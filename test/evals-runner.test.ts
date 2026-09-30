import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheKey } from "../src/evals/cache.ts";
import { pinnedTree, withRepoLock } from "../src/git/repos.ts";
import type { FakeReply } from "../src/harness/fake.ts";
import { selectHarness } from "../src/harness/select.ts";
import { FACTORY_PREAMBLE, triagePrompt } from "../src/pipeline/prompts.ts";
import { TriageSchema, toStrictJsonSchema } from "../src/pipeline/schemas.ts";
import { sh } from "../src/util/proc.ts";
import { answer, deferred, evalFixture } from "./evals-support.ts";

test("3 cases x 2 exact models x k=2 use pinned bare inputs and shared invocation semantics", async () => {
  const f = await evalFixture();
  try {
    const arrived = deferred<void>();
    const release = deferred<void>();
    const busy = new Set<string>();
    f.respond(async (s) => {
      expect(busy.has(s.target.modelId)).toBe(false);
      busy.add(s.target.modelId);
      if (busy.size === 2) arrived.resolve();
      await release.promise;
      busy.delete(s.target.modelId);
      return { structured: answer };
    });
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a", "candidate-b"], k: 2 });
    await arrived.promise;
    expect(f.calls).toHaveLength(2);
    release.resolve();
    await f.factory.evals.wait(run.id);
    const report = f.factory.evals.report(run.id);
    expect(report?.run.status).toBe("completed");
    expect(report?.trials).toHaveLength(12);
    expect(f.calls).toHaveLength(12);
    for (const model of run.models) {
      expect(f.calls.filter((s) => s.target.modelId === model).map((s) => s.prompt)).toEqual(
        f.dataset.cases.flatMap((item) =>
          Array(2).fill(triagePrompt({ repoSlug: item.repo, prompt: item.prompt, tree: "PINNED.txt" })),
        ),
      );
    }
    for (const spec of f.calls) {
      expect(spec.systemAppend).toBe(FACTORY_PREAMBLE);
      expect(spec.jsonSchema).toEqual(toStrictJsonSchema(TriageSchema));
      expect(spec.schema).toBe(TriageSchema);
      expect(spec.noTools).toBe(true);
      expect(spec.mode).toBe("readonly");
      expect(spec.prompt).not.toContain("CURRENT.txt");
      expect(spec.prompt).not.toContain("SECRET_TAG");
      expect(spec.prompt).not.toContain('"gold"');
      expect(spec.cwd).not.toBe(f.source);
      expect(existsSync(spec.cwd)).toBe(false);
    }
    expect(new Set(f.harnessNames)).toEqual(new Set(["llm", "fake"]));
    expect(existsSync(join(f.cache, "worktrees"))).toBe(false);
    expect((await sh(["git", "rev-parse", "--is-bare-repository"], { cwd: f.cache })).stdout.trim()).toBe(
      "true",
    );
    expect(readFileSync(join(f.source, "CURRENT.txt"), "utf8")).toBe("new");
    const target = f.calls[0]?.target;
    if (!target) throw new Error("missing target");
    for (const role of ["triage", "chat", "summarize"] as const) {
      expect(selectHarness(role, { ...target, openai: { baseUrl: "unused", authToken: "" } })).toEqual({
        harnessName: "llm",
        noTools: true,
      });
      expect(selectHarness(role, { ...target, openai: undefined })).toEqual({
        harnessName: "fake",
        noTools: true,
      });
    }
    expect(selectHarness("implement", target)).toEqual({ harnessName: "fake", noTools: false });
    expect(selectHarness("holdout", target, true)).toEqual({ harnessName: "fake", noTools: true });
  } finally {
    await f.close();
  }
});

test("cache reuses schema-valid successes including grade failures; regrades current gold with zero spend", async () => {
  const f = await evalFixture();
  try {
    f.respond(() => ({ structured: answer, costUsd: 0.02, costEquivUsd: 0.04, delayMs: 2 }));
    const first = await f.run();
    expect(first.trials).toHaveLength(12);
    const calls = f.calls.length;
    for (const item of f.dataset.cases) item.gold.risk = "high";
    f.save();
    const second = await f.run();
    expect(f.calls).toHaveLength(calls);
    expect(second.trials.every((t) => t.status === "ok" && t.pass === false)).toBe(true);
    expect(
      second.trials.every(
        (t) =>
          t.costUsd === 0 &&
          t.costEquivUsd === 0 &&
          t.tokensIn === 0 &&
          t.tokensOut === 0 &&
          t.durationMs === 0,
      ),
    ).toBe(true);
    expect(second.trials[0]?.details.cache).toMatchObject({
      evalRunId: first.run.id,
      costUsd: 0.02,
      costEquivUsd: 0.04,
      tokensIn: 100,
    });
    expect(second.summaries.every((s) => s.p50LatencyMs === null && s.cached === 6)).toBe(true);
    expect(f.factory.store.providerSpendSince("openrouter", 0)).toBeCloseTo(0.12);
    expect(f.factory.evals.report(first.run.id)?.trials.every((t) => t.pass)).toBe(true);
    const third = await f.run();
    expect(f.calls).toHaveLength(calls);
    expect(third.trials[0]?.details.cache?.evalRunId).toBe(first.run.id);
    await f.run({ cache: false });
    expect(f.calls).toHaveLength(calls * 2);
  } finally {
    await f.close();
  }
});

