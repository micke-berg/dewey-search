import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, defaultDbPath, resolveConfig } from "./config.js";

const created: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dewey-config-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) fs.rmSync(created.pop()!, { recursive: true, force: true });
});

describe("resolveConfig", () => {
  it("resolves a notes folder from a flag", () => {
    const root = tempDir();
    expect(resolveConfig({ root, env: {} }).root).toBe(fs.realpathSync(root));
  });

  it("falls back to the environment when no flag is given", () => {
    const root = tempDir();
    expect(resolveConfig({ env: { DEWEY_NOTES: root } }).root).toBe(fs.realpathSync(root));
  });

  it("prefers the flag over the environment", () => {
    const flagRoot = tempDir();
    const envRoot = tempDir();
    expect(resolveConfig({ root: flagRoot, env: { DEWEY_NOTES: envRoot } }).root).toBe(fs.realpathSync(flagRoot));
  });

  it("explains itself when no notes folder is configured at all", () => {
    expect(() => resolveConfig({ env: {} })).toThrow(ConfigError);
    expect(() => resolveConfig({ env: {} })).toThrow(/DEWEY_NOTES/);
  });

  it("rejects a notes folder that does not exist", () => {
    expect(() => resolveConfig({ root: "/nope/not/here", env: {} })).toThrow(/does not exist/);
  });

  it("rejects a notes path that is a file", () => {
    const dir = tempDir();
    const file = path.join(dir, "a.md");
    fs.writeFileSync(file, "# A");
    expect(() => resolveConfig({ root: file, env: {} })).toThrow(/not a directory/);
  });

  it("refuses to put the index inside the notes folder", () => {
    const root = tempDir();
    // Otherwise the index gets synced, committed, and eventually indexed by itself.
    expect(() => resolveConfig({ root, dbPath: path.join(root, "index.db"), env: {} })).toThrow(/inside the notes/);
    expect(() => resolveConfig({ root, dbPath: path.join(root, "sub", "index.db"), env: {} })).toThrow(
      /inside the notes/,
    );
  });

  it("rejects an unknown embedding model rather than guessing its dimensions", () => {
    const root = tempDir();
    expect(() => resolveConfig({ root, model: "some/unknown-model", env: {} })).toThrow(/Unknown embedding model/);
  });

  it("carries the dimensions and prefix rule of the chosen model", () => {
    const root = tempDir();
    const e5 = resolveConfig({ root, model: "Xenova/multilingual-e5-small", env: {} });
    expect(e5.embedDims).toBe(384);
    expect(e5.modelPrefixes).toBe(true);

    const bge = resolveConfig({ root, model: "Xenova/bge-small-en-v1.5", env: {} });
    expect(bge.modelPrefixes).toBe(false);
  });

  it("expands a leading tilde in both paths", () => {
    const root = tempDir();
    expect(resolveConfig({ root, dbPath: "~/dewey-test.db", env: {} }).dbPath).toBe(
      path.join(os.homedir(), "dewey-test.db"),
    );
  });

  it("canonicalises a symlinked notes folder", () => {
    const real = tempDir();
    const link = path.join(tempDir(), "link-to-notes");
    fs.symlinkSync(real, link);
    // Both spellings must resolve to the same root, or the index and the path
    // guard end up disagreeing about which folder is being served.
    expect(resolveConfig({ root: link, env: {} }).root).toBe(resolveConfig({ root: real, env: {} }).root);
  });

  it("reads the ignore list from the environment as a comma-separated list", () => {
    const root = tempDir();
    expect(resolveConfig({ root, env: { DEWEY_IGNORE: "archive, attachments" } }).ignoreDirs).toEqual([
      "archive",
      "attachments",
    ]);
  });

  it("leaves the reranker off unless it is asked for", () => {
    const root = tempDir();
    expect(resolveConfig({ root, env: {} }).rerank).toBe(false);
    expect(resolveConfig({ root, env: { DEWEY_RERANK: "1" } }).rerank).toBe(true);
    expect(resolveConfig({ root, rerank: true, env: {} }).rerank).toBe(true);
  });
});

describe("defaultDbPath", () => {
  it("gives different folders different databases", () => {
    expect(defaultDbPath("/a/notes")).not.toBe(defaultDbPath("/b/notes"));
  });

  it("is stable for the same folder", () => {
    expect(defaultDbPath("/a/notes")).toBe(defaultDbPath("/a/notes"));
  });

  it("produces a filename with no spaces or non-ASCII, whatever the folder is called", () => {
    const name = path.basename(defaultDbPath("/tmp/mina anteckningar åäö"));
    expect(name).toMatch(/^[a-zA-Z0-9._-]+\.db$/);
  });
});
