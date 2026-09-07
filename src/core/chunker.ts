/**
 * Heading-aware markdown chunker. Pure functions, no IO: content in, typed
 * chunks out.
 *
 * The unit of retrieval is a heading section rather than a file or a fixed
 * token window. Notes are already structured by their author, and a heading is
 * that author saying "this part is about one thing" — cutting anywhere else
 * throws away a signal you would otherwise have to infer. Sections that grow
 * past what the embedder can usefully represent fall back to a sliding window
 * over paragraph boundaries.
 *
 * `[[wikilinks]]` are extracted per chunk and resolved against the folder's
 * file list by the indexer, which gives the index a link graph for free.
 */

export interface Chunk {
  /** Path relative to the notes root, using forward slashes. */
  path: string;
  /** Page title: the first H1, else the filename without its extension. */
  title: string;
  /** Nearest heading above the chunk; null for content before any heading. */
  heading: string | null;
  /** Full heading trail, e.g. ["Retrieval", "Benchmark"]. */
  headingPath: string[];
  /** 1-based line where the chunk's text starts in the original file. */
  startLine: number;
  text: string;
  /** Raw [[wikilink]] targets in this chunk, alias and anchor stripped. */
  links: string[];
}

/** A section longer than this switches to the sliding-window fallback. */
export const MAX_CHUNK_CHARS = 2000;
export const WINDOW_CHARS = 1400;
export const WINDOW_OVERLAP_CHARS = 200;

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Extract `[[wikilink]]` targets, with alias and `#anchor` stripped. */
export function extractWikilinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = m[1]?.trim();
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}

interface Section {
  heading: string | null;
  headingPath: string[];
  startLine: number;
  lines: string[];
}

/**
 * Split markdown into heading-delimited sections. Fence-aware, because `#` at
 * the start of a line inside a code block is a comment in half the languages
 * people paste, not a heading.
 */
