/**
 * Draft a question set from someone's own notes.
 *
 * Writing fifty good benchmark questions by hand is the reason most people
 * never benchmark anything, so this does the tedious part: pick a spread of
 * notes, propose a question for each, and prefill the expected file and an
 * evidence pattern.
 *
 * What it deliberately does not do is decide the questions are correct. Each
 * one lands with `"reviewed": false` and the runner will not score the set
 * until a human has been through it. That gate is the whole point — a
 * generated question is a guess about your notes, and a benchmark scored
 * against guesses measures nothing.
 *
 * Evidence patterns use the rarest term in each note, measured across the
 * whole corpus. A term that appears in one note is strong proof the answer is
 * there; a term that appears in four hundred proves nothing.
 */

import fs from "node:fs";
import path from "node:path";
import type { DeweyConfig } from "../config.js";
import { chunkMarkdown } from "../core/chunker.js";
import { listMarkdownFiles } from "../core/indexer.js";
import type { QuestionSet } from "./questions.js";

const MIN_TERM_LENGTH = 4;
const MAX_TERM_LENGTH = 30;

export interface ScaffoldOptions {
  count?: number;
  /** Injectable so tests are not at the mercy of file ordering. */
  pick?: <T>(items: T[], n: number) => T[];
}

export function scaffoldQuestionSet(config: DeweyConfig, opts: ScaffoldOptions = {}): QuestionSet {
  const count = opts.count ?? 50;
  const files = listMarkdownFiles(config.root, config.ignoreDirs);
  if (files.length === 0) throw new Error(`No markdown files found in ${config.root}`);

  const documents = files.map((f) => {
    const content = readOrEmpty(path.join(config.root, f.rel));
    return { rel: f.rel, content, terms: tokenize(content) };
  });

  // Document frequency across the corpus, so "rare" means rare here rather
  // than rare in general English.
  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    for (const term of new Set(doc.terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const substantial = documents.filter((d) => d.content.trim().length > 200);
  const chosen = (opts.pick ?? spreadAcrossFolders)(substantial.length > 0 ? substantial : documents, count);

  const questions = chosen.map((doc, i) => {
    const title = titleOf(doc.rel, doc.content);
    const rarest = rarestTerm(doc.terms, documentFrequency);
    return {
      id: `q${String(i + 1).padStart(2, "0")}`,
      q: `what is ${title.toLowerCase()}`,
      expect: [doc.rel],
      evidence: [{ file: doc.rel, pattern: escapeRegex(rarest ?? title) }],
      reviewed: false,
      note: "Rewrite the question the way you would actually ask it, then set reviewed to true.",
    };
  });

  return {
    description:
      "Retrieval ground truth. Each question must be answerable from one of its expect files, " +
      "and the evidence pattern must appear in that file. Rewrite the generated questions in your " +
      "own words before scoring anything.",
    createdAt: new Date().toISOString(),
    questions,
  };
}

/**
 * Sample evenly across top-level folders rather than taking the first N files.
 * An alphabetical slice of most note collections is a slice of one folder, and
 * a benchmark over one folder tells you about that folder.
 */
function spreadAcrossFolders<T extends { rel: string }>(items: T[], n: number): T[] {
  const byFolder = new Map<string, T[]>();
  for (const item of items) {
    const folder = item.rel.includes("/") ? item.rel.slice(0, item.rel.indexOf("/")) : ".";
    const bucket = byFolder.get(folder);
    if (bucket) bucket.push(item);
    else byFolder.set(folder, [item]);
  }

  const buckets = [...byFolder.values()];
  const picked: T[] = [];
  for (let round = 0; picked.length < n; round++) {
    let addedThisRound = false;
    for (const bucket of buckets) {
      const item = bucket[round];
      if (!item) continue;
      picked.push(item);
      addedThisRound = true;
      if (picked.length >= n) break;
    }
    if (!addedThisRound) break;
  }
  return picked;
}

function rarestTerm(terms: string[], documentFrequency: Map<string, number>): string | null {
  let best: string | null = null;
  let bestFrequency = Infinity;
  for (const term of new Set(terms)) {
    const frequency = documentFrequency.get(term) ?? Infinity;
    // Ties break toward the longer term, which is usually the more specific one.
    if (frequency < bestFrequency || (frequency === bestFrequency && best !== null && term.length > best.length)) {
      best = term;
      bestFrequency = frequency;
    }
  }
  return best;
}

function tokenize(content: string): string[] {
  return content
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((t) => t.length >= MIN_TERM_LENGTH && t.length <= MAX_TERM_LENGTH && !/^\d+$/.test(t));
}

function titleOf(rel: string, content: string): string {
  const chunk = chunkMarkdown(rel, content)[0];
  return chunk?.title ?? (rel.split("/").pop() ?? rel).replace(/\.md$/, "");
}

function readOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
