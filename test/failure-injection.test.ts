import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory, type FactoryOptions } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { NoCapacityError, RunContext, type RunState } from "../src/pipeline/context.ts";
import {
  type FaultContext,
  FaultInjector,
  type FaultPlan,
  HARNESS_KILLED,
  untilAborted,
} from "../src/pipeline/faults.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";
import { runProcess, sh } from "../src/util/proc.ts";

const providers: ProviderDef[] = ["a", "b"].map((id) => ({
  id,
  label: id,
  harness: "fake",
  billing: "subscription",
  maxConcurrent: 2,
}));
const models: ModelDef[] = providers.map(
  (p): ModelDef => ({
    id: p.id,
    provider: p.id,
    model: p.id,
    vendor: p.id === "a" ? "anthropic" : "openai",
    origin: "unknown",
    baseOrigin: "unknown",
    tier: 4,
    price: { input: 1, output: 1 },
    supportedEfforts: ["high"],
    effort: "high",
  }),
);
const policy = Object.fromEntries(
  ["triage", "spec", "holdout", "implement", "review", "verify"].map((r) => [r, { default: ["a", "b"] }]),
) as Policy;
const triage = {
  title: "Change",
  task_class: "feature",
  complexity: "small",
  risk: "low",
  ambiguity: "low",
  blocking_questions: [],
  summary: "Change",
  suggested_profile: "standard",
};
const spec = {
  summary: "Change",
  assumptions: [],
  requirements: ["Change"],
  acceptance_criteria: [{ id: "AC-1", criterion: "Change", how_to_verify: "inspect" }],
  out_of_scope: [],
  blocking_questions: [],
};
const holdout = {
  scenarios: [1, 2, 3].map((i) => ({
    id: `H-${i}`,
    description: "check",
    steps: "inspect",
    expected: "ok",
    edge_case: i > 1,
  })),
};
const review = { verdict: "approve", summary: "ok", findings: [] };
const verify = {
  overall: "pass",
  notes: "",
  criteria: ["AC-1", "H-1", "H-2", "H-3"].map((id) => ({
    id,
    status: "met",
    evidence: "observed",
    publicSummary: "",
  })),
};
function answer(s: AgentSpec): FakeReply {
  if (s.prompt.startsWith("Classify")) return { structured: triage };
  if (s.prompt.startsWith("Write the specification")) return { structured: spec };
  if (s.prompt.startsWith("Write blind")) return { structured: holdout };
  if (s.prompt.startsWith("You are an adversarial")) return { structured: review };
  if (s.prompt.startsWith("You are the acceptance")) return { structured: verify };
  return { files: { "ui/change.txt": "done\n" }, text: "done" };
}
let root: string;
let source: string;
let factories: Factory[];
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "limitless-fault-"));
  source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "README.md"), "fixture\n");
  writeFileSync(join(source, ".limitless.toml"), '[gates]\nchecks = [{name="check",run="true"}]\n');
  for (const cmd of [
    ["init", "-qb", "main"],
    ["config", "user.email", "test@example.test"],
    ["config", "user.name", "Test"],
    ["add", "."],
    ["commit", "-qm", "base"],
  ])
    await sh(["git", ...cmd], { cwd: source });
  factories = [];
});
afterEach(async () => {
  for (const f of factories) {
    await f.stop();
    f.store.close();
  }
  rmSync(root, { recursive: true, force: true });
});
function factory(faults?: FaultPlan, handler = answer, opts: FactoryOptions = {}) {
  const f = new Factory(loadConfig({ home: join(root, "data"), configDir: join(root, "cfg") }), {
    providers,
    models,
    policy,
    harnesses: { fake: fakeHarness(handler) },
    faults,
    ...opts,
  });
  factories.push(f);
  return f;
}
async function wait(check: () => boolean) {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("barrier timed out");
    await Bun.sleep(5);
  }
}
async function run(f: Factory) {
  const r = await f.createRun({ repo: source, prompt: "Change", profile: "standard" });
  f.scheduler.start(); // Fixture providers have no probe URLs, credentials or network operations.
  return r.id;
}
async function settled(f: Factory, id: string) {
  await wait(() => !f.scheduler.activeRunIds.includes(id) && f.store.getRun(id)?.status !== "queued");
}
async function reopen(f: Factory, handler = answer) {
  await f.stop();
  f.store.close();
  factories = factories.filter((v) => v !== f);
  const next = factory(undefined, handler);
  next.scheduler.start();
  return next;
}
function history(f: Factory, id: string) {
  const r = f.store.getRun(id);
  const attempts = f.store.listInvocations(id);
  for (const row of [...f.store.listStages(id), ...attempts]) {
    expect(row.status).not.toBe("running");
    expect(row.finishedAt).toBeNumber();
  }
  expect(r?.tokensIn).toBe(attempts.reduce((n, i) => n + i.inputTokens + i.cacheReadTokens, 0));
  expect(r?.tokensOut).toBe(attempts.reduce((n, i) => n + i.outputTokens, 0));
  expect(r?.costUsd).toBeCloseTo(attempts.reduce((n, i) => n + i.costUsd, 0));
  expect(r?.costEquivUsd).toBeCloseTo(attempts.reduce((n, i) => n + i.costEquivUsd, 0));
  expect(f.tracker.all().every((p) => p.inFlight === 0)).toBe(true);
  expect(f.store.getRunState<RunState>(id)).not.toBeNull();
}
for (const stage of ["implement", "gates", "review", "verify", "deliver"] as const) {
  test(`restart during ${stage} preserves round and completed checks`, async () => {
    let reached = false;
    const f = factory({
      [`stage:${stage}:before`]: {
        action: "hang",
        onHit: () => {
          reached = true;
        },
      },
    });
    const id = await run(f);
    await wait(() => reached);
    await f.stop();
    expect(f.store.getRun(id)?.status).toBe("queued");
    history(f, id);
    const before = f.store.getRunState<RunState>(id);
    expect(existsSync(before?.worktreePath ?? "")).toBe(true);
    const stages = f.store.listStages(id).map((s) => s.name);
    const next = await reopen(f);
    await settled(next, id);
    expect(next.store.getRun(id)?.status).toBe("succeeded");
    const state = next.store.getRunState<RunState>(id);
    expect(state?.round).toBe(before?.round);
    expect(state?.roundsOnImplementer).toBe(before?.roundsOnImplementer);
    if (before?.implementer) expect(state?.implementer).toEqual(before.implementer);
    const resumed = next.store
      .listStages(id)
      .slice(stages.length)
      .map((s) => s.name);
    expect(resumed[0]).toBe(stage);
    for (const earlier of [
      "prepare",
      "triage",
      "spec",
      ...["implement", "gates", "audit", "review"].slice(
        0,
        ["implement", "gates", "audit", "review", "verify", "deliver"].indexOf(stage),
      ),
    ])
      expect(resumed).not.toContain(earlier);
    history(next, id);
  });
}
for (const stage of [
  "prepare",
  "triage",
  "clarify",
  "spec",
  "holdout",
  "implement",
  "gates",
  "audit",
  "review",
  "preview",
  "verify",
  "deliver",
] as const) {
  test(`Factory cancellation during ${stage} stays terminal on restart`, async () => {
    if (stage === "preview") {
      writeFileSync(
        join(source, ".limitless.toml"),
        '[gates]\nchecks=[]\n[preview]\npaths=["ui/"]\nbuild="true"\nserve="false"\nready="/"\nenv={}\n',
      );
      await sh(["git", "commit", "-qam", "preview"], { cwd: source });
    }
    let reached = false;
    const f = factory(
      {
        [`stage:${stage}:before`]: {
          action: "hang",
          onHit: () => {
            reached = true;
          },
        },
      },
      (s) =>
        stage === "clarify" && s.prompt.startsWith("Classify")
          ? { structured: { ...triage, ambiguity: "high", blocking_questions: ["Which?"] } }
          : answer(s),
    );
    const id = await run(f);
    await wait(() => reached);
    expect(f.cancelRun(id)).toBe(true);
    await settled(f, id);
    expect(f.store.getRun(id)?.status).toBe("cancelled");
    expect(f.store.getRun(id)?.error).toContain("cancelled by");
    history(f, id);
    const state = f.store.getRunState<RunState>(id);
    if (state?.worktreePath) expect(existsSync(state.worktreePath)).toBe(true);
    const count = f.store.listStages(id).length;
    const next = await reopen(f);
    expect(next.store.getRun(id)?.status).toBe("cancelled");
    expect(next.scheduler.activeRunIds).toEqual([]);
    expect(next.store.listStages(id)).toHaveLength(count);
  });
}
const failures: Record<string, FakeReply> = {
  exit: { fault: "exit" },
  kill: { fault: "kill" },
  timeout: { fault: "timeout" },
  throw: { fault: "throw" },
  schema: { structured: { invalid: true } },
  "claude malformed": { stream: { parser: "claude", lines: ["not json"] } },
  "claude truncated": {
    stream: {
      parser: "claude",
      lines: [
        '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}',
        '{"type":"result"',
      ],
    },
  },
  "codex malformed": { stream: { parser: "codex", lines: ["not json"] } },
  "codex truncated": {
    stream: { parser: "codex", lines: ['{"type":"turn.started"}', '{"type":"turn.completed"'] },
  },
};
for (const [name, failure] of Object.entries(failures))
  for (const exhaust of [false, true]) {
    test(`${name}: ${exhaust ? "exhaustion" : "recovery"} records every started attempt`, async () => {
      let calls = 0;
      const f = factory(undefined, (s) =>
        s.prompt.startsWith("Classify") && (exhaust || calls++ === 0) ? failure : answer(s),
      );
      const id = await run(f);
      await settled(f, id);
      expect(f.store.getRun(id)?.status).toBe(exhaust ? "needs_human" : "succeeded");
      if (exhaust) expect(f.store.getRun(id)?.error).toContain("No model available for triage");
      const inv = f.store.listInvocations(id).filter((i) => i.role === "triage");
      expect(inv.map((i) => i.modelId)).toEqual(["a", "b"]);
      expect(inv[0]?.error).toBeTruthy();
      expect(inv[0]?.status).toBe(name === "timeout" ? "timeout" : "error");
      expect(inv[1]?.status).toBe(exhaust ? inv[0]?.status : "ok");
      expect(f.store.getRunState<RunState>(id)?.round).toBe(0);
      expect(existsSync(f.store.getRunState<RunState>(id)?.worktreePath ?? "")).toBe(true);
      history(f, id);
    });
  }