function splitSections(body: string, firstLine: number): { title: string | null; sections: Section[] } {
  const lines = body.split("\n");
  const sections: Section[] = [{ heading: null, headingPath: [], startLine: firstLine, lines: [] }];
  const trail: { level: number; text: string }[] = [];
  let title: string | null = null;
  let inFence = false;

  lines.forEach((line, i) => {
    if (/^```/.test(line.trim())) inFence = !inFence;
    const m = !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (!m?.[1] || !m[2]) {
      sections[sections.length - 1]!.lines.push(line);
      return;
    }
    const level = m[1].length;
    const text = m[2];
    if (level === 1 && title === null) title = text;
    while (trail.length > 0 && trail[trail.length - 1]!.level >= level) trail.pop();
    trail.push({ level, text });
    sections.push({
      heading: text,
      headingPath: trail.map((t) => t.text),
      startLine: firstLine + i + 1,
      lines: [],
    });
  });

  return { title, sections };
}

/** Sliding window over paragraphs, for sections longer than MAX_CHUNK_CHARS. */
function windowText(text: string): { offset: number; text: string }[] {
  if (text.length <= MAX_CHUNK_CHARS) return [{ offset: 0, text }];

  const parts: { offset: number; text: string }[] = [];
  let offset = 0;
  for (const para of text.split(/\n\n+/)) {
    const at = text.indexOf(para, offset);
    if (para.trim()) parts.push({ offset: at, text: para });
    offset = at + para.length;
  }

  const windows: { offset: number; text: string }[] = [];
  let current: { offset: number; text: string } | null = null;
  for (const part of parts.flatMap(hardSplit)) {
    if (!current) {
      current = { ...part };
    } else if (current.text.length + part.text.length + 2 <= WINDOW_CHARS) {
      current.text += "\n\n" + part.text;
    } else {
      windows.push(current);
      // Carry the tail of the previous window into the next one, so a fact
      // that straddles the cut is fully present in at least one chunk.
      // Annotated because `current` is being reassigned from an expression
      // that reads it, which otherwise makes these implicitly `any`.
      const tail: string = current.text.slice(-WINDOW_OVERLAP_CHARS);
      const tailAt: number = current.offset + current.text.length - tail.length;
      current = { offset: Math.min(tailAt, part.offset), text: tail + "\n\n" + part.text };
    }
  }
  if (current) windows.push(current);
  return windows;
}

/**
 * A single paragraph longer than one window gets hard-cut on sentence-ish
 * edges. No overlap here: the window loop above already carries the tail, and
 * doing it in both places duplicates text into the index.
 */
function hardSplit(part: { offset: number; text: string }): { offset: number; text: string }[] {
  if (part.text.length <= WINDOW_CHARS) return [part];
  const out: { offset: number; text: string }[] = [];
  let rest = part.text;
  let offset = part.offset;
  while (rest.length > WINDOW_CHARS) {
    let cut = rest.lastIndexOf(". ", WINDOW_CHARS);
    if (cut < WINDOW_CHARS / 2) cut = rest.lastIndexOf(" ", WINDOW_CHARS);
    if (cut < WINDOW_CHARS / 2) cut = WINDOW_CHARS;
    out.push({ offset, text: rest.slice(0, cut + 1).trim() });
    offset += cut + 1;
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push({ offset, text: rest.trim() });
  return out;
}

/**
 * Chunk one markdown page. YAML frontmatter is skipped rather than indexed —
 * it is metadata about the note, and indexing it makes every note with a
 * `tags:` block a weak match for every tag query.
 */
export function chunkMarkdown(notePath: string, content: string): Chunk[] {
  const fm = FRONTMATTER_RE.exec(content);
  const body = fm ? content.slice(fm[0].length) : content;
  const firstLine = fm ? fm[0].split("\n").length : 1;
  const fileName = notePath.split("/").pop() ?? notePath;
  const { title, sections } = splitSections(body, firstLine);
  const pageTitle = title ?? fileName.replace(/\.md$/, "");

  const chunks: Chunk[] = [];
  for (const section of sections) {
    const text = section.lines.join("\n").trim();
    if (!text) continue;
    for (const win of windowText(text)) {
      const linesBefore = text.slice(0, win.offset).split("\n").length - 1;
      chunks.push({
        path: notePath,
        title: pageTitle,
        heading: section.heading,
        headingPath: section.headingPath,
        startLine: section.startLine + linesBefore,
        text: win.text.trim(),
        links: extractWikilinks(win.text),
      });
    }
  }
  return chunks;
}

/**
 * A chunk as a model should see it: title and heading trail prepended to the
 * body.
 *
 * This matters more than it looks. Sections are split *at* their headings, so
 * the heading text is not in the body — a chunk under `## Anna` may not contain
 * the word "Anna" anywhere. Any model scoring the bare body is scoring text with
 * its subject removed.
 *
 * Both the indexer and the reranker use this, and they have to use the same one:
 * embedding contextualised text and then reranking bare text means the two
 * stages are ranking different documents.
 */
export function contextualize(chunk: Pick<Chunk, "title" | "headingPath" | "text">): string {
  const trail = chunk.headingPath.length > 0 ? ` · ${chunk.headingPath.join(" › ")}` : "";
  return `${chunk.title}${trail}\n${chunk.text}`;
}

/**
 * Resolve a wikilink target to a path in the folder, the way note apps do it:
 * an exact relative path first, then a unique basename match. Returns null for
 * targets that do not exist — a link to a note you have not written yet is a
 * normal thing to have, and inventing a destination for it would put a
 * fabricated edge in the graph.
 */
export function buildLinkResolver(paths: string[]): (target: string) => string | null {
  const byRelative = new Map<string, string>();
  const byName = new Map<string, string | null>(); // null marks an ambiguous basename
  for (const p of paths) {
    const rel = p.replace(/\.md$/, "").toLowerCase();
    byRelative.set(rel, p);
    const name = rel.split("/").pop()!;
    byName.set(name, byName.has(name) ? null : p);
  }
  return (target: string) => {
    const t = target.replace(/\.md$/, "").toLowerCase();
    return byRelative.get(t) ?? byName.get(t.split("/").pop() ?? t) ?? null;
  };
}
