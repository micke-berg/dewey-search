/**
 * Model loading without transformers.js.
 *
 * Dewey only ever runs two small text models, so it talks to ONNX Runtime and
 * the Hugging Face tokenizer directly. That removes the image-processing
 * dependency transformers.js drags in unconditionally, which was the one thing
 * standing between this package and a clean install for anyone else.
 *
 * Files live under `<modelCacheDir>/<model>/`, the same layout transformers.js
 * used, so an existing cache keeps working and nothing is downloaded twice.
 */

import fs from "node:fs";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Tokenizer as HubTokenizer } from "@huggingface/tokenizers";
import * as ort from "onnxruntime-node";

/**
 * The slice of the Hub tokenizer Dewey uses. Declared here because the
 * package's type entry re-exports its internals with extensionless relative
 * paths, which the NodeNext resolver cannot follow, so the imported class type
 * comes through as unresolved. Constructing through this interface keeps the
 * call sites typed without patching the dependency.
 */
export interface Tokenizer {
  encode(
    text: string,
    options?: { text_pair?: string | null; return_token_type_ids?: boolean | null },
  ): { ids: number[]; attention_mask: number[]; token_type_ids?: number[] };
  token_to_id(token: string): number | undefined;
}

const TokenizerCtor = HubTokenizer as unknown as new (tokenizer: object, config: object) => Tokenizer;

const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"] as const;

/** Base URL for a model file on the Hub. Overridable for mirrors and tests. */
function hubUrl(model: string, file: string): string {
  const base = (process.env["DEWEY_HF_ENDPOINT"] ?? "https://huggingface.co").replace(/\/$/, "");
  return `${base}/${model}/resolve/main/${file}`;
}

/**
 * Make sure every file the model needs is on disk, downloading the missing
 * ones. Downloads go to a temp name and are renamed on completion, so an
 * interrupted first run never leaves a half-written weights file that later
 * loads succeed on and then crash inside.
 */
export async function ensureModelFiles(model: string, cacheDir: string): Promise<string> {
  const dir = path.join(cacheDir, model);
  for (const file of MODEL_FILES) {
    const target = path.join(dir, file);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const url = hubUrl(model, file);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`Could not download ${url} (${res.status} ${res.statusText})`);
    }
    const tmp = `${target}.part-${process.pid}`;
    try {
      await streamPipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp));
      fs.renameSync(tmp, target);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return dir;
}

export interface LoadedModel {
  tokenizer: Tokenizer;
  session: ort.InferenceSession;
  /** Longest sequence the model accepts, from tokenizer_config.json. */
  maxLength: number;
  padId: number;
}

export async function loadModel(model: string, cacheDir: string): Promise<LoadedModel> {
  const dir = await ensureModelFiles(model, cacheDir);
  const readJson = (file: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>;
  const tokenizerConfig = readJson("tokenizer_config.json");
  const tokenizer = new TokenizerCtor(readJson("tokenizer.json"), tokenizerConfig);
  const session = await ort.InferenceSession.create(path.join(dir, "onnx/model_quantized.onnx"));
  const rawMax = tokenizerConfig["model_max_length"];
  const maxLength = typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 512;
  const padToken = typeof tokenizerConfig["pad_token"] === "string" ? tokenizerConfig["pad_token"] : "<pad>";
  const padId = tokenizer.token_to_id(padToken) ?? 0;
  return { tokenizer, session, maxLength, padId };
}

export interface EncodedBatch {
  ids: number[][];
  mask: number[][];
  typeIds: number[][];
  /** Padded length every row was brought to. */
  length: number;
}

/**
 * Tokenize a batch, truncate each row to `maxLength`, and right-pad every row
 * to the longest one. Truncation is a plain slice after special tokens are
 * added, which is what transformers.js does for `truncation: true`, so the
 * inputs a model sees are byte-identical to before the dependency swap.
 */
export function encodeBatch(
  tokenizer: Tokenizer,
  texts: string[],
  opts: { pairs?: string[]; maxLength: number; padId: number },
): EncodedBatch {
  const rows = texts.map((text, i) => {
    const enc = tokenizer.encode(text, { text_pair: opts.pairs?.[i] ?? null, return_token_type_ids: true });
    return {
      ids: enc.ids.slice(0, opts.maxLength),
      mask: enc.attention_mask.slice(0, opts.maxLength),
      typeIds: (enc.token_type_ids ?? enc.ids.map(() => 0)).slice(0, opts.maxLength),
    };
  });
  const length = rows.reduce((m, r) => Math.max(m, r.ids.length), 0);
  const pad = (row: number[], fill: number): number[] =>
    row.length === length ? row : [...row, ...new Array<number>(length - row.length).fill(fill)];
  return {
    ids: rows.map((r) => pad(r.ids, opts.padId)),
    mask: rows.map((r) => pad(r.mask, 0)),
    typeIds: rows.map((r) => pad(r.typeIds, 0)),
    length,
  };
}

/** Build the int64 feeds a BERT-family ONNX export expects, only the inputs it declares. */
export function toFeeds(batch: EncodedBatch, inputNames: readonly string[]): Record<string, ort.Tensor> {
  const n = batch.ids.length;
  const dims = [n, batch.length];
  const tensor = (rows: number[][]): ort.Tensor =>
    new ort.Tensor("int64", BigInt64Array.from(rows.flat().map((v) => BigInt(v))), dims);
  const feeds: Record<string, ort.Tensor> = {};
  if (inputNames.includes("input_ids")) feeds["input_ids"] = tensor(batch.ids);
  if (inputNames.includes("attention_mask")) feeds["attention_mask"] = tensor(batch.mask);
  if (inputNames.includes("token_type_ids")) feeds["token_type_ids"] = tensor(batch.typeIds);
  return feeds;
}

/**
 * Mean-pool token vectors under the attention mask and L2-normalise, so cosine
 * similarity downstream is a plain dot product. `hidden` is [n, length, dims].
 */
export function meanPoolNormalize(hidden: Float32Array, mask: number[][], dims: number): Float32Array[] {
  const out: Float32Array[] = [];
  const length = mask[0]?.length ?? 0;
  for (let i = 0; i < mask.length; i++) {
    const row = mask[i] ?? [];
    const acc = new Float32Array(dims);
    let count = 0;
    for (let t = 0; t < length; t++) {
      if (!row[t]) continue;
      count++;
      const off = (i * length + t) * dims;
      for (let d = 0; d < dims; d++) acc[d] = (acc[d] ?? 0) + (hidden[off + d] ?? 0);
    }
    let norm = 0;
    for (let d = 0; d < dims; d++) {
      const v = (acc[d] ?? 0) / Math.max(count, 1);
      acc[d] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dims; d++) acc[d] = (acc[d] ?? 0) / norm;
    out.push(acc);
  }
  return out;
}
