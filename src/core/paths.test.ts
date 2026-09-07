import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isInside, PathOutsideRootError, resolveInsideRoot, toRelative } from "./paths.js";

let root: string;
let outside: string;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dewey-paths-"));
  root = path.join(base, "notes");
  outside = path.join(base, "secrets");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, "a.md"), "# A");
  fs.writeFileSync(path.join(root, "sub", "b.md"), "# B");
  fs.writeFileSync(path.join(outside, "keys.txt"), "sensitive");
  fs.symlinkSync(path.join(outside, "keys.txt"), path.join(root, "escape.md"));
  fs.symlinkSync(path.join(root, "sub", "b.md"), path.join(root, "inside-link.md"));
});

afterAll(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe("resolveInsideRoot", () => {
  it("resolves a relative path inside the root", () => {
    expect(resolveInsideRoot(root, "sub/b.md")).toBe(path.join(fs.realpathSync(root), "sub", "b.md"));
  });

  it("accepts an absolute path that is inside the root", () => {
    const absolute = path.join(fs.realpathSync(root), "a.md");
    expect(resolveInsideRoot(root, absolute)).toBe(absolute);
  });

  it("rejects traversal out of the root", () => {
    expect(() => resolveInsideRoot(root, "../secrets/keys.txt")).toThrow(PathOutsideRootError);
    expect(() => resolveInsideRoot(root, "sub/../../secrets/keys.txt")).toThrow(PathOutsideRootError);
  });

  it("rejects an absolute path elsewhere on the filesystem", () => {
    expect(() => resolveInsideRoot(root, "/etc/passwd")).toThrow(PathOutsideRootError);
    expect(() => resolveInsideRoot(root, path.join(outside, "keys.txt"))).toThrow(PathOutsideRootError);
  });

  it("rejects a symlink inside the root that points outside it", () => {
    // The textual path looks fine. Only resolving it catches this one, which
    // is exactly the case a naive prefix check waves through.
    expect(() => resolveInsideRoot(root, "escape.md")).toThrow(PathOutsideRootError);
  });

  it("allows a symlink that stays inside the root", () => {
    expect(() => resolveInsideRoot(root, "inside-link.md")).not.toThrow();
  });

  it("rejects a null byte", () => {
    expect(() => resolveInsideRoot(root, "a.md\0.txt")).toThrow(PathOutsideRootError);
  });

  it("resolves a path that does not exist yet, as long as it would be inside", () => {
    expect(() => resolveInsideRoot(root, "sub/not-written-yet.md")).not.toThrow();
    expect(() => resolveInsideRoot(root, "../not-written-yet.md")).toThrow(PathOutsideRootError);
  });
});

describe("isInside", () => {
  it("treats the root itself as inside", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    // "/a/bc" starts with "/a/b" as a string but is not under it.
    expect(isInside("/a/bc", "/a/b")).toBe(false);
  });

  it("recognises a nested path", () => {
    expect(isInside("/a/b/c/d.md", "/a/b")).toBe(true);
  });
});

describe("toRelative", () => {
  it("returns forward-slash paths relative to the root", () => {
    expect(toRelative(root, path.join(fs.realpathSync(root), "sub", "b.md"))).toBe("sub/b.md");
  });
});
