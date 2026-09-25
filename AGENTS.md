# Notes for coding agents

Read `CLAUDE.md` in this folder: it holds the project rules for every agent, not only Claude.

## Nothing private, anywhere in this repository

This code is published. Nothing from the maintainer's own notes, or about the
people in them, may appear in code, tests, fixtures, docs, commit messages,
pull requests, issues or comments: no names of people, companies or places, no
paths or file names from the notes folder, no questions, per-question results
or snippets, and no personal context. Benchmark results are shared as totals
only. Tests and docs use made-up examples (`notes/launch.md`, "Anna", "Acme").

A private word list backs this up with checks that do not depend on which tool
you use: git hooks on commit and push, a `gh` wrapper for PR, issue and
comment text, and the `privacy-guard` workflow on every push, pull request,
issue and comment. When one of them fires, remove the content. Never bypass
it (`--no-verify`, editing or disabling the workflow).
