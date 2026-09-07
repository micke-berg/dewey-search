/**
 * Optional cross-encoder reranking pass.
 *
 * Fusion ranks a chunk without ever comparing it to the query directly: BM25
 * sees overlapping terms, the bi-encoder sees two vectors that were computed
 * independently. A cross-encoder reads the query and the chunk together and
 * scores the pair, which is how it resolves the cases fusion cannot — most
 * usefully, a dated digest that mentions a name in passing outranking the page
 * actually about that person.
 *
 * It is off by default and behind a flag because it costs roughly two orders
 * of magnitude more per query than the fused search it corrects, and a
 * keystroke-speed search that stops being keystroke-speed is a different
 * product. Turn it on when answer quality matters more than latency.
 */

import type { DeweyConfig } from "../config.js";
import { encodeBatch, loadModel, toFeeds, type LoadedModel } from "./model-files.js";

/** Query plus candidate texts in, one score per candidate out. Higher is better. */
export type Reranker = (query: string, documents: string[]) => Promise<number[]>;

const encoders = new Map<string, Promise<LoadedModel>>();

async function getCrossEncoder(model: string, cacheDir: string): Promise<LoadedModel> {
  const existing = encoders.get(model);
  if (existing) return existing;
  const loading = loadModel(model, cacheDir);
  loading.catch(() => encoders.delete(model));
  encoders.set(model, loading);
  return loading;
}

export function createReranker(config: DeweyConfig): Reranker {
  return async (query, documents) => {
    if (documents.length === 0) return [];
    const { tokenizer, session, maxLength, padId } = await getCrossEncoder(config.rerankModel, config.modelCacheDir);
    const batch = encodeBatch(
      tokenizer,
      documents.map(() => query),
      { pairs: documents, maxLength, padId },
    );
    const result = await session.run(toFeeds(batch, session.inputNames));
    const logits = result["logits"];
    if (!logits) throw new Error(`Model ${config.rerankModel} returned no logits`);
    const data = logits.data as Float32Array;
    const width = logits.dims[1] ?? 1;
    // bge-reranker emits a single relevance logit per pair; sigmoid maps it to
    // a 0-1 score that is comparable across queries.
    return documents.map((_, i) => 1 / (1 + Math.exp(-(data[i * width] ?? 0))));
  };
}

export function resetRerankerCache(): void {
  encoders.clear();
}