test("cache identity includes every invocation component and ignores schema object key order", () => {
  const base = cacheKey("model", "fake", "prompt", "system", { a: 1, b: 2 }, 0);
  for (const key of [
    cacheKey("other", "fake", "prompt", "system", { a: 1, b: 2 }, 0),
    cacheKey("model", "llm", "prompt", "system", { a: 1, b: 2 }, 0),
    cacheKey("model", "fake", "changed", "system", { a: 1, b: 2 }, 0),
    cacheKey("model", "fake", "prompt", "changed", { a: 1, b: 2 }, 0),
    cacheKey("model", "fake", "prompt", "system", { a: 2, b: 2 }, 0),
    cacheKey("model", "fake", "prompt", "system", { a: 1, b: 2 }, 1),
  ])
    expect(key).not.toBe(base);
  expect(cacheKey("model", "fake", "prompt", "system", { b: 2, a: 1 }, 0)).toBe(base);
});

test("invalid and non-ok stored outputs never satisfy cache lookup", async () => {
  const f = await evalFixture();
  try {
    const first = await f.run({ models: ["candidate-a"], k: 1, caseIds: ["a"] });
    const t = first.trials[0];
    if (!t) throw new Error("missing trial");
    f.factory.store.recordEvalTrial({ ...t, output: { risk: "low" } });
    await f.run({ models: ["candidate-a"], k: 1, caseIds: ["a"] });
    expect(f.calls).toHaveLength(2);
    for (const r of f.factory.store.listEvalRuns())
      for (const row of f.factory.store.listEvalTrials(r.id))
        f.factory.store.recordEvalTrial({ ...row, status: "error" });
    await f.run({ models: ["candidate-a"], k: 1, caseIds: ["a"] });
    expect(f.calls).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test("zero and exact budgets skip all remaining work; unsuccessful calls retain full costs", async () => {
  const f = await evalFixture();
  try {
    const zero = await f.run({ maxUsd: 0 });
    expect(zero.run.status).toBe("budget_exhausted");
    expect(
      zero.trials.every((t) => t.status === "skipped" && t.details.reason === "eval budget exhausted"),
    ).toBe(true);
    expect(f.calls).toHaveLength(0);
    f.respond(() => ({ status: "error", error: "bad output", costUsd: 0.5, costEquivUsd: 50 }));
    const report = await f.run({ models: ["candidate-a"], maxUsd: 0.5 });
    expect(f.calls).toHaveLength(1);
    expect(report.run.status).toBe("budget_exhausted");
    expect(report.trials[0]).toMatchObject({ status: "error", pass: false, score: 0, costUsd: 0.5 });
    expect(report.trials.filter((t) => t.status === "skipped")).toHaveLength(5);
    expect(f.factory.store.providerSpendSince("openrouter", 0)).toBe(0.5);
    f.respond(() => ({ structured: answer, costEquivUsd: 100 }));
    expect((await f.run({ models: ["candidate-a"], cache: false })).run.status).toBe("completed");
  } finally {
    await f.close();
  }
});

test("in-flight cross-provider overshoot is retained; no calls dispatch after exhaustion", async () => {
  const f = await evalFixture();
  try {
    const started = deferred<void>();
    const finish = deferred<void>();
    f.respond(async () => {
      if (f.calls.length === 2) started.resolve();
      await finish.promise;
      return { structured: answer, costUsd: 0.75 };
    });
    const run = f.factory.evals.submit({
      role: "triage",
      models: ["candidate-a", "candidate-b"],
      k: 2,
      maxUsd: 0.5,
    });
    await started.promise;
    finish.resolve();
    await f.factory.evals.wait(run.id);
    expect(f.calls).toHaveLength(2);
    expect(f.factory.store.evalSpend(run.id)).toBe(1.5);
    expect(f.factory.evals.report(run.id)?.run.status).toBe("budget_exhausted");
  } finally {
    await f.close();
  }
});

test("capacity wait rechecks eligibility and shares slots with other daemon operations", async () => {
  for (const kind of ["reserve", "provider budget", "model", "eval budget"] as const) {
    const f = await evalFixture();
    try {
      const release = await f.factory.tracker.acquire("openrouter", new AbortController().signal);
      const waiting = deferred<void>();
      const acquire = f.factory.tracker.acquire.bind(f.factory.tracker);
      const spy = spyOn(f.factory.tracker, "acquire").mockImplementation((id, signal) => {
        waiting.resolve();
        return acquire(id, signal);
      });
      const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 1 });
      await waiting.promise;
      spy.mockRestore();
      expect(f.calls).toHaveLength(0);
      if (kind === "reserve")
        f.factory.tracker.observeWindows("openrouter", {
          five_hour: { utilization: 1, resetsAt: Date.now() + 60_000 },
        });
      if (kind === "model") f.factory.tracker.blockModel("candidate-a", "not supported");
      if (kind === "provider budget" || kind === "eval budget") {
        const t = f.factory.store.listEvalTrials(run.id)[0];
        if (!t) throw new Error("missing");
        // Simulate a concurrently completed invocation (eval-wide or provider-wide spend).
        const other = f.factory.store.createEvalRun(
          { role: "triage", models: ["candidate-a"], k: 1, maxUsd: 200 },
          [],
        );
        f.factory.store.recordEvalTrial({
          ...t,
          evalRunId: kind === "eval budget" ? run.id : other.id,
          caseId: "concurrent",
          status: "ok",
          costUsd: kind === "eval budget" ? 1 : 100,
          details: { provider: "openrouter" },
        });
        f.factory.store.updateEvalRun(other.id, "completed");
      }
      release();
      await f.factory.evals.wait(run.id);
      expect(f.calls).toHaveLength(0);
      const rows = f.factory.store.listEvalTrials(run.id).filter((t) => t.status === "skipped");
      expect(rows).toHaveLength(3);
      expect(rows[0]?.details.reason).toContain(
        kind === "reserve" ? "reserve" : kind === "model" ? "model rejected" : "budget exhausted",
      );
      expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
    } finally {
      await f.close();
    }
  }
});

test("unavailable candidates, quota, circuit breakers, missing harnesses and throws remain explicit", async () => {
  const f = await evalFixture();
  try {
    f.factory.tracker.setHealthy("openrouter", false);
    const unavailable = await f.run();
    expect(
      unavailable.trials
        .filter((t) => t.modelId === "candidate-a")
        .every((t) => t.details.reason === "server not reachable"),
    ).toBe(true);
    expect(f.calls.every((s) => s.target.modelId === "candidate-b")).toBe(true);
    f.factory.tracker.setHealthy("openrouter", true);
    f.respond(() => ({
      status: "quota",
      error: "quota exhausted",
      costUsd: 0.1,
      quota: { windows: {}, exhaustedUntil: Date.now() + 60_000 },
    }));
    const quota = await f.run({ models: ["candidate-a"], cache: false });
    expect(quota.trials[0]?.status).toBe("error");
    expect(quota.trials[1]?.details.reason).toContain("quota exhausted");
    f.respond(() => {
      throw new Error("fake exception");
    });
    const thrown = await f.run({ models: ["candidate-b"], cache: false });
    expect(thrown.trials.every((t) => t.details.reason === "fake exception")).toBe(true);
    expect(f.factory.tracker.status("provider-b")?.inFlight).toBe(0);
    const fake = f.factory.deps.harnesses.fake;
    if (!fake) throw new Error("missing fake");
    delete f.factory.deps.harnesses.fake;
    const missing = await f.run({ models: ["candidate-b"], cache: false });
    expect(missing.trials.every((t) => t.details.reason === "No harness registered for fake")).toBe(true);
    f.factory.deps.harnesses.fake = fake;
    for (let i = 0; i < 5; i++) f.factory.tracker.record("provider-b", "unavailable");
    const circuit = await f.run({ models: ["candidate-b"], cache: false });
    expect(circuit.trials[0]?.details.reason).toContain("circuit open");
  } finally {
    await f.close();
  }
});

test("shutdown aborts active and waiting trials, releases slots, and preserves partial output", async () => {
  const f = await evalFixture();
  try {
    const entered = deferred<void>();
    f.respond(async (s) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        s.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { structured: answer };
    });
    // Evals share max - 1 = 2 slots; production work holds the rest so the second eval waits on the tracker.
    setLimit(f, "openrouter", 3);
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], concurrency: 1 });
    await entered.promise;
    const held = new AbortController().signal;
    const production = [
      await f.factory.tracker.acquire("openrouter", held),
      await f.factory.tracker.acquire("openrouter", held),
    ];
    const acquiring = deferred<void>();
    const acquire = f.factory.tracker.acquire.bind(f.factory.tracker);
    const spy = spyOn(f.factory.tracker, "acquire").mockImplementation((id, signal) => {
      acquiring.resolve();
      return acquire(id, signal);
    });
    const waiting = f.factory.evals.submit({ role: "triage", models: ["candidate-a"] });
    await acquiring.promise;
    spy.mockRestore();
    await f.factory.stop();
    for (const release of production) release();
    expect(f.factory.evals.report(run.id)?.run).toMatchObject({
      status: "failed",
      error: "eval interrupted by daemon shutdown",
    });
    expect(f.factory.evals.report(waiting.id)?.run.status).toBe("failed");
    const report = f.factory.evals.report(waiting.id);
    expect(report?.trials).toHaveLength(3);
    for (const trial of report?.trials ?? []) {
      expect(trial).toMatchObject({
        status: "skipped",
        pass: null,
        score: null,
        details: { reason: "daemon shutdown" },
      });
      expect(trial.details.preparationFailed).toBeUndefined();
    }
    expect(report?.summaries[0]).toMatchObject({
      evaluatedTrials: 0,
      errors: 0,
      skipped: 3,
      passRate: null,
      predictionTrials: 0,
      latencyDenominator: 0,
    });
    expect(f.calls).toHaveLength(1);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
    expect(
      f.factory.store.listEvalTrials(run.id).every((t) => !["running", "queued"].includes(t.status)),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("bare cache clones/fetches exact pins under existing locks, and never substitutes HEAD", async () => {
  const f = await evalFixture();
  try {
    f.factory.store.upsertRepo({
      slug: "fixture/repo",
      kind: "github",
      url: f.source,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    rmSync(f.cache, { recursive: true, force: true });
    expect(
      await Promise.all([
        pinnedTree(f.cfg.paths, f.factory.store, "fixture/repo", f.sha),
        pinnedTree(f.cfg.paths, f.factory.store, "fixture/repo", f.sha),
      ]),
    ).toEqual(["PINNED.txt", "PINNED.txt"]);
    const hold = deferred<void>();
    const entered = deferred<void>();
    const lock = withRepoLock(f.cache, async () => {
      entered.resolve();
      await hold.promise;
    });
    await entered.promise;
    let complete = false;
    const read = pinnedTree(f.cfg.paths, f.factory.store, "fixture/repo", f.sha).then((tree) => {
      complete = true;
      return tree;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    hold.resolve();
    await lock;
    expect(await read).toBe("PINNED.txt");
    writeFileSync(join(f.source, "FETCHED.txt"), "newer");
    await sh(["git", "add", "."], { cwd: f.source });
    await sh(["git", "commit", "-qm", "new pin"], { cwd: f.source });
    const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
    expect(await pinnedTree(f.cfg.paths, f.factory.store, "fixture/repo", sha)).toBe(
      "CURRENT.txt  FETCHED.txt",
    );
    f.dataset.repos["fixture/repo"] = "0".repeat(40);
    f.save();
    const missing = await f.run();
    // A missing pin fails each of its cases' preparation, never the whole run.
    expect(missing.run.status).toBe("completed");
    expect(f.calls).toHaveLength(0);
    for (const trial of missing.trials) {
      expect(trial).toMatchObject({ status: "error", pass: false, details: { preparationFailed: true } });
      expect(String(trial.details.reason)).toContain("0000000000");
    }
    expect(existsSync(join(f.cache, "worktrees"))).toBe(false);
  } finally {
    await f.close();
  }
});

test("live and final quota telemetry stop later calls; cache replay does not update tracker", async () => {
  const f = await evalFixture();
  try {
    const windows = { five_hour: { utilization: 1, resetsAt: Date.now() + 60_000 } };
    f.respond((spec) => {
      spec.onEvent({ type: "rate_limit", status: "allowed", windows, resetsAt: null });
      return { structured: answer, quota: { windows, exhaustedUntil: null } };
    });
    const limited = await f.run({ models: ["candidate-a"] });
    expect(f.calls).toHaveLength(1);
    expect(limited.trials[1]?.details.reason).toBe("at reserve limit");
    // Cached outputs are usable even when the provider has just hit its reserve.
    expect(f.factory.tracker.unavailableReason("openrouter")).toBe("at reserve limit");
    const record = spyOn(f.factory.tracker, "record");
    const observe = spyOn(f.factory.tracker, "observeWindows");
    const cached = await f.run({ models: ["candidate-a"], caseIds: ["a"], k: 1 });
    expect(cached.summaries[0]?.cached).toBe(1);
    expect(record).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    record.mockRestore();
    observe.mockRestore();
  } finally {
    await f.close();
  }
});

test("two efforts execute independently, cache only equivalent targets, and freeze submitted defaults", async () => {
  const { enableEfforts } = await import("./evals-support.ts");
  const f = await evalFixture();
  try {
    const model = enableEfforts(f);
    const request = { role: "triage", models: ["candidate-a", "candidate-a@high"], k: 1, caseIds: ["a"] };
    const run = f.factory.evals.submit(request);
    // Submission is synchronous; execution starts on the next microtask.
    model.effort = "none";
    await f.factory.evals.wait(run.id);
    expect(f.calls.map((s) => s.target.effort)).toEqual(["low", "high"]);
    const report = f.factory.evals.report(run.id);
    expect(report?.trials.map((t) => [t.modelId, t.effort])).toEqual([
      ["candidate-a", "low"],
      ["candidate-a", "high"],
    ]);
    expect(report?.summaries.map((s) => [s.modelId, s.evaluatedTrials])).toEqual([
      ["candidate-a@low", 1],
      ["candidate-a@high", 1],
    ]);
    const reuse = await f.run({ ...request, models: ["candidate-a@low", "candidate-a@high"] });
    expect(f.calls).toHaveLength(2);
    expect(reuse.summaries.every((s) => s.cached === 1)).toBe(true);
    const different = await f.run({ ...request, models: ["candidate-a"] });
    expect(f.calls.at(-1)?.target.effort).toBe("none");
    expect(different.summaries[0]?.cached).toBe(0);
    model.effort = "low";
    const alias = await f.run({ ...request, models: ["candidate-a"] });
    expect(alias.summaries[0]?.cached).toBe(1);
    const key = (effort?: string | null) =>
      cacheKey("candidate-a", "fake", "prompt", "system", {}, 0, { repo: "pin" }, effort);
    // Legacy (unknown) and deliberately unset ("default") entries never share a key.
    expect(key(null)).toBe(key());
    expect(new Set([key(), key("default"), key("none"), key("low"), key("high")]).size).toBe(5);
  } finally {
    await f.close();
  }
});

test("saved unset effort remains unset after the catalog gains a default", async () => {
  const { enableEfforts } = await import("./evals-support.ts");
  const f = await evalFixture();
  try {
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 1, caseIds: ["a"] });
    enableEfforts(f);
    await f.factory.evals.wait(run.id);
    expect(f.calls[0]?.target.effort).toBeUndefined();
    expect(f.factory.evals.report(run.id)?.trials[0]?.effort).toBe("default");
  } finally {
    await f.close();
  }
});

type Fixture = Awaited<ReturnType<typeof evalFixture>>;
function setLimit(f: Fixture, provider: string, maxConcurrent: number) {
  const def = f.factory.tracker.def(provider);
  if (!def) throw new Error(`missing provider ${provider}`);
  def.maxConcurrent = maxConcurrent;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 2000 && !check(); i++) await Bun.sleep(1);
  if (!check()) throw new Error("condition never held");
}
/** Holds every fake call until released, tracking how many are active at once. */
function gate(f: Fixture, reply: () => FakeReply = () => ({ structured: answer })) {
  const state = { active: 0, max: 0, open: deferred<void>() };
  f.respond(async () => {
    state.max = Math.max(state.max, ++state.active);
    await state.open.promise;
    state.active--;
    return reply();
  });
  return state;
}

test("concurrency runs N trials at once per provider when the provider allows more", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 3);
    const state = gate(f);
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 2, concurrency: 2 });
    expect(run.concurrency).toBe(2);
    await until(() => state.active === 2);
    await Bun.sleep(20);
    expect(f.calls).toHaveLength(2);
    state.open.resolve();
    await f.factory.evals.wait(run.id);
    const report = f.factory.evals.report(run.id);
    expect(state.max).toBe(2);
    expect(report?.run).toMatchObject({ status: "completed", concurrency: 2 });
    expect(report?.trials.every((t) => t.status === "ok")).toBe(true);
    expect(f.calls).toHaveLength(6);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
  } finally {
    await f.close();
  }
});

