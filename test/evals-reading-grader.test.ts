import { expect, test } from "bun:test";
import { loadRoleCases, VerifyCaseFileSchema } from "../src/evals/cases.ts";
import { gradeReview } from "../src/evals/graders/review.ts";
import { gradeVerify } from "../src/evals/graders/verify.ts";
import type { Verify } from "../src/pipeline/schemas.ts";
import { reviewCase, reviewOutput } from "./evals-reading-support.ts";

const fixturePath = new URL("./data/evals-verify.json", import.meta.url).pathname;
test("review location windows are inclusive, normalize ./, exclude nits and never match line zero numerically", () => {
  for (const [line, match] of [
    [4, false],
    [5, true],
    [25, true],
    [26, false],
    [0, false],
    [-1, false],
  ] as const)
    expect(gradeReview(reviewCase, reviewOutput(line)).pass).toBe(match);
  expect(gradeReview(reviewCase, reviewOutput(10, "nit")).pass).toBe(false);
  expect(gradeReview(reviewCase, reviewOutput(10, "blocker", "wrong.ts")).pass).toBe(false);
  expect(gradeReview(reviewCase, reviewOutput(10, "blocker", "././src/a.ts")).pass).toBe(true);
  for (const category of ["correctness", "completeness"]) {
    const item = {
      ...reviewCase,
      defects: reviewCase.defects.map((d) => ({ ...d, category, lines: [1, 2] as [number, number] })),
    };
    expect(gradeReview(item, reviewOutput(0)).pass).toBe(category === "completeness");
  }
  const output = reviewOutput();
  output.findings.push(...output.findings);
  expect(gradeReview(reviewCase, output).review?.requiredMatched).toBe(1);
});
test("review optional defects, returned verdict and clean blocking rules", () => {
  const optional = { ...reviewCase, defects: reviewCase.defects.map((d) => ({ ...d, required: false })) };
  expect(gradeReview(optional, { ...reviewOutput(), findings: [] })).toMatchObject({
    pass: true,
    score: null,
    review: { requiredTotal: 0, recall: null },
  });
  for (const kind of ["real", "seeded"] as const) {
    expect(gradeReview({ ...reviewCase, kind }, reviewOutput()).pass).toBe(true);
    expect(gradeReview({ ...reviewCase, kind }, { ...reviewOutput(), verdict: "approve" }).pass).toBe(false);
  }
  for (const severity of ["blocker", "major", "minor", "nit"] as const) {
    const clean = { ...optional, kind: "clean" as const };
    expect(gradeReview(clean, { ...reviewOutput(10, severity), verdict: "approve" }).pass).toBe(
      ["minor", "nit"].includes(severity),
    );
    expect(gradeReview(clean, reviewOutput(10, severity)).review?.falseBlock).toBe(true);
  }
});
test("verify truth table treats absent, unclear and duplicate IDs as inconclusive, disregarding overall", () => {
  const item = VerifyCaseFileSchema.parse(loadRoleCases("verify", fixturePath)).cases[0];
  if (!item) throw new Error("fixture");
  for (const gold of ["met", "unmet"] as const)
    for (const statuses of [
      [],
      ["met"],
      ["unmet"],
      ["unclear"],
      ["met", "met"],
      ["met", "unmet"],
    ] as Verify["criteria"][number]["status"][][]) {
      const predicted = statuses.length === 1 ? statuses[0] : null;
      for (const overall of ["pass", "fail"] as const) {
        const grade = gradeVerify(
          { ...item, gold: { "AC-1": gold } },
          {
            overall,
            notes: "",
            criteria: [
              ...statuses.map((status) => ({ id: "AC-1", status, evidence: "checked", publicSummary: "" })),
              { id: "EXTRA", status: "met", evidence: "ignored", publicSummary: "" },
            ],
          },
        );
        expect(grade.pass).toBe(predicted === gold);
        expect(grade.verify?.falseAccepts).toBe(Number(gold === "unmet" && predicted === "met"));
        expect(grade.verify?.falseRejects).toBe(Number(gold === "met" && predicted !== "met"));
        expect(grade.verify?.total).toBe(1);
      }
    }
  const cases = VerifyCaseFileSchema.parse(loadRoleCases("verify", fixturePath)).cases;
  expect(cases).toHaveLength(3);
  for (const c of cases)
    expect(
      gradeVerify(c, {
        overall: "fail",
        notes: "",
        criteria: Object.entries(c.gold).map(([id, status]) => ({
          id,
          status,
          evidence: "checked",
          publicSummary: "",
        })),
      }).pass,
    ).toBe(true);
});
