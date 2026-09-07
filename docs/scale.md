# Behaviour at scale

Tools in this space have a reputation for degrading on large collections, so
"does it hold up" deserves a measurement rather than a reassurance. This page
records what was actually run.

Reproduce it:

```bash
dewey synth --out /tmp/big-corpus --count 20000 --seed 7
dewey index --notes /tmp/big-corpus --db /tmp/big-corpus.db
```

The generator is deterministic given a seed, produces a heavy-tailed link graph
so some notes accumulate hundreds of inbound links, and varies file sizes. The
text itself is nonsense. This measures throughput, index size and query latency.
It says nothing about retrieval quality, and any recall number from it would be
meaningless.

Hardware: an M-series MacBook Pro, Node 22.12, nothing else running.

## Query latency against corpus size

| Corpus | Files | Chunks | Index | p50 | p90 | p99 |
| --- | --- | --- | --- | --- | --- | --- |
| Real notes | 600 | 6,967 | 33.6 MB | 8 ms | — | — |
| Synthetic | 20,000 | 110,241 | 331.9 MB | 46 ms | 72 ms | 420 ms |

**15.8 times the chunks costs 5.75 times the latency.** The curve is comfortably
sub-linear, which is what the design predicts: FTS5 and the vector index both do
work proportional to matches rather than to corpus size, and a fixed cost
(embedding the query, loading candidate rows) makes up much of the small-corpus
number.

The p99 of 420 ms is worth naming rather than hiding behind the median. It is a
cold-page effect. At 332 MB the index no longer sits in the filesystem cache, so
an occasional query pays for real disk reads. It is not a tail that grows with
further scale, it is the cost of the first touch of a cold region.

Search stays interactive at 20,000 notes. Nothing here needed tuning to get
there.

## Indexing

| | 600 notes | 20,000 notes |
| --- | --- | --- |
| Full build | 374 s | 1,833 s (30.5 min) |
| Re-index, nothing changed | under 1 s | **0.3 s** |
| Peak memory | — | 1.05 GB |

Two things matter more than the headline.

**The first build is a leave-it-running job.** Half an hour for 20,000 notes,
dominated entirely by embedding, which is CPU-bound. Throughput observed between
roughly 100 and 400 files per minute depending on what else the machine was
doing, and a dip mid-run traced to CPU contention rather than corpus size.

**Every build after that is free.** 0.3 seconds to confirm 20,000 unchanged
files, because the incremental check is a stat of each file against the recorded
mtime and size, and nothing gets re-read. This is the number that decides whether
a tool is usable daily, and it is the one most easily lost by rebuilding
everything on a schedule.

Memory peaked at 1.05 GB during the full build. That is the embedding model plus
one file's chunks at a time, not the corpus, so it does not grow with the notes.

Interrupting a build is safe. Each file commits in its own transaction, so a
build killed halfway leaves a complete, queryable index of the files it reached
and the next run continues from there.

## What this does and does not establish

It establishes that indexing, storage and query latency hold up at 20,000 notes
and 110,000 chunks, with no tuning, on a laptop.

It establishes nothing about retrieval *quality* at that size. The corpus is
generated nonsense with deliberately overlapping vocabulary. For quality you need
a verified question set over real notes, which is what
[docs/benchmark.md](benchmark.md) is for.
