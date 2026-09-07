# Changelog

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
