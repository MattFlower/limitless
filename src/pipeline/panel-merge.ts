import type { Review } from "./schemas.ts";

type Finding = Review["findings"][number];
type Report = Finding & { finder: number };

/** Lines on each side of a report; two reports merge when their windows overlap. */
export const MERGE_WINDOW = 10;
const SEVERITY_RANK = { blocker: 0, major: 1, minor: 2, nit: 3 } as const;

/**
 * Deterministic merge of finder reports before verification; no model is involved. Reports from
 * different finders merge when they name the same file and category, their ±MERGE_WINDOW line
 * windows overlap, and they carry the same label and citation, so a merge never changes which rule
 * applies. A finder's own reports never merge (they are separate claims), nor do reports without a
 * file and line. A merged candidate keeps the report with the most concrete (longest) failure
 * scenario, the highest finder severity and any finder's security flag; `raisedBy` lists its finders
 * and `agreement` counts them.
 */
export function mergeReports<T extends Report>(
  reports: T[],
  citation: (report: T) => number | undefined,
): {
  candidates: (T & { agreement: number; raisedBy: number[] })[];
  /** Every report folded into another one, with the index of the candidate it joined. */
  merged: { into: number; report: T }[];
} {
  const sameClaim = (a: T, b: T) =>
    a.file === b.file && a.category === b.category && a.label === b.label && citation(a) === citation(b);
  const groups: T[][] = [];
  for (const report of reports) {
    const group =
      report.file && report.line > 0
        ? groups.find(
            (g) =>
              g[0] !== undefined &&
              sameClaim(g[0], report) &&
              g.every((m) => m.finder !== report.finder) &&
              g.some((m) => m.line > 0 && Math.abs(m.line - report.line) <= 2 * MERGE_WINDOW),
          )
        : undefined;
    if (group) group.push(report);
    else groups.push([report]);
  }
  const concreteness = (r: T) => r.failure_scenario?.trim().length ?? 0;
  const candidates: (T & { agreement: number; raisedBy: number[] })[] = [];
  const merged: { into: number; report: T }[] = [];
  for (const [into, group] of groups.entries()) {
    // Ties keep the earliest report.
    const kept = group.reduce((best, r) => (concreteness(r) > concreteness(best) ? r : best));
    const severity = group.reduce((most, r) =>
      SEVERITY_RANK[r.severity] < SEVERITY_RANK[most.severity] ? r : most,
    ).severity;
    candidates.push({
      ...kept,
      severity,
      security: group.some((r) => r.security),
      agreement: group.length,
      raisedBy: group.map((r) => r.finder),
    });
    for (const report of group) if (report !== kept) merged.push({ into, report });
  }
  return { candidates, merged };
}
