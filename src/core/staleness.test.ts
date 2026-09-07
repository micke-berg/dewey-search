import { afterEach, describe, expect, it } from "vitest";
import { buildIndex } from "./indexer.js";
import { getStaleNotes } from "./staleness.js";
import { ageFile, createFakeEmbedder, createWorkspace, type Workspace } from "../test-helpers.js";

const embed = createFakeEmbedder();

let ws: Workspace | null = null;
afterEach(() => {
  ws?.cleanup();
  ws = null;
});

async function workspace(files: Record<string, string>, index = true): Promise<Workspace> {
  ws = createWorkspace(files);
  if (index) await buildIndex({ config: ws.config, embed });
  return ws;
}

describe("getStaleNotes", () => {
  it("counts everything and reports only what crosses the threshold", async () => {
    const w = await workspace({
      "fresh.md": "# Fresh\n\nWritten today.\n",
      "old.md": "# Old\n\nWritten a long time ago.\n",
    });
    ageFile(w.root, "old.md", 400);

    const report = getStaleNotes(w.config, { olderThanDays: 180 });
    expect(report.totalNotes).toBe(2);
    expect(report.staleCount).toBe(1);
    expect(report.notes.map((n) => n.path)).toEqual(["old.md"]);
  });

  it("ranks by age weighted by inbound links, not age alone", async () => {
    const w = await workspace({
      "hub.md": "# Hub\n\nA page others depend on.\n",
      "leaf.md": "# Leaf\n\nNothing points here.\n",
      "a.md": "# A\n\nSee [[hub]].\n",
      "b.md": "# B\n\nAlso see [[hub]].\n",
    });
    // The leaf is older, but the hub is what other notes still lean on.
    ageFile(w.root, "hub.md", 300);
    ageFile(w.root, "leaf.md", 365);

    const report = getStaleNotes(w.config, { olderThanDays: 200 });
    expect(report.notes[0]!.path).toBe("hub.md");
    expect(report.notes[0]!.inboundLinks).toBe(2);
  });

  it("counts a link between two notes once, however often it is repeated", async () => {
    const w = await workspace({
      "target.md": "# Target\n\nContent.\n",
      "chatty.md": "# Chatty\n\n[[target]] and [[target]] and again [[target]].\n",
    });
    ageFile(w.root, "target.md", 400);

    const report = getStaleNotes(w.config, { olderThanDays: 300 });
    expect(report.notes[0]!.inboundLinks).toBe(1);
  });

  it("does not count a note linking to itself", async () => {
    const w = await workspace({ "self.md": "# Self\n\nSee [[self]].\n" });
    ageFile(w.root, "self.md", 400);
    const report = getStaleNotes(w.config, { olderThanDays: 300 });
    expect(report.notes[0]!.inboundLinks).toBe(0);
  });

  it("counts notes with no links in either direction as orphans", async () => {
    const w = await workspace({
      "orphan.md": "# Orphan\n\nAlone.\n",
      "linked.md": "# Linked\n\nSee [[other]].\n",
      "other.md": "# Other\n\nContent.\n",
    });
    expect(getStaleNotes(w.config).orphanCount).toBe(1);
  });

  it("scopes to a folder prefix", async () => {
    const w = await workspace({
      "archive/old.md": "# Old\n\nContent.\n",
      "current/new.md": "# New\n\nContent.\n",
    });
    ageFile(w.root, "archive/old.md", 400);
    ageFile(w.root, "current/new.md", 400);

    const report = getStaleNotes(w.config, { olderThanDays: 300, pathPrefix: "archive/" });
    expect(report.totalNotes).toBe(1);
    expect(report.notes.map((n) => n.path)).toEqual(["archive/old.md"]);
  });

  it("respects the limit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`n${String(i)}.md`] = `# Note ${String(i)}\n\nBody.\n`;
    const w = await workspace(files);
    for (const name of Object.keys(files)) ageFile(w.root, name, 400);

    const report = getStaleNotes(w.config, { olderThanDays: 300, limit: 3 });
    expect(report.notes).toHaveLength(3);
    expect(report.staleCount).toBe(10);
  });

  it("works without an index, and says the link data is missing", async () => {
    const w = await workspace({ "old.md": "# Old\n\nContent.\n" }, false);
    ageFile(w.root, "old.md", 400);

    const report = getStaleNotes(w.config, { olderThanDays: 300 });
    expect(report.linkDataMissing).toBe(true);
    expect(report.notes[0]!.inboundLinks).toBe(0);
    // Age still works, because it comes from disk rather than the index.
    expect(report.notes[0]!.ageDays).toBeGreaterThanOrEqual(400);
  });

  it("reads modification times from disk, not from a stale index", async () => {
    const w = await workspace({ "note.md": "# Note\n\nOriginal.\n" });
    ageFile(w.root, "note.md", 400);
    // The index still records the build-time mtime; the report must not.
    expect(getStaleNotes(w.config, { olderThanDays: 300 }).staleCount).toBe(1);
  });

  it("reports a median age over all notes, not only the stale ones", async () => {
    const w = await workspace({ "a.md": "# A\n\nx\n", "b.md": "# B\n\nx\n", "c.md": "# C\n\nx\n" });
    ageFile(w.root, "a.md", 100);
    ageFile(w.root, "b.md", 200);
    ageFile(w.root, "c.md", 300);
    expect(getStaleNotes(w.config, { olderThanDays: 250 }).medianAgeDays).toBe(200);
  });
});
