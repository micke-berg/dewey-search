import { describe, expect, it } from "vitest";
import { encodeBatch, meanPoolNormalize, toFeeds, type Tokenizer } from "./model-files.js";

// A stand-in tokenizer: one id per character, pair appended after a separator.
const fakeTokenizer = {
  encode(text: string, opts?: { text_pair?: string | null }) {
    const ids = [0, ...Array.from(text, (c) => c.charCodeAt(0)), 2];
    if (opts?.text_pair) ids.push(...Array.from(opts.text_pair, (c) => c.charCodeAt(0)), 2);
    return { ids, tokens: ids.map(String), attention_mask: ids.map(() => 1), token_type_ids: ids.map(() => 0) };
  },
  token_to_id: () => 1,
} satisfies Tokenizer;

describe("encodeBatch", () => {
  it("pads every row to the longest and masks the padding", () => {
    const b = encodeBatch(fakeTokenizer, ["ab", "abcd"], { maxLength: 512, padId: 1 });
    expect(b.length).toBe(6);
    expect(b.ids[0]).toEqual([0, 97, 98, 2, 1, 1]);
    expect(b.mask[0]).toEqual([1, 1, 1, 1, 0, 0]);
    expect(b.mask[1]).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("truncates after special tokens, the way transformers.js did", () => {
    const b = encodeBatch(fakeTokenizer, ["abcdefgh"], { maxLength: 4, padId: 1 });
    expect(b.ids[0]).toEqual([0, 97, 98, 99]);
    expect(b.length).toBe(4);
  });

  it("appends the pair text for cross-encoders", () => {
    const b = encodeBatch(fakeTokenizer, ["q"], { pairs: ["doc"], maxLength: 512, padId: 1 });
    expect(b.ids[0]).toEqual([0, 113, 2, 100, 111, 99, 2]);
  });
});

describe("toFeeds", () => {
  it("only builds the inputs the model declares", () => {
    const b = encodeBatch(fakeTokenizer, ["a"], { maxLength: 512, padId: 1 });
    const feeds = toFeeds(b, ["input_ids", "attention_mask"]);
    expect(Object.keys(feeds).sort()).toEqual(["attention_mask", "input_ids"]);
    expect(feeds["input_ids"]?.dims).toEqual([1, 3]);
    expect(feeds["input_ids"]?.type).toBe("int64");
  });
});

describe("meanPoolNormalize", () => {
  it("averages only unmasked tokens and returns unit vectors", () => {
    // one row, three tokens, two dims; third token is padding
    const hidden = new Float32Array([1, 0, 0, 1, 9, 9]);
    const [v] = meanPoolNormalize(hidden, [[1, 1, 0]], 2);
    expect(v).toBeDefined();
    const [x, y] = [v?.[0] ?? 0, v?.[1] ?? 0];
    expect(x).toBeCloseTo(Math.SQRT1_2, 5);
    expect(y).toBeCloseTo(Math.SQRT1_2, 5);
  });
});