for (const status of ["timeout", "stuck", "error"] as const)
  test(`implement ${status} preserves partial work and uses task feedback in the next round`, async () => {
    writeFileSync(
      join(source, ".limitless.toml"),
      '[gates]\nchecks = [{name="check",run="! test -f ui/change.txt || grep -qx done ui/change.txt"}]\n',
    );
    await sh(["git", "commit", "-qam", "check completed implementation"], { cwd: source });
    const attempts: { state: RunState | null; prompt: string }[] = [];
    const diagnostic = status === "error" ? "process exited with code 1" : `session ${status}`;
    const f = factory(undefined, (s) => {
      if (s.mode !== "edit") return answer(s);
      attempts.push({ state: f.store.getRunState<RunState>(id), prompt: s.prompt });
      return attempts.length === 1
        ? { status, error: diagnostic, files: { "ui/change.txt": "partial\n" } }
        : answer(s);
    });
    const id = await run(f);
    await settled(f, id);
    expect(f.store.getRun(id)).toMatchObject({ status: "succeeded", error: null });
    expect(attempts.map((a) => a.state?.round)).toEqual([0, 1]);
    expect(attempts[1]?.state).toMatchObject({
      implementedRound: 0,
      roundsOnImplementer: 1,
      implementerIssue: `${status}: ${diagnostic}`,
      triedImplementers: [{ modelId: "a", effort: "high" }],
    });
    expect(attempts[1]?.prompt).toContain("Your previous session ended early");
    expect(attempts[1]?.prompt).toContain(`${status}: ${diagnostic}`);
    const stages = f.store.listStages(id).filter((s) => s.name === "implement");
    expect(stages.map((s) => s.round)).toEqual([0, 1]);
    const inv = f.store.listInvocations(id).filter((i) => i.role === "implement");
    expect(inv.map((i) => i.stageId)).toEqual(stages.map((s) => s.id));
    expect(inv.map((i) => [i.modelId, i.status, i.error])).toEqual([
      ["a", status, diagnostic],
      ["a", "ok", null],
    ]);
    const state = f.store.getRunState<RunState>(id);
    expect(state?.implementerIssue).toBeNull();
    const cwd = state?.worktreePath ?? "";
    expect(existsSync(cwd)).toBe(true);
    expect((await sh(["git", "show", "HEAD~1:ui/change.txt"], { cwd })).stdout).toBe("partial\n");
    expect(readFileSync(join(cwd, "ui/change.txt"), "utf8")).toBe("done\n");
    history(f, id);
  });

