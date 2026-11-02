import { initialRunState, type RunState } from "../src/pipeline/context.ts";
import type { PortableManifest } from "../src/pipeline/portable.ts";
import { encodeRunPayload } from "../src/pipeline/run-transfer-schema.ts";
import { policyFixture } from "./run-transfer-policy-support.ts";
import { fixture, followUpFixture, head, repo, sha } from "./run-transfer-support.ts";

export function portableProjectionFixture(policy = policyFixture()) {
  const { input: rows, dependency } = followUpFixture();
  if (!dependency.owner || !dependency.round) throw new Error("Missing fixture owner");
  rows.run.id = "child01";
  dependency.owner.id = "owner01";
  dependency.round.runId = rows.run.id;
  dependency.round.ownerId = dependency.owner.id;
  rows.run.sourceRef = {
    kind: "review-round",
    runId: "owner01",
    round: 3,
    prUrl: rows.run.prUrl,
    reviewedSha: sha,
    data: { stageOrdinal: 1 },
  };
  rows.run.status = "running";
  rows.run.finishedAt = null;
  const ordinary = fixture();
  rows.stages = ordinary.stages.map((s) => ({ ...s, runId: rows.run.id }));
  rows.invocations = ordinary.invocations.map((v) => ({
    ...v,
    runId: rows.run.id,
    status: "running",
    finishedAt: null,
  }));
  rows.questions = ordinary.questions.map((q) => ({ ...q, runId: rows.run.id }));
  const model = {
    overall: "pass" as const,
    notes: "Historical evidence",
    criteria: [
      {
        id: "AC-1",
        status: "met" as const,
        evidence: "Recorded",
        publicSummary: "Recorded",
        gateEvidence: { stageId: 31, sha, check: "test", command: "bun test" },
      },
    ],
  };
  const verify = { ...model, modelId: "fake/model", modelOutput: model };
  const state: RunState = {
    ...initialRunState(rows.run),
    ...policy.state,
    reviewMode: "single",
    flow: "build",
    phase: "loop",
    round: 3,
    gateEvidence: { stageId: 900, sha, baseSha: sha, checks: [] },
    lastVerify: verify,
    pendingVerify: { round: 3, attempt: 0, sha, modelId: "fake/model", modelOutput: model },
    lastVerifiedEvidence: { lastVerify: verify },
    verifyResults: [{ ...verify, round: 3 }],
    coveringTestRuns: [
      { file: "a.test.ts", name: "absent", verifiedSha: sha, round: 3, stageId: 0, unavailable: true },
      { file: "b.test.ts", name: "recorded", verifiedSha: sha, round: 3, stageId: 31, unavailable: true },
    ],
    agentJob: { round: 3, id: "queued-job" },
    gateExecution: {
      stage: "gates",
      round: 3,
      purpose: "candidate",
      sha,
      handle: {
        kind: "github-actions",
        id: "history",
        startedAt: 18,
        githubActions: {
          cwd: "/source/checkout",
          repo: repo.slug,
          candidate: "candidate",
          dispatch: "dispatch",
          headSha: head,
          runId: 42,
          cleanupRunIds: [31, 900],
          dispatchSent: true,
        },
      },
    },
  };
  const jobs = ["queued", "leased"].map((status, i) => ({
    id: `${status}-job`,
    run_id: rows.run.id,
    invocation_id: i === 0 ? 721 : 19,
    parent_sha: sha,
    state: status,
    attempt: i,
    result_sha: null,
    failure_reason: null,
    created_at: 11,
    updated_at: 12,
    attempt_deadline_at: i === 0 ? null : 90,
    result: null,
  }));
  const manifest: PortableManifest = {
    schema: 2,
    runId: rows.run.id,
    key: { kind: "pr", repo: repo.slug, number: 42 },
    generation: 1,
    sequence: 0,
    previous: null,
    baseSha: sha,
    headSha: head,
    phase: "loop",
    round: 3,
    createdBy: "test",
    blobs: { state: { key: "0".repeat(32), digest: "0".repeat(64), size: 1 }, artifacts: [], objects: [] },
    effects: [],
  };
  const payload = encodeRunPayload(
    {
      ...rows,
      state,
      jobs,
      followUp: dependency,
      policy: { history: policy.history, identity: policy.identity },
    },
    repo,
    manifest,
  );
  Reflect.deleteProperty(payload.state, "answers");
  return payload;
}
