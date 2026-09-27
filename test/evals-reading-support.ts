import type { ReviewCase } from "../src/evals/cases.ts";
import type { Review } from "../src/pipeline/schemas.ts";

export const reviewCase: ReviewCase = {
  id: "review-one",
  repo: "fixture/repo",
  base: "a".repeat(40),
  head: "b".repeat(40),
  kind: "real",
  source: "SECRET_SOURCE",
  input: { prompt: "Fix the bug", spec: null, gates: [], implementerReport: "Done" },
  defects: [
    {
      file: "./src/a.ts",
      lines: [10, 20],
      severity: "major",
      category: "correctness",
      summary: "SECRET_DEFECT",
      required: true,
      foundBy: "SECRET_AUTHOR",
    },
  ],
};
export function reviewOutput(
  line = 10,
  severity: Review["findings"][number]["severity"] = "minor",
  file = "src/a.ts",
): Review {
  return {
    verdict: "request_changes",
    summary: "reviewed",
    findings: [{ line, severity, file, title: "Bug", detail: "Observed", suggestion: "Fix" }],
  };
}
