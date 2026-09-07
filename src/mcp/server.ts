/**
 * The MCP server, built on the 2026-07-28 revision of the protocol.
 *
 * Two things about that revision shape this file:
 *
 * 1. The protocol is stateless. There is no initialize handshake and no
 *    session: a client may interleave unrelated requests on one stdio pipe,
 *    and a server must not treat the connection as a conversation. So nothing
 *    here caches anything per connection. The config is process configuration,
 *    fixed before the first request and identical for every caller.
 * 2. Server-initiated requests are gone. A tool that needs more information
 *    returns an `input_required` result and is called again. None of these
 *    tools need that — searching a folder never has a follow-up question.
 *
 * Every tool is read-only against the notes folder. `reindex` writes, but only
 * to the index database, which lives outside the notes by construction.
 */

import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { DeweyConfig } from "../config.js";
import { createEmbedder, type EmbedFn } from "../core/embedder.js";
import { createReranker, type Reranker } from "../core/rerank.js";
import { describeFreshness, getFreshness } from "../core/freshness.js";
import { buildIndex } from "../core/indexer.js";
import { linkNeighbors, search } from "../core/query.js";
import { getStaleNotes } from "../core/staleness.js";
import { PathOutsideRootError, resolveInsideRoot } from "../core/paths.js";
import { describeMismatch, findMismatch, getIndexStatus } from "../core/db.js";

export const SERVER_NAME = "dewey";

/** Caps that exist to protect the caller's context window, not the server. */
const MAX_HITS = 25;
const MAX_NOTE_BYTES = 200_000;
const MAX_STALE_NOTES = 100;

export interface BuildServerOptions {
  config: DeweyConfig;
  version: string;
  /** Injectable for tests; defaults to the real local models. */
  embed?: EmbedFn;
  rerank?: Reranker;
}

