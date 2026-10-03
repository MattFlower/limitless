import { afterEach, beforeEach, expect, test } from "bun:test";
import { Factory } from "../src/app.ts";
import type { EvalStatus, FeedItem, FeedKind } from "../src/core/types.ts";
import type { Store } from "../src/db/store.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { allItems } from "./feed-support.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let store: Store;
beforeEach(async () => {
  f = await fixture("0123456789abcdef0123456789abcdef01234567");
  store = f.factory.store;
});
afterEach(async () => {
  await f.close();
});

const create = (dependsOn?: string[]) => f.factory.createRun({ repo: f.repo, prompt: "work", dependsOn });

/** Runs a transition twice and returns the items it produced; the repeat must produce none. */
function twice(transition: () => unknown): FeedItem[] {
  const before = allItems(store).length;
  transition();
  const items = allItems(store).slice(before);
  transition();
  expect(allItems(store).length).toBe(before + items.length);
  return items;
}

const kinds = (items: FeedItem[]) => items.map((i) => i.kind);

test("each run lifecycle transition records exactly one item with its context", async () => {
  const cases: [FeedKind, Record<string, unknown>, Record<string, unknown>][] = [
    ["run.needs_human", { status: "needs_human", error: "Unclear spec" }, { reason: "Unclear spec" }],
    ["run.failed", { status: "failed", error: "gates failed" }, { error: "gates failed" }],
    ["run.succeeded", { status: "succeeded" }, { status: "succeeded" }],
    ["run.cancelled", { status: "cancelled" }, { status: "cancelled" }],
    ["run.pr_opened", { prUrl: "https://github.com/o/r/pull/1" }, { prUrl: "https://github.com/o/r/pull/1" }],
    ["run.merged", { merged: true, mergedBy: "octo", mergedAt: 5 }, { mergedBy: "octo", mergedAt: 5 }],
  ];
  for (const [kind, patch, data] of cases) {
    const run = await create();
    const items = twice(() => store.updateRun(run.id, patch));
    expect(kinds(items)).toEqual([kind]);
    expect(items[0]).toMatchObject({ runId: run.id, repo: run.repoSlug, evalId: null, data });
  }
});

test("one mutation orders PR opening, merge and success by id", async () => {
  const run = await create();
  const items = twice(() =>
    store.updateRun(run.id, { prUrl: "https://github.com/o/r/pull/2", merged: true, status: "succeeded" }),
  );
  expect(kinds(items)).toEqual(["run.pr_opened", "run.merged", "run.succeeded"]);
  expect(items[0]?.id).toBeLessThan(items[1]?.id ?? 0);
  expect(items[1]?.id).toBeLessThan(items[2]?.id ?? 0);
});

test("scheduler shutdown re-queues directly; a later real cancel emits exactly once", async () => {
  const run = await create();
  const statuses: string[] = [];
  store.subscribe((msg) => {
    if (msg.kind === "run" && msg.run.id === run.id) statuses.push(msg.run.status);
  });
  const harness = f.factory.deps.harnesses.fake;
  if (!harness) throw new Error("Missing fake harness");
  let signal: AbortSignal | undefined;
  f.factory.deps.harnesses.fake = async (spec) => {
    signal = spec.signal;
    return harness(spec);
  };
  f.factory.scheduler.tick();
  for (let i = 0; i < 300 && !signal; i++) await Bun.sleep(10);
  expect(signal).toBeDefined();
  expect(store.listInvocations(run.id)).toHaveLength(1);
  await f.factory.scheduler.stop();
  expect(signal?.reason).toBeInstanceOf(Error);
  expect(signal?.reason).toMatchObject({ message: "shutdown" });
  expect(store.getRun(run.id)).toMatchObject({ status: "queued", finishedAt: null });
  expect(statuses).not.toContain("cancelled");
  expect(allItems(store)).toEqual([]);
  expect(f.factory.scheduler.cancel(run.id, "test")).toBe(true);
  expect(f.factory.scheduler.cancel(run.id, "test")).toBe(false);
  expect(allItems(store)).toMatchObject([
    { kind: "run.cancelled", runId: run.id, data: { reason: "cancelled by test" } },
  ]);
});

test("re-entering terminal statuses emits distinct occurrences, even with the same finishedAt", async () => {
  for (const status of ["cancelled", "failed", "succeeded", "needs_human"] as const) {
    const run = await create();
    twice(() => store.updateRun(run.id, { status, finishedAt: 1 }));
    store.updateRun(run.id, { status: "queued", finishedAt: null });
    twice(() => store.updateRun(run.id, { status, finishedAt: 1 }));
    expect(
      allItems(store)
        .filter((i) => i.runId === run.id)
        .map((i) => i.kind),
    ).toEqual([`run.${status}`, `run.${status}`]);
  }
});

test("a real cancel requested during shutdown stays cancelled", async () => {
  const run = await create();
  f.factory.scheduler.tick();
  for (let i = 0; i < 300 && store.listInvocations(run.id).length === 0; i++) await Bun.sleep(10);
  expect(store.listInvocations(run.id)).toHaveLength(1);
  const stopped = f.factory.scheduler.stop();
  expect(f.factory.scheduler.cancel(run.id, "test")).toBe(true);
  await stopped;
  expect(store.getRun(run.id)).toMatchObject({ status: "cancelled", error: "cancelled by test" });
  expect(allItems(store)).toMatchObject([{ kind: "run.cancelled", data: { reason: "cancelled by test" } }]);
});

