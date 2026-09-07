# Dewey — notes for agents working in this repository

## What this is

A local search engine over a folder of markdown, exposed three ways: a library,
a CLI, and an MCP server. The MCP server is the reason it exists; the CLI is how
you drive it without a host; the library is what both are built on and has no
privileged access to anything.

## The rules that are not negotiable

1. **Nothing writes to the notes folder. Ever.** The index lives outside it, and
   `resolveConfig` refuses a database path inside the notes. If a feature seems
   to need a write into the notes, it belongs in a different tool.
2. **Every caller-supplied path goes through `resolveInsideRoot`.** Note paths
   make a round trip through a language model that has read the notes, so a path
   arriving from outside is untrusted input, not a filename. Symlinks are
   resolved, not just prefix-checked.
3. **stdout belongs to the MCP protocol.** `no-console` is an error everywhere
   except the CLI and the benchmark, and `src/mcp/stdio.ts` redirects the console
   to stderr before anything else loads. One stray `console.log` from any
   dependency breaks the transport.
4. **Search never answers without saying how fresh the index is.** A derived
   cache that can go quietly stale is worse than no cache, because the failure is
   invisible. `indexFreshness` rides on every search response.
5. **The benchmark cannot be scored against unverified ground truth.** Evidence
   patterns must actually match, and scaffolded questions stay unreviewed until a
   human says otherwise. Do not add an escape hatch for this.

## Layout

```
src/
  config.ts          Path and model resolution. Canonicalises both paths once.
  cli.ts             The command line. The only place with argument parsing.
  core/
    chunker.ts       Heading-aware chunking, wikilink extraction. Pure.
    db.ts            SQLite schema, FTS5 + vec0 tables, index status, mismatch detection.
    embedder.ts      Local embeddings via ONNX Runtime + the Hub tokenizer. The EmbedFn seam.
    model-files.ts   Model download, tokenizer, padding/truncation, pooling.
    indexer.ts       The walk, the incremental diff, the per-file transaction.
    query.ts         BM25 + vector candidates, RRF fusion, optional rerank.
    rrf.ts           Reciprocal rank fusion. Pure.
    rerank.ts        Cross-encoder pass. Off by default.
    snippet.ts       Result excerpts. Pure.
    freshness.ts     How far behind the index is.
    staleness.ts     How stale the notes are. Different question.
    paths.ts         The root containment guard.
  mcp/
    server.ts        Tool definitions and handlers.
    stdio.ts         The stdout guard and serveStdio wiring.
  bench/
    questions.ts     Question-set schema and the verifier.
    scaffold.ts      Drafts a question set from someone's notes.
    run.ts           The runner and the markdown report.
    synth.ts         Synthetic corpus for load testing.
  test-helpers.ts    Fake embedder and throwaway workspaces. Not published.
```

## Protocol version

The MCP server targets **2026-07-28**. That revision is stateless: no
`initialize` handshake, no session id, per-request `_meta`, and no
server-initiated requests. Two consequences that are easy to get wrong:

- Use `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`.
  Constructing a `StdioServerTransport` and calling `server.connect()` serves
  only the 2025-era protocol regardless of SDK version.
- Never cache anything per connection. The tool set must be identical for every
  caller, and one pipe may carry unrelated requests.

The package is `@modelcontextprotocol/server` v2. The older
`@modelcontextprotocol/sdk` package tops out at protocol `2025-11-25` and is the
wrong dependency here.

## Pinned versions and why

- **`better-sqlite3` 12.x.** Version 13 segfaults on the first `vec0` query with
  `sqlite-vec` 0.1.9 — no exception, exit code 139. `src/core/native.test.ts`
  exercises the native path so a bump fails CI instead of shipping a crash.
- **TypeScript 6.0.3.** `typescript-eslint` declares `typescript <6.1.0`. TS 7 is
  current but makes the linter warn on every run.
- **No transformers.js.** It pulled in an image library with open advisories
  that reached every consumer. `model-files.ts` uses ONNX Runtime and the Hub
  tokenizer directly instead. Do not reintroduce it for convenience.

## Definition of done

`npm run lint && npm run typecheck && npm test && npm run build`, all green.
Check the exit codes — piping vitest into `tail` swallows them and makes a red
run look green.

Changes to retrieval behaviour need a benchmark run before and after, on the same
corpus. "It feels better" is not a result.
