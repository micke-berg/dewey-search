# Changelog

## 0.1.2

A maintenance release. Search works exactly as in 0.1.1.

- An example path in a code comment is replaced with a made-up one.
- The repository's lockfile moves to `adm-zip` 0.6.1, which fixes a
  high-severity advisory, and `vitest` 4.1.11. A fresh install of the package
  already picked up the fixed `adm-zip`.
- Publishing and the release workflow now check the package contents first and
  stop if the check fails.

## 0.1.1

First public distribution of Dewey, a local Markdown search library, CLI and MCP
server. Combines BM25 and multilingual vector retrieval, reports index freshness,
and identifies old notes with incoming links. Cross-encoder reranking is optional.

- Verified clean package installation and removal on Windows, macOS and Linux.
- Fixed note text missing from structured MCP results in Claude Code.
- Fixed the nonzero exit from CLI help.
- Updated a vulnerable transitive dependency.
- Added a synthetic worked example and documented retrieval limitations.

Historical development and private evaluation data are not part of this public
source repository. The library is MIT licensed; embedding models are downloaded
separately and retain their own licenses.