test("quota after partial output persists cooldown and falls back without a task round", async () => {
  let now = 100_000;
  const f = factory(
    undefined,
    (s) =>
      s.target.provider === "a"
        ? {
            status: "quota",
            error: "429 quota rejected",
            events: [{ type: "text", text: "partial progress" }],
            quota: { windows: {}, exhaustedUntil: 200_000 },
          }
        : answer(s),
    { clock: () => now },
  );
  const id = await run(f);
  await settled(f, id);
  expect(f.store.getRun(id)?.status).toBe("succeeded");
  expect(
    f.store
      .listInvocations(id)
      .slice(0, 2)
      .map((i) => [i.provider, i.status]),
  ).toEqual([
    ["a", "quota"],
    ["b", "ok"],
  ]);
  expect(f.store.getProviderRow("a")).toMatchObject({ state: "exhausted", until: 200_000 });
  expect(f.store.getRunState<RunState>(id)?.round).toBe(0);
  const restored = factory(undefined, answer, { clock: () => now });
  expect(restored.tracker.isAvailable("a")).toBe(false);
  now = 199_999;
  expect(f.tracker.isAvailable("a")).toBe(false);
  now = 200_000;
  expect(f.tracker.isAvailable("a")).toBe(true);
  history(f, id);
});
for (const attempted of [false, true])
  test(`capacity exhaustion ${attempted ? "after calls" : "before calls"}`, async () => {
    const f = factory(undefined, () => ({ status: "quota", error: "429 quota exhausted" }));
    if (!attempted) for (const p of providers) f.tracker.setEnabled(p.id, false);
    const id = await run(f);
    await settled(f, id);
    expect(f.store.getRun(id)?.status).toBe("needs_human");
    expect(f.store.getRun(id)?.error).toContain("No model available");
    expect(f.store.listInvocations(id)).toHaveLength(attempted ? 2 : 0);
    const r = f.store.getRun(id);
    const repo = r && f.store.getRepo(r.repoId);
    if (!r || !repo) throw new Error("missing fixture");
    const ctx = new RunContext(f.deps, r, repo, new AbortController().signal);
    const stage = f.store.listStages(id).at(-1);
    if (!stage) throw new Error("missing stage");
    await expect(
      ctx.invoke({ stage, role: "triage", complexity: "small", mode: "readonly", prompt: "test" }),
    ).rejects.toBeInstanceOf(NoCapacityError);
    history(f, id);
  });

