import { expect, test } from "bun:test";
import type { RunState } from "../src/pipeline/context.ts";
import type { PortableManifest } from "../src/pipeline/portable.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import {
  decodeRunPayload,
  encodeRunPayload,
  type RunPayloadInput,
} from "../src/pipeline/run-transfer-schema.ts";
import { base, policyFixture, source } from "./run-transfer-policy-support.ts";
import { fixture, followUpFixture, rejects, repo } from "./run-transfer-support.ts";

const oid = (n: number) => n.toString(16).padStart(40, "0");
const prose = "e".repeat(40),
  tree = "f".repeat(40);
const gate = (n: number) => ({
  name: "test",
  verdict: "pass" as const,
  blocking: false,
  result: {
    name: "test",
    command: "bun test",
    ok: true,
    exitCode: 0,
    durationMs: 1,
    output: prose,
    executionProvenance: { sha: oid(n) },
    reused: { executionId: prose, treeHash: tree, createdAt: 1 },
  },
});
const model = (n: number) => ({
  overall: "pass" as const,
  notes: prose,
  criteria: ["Z", "A"].map((id) => ({
    id,
    status: "met" as const,
    evidence: " evidence ",
    publicSummary: "",
    gateEvidence: { stageId: 31, sha: oid(n), check: "test", command: "bun test" },
  })),
});
const verified = (n: number) => ({
  ...model(n + 1),
  sha: oid(n),
  modelId: "fake/model",
  modelOutput: model(n + 2),
});
function complete() {
  const { input: rows, dependency } = followUpFixture();
  const owner = dependency.owner,
    round = dependency.round;
  if (!owner || !round) throw new Error("fixture dependency missing");
  rows.run.id = "child01";
  rows.run.baseSha = oid(1);
  rows.run.headSha = oid(2);
  owner.id = "owner01";
  owner.baseSha = oid(3);
  owner.headSha = oid(4);
  round.runId = rows.run.id;
  round.ownerId = owner.id;
  round.reviewedSha = oid(5);
  round.deliveredSha = oid(6);
  rows.run.sourceRef = {
    kind: "review-round",
    runId: owner.id,
    round: round.round,
    prUrl: round.prUrl,
    reviewedSha: round.reviewedSha,
  };
  const ordinary = fixture();
  rows.stages = ordinary.stages.map((s) => ({ ...s, runId: rows.run.id }));
  rows.invocations = ordinary.invocations.map((v) => ({ ...v, runId: rows.run.id }));
  rows.questions = ordinary.questions.map((q) => ({ ...q, runId: rows.run.id }));
  const policy = policyFixture();
  const history = (sha: number, a: number, b: number) => ({
    round: 3,
    sha: oid(sha),
    blocking: [],
    followUps: [],
    scope: { kind: "fix" as const, range: `${oid(a)}...${oid(b)}` },
  });
  const state: RunState = {
    ...policy.state,
    reviewMode: "single",
    flow: "build",
    phase: "loop",
    round: 3,
    answers: ["z", "a", "z"],
    toolCommands: ["z", "a"],
    feedback: prose,
    triedImplementers: ["z", "a", "z"],
    roundsOnImplementer: 2,
    verification: { baseSha: oid(7), headSha: oid(8) },
    reviewBaseSha: oid(9),
    reviewResolution: { sha: oid(10), feedback: prose },
    publishedSha: oid(11),
    publishingSha: oid(12),
    pendingRebaseSha: oid(13),
    preRebaseHead: oid(14),
    verdictCommentPending: true,
    deliveryMerges: [{ runId: owner.id, reviewedSha: oid(15), sha: oid(16), head: oid(17), base: oid(18) }],
    postMergeRejection: { reason: prose, sha: oid(19), base: oid(20), head: oid(21), round: 2 },
    lastVerifiedSha: oid(22),
    reviewedSha: oid(23),
    lastVerify: verified(24),
    pendingVerify: { round: 3, attempt: 0, sha: oid(27), modelId: "fake/model", modelOutput: model(28) },
    verifyResults: [{ ...verified(29), round: 3 }],
    lastVerifiedEvidence: {
      lastVerify: verified(32),
      lastGates: [gate(51)],
      reviewHistory: [history(38, 39, 40)],
    },
    reviewHistory: [history(37, 35, 36), { ...history(37, 35, 36), round: 1 }],
    gateEvidence: { stageId: 900, sha: oid(41), baseSha: oid(42), checks: [] },
    coveringTestRuns: [
      {
        file: "a.test.ts",
        name: "test",
        verifiedSha: oid(43),
        round: 3,
        stageId: 31,
        result: gate(44).result,
      },
      { file: "b.test.ts", name: "refused", verifiedSha: oid(43), round: 3, stageId: 0, unavailable: true },
    ],
    postMergeGates: {
      sha: oid(45),
      base: oid(46),
      head: oid(47),
      round: 3,
      deadline: 100,
      result: { setupOk: true, timedOut: false, comparison: [gate(48)] },
    },
    lastGates: [gate(49)],
    preRebaseGates: [gate(50)],
    completedChecks: { round: 3, sha: oid(52), values: { gates: [gate(53)] } },
    sizeReport: { base: oid(54), head: oid(55), mode: "two-dot", error: "historical" },
    gateExecution: {
      stage: "gates",
      round: 3,
      purpose: "candidate",
      sha: oid(56),
      handle: {
        kind: "github-actions",
        id: "historical",
        startedAt: 1,
        githubActions: {
          cwd: "/local/checkout",
          repo: repo.slug,
          candidate: "candidate",
          dispatch: "dispatch",
          headSha: oid(57),
          dispatchSha: oid(58),
          inputs: { sha: oid(59), candidate: "candidate", setup: "", checks: "", setup_minutes: "1" },
          completed: { sha: oid(60), treeHash: tree, setupOk: true, setup: [gate(61).result], checks: [] },
        },
      },
      previous: [
        {
          purpose: "prior",
          gateKey: "prior",
          result: { sha: oid(62), treeHash: tree, setupOk: true, setup: [], checks: [gate(63).result] },
        },
      ],
    },
    agentJob: { round: 3, id: "z-done" },
    spec: null,
    implementerIssue: null,
    acceptance: {
      snapshot: {
        ticket: { number: 2, body: "ticket", author: null },
        parent: { number: 1, body: "parent", author: null },
      },
      sha: oid(67),
      outcome: { sha: oid(68), units: [], summary: "recorded", passed: true },
    },
    worktreePath: "/local/checkout",
    worktreeAliases: ["/local/alias"],
    baseline: null,
    baselineCached: true,
    iterationBase: oid(71),
  };
  const job = {
    id: "z-done",
    run_id: rows.run.id,
    invocation_id: 721,
    parent_sha: oid(64),
    state: "done",
    attempt: 1,
    result_sha: oid(65),
    failure_reason: null,
    created_at: 1,
    updated_at: 2,
    attempt_deadline_at: null,
    result: JSON.stringify({
      status: "ok",
      finalText: prose,
      structured: null,
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      numTurns: 1,
      costUsd: 0,
      costEquivUsd: 0,
      error: null,
      parentSha: oid(64),
      sha: oid(65),
    }),
  };
  const input: RunPayloadInput = {
    ...rows,
    state,
    policy: { history: policy.history, identity: policy.identity },
    followUp: dependency,
    jobs: [
      job,
      {
        ...job,
        id: "a-queued",
        invocation_id: 19,
        parent_sha: oid(66),
        state: "queued",
        result_sha: null,
        result: null,
      },
    ],
  };
  const manifest: PortableManifest = {
    schema: 2,
    runId: rows.run.id,
    key: { kind: "pr", repo: repo.slug, number: 42 },
    generation: 1,
    sequence: 0,
    previous: null,
    baseSha: rows.run.baseSha,
    headSha: rows.run.headSha,
    phase: "loop",
    round: 3,
    createdBy: "test",
    blobs: { state: { key: "0".repeat(32), digest: "0".repeat(64), size: 1 }, artifacts: [], objects: [] },
    effects: [],
  };
  return { input, manifest };
}
function encoded() {
  const { input, manifest } = complete();
  return { payload: encodeRunPayload(input, repo, manifest), manifest };
}
function set(value: unknown, path: string, member: unknown) {
  const keys = path.split(".");
  let cursor = value;
  const last = keys.pop();
  if (!last) throw new Error("fixture path missing");
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object") throw new Error(`fixture path missing: ${path}`);
    cursor = Reflect.get(cursor, key);
  }
  if (!cursor || typeof cursor !== "object") throw new Error(`fixture path missing: ${path}`);
  Reflect.set(cursor, last, member);
}
function withStoredFragments() {
  const data = complete();
  const finding = { severity: "major", file: "a.ts", line: 0, confidence: 1.5 };
  const review = {
    verdict: "request_changes",
    summary: " recorded ",
    findings: [finding, { ...finding, file: "b.ts" }],
    modelId: "fake/review",
  };
  const history = [{ round: 3, sha: oid(37), blocking: [finding], followUps: [finding] }];
  const stored = {
    triage: {
      title: " Task ",
      task_class: "bugfix",
      complexity: "small",
      risk: "low",
      ambiguity: "low",
      blocking_questions: ["z", "a"],
      summary: " recorded ",
      suggested_profile: "quick",
    },
    spec: {
      summary: " recorded ",
      assumptions: ["z", "a"],
      requirements: [],
      acceptance_criteria: [
        { id: "AC-2", criterion: " second ", how_to_verify: " inspect " },
        { id: "AC-1", criterion: " first ", how_to_verify: " run " },
      ],
      out_of_scope: [],
      blocking_questions: [],
    },
    holdout: {
      scenarios: [
        { id: "H-1", description: " private ", steps: " run ", expected: " result ", edge_case: false },
      ],
    },
    lastReview: review,
    reviewFollowUps: review.findings,
    reviewHistory: history,
    lastVerifiedEvidence: { lastVerify: null, lastReview: review, reviewHistory: history },
    completedChecks: { round: 3, values: { review } },
  };
  for (const [key, value] of Object.entries(stored)) set(data.input.state, key, structuredClone(value));
  set(data.input.state, "acceptance.output", {
    items: [
      {
        unit: "U1",
        verdict: "manual",
        files: [{ path: "a.ts" }, { path: "b.ts", lines: null }],
        tests: [],
        note: " recorded ",
      },
    ],
  });
  return { ...data, stored };
}

