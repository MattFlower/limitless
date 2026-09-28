import { expect, test } from "bun:test";
import { loadRoleCases, type ReviewCase, VerifyCaseFileSchema } from "../src/evals/cases.ts";
import { gradeReview } from "../src/evals/graders/review.ts";
import { gradeVerify } from "../src/evals/graders/verify.ts";
import { type Review, StoredReviewSchema, type Verify } from "../src/pipeline/schemas.ts";
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
  // With no required defects a real case still needs the derived verdict to request changes.
  expect(gradeReview(optional, reviewOutput(300))).toMatchObject({
    pass: true,
    score: null,
    review: { requiredTotal: 0, recall: null, underRated: 0 },
  });
  expect(gradeReview(optional, { ...reviewOutput(), findings: [] }).pass).toBe(false);
  for (const kind of ["real", "seeded"] as const) {
    expect(gradeReview({ ...reviewCase, kind }, reviewOutput()).pass).toBe(true);
    expect(gradeReview({ ...reviewCase, kind }, { ...reviewOutput(), verdict: "approve" }).pass).toBe(true);
    // Stored output without any model verdict regrades on the derived verdict alone.
    const { verdict: _ignored, ...withoutVerdict } = reviewOutput();
    expect(StoredReviewSchema.safeParse(withoutVerdict).success).toBe(true);
    expect(gradeReview({ ...reviewCase, kind }, StoredReviewSchema.parse(withoutVerdict))).toMatchObject({
      pass: true,
      review: { requiredMatched: 1, requestChanges: true, verdictMatch: true },
    });
  }
  // The stored schema only relaxes the verdict: an invalid verdict or a degenerate review still fails.
  expect(StoredReviewSchema.safeParse({ ...reviewOutput(), verdict: "maybe" }).success).toBe(false);
  expect(StoredReviewSchema.safeParse({ summary: "short", findings: [] }).success).toBe(false);
  for (const severity of ["blocker", "major", "minor", "nit"] as const) {
    const clean = { ...optional, kind: "clean" as const };
    const blocks = ["blocker", "major"].includes(severity);
    // The production-derived verdict decides; the model's verdict is ignored either way.
    for (const verdict of ["approve", "request_changes"] as const)
      expect(gradeReview(clean, { ...reviewOutput(10, severity), verdict })).toMatchObject({
        pass: !blocks,
        review: { falseBlock: blocks, blockingFindings: Number(blocks), requestChanges: blocks },
      });
  }
});
test("review recall counts only round-1 blocking findings; minor and nit detections are under-rated", () => {
  for (const severity of ["minor", "nit"] as const)
    for (const verdict of ["approve", "request_changes"] as const)
      expect(gradeReview(reviewCase, { ...reviewOutput(10, severity), verdict })).toMatchObject({
        pass: false,
        score: 0,
        review: { requiredMatched: 0, underRated: 1, recall: 0, requestChanges: false, verdictMatch: false },
      });
  for (const severity of ["blocker", "major"] as const) {
    const output = { ...reviewOutput(10, severity), verdict: "approve" as const };
    // A duplicate minor on the same lines doesn't make a caught defect under-rated too.
    output.findings.push(output.findings[0] as Review["findings"][number], {
      ...(output.findings[0] as Review["findings"][number]),
      severity: "minor",
    });
    expect(gradeReview(reviewCase, output)).toMatchObject({
      pass: true,
      score: 1,
      review: { requiredMatched: 1, underRated: 0, blockingFindings: 2, requestChanges: true },
    });
  }
  // Blocking findings elsewhere make the verdict request changes but don't catch the defect.
  const elsewhere = reviewOutput(10, "minor");
  elsewhere.findings.push({
    ...(elsewhere.findings[0] as Review["findings"][number]),
    severity: "blocker",
    line: 40,
  });
  expect(gradeReview(reviewCase, elsewhere)).toMatchObject({
    pass: false,
    review: { requiredMatched: 0, underRated: 1, requestChanges: true },
  });
  // Nit findings still respect the file/line-window boundaries.
  expect(gradeReview(reviewCase, reviewOutput(26, "nit")).review?.underRated).toBe(0);
  expect(gradeReview(reviewCase, reviewOutput(5, "nit", "././src/a.ts")).review?.underRated).toBe(1);
  // Only real blocker/major detections of multiple defects; optional defects stay out of every count.
  const mixed = {
    ...reviewCase,
    defects: [
      { ...reviewCase.defects[0], severity: "blocker", lines: [10, 10] },
      { ...reviewCase.defects[0], severity: "minor", lines: [100, 100] },
      { ...reviewCase.defects[0], severity: "nit", lines: [200, 200] },
      { ...reviewCase.defects[0], severity: "major", lines: [300, 300], required: false },
    ],
  } as ReviewCase;
  const output = reviewOutput(10, "blocker");
  output.findings.push(
    { ...(output.findings[0] as Review["findings"][number]), severity: "minor", line: 100 },
    { ...(output.findings[0] as Review["findings"][number]), severity: "major", line: 300 },
  );
  expect(gradeReview(mixed, output)).toMatchObject({
    pass: false,
    score: 1 / 3,
    review: {
      requiredMatched: 1,
      requiredTotal: 3,
      underRated: 1,
      bySeverity: {
        high: { caught: 1, total: 1 },
        medium: { caught: 0, total: 0 },
        low: { caught: 0, total: 2 },
      },
    },
  });
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
