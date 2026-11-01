import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATION_DIR, runMigrations } from "../src/db/migration-runner.ts";
import {
  readOfflineProjection,
  readProjectionIds,
  readProjectionSemantics,
  writeOfflineProjection,
} from "../src/db/portable-projection.ts";
import { Store } from "../src/db/store.ts";
import { initialRunState, type RunState } from "../src/pipeline/context.ts";
import type { PortableManifest } from "../src/pipeline/portable.ts";
import { encodeRunPayload } from "../src/pipeline/run-transfer-schema.ts";
import { policyFixture } from "./run-transfer-policy-support.ts";
import { fixture, followUpFixture, head, repo, sha } from "./run-transfer-support.ts";

function portable() {
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
  const policy = policyFixture();
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
let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => {
  store.close();
});
function existing() {
  const r = store.upsertRepo({
    slug: "EXAMPLE/Project",
    kind: "github",
    url: "https://github.com/EXAMPLE/Project",
    localPath: null,
    defaultBranch: "trunk",
    mergePolicy: "auto",
  });
  store.db.query("UPDATE repos SET profile_json = ? WHERE id = ?").run('{"ordinary":true}', r.id);
  const run = store.createRun(r, { repo: r.slug, prompt: "Ordinary run" });
  for (let i = 0; i < 2; i++) {
    const stage = store.startStage(run.id, "review");
    store.createInvocation({
      runId: run.id,
      stageId: stage.id,
      role: "review",
      harness: "fake",
      provider: "fake",
      model: "fake",
      modelId: "fake/model",
    });
    store.askQuestion(run.id, "Existing question");
  }
  return run;
}
function snapshot() {
  const tables = store.db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => [name, store.db.query(`SELECT * FROM "${name}"`).all()]),
  );
}

