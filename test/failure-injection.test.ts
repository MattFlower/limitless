import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory, type FactoryOptions } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import {
  createPullRequest,
  GitHubUnavailableError,
  githubRetry,
  isTransient,
  mergePullRequest,
  pushBranch,
  withGitHubRetry,
} from "../src/git/repos.ts";
import { CodexReaderProbe, runCodex } from "../src/harness/codex.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { NoCapacityError, RunContext, type RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import {
  type FaultContext,
  FaultInjector,
  type FaultPlan,
  HARNESS_KILLED,
  InjectedFault,
  SimulatedTermination,
  untilAborted,
} from "../src/pipeline/faults.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";
import { CommandError, type ProcOptions, type ProcResult, runProcess, sh } from "../src/util/proc.ts";
import { gitSeed } from "./git-seed.ts";
import { findingEvidence } from "./review-support.ts";

// These tests drive real git and subprocesses; under CPU load they outlast Bun's 5 s default (#140).
setDefaultTimeout(30_000);
githubRetry.baseDelayMs = 10;

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
const review = {
  verdict: "approve",
  summary: "ok: checked the diff against every requirement",
  findings: [],
};
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
  if (s.prompt.startsWith("Write holdout checks")) return { structured: holdout };
  if (s.prompt.startsWith("You are an adversarial")) return { structured: review };
  if (s.prompt.startsWith("You are the acceptance")) return { structured: verify };
  return { files: { "ui/change.txt": "done\n" }, text: "done" };
}
let root: string;
let source: string;
let factories: Factory[];
const sourceSeed = gitSeed(async (dir) => {
  writeFileSync(join(dir, "README.md"), "fixture\n");
  writeFileSync(join(dir, ".limitless.toml"), '[gates]\nchecks = [{name="check",run="true"}]\n');
  for (const cmd of [
    ["init", "-qb", "main"],
    ["config", "user.email", "test@example.test"],
    ["config", "user.name", "Test"],
    ["add", "."],
    ["commit", "-qm", "base"],
  ])
    await sh(["git", ...cmd], { cwd: dir });
});
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "limitless-fault-"));
  source = join(root, "source");
  cpSync((await sourceSeed()).dir, source, { recursive: true });
  factories = [];
});
afterEach(async () => {
  for (const f of factories) {
    await f.stop();
    f.store.close();
  }
  rmSync(root, { recursive: true, force: true });
});
function factory(
  faults?: FaultPlan,
  handler: (s: AgentSpec) => FakeReply | Promise<FakeReply> = answer,
  opts: FactoryOptions = {},
) {
  const cfg = loadConfig({ home: join(root, "data"), configDir: join(root, "cfg") });
  cfg.maxConcurrentGates = 1;
  const f = new Factory(cfg, {
    healthFetch: Object.assign(async () => new Response("{}"), { preconnect() {} }),
    fetch: Object.assign(async () => new Response("{}"), { preconnect() {} }),
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
async function reopen(f: Factory, handler: (s: AgentSpec) => FakeReply | Promise<FakeReply> = answer) {
  await f.stop();
  f.store.close();
  factories = factories.filter((v) => v !== f);
  const next = factory(undefined, handler);
  next.deps.gh = f.deps.gh;
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
    // Holdout exports a base snapshot in parallel; let it finish so only `stage` is interrupted.
    await wait(() => reached && f.store.getRunState<RunState>(id)?.holdoutStatus === "complete");
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
    const invocationCount = f.store.listInvocations(id).length;
    const next = await reopen(f);
    expect(next.store.getRun(id)?.status).toBe("cancelled");
    expect(next.scheduler.activeRunIds).toEqual([]);
    expect(next.store.listStages(id)).toHaveLength(count);
    expect(next.store.listInvocations(id)).toHaveLength(invocationCount);
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

const SECRET = "sk-live-SENTINEL-0154";

/** Stand-ins for /tmp, the macOS TMPDIR (/var/folders/...) and home, distinct on any host. */
function privateRoots() {
  const roots = { tmp: join(root, "slash-tmp"), TMPDIR: join(root, "var-folders"), home: join(root, "home") };
  for (const dir of Object.values(roots)) mkdirSync(dir);
  // Canonical, as the probe's canary paths are.
  return { tmp: realpathSync(roots.tmp), TMPDIR: realpathSync(roots.TMPDIR), home: realpathSync(roots.home) };
}

async function confinedHoldout(f: ReturnType<typeof factory>, prompt = "Write holdout checks") {
  const r = await f.createRun({ repo: source, prompt: "Change", profile: "standard" });
  const repo = f.store.getRepo(r.repoId);
  if (!repo) throw new Error("missing repo");
  const ctx = new RunContext(f.deps, r, repo, new AbortController().signal);
  const cwd = mkdtempSync(join(root, "snapshot-"));
  const invoke = (confined: boolean) =>
    ctx.invoke({
      stage: f.store.startStage(r.id, "holdout"),
      role: "holdout",
      complexity: "small",
      mode: "readonly",
      prompt,
      cwd,
      ...(confined ? { confineReads: true } : {}),
      privateOutput: true,
    });
  return { run: r, invoke };
}

test("codex 0.154.0, which denies home and TMPDIR but allows /tmp, diverts confined readers", async () => {
  const roots = privateRoots();
  const commands: string[][] = [];
  const cli = async (opts: ProcOptions): Promise<ProcResult> => {
    commands.push(opts.cmd);
    const base = { exitCode: 0, signal: null, cancelled: false, timedOut: false, idleTimedOut: false };
    const done = { ...base, stdout: "", stderr: "", truncated: false, durationMs: 1 };
    if (opts.cmd[1] === "--version") return { ...done, stdout: "codex-cli 0.154.0\n" };
    if (opts.cmd[1] === "sandbox") {
      // 0.154.0 accepts the profile but leaves /tmp readable; stderr echoes config.
      const file = opts.cmd.at(-1) ?? "";
      if (file.startsWith(`${roots.TMPDIR}/`) || file.startsWith(`${roots.home}/`))
        return {
          ...done,
          exitCode: 1,
          stderr: `token = "${SECRET}"\ncat: ${file}: Operation not permitted\n`,
        };
      return { ...done, stdout: readFileSync(file, "utf8"), stderr: `token = "${SECRET}"\n` };
    }
    return done;
  };
  const probe = new CodexReaderProbe(() => "/old/node_modules/.bin/codex", {
    canaryRoots: () => [roots.TMPDIR, roots.home, roots.tmp],
  });
  const [a, b] = providers;
  if (!a || !b) throw new Error("missing fixture providers");
  const f = factory(undefined, answer, {
    providers: [{ ...a, harness: "codex" }, b],
    harnesses: { fake: fakeHarness(answer), codex: (s) => runCodex(s, cli, probe) },
  });
  const { run: r, invoke } = await confinedHoldout(f);
  const outcome = await invoke(true);
  expect(outcome.target.provider).toBe("b");
  expect(commands.map((cmd) => cmd[1])).not.toContain("exec");
  // Home and TMPDIR were denied; the /tmp canary is the one that leaked.
  const reads = commands.filter((cmd) => cmd[1] === "sandbox").map((cmd) => cmd.at(-1) ?? "");
  expect(reads.map((file) => file.startsWith(`${roots.tmp}/`))).toEqual([false, false, true]);
  const [rejected, fallback] = f.store.listInvocations(r.id);
  expect(fallback).toMatchObject({ provider: "b", status: "ok" });
  expect(rejected).toMatchObject({ provider: "a", status: "unavailable" });
  expect(rejected?.error).toContain("/old/node_modules/.bin/codex (codex-cli 0.154.0)");
  expect(rejected?.error).toContain("reader profile not enforced, exit 0");
  // The provider stays routable for unconfined roles; its card says why confined readers skip it.
  expect(f.tracker.status("a")).toMatchObject({
    state: "ok",
    confinement: {
      ok: false,
      path: "/old/node_modules/.bin/codex",
      version: "codex-cli 0.154.0",
      reason: "reader profile not enforced",
      exitCode: 0,
    },
  });
  const surfaces = JSON.stringify([
    f.store.listInvocations(r.id),
    f.store.listEvents(r.id),
    f.tracker.status("a"),
  ]);
  expect(surfaces).not.toContain(SECRET);
});

test("a confinement failure that reads like a model rejection blocks neither model nor provider", async () => {
  const [a, b] = providers;
  if (!a || !b) throw new Error("missing fixture providers");
  const confinedCalls: string[] = [];
  const f = factory(undefined, answer, {
    providers: [{ ...a, harness: "codex" }, b],
    harnesses: {
      fake: fakeHarness(answer),
      codex: async (s) => {
        const result = await fakeHarness(answer)(s);
        if (!s.confineReads) return result;
        confinedCalls.push(s.target.modelId);
        return {
          ...result,
          status: "unavailable",
          structured: null,
          error: "model a is not supported: unknown model",
          confinement: {
            ok: false,
            path: "/bin/codex",
            version: null,
            reason: "probe inconclusive",
            exitCode: 1,
          },
        };
      },
    },
  });
  const { run: r, invoke } = await confinedHoldout(f);
  expect((await invoke(true)).target.provider).toBe("b");
  expect(confinedCalls).toEqual(["a"]);
  expect(f.tracker.modelUnavailableReason("a")).toBeNull();
  expect(f.tracker.status("a")).toMatchObject({ state: "ok", reason: null, until: null });
  expect(f.tracker.isAvailable("a")).toBe(true);
  // The same model still serves unconfined roles.
  expect((await invoke(false)).target.modelId).toBe("a");
  expect(f.store.listInvocations(r.id).map((i) => [i.provider, i.status])).toEqual([
    ["a", "unavailable"],
    ["b", "ok"],
    ["a", "ok"],
  ]);
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
  f.store.updateInvocation(inv.id, { inputTokens: 17, outputTokens: 3, costUsd: 0.4 });
  const next = await reopen(f);
  await settled(next, r.id);
  expect(next.store.getRun(r.id)?.status).toBe("succeeded");
  expect(next.store.getInvocation(inv.id)).toMatchObject({ inputTokens: 17, outputTokens: 3, costUsd: 0.4 });
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
    // `${pr}.fail` queues scripted failures: {on, err?, landed?, hang?, delay?} (no err: succeed with
    // no output; hang: never exit, so the caller's command timeout fires; delay: ms before acting).
    `#!${process.execPath}
import {appendFileSync,existsSync,readFileSync,writeFileSync} from "node:fs";
const file=${JSON.stringify(pr)}, cmd=process.argv.slice(2).join(" "), state=()=>existsSync(file+".merged")?"MERGED":"OPEN";
appendFileSync(file+".calls",cmd+"\\n");
const q=existsSync(file+".fail")?JSON.parse(readFileSync(file+".fail","utf8")):[];
const fail=q[0]&&cmd.startsWith(q[0].on)?q.shift():null;
writeFileSync(file+".fail",JSON.stringify(q));
if(fail?.delay) await Bun.sleep(fail.delay);
const out=fail?()=>{}:console.log, end=()=>{ if(fail?.hang){setInterval(()=>{},1e6);return;} if(fail?.err){console.error(fail.err);process.exit(1);} };
if(fail&&!fail.landed){end();process.exit(0);}
if(process.argv[3]==="list" && existsSync(file)) { const url=readFileSync(file,"utf8"); out(process.argv.includes("--jq") ? url : JSON.stringify([{state:state(),url}])); }
if(process.argv[3]==="create") { if(existsSync(file)) {console.error("a pull request for branch already exists");process.exit(9);} writeFileSync(file,"https://github.com/test/repo/pull/1"); out(readFileSync(file,"utf8")); }
if(process.argv[3]==="merge") writeFileSync(file+".merged","");
if(process.argv[3]==="view") {
  if(process.argv.includes("headRefOid")) {
    const head=Bun.spawnSync(["/usr/bin/git","--git-dir",${JSON.stringify(join(root, "remote.git"))},"rev-parse","refs/heads/pr-head"]);
    out(JSON.stringify({headRefOid:head.stdout.toString().trim()}));
  } else out(process.argv.includes("--jq") ? state() : JSON.stringify({state:state(),url:readFileSync(file,"utf8")}));
}
end();
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncommand=$(while [ "$1" = -c ]; do shift 2; done; printf '%s' "$1")\nif [ "$command" = push ]; then printf '%s\\n' "$@" >> '${join(root, "pushes")}'; exit 0; fi\nexec /usr/bin/git "$@"\n`,
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

for (const operation of [
  "fetch",
  "push",
  "list",
  "edit",
  "create",
  "merge",
  "auto-merge",
  "existing-head",
  "existing-push",
  "comment",
  "comments",
  "draft",
] as const)
  test(`cancel active delivery ${operation} kills descendants and stays cancelled after restart`, async () => {
    const pr = join(root, "pr");
    const pidFile = join(root, "delivery-pids");
    const calls = join(root, "delivery-calls");
    const restore = fakeGh(pr);
    let pids: number[] = [];
    try {
      const pattern = {
        fetch: "git fetch origin +refs/heads/*",
        push: "git push *",
        list: "gh pr list *",
        edit: "gh pr edit *",
        create: "gh pr create *",
        merge: "gh pr merge *",
        "auto-merge": "gh pr merge *--auto*",
        "existing-head": "git ls-remote *",
        "existing-push": "git push --force-with-lease=*",
        comment: "gh pr comment *",
        comments: "gh api *",
        draft: "gh pr create *--draft*",
      }[operation];
      for (const bin of ["gh", "git"]) {
        const path = join(root, "bin", bin);
        renameSync(path, `${path}-delegate`);
        writeFileSync(
          path,
          `#!/bin/sh
args=$(while [ "$1" = -c ]; do shift 2; done; printf '%s' "$*")
printf '%s\\n' "${bin} $args" >> '${calls}'
case "${bin} $args" in
  ${pattern
    .split("*")
    .map((part) => `'${part}'`)
    .join("*")}) sleep 60 & child=$!; echo "$$ $child" > '${pidFile}'; wait; exit 1 ;;
esac
${operation === "auto-merge" ? 'if [ "$1 $2" = "pr merge" ]; then exit 1; fi' : ""}
exec '${path}-delegate' "$@"
`,
          { mode: 0o755 },
        );
      }
      if (operation === "edit") writeFileSync(pr, "https://github.com/test/repo/pull/1");
      const existing = operation.startsWith("existing-");
      let f = factory(
        operation === "comments"
          ? { "store:save": { action: "kill", when: (c) => c.checkpoint === "verification-comment-posted" } }
          : undefined,
        (s) =>
          operation === "draft" && s.prompt.startsWith("You are the acceptance")
            ? { structured: blocked }
            : answer(s),
      );
      let id: string;
      if (operation === "comment" || operation === "comments") {
        id = (await externalChange(f)).run.id;
      } else {
        const repo = githubRun(f);
        if (operation === "merge" || operation === "auto-merge")
          f.store.upsertRepo({ ...repo, mergePolicy: "auto" });
        const headSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: source })).stdout.trim();
        const r = f.store.createRun(
          repo,
          {
            repo: repo.slug,
            prompt: "Change",
            profile: "standard",
            ...(existing
              ? {
                  source: "github" as const,
                  requestedBy: "dependabot[bot]",
                  baseBranch: "main",
                  deliveryBranch: "main",
                  sourceRef: { kind: "pull_request", repo: repo.slug, number: 7, headSha },
                }
              : {}),
          },
          existing,
        );
        id = r.id;
        if (existing)
          f.store.setRunState(id, {
            flow: "build",
            phase: "prepare",
            answers: [],
            round: 0,
            roundsOnImplementer: 0,
            triedImplementers: [],
            feedback: null,
            toolCommands: [],
          } satisfies RunState);
      }
      f.scheduler.start();
      if (operation === "comments") {
        await settled(f, id);
        expect(f.store.getRun(id)?.status).toBe("running");
        f = await reopen(f);
      }
      await wait(() => existsSync(pidFile));
      pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
      expect(pids).toHaveLength(2);
      expect(f.store.getRun(id)).toMatchObject({ status: "running", stage: "deliver" });
      const beforeCancel = readFileSync(calls, "utf8");
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
      const cwd = f.store.getRunState<RunState>(id)?.worktreePath ?? "";
      expect(existsSync(cwd)).toBe(true);
      expect(f.store.listStages(id).at(-1)).toMatchObject({ name: "deliver", status: "cancelled" });
      history(f, id);
      const stages = f.store.listStages(id);
      const invocations = f.store.listInvocations(id);
      const next = await reopen(f);
      await settled(next, id);
      expect(next.store.getRun(id)?.status).toBe("cancelled");
      expect(next.store.listStages(id)).toEqual(stages);
      expect(next.store.listInvocations(id)).toEqual(invocations);
      expect(existsSync(cwd)).toBe(true);
      // In particular, a cancelled list/merge must not fall through to create/auto-merge.
      expect(readFileSync(calls, "utf8")).toBe(beforeCancel);
      history(next, id);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await restore();
    }
  });

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
  f.store.setRunState(r.id, {
    flow: "build",
    phase: "prepare",
    answers: [],
    round: 0,
    roundsOnImplementer: 0,
    triedImplementers: [],
    feedback: null,
    toolCommands: [],
  } satisfies RunState);
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

test("abrupt daemon death mid-gate discards staged edits and untracked residue before checking committed content", async () => {
  const entered = join(root, "gate-pid");
  const observed = join(root, "observed");
  mkdirSync(join(source, "ui"));
  writeFileSync(join(source, "ui/change.txt"), "done\n");
  writeFileSync(join(source, ".gitignore"), "cache/\n");
  const command = `if grep -qx broken ui/change.txt && ! test -f '${entered}'; then
    echo done > ui/change.txt; git add ui/change.txt; mkdir -p debris cache;
    echo residue > debris/sentinel; echo keep > cache/sentinel;
    echo $$ > '${entered}'; sleep 60;
  fi
  if test -f '${entered}'; then cat ui/change.txt >> '${observed}'; fi
  grep -qx done ui/change.txt`;
  writeFileSync(
    join(source, ".limitless.toml"),
    `[gates]\nchecks=[{name="check",run=${JSON.stringify(command)}}]\n`,
  );
  await sh(["git", "add", "."], { cwd: source });
  await sh(["git", "commit", "-qm", "tracked gate fixture"], { cwd: source });
  const f = factory();
  const r = await f.createRun({ repo: source, prompt: "Change", profile: "quick" });
  await f.stop();
  f.store.close();
  factories = factories.filter((v) => v !== f);
  const worker = join(root, "daemon.ts");
  writeFileSync(
    worker,
    `
    import { Factory } from ${JSON.stringify(join(import.meta.dir, "../src/app.ts"))};
    import { loadConfig } from ${JSON.stringify(join(import.meta.dir, "../src/config.ts"))};
    import { fakeHarness } from ${JSON.stringify(join(import.meta.dir, "../src/harness/fake.ts"))};
    const f = new Factory(loadConfig(${JSON.stringify({ home: join(root, "data"), configDir: join(root, "cfg") })}), {
      providers: ${JSON.stringify(providers)}, models: ${JSON.stringify(models)}, policy: ${JSON.stringify(policy)},
      healthFetch: async () => new Response('{}'), fetch: async () => new Response('{}'),
      harnesses: { fake: fakeHarness(s => s.prompt.startsWith('Classify')
        ? { structured: ${JSON.stringify(triage)} } : { files: { 'ui/change.txt': 'broken\\n' } }) }
    });
    f.scheduler.start();
  `,
  );
  const child = Bun.spawn([process.execPath, worker], { stdout: "ignore", stderr: "pipe" });
  let gatePid: number | undefined;
  try {
    await wait(() => existsSync(entered));
    gatePid = Number(readFileSync(entered, "utf8"));
    child.kill("SIGKILL");
    await child.exited;
    process.kill(-gatePid, "SIGKILL");
    const stopped = factory();
    const state = stopped.store.getRunState<RunState>(r.id);
    const cwd = state?.worktreePath ?? "";
    expect(stopped.store.getRun(r.id)?.status).toBe("running");
    expect(stopped.store.listStages(r.id).at(-1)).toMatchObject({ name: "gates", status: "running" });
    expect(readFileSync(join(cwd, "ui/change.txt"), "utf8")).toBe("done\n");
    expect((await sh(["git", "show", "HEAD:ui/change.txt"], { cwd })).stdout).toBe("broken\n");
    expect(existsSync(join(cwd, "debris/sentinel"))).toBe(true);
    await stopped.stop();
    stopped.store.close();
    factories = factories.filter((v) => v !== stopped);
    let repairing = false;
    const next = factory({
      "stage:implement:before": {
        action: "hang",
        when: (c) => c.round === 1,
        onHit: () => {
          repairing = true;
        },
      },
    });
    next.scheduler.start();
    await wait(() => repairing || !next.scheduler.activeRunIds.includes(r.id));
    expect(readFileSync(observed, "utf8")).toBe("broken\nbroken\n");
    expect(next.store.getRunState<RunState>(r.id)?.lastGates?.[0]?.blocking).toBe(true);
    expect(existsSync(join(cwd, "debris"))).toBe(false);
    expect(readFileSync(join(cwd, "cache/sentinel"), "utf8")).toBe("keep\n");
    expect(next.store.getRun(r.id)?.status).toBe("running");
    const repaired = await reopen(next, (s) =>
      s.mode === "edit"
        ? { files: { "ui/change.txt": "done\n", "ui/repair.txt": "committed repair\n" } }
        : answer(s),
    );
    await settled(repaired, r.id);
    expect(repaired.store.getRun(r.id)?.status).toBe("succeeded");
    expect(repaired.store.getRunState<RunState>(r.id)?.round).toBe(1);
    expect((await sh(["git", "show", "HEAD:ui/change.txt"], { cwd })).stdout).toBe("done\n");
    history(repaired, r.id);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    if (gatePid) {
      try {
        process.kill(-gatePid, "SIGKILL");
      } catch {}
    }
  }
});

test("unconfigured seams leave a successful run and release gate capacity", async () => {
  const f = factory();
  const id = await run(f);
  await settled(f, id);
  expect(f.store.getRun(id)).toMatchObject({ status: "succeeded", error: null });
  expect(f.store.getRunState<RunState>(id)).toMatchObject({ flow: "build", phase: "done", round: 0 });
  history(f, id);
  const { gateSlots } = await import("../src/gates/slots.ts");
  gateSlots.setLimit(1);
  const release = await gateSlots.acquire(AbortSignal.timeout(1000));
  release();
});

for (const cancel of [false, true])
  test(`drain then restart preserves completed checks (cancel=${cancel})`, async () => {
    const f = factory(undefined, (s) => {
      if (s.prompt.startsWith("You are an adversarial")) f.scheduler.drain();
      return answer(s);
    });
    const id = await run(f);
    await wait(() => f.scheduler.parkedRunIds.includes(id));
    expect(f.store.getRunState<RunState>(id)).toMatchObject({ phase: "deliver", parked: true });
    if (cancel) f.cancelRun(id);
    await f.stop();
    const count = f.store.listInvocations(id).length;
    const next = await reopen(f);
    await settled(next, id);
    expect(next.store.getRun(id)?.status).toBe(cancel ? "cancelled" : "succeeded");
    expect(next.store.listInvocations(id).filter((i) => i.role === "implement")).toHaveLength(1);
    expect(next.store.listInvocations(id)).toHaveLength(count);
    history(next, id);
  });

async function externalChange(f: Factory) {
  const baseSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: source })).stdout.trim();
  await sh(["git", "checkout", "-qb", "pr-head"], { cwd: source });
  writeFileSync(join(source, "README.md"), "external change\n");
  await sh(["git", "commit", "-qam", "external"], { cwd: source });
  const headSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: source })).stdout.trim();
  const remote = join(root, "remote.git");
  await sh(["git", "clone", "-q", "--bare", source, remote], { cwd: root });
  const repo = githubRun(f, remote);
  const run = f.store.createRun(
    repo,
    {
      repo: repo.slug,
      prompt: "Verify",
      profile: "quick",
      source: "github",
      requestedBy: "dependabot[bot]",
      baseBranch: "pr-head",
      deliveryBranch: "pr-head",
      sourceRef: { kind: "pull_request", repo: repo.slug, number: 7, baseRef: "main", baseSha, headSha },
    },
    true,
  );
  return { run, remote, baseSha, headSha };
}