test("complete codecs preserve stored fragments without applying parser changes", () => {
  const { input, manifest, stored } = withStoredFragments();
  const payload = encodeRunPayload(input, repo, manifest);
  const decoded = decodeRunPayload(
    JSON.parse(new TextDecoder().decode(encodeTransferJson(payload))),
    repo,
    manifest,
  );
  const fragments = Object.fromEntries(
    Object.keys(stored).map((key) => [key, Reflect.get(decoded.state, key)]),
  );
  expect(encodeTransferJson(fragments)).toEqual(encodeTransferJson(stored));
  expect(encodeTransferJson(decoded.state.acceptance?.output)).toEqual(
    encodeTransferJson(input.state.acceptance?.output),
  );
});
test.each([
  "triage",
  "spec.acceptance_criteria.0",
  "holdout.scenarios.0",
  "lastReview.findings.0",
  "reviewFollowUps.0",
  "reviewHistory.0.blocking.0",
  "reviewHistory.0.followUps.0",
  "lastVerifiedEvidence.lastReview.findings.0",
  "lastVerifiedEvidence.reviewHistory.0.blocking.0",
  "completedChecks.values.review.findings.0",
  "acceptance.output.items.0",
  "acceptance.output.items.0.files.0",
])("both codecs reject unknown stored members inside %s", (path) => {
  const { input, manifest } = withStoredFragments();
  const payload = encodeRunPayload(input, repo, manifest);
  set(input.state, `${path}.unknown`, true);
  rejects(() => encodeRunPayload(input, repo, manifest));
  set(payload.state, `${path}.unknown`, true);
  rejects(() => decodeRunPayload(payload, repo, manifest));
});

