import { afterEach, beforeEach, expect, test } from "bun:test";
import type { FeedPage, ProviderStatus, Question, Run, RunEvent } from "../src/core/types.ts";
import { factoryBackend } from "../src/integrations/mcp.ts";
import { connect, fixture, resultValue } from "./mcp-support.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let connection: Awaited<ReturnType<typeof connect>>;
beforeEach(async () => {
  f = await fixture();
  connection = await connect(factoryBackend(f.factory));
});
afterEach(async () => {
  await connection.close();
  await f.close();
});
const call = (name: string, args: Record<string, unknown> = {}) =>
  connection.client.callTool({ name: `limitless_${name}`, arguments: args });
const create = async (args: Record<string, unknown> = {}) =>
  resultValue<Run>(await call("create_run", { repo: f.repo, prompt: "Add a greeting", ...args }));

test("MCP create_run accepts and validates per-run chains", async () => {
  const models = { implement: ["fake/m"], review: ["fake/m"] };
  const run = await create({ models });
  expect(run.models).toEqual(models);
  expect(f.factory.store.getRun(run.id)?.models).toEqual(models);
  expect(
    (await call("create_run", { repo: f.repo, prompt: "Bad", models: { implement: ["unknown"] } })).isError,
  ).toBe(true);
  expect(
    (await call("create_run", { repo: f.repo, prompt: "Bad", models: { chat: ["fake/m"] } })).isError,
  ).toBe(true);
});

