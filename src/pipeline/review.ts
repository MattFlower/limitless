import type { Review } from "./schemas.ts";

export function blockingReviewFindings(review: Review, later: boolean): Review["findings"] {
  return review.findings.filter((finding) =>
    !later
      ? finding.severity === "blocker" || finding.severity === "major"
      : finding.label === "unaddressed" ||
        finding.label === "regression" ||
        (finding.label === "new" && (finding.severity === "blocker" || finding.security === true)),
  );
}

export function reviewVerdict(review: Review, later: boolean): Review["verdict"] {
  return blockingReviewFindings(review, later).length ? "request_changes" : "approve";
}
