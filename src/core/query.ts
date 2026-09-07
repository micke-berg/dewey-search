/**
 * Hybrid query: BM25 over FTS5 with title and heading boosted over body, plus
 * vector nearest-neighbour search, fused with reciprocal-rank fusion.
 *
 * Every hit carries its own breakdown — which retriever found it and at what
 * rank — because "why did this match" is most of what makes a search result
 * trustworthy, and because it is the only way to tell a genuine hybrid win
 * from one retriever quietly carrying the whole system.
 *
 * When the embedder is unavailable the search degrades to BM25 alone and says
 * so in the result rather than returning thinner results without explanation.
 */

import type { DeweyConfig } from "../config.js";
import { contextualize } from "./chunker.js";
import { openDb, toBlob, type RetrievalDb } from "./db.js";
import { fuseRrf, RRF_K } from "./rrf.js";
import { makeSnippet } from "./snippet.js";
import type { EmbedFn } from "./embedder.js";
import type { Reranker } from "./rerank.js";

/** BM25 field weights: title 4x, heading 3x, body 1x. */
export const BM25_WEIGHTS = { title: 4.0, heading: 3.0, body: 1.0 } as const;
/** Candidates taken from each retriever before fusion. */
export const CANDIDATES_PER_LIST = 40;
/** How many fused candidates the reranker is allowed to look at. */
export const RERANK_CANDIDATES = 20;

export type HitSource = "bm25" | "vec" | "both";
export type SearchMode = "hybrid" | "bm25-only";

export interface Hit {
  path: string;
  title: string;
  heading: string | null;
  headingPath: string[];
  startLine: number;
  snippet: string;
  source: HitSource;
  /** RRF score, or the cross-encoder score when reranking is on. */
  score: number;
  bm25Rank: number | null;
  vecRank: number | null;
  /** Position before reranking, so a reorder can be seen rather than guessed. */
  fusedRank: number | null;
  /** Resolved [[wikilink]] targets of this chunk. */
  links: string[];
}

export interface SearchResult {
  indexed: boolean;
  mode: SearchMode;
  reranked: boolean;
  hits: Hit[];
  /** Populated when something degraded, e.g. the embedder failed to load. */
  notes: string[];
}

interface ChunkRow {
  id: number;
  path: string;
  title: string;
  heading: string | null;
  heading_path: string;
  start_line: number;
  text: string;
}

/**
 * A user query to an FTS5 MATCH expression that cannot throw. FTS5 treats
 * quotes, asterisks and parentheses as syntax, so a query containing them is a
 * syntax error rather than a search — stripping them is the difference between
 * "no results" and a 500.
 */
export function toFtsQuery(query: string, or = false): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/["'*()]/g, ""))
    .filter(Boolean);
  if (tokens.length === 0) return "";
  const last = tokens.length - 1;
  return tokens.map((t, i) => `"${t}"${i === last ? "*" : ""}`).join(or ? " OR " : " ");
}

export function queryTokens(query: string): string[] {
  return query.split(/\s+/).filter(Boolean);
}

/**
 * BM25 candidates, best first.
 *
 * Strict AND first. The OR fallback rescues recall when no chunk contains
 * every term, but it is opt-in because it actively hurts in hybrid mode: it
 * returns 40 chunks that each share one common word with the query, and those
 * 40 weak candidates push a correct vector hit down the fused list. It is
 * worth having only when there is no vector list to provide that recall.
 */
export function bm25Candidates(
  db: RetrievalDb,
  query: string,
  limit: number = CANDIDATES_PER_LIST,
  orFallback = true,
): number[] {
  const run = (expr: string): number[] => {
    if (!expr) return [];
    try {
      return (
        db
          .prepare(
            `SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?
             ORDER BY bm25(chunks_fts, ?, ?, ?) LIMIT ?`,
          )
          .all(expr, BM25_WEIGHTS.title, BM25_WEIGHTS.heading, BM25_WEIGHTS.body, limit) as { rowid: number }[]
      ).map((r) => r.rowid);
    } catch {
      return [];
    }
  };

  const strict = run(toFtsQuery(query, false));
  if (!orFallback || strict.length > 0 || queryTokens(query).length < 2) return strict;
  return run(toFtsQuery(query, true));
}

/** Vector candidates by cosine distance, best first. */
export function vectorCandidates(db: RetrievalDb, queryVec: Float32Array, limit = CANDIDATES_PER_LIST): number[] {
  return (
    db
      .prepare("SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance")
      .all(toBlob(queryVec), limit) as { rowid: number }[]
  ).map((r) => r.rowid);
}

export interface SearchOptions {
  config: DeweyConfig;
  /** Omit to search BM25-only. */
  embed?: EmbedFn | undefined;
  /** Omit, or leave `config.rerank` false, to skip the cross-encoder pass. */
  rerank?: Reranker | undefined;
  limit?: number;
  /** Collapse to the best chunk per file. On by default: a result list that
   *  shows one note four times is worse than one showing four notes. */
  perFile?: boolean;
  rrfK?: number;
}

