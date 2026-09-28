import type { Review, StoredReview } from "./schemas.ts";

export function reviewFindingKey(finding: Review["findings"][number]): string {
  // Lines and explanations can change while fixing the same issue.
  return JSON.stringify([finding.file, finding.title]);
}

/** Whether an "unaddressed" finding cites one of the previous blocking findings (P1, P2, ...). */
function citesPriorBlocking(finding: Review["findings"][number], priorBlocking: Review["findings"]): boolean {
  const match = /^P(\d+)$/i.exec(finding.prior?.trim() ?? "");
  const index = match ? Number(match[1]) : 0;
  return index >= 1 && index <= priorBlocking.length;
}

/**
 * First round: blockers and majors block. Later rounds may not move the goalposts: a finding blocks
 * only if it is a regression from the latest changes, an unaddressed previous *blocking* finding
 * (cited by id, so rewording can't lose it and follow-ups can't be promoted), or a new blocker or
 * security issue. Everything else becomes a follow-up.
 */
export function blockingReviewFindings(
  review: StoredReview,
  priorBlocking?: Review["findings"],
): Review["findings"] {
  return review.findings.filter((finding) => {
    if (!priorBlocking) return finding.severity === "blocker" || finding.severity === "major";
    if (finding.label === "regression") return true;
    if (finding.label === "unaddressed" && citesPriorBlocking(finding, priorBlocking)) return true;
    return finding.severity === "blocker" || finding.security;
  });
}

export function reviewVerdict(review: StoredReview, priorBlocking?: Review["findings"]): Review["verdict"] {
  return blockingReviewFindings(review, priorBlocking).length ? "request_changes" : "approve";
}
