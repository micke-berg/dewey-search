/**
 * The boundary between "a path from the index" and "a path from whoever is
 * talking to the server".
 *
 * Dewey hands note paths to a language model and then accepts note paths back
 * from it. That round trip is the whole attack surface: a model that has read
 * a note containing `../../.ssh/id_rsa` can echo it into a read request, and
 * the model is not the adversary — the note's author might be. So every path
 * that arrives from outside is resolved against the notes root and rejected if
 * it lands anywhere else, before it reaches the filesystem.
 *
 * Symlinks are resolved too. A symlink inside the notes folder pointing out of
 * it is a real pattern in synced folders, and checking the textual path alone
 * would wave it straight through.
 */

import fs from "node:fs";
import path from "node:path";

export class PathOutsideRootError extends Error {
  constructor(readonly requested: string) {
    super(`Path is outside the notes folder: ${requested}`);
    this.name = "PathOutsideRootError";
  }
}

/**
 * Resolve a caller-supplied note path to an absolute path inside `root`.
 *
 * Accepts a root-relative path (`notes/launch.md`) or an absolute path that
 * happens to be inside the root. Throws `PathOutsideRootError` for anything
 * that escapes, including via `..`, an absolute path elsewhere, or a symlink
 * whose target leaves the tree.
 */
export function resolveInsideRoot(root: string, requested: string): string {
  if (requested.includes("\0")) throw new PathOutsideRootError(requested);

  const rootReal = realpathOrSelf(path.resolve(root));
  const candidate = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(rootReal, requested);

  // Check the textual path first so a non-existent file still gets a clear
  // rejection rather than a confusing ENOENT from realpath.
  if (!isInside(candidate, rootReal)) throw new PathOutsideRootError(requested);

  // Then check where it actually points. realpath only resolves what exists,
  // so walk up to the nearest existing ancestor and verify that.
  const real = realpathOrNearest(candidate);
  if (!isInside(real, rootReal)) throw new PathOutsideRootError(requested);

  return candidate;
}

/** True when `child` is `parent` itself or sits underneath it. */
export function isInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel);
}

/** Path relative to the notes root, in the `a/b.md` form the index stores. */
export function toRelative(root: string, absolute: string): string {
  return path.relative(realpathOrSelf(path.resolve(root)), absolute).split(path.sep).join("/");
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * realpath of the deepest existing ancestor, with the non-existent tail
 * appended. Lets a path be validated before the file is created or when it has
 * just been deleted, without losing symlink resolution on the part that exists.
 */
export function canonicalize(target: string): string {
  return realpathOrNearest(path.resolve(target));
}

function realpathOrNearest(target: string): string {
  let existing = target;
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...missing);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}
