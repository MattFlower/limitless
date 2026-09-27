import type { EvalGrade } from "../../core/types.ts";
import type { Review } from "../../pipeline/schemas.ts";
import type { ReviewCase } from "../cases.ts";

export function gradeReview(item: ReviewCase, output: Review): EvalGrade {
  const normalize = (file: string) => file.replace(/^(\.\/)+/, "");
  const required = item.defects.filter((defect) => defect.required);
  const matched = required.filter((defect) =>
    output.findings.some(
      (finding) =>
        ["blocker", "major", "minor"].includes(finding.severity) &&
        normalize(finding.file) === normalize(defect.file) &&
        (finding.line === 0
          ? defect.category === "completeness"
          : finding.line > 0 && finding.line >= defect.lines[0] - 5 && finding.line <= defect.lines[1] + 5),
    ),
  ).length;
  const requestChanges = output.verdict === "request_changes";
  const falseBlock =
    item.kind === "clean"
      ? requestChanges || output.findings.some((f) => f.severity === "blocker" || f.severity === "major")
      : null;
  const pass = item.kind === "clean" ? !falseBlock : matched === required.length && requestChanges;
  return {
    pass,
    score: item.kind === "clean" ? Number(pass) : required.length ? matched / required.length : null,
    fields: {},
    riskUnderCall: null,
    review: {
      requiredMatched: matched,
      requiredTotal: required.length,
      recall: required.length ? matched / required.length : null,
      requestChanges,
      falseBlock,
      verdictMatch: requestChanges === (item.kind !== "clean"),
    },
  };
}