test("omitted concurrency defaults to 2", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 5);
    const state = gate(f);
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 2 });
    await until(() => state.active === 2);
    await Bun.sleep(20);
    expect(state.active).toBe(2);
    state.open.resolve();
    await f.factory.evals.wait(run.id);
    expect(state.max).toBe(2);
    expect(f.factory.evals.report(run.id)?.run.concurrency).toBe(2);
  } finally {
    await f.close();
  }
});

test("provider limits and slots held by other daemon work cap eval concurrency", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 1);
    let state = gate(f);
    const first = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 2, concurrency: 3 });
    await until(() => state.active === 1);
    await Bun.sleep(20);
    state.open.resolve();
    await f.factory.evals.wait(first.id);
    expect(state.max).toBe(1);
    expect(f.calls).toHaveLength(6);

    // Evals take at most max - 1 = 3 slots; two held by other work leave them 2.
    setLimit(f, "openrouter", 4);
    const held = new AbortController().signal;
    const release = await f.factory.tracker.acquire("openrouter", held);
    const releaseOther = await f.factory.tracker.acquire("openrouter", held);
    state = gate(f);
    const second = f.factory.evals.submit({
      role: "triage",
      models: ["candidate-a"],
      k: 2,
      concurrency: 3,
      cache: false,
    });
    await until(() => state.active === 2);
    await Bun.sleep(20);
    expect(state.active).toBe(2);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(4);
    release();
    await until(() => state.active === 3);
    await Bun.sleep(20);
    releaseOther();
    state.open.resolve();
    await f.factory.evals.wait(second.id);
    expect(state.max).toBe(3);
    expect(f.factory.evals.report(second.id)?.run.status).toBe("completed");
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
  } finally {
    await f.close();
  }
});

