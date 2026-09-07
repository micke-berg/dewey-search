# Benchmarking retrieval on your own notes

Nobody in this corner of the tooling world publishes retrieval numbers, which
means every claim about search quality — including the ones in this repository's
README — is asking you to take someone's word for it. The way out is not a
better claim. It is shipping the harness so you can generate your own numbers on
your own notes, and being explicit about what the method can and cannot tell
you.

## Why the ground truth is the hard part

The tempting way to build a retrieval benchmark is to write some questions,
decide from memory which note answers each one, and score the retriever against
that. What this measures is whether the retriever agrees with your recollection
of your own notes. It is not the same thing as whether it found the answer, and
it fails in the flattering direction: questions you remember clearly are
questions about notes that are easy to find.

So a question set here is not trusted until it is verified. Each question
carries:

- `expect` — the notes that genuinely answer it. Any one of them counts.
- `evidence` — a regular expression that must actually match inside one of those
  notes.

`dewey bench verify` checks every one of these against the files on disk. If the
evidence pattern is not in the file, the question is broken and the runner
refuses to score the whole set rather than counting it as a miss. A miss that is
really a bad question deflates your numbers and teaches you nothing.

## Getting a question set

```bash
dewey bench init --out my-questions.json --count 50
```

This drafts one question per note across a spread of your folders, prefills the
expected file, and picks an evidence pattern using the rarest term in that note
measured across your whole corpus — a term appearing in one note is strong proof
the answer is there, a term appearing in four hundred proves nothing.

Every drafted question arrives with `"reviewed": false` and the runner will not
score the set until you change that. This is deliberate. A generated question is
a guess about your notes, and the generated phrasing ("what is X") is not how you
would actually ask. Rewriting them in your own words is most of the value:
questions phrased the way you really search are the questions worth optimising
for.

Practical advice while reviewing:

- **Write questions you have actually needed answered.** Half-remembered ones are
  the realistic case.
- **Use the vocabulary you would use**, including the wrong or outdated name for
  a thing. Those are the queries that separate hybrid search from grep.
- **If your notes are multilingual, ask in both languages.** Cross-language
  retrieval is where a monolingual setup falls apart, and you will not find out
  from questions asked only in the language your notes are written in.
- **Add several expect files where several notes genuinely answer.** Being strict
  about the "one true note" invents misses.
- **Keep the questions that make it look bad.** Those are the useful ones.

Then:

```bash
dewey bench verify my-questions.json
dewey bench run my-questions.json --out results.json
```

## What is measured

| | |
| --- | --- |
| **recall@5** | Did any expected note appear in the top 5? The headline number. |
| **MRR** | Mean reciprocal rank of the first expected note. Rewards ranking it first rather than fifth. |
| **latency p50 / mean** | Wall clock per query, embedding model already warm. |

Four retrievers run over the same index and the same questions: BM25 alone,
vectors alone, the two fused with RRF, and optionally fusion plus the
cross-encoder reranker.

Results are deduplicated to notes rather than chunks, because "which note
answers this" is the question a person actually has.

## Reading the results honestly

**Latency excludes the one-time model load.** Loading the embedding model takes
around a second from a warm cache, and around twenty seconds the first time it is
downloaded. Reporting it as part of query latency would be dishonest in one
direction; hiding it entirely would be dishonest in the other, so it is reported
separately as `warmupMs`.

**The per-question file is the point.** `--out results.json` records every
retriever's top 5 for every question. A summary table with no way to see which
questions failed is a claim rather than a measurement, and the failures are the
part worth reading — they cluster, and the clusters tell you what to fix.

**recall@5 on your notes is not comparable to recall@5 on anyone else's.** It
depends on how many notes you have, how much they repeat each other, and how
distinctive your vocabulary is. A number from this harness is meaningful compared
against another retriever on the *same* corpus, and close to meaningless as an
absolute.

**Corpus size moves the number.** Adding notes usually lowers recall@5, because
there is more competition for five slots and more near-duplicates of the right
answer. A benchmark from six months ago is not evidence about your notes today.

**A benchmark cannot tell you the answer was right.** It measures whether the
retriever surfaced a note that contains the answer. Whether the assistant then
reads it correctly, and whether the note itself is still true, are different
questions — the second is what `dewey stale` is for.

## Load testing

Retrieval quality and scale are separate questions, and the synthetic corpus
answers only the second:

```bash
dewey synth --out /tmp/big-corpus --count 20000
dewey index --notes /tmp/big-corpus --db /tmp/big-corpus.db
```

The generated text is deliberately nonsense with a heavy-tailed link graph and a
realistic spread of file sizes. It tells you about index build time, database
size and query latency at a scale most real notes will not reach. It tells you
nothing whatsoever about retrieval quality, and any recall number produced from
it would be meaningless.
