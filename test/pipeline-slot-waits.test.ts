import { describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { CreateRunRequest, Role } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { CancelledError, NoCapacityError, RunContext } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { SimulatedTermination } from "../src/pipeline/faults.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { Router } from "../src/router/router.ts";
import { RuntimePolicy } from "../src/router/runtime-policy.ts";
import { fakeConfinement } from "./confinement.ts";
import { deferred } from "./evals-support.ts";
import { everyone, models, pipelineSetup, policy, providers } from "./pipeline-support.ts";
import { waitClock } from "./wait-clock.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
pipelineSetup({
  get home() {
    return home;
  },
  set home(value) {
    home = value;
  },
  get repoDir() {
    return repoDir;
  },
  set repoDir(value) {
    repoDir = value;
  },
  get factory() {
    return factory;
  },
  set factory(value) {
    factory = value;
  },
});

describe("routing bounded slot waits", () => {
  function fixture(
    catalog = models,
    routing = policy,
    reply?: (s: AgentSpec) => FakeReply | Promise<FakeReply>,
    runModels?: CreateRunRequest["models"],
    definitions = providers,
  ) {
    const clock = waitClock();
    const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "cfg") });
    const calls: AgentSpec[] = [];
    factory = new Factory(cfg, {
      confinement: fakeConfinement,
      providers: definitions,
      models: catalog,
      policy: routing,
      harnesses: {
        fake: fakeHarness((s) => {
          calls.push(s);
          if (reply) return reply(s);
          return s.target.modelId === "beta/5" || catalog === models
            ? { text: "ok", structured: {} }
            : { status: "error", error: "invalid output" };
        }),
      },
    });
    const tracker = new ProviderTracker(
      definitions,
      factory.store,
      cfg.reserves,
      {},
      {},
      clock.now,
      fetch,
      clock.timer,
    );
    const router = new Router(tracker, routing, catalog);
    const repo = factory.store.upsertRepo({
      slug: "wait/repo",
      kind: "local",
      localPath: repoDir,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = factory.store.createRun(repo, { repo: repo.slug, prompt: "wait", models: runModels });
    const controller = new AbortController();
    const context = new RunContext({ ...factory.deps, tracker, router }, run, repo, controller.signal);
    const stage = factory.store.startStage(run.id, "triage", 0);
    const invoke = (deadline?: number, role: Role = "triage") =>
      context.invoke({
        role,
        stage,
        prompt: "wait",
        mode: "readonly",
        noTools: true,
        complexity: "small",
        requireStructured: true,
        deadline,
      });
    const events = () => context.store.listEvents(run.id).filter((e) => e.message.startsWith("waiting for"));
    return { clock, cfg, tracker, router, calls, controller, context, run, invoke, events };
  }

  test.each([false, true])(
    "implement dispatch history survives a crash inside the harness and database reopen (pinned=%s)",
    async (pinned) => {
      const f = fixture(
        models,
        policy,
        () => {
          throw new SimulatedTermination("daemon terminated during implement harness");
        },
        pinned ? { implement: ["alpha/m", "beta/m"] } : undefined,
      );
      await expect(f.invoke(undefined, "implement")).rejects.toThrow(SimulatedTermination);
      expect(f.calls.map((s) => s.target.modelId)).toEqual(["alpha/m"]);
      await factory?.stop();
      f.context.store.close();
      factory = null;
      const reopened = new Store(f.cfg.paths.db);
      try {
        const tracker = new ProviderTracker(providers, reopened, f.cfg.reserves, {}, {});
        const router = new Router(tracker, policy, models);
        const loaded = new RunContext(
          { ...f.context.deps, store: reopened, tracker, router },
          f.run,
          f.context.repo,
          new AbortController().signal,
        );
        expect(loaded.state.triedImplementers).toEqual([{ modelId: "alpha/m", effort: null }]);
        expect(
          router
            .route("implement", "small", { exclude: loaded.state.triedImplementers })
            .candidates.map((t) => t.modelId),
        ).toEqual(["beta/m"]);
      } finally {
        reopened.close();
      }
    },
  );

  test.each(["cell", "prefer"])(
    "live %s edits cancel obsolete capacity waits before invoking",
    async (edit) => {
      const routing = { ...policy, implement: { default: ["alpha/m|beta/m"] } };
      const f = fixture(models, routing);
      const runtime = new RuntimePolicy(f.context.store, f.router, models, providers, [], routing);
      const slots = await Promise.all(
        ["alpha", "alpha"].map((p) => f.tracker.acquire(p, f.controller.signal)),
      );
      try {
        const pending = f.invoke(undefined, "implement");
        expect(f.events()[0]?.message).toContain("waiting for alpha slot");
        await f.clock.advance(2_500);
        if (edit === "cell") runtime.setCell("implement", "small", ["beta/m"]);
        else runtime.setPrefer(["beta"]);
        const outcome = await pending;
        expect(outcome.target.modelId).toBe("beta/m");
        expect(f.calls.map((s) => s.target.modelId)).toEqual(["beta/m"]);
        expect(f.context.store.listInvocations(f.run.id)).toHaveLength(1);
        expect(outcome.invocation.waitMs).toBe(2_500);
        // The obsolete wait is gone even though the old provider has not freed any capacity.
        expect(f.tracker.status("alpha")?.inFlight).toBe(2);
        expect(f.tracker.status("beta")?.inFlight).toBe(0);
        expect(f.clock.pending).toBe(0);
      } finally {
        for (const release of slots) release();
      }
      expect(f.tracker.status("alpha")?.inFlight).toBe(0);
    },
  );

  test.each(["cell", "prefer"])(
    "a queued pinned implementer survives live %s edits without being tried early",
    async (edit) => {
      const f = fixture(models, policy, undefined, { implement: ["alpha/m", "beta/m"] });
      const runtime = new RuntimePolicy(f.context.store, f.router, models, providers, [], policy);
      const slots = await Promise.all(
        ["alpha", "alpha"].map((p) => f.tracker.acquire(p, f.controller.signal)),
      );
      try {
        const pending = f.invoke(undefined, "implement");
        expect(f.events()[0]?.message).toContain("waiting for alpha slot");
        if (edit === "cell") runtime.setCell("implement", "small", ["beta/m"]);
        else runtime.setPrefer(["beta"]);
        await f.clock.flush();
        expect(f.calls).toEqual([]);
        expect(f.context.state.triedImplementers).toEqual([]);
        slots[0]?.();
        expect((await pending).target.modelId).toBe("alpha/m");
        expect(f.calls.map((s) => s.target.modelId)).toEqual(["alpha/m"]);
        expect(f.context.state.triedImplementers).toEqual([{ modelId: "alpha/m", effort: null }]);
      } finally {
        for (const release of slots) release();
      }
    },
  );

  test.each([
    ["cell", false],
    ["cell", true],
    ["prefer", false],
    ["prefer", true],
  ] as const)(
    "a live %s edit cancelling a call before dispatch leaves it eligible for escalation (pinned=%s)",
    async (edit, pinned) => {
      const chain = ["alpha/m", "beta/m"];
      const f = fixture(models, policy, undefined, pinned ? { implement: chain } : undefined);
      const runtime = new RuntimePolicy(f.context.store, f.router, models, providers, [], policy);
      const slots = await Promise.all(
        ["alpha", "alpha"].map((p) => f.tracker.acquire(p, f.controller.signal)),
      );
      const reached = deferred<void>();
      const resume = deferred<void>();
      const save = f.context.save.bind(f.context);
      const persist = spyOn(f.context, "save").mockImplementationOnce(async () => {
        reached.resolve();
        await resume.promise;
        await save();
      });
      try {
        const pending = f.invoke(undefined, "implement");
        expect(f.events()[0]?.message).toContain("waiting for alpha slot");
        // First edit lands while queued; a second races the saved candidate before dispatch.
        if (edit === "cell") runtime.setCell("implement", "small", ["beta/m"]);
        else runtime.setPrefer(["beta"]);
        await f.clock.flush();
        slots[0]?.();
        await reached.promise;
        f.tracker.blockModel("alpha/m", "temporarily rejected", 1_000);
        if (edit === "cell") runtime.setCell("implement", "small", ["beta/m", "alpha/m"]);
        else runtime.setPrefer([]);
        resume.resolve();
        expect((await pending).target.modelId).toBe("beta/m");
        expect(f.calls.map((s) => s.target.modelId)).toEqual(["beta/m"]);
        expect(f.context.store.listInvocations(f.run.id).map((i) => i.status)).toEqual(["cancelled", "ok"]);
        expect(f.context.state.triedImplementers).toEqual([{ modelId: "beta/m", effort: null }]);
        const loaded = new RunContext(
          { ...f.context.deps, tracker: f.tracker, router: f.router },
          f.run,
          f.context.repo,
          f.controller.signal,
        );
        expect(loaded.state.triedImplementers).toEqual(f.context.state.triedImplementers);
        await f.clock.advance(1_000);
        expect(
          f.router
            .route("implement", "small", {
              ...(pinned ? { chain } : {}),
              exclude: loaded.state.triedImplementers,
            })
            .candidates.map((t) => t.modelId),
        ).toEqual(["alpha/m"]);
      } finally {
        resume.resolve();
        persist.mockRestore();
        for (const release of slots) release();
      }
    },
  );

  test.each(["cell", "prefer"])(
    "live %s edits during preflight release the obsolete reservation",
    async (edit) => {
      const routing = { ...policy, implement: { default: ["alpha/m|beta/m"] } };
      const f = fixture(models, routing);
      const runtime = new RuntimePolicy(f.context.store, f.router, models, providers, [], routing);
      const reached = deferred<void>();
      const resume = deferred<boolean>();
      const preflight = f.tracker.preflight.bind(f.tracker);
      const probe = spyOn(f.tracker, "preflight").mockImplementation((provider) => {
        if (provider !== "alpha") return preflight(provider);
        reached.resolve();
        return resume.promise;
      });
      try {
        const pending = f.invoke(undefined, "implement");
        await reached.promise;
        expect(f.tracker.status("alpha")?.inFlight).toBe(1);
        if (edit === "cell") runtime.setCell("implement", "small", ["beta/m"]);
        else runtime.setPrefer(["beta"]);
        resume.resolve(true);
        expect((await pending).target.modelId).toBe("beta/m");
        expect(f.calls.map((s) => s.target.modelId)).toEqual(["beta/m"]);
        expect(f.context.store.listInvocations(f.run.id)).toHaveLength(1);
        expect(f.tracker.status("alpha")?.inFlight).toBe(0);
        expect(f.tracker.status("beta")?.inFlight).toBe(0);
      } finally {
        probe.mockRestore();
      }
    },
  );

  test("a reset reroutes all-provider waits without leaving losing reservations", async () => {
    const routing = { ...policy, implement: { default: ["beta/m"] } };
    const f = fixture(models, routing);
    const runtime = new RuntimePolicy(f.context.store, f.router, models, providers, [], routing);
    runtime.setCell("implement", "small", ["alpha/m", "beta/m"]);
    f.cfg.waitBudgetS.implement = 0;
    const slots = await Promise.all(
      ["alpha", "alpha", "beta", "beta"].map((p) => f.tracker.acquire(p, f.controller.signal)),
    );
    try {
      const pending = f.invoke(undefined, "implement");
      await f.clock.flush();
      expect(f.events().map((e) => e.message)).toContain("waiting for beta slot (0 ahead), up to unbounded");
      runtime.setCell("implement", "small", null);
      // Free the obsolete provider too, racing admission against the routing edit.
      slots[0]?.();
      slots[2]?.();
      expect((await pending).target.modelId).toBe("beta/m");
      expect(f.calls.map((s) => s.target.modelId)).toEqual(["beta/m"]);
      expect(f.context.store.listInvocations(f.run.id)).toHaveLength(1);
      expect(f.clock.pending).toBe(0);
    } finally {
      for (const release of slots) release();
    }
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
    expect(f.tracker.status("beta")?.inFlight).toBe(0);
  });

  test("a live edit during implementer persistence revalidates before the model call", async () => {
    const f = fixture();
    const runtime = new RuntimePolicy(f.context.store, f.router, models, providers, [], policy);
    const reached = deferred<void>();
    const resume = deferred<void>();
    const save = f.context.save.bind(f.context);
    const persist = spyOn(f.context, "save").mockImplementationOnce(async () => {
      reached.resolve();
      await resume.promise;
      await save();
    });
    try {
      const pending = f.invoke(undefined, "implement");
      await reached.promise;
      runtime.setCell("implement", "small", ["beta/m"]);
      resume.resolve();
      expect((await pending).target.modelId).toBe("beta/m");
      expect(f.calls.map((s) => s.target.modelId)).toEqual(["beta/m"]);
      expect(f.context.state.implementer?.modelId).toBe("beta/m");
      expect(f.tracker.status("alpha")?.inFlight).toBe(0);
      expect(f.tracker.status("beta")?.inFlight).toBe(0);
    } finally {
      persist.mockRestore();
    }
  });

  test("expiry falls through without an invocation; immediate admission records zero and no wait event", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const slots = await Promise.all([f.tracker.acquire("alpha", signal), f.tracker.acquire("alpha", signal)]);
    const ahead = f.tracker.acquire("alpha", signal);
    const pending = f.invoke();
    expect(f.events().map((e) => e.message)).toEqual(["waiting for alpha slot (1 ahead), up to 20s"]);
    await f.clock.advance(20_000);
    const outcome = await pending;
    expect(f.calls.map((s) => s.target.provider)).toEqual(["beta"]);
    expect(f.context.store.listInvocations(f.run.id)).toHaveLength(1);
    expect(f.context.store.getInvocation(outcome.invocation.id)?.waitMs).toBe(20_000);
    expect(f.events()).toHaveLength(1);
    expect(f.clock.pending).toBe(0);
    const usage = f.context.store.listEvents(f.run.id).find((e) => e.message === "triage: using beta/m");
    expect(usage?.data).toMatchObject({ skipped: [] });
    for (const release of slots) release();
    (await ahead)();
    const immediate = await f.invoke();
    expect(f.context.store.getInvocation(immediate.invocation.id)?.waitMs).toBe(0);
    expect(f.events()).toHaveLength(1);
  });

  test("a slot freed inside the overridden budget is invoked with persisted elapsed wait", async () => {
    const f = fixture();
    f.cfg.waitBudgetS.triage = 7;
    const signal = new AbortController().signal;
    const slots = await Promise.all([f.tracker.acquire("alpha", signal), f.tracker.acquire("alpha", signal)]);
    const pending = f.invoke();
    await f.clock.advance(2_500);
    slots[0]?.();
    const outcome = await pending;
    expect(f.calls.map((s) => s.target.provider)).toEqual(["alpha"]);
    expect(f.context.store.getInvocation(outcome.invocation.id)?.waitMs).toBe(2_500);
    expect(f.events().map((e) => e.message)).toEqual(["waiting for alpha slot (0 ahead), up to 7s"]);
    expect(f.clock.pending).toBe(0);
    slots[1]?.();
  });

  test("an immediate watched alternative suppresses losing wait messages and zero-budget probes", async () => {
    const f = fixture();
    f.cfg.waitBudgetS.triage = 0;
    const slots = await Promise.all(["alpha", "alpha"].map((p) => f.tracker.acquire(p, f.controller.signal)));
    try {
      const outcome = await f.invoke();
      expect(outcome.target.provider).toBe("beta");
      expect(outcome.invocation.waitMs).toBe(0);
      expect(f.events()).toEqual([]);
      expect(f.clock.pending).toBe(0);
    } finally {
      for (const release of slots) release();
    }
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
    expect(f.tracker.status("beta")?.inFlight).toBe(0);
  });

  test("cancelled waiting stays cancellation without fallback or an invocation", async () => {
    const f = fixture();
    const slots = await Promise.all(
      Array.from({ length: 2 }, () => f.tracker.acquire("alpha", f.controller.signal)),
    );
    const pending = f.invoke();
    f.controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(f.calls).toHaveLength(0);
    expect(f.context.store.listInvocations(f.run.id)).toHaveLength(0);
    expect(f.clock.pending).toBe(0);
    for (const release of slots) release();
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
  });

  test.each([0, 20])("all busy providers race for the first slot with a %ss budget", async (seconds) => {
    const f = fixture();
    f.cfg.waitBudgetS.triage = seconds;
    const slots = await Promise.all(
      providers.flatMap((p) =>
        Array.from({ length: p.maxConcurrent }, () => f.tracker.acquire(p.id, f.controller.signal)),
      ),
    );
    const pending = f.invoke();
    await f.clock.advance(seconds * 1000);
    await f.clock.advance(seconds * 1000);
    await f.clock.advance(60_000);
    expect(f.calls).toHaveLength(0);
    expect(f.context.store.listInvocations(f.run.id)).toHaveLength(0);
    expect(f.events().map((e) => e.message)).toEqual([
      ...(seconds
        ? [
            `waiting for alpha slot (0 ahead), up to ${seconds}s`,
            `waiting for alpha slot (0 ahead), up to ${seconds}s`,
            `waiting for beta slot (0 ahead), up to ${seconds}s`,
          ]
        : []),
      "waiting for alpha slot (0 ahead), up to unbounded",
      "waiting for beta slot (0 ahead), up to unbounded",
    ]);
    expect(f.clock.pending).toBe(0);
    slots[0]?.();
    const outcome = await pending;
    expect(f.calls.map((s) => s.target.provider)).toEqual(["alpha"]);
    expect(f.context.store.listInvocations(f.run.id)).toHaveLength(1);
    expect(f.context.store.getInvocation(outcome.invocation.id)?.waitMs).toBe(seconds * 2000 + 60_000);
    expect(f.events()).toHaveLength(seconds ? 5 : 2);
    // Losing reservations and waiters must be gone: beta remains occupied only by the fixture.
    expect(f.tracker.status("beta")?.inFlight).toBe(2);
    for (const release of slots) release();
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
    expect(f.tracker.status("beta")?.inFlight).toBe(0);
  });

  test.each(["alpha", "beta", "both"])(
    "expired providers remain watched when %s frees at 25s",
    async (free) => {
      const alpha = models[0];
      if (!alpha) throw new Error("missing alpha");
      const catalog = [...models, { ...alpha, id: "alpha/second" }];
      const f = fixture(
        catalog,
        { ...policy, triage: { default: ["alpha/second", "beta/m", "alpha/m"] } },
        () => ({ structured: {} }),
      );
      const slots = await Promise.all(
        ["alpha", "alpha", "beta", "beta"].map((p) => f.tracker.acquire(p, f.controller.signal)),
      );
      try {
        const pending = f.invoke();
        await f.clock.advance(20_000);
        const queued = f.events().map((e) => e.message);
        await f.clock.advance(5_000);
        if (free !== "alpha") slots[2]?.();
        if (free !== "beta") slots[0]?.();
        await f.clock.flush();
        const dispatchedAt25s = f.calls.map((s) => s.target.modelId);
        // Drain the old implementation's later budget too, so a regression fails without hanging.
        await f.clock.advance(15_000);
        const outcome = await pending;
        expect(dispatchedAt25s).toEqual([free === "beta" ? "beta/m" : "alpha/second"]);
        expect(outcome.target.modelId).toBe(free === "beta" ? "beta/m" : "alpha/second");
        expect(outcome.invocation.waitMs).toBe(25_000);
        expect(queued).toEqual([
          "waiting for alpha slot (0 ahead), up to 20s",
          "waiting for alpha slot (0 ahead), up to 20s",
          "waiting for beta slot (0 ahead), up to 20s",
        ]);
        expect(f.context.store.listInvocations(f.run.id)).toHaveLength(1);
        expect(f.clock.pending).toBe(0);
      } finally {
        for (const release of slots) release();
      }
      expect(f.tracker.status("alpha")?.inFlight).toBe(0);
      expect(f.tracker.status("beta")?.inFlight).toBe(0);
      expect((await f.invoke()).target.modelId).toBe("alpha/second");
    },
  );

  test.each(["cancel", "deadline", "cancel after release"])(
    "overlapping waits clean up on %s",
    async (end) => {
      const f = fixture();
      const now = spyOn(Date, "now").mockImplementation(f.clock.now);
      const slots = await Promise.all(
        ["alpha", "alpha", "beta", "beta"].map((p) => f.tracker.acquire(p, f.controller.signal)),
      );
      try {
        const pending = f.invoke(end === "deadline" ? f.clock.now() + 25_000 : undefined);
        const settled = pending.catch((error: unknown) => error);
        await f.clock.advance(20_000);
        if (end === "deadline") await f.clock.advance(5_000);
        else {
          if (end === "cancel after release") {
            slots[2]?.();
            slots[0]?.();
          }
          f.controller.abort();
        }
        expect(await settled).toBeInstanceOf(end === "deadline" ? NoCapacityError : CancelledError);
        expect(f.clock.pending).toBe(0);
        expect(f.calls).toHaveLength(0);
        expect(f.context.store.listInvocations(f.run.id)).toHaveLength(0);
      } finally {
        now.mockRestore();
        for (const release of slots) release();
      }
      expect(f.tracker.status("alpha")?.inFlight).toBe(0);
      expect(f.tracker.status("beta")?.inFlight).toBe(0);
      // An abandoned queue must not strand a new waiter.
      const release = await f.tracker.acquire("beta", new AbortController().signal);
      release();
    },
  );

  test("later providers remain unwatched until their exclusive budget starts", async () => {
    const beta = models[1];
    if (!beta) throw new Error("missing beta");
    const catalog = [...models, { ...beta, id: "gamma/m", provider: "gamma" }];
    const f = fixture(
      catalog,
      { ...policy, triage: { default: catalog.map((m) => m.id) } },
      () => ({ structured: {} }),
      undefined,
      [
        ...providers,
        {
          id: "gamma",
          label: "Gamma",
          harness: "fake",
          billing: "subscription",
          maxConcurrent: 2,
        },
      ],
    );
    const slots = await Promise.all(
      ["alpha", "alpha", "beta", "beta"].map((p) => f.tracker.acquire(p, f.controller.signal)),
    );
    try {
      const pending = f.invoke();
      await f.clock.advance(20_000);
      await f.clock.advance(19_000);
      expect(f.calls).toHaveLength(0);
      expect(f.events().some((e) => e.message.includes("gamma"))).toBe(false);
      await f.clock.advance(1_000);
      expect((await pending).target.provider).toBe("gamma");
      expect(f.context.store.listInvocations(f.run.id)[0]?.waitMs).toBe(40_000);
      expect(f.events()).toHaveLength(3);
      expect(f.clock.pending).toBe(0);
    } finally {
      for (const release of slots) release();
    }
  });

  test("a failed overlapping wait notice removes every queued acquisition", async () => {
    const f = fixture();
    const slots = await Promise.all(
      ["alpha", "alpha", "beta", "beta"].map((p) => f.tracker.acquire(p, f.controller.signal)),
    );
    const log = f.context.log.bind(f.context);
    const notice = spyOn(f.context, "log").mockImplementation((...args) => {
      if (args[0].startsWith("waiting for beta")) throw new Error("wait logging failed");
      log(...args);
    });
    try {
      const pending = f.invoke();
      const settled = pending.catch((error: unknown) => error);
      await f.clock.advance(20_000);
      expect(await settled).toEqual(new Error("wait logging failed"));
      expect(f.clock.pending).toBe(0);
      expect(f.calls).toHaveLength(0);
    } finally {
      notice.mockRestore();
      for (const release of slots) release();
    }
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
    expect(f.tracker.status("beta")?.inFlight).toBe(0);
    expect((await f.invoke()).target.provider).toBe("alpha");
  });

  test("metered target selection checks concurrency without status or spend queries", async () => {
    const f = fixture(
      models,
      policy,
      undefined,
      undefined,
      providers.map((p) => ({ ...p, billing: "metered" })),
    );
    const slots = await Promise.all(["alpha", "alpha"].map((p) => f.tracker.acquire(p, f.controller.signal)));
    const status = spyOn(f.tracker, "status");
    const spend = spyOn(f.context.store, "providerSpendSince");
    const route = f.router.route.bind(f.router);
    let beforeSelection = [0, 0];
    const routing = spyOn(f.router, "route").mockImplementation((...args) => {
      const result = route(...args);
      beforeSelection = [status.mock.calls.length, spend.mock.calls.length];
      return result;
    });
    const acquire = f.tracker.acquireFirst.bind(f.tracker);
    let selections = 0;
    const admission = spyOn(f.tracker, "acquireFirst").mockImplementation((...args) => {
      expect([status.mock.calls.length, spend.mock.calls.length]).toEqual(beforeSelection);
      selections++;
      return acquire(...args);
    });
    try {
      expect(f.tracker.isBusy("alpha")).toBe(true);
      expect(f.tracker.isBusy("beta")).toBe(false);
      const pending = f.invoke();
      await f.clock.advance(20_000);
      expect((await pending).target.provider).toBe("beta");
      slots[0]?.();
      expect(f.tracker.isBusy("alpha")).toBe(false);
      expect((await f.invoke()).target.provider).toBe("alpha");
      expect(selections).toBe(3);
      // Normal routing/admission still publishes metered status and checks quota.
      expect(status.mock.calls.length).toBeGreaterThan(0);
      expect(spend.mock.calls.length).toBeGreaterThan(0);
    } finally {
      admission.mockRestore();
      routing.mockRestore();
      status.mockRestore();
      spend.mockRestore();
      for (const release of slots) release();
    }
  });

  test.each(["alpha", "beta", "both"])("all busy providers select %s when its slot frees", async (free) => {
    const f = fixture();
    const slots = await Promise.all(
      ["alpha", "alpha", "beta", "beta"].map((p) => f.tracker.acquire(p, f.controller.signal)),
    );
    const pending = f.invoke();
    await f.clock.advance(20_000);
    await f.clock.advance(20_000);
    await f.clock.advance(5_000);
    // Release beta first to prove simultaneous availability still prefers policy order.
    if (free !== "alpha") slots[2]?.();
    if (free !== "beta") slots[0]?.();
    expect((await pending).target.provider).toBe(free === "beta" ? "beta" : "alpha");
    expect(f.context.store.listInvocations(f.run.id)[0]?.waitMs).toBe(45_000);
    for (const release of slots) release();
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
    expect(f.tracker.status("beta")?.inFlight).toBe(0);
    // A new invocation can use either provider after losing waiters were cancelled.
    expect((await f.invoke()).target.provider).toBe("alpha");
  });

  test.each(["quota", "unavailable", "declined", "missing"] as const)(
    "an expired provider remains eligible after beta returns %s",
    async (status) => {
      const f = fixture(models, policy, (s) =>
        s.target.provider === "alpha" ? { structured: {} } : status === "missing" ? {} : { status },
      );
      const slots = await Promise.all(
        ["alpha", "alpha"].map((p) => f.tracker.acquire(p, f.controller.signal)),
      );
      const pending = f.invoke();
      await f.clock.advance(20_000);
      expect(f.calls.map((s) => s.target.provider)).toEqual(["beta"]);
      await f.clock.advance(5_000);
      slots[0]?.();
      const outcome = await pending;
      expect(outcome.target.provider).toBe("alpha");
      expect(f.calls.map((s) => s.target.provider)).toEqual(["beta", "alpha"]);
      expect(f.context.store.listInvocations(f.run.id).map((i) => i.waitMs)).toEqual([20_000, 5_000]);
      expect(f.events().map((e) => e.message)).toEqual([
        "waiting for alpha slot (0 ahead), up to 20s",
        "waiting for alpha slot (0 ahead), up to unbounded",
      ]);
      expect(f.clock.pending).toBe(0);
      for (const release of slots) release();
    },
  );

  test("expired providers can run immediately when a fallback fails after their slot frees", async () => {
    let finishBeta: (reply: FakeReply) => void = () => {
      throw new Error("beta not invoked");
    };
    const f = fixture(models, policy, (s) =>
      s.target.provider === "alpha"
        ? { structured: {} }
        : new Promise<FakeReply>((resolve) => {
            finishBeta = resolve;
          }),
    );
    const slots = await Promise.all(["alpha", "alpha"].map((p) => f.tracker.acquire(p, f.controller.signal)));
    const pending = f.invoke();
    await f.clock.advance(20_000);
    await f.clock.advance(5_000);
    slots[0]?.();
    finishBeta({ status: "quota" });
    const outcome = await pending;
    expect(outcome.target.provider).toBe("alpha");
    // The five seconds beta spent executing are not slot waiting.
    expect(outcome.invocation.waitMs).toBe(0);
    expect(f.context.store.listInvocations(f.run.id).map((i) => i.waitMs)).toEqual([20_000, 0]);
    expect(f.events()).toHaveLength(1);
    slots[1]?.();
  });

  test.each(["cancel", "deadline"])("an all-provider wait cleans up on %s", async (end) => {
    const f = fixture();
    const now = spyOn(Date, "now").mockImplementation(f.clock.now);
    const slots = await Promise.all(
      ["alpha", "alpha", "beta", "beta"].map((p) => f.tracker.acquire(p, f.controller.signal)),
    );
    try {
      const pending = f.invoke(end === "deadline" ? f.clock.now() + 60_000 : undefined);
      const settled = pending.catch((error: unknown) => error);
      await f.clock.advance(20_000);
      await f.clock.advance(20_000);
      if (end === "cancel") f.controller.abort();
      else await f.clock.advance(20_000);
      expect(await settled).toBeInstanceOf(end === "cancel" ? CancelledError : NoCapacityError);
      expect(f.clock.pending).toBe(0);
      expect(f.calls).toHaveLength(0);
      for (const release of slots) release();
      expect(f.tracker.status("alpha")?.inFlight).toBe(0);
      expect(f.tracker.status("beta")?.inFlight).toBe(0);
    } finally {
      now.mockRestore();
      for (const release of slots) release();
    }
  });

  test.each(["review", "verify", "spec", "holdout", "implement", "plan", "plan_review"] as const)(
    "%s waits beyond the former defaults without falling through",
    async (role) => {
      const f = fixture(models, { ...policy, [role]: everyone });
      const slots = await Promise.all(
        ["alpha", "alpha"].map((p) => f.tracker.acquire(p, f.controller.signal)),
      );
      const pending = f.invoke(undefined, role);
      await f.clock.advance(360_000);
      expect(f.calls).toHaveLength(0);
      expect(f.events()[0]?.message).toContain("up to unbounded");
      slots[0]?.();
      const outcome = await pending;
      expect(outcome.target.provider).toBe("alpha");
      expect(outcome.invocation.waitMs).toBe(360_000);
      slots[1]?.();
    },
  );

  test.each(["release", "cancel", "deadline"])("a pinned candidate waits until %s", async (end) => {
    const f = fixture(models, { ...policy, triage: { default: ["alpha/m"] } });
    const now = spyOn(Date, "now").mockImplementation(f.clock.now);
    const slots = await Promise.all(
      Array.from({ length: 2 }, () => f.tracker.acquire("alpha", f.controller.signal)),
    );
    try {
      const pending = f.invoke(end === "deadline" ? f.clock.now() + 60_000 : undefined);
      const settled = pending.catch((error: unknown) => error);
      await f.clock.advance(40_000);
      expect(f.calls).toHaveLength(0);
      expect(f.context.store.listInvocations(f.run.id)).toHaveLength(0);
      expect(f.events().map((e) => e.message)).toEqual([
        `waiting for alpha slot (0 ahead), up to ${end === "deadline" ? "60s" : "unbounded"}`,
      ]);
      if (end === "release") {
        slots[0]?.();
        const outcome = await pending;
        expect(f.calls.map((s) => s.target.provider)).toEqual(["alpha"]);
        expect(f.context.store.getInvocation(outcome.invocation.id)?.waitMs).toBe(40_000);
        expect(f.context.store.listInvocations(f.run.id)).toHaveLength(1);
      } else {
        if (end === "cancel") f.controller.abort();
        else await f.clock.advance(20_000);
        expect(await settled).toBeInstanceOf(end === "cancel" ? CancelledError : NoCapacityError);
        expect(f.calls).toHaveLength(0);
        expect(f.context.store.listInvocations(f.run.id)).toHaveLength(0);
      }
      expect(f.events()).toHaveLength(1);
      expect(f.clock.pending).toBe(0);
    } finally {
      now.mockRestore();
      for (const release of slots) release();
    }
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
  });

  test("more than six busy candidates still allow all six actual invocation attempts", async () => {
    const alpha = models[0];
    const beta = models[1];
    if (!alpha || !beta) throw new Error("missing models");
    const catalog = [
      ...Array.from({ length: 7 }, (_, i) => ({ ...alpha, id: `alpha/${i}` })),
      ...Array.from({ length: 6 }, (_, i) => ({ ...beta, id: `beta/${i}` })),
    ];
    const f = fixture(catalog, { ...policy, triage: { default: catalog.map((m) => m.id) } });
    const slots = await Promise.all(
      Array.from({ length: 2 }, () => f.tracker.acquire("alpha", f.controller.signal)),
    );
    const pending = f.invoke();
    await f.clock.advance(20_000);
    expect((await pending).target.modelId).toBe("beta/5");
    expect(f.calls.map((s) => s.target.modelId)).toEqual(Array.from({ length: 6 }, (_, i) => `beta/${i}`));
    expect(f.context.store.listInvocations(f.run.id)).toHaveLength(6);
    expect(f.events()).toHaveLength(1);
    expect(f.context.store.listInvocations(f.run.id).map((i) => i.waitMs)).toEqual([20_000, 0, 0, 0, 0, 0]);
    for (const release of slots) release();
  });

  test("an invocation deadline caps the provider wait", async () => {
    const f = fixture();
    const now = spyOn(Date, "now").mockImplementation(f.clock.now);
    const slots = await Promise.all(
      Array.from({ length: 2 }, () => f.tracker.acquire("alpha", f.controller.signal)),
    );
    try {
      const pending = f.invoke(f.clock.now() + 1_500);
      const rejection = pending.catch((error: unknown) => error);
      expect(f.events()[0]?.message).toContain("up to 2s");
      await f.clock.advance(1_500);
      expect(await rejection).toBeInstanceOf(NoCapacityError);
      expect(f.calls).toHaveLength(0);
      expect(f.clock.pending).toBe(0);
    } finally {
      now.mockRestore();
      for (const release of slots) release();
    }
  });

  test.each(["before routing", "waiting", "admitted", "cancel"])(
    "a run's pinned chain records deadline exhaustion: %s",
    async (expiry) => {
      const f = fixture(models, policy, undefined, { triage: ["alpha/m", "beta/m"] });
      const now = spyOn(Date, "now").mockImplementation(f.clock.now);
      const slots = await Promise.all(
        ["alpha", "alpha", "beta", "beta"].map((p) => f.tracker.acquire(p, f.controller.signal)),
      );
      const waiting = deferred<void>();
      const unsubscribe = f.context.store.subscribe((message) => {
        if (
          message.kind === "event" &&
          message.event.runId === f.run.id &&
          message.event.message.startsWith("waiting for")
        )
          waiting.resolve();
      });
      const invoke = RunContext.prototype.invoke;
      const invocation = spyOn(RunContext.prototype, "invoke").mockImplementation(async function (
        this: RunContext,
        opts,
      ) {
        const deadline = f.clock.now() + 60_000;
        if (expiry === "before routing") await f.clock.advance(60_000);
        return invoke.call(this, { ...opts, deadline });
      });
      const acquire = f.tracker.acquire;
      function admit(id: string, signal: AbortSignal): Promise<() => void>;
      function admit(
        id: string,
        signal: AbortSignal,
        ms: number | undefined,
        onWait?: (ahead: number) => void,
      ): Promise<(() => void) | null>;
      async function admit(id: string, signal: AbortSignal, ms?: number, onWait?: (ahead: number) => void) {
        const release = await acquire.call(f.tracker, id, signal, ms, onWait);
        if (release && expiry === "admitted") await f.clock.advance(60_000);
        return release;
      }
      const admission = spyOn(f.tracker, "acquire").mockImplementation(admit);
      try {
        const pending = executeRun(f.context.deps, f.run.id, f.controller.signal);
        if (expiry !== "before routing") {
          await waiting.promise;
          if (expiry === "cancel") f.controller.abort();
          else if (expiry === "admitted") slots[0]?.();
          else {
            await f.clock.advance(20_000);
            await f.clock.advance(20_000);
            await f.clock.advance(20_000);
          }
        }
        expect(await pending).toBe(expiry === "cancel" ? "cancelled" : "needs_human");
        expect(f.context.store.getRun(f.run.id)?.status).toBe(
          expiry === "cancel" ? "cancelled" : "needs_human",
        );
        const questions = f.context.store.listQuestions(f.run.id);
        if (expiry === "cancel") expect(questions).toHaveLength(0);
        else {
          expect(questions).toHaveLength(1);
          expect(questions[0]?.question).toContain("triage; pinned chain: alpha/m, beta/m");
          for (const id of ["alpha/m", "beta/m"])
            expect(questions[0]?.question).toMatch(new RegExp(`${id} \\([^)]*(busy|deadline)`));
        }
        expect(f.calls).toHaveLength(0);
        expect(f.context.store.listInvocations(f.run.id)).toHaveLength(0);
        expect(f.clock.pending).toBe(0);
        for (const release of slots) release();
        expect(f.tracker.status("alpha")?.inFlight).toBe(0);
        expect(f.tracker.status("beta")?.inFlight).toBe(0);
        const release = await f.tracker.acquire(
          "alpha",
          f.controller.signal.aborted ? new AbortController().signal : f.controller.signal,
        );
        release();
      } finally {
        admission.mockRestore();
        invocation.mockRestore();
        now.mockRestore();
        unsubscribe();
        for (const release of slots) release();
      }
    },
  );
});