test("budget stops new trials while concurrent in-flight trials finish and keep their costs", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 4);
    const state = gate(f, () => ({ structured: answer, costUsd: 0.5 }));
    const run = f.factory.evals.submit({
      role: "triage",
      models: ["candidate-a"],
      k: 2,
      concurrency: 3,
      maxUsd: 0.5,
    });
    await until(() => state.active === 3);
    state.open.resolve();
    await f.factory.evals.wait(run.id);
    const report = f.factory.evals.report(run.id);
    expect(f.calls).toHaveLength(3);
    expect(f.factory.store.evalSpend(run.id)).toBe(1.5);
    expect(report?.run.status).toBe("budget_exhausted");
    expect(report?.trials.filter((t) => t.status === "ok")).toHaveLength(3);
    const skipped = report?.trials.filter((t) => t.status === "skipped") ?? [];
    expect(skipped).toHaveLength(3);
    expect(skipped.every((t) => t.details.reason === "eval budget exhausted")).toBe(true);
  } finally {
    await f.close();
  }
});

test("shutdown interrupts concurrent trials, releases slots, and a resubmission reuses cached trials", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 3);
    let active = 0;
    f.respond(async (s) => {
      // The first two calls complete; the rest hold until the daemon stops.
      if (f.calls.length <= 2) return { structured: answer };
      active++;
      await new Promise<void>((resolve) =>
        s.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { structured: answer };
    });
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 2, concurrency: 2 });
    await until(() => active === 2);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(2);
    await f.factory.stop();
    const report = f.factory.evals.report(run.id);
    expect(report?.run).toMatchObject({ status: "failed", error: "eval interrupted by daemon shutdown" });
    expect(report?.trials.every((t) => !["queued", "running"].includes(t.status))).toBe(true);
    expect(report?.trials.filter((t) => t.status === "ok")).toHaveLength(2);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
    expect(f.calls).toHaveLength(4);

    const { EvalRunner } = await import("../src/evals/runner.ts");
    const runner = new EvalRunner(f.factory.deps, f.casePath);
    f.respond(() => ({ structured: answer }));
    const again = runner.submit({ role: "triage", models: ["candidate-a"], k: 2, concurrency: 2 });
    await runner.wait(again.id);
    const resumed = runner.report(again.id);
    expect(resumed?.run.status).toBe("completed");
    expect(resumed?.trials.filter((t) => t.details.cache?.evalRunId === run.id)).toHaveLength(2);
    expect(f.calls).toHaveLength(8);
  } finally {
    await f.close();
  }
});

