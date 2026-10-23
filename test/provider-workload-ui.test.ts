import { expect, spyOn, test } from "bun:test";
import type { EvalTrial } from "../src/core/types.ts";
import { computeProviderStatistics, type ProviderWorkload } from "../src/db/stats.ts";
import { Store } from "../src/db/store.ts";
import { getProviderWorkload } from "../ui/api.ts";
import {
  createProviderWorkloadController,
  initialWorkloadState,
  workloadCell,
  workloadFor,
  workloadTables,
} from "../ui/lib/provider-workload.ts";
import type { subscribeLiveUpdates } from "../ui/store.ts";
import { deferred } from "./evals-support.ts";

const totals = { invocations: 1, tokensIn: 100, tokensOut: 10, wallTimeMs: 1000, costEquivUsd: 1 };
const payload = (provider: string): ProviderWorkload[] => [{ provider, today: totals, sevenDays: totals }];
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function fixture(clock = () => new Date(2026, 9, 22, 12).getTime()) {
  let state = initialWorkloadState();
  const publications: (typeof state)[] = [];
  const reads: { since: number; pending: ReturnType<typeof deferred<ProviderWorkload[] | Error>> }[] = [];
  let listener: Parameters<typeof subscribeLiveUpdates>[0] = () => {};
  let unsubscribed = false;
  const controller = createProviderWorkloadController(
    async (since) => {
      const pending = deferred<ProviderWorkload[] | Error>();
      reads.push({ since, pending });
      const result = await pending.promise;
      if (result instanceof Error) throw result;
      return result;
    },
    (next) => {
      state = next;
      publications.push(next);
    },
    (next) => {
      listener = next;
      return () => {
        unsubscribed = true;
      };
    },
    clock,
  );
  return {
    controller,
    reads,
    publications,
    state: () => state,
    unsubscribed: () => unsubscribed,
    emit: (message: Parameters<typeof listener>[0] = { kind: "reconnected" }) => listener(message),
    async finish(index: number, value: ProviderWorkload[] | Error) {
      const read = reads[index];
      if (!read) throw new Error("missing read");
      read.pending.resolve(value);
      await flush();
    },
  };
}

