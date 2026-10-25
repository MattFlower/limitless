import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { WorkerStore } from "../src/db/workers.ts";
import { agentTestLease } from "../src/gates/agent-tests.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import type { AgentResult, AgentSpec } from "../src/harness/types.ts";
import type { AgentCall, AgentExecutor } from "../src/pipeline/agent-executor.ts";
import { type EngineDeps, type InvokeOptions, NeedsHumanError, RunContext } from "../src/pipeline/context.ts";
import type { FaultPlan } from "../src/pipeline/faults.ts";
import { lanAgentExecutor } from "../src/pipeline/lan-agent.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { Router } from "../src/router/router.ts";
import { registerCredential } from "../src/util/proc.ts";
import { models, policy, providers } from "./pipeline-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture(
  executor?: AgentExecutor,
  reply: (spec: AgentSpec) => FakeReply | Promise<FakeReply> = () => ({ text: "local result" }),
  faults?: FaultPlan,
  catalogModels = models,
) {
  const root = mkdtempSync(join(tmpdir(), "agent-executor-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cfg = loadConfig({ home: join(root, "data"), configDir: join(root, "cfg") });
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  const tracker = new ProviderTracker(providers, store, cfg.reserves, {});
  const calls: AgentSpec[] = [];
  const deps: EngineDeps = {
    cfg,
    store,
    tracker,
    router: new Router(tracker, policy, catalogModels),
    agentExecutor: executor,
    faults,
    harnesses: {
      fake: fakeHarness((spec) => {
        calls.push(spec);
        return reply(spec);
      }),
    },
  };
  const repo = store.upsertRepo({
    slug: "fixture/repo",
    kind: "local",
    localPath: root,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "exercise executor" });
  const context = new RunContext(deps, run, repo, new AbortController().signal);
  const stage = store.startStage(run.id, "implement", 0);
  const cwd = join(root, "checkout");
  mkdirSync(cwd);
  const invoke = (options: Partial<InvokeOptions> = {}) =>
    context.invoke({
      role: "implement",
      stage,
      prompt: "exercise executor",
      mode: "edit",
      complexity: "small",
      constraints: { only: "alpha/m" },
      cwd,
      ...options,
    });
  return { root, cwd, run, stage, repo, context, store, tracker, calls, invoke, cfg };
}

const remoteResult: AgentResult = {
  status: "ok",
  finalText: "executor result",
  structured: { complete: true },
  sessionId: "executor-session",
  usage: { input: 321, output: 123, cacheRead: 45, cacheWrite: 67 },
  numTurns: 9,
  costUsd: 0.12,
  costEquivUsd: 0.34,
  error: null,
  quota: { windows: { short: { utilization: 0.2, resetsAt: null } }, exhaustedUntil: null },
};

test("remote implement invocations omit the coordinator browser and persist the locality reason", async () => {
  const f = fixture();
  f.cfg.workers.agents = ["implement"];
  f.cfg.workers.repos = [f.repo.slug];
  f.context.previewUrl = "http://127.0.0.1:43210";
  const parentSha = "b".repeat(40);
  const prepared = {
    parentSha,
    baseSha: parentSha,
    branch: "change/browser",
    repoUrl: "https://github.com/example/repo.git",
    expectedRemoteSha: null,
    discreet: false,
    privateStringsDigest: "c".repeat(64),
    commit: {
      message: "UI change",
      authorName: "Test",
      authorEmail: "test@example.com",
      committerName: "Test",
      committerEmail: "test@example.com",
    },
  };
  const workers = new WorkerStore(f.store, "a".repeat(40), { tick: 1 });
  const enqueue = workers.enqueueAgentJob.bind(workers);
  spyOn(workers, "enqueueAgentJob").mockImplementation((request, id) => {
    if (!id) throw new Error("missing job id");
    expect(request).not.toHaveProperty("browser");
    expect(JSON.stringify(request)).not.toContain("43210");
    const job = enqueue(request, id);
    f.store.db.query("UPDATE agent_jobs SET state='leased',worker='fixture-worker' WHERE id=?").run(id);
    workers.completeAgentJob(
      id,
      {
        ...remoteResult,
        parentSha,
        sha: parentSha,
        branch: prepared.branch,
        privateStringsDigest: prepared.privateStringsDigest,
      },
      "a".repeat(40),
    );
    return job;
  });
  const executor = lanAgentExecutor(workers, f.cfg);
  f.context.deps.agentExecutor = {
    kind: "lan",
    run: (call, local) =>
      executor.run(
        { ...call, spec: { ...call.spec, target: { ...call.spec.target, harness: "claude" } } },
        local,
      ),
  };
  const outcome = await f.invoke({
    publication: {
      async started() {},
      async retired() {},
      async resume() {
        return false;
      },
      async prepare() {
        return prepared;
      },
      async adopt() {},
      async remoteSha() {
        return null;
      },
    },
  });
  expect(outcome.result.status).toBe("ok");
  expect(f.calls).toHaveLength(0);
  expect(f.store.listEvents(f.run.id)).toContainEqual(
    expect.objectContaining({
      invocationId: outcome.invocation.id,
      level: "warn",
      message: expect.stringContaining("remote invocation"),
      data: { code: "browser_unavailable", id: "browser-unavailable" },
    }),
  );
  expect(f.store.countEvents(f.run.id, "signal_attempt")).toBe(0);
});

test("NeedsHuman finalizes the invocation after releasing its slot without observing health", async () => {
  const reason = new NeedsHumanError("Run branch moved during a failed worker attempt");
  const f = fixture({
    kind: "lan",
    async run() {
      throw reason;
    },
  });
  f.tracker.record("alpha", "unavailable");
  expect(f.tracker.status("alpha")?.state).toBe("degraded");
  const record = spyOn(f.tracker, "record");
  const windows = spyOn(f.tracker, "observeWindows");
  const confinement = spyOn(f.tracker, "observeConfinement");
  const publication = {
    async started() {},
    async retired() {},
    async resume() {
      return true;
    },
    async prepare() {
      return null;
    },
    async adopt() {},
    async remoteSha() {
      return null;
    },
  };
  await expect(f.invoke({ publication })).rejects.toBe(reason);
  expect(f.calls).toHaveLength(0);
  expect(f.store.listInvocations(f.run.id)).toMatchObject([
    { status: "error", error: reason.message, finishedAt: expect.any(Number) },
  ]);
  expect(record).not.toHaveBeenCalled();
  expect(windows).not.toHaveBeenCalled();
  expect(confinement).not.toHaveBeenCalled();
  expect(f.tracker.status("alpha")?.inFlight).toBe(0);
  expect(f.tracker.status("alpha")?.state).toBe("degraded");
});

test.each([
  ["ordinary", {}, false],
  ["private output", { privateOutput: true }, true],
  ["holdout redaction without holdout content", { redactHoldout: true }, true],
  ["private session", { privateSession: true }, true],
  ["confined reads", { confineReads: true }, false],
] as const)("executor payload: %s", async (_name, options, privateCall) => {
  const received: AgentCall[] = [];
  const f = fixture({
    kind: "capture",
    async run(call) {
      received.push(call);
      call.dispatch();
      return remoteResult;
    },
  });
  f.context.state.worktreePath = join(f.root, "original-checkout");
  f.context.state.slottedCommands = [
    ["bun", "test"],
    ["cargo", "test"],
  ];
  f.context.state.agentFullSuite = "refuse";
  const denyRead = [join(f.root, "private-source")];
  const outcome = await f.invoke({ ...options, denyRead });
  expect(received).toHaveLength(1);
  const call = received[0];
  expect(call).toMatchObject({
    runId: f.run.id,
    invocationId: outcome.invocation.id,
    repoSlug: "fixture/repo",
    role: "implement",
    agentFullSuite: "refuse",
    worktree: f.cwd,
    slottedCommands:
      "confineReads" in options
        ? []
        : [
            ["bun", "test"],
            ["cargo", "test"],
          ],
    shadow: false,
    private: privateCall,
    denyRead,
    spec: { cwd: f.cwd, denyRead, mode: "edit", noTools: false, target: { modelId: "alpha/m" } },
  });
  expect(call?.spec.scratchDir).toBeUndefined();
  expect(call?.spec.commandPath).toBeUndefined();
  expect(outcome.invocation).toMatchObject({ runId: f.run.id, stageId: f.stage.id, role: "implement" });
  expect(f.store.getRunState<{ triedImplementers: unknown[] }>(f.run.id)?.triedImplementers).toEqual([
    { modelId: "alpha/m", effort: null },
  ]);
  expect(f.calls).toHaveLength(0);
});

test.each([false, true])("executor result uses normal bookkeeping (shadow=%s)", async (shadow) => {
  const received: AgentCall[] = [];
  const f = fixture({
    kind: "result",
    async run(call) {
      received.push(call);
      call.dispatch();
      call.spec.onEvent({ type: "text", text: "executor progress" });
      return remoteResult;
    },
  });
  const record = spyOn(f.tracker, "record");
  const observe = spyOn(f.tracker, "observeWindows");
  const block = spyOn(f.tracker, "blockModel");
  const ids: number[] = [];
  const shadowCwd = join(f.root, "shadow-checkout");
  const outcome = await f.invoke({
    role: "holdout",
    cwd: undefined,
    ...(shadow ? { shadow: { signal: f.context.signal, ids, cwd: shadowCwd, stop: () => undefined } } : {}),
  });
  expect(received[0]).toMatchObject({
    role: "holdout",
    shadow,
    private: false,
    worktree: shadow ? shadowCwd : f.context.runDir,
    slottedCommands: [],
    denyRead: undefined,
  });
  expect(outcome.result).toEqual(remoteResult);
  expect(f.store.listInvocations(f.run.id)).toEqual([outcome.invocation]);
  expect(outcome.invocation).toMatchObject({
    status: "ok",
    role: shadow ? "review_shadow" : "holdout",
    sessionId: "executor-session",
    numTurns: 9,
    costUsd: 0.12,
    costEquivUsd: 0.34,
    inputTokens: 321,
    outputTokens: 123,
    cacheReadTokens: 45,
    cacheWriteTokens: 67,
  });
  expect(outcome.invocation.finishedAt).toBeNumber();
  expect(f.store.listEvents(f.run.id).at(-1)?.message).toBe("executor progress");
  expect(f.store.getRun(f.run.id)).toMatchObject({ costUsd: 0.12, costEquivUsd: 0.34 });
  expect(f.calls).toHaveLength(0);
  expect(record).toHaveBeenCalledTimes(shadow ? 0 : 1);
  expect(observe).toHaveBeenCalledTimes(shadow ? 0 : 1);
  expect(block).not.toHaveBeenCalled();
  if (shadow) expect(ids).toEqual([outcome.invocation.id]);
  else {
    expect(record).toHaveBeenCalledWith("alpha", "ok", { exhaustedUntil: null, error: null });
    expect(observe).toHaveBeenCalledWith("alpha", remoteResult.quota?.windows);
  }
});

test("delegating to local preserves ordered events, rows, wrappers and watchdog cleanup", async () => {
  const snapshots: unknown[] = [];
  for (const injected of [false, true]) {
    let wrapper = "",
      scratch = "",
      token = "";
    const f = fixture(
      injected ? { kind: "delegate", run: (_call, local) => local() } : undefined,
      async (spec) => {
        scratch = spec.scratchDir ?? "";
        wrapper = spec.commandPath?.split(delimiter)[0] ?? "";
        expect(existsSync(scratch)).toBe(true);
        expect(existsSync(join(wrapper, "bun"))).toBe(true);
        expect(f.store.getRunState<{ triedImplementers: unknown[] }>(f.run.id)?.triedImplementers).toEqual([
          { modelId: "alpha/m", effort: null },
        ]);
        token = JSON.parse(readFileSync(join(wrapper, "config.json"), "utf8")).token;
        const lease = await agentTestLease({ token, name: "bun test", lane: "small" });
        try {
          expect(lease.acquired).toBe(true);
          const now = spec.idleNow?.();
          expect(now).toBeNumber();
          expect(spec.idleNow?.()).toBe(now);
        } finally {
          await agentTestLease({ token, id: lease.id, release: true });
        }
        return { text: "local result", events: [{ type: "status", text: "local progress" }] };
      },
    );
    f.context.state.slottedCommands = [["bun", "test"]];
    const outcome = await f.invoke();
    expect(outcome.result.status).toBe("ok");
    expect(f.calls).toHaveLength(1);
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(wrapper)).toBe(false);
    await expect(agentTestLease({ token, name: "bun test", lane: "small" })).rejects.toThrow("capability");
    const events = f.store.listEvents(f.run.id);
    expect(events.filter((e) => e.message.startsWith("Idle watchdog")).map((e) => e.message)).toEqual([
      "Idle watchdog held off for slotted command",
      expect.stringMatching(/^Idle watchdog resumed after \d+ms held off for slotted command$/),
    ]);
    snapshots.push(
      JSON.parse(
        JSON.stringify({ events, rows: f.store.listInvocations(f.run.id) }, (key, value: unknown) => {
          if (
            [
              "id",
              "runId",
              "stageId",
              "invocationId",
              "ts",
              "startedAt",
              "finishedAt",
              "waitMs",
              "durationMs",
            ].includes(key)
          )
            return 0;
          return typeof value === "string" ? value.replace(/\d+ms/g, "<duration>") : value;
        }),
      ),
    );
  }
  expect(snapshots[1]).toEqual(snapshots[0]);
});

test.each(["triage", "noTools", "stream"] as const)("%s bypasses the executor", async (branch) => {
  const run = spyOn(
    {
      async run() {
        throw new Error("unexpected executor call");
      },
    },
    "run",
  );
  const f = fixture(
    { kind: "unreachable", run },
    undefined,
    branch === "stream"
      ? {
          "harness:stream": {
            action: {
              parser: "claude",
              lines: [JSON.stringify({ type: "result", subtype: "success", result: "stream result" })],
            },
          },
        }
      : undefined,
  );
  const outcome = await f.invoke(
    branch === "triage" ? { role: "triage" } : { noTools: branch === "noTools" },
  );
  expect(outcome.result.status).toBe("ok");
  expect(run).not.toHaveBeenCalled();
  expect(f.calls).toHaveLength(branch === "stream" ? 0 : 1);
  if (branch === "stream") expect(outcome.result.finalText).toBe("stream result");
  else {
    expect(f.calls[0]?.noTools).toBe(true);
    expect(f.calls[0]?.scratchDir).toBeUndefined();
    expect(f.calls[0]?.commandPath).toBeUndefined();
  }
});

test("invocation and stream fault hooks precede the tool-enabled executor", async () => {
  const order: string[] = [];
  const f = fixture(
    {
      kind: "ordered",
      async run(call) {
        order.push("executor");
        call.dispatch();
        return remoteResult;
      },
    },
    undefined,
    {
      "harness:invoke": {
        action: "continue",
        onHit: () => {
          order.push("invoke");
        },
      },
      "harness:stream": {
        action: "continue",
        onHit: () => {
          order.push("stream");
        },
      },
    },
  );
  await f.invoke();
  expect(order).toEqual(["invoke", "stream", "executor"]);
});

test.each([false, true])(
  "executor rejection follows existing error and slot cleanup (private=%s)",
  async (privateOutput) => {
    const secret = "synthetic-executor-credential-725";
    registerCredential("executor-test", secret);
    let logDirectory = "";
    const run = spyOn(
      {
        async run(call: AgentCall) {
          logDirectory = call.spec.logPath;
          throw new Error(`executor failed ${secret}`);
        },
      },
      "run",
    );
    const f = fixture({ kind: "reject", run });
    const record = spyOn(f.tracker, "record");
    const outcome = await f.invoke({ privateOutput });
    expect(outcome.result).toMatchObject({ status: "error", error: "executor failed [redacted]" });
    const error = privateOutput ? "private invocation failed" : "executor failed [redacted]";
    expect(outcome.invocation).toMatchObject({ status: "error", error, sessionId: null, numTurns: 0 });
    expect(f.store.listInvocations(f.run.id)).toEqual([outcome.invocation]);
    expect(record).toHaveBeenCalledWith("alpha", "error", { exhaustedUntil: null, error });
    expect(run).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveLength(0);
    expect(f.tracker.status("alpha")?.inFlight).toBe(0);
    const releases = await Promise.all([0, 1].map(() => f.tracker.acquire("alpha", f.context.signal, 0)));
    try {
      for (const release of releases) expect(release).toBeFunction();
    } finally {
      for (const release of releases) release?.();
    }
    expect(JSON.stringify([f.store.listInvocations(f.run.id), f.store.listEvents(f.run.id)])).not.toContain(
      secret,
    );
    if (privateOutput) {
      expect(existsSync(join(logDirectory, ".."))).toBe(false);
      expect(JSON.stringify(f.store.listInvocations(f.run.id))).not.toContain("executor failed");
    }
  },
);

test.each(["implement", "verify", "review", "triage"] as const)(
  "%s authentication failure skips the provider's remaining candidates",
  async (role) => {
    const first = models[0];
    if (!first) throw new Error("missing model");
    const secret = `auth-secret-${role}`;
    registerCredential("auth-test", secret);
    const f = fixture(
      undefined,
      (spec) =>
        spec.target.provider === "alpha"
          ? {
              status: "unavailable",
              failureClass: "authentication",
              error: `authentication rejected ${secret}`,
            }
          : { text: "success", structured: { complete: true } },
      undefined,
      [...models, { ...first, id: "alpha/second", model: "alpha-2" }],
    );
    f.context.run.models = { [role]: ["alpha/m", "alpha/second", "beta/m"] };
    const outcome = await f.invoke({
      role,
      mode: role === "implement" ? "edit" : "readonly",
      constraints: {},
      requireStructured: role !== "implement",
    });
    expect(outcome.target.provider).toBe("beta");
    expect(f.calls.map((s) => s.target.modelId)).toEqual(["alpha/m", "beta/m"]);
    expect(f.store.listInvocations(f.run.id)).toMatchObject([
      {
        modelId: "alpha/m",
        status: "unavailable",
        error: expect.stringContaining("authentication rejected"),
      },
      { modelId: "beta/m", status: "ok" },
    ]);
    expect(f.tracker.status("alpha")).toMatchObject({
      state: "degraded",
      reason: expect.stringContaining("authentication rejected"),
    });
    expect(JSON.stringify(f.tracker.status("alpha"))).not.toContain(secret);
    expect(JSON.stringify(f.store.listInvocations(f.run.id))).not.toContain(secret);
    expect(f.context.state.round).toBe(0);
    expect(f.context.state.roundsOnImplementer).toBe(0);
  },
);

test.each([true, false])(
  "worker authentication rejection followed by local success=%s observes only local health",
  async (success) => {
    const f = fixture(undefined, () =>
      success
        ? { text: "local success" }
        : { status: "unavailable", failureClass: "authentication", error: "local authentication rejected" },
    );
    f.cfg.workers.agents = ["review"];
    f.cfg.workers.repos = [f.repo.slug];
    const workers = new WorkerStore(f.store, "a".repeat(40), { tick: 1 });
    const parentSha = "b".repeat(40);
    const enqueue = workers.enqueueAgentJob.bind(workers);
    spyOn(workers, "enqueueAgentJob").mockImplementation((request, id) => {
      if (!id) throw new Error("missing job id");
      const job = enqueue(request, id);
      f.store.db.query("UPDATE agent_jobs SET state='leased',worker='fixture-worker' WHERE id=?").run(id);
      workers.completeAgentJob(
        id,
        {
          ...remoteResult,
          status: "unavailable",
          failureClass: "authentication",
          error: "remote authentication rejected",
          parentSha,
          sha: parentSha,
          branch: "change/review",
        },
        "a".repeat(40),
      );
      return job;
    });
    const executor = lanAgentExecutor(workers, f.cfg);
    f.context.deps.agentExecutor = {
      kind: "lan",
      run: (call, local) =>
        executor.run(
          { ...call, spec: { ...call.spec, target: { ...call.spec.target, harness: "claude" } } },
          local,
        ),
    };
    const record = spyOn(f.tracker, "record");
    const invoked = f.invoke({
      role: "review",
      mode: "readonly",
      checkout: { parentSha, baseSha: parentSha, branch: "change/review" },
    });
    if (success) {
      expect((await invoked).result).toMatchObject({ status: "ok", finalText: "local success" });
      expect(f.tracker.status("alpha")).toMatchObject({ state: "ok", reason: null });
    } else {
      await expect(invoked).rejects.toThrow("local authentication rejected");
      expect(f.tracker.status("alpha")?.reason).toBe("local authentication rejected");
    }
    expect(f.calls).toHaveLength(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(f.store.listInvocations(f.run.id)).toHaveLength(1);
  },
);

test.each([false, true])(
  "private authentication exhaustion retains the cause without private output (pinned=%s)",
  async (pinned) => {
    const f = fixture(undefined, () => ({
      status: "error",
      failureClass: "authentication",
      error: "private diagnostic",
    }));
    if (pinned) f.context.run.models = { implement: ["alpha/m"] };
    await expect(f.invoke({ privateOutput: true })).rejects.toThrow("authentication failed");
    expect(f.tracker.status("alpha")?.reason).toBe("authentication failed");
    expect(f.store.listInvocations(f.run.id)).toMatchObject([
      { status: "unavailable", error: "authentication failed" },
    ]);
    expect(f.context.state.round).toBe(0);
  },
);

test("structured authentication rejection without diagnostics retains a usable reason", async () => {
  const f = fixture(undefined, () => ({ status: "error", failureClass: "authentication" }));
  await expect(f.invoke()).rejects.toThrow("authentication failed");
  expect(f.tracker.status("alpha")?.reason).toBe("authentication failed");
  expect(f.store.listInvocations(f.run.id)).toMatchObject([
    { status: "unavailable", error: "authentication failed" },
  ]);
});
