/**
 * Index builder. Walks the notes folder read-only, chunks by heading, embeds,
 * and writes SQLite outside the folder.
 *
 * Incremental by mtime and size: unchanged files are never re-read, and a
 * changed file replaces its own chunks inside a single transaction. That
 * per-file transaction is also what makes an interrupted build safe to resume
 * — the index is never left holding half a file's chunks.
 */

import fs from "node:fs";
import path from "node:path";
import type { DeweyConfig } from "../config.js";
import { buildLinkResolver, chunkMarkdown, contextualize } from "./chunker.js";
import { openDb, setMeta, toBlob, type RetrievalDb } from "./db.js";
import type { EmbedFn } from "./embedder.js";

const EMBED_BATCH = 24;

export interface DiskFile {
  rel: string;
  mtimeMs: number;
  size: number;
}

export interface BuildOptions {
  config: DeweyConfig;
  embed: EmbedFn;
  /** Re-read and re-embed every file, ignoring mtime. */
  full?: boolean;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface BuildStats {
  scanned: number;
  indexed: number;
  removed: number;
  unchanged: number;
  chunks: number;
  ms: number;
  dbBytes: number;
  dbPath: string;
  aborted: boolean;
}

/**
 * Every markdown file in the folder, with stat info. Dotfiles and dot-folders
 * are skipped: `.git`, `.obsidian` and friends contain thousands of files that
 * nobody means when they say "my notes".
 */
export function listMarkdownFiles(root: string, ignoreDirs: string[] = ["node_modules"]): DiskFile[] {
  const skip = new Set(ignoreDirs);
  const out: DiskFile[] = [];

  const walk = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(childRel);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const stat = fs.statSync(path.join(root, childRel));
          out.push({ rel: childRel, mtimeMs: Math.round(stat.mtimeMs), size: stat.size });
        } catch {
          // A file disappearing mid-walk is normal in a synced folder, not an
          // error worth failing a whole build over.
        }
      }
    }
  };

  walk("");
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/** True when the file on disk differs from what the index recorded. */
export function isChanged(file: DiskFile, known: { mtime_ms: number; size: number } | undefined): boolean {
  return !known || known.mtime_ms !== file.mtimeMs || known.size !== file.size;
}

function deleteFileRows(db: RetrievalDb, rel: string): void {
  const ids = (db.prepare("SELECT id FROM chunks WHERE path = ?").all(rel) as { id: number }[]).map((r) => r.id);
  const delFts = db.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
  const delVec = db.prepare("DELETE FROM vec_chunks WHERE rowid = ?");
  const delLinks = db.prepare("DELETE FROM links WHERE chunk_id = ?");
  for (const id of ids) {
    delFts.run(id);
    delVec.run(id);
    delLinks.run(id);
  }
  db.prepare("DELETE FROM chunks WHERE path = ?").run(rel);
  db.prepare("DELETE FROM files WHERE path = ?").run(rel);
}

export async function buildIndex(opts: BuildOptions): Promise<BuildStats> {
  const started = Date.now();
  const { config, embed } = opts;
  const db = openDb({ dbPath: config.dbPath, create: true, embedDims: config.embedDims })!;
  const onProgress = opts.onProgress ?? (() => {});

  try {
    const disk = listMarkdownFiles(config.root, config.ignoreDirs);
    const resolveLink = buildLinkResolver(disk.map((f) => f.rel));
    const known = new Map(
      (
        db.prepare("SELECT path, mtime_ms, size FROM files").all() as {
          path: string;
          mtime_ms: number;
          size: number;
        }[]
      ).map((r) => [r.path, r]),
    );

    const diskPaths = new Set(disk.map((f) => f.rel));
    const toRemove = [...known.keys()].filter((p) => !diskPaths.has(p));
    const toIndex = opts.full ? disk : disk.filter((f) => isChanged(f, known.get(f.rel)));

    for (const rel of toRemove) deleteFileRows(db, rel);

    const insertChunk = db.prepare(
      "INSERT INTO chunks (path, title, heading, heading_path, start_line, text) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertFts = db.prepare("INSERT INTO chunks_fts (rowid, title, heading, body) VALUES (?, ?, ?, ?)");
    const insertVec = db.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)");
    const insertLink = db.prepare("INSERT OR IGNORE INTO links (chunk_id, target_path) VALUES (?, ?)");
    const upsertFile = db.prepare("INSERT OR REPLACE INTO files (path, mtime_ms, size, title) VALUES (?, ?, ?, ?)");

    let done = 0;
    let aborted = false;
    for (const file of toIndex) {
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }

      let content: string;
      try {
        content = fs.readFileSync(path.join(config.root, file.rel), "utf8");
      } catch {
        continue;
      }

      const chunks = chunkMarkdown(file.rel, content);
      // Embedding is async and slow; the write is sync and atomic. Doing them
      // in that order keeps the transaction short enough not to block readers.
      const vectors: Float32Array[] = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        vectors.push(...(await embed(batch.map(contextualize), "passage")));
      }

      db.transaction(() => {
        deleteFileRows(db, file.rel);
        chunks.forEach((chunk, i) => {
          const id = Number(
            insertChunk.run(
              chunk.path,
              chunk.title,
              chunk.heading,
              JSON.stringify(chunk.headingPath),
              chunk.startLine,
              chunk.text,
            ).lastInsertRowid,
          );
          insertFts.run(id, chunk.title, chunk.heading ?? "", chunk.text);
          const vec = vectors[i];
          if (vec) insertVec.run(BigInt(id), toBlob(vec));
          for (const target of chunk.links) {
            const resolved = resolveLink(target);
            if (resolved) insertLink.run(id, resolved);
          }
        });
        upsertFile.run(file.rel, file.mtimeMs, file.size, chunks[0]?.title ?? file.rel);
      })();

      done += 1;
      onProgress(done, toIndex.length);
    }

    setMeta(db, "built_at", new Date().toISOString());
    setMeta(db, "root", config.root);
    setMeta(db, "embed_model", config.model);

    const chunks = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    return {
      scanned: disk.length,
      indexed: done,
      removed: toRemove.length,
      unchanged: disk.length - toIndex.length,
      chunks,
      ms: Date.now() - started,
      dbBytes: fs.statSync(config.dbPath).size,
      dbPath: config.dbPath,
      aborted,
    };
  } finally {
    db.close();
  }
}
