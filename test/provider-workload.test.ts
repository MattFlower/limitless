import { expect, setSystemTime, test } from "bun:test";
import { parseSince } from "../src/core/since.ts";
import type { EvalRound, EvalTrial } from "../src/core/types.ts";
import { computeProviderStatistics, computeProviderWorkload } from "../src/db/stats.ts";
import { Store } from "../src/db/store.ts";
import { emptyUsage } from "../src/harness/types.ts";
import type { ProviderDef } from "../src/router/catalog.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { workloadFor } from "../ui/lib/provider-workload.ts";

function localDay(dayOffset: number, hour = 0): number {
  const now = new Date(2026, 8, 27);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour).getTime();
}

test("provider workload uses local calendar boundaries and adds chat calls once", () => {
  const store = new Store(":memory:");
  try {
    store.db.exec("PRAGMA foreign_keys = OFF");
    const inv = store.db.query(`INSERT INTO invocations
      (run_id, role, harness, provider, model, model_id, status, started_at, finished_at,
       input_tokens, cache_read_tokens, output_tokens, cost_equiv_usd)
      VALUES ('r', 'triage', 'fake', ?, 'm', 'm', 'ok', ?, ?, ?, ?, ?, ?)`);
    inv.run("mtplx", localDay(0, 1), localDay(0, 2), 10, 4, 3, 0.5);
    inv.run("mtplx", localDay(-6, 1), localDay(-6, 2), 20, 5, 6, 1);
    inv.run("mtplx", localDay(-6) - 1, localDay(-6), 999, 0, 999, 99);
    inv.run("retired-lan", localDay(0) - 1, null, 7, 2, 8, 0.2);
    store.db
      .query(`INSERT INTO chat_calls
      (conversation_id, provider, model_id, result_json, cost_usd, started_at, duration_ms)
      VALUES ('c', ?, 'm', ?, 0, ?, ?)`)
      .run(
        "mtplx",
        JSON.stringify({ usage: { input: 2, cacheRead: 1, output: 4 }, costEquivUsd: 0.3 }),
        localDay(0, 3),
        2500,
      );
    store.db
      .query(`INSERT INTO chat_calls
      (conversation_id, provider, model_id, result_json, cost_usd, started_at)
      VALUES ('c', ?, 'm', ?, 0, ?)`)
      .run(
        "retired-lan",
        JSON.stringify({ usage: { input: 3, cacheRead: 0, output: 1 }, costEquivUsd: 0.1 }),
        localDay(-6, 2),
      );
    store.db
      .query(`INSERT INTO chat_calls
      (conversation_id, provider, model_id, result_json, cost_usd, started_at)
      VALUES ('c', 'mtplx', 'm', ?, 0, ?)`)
      .run("not valid json {{{", localDay(0, 4));
    store.db
      .query(`INSERT INTO chat_calls
      (conversation_id, provider, model_id, result_json, cost_usd, started_at)
      VALUES ('c', 'mtplx', 'm', '{}', 0, ?)`)
      .run(localDay(0, 5));
    const rows = computeProviderWorkload(store, localDay(0, 23));
    expect(workloadFor("mtplx", rows)).toEqual({
      provider: "mtplx",
      today: { invocations: 3, tokensIn: 17, tokensOut: 7, wallTimeMs: 3_602_500, costEquivUsd: 0.8 },
      sevenDays: { invocations: 4, tokensIn: 42, tokensOut: 13, wallTimeMs: 7_202_500, costEquivUsd: 1.8 },
    });
    expect(workloadFor("retired-lan", rows)).toEqual({
      provider: "retired-lan",
      today: { invocations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0, costEquivUsd: 0 },
      sevenDays: {
        invocations: 2,
        tokensIn: 12,
        tokensOut: 9,
        wallTimeMs: 0,
        costEquivUsd: 0.30000000000000004,
      },
    });
    expect(workloadFor("unused", rows).sevenDays.invocations).toBe(0);
  } finally {
    store.close();
  }
});