test("verify-change reconciles a posted verification comment after its save is lost", async () => {
  const comments: string[] = [];
  const f = factory({
    "store:save": { action: "kill", when: (c) => c.checkpoint === "verification-comment-posted" },
  });
  const { run, headSha, baseSha } = await externalChange(f);
  f.deps.gh = async (args) => {
    if (args[0] === "api") return comments.join("\n");
    if (args[1] === "view") return JSON.stringify({ headRefOid: headSha });
    expect(args.slice(0, 3)).toEqual(["pr", "comment", "7"]);
    comments.push(args.at(-1) ?? "");
    return "";
  };
  f.scheduler.start();
  await settled(f, run.id);
  expect(f.store.getRun(run.id)).toMatchObject({ status: "running", error: null });
  expect(comments).toHaveLength(1);
  expect(f.store.getRunState<RunState>(run.id)).toMatchObject({
    flow: "verify-change",
    verdictCommentPending: true,
    verification: { headSha, baseSha, initialComplete: true },
  });
  const attempts = f.store.listInvocations(run.id).length;
  const next = await reopen(f);
  await settled(next, run.id);
  expect(next.store.getRun(run.id)).toMatchObject({ status: "succeeded", headSha });
  expect(comments).toHaveLength(1);
  expect(next.store.listInvocations(run.id)).toHaveLength(attempts);
  expect(next.store.getRunState<RunState>(run.id)).toMatchObject({
    verdictCommentPosted: true,
    reviewedSha: headSha,
  });
  history(next, run.id);
});

