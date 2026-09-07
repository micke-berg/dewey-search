/**
 * The benchmark runner.
 *
 * Scores four retrievers over the same verified question set on the same
 * index, and writes every per-question rank out alongside the summary. The
 * per-question file is not a nicety: a summary table with no way to see which
 * questions failed is a claim, not a measurement, and the failures are the
 * part worth reading.
 *
 * Latency is measured with the embedding model already warm. The one-time
 * model load is reported separately rather than smeared across the first
 * query, because attributing a 20-second download to "search latency" would
 * be flattering in the wrong direction and misleading in both.
 */

import fs from "node:fs";
import type { DeweyConfig } from "../config.js";
import { openDb, type RetrievalDb } from "../core/db.js";
import { createEmbedder, warmEmbedder, type EmbedFn } from "../core/embedder.js";
import { createReranker, type Reranker } from "../core/rerank.js";
import { bm25Candidates, search, vectorCandidates } from "../core/query.js";
import { verifyQuestionSet, type Question, type QuestionSet } from "./questions.js";

export const TOP_K = 5;

export type RetrieverName = "bm25" | "vector" | "hybrid" | "hybrid+rerank";

export interface RetrieverRun {
  files: string[];
  ms: number;
  /** 1-based rank of the first expected file within the top K, else null. */
  rank: number | null;
}

export interface QuestionResult {
  id: string;
  q: string;
  expect: string[];
  runs: Partial<Record<RetrieverName, RetrieverRun>>;
}

export interface RetrieverSummary {
  name: RetrieverName;
  recallAtK: number;
  mrr: number;
  latencyP50: number;
  latencyMean: number;
}

export interface BenchmarkReport {
  ranAt: string;
  root: string;
  model: string;
  topK: number;
  questionCount: number;
  index: { files: number; chunks: number; dbBytes: number };
  warmupMs: number;
  summaries: RetrieverSummary[];
  results: QuestionResult[];
}

export interface RunOptions {
  config: DeweyConfig;
  set: QuestionSet;
  withRerank?: boolean;
  embed?: EmbedFn;
  rerank?: Reranker;
  onProgress?: (done: number, total: number, id: string) => void;
}

export async function runBenchmark(opts: RunOptions): Promise<BenchmarkReport> {
  const { config, set } = opts;

  const problems = verifyQuestionSet(set, config.root);
  if (problems.length > 0) {
    throw new Error(
      `Question set failed verification (${String(problems.length)} problems). Fix these before scoring:\n` +
        problems.map((p) => `  ${p.id}: ${p.problem}`).join("\n"),
    );
  }

  const db = openDb({ dbPath: config.dbPath });
  if (!db) throw new Error(`No index at ${config.dbPath}. Run \`dewey index\` first.`);

  const embed = opts.embed ?? createEmbedder(config);
  const rerank = opts.rerank ?? createReranker(config);

  try {
    const warmStarted = Date.now();
    await warmEmbedder(config);
    if (opts.withRerank) {
      // The cross-encoder loads lazily on first use. Left unwarmed, its whole
      // model load lands inside the first question's timing and drags the mean
      // far above anything a user would experience.
      await rerank("warm up the reranker", ["warm up the reranker"]);
    }
    const warmupMs = Date.now() - warmStarted;

    const results: QuestionResult[] = [];
    for (const [i, question] of set.questions.entries()) {
      results.push(await scoreQuestion(question, { config, db, embed, rerank, withRerank: opts.withRerank ?? false }));
      opts.onProgress?.(i + 1, set.questions.length, question.id);
    }

    const names: RetrieverName[] = opts.withRerank
      ? ["bm25", "vector", "hybrid", "hybrid+rerank"]
      : ["bm25", "vector", "hybrid"];

    const counts = db.prepare("SELECT (SELECT COUNT(*) FROM files) AS files, COUNT(*) AS chunks FROM chunks").get() as {
      files: number;
      chunks: number;
    };

    return {
      ranAt: new Date().toISOString(),
      root: config.root,
      model: config.model,
      topK: TOP_K,
      questionCount: set.questions.length,
      index: { files: counts.files, chunks: counts.chunks, dbBytes: sizeOf(config.dbPath) },
      warmupMs,
      summaries: names.map((name) => summarize(name, results)),
      results,
    };
  } finally {
    db.close();
  }
}

interface ScoreContext {
  config: DeweyConfig;
  db: RetrievalDb;
  embed: EmbedFn;
  rerank: Reranker;
  withRerank: boolean;
}