for (const fallback of [false, true])
  test(`disabling a blocked provider excludes subsequent routing (fallback=${fallback})`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = factory(undefined, answer, {
      harnesses: {
        fake: fakeHarness(async (s) => {
          if (s.prompt.startsWith("Classify")) {
            entered.resolve();
            await release.promise;
            if (fallback && s.target.provider === "a") return { structured: { invalid: true } };
          }
          return answer(s);
        }),
      },
    });
    const id = await run(f);
    try {
      await wait(() => f.store.listInvocations(id).length === 1);
      await entered.promise;
      f.tracker.setEnabled("a", false);
    } finally {
      release.resolve();
    }
    await settled(f, id);
    expect(f.store.getRun(id)?.status).toBe("succeeded");
    const inv = f.store.listInvocations(id);
    expect(inv[0]).toMatchObject({ provider: "a", status: fallback ? "error" : "ok" });
    expect(inv.slice(1).every((i) => i.provider === "b")).toBe(true);
    history(f, id);
  });

test("fault matching is one-shot, independent, and already-aborted hangs settle", async () => {
  const hit: string[] = [];
  const plan: FaultPlan = {
    "harness:invoke": {
      action: "throw",
      occurrence: 2,
      when: (c: FaultContext) => c.role === "implement",
      onHit: (c) => hit.push(c.role ?? ""),
    },
  };
  const context = { runId: "r", round: 0, role: "implement" as const };
  for (const injector of [new FaultInjector(plan), new FaultInjector(plan)]) {
    await injector.hit("harness:invoke", { ...context, role: "holdout" }, AbortSignal.abort());
    await injector.hit("harness:invoke", context, AbortSignal.abort());
    await expect(injector.hit("harness:invoke", context, AbortSignal.abort())).rejects.toThrow("injected");
    await injector.hit("harness:invoke", context, AbortSignal.abort());
  }
  expect(hit).toEqual(["implement", "implement"]);
  await new FaultInjector({ "store:save": { action: "hang" } }).hit(
    "store:save",
    context,
    AbortSignal.abort(),
  );
  await untilAborted(AbortSignal.abort());
});

