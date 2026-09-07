/**
 * Public surface of the retrieval engine. Everything here is usable without
 * MCP — the server in `src/mcp/` is one caller of this, not the only one.
 */

export { chunkMarkdown, extractWikilinks, buildLinkResolver, MAX_CHUNK_CHARS } from "./chunker.js";
export type { Chunk } from "./chunker.js";

export { openDb, getIndexStatus, findMismatch, describeMismatch, SCHEMA_VERSION } from "./db.js";
export type { IndexStatus, IndexMismatch, RetrievalDb } from "./db.js";

export { createEmbedder, warmEmbedder, resetEmbedderCache } from "./embedder.js";
export type { EmbedFn } from "./embedder.js";

export { buildIndex, listMarkdownFiles, isChanged } from "./indexer.js";
export type { BuildOptions, BuildStats, DiskFile } from "./indexer.js";

export { fuseRrf, RRF_K } from "./rrf.js";
export type { FusedItem } from "./rrf.js";

export { makeSnippet, SNIPPET_CHARS } from "./snippet.js";

export {
  search,
  linkNeighbors,
  bm25Candidates,
  vectorCandidates,
  toFtsQuery,
  BM25_WEIGHTS,
  CANDIDATES_PER_LIST,
  RERANK_CANDIDATES,
} from "./query.js";
export type { Hit, HitSource, SearchMode, SearchOptions, SearchResult } from "./query.js";

export { createReranker, resetRerankerCache } from "./rerank.js";
export type { Reranker } from "./rerank.js";

export { getFreshness, describeFreshness } from "./freshness.js";
export type { IndexFreshness } from "./freshness.js";

export { getStaleNotes } from "./staleness.js";
export type { StaleNote, StalenessReport, StalenessOptions } from "./staleness.js";

export { resolveInsideRoot, isInside, toRelative, PathOutsideRootError } from "./paths.js";