test("stored workload aggregates providers and roles across models with independent totals and shares", () => {
  const store = new Store(":memory:");
  const at = new Date(2026, 9, 22, 12).getTime();
  try {
    store.db.exec("PRAGMA foreign_keys = OFF");
    const insert = store.db.query(`INSERT INTO invocations
      (run_id, role, harness, provider, model, model_id, status, started_at, finished_at,
       input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_equiv_usd)
      VALUES ('r', ?, 'fake', ?, ?, ?, 'ok', ?, ?, ?, 0, 0, ?, ?)`);
    for (const [index, [provider, model, role]] of [
      ["alpha", "m1", "spec"],
      ["alpha", "m2", "spec"],
      ["alpha", "m2", "review_shadow"],
      ["beta", "m1", "spec"],
      ["beta", "m1", "review_shadow"],
    ].entries()) {
      const n = index + 1;
      insert.run(role ?? "", provider ?? "", model ?? "", model ?? "", at, at + n * 1000, n * 100, n * 10, n);
    }
    const run = store.createEvalRun({ role: "review", models: ["alpha/m1"], k: 1, maxUsd: 10 }, []);
    const trial: EvalTrial = {
      evalRunId: run.id,
      modelId: "alpha/m1",
      effort: null,
      caseId: "case",
      trial: 0,
      cacheKey: "key",
      harness: "fake",
      status: "ok",
      output: null,
      pass: true,
      score: 1,
      createdAt: at,
      tokensIn: 99,
      tokensOut: 9,
      costUsd: 9,
      costEquivUsd: 9,
      durationMs: 9000,
      details: { provider: "alpha", verifiers: [{ modelId: "beta/m1", effort: "high", candidates: [] }] },
    };
    store.recordEvalTrial(trial);
    const rows = computeProviderStatistics(store, at, at + 10_000);
    const production = workloadTables(rows, "production");
    expect(production.providers.rows).toEqual([
      { name: "alpha", invocations: 3, tokensIn: 600, tokensOut: 60, wallTimeMs: 6000, costEquivUsd: 6 },
      { name: "beta", invocations: 2, tokensIn: 900, tokensOut: 90, wallTimeMs: 9000, costEquivUsd: 9 },
    ]);
    expect(production.roles.rows).toEqual([
      { name: "spec", invocations: 3, tokensIn: 700, tokensOut: 70, wallTimeMs: 7000, costEquivUsd: 7 },
      {
        name: "review_shadow",
        invocations: 2,
        tokensIn: 800,
        tokensOut: 80,
        wallTimeMs: 8000,
        costEquivUsd: 8,
      },
    ]);
    for (const table of [production.providers, production.roles]) {
      expect(table.total).toEqual({
        name: "Total",
        invocations: 5,
        tokensIn: 1500,
        tokensOut: 150,
        wallTimeMs: 15000,
        costEquivUsd: 15,
      });
      expect(workloadCell("invocations", table.rows[0]?.invocations, table.total.invocations)).toEqual({
        value: "3",
        share: "60%",
      });
      expect(workloadCell("costEquivUsd", table.total.costEquivUsd, table.total.costEquivUsd)).toEqual({
        value: "$15.00",
        share: "100%",
      });
    }
    expect(workloadCell("tokensIn", 600, 1500)).toEqual({ value: "600", share: "40%" });
    expect(workloadCell("tokensOut", 60, 150)).toEqual({ value: "60", share: "40%" });
    expect(workloadCell("tokensIn", 700, 1500)).toEqual({ value: "700", share: "47%" });
    expect(workloadCell("wallTimeMs", 6000, 15000)).toEqual({ value: "6s", share: "40%" });
    const evaluation = workloadTables(rows, "eval");
    expect(evaluation.providers.rows).toEqual([
      {
        name: "(compound/unattributed)",
        invocations: 1,
        tokensIn: 99,
        tokensOut: 9,
        wallTimeMs: 9000,
        costEquivUsd: 9,
      },
    ]);
    expect(evaluation.roles.rows[0]?.name).toBe("review");
    expect(evaluation.roles.total.invocations).toBe(1);
    expect(evaluation.providers.total.costEquivUsd).toBe(9);
  } finally {
    store.close();
  }
});

test("compatibility, null propagation and opaque names preserve independent known columns", () => {
  const rows = [
    { provider: "legacy", today: totals, sevenDays: totals },
    { provider: "z", production: { totals, roles: [{ ...totals, role: "review_shadow", tokensIn: null }] } },
    {
      provider: "(unknown)",
      production: {
        totals: { ...totals, tokensIn: null },
        roles: [
          { ...totals, role: "review_shadow" },
          { ...totals, extra: 5 },
        ],
      },
      extra: "ignored",
    },
    {
      provider: "a",
      production: { totals: { ...totals, tokensOut: "bad", wallTimeMs: Infinity, costEquivUsd: undefined } },
    },
    { provider: "invalid-count", production: { totals: { ...totals, invocations: "1" } } },
  ];
  const result = workloadTables(rows, "production");
  expect(result.unavailable).toEqual(["legacy"]);
  expect(result.providers.rows.map((r) => r.name)).toEqual(["(unknown)", "a", "z"]);
  expect(result.providers.total).toEqual({
    name: "Total",
    invocations: 3,
    tokensIn: null,
    tokensOut: null,
    wallTimeMs: null,
    costEquivUsd: null,
  });
  expect(result.roles.rows).toEqual([
    {
      name: "review_shadow",
      invocations: 2,
      tokensIn: null,
      tokensOut: 20,
      wallTimeMs: 2000,
      costEquivUsd: 2,
    },
    { name: "(unknown role)", ...totals },
  ]);
  expect(result.roles.total).toEqual({
    name: "Total",
    invocations: 3,
    tokensIn: null,
    tokensOut: 30,
    wallTimeMs: 3000,
    costEquivUsd: 3,
  });
  expect(workloadCell("tokensIn", null, null)).toEqual({ value: "unknown", share: "—" });
  expect(workloadCell("tokensIn", 100, null)).toEqual({ value: "100", share: "—" });
  expect(workloadTables(rows, "eval").providers.total.invocations).toBe(0);
  expect(workloadTables([{ provider: "eval only", eval: { totals } }], "production").unavailable).toEqual([
    "eval only",
  ]);
  expect(
    workloadTables([{ provider: "eval only", eval: { totals } }], "eval").providers.total.invocations,
  ).toBe(1);
  expect(workloadTables([{ provider: "empty", production: { totals } }], "production").roles.rows).toEqual(
    [],
  );
});