test.each(["502", "timeout", "exhausted", "injected", "terminated"] as const)(
  "verify-change head recheck preserves retries and interruptions: %s",
  async (failure) => {
    const comments: string[] = [];
    let lookups = 0;
    const f = factory();
    const { run, headSha } = await externalChange(f);
    f.deps.gh = async (args) => {
      if (args[0] === "api") return comments.join("\n");
      if (args[1] === "view") {
        lookups++;
        if (lookups === 1 || failure === "exhausted") {
          if (failure === "injected") throw new InjectedFault("head recheck interrupted");
          if (failure === "terminated") throw new SimulatedTermination("head recheck terminated");
          throw new CommandError(
            "gh failed",
            1,
            "",
            failure === "timeout" ? "" : "HTTP 502: Bad Gateway",
            failure === "timeout",
          );
        }
        return JSON.stringify({ headRefOid: headSha });
      }
      expect(args.slice(0, 3)).toEqual(["pr", "comment", "7"]);
      comments.push(args.at(-1) ?? "");
      return "";
    };
    const status = await executeRun(f.deps, run.id, new AbortController().signal);
    if (failure === "exhausted") {
      expect(status).toBe("failed");
      expect(lookups).toBe(githubRetry.attempts);
      expect(comments).toHaveLength(0);
      const reason = "Unable to confirm PR head before verdict: GitHub unavailable:";
      expect(f.store.getRun(run.id)?.error).toContain(reason);
      expect(f.store.getRunState<RunState>(run.id)?.terminalReason).toContain(reason);
      expect(f.store.getArtifact(run.id, "report.md")).toContain(reason);
      return;
    }
    if (failure === "injected" || failure === "terminated") {
      expect(status).toBe(failure === "injected" ? "queued" : "running");
      expect(comments).toHaveLength(0);
      expect(f.store.getRunState<RunState>(run.id)?.terminalReason).toBeUndefined();
      expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("succeeded");
    } else expect(status).toBe("succeeded");
    expect(lookups).toBe(2);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(`Verified commit: \`${headSha}\``);
  },
);

