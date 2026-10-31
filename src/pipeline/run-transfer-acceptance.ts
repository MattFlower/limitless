import { z } from "zod";
import { RunTransferError } from "./run-transfer-errors.ts";
import * as g from "./run-transfer-gates.ts";
import { storedInput, transferAuditSchema, transferReviewSchema } from "./run-transfer-outcomes.ts";
import * as r from "./run-transfer-rows.ts";
import { AcceptanceSchema } from "./schemas.ts";

const object = z.strictObject,
  text = z.string(),
  strings = z.array(text);
const actor = object({ login: text }).nullable();
const issue = object({
  number: r.ordinal,
  body: text,
  author: actor,
  editor: actor.optional(),
  lastEditedAt: text.nullable().optional(),
  userContentEdits: object({
    nodes: z.array(object({ editor: actor })).max(100),
    pageInfo: object({ hasNextPage: z.boolean() }),
  }).optional(),
});
const acceptance = object({
  snapshot: object({ ticket: issue, parent: issue }),
  sha: r.oid.optional(),
  manifest: z
    .array(object({ id: text, text, class: r.oneOf("behaviour docs"), sources: strings }))
    .optional(),
  setupDone: z.boolean().optional(),
  output: storedInput(AcceptanceSchema).optional(),
  outcome: object({
    sha: r.oid,
    units: z.array(
      object({
        unit: text,
        verdict: r.oneOf("met partly_met unmet regressed manual not_assessed"),
        ...r.fields("citations refusals", strings),
        note: text.optional(),
      }),
    ),
    summary: text,
    passed: z.boolean(),
  }).optional(),
});
export const transferAcceptanceSchema = object({ acceptance: acceptance.optional() });
export type TransferAcceptance = z.infer<typeof transferAcceptanceSchema>;
export const parseTransferAcceptance = r.boundary(
  (value: unknown): TransferAcceptance => r.parseRecord(transferAcceptanceSchema, value),
);
export const acceptanceCommitMembers = ["acceptance.sha", "acceptance.outcome.sha"] as const;
export const acceptanceCommitDependencies = r.boundary((value: TransferAcceptance): string[] =>
  [value.acceptance?.sha, value.acceptance?.outcome?.sha].filter((v): v is string => v !== undefined),
);

const values = object({
  gates: z.array(g.transferGateComparisonSchema).optional(),
  audit: transferAuditSchema.optional(),
  review: transferReviewSchema.optional(),
});
const checkedValues = g.transferDictionary(z.unknown()).transform((v) => {
  if (Object.keys(v).some((k) => !Object.hasOwn(values.shape, k))) throw new RunTransferError("unsupported");
  return r.parseRecord(values, v);
});
export const transferCompletedChecksSchema = object({
  completedChecks: object({ round: r.counter, sha: r.oid.optional(), values: checkedValues }).optional(),
});
export type TransferCompletedChecks = z.infer<typeof transferCompletedChecksSchema>;
export const parseTransferCompletedChecks = r.boundary(
  (value: unknown): TransferCompletedChecks => r.parseRecord(transferCompletedChecksSchema, value),
);
export const completedChecksCommitMembers = ["completedChecks.sha"] as const;
export const completedChecksCommitDependencies = r.boundary((value: TransferCompletedChecks): string[] => [
  ...(value.completedChecks?.sha ? [value.completedChecks.sha] : []),
  ...(value.completedChecks?.values.gates ?? []).flatMap(g.gateComparisonCommitDependencies),
]);
