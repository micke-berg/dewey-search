/**
 * Staleness reporting over the notes themselves, which is a different question
 * from whether the search index is current.
 *
 * The failure this exists for: a note written eighteen months ago that says
 * something confidently, that thirty other notes still link to, and that
 * nobody has reread since. Search finds it, it reads as authoritative, and it
 * is wrong. Age alone does not identify it — most old notes are old because
 * they were finished. What identifies it is age combined with how much the
 * rest of the corpus still leans on it.
 *
 * So the ranking signal here is inbound links times age, not age. A stale note
 * nothing references is housekeeping; a stale note forty notes point at is a
 * live source of wrong answers.
 *
 * Modification times come from disk rather than the index, so this stays
 * accurate even when the index is behind.
 */

import type { DeweyConfig } from "../config.js";
import { openDb } from "./db.js";
import { listMarkdownFiles } from "./indexer.js";

export interface StaleNote {
  path: string;
  title: string;
  /** Whole days since the file was last modified. */
  ageDays: number;
  /** Distinct notes linking to this one. */
  inboundLinks: number;
  /** Distinct notes this one links to. */
  outboundLinks: number;
  sizeBytes: number;
  /** ageDays × (1 + inboundLinks). Higher means "reread this one first". */
  risk: number;
}

export interface StalenessReport {
  /** Notes older than the threshold, most at-risk first. */
  notes: StaleNote[];
  /** Every markdown file seen on disk. */
  totalNotes: number;
  /** How many exceeded the age threshold, before any limit was applied. */
  staleCount: number;
  /** Notes with no inbound and no outbound links at all. */
  orphanCount: number;
  thresholdDays: number;
  medianAgeDays: number;
  /** True when there is no index, so link counts are all zero. */
  linkDataMissing: boolean;
}

export interface StalenessOptions {
  /** A note is stale past this many days since modification. Default 180. */
  olderThanDays?: number;
  /** Cap on returned notes. Default 20. */
  limit?: number;
  /** Only consider notes whose path starts with this prefix. */
  pathPrefix?: string | undefined;
  /** Injectable for tests. */
  now?: number;
}

const DAY_MS = 86_400_000;

export function getStaleNotes(config: DeweyConfig, opts: StalenessOptions = {}): StalenessReport {
  const thresholdDays = opts.olderThanDays ?? 180;
  const limit = opts.limit ?? 20;
  const now = opts.now ?? Date.now();

  const files = listMarkdownFiles(config.root, config.ignoreDirs).filter(
    (f) => !opts.pathPrefix || f.rel.startsWith(opts.pathPrefix),
  );

  const { inbound, outbound, titles, linkDataMissing } = loadLinkGraph(config.dbPath);

  const scored: StaleNote[] = files.map((f) => {
    const ageDays = Math.max(0, Math.floor((now - f.mtimeMs) / DAY_MS));
    const inboundLinks = inbound.get(f.rel) ?? 0;
    return {
      path: f.rel,
      title: titles.get(f.rel) ?? basename(f.rel),
      ageDays,
      inboundLinks,
      outboundLinks: outbound.get(f.rel) ?? 0,
      sizeBytes: f.size,
      risk: ageDays * (1 + inboundLinks),
    };
  });

  const stale = scored.filter((n) => n.ageDays >= thresholdDays);

  return {
    notes: [...stale].sort((a, b) => b.risk - a.risk || b.ageDays - a.ageDays).slice(0, limit),
    totalNotes: scored.length,
    staleCount: stale.length,
    orphanCount: scored.filter((n) => n.inboundLinks === 0 && n.outboundLinks === 0).length,
    thresholdDays,
    medianAgeDays: median(scored.map((n) => n.ageDays)),
    linkDataMissing,
  };
}

interface LinkGraph {
  inbound: Map<string, number>;
  outbound: Map<string, number>;
  titles: Map<string, string>;
  linkDataMissing: boolean;
}

/**
 * Link counts are per distinct note pair, not per link occurrence. A note that
 * mentions another one eleven times is one relationship, and counting it as
 * eleven would put chatty notes at the top of every report.
 */
function loadLinkGraph(dbPath: string): LinkGraph {
  const db = openDb({ dbPath });
  if (!db) return { inbound: new Map(), outbound: new Map(), titles: new Map(), linkDataMissing: true };

  try {
    const inbound = new Map<string, number>();
    const outbound = new Map<string, number>();

    const edges = db
      .prepare(
        `SELECT DISTINCT c.path AS source, l.target_path AS target
         FROM links l JOIN chunks c ON c.id = l.chunk_id
         WHERE c.path <> l.target_path`,
      )
      .all() as { source: string; target: string }[];

    for (const { source, target } of edges) {
      inbound.set(target, (inbound.get(target) ?? 0) + 1);
      outbound.set(source, (outbound.get(source) ?? 0) + 1);
    }

    const titles = new Map(
      (db.prepare("SELECT path, title FROM files").all() as { path: string; title: string }[]).map((r) => [
        r.path,
        r.title,
      ]),
    );

    return { inbound, outbound, titles, linkDataMissing: false };
  } finally {
    db.close();
  }
}

function basename(p: string): string {
  return (p.split("/").pop() ?? p).replace(/\.md$/, "");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2) : (sorted[mid] ?? 0);
}
