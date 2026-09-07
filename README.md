# Dewey

Hybrid search and staleness reporting over any folder of markdown, exposed as an
MCP server so your AI assistant can actually find things in your notes.

Two problems, both of which get worse the longer you keep notes:

**Finding things.** Grep needs the exact word you wrote. Semantic search alone
misses the exact word you wrote. Dewey runs both, fuses the rankings, and
returns the note with the line to jump to, with measured latency reported below.

**Trusting things.** A note from eighteen months ago that thirty other notes
still link to reads exactly like a note from last week. Dewey ranks your notes
by age weighted by how much the rest of your notes depend on them, so the ones
most likely to be quietly out of date come first.

Retrieval runs locally after the approved model download. A cloud AI assistant
can still send retrieved text to its provider. Local storage, local retrieval
and provider processing are separate privacy boundaries.

## Numbers

Measured on a real notes folder, roughly half English and half Swedish, using
questions the owner actually asked, verified against the notes that answer them.
Run the same measurement method on your own notes with `dewey bench` — the method is in
[docs/benchmark.md](docs/benchmark.md), and the harness refuses to score a
question set until you have checked it yourself.

These historical results use a private corpus and cannot be independently
reproduced from this repository. They are context, not a guarantee.

Run 2026-09-05, 51 questions over 957 files (11,516 chunks):

| Retriever | recall@5 | MRR | latency p50 |
| --- | --- | --- | --- |
| BM25 only | 51.0 % | 0.387 | 4 ms |
| Vectors only | 74.5 % | 0.625 | 10 ms |
| **Hybrid RRF** (default) | **74.5 %** | 0.592 | **10 ms** |
| Hybrid + cross-encoder rerank | 74.5 % | 0.578 | 2084 ms |

The same harness on 2026-08-06, 54 questions over 600 files, gave 55.6 / 77.8 /
79.6 / 87.0. Three things worth saying out loud about the two tables together:

**Vectors do most of the work.** Fusing BM25 in adds between zero and two points
over vectors alone, not the dramatic gain the phrase "hybrid search" implies. On
a corpus that mixes languages, exact-term search structurally misses, and BM25's
honest contribution is rescuing the queries where someone searches for a literal
string they remember typing.

**Corpus shape matters.** The later run used more files and a different question
set. Daily logs can compete with canonical pages by mentioning the same people
and projects. These runs do not isolate the effect of folder growth, so they
cannot establish its impact on recall. Source weighting remains an open area
for investigation.

**Reranking is not a free win.** In August it lifted recall@5 by 7.4 points at
about 270x the latency. In September, on the larger corpus and a newer ONNX
Runtime, it rescued four questions and lost four others. The runtime alone
accounts for part of that: the same code on the previous runtime scores 80.4 %
with rerank on this corpus. Quantised models shift with the runtime underneath
them, which is one more reason to measure on your own setup rather than trust a
table. It stays behind a flag.

## Install

Install the published package with Node 22.12 or newer:

```sh
npm install --global @micke-berg/dewey@0.1.1
dewey --help
```

For an installation without a global command, see
[installation and removal](docs/release.md). You can also build from source:

```bash
git clone https://github.com/micke-berg/dewey-search.git
cd dewey-search
npm ci
npm run build
node dist/cli.js --help
```

Node 22.12 or newer at runtime; source development needs 22.13+. First indexing
downloads an embedding model, so obtain permission before indexing.
See [installation and release](docs/release.md)
for Windows, tarball installation, both provider adapters and removal.
CLI examples below assume an explicitly installed `dewey` executable; a source
checkout can use `node dist/cli.js` in its place.

Release checks and tested host versions are recorded in
[verification](docs/verification.md).

## Try a small example

From the source checkout, run `npm run demo`. It creates three synthetic notes,
indexes them with the real local embedding model, and prints results for a
plain-language question and an exact release identifier. It checks that note
bytes are unchanged and removes its temporary notes and index afterward.
The embedding model downloads if it is not already cached. This is a worked
example, not a scored benchmark.

## Use it from the command line

```bash
dewey index --notes ~/notes
```

```bash
dewey search "what did I decide about pricing"
```

```bash
dewey stale --days 365
```

Set `DEWEY_NOTES` once and you can drop the `--notes` flag.

## Use it from Claude Code

```bash
claude mcp add dewey --env DEWEY_NOTES=$HOME/notes -- dewey serve
```

That gives the assistant six tools:

