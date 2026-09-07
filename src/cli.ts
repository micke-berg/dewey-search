#!/usr/bin/env node
/**
 * The command line. Deliberately dependency-free argument parsing: the surface
 * is eight commands and a handful of flags, and a parsing library would be a
 * larger thing to audit than the thing it parses.
 *
 * Everything here writes to stdout. The `serve` command is the exception and
 * redirects the console before it starts, because on stdio stdout belongs to
 * the protocol.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError, resolveConfig, type DeweyConfig } from "./config.js";
import { createEmbedder } from "./core/embedder.js";
import { createReranker } from "./core/rerank.js";
import { buildIndex } from "./core/indexer.js";
import { search } from "./core/query.js";
import { describeFreshness, getFreshness } from "./core/freshness.js";
import { getStaleNotes } from "./core/staleness.js";
import { describeMismatch, findMismatch, getIndexStatus } from "./core/db.js";
import { serve } from "./mcp/stdio.js";
import { loadQuestionSet, verifyQuestionSet } from "./bench/questions.js";
import { scaffoldQuestionSet } from "./bench/scaffold.js";
import { renderReport, runBenchmark } from "./bench/run.js";
import { generateCorpus } from "./bench/synth.js";

const USAGE = `dewey — hybrid search and staleness reporting over a folder of markdown

Usage
  dewey index [--full]              Build or update the search index
  dewey search <query> [--rerank]   Search the notes
  dewey status                      Index size, age, and how far behind it is
  dewey stale [--days N]            Notes that are old and still linked to
  dewey serve                       Run the MCP server on stdio
  dewey bench init [--out FILE]     Draft a question set from your own notes
  dewey bench verify <FILE>         Check a question set against the notes
  dewey bench run <FILE> [--rerank] Score the retrievers and print the table
  dewey synth --out DIR --count N   Generate a synthetic corpus for load testing

Options
  --notes <path>    Folder of markdown notes    (env DEWEY_NOTES)
  --db <path>       Index database location     (env DEWEY_DB)
  --model <name>    Embedding model             (env DEWEY_MODEL)
  --limit <n>       Results to show             (default 10)
  --days <n>        Staleness threshold in days (default 180)
  --json            Machine-readable output
  --help            This text
`;

interface Args {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return { positional, flags };
}

/**
 * Where a hit lives, as one line. The heading is dropped when it merely
 * repeats the note title, which is what happens for content under a page's
 * own H1 and reads like a rendering bug.
 */
export function describeLocation(title: string, heading: string | null): string {
  return heading && heading !== title ? `${title} › ${heading}` : title;
}

/** Erase the progress line, but only when something is there to erase it. */
function clearProgress(): void {
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
  else process.stdout.write("\n");
}

function progress(text: string): void {
  if (process.stdout.isTTY) process.stdout.write(`\r${text}`);
}