export function buildServer(opts: BuildServerOptions): McpServer {
  const { config, version } = opts;
  const embed = opts.embed ?? createEmbedder(config);
  const rerank = opts.rerank ?? createReranker(config);

  const server = new McpServer(
    { name: SERVER_NAME, version },
    {
      // The tool list is static and identical for every caller, so it is safe
      // to cache publicly. Nothing else here is: results depend on the notes
      // on disk, which change under us.
      cacheHints: { "tools/list": { ttlMs: 300_000, cacheScope: "public" } },
    },
  );

  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description:
        "Search the local markdown notes folder. Combines keyword (BM25) and semantic (local embedding) " +
        "search, so it finds notes that match the meaning of the question as well as its wording. " +
        "Returns the best matching notes with a snippet and the line to jump to. " +
        "Use this before answering anything about the user's own notes.",
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe("What to look for, in natural language or keywords"),
        limit: z.number().int().min(1).max(MAX_HITS).optional().describe("Maximum notes to return, default 10"),
        rerank: z
          .boolean()
          .optional()
          .describe("Run the cross-encoder reranker for better ordering, at roughly 100x the latency"),
      }),
      annotations: readOnly,
    },
    async ({ query, limit, rerank: rerankRequested }) => {
      const useRerank = rerankRequested ?? config.rerank;
      const result = await search(query, {
        config: useRerank ? { ...config, rerank: true } : config,
        embed,
        rerank,
        limit: limit ?? 10,
      });

      const freshness = getFreshness(config);
      const structured = {
        hits: result.hits.map((h) => ({
          path: h.path,
          title: h.title,
          heading: h.heading,
          startLine: h.startLine,
          snippet: h.snippet,
          matchedBy: h.source,
          score: Number(h.score.toFixed(6)),
        })),
        mode: result.mode,
        reranked: result.reranked,
        // Attached to every response on purpose. A caller that cannot see the
        // index is behind will present a stale answer as a current one.
        indexFreshness: {
          behind: freshness.behind,
          ageHours: freshness.ageHours,
          summary: describeFreshness(freshness),
        },
        notes: result.notes,
      };

      if (!result.indexed) {
        return {
          content: [
            {
              type: "text",
              text: "No search index exists yet for this notes folder. Run `dewey index` to build it.",
            },
          ],
          structuredContent: { ...structured, hits: [] },
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: renderHits(structured) }],
        structuredContent: structured,
      };
    },
  );

  server.registerTool(
    "read_note",
    {
      title: "Read a note",
      description:
        "Read the full text of one note, by the path returned from search_notes. " +
        "Paths are relative to the notes folder.",
      inputSchema: z.object({
        path: z.string().min(1).max(1024).describe("Note path relative to the notes folder, e.g. projects/index.md"),
        fromLine: z.number().int().min(1).optional().describe("First line to return, 1-based"),
        toLine: z.number().int().min(1).optional().describe("Last line to return, inclusive"),
      }),
      annotations: readOnly,
    },
    ({ path: requested, fromLine, toLine }) => {
      let absolute: string;
      try {
        absolute = resolveInsideRoot(config.root, requested);
      } catch (e) {
        // Deliberately does not echo the resolved path: the caller asked for
        // something outside the folder and does not need to learn where the
        // folder actually is.
        if (e instanceof PathOutsideRootError) {
          return errorResult(`That path is outside the notes folder: ${requested}`);
        }
        throw e;
      }

      let raw: string;
      try {
        const stat = fs.statSync(absolute);
        if (!stat.isFile()) return errorResult(`Not a file: ${requested}`);
        raw = fs.readFileSync(absolute, "utf8");
      } catch {
        return errorResult(`No such note: ${requested}`);
      }

      let text = raw;
      let truncated = false;
      if (fromLine !== undefined || toLine !== undefined) {
        const lines = raw.split("\n");
        text = lines.slice((fromLine ?? 1) - 1, toLine ?? lines.length).join("\n");
      }
      if (Buffer.byteLength(text, "utf8") > MAX_NOTE_BYTES) {
        text = text.slice(0, MAX_NOTE_BYTES);
        truncated = true;
      }

      return {
        content: [{ type: "text", text }],
        structuredContent: {
          path: requested,
          // Some hosts expose only structuredContent to the model.
          text,
          bytes: Buffer.byteLength(text, "utf8"),
          truncated,
          modified: new Date(fs.statSync(absolute).mtimeMs).toISOString(),
        },
      };
    },
  );

  server.registerTool(
    "list_stale_notes",
    {
      title: "List stale notes",
      description:
        "Find notes that have not been touched in a long time but that other notes still link to. " +
        "Ranked by risk, meaning age weighted by how many notes depend on it, so the top of the list " +
        "is where an out-of-date note is most likely to be quietly believed. Use this for maintenance " +
        "passes and before trusting an old note.",
      inputSchema: z.object({
        olderThanDays: z.number().int().min(1).max(3650).optional().describe("Age threshold in days, default 180"),
        limit: z.number().int().min(1).max(MAX_STALE_NOTES).optional().describe("Maximum notes to return, default 20"),
        pathPrefix: z.string().max(512).optional().describe("Only consider notes under this folder prefix"),
      }),
      annotations: readOnly,
    },
    ({ olderThanDays, limit, pathPrefix }) => {
      const report = getStaleNotes(config, {
        ...(olderThanDays !== undefined ? { olderThanDays } : {}),
        ...(limit !== undefined ? { limit } : {}),
        pathPrefix,
      });
      return {
        content: [{ type: "text", text: renderStaleness(report) }],
        structuredContent: report,
      };
    },
  );

  server.registerTool(
    "note_links",
    {
      title: "Note links",
      description:
        "The notes that one note links to, and the notes that link back to it. " +
        "Useful for following a thread of related notes that search alone would not connect.",
      inputSchema: z.object({
        path: z.string().min(1).max(1024).describe("Note path relative to the notes folder"),
      }),
      annotations: readOnly,
    },
    ({ path: notePath }) => {
      const { outgoing, incoming } = linkNeighbors(notePath, config.dbPath);
      const text =
        outgoing.length === 0 && incoming.length === 0
          ? `No links recorded for ${notePath}. It may be unindexed, or it may genuinely link nowhere.`
          : [
              outgoing.length > 0 ? `Links to:\n${outgoing.map((p) => `  ${p}`).join("\n")}` : "",
              incoming.length > 0 ? `Linked from:\n${incoming.map((p) => `  ${p}`).join("\n")}` : "",
            ]
              .filter(Boolean)
              .join("\n\n");
      return {
        content: [{ type: "text", text }],
        structuredContent: { path: notePath, outgoing, incoming },
      };
    },
  );

  server.registerTool(
    "index_status",
    {
      title: "Index status",
      description:
        "How large the search index is, when it was last built, and how many notes it is behind. " +
        "Check this when search results seem to be missing something recent.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    () => {
      const freshness = getFreshness(config);
      const mismatch = findMismatch(getIndexStatus(config.dbPath), {
        model: config.model,
        embedDims: config.embedDims,
        root: config.root,
      });
      const lines = [
        describeFreshness(freshness),
        `Notes folder: ${config.root}`,
        `Chunks: ${String(freshness.chunks)} across ${String(freshness.files)} files`,
        `Model: ${freshness.model ?? config.model}`,
        `Index size: ${(freshness.dbBytes / 1_048_576).toFixed(1)} MB`,
        freshness.builtAt ? `Last built: ${freshness.builtAt}` : "Never built",
        mismatch ? `Needs a rebuild. ${describeMismatch(mismatch)}` : "",
      ].filter(Boolean);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          ...freshness,
          mismatch: mismatch ? describeMismatch(mismatch) : null,
        },
      };
    },
  );

  server.registerTool(
    "reindex",
    {
      title: "Reindex the notes",
      description:
        "Bring the search index up to date. Incremental by default: only notes whose contents changed " +
        "are re-read. Writes only to the index database, never to the notes themselves.",
      inputSchema: z.object({
        full: z.boolean().optional().describe("Rebuild every note from scratch rather than only what changed"),
      }),
      annotations: {
        readOnlyHint: false,
        // It rewrites a derived cache that can be regenerated at any time from
        // the notes, so nothing a user owns is at risk.
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ full }) => {
      const stats = await buildIndex({ config, embed, full: full ?? false });
      const text =
        `Indexed ${String(stats.indexed)} of ${String(stats.scanned)} notes ` +
        `(${String(stats.unchanged)} unchanged, ${String(stats.removed)} removed) ` +
        `in ${(stats.ms / 1000).toFixed(1)}s. ${String(stats.chunks)} chunks total.`;
      return { content: [{ type: "text", text }], structuredContent: stats };
    },
  );

  return server;
}