| Tool | What it does |
| --- | --- |
| `search_notes` | Hybrid search, returns path, line, snippet, and which retriever matched |
| `read_note` | Read one note, or a line range of it |
| `list_stale_notes` | Old notes that other notes still depend on, most at risk first |
| `note_links` | What a note links to, and what links back |
| `index_status` | Size, age, and how many notes the index is behind |
| `reindex` | Bring the index up to date |

Every search response carries the index's freshness with it. An assistant that
cannot see the index is three days behind will present a stale answer as a
current one, so the number travels with the answer rather than sitting in a
status command nobody runs.

## How it works

```
notes/*.md
    │
    ├─ chunk by heading ─────────► one chunk per section, wikilinks extracted
    │                              (long sections fall back to a sliding window)
    │
    ├─ FTS5 ──────► BM25, title 4x / heading 3x / body 1x ──┐
    │                                                        ├─► RRF ─► top N
    └─ embed ─────► sqlite-vec KNN, 384-dim local model ────┘         │
                                                                      │
                                             optional cross-encoder ──┘
```

The index is SQLite, lives outside your notes folder, and is a pure derived
cache — delete it any time and rebuild. Nothing in Dewey writes to your notes.

Incremental by modification time and size, so re-indexing an untouched folder
takes milliseconds and a changed folder only re-reads what changed. Measured at
20,000 notes and 110,000 chunks: 46 ms per query, and 0.3 seconds to confirm
nothing changed. See [docs/scale.md](docs/scale.md).

### Why fuse on rank rather than score

BM25 scores and cosine distances are not on comparable scales. Normalising them
into one number means inventing a conversion and then defending it. Reciprocal
rank fusion only needs the ordering, which both retrievers genuinely agree on
the meaning of. The cost is that it throws away how *confident* each retriever
was, which is part of why the reranker exists.

## Configuration

| Flag | Environment | Default |
| --- | --- | --- |
| `--notes` | `DEWEY_NOTES` | required |
| `--db` | `DEWEY_DB` | `~/.cache/dewey/<folder>-<hash>.db` |
| `--model` | `DEWEY_MODEL` | `Xenova/multilingual-e5-small` |
| `--rerank` | `DEWEY_RERANK=1` | off |
| — | `DEWEY_IGNORE` | `node_modules` |

Dotfiles and dot-directories are always skipped, so `.git` and `.obsidian` never
enter the index.

The default model is multilingual on purpose. An English-only model scores
better on English-only notes, but collapses on notes that mix languages, and the
user has no way to attribute the bad results to the model choice. If your notes
are entirely English, `--model Xenova/bge-small-en-v1.5` is another supported option to measure.

## Where it loses

Published because a benchmark that only reports its wins is advertising.

- **Person questions.** "Who is X" tends to return the dated digest that mentions
  X six times rather than the page about X. This is a corpus-shape problem, not a
  similarity problem, and it is the single biggest cluster of failures.
- **Dated digests generally.** Daily notes and clippings mention everything, so
  they outrank canonical pages on broad questions. Source weighting would help
  and is not implemented.
- **Cross-language vocabulary.** A multilingual embedding bridges most of the gap
  between a Swedish question and an English note, but not idioms. A question
  using the Swedish word for a concept the notes only ever name in English can
  miss entirely.
- **Only markdown.** `.txt`, PDFs and Org files are ignored.
- **No incremental link graph.** Link edges are rebuilt per file on reindex.
  Measured fine at 20,000 notes; untested well beyond that.
- **The first index of a large folder is slow.** Half an hour for 20,000 notes,
  all of it embedding. Every build after that is incremental and takes under a
  second.

## Reranking

The cross-encoder pass reads the query and the candidate together instead of
comparing two independently computed vectors, which is how it fixes cases fusion
cannot. It is off by default because it costs roughly two orders of magnitude
more per query, and a keystroke-speed search that is no longer keystroke-speed
is a different product.

```bash
dewey search "who is Anna" --rerank
```

## Development

```bash
npm install && npm test
```

`npm run lint`, `npm run typecheck`, `npm test` and `npm run build` are what CI
runs.

`better-sqlite3` is pinned to 12.x deliberately: version 13 segfaults the process
on the first vector query when paired with `sqlite-vec` 0.1.9, with no catchable
error. `src/core/native.test.ts` exists to turn that into a failing CI run rather
than a crash in the field.

TypeScript is pinned one major behind current, because `typescript-eslint` still
declares `typescript <6.1.0` and a linter that prints an unsupported-version
warning on every run trains you to ignore its output.

## License

MIT.
