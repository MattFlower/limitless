import { z } from "zod";
import { parseExcludeOrigins } from "../router/origins.ts";

const fraction = z.number().finite().min(0).max(1);
const floors = z.strictObject({
  triage_pass_rate: fraction.default(0.6),
  implement_pass_rate: fraction.default(0.6),
  triage_risk_under_call_rate: fraction.default(0.1),
  review_defect_recall: fraction.default(0.5),
  review_clean_false_block_rate: fraction.default(0.5),
  verify_false_accept_rate: fraction.default(0.25),
});
const settings = z.strictObject({
  floors: floors.prefault({}),
  delta: fraction.default(0.1),
  subscription_weight: z.number().finite().nonnegative().default(0.25),
});
export function evalSettings(raw: Record<string, unknown>) {
  return {
    ...settings.parse(raw.evals === undefined ? {} : raw.evals),
    excludeOrigins: parseExcludeOrigins(raw),
  };
}
export type EvalSettings = ReturnType<typeof evalSettings>;
