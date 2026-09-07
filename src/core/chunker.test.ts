import { describe, expect, it } from "vitest";
import { buildLinkResolver, chunkMarkdown, extractWikilinks, MAX_CHUNK_CHARS } from "./chunker.js";

const PAGE = `---
status: live
updated: 2026-07-18
---
Intro line before any heading with a [[projects/index|the projects page]].

# Field Notes

Notes on retrieval. Blandade språk: å ä ö räknas som bokstäver, inte accenter.

## Retrieval

Hybrid search over a notes folder, see [[research/fusion-2026-07-18#Method]].

### Benchmark

Fifty questions, honest numbers, no cherry-picking.

## Empty section

## Links

Points at [[log]] and [[inbox/queue]] and a dangling [[does-not-exist]].
`;

describe("chunkMarkdown", () => {
  const chunks = chunkMarkdown("notes/field-notes.md", PAGE);

  it("chunks by heading, skipping frontmatter and empty sections", () => {
    expect(chunks.map((c) => c.heading)).toEqual([null, "Field Notes", "Retrieval", "Benchmark", "Links"]);
    expect(chunks.every((c) => !c.text.includes("status: live"))).toBe(true);
  });

  it("titles every chunk with the first H1 and tracks the heading trail", () => {
    expect(chunks.every((c) => c.title === "Field Notes")).toBe(true);
    expect(chunks.find((c) => c.heading === "Benchmark")!.headingPath).toEqual([
      "Field Notes",
      "Retrieval",
      "Benchmark",
    ]);
  });

  it("keeps non-ASCII text intact", () => {
    expect(chunks.find((c) => c.heading === "Field Notes")!.text).toContain("å ä ö räknas som bokstäver");
  });

  it("extracts wikilinks per chunk, stripping aliases and anchors", () => {
    expect(chunks[0]!.links).toEqual(["projects/index"]);
    expect(chunks.find((c) => c.heading === "Retrieval")!.links).toEqual(["research/fusion-2026-07-18"]);
    expect(chunks.find((c) => c.heading === "Links")!.links).toEqual(["log", "inbox/queue", "does-not-exist"]);
  });

  it("points startLine at the chunk's content in the original file", () => {
    // Lines 1-4 are frontmatter, line 5 is the intro.
    expect(chunks[0]!.startLine).toBe(5);
    const retrieval = chunks.find((c) => c.heading === "Retrieval")!;
    expect(PAGE.split("\n")[retrieval.startLine - 2]).toBe("## Retrieval");
  });

  it("falls back to a sliding window for long sections, with overlap", () => {
    const paragraphs = Array.from({ length: 70 }, (_, i) => `Paragraph ${i} about retrieval and ranking.`);
    const out = chunkMarkdown("long.md", `# Long\n\n## Wall\n\n${paragraphs.join("\n\n")}\n`);
    const wall = out.filter((c) => c.heading === "Wall");
    expect(wall.length).toBeGreaterThan(1);
    expect(wall.every((c) => c.text.length <= MAX_CHUNK_CHARS)).toBe(true);
    for (let i = 1; i < wall.length; i++) {
      const tail = wall[i - 1]!.text.slice(-60);
      expect(wall[i]!.text).toContain(tail.slice(tail.indexOf(" ") + 1, tail.indexOf(" ") + 30));
    }
  });

  it("hard-cuts a single paragraph longer than the window", () => {
    const out = chunkMarkdown("m.md", `# M\n\n## One\n\n${"word ".repeat(1500)}\n`).filter((c) => c.heading === "One");
    expect(out.length).toBeGreaterThan(1);
    // The invariant the embedder relies on: no chunk exceeds MAX_CHUNK_CHARS.
    expect(out.every((c) => c.text.length <= MAX_CHUNK_CHARS)).toBe(true);
  });

  it("uses the file name as title when there is no H1", () => {
    expect(chunkMarkdown("inbox/today.md", "Just content, no heading.")[0]!.title).toBe("today");
  });

  it("ignores heading-look-alikes inside code fences", () => {
    const fenced = "# Real\n\n```\n# not a heading\n```\n\ntext after fence\n";
    expect(chunkMarkdown("f.md", fenced).map((c) => c.heading)).toEqual(["Real"]);
  });

  it("returns nothing for an empty or whitespace-only file", () => {
    expect(chunkMarkdown("empty.md", "")).toEqual([]);
    expect(chunkMarkdown("blank.md", "\n\n   \n")).toEqual([]);
  });

  it("handles CRLF frontmatter without leaking it into the first chunk", () => {
    const out = chunkMarkdown("crlf.md", "---\r\ntags: a\r\n---\r\n# T\r\n\r\nbody\r\n");
    expect(out.some((c) => c.text.includes("tags: a"))).toBe(false);
  });
});

describe("extractWikilinks", () => {
  it("dedupes and handles alias, anchor, and both", () => {
    expect(extractWikilinks("[[a]] [[a|x]] [[b#h]] [[c#h|y]]")).toEqual(["a", "b", "c"]);
  });

  it("returns nothing for markdown links", () => {
    expect(extractWikilinks("no links [here](url)")).toEqual([]);
  });
});

describe("buildLinkResolver", () => {
  const resolve = buildLinkResolver(["notes/Today.md", "notes/log.md", "inbox/queue.md", "a/dup.md", "b/dup.md"]);

  it("resolves exact relative paths and unique basenames, case-insensitively", () => {
    expect(resolve("notes/Today")).toBe("notes/Today.md");
    expect(resolve("today")).toBe("notes/Today.md");
    expect(resolve("inbox/queue.md")).toBe("inbox/queue.md");
  });

  it("returns null for dangling and ambiguous targets", () => {
    expect(resolve("does-not-exist")).toBeNull();
    expect(resolve("dup")).toBeNull();
    expect(resolve("a/dup")).toBe("a/dup.md");
  });
});