test("failed checkpoint leaves durable state usable after SQLite reopen", async () => {
  const f = factory({ "store:save": { action: "throw", occurrence: 2 } });
  const r = await f.createRun({ repo: source, prompt: "Change" });
  const repo = f.store.getRepo(r.repoId);
  if (!repo) throw new Error("missing repo");
  const ctx = new RunContext(f.deps, r, repo, new AbortController().signal);
  await ctx.save();
  const before = f.store.getRunState<RunState>(r.id);
  ctx.state.round = 99;
  await expect(ctx.save()).rejects.toThrow("store:save");
  const db = new Store(f.cfg.paths.db);
  try {
    expect(db.getRunState<RunState>(r.id)).toEqual(before);
  } finally {
    db.close();
  }
});

for (const [checkpoint, action] of [
  ["implementation-committed", "kill"],
  ["stage:implement:after", "kill"],
  ["stage:implement:after", "throw"],
] as const)
  test(`commit window ${checkpoint} ${action} does not duplicate work`, async () => {
    const fault = {
      action,
      when: (c: { checkpoint?: string }) => c.checkpoint === checkpoint,
    };
    const f = factory(
      checkpoint === "stage:implement:after" ? { [checkpoint]: { action } } : { "store:save": fault },
    );
    const id = await run(f);
    await settled(f, id);
    // A thrown fault re-queues and resumes in place; a kill waits for a fresh Factory.
    expect(f.store.getRun(id)?.status).toBe(action === "throw" ? "succeeded" : "running");
    const failed = f.store.listStages(id).find((s) => s.status === "failed");
    if (action === "throw")
      expect(failed).toMatchObject({ name: "implement", summary: expect.stringContaining("injected") });
    const state = f.store.getRunState<RunState>(id);
    const cwd = state?.worktreePath ?? "";
    const head = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout;
    const next = await reopen(f);
    await settled(next, id);
    expect(next.store.getRun(id)).toMatchObject({ status: "succeeded", error: null });
    expect((await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout).toBe(head);
    expect((await sh(["git", "rev-list", "--count", "HEAD"], { cwd })).stdout.trim()).toBe("2");
    expect(next.store.listInvocations(id).filter((i) => i.role === "implement")).toHaveLength(1);
    history(next, id);
  });

for (const point of ["harness:invoke", "harness:stream"] as const) {
  test(`${point} kill is a recorded harness failure routed by task policy`, async () => {
    const f = factory({ [point]: { action: "kill", when: (c: FaultContext) => c.role === "implement" } });
    const id = await run(f);
    await settled(f, id);
    expect(f.store.getRun(id)).toMatchObject({ status: "succeeded", error: null });
    const inv = f.store.listInvocations(id).filter((i) => i.role === "implement");
    expect(inv[0]).toMatchObject({ modelId: "a", status: "error", error: HARNESS_KILLED });
    expect(f.store.listStages(id).find((s) => s.name === "implement")?.status).toBe("succeeded");
    history(f, id);
  });
  for (const action of ["hang"] as const)
    test(`${point} ${action} targets implement without background holdout consuming it`, async () => {
      let reached = false;
      const f = factory({
        [point]: {
          action,
          when: (c: FaultContext) => c.role === "implement",
          onHit: () => {
            reached = true;
          },
        },
      });
      const id = await run(f);
      await wait(() => reached);
      await f.stop();
      const selection = f.store.getRunState<RunState>(id)?.implementer;
      expect(selection).toMatchObject({ modelId: "a", effort: "high" });
      history(f, id);
      const next = await reopen(f);
      await settled(next, id);
      expect(next.store.getRun(id)?.status).toBe("succeeded");
      expect(next.store.getRunState<RunState>(id)?.implementer).toEqual(selection);
      expect(
        next.store
          .listInvocations(id)
          .filter((i) => i.role === "implement")
          .map((i) => i.status),
      ).toEqual(["cancelled", "ok"]);
      history(next, id);
    });
}

test("stream seam feeds parser bytes and recovers through routing", async () => {
  const f = factory({
    "harness:stream": {
      action: { parser: "codex", lines: ['{"type":"turn.started"}', '{"type":'] },
      when: (c) => c.role === "triage",
    },
  });
  const id = await run(f);
  await settled(f, id);
  expect(f.store.getRun(id)?.status).toBe("succeeded");
  expect(f.store.listInvocations(id)[0]?.error).toContain("truncated");
  history(f, id);
});

test("startup finalizes abandoned running rows before retrying the stage", async () => {
  const f = factory();
  const r = await f.createRun({ repo: source, prompt: "Change" });
  f.store.updateRun(r.id, { status: "running" });
  const stage = f.store.startStage(r.id, "prepare");
  const inv = f.store.createInvocation({
    runId: r.id,
    stageId: stage.id,
    role: "triage",
    harness: "fake",
    provider: "a",
    model: "a",
    modelId: "a",
  });
  const next = await reopen(f);
  await settled(next, r.id);
  expect(next.store.getRun(r.id)?.status).toBe("succeeded");
  expect(next.store.getStage(stage.id)?.status).toBe("cancelled");
  expect(next.store.getInvocation(inv.id)?.error).toContain("interrupted");
  history(next, r.id);
});

for (const kind of ["harness", "gate", "preview"] as const)
  test(`cancel active ${kind} kills its process group and retains worktree`, async () => {
    const pidFile = join(root, "pids");
    const script = `sleep 60 & child=$!; echo "$$ $child" > '${pidFile}'; wait`;
    if (kind === "gate") {
      writeFileSync(
        join(source, ".limitless.toml"),
        `[gates]\nchecks=[{name="block",run=${JSON.stringify(`if test -e ui/change.txt; then ${script}; fi`)}}]\n`,
      );
      await sh(["git", "commit", "-qam", "gate"], { cwd: source });
    }
    if (kind === "preview") {
      writeFileSync(
        join(source, ".limitless.toml"),
        `[gates]\nchecks=[]\n[preview]\npaths=["ui/"]\nbuild=${JSON.stringify(script)}\nserve="false"\nready="/"\nenv={}\n`,
      );
      await sh(["git", "commit", "-qam", "preview"], { cwd: source });
    }
    const f = factory(undefined, answer, {
      harnesses: {
        fake: fakeHarness(async (s) => {
          if (kind === "harness" && answer(s).files) {
            const result = await runProcess({
              cmd: ["/bin/sh", "-c", script],
              cwd: s.cwd,
              env: {},
              signal: s.signal,
            });
            expect(result.cancelled).toBe(true);
          }
          return answer(s);
        }),
      },
    });
    const id = await run(f);
    await wait(() => existsSync(pidFile));
    const pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
    try {
      f.cancelRun(id);
      await settled(f, id);
      for (const pid of pids)
        await wait(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        });
      expect(f.store.getRun(id)?.status).toBe("cancelled");
      expect(existsSync(f.store.getRunState<RunState>(id)?.worktreePath ?? "")).toBe(true);
      history(f, id);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  });

/** Stateful fake `gh` (one PR per branch) and a `git push` stub on PATH; returns a restore hook. */
function fakeGh(pr: string) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}\nimport {existsSync,readFileSync,writeFileSync} from "node:fs";\nconst file=${JSON.stringify(pr)};\nif(process.argv[3]==="list" && existsSync(file)) console.log(readFileSync(file,"utf8"));\nif(process.argv[3]==="create") { if(existsSync(file)) process.exit(9); writeFileSync(file,"https://github.com/test/repo/pull/1"); console.log(readFileSync(file,"utf8")); }\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "git"),
    '#!/bin/sh\nif [ "$1" = push ]; then exit 0; fi\nexec /usr/bin/git "$@"\n',
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  return async () => {
    for (const f of factories) await f.stop();
    process.env.PATH = oldPath;
  };
}
function githubRun(f: Factory, url = source) {
  const repo = f.store.upsertRepo({
    slug: "test/repo",
    kind: "github",
    url,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  return repo;
}
const blocked = {
  ...verify,
  overall: "fail",
  criteria: verify.criteria.map((c) =>
    c.id === "AC-1" ? { ...c, status: "blocked", evidence: "EPERM" } : c,
  ),
};

test("PR creation window reconciles a stateful fake after Factory replacement", async () => {
  const pr = join(root, "pr");
  const restore = fakeGh(pr);
  try {
    const f = factory({
      "store:save": { action: "kill", when: (c) => c.checkpoint === "delivery-pr-created" },
    });
    const repo = githubRun(f);
    const r = f.store.createRun(repo, { repo: repo.slug, prompt: "Change", profile: "standard" });
    f.scheduler.start();
    await settled(f, r.id);
    expect(f.store.getRun(r.id)?.status).toBe("running");
    expect(f.store.getRun(r.id)?.prUrl).toBeNull();
    const cwd = f.store.getRunState<RunState>(r.id)?.worktreePath ?? "";
    expect(existsSync(cwd)).toBe(true);
    expect(readFileSync(pr, "utf8")).toContain("/pull/1");
    const next = await reopen(f);
    await settled(next, r.id);
    expect(next.store.getRun(r.id)).toMatchObject({
      status: "succeeded",
      prUrl: "https://github.com/test/repo/pull/1",
    });
    expect(existsSync(cwd)).toBe(false);
    history(next, r.id);
  } finally {
    await restore();
  }
});

test("restart during the environment verification retry resumes that retry", async () => {
  let verifies = 0;
  const handler = (s: AgentSpec): FakeReply =>
    s.prompt.startsWith("You are the acceptance") && verifies++ === 0 ? { structured: blocked } : answer(s);
  let reached = false;
  const f = factory(
    {
      "stage:verify:before": {
        action: "hang",
        occurrence: 2,
        onHit: () => {
          reached = true;
        },
      },
    },
    handler,
  );
  const id = await run(f);
  await wait(() => reached);
  const next = await reopen(f, handler);
  await settled(next, id);
  expect(next.store.getRun(id)?.status).toBe("succeeded");
  const verifiers = next.store.listInvocations(id).filter((i) => i.role === "verify");
  expect(verifiers.map((i) => [i.modelId, i.status])).toEqual([
    ["b", "ok"],
    ["a", "ok"],
  ]);
  expect(next.store.getRunState<RunState>(id)?.verifyResults?.map((v) => v.attempt)).toEqual([0, 1]);
  history(next, id);
});

for (const interrupt of ["cancel", "shutdown"] as const)
  test(`${interrupt} during draft delivery is not recorded as needs_human`, async () => {
    const pr = join(root, "pr");
    const restore = fakeGh(pr);
    try {
      let reached = false;
      const f = factory(
        {
          "stage:deliver:before": {
            action: "hang",
            onHit: () => {
              reached = true;
            },
          },
        },
        (s) => (s.prompt.startsWith("You are the acceptance") ? { structured: blocked } : answer(s)),
      );
      const repo = githubRun(f);
      const r = f.store.createRun(repo, { repo: repo.slug, prompt: "Change", profile: "standard" });
      f.scheduler.start();
      await wait(() => reached);
      if (interrupt === "cancel") {
        f.cancelRun(r.id);
        await settled(f, r.id);
        expect(f.store.getRun(r.id)).toMatchObject({ status: "cancelled", error: "cancelled by user" });
        expect(f.store.listStages(r.id).at(-1)).toMatchObject({ name: "deliver", status: "cancelled" });
        expect(existsSync(f.store.getRunState<RunState>(r.id)?.worktreePath ?? "")).toBe(true);
        history(f, r.id);
        const next = await reopen(f);
        expect(next.store.getRun(r.id)?.status).toBe("cancelled");
        expect(existsSync(pr)).toBe(false);
        return;
      }
      await f.stop();
      expect(f.store.getRun(r.id)?.status).toBe("queued");
      const next = await reopen(f);
      await settled(next, r.id);
      expect(next.store.getRun(r.id)).toMatchObject({
        status: "needs_human",
        prUrl: "https://github.com/test/repo/pull/1",
      });
      expect(next.store.getRun(r.id)?.error).toContain("blocked by the environment");
      expect(next.store.listInvocations(r.id).filter((i) => i.role === "verify")).toHaveLength(2);
      history(next, r.id);
    } finally {
      await restore();
    }
  });

test("shutdown during the draft after an exhausted verification retry resumes the draft", async () => {
  const pr = join(root, "pr");
  const restore = fakeGh(pr);
  try {
    // Attempt 0 is environment-blocked; the retry's only candidate returns schema-invalid output, so
    // routing is exhausted without a recorded attempt 1. Any later verifier call would pass.
    const replies = [blocked, { invalid: true }];
    let verifies = 0;
    const handler = (s: AgentSpec): FakeReply =>
      s.prompt.startsWith("You are the acceptance")
        ? { structured: replies[verifies++] ?? verify }
        : answer(s);
    let reached = false;
    const f = factory(
      {
        "stage:deliver:before": {
          action: "hang",
          onHit: () => {
            reached = true;
          },
        },
      },
      handler,
    );
    const repo = githubRun(f);
    const r = f.store.createRun(repo, { repo: repo.slug, prompt: "Change", profile: "standard" });
    f.scheduler.start();
    await wait(() => reached);
    await f.stop();
    expect(f.store.getRun(r.id)?.status).toBe("queued");
    const state = f.store.getRunState<RunState>(r.id);
    expect(state?.environmentRetryRound).toBe(0);
    expect(state?.verifyResults?.map((v) => v.attempt)).toEqual([0]);
    expect(state?.needsHumanReason).toContain("blocked by the environment");
    const next = await reopen(f, handler);
    await settled(next, r.id);
    expect(next.store.getRun(r.id)).toMatchObject({
      status: "needs_human",
      prUrl: "https://github.com/test/repo/pull/1",
    });
    expect(next.store.getRun(r.id)?.error).toContain("blocked by the environment");
    expect(next.store.getRun(r.id)?.error).toContain("No model available for verify after");
    const verifiers = next.store.listInvocations(r.id).filter((i) => i.role === "verify");
    expect(verifiers.map((i) => [i.modelId, i.status])).toEqual([
      ["b", "ok"],
      ["a", "error"],
    ]);
    expect(next.store.listStages(r.id).filter((s) => s.name === "verify")).toHaveLength(2);
    history(next, r.id);
  } finally {
    await restore();
  }
});

test("existing-branch push interrupted before completion is reconciled on restart", async () => {
  const remote = join(root, "remote.git");
  await sh(["git", "clone", "-q", "--bare", source, remote], { cwd: root });
  const headSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: source })).stdout.trim();
  const f = factory({ "store:save": { action: "kill", when: (c) => c.checkpoint === "delivery-complete" } });
  const repo = githubRun(f, remote);
  const request = {
    repo: repo.slug,
    prompt: "Change",
    profile: "standard" as const,
    source: "github" as const,
    requestedBy: "dependabot[bot]",
    baseBranch: "main",
    deliveryBranch: "main",
    sourceRef: { kind: "pull_request", repo: repo.slug, number: 7, headSha },
  };
  const r = f.store.createRun(repo, request, true);
  f.scheduler.start();
  await settled(f, r.id);
  expect(f.store.getRun(r.id)?.status).toBe("running");
  const pushed = (await sh(["git", "rev-parse", "main"], { cwd: remote })).stdout.trim();
  expect(pushed).not.toBe(headSha);
  const next = await reopen(f);
  await settled(next, r.id);
  expect(next.store.getRun(r.id)).toMatchObject({
    status: "succeeded",
    headSha: pushed,
    prUrl: "https://github.com/test/repo/pull/7",
  });
  expect((await sh(["git", "rev-parse", "main"], { cwd: remote })).stdout.trim()).toBe(pushed);
  expect((await sh(["git", "rev-list", "--count", "main"], { cwd: remote })).stdout.trim()).toBe("2");
  history(next, r.id);
});
