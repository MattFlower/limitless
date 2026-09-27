import { expect, test } from "bun:test";
import type { TriageCase } from "../src/evals/cases.ts";
import { gradeTriage } from "../src/evals/graders/triage.ts";
import { answer, gold } from "./evals-support.ts";

const item: TriageCase = { id: "a", repo: "fixture/repo", prompt: "fix", tags: [], gold };

test("exact fields, alternatives, nulls, questions and risk weighting", () => {
  expect(gradeTriage(item, answer)).toMatchObject({ pass: true, score: 1, riskUnderCall: false });
  const mismatched = gradeTriage(item, { ...answer, risk: "high" });
  expect(mismatched).toMatchObject({ pass: false, score: 4 / 6, riskUnderCall: false });
  expect(mismatched.fields.risk).toMatchObject({ weight: 2, match: false });
  const alternatives: TriageCase = {
    ...item,
    gold: {
      ...gold,
      task_class: ["bugfix", "feature"],
      risk: ["medium", "high"],
      complexity: null,
      needs_questions: [true, false],
    },
  };
  expect(gradeTriage(alternatives, answer)).toMatchObject({ pass: false, score: 3 / 5, riskUnderCall: true });
  expect(gradeTriage(alternatives, { ...answer, risk: "medium", task_class: "feature" }).pass).toBe(true);
  expect(
    gradeTriage(
      { ...item, gold: { ...gold, needs_questions: true } },
      { ...answer, blocking_questions: ["Which?"] },
    ).pass,
  ).toBe(true);
  expect(gradeTriage({ ...item, gold: { ...gold, needs_questions: true } }, answer).pass).toBe(false);
  expect(
    gradeTriage({ ...item, gold: { ...gold, risk: ["low", "high"] } }, { ...answer, risk: "medium" })
      .riskUnderCall,
  ).toBe(false);
});

test("null risk has no denominator; entirely ungraded cases remain unscored", () => {
  expect(gradeTriage({ ...item, gold: { ...gold, risk: null } }, answer).riskUnderCall).toBeNull();
  expect(
    gradeTriage(
      {
        ...item,
        gold: { task_class: null, complexity: null, risk: null, ambiguity: null, needs_questions: null },
      },
      answer,
    ),
  ).toEqual({ pass: null, score: null, fields: {}, riskUnderCall: null });
});
