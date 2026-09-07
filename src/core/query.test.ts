import { afterEach, describe, expect, it } from "vitest";
import { buildIndex } from "./indexer.js";
import { bm25Candidates, linkNeighbors, search, toFtsQuery } from "./query.js";
import { openDb } from "./db.js";
import { createFakeEmbedder, createWorkspace, type Workspace } from "../test-helpers.js";

const embed = createFakeEmbedder();

const NOTES = {
  "notes/pricing.md": "# Pricing\n\nWe chose a one-time price over a subscription. See [[notes/launch]].\n",
  "notes/launch.md": "# Launch\n\nBenchmarks are published before the announcement.\n",
  "notes/ranking.md": "# Ranking\n\nReciprocal rank fusion combines keyword and vector retrieval.\n",
  "notes/swedish.md": "# Anteckningar\n\nVi valde ett engångspris framför en prenumeration.\n",
};

let ws: Workspace | null = null;
afterEach(() => {
  ws?.cleanup();
  ws = null;
});

async function indexed(): Promise<Workspace> {
  ws = createWorkspace(NOTES);
  await buildIndex({ config: ws.config, embed });
  return ws;
}

describe("toFtsQuery", () => {
  it("quotes each token and prefix-matches the last", () => {
    expect(toFtsQuery("hybrid search")).toBe('"hybrid" "search"*');
  });

  it("joins with OR when asked", () => {
    expect(toFtsQuery("hybrid search", true)).toBe('"hybrid" OR "search"*');
  });

  it("strips characters FTS5 would treat as syntax", () => {
    // Each token is re-quoted as a literal, so the user's own quotes,
    // parentheses and asterisks never reach FTS5 as operators. Left alone they
    // produce a syntax error rather than a search.
    const expression = toFtsQuery('what about "quotes" (and parens)*');
    expect(expression).toBe('"what" "about" "quotes" "and" "parens"*');
    expect(expression).not.toContain("(");
    expect(expression).not.toContain(")");
    // Every quote is part of a matched pair wrapping one token.
    expect((expression.match(/"/g) ?? []).length % 2).toBe(0);
  });

  it("returns an empty expression when the query is only syntax characters", () => {
    expect(toFtsQuery("*")).toBe("");
    expect(toFtsQuery('"" ()')).toBe("");
  });

  it("returns an empty expression for whitespace", () => {
    expect(toFtsQuery("   ")).toBe("");
  });
});

describe("bm25Candidates", () => {
  it("finds notes by exact term", async () => {
    const w = await indexed();
    const db = openDb({ dbPath: w.dbPath })!;
    try {
      expect(bm25Candidates(db, "subscription").length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("returns nothing for a strict AND with no common note, when the fallback is off", async () => {
    const w = await indexed();
    const db = openDb({ dbPath: w.dbPath })!;
    try {
      expect(bm25Candidates(db, "subscription reciprocal", 40, false)).toEqual([]);
      // With the fallback on, the same query rescues recall via OR.
      expect(bm25Candidates(db, "subscription reciprocal", 40, true).length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("does not throw on a query made entirely of FTS syntax", async () => {
    const w = await indexed();
    const db = openDb({ dbPath: w.dbPath })!;
    try {
      expect(() => bm25Candidates(db, '"" (( *')).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe("search", () => {
  it("reports that nothing is indexed rather than returning empty results", async () => {
    ws = createWorkspace(NOTES);
    const result = await search("pricing", { config: ws.config, embed });
    expect(result.indexed).toBe(false);
    expect(result.notes[0]).toContain("dewey index");
  });

  it("finds the right note and says which retriever found it", async () => {
    const w = await indexed();
    const result = await search("subscription", { config: w.config, embed });
    expect(result.indexed).toBe(true);
    expect(result.mode).toBe("hybrid");
    expect(result.hits[0]!.path).toBe("notes/pricing.md");
    expect(["bm25", "vec", "both"]).toContain(result.hits[0]!.source);
  });

  it("degrades to keyword-only when no embedder is supplied", async () => {
    const w = await indexed();
    const result = await search("subscription", { config: w.config });
    expect(result.mode).toBe("bm25-only");
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("keeps answering, and says so, when the embedder throws", async () => {
    const w = await indexed();
    const result = await search("subscription", {
      config: w.config,
      embed: () => Promise.reject(new Error("model not downloaded")),
    });
    // The failure is visible in the result rather than swallowed into thinner
    // results with no explanation.
    expect(result.mode).toBe("bm25-only");
    expect(result.notes.join(" ")).toContain("model not downloaded");
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("returns one hit per file by default", async () => {
    const w = createWorkspace({
      "big.md": "# Big\n\n## One\n\nsubscription here.\n\n## Two\n\nsubscription again.\n",
    });
    ws = w;
    await buildIndex({ config: w.config, embed });
    const result = await search("subscription", { config: w.config, embed });
    expect(result.hits.filter((h) => h.path === "big.md")).toHaveLength(1);
  });

  it("can return several chunks from one file when asked", async () => {
    const w = createWorkspace({
      "big.md": "# Big\n\n## One\n\nsubscription here.\n\n## Two\n\nsubscription again.\n",
    });
    ws = w;
    await buildIndex({ config: w.config, embed });
    const result = await search("subscription", { config: w.config, embed, perFile: false });
    expect(result.hits.filter((h) => h.path === "big.md").length).toBeGreaterThan(1);
  });

  it("respects the limit", async () => {
    const w = await indexed();
    const result = await search("the", { config: w.config, embed, limit: 2 });
    expect(result.hits.length).toBeLessThanOrEqual(2);
  });

  it("reorders results when a reranker is supplied and enabled", async () => {
    const w = await indexed();
    const base = await search("price", { config: { ...w.config, rerank: false }, embed, limit: 4 });

    // Score in reverse, so a reorder is unambiguous rather than a coincidence.
    const reversed = await search("price", {
      config: { ...w.config, rerank: true },
      embed,
      rerank: (_query, documents) => Promise.resolve(documents.map((_, i) => i)),
      limit: 4,
    });

    expect(reversed.reranked).toBe(true);
    expect(reversed.hits.map((h) => h.path)).toEqual([...base.hits.map((h) => h.path)].reverse());
    // The pre-rerank position stays visible so the reorder can be audited.
    expect(reversed.hits[0]!.fusedRank).toBeGreaterThan(1);
  });

  it("falls back to fusion order, and says so, when the reranker fails", async () => {
    const w = await indexed();
    const result = await search("price", {
      config: { ...w.config, rerank: true },
      embed,
      rerank: () => Promise.reject(new Error("reranker model missing")),
    });
    expect(result.reranked).toBe(false);
    expect(result.notes.join(" ")).toContain("reranker model missing");
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("does not rerank when the config leaves it off", async () => {
    const w = await indexed();
    let called = false;
    const result = await search("price", {
      config: { ...w.config, rerank: false },
      embed,
      rerank: (_q, documents) => {
        called = true;
        return Promise.resolve(documents.map(() => 1));
      },
    });
    expect(called).toBe(false);
    expect(result.reranked).toBe(false);
  });
});

describe("linkNeighbors", () => {
  it("reports links in both directions", async () => {
    const w = await indexed();
    expect(linkNeighbors("notes/pricing.md", w.dbPath).outgoing).toContain("notes/launch.md");
    expect(linkNeighbors("notes/launch.md", w.dbPath).incoming).toContain("notes/pricing.md");
  });

  it("returns empty lists for an unknown note", async () => {
    const w = await indexed();
    expect(linkNeighbors("notes/nope.md", w.dbPath)).toEqual({ outgoing: [], incoming: [] });
  });
});
