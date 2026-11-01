import { z } from "zod";
import type { RunState } from "./context.ts";
import type { PortableManifest } from "./portable.ts";
import * as a from "./run-transfer-acceptance.ts";
import * as c from "./run-transfer-control.ts";
import { RunTransferError } from "./run-transfer-errors.ts";
import * as e from "./run-transfer-evidence.ts";
import * as x from "./run-transfer-execution.ts";
import * as f from "./run-transfer-followups.ts";
import * as j from "./run-transfer-jobs.ts";
import * as o from "./run-transfer-outcomes.ts";
import { parseTransferPolicy } from "./run-transfer-policy-equality.ts";
import * as p from "./run-transfer-policy-schema.ts";
import { payloadCommitDependencies, validatePayloadReferences } from "./run-transfer-references.ts";
import type { TransferRepository as Repo } from "./run-transfer-rows.ts";
import * as r from "./run-transfer-rows.ts";
import * as s from "./run-transfer-size.ts";

const tag = <S extends object, T extends string>(
  shape: S & Record<Exclude<keyof S, keyof RunState>, never>,
  name: T,
) => Object.fromEntries(Object.keys(shape).map((key) => [key, name])) as Record<keyof S, T>;
const policyState = p.transferPreparedPolicySchema
  .partial()
  .extend({ reviewMode: r.oneOf("single panel").optional() });
const classification = {
  ...tag(c.transferControlSchema.shape, "control"),
  ...tag(o.transferOutcomesSchema.shape, "outcomes"),
  ...tag(e.transferEvidenceSchema.shape, "evidence"),
  ...tag(a.transferAcceptanceSchema.shape, "acceptance"),
  ...tag(a.transferCompletedChecksSchema.shape, "completedChecks"),
  ...tag(s.transferSizeSchema.shape, "size"),
  ...tag(policyState.shape, "policy"),
  gateExecution: "execution",
  agentJob: "job",
  ...tag(r.fields("worktreePath worktreeAliases baseline baselineCached", r.counter), "excluded"),
} satisfies Record<keyof RunState, string>;
const jobState = z.strictObject({
  agentJob: z.strictObject({ round: r.counter, id: r.identity }).optional(),
});
const envelope = z.strictObject({
  header: z.strictObject({
    format: z.literal("limitless-run-payload"),
    version: z.literal(1),
    ...r.fields("runId repository", r.identity),
    claim: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("run"), repo: r.identity, runId: r.identity }),
      z.strictObject({ kind: r.oneOf("pr issue"), repo: r.identity, number: r.ordinal }),
    ]),
  }),
  policy: z.strictObject({
    history: z.unknown().transform(p.parseTransferPolicyHistory),
    identity: p.transferPolicyRecordSchema.options[0].pick({ policyId: true, repository: true }),
  }),
  ...r.fields("run state stages invocations questions", z.unknown()),
  jobs: z.array(z.unknown()),
  followUp: z.unknown().optional(),
  commits: z.array(r.oid),
});
export type RunPayloadV1 = ReturnType<typeof readPayload> & { followUp?: f.TransferFollowUp };
export type RunPayloadInput = r.TransferRowInput &
  Pick<z.input<typeof envelope>, "policy" | "jobs"> & {
    state: RunState;
    followUp?: f.FollowUpInput;
  };
function parseState(value: unknown, encode: boolean, ids: number[]) {
  const stages = ids.map((id) => ({ id, ordinal: id }));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunTransferError("invalid");
  const groups: Record<string, Record<string, unknown>> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !Object.hasOwn(classification, key))
      throw new RunTransferError(encode ? "unsupported" : "invalid");
    const group = classification[key as keyof RunState];
    if (group === "excluded" && !encode) throw new RunTransferError("invalid");
    groups[group] ??= {};
    groups[group][key] = Reflect.get(value, key);
  }
  const pick = (group: string) => groups[group] ?? {};
  const execution = pick("execution"),
    outcomes = encode ? o.encodeTransferOutcomes : o.parseTransferOutcomes,
    evidence = encode ? e.encodeTransferEvidence : e.parseTransferEvidence,
    executionParser = encode ? x.encodeTransferExecution : x.parseTransferExecution;
  if (Object.hasOwn(execution, "gateExecution"))
    execution.gateExecution = executionParser(execution.gateExecution);
  return {
    ...c.parseTransferControl(pick("control")),
    ...outcomes(pick("outcomes"), stages),
    ...evidence(pick("evidence"), stages),
    ...a.parseTransferAcceptance(pick("acceptance")),
    ...a.parseTransferCompletedChecks(pick("completedChecks")),
    ...s.parseTransferSize(pick("size")),
    ...r.parseRecord(policyState, pick("policy")),
    ...r.parseRecord(jobState, pick("job")),
    ...r.parseRecord(z.strictObject({ gateExecution: x.transferExecutionSchema.optional() }), execution),
  };
}
function readPayload(value: unknown, repo: Repo, manifest: PortableManifest, build = false) {
  r.preflight(value);
  const version = z.looseObject({ header: z.looseObject({ version: z.number() }) }).safeParse(value);
  if (version.success && version.data.header.version !== 1) throw new RunTransferError("unsupported");
  const { header: h, state, policy, jobs, commits, ...rows } = r.parseRecord(envelope, value);
  const data = f.decodeRunTransfer(rows, repo);
  const ids = data.stages.map((v) => v.ordinal);
  const portable = parseState(state, false, ids);
  parseTransferPolicy(policy.history, policy.identity, portable);
  const result = {
    ...data,
    header: h,
    state: portable,
    policy,
    jobs: jobs
      .map((v) => j.parseTransferAgentJob(v, data.invocations))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    commits,
  };
  for (const collection of [result.stages, result.invocations, result.questions])
    collection.sort((a, b) => a.ordinal - b.ordinal);
  validatePayloadReferences(result, repo, manifest);
  if (build) result.commits = payloadCommitDependencies(result);
  else if (p.policyCanonical(commits) !== p.policyCanonical(payloadCommitDependencies(result)))
    throw new RunTransferError("invalid");
  return result;
}
export const decodeRunPayload = r.boundary((value: unknown, repo: Repo, manifest: PortableManifest) =>
  readPayload(value, repo, manifest),
);
export const encodeRunPayload = r.boundary(
  (input: RunPayloadInput, repo: Repo, manifest: PortableManifest): RunPayloadV1 => {
    r.preflight(input, input.followUp?.owner);
    const { state, policy, jobs, followUp, ...rows } = input;
    const data = f.encodeRunTransfer(rows, repo, followUp);
    const ids = input.stages.map((v) => v.id);
    const encoded = {
      ...data,
      state: parseState(state, true, ids),
      policy,
      header: {
        format: "limitless-run-payload",
        version: 1,
        runId: manifest.runId,
        repository: repo.slug,
        claim: manifest.key,
      },
      jobs: jobs.map((v) => j.encodeTransferAgentJob(v, input.invocations)),
      commits: [],
    };
    return decodeRunPayload(readPayload(encoded, repo, manifest, true), repo, manifest);
  },
);
