/**
 * How far behind is the index?
 *
 * A derived cache that can go quietly stale is worse than no cache, because
 * the failure is invisible: a search over a five-day-old index looks exactly
 * like a search over a fresh one, right up until it confidently fails to
 * return the note you wrote this morning. So every search response carries
 * these numbers, and the caller is expected to show them.
 *
 * The staleness check reuses the indexer's own change predicate rather than
 * approximating it. If the two ever disagreed, this would report "up to date"
 * about files a rebuild would immediately re-read.
 *
 * Read-only in both directions: it stats the notes folder and reads the index,
 * and writes neither.
 */

import type { DeweyConfig } from "../config.js";
import { getIndexStatus, openDb, type IndexStatus } from "./db.js";
import { isChanged, listMarkdownFiles } from "./indexer.js";

export interface IndexFreshness extends IndexStatus {
  /** Files present in the folder but never indexed. */
  added: number;
  /** Files whose mtime or size moved since they were indexed. */
  changed: number;
  /** Indexed files no longer on disk. */
  removed: number;
  /** added + changed + removed: the work one refresh would do. */
  behind: number;
  /** Whole hours since the index was last written; null when never built. */
  ageHours: number | null;
}

const NO_DRIFT = { added: 0, changed: 0, removed: 0, behind: 0 } as const;

/**
 * Status and drift in one pass. Costs one directory walk with stats but no
 * file reads, which is single-digit milliseconds for a few thousand notes —
 * cheap enough to attach to every search response.
 */
export function getFreshness(config: DeweyConfig): IndexFreshness {
  const status = getIndexStatus(config.dbPath);
  if (!status.built) return { ...status, ...NO_DRIFT, ageHours: null };

  const ageHours = status.builtAt
    ? Math.max(0, Math.floor((Date.now() - new Date(status.builtAt).getTime()) / 3_600_000))
    : null;

  const db = openDb({ dbPath: config.dbPath });
  if (!db) return { ...status, ...NO_DRIFT, ageHours };

  try {
    const known = new Map(
      (
        db.prepare("SELECT path, mtime_ms, size FROM files").all() as {
          path: string;
          mtime_ms: number;
          size: number;
        }[]
      ).map((r) => [r.path, r]),
    );

    const disk = listMarkdownFiles(config.root, config.ignoreDirs);
    let added = 0;
    let changed = 0;
    for (const file of disk) {
      const k = known.get(file.rel);
      if (!k) added += 1;
      else if (isChanged(file, k)) changed += 1;
    }

    const diskPaths = new Set(disk.map((f) => f.rel));
    const removed = [...known.keys()].filter((p) => !diskPaths.has(p)).length;

    return { ...status, added, changed, removed, behind: added + changed + removed, ageHours };
  } finally {
    db.close();
  }
}

/** One line a caller can show verbatim next to results. */
export function describeFreshness(f: IndexFreshness): string {
  if (!f.built) return "No index yet.";
  if (f.behind === 0) return `Index up to date, ${String(f.files)} files.`;
  const parts: string[] = [];
  if (f.added > 0) parts.push(`${String(f.added)} new`);
  if (f.changed > 0) parts.push(`${String(f.changed)} changed`);
  if (f.removed > 0) parts.push(`${String(f.removed)} deleted`);
  return `Index is ${String(f.behind)} file${f.behind === 1 ? "" : "s"} behind (${parts.join(", ")}).`;
}