test("completion order never changes cache keys, grades or report order", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 4);
    // Case b fails its gold so grades differ across cases.
    const reply = (s: { prompt: string }) => ({
      structured: s.prompt.includes("Fix b") ? { ...answer, risk: "high" as const } : answer,
    });
    f.respond(reply);
    const sequential = await f.run({ models: ["candidate-a"], concurrency: 1, cache: false });
    const pending: (() => void)[] = [];
    f.respond(async (s) => {
      const done = deferred<void>();
      pending.push(() => done.resolve());
      // Release each batch of three in reverse submission order.
      if (pending.length === 3)
        for (const [i, resolve] of pending.splice(0).reverse().entries()) setTimeout(resolve, i * 5);
      await done.promise;
      return reply(s);
    });
    const reversed = await f.run({ models: ["candidate-a"], concurrency: 3, cache: false });
    const view = (r: typeof sequential) =>
      r.trials.map((t) => [t.caseId, t.modelId, t.trial, t.cacheKey, t.status, t.pass, t.score, t.output]);
    expect(view(reversed)).toEqual(view(sequential));
    expect(view(sequential).map((t) => t[5])).toEqual([true, true, false, false, true, true]);
    expect(reversed.summaries.map((s) => [s.passRate, s.evaluatedTrials])).toEqual(
      sequential.summaries.map((s) => [s.passRate, s.evaluatedTrials]),
    );
  } finally {
    await f.close();
  }
});

