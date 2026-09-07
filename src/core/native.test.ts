/**
 * The native stack, exercised on purpose.
 *
 * `better-sqlite3` and `sqlite-vec` are compiled against SQLite's C ABI, and a
 * mismatched pair does not throw — it segfaults the process on the first
 * vector query. That failure mode skips every error handler in this codebase
 * and produces exit code 139 with no message, which is a genuinely awful thing
 * to debug from a bug report.
 *
 * Version 13 of better-sqlite3 crashes with sqlite-vec 0.1.9 exactly this way,
 * which is why the dependency is pinned to 12.x. This test exists so that a
 * dependency bump fails CI loudly instead of shipping a crash: a segfault here
 * takes the test runner down with it, which is a very hard failure to ignore.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, toBlob } from "./db.js";

let dbPath: string | null = null;

afterEach(() => {
  if (dbPath) fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  dbPath = null;
});

function tempDb(): string {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dewey-native-")), "index.db");
  return dbPath;
}

describe("native SQLite stack", () => {
  it("loads the vector extension and answers a nearest-neighbour query", () => {
    const db = openDb({ dbPath: tempDb(), create: true, embedDims: 4 })!;
    try {
      const insert = db.prepare("INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)");
      insert.run(1n, toBlob(new Float32Array([1, 0, 0, 0])));
      insert.run(2n, toBlob(new Float32Array([0, 1, 0, 0])));
      insert.run(3n, toBlob(new Float32Array([0.9, 0.1, 0, 0])));

      const rows = db
        .prepare("SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance")
        .all(toBlob(new Float32Array([1, 0, 0, 0])), 2) as { rowid: number }[];

      expect(rows.map((r) => r.rowid)).toEqual([1, 3]);
    } finally {
      db.close();
    }
  });

  it("runs a BM25 query with per-field weights", () => {
    const db = openDb({ dbPath: tempDb(), create: true, embedDims: 4 })!;
    try {
      const insert = db.prepare("INSERT INTO chunks_fts (rowid, title, heading, body) VALUES (?, ?, ?, ?)");
      insert.run(1, "Pricing", "", "unrelated prose about deployment");
      insert.run(2, "Deployment", "", "the word pricing appears once here");

      const rows = db
        .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts, ?, ?, ?)")
        .all('"pricing"', 4.0, 3.0, 1.0) as { rowid: number }[];

      // The title match outranks the body match, which is the point of the weights.
      expect(rows[0]!.rowid).toBe(1);
    } finally {
      db.close();
    }
  });
});