test("recorded concierge duration contributes to workload", () => {
  const store = new Store(":memory:");
  try {
    const started = localDay(0, 1);
    setSystemTime(started + 2_500);
    store.recordChatCall("c", "mtplx", "m", started, {
      status: "ok",
      finalText: "",
      structured: null,
      sessionId: null,
      usage: { ...emptyUsage(), input: 3, cacheRead: 2, output: 1 },
      numTurns: 1,
      costUsd: 0,
      costEquivUsd: 0.5,
      error: null,
      quota: null,
    });
    expect(computeProviderWorkload(store, started + 2_500)[0]?.today).toEqual({
      invocations: 1,
      tokensIn: 5,
      tokensOut: 1,
      wallTimeMs: 2_500,
      costEquivUsd: 0.5,
    });
  } finally {
    setSystemTime();
    store.close();
  }
});

const tracked = (maxConcurrent: number) => {
  const store = new Store(":memory:");
  const reserves = { claudeFiveHour: 0.8, claudeSevenDay: 0.85, codexWeekly: 0.9, codexFiveHour: 0.9 };
  const def: ProviderDef = {
    id: "alpha",
    label: "Alpha",
    harness: "fake",
    billing: "subscription",
    maxConcurrent,
  };
  return { store, tracker: new ProviderTracker([def], store, reserves, {}) };
};
const noop = () => {};

test("a shadow slot needs two free slots and nobody queued: never the last slot, never queued", async () => {
  const single = tracked(1);
  try {
    // A one-slot provider never admits shadow work, even idle.
    expect(single.tracker.tryAcquire("alpha", noop)).toBeNull();
    expect(single.tracker.tryAcquire("unknown", noop)).toBeNull();
  } finally {
    single.store.close();
  }
  const { store, tracker } = tracked(3);
  try {
    const signal = new AbortController().signal;
    const shadows = [tracker.tryAcquire("alpha", noop), tracker.tryAcquire("alpha", noop)];
    expect(shadows).toEqual([expect.any(Function), expect.any(Function)]);
    // One of three free: a third shadow call would take the last slot, so it gets nothing at once.
    expect(tracker.tryAcquire("alpha", noop)).toBeNull();
    for (const release of shadows) {
      release?.();
      release?.(); // a repeated release frees nothing more
    }
    expect(tracker.status("alpha")?.inFlight).toBe(0);
    const held = await Promise.all([1, 2, 3].map(() => tracker.acquire("alpha", signal)));
    expect(tracker.status("alpha")?.inFlight).toBe(3);
    const order: string[] = [];
    const waiter = tracker.acquire("alpha", signal).then((release) => {
      order.push("waiter");
      return release;
    });
    await Bun.sleep(0);
    // A release wakes the waiter; a fresh production call doesn't take the slot reserved for it.
    held[0]?.();
    const fresh = tracker.acquire("alpha", signal).then((release) => {
      order.push("fresh");
      return release;
    });
    // Both released slots are reserved for woken waiters until they take them: none for a shadow.
    held[1]?.();
    expect(tracker.tryAcquire("alpha", noop)).toBeNull();
    (await waiter)();
    (await fresh)();
    expect(order).toEqual(["waiter", "fresh"]);
    held[2]?.();
    expect(tracker.status("alpha")?.inFlight).toBe(0);
    const later = tracker.tryAcquire("alpha", noop);
    expect(later).toBeFunction();
    later?.();
  } finally {
    store.close();
  }
});

test("a production call preempts a shadow holder and takes its slot ahead of the queue", async () => {
  const { store, tracker } = tracked(3);
  try {
    const signal = new AbortController().signal;
    const preempted: string[] = [];
    const shadow = tracker.tryAcquire("alpha", () => preempted.push("shadow"));
    expect(shadow).toBeFunction();
    const held = await Promise.all([1, 2].map(() => tracker.acquire("alpha", signal)));
    const order: string[] = [];
    const take = (name: string, s = signal) =>
      tracker.acquire("alpha", s).then((release) => {
        order.push(name);
        return release;
      });
    // Saturated: the next production call aborts the shadow call at once, through its own callback.
    const priority = take("priority");
    expect(preempted).toEqual(["shadow"]);
    // No other shadow to preempt: this one queues behind.
    const queued = take("queued");
    await Bun.sleep(0);
    expect(preempted).toEqual(["shadow"]);
    shadow?.();
    shadow?.();
    (await priority)();
    expect(order).toEqual(["priority"]);
    (await queued)();
    for (const release of held) release();
    expect(tracker.status("alpha")?.inFlight).toBe(0);

    // A cancelled priority waiter leaves the queue: the shadow's release goes to the next waiter.
    const again: string[] = [];
    const second = tracker.tryAcquire("alpha", () => again.push("shadow"));
    const busy = await Promise.all([1, 2].map(() => tracker.acquire("alpha", signal)));
    const cancel = new AbortController();
    const gone = take("gone", cancel.signal).catch((error: Error) => error.message);
    const next = take("next");
    expect(again).toEqual(["shadow"]);
    cancel.abort();
    expect(await gone).toBe("cancelled");
    second?.();
    (await next)();
    expect(order).toEqual(["priority", "queued", "next"]);
    for (const release of busy) release();
    expect(tracker.status("alpha")?.inFlight).toBe(0);
  } finally {
    store.close();
  }
});