test("complete payload preserves shape, semantic ordering and pending effects", () => {
  const { payload, manifest } = encoded();
  expect(decodeRunPayload(payload, repo, manifest)).toEqual(payload);
  const json = JSON.parse(new TextDecoder().decode(encodeTransferJson(payload)));
  expect(decodeRunPayload(json, repo, manifest)).toEqual(payload);
  expect(payload.state.answers).toEqual(["z", "a", "z"]);
  expect(payload.state.triedImplementers).toEqual(["z", "a", "z"]);
  expect(payload.state.reviewHistory?.map((v) => v.round)).toEqual([3, 1]);
  expect(payload.state.verifyResults?.[0]?.criteria.map((v) => v.id)).toEqual(["Z", "A"]);
  expect(payload.state.spec).toBeNull();
  expect(payload.state.implementerIssue).toBeNull();
  expect(payload.state).not.toHaveProperty("holdout");
  expect(payload.state.lastVerify?.criteria[0]).not.toHaveProperty("blockedReason");
  expect(payload.state.lastVerify?.criteria[0]).not.toHaveProperty("covering_tests");
  expect(payload.state).toMatchObject({ verdictCommentPending: true, publishingSha: oid(12) });
  expect(payload.stages.map((v) => v.ordinal)).toEqual([1, 2]);
  expect(payload.invocations.map((v) => v.ordinal)).toEqual([1, 2]);
  expect(payload.questions.map((v) => v.ordinal)).toEqual([1, 2]);
  expect(payload.jobs.map((v) => v.id)).toEqual(["a-queued", "z-done"]);
  expect(payload.jobs[0]?.result).toBeNull();
  for (const key of ["worktreePath", "worktreeAliases", "baseline", "baselineCached"])
    expect(payload.state).not.toHaveProperty(key);
});