test("verify-change does not post its comment twice when the post lands but answers 502", async () => {
  const comments: string[] = [];
  const f = factory();
  const { run, headSha } = await externalChange(f);
  f.deps.gh = async (args) => {
    if (args[0] === "api") return comments.join("\n");
    if (args[1] === "view") return JSON.stringify({ headRefOid: headSha });
    comments.push(args.at(-1) ?? "");
    if (comments.length === 1) throw new CommandError("gh failed", 1, "", "HTTP 502: Bad Gateway", false);
    return "";
  };
  f.scheduler.start();
  await settled(f, run.id);
  expect(f.store.getRun(run.id)?.status).toBe("succeeded");
  expect(comments).toHaveLength(1);
  expect(comments[0]).toStartWith(`<!-- limitless-verification:${run.id} -->`);
});

for (const moved of [false, true])
  test(`verify-change repairs reconcile branch push and reject unrelated movement (moved=${moved})`, async () => {
    let reviews = 0;
    const handler = (s: AgentSpec): FakeReply =>
      s.prompt.startsWith("You are an adversarial") && reviews++ === 0
        ? {
            structured: {
              verdict: "request_changes",
              summary: "broken",
              findings: [
                {
                  severity: "major",
                  security: false,
                  ...findingEvidence,
                  file: "README.md",
                  line: 1,
                  title: "broken",
                  detail: "broken",
                  suggestion: "repair",
                },
              ],
            },
          }
        : answer(s);
    const f = factory(
      { "store:save": { action: "kill", when: (c) => c.checkpoint === "delivery-complete" } },
      handler,
    );
    const { run, remote, headSha } = await externalChange(f);
    f.scheduler.start();
    await settled(f, run.id);
    expect(f.store.getRun(run.id)).toMatchObject({ status: "running", error: null });
    const pushed = (await sh(["git", "rev-parse", "pr-head"], { cwd: remote })).stdout.trim();
    expect(pushed).not.toBe(headSha);
    if (moved) {
      writeFileSync(join(source, "README.md"), "unrelated change\n");
      await sh(["git", "commit", "-qam", "unrelated"], { cwd: source });
      await sh(["git", "push", "-q", "--force", remote, "pr-head"], { cwd: source });
    }
    const next = await reopen(f, handler);
    await settled(next, run.id);
    expect(next.store.getRun(run.id)?.status).toBe(moved ? "failed" : "succeeded");
    if (moved) expect(next.store.getRun(run.id)?.error).toContain("PR head moved");
    else expect((await sh(["git", "rev-parse", "pr-head"], { cwd: remote })).stdout.trim()).toBe(pushed);
    expect(next.store.getRunState<RunState>(run.id)?.flow).toBe("verify-change");
    expect(next.store.listInvocations(run.id).filter((i) => i.role === "implement")).toHaveLength(1);
    history(next, run.id);
  });