test("each preemptor receives the slot its own shadow releases, before other waiters", async () => {
  const { store, tracker } = tracked(4);
  try {
    const signal = new AbortController().signal;
    const preempted: string[] = [];
    const first = tracker.tryAcquire("alpha", () => preempted.push("s1"));
    const second = tracker.tryAcquire("alpha", () => preempted.push("s2"));
    const held = await Promise.all([1, 2].map(() => tracker.acquire("alpha", signal)));
    const order: string[] = [];
    const take = (name: string, s = signal) =>
      tracker.acquire("alpha", s).then((release) => {
        order.push(name);
        return release;
      });
    const p1 = take("first");
    const p2 = take("second");
    const queued = take("queued");
    expect(preempted).toEqual(["s1", "s2"]);
    // No free slot is ever offered to a shadow while a preemptor waits.
    expect(tracker.tryAcquire("alpha", noop)).toBeNull();
    // Each shadow's release goes to the preemptor that aborted it, whatever order they finish in.
    first?.();
    await Bun.sleep(0);
    expect(order).toEqual(["first"]);
    second?.();
    await Bun.sleep(0);
    expect(order).toEqual(["first", "second"]);
    (await p1)();
    (await p2)();
    (await queued)();
    for (const release of held) release();
    expect(tracker.status("alpha")?.inFlight).toBe(0);

    // A production release goes to the earliest preemptor; that one's shadow then serves the next.
    order.length = 0;
    const s3 = tracker.tryAcquire("alpha", noop);
    const s4 = tracker.tryAcquire("alpha", noop);
    const busy = await Promise.all([1, 2].map(() => tracker.acquire("alpha", signal)));
    const cancel = new AbortController();
    const a = take("a");
    const gone = take("gone", cancel.signal).catch((error: Error) => error.message);
    const tail = take("tail");
    // The cancelled preemptor's reservation lapses: its shadow's release serves the queue.
    cancel.abort();
    expect(await gone).toBe("cancelled");
    busy[0]?.();
    await Bun.sleep(0);
    expect(order).toEqual(["a"]);
    s4?.();
    await Bun.sleep(0);
    expect(order).toEqual(["a", "tail"]);
    s3?.();
    s3?.();
    (await a)();
    (await tail)();
    busy[1]?.();
    expect(tracker.status("alpha")?.inFlight).toBe(0);
  } finally {
    store.close();
  }
});

test("a woken production waiter that has not resumed keeps a shadow out, whatever else is free", async () => {
  const { store, tracker } = tracked(4);
  try {
    const signal = new AbortController().signal;
    const held = await Promise.all([1, 2, 3, 4].map(() => tracker.acquire("alpha", signal)));
    let resumed = false;
    const waiter = tracker.acquire("alpha", signal).then((release) => {
      resumed = true;
      return release;
    });
    await Bun.sleep(0);
    // Three releases in one turn: the waiter is woken but has not run yet, and two slots are free.
    for (const release of held.slice(0, 3)) release?.();
    expect(resumed).toBe(false);
    expect(tracker.tryAcquire("alpha", noop)).toBeNull();
    (await waiter)();
    const shadow = tracker.tryAcquire("alpha", noop);
    expect(shadow).toBeFunction();
    shadow?.();
    held[3]?.();
    expect(tracker.status("alpha")?.inFlight).toBe(0);
  } finally {
    store.close();
  }
});