test("concurrent trials sharing a cache key reuse the earliest queued trial regardless of completion", async () => {
  for (const failFirst of [false, true]) {
    const f = await evalFixture();
    try {
      setLimit(f, "openrouter", 4);
      for (const item of f.dataset.cases) item.prompt = "same";
      f.save();
      const held = deferred<void>();
      f.respond(async () => {
        const call = f.calls.length;
        if (call === 1) {
          await held.promise;
          return failFirst ? { status: "error" as const, error: "boom" } : { structured: answer };
        }
        return { structured: { ...answer, risk: "high" as const } };
      });
      const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 1, concurrency: 3 });
      await until(() => f.calls.length === 1);
      await Bun.sleep(30);
      // Later trials with the same key wait for the first instead of racing it.
      expect(f.calls).toHaveLength(1);
      held.resolve();
      await f.factory.evals.wait(run.id);
      const trials = f.factory.evals.report(run.id)?.trials ?? [];
      expect(trials.map((t) => [t.caseId, t.status, t.details.cache?.caseId ?? null])).toEqual(
        failFirst
          ? [
              ["a", "error", null],
              ["b", "ok", null],
              ["c", "ok", "b"],
            ]
          : [
              ["a", "ok", null],
              ["b", "ok", "a"],
              ["c", "ok", "a"],
            ],
      );
      expect(f.calls).toHaveLength(failFirst ? 2 : 1);
    } finally {
      await f.close();
    }
  }
});

test("concurrent eval runs share max - 1 provider slots, leaving one for production", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 3);
    const state = gate(f);
    const request = { role: "triage", models: ["candidate-a"], k: 2, concurrency: 3, cache: false };
    const runs = [f.factory.evals.submit(request), f.factory.evals.submit(request)];
    await until(() => state.active === 2);
    await Bun.sleep(20);
    expect(state.active).toBe(2);
    // Production work still gets the remaining slot while both evals have queued trials.
    const release = await f.factory.tracker.acquire("openrouter", new AbortController().signal);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(3);
    release();
    state.open.resolve();
    for (const run of runs) await f.factory.evals.wait(run.id);
    expect(state.max).toBe(2);
    expect(runs.map((run) => f.factory.evals.report(run.id)?.run.status)).toEqual(["completed", "completed"]);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
  } finally {
    await f.close();
  }
});

test("the shared eval cap follows the largest concurrency among running evals", async () => {
  const f = await evalFixture();
  try {
    setLimit(f, "openrouter", 5);
    let state = gate(f);
    const submit = (concurrency: number) =>
      f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 2, concurrency, cache: false });
    // Own caps of 1 and 2 would allow 3, but the shared cap is the largest request, 2.
    const runs = [submit(1), submit(2)];
    await until(() => state.active === 2);
    await Bun.sleep(20);
    expect(state.active).toBe(2);
    // A run asking for 3 raises the shared cap to 3 (still under max - 1 = 4).
    runs.push(submit(3));
    await until(() => state.active === 3);
    await Bun.sleep(20);
    expect(state.active).toBe(3);
    state.open.resolve();
    for (const run of runs) await f.factory.evals.wait(run.id);
    expect(state.max).toBe(3);
    // Once they finish the shared cap shrinks back: two concurrency-1 runs share one slot.
    state = gate(f);
    const later = [submit(1), submit(1)];
    await until(() => state.active === 1);
    await Bun.sleep(20);
    expect(state.active).toBe(1);
    state.open.resolve();
    for (const run of later) await f.factory.evals.wait(run.id);
    expect(state.max).toBe(1);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
  } finally {
    await f.close();
  }
});

/** Tracker acquisitions after the first `after` wait until aborted, like a daemon dying before a call. */
function stallAcquire(f: Fixture, after: number) {
  const tracker = f.factory.tracker;
  const acquire = tracker.acquire.bind(tracker);
  const stalled = deferred<void>();
  let n = 0;
  spyOn(tracker, "acquire").mockImplementation((id, signal) => {
    if (n++ < after) return acquire(id, signal);
    stalled.resolve();
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  });
  return stalled.promise;
}
const promptCalls = (f: Fixture, id: string) =>
  f.calls.filter((s) => new RegExp(`Fix ${id}\\b`).test(s.prompt)).length;

test("a restart resumes a run under its ID, keeps completed trials and runs each remaining trial once", async () => {
  const f = await evalFixture();
  try {
    f.respond(() => ({ structured: answer, costUsd: 0.1 }));
    const stalled = stallAcquire(f, 2);
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 2, maxUsd: 5 });
    await stalled;
    const before = f.factory.store.listEvalTrials(run.id);
    expect(before.map((t) => t.status)).toEqual(["ok", "ok", "queued", "queued", "queued", "queued"]);
    expect(f.calls).toHaveLength(2);

    f.crash();
    await Bun.sleep(20);
    expect(f.calls).toHaveLength(2);
    expect(f.factory.store.getEvalRun(run.id)?.status).toBe("running");
    f.factory.start();
    await f.factory.evals.wait(run.id);
    const report = f.factory.evals.report(run.id);
    expect(report?.run).toMatchObject({ id: run.id, status: "completed", error: null });
    expect(f.factory.store.listEvalRuns()).toHaveLength(1);
    expect(report?.trials.map((t) => [t.caseId, t.trial, t.status])).toEqual(
      ["a", "b", "c"].flatMap((id) => [
        [id, 0, "ok"],
        [id, 1, "ok"],
      ]),
    );
    expect(report?.trials.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(report?.trials.map((t) => t.details.resumed ?? false)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
    expect(f.calls).toHaveLength(6);
    expect(["a", "b", "c"].map((id) => promptCalls(f, id))).toEqual([2, 2, 2]);
    expect(f.factory.store.evalSpend(run.id)).toBeCloseTo(0.6);
    expect(f.factory.store.evalCallAttempts(run.id).every((a) => a.resolved && !a.usageUnknown)).toBe(true);
  } finally {
    await f.close();
  }
});

