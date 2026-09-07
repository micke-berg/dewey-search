/**
 * Snippet extraction for search results. Pure.
 *
 * Centres a short window on the first query term that appears in the chunk. A
 * hit with no literal term match — which is most of what the vector retriever
 * contributes — shows the chunk's opening instead of a misleading excerpt from
 * the middle.
 */

export const SNIPPET_CHARS = 170;

export function makeSnippet(text: string, queryTokens: string[], max: number = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;

  const lower = flat.toLowerCase();
  let at = -1;
  for (const token of queryTokens) {
    const t = token.toLowerCase();
    if (!t) continue;
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return cutAtWord(flat, 0, max) + "…";

  const start = Math.max(0, at - Math.floor(max / 3));
  const clipped = cutAtWord(flat, start, max);
  return (start > 0 ? "…" : "") + clipped + (start + clipped.length < flat.length ? "…" : "");
}

/** Never start or end mid-word, unless there is no space to cut on. */
function cutAtWord(text: string, start: number, max: number): string {
  let s = start;
  if (s > 0) {
    const space = text.indexOf(" ", s);
    if (space !== -1 && space - s < 20) s = space + 1;
  }
  let piece = text.slice(s, s + max);
  if (s + max < text.length) {
    const lastSpace = piece.lastIndexOf(" ");
    if (lastSpace > max * 0.6) piece = piece.slice(0, lastSpace);
  }
  return piece.trim();
}