test("a waiter cancelled in the same turn as its slot frees never holds it", async () => {
  const { store, tracker } = tracked(2);
  try {
    const signal = new AbortController().signal;
    // A preemptor cancelled just before its shadow releases: the slot stays free, not leaked.
    const shadow = tracker.tryAcquire("alpha", noop);
    const busy = await tracker.acquire("alpha", signal);
    const cancel = new AbortController();
    const gone = tracker.acquire("alpha", cancel.signal).then(
      () => "acquired",
      (error: Error) => error.message,
    );
    cancel.abort();
    shadow?.();
    expect(await gone).toBe("cancelled");
    expect(tracker.status("alpha")?.inFlight).toBe(1);

    // A queued waiter cancelled right after its wake passes the slot on to the next in line.
    const other = await tracker.acquire("alpha", signal);
    const late = new AbortController();
    const dropped = tracker.acquire("alpha", late.signal).then(
      () => "acquired",
      (error: Error) => error.message,
    );
    const order: string[] = [];
    const next = tracker.acquire("alpha", signal).then((release) => {
      order.push("next");
      return release;
    });
    await Bun.sleep(0);
    busy();
    late.abort();
    expect(await dropped).toBe("cancelled");
    (await next)();
    expect(order).toEqual(["next"]);
    other();
    expect(tracker.status("alpha")?.inFlight).toBe(0);
  } finally {
    store.close();
  }
});

const cutoff = Date.parse("2026-09-01T00:00:00Z");
function invocation(
  store: Store,
  provider: string,
  model: string,
  role: string,
  at: number,
  duration: number | null,
  status = "ok",
) {
  store.db.exec("PRAGMA foreign_keys = OFF");
  store.db
    .query(`INSERT INTO invocations
    (run_id, role, harness, provider, model, model_id, status, started_at, finished_at,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_equiv_usd)
    VALUES ('r', ?, 'fake', ?, ?, ?, ?, ?, ?, 10, 5, 3, 2, 0.25, 0.5)`)
    .run(role, provider, model, model, status, at, duration === null ? null : at + duration);
}

test("historical production keeps stored identities, roles, tokens and finished medians", () => {
  const store = new Store(":memory:");
  try {
    invocation(store, "retired", "m1", "triage", cutoff - 86_400_000, 100);
    invocation(store, "retired", "m1", "triage", cutoff, 300, "error");
    invocation(store, "retired", "m2", "review_shadow", cutoff + 1, 500);
    invocation(store, "second", "m1", "implement", cutoff + 2, 200);
    invocation(store, "second", "m1", "implement", cutoff + 3, -100, "error");
    invocation(store, "second", "m1", "implement", cutoff + 4, null, "running");
    const rows = computeProviderStatistics(store, undefined, cutoff + 30 * 86_400_000);
    expect(rows.map((r) => r.provider)).toEqual(["retired", "second"]);
    const first = rows[0]?.production;
    expect(first?.totals).toEqual({
      invocations: 3,
      successfulShare: 2 / 3,
      countingUnits: { invocation: 3, round: 0, trial: 0 },
      tokensIn: 45,
      inputTokens: 30,
      tokensOut: 15,
      cacheReadTokens: 9,
      cacheWriteTokens: 6,
      costUsd: 0.75,
      costEquivUsd: 1.5,
      wallTimeMs: 900,
      p50WallTimeMs: 300,
    });
    expect(first?.models.map((r) => [r.provider, r.modelId, r.invocations, r.p50WallTimeMs])).toEqual([
      ["retired", "m1", 2, 200],
      ["retired", "m2", 1, 500],
    ]);
    expect(first?.roles.map((r) => [r.provider, r.modelId, r.role, r.successfulShare])).toEqual([
      ["retired", "m2", "review_shadow", 1],
      ["retired", "m1", "triage", 0.5],
    ]);
    expect(first?.days.map((r) => [r.day, r.provider, r.modelId, r.invocations])).toEqual([
      [dayKey(cutoff - 86_400_000), "retired", "m1", 1],
      [dayKey(cutoff), "retired", "m1", 1],
      [dayKey(cutoff), "retired", "m2", 1],
    ]);
    expect(rows[1]?.production?.totals).toMatchObject({
      invocations: 3,
      successfulShare: 1 / 3,
      wallTimeMs: 200,
      p50WallTimeMs: 100,
    });
    expect(rows[0]?.today.invocations).toBe(0);
    expect(rows.every((r) => r.eval?.totals.invocations === 0)).toBe(true);
    const filtered = computeProviderStatistics(store, cutoff, cutoff + 30 * 86_400_000);
    expect(filtered[0]?.production?.totals).toMatchObject({
      invocations: 2,
      wallTimeMs: 800,
      p50WallTimeMs: 400,
    });
  } finally {
    store.close();
  }
});