function errorResult(message: string): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}

interface RenderableHits {
  hits: { path: string; title: string; heading: string | null; startLine: number; snippet: string; matchedBy: string }[];
  mode: string;
  reranked: boolean;
  indexFreshness: { behind: number; summary: string };
}

/**
 * The text rendering exists alongside `structuredContent` because a model
 * reading the text block should be able to act without parsing JSON, and
 * because the path and line are what it needs to quote a source.
 */
function renderHits(result: RenderableHits): string {
  if (result.hits.length === 0) return "No matching notes.";
  const lines = result.hits.map((h, i) => {
    // The heading is dropped when it only repeats the note title, which is
    // what content under a page's own H1 produces.
    const where = h.heading && h.heading !== h.title ? `${h.title} › ${h.heading}` : h.title;
    return `${String(i + 1)}. ${where}\n   ${h.path}:${String(h.startLine)}  [${h.matchedBy}]\n   ${h.snippet}`;
  });
  const footer =
    result.indexFreshness.behind > 0 ? `\n\n${result.indexFreshness.summary} Run reindex for current results.` : "";
  const how = result.reranked ? " (reranked)" : result.mode === "bm25-only" ? " (keyword only)" : "";
  return `${String(result.hits.length)} result${result.hits.length === 1 ? "" : "s"}${how}:\n\n${lines.join("\n\n")}${footer}`;
}

function renderStaleness(report: ReturnType<typeof getStaleNotes>): string {
  const header =
    `${String(report.staleCount)} of ${String(report.totalNotes)} notes are older than ` +
    `${String(report.thresholdDays)} days (median age ${String(report.medianAgeDays)} days, ` +
    `${String(report.orphanCount)} orphans).`;

  if (report.notes.length === 0) return header;
  if (report.linkDataMissing) {
    return `${header}\n\nNo index found, so link counts are unavailable and this is ranked by age alone.\n\n${report.notes
      .map((n) => `  ${String(n.ageDays)}d  ${n.path}`)
      .join("\n")}`;
  }

  const rows = report.notes.map(
    (n) => `  ${String(n.ageDays).padStart(5)}d  ${String(n.inboundLinks).padStart(3)} in  ${n.path}`,
  );
  return `${header}\n\nMost at risk first (age weighted by how many notes link to it):\n\n${rows.join("\n")}`;
}

/** Package version, read from the manifest so it cannot drift from the release. */
export function readVersion(moduleUrl: string): string {
  try {
    const here = path.dirname(new URL(moduleUrl).pathname);
    for (const candidate of [
      path.join(here, "..", "..", "package.json"),
      path.join(here, "..", "..", "..", "package.json"),
    ]) {
      if (fs.existsSync(candidate)) {
        return (JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: string }).version ?? "0.0.0";
      }
    }
  } catch {
    // Version is cosmetic in the handshake; never fail startup over it.
  }
  return "0.0.0";
}