async function scoreQuestion(question: Question, ctx: ScoreContext): Promise<QuestionResult> {
  const runs: Partial<Record<RetrieverName, RetrieverRun>> = {};

  const bm25Started = Date.now();
  const bm25Files = chunkIdsToFiles(ctx.db, bm25Candidates(ctx.db, question.q));
  runs.bm25 = finish(bm25Files, question.expect, Date.now() - bm25Started);

  const vectorStarted = Date.now();
  const [queryVec] = await ctx.embed([question.q], "query");
  const vectorFiles = queryVec ? chunkIdsToFiles(ctx.db, vectorCandidates(ctx.db, queryVec)) : [];
  runs.vector = finish(vectorFiles, question.expect, Date.now() - vectorStarted);

  const hybridStarted = Date.now();
  const hybrid = await search(question.q, {
    config: { ...ctx.config, rerank: false },
    embed: ctx.embed,
    limit: TOP_K,
  });
  runs.hybrid = finish(
    hybrid.hits.map((h) => h.path),
    question.expect,
    Date.now() - hybridStarted,
  );

  if (ctx.withRerank) {
    const rerankStarted = Date.now();
    const reranked = await search(question.q, {
      config: { ...ctx.config, rerank: true },
      embed: ctx.embed,
      rerank: ctx.rerank,
      limit: TOP_K,
    });
    runs["hybrid+rerank"] = finish(
      reranked.hits.map((h) => h.path),
      question.expect,
      Date.now() - rerankStarted,
    );
  }

  return { id: question.id, q: question.q, expect: question.expect, runs };
}

function finish(files: string[], expect: string[], ms: number): RetrieverRun {
  return { files: files.slice(0, TOP_K), ms, rank: rankOf(files, expect) };
}

function rankOf(files: string[], expect: string[]): number | null {
  for (let i = 0; i < Math.min(files.length, TOP_K); i++) {
    if (expect.includes(files[i]!)) return i + 1;
  }
  return null;
}

/** Chunk ids to an ordered, deduplicated file list — retrieval is scored per note. */
function chunkIdsToFiles(db: RetrievalDb, ids: number[]): string[] {
  const stmt = db.prepare("SELECT path FROM chunks WHERE id = ?");
  const files: string[] = [];
  for (const id of ids) {
    const row = stmt.get(id) as { path: string } | undefined;
    if (row && !files.includes(row.path)) files.push(row.path);
  }
  return files;
}

function summarize(name: RetrieverName, results: QuestionResult[]): RetrieverSummary {
  const runs = results.map((r) => r.runs[name]).filter((r): r is RetrieverRun => r !== undefined);
  const n = Math.max(1, runs.length);
  const latencies = runs.map((r) => r.ms).sort((a, b) => a - b);
  return {
    name,
    recallAtK: runs.filter((r) => r.rank !== null).length / n,
    mrr: runs.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / n,
    latencyP50: latencies[Math.floor(latencies.length / 2)] ?? 0,
    latencyMean: latencies.reduce((a, b) => a + b, 0) / n,
  };
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Markdown summary, ready to paste into a doc or a pull request. */
export function renderReport(report: BenchmarkReport): string {
  const rows = report.summaries.map(
    (s) =>
      `| ${s.name} | ${(s.recallAtK * 100).toFixed(1)} % | ${s.mrr.toFixed(3)} | ${String(s.latencyP50)} ms | ${s.latencyMean.toFixed(0)} ms |`,
  );

  const misses = report.results.filter((r) => r.runs.hybrid?.rank === null);
  const missSection =
    misses.length === 0
      ? "\nNo hybrid misses.\n"
      : `\nHybrid missed ${String(misses.length)} of ${String(report.questionCount)}:\n\n` +
        misses.map((m) => `- ${m.id} "${m.q}" — expected ${m.expect.join(" or ")}`).join("\n") +
        "\n";

  return [
    `# Retrieval benchmark`,
    ``,
    `${String(report.questionCount)} questions over ${String(report.index.files)} files ` +
      `(${String(report.index.chunks)} chunks, ${(report.index.dbBytes / 1_048_576).toFixed(1)} MB index), ` +
      `model \`${report.model}\`, run ${report.ranAt}.`,
    `Embedding model warm-up ${String(report.warmupMs)} ms, excluded from the latencies below.`,
    ``,
    `| Retriever | recall@${String(report.topK)} | MRR | latency p50 | latency mean |`,
    `| --- | --- | --- | --- | --- |`,
    ...rows,
    missSection,
  ].join("\n");
}
