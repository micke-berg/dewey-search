/**
 * End-to-end protocol tests: a real client talking to a real server over an
 * in-memory transport. Calling the handlers directly would test the functions
 * but not the thing that actually matters here — that the tools are declared,
 * validated and answered over the wire the way a host will drive them.
 */

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { buildIndex } from "../core/indexer.js";
import { createFakeEmbedder, createWorkspace, ageFile, type Workspace } from "../test-helpers.js";

const embed = createFakeEmbedder();

const NOTES = {
  "notes/pricing.md": "# Pricing\n\nWe chose a one-time price over a subscription. See [[notes/launch]].\n",
  "notes/launch.md": "# Launch\n\nBenchmarks are published before the announcement.\n",
  "archive/old.md": "# Old decisions\n\nAn early plan that nothing has revisited.\n",
};

let ws: Workspace;
let client: Client;

beforeEach(async () => {
  ws = createWorkspace(NOTES);
  await buildIndex({ config: ws.config, embed });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ config: ws.config, version: "0.0.0-test", embed });
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  ws.cleanup();
});

interface ToolResponse {
  content: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResponse> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResponse;
}

function textOf(response: ToolResponse): string {
  return response.content.map((c) => c.text ?? "").join("\n");
}

describe("tool declarations", () => {
  it("advertises every tool with a description", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "index_status",
      "list_stale_notes",
      "note_links",
      "read_note",
      "reindex",
      "search_notes",
    ]);
    expect(tools.every((t) => (t.description ?? "").length > 20)).toBe(true);
  });

  it("marks the read-only tools as read-only so a host can auto-approve them", async () => {
    const { tools } = await client.listTools();
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(["index_status", "list_stale_notes", "note_links", "read_note", "search_notes"]);
    expect(tools.find((t) => t.name === "reindex")!.annotations?.readOnlyHint).toBe(false);
  });
});

describe("search_notes", () => {
  it("returns the matching note with a path and a line to jump to", async () => {
    const response = await call("search_notes", { query: "subscription" });
    const structured = response.structuredContent as { hits: { path: string; startLine: number }[] };
    expect(structured.hits[0]!.path).toBe("notes/pricing.md");
    expect(structured.hits[0]!.startLine).toBeGreaterThan(0);
    expect(textOf(response)).toContain("notes/pricing.md");
  });

  it("attaches index freshness to every response", async () => {
    const response = await call("search_notes", { query: "pricing" });
    const structured = response.structuredContent as { indexFreshness: { behind: number; summary: string } };
    expect(structured.indexFreshness.summary).toBeTruthy();
    expect(structured.indexFreshness.behind).toBe(0);
  });

  it("reports being behind after a note changes underneath it", async () => {
    ws.write("notes/new-note.md", "# Brand new\n\nWritten after the index was built.\n");
    const structured = (await call("search_notes", { query: "pricing" })).structuredContent as {
      indexFreshness: { behind: number };
    };
    expect(structured.indexFreshness.behind).toBe(1);
  });

  it("rejects arguments outside the schema before the handler runs", async () => {
    const response = await call("search_notes", { query: "pricing", limit: 9999 });
    expect(response.isError).toBe(true);
    expect(textOf(response).toLowerCase()).toContain("limit");
  });

  it("rejects an empty query", async () => {
    expect((await call("search_notes", { query: "" })).isError).toBe(true);
  });
});

describe("read_note", () => {
  it("returns note text to hosts using either response representation", async () => {
    const response = await call("read_note", { path: "notes/pricing.md" });
    expect(textOf(response)).toBe(NOTES["notes/pricing.md"]);
    expect(response.structuredContent).toMatchObject({ text: NOTES["notes/pricing.md"] });
  });

  it("returns only the requested line range in both representations", async () => {
    const response = await call("read_note", { path: "notes/pricing.md", fromLine: 1, toLine: 1 });
    expect(textOf(response)).toBe("# Pricing");
    expect(response.structuredContent).toMatchObject({ text: "# Pricing" });
  });

  it("refuses to read outside the notes folder", async () => {
    for (const escape of ["../../etc/passwd", "/etc/passwd", "notes/../../secret.md"]) {
      const response = await call("read_note", { path: escape });
      expect(response.isError, escape).toBe(true);
      expect(textOf(response)).toContain("outside the notes folder");
    }
  });

  it("reports a missing note without leaking the absolute path", async () => {
    const response = await call("read_note", { path: "notes/nope.md" });
    expect(response.isError).toBe(true);
    expect(textOf(response)).not.toContain(ws.root);
  });
});

describe("list_stale_notes", () => {
  it("finds notes older than the threshold", async () => {
    ageFile(ws.root, "archive/old.md", 400);
    const structured = (await call("list_stale_notes", { olderThanDays: 300 })).structuredContent as {
      notes: { path: string; ageDays: number }[];
      staleCount: number;
    };
    expect(structured.staleCount).toBe(1);
    expect(structured.notes[0]!.path).toBe("archive/old.md");
    expect(structured.notes[0]!.ageDays).toBeGreaterThanOrEqual(400);
  });

  it("ranks a linked stale note above an unlinked one of the same age", async () => {
    ageFile(ws.root, "archive/old.md", 400);
    ageFile(ws.root, "notes/launch.md", 400);
    const structured = (await call("list_stale_notes", { olderThanDays: 300 })).structuredContent as {
      notes: { path: string }[];
    };
    // launch.md is linked from pricing.md; old.md is linked from nowhere.
    expect(structured.notes[0]!.path).toBe("notes/launch.md");
  });

  it("returns an empty list when nothing is stale", async () => {
    const structured = (await call("list_stale_notes", { olderThanDays: 3650 })).structuredContent as {
      notes: unknown[];
    };
    expect(structured.notes).toEqual([]);
  });
});

describe("note_links", () => {
  it("reports both directions", async () => {
    const structured = (await call("note_links", { path: "notes/launch.md" })).structuredContent as {
      incoming: string[];
    };
    expect(structured.incoming).toContain("notes/pricing.md");
  });
});

describe("index_status", () => {
  it("reports size, model and freshness", async () => {
    const response = await call("index_status");
    const structured = response.structuredContent as { files: number; chunks: number; behind: number };
    expect(structured.files).toBe(3);
    expect(structured.chunks).toBeGreaterThan(0);
    expect(structured.behind).toBe(0);
    expect(textOf(response)).toContain(ws.root);
  });
});

describe("reindex", () => {
  it("picks up a new note and clears the backlog", async () => {
    ws.write("notes/added.md", "# Added\n\nA note written after the first build.\n");

    const structured = (await call("reindex")).structuredContent as { indexed: number; scanned: number };
    expect(structured.scanned).toBe(4);
    expect(structured.indexed).toBe(1);

    const after = (await call("search_notes", { query: "pricing" })).structuredContent as {
      indexFreshness: { behind: number };
    };
    expect(after.indexFreshness.behind).toBe(0);
  });
});
