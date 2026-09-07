# Contributing

Use Node 22.13 or newer. Install with `npm ci`, then run:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run release:check
```

Open a pull request with the problem, resulting behavior and relevant checks.
Keep fixtures synthetic. Never include personal notes, local index databases,
credentials or downloaded model weights.

Dewey must preserve note files, contain note paths within the configured root,
keep the database outside notes, and report freshness with MCP search results.
Changes to retrieval need measurements before and after on the same corpus and
human-reviewed questions. Do not label generated benchmark answers as verified.

To discuss a bug, include your OS, architecture, Node version and a minimal
synthetic example. Report security problems privately as described in SECURITY.md.
