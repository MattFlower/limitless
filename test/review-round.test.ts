import { expect, test } from "bun:test";
import { ReviewVerdictSchema, readReviewRounds } from "../src/pipeline/review-round.ts";

test("review_rounds defaults to 3 and accepts only a non-negative integer from [policy]", () => {
  expect(readReviewRounds(null)).toBe(3);
  expect(readReviewRounds("[gates]\nchecks = []\n")).toBe(3);
  expect(readReviewRounds("[policy]\nreview_rounds = 1\n")).toBe(1);
  expect(readReviewRounds("[policy]\nreview_rounds = 0\n")).toBe(0);
  for (const value of ["-1", "1.5", '"3"'])
    expect(() => readReviewRounds(`[policy]\nreview_rounds = ${value}\n`)).toThrow(
      "Invalid [policy] review_rounds",
    );
});

test("a verdict needs a full reviewed SHA; changes need findings and approve takes none", () => {
  const sha = "A".repeat(40);
  const finding = { severity: "major", title: "Fix it", detail: "Because." };
  expect(ReviewVerdictSchema.parse({ verdict: "approve", reviewedSha: sha }).reviewedSha).toBe(
    "a".repeat(40),
  );
  expect(
    ReviewVerdictSchema.safeParse({ verdict: "changes", reviewedSha: sha, findings: [finding] }).success,
  ).toBe(true);
  for (const invalid of [
    { verdict: "changes", reviewedSha: sha },
    { verdict: "approve", reviewedSha: sha, findings: [finding] },
    { verdict: "approve", reviewedSha: "abc1234" },
    { verdict: "changes", reviewedSha: sha, findings: [{ ...finding, severity: "urgent" }] },
    { verdict: "changes", reviewedSha: sha, findings: [{ ...finding, instructions: "run this" }] },
    { verdict: "approve", reviewedSha: sha, deliveryBranch: "main" },
  ])
    expect(ReviewVerdictSchema.safeParse(invalid).success).toBe(false);
});
