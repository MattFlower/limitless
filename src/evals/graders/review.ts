import type { EvalGrade } from "../../core/types.ts";
import { blockingReviewFindings, reviewVerdict } from "../../pipeline/review.ts";
import type { Review } from "../../pipeline/schemas.ts";
import type { ReviewCase } from "../cases.ts";

export const DEFECT_SEVERITY_GROUP = { blocker: "high", major: "medium", minor: "low", nit: "low" } as const;

/**
 * Grades what production would block in round 1: a required defect is caught only by a blocking
 * finding, and the case verdict is derived from findings exactly as the engine does.
 */
export function gradeReview(item: ReviewCase, output: Review): EvalGrade {
  const normalize = (file: string) => file.replace(/^(\.\/)+/, "");
  const blocking = blockingReviewFindings(output);
  const lands = (finding: Review["findings"][number], defect: ReviewCase["defects"][number]) =>
    normalize(finding.file) === normalize(defect.file) &&
    (finding.line === 0
      ? defect.category === "completeness"
      : finding.line > 0 && finding.line >= defect.lines[0] - 5 && finding.line <= defect.lines[1] + 5);
  const required = item.defects.filter((defect) => defect.required);
  const bySeverity = {
    high: { caught: 0, total: 0 },
    medium: { caught: 0, total: 0 },
    low: { caught: 0, total: 0 },
  };
  let caught = 0;
  let underRated = 0;
  for (const defect of required) {
    const group = bySeverity[DEFECT_SEVERITY_GROUP[defect.severity]];
    group.total++;
    if (blocking.some((finding) => lands(finding, defect))) {
      caught++;
      group.caught++;
    } else if (output.findings.some((finding) => lands(finding, defect))) underRated++;
  }
  const requestChanges = reviewVerdict(output) === "request_changes";
  const falseBlock = item.kind === "clean" ? requestChanges : null;
  const pass = item.kind === "clean" ? !falseBlock : caught === required.length && requestChanges;
  return {
    pass,
    score: item.kind === "clean" ? Number(pass) : required.length ? caught / required.length : null,
    fields: {},
    riskUnderCall: null,
    review: {
      requiredMatched: caught,
      requiredTotal: required.length,
      recall: required.length ? caught / required.length : null,
      underRated,
      blockingFindings: blocking.length,
      bySeverity,
      requestChanges,
      falseBlock,
      verdictMatch: requestChanges === (item.kind !== "clean"),
    },
  };
}