test.each([oid(71), oid(1), "Ab".repeat(32), undefined])(
  "iterationBase checkpoint preserves its spelling and presence (%j)",
  (checkpoint) => {
    const { input, manifest } = complete();
    if (checkpoint === undefined) delete input.state.iterationBase;
    else input.state.iterationBase = checkpoint;
    const payload = encodeRunPayload(input, repo, manifest);
    const decoded = decodeRunPayload(payload, repo, manifest);
    if (checkpoint === undefined) {
      expect(payload.state).not.toHaveProperty("iterationBase");
      expect(decoded.state).not.toHaveProperty("iterationBase");
      expect(payload.commits).not.toContain(oid(71));
    } else {
      expect(payload.state).toHaveProperty("iterationBase", checkpoint);
      expect(decoded.state).toHaveProperty("iterationBase", checkpoint);
      expect(payload.commits.filter((v) => v === checkpoint)).toHaveLength(1);
    }
  },
);
test.each([null, true, "", "main", "a".repeat(39), "g".repeat(40)])(
  "both codecs reject malformed iterationBase (%j)",
  (checkpoint) => {
    const { input, manifest } = complete();
    set(input.state, "iterationBase", checkpoint);
    rejects(() => encodeRunPayload(input, repo, manifest));
    const { payload } = encoded();
    set(payload.state, "iterationBase", checkpoint);
    rejects(() => decodeRunPayload(payload, repo, manifest));
  },
);

test.each([
  "invocations.0.stageOrdinal",
  "jobs.0.invocationOrdinal",
  "state.agentJob.id",
  "state.gateEvidence.stageOrdinal",
  "state.coveringTestRuns.0.stageOrdinal",
  "state.lastVerify.criteria.0.gateEvidence.stageOrdinal",
  "state.lastVerify.modelOutput.criteria.0.gateEvidence.stageOrdinal",
  "state.lastVerifiedEvidence.lastVerify.criteria.0.gateEvidence.stageOrdinal",
  "state.lastVerifiedEvidence.lastVerify.modelOutput.criteria.0.gateEvidence.stageOrdinal",
  "state.pendingVerify.modelOutput.criteria.0.gateEvidence.stageOrdinal",
  "state.verifyResults.0.criteria.0.gateEvidence.stageOrdinal",
  "state.verifyResults.0.modelOutput.criteria.0.gateEvidence.stageOrdinal",
])("rejects dangling reference at %s", (path) => {
  const { payload, manifest } = encoded();
  set(payload, path, path.endsWith(".id") ? "missing" : 999);
  rejects(() => decodeRunPayload(payload, repo, manifest));
});

const expectedCommits = [...Array.from({ length: 68 }, (_, i) => oid(i + 1)), oid(71), base, source].sort();
test("commit closure includes every typed checkpoint and excludes prose and trees", () => {
  const { payload } = encoded();
  expect(payload.commits).toEqual(expectedCommits);
  expect(payload.commits).not.toContain(prose);
  expect(payload.commits).not.toContain(tree);
});
test.each(expectedCommits)("requires classified commit %s", (commit) => {
  const { payload, manifest } = encoded();
  payload.commits = payload.commits.filter((v) => v !== commit);
  rejects(() => decodeRunPayload(payload, repo, manifest));
});
test.each([prose, tree])("rejects an extra unreferenced commit %s", (commit) => {
  const { payload, manifest } = encoded();
  payload.commits.push(commit);
  payload.commits.sort();
  rejects(() => decodeRunPayload(payload, repo, manifest));
});

