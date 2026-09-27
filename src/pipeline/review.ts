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
    // Fail closed on unmatched "unaddressed" claims: rewording must not approve an unresolved issue.
    if (finding.label === "unaddressed" || finding.label === "regression") return true;
    return finding.severity === "blocker" || finding.security;
  });
}

export function reviewVerdict(review: Review, priorBlocking?: Review["findings"]): Review["verdict"] {
  return blockingReviewFindings(review, priorBlocking).length ? "request_changes" : "approve";
}
