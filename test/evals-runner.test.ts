import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheKey } from "../src/evals/cache.ts";
import { pinnedTree, withRepoLock } from "../src/git/repos.ts";
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
    const run = f.factory.evals.submit({ role: "triage", models: ["candidate-a"], cache: false });
    await entered.promise;
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
    // Shutdown leaves both runs queued to resume, with nothing failed or skipped.
    for (const id of [run.id, waiting.id])
      expect(f.factory.evals.report(id)?.run).toMatchObject({ status: "queued", error: null });
    const report = f.factory.evals.report(waiting.id);
    expect(report?.trials).toHaveLength(3);
    for (const trial of report?.trials ?? []) {
      expect(trial).toMatchObject({ status: "queued", pass: null, score: null, output: null });
      expect(trial.details.reason).toBeUndefined();
      expect(trial.details.preparationFailed).toBeUndefined();
    }
    expect(report?.summaries[0]).toMatchObject({
      evaluatedTrials: 0,
      errors: 0,
      skipped: 0,
      pending: 3,
      passRate: null,
      predictionTrials: 0,
      latencyDenominator: 0,
    });
    expect(f.calls).toHaveLength(1);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
    expect(f.factory.store.listEvalTrials(run.id).every((t) => t.status === "queued")).toBe(true);
    // A restart resumes both runs, rerunning the interrupted trial.
    f.respond(() => ({ structured: answer }));
    const restarted = await f.restart();
    await Promise.all([restarted.evals.wait(run.id), restarted.evals.wait(waiting.id)]);
    for (const id of [run.id, waiting.id]) {
      const resumed = restarted.evals.report(id);
      expect(resumed?.run).toMatchObject({ status: "completed", error: null });
      expect(resumed?.trials.map((t) => t.status)).toEqual(["ok", "ok", "ok"]);
      expect(resumed?.summaries[0]).toMatchObject({ evaluatedTrials: 3, pending: 0 });
    }
    expect(f.calls.length).toBeGreaterThanOrEqual(4);
    // A crash leaves a run and one trial running before its call recorded any usage; the restart reruns
    // only that trial, still uncached.
    const calls = f.calls.length;
    const crashed = restarted.store.listEvalTrials(run.id)[1];
    if (!crashed) throw new Error("missing trial");
    restarted.store.recordEvalTrial({
      ...crashed,
      status: "running",
      output: null,
      pass: null,
      score: null,
      costUsd: 0,
      costEquivUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      details: {},
    });
    restarted.store.updateEvalRun(run.id, "running");
    const again = await f.restart();
    await again.evals.wait(run.id);
    expect(again.evals.report(run.id)?.run).toMatchObject({ status: "completed", cache: false });
    expect(again.evals.report(run.id)?.trials.map((t) => t.status)).toEqual(["ok", "ok", "ok"]);
    expect(f.calls).toHaveLength(calls + 1);
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