for (const section of ["production", "eval"] as const) {
  const valid = { provider: "valid", [section]: { totals, roles: [{ ...totals, role: "spec" }] } };
  test.each([undefined, null, {}, "roles", 5].map((value) => [value]))(
    `${section}: roles collection %j is absent`,
    (roles) => {
      const result = workloadTables([valid, { provider: "other", [section]: { roles } }], section);
      expect(result.roles.rows).toEqual([{ name: "spec", ...totals }]);
      expect(result.roles.total).toEqual({ name: "Total", ...totals });
    },
  );
  test.each([null, [], "role", 5, true].map((value) => [value]))(
    `${section}: role entry %j is skipped`,
    (entry) => {
      const result = workloadTables([valid, { provider: "other", [section]: { roles: [entry] } }], section);
      expect(result.roles.rows).toEqual([{ name: "spec", ...totals }]);
      expect(result.roles.total).toEqual({ name: "Total", ...totals });
    },
  );
  test.each([undefined, null, 5, {}, [], true].map((value) => [value]))(
    `${section}: role name %j groups and sorts as unknown`,
    (role) => {
      const result = workloadTables(
        [valid, { provider: "other", [section]: { roles: [{ ...totals, role }, { ...totals }] } }],
        section,
      );
      expect(result.roles.rows).toEqual([
        {
          name: "(unknown role)",
          invocations: 2,
          tokensIn: 200,
          tokensOut: 20,
          wallTimeMs: 2000,
          costEquivUsd: 2,
        },
        { name: "spec", ...totals },
      ]);
      expect(result.roles.total).toEqual({
        name: "Total",
        invocations: 3,
        tokensIn: 300,
        tokensOut: 30,
        wallTimeMs: 3000,
        costEquivUsd: 3,
      });
      expect(
        workloadCell("tokensIn", result.roles.rows[0]?.tokensIn, result.roles.total.tokensIn).share,
      ).toBe("67%");
      const tied = workloadTables([valid, { [section]: { roles: [{ ...totals, role }] } }], section);
      expect(tied.roles.rows.map((row) => row.name)).toEqual(["(unknown role)", "spec"]);
    },
  );
  test.each([undefined, null, 5, {}, [], true, ""].map((value) => [value]))(
    `${section}: provider name %j is safe`,
    (provider) => {
      const name = typeof provider === "string" ? provider : "(unknown)";
      const result = workloadTables([valid, { provider, [section]: { totals } }, { provider }], section);
      expect(result.providers.rows).toEqual([
        { name, ...totals },
        { name: "valid", ...totals },
      ]);
      expect(result.providers.total).toEqual({
        name: "Total",
        invocations: 2,
        tokensIn: 200,
        tokensOut: 20,
        wallTimeMs: 2000,
        costEquivUsd: 2,
      });
      expect(result.unavailable).toEqual([name]);
    },
  );
  test.each([undefined, null, [], "section", 5, false].map((value) => [value]))(
    `${section}: section %j is unavailable`,
    (history) => {
      const result = workloadTables([valid, { provider: "legacy", [section]: history }], section);
      expect(result.unavailable).toEqual(["legacy"]);
      expect(result.providers.rows).toEqual([{ name: "valid", ...totals }]);
      expect(result.providers.total).toEqual({ name: "Total", ...totals });
    },
  );
  test.each(
    [undefined, null, [], "totals", 5, {}, { invocations: "1" }, { invocations: 0 }].map((value) => [value]),
  )(`${section}: totals %j contribute no provider row but retain roles`, (invalidTotals) => {
    const result = workloadTables(
      [valid, { provider: "other", [section]: { totals: invalidTotals, roles: [{ ...totals, role: "" }] } }],
      section,
    );
    expect(result.unavailable).toEqual([]);
    expect(result.providers.rows).toEqual([{ name: "valid", ...totals }]);
    expect(result.providers.total).toEqual({ name: "Total", ...totals });
    expect(result.roles.rows).toEqual([
      { name: "", ...totals },
      { name: "spec", ...totals },
    ]);
  });
}