test.each<[string, unknown]>([
  ["payload.header.runId", "other01"],
  ["payload.run.flow", "acceptance"],
  ["manifest.phase", "done"],
  ["manifest.round", 4],
  ["manifest.runId", "other01"],
  ["manifest.baseSha", oid(99)],
  ["manifest.headSha", oid(99)],
  ["manifest.key.repo", "other/project"],
  ["payload.header.repository", "other/project"],
  ["payload.policy.identity.repository.slug", "other/project"],
  ["manifest.key", { kind: "run", repo: repo.slug, runId: "other01" }],
  ["manifest.key.number", 43],
])("rejects cross-record disagreement at %s", (path, value) => {
  const data = encoded();
  set(data, path, value);
  expect(() => decodeRunPayload(data.payload, repo, data.manifest)).toThrow(
    expect.objectContaining({ name: "RunTransferError" }),
  );
});
test("a run claim must name the primary run, even when header agrees", () => {
  const { payload, manifest } = encoded();
  manifest.key = { kind: "run", repo: repo.slug, runId: "other01" };
  payload.header.claim = manifest.key;
  rejects(() => decodeRunPayload(payload, repo, manifest));
});
test.each(["issue", "pull_request", "follow-up"] as const)(
  "both codecs reject self-naming run claims for %s payloads",
  (kind) => {
    const { input, manifest } = complete();
    if (kind !== "follow-up") {
      delete input.followUp;
      input.run.sourceRef = {
        kind,
        repo: repo.slug,
        number: 17,
        ...(kind === "pull_request" ? { baseSha: oid(69), headSha: oid(70) } : {}),
      };
      manifest.key = { kind: kind === "issue" ? "issue" : "pr", repo: repo.slug, number: 17 };
    }
    const payload = encodeRunPayload(input, repo, manifest);
    expect(decodeRunPayload(payload, repo, manifest)).toEqual(payload);
    manifest.key = { kind: "run", repo: repo.slug, runId: input.run.id };
    payload.header.claim = manifest.key;
    rejects(() => encodeRunPayload(input, repo, manifest));
    rejects(() => decodeRunPayload(payload, repo, manifest));
  },
);
test("repository identities compare without case sensitivity", () => {
  const { input, manifest } = complete();
  manifest.key.repo = repo.slug.toUpperCase();
  const payload = encodeRunPayload(input, { ...repo, slug: repo.slug.toUpperCase() }, manifest);
  expect(decodeRunPayload(payload, repo, manifest)).toEqual(payload);
});
test.each(["issue", "pull_request"] as const)(
  "mixed-case %s source repositories preserve their original spelling on both boundaries",
  (kind) => {
    const { input, manifest } = complete();
    delete input.followUp;
    input.run.sourceRef = {
      kind,
      repo: "Example/PROJECT",
      number: 17,
      ...(kind === "pull_request" ? { baseSha: oid(69), headSha: oid(70) } : {}),
    };
    manifest.key = { kind: kind === "issue" ? "issue" : "pr", repo: repo.slug, number: 17 };
    const payload = encodeRunPayload(input, repo, manifest);
    expect(payload.run.sourceRef).toEqual(input.run.sourceRef);
    set(payload, "run.sourceRef.repo", "EXAMPLE/Project");
    const decoded = decodeRunPayload(payload, repo, manifest);
    expect(decoded).toEqual(payload);
    expect(decoded.run.sourceRef?.repo).toBe("EXAMPLE/Project");
    set(payload, "run.sourceRef.repo", "other/project");
    rejects(() => decodeRunPayload(payload, repo, manifest));
    input.run.sourceRef.repo = "other/project";
    rejects(() => encodeRunPayload(input, repo, manifest));
  },
);
test.each(["owner", "round"] as const)(
  "mixed-case follow-up %s repositories preserve their original spelling on both boundaries",
  (which) => {
    const { input, manifest } = complete();
    const member = input.followUp?.[which];
    if (!member) throw new Error("fixture dependency missing");
    member.repoSlug = "Example/PROJECT";
    const payload = encodeRunPayload(input, repo, manifest);
    const path = which === "owner" ? "followUp.owner.repoSlug" : "followUp.repoSlug";
    expect(payload).toHaveProperty(path, "Example/PROJECT");
    set(payload, path, "EXAMPLE/Project");
    const decoded = decodeRunPayload(payload, repo, manifest);
    expect(decoded).toEqual(payload);
    expect(decoded).toHaveProperty(path, "EXAMPLE/Project");
    set(payload, path, "other/project");
    rejects(() => decodeRunPayload(payload, repo, manifest), "incomplete");
    member.repoSlug = "other/project";
    rejects(() => encodeRunPayload(input, repo, manifest), "incomplete");
  },
);
test("new payload versions are unsupported", () => {
  const { payload, manifest } = encoded();
  set(payload, "header.version", 2);
  rejects(() => decodeRunPayload(payload, repo, manifest), "unsupported");
});

