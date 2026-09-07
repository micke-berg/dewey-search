import { afterEach, describe, expect, it } from "vitest";
import { buildIndex } from "./indexer.js";
import { describeFreshness, getFreshness } from "./freshness.js";
import { createFakeEmbedder, createWorkspace, type Workspace } from "../test-helpers.js";

const embed = createFakeEmbedder();

let ws: Workspace | null = null;
afterEach(() => {
  ws?.cleanup();
  ws = null;
});

async function indexed(files: Record<string, string>): Promise<Workspace> {
  ws = createWorkspace(files);
  await buildIndex({ config: ws.config, embed });
  return ws;
}

describe("getFreshness", () => {
  it("reports no index before one is built", () => {
    ws = createWorkspace({ "a.md": "# A\n\nContent.\n" });
    const freshness = getFreshness(ws.config);
    expect(freshness.built).toBe(false);
    expect(freshness.behind).toBe(0);
    expect(describeFreshness(freshness)).toBe("No index yet.");
  });

  it("reports zero drift immediately after a build", async () => {
    const w = await indexed({ "a.md": "# A\n\nContent.\n" });
    const freshness = getFreshness(w.config);
    expect(freshness.built).toBe(true);
    expect(freshness.behind).toBe(0);
    expect(describeFreshness(freshness)).toContain("up to date");
  });

  it("counts a new note as added", async () => {
    const w = await indexed({ "a.md": "# A\n\nContent.\n" });
    w.write("b.md", "# B\n\nWritten later.\n");
    const freshness = getFreshness(w.config);
    expect(freshness.added).toBe(1);
    expect(freshness.behind).toBe(1);
    expect(describeFreshness(freshness)).toContain("1 new");
  });

  it("counts an edited note as changed", async () => {
    const w = await indexed({ "a.md": "# A\n\nContent.\n" });
    w.write("a.md", "# A\n\nContent, substantially rewritten and longer.\n");
    const freshness = getFreshness(w.config);
    expect(freshness.changed).toBe(1);
    expect(describeFreshness(freshness)).toContain("1 changed");
  });

  it("counts a deleted note as removed", async () => {
    const w = await indexed({ "a.md": "# A\n\nContent.\n", "b.md": "# B\n\nContent.\n" });
    w.remove("b.md");
    const freshness = getFreshness(w.config);
    expect(freshness.removed).toBe(1);
    expect(describeFreshness(freshness)).toContain("1 deleted");
  });

  it("sums the three kinds of drift", async () => {
    const w = await indexed({ "a.md": "# A\n\nContent.\n", "b.md": "# B\n\nContent.\n" });
    w.write("a.md", "# A\n\nRewritten with different length.\n");
    w.write("c.md", "# C\n\nNew.\n");
    w.remove("b.md");
    expect(getFreshness(w.config).behind).toBe(3);
  });

  it("agrees with what a rebuild actually does", async () => {
    const w = await indexed({ "a.md": "# A\n\nContent.\n" });
    w.write("b.md", "# B\n\nNew note.\n");
    w.write("a.md", "# A\n\nContent, edited to a different length.\n");

    const predicted = getFreshness(w.config).behind;
    const stats = await buildIndex({ config: w.config, embed });
    // If these ever disagree, freshness is reporting fiction.
    expect(stats.indexed + stats.removed).toBe(predicted);
    expect(getFreshness(w.config).behind).toBe(0);
  });
});