function dayKey(at: number) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function evalTrial(store: Store, patch: Partial<EvalTrial> = {}) {
  const run = store.createEvalRun({ role: "implement", models: ["m"], k: 1, maxUsd: 10 }, []);
  const trial: EvalTrial = {
    evalRunId: run.id,
    effort: null,
    caseId: "case",
    modelId: "legacy-model",
    trial: 0,
    cacheKey: "key",
    harness: "fake",
    status: "error",
    output: null,
    pass: false,
    score: 0,
    details: { provider: "legacy", invocationStatus: "ok", cacheReadTokens: 2, cacheWriteTokens: 1 },
    tokensIn: 10,
    tokensOut: 4,
    costUsd: 0.5,
    costEquivUsd: 1,
    durationMs: 100,
    createdAt: cutoff,
    ...patch,
  };
  store.recordEvalTrial(trial);
}

test("evals count recorded rounds or trials once, with unknown cache splits and attribution explicit", () => {
  const store = new Store(":memory:");
  try {
    evalTrial(store);
    const round = {
      round: 0,
      modelId: "switched",
      effort: "default",
      status: "ok",
      pass: false,
      reason: null,
      costUsd: 0.25,
      costEquivUsd: 0.5,
      tokensIn: 20,
      tokensOut: 8,
      durationMs: 50,
    } satisfies EvalRound;
    evalTrial(store, {
      details: {
        rounds: [
          { ...round, provider: "alpha" },
          { ...round, round: 1, provider: "beta", status: "timeout", durationMs: 150 },
        ],
      },
      costUsd: 999,
    });
    evalTrial(store, {
      details: {
        cache: {
          evalRunId: "old",
          caseId: "case",
          costUsd: 1,
          costEquivUsd: 2,
          tokensIn: 3,
          tokensOut: 4,
          durationMs: 5,
        },
      },
    });
    evalTrial(store, { details: { resumedFrom: "old" } });
    evalTrial(store, { status: "queued" });
    evalTrial(store, { modelId: "unattributed", details: {} });
    evalTrial(store, { createdAt: cutoff - 1 });
    const rows = computeProviderStatistics(store, cutoff, cutoff);
    expect(rows.map((r) => r.provider)).toEqual(["alpha", "beta", "legacy", "(unknown)"]);
    expect(rows.every((r) => r.production?.totals.invocations === 0)).toBe(true);
    expect(rows[0]?.eval?.totals).toEqual({
      invocations: 1,
      successfulShare: 1,
      countingUnits: { invocation: 0, round: 1, trial: 0 },
      tokensIn: 20,
      inputTokens: null,
      tokensOut: 8,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: 0.25,
      costEquivUsd: 0.5,
      wallTimeMs: 50,
      p50WallTimeMs: 50,
    });
    expect(rows[1]?.eval?.totals).toMatchObject({
      invocations: 1,
      successfulShare: 0,
      costUsd: 0.25,
      wallTimeMs: 150,
    });
    expect(rows[2]?.eval?.totals).toMatchObject({
      invocations: 1,
      successfulShare: 1,
      inputTokens: 7,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsd: 0.5,
      countingUnits: { invocation: 0, round: 0, trial: 1 },
    });
    expect(rows[3]?.eval?.models[0]).toMatchObject({
      provider: null,
      modelId: "unattributed",
      inputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      successfulShare: 0,
    });
    expect(rows[1]?.eval?.roles[0]).toMatchObject({
      provider: "beta",
      modelId: "switched",
      role: "implement",
    });
    expect(rows[1]?.eval?.days[0]?.day).toBe(dayKey(cutoff));
    expect(computeProviderStatistics(store, cutoff + 1, cutoff)).toEqual([]);
  } finally {
    store.close();
  }
});

