/**
 * Reciprocal-rank fusion (Cormack, Clarke & Buettcher, 2009) — the whole of
 * the "hybrid" in hybrid search, kept pure so the arithmetic is pinned by
 * tests rather than inferred from search results.
 *
 * Each retriever contributes `1 / (K + rank)` per item and items appearing on
 * several lists add up. Fusing on rank rather than score is the point: BM25
 * scores and cosine distances are not on comparable scales and normalising
 * them means inventing a conversion. Rank needs no such invention, at the cost
 * of throwing away how *confident* each retriever was.
 */

/** Standard RRF constant. Dampens the head so one list cannot dominate. */
export const RRF_K = 60;

export interface FusedItem<Id> {
  id: Id;
  /** Sum of 1/(K + rank) across the lists this item appeared on. */
  score: number;
  /** 1-based rank per source list, only for lists the item appeared on. */
  ranks: Record<string, number>;
}

/**
 * Fuse ordered id lists (best first) into one ranking. Ties break on the best
 * single-list rank, so the output order is stable across runs — an unstable
 * ranking makes every benchmark number a little bit fiction.
 */
export function fuseRrf<Id>(lists: { source: string; ids: Id[] }[], k: number = RRF_K): FusedItem<Id>[] {
  const items = new Map<Id, FusedItem<Id>>();
  for (const list of lists) {
    list.ids.forEach((id, i) => {
      const rank = i + 1;
      const item = items.get(id) ?? { id, score: 0, ranks: {} };
      // A duplicate id within one list keeps its best (first) rank.
      if (list.source in item.ranks) return;
      item.score += 1 / (k + rank);
      item.ranks[list.source] = rank;
      items.set(id, item);
    });
  }
  return [...items.values()].sort((a, b) => b.score - a.score || bestRank(a) - bestRank(b));
}

function bestRank<Id>(item: FusedItem<Id>): number {
  return Math.min(...Object.values(item.ranks));
}