for (const checkpoint of ["resolution-start", "implementation-committed"] as const)
  test(`factory merge survives interruption at ${checkpoint} without losing parents or replaying completed work`, async () => {
    const restore = fakeGh(join(root, "pr"));
    try {
      let implementations = 0;
      const handler = async (s: AgentSpec): Promise<FakeReply> => {
        if (s.mode !== "edit") return answer(s);
        if (implementations++ === 0) {
          writeFileSync(join(source, "README.md"), "base advanced\n");
          await sh(["git", "commit", "-qam", "advance base"], { cwd: source });
          return { files: { "README.md": "implementation\n" } };
        }
        return { files: { "README.md": "both intents\n" } };
      };
      let reached = false;
      const f = factory(
        checkpoint === "resolution-start"
          ? {
              "stage:implement:before": {
                action: "hang",
                when: (c) => c.round === 1,
                onHit: () => {
                  reached = true;
                },
              },
            }
          : { "store:save": { action: "kill", when: (c) => c.round === 1 && c.checkpoint === checkpoint } },
        handler,
      );
      const repo = githubRun(f);
      const r = f.store.createRun(repo, { repo: repo.slug, prompt: "Change", profile: "standard" });
      f.scheduler.start();
      if (checkpoint === "resolution-start") {
        await wait(() => reached);
        await f.stop();
      } else await settled(f, r.id);
      const state = f.store.getRunState<RunState>(r.id);
      const cwd = state?.worktreePath ?? "";
      const parent = state?.preRebaseHead;
      const base = state?.pendingRebaseSha;
      if (!parent || !base) throw new Error("missing merge parents");
      expect(state?.conflictRound).toBe(1);
      if (checkpoint === "resolution-start") {
        expect((await sh(["git", "rev-parse", "MERGE_HEAD"], { cwd })).stdout.trim()).toBe(base);
        expect(readFileSync(join(cwd, "README.md"), "utf8")).toContain("<<<<<<< HEAD");
      }
      const next = await reopen(f, handler);
      await settled(next, r.id);
      expect(next.store.getRun(r.id)).toMatchObject({ status: "succeeded", error: null });
      const cache = join(next.cfg.paths.repos, "test__repo.git");
      const head = next.store.getRun(r.id)?.headSha ?? "";
      expect(
        (await sh(["git", "show", "-s", "--format=%P", head], { cwd: cache })).stdout.trim().split(" "),
      ).toEqual([parent, base]);
      expect(implementations).toBe(2);
      expect(next.store.listInvocations(r.id).filter((i) => i.role === "review")).toHaveLength(2);
      expect(next.store.getRunState<RunState>(r.id)?.lastVerifiedSha).toBe(head);
      history(next, r.id);
    } finally {
      await restore();
    }
  });

