import { z } from "zod";
import { RunTransferError } from "./run-transfer-errors.ts";
import * as g from "./run-transfer-gates.ts";
import * as r from "./run-transfer-rows.ts";
import * as s from "./schemas.ts";

const object = z.strictObject,
  text = z.string();
// Validate stored model bodies without applying defaults, trims, catches or clamps.
export const storedInput = <S extends z.ZodType>(schema: S) =>
  z.custom<z.input<S>>((v) => schema.safeParse(v).success);
const finding = s.StoredReviewSchema.shape.findings.element.extend({
  label: r.oneOf("unaddressed regression new").optional(),
  prior: text.optional(),
});
export const transferReviewSchema = storedInput(
  object({ ...s.StoredReviewSchema.shape, findings: z.array(finding), modelId: text.optional() }).refine(
    (v) => v.findings.length > 0 || v.summary.trim().length >= s.MIN_LATER_REVIEW_SUMMARY,
  ),
);
export const transferAuditSchema = z.array(
  object({ rule: text, severity: r.oneOf("block warn"), file: text.optional(), detail: text }),
);
const rangeCommits = (value: string) => {
  const parts = value.split(/\.{2,3}/);
  if (parts.length !== 2) throw new RunTransferError("invalid");
  return parts.map((v) => r.parseRecord(r.oid, v));
};
const history = z.array(
  object({
    round: r.counter,
    sha: r.oid,
    ...r.fields("blocking followUps", storedInput(z.array(finding))),
    panelReview: r.counter.optional(),
    scope: object({
      kind: r.oneOf("full fix resolution"),
      range: text.refine((v) => rangeCommits(v).length === 2),
    }).optional(),
  }),
);
const binding = object({ stageOrdinal: r.ordinal, sha: r.oid, check: text, command: text });
function outcomesSchema(reference: z.ZodType<z.infer<typeof binding>>) {
  const criterion = storedInput(
    s.VerifySchema.shape.criteria.element.extend({ gateEvidence: z.unknown().optional() }),
  ).transform(({ gateEvidence, ...v }) => ({
    ...v,
    ...(gateEvidence === undefined ? {} : { gateEvidence: r.parseRecord(reference, gateEvidence) }),
  }));
  const model = object({ ...s.VerifySchema.shape, criteria: z.array(criterion) });
  const verify = model.extend({
    modelId: text,
    ...r.fields("round attempt", r.counter.optional()),
    sha: r.oid.optional(),
    modelOutput: model.optional(),
    browserContext: r.oneOf("available unavailable no_preview").optional(),
  });
  const saved = object({
    lastVerify: verify.nullable().optional(),
    lastGates: z.array(g.transferGateComparisonSchema).optional(),
    lastReview: transferReviewSchema.and(z.object({ modelId: text })).optional(),
    lastAudit: transferAuditSchema.optional(),
    reviewHistory: history.optional(),
  });
  return saved.omit({ lastGates: true }).extend({
    triage: storedInput(s.TriageSchema).optional(),
    spec: storedInput(s.SpecSchema).nullable().optional(),
    ...r.fields("specAuthorVendor holdoutModelId", text.optional()),
    holdout: storedInput(s.HoldoutSchema).optional(),
    holdoutStatus: r.oneOf("generating complete").optional(),
    holdoutSameVendor: z.boolean().optional(),
    reviewFollowUps: storedInput(z.array(finding)).optional(),
    lastVerifiedEvidence: saved.optional(),
    pendingVerify: object({
      ...r.fields("round attempt", r.counter),
      sha: r.oid,
      modelOutput: model,
      modelId: text,
      browserContext: verify.shape.browserContext,
    }).optional(),
    verifyResults: z.array(verify.extend({ round: r.counter, modelId: text })).optional(),
  });
}
export const transferOutcomesSchema = outcomesSchema(binding);
export type TransferOutcomes = z.infer<typeof transferOutcomesSchema>;
export const parseTransferOutcomes = r.boundary(
  (value: unknown, stages: readonly { ordinal: number }[]): TransferOutcomes => {
    const ordinals = new Set(stages.map((s) => r.parseRecord(r.ordinal, s.ordinal)));
    return r.parseRecord(outcomesSchema(binding.refine((v) => ordinals.has(v.stageOrdinal))), value);
  },
);
export const encodeTransferOutcomes = r.boundary(
  (value: unknown, stages: readonly { id: number }[]): TransferOutcomes => {
    const ids = stages.map((s) => r.parseRecord(r.ordinal, s.id)).sort((a, b) => a - b);
    if (new Set(ids).size !== ids.length) throw new RunTransferError("invalid");
    const local = binding
      .omit({ stageOrdinal: true })
      .extend({ stageId: r.ordinal })
      .transform(({ stageId, ...v }) => {
        const stageOrdinal = ids.indexOf(stageId) + 1;
        if (!stageOrdinal) throw new RunTransferError("invalid");
        return { ...v, stageOrdinal };
      });
    return r.parseRecord(outcomesSchema(local), value);
  },
);
const savedCommitMembers = [
  "reviewHistory[].sha",
  "reviewHistory[].scope.range",
  "lastVerify.sha",
  "lastVerify.criteria[].gateEvidence.sha",
  "lastVerify.modelOutput.criteria[].gateEvidence.sha",
] as const;
export const outcomesCommitMembers = [
  ...savedCommitMembers,
  ...savedCommitMembers.map((v) => `lastVerifiedEvidence.${v}` as const),
  "pendingVerify.sha",
  "pendingVerify.modelOutput.criteria[].gateEvidence.sha",
  "verifyResults[].sha",
  "verifyResults[].criteria[].gateEvidence.sha",
  "verifyResults[].modelOutput.criteria[].gateEvidence.sha",
] as const;
export const outcomesCommitDependencies = r.boundary((value: TransferOutcomes): string[] => {
  const verify = (v: Partial<NonNullable<TransferOutcomes["lastVerify"]>> | null | undefined): string[] =>
    [
      v?.sha,
      ...[...(v?.criteria ?? []), ...(v?.modelOutput?.criteria ?? [])].map((c) => c.gateEvidence?.sha),
    ].filter((v): v is string => v !== undefined);
  const saved = (v: NonNullable<TransferOutcomes["lastVerifiedEvidence"]>) => [
    ...(v.reviewHistory ?? []).flatMap((h) => [h.sha, ...(h.scope ? rangeCommits(h.scope.range) : [])]),
    ...verify(v.lastVerify),
    ...(v.lastGates ?? []).flatMap(g.gateComparisonCommitDependencies),
  ];
  return [
    ...saved(value),
    ...(value.lastVerifiedEvidence ? saved(value.lastVerifiedEvidence) : []),
    ...(value.pendingVerify ? [value.pendingVerify.sha, ...verify(value.pendingVerify.modelOutput)] : []),
    ...(value.verifyResults ?? []).flatMap(verify),
  ];
});
