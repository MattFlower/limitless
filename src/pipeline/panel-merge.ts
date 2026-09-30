import type { Review } from "./schemas.ts";

type Finding = Review["findings"][number];
type Report = Finding & { finder: number };
type Duplicate = NonNullable<Finding["duplicates"]>[number];

/**
 * Merge rules, part of the panel cache identity: bump `version` when the algorithm changes. Reports
 * merge only when they make the same claim: lines within each other's ±`window` and a token Jaccard
 * similarity of at least `similarity` on title plus failure scenario. The threshold is conservative:
 * a missed merge costs one more verification, while a wrong one could hide a claim behind a refuted one.
 */
export const MERGE_RULES = { version: 2, window: 10, similarity: 0.7 };

/** Lowercase words of three or more characters; dotted identifiers such as user.email stay whole. */
function tokens(report: Finding): Set<string> {
  const text = `${report.title} ${report.failure_scenario ?? ""}`.toLowerCase();
  return new Set((text.match(/[a-z0-9_]+(?:\.[a-z0-9_]+)*/g) ?? []).filter((t) => t.length >= 3));
}

/** Token Jaccard similarity of two reports' titles and failure scenarios. */
export function claimSimilarity(a: Finding, b: Finding): number {
  const [x, y] = [tokens(a), tokens(b)];
  const shared = [...x].filter((t) => y.has(t)).length;
  const union = x.size + y.size - shared;
  return union ? shared / union : 0;
}

const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Deterministic merge of finder reports before verification; no model is involved. Two reports make
 * the same claim when different finders give the same file, category, label, citation and security
 * flag, lines within each other's windows and similar wording (`MERGE_RULES`). Every pair in a group
 * must make the same claim, and grouping runs in a canonical order, so neither chains nor finder or
 * report order change which reports merge. A candidate keeps the report with the most concrete
 * (longest) failure scenario and the highest finder severity; the other reports ride along as
 * `duplicates`, so none is lost. Candidates keep the order of their first report.
 */
export function mergeReports<T extends Report>(
  reports: T[],
  citation: (report: T) => number | undefined,
): (T & { agreement: number; raisedBy: number[]; duplicates: Duplicate[] })[] {
  const sameClaim = (a: T, b: T) =>
    a.finder !== b.finder &&
    a.file !== "" &&
    a.file === b.file &&
    a.line > 0 &&
    b.line > 0 &&
    Math.abs(a.line - b.line) <= 2 * MERGE_RULES.window &&
    a.category === b.category &&
    a.label === b.label &&
    a.security === b.security &&
    citation(a) === citation(b) &&
    claimSimilarity(a, b) >= MERGE_RULES.similarity;
  const canonical = [...reports].sort(
    (a, b) =>
      order(a.file, b.file) ||
      a.line - b.line ||
      order(a.title, b.title) ||
      order(a.failure_scenario ?? "", b.failure_scenario ?? "") ||
      a.finder - b.finder ||
      reports.indexOf(a) - reports.indexOf(b),
  );
  const groups: T[][] = [];
  for (const report of canonical) {
    const group = groups.find((g) => g.every((member) => sameClaim(member, report)));
    if (group) group.push(report);
    else groups.push([report]);
  }
  const first = (group: T[]) => Math.min(...group.map((r) => reports.indexOf(r)));
  const concreteness = (r: T) => r.failure_scenario?.trim().length ?? 0;
  const rank = { blocker: 0, major: 1, minor: 2, nit: 3 } as const;
  return groups
    .sort((g, h) => first(g) - first(h))
    .map((group) => {
      // Ties keep the canonical first.
      const kept = group.reduce((best, r) => (concreteness(r) > concreteness(best) ? r : best));
      const severity = group.reduce((most, r) =>
        rank[r.severity] < rank[most.severity] ? r : most,
      ).severity;
      return {
        ...kept,
        severity,
        agreement: group.length,
        raisedBy: group.map((r) => r.finder).sort((a, b) => a - b),
        duplicates: group
          .filter((r) => r !== kept)
          .map(
            ({
              finder,
              line,
              title,
              detail,
              suggestion,
              severity,
              failure_scenario,
              confidence,
              introduced_by_diff,
            }) => ({
              finder,
              line,
              title,
              detail,
              suggestion,
              severity,
              ...(failure_scenario === undefined ? {} : { failure_scenario }),
              ...(confidence === undefined ? {} : { confidence }),
              ...(introduced_by_diff === undefined ? {} : { introduced_by_diff }),
            }),
          ),
      };
    });
}