for (const cancel of [false, true])
  test(`verified-work draft retains its verified target across ${cancel ? "cancellation" : "PR checkpoint restart"}`, async () => {
    const pr = join(root, "pr");
    const restore = fakeGh(pr);
    try {
      let implementations = 0;
      const handler = async (s: AgentSpec): Promise<FakeReply> => {
        if (s.mode !== "edit") return answer(s);
        if (implementations++ === 0) {
          writeFileSync(join(source, "README.md"), "base advanced\n");
          await sh(["git", "commit", "-qam", "advance base"], { cwd: source });
          return { files: { "README.md": "implementation\n" } };
        }
        // An unresolved factory merge cannot replace the verified implementation in the draft.
        return {};
      };
      let reached = false;
      const f = factory(
        cancel
          ? {
              "stage:deliver:before": {
                action: "hang",
                occurrence: 2,
                onHit: () => {
                  reached = true;
                },
              },
            }
          : { "store:save": { action: "kill", when: (c) => c.checkpoint === "delivery-pr-created" } },
        handler,
      );
      const repo = githubRun(f);
      const r = f.store.createRun(repo, { repo: repo.slug, prompt: "Change", profile: "standard" });
      f.scheduler.start();
      if (cancel) {
        await wait(() => reached);
        f.cancelRun(r.id);
      }
      await settled(f, r.id);
      const state = f.store.getRunState<RunState>(r.id);
      expect(state?.lastVerifiedSha).toBe(state?.preRebaseHead);
      expect(state?.needsHumanReason).toContain("Unresolved conflict markers");
      expect(f.store.getRun(r.id)?.status).toBe(cancel ? "cancelled" : "running");
      const next = await reopen(f, handler);
      await settled(next, r.id);
      expect(next.store.getRun(r.id)?.status).toBe(cancel ? "cancelled" : "needs_human");
      expect(next.store.getRunState<RunState>(r.id)?.lastVerifiedSha).toBe(state?.lastVerifiedSha);
      if (cancel) expect(existsSync(pr)).toBe(false);
      else {
        expect(next.store.getRun(r.id)?.prUrl).toContain("/pull/1");
        const pushes = readFileSync(join(root, "pushes"), "utf8")
          .split("\n")
          .filter((line) => line.includes(":refs/heads/"));
        expect(pushes).toEqual(
          Array(2).fill(`${state?.lastVerifiedSha}:refs/heads/${next.store.getRun(r.id)?.branch}`),
        );
        expect(next.store.getArtifact(r.id, "report.md")).toContain(state?.lastVerifiedSha ?? "missing");
      }
      expect(implementations).toBe(2);
      expect(existsSync(state?.worktreePath ?? "")).toBe(true);
      history(next, r.id);
    } finally {
      await restore();
    }
  });

test("Factory stop waits for its active health probe before database replacement", async () => {
  const f = factory();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.tracker.probe = async () => {
    entered.resolve();
    await release.promise;
    f.store.listRuns();
  };
  f.scheduler.start();
  await entered.promise;
  let stopped = false;
  const stop = f.stop().then(() => {
    stopped = true;
  });
  try {
    await Bun.sleep(10);
    expect(stopped).toBe(false);
  } finally {
    release.resolve();
    await stop;
  }
  const next = await reopen(f);
  expect(next.scheduler.activeRunIds).toEqual([]);
});

const ghError = (stderr: string, timedOut = false) => new CommandError("gh failed", 1, "", stderr, timedOut);
const bad502 = "HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)";
const ghCalls = (pr: string, prefix: string) =>
  readFileSync(`${pr}.calls`, "utf8")
    .split("\n")
    .filter((c) => c.startsWith(prefix));

test("GitHub retries classify structured failures and share one abortable deadline", async () => {
  for (const stderr of [
    bad502,
    "error connecting to api.github.com",
    "non-200 OK status code: 503 x",
    'Post "https://api.github.com/graphql": read tcp 10.0.0.2:5->1.2.3.4:443: read: Connection Reset By Peer',
    'Get "https://api.github.com/repos/o/r": dial tcp: lookup api.github.com: i/o timeout',
    "ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known",
    'Post "https://api.github.com/graphql": net/http: TLS handshake timeout',
    'Post "https://api.github.com/graphql": EOF',
    "error: RPC failed; curl 18 transfer closed\nfatal: early EOF",
    "fatal: unexpected eof",
  ])
    expect(isTransient(ghError(stderr))).toBe(true);
  expect(isTransient(ghError("", true))).toBe(true);
  expect(isTransient(ghError("HTTP 422: Validation Failed"))).toBe(false);
  expect(isTransient(ghError("! [rejected] limitless/fix-timeout-502 (stale info)"))).toBe(false);
  // Branch names echoed in errors never look transient, however they are spelled.
  for (const branch of ["eof", "i/o-timeout", "connection-reset-by-peer", "tls-handshake-timeout"])
    expect(isTransient(ghError(`! [rejected] ${branch} -> ${branch} (non-fast-forward)`))).toBe(false);
  expect(isTransient(new Error(bad502))).toBe(false);
  // Only the failing call's stderr counts, not what it printed to stdout.
  expect(isTransient(new CommandError("x", 1, "i/o timeout", "fatal: denied", false))).toBe(false);
  let calls = 0;
  const flaky = (errors: CommandError[]) => async () => {
    calls++;
    const e = errors.shift();
    if (e) throw e;
    return "ok";
  };
  expect(await withGitHubRetry(flaky([ghError(bad502), ghError(bad502)]))).toBe("ok");
  expect(calls).toBe(3);
  calls = 0;
  const final = ghError("HTTP 422: Validation Failed");
  await expect(withGitHubRetry(flaky([final]))).rejects.toBe(final);
  expect(calls).toBe(1);
  // 100 ms, then 300 ms of backoff would overrun a 150 ms budget: give up without sleeping past it.
  githubRetry.baseDelayMs = 100;
  const budget = { leftMs: 150 };
  const started = Date.now();
  calls = 0;
  const failing = () => withGitHubRetry(flaky(Array(9).fill(ghError(bad502))), { budget });
  await expect(failing()).rejects.toBeInstanceOf(GitHubUnavailableError);
  await expect(failing()).rejects.toBeInstanceOf(GitHubUnavailableError);
  expect(calls).toBe(3); // the second call of the delivery gets no fresh budget: one attempt
  expect(Date.now() - started).toBeLessThan(250);
  // Local work between GitHub calls (merging, gates) does not drain the budget; only remote time does.
  await Bun.sleep(100);
  expect(budget.leftMs).toBeGreaterThan(0);
  const slow = () => withGitHubRetry(() => Bun.sleep(budget.leftMs + 5).then(() => "ok"), { budget });
  expect(await slow()).toBe("ok");
  expect(budget.leftMs).toBeLessThanOrEqual(0);
  await expect(failing()).rejects.toBeInstanceOf(GitHubUnavailableError);
  expect(calls).toBe(4); // a spent budget still allows each call's first attempt, never a retry
  githubRetry.baseDelayMs = 60_000;
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 20);
  try {
    await expect(withGitHubRetry(flaky([ghError(bad502)]), { signal: abort.signal })).rejects.toThrow();
  } finally {
    githubRetry.baseDelayMs = 10;
  }
});