test("questions are distinct occurrences", async () => {
  const run = await create();
  store.askQuestion(run.id, "Which API?");
  store.askQuestion(run.id, "Which API?");
  const items = allItems(store).filter((i) => i.kind === "run.question");
  expect(items.map((i) => i.data)).toEqual(
    store.listQuestions(run.id).map((q) => ({ questionId: q.id, question: "Which API?" })),
  );
  expect(items).toHaveLength(2);
});

test("dependency release, immediate dependency blocking and the alternate merge path", async () => {
  const parent = await create();
  const child = await create([parent.id]);
  expect(store.getRun(child.id)?.status).toBe("waiting");
  store.updateRun(parent.id, { prUrl: "https://github.com/o/r/pull/3", status: "needs_human" });
  const merged = twice(() => store.resolveMergedRun(parent.id, "octo", 9));
  expect(kinds(merged)).toEqual(["run.merged"]);
  expect(merged[0]?.data).toMatchObject({
    prUrl: "https://github.com/o/r/pull/3",
    mergedBy: "octo",
    mergedAt: 9,
  });
  const released = twice(() => store.reconcileWaitingRuns());
  expect(kinds(released)).toEqual(["run.released"]);
  expect(released[0]).toMatchObject({ runId: child.id, data: { dependsOn: [parent.id], status: "queued" } });

  const failed = await create();
  store.updateRun(failed.id, { status: "failed" });
  const before = allItems(store).length;
  const blocked = await create([failed.id]);
  const items = allItems(store).slice(before);
  expect(kinds(items)).toEqual(["run.needs_human"]);
  expect(items[0]?.data.reason).toBe(`Dependency ${failed.id}: run failed`);
  expect(items[0]?.runId).toBe(blocked.id);

  // A waiting run that becomes blocked records needs_human, not a release.
  const parent2 = await create();
  const child2 = await create([parent2.id]);
  store.updateRun(parent2.id, { status: "cancelled" });
  const blockedLater = twice(() => store.reconcileWaitingRuns());
  expect(blockedLater.map((i) => [i.kind, i.runId])).toEqual([["run.needs_human", child2.id]]);
});

test("every terminal eval status records eval.finished once, including interruption, recovery and resume", () => {
  const input = { role: "triage" as const, models: ["m"], k: 1, maxUsd: 1 };
  const statuses: EvalStatus[] = ["completed", "budget_exhausted", "failed", "interrupted"];
  for (const status of statuses) {
    const run = store.createEvalRun(input, []);
    expect(twice(() => store.updateEvalRun(run.id, "running"))).toEqual([]);
    const items = twice(() => store.updateEvalRun(run.id, status, status === "failed" ? "boom" : null));
    expect(items.map((i) => [i.kind, i.evalId, i.data.status])).toEqual([["eval.finished", run.id, status]]);
    expect(items[0]?.runId).toBeNull();
  }
  const interrupted = store.createEvalRun(input, []);
  expect(twice(() => store.interruptEval(interrupted.id, "cancelled")).map((i) => i.data)).toEqual([
    expect.objectContaining({ status: "interrupted", error: "cancelled" }),
  ]);
  const recovered = store.createEvalRun(input, [], { request: {} });
  const recovery = twice(() => store.recoverEvals());
  expect(recovery.map((i) => [i.evalId, i.data.status])).toEqual([[recovered.id, "interrupted"]]);
  const predecessor = store.createEvalRun(input, [], { request: {} });
  store.db.query("UPDATE eval_runs SET status = 'running' WHERE id = ?").run(predecessor.id);
  const before = allItems(store).length;
  store.createEvalRun(input, [], { request: {} }, predecessor.id);
  expect(
    allItems(store)
      .slice(before)
      .map((i) => [i.evalId, i.data.status]),
  ).toEqual([[predecessor.id, "interrupted"]]);
});

test("daemon.started is recorded per startup, not by opening the store", async () => {
  expect(allItems(store)).toEqual([]);
  const previous = process.env.LIMITLESS_NO_SCHEDULER;
  process.env.LIMITLESS_NO_SCHEDULER = "1";
  try {
    twice(() => f.factory.start());
    const second = new Factory(f.factory.cfg, { store, providers: [] });
    expect(allItems(store)).toHaveLength(1);
    second.start();
    const items = allItems(store);
    expect(kinds(items)).toEqual(["daemon.started", "daemon.started"]);
    expect(items.map((i) => i.data.bootId)).toEqual([f.factory.bootId, second.bootId]);
    expect(items[0]?.data.version).toBe((await import("../package.json")).version);
    const health = createHttpRoutes(f.factory)["/api/health"] as Route;
    const response = await health(requestWithParams("http://localhost:7400/api/health"), localServer);
    const running = (await response.json()) as { sha: string };
    expect(running.sha).toBe(f.factory.bootSha);
    expect(items[0]?.data.sha).toBe(running.sha);
    expect(items[0]?.summary).toContain(running.sha);
  } finally {
    if (previous === undefined) delete process.env.LIMITLESS_NO_SCHEDULER;
    else process.env.LIMITLESS_NO_SCHEDULER = previous;
  }
});

test("resuming a finished eval after its item was pruned records no second completion", () => {
  const input = { role: "triage" as const, models: ["m"], k: 1, maxUsd: 1 };
  const failed = store.createEvalRun(input, [], { request: {} });
  store.updateEvalRun(failed.id, "failed", "boom");
  expect(allItems(store).map((i) => [i.kind, i.evalId])).toEqual([["eval.finished", failed.id]]);
  store.pruneFeed(Date.now() + 1);
  expect(allItems(store)).toEqual([]);
  store.createEvalRun(input, [], { request: {} }, failed.id);
  expect(store.getEvalRun(failed.id)?.status).toBe("interrupted");
  expect(allItems(store)).toEqual([]);
});