test("a crash during a call never replays it: unknown usage blocks paid calls while cached work finishes", async () => {
  const f = await evalFixture();
  try {
    f.respond(() => ({ structured: answer, costUsd: 0.1 }));
    const prior = await f.run({ models: ["candidate-a"], k: 1, caseIds: ["c"] });
    const hung = deferred<void>();
    f.respond((s) => {
      if (!/Fix b\b/.test(s.prompt)) return { structured: answer, costUsd: 0.1 };
      hung.resolve();
      // The daemon dies mid-call: this call never returns, and its spend is never reported.
      return new Promise<never>(() => undefined);
    });
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 2, maxUsd: 5 });
    await hung.promise;
    expect(f.factory.store.evalCallAttempts(run.id).map((a) => a.resolved)).toEqual([true, true, false]);
    // A trial still recorded as running with zero usage is exactly what a crash mid-call leaves.
    expect(f.factory.store.listEvalTrials(run.id)[2]).toMatchObject({ status: "running", costUsd: 0 });
    const calls = f.calls.length;

    f.crash();
    f.respond(() => ({ structured: answer, costUsd: 0.1 }));
    f.factory.start();
    await f.factory.evals.wait(run.id);
    expect(f.calls).toHaveLength(calls);
    expect(promptCalls(f, "b")).toBe(1);
    const report = f.factory.evals.report(run.id);
    expect(report?.run.status).toBe("budget_exhausted");
    expect(report?.run.error).toContain("unknown spend");
    const [a0, a1, b0, b1, c0, c1] = report?.trials ?? [];
    expect([a0?.status, a1?.status]).toEqual(["ok", "ok"]);
    expect(b0).toMatchObject({
      status: "error",
      pass: false,
      details: { interrupted: true, usageUnknown: true },
    });
    expect(b0?.details.reason).toContain("final usage unknown");
    // No further paid calls; only the trial with a cached output completes, at no charge.
    expect(b1).toMatchObject({ status: "skipped", details: { resumed: true } });
    expect(b1?.details.reason).toBe(report?.run.error ?? "");
    expect(c0).toMatchObject({ status: "ok", costUsd: 0, details: { cache: { evalRunId: prior.run.id } } });
    expect(c1?.status).toBe("skipped");
    expect(f.factory.store.evalSpend(run.id)).toBeCloseTo(0.2);
    const { formatEvalReport } = await import("../src/evals/format.ts");
    if (!report) throw new Error("missing report");
    expect(formatEvalReport(report)).toContain(
      "restart recovery: 3 trials resumed, 1 interrupted and not replayed, 1 with unknown final usage",
    );
  } finally {
    await f.close();
  }
});

test("crash boundaries: no intent runs once, a resolved call keeps its cost, a recorded result is kept", async () => {
  const f = await evalFixture();
  try {
    f.respond(() => ({ structured: answer, costUsd: 0.25, costEquivUsd: 0.5 }));
    const stalled = stallAcquire(f, 1);
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 1, maxUsd: 5 });
    await stalled;
    const { store } = f.factory;
    const [a, b, c] = store.listEvalTrials(run.id);
    if (!a || !b || !c) throw new Error("missing trials");
    expect(a).toMatchObject({ status: "ok", costUsd: 0.25 });
    // b crashed after being marked running but before its call intent was written.
    store.recordEvalTrial({ ...b, status: "running", harness: "llm" });
    // c's call returned and resolved, but the daemon died before the trial recorded it.
    store.recordEvalTrial({ ...c, status: "running" });
    const { evalTrialKey } = await import("../src/db/store.ts");
    const call = store.beginEvalCall(run.id, evalTrialKey(c), "openrouter", "candidate-a");
    store.resolveEvalCall(call, { status: "ok", costUsd: 0.4, costEquivUsd: 0.8 });

    f.crash();
    f.factory.start();
    await f.factory.evals.wait(run.id);
    expect([promptCalls(f, "a"), promptCalls(f, "b"), promptCalls(f, "c")]).toEqual([1, 1, 0]);
    const report = f.factory.evals.report(run.id);
    expect(report?.run.status).toBe("completed");
    expect(report?.trials[0]).toEqual({ ...a });
    expect(report?.trials[1]).toMatchObject({
      status: "ok",
      pass: true,
      costUsd: 0.25,
      details: { resumed: true },
    });
    expect(report?.trials[2]).toMatchObject({
      status: "error",
      costUsd: 0.4,
      costEquivUsd: 0.8,
      details: { interrupted: true },
    });
    expect(report?.trials[2]?.details.usageUnknown).toBeUndefined();
    expect(f.factory.store.evalSpend(run.id)).toBeCloseTo(0.9);
  } finally {
    await f.close();
  }
});