test("evals exclude skips and preparation failures without execution evidence", () => {
  const store = new Store(":memory:");
  try {
    evalTrial(store);
    const unexecuted = { tokensIn: 0, tokensOut: 0, costUsd: 0, costEquivUsd: 0, durationMs: 0 };
    evalTrial(store, {
      ...unexecuted,
      status: "skipped",
      details: { provider: "legacy", reason: "eval budget exhausted" },
    });
    evalTrial(store, {
      ...unexecuted,
      durationMs: 25,
      details: { provider: "legacy", preparationFailed: true },
    });
    evalTrial(store, { ...unexecuted, status: "skipped", details: {} });
    const rows = computeProviderStatistics(store, cutoff, cutoff);
    expect(rows.map((r) => r.provider)).toEqual(["legacy"]);
    expect(rows[0]?.eval?.totals).toEqual({
      invocations: 1,
      successfulShare: 1,
      countingUnits: { invocation: 0, round: 0, trial: 1 },
      tokensIn: 10,
      inputTokens: 7,
      tokensOut: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsd: 0.5,
      costEquivUsd: 1,
      wallTimeMs: 100,
      p50WallTimeMs: 100,
    });
    // A skipped trial can still have attempted a call, even with zero usage.
    evalTrial(store, {
      ...unexecuted,
      status: "skipped",
      details: { provider: "legacy", invocationStatus: "ok", cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(computeProviderStatistics(store, cutoff, cutoff)[0]?.eval?.totals).toMatchObject({
      invocations: 2,
      successfulShare: 1,
      wallTimeMs: 100,
      p50WallTimeMs: 50,
    });
  } finally {
    store.close();
  }
});

test("empty selections, unfinished durations and ISO cutoffs are finite and inclusive", () => {
  const store = new Store(":memory:");
  try {
    expect(computeProviderStatistics(store)).toEqual([]);
    invocation(store, "p", "m", "spec", cutoff - 1, 100);
    invocation(store, "p", "m", "spec", cutoff, null, "running");
    invocation(store, "p", "m", "spec", cutoff + 1, null, "running");
    const utc = computeProviderStatistics(store, parseSince("2026-09-01T00:00:00Z"), cutoff);
    expect(utc).toEqual(computeProviderStatistics(store, parseSince("2026-09-01T02:00:00+02:00"), cutoff));
    expect(utc[0]?.production?.totals).toMatchObject({
      invocations: 2,
      successfulShare: 0,
      wallTimeMs: 0,
      p50WallTimeMs: null,
    });
    expect(
      computeProviderStatistics(store, parseSince("2030-01-01"), cutoff)[0]?.production?.totals.invocations,
    ).toBe(0);
  } finally {
    store.close();
  }
});

test.each([
  "",
  "yesterday",
  "2026-02-29",
  "2026-02-30T12:00:00Z",
  "2026-04-31",
  "2026-09-01T24:00:00Z",
  "2026-09-01T12:00:00Z trailing",
])("rejects invalid cutoff %j", (value) => {
  expect(() => parseSince(value)).toThrow("invalid ISO-8601 timestamp");
});

test("partial eval round evidence does not fabricate missing measurements", () => {
  const store = new Store(":memory:");
  try {
    evalTrial(store);
    store.db.run("UPDATE eval_trials SET details_json = ?", [
      JSON.stringify({
        rounds: [{ provider: "partial", modelId: "m", status: "ok", costUsd: 0.75 }],
      }),
    ]);
    const data = computeProviderStatistics(store, cutoff, cutoff)[0]?.eval;
    expect(data?.totals).toMatchObject({
      invocations: 1,
      successfulShare: 1,
      tokensIn: null,
      inputTokens: null,
      tokensOut: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: 0.75,
      costEquivUsd: null,
      wallTimeMs: 0,
      p50WallTimeMs: null,
    });
    expect(data?.models[0]).toMatchObject({ provider: "partial", modelId: "m" });
    expect(JSON.stringify(data)).not.toContain("NaN");
  } finally {
    store.close();
  }
});
