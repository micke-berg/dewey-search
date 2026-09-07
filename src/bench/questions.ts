/**
 * The question-set format and its verifier.
 *
 * A retrieval benchmark is only worth the ground truth behind it. The easy
 * failure is writing a question, guessing which note answers it, and scoring
 * against the guess — which measures whether the retriever agrees with your
 * memory, not whether it found the answer.
 *
 * So a question set is not trusted until it is verified: every expected file
 * must exist, and every question must carry an evidence pattern that actually
 * appears in that file. A question whose evidence does not match is a broken
 * question, and the runner refuses to score it rather than counting it as a
 * miss and quietly deflating the numbers.
 */

import fs from "node:fs";
import path from "node:path";
import * as z from "zod";

export const evidenceSchema = z.object({
  file: z.string().min(1),
  /** Case-insensitive regular expression that must match somewhere in `file`. */
  pattern: z.string().min(1),
});

export const questionSchema = z.object({
  id: z.string().min(1),
  q: z.string().min(1),
  /** Any one of these counts as a correct retrieval. */
  expect: z.array(z.string().min(1)).min(1),
  evidence: z.array(evidenceSchema).min(1),
  /**
   * Scaffolded questions start false. The runner refuses to score an unreviewed
   * set, because a generated question is a guess about your notes until a human
   * has confirmed it asks something real.
   */
  reviewed: z.boolean().default(false),
  note: z.string().optional(),
});

export const questionSetSchema = z.object({
  description: z.string().optional(),
  createdAt: z.string().optional(),
  questions: z.array(questionSchema).min(1),
});

export type Question = z.infer<typeof questionSchema>;
export type QuestionSet = z.infer<typeof questionSetSchema>;

export interface VerificationProblem {
  id: string;
  problem: string;
}

export function loadQuestionSet(filePath: string): QuestionSet {
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const parsed = questionSetSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(
      `${filePath} is not a valid question set: ${first ? `${first.path.join(".")} ${first.message}` : "unknown error"}`,
    );
  }
  return parsed.data;
}

/**
 * Check every question against the notes on disk. An empty result means the
 * set is safe to score against.
 */
export function verifyQuestionSet(set: QuestionSet, root: string): VerificationProblem[] {
  const problems: VerificationProblem[] = [];
  const seenIds = new Set<string>();

  for (const question of set.questions) {
    if (seenIds.has(question.id)) problems.push({ id: question.id, problem: "duplicate id" });
    seenIds.add(question.id);

    if (!question.reviewed) {
      problems.push({
        id: question.id,
        problem: 'not reviewed yet — read the question, fix it if it is wrong, then set "reviewed": true',
      });
    }

    for (const expected of question.expect) {
      if (!fs.existsSync(path.join(root, expected))) {
        problems.push({ id: question.id, problem: `expected file does not exist: ${expected}` });
      }
    }

    for (const evidence of question.evidence) {
      const full = path.join(root, evidence.file);
      if (!fs.existsSync(full)) {
        problems.push({ id: question.id, problem: `evidence file does not exist: ${evidence.file}` });
        continue;
      }
      if (!question.expect.includes(evidence.file)) {
        problems.push({
          id: question.id,
          problem: `evidence points at ${evidence.file}, which is not in expect — the answer would not be scored`,
        });
      }
      let re: RegExp;
      try {
        re = new RegExp(evidence.pattern, "i");
      } catch {
        problems.push({ id: question.id, problem: `evidence pattern is not a valid regex: ${evidence.pattern}` });
        continue;
      }
      if (!re.test(fs.readFileSync(full, "utf8"))) {
        problems.push({
          id: question.id,
          problem: `evidence pattern /${evidence.pattern}/i does not appear in ${evidence.file} — the answer is not actually there`,
        });
      }
    }
  }

  return problems;
}
