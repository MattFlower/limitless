import { describe, expect, test } from "bun:test";
import { blockingReviewFindings, reviewVerdict } from "../src/pipeline/review.ts";
import { LaterReviewSchema, type Review, ReviewSchema, toStrictJsonSchema } from "../src/pipeline/schemas.ts";

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
      expect(blockingReviewFindings(review).length > 0).toBe(firstRound);
      expect(blockingReviewFindings(review, [finding("major")]).length > 0).toBe(laterRound);
      expect(reviewVerdict(review, [finding("major")])).toBe(laterRound ? "request_changes" : "approve");
      expect(reviewVerdict({ ...review, verdict: "request_changes" }, [finding("major")])).toBe(
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

test("both review schemas require every object property for strict structured output", () => {
  const check = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if ("properties" in node && node.properties && typeof node.properties === "object") {
      expect("required" in node ? node.required : []).toEqual(Object.keys(node.properties));
    }
    for (const value of Object.values(node)) check(value);
  };
  for (const schema of [ReviewSchema, LaterReviewSchema]) check(toStrictJsonSchema(schema));
  expect(
    ReviewSchema.safeParse({
      verdict: "approve",
      summary: "",
      findings: [{ ...finding("minor"), security: undefined }],
    }).success,
  ).toBe(false);
});

for (const severity of ["blocker", "major", "minor", "nit"] as const) {
  test(`an unmatched unaddressed ${severity} finding fails closed`, () => {
    const review: Review = {
      verdict: "approve",
      summary: "",
      findings: [{ ...finding(severity), label: "unaddressed" }],
    };
    for (const prior of [
      [],
      [{ ...finding("major"), title: "Different issue" }],
      [{ ...finding("major"), file: "src/old.ts" }],
      [{ ...finding("major"), line: 99 }],
    ]) {
      expect(reviewVerdict(review, prior)).toBe("request_changes");
      expect(blockingReviewFindings(review, prior)).toEqual(review.findings);
    }
  });
}
