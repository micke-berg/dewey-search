# Release verification

Checked on 2026-09-07 for the first public 0.1.1 distribution.

- Local macOS arm64, Node 24.19.0: lint, type checking, 139 tests and build pass.
- The clean consumer check installs the packed package with native dependencies,
  runs the CLI and synthetic vector search, verifies original note bytes, and
  uninstalls it. No development dependencies or fixtures enter the package.
- The real cached multilingual-e5-small model returns recovery.md first for
  "How can I undo a mistake?" and launch.md first for "LANTERN-42" in the
  three-note `npm run demo` example. This is not a retrieval benchmark.
- Fresh Claude Code 2.1.263 and Codex CLI 0.144.0 sessions on macOS successfully
  call `index_status`, `search_notes` and `read_note` against one synthetic note.
  The reported identifier is LANTERN-42, index backlog is zero, and note bytes
  remain unchanged. These checks do not establish every host or OS combination.

The first Claude check exposed a compatibility issue. The server returned note
text in `content` and metadata in `structuredContent`; Claude exposed only the
latter to its model. The fixed response includes the same requested text in both
representations. Regression tests failed before the fix and pass afterward.
Both host checks were repeated against the fix.

The CI and tagged release workflows require checks on Windows, macOS and Linux.
Use the workflow run associated with a specific commit or tag for its status.
They use deterministic embeddings to verify native storage and packaging;
they do not download models or score semantic quality.

Registry publication is a separate step requiring an authenticated npm owner.
A source release and a successful package check do not establish npm availability.