test("constructing a factory resumes nothing; start resumes after the tracker and tunnels, once", async () => {
  const { SshTunnels } = await import("../src/util/ssh-tunnel.ts");
  const f = await evalFixture();
  const order: string[] = [];
  const tunnels = spyOn(SshTunnels.prototype, "start").mockImplementation(() => {
    order.push("tunnels");
  });
  try {
    const stalled = stallAcquire(f, 0);
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 1 });
    await stalled;
    const factory = f.crash();
    f.respond(() => {
      order.push("call");
      return { structured: answer };
    });
    await Bun.sleep(20);
    expect(f.calls).toHaveLength(0);
    expect(factory.store.getEvalRun(run.id)?.status).toBe("running");
    // Resuming requeues trials synchronously, so construction left them untouched.
    expect(factory.store.listEvalTrials(run.id).some((t) => t.details.resumed)).toBe(false);
    expect(factory.store.getEvalResume(run.id)?.state).toBe("active");
    const evalsStart = factory.evals.start.bind(factory.evals);
    spyOn(factory.evals, "start").mockImplementation(() => {
      order.push("evals");
      evalsStart();
    });
    const trackerStart = factory.tracker.start.bind(factory.tracker);
    spyOn(factory.tracker, "start").mockImplementation(() => {
      order.push("tracker");
      trackerStart();
    });
    factory.start();
    factory.start();
    factory.evals.start();
    await factory.evals.wait(run.id);
    factory.evals.start();
    await Bun.sleep(20);
    // The second Factory.start() returns early; direct calls after the first do nothing.
    expect(order).toEqual(["tracker", "tunnels", "evals", "evals", "call", "call", "call", "evals"]);
    expect(factory.evals.report(run.id)?.trials.every((t) => t.details.resumed)).toBe(true);
    expect(factory.evals.report(run.id)?.run.status).toBe("completed");
  } finally {
    tunnels.mockRestore();
    await f.close();
  }
});

test("a resumed run keeps its submitted dataset; a legacy run without one is not resumed", async () => {
  const f = await evalFixture();
  try {
    f.respond(() => ({ structured: answer }));
    const stalled = stallAcquire(f, 1);
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 1 });
    await stalled;
    const legacy = f.factory.store.createEvalRun(
      { role: "triage", models: ["candidate-a"], k: 1, maxUsd: 1 },
      [
        {
          ...(f.factory.store.listEvalTrials(run.id)[1] ??
            ((): never => {
              throw new Error("missing trial");
            })()),
          status: "queued",
          details: {},
        },
      ],
    );
    f.factory.store.updateEvalRun(legacy.id, "running");
    for (const item of f.dataset.cases) {
      item.prompt = `Changed ${item.id}`;
      item.gold.risk = "high";
    }
    f.dataset.cases.pop();
    f.save();

    f.crash();
    f.factory.start();
    await f.factory.evals.wait(run.id);
    expect(f.calls.map((s) => s.prompt.includes("Changed"))).toEqual([false, false, false]);
    expect([promptCalls(f, "a"), promptCalls(f, "b"), promptCalls(f, "c")]).toEqual([1, 1, 1]);
    const report = f.factory.evals.report(run.id);
    expect(report?.run.status).toBe("completed");
    expect(report?.trials.map((t) => [t.caseId, t.pass])).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
    ]);
    expect(f.factory.store.getEvalRun(legacy.id)).toMatchObject({
      status: "failed",
      error: "interrupted by daemon restart; submit a new eval to reuse completed trials",
    });
    expect(f.factory.store.listEvalTrials(legacy.id)[0]?.status).toBe("skipped");
  } finally {
    await f.close();
  }
});

test.each([true, false])("cache=%p survives a restart", async (cache) => {
  const f = await evalFixture();
  try {
    f.respond(() => ({ structured: answer, costUsd: 0.1 }));
    const prior = await f.run({ models: ["candidate-a"], k: 1, caseIds: ["b"] });
    const stalled = stallAcquire(f, 0);
    const run = f.factory.evals.submit({
      role: "triage",
      models: ["candidate-a"],
      k: 1,
      caseIds: ["a", "b"],
      cache,
    });
    await stalled;
    f.crash();
    f.factory.start();
    await f.factory.evals.wait(run.id);
    expect([promptCalls(f, "a"), promptCalls(f, "b")]).toEqual([1, cache ? 1 : 2]);
    const [a, b] = f.factory.evals.report(run.id)?.trials ?? [];
    expect(a?.details.cache).toBeUndefined();
    if (cache)
      expect(b).toMatchObject({ status: "ok", costUsd: 0, details: { cache: { evalRunId: prior.run.id } } });
    else expect(b).toMatchObject({ status: "ok", costUsd: 0.1, details: { resumed: true } });
    if (!cache) expect(b?.details.cache).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("a shutdown leaves the run for the next daemon, which resumes trials that never called a model", async () => {
  const f = await evalFixture();
  try {
    f.respond(() => ({ structured: answer }));
    const stalled = stallAcquire(f, 1);
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], k: 1 });
    await stalled;
    await f.factory.stop();
    expect(f.factory.evals.report(run.id)?.run).toMatchObject({
      status: "failed",
      error: "eval interrupted by daemon shutdown",
    });
    f.crash();
    f.factory.start();
    await f.factory.evals.wait(run.id);
    expect(f.factory.evals.report(run.id)?.run).toMatchObject({ status: "completed", error: null });
    expect([promptCalls(f, "a"), promptCalls(f, "b"), promptCalls(f, "c")]).toEqual([1, 1, 1]);
    // A finished run is not resumed again by a later daemon.
    await f.factory.stop();
    f.crash();
    f.factory.start();
    await f.factory.evals.wait(run.id);
    expect(f.calls).toHaveLength(3);
  } finally {
    await f.close();
  }
});
