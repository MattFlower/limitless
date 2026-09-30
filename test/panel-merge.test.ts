import { expect, test } from "bun:test";
import { MERGE_WINDOW, mergeReports } from "../src/pipeline/panel-merge.ts";
import type { Review } from "../src/pipeline/schemas.ts";
import { findingEvidence } from "./review-support.ts";

type Report = Review["findings"][number] & { finder: number };
const report = (finder: number, line: number, over: Partial<Report> = {}): Report => ({
  severity: "minor",
  security: false,
  file: "src/a.ts",
  line,
  title: `finder ${finder} line ${line}`,
  detail: "d",
  suggestion: "s",
  ...findingEvidence,
  category: "correctness",
  finder,
  ...over,
});
const merge = (reports: Report[]) =>
  mergeReports(reports, (r) => (r.prior ? Number(r.prior.slice(1)) : undefined));
const lines = (out: ReturnType<typeof merge>) => out.candidates.map((c) => [c.line, c.raisedBy]);

test("reports from different finders merge when their windows overlap in the same file and category", () => {
  const out = merge([
    report(0, 10, { failure_scenario: "short" }),
    report(1, 10 + 2 * MERGE_WINDOW, {
      failure_scenario: "empty input -> crash in parse()",
      severity: "major",
    }),
    report(2, 60, { security: true, severity: "nit" }),
  ]);
  expect(lines(out)).toEqual([
    [30, [0, 1]],
    [60, [2]],
  ]);
  // The most concrete scenario wins; severity is the highest reported, agreement the finder count.
  expect(out.candidates[0]).toMatchObject({ title: "finder 1 line 30", severity: "major", agreement: 2 });
  expect(out.candidates[1]).toMatchObject({ agreement: 1, security: true });
  expect(out.merged.map(({ into, report }) => [into, report.title])).toEqual([[0, "finder 0 line 10"]]);
  // A security flag from any finder survives the merge.
  const flagged = merge([report(0, 10), report(1, 12, { security: true })]);
  expect(flagged.candidates).toMatchObject([{ security: true, agreement: 2 }]);
});

test("reports stay apart across files, categories, labels, citations, distant lines, one finder, or no location", () => {
  for (const pair of [
    [report(0, 10), report(1, 11 + 2 * MERGE_WINDOW)],
    [report(0, 10), report(1, 10, { file: "src/b.ts" })],
    [report(0, 10), report(1, 10, { category: "data" })],
    [report(0, 10, { label: "new" }), report(1, 10, { label: "regression" })],
    [
      report(0, 10, { label: "unaddressed", prior: "P1" }),
      report(1, 10, { label: "unaddressed", prior: "P2" }),
    ],
    [report(0, 10), report(0, 12)],
    [report(0, 0, { file: "" }), report(1, 0, { file: "" })],
    [report(0, 0), report(1, 0)],
  ])
    expect(merge(pair).candidates.map((c) => c.agreement)).toEqual([1, 1]);
});

test("a finder joins the first group without a report of its own; ties keep the earliest report", () => {
  const out = merge([report(0, 10), report(0, 14), report(1, 12), report(1, 16), report(2, 50)]);
  expect(lines(out)).toEqual([
    [10, [0, 1]],
    [14, [0, 1]],
    [50, [2]],
  ]);
  expect(out.merged.map(({ into, report }) => [into, report.line])).toEqual([
    [0, 12],
    [1, 16],
  ]);
});
