import { afterEach, describe, expect, it } from "vitest";
import { verifyQuestionSet, type QuestionSet } from "./questions.js";
import { scaffoldQuestionSet } from "./scaffold.js";
import { createWorkspace, type Workspace } from "../test-helpers.js";

let ws: Workspace | null = null;
afterEach(() => {
  ws?.cleanup();
  ws = null;
});

const NOTES = {
  "notes/pricing.md": "# Pricing\n\nWe chose a one-time price. The internal codename was quicksilver.\n",
  "notes/launch.md": "# Launch\n\nBenchmarks first, announcement second.\n",
};

function question(overrides: Partial<QuestionSet["questions"][number]> = {}): QuestionSet {
  return {
    questions: [
      {
        id: "q01",
        q: "what did we decide about pricing",
        expect: ["notes/pricing.md"],
        evidence: [{ file: "notes/pricing.md", pattern: "one-time price" }],
        reviewed: true,
        ...overrides,
      },
    ],
  };
}

describe("verifyQuestionSet", () => {
  it("passes a set whose evidence really is in the expected file", () => {
    ws = createWorkspace(NOTES);
    expect(verifyQuestionSet(question(), ws.root)).toEqual([]);
  });

  it("refuses a set that has not been reviewed", () => {
    ws = createWorkspace(NOTES);
    const problems = verifyQuestionSet(question({ reviewed: false }), ws.root);
    expect(problems.map((p) => p.problem).join(" ")).toContain("not reviewed");
  });

  it("catches an expected file that does not exist", () => {
    ws = createWorkspace(NOTES);
    const problems = verifyQuestionSet(question({ expect: ["notes/imaginary.md"] }), ws.root);
    expect(problems.some((p) => p.problem.includes("expected file does not exist"))).toBe(true);
  });

  it("catches evidence that does not appear in the file", () => {
    ws = createWorkspace(NOTES);
    // This is the failure the whole mechanism exists for: a question whose
    // supposed answer is not actually in the note it points at.
    const problems = verifyQuestionSet(
      question({ evidence: [{ file: "notes/pricing.md", pattern: "annual subscription" }] }),
      ws.root,
    );
    expect(problems.some((p) => p.problem.includes("is not actually there"))).toBe(true);
  });

  it("catches evidence pointing at a file that would never be scored", () => {
    ws = createWorkspace(NOTES);
    const problems = verifyQuestionSet(
      question({ evidence: [{ file: "notes/launch.md", pattern: "Benchmarks" }] }),
      ws.root,
    );
    expect(problems.some((p) => p.problem.includes("not in expect"))).toBe(true);
  });

  it("catches an invalid regex instead of crashing", () => {
    ws = createWorkspace(NOTES);
    const problems = verifyQuestionSet(
      question({ evidence: [{ file: "notes/pricing.md", pattern: "unclosed(" }] }),
      ws.root,
    );
    expect(problems.some((p) => p.problem.includes("not a valid regex"))).toBe(true);
  });

  it("catches duplicate ids", () => {
    ws = createWorkspace(NOTES);
    const set = question();
    set.questions.push({ ...set.questions[0]! });
    expect(verifyQuestionSet(set, ws.root).some((p) => p.problem === "duplicate id")).toBe(true);
  });

  it("matches evidence case-insensitively", () => {
    ws = createWorkspace(NOTES);
    expect(verifyQuestionSet(question({ evidence: [{ file: "notes/pricing.md", pattern: "ONE-TIME PRICE" }] }), ws.root)).toEqual(
      [],
    );
  });
});

describe("scaffoldQuestionSet", () => {
  it("drafts questions marked unreviewed, so nothing can be scored by accident", () => {
    ws = createWorkspace({
      "notes/pricing.md": `# Pricing\n\n${"Long enough to count as substantial. ".repeat(10)}quicksilver\n`,
      "notes/launch.md": `# Launch\n\n${"Also long enough to be picked up here. ".repeat(10)}palladium\n`,
    });

    const set = scaffoldQuestionSet(ws.config, { count: 2 });
    expect(set.questions).toHaveLength(2);
    expect(set.questions.every((q) => !q.reviewed)).toBe(true);
    // A scaffolded set must fail verification until a human has been through it.
    expect(verifyQuestionSet(set, ws.root).length).toBeGreaterThan(0);
  });

  it("points each question at the note it came from, with evidence that matches", () => {
    ws = createWorkspace({
      "notes/pricing.md": `# Pricing\n\n${"Substantial body text goes here. ".repeat(10)}quicksilver\n`,
    });

    const set = scaffoldQuestionSet(ws.config, { count: 1 });
    const drafted = set.questions[0]!;
    expect(drafted.expect).toEqual(["notes/pricing.md"]);

    // Reviewing it without changing anything else should leave it valid, which
    // is only true if the generated evidence genuinely matches.
    drafted.reviewed = true;
    expect(verifyQuestionSet(set, ws.root)).toEqual([]);
  });

  it("spreads across folders rather than taking an alphabetical slice", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) files[`aaa/note-${String(i)}.md`] = `# A${String(i)}\n\n${"body ".repeat(60)}\n`;
    for (let i = 0; i < 6; i++) files[`zzz/note-${String(i)}.md`] = `# Z${String(i)}\n\n${"body ".repeat(60)}\n`;
    ws = createWorkspace(files);

    const drafted = scaffoldQuestionSet(ws.config, { count: 4 });
    const folders = new Set(drafted.questions.map((q) => q.expect[0]!.split("/")[0]));
    expect(folders).toEqual(new Set(["aaa", "zzz"]));
  });

  it("refuses to draft anything from an empty folder", () => {
    const empty = createWorkspace({});
    ws = empty;
    expect(() => scaffoldQuestionSet(empty.config)).toThrow(/No markdown files/);
  });
});
