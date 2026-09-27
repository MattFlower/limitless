import { expect, setSystemTime, test } from "bun:test";
import { computeProviderWorkload } from "../src/db/stats.ts";
import { Store } from "../src/db/store.ts";
import { emptyUsage } from "../src/harness/types.ts";
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
    const rows = computeProviderWorkload(store, localDay(0, 23));
    expect(workloadFor("mtplx", rows)).toEqual({
      provider: "mtplx",
      today: { invocations: 2, tokensIn: 17, tokensOut: 7, wallTimeMs: 3_602_500, costEquivUsd: 0.8 },
      sevenDays: { invocations: 3, tokensIn: 42, tokensOut: 13, wallTimeMs: 7_202_500, costEquivUsd: 1.8 },
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
