/**
 * Synthetic corpus generator, for testing behaviour at sizes most people's
 * real notes will not reach.
 *
 * The incumbent tools in this space are known to degrade past roughly twenty
 * thousand notes, and "it works on my four hundred notes" is not evidence
 * about that. This produces a corpus with the properties that actually stress
 * a hybrid index: a heavy-tailed link graph so some notes have hundreds of
 * inbound links, vocabulary that overlaps between notes so BM25 cannot win by
 * exact match alone, and a spread of file sizes rather than a uniform one.
 *
 * The text is nonsense on purpose. This measures throughput, index size and
 * latency, and says nothing about retrieval quality — for that you need a
 * verified question set over real notes.
 */

import fs from "node:fs";
import path from "node:path";

const TOPICS = [
  "retrieval", "indexing", "ranking", "embedding", "tokenizer", "latency", "throughput", "cache",
  "migration", "schema", "contract", "invoice", "roadmap", "postmortem", "onboarding", "pricing",
  "deployment", "rollback", "telemetry", "quota", "handover", "interview", "prototype", "audit",
];

const SUBJECTS = [
  "the ingest path", "the nightly job", "the review queue", "the staging cluster", "the client export",
  "the billing run", "the archive sweep", "the search surface", "the sync worker", "the alert rules",
];

/**
 * Deterministic PRNG so a corpus can be regenerated identically. Benchmarks
 * that cannot be reproduced are anecdotes.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthOptions {
  outDir: string;
  count: number;
  seed?: number;
  folders?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface SynthStats {
  files: number;
  bytes: number;
  ms: number;
  outDir: string;
}

export function generateCorpus(opts: SynthOptions): SynthStats {
  const started = Date.now();
  const random = mulberry32(opts.seed ?? 1);
  const folderCount = opts.folders ?? 24;

  fs.mkdirSync(opts.outDir, { recursive: true });
  for (let f = 0; f < folderCount; f++) {
    fs.mkdirSync(path.join(opts.outDir, `area-${String(f).padStart(2, "0")}`), { recursive: true });
  }

  let bytes = 0;
  for (let i = 0; i < opts.count; i++) {
    const folder = `area-${String(Math.floor(random() * folderCount)).padStart(2, "0")}`;
    const rel = path.join(folder, `note-${String(i).padStart(6, "0")}.md`);
    const content = renderNote(i, opts.count, random);
    fs.writeFileSync(path.join(opts.outDir, rel), content, "utf8");
    bytes += Buffer.byteLength(content, "utf8");
    if ((i + 1) % 1000 === 0) opts.onProgress?.(i + 1, opts.count);
  }

  return { files: opts.count, bytes, ms: Date.now() - started, outDir: opts.outDir };
}

function renderNote(index: number, total: number, random: () => number): string {
  const topic = TOPICS[Math.floor(random() * TOPICS.length)]!;
  const secondary = TOPICS[Math.floor(random() * TOPICS.length)]!;
  const sectionCount = 2 + Math.floor(random() * 6);

  const lines: string[] = [
    "---",
    `id: note-${String(index)}`,
    `topic: ${topic}`,
    "---",
    "",
    `# Note ${String(index)} on ${topic}`,
    "",
    `Working notes about ${topic} and how it interacts with ${secondary}.`,
    "",
  ];

  for (let s = 0; s < sectionCount; s++) {
    lines.push(`## ${capitalize(TOPICS[Math.floor(random() * TOPICS.length)]!)} ${String(s + 1)}`, "");
    const paragraphs = 1 + Math.floor(random() * 3);
    for (let p = 0; p < paragraphs; p++) lines.push(sentence(random), "");

    // Link targets are drawn from a squared distribution, so low-numbered
    // notes accumulate most of the inbound links. A uniform graph would make
    // every note equally important and hide the hub behaviour entirely.
    if (random() < 0.7) {
      const target = Math.floor(random() * random() * total);
      lines.push(`See [[area-${String(target % 24).padStart(2, "0")}/note-${String(target).padStart(6, "0")}]].`, "");
    }
  }

  return lines.join("\n");
}

function sentence(random: () => number): string {
  const parts: string[] = [];
  const clauses = 2 + Math.floor(random() * 4);
  for (let i = 0; i < clauses; i++) {
    const subject = SUBJECTS[Math.floor(random() * SUBJECTS.length)]!;
    const topic = TOPICS[Math.floor(random() * TOPICS.length)]!;
    parts.push(`${capitalize(subject)} depends on ${topic} more than the previous revision assumed`);
  }
  return parts.join(", and ") + ".";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
