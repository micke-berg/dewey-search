import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIndex, isChanged, listMarkdownFiles } from "./indexer.js";
import { getIndexStatus, openDb } from "./db.js";
import { createFakeEmbedder, createWorkspace, type Workspace } from "../test-helpers.js";

const embed = createFakeEmbedder();

let ws: Workspace | null = null;
afterEach(() => {
  ws?.cleanup();
  ws = null;
});

function workspace(files: Record<string, string>): Workspace {
  ws = createWorkspace(files);
  return ws;
}

describe("listMarkdownFiles", () => {
  it("finds markdown recursively and ignores everything else", () => {
    const w = workspace({
      "a.md": "# A",
      "sub/b.md": "# B",
      "sub/notes.txt": "not markdown",
      "sub/deep/c.md": "# C",
    });
    expect(listMarkdownFiles(w.root).map((f) => f.rel)).toEqual(["a.md", "sub/b.md", "sub/deep/c.md"]);
  });

  it("skips dot-directories and configured ignores", () => {
    const w = workspace({ "a.md": "# A", ".obsidian/plugin.md": "# hidden", "node_modules/pkg/readme.md": "# dep" });
    expect(listMarkdownFiles(w.root).map((f) => f.rel)).toEqual(["a.md"]);
  });

  it("honours an extra ignore directory", () => {
    const w = workspace({ "a.md": "# A", "archive/old.md": "# Old" });
    expect(listMarkdownFiles(w.root, ["archive"]).map((f) => f.rel)).toEqual(["a.md"]);
  });
});

describe("isChanged", () => {
  const file = { rel: "a.md", mtimeMs: 1000, size: 50 };

  it("treats an unknown file as changed", () => {
    expect(isChanged(file, undefined)).toBe(true);
  });

  it("detects a different mtime or size", () => {
    expect(isChanged(file, { mtime_ms: 999, size: 50 })).toBe(true);
    expect(isChanged(file, { mtime_ms: 1000, size: 49 })).toBe(true);
  });

  it("treats an identical stat as unchanged", () => {
    expect(isChanged(file, { mtime_ms: 1000, size: 50 })).toBe(false);
  });
});

describe("buildIndex", () => {
  it("indexes every note and records status", async () => {
    const w = workspace({
      "a.md": "# Alpha\n\nContent about retrieval.\n",
      "sub/b.md": "# Beta\n\nContent about ranking.\n",
    });

    const stats = await buildIndex({ config: w.config, embed });
    expect(stats.scanned).toBe(2);
    expect(stats.indexed).toBe(2);
    expect(stats.chunks).toBeGreaterThan(0);

    const status = getIndexStatus(w.dbPath);
    expect(status.built).toBe(true);
    expect(status.files).toBe(2);
    expect(status.root).toBe(w.root);
  });

  it("re-reads only what changed on a second run", async () => {
    const w = workspace({ "a.md": "# Alpha\n\nOne.\n", "b.md": "# Beta\n\nTwo.\n" });
    await buildIndex({ config: w.config, embed });

    // mtime has one-second granularity on some filesystems, so change the size
    // too rather than trusting the clock to have moved.
    w.write("b.md", "# Beta\n\nTwo, revised and longer than before.\n");

    const second = await buildIndex({ config: w.config, embed });
    expect(second.indexed).toBe(1);
    expect(second.unchanged).toBe(1);
  });

  it("removes chunks for deleted notes", async () => {
    const w = workspace({ "a.md": "# Alpha\n\nOne.\n", "gone.md": "# Gone\n\nTwo.\n" });
    await buildIndex({ config: w.config, embed });
    w.remove("gone.md");

    const stats = await buildIndex({ config: w.config, embed });
    expect(stats.removed).toBe(1);

    const db = openDb({ dbPath: w.dbPath })!;
    try {
      const remaining = db.prepare("SELECT DISTINCT path FROM chunks").all() as { path: string }[];
      expect(remaining.map((r) => r.path)).toEqual(["a.md"]);
    } finally {
      db.close();
    }
  });

  it("replaces a changed note's chunks rather than accumulating them", async () => {
    const w = workspace({ "a.md": "# Alpha\n\n## One\n\nFirst.\n\n## Two\n\nSecond.\n" });
    await buildIndex({ config: w.config, embed });
    w.write("a.md", "# Alpha\n\n## One\n\nOnly one section now.\n");
    await buildIndex({ config: w.config, embed });

    const db = openDb({ dbPath: w.dbPath })!;
    try {
      const headings = (db.prepare("SELECT heading FROM chunks WHERE path = 'a.md'").all() as { heading: string }[])
        .map((r) => r.heading)
        .filter(Boolean);
      expect(headings).toEqual(["One"]);
      // The FTS and vector tables must shrink with it, or deleted text keeps
      // being retrievable long after it was removed from the note.
      const fts = (db.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get() as { n: number }).n;
      const chunks = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
      expect(fts).toBe(chunks);
    } finally {
      db.close();
    }
  });

  it("resolves wikilinks into edges and drops dangling ones", async () => {
    const w = workspace({
      "a.md": "# Alpha\n\nSee [[b]] and [[nowhere]].\n",
      "b.md": "# Beta\n\nBack to [[a]].\n",
    });
    await buildIndex({ config: w.config, embed });

    const db = openDb({ dbPath: w.dbPath })!;
    try {
      const targets = (
        db.prepare("SELECT DISTINCT target_path AS p FROM links ORDER BY p").all() as { p: string }[]
      ).map((r) => r.p);
      expect(targets).toEqual(["a.md", "b.md"]);
    } finally {
      db.close();
    }
  });

  it("stops cleanly when aborted and keeps what it already wrote", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`n${String(i)}.md`] = `# Note ${String(i)}\n\nBody ${String(i)}.\n`;
    const w = workspace(files);

    const controller = new AbortController();
    let seen = 0;
    const stats = await buildIndex({
      config: w.config,
      embed: async (texts, kind) => {
        if (++seen >= 3) controller.abort();
        return embed(texts, kind);
      },
      signal: controller.signal,
    });

    expect(stats.aborted).toBe(true);
    expect(stats.indexed).toBeLessThan(10);
    // Whatever was committed is complete and queryable, not half a file.
    expect(getIndexStatus(w.dbPath).files).toBe(stats.indexed);
  });

  it("never writes into the notes folder", async () => {
    const w = workspace({ "a.md": "# Alpha\n\nContent.\n" });
    const before = snapshot(w.root);
    await buildIndex({ config: w.config, embed });
    expect(snapshot(w.root)).toEqual(before);
  });
});

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}