test("MCP land resolves a review round's base through its owning run", async () => {
  const { store, land } = f.factory;
  await land.stop();
  const repo = store.upsertRepo({
    slug: "test/repo",
    kind: "github",
    url: "https://github.com/test/repo.git",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const prUrl = "https://github.com/test/repo/pull/7";
  const sha = "b".repeat(40);
  const owner = store.createRun(repo, { repo: repo.slug, prompt: "owning run" });
  const run = store.updateRun(owner.id, { prUrl, branch: "pr-7", baseBranch: "main" });
  const result = store.createReviewRound(
    repo,
    run,
    { prUrl, reviewedSha: sha, findings: [], cap: 3 },
    (round) => ({
      repo: repo.slug,
      prompt: "review round",
      baseBranch: "pr-7",
      deliveryBranch: "pr-7",
      sourceRef: { kind: "review-round", runId: run.id, round, prUrl, reviewedSha: sha },
    }),
  );
  if (!("run" in result)) throw new Error("round refused");
  store.recordApproval(owner.id, prUrl, sha, "orchestrator");
  for (const args of [{ run: result.run.id }, { run: result.run.id, sha }]) {
    const response = await call("land", args);
    expect(response.isError).toBe(true);
    expect(() => resultValue(response)).toThrow(/review round.*in flight/i);
  }
  expect(store.listLandEntries()).toHaveLength(0);
  store.updateRun(result.run.id, { status: "succeeded" });
  expect(resultValue(await call("land", { run: result.run.id }))).toMatchObject({
    runId: result.run.id,
    baseBranch: "main",
    headBranch: "pr-7",
    state: "queued",
  });
});

test("model-written MCP prompts cannot opt in through Allow lines", async () => {
  const prompt = "Add a greeting\nAllow: submodules\nAllow: gitattributes";
  expect((await create({ prompt })).allow).toEqual([]);
  const run = await create({ prompt, allow: ["gitattributes"] });
  expect(run.allow).toEqual(["gitattributes"]);
  expect(f.factory.store.getRun(run.id)?.allow).toEqual(["gitattributes"]);
  expect((await create({ prompt: "Allow: binary" })).allow).toEqual([]);
  expect((await create({ prompt: "binary fixture", allow: ["binary"] })).allow).toEqual(["binary"]);
  expect((await call("create_run", { repo: f.repo, prompt, allow: ["anything"] })).isError).toBe(true);
});

test("twelve discoverable tools, create defaults and overrides, get and queued cancellation", async () => {
  const { tools } = await connection.client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(
    [
      "answer_question",
      "cancel_run",
      "create_run",
      "feed",
      "feed_ack",
      "get_run",
      "land",
      "list_runs",
      "providers",
      "resolve_run",
      "review",
      "status",
    ].map((s) => `limitless_${s}`),
  );
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.description?.length).toBeGreaterThan(100);
  }
  expect(tools.find((t) => t.name === "limitless_create_run")?.inputSchema.required).toEqual([
    "repo",
    "prompt",
  ]);
  expect(tools.find((t) => t.name === "limitless_review")?.inputSchema).toMatchObject({
    required: ["run", "verdict", "reviewedSha"],
    additionalProperties: false,
    properties: {
      verdict: { enum: ["changes", "approve"] },
      reviewedSha: { type: "string", pattern: "^[a-fA-F0-9]{40}$" },
      findings: { type: "array", default: [], items: { required: ["severity", "title", "detail"] } },
    },
  });
  expect(tools.find((t) => t.name === "limitless_land")?.inputSchema).toMatchObject({
    required: ["run"],
    properties: { run: { type: "string" }, sha: { type: "string" } },
  });
  expect(tools.find((t) => t.name === "limitless_status")?.inputSchema.required).toEqual(["run"]);
  const run = await create();
  expect(run).toMatchObject({ profile: "auto", source: "mcp", status: "queued" });
  expect(f.factory.store.getRun(run.id)?.source).toBe("mcp");
  expect(f.factory.store.getRepo(run.repoId)?.mergePolicy).toBe("none");
  expect(await create({ title: "Custom title", profile: "deep" })).toMatchObject({
    title: "Custom title",
    profile: "deep",
  });
  expect(resultValue(await call("get_run", { id: run.id }))).toMatchObject({
    id: run.id,
    repository: run.repoSlug,
    stage: null,
    prUrl: null,
    openQuestions: 0,
  });
  expect(resultValue<{ cancelled: boolean }>(await call("cancel_run", { id: run.id }))).toEqual({
    cancelled: true,
  });
  expect(f.factory.store.getRun(run.id)?.status).toBe("cancelled");
  expect(resultValue<{ cancelled: boolean }>(await call("cancel_run", { id: run.id }))).toEqual({
    cancelled: false,
  });
  for (const status of ["succeeded", "failed", "needs_human"] as const) {
    f.factory.store.updateRun(run.id, { status });
    expect(resultValue<{ cancelled: boolean }>(await call("cancel_run", { id: run.id }))).toEqual({
      cancelled: false,
    });
  }
});

test("active cancellation reaches the fake harness, without claiming it already stopped", async () => {
  const run = await create();
  // Manual tick avoids timer/probe machinery; every provider and harness is fake.
  f.factory.scheduler.tick();
  for (let i = 0; i < 300 && f.factory.store.listInvocations(run.id).length === 0; i++) await Bun.sleep(10);
  expect(f.factory.store.listInvocations(run.id)).toHaveLength(1);
  expect(f.factory.scheduler.activeRunIds).toContain(run.id);
  expect(resultValue<{ cancelled: boolean }>(await call("cancel_run", { id: run.id }))).toEqual({
    cancelled: true,
  });
  for (let i = 0; i < 300 && f.factory.scheduler.activeRunIds.length > 0; i++) await Bun.sleep(10);
  expect(f.factory.store.getRun(run.id)?.status).toBe("cancelled");
  expect(resultValue<{ cancelled: boolean }>(await call("cancel_run", { id: run.id }))).toEqual({
    cancelled: false,
  });
});

