import { z } from "zod";
import { isBranchName } from "../core/delivery.ts";
import { RunTransferError } from "./run-transfer-errors.ts";
import { parseTransferJson } from "./run-transfer-json.ts";
import * as r from "./run-transfer-rows.ts";

const object = z.strictObject;
const text = z.string();
export const transferAgentResultSchema = object({
  status: r.oneOf("running ok error cancelled timeout stuck quota unavailable declined"),
  failureClass: r.oneOf("authentication malformed").optional(),
  finalText: text,
  structured: z.unknown().transform(parseTransferJson),
  usage: object({
    ...r.fields("input output cacheRead cacheWrite", r.counter),
    cacheWrite1h: r.counter.optional(),
  }),
  numTurns: r.counter,
  ...r.fields("costUsd costEquivUsd", z.number().nonnegative()),
  error: text.nullable(),
  decline: object({ reason: text, lastResort: z.boolean() }).optional(),
  ...r.fields("fastModeState fastModeDisabledReason", text.nullable().optional()),
  // Persisted AgentResultReport publication metadata; commits must match the job's typed fields.
  ...r.fields("parentSha sha", r.oid.optional()),
  branch: text.refine(isBranchName).optional(),
});
export const transferAgentJobSchema = object({
  id: r.identity,
  run_id: r.identity.nullable(),
  invocationOrdinal: r.ordinal,
  parent_sha: r.oid,
  state: r.oneOf("queued leased done failed cancelled"),
  attempt: r.counter,
  result_sha: r.oid.nullable(),
  failure_reason: text.nullable(),
  ...r.fields("created_at updated_at", r.counter),
  attempt_deadline_at: r.counter.nullable(),
  result: transferAgentResultSchema.nullable(),
});
export type TransferAgentResult = z.infer<typeof transferAgentResultSchema>;
export type TransferAgentJob = z.infer<typeof transferAgentJobSchema>;
export const parseTransferAgentResult = r.boundary(
  (value: unknown): TransferAgentResult => r.parseRecord(transferAgentResultSchema, value),
);
export const encodeTransferAgentResult = r.boundary(
  (value: unknown): TransferAgentResult =>
    r.transferSource(transferAgentResultSchema, value, [
      "sessionId",
      "quota",
      "modelCooldownMs",
      "confinement",
      "privateStringsDigest",
    ]),
);
// No request, worker, lease or dispatch API exists on this historical record.
export const parseTransferAgentJob = r.boundary(
  (value: unknown, invocations: readonly { ordinal: number; runId: string }[]): TransferAgentJob => {
    const result = r.parseRecord(transferAgentJobSchema, value);
    const matches = invocations.filter(
      (v) => r.parseRecord(r.ordinal, v.ordinal) === result.invocationOrdinal,
    );
    const report = result.result;
    if (
      matches.length !== 1 ||
      (result.run_id !== null && matches[0]?.runId !== result.run_id) ||
      (report?.parentSha !== undefined && report.parentSha !== result.parent_sha) ||
      (report?.sha !== undefined && report.sha !== result.result_sha)
    )
      throw new RunTransferError("invalid");
    return result;
  },
);
const sourceSchema = transferAgentJobSchema.omit({ invocationOrdinal: true, result: true }).extend({
  invocation_id: r.ordinal,
  result: text.nullable(),
});
export const encodeTransferAgentJob = r.boundary(
  (value: unknown, invocations: readonly { id: number; runId: string }[]): TransferAgentJob => {
    const { invocation_id, result, ...job } = r.transferSource(sourceSchema, value, [
      "request",
      "worker",
      "excluded",
      "lease_expires_at",
    ]);
    const ordered = [...invocations].sort((a, b) => a.id - b.id);
    const ids = ordered.map((v) => r.parseRecord(r.ordinal, v.id));
    if (new Set(ids).size !== ids.length) throw new RunTransferError("invalid");
    return parseTransferAgentJob(
      {
        ...job,
        invocationOrdinal: ids.indexOf(invocation_id) + 1,
        result: result === null ? null : encodeTransferAgentResult(JSON.parse(result)),
      },
      ordered.map((v, i) => ({ ordinal: i + 1, runId: v.runId })),
    );
  },
);
export const agentJobCommitDependencies = (value: TransferAgentJob): string[] => [
  value.parent_sha,
  ...(value.result_sha === null ? [] : [value.result_sha]),
];
