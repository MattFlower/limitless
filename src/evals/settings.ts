import { z } from "zod";

const fraction = z.number().finite().min(0).max(1);
const floors = z.strictObject({
  triage_pass_rate: fraction.default(0.6),
  triage_risk_under_call_rate: fraction.default(0.1),
  review_defect_recall: fraction.default(0.5),
  review_clean_false_block_rate: fraction.default(0.34),
  verify_false_accept_rate: fraction.default(0.1),
});
const settings = z.strictObject({
  floors: floors.prefault({}),
  delta: fraction.default(0.1),
  subscription_weight: z.number().finite().nonnegative().default(0.25),
});
export function evalSettings(raw: Record<string, unknown>) {
  const routing = z
    .object({ exclude_origins: z.array(z.string().min(1)).optional() })
    .parse(raw.routing ?? {});
  return {
    ...settings.parse(raw.evals === undefined ? {} : raw.evals),
    excludeOrigins: routing.exclude_origins,
  };
}
export type EvalSettings = ReturnType<typeof evalSettings>;
