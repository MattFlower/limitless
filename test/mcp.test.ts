import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ProviderStatus, Question, Run, RunEvent } from "../src/core/types.ts";
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

test("six discoverable tools, create defaults and overrides, get and queued cancellation", async () => {
  const { tools } = await connection.client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(
    ["answer_question", "cancel_run", "create_run", "get_run", "list_runs", "providers"].map(
      (s) => `limitless_${s}`,
    ),
  );
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.description?.length).toBeGreaterThan(100);
  }
  expect(tools.find((t) => t.name === "limitless_create_run")?.inputSchema.required).toEqual([
    "repo",
    "prompt",
  ]);
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
    questions: [],
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
  }>(await call("get_run", { id: run.id }));
  expect(detail.events.map((e) => e.id)).toEqual(expected.slice(-20));
  expect(detail.questions).toEqual([open]);
  expect(detail.costUsd).toBe(1.25);
  expect(detail.costEquivUsd).toBe(8.75);
  // Default reads retain oldest-first behavior for existing REST/SSE callers.
  expect(store.listEvents(run.id, { limit: 1 })[0]?.message).toBe("Run created from mcp");
  const short = await create();
  expect(resultValue<{ events: RunEvent[] }>(await call("get_run", { id: short.id })).events).toHaveLength(1);
  store.db.query("DELETE FROM events WHERE run_id = ?").run(short.id);
  expect(resultValue<{ events: RunEvent[] }>(await call("get_run", { id: short.id })).events).toEqual([]);
});

test("list uses newest-first filtering and providers preserve telemetry and absent values", async () => {
  const old = await create();
  const newer = await create();
  f.factory.store.db.query("UPDATE runs SET created_at = ? WHERE id = ?").run(1, old.id);
  f.factory.store.updateRun(old.id, { status: "failed" });
  expect(resultValue<Run[]>(await call("list_runs")).map((r) => r.id)).toEqual([newer.id, old.id]);
  expect(
    resultValue<Run[]>(await call("list_runs", { status: "failed", limit: 1 })).map((r) => r.id),
  ).toEqual([old.id]);
  expect(resultValue<Run[]>(await call("list_runs", { limit: 1 })).map((r) => r.id)).toEqual([newer.id]);
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
    expect(providers[1]).toMatchObject({ enabled: false, state: "disabled", reason: "missing MISSING" });
    expect(JSON.stringify(result)).not.toContain("do-not-expose");
  } finally {
    await conn.close();
  }
});
