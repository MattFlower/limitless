import type { EvalGrade } from "../../core/types.ts";
import type { Triage } from "../../pipeline/schemas.ts";
import type { TriageCase } from "../cases.ts";

export function gradeTriage(item: TriageCase, output: Triage): EvalGrade {
  const fields: EvalGrade["fields"] = {};
  let total = 0;
  let matched = 0;
  const predicted = { ...output, needs_questions: output.blocking_questions.length > 0 };
  for (const key of Object.keys(item.gold) as (keyof TriageCase["gold"])[]) {
    const gold = item.gold[key];
    if (gold === null) continue;
    const accepted: (string | boolean)[] = Array.isArray(gold) ? gold : [gold];
    const weight = key === "risk" ? 2 : 1;
    const match = accepted.includes(predicted[key]);
    fields[key] = { predicted: predicted[key], accepted, match, weight };
    total += weight;
    if (match) matched += weight;
  }
  const ranks: Record<string, number> = { low: 0, medium: 1, high: 2 };
  const risk = fields.risk;
  return {
    pass: total ? matched === total : null,
    score: total ? matched / total : null,
    fields,
    riskUnderCall: risk
      ? (ranks[output.risk] ?? 0) < Math.min(...risk.accepted.map((r) => ranks[String(r)] ?? 0))
      : null,
  };
}