test.each([null, [], "provider", 5, true].map((value) => [value]))(
  "provider entry %j is skipped in tables and card lookup",
  (entry) => {
    const valid = { provider: "valid", today: totals, sevenDays: totals, production: { totals } };
    const rows = [entry, valid];
    const result = workloadTables(rows, "production");
    expect(result.providers.rows).toEqual([{ name: "valid", ...totals }]);
    expect(result.providers.total).toEqual({ name: "Total", ...totals });
    expect(result.unavailable).toEqual([]);
    const cardRows = rows as unknown as ProviderWorkload[];
    expect(workloadFor("valid", cardRows) === valid).toBe(true);
    expect(workloadFor("absent", cardRows)).toEqual({
      provider: "absent",
      today: { invocations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0, costEquivUsd: 0 },
      sevenDays: { invocations: 0, tokensIn: 0, tokensOut: 0, wallTimeMs: 0, costEquivUsd: 0 },
    });
  },
);

test("missing and malformed metrics stay unknown, and shares use whole-percent boundaries", () => {
  for (const bad of [null, undefined, "12", NaN, Infinity, -Infinity, {}]) {
    for (const key of ["invocations", "tokensIn", "tokensOut", "wallTimeMs", "costEquivUsd"] as const)
      expect(workloadCell(key, bad, 100)).toEqual({ value: "unknown", share: "—" });
    expect(workloadCell("tokensIn", 1, bad).share).toBe("—");
    const result = workloadTables(
      [
        {
          provider: "p",
          production: {
            totals: { ...totals, tokensIn: bad },
            roles: [{ invocations: bad, wallTimeMs: bad }],
          },
        },
      ],
      "production",
    );
    expect(result.providers.total.tokensIn).toBeNull();
    expect(result.providers.total.tokensOut).toBe(10);
    expect(result.roles.total.invocations).toBeNull();
    expect(result.roles.total.wallTimeMs).toBeNull();
  }
  expect(workloadCell("tokensIn", 1, 0).share).toBe("—");
  expect(workloadCell("tokensIn", 0, 100).share).toBe("0%");
  expect(workloadCell("tokensIn", 0.49, 100).share).toBe("<1%");
  expect(workloadCell("tokensIn", 0.5, 100).share).toBe("1%");
  expect(workloadCell("tokensIn", 33.3, 100).share).toBe("33%");
  expect(workloadCell("tokensIn", 0, 0).share).toBe("—");
});