export async function search(query: string, opts: SearchOptions): Promise<SearchResult> {
  const { config } = opts;
  const db = openDb({ dbPath: config.dbPath });
  if (!db) {
    return { indexed: false, mode: "hybrid", reranked: false, hits: [], notes: ["No index yet. Run `dewey index`."] };
  }

  try {
    const limit = opts.limit ?? 10;
    const notes: string[] = [];

    let vecIds: number[] = [];
    let mode: SearchMode = "bm25-only";
    if (opts.embed) {
      try {
        const [queryVec] = await opts.embed([query], "query");
        if (queryVec) {
          vecIds = vectorCandidates(db, queryVec);
          mode = "hybrid";
        }
      } catch (e) {
        notes.push(
          `Embedding model unavailable, answering from keyword search only: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
    }

    const bm25Ids = bm25Candidates(db, query, CANDIDATES_PER_LIST, vecIds.length === 0);
    const fused = fuseRrf(
      [
        { source: "bm25", ids: bm25Ids },
        { source: "vec", ids: vecIds },
      ],
      opts.rrfK ?? RRF_K,
    );

    const rows = loadChunks(db, fused.map((f) => f.id));
    const tokens = queryTokens(query);

    // Collapse per file before reranking, so the cross-encoder spends its
    // budget on distinct notes instead of four chunks of the same one.
    const candidates: { hit: Hit; id: number; text: string }[] = [];
    const seenFiles = new Set<string>();
    for (const [i, item] of fused.entries()) {
      const row = rows.get(item.id);
      if (!row) continue;
      if (opts.perFile !== false) {
        if (seenFiles.has(row.path)) continue;
        seenFiles.add(row.path);
      }
      const bm25Rank = item.ranks["bm25"] ?? null;
      const vecRank = item.ranks["vec"] ?? null;
      const headingPath = JSON.parse(row.heading_path) as string[];
      candidates.push({
        id: item.id,
        // The same contextualised form the indexer embedded. Reranking the bare
        // body would score a document the retriever never ranked.
        text: contextualize({ title: row.title, headingPath, text: row.text }),
        hit: {
          path: row.path,
          title: row.title,
          heading: row.heading,
          headingPath,
          startLine: row.start_line,
          snippet: makeSnippet(row.text, tokens),
          source: bm25Rank !== null && vecRank !== null ? "both" : bm25Rank !== null ? "bm25" : "vec",
          score: item.score,
          bm25Rank,
          vecRank,
          fusedRank: i + 1,
          links: loadLinks(db, item.id),
        },
      });
    }

    let reranked = false;
    let ordered = candidates;
    if (opts.rerank && config.rerank && candidates.length > 1) {
      const pool = candidates.slice(0, RERANK_CANDIDATES);
      try {
        const scores = await opts.rerank(
          query,
          pool.map((c) => c.text),
        );
        const rescored = pool
          .map((c, i) => ({ ...c, hit: { ...c.hit, score: scores[i] ?? 0 } }))
          .sort((a, b) => b.hit.score - a.hit.score);
        ordered = [...rescored, ...candidates.slice(RERANK_CANDIDATES)];
        reranked = true;
      } catch (e) {
        notes.push(
          `Reranker unavailable, keeping fusion order: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      }
    }

    return { indexed: true, mode, reranked, hits: ordered.slice(0, limit).map((c) => c.hit), notes };
  } finally {
    db.close();
  }
}

function loadChunks(db: RetrievalDb, ids: number[]): Map<number, ChunkRow> {
  const rows = new Map<number, ChunkRow>();
  const stmt = db.prepare("SELECT * FROM chunks WHERE id = ?");
  for (const id of ids) {
    const row = stmt.get(id) as ChunkRow | undefined;
    if (row) rows.set(id, row);
  }
  return rows;
}

function loadLinks(db: RetrievalDb, chunkId: number): string[] {
  return (db.prepare("SELECT target_path FROM links WHERE chunk_id = ?").all(chunkId) as { target_path: string }[]).map(
    (r) => r.target_path,
  );
}

/** One-hop neighbours of a note via the stored wikilink edges, both directions. */
export function linkNeighbors(notePath: string, dbPath: string): { outgoing: string[]; incoming: string[] } {
  const db = openDb({ dbPath });
  if (!db) return { outgoing: [], incoming: [] };
  try {
    const outgoing = (
      db
        .prepare("SELECT DISTINCT l.target_path AS p FROM links l JOIN chunks c ON c.id = l.chunk_id WHERE c.path = ?")
        .all(notePath) as { p: string }[]
    ).map((r) => r.p);
    const incoming = (
      db
        .prepare("SELECT DISTINCT c.path AS p FROM links l JOIN chunks c ON c.id = l.chunk_id WHERE l.target_path = ?")
        .all(notePath) as { p: string }[]
    ).map((r) => r.p);
    return { outgoing, incoming: incoming.filter((p) => p !== notePath) };
  } finally {
    db.close();
  }
}
