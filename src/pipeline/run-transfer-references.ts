import type { PortableManifest } from "./portable.ts";
import * as a from "./run-transfer-acceptance.ts";
import { controlCommitMembers } from "./run-transfer-control.ts";
import { RunTransferError } from "./run-transfer-errors.ts";
import { evidenceCommitDependencies } from "./run-transfer-evidence.ts";
import { executionCommitDependencies } from "./run-transfer-execution.ts";
import { agentJobCommitDependencies } from "./run-transfer-jobs.ts";
import { outcomesCommitDependencies, type TransferOutcomes } from "./run-transfer-outcomes.ts";
import { policyCanonical, policyCommitDependencies } from "./run-transfer-policy-schema.ts";
import type { TransferRepository as Repo } from "./run-transfer-rows.ts";
import type { RunPayloadV1 } from "./run-transfer-schema.ts";
import { sizeCommitDependencies } from "./run-transfer-size.ts";

function controlCommits(value: unknown, path: string[]): string[] {
  const [key, ...rest] = path;
  if (!key) return typeof value === "string" ? [value] : [];
  if (!value || typeof value !== "object") return [];
  const member = Reflect.get(value, key.replace(/\[\]$/, ""));
  return (Array.isArray(member) ? member : [member]).flatMap((v) => controlCommits(v, rest));
}
export function payloadCommitDependencies(p: RunPayloadV1): string[] {
  const { followUp: f, state: s } = p;
  const refs = [p.run, ...(f ? [f.owner] : [])].flatMap(({ sourceRef: ref }) => {
    if (ref?.kind === "pull_request") return [ref.baseSha, ref.headSha];
    return ref?.kind === "review-round" ? [ref.reviewedSha] : [];
  });
  const commits = [
    [p.run.baseSha, p.run.headSha],
    refs.filter((v): v is string => typeof v === "string"),
    policyCommitDependencies(p.policy.history),
    controlCommitMembers.flatMap((v) => controlCommits(s, v.split("."))),
    outcomesCommitDependencies(s),
    evidenceCommitDependencies(s),
    a.acceptanceCommitDependencies(s),
    a.completedChecksCommitDependencies(s),
    sizeCommitDependencies(s),
    s.gateExecution ? executionCommitDependencies(s.gateExecution) : [],
    p.jobs.flatMap(agentJobCommitDependencies),
    f ? [f.reviewedSha, f.deliveredSha, f.owner.baseSha, f.owner.headSha] : [],
  ];
  return [...new Set(commits.flat().filter((v): v is string => v !== null))].sort();
}
export function validatePayloadReferences(p: RunPayloadV1, repo: Repo, m: PortableManifest): void {
  const { run, state: s, header: h, followUp: f } = p;
  const invalid = () => {
    throw new RunTransferError("invalid");
  };
  const stage = (n: number) => p.stages.some((v) => v.ordinal === n) || invalid();
  for (const i of p.invocations) if (i.stageOrdinal !== null) stage(i.stageOrdinal);
  const ids = new Set(p.jobs.map((v) => v.id));
  if (ids.size !== p.jobs.length || (s.agentJob && !ids.has(s.agentJob.id))) invalid();
  for (const job of p.jobs) {
    const invocation = p.invocations.find((v) => v.ordinal === job.invocationOrdinal);
    if (!invocation || (job.run_id !== null && job.run_id !== invocation.runId)) invalid();
    if (job.state === "done" && (job.result?.status !== "ok" || job.result_sha === null)) invalid();
  }
  if (s.gateEvidence) stage(s.gateEvidence.stageOrdinal);
  for (const v of s.coveringTestRuns ?? []) if (v.stageOrdinal !== 0) stage(v.stageOrdinal);
  const verify = (v: Partial<NonNullable<TransferOutcomes["lastVerify"]>> | null | undefined) => {
    for (const c of [...(v?.criteria ?? []), ...(v?.modelOutput?.criteria ?? [])])
      if (c.gateEvidence) stage(c.gateEvidence.stageOrdinal);
  };
  [s.lastVerify, s.pendingVerify?.modelOutput, s.lastVerifiedEvidence?.lastVerify].forEach(verify);
  s.verifyResults?.forEach(verify);
  for (const record of [run, ...(f ? [f.owner] : []), ...p.invocations])
    if (record.costUsd < 0 || record.costEquivUsd < 0) invalid();
  const expected = [run.id, run.id, s.flow ?? null, s.phase, s.round, run.baseSha, run.headSha];
  const observed = [h.runId, m.runId, run.flow ?? null, m.phase, m.round, m.baseSha, m.headSha];
  if (
    expected.some((v, i) => v !== observed[i]) ||
    policyCanonical({ ...h.claim, repo: h.claim.repo.toLowerCase() }) !==
      policyCanonical({ ...m.key, repo: m.key.repo.toLowerCase() }) ||
    [repo.slug, h.repository, p.policy.identity.repository.slug, m.key.repo].some(
      (v) => v.toLowerCase() !== run.repoSlug.toLowerCase(),
    )
  )
    invalid();
  const claim = m.key,
    ref = run.sourceRef;
  if (claim.kind === "run") {
    if (claim.runId !== run.id || ref?.kind === "issue" || ref?.kind === "pull_request" || f) invalid();
  } else if (f && claim.kind === "pr") {
    if (Number(f.prUrl.match(/\/pull\/([1-9][0-9]*)$/)?.[1]) !== claim.number) invalid();
  } else if (
    ref?.kind !== (claim.kind === "pr" ? "pull_request" : "issue") ||
    ref.number !== claim.number ||
    typeof ref.repo !== "string" ||
    ref.repo.toLowerCase() !== claim.repo.toLowerCase()
  )
    invalid();
}