test.each(["primary", "owner"] as const)("encoding refuses ordinary dependencies on %s", (which) => {
  const { input, manifest } = complete();
  const run = which === "primary" ? input.run : input.followUp?.owner;
  if (!run) throw new Error("fixture owner missing");
  run.dependsOn = ["owner01"];
  rejects(() => encodeRunPayload(input, repo, manifest), "unsupported");
});
test.each(["run", "followUp.owner"])("decoding refuses ordinary dependencies on %s", (path) => {
  const { payload, manifest } = encoded();
  set(payload, `${path}.dependsOn`, ["owner01"]);
  rejects(() => decodeRunPayload(payload, repo, manifest), "unsupported");
});
test.each(["worktreePath", "worktreeAliases", "baseline", "baselineCached", "unclassified"])(
  "portable state refuses %s",
  (key) => {
    const { payload, manifest } = encoded();
    set(payload.state, key, true);
    rejects(() => decodeRunPayload(payload, repo, manifest));
  },
);
test("encoding refuses unclassified state members", () => {
  const { input, manifest } = complete();
  set(input.state, "unclassified", true);
  rejects(() => encodeRunPayload(input, repo, manifest), "unsupported");
});
test.each<[string, unknown]>([
  ["jobs.1.result", null],
  ["jobs.1.result.status", "error"],
  ["jobs.1.result_sha", null],
  ["jobs.1.id", "a-queued"],
  ["jobs.0.run_id", "owner01"],
  ["stages.1.ordinal", 1],
  ["stages.1.ordinal", 3],
  ["invocations.1.ordinal", 1],
  ["questions.0.ordinal", 0],
  ["questions.1.ordinal", 3],
  ["questions.0.runId", "other01"],
  ["invocations.0.costUsd", Number.POSITIVE_INFINITY],
  ["invocations.0.costUsd", -1],
  ["run.costEquivUsd", -1],
  ["invocations.0.inputTokens", -1],
  ["jobs.1.state", "unknown"],
  ["state.round", Number.NaN],
  ["jobs.1.result.usage.input", Number.POSITIVE_INFINITY],
])("rejects invalid row or accounting at %s (%j)", (path, value) => {
  const { payload, manifest } = encoded();
  set(payload, path, value);
  rejects(() => decodeRunPayload(payload, repo, manifest));
});
test.each(["header", "run", "state", "policy", "stages", "invocations", "questions", "jobs", "commits"])(
  "envelope requires %s",
  (key) => {
    const { payload, manifest } = encoded();
    Reflect.deleteProperty(payload, key);
    rejects(() => decodeRunPayload(payload, repo, manifest));
  },
);
test("strict envelopes refuse unknown members, including nested header and policy", () => {
  for (const path of [
    "unknown",
    "header.unknown",
    "header.claim.unknown",
    "policy.unknown",
    "policy.identity.unknown",
  ]) {
    const { payload, manifest } = encoded();
    set(payload, path, true);
    rejects(() => decodeRunPayload(payload, repo, manifest));
  }
});
test("a missing follow-up stays incomplete and an absent flow stays absent", () => {
  const { payload, manifest } = encoded();
  Reflect.deleteProperty(payload, "followUp");
  rejects(() => decodeRunPayload(payload, repo, manifest), "incomplete");
  const { input, manifest: m } = complete();
  delete input.run.flow;
  delete input.state.flow;
  expect(encodeRunPayload(input, repo, m).state).not.toHaveProperty("flow");
});

