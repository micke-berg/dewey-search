/**
 * The index database: SQLite, always outside the notes folder.
 *
 * FTS5 carries BM25 with per-field weights, sqlite-vec carries the embeddings
 * for nearest-neighbour search, and both point at the same `chunks` rows so a
 * fused result can be resolved back to one place in one file.
 *
 * The database is a derived cache and nothing else. It can be deleted at any
 * time and rebuilt from the notes; nothing is stored here that does not exist
 * in a markdown file. Nothing in this module writes to the notes folder.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

export type RetrievalDb = Database.Database;

/**
 * Bumping this invalidates every existing index. Do it whenever the chunking,
 * the field weights, or the table layout change in a way that would make old
 * rows and new rows rank against each other unfairly — a half-migrated index
 * produces plausible, quietly wrong results, which is worse than a rebuild.
 */
export const SCHEMA_VERSION = 2;

export interface OpenOptions {
  dbPath: string;
  /** Create and migrate when absent. Readers pass false and get null instead. */
  create?: boolean;
  /** Vector width. Only consulted when creating the vector table. */
  embedDims?: number;
}

export function openDb({ dbPath, create = false, embedDims = 384 }: OpenOptions): RetrievalDb | null {
  if (!create && !fs.existsSync(dbPath)) return null;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  if (create) migrate(db, embedDims);
  return db;
}

function migrate(db: RetrievalDb, embedDims: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL,
      title TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      heading TEXT,
      heading_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
    CREATE TABLE IF NOT EXISTS links (
      chunk_id INTEGER NOT NULL,
      target_path TEXT NOT NULL,
      PRIMARY KEY (chunk_id, target_path)
    );
    CREATE INDEX IF NOT EXISTS links_target ON links(target_path);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(title, heading, body);
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${String(embedDims)}]);
  `);
  setMeta(db, "schema_version", String(SCHEMA_VERSION));
  setMeta(db, "embed_dims", String(embedDims));
}

export function setMeta(db: RetrievalDb, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

export function getMeta(db: RetrievalDb, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export interface IndexStatus {
  built: boolean;
  files: number;
  chunks: number;
  model: string | null;
  embedDims: number | null;
  schemaVersion: number | null;
  /** Notes folder this index was built from, as recorded at build time. */
  root: string | null;
  builtAt: string | null;
  dbBytes: number;
  dbPath: string;
}

export const EMPTY_STATUS = (dbPath: string): IndexStatus => ({
  built: false,
  files: 0,
  chunks: 0,
  model: null,
  embedDims: null,
  schemaVersion: null,
  root: null,
  builtAt: null,
  dbBytes: 0,
  dbPath,
});

export function getIndexStatus(dbPath: string): IndexStatus {
  const db = openDb({ dbPath });
  if (!db) return EMPTY_STATUS(dbPath);
  try {
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const dims = getMeta(db, "embed_dims");
    const schema = getMeta(db, "schema_version");
    const chunks = count("chunks");
    return {
      built: chunks > 0,
      files: count("files"),
      chunks,
      model: getMeta(db, "embed_model"),
      embedDims: dims === null ? null : Number(dims),
      schemaVersion: schema === null ? null : Number(schema),
      root: getMeta(db, "root"),
      builtAt: getMeta(db, "built_at"),
      dbBytes: fs.statSync(dbPath).size,
      dbPath,
    };
  } finally {
    db.close();
  }
}

/**
 * Reasons an existing index cannot answer queries for the current config.
 * Each one means "rebuild", and saying which is which turns a baffling empty
 * result into an instruction.
 */
export type IndexMismatch =
  | { kind: "schema"; found: number | null; expected: number }
  | { kind: "model"; found: string | null; expected: string }
  | { kind: "dims"; found: number | null; expected: number }
  | { kind: "root"; found: string | null; expected: string };

export function findMismatch(
  status: IndexStatus,
  expected: { model: string; embedDims: number; root: string },
): IndexMismatch | null {
  if (!status.built) return null;
  if (status.schemaVersion !== SCHEMA_VERSION) {
    return { kind: "schema", found: status.schemaVersion, expected: SCHEMA_VERSION };
  }
  // Vectors from two different models share a coordinate space only by
  // coincidence. Querying across them returns confident nonsense.
  if (status.model !== expected.model) return { kind: "model", found: status.model, expected: expected.model };
  if (status.embedDims !== expected.embedDims) {
    return { kind: "dims", found: status.embedDims, expected: expected.embedDims };
  }
  if (status.root !== expected.root) return { kind: "root", found: status.root, expected: expected.root };
  return null;
}

export function describeMismatch(m: IndexMismatch): string {
  switch (m.kind) {
    case "schema":
      return `The index was built by a different version of Dewey (schema ${String(m.found)}, this build expects ${String(m.expected)}).`;
    case "model":
      return `The index was built with embedding model "${String(m.found)}", but the current model is "${m.expected}".`;
    case "dims":
      return `The index stores ${String(m.found)}-dimension vectors, but the current model produces ${String(m.expected)}.`;
    case "root":
      return `The index was built from "${String(m.found)}", but the current notes folder is "${m.expected}".`;
  }
}

/** Float32Array to the BLOB layout sqlite-vec expects. */
export function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
