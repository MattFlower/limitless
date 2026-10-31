import { z } from "zod";
import { RunTransferError } from "./run-transfer-errors.ts";
import * as g from "./run-transfer-gates.ts";
import * as r from "./run-transfer-rows.ts";

const object = z.strictObject;
const text = z.string();
const comparisons = z.array(g.transferGateComparisonSchema);
const gateEvidence = object({
  stageOrdinal: r.ordinal,
  sha: r.oid,
  baseSha: r.oid.optional(),
  changedFiles: z.array(text).optional(),
  checks: z.array(g.transferGateComparisonSchema.extend({ testCommand: text.nullable() })),
});
// Covering requests refused before stage allocation retain the local no-stage sentinel.
const coveringStage = z.union([z.literal(0), r.ordinal]);
const coveringRun = object({
  file: text,
  name: text,
  verifiedSha: r.oid,
  round: r.counter,
  stageOrdinal: coveringStage,
  result: g.transferGateResultSchema.optional(),
  ...r.fields("command reason", text.optional()),
});
// Private historical evidence only: no reusable baseline or execution authority.
export const transferEvidenceSchema = object({
  lastGates: comparisons.optional(),
  gateEvidence: gateEvidence.optional(),
  coveringTestRuns: z.array(coveringRun).optional(),
  preRebaseGates: comparisons.optional(),
  postMergeGates: object({
    ...r.fields("sha base head", r.oid),
    ...r.fields("round deadline", r.counter),
    result: object({
      setupOk: z.boolean(),
      timedOut: z.boolean(),
      comparison: comparisons,
      workers: g.transferDictionary(text.nullable()).optional(),
    }).optional(),
  }).optional(),
});
export type TransferEvidence = z.infer<typeof transferEvidenceSchema>;
const localSchema = transferEvidenceSchema.extend({
  gateEvidence: gateEvidence.omit({ stageOrdinal: true }).extend({ stageId: r.ordinal }).optional(),
  coveringTestRuns: z
    .array(coveringRun.omit({ stageOrdinal: true }).extend({ stageId: coveringStage }))
    .optional(),
});
export const parseTransferEvidence = r.boundary(
  (value: unknown, stages: readonly { ordinal: number }[]): TransferEvidence => {
    const result = r.parseRecord(transferEvidenceSchema, value);
    const ordinals = new Set(stages.map((s) => r.parseRecord(r.ordinal, s.ordinal)));
    for (const record of [result.gateEvidence, ...(result.coveringTestRuns ?? [])])
      if (record && record.stageOrdinal !== 0 && !ordinals.has(record.stageOrdinal))
        throw new RunTransferError("invalid");
    return result;
  },
);
export const encodeTransferEvidence = r.boundary((value: unknown, stages: readonly { id: number }[]) => {
  const local = r.parseRecord(localSchema, value);
  const ids = stages.map((s) => r.parseRecord(r.ordinal, s.id)).sort((a, b) => a - b);
  if (new Set(ids).size !== ids.length) throw new RunTransferError("invalid");
  const reference = <T extends { stageId: number }>({ stageId, ...record }: T) => {
    if (stageId === 0) return { ...record, stageOrdinal: 0 };
    const ordinal = ids.indexOf(stageId) + 1;
    if (!ordinal) throw new RunTransferError("invalid");
    return { ...record, stageOrdinal: ordinal };
  };
  return parseTransferEvidence(
    {
      ...local,
      ...(local.gateEvidence ? { gateEvidence: reference(local.gateEvidence) } : {}),
      ...(local.coveringTestRuns ? { coveringTestRuns: local.coveringTestRuns.map(reference) } : {}),
    },
    ids.map((_, i) => ({ ordinal: i + 1 })),
  );
});
export const evidenceCommitMembers = [
  "gateEvidence.sha",
  "gateEvidence.baseSha",
  "coveringTestRuns[].verifiedSha",
  "postMergeGates.sha",
  "postMergeGates.base",
  "postMergeGates.head",
] as const;
export function evidenceCommitDependencies(value: TransferEvidence): string[] {
  return [
    ...[
      value.gateEvidence?.sha,
      value.gateEvidence?.baseSha,
      value.postMergeGates?.sha,
      value.postMergeGates?.base,
      value.postMergeGates?.head,
    ].filter((v): v is string => v !== undefined),
    ...(value.coveringTestRuns ?? []).flatMap((v) => [
      v.verifiedSha,
      ...(v.result ? g.gateResultCommitDependencies(v.result) : []),
    ]),
    ...[
      ...(value.lastGates ?? []),
      ...(value.gateEvidence?.checks ?? []),
      ...(value.preRebaseGates ?? []),
      ...(value.postMergeGates?.result?.comparison ?? []),
    ].flatMap(g.gateComparisonCommitDependencies),
  ];
}