function str(args: Args, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function num(args: Args, key: string): number | undefined {
  const value = str(args, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ConfigError(`--${key} expects a number, got "${value}"`);
  return parsed;
}

function configFrom(args: Args): DeweyConfig {
  return resolveConfig({
    root: str(args, "notes"),
    dbPath: str(args, "db"),
    model: str(args, "model"),
    rerank: args.flags.has("rerank") ? true : undefined,
  });
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positional[0];

  if (!command || args.flags.has("help")) {
    console.log(USAGE);
    return args.flags.has("help") ? 0 : 1;
  }

  switch (command) {
    case "index":
      return await cmdIndex(args);
    case "search":
      return await cmdSearch(args);
    case "status":
      return cmdStatus(args);
    case "stale":
      return cmdStale(args);
    case "serve":
      await serve(configFrom(args));
      return 0;
    case "bench":
      return await cmdBench(args);
    case "synth":
      return cmdSynth(args);
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

async function cmdIndex(args: Args): Promise<number> {
  const config = configFrom(args);
  const full = args.flags.has("full");

  const status = getIndexStatus(config.dbPath);
  const mismatch = findMismatch(status, {
    model: config.model,
    embedDims: config.embedDims,
    root: config.root,
  });
  if (mismatch && !full) {
    console.log(`${describeMismatch(mismatch)}\nRebuilding from scratch.`);
    fs.rmSync(config.dbPath, { force: true });
  }

  console.log(`Indexing ${config.root}`);
  console.log(`Index at ${config.dbPath}`);

  let lastLine = 0;
  const stats = await buildIndex({
    config,
    embed: createEmbedder(config),
    full: full || mismatch !== null,
    onProgress: (done, total) => {
      // Reporting every file turns a build log into thousands of lines.
      if (done === total || done - lastLine >= 25) {
        lastLine = done;
        progress(`  ${String(done)}/${String(total)} files`);
      }
    },
  });

  clearProgress();
  console.log(
    `Indexed ${String(stats.indexed)} files (${String(stats.unchanged)} unchanged, ${String(stats.removed)} removed) ` +
      `in ${(stats.ms / 1000).toFixed(1)}s`,
  );
  console.log(`${String(stats.chunks)} chunks, ${(stats.dbBytes / 1_048_576).toFixed(1)} MB`);
  return 0;
}

async function cmdSearch(args: Args): Promise<number> {
  const config = configFrom(args);
  const query = args.positional.slice(1).join(" ");
  if (!query) {
    console.error("Nothing to search for. Try: dewey search \"what did I decide about pricing\"");
    return 1;
  }

  const result = await search(query, {
    config,
    embed: createEmbedder(config),
    rerank: createReranker(config),
    limit: num(args, "limit") ?? 10,
  });

  if (args.flags.has("json")) {
    console.log(JSON.stringify(result, null, 2));
    return result.indexed ? 0 : 1;
  }

  if (!result.indexed) {
    console.error("No index yet. Run `dewey index` first.");
    return 1;
  }
  for (const note of result.notes) console.error(note);
  if (result.hits.length === 0) {
    console.log("No matching notes.");
    return 0;
  }

  for (const [i, hit] of result.hits.entries()) {
    console.log(`${String(i + 1).padStart(2)}. ${describeLocation(hit.title, hit.heading)}`);
    console.log(`    ${hit.path}:${String(hit.startLine)}  [${hit.source}]`);
    console.log(`    ${hit.snippet}`);
    console.log("");
  }

  const freshness = getFreshness(config);
  if (freshness.behind > 0) console.log(`${describeFreshness(freshness)} Run \`dewey index\` to catch up.`);
  return 0;
}

function cmdStatus(args: Args): number {
  const config = configFrom(args);
  const freshness = getFreshness(config);

  if (args.flags.has("json")) {
    console.log(JSON.stringify(freshness, null, 2));
    return 0;
  }

  console.log(describeFreshness(freshness));
  console.log(`Notes:  ${config.root}`);
  console.log(`Index:  ${config.dbPath}`);
  if (freshness.built) {
    console.log(`Chunks: ${String(freshness.chunks)} across ${String(freshness.files)} files`);
    console.log(`Model:  ${freshness.model ?? config.model}`);
    console.log(`Size:   ${(freshness.dbBytes / 1_048_576).toFixed(1)} MB`);
    console.log(`Built:  ${freshness.builtAt ?? "unknown"}`);
  }

  const mismatch = findMismatch(getIndexStatus(config.dbPath), {
    model: config.model,
    embedDims: config.embedDims,
    root: config.root,
  });
  if (mismatch) console.log(`\n${describeMismatch(mismatch)} Run \`dewey index --full\`.`);
  return 0;
}

function cmdStale(args: Args): number {
  const config = configFrom(args);
  const report = getStaleNotes(config, {
    ...(num(args, "days") !== undefined ? { olderThanDays: num(args, "days")! } : {}),
    ...(num(args, "limit") !== undefined ? { limit: num(args, "limit")! } : {}),
    pathPrefix: str(args, "prefix"),
  });

  if (args.flags.has("json")) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log(
    `${String(report.staleCount)} of ${String(report.totalNotes)} notes older than ${String(report.thresholdDays)} days. ` +
      `Median age ${String(report.medianAgeDays)} days, ${String(report.orphanCount)} orphans.`,
  );
  if (report.linkDataMissing) console.log("No index found, so this is ranked by age alone. Run `dewey index`.");
  if (report.notes.length === 0) return 0;

  console.log("\n  age    links  note");
  for (const note of report.notes) {
    console.log(`  ${String(note.ageDays).padStart(4)}d  ${String(note.inboundLinks).padStart(5)}  ${note.path}`);
  }
  return 0;
}

async function cmdBench(args: Args): Promise<number> {
  const config = configFrom(args);
  const sub = args.positional[1];

  if (sub === "init") {
    const out = str(args, "out") ?? "dewey-questions.json";
    const set = scaffoldQuestionSet(config, { ...(num(args, "count") !== undefined ? { count: num(args, "count")! } : {}) });
    fs.writeFileSync(out, JSON.stringify(set, null, 2) + "\n", "utf8");
    console.log(`Drafted ${String(set.questions.length)} questions to ${out}`);
    console.log(
      "\nEvery question is marked \"reviewed\": false. Read them, rewrite each one the way you would\n" +
        "actually ask it, correct the expected file if it is wrong, then set reviewed to true.\n" +
        "The runner will not score an unreviewed set, on purpose.",
    );
    return 0;
  }

  if (sub === "verify") {
    const file = args.positional[2];
    if (!file) {
      console.error("Which question set? dewey bench verify <file>");
      return 1;
    }
    const problems = verifyQuestionSet(loadQuestionSet(file), config.root);
    if (problems.length === 0) {
      console.log("Question set verified. Every expected file exists and every evidence pattern matches.");
      return 0;
    }
    console.error(`${String(problems.length)} problems:\n`);
    for (const p of problems) console.error(`  ${p.id}: ${p.problem}`);
    return 1;
  }

  if (sub === "run") {
    const file = args.positional[2];
    if (!file) {
      console.error("Which question set? dewey bench run <file>");
      return 1;
    }
    const report = await runBenchmark({
      config,
      set: loadQuestionSet(file),
      withRerank: args.flags.has("rerank"),
      onProgress: (done, total, id) => progress(`  ${String(done)}/${String(total)} ${id}      `),
    });
    clearProgress();

    const out = str(args, "out");
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
      console.log(`Per-question results → ${out}\n`);
    }
    console.log(renderReport(report));
    return 0;
  }

  console.error("Usage: dewey bench init | verify <file> | run <file>");
  return 1;
}

function cmdSynth(args: Args): number {
  const outDir = str(args, "out");
  const count = num(args, "count");
  if (!outDir || count === undefined) {
    console.error("Usage: dewey synth --out <dir> --count <n> [--seed <n>]");
    return 1;
  }

  const stats = generateCorpus({
    outDir: path.resolve(outDir),
    count,
    ...(num(args, "seed") !== undefined ? { seed: num(args, "seed")! } : {}),
    onProgress: (done, total) => progress(`  ${String(done)}/${String(total)} notes`),
  });

  clearProgress();
  console.log(
    `Generated ${String(stats.files)} notes (${(stats.bytes / 1_048_576).toFixed(1)} MB) ` +
      `in ${(stats.ms / 1000).toFixed(1)}s at ${stats.outDir}`,
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  });
