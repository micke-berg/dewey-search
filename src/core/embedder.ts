/**
 * Local embeddings via ONNX Runtime. Fully offline after a one-time model
 * download, no API key, no request leaving the machine — which for a tool
 * pointed at someone's private notes is a correctness requirement rather than
 * a performance one.
 *
 * The E5 family expects "query:" and "passage:" prefixes and quietly loses
 * accuracy without them. Applying them here means no caller can forget, and
 * models that do not want them are marked in the model table instead of being
 * handled at each call site.
 */

import type { DeweyConfig } from "../config.js";
import { encodeBatch, loadModel, meanPoolNormalize, toFeeds, type LoadedModel } from "./model-files.js";

/** The seam. Tests inject a deterministic fake instead of loading a model. */
export type EmbedFn = (texts: string[], kind: "query" | "passage") => Promise<Float32Array[]>;

const models = new Map<string, Promise<LoadedModel>>();

async function getModel(model: string, cacheDir: string): Promise<LoadedModel> {
  const existing = models.get(model);
  if (existing) return existing;
  const loading = loadModel(model, cacheDir);
  // A failed load must not poison every later call — an interrupted first
  // download is the common case and the next attempt usually succeeds.
  loading.catch(() => models.delete(model));
  models.set(model, loading);
  return loading;
}

/**
 * Build the embedder for a config. Batched, mean-pooled and L2-normalised, so
 * cosine similarity is a plain dot product downstream.
 */
export function createEmbedder(config: DeweyConfig): EmbedFn {
  return async (texts, kind) => {
    if (texts.length === 0) return [];
    const { tokenizer, session, maxLength, padId } = await getModel(config.model, config.modelCacheDir);
    const input = config.modelPrefixes ? texts.map((t) => `${kind}: ${t}`) : texts;
    const batch = encodeBatch(tokenizer, input, { maxLength, padId });
    const result = await session.run(toFeeds(batch, session.inputNames));
    const hidden = result["last_hidden_state"];
    if (!hidden) throw new Error(`Model ${config.model} returned no last_hidden_state`);
    const dims = hidden.dims[2] ?? 0;
    return meanPoolNormalize(hidden.data as Float32Array, batch.mask, dims);
  };
}

/**
 * Load the model ahead of first use. Worth calling before a benchmark, so the
 * one-time load is not smeared across the first query's latency and reported
 * as if it were the cost of searching.
 */
export async function warmEmbedder(config: DeweyConfig): Promise<void> {
  await getModel(config.model, config.modelCacheDir);
}

/** Test seam: drop cached models so a case can swap implementations. */
export function resetEmbedderCache(): void {
  models.clear();
}
