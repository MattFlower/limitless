import { describe, expect, test } from "bun:test";
import { blockingReviewFindings, reviewVerdict } from "../src/pipeline/review.ts";
import { LaterReviewSchema, type Review } from "../src/pipeline/schemas.ts";

const finding = (severity: Review["findings"][number]["severity"], security = false) => ({
  severity,
  security,
  label: "new" as const,
  file: "src/example.ts",
  line: 1,
  title: "Observed issue",
  detail: "Reproducible issue",
  suggestion: "Fix it",
});

describe("deterministic review decision", () => {
  for (const [label, severity, security, firstRound, laterRound] of [
    ["new", "blocker", false, true, true],
    ["new", "major", false, true, false],
    ["new", "minor", false, false, false],
    ["new", "nit", false, false, false],
    ["new", "minor", true, false, true],
    ["unaddressed", "minor", false, false, true],
    ["regression", "nit", false, false, true],
  ] as const) {
    test(`${label} ${severity}${security ? " security" : ""}`, () => {
      const review: Review = {
        verdict: "approve",
        summary: "model assessment",
        findings: [{ ...finding(severity, security), label }],
      };
      expect(blockingReviewFindings(review, false).length > 0).toBe(firstRound);
      expect(blockingReviewFindings(review, true).length > 0).toBe(laterRound);
      expect(reviewVerdict(review, true)).toBe(laterRound ? "request_changes" : "approve");
      expect(reviewVerdict({ ...review, verdict: "request_changes" }, true)).toBe(
        laterRound ? "request_changes" : "approve",
      );
    });
  }

  test("later findings require a valid label and explicit security marker", () => {
    const review = { verdict: "approve", summary: "reviewed", findings: [finding("major")] };
    expect(LaterReviewSchema.safeParse(review).success).toBe(true);
    for (const invalid of [
      { ...finding("major"), label: undefined },
      { ...finding("major"), label: "unknown" },
      { ...finding("major"), security: undefined },
    ]) {
      expect(LaterReviewSchema.safeParse({ ...review, findings: [invalid] }).success).toBe(false);
    }
  });
});
