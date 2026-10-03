import { expect, setSystemTime, test } from "bun:test";
import { computeProviderWorkload } from "../src/db/stats.ts";
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
    inv.run("twilight", localDay(0) - 1, null, 7, 2, 8, 0.2);
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
        "twilight",
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
    expect(workloadFor("twilight", rows)).toEqual({
      provider: "twilight",
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