test("colliding ordinals allocate local IDs and preserve repository bindings, questions and nested semantics", () => {
  const preexisting = existing(),
    before = snapshot(),
    payload = portable();
  let notifications = 0;
  store.subscribe(() => {
    notifications++;
  });
  const forbidden = [
    "createRun",
    "updateRun",
    "setRunState",
    "startStage",
    "createInvocation",
    "askQuestion",
    "refreshRunTotals",
  ] as const;
  const spies = forbidden.map((name) =>
    spyOn(store, name).mockImplementation(() => {
      throw new Error(`Forbidden ${name}`);
    }),
  );
  try {
    const ids = store.db.transaction(() => writeOfflineProjection(store.db, payload))();
    expect(readProjectionIds(store.db, payload.run.id)).toEqual(ids);
    expect([...ids.stages]).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect([...ids.invocations]).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect([...ids.questions]).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(store.getRun(payload.run.id)?.repoId).toBe(preexisting.repoId);
    expect(store.db.query("SELECT * FROM repos").all()).toEqual(before.repos ?? []);
    expect(store.getRun(preexisting.id)).toEqual(preexisting);
    expect(store.getQuestion(3)).toEqual({
      id: 3,
      runId: "child01",
      question: "Answered?",
      answer: "Yes",
      answeredBy: "human",
      askedAt: 25,
      answeredAt: 26,
    });
    expect(store.getQuestion(4)).toEqual({
      id: 4,
      runId: "child01",
      question: "Open?",
      answer: null,
      answeredBy: null,
      askedAt: 65,
      answeredAt: null,
    });
    expect(store.listQuestions("child01").map((q) => q.id)).toEqual([3, 4]);
    expect(
      store.db
        .query("SELECT stage_id, session_id FROM invocations WHERE run_id = ? ORDER BY id")
        .all("child01"),
    ).toEqual([
      { stage_id: null, session_id: null },
      { stage_id: 4, session_id: null },
    ]);
    const semantic = readProjectionSemantics(store.db, "child01");
    expect(semantic?.state.gateEvidence?.stageOrdinal).toBe(4);
    expect(semantic?.state.coveringTestRuns?.map((r) => r.stageOrdinal)).toEqual([0, 3]);
    for (const v of [
      semantic?.state.lastVerify,
      semantic?.state.lastVerifiedEvidence?.lastVerify,
      ...(semantic?.state.verifyResults ?? []),
    ]) {
      expect(v?.criteria[0]?.gateEvidence?.stageOrdinal).toBe(3);
      expect(v?.modelOutput?.criteria[0]?.gateEvidence?.stageOrdinal).toBe(3);
    }
    expect(semantic?.state.pendingVerify?.modelOutput.criteria[0]?.gateEvidence?.stageOrdinal).toBe(3);
    expect(semantic?.jobs.map((j) => [j.state, j.invocationOrdinal])).toEqual([
      ["leased", 3],
      ["queued", 4],
    ]);
    expect(semantic?.state.gateExecution).toEqual(payload.state.gateExecution);
    expect(semantic?.followUp).toEqual(payload.followUp);
    expect(readOfflineProjection(store.db, "child01")).toEqual(payload);
    expect(
      store.db
        .query("SELECT selected_version, selected_digest FROM run_policy_selections WHERE run_id = 'child01'")
        .get(),
    ).toEqual({ selected_version: 4, selected_digest: payload.policy.history[3]?.recordId });
    expect(
      store.db
        .query(
          "SELECT status, created_at, started_at, finished_at, tokens_in, tokens_out, cost_usd, cost_equiv_usd, state_json FROM runs WHERE id = 'child01'",
        )
        .get(),
    ).toEqual({
      status: "running",
      created_at: 11,
      started_at: 12,
      finished_at: null,
      tokens_in: 1234,
      tokens_out: 98,
      cost_usd: 1.25,
      cost_equiv_usd: 8.5,
      state_json: null,
    });
    expect(store.getRun("owner01")).toBeNull();
    const after = snapshot();
    const changed = new Set([
      "sqlite_sequence",
      "runs",
      "stages",
      "invocations",
      "questions",
      "run_projection_ids",
      "run_projections",
      "run_policy_versions",
      "run_policy_selections",
    ]);
    for (const [name, values] of Object.entries(before))
      if (!changed.has(name)) expect(after[name]).toEqual(values);
    for (const name of ["stages", "invocations", "questions"])
      expect(after[name]?.slice(0, 2)).toEqual(before[name]);
    expect(notifications).toBe(0);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
test("missing repository gets an inert local skeleton and optional run absences survive inverse reading", () => {
  const payload = portable();
  delete payload.run.titleProvenance;
  delete payload.run.flow;
  delete payload.run.noBaselineCache;
  delete payload.run.githubWait;
  delete payload.run.models;
  delete payload.run.allow;
  store.db.transaction(() => writeOfflineProjection(store.db, payload))();
  const local = store.listRepos()[0];
  expect(local).toMatchObject({
    slug: "example/project",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
    createdAt: 11,
  });
  expect(local?.id).not.toBe(repo.id);
  expect(store.getRun("child01")?.repoId).toBe(local?.id);
  expect(readOfflineProjection(store.db, "child01")).toEqual(payload);
  expect(readOfflineProjection(store.db, "absent")).toBeNull();
  const question = store.askQuestion("child01", "Ordinary publication resumes");
  expect(store.db.query("SELECT dedupe_key FROM feed").all()).toEqual([
    { dedupe_key: `run.question:${question.id}` },
  ]);
});
test("transaction requirement, duplicate conflict and a late write failure leave no partial history", () => {
  const payload = portable(),
    before = snapshot();
  let notifications = 0;
  store.subscribe(() => {
    notifications++;
  });
  expect(() => writeOfflineProjection(store.db, payload)).toThrow("enclosing transaction");
  expect(snapshot()).toEqual(before);
  expect(store.db.query("SELECT name FROM sqlite_temp_master WHERE type = 'trigger'").all()).toEqual([]);
  store.db.exec(
    "CREATE TRIGGER fail_projection BEFORE INSERT ON run_projections BEGIN SELECT RAISE(ABORT, 'Late write failure'); END",
  );
  expect(() => store.db.transaction(() => writeOfflineProjection(store.db, payload))()).toThrow(
    "Late write failure",
  );
  expect(snapshot()).toEqual(before);
  store.db.exec("DROP TRIGGER fail_projection");
  store.db.transaction(() => writeOfflineProjection(store.db, payload))();
  const saved = snapshot();
  expect(() => store.db.transaction(() => writeOfflineProjection(store.db, payload))()).toThrow();
  expect(snapshot()).toEqual(saved);
  expect(notifications).toBe(0);
});
test("blocked historical runs do not publish and a successful writer still belongs to its outer rollback", () => {
  const payload = portable();
  payload.run.status = "needs_human";
  const before = snapshot();
  expect(() =>
    store.db.transaction(() => {
      writeOfflineProjection(store.db, payload);
      expect(store.db.inTransaction).toBe(true);
      expect(store.db.query("SELECT * FROM feed").all()).toEqual([]);
      throw new Error("Caller rolls back");
    })(),
  ).toThrow("Caller rolls back");
  expect(snapshot()).toEqual(before);
  expect(store.db.query("SELECT name FROM sqlite_temp_master WHERE type = 'trigger'").all()).toEqual([]);
});
test("additive migration leaves old table layouts and ordinary lifecycle operations working without sidecars", () => {
  const home = mkdtempSync(join(tmpdir(), "projection-migration-"));
  const migrations = join(home, "migrations");
  cpSync(MIGRATION_DIR, migrations, {
    recursive: true,
    filter: (p) => !p.endsWith("-portable-projection.sql"),
  });
  const old = new Store(":memory:", migrations);
  try {
    const r = old.upsertRepo({
      slug: "other/project",
      kind: "github",
      url: null,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const run = old.createRun(r, { repo: r.slug, prompt: "Ordinary" });
    const names = old.db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    const layouts = () => names.map(({ name }) => old.db.query(`PRAGMA table_info("${name}")`).all());
    const before = layouts();
    runMigrations(old.db);
    expect(layouts()).toEqual(before);
    expect(old.getRun(run.id)).toEqual(run);
    expect(old.updateRun(run.id, { status: "waiting_input" }).status).toBe("waiting_input");
    const question = old.askQuestion(run.id, "Still ordinary?");
    expect(old.getQuestion(question.id)?.question).toBe("Still ordinary?");
    expect(readOfflineProjection(old.db, run.id)).toBeNull();
    for (const table of [
      "run_projections",
      "run_projection_ids",
      "run_policy_versions",
      "run_policy_selections",
    ])
      expect(old.db.query(`SELECT * FROM ${table}`).all()).toEqual([]);
  } finally {
    old.close();
    rmSync(home, { recursive: true, force: true });
  }
});
