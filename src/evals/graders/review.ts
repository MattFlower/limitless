import type { EvalGrade } from "../../core/types.ts";
import { blockingReviewFindings, reviewVerdict } from "../../pipeline/review.ts";
import type { Review, StoredReview } from "../../pipeline/schemas.ts";
import type { ReviewCase } from "../cases.ts";

export const DEFECT_SEVERITY_GROUP = { blocker: "high", major: "medium", minor: "low", nit: "low" } as const;
const SEVERITY_RANK = { blocker: 0, major: 1, minor: 2, nit: 3 } as const;

type Finding = Review["findings"][number];
type Defect = ReviewCase["defects"][number];

/**
 * Maximum bipartite matching by augmenting paths, so one finding never credits two defects whose
 * windows overlap. Returns the matched defect indexes; a matched defect stays matched, so defects
 * earlier in the list win ties.
 */
function assign(defects: Defect[], findings: Finding[], lands: (f: Finding, d: Defect) => boolean) {
  const owner = new Map<number, number>(); // finding index -> defect index
  const augment = (d: number, seen: Set<number>): boolean =>
    findings.some((finding, f) => {
      const defect = defects[d];
      if (!defect || seen.has(f) || !lands(finding, defect)) return false;
      seen.add(f);
      const current = owner.get(f);
      if (current !== undefined && !augment(current, seen)) return false;
      owner.set(f, d);
      return true;
    });
  for (let d = 0; d < defects.length; d++) augment(d, new Set());
  return new Set(owner.values());
}

/**
 * Grades what production would block in round 1: a required defect is caught only by a blocking
 * finding, and the case verdict is derived from findings exactly as the engine does. The model's
 * verdict is never graded, so stored output without one is still evidence.
 */
export function gradeReview(item: ReviewCase, output: StoredReview): EvalGrade {
  const normalize = (file: string) => file.replace(/^(\.\/)+/, "");
  const blocking = blockingReviewFindings(output);
  const atLine = (line: number, defect: Defect) =>
    line === 0
      ? defect.category === "completeness"
      : line > 0 && line >= defect.lines[0] - 5 && line <= defect.lines[1] + 5;
  const lands = (finding: Finding, defect: Defect) =>
    normalize(finding.file) === normalize(defect.file) &&
    (atLine(finding.line, defect) || (finding.duplicates ?? []).some((d) => atLine(d.line, defect)));
  // Verbatim repeats are one finding. Aliases are alternative locations for that claim, never
  // independent vertices: both blocking credit and under-rated detection have a one-claim limit.
  const distinct = (findings: Finding[]) => [
    ...new Map(findings.map((f) => [JSON.stringify([normalize(f.file), f.line, f.title]), f])).values(),
  ];
  // Most severe first, so an ambiguous assignment credits the defect that matters most.
  const required = item.defects
    .filter((defect) => defect.required)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const caught = assign(required, distinct(blocking), lands);
  const missed = required.filter((_, index) => !caught.has(index));
  const underRated = assign(
    missed,
    distinct(output.findings.filter((f) => !blocking.includes(f))),
    lands,
  ).size;
  const bySeverity = {
    high: { caught: 0, total: 0 },
    medium: { caught: 0, total: 0 },
    low: { caught: 0, total: 0 },
  };
  for (const [index, defect] of required.entries()) {
    const group = bySeverity[DEFECT_SEVERITY_GROUP[defect.severity]];
    group.total++;
    if (caught.has(index)) group.caught++;
  }
  const requestChanges = reviewVerdict(output) === "request_changes";
  const falseBlock = item.kind === "clean" ? requestChanges : null;
  const pass = item.kind === "clean" ? !falseBlock : caught.size === required.length && requestChanges;
  return {
    pass,
    score: item.kind === "clean" ? Number(pass) : required.length ? caught.size / required.length : null,
    fields: {},
    riskUnderCall: null,
    review: {
      requiredMatched: caught.size,
      requiredTotal: required.length,
      recall: required.length ? caught.size / required.length : null,
      underRated,
      blockingFindings: blocking.length,
      bySeverity,
      requestChanges,
      falseBlock,
      verdictMatch: requestChanges === (item.kind !== "clean"),
    },
  };
}
