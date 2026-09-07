/**
 * Shared test scaffolding. Excluded from the published build.
 *
 * Tests never load a real embedding model. A 120 MB download would make the
 * suite depend on the network and on a cache directory, and it would measure
 * the model rather than this code. The fake below is deterministic and has
 * just enough structure to make fusion behave like fusion: it hashes tokens
 * into a fixed number of dimensions, so texts sharing vocabulary genuinely
 * land near each other and texts that do not, do not.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig, type DeweyConfig } from "./config.js";
import type { EmbedFn } from "./core/embedder.js";

export const TEST_DIMS = 64;

/**
 * Hashed bag-of-words embeddings, L2-normalised. Not good retrieval — it has
 * no notion of synonyms — but it is a real vector space with real distances,
 * which is what the fusion and storage paths need in order to be tested.
 */
export function createFakeEmbedder(dims: number = TEST_DIMS): EmbedFn {
  return (texts) =>
    Promise.resolve(
      texts.map((text) => {
        const vector = new Float32Array(dims);
        for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
          if (!token) continue;
          let hash = 2166136261;
          for (let i = 0; i < token.length; i++) {
            hash = Math.imul(hash ^ token.charCodeAt(i), 16777619);
          }
          const slot = Math.abs(hash) % dims;
          vector[slot] = (vector[slot] ?? 0) + 1;
        }
        const magnitude = Math.hypot(...vector) || 1;
        for (let i = 0; i < dims; i++) vector[i] = vector[i]! / magnitude;
        return vector;
      }),
    );
}

export interface Workspace {
  root: string;
  dbPath: string;
  config: DeweyConfig;
  write: (relativePath: string, content: string) => void;
  remove: (relativePath: string) => void;
  cleanup: () => void;
}

/** A throwaway notes folder plus a config pointing at it. */
export function createWorkspace(files: Record<string, string> = {}): Workspace {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dewey-ws-"));
  const root = path.join(base, "notes");
  fs.mkdirSync(root, { recursive: true });

  const write = (relativePath: string, content: string): void => {
    const full = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  };

  for (const [relativePath, content] of Object.entries(files)) write(relativePath, content);

  const dbPath = path.join(base, "index.db");
  const config: DeweyConfig = {
    ...resolveConfig({ root, dbPath, env: {} }),
    embedDims: TEST_DIMS,
  };

  return {
    // The canonical spelling, matching what the config resolved to. On macOS
    // the temp directory is a symlink, so the raw path and the resolved one
    // differ and tests comparing the two would be comparing spellings.
    root: config.root,
    dbPath,
    config,
    write,
    remove: (relativePath: string) => fs.rmSync(path.join(root, relativePath), { force: true }),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

/** Nudge a file's mtime into the past, for staleness and freshness tests. */
export function ageFile(root: string, relativePath: string, days: number): void {
  const full = path.join(root, relativePath);
  const when = new Date(Date.now() - days * 86_400_000);
  fs.utimesSync(full, when, when);
}
