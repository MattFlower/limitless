import { expect, test } from "bun:test";
import { claimSimilarity, MERGE_RULES, mergeReports } from "../src/pipeline/panel-merge.ts";
import type { Review } from "../src/pipeline/schemas.ts";
import { findingEvidence } from "./review-support.ts";

type Report = Review["findings"][number] & { finder: number };
const claim = "Missing null check in parseHeader crashes on empty input";
const report = (finder: number, line: number, over: Partial<Report> = {}): Report => ({
  severity: "minor",
  security: false,
  file: "src/a.ts",
  line,
  title: claim,
  detail: `finder ${finder}`,
  suggestion: "s",
  ...findingEvidence,
  failure_scenario: "",
  category: "correctness",
  finder,
  ...over,
});
const merge = (reports: Report[]) =>
  mergeReports(reports, (r) => (r.prior ? Number(r.prior.slice(1)) : undefined));
const shape = (reports: Report[]) =>
  merge(reports)
    .map((c) => [c.line, c.raisedBy, c.duplicates.map((d) => d.line)])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test("reports of the same claim from different finders merge, carrying every report", () => {
  const [candidate, ...rest] = merge([
    report(0, 10, { severity: "nit" }),
    report(1, 12, { failure_scenario: "an empty header -> TypeError in parseHeader", severity: "major" }),
  ]);
  expect(rest).toEqual([]);
  // The most concrete report is kept, with the highest severity; the other rides along.
  expect(candidate).toMatchObject({ line: 12, severity: "major", agreement: 2, raisedBy: [0, 1] });
  expect(candidate?.duplicates).toEqual([
    { finder: 0, line: 10, title: claim, detail: "finder 0", suggestion: "s", failure_scenario: "" },
  ]);
});

test("nearby reports of different claims stay apart, as do different flags, labels, citations and lines", () => {
  for (const pair of [
    [report(0, 10), report(1, 25, { title: "Path traversal via unsanitized filename" })],
    [report(0, 10), report(1, 10, { security: true })],
    [report(0, 10), report(1, 11 + 2 * MERGE_RULES.window)],
    [report(0, 10), report(1, 10, { file: "src/b.ts" })],
    [report(0, 10), report(1, 10, { category: "data" })],
    [report(0, 10, { label: "new" }), report(1, 10, { label: "regression" })],
    [
      report(0, 10, { label: "unaddressed", prior: "P1" }),
      report(1, 10, { label: "unaddressed", prior: "P2" }),
    ],
    [report(0, 10), report(0, 12)],
    [report(0, 0, { file: "" }), report(1, 0, { file: "" })],
  ])
    expect(merge(pair).map((c) => c.agreement)).toEqual([1, 1]);
});

test(`claims are similar at a token Jaccard of ${MERGE_RULES.similarity} or more`, () => {
  const words = "alpha bravo charlie delta echo foxtrot golf";
  const at = (extra: string) => report(1, 10, { title: `${words} ${extra}` });
  // 7 shared of 10 tokens is 0.7; of 11 it is below. Short words don't count.
  expect(claimSimilarity(report(0, 10, { title: words }), at("hotel india juliet"))).toBe(0.7);
  expect(merge([report(0, 10, { title: `${words} of a` }), at("hotel india juliet")])).toHaveLength(1);
  expect(merge([report(0, 10, { title: words }), at("hotel india juliet kilo")])).toHaveLength(2);
});

test("groups never chain, and neither finder nor report order changes them", () => {
  // 10 and 30, and 30 and 50, overlap; 10 and 50 don't, so 50 stays apart.
  const reports = [report(0, 10), report(1, 30), report(2, 50)];
  const expected = [
    [10, [0, 1], [30]],
    [50, [2], []],
  ];
  const permutations = (items: Report[]): Report[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, i) =>
          permutations(items.filter((_, j) => j !== i)).map((rest) => [item, ...rest]),
        );
  for (const order of permutations(reports)) expect(shape(order)).toEqual(expected);
  // Renumbering the finders doesn't change the grouping either.
  const renumbered = reports.map((r) => ({ ...r, finder: 2 - r.finder }));
  expect(shape(renumbered).map(([line]) => line)).toEqual([10, 50]);
});

test("exact ties within one finder keep report order", () => {
  const out = merge([report(0, 10, { detail: "first" }), report(0, 10, { detail: "second" }), report(1, 10)]);
  expect(out.map((c) => [c.detail, c.agreement])).toEqual([
    ["first", 2],
    ["second", 1],
  ]);
});

test("candidates keep the order of their first report", () => {
  const out = merge([report(0, 60, { title: "Other claim entirely here" }), report(0, 10), report(1, 11)]);
  expect(out.map((c) => [c.line, c.agreement])).toEqual([
    [60, 1],
    [10, 2],
  ]);
});