test.each(["issue", "pull_request"] as const)("ordinary %s claims and source commits agree", (kind) => {
  const { input, manifest } = complete();
  delete input.followUp;
  input.run.sourceRef = {
    kind,
    repo: repo.slug,
    number: 17,
    ...(kind === "pull_request" ? { baseSha: oid(69), headSha: oid(70) } : {}),
  };
  manifest.key = { kind: kind === "issue" ? "issue" : "pr", repo: repo.slug, number: 17 };
  const payload = encodeRunPayload(input, repo, manifest);
  expect(decodeRunPayload(payload, repo, manifest)).toEqual(payload);
  expect(payload).not.toHaveProperty("followUp");
  if (kind === "pull_request") {
    expect(payload.commits).toContain(oid(69));
    expect(payload.commits).toContain(oid(70));
    payload.commits = payload.commits.filter((v) => v !== oid(69));
    rejects(() => decodeRunPayload(payload, repo, manifest));
  }
  set(payload, "run.sourceRef.number", 18);
  rejects(() => decodeRunPayload(payload, repo, manifest));
});
test("owner source commits are inventoried through the same typed fields", () => {
  const { input, manifest } = complete();
  const owner = input.followUp?.owner;
  if (!owner) throw new Error("fixture owner missing");
  owner.sourceRef = { kind: "pull_request", repo: repo.slug, number: 42, baseSha: oid(69), headSha: oid(70) };
  const payload = encodeRunPayload(input, repo, manifest);
  expect(payload.commits).toContain(oid(69));
  expect(payload.commits).toContain(oid(70));
  payload.commits = payload.commits.filter((v) => v !== oid(70));
  rejects(() => decodeRunPayload(payload, repo, manifest));
});
test("provisional policies and a self-naming run claim remain valid without prepared fields", () => {
  const { input, manifest } = complete();
  delete input.followUp;
  input.run.sourceRef = null;
  const policy = policyFixture();
  input.policy.history = [policy.provisional];
  input.state = {
    phase: "loop",
    flow: "build",
    round: 3,
    feedback: null,
    answers: [],
    toolCommands: [],
    roundsOnImplementer: 0,
    triedImplementers: [],
  };
  manifest.key = { kind: "run", repo: repo.slug, runId: input.run.id };
  const payload = encodeRunPayload(input, repo, manifest);
  expect(decodeRunPayload(payload, repo, manifest)).toEqual(payload);
  expect(payload.state).not.toHaveProperty("gatesConfig");
});
test("non-enumerable and symbol state keys cannot bypass classification", () => {
  const { input, manifest } = complete();
  Object.defineProperty(input.state, "unclassified", { value: true });
  rejects(() => encodeRunPayload(input, repo, manifest), "unsupported");
  const other = complete();
  Reflect.set(other.input.state, Symbol("unclassified"), true);
  rejects(() => encodeRunPayload(other.input, repo, other.manifest), "unsupported");
});
test("dependency preflight precedes malformed fragments", () => {
  const { payload, manifest } = encoded();
  set(payload, "run.dependsOn", ["owner01"]);
  Reflect.deleteProperty(payload, "state");
  set(payload, "header.version", 2);
  rejects(() => decodeRunPayload(payload, repo, manifest), "unsupported");
});
test.each<[string, unknown]>([
  ["header.version", undefined],
  ["header.format", "other"],
  ["commits", []],
])("malformed envelope member %s is invalid", (path, member) => {
  const { payload, manifest } = encoded();
  set(payload, path, member);
  rejects(() => decodeRunPayload(payload, repo, manifest));
});
test("decoding orders only relational rows and jobs", () => {
  const { payload, manifest } = encoded();
  payload.stages.reverse();
  payload.invocations.reverse();
  payload.questions.reverse();
  payload.jobs.reverse();
  const decoded = decodeRunPayload(payload, repo, manifest);
  expect(decoded.stages.map((v) => v.ordinal)).toEqual([1, 2]);
  expect(decoded.invocations.map((v) => v.ordinal)).toEqual([1, 2]);
  expect(decoded.questions.map((v) => v.ordinal)).toEqual([1, 2]);
  expect(decoded.jobs.map((v) => v.id)).toEqual(["a-queued", "z-done"]);
  expect(decoded.state.toolCommands).toEqual(["z", "a"]);
  const reversed = structuredClone(decoded);
  reversed.commits.reverse();
  rejects(() => decodeRunPayload(reversed, repo, manifest));
  const duplicate = structuredClone(decoded);
  duplicate.commits.push(oid(1));
  duplicate.commits.sort();
  rejects(() => decodeRunPayload(duplicate, repo, manifest));
});
