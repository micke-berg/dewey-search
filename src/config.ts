/**
 * Configuration resolution.
 *
 * Dewey indexes a folder you name and writes its index somewhere else. Both
 * paths are decisions a user can get wrong in ways that are hard to notice, so
 * they are resolved once, here, and validated rather than trusted:
 *
 * - the notes folder must exist and be a directory;
 * - the index database defaults OUTSIDE the notes folder, because an index
 *   file that lives inside the corpus ends up in the user's sync client, their
 *   git history, and eventually in the index itself.
 *
 * Every value can come from a flag, an environment variable, or the default,
 * in that order.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize, isInside } from "./core/paths.js";

/**
 * Embedding models known to work, with their output dimensions. The dimension
 * is baked into the vector table at build time, so it has to be known before
 * the first insert rather than discovered from the first result.
 */
export const KNOWN_MODELS = {
  "Xenova/multilingual-e5-small": { dims: 384, prefixes: true },
  "Xenova/multilingual-e5-base": { dims: 768, prefixes: true },
  "Xenova/bge-small-en-v1.5": { dims: 384, prefixes: false },
  "Xenova/all-MiniLM-L6-v2": { dims: 384, prefixes: false },
} as const satisfies Record<string, { dims: number; prefixes: boolean }>;

export type KnownModel = keyof typeof KNOWN_MODELS;

/**
 * Multilingual by default. An English-only model scores better on English-only
 * corpora, but silently collapses on notes that mix languages, and a user whose
 * notes are half Swedish has no way to attribute the bad results to the model
 * choice. Losing a little English accuracy is the cheaper mistake.
 */
export const DEFAULT_MODEL: KnownModel = "Xenova/multilingual-e5-small";

/** Cross-encoder used by the optional reranking pass. */
export const DEFAULT_RERANK_MODEL = "Xenova/bge-reranker-base";

export const configSchema = z.object({
  /** Absolute path to the folder of markdown notes. */
  root: z.string().min(1),
  /** Absolute path to the SQLite index. Never inside `root`. */
  dbPath: z.string().min(1),
  model: z.string().min(1).default(DEFAULT_MODEL),
  embedDims: z.number().int().positive().default(KNOWN_MODELS[DEFAULT_MODEL].dims),
  /** E5-family models require "query:"/"passage:" prefixes; most others do not. */
  modelPrefixes: z.boolean().default(KNOWN_MODELS[DEFAULT_MODEL].prefixes),
  /** Directory names skipped during the walk, in addition to all dotfiles. */
  ignoreDirs: z.array(z.string()).default(["node_modules"]),
  /** Where transformers.js caches ONNX weights. */
  modelCacheDir: z.string().min(1),
  rerank: z.boolean().default(false),
  rerankModel: z.string().min(1).default(DEFAULT_RERANK_MODEL),
});

export type DeweyConfig = z.infer<typeof configSchema>;

export const CACHE_HOME = path.join(os.homedir(), ".cache", "dewey");

/**
 * One index per notes folder, keyed by a hash of the absolute path. Using the
 * path itself would break on the spaces and non-ASCII that real note folders
 * are full of; a short hash keeps filenames boring and collision-free enough
 * for a per-user cache. The readable prefix is there so a human can tell which
 * database belongs to which folder without opening it.
 */
export function defaultDbPath(root: string): string {
  const digest = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 10);
  const label = path.basename(path.resolve(root)).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 32) || "notes";
  return path.join(CACHE_HOME, `${label}-${digest}.db`);
}

export interface ResolveConfigInput {
  root?: string | undefined;
  dbPath?: string | undefined;
  model?: string | undefined;
  rerank?: boolean | undefined;
  rerankModel?: string | undefined;
  ignoreDirs?: string[] | undefined;
  env?: NodeJS.ProcessEnv;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Flags beat environment beats defaults. Throws `ConfigError` with a message
 * meant to be shown to a user, not logged — a misconfigured notes path is the
 * single most likely first-run failure and deserves a sentence that says what
 * to do about it.
 */
export function resolveConfig(input: ResolveConfigInput = {}): DeweyConfig {
  const env = input.env ?? process.env;

  const rawRoot = input.root ?? env["DEWEY_NOTES"];
  if (!rawRoot) {
    throw new ConfigError(
      "No notes folder given. Pass --notes <path>, or set DEWEY_NOTES to the folder you want indexed.",
    );
  }
  const requestedRoot = path.resolve(expandHome(rawRoot));

  let stat: fs.Stats;
  try {
    stat = fs.statSync(requestedRoot);
  } catch {
    throw new ConfigError(`Notes folder does not exist: ${requestedRoot}`);
  }
  if (!stat.isDirectory()) throw new ConfigError(`Notes path is not a directory: ${requestedRoot}`);

  // Canonicalised once, here, so every later comparison is against the same
  // spelling. Without this a symlinked root (`/tmp` on macOS, or a folder
  // someone symlinks into their sync client) gets recorded in the index one
  // way and resolved by the path guard another, and the index looks like it
  // belongs to a different folder on every startup.
  const root = fs.realpathSync(requestedRoot);

  // Canonicalised for the same reason the root is: the containment check below
  // compares two paths, and comparing a resolved one against an unresolved one
  // silently misses the case it exists to catch.
  const dbPath = canonicalize(expandHome(input.dbPath ?? env["DEWEY_DB"] ?? defaultDbPath(root)));
  if (isInside(dbPath, root)) {
    throw new ConfigError(
      `The index database would live inside the notes folder (${dbPath}). ` +
        "Choose a path outside it so the index does not end up synced, committed, or indexed by itself.",
    );
  }

  const model = input.model ?? env["DEWEY_MODEL"] ?? DEFAULT_MODEL;
  const known: { dims: number; prefixes: boolean } | undefined =
    KNOWN_MODELS[model as KnownModel];
  if (!known) {
    throw new ConfigError(
      `Unknown embedding model "${model}". Known models: ${Object.keys(KNOWN_MODELS).join(", ")}. ` +
        "Other models may work but their output dimensions have to be known before the index is built.",
    );
  }

  return configSchema.parse({
    root,
    dbPath,
    model,
    embedDims: known.dims,
    modelPrefixes: known.prefixes,
    ignoreDirs: input.ignoreDirs ?? splitList(env["DEWEY_IGNORE"]) ?? ["node_modules"],
    modelCacheDir: path.join(CACHE_HOME, "models"),
    rerank: input.rerank ?? env["DEWEY_RERANK"] === "1",
    rerankModel: input.rerankModel ?? env["DEWEY_RERANK_MODEL"] ?? DEFAULT_RERANK_MODEL,
  });
}

function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? path.join(os.homedir(), p.slice(1)) : p;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}
