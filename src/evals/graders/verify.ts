import type { EvalGrade } from "../../core/types.ts";
import type { Verify } from "../../pipeline/schemas.ts";
import type { VerifyCase } from "../cases.ts";

export function gradeVerify(item: VerifyCase, output: Verify): EvalGrade {
  const criteria: NonNullable<EvalGrade["verify"]>["criteria"] = {};
  for (const [id, gold] of Object.entries(item.gold)) {
    const predictions = output.criteria.filter((c) => c.id === id).map((c) => c.status);
    const predicted = predictions.length > 1 ? "duplicate" : (predictions[0] ?? "missing");
    criteria[id] = {
      gold,
      predictions,
      predicted,
      match: predicted === gold,
      falseAccept: gold === "unmet" && predicted === "met",
      falseReject: gold === "met" && predicted !== "met",
    };
  }
  const rows = Object.values(criteria);
  const matched = rows.filter((c) => c.match).length;
  return {
    pass: matched === rows.length,
    score: matched / rows.length,
    fields: {},
    riskUnderCall: null,
    verify: {
      matched,
      total: rows.length,
      criteria,
      falseAccepts: rows.filter((c) => c.falseAccept).length,
      unmetTotal: rows.filter((c) => c.gold === "unmet").length,
      falseRejects: rows.filter((c) => c.falseReject).length,
      metTotal: rows.filter((c) => c.gold === "met").length,
    },
  };
}
