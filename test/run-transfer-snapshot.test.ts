import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  appendPolicySupplement,
  finalizePreparePolicy,
  recordProvisionalPolicy,
} from "../src/db/portable-policies.ts";
import { Store } from "../src/db/store.ts";
import { initialRunState } from "../src/pipeline/context.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import {
  captureRunTransferSnapshot,
  type SnapshotManifestContext,
  type SnapshotSourceContext,
} from "../src/pipeline/run-transfer-snapshot.ts";
import { registerCredential } from "../src/util/proc.ts";
import { policyFixture, seal } from "./run-transfer-policy-support.ts";
import { fixture, head, rejects, sha } from "./run-transfer-support.ts";

const stores: Store[] = [];
afterEach(() => {
  mock.restore();
  for (const store of stores.splice(0)) store.close();
});
const excluded = "excluded-resource-marker";
function setup(policy = policyFixture()) {
  const store = new Store(":memory:");
  stores.push(store);
  const repo = store.upsertRepo({
    slug: "example/project",
    kind: "github",
    url: excluded,
    localPath: excluded,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "Original request" });
  const initial = initialRunState(run);
  const state = {
    ...initial,
    ...policy.prepared.fields,
    phase: "loop" as const,
    round: 2,
    worktreePath: excluded,
    worktreeAliases: [excluded],
    baseline: null,
    baselineCached: true,
    agentJob: { round: 2, id: "current-job" },
  };
  recordProvisionalPolicy(store, {
    runId: run.id,
    record: policy.provisional,
    state: initial,
    expected: null,
    expectedState: null,
  });
  finalizePreparePolicy(store, {
    runId: run.id,
    record: policy.prepared,
    state,
    expected: { version: 1, digest: policy.provisional.recordId },
    expectedState: initial,
  });
  store.db
    .query("UPDATE runs SET base_sha = ?, head_sha = ?, cost_usd = 90, tokens_in = 9999 WHERE id = ?")
    .run(sha, head, run.id);
  const rows = fixture();
  // IDs collide across tables; neither insertion order nor the other table's IDs are ordinals.
  rows.invocations = rows.invocations.map((v, i) =>
    i === 1 ? { ...v, id: 31, status: "running", finishedAt: null } : v,
  );
  rows.questions = rows.questions.map((v, i) => (i === 1 ? { ...v, id: 31 } : v));
  const insert = (table: string, row: object) => {
    const entries = Object.entries({ ...row, runId: run.id });
    store.db
      .query(
        `INSERT INTO ${table} (${entries.map(([k]) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
      )
      .run(...entries.map(([, v]) => (typeof v === "boolean" ? Number(v) : v)));
  };
  for (const s of rows.stages) insert("stages", s);
  for (const i of rows.invocations) insert("invocations", { ...i, sessionId: excluded });
  for (const q of rows.questions) insert("questions", q);
  for (const [id, invocation, runId] of [
    ["old-job", 31, null],
    ["current-job", 721, run.id],
  ] as const)
    store.db
      .query(`INSERT INTO agent_jobs
      (id, run_id, invocation_id, request, parent_sha, state, worker, attempt, lease_expires_at,
       attempt_deadline_at, result, result_sha, failure_reason, excluded, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'failed', ?, 7, 987, 123, NULL, NULL, 'exhausted', ?, 11, 22)`)
      .run(id, runId, invocation, excluded, sha, excluded, JSON.stringify([excluded]));
  const context = ({ run, state }: SnapshotSourceContext): SnapshotManifestContext => ({
    manifest: {
      schema: 2,
      runId: run.id,
      key: { kind: "run", repo: run.repoSlug, runId: run.id },
      generation: 4,
      sequence: 5,
      previous: null,
      baseSha: run.baseSha,
      headSha: run.headSha,
      phase: state.phase,
      round: state.round,
      createdBy: "offline",
      effects: [],
      blobs: { state: { key: "a".repeat(32), digest: "c".repeat(64), size: 10 }, artifacts: [], objects: [] },
    },
  });
  return {
    store,
    runId: run.id,
    repo,
    state,
    policy,
    context,
    capture: () => captureRunTransferSnapshot(store, run.id, context),
  };
}
function sourceRows(store: Store) {
  return [
    "runs",
    "stages",
    "invocations",
    "questions",
    "agent_jobs",
    "run_policy_selections",
    "run_policy_versions",
  ].map((table) => store.db.query(`SELECT * FROM ${table}`).all());
}
function followUp(f: ReturnType<typeof setup>) {
  const owner = f.store.createRun(f.repo, { repo: f.repo.slug, prompt: "Owner" });
  const url = "https://github.com/example/project/pull/42";
  f.store.db.query("UPDATE runs SET branch = 'topic', pr_url = ? WHERE id = ?").run(url, owner.id);
  f.store.db
    .query(
      "UPDATE runs SET base_branch = 'topic', delivery_branch = 'topic', pr_url = ?, source_ref = ? WHERE id = ?",
    )
    .run(
      url,
      JSON.stringify({ kind: "review-round", runId: owner.id, round: 3, prUrl: url, reviewedSha: sha }),
      f.runId,
    );
  f.store.db
    .query(`INSERT INTO review_rounds
    (run_id, source_run_id, pr_url, round, reviewed_sha, findings, created_at)
    VALUES (?, ?, ?, 3, ?, '[]', 80)`)
    .run(f.runId, owner.id, url, sha);
  const context = (source: SnapshotSourceContext) => {
    const captured = f.context(source);
    captured.manifest.key = { kind: "pr", repo: f.repo.slug, number: 42 };
    return captured;
  };
  return { ownerId: owner.id, capture: () => captureRunTransferSnapshot(f.store, f.runId, context) };
}

test("capture completes its read transaction before deferred object work and detaches every retained input", async () => {
  const f = setup();
  const run = f.store.getRun(f.runId);
  if (!run) throw new Error("Missing fixture run");
  const retained = f.context({
    run,
    state: f.state,
    repository: f.repo,
    policyPin: { version: 2, digest: f.policy.prepared.recordId },
  });
  const bytes = new Uint8Array([1, 2, 3]);
  retained.byteInputs = [bytes];
  for (const name of [
    "getRun",
    "getRunState",
    "getRepo",
    "listStages",
    "listInvocations",
    "listQuestions",
  ] as const) {
    const original = f.store[name].bind(f.store);
    spyOn(f.store, name).mockImplementation(((id: string) => {
      expect(f.store.db.inTransaction).toBe(true);
      return original(id);
    }) as Store[typeof name]);
  }
  const candidate = captureRunTransferSnapshot(f.store, f.runId, (source) => {
    expect(f.store.db.inTransaction).toBe(true);
    expect(source.policyPin).toEqual({ version: 2, digest: f.policy.prepared.recordId });
    return retained;
  });
  mock.restore();
  const paused = Promise.withResolvers<void>();
  const consumer = mock(async () => {
    expect(f.store.db.inTransaction).toBe(false);
    await paused.promise;
    return new TextDecoder().decode(encodeTransferJson(candidate.payload));
  });
  const pending = consumer();
  f.store.db
    .query("UPDATE runs SET head_sha = ?, title = 'Changed' WHERE id = ?")
    .run("d".repeat(40), f.runId);
  f.store.db.query("UPDATE questions SET answer = 'Changed', answered_at = 100").run();
  appendPolicySupplement(f.store, {
    runId: f.runId,
    record: f.policy.reviewed,
    state: { ...f.state, reviewMode: "single" },
    expectedState: f.state,
    expected: { version: 2, digest: f.policy.prepared.recordId },
  });
  retained.manifest.headSha = "d".repeat(40);
  retained.manifest.key.repo = "changed/project";
  retained.manifest.blobs.state.size = 999;
  bytes.fill(9);
  // Any delayed semantic read, including raw SQL, is forbidden after capture.
  spyOn(f.store.db, "query").mockImplementation(() => {
    throw new Error("late source read");
  });
  paused.resolve();
  const serialized = await pending;
  expect(consumer).toHaveBeenCalledTimes(1);
  expect(candidate.payload.run).toMatchObject({ title: "Original request", headSha: head });
  expect(candidate.payload.questions.map((q) => q.answer)).toEqual(["Yes", null]);
  expect(candidate.payload.policy.history.map((p) => p.version)).toEqual([1, 2]);
  expect(candidate.payload.commits).toEqual([head, sha].sort());
  expect(candidate.context).toMatchObject({
    policyPin: { version: 2, digest: f.policy.prepared.recordId },
    manifest: { headSha: head, key: { repo: "example/project" }, blobs: { state: { size: 10 } } },
  });
  expect(candidate.context.byteInputs?.[0]).toEqual(new Uint8Array([1, 2, 3]));
  expect(serialized).not.toContain("Changed");
});

test("maps independent unsorted IDs and every nested verifier binding while preserving sentinel and null references", () => {
  const f = setup();
  for (const name of ["listStages", "listInvocations", "listQuestions"] as const) {
    const original = f.store[name].bind(f.store);
    spyOn(f.store, name).mockImplementation(((id: string) => original(id).reverse()) as Store[typeof name]);
  }
  const model = {
    overall: "pass",
    notes: "saved",
    criteria: [
      {
        id: "AC-1",
        status: "met",
        evidence: "recorded",
        gateEvidence: { stageId: 900, sha, check: "test", command: "bun test" },
      },
    ],
  };
  const verified = { ...model, modelId: "fake/model", modelOutput: model };
  f.store.setRunState(f.runId, {
    ...f.state,
    lastVerify: verified,
    pendingVerify: { round: 2, attempt: 4, sha, modelId: "fake/model", modelOutput: model },
    verifyResults: [{ ...verified, round: 2 }],
    lastVerifiedEvidence: { lastVerify: verified },
    gateEvidence: { stageId: 31, sha, checks: [] },
    coveringTestRuns: [{ stageId: 0, file: "a.ts", name: "refused", verifiedSha: sha, round: 2 }],
  });
  const { payload: p, ordinals } = f.capture();
  expect([...ordinals.stages]).toEqual([
    [31, 1],
    [900, 2],
  ]);
  expect([...ordinals.invocations]).toEqual([
    [31, 1],
    [721, 2],
  ]);
  expect([...ordinals.questions]).toEqual([
    [31, 1],
    [101, 2],
  ]);
  expect(p.invocations.map((i) => i.stageOrdinal)).toEqual([null, 2]);
  expect(p.jobs.map((j) => [j.id, j.invocationOrdinal])).toEqual([
    ["current-job", 2],
    ["old-job", 1],
  ]);
  expect(p.run.id).toBe(f.runId);
  expect(p.jobs.map((j) => j.run_id)).toEqual([f.runId, null]);
  const s = p.state;
  const bindings = [
    s.lastVerify,
    s.lastVerify?.modelOutput,
    s.pendingVerify?.modelOutput,
    s.verifyResults?.[0],
    s.verifyResults?.[0]?.modelOutput,
    s.lastVerifiedEvidence?.lastVerify,
    s.lastVerifiedEvidence?.lastVerify?.modelOutput,
  ];
  expect(bindings.map((v) => v?.criteria[0]?.gateEvidence)).toEqual(
    Array(7).fill({ stageOrdinal: 2, sha, check: "test", command: "bun test" }),
  );
  expect(s.gateEvidence?.stageOrdinal).toBe(1);
  expect(s.coveringTestRuns?.[0]?.stageOrdinal).toBe(0);
});

test.each(["stage", "invocation", "saved-binding"])("fails closed on dangling %s references", (which) => {
  const f = setup();
  if (which === "stage") {
    f.store.db.exec("PRAGMA foreign_keys = OFF");
    f.store.db.query("UPDATE invocations SET stage_id = 999").run();
  }
  if (which === "invocation") f.store.db.query("UPDATE agent_jobs SET invocation_id = 999").run();
  if (which === "saved-binding")
    f.store.setRunState(f.runId, {
      ...f.state,
      pendingVerify: {
        round: 2,
        attempt: 1,
        sha,
        modelId: "fake/model",
        modelOutput: {
          overall: "pass",
          notes: "",
          criteria: [
            {
              id: "AC-1",
              status: "met",
              evidence: "",
              gateEvidence: { stageId: 999, sha, check: "test", command: "bun test" },
            },
          ],
        },
      },
    });
  rejects(f.capture);
});

test("preserves partial usage, exhausted attempts, totals and all questions without mutations or publications", () => {
  const f = setup();
  const before = sourceRows(f.store),
    published = mock();
  f.store.subscribe(published);
  const { payload: p } = f.capture();
  expect(p.run).toMatchObject({ costUsd: 90, tokensIn: 9999, status: "queued", finishedAt: null });
  expect(p.invocations[0]).toMatchObject({
    status: "running",
    finishedAt: null,
    costUsd: 0.5,
    costEquivUsd: 1,
    inputTokens: 8,
    outputTokens: 9,
    numTurns: 1,
  });
  expect(p.jobs.map((j) => [j.state, j.attempt, j.attempt_deadline_at, j.failure_reason])).toEqual([
    ["failed", 7, 123, "exhausted"],
    ["failed", 7, 123, "exhausted"],
  ]);
  expect(p.questions).toEqual([
    {
      ordinal: 1,
      runId: f.runId,
      question: "Answered?",
      answer: "Yes",
      askedAt: 25,
      answeredAt: 26,
      answeredBy: "human",
    },
    {
      ordinal: 2,
      runId: f.runId,
      question: "Open?",
      answer: null,
      askedAt: 65,
      answeredAt: null,
      answeredBy: null,
    },
  ]);
  expect(sourceRows(f.store)).toEqual(before);
  expect(published).not.toHaveBeenCalled();
});

test("redacts descriptive text and excludes unrelated resources, requests, leases and logs", () => {
  const f = setup();
  const secret = ["snapshot", "credential-long"].join("-");
  registerCredential("SNAPSHOT_DESCRIPTION", secret);
  f.store.db.query("UPDATE runs SET prompt = ? WHERE id = ?").run(`Request ${secret}`, f.runId);
  f.store.db.query("UPDATE questions SET answer = ? WHERE id = 31").run(secret);
  f.store.db.query("INSERT INTO agent_job_events VALUES ('current-job', 1, ?, 1)").run(excluded);
  f.store.setSetting("private", excluded);
  f.store.createRun(f.repo, { repo: f.repo.slug, prompt: excluded });
  f.store.addEvent({ runId: f.runId, type: "text", message: excluded, data: { text: excluded } });
  f.store.db.query("UPDATE agent_jobs SET result = ? WHERE id = 'current-job'").run(
    JSON.stringify({
      status: "error",
      finalText: `Recorded ${secret}`,
      structured: { description: secret },
      usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 },
      numTurns: 1,
      costUsd: 0.1,
      costEquivUsd: 0.2,
      error: secret,
      sessionId: excluded,
    }),
  );
  f.store.setRunState(f.runId, {
    ...f.state,
    feedback: secret,
    gateExecution: {
      stage: "gates",
      round: 2,
      purpose: "candidate",
      sha,
      handle: {
        kind: "github-actions",
        id: "historical",
        startedAt: 1,
        githubActions: {
          cwd: excluded,
          repo: f.repo.slug,
          candidate: "candidate",
          dispatch: "dispatch",
          headSha: head,
        },
      },
    },
  });
  const { payload: p } = f.capture();
  expect(p.run.prompt).toBe("Request [redacted]");
  expect(p.questions[0]?.answer).toBe("[redacted]");
  expect(p.state.feedback).toBe("[redacted]");
  expect(p.jobs[0]?.result).toMatchObject({
    finalText: "Recorded [redacted]",
    error: "[redacted]",
    structured: { description: "[redacted]" },
  });
  expect(p.state.gateExecution?.identity).toEqual({
    executorKind: "github-actions",
    id: "historical",
    startedAt: 1,
  });
  const text = new TextDecoder().decode(encodeTransferJson(p));
  expect(text).not.toContain(secret);
  expect(text).not.toContain(excluded);
  for (const key of [
    "worktreePath",
    "worktreeAliases",
    "baseline",
    "baselineCached",
    "sessionId",
    "request",
    "lease_expires_at",
  ])
    expect(text).not.toContain(`"${key}"`);
});

test("redacts acceptance ticket and parent bodies and manifest descriptions without changing source records", () => {
  const f = setup();
  const secret = ["snapshot", "acceptance-credential"].join("-");
  registerCredential("SNAPSHOT_ACCEPTANCE_DESCRIPTION", secret);
  f.store.setRunState(f.runId, {
    ...f.state,
    acceptance: {
      snapshot: {
        ticket: {
          number: 2,
          body: `Ticket ${secret}`,
          author: { login: "ticket-author" },
          parent: { number: 1, body: `Nested parent ${secret}`, author: null },
        },
        parent: { number: 1, body: `Parent ${secret}`, author: null },
      },
      manifest: [
        {
          id: "U1",
          text: `Description ${secret}`,
          item: `Item ${secret}`,
          class: "behaviour",
          sources: ["#1"],
        },
      ],
    },
  });
  const before = sourceRows(f.store);
  const { payload } = f.capture();
  expect(payload.state.acceptance).toEqual({
    snapshot: {
      ticket: {
        number: 2,
        body: "Ticket [redacted]",
        author: { login: "ticket-author" },
        parent: { number: 1, body: "Nested parent [redacted]", author: null },
      },
      parent: { number: 1, body: "Parent [redacted]", author: null },
    },
    manifest: [
      {
        id: "U1",
        text: "Description [redacted]",
        item: "Item [redacted]",
        class: "behaviour",
        sources: ["#1"],
      },
    ],
  });
  expect(new TextDecoder().decode(encodeTransferJson(payload))).not.toContain(secret);
  expect(sourceRows(f.store)).toEqual(before);
});

test.each(["login", "id"])("refuses credential-bearing acceptance %s identities", (field) => {
  const f = setup();
  const secret = `snapshot-acceptance-${field}-credential`;
  registerCredential(`SNAPSHOT_ACCEPTANCE_${field}`, secret);
  f.store.setRunState(f.runId, {
    ...f.state,
    acceptance: {
      snapshot: {
        ticket: { number: 2, body: "Ticket", author: { login: field === "login" ? secret : "author" } },
        parent: { number: 1, body: "Parent", author: null },
      },
      manifest: [{ id: field === "id" ? secret : "U1", text: "Description", class: "docs", sources: ["#1"] }],
    },
  });
  rejects(f.capture, "invalid");
});

test("local execution history carries no attach handle and short descriptive credentials are redacted", () => {
  const f = setup(),
    secret = ["t!", "k"].join("");
  registerCredential("SNAPSHOT_SHORT", secret);
  f.store.setRunState(f.runId, {
    ...f.state,
    feedback: `prefix ${secret} suffix`,
    gateExecution: {
      stage: "gates",
      round: 2,
      purpose: "candidate",
      sha,
      handle: { kind: "local", id: "local-history", startedAt: 10 },
    },
  });
  const { payload } = f.capture();
  expect(payload.state.feedback).toBe("prefix [redacted] suffix");
  expect(payload.state.gateExecution).toEqual({
    stage: "gates",
    round: 2,
    purpose: "candidate",
    sha,
    identity: { executorKind: "local", id: "local-history", startedAt: 10 },
  });
});

test.each(["identity", "command", "policy", "context", "adapter", "callback"])(
  "refuses %s safely without payload-bearing diagnostics",
  (which) => {
    const secret = `secret-${which}-snapshot-value`;
    const policy = policyFixture();
    if (which === "policy") {
      policy.prepared = seal({
        ...policy.prepared,
        fields: { ...policy.prepared.fields, slottedCommands: [["echo", secret]] },
      });
    }
    const f = setup(policy);
    registerCredential(`SNAPSHOT_${which}`, secret);
    let capture = f.capture;
    if (which === "identity")
      f.store.db.query("UPDATE runs SET branch = ? WHERE id = ?").run(secret, f.runId);
    if (which === "command") f.store.setRunState(f.runId, { ...f.state, toolCommands: [`echo ${secret}`] });
    if (which === "adapter")
      f.store.setRunState(f.runId, {
        ...f.state,
        gateExecution: {
          stage: "gates",
          round: 2,
          purpose: "candidate",
          sha,
          handle: { kind: "unknown", id: "historical", startedAt: 1 },
        },
      });
    if (which === "context" || which === "callback")
      capture = () =>
        captureRunTransferSnapshot(f.store, f.runId, (source) => {
          if (which === "callback") throw new Error(secret, { cause: { payload: secret } });
          const context = f.context(source);
          context.manifest.createdBy = secret;
          return context;
        });
    rejects(capture, which === "adapter" ? "unsupported" : "invalid");
    try {
      capture();
    } catch (error) {
      expect(`${String(error)}${JSON.stringify(error, Object.getOwnPropertyNames(error))}`).not.toContain(
        secret,
      );
      expect(error).not.toHaveProperty("cause");
    }
  },
);

test.each(["primary", "owner", "state", "selection", "history"])(
  "rejects %s preconditions before any object operation",
  (which) => {
    const f = setup();
    const child = which === "owner" ? followUp(f) : null;
    if (which === "primary" || which === "owner")
      f.store.db
        .query("UPDATE runs SET depends_on = ? WHERE id = ?")
        .run('["other-run"]', child?.ownerId ?? f.runId);
    if (which === "state") f.store.db.query("UPDATE runs SET state_json = NULL WHERE id = ?").run(f.runId);
    if (which === "selection")
      f.store.db.query("DELETE FROM run_policy_selections WHERE run_id = ?").run(f.runId);
    if (which === "history") {
      f.store.db.exec("PRAGMA foreign_keys = OFF");
      f.store.db.query("UPDATE run_policy_selections SET selected_version = 3 WHERE run_id = ?").run(f.runId);
    }
    const before = sourceRows(f.store),
      objectConsumer = mock();
    rejects(
      () => {
        const candidate = (child?.capture ?? f.capture)();
        objectConsumer(candidate);
      },
      which === "primary" || which === "owner" ? "unsupported" : "incomplete",
    );
    expect(objectConsumer).not.toHaveBeenCalled();
    expect(sourceRows(f.store)).toEqual(before);
  },
);
test("ordinary and server-authorized follow-up snapshots are supported, missing runs are precise", () => {
  const f = setup();
  expect(f.capture().payload).not.toHaveProperty("followUp");
  const child = followUp(f);
  expect(child.capture().payload.followUp).toMatchObject({
    ownerId: child.ownerId,
    runId: f.runId,
    reviewedSha: sha,
    round: 3,
    createdAt: 80,
    owner: { id: child.ownerId },
  });
  rejects(() => captureRunTransferSnapshot(f.store, "absent", f.context), "missing");
});

function proseState() {
  const verification = {
    verdict: "CONFIRMED",
    evidence: "Evidence",
    trigger: "Trigger",
    severity: "high",
    category: "correctness",
    attribution: "introduced",
    attributionEvidence: {
      change: "Change",
      obligation: "Obligation",
      obligationSource: "Source",
      base: { setup: "ok", result: "Base result" },
      head: "Head explanation",
    },
  };
  const finding = {
    severity: "major",
    file: "a.ts",
    line: 1,
    title: "Finding",
    detail: "Detail",
    suggestion: "Suggestion",
    failure_scenario: "Scenario",
    verification,
    duplicates: [
      {
        finder: 1,
        line: 1,
        title: "Duplicate",
        detail: "Detail",
        suggestion: "Suggestion",
        failure_scenario: "Scenario",
      },
    ],
  };
  const review = {
    verdict: "request_changes",
    summary: "Saved review",
    findings: [finding],
    modelId: "fake/model",
    checklist: [{ item: "Item", applies: "Applies", checked: "Checked", finding: "Finding" }],
    panel: {
      reports: [{ summary: "Report", findings: [finding] }],
      candidates: [{ ...finding, id: "C1", finder: 1, vendor: "fake" }],
      verdicts: [{ ...verification, id: "C1" }],
      refuted: [],
      capped: [],
      warnings: ["Warning"],
    },
  };
  const history = [{ round: 1, sha, blocking: [finding], followUps: [finding] }];
  const state = {
    spec: {
      summary: "Spec",
      assumptions: ["Assumption"],
      requirements: ["Requirement"],
      acceptance_criteria: [{ id: "AC-1", criterion: "Criterion", how_to_verify: "bun test" }],
      out_of_scope: ["Excluded"],
      blocking_questions: ["Question"],
    },
    lastReview: review,
    reviewHistory: history,
    reviewFollowUps: [finding],
    lastVerifiedEvidence: { lastReview: review, reviewHistory: history },
    completedChecks: { round: 2, values: { review } },
    acceptance: {
      snapshot: {
        ticket: { number: 2, body: "Ticket", author: null },
        parent: { number: 1, body: "Parent", author: null },
      },
      outcome: {
        sha,
        units: [{ unit: "U1", verdict: "unmet", citations: [], refusals: ["Refusal"] }],
        summary: "Outcome",
        passed: false,
      },
    },
    sizeReport: { unavailable: "Unavailable" },
  };
  return JSON.parse(JSON.stringify(state)) as typeof state;
}
function replacePath(value: object, path: string, text: string) {
  const keys = path.split(".");
  const key = keys.pop();
  let parent: object = value;
  for (const part of keys) {
    const child: unknown = Reflect.get(parent, part);
    if (!child || typeof child !== "object") throw new Error("Missing fixture path");
    parent = child;
  }
  if (!key || !Object.hasOwn(parent, key)) throw new Error("Missing fixture field");
  Reflect.set(parent, key, text);
}
const prosePaths = [
  "spec.acceptance_criteria.0.criterion",
  "spec.requirements.0",
  "spec.assumptions.0",
  "spec.out_of_scope.0",
  "spec.blocking_questions.0",
  "lastReview.findings.0.suggestion",
  "lastReview.findings.0.failure_scenario",
  "lastReview.findings.0.verification.trigger",
  "lastReview.findings.0.verification.attributionEvidence.change",
  "lastReview.findings.0.verification.attributionEvidence.obligation",
  "lastReview.findings.0.verification.attributionEvidence.obligationSource",
  "lastReview.findings.0.verification.attributionEvidence.base.result",
  "lastReview.findings.0.verification.attributionEvidence.head",
  "lastReview.checklist.0.item",
  "lastReview.checklist.0.applies",
  "lastReview.checklist.0.checked",
  "lastReview.checklist.0.finding",
  "lastReview.panel.warnings.0",
  "lastReview.panel.verdicts.0.trigger",
  "lastReview.panel.verdicts.0.attributionEvidence.head",
  "lastReview.panel.reports.0.findings.0.suggestion",
  "lastReview.panel.candidates.0.failure_scenario",
  "lastReview.findings.0.duplicates.0.suggestion",
  "lastReview.findings.0.duplicates.0.failure_scenario",
  "reviewHistory.0.blocking.0.suggestion",
  "reviewHistory.0.followUps.0.failure_scenario",
  "reviewFollowUps.0.suggestion",
  "lastVerifiedEvidence.lastReview.findings.0.suggestion",
  "lastVerifiedEvidence.reviewHistory.0.blocking.0.verification.attributionEvidence.head",
  "completedChecks.values.review.findings.0.suggestion",
  "acceptance.outcome.units.0.refusals.0",
  "sizeReport.unavailable",
];
test.each(prosePaths)("redacts supported prose at %s without changing source or other values", (path) => {
  const f = setup();
  const state = { ...f.state, ...structuredClone(proseState()) };
  f.store.setRunState(f.runId, state);
  const expected = f.capture().payload;
  const secret = ["snapshot", "schema-prose-credential"].join("-");
  registerCredential("SNAPSHOT_SCHEMA_PROSE", secret);
  replacePath(state, path, `Recorded ${secret}`);
  f.store.setRunState(f.runId, state);
  const before = sourceRows(f.store);
  replacePath(expected.state, path, "Recorded [redacted]");
  const { payload } = f.capture();
  expect(payload).toEqual(expected);
  expect(new TextDecoder().decode(encodeTransferJson(payload))).not.toContain(secret);
  expect(sourceRows(f.store)).toEqual(before);
});

test("distinguishes attribution head prose from immutable commit head identity", () => {
  const f = setup();
  const state = { ...f.state, ...structuredClone(proseState()) };
  const secret = ["12c4", "5d67"].join("");
  const oid = secret + "e".repeat(32);
  replacePath(state, "lastReview.findings.0.verification.attributionEvidence.head", `Observed ${oid}`);
  f.store.setRunState(f.runId, state);
  expect(f.capture().payload.state.lastReview).toBeDefined();
  registerCredential("SNAPSHOT_HEAD_SUBSTRING", secret);
  expect(f.capture().payload.state.lastReview?.findings[0]?.verification?.attributionEvidence?.head).toBe(
    `Observed [redacted]${"e".repeat(32)}`,
  );
  f.store.setRunState(f.runId, {
    ...state,
    sizeReport: { base: sha, head: oid, mode: "two-dot", error: "Unavailable" },
  });
  rejects(f.capture, "invalid");
  try {
    f.capture();
  } catch (error) {
    expect(`${String(error)}${JSON.stringify(error, Object.getOwnPropertyNames(error))}`).not.toContain(
      secret,
    );
    expect(error).not.toHaveProperty("cause");
  }
});

test("explicit projections never read excluded columns and callback gets only repository kind and slug", () => {
  const f = setup();
  f.store.setRepoProfile(f.repo.id, { private: excluded });
  for (const [table, denied] of [
    ["repos", ["profile_json", "local_path"]],
    ["invocations", ["session_id"]],
    ["agent_jobs", ["request"]],
  ] as const) {
    const columns = f.store.db.query<{ name: string }, []>(`PRAGMA main.table_info(${table})`).all();
    f.store.db.exec(
      `CREATE TEMP VIEW ${table} AS SELECT ${columns
        .map(({ name }) =>
          (denied as readonly string[]).includes(name)
            ? `json('read-trap:' || COALESCE(${name}, '')) AS ${name}`
            : name,
        )
        .join(",")} FROM main.${table}`,
    );
    for (const column of [...denied, "*"]) {
      expect(() => f.store.db.query(`SELECT ${column} FROM ${table}`).all()).toThrow();
    }
  }
  const context = mock((source: SnapshotSourceContext) => {
    expect(f.store.db.inTransaction).toBe(true);
    expect(source.repository).toEqual({ kind: "github", slug: "example/project" });
    return f.context(source);
  });
  expect(captureRunTransferSnapshot(f.store, f.runId, context).payload.invocations).toHaveLength(2);
  expect(context).toHaveBeenCalledTimes(1);
});

test.each(["object key", "unclassified prose name", "spec command"])(
  "refuses credentials in %s without exposing payloads",
  (which) => {
    const f = setup();
    const secret = ["snapshot", "unclassified-credential"].join("-");
    registerCredential("SNAPSHOT_UNCLASSIFIED", secret);
    if (which === "spec command") {
      const state = { ...f.state, ...proseState() };
      replacePath(state, "spec.acceptance_criteria.0.how_to_verify", `echo ${secret}`);
      f.store.setRunState(f.runId, state);
    } else {
      f.store.db
        .query("UPDATE runs SET source_ref = ? WHERE id = ?")
        .run(
          JSON.stringify(which === "object key" ? { [secret]: "value" } : { description: secret }),
          f.runId,
        );
    }
    rejects(f.capture, "invalid");
    try {
      f.capture();
    } catch (error) {
      expect(`${String(error)}${JSON.stringify(error, Object.getOwnPropertyNames(error))}`).not.toContain(
        secret,
      );
      expect(error).not.toHaveProperty("cause");
    }
  },
);