test("GitHub retries SSH temporary DNS failures", async () => {
  let calls = 0;
  expect(
    await withGitHubRetry(async () => {
      if (++calls === 1)
        throw new CommandError(
          "git push failed",
          128,
          "",
          "ssh: Could not resolve hostname github.com: Temporary failure in name resolution",
          false,
        );
      return "pushed";
    }),
  ).toBe("pushed");
  expect(calls).toBe(2);
});

test("the budget bounds retries and waits, never a call's first attempt or a healthy slow call", async () => {
  const restore = fakeGh(join(root, "pr"));
  // A healthy push that takes longer than the budget left still completes on its own timeout.
  writeFileSync(
    join(root, "bin", "git"),
    `#!/bin/sh\ncommand=$(while [ "$1" = -c ]; do shift 2; done; printf '%s' "$1")\nif [ "$command" = config ]; then exec /usr/bin/git "$@"; fi\nsleep 0.3\necho "$@" >> '${join(root, "pushes")}'\n`,
    {
      mode: 0o755,
    },
  );
  const repo = { kind: "github", url: "https://github.com/test/repo.git" } as Parameters<
    typeof pushBranch
  >[0];
  const budget = { leftMs: 100 };
  try {
    await pushBranch(repo, root, "limitless/x", "HEAD", undefined, budget);
    expect(readFileSync(join(root, "pushes"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(budget.leftMs).toBeLessThan(0);
    // With the budget spent, the next call's first attempt still runs (as on main); only retries stop.
    await pushBranch(repo, root, "limitless/x", "HEAD", undefined, budget);
    expect(readFileSync(join(root, "pushes"), "utf8").trim().split("\n")).toHaveLength(2);
  } finally {
    await restore();
  }
});

test("PR create reuses a PR hidden by a 502 or reported as existing; 422 is final", async () => {
  const pr = join(root, "pr");
  const restore = fakeGh(pr);
  const opts = { branch: "limitless/x-timeout", base: "main", title: "T", body: "B", cwd: root };
  const repo = { slug: "test/repo" } as Parameters<typeof createPullRequest>[0];
  try {
    writeFileSync(`${pr}.fail`, JSON.stringify([{ on: "pr create", err: bad502, landed: true }]));
    expect(await createPullRequest(repo, opts)).toBe("https://github.com/test/repo/pull/1");
    expect(ghCalls(pr, "pr create")).toHaveLength(1);
    writeFileSync(`${pr}.fail`, JSON.stringify([{ on: "pr list" }]));
    expect(await createPullRequest(repo, opts)).toBe("https://github.com/test/repo/pull/1");
    expect(ghCalls(pr, "pr create")).toHaveLength(2);
    expect(ghCalls(pr, "pr edit")).toHaveLength(2);
    rmSync(pr);
    writeFileSync(`${pr}.fail`, JSON.stringify([{ on: "pr list" }, { on: "pr create", err: "HTTP 422: x" }]));
    await expect(createPullRequest(repo, opts)).rejects.toThrow("HTTP 422");
    expect(ghCalls(pr, "pr create")).toHaveLength(3);
    writeFileSync(`${pr}.fail`, JSON.stringify([{ on: "pr merge", err: bad502, landed: true }]));
    expect(await mergePullRequest("https://github.com/test/repo/pull/1", root, "T")).toBe("merged");
    expect(ghCalls(pr, "pr merge")).toHaveLength(1);
    // The landed merge is found even though the first state lookup also hit a 502.
    rmSync(`${pr}.merged`);
    const lookups = ghCalls(pr, "pr view").length;
    writeFileSync(
      `${pr}.fail`,
      JSON.stringify([
        { on: "pr merge", err: bad502, landed: true },
        { on: "pr view", err: bad502 },
      ]),
    );
    expect(await mergePullRequest("https://github.com/test/repo/pull/1", root, "T")).toBe("merged");
    expect(ghCalls(pr, "pr merge")).toHaveLength(2);
    expect(ghCalls(pr, "pr view")).toHaveLength(lookups + 2);
    // Exhausting the immediate merge still falls back to auto-merge, as on main.
    rmSync(`${pr}.merged`);
    writeFileSync(`${pr}.fail`, JSON.stringify(Array(3).fill({ on: "pr merge", err: bad502 })));
    expect(await mergePullRequest("https://github.com/test/repo/pull/1", root, "T")).toBe("auto");
    expect(ghCalls(pr, "pr merge").filter((c) => c.includes("--auto"))).toHaveLength(1);
    // A healthy merge slower than the budget left is not cut off, so it needs no reconciling.
    rmSync(`${pr}.merged`);
    const merges = ghCalls(pr, "pr merge").length;
    const views = ghCalls(pr, "pr view").length;
    writeFileSync(`${pr}.fail`, JSON.stringify([{ on: "pr merge", landed: true, delay: 300 }]));
    const budget = { leftMs: 100 };
    const url = "https://github.com/test/repo/pull/1";
    expect(await mergePullRequest(url, root, "T", undefined, budget)).toBe("merged");
    expect(ghCalls(pr, "pr merge")).toHaveLength(merges + 1);
    expect(ghCalls(pr, "pr view")).toHaveLength(views);
  } finally {
    await restore();
  }
});

for (const failures of [2, 3])
  test(`delivery with ${failures} PR-create 502s ${failures < 3 ? "delivers" : "falls back as GitHub unavailable"}`, async () => {
    const pr = join(root, "pr");
    const restore = fakeGh(pr);
    try {
      writeFileSync(`${pr}.fail`, JSON.stringify(Array(failures).fill({ on: "pr create", err: bad502 })));
      const f = factory();
      const repo = githubRun(f);
      const r = f.store.createRun(repo, { repo: repo.slug, prompt: "Change", profile: "standard" });
      f.scheduler.start();
      await settled(f, r.id);
      const run = f.store.getRun(r.id);
      expect(run?.prUrl).toBe("https://github.com/test/repo/pull/1");
      expect(ghCalls(pr, "pr create")).toHaveLength(failures + 1);
      expect(ghCalls(pr, "pr create").some((c) => c.includes("--draft"))).toBe(failures === 3);
      expect(run?.status).toBe(failures === 3 ? "needs_human" : "succeeded");
      if (failures === 3) expect(run?.error).toStartWith("GitHub unavailable: ");
    } finally {
      await restore();
    }
  });

test("PR create retries a lagging lookup after 'already exists', up to twice", async () => {
  const pr = join(root, "pr");
  const restore = fakeGh(pr);
  const opts = { branch: "limitless/x", base: "main", title: "T", body: "B", cwd: root };
  const repo = { slug: "test/repo" } as Parameters<typeof createPullRequest>[0];
  try {
    for (const lagging of [3, 4]) {
      // The PR exists, so create says so, but the first lookups do not see it yet.
      writeFileSync(pr, "https://github.com/test/repo/pull/1");
      writeFileSync(`${pr}.fail`, JSON.stringify(Array(lagging).fill({ on: "pr list" })));
      const creates = existsSync(`${pr}.calls`) ? ghCalls(pr, "pr create").length : 0;
      const created = createPullRequest(repo, opts);
      if (lagging === 3) expect(await created).toBe("https://github.com/test/repo/pull/1");
      else await expect(created).rejects.toBeInstanceOf(GitHubUnavailableError);
      expect(ghCalls(pr, "pr create")).toHaveLength(creates + 1);
    }
  } finally {
    await restore();
  }
});

test("a fallback after the budget is spent still records a PR that was created", async () => {
  const pr = join(root, "pr");
  const restore = fakeGh(pr);
  const budgetMs = githubRetry.budgetMs;
  githubRetry.budgetMs = 1_000;
  try {
    // The create lands but answers 502 only after the whole budget is gone.
    writeFileSync(
      `${pr}.fail`,
      JSON.stringify([{ on: "pr create", err: bad502, landed: true, delay: 1_200 }]),
    );
    const f = factory();
    const repo = githubRun(f);
    const r = f.store.createRun(repo, { repo: repo.slug, prompt: "Change", profile: "standard" });
    f.scheduler.start();
    await settled(f, r.id);
    expect(f.store.getRun(r.id)).toMatchObject({
      status: "needs_human",
      prUrl: "https://github.com/test/repo/pull/1",
    });
    expect(ghCalls(pr, "pr create")).toHaveLength(1);
  } finally {
    githubRetry.budgetMs = budgetMs;
    await restore();
  }
});

test("a delivery resumed after a crash and downtime starts a fresh GitHub budget", async () => {
  const pr = join(root, "pr");
  const restore = fakeGh(pr);
  const budgetMs = githubRetry.budgetMs;
  githubRetry.budgetMs = 2_000;
  try {
    // Crash mid-delivery, after the PR exists but before its URL is saved, then stay down past the
    // whole budget: the resumed delivery gets a fresh budget and reuses the PR.
    const f = factory({
      "store:save": { action: "kill", when: (c) => c.checkpoint === "delivery-pr-created" },
    });
    const repo = githubRun(f);
    const r = f.store.createRun(repo, { repo: repo.slug, prompt: "Change", profile: "standard" });
    f.scheduler.start();
    await settled(f, r.id);
    expect(f.store.getRun(r.id)?.status).toBe("running");
    expect(f.store.getRun(r.id)?.prUrl).toBeNull();
    await f.stop();
    await Bun.sleep(githubRetry.budgetMs + 500);
    const next = await reopen(f);
    await settled(next, r.id);
    expect(next.store.getRun(r.id)).toMatchObject({
      status: "succeeded",
      prUrl: "https://github.com/test/repo/pull/1",
    });
    expect(ghCalls(pr, "pr create")).toHaveLength(1);
    history(next, r.id);
  } finally {
    githubRetry.budgetMs = budgetMs;
    await restore();
  }
});

test("an invoke deadline bounds slot waits and every fallback, then gives up saying why", async () => {
  let reply: (s: AgentSpec) => Promise<FakeReply> = async () => ({});
  const f = factory(undefined, (s) => reply(s));
  const r = await f.createRun({ repo: source, prompt: "Change", profile: "standard" });
  const repo = f.store.getRepo(r.repoId);
  if (!repo) throw new Error("missing fixture");
  const ctx = new RunContext(f.deps, r, repo, new AbortController().signal);
  const stage = f.store.startStage(r.id, "review", 0);
  const call = () =>
    ctx.invoke({
      stage,
      role: "review",
      complexity: "small",
      mode: "readonly",
      prompt: "test",
      requireStructured: true,
      deadline: Date.now() + 300,
    });
  // A slow model gets only what is left of the deadline, and no fallback starts after it.
  const timeouts: number[] = [];
  reply = async (s) => {
    timeouts.push(s.timeoutMs);
    await Bun.sleep(s.timeoutMs);
    return { fault: "timeout" };
  };
  await expect(call()).rejects.toThrow("Timed out routing review after: a@high: harness timeout");
  expect(timeouts).toHaveLength(1);
  expect(timeouts[0]).toBeLessThanOrEqual(300);
  // Busy slots are waited for only until the deadline.
  const never = new AbortController().signal;
  const held = await Promise.all(["a", "a", "b", "b"].map((p) => f.tracker.acquire(p, never)));
  const started = Date.now();
  await expect(call()).rejects.toThrow("a@high: busy until the deadline");
  expect(Date.now() - started).toBeLessThan(5_000);
  for (const release of held) release();
  expect(timeouts).toHaveLength(1);
});
