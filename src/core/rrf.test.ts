import { describe, expect, it } from "vitest";
import { fuseRrf, RRF_K } from "./rrf.js";

describe("fuseRrf", () => {
  it("scores an item on one list as 1/(K + rank)", () => {
    const [top] = fuseRrf([{ source: "bm25", ids: ["a"] }]);
    expect(top!.score).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(top!.ranks).toEqual({ bm25: 1 });
  });

  it("sums contributions for an item on both lists", () => {
    const fused = fuseRrf([
      { source: "bm25", ids: ["a", "b"] },
      { source: "vec", ids: ["b", "a"] },
    ]);
    const a = fused.find((f) => f.id === "a")!;
    expect(a.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 10);
    expect(a.ranks).toEqual({ bm25: 1, vec: 2 });
  });

  it("ranks an item found by both retrievers above one found by a single retriever", () => {
    const fused = fuseRrf([
      { source: "bm25", ids: ["both", "only-bm25"] },
      { source: "vec", ids: ["both"] },
    ]);
    expect(fused[0]!.id).toBe("both");
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score);
  });

  it("lets agreement beat a single strong rank: two #3s outrank one #2", () => {
    const fused = fuseRrf([
      { source: "bm25", ids: ["x", "single", "agree"] },
      { source: "vec", ids: ["y", "z", "agree"] },
    ]);
    expect(fused.find((f) => f.id === "agree")!.score).toBeGreaterThan(
      fused.find((f) => f.id === "single")!.score,
    );
  });

  it("orders tied scores deterministically across repeated runs", () => {
    const lists = [
      { source: "bm25", ids: ["a"] },
      { source: "vec", ids: ["b"] },
    ];
    const first = fuseRrf(lists).map((f) => f.id);
    const second = fuseRrf(lists).map((f) => f.id);
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
  });

  it("ignores duplicate ids within one list beyond the first occurrence", () => {
    const [top] = fuseRrf([{ source: "bm25", ids: ["a", "a", "a"] }]);
    expect(top!.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it("handles empty lists", () => {
    expect(
      fuseRrf([
        { source: "bm25", ids: [] },
        { source: "vec", ids: [] },
      ]),
    ).toEqual([]);
  });

  it("respects a custom K", () => {
    expect(fuseRrf([{ source: "bm25", ids: ["a"] }], 10)[0]!.score).toBeCloseTo(1 / 11, 10);
  });
});