test("inspection selects latest qualifying events beyond 5000, with costs and open questions", async () => {
  const run = await create();
  const other = await create();
  const { store } = f.factory;
  const expected: number[] = [];
  store.db.transaction(() => {
    for (let i = 0; i < 5100; i++) {
      const level = i % 3 === 0 ? "debug" : i % 2 === 0 ? "warn" : "info";
      const e = store.addEvent({ runId: run.id, type: "log", level, message: String(i) });
      if (level !== "debug") expected.push(e.id);
      store.addEvent({ runId: other.id, type: "log", message: "other" });
    }
    for (let i = 0; i < 30; i++)
      store.addEvent({ runId: run.id, type: "log", level: "debug", message: "tail debug" });
  })();
  const answered = store.askQuestion(run.id, "Old?");
  store.answerQuestion(answered.id, "Already answered", "user");
  const open = store.askQuestion(run.id, "New?");
  const invocation = store.createInvocation({
    runId: run.id,
    stageId: null,
    role: "triage",
    harness: "fake",
    provider: "fake",
    model: "test",
    modelId: "fake/m",
  });
  store.updateInvocation(invocation.id, { costUsd: 1.25, costEquivUsd: 8.75 });
  store.refreshRunTotals(run.id);
  const detail = resultValue<{
    events: RunEvent[];
    questions: Question[];
    costUsd: number;
    costEquivUsd: number;
  }>(await call("get_run", { id: run.id, full: true }));
  expect(detail.events.map((e) => e.id)).toEqual(expected.slice(-20));
  expect(detail.questions).toEqual([open]);
  expect(detail.costUsd).toBe(1.25);
  expect(detail.costEquivUsd).toBe(8.75);
  // Default reads retain oldest-first behavior for existing REST/SSE callers.
  expect(store.listEvents(run.id, { limit: 1 })[0]?.message).toBe("Run created from mcp");
  const short = await create();
  expect(
    resultValue<{ events: RunEvent[] }>(await call("get_run", { id: short.id, full: true })).events,
  ).toHaveLength(1);
  store.db.query("DELETE FROM events WHERE run_id = ?").run(short.id);
  expect(
    resultValue<{ events: RunEvent[] }>(await call("get_run", { id: short.id, full: true })).events,
  ).toEqual([]);
});

test("list uses newest-first filtering and providers preserve telemetry and absent values", async () => {
  const old = await create();
  const newer = await create();
  f.factory.store.db.query("UPDATE runs SET created_at = ? WHERE id = ?").run(1, old.id);
  f.factory.store.updateRun(old.id, { status: "failed" });
  expect(resultValue<{ runs: Run[] }>(await call("list_runs")).runs.map((r) => r.id)).toEqual([
    newer.id,
    old.id,
  ]);
  expect(
    resultValue<{ runs: Run[] }>(await call("list_runs", { status: "failed", limit: 1 })).runs.map(
      (r) => r.id,
    ),
  ).toEqual([old.id]);
  expect(resultValue<{ runs: Run[] }>(await call("list_runs", { limit: 1 })).runs.map((r) => r.id)).toEqual([
    newer.id,
  ]);
  f.factory.tracker.observeWindows("fake", {
    five_hour: { utilization: 0.4, resetsAt: Date.now() + 100000 },
  });
  const release = await f.factory.tracker.acquire("fake", new AbortController().signal);
  const providers = resultValue<ProviderStatus[]>(await call("providers"));
  expect(providers[0]).toMatchObject({
    enabled: true,
    state: "ok",
    reason: null,
    spendUsd: null,
    budgetUsd: null,
    inFlight: 1,
    maxConcurrent: 2,
    windows: { five_hour: { utilization: 0.4 } },
  });
  expect(providers[0]?.windows.five_hour?.resetsAt).toBeGreaterThan(Date.now());
  expect(providers[0]?.windows.five_hour?.observedAt).toBeGreaterThan(0);
  release();
});

