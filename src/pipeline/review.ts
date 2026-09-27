import type { Review } from "./schemas.ts";

export function reviewFindingKey(finding: Review["findings"][number]): string {
  // Lines and explanations can change while fixing the same issue.
  return JSON.stringify([finding.file, finding.title]);
}

export function blockingReviewFindings(
  review: Review,
  priorBlocking?: Review["findings"],
): Review["findings"] {
  return review.findings.filter((finding) => {
    if (!priorBlocking) return finding.severity === "blocker" || finding.severity === "major";
    if (finding.label === "regression") return true;
    if (
      finding.label === "unaddressed" &&
      priorBlocking.some((prior) => reviewFindingKey(prior) === reviewFindingKey(finding))
    )
      return true;
    // An unmatched "unaddressed" claim is a new finding, not permission to revive a follow-up.
    return finding.severity === "blocker" || finding.security;
  });
}

export function reviewVerdict(review: Review, priorBlocking?: Review["findings"]): Review["verdict"] {
  return blockingReviewFindings(review, priorBlocking).length ? "request_changes" : "approve";
}