test("calendar cutoffs use local dates, roll at midnight and span DST", async () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  let now = new Date("2026-03-10T23:59:00-04:00").getTime();
  const f = fixture(() => now);
  try {
    const first = f.controller.load();
    expect(f.reads[0]?.since).toBe(new Date("2026-03-10T00:00:00-04:00").getTime());
    await f.finish(0, payload("today"));
    await first;
    f.controller.setWindow("sevenDays");
    expect(f.reads[1]?.since).toBe(new Date("2026-03-04T00:00:00-05:00").getTime());
    await f.finish(1, payload("week"));
    now = new Date("2026-03-11T00:01:00-04:00").getTime();
    const poll = f.controller.load();
    expect(f.state().rows).toBeNull();
    expect(f.reads[2]?.since).toBe(new Date("2026-03-05T00:00:00-05:00").getTime());
    await f.finish(2, payload("next week"));
    await poll;
    f.controller.setWindow("today");
    expect(f.reads[3]?.since).toBe(new Date("2026-03-11T00:00:00-04:00").getTime());
    await f.finish(3, []);
  } finally {
    f.controller.dispose();
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("window change clears tables and stale successes and errors cannot replace newer figures", async () => {
  const f = fixture();
  try {
    const first = f.controller.load();
    await f.finish(0, payload("accepted"));
    await first;
    const older = f.controller.load();
    f.controller.setWindow("sevenDays");
    expect(f.state().rows).toBeNull();
    expect(f.state().cards).toEqual(payload("accepted"));
    await f.finish(2, payload("week"));
    await f.finish(1, payload("late today"));
    await older;
    expect(f.state().rows).toEqual(payload("week"));
    expect(f.state().cards).toEqual(payload("week"));
    const superseded = f.controller.load();
    const current = f.controller.load();
    await f.finish(4, payload("current"));
    await current;
    await f.finish(3, new Error("stale error"));
    await superseded;
    expect(f.state().error).toBe("");
    expect(f.state().rows).toEqual(payload("current"));
  } finally {
    f.controller.dispose();
  }
});

test("failed same-window poll retains tables and cards, then success clears the error", async () => {
  const f = fixture();
  try {
    const first = f.controller.load();
    await f.finish(0, payload("good"));
    await first;
    const poll = f.controller.load();
    await f.finish(1, new Error("poll failed"));
    await poll;
    expect(f.state().rows).toEqual(payload("good"));
    expect(f.state().cards).toEqual(payload("good"));
    expect(f.state().error).toContain("poll failed");
    const recovery = f.controller.load();
    await f.finish(2, payload("recovered"));
    await recovery;
    expect(f.state().error).toBe("");
    expect(f.state().rows).toEqual(payload("recovered"));
  } finally {
    f.controller.dispose();
  }
});

test("reconnects coalesce until outstanding reads settle and follow the current window", async () => {
  const f = fixture();
  try {
    f.emit({ kind: "invocation" } as Parameters<typeof f.emit>[0]);
    expect(f.reads).toHaveLength(0);
    const first = f.controller.load();
    f.emit();
    f.emit();
    f.emit();
    expect(f.reads).toHaveLength(1);
    f.controller.setWindow("sevenDays");
    await f.finish(1, payload("week"));
    expect(f.reads).toHaveLength(2);
    await f.finish(0, payload("old"));
    await first;
    expect(f.reads).toHaveLength(3);
    expect(f.reads[2]?.since).toBe(new Date(2026, 9, 16).getTime());
    await f.finish(2, payload("refreshed"));
    expect(f.reads).toHaveLength(3);
    expect(f.state().rows).toEqual(payload("refreshed"));
    f.emit();
    expect(f.reads).toHaveLength(4);
    await f.finish(3, []);
  } finally {
    f.controller.dispose();
  }
});

test("dispose invalidates pending success and error, prevents followups and unsubscribes", async () => {
  for (const value of [payload("late"), new Error("late error")]) {
    const f = fixture();
    const read = f.controller.load();
    f.emit();
    const count = f.publications.length;
    f.controller.dispose();
    expect(f.unsubscribed()).toBe(true);
    await f.finish(0, value);
    await read;
    f.emit();
    await f.controller.load();
    f.controller.setWindow("sevenDays");
    expect(f.publications).toHaveLength(count);
    expect(f.reads).toHaveLength(1);
    expect(f.state().rows).toBeNull();
  }
});

test("API helper preserves the no-argument URL and serializes since as encoded ISO", async () => {
  const paths: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (path: RequestInfo | URL) => {
        paths.push(String(path));
        return new Response("[]");
      },
      { preconnect() {} },
    ),
  );
  try {
    await getProviderWorkload();
    await getProviderWorkload(Date.UTC(2026, 9, 22));
    expect(paths).toEqual([
      "/api/stats/providers",
      "/api/stats/providers?since=2026-10-22T00%3A00%3A00.000Z",
    ]);
  } finally {
    fetcher.mockRestore();
  }
});
