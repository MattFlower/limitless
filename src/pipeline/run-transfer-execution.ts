import { z } from "zod";
import { RunTransferError } from "./run-transfer-errors.ts";
import * as g from "./run-transfer-gates.ts";
import * as r from "./run-transfer-rows.ts";

const object = z.strictObject;
const text = z.string();
const inputs = object({ sha: r.oid, ...r.fields("candidate setup checks setup_minutes", text) });
export const transferActionsProgressSchema = object({
  repo: text.regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/),
  ...r.fields("candidate dispatch", r.identity),
  headSha: r.oid,
  dispatchSha: r.oid.optional(),
  ...r.fields("pushed dispatchIntent dispatchSent cleanupFailed", z.boolean().optional()),
  cleanupRunIds: z.array(r.ordinal).optional(),
  ...r.fields("visibilityDeadline deadline nextPollAt", r.counter.optional()),
  runId: r.ordinal.optional(),
  completed: g.transferGateRunSchema.optional(),
  owner: r.identity.optional(),
  ...r.fields("gateKey interrupted diagnostic", text.optional()),
  inputs: inputs.optional(),
});
// Historical identity is deliberately separate from ExecutionHandle and attach authority.
export const transferExecutionSchema = object({
  stage: r.oneOf(
    "prepare triage clarify spec plan holdout implement gates audit review preview verify accept deliver",
  ),
  round: r.counter,
  purpose: text,
  sha: r.oid,
  gateKey: text.optional(),
  identity: object({
    executorKind: r.oneOf("local github-actions"),
    id: r.identity,
    startedAt: r.counter,
    url: text.optional(),
  }),
  githubActions: transferActionsProgressSchema.optional(),
  previous: z.array(object({ purpose: text, gateKey: text, result: g.transferGateRunSchema })).optional(),
});
export type TransferExecution = z.infer<typeof transferExecutionSchema>;
export type TransferActionsProgress = z.infer<typeof transferActionsProgressSchema>;
function compatible(value: TransferExecution, code: "invalid" | "unsupported") {
  const { identity, githubActions: p } = value;
  if ((identity.executorKind === "github-actions") !== Boolean(p)) throw new RunTransferError(code);
  if (identity.url !== undefined) {
    const match =
      /^https:\/\/github\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/([1-9][0-9]*)$/.exec(
        identity.url,
      );
    if (
      !p ||
      !match ||
      new URL(identity.url).href !== identity.url ||
      match[1]?.toLowerCase() !== p.repo.toLowerCase() ||
      !Number.isSafeInteger(Number(match[2])) ||
      (p.runId !== undefined && String(p.runId) !== match[2])
    )
      throw new RunTransferError(code);
  }
}
export const parseTransferExecution = r.boundary((value: unknown): TransferExecution => {
  const result = r.parseRecord(transferExecutionSchema, value);
  compatible(result, "invalid");
  return result;
});
const handleSchema = object({
  kind: text,
  id: r.identity,
  startedAt: r.counter,
  url: text.optional(),
  githubActions: z.unknown().optional(),
}).transform((handle) => {
  if (handle.kind !== "local" && handle.kind !== "github-actions") throw new RunTransferError("unsupported");
  if ((handle.kind === "github-actions") !== (handle.githubActions !== undefined))
    throw new RunTransferError("unsupported");
  const { githubActions, ...identity } = handle;
  return {
    ...identity,
    ...(githubActions === undefined
      ? {}
      : {
          githubActions: r.transferSource(transferActionsProgressSchema, githubActions, ["cwd"]),
        }),
  };
});
const sourceSchema = transferExecutionSchema
  .omit({ identity: true, githubActions: true })
  .extend({ handle: handleSchema });
export const encodeTransferExecution = r.boundary((value: unknown): TransferExecution => {
  const { handle, ...context } = r.transferSource(sourceSchema, value);
  const { githubActions, kind, ...historical } = handle;
  const result = r.transferSource(transferExecutionSchema, {
    ...context,
    identity: { ...historical, executorKind: kind },
    ...(githubActions === undefined ? {} : { githubActions }),
  });
  compatible(result, "unsupported");
  return result;
});
export const executionCommitDependencies = (value: TransferExecution): string[] => [
  value.sha,
  ...[
    value.githubActions?.headSha,
    value.githubActions?.dispatchSha,
    value.githubActions?.inputs?.sha,
  ].filter((v): v is string => v !== undefined),
  ...(value.githubActions?.completed ? g.gateRunCommitDependencies(value.githubActions.completed) : []),
  ...(value.previous ?? []).flatMap((v) => g.gateRunCommitDependencies(v.result)),
];