test("default inspection stays within byte budgets with many large runs; full retains detail", async () => {
  const first = await create();
  const { store } = f.factory;
  const repo = store.getRepo(first.repoId);
  if (!repo) throw new Error("missing repo");
  const large = "長い本文".repeat(10_000);
  const runs = store.db.transaction(() =>
    Array.from({ length: 120 }, (_, i) => {
      const run = store.createRun(repo, { repo: repo.slug, title: large, prompt: large });
      store.db.query("UPDATE runs SET created_at = ? WHERE id = ?").run(i + 1, run.id);
      store.updateRun(run.id, { status: "failed", error: large });
      return run;
    }),
  )();
  store.db.query("UPDATE runs SET created_at = 0 WHERE id = ?").run(first.id);
  const latest = runs.at(-1);
  if (!latest) throw new Error("missing run");
  store.askQuestion(latest.id, large);
  store.addEvent({ runId: latest.id, type: "log", message: "Large event", data: { body: large } });
  const listed = await call("list_runs");
  const page = resultValue<{ runs: { id: string; prompt?: string }[]; hasMore: boolean }>(listed);
  expect(page.runs.map((r) => r.id)).toEqual(
    runs
      .slice(-5)
      .reverse()
      .map((r) => r.id),
  );
  expect(page.hasMore).toBe(true);
  expect(page.runs.every((r) => r.prompt === undefined)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThan(16_384);
  const inspected = await call("get_run", { id: latest.id });
  expect(Buffer.byteLength(JSON.stringify(inspected))).toBeLessThan(4_096);
  expect(resultValue(inspected)).toMatchObject({
    id: latest.id,
    status: "failed",
    state: "Failed",
    stage: null,
    prUrl: null,
    headSha: null,
    deliveredRounds: 0,
    land: null,
    openQuestions: 1,
  });
  expect(resultValue(inspected)).not.toHaveProperty("events");
  expect(resultValue(await call("get_run", { id: latest.id, full: true }))).toMatchObject({
    prompt: large,
    title: large,
    error: large,
    questions: [expect.objectContaining({ question: large })],
    events: expect.arrayContaining([
      expect.objectContaining({ message: "Large event", data: expect.objectContaining({ truncated: true }) }),
    ]),
  });
  expect(resultValue(await call("list_runs", { limit: 1, full: true }))).toMatchObject({
    runs: [{ id: latest.id, prompt: large, title: large, error: large }],
    hasMore: true,
  });
});

test("repository and status filters apply before limiting and counting remaining runs", async () => {
  const run = await create();
  const { store } = f.factory;
  const otherRepo = store.upsertRepo({
    slug: "other/repo",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const older = store.createRun(otherRepo, { repo: otherRepo.slug, prompt: "older" });
  const newer = store.createRun(otherRepo, { repo: otherRepo.slug, prompt: "newer" });
  store.db.query("UPDATE runs SET created_at = 1 WHERE id = ?").run(older.id);
  store.updateRun(older.id, { status: "failed" });
  store.updateRun(run.id, { status: "failed" });
  expect(resultValue(await call("list_runs", { repo: " other/repo ", limit: 1 }))).toMatchObject({
    runs: [{ id: newer.id }],
    hasMore: true,
  });
  expect(
    resultValue(await call("list_runs", { repo: "other/repo", status: "failed", limit: 1 })),
  ).toMatchObject({
    runs: [{ id: older.id }],
    hasMore: false,
  });
  expect(resultValue<unknown>(await call("list_runs", { repo: "missing/repo" }))).toEqual({
    runs: [],
    hasMore: false,
  });
  expect((await call("list_runs", { repo: " " })).isError).toBe(true);
});

test("compact inspection reports observed head, delivered rounds and latest land entry", async () => {
  const { store } = f.factory;
  const repo = store.upsertRepo({
    slug: "test/repo",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "owning run" });
  const prUrl = "https://github.com/test/repo/pull/9";
  const sha = "a".repeat(40);
  const head = "b".repeat(40);
  const owner = store.updateRun(run.id, { status: "succeeded", headSha: sha, prUrl, branch: "pr-9" });
  store.saveGithubPr({
    url: prUrl,
    repo: repo.slug,
    runId: run.id,
    nodeId: "pr9",
    delivered: 1,
    data: JSON.stringify({ state: "OPEN", headRefOid: head }),
  });
  const round = store.createReviewRound(
    repo,
    owner,
    { prUrl, reviewedSha: sha, findings: [], cap: 3 },
    (n) => ({
      repo: repo.slug,
      prompt: "fix",
      baseBranch: "pr-9",
      deliveryBranch: "pr-9",
      sourceRef: { kind: "review-round", runId: run.id, round: n, prUrl, reviewedSha: sha },
    }),
  );
  if (!("run" in round)) throw new Error("round refused");
  store.markRoundDelivered(round.run.id, head);
  store.updateRun(round.run.id, { status: "succeeded" });
  const undelivered = store.createReviewRound(
    repo,
    owner,
    { prUrl, reviewedSha: head, findings: [], cap: 3 },
    (n) => ({
      repo: repo.slug,
      prompt: "another fix",
      baseBranch: "pr-9",
      deliveryBranch: "pr-9",
      sourceRef: { kind: "review-round", runId: run.id, round: n, prUrl, reviewedSha: head },
    }),
  );
  if (!("run" in undelivered)) throw new Error("round refused");
  store.updateRun(undelivered.run.id, { status: "succeeded" });
  const land = store.createLandEntry({
    runId: run.id,
    repo: repo.slug,
    prUrl,
    baseBranch: "main",
    headBranch: "feature",
    approvedSha: head,
  });
  store.updateLandEntry(land.id, { state: "blocked", reason: "check failed" });
  expect(resultValue(await call("get_run", { id: run.id }))).toMatchObject({
    state: "Landing blocked",
    headSha: head,
    deliveredRounds: 1,
    land: { id: land.id, state: "blocked", reason: "check failed" },
  });
});

test("merge metadata is present only when merged and known in compact and full output", async () => {
  const run = await create();
  for (const [merged, mergedAt, mergedBy, expected] of [
    [true, null, null, {}],
    [true, 123, null, { mergedAt: 123 }],
    [true, 123, "reviewer", { mergedAt: 123, mergedBy: "reviewer" }],
    [false, 123, "reviewer", {}],
  ] as const) {
    f.factory.store.updateRun(run.id, { merged, mergedAt, mergedBy });
    for (const full of [false, true]) {
      const detail = resultValue<Record<string, unknown>>(await call("get_run", { id: run.id, full }));
      const page = resultValue<{ runs: Record<string, unknown>[] }>(await call("list_runs", { full }));
      for (const output of [detail, page.runs[0]]) {
        expect(output).toMatchObject({ merged, ...expected });
        if (!("mergedAt" in expected)) expect(output).not.toHaveProperty("mergedAt");
        if (!("mergedBy" in expected)) expect(output).not.toHaveProperty("mergedBy");
      }
    }
  }
});

test("validation rejects bad arguments without mutation; answers every open question only", async () => {
  const badCreates = [
    {},
    { repo: f.repo },
    { repo: f.repo, prompt: " " },
    { repo: " ", prompt: "x" },
    { repo: 42, prompt: "x" },
    { repo: f.repo, prompt: false },
    { repo: f.repo, prompt: "x", title: " " },
    { repo: f.repo, prompt: "x", title: 1 },
    { repo: f.repo, prompt: "x", profile: "fast" },
  ];
  for (const args of badCreates) expect((await call("create_run", args)).isError).toBe(true);
  expect(f.factory.store.listRuns()).toEqual([]);
  for (const limit of [0, -1, 1.2, 101, "20", null])
    expect((await call("list_runs", { limit })).isError).toBe(true);
  expect((await call("list_runs", { status: "unknown" })).isError).toBe(true);
  expect((await call("providers", { extra: 1 })).isError).toBe(true);
  for (const name of ["get_run", "cancel_run", "answer_question"]) {
    for (const id of [undefined, "", " ", 42])
      expect((await call(name, { id, ...(name === "answer_question" ? { answer: "x" } : {}) })).isError).toBe(
        true,
      );
    const result = await call(name, {
      id: "missing",
      ...(name === "answer_question" ? { answer: "x" } : {}),
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not found");
  }
  const run = await create();
  expect(JSON.stringify((await call("answer_question", { id: run.id, answer: "x" })).content)).toContain(
    "no open questions",
  );
  const old = f.factory.store.askQuestion(run.id, "old");
  f.factory.store.answerQuestion(old.id, "old answer", "user");
  const first = f.factory.store.askQuestion(run.id, "first");
  const second = f.factory.store.askQuestion(run.id, "second");
  for (const answer of [undefined, " ", 12])
    expect((await call("answer_question", { id: run.id, answer })).isError).toBe(true);
  expect(f.factory.store.getQuestion(first.id)?.answer).toBeNull();
  const answers = resultValue<Question[]>(
    await call("answer_question", { id: run.id, answer: "Use defaults for both" }),
  );
  expect(answers.map((q) => q.id)).toEqual([first.id, second.id]);
  expect(answers.every((q) => q.answer === "Use defaults for both" && q.answeredBy === "mcp")).toBe(true);
  expect(f.factory.store.getQuestion(old.id)?.answer).toBe("old answer");
});

test("provider health and budget states pass through without secrets", async () => {
  const { ProviderTracker } = await import("../src/router/providers.ts");
  const tracker = new ProviderTracker(
    [
      {
        id: "metered",
        label: "Metered",
        harness: "fake",
        billing: "metered",
        maxConcurrent: 3,
        apiKeySecret: "TEST_TOKEN",
      },
      {
        id: "disabled",
        label: "Disabled",
        harness: "fake",
        billing: "metered",
        maxConcurrent: 1,
        apiKeySecret: "MISSING",
      },
    ],
    f.factory.store,
    f.factory.cfg.reserves,
    { TEST_TOKEN: "do-not-expose" },
    { metered: 10 },
  );
  const run = await create();
  const inv = f.factory.store.createInvocation({
    runId: run.id,
    stageId: null,
    role: "triage",
    harness: "fake",
    provider: "metered",
    model: "m",
    modelId: "metered/m",
  });
  f.factory.store.updateInvocation(inv.id, { costUsd: 2.5 });
  tracker.record("metered", "quota", { error: "Daily quota", exhaustedUntil: Date.now() + 10000 });
  const conn = await connect({ ...factoryBackend(f.factory), providers: async () => tracker.all() });
  try {
    const result = await conn.client.callTool({ name: "limitless_providers", arguments: {} });
    const providers = resultValue<ProviderStatus[]>(result);
    expect(providers[0]).toMatchObject({
      enabled: true,
      state: "exhausted",
      reason: "Daily quota",
      spendUsd: 2.5,
      budgetUsd: 10,
      maxConcurrent: 3,
    });
    expect(providers[1]).toMatchObject({ enabled: false, state: "disabled", reason: "missing key MISSING" });
    expect(JSON.stringify(result)).not.toContain("do-not-expose");
  } finally {
    await conn.close();
  }
});

test("dependencies appear in create, get and waiting filters with shared validation", async () => {
  const first = await create();
  const second = await create();
  const run = await create({ dependsOn: [` ${first.id} `, second.id, first.id] });
  expect(run).toMatchObject({ status: "waiting", dependsOn: [first.id, second.id] });
  expect(resultValue(await call("get_run", { id: run.id }))).toMatchObject({
    dependsOn: run.dependsOn,
    status: "waiting",
  });
  expect(
    resultValue<{ runs: Run[] }>(await call("list_runs", { status: "waiting" })).runs.map((r) => r.id),
  ).toEqual([run.id]);
  const invalid = await call("create_run", { repo: f.repo, prompt: "bad", dependsOn: ["unknown"] });
  expect(invalid.isError).toBe(true);
  expect(JSON.stringify(invalid.content)).toContain("unknown");
  expect((await call("create_run", { repo: f.repo, prompt: "bad", dependsOn: [1] })).isError).toBe(true);
});

test("feed tools bound cursors and waits, read without acknowledging and ack monotonically", async () => {
  const { tools } = await connection.client.listTools();
  const feed = tools.find((t) => t.name === "limitless_feed");
  const ack = tools.find((t) => t.name === "limitless_feed_ack");
  expect(feed?.inputSchema).toMatchObject({
    additionalProperties: false,
    properties: { wait: { minimum: 0, maximum: 45 }, after: { minimum: 0 }, consumer: { type: "string" } },
  });
  expect(feed?.inputSchema.required ?? []).toEqual([]);
  expect(feed?.description).toContain("0–45 seconds");
  expect(ack?.inputSchema.required).toEqual(["consumer", "id"]);
  for (const tool of [feed, ack]) expect(tool?.description).toContain("only after");
  const run = await create();
  f.factory.store.updateRun(run.id, { status: "failed", error: "boom" });
  const page = resultValue<FeedPage>(await call("feed", { consumer: "claude" }));
  expect(page.items.map((i) => [i.kind, i.runId, i.data.error])).toEqual([["run.failed", run.id, "boom"]]);
  expect(resultValue<FeedPage>(await call("feed", { wait: 45 })).items).toEqual(page.items);
  expect(f.factory.store.feedCursor("claude")).toBe(0);
  expect(resultValue<unknown>(await call("feed_ack", { consumer: "claude", id: page.nextAfter }))).toEqual({
    consumer: "claude",
    id: page.nextAfter,
  });
  expect(resultValue<unknown>(await call("feed_ack", { consumer: "claude", id: 0 }))).toEqual({
    consumer: "claude",
    id: page.nextAfter,
  });
  expect(resultValue<FeedPage>(await call("feed", { consumer: "claude", wait: 0.05 })).items).toEqual([]);
  for (const [name, args] of [
    ["feed", { wait: 46 }],
    ["feed", { after: -1 }],
    ["feed", { consumer: " " }],
    ["feed", { limit: 5 }],
    ["feed_ack", { consumer: "claude" }],
    ["feed_ack", { consumer: "claude", id: 1.5 }],
    ["feed_ack", { consumer: "claude", id: page.nextAfter + 1 }],
  ] as const)
    expect((await call(name, args)).isError).toBe(true);
  expect(f.factory.store.feedCursor("claude")).toBe(page.nextAfter);
});

test("cancelling a feed long poll or closing the connection releases its listener", async () => {
  const listeners = () => (f.factory.store as unknown as { listeners: Set<unknown> }).listeners.size;
  const idle = listeners();
  const controller = new AbortController();
  const cancelled = connection.client
    .callTool({ name: "limitless_feed", arguments: { wait: 30 } }, undefined, { signal: controller.signal })
    .catch(() => "cancelled");
  await Bun.sleep(20);
  expect(listeners()).toBe(idle + 1);
  controller.abort();
  expect(await cancelled).toBe("cancelled");
  await Bun.sleep(20);
  expect(listeners()).toBe(idle);

  const other = await connect(factoryBackend(f.factory));
  const closed = other.client
    .callTool({ name: "limitless_feed", arguments: { wait: 30 } })
    .catch(() => "closed");
  await Bun.sleep(20);
  expect(listeners()).toBe(idle + 1);
  await other.close();
  expect(await closed).toBe("closed");
  await Bun.sleep(20);
  expect(listeners()).toBe(idle);
});
