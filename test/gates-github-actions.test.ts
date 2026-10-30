import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import {
  type ExecutionHandle,
  executeGate,
  GateBlockedError,
  type GateRequest,
  localExecutor,
} from "../src/gates/executor.ts";
import { type ActionsProgress, githubActionsExecutor } from "../src/gates/github-actions.ts";
import {
  compareGates,
  type GateRun,
  retryBaselineFailures,
  retryRegressions,
  validateRetry,
} from "../src/gates/run.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import { type EngineDeps, RunContext, type RunState } from "../src/pipeline/context.ts";
import {
  consumeGateExecution,
  resumeGateExecution,
  runGateExecution,
} from "../src/pipeline/gate-execution.ts";
import { CommandError, registerCredential, sh } from "../src/util/proc.ts";
import { seeded } from "./seeded.ts";

const seed = seeded(async (cwd) => {
  await sh(["git", "init", "-qb", "main"], { cwd });
  writeFileSync(join(cwd, "candidate.txt"), "base\n");
  await sh(["git", "add", "."], { cwd });
  await sh(["git", "commit", "-qm", "base"], { cwd });
  const baseSha = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
  writeFileSync(join(cwd, "candidate.txt"), "candidate\n");
  await sh(["git", "commit", "-qam", "candidate"], { cwd });
  return { baseSha, headSha: (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim() };
});
let cwd: string;
let req: GateRequest;
beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), "actions-gates-"));
  const { value } = await seed(cwd);
  req = {
    ...value,
    cwd,
    runId: "run-1",
    repo: "test/repo",
    gates: {
      setup: ["install"],
      checks: [{ name: "test", run: "test", timeoutSec: 80 }],
      source: "none",
      protectedPaths: [],
    },
  };
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
const signal = () => new AbortController().signal;
const token = "a".repeat(32);
const framed = (index = 0, exit = 0, ms = 123, timeout = false) =>
  `LIMITLESS:${token}:${index}:${exit}:${ms}:${timeout}`;
function log(setup = framed(), check = framed()) {
  return [
    ["Token", `LIMITLESS_TOKEN ${token}`],
    ["Checkout", "checkout-only"],
    ["Bun", "bun-only"],
    ["Setup", setup],
    ["Check", check],
  ]
    .flatMap(([step, text]) =>
      (text ?? "").split("\n").map((line) => `gate\t${step}\t2026-01-01T00:00:00Z ${line}`),
    )
    .join("\n");
}
function fixture() {
  let now = 4_000_000_000_000;
  const calls: string[] = [];
  const requests: { args: string[]; body: Record<string, unknown> | undefined; repo?: string }[] = [];
  const saved: ExecutionHandle[] = [];
  const remote = new Map<string, string>();
  const pushes: { url: string; headSha: string; dispatchSha?: string }[] = [];
  const deletes: string[] = [];
  const settings = {
    githubActions: true,
    githubActionsPaidMinutes: false,
    discreet: false,
    branchPrefix: "change/",
    landRequiresApproval: false,
  };
  const state = {
    destination: "test/repo" as string | undefined,
    meta: (): unknown => ({ default_branch: "main", full_name: "test/repo", private: false }),
    dispatchSha: req.baseSha,
    runStatus: "completed",
    returnId: true,
    visibleAfter: 0,
    discoveries: 0,
    sleeps: 0,
    delays: [] as number[],
    onSleep: () => {},
    jobs: [{ id: 1, name: "gate-0", status: "completed", conclusion: "success" }],
    logs: new Map([[1, log()]]),
  };
  const gh: GhRunner = async (args, _signal, stdin, repo) => {
    const path = args[1] ?? "";
    const body = stdin ? (JSON.parse(stdin) as Record<string, unknown>) : undefined;
    requests.push({ args, body, repo });
    if (args[0] === "run") return state.logs.get(Number(args[args.indexOf("--job") + 1])) ?? "";
    let data: unknown;
    if (path.endsWith("/dispatches")) {
      calls.push("dispatch");
      data = state.returnId ? { workflow_run_id: 17 } : null;
    } else if (path.endsWith("/cancel")) {
      calls.push("cancel");
      state.runStatus = "completed";
      data = null;
    } else if (path.includes("workflow_dispatch")) {
      state.discoveries++;
      calls.push("discover");
      data = {
        workflow_runs:
          state.discoveries > state.visibleAfter
            ? [{ id: 17, status: state.runStatus, created_at: "2020-01-01T00:00:00Z" }]
            : [],
      };
    } else if (path.includes("/jobs?")) data = { jobs: state.jobs, total_count: state.jobs.length };
    else if (path.endsWith("/runs/17")) data = { id: 17, status: state.runStatus };
    else if (path.includes("git/ref/heads/")) data = { object: { sha: state.dispatchSha } };
    else if (path === "repos/test/repo/") data = await state.meta();
    else throw new Error(`Unexpected fake gh call: ${args.join(" ")}`);
    if (args.includes("--include")) {
      const etag = `"${JSON.stringify(data).length}-${state.runStatus}"`;
      return args.includes(`If-None-Match: ${etag}`)
        ? "HTTP/2.0 304 Not Modified\r\n\r\n"
        : `HTTP/2.0 200 OK\r\nETag: ${etag}\r\n\r\n${JSON.stringify(data)}`;
    }
    return JSON.stringify(data);
  };
  const deps = {
    gh,
    destination: (runId?: string) => (runId ? state.destination : undefined),
    settings: () => settings,
    now: () => now,
    pollMs: 10,
    discardVisibilityMs: 40,
    async sleep(ms: number) {
      state.delays.push(ms);
      now += ms;
      if (++state.sleeps > 20) throw new Error("Unexpected unbounded polling");
      state.onSleep();
    },
    async push(p: ActionsProgress, url: string) {
      expect(saved.at(-1)?.githubActions?.dispatchSha).toBe(p.dispatchSha);
      expect(saved.at(-1)?.githubActions?.pushed).toBeUndefined();
      calls.push("push");
      pushes.push({ url, headSha: p.headSha, dispatchSha: p.dispatchSha });
      remote.set(p.dispatch, p.dispatchSha ?? "");
      remote.set(p.candidate, p.headSha);
    },
    async delete(_p: ActionsProgress, branch: string, sha: string, url: string) {
      calls.push(`delete:${branch}:${sha}`);
      deletes.push(url);
      if (remote.get(branch) === sha) remote.delete(branch);
    },
  };
  const persist = async (handle: ExecutionHandle) => {
    saved.push(structuredClone(handle));
  };
  const executor = () => githubActionsExecutor(deps);
  const run = (s = signal(), handle?: ExecutionHandle) =>
    executeGate(req, s, {}, executor(), handle, persist);
  const stored = async (progress: Partial<ActionsProgress> = {}) => {
    const handle = await executor().start(req, signal());
    if (!handle.githubActions) throw new Error("Missing fixture progress");
    Object.assign(handle.githubActions, { dispatchSha: "d".repeat(40), pushed: true }, progress);
    remote.set(handle.githubActions.dispatch, handle.githubActions.dispatchSha ?? "");
    remote.set(handle.githubActions.candidate, req.headSha);
    return handle;
  };
  const dispatches = () => requests.filter((r) => r.args[1]?.endsWith("/dispatches"));
  return {
    state,
    settings,
    calls,
    requests,
    saved,
    remote,
    pushes,
    deletes,
    dispatches,
    deps,
    executor,
    persist,
    run,
    stored,
  };
}

test("dispatch uses trusted per-handle branches and maps pass, failure and timeout records", async () => {
  const f = fixture();
  req.gates.checks = ["pass", "fail", "timeout"].map((name) => ({ name, run: name }));
  f.state.jobs = req.gates.checks.map((_, i) => ({
    id: i + 1,
    name: `gate-${i}`,
    status: "completed",
    conclusion: i ? "failure" : "success",
  }));
  f.state.logs.set(
    1,
    log(framed(), `${framed()}\nLIMITLESS:${"b".repeat(32)}:0:99:99:true\nLIMITLESS:0:99:99:true`),
  );
  f.state.logs.set(2, log(framed(), `(fail) expected excerpt\n${framed(0, 2, 234)}`));
  f.state.logs.set(3, log(framed(), framed(0, 137, 345, true)));
  const run = await f.run();
  expect(run.setupOk).toBe(true);
  expect(run.checks.map((r) => [r.ok, r.exitCode, r.durationMs, r.timedOut])).toEqual([
    [true, 0, 123, false],
    [false, 2, 234, false],
    [false, 137, 345, true],
  ]);
  expect(run.checks[1]?.failures).toContain("(fail) expected excerpt");
  expect(run.checks[1]?.output).not.toContain("checkout-only");
  expect(run.checks[1]?.output).not.toContain("bun-only");
  const p = f.saved[0]?.githubActions;
  const dispatched = f.requests.find((r) => r.args[1]?.endsWith("/dispatches"));
  expect(dispatched?.body).toMatchObject({ ref: p?.dispatch, return_run_details: true });
  expect(p?.dispatch).not.toBe("main");
  expect(f.saved.find((h) => h.githubActions?.dispatchSha)?.githubActions?.dispatchSha).toBe(req.baseSha);
  expect(f.calls.filter((c) => c !== "discover")).toEqual([
    "push",
    "dispatch",
    expect.stringContaining("/dispatch:"),
    expect.stringContaining("/candidate:"),
  ]);
  expect(f.executor().freshCheckoutFor?.("test/repo")).toBe(true);
});

test("setup failure returns the first failed setup and no checks", async () => {
  const f = fixture();
  f.state.logs.set(1, log(framed(0, 7, 456), "not run"));
  const run = await f.run();
  expect(run).toMatchObject({
    setupOk: false,
    checks: [],
    setup: [{ ok: false, exitCode: 7, durationMs: 456 }],
  });
  // A recorded setup failure is an ordinary candidate failure: it reaches normal feedback.
  const baseline = { setupOk: true, setup: [], checks: [] };
  expect(compareGates(baseline, run)[0]).toMatchObject({ verdict: "regressed", blocking: true });
});

test.each([
  "before push",
  "after push",
  "after intent before POST",
  "after POST before response",
  "after run ID",
  "after completed",
])("restart boundary: %s cleans up and stays blocked without a replacement", async (boundary) => {
  const f = fixture();
  const controller = new AbortController();
  const crash = () => {
    controller.abort(new Error("shutdown"));
    throw new Error("shutdown");
  };
  f.state.runStatus = boundary === "after completed" ? "completed" : "in_progress";
  f.state.logs.set(1, log(framed(), framed(0, 7)));
  const push = f.deps.push;
  f.deps.push = async (p, url) => {
    if (boundary === "before push") crash();
    await push(p, url);
    if (boundary === "after push") crash();
  };
  const gh = f.deps.gh;
  f.deps.gh = async (...args) => {
    const raw = await gh(...args);
    if (boundary === "after POST before response" && args[0][1]?.endsWith("/dispatches")) crash();
    return raw ?? "";
  };
  const persist = async (h: ExecutionHandle) => {
    await f.persist(h);
    const p = h.githubActions;
    if (
      (boundary === "after intent before POST" && p?.dispatchIntent) ||
      (boundary === "after run ID" && p?.runId) ||
      (boundary === "after completed" && p?.completed)
    )
      crash();
  };
  await expect(executeGate(req, controller.signal, {}, f.executor(), undefined, persist)).rejects.toThrow(
    "shutdown",
  );
  const old = structuredClone(f.saved.at(-1));
  if (!old?.githubActions) throw new Error("Missing interrupted handle");
  const completed = old.githubActions.completed;
  const oldPosts = f.requests.filter((r) => r.body?.ref === old.githubActions?.dispatch);
  expect(oldPosts).toHaveLength(
    ["after POST before response", "after run ID", "after completed"].includes(boundary) ? 1 : 0,
  );
  f.calls.length = 0;
  f.deps.push = push;
  f.deps.gh = async (...args) => {
    if (args[0][1]?.endsWith("/dispatches")) f.state.runStatus = "completed";
    return (await gh(...args)) ?? "";
  };
  // An intent persisted before POST has no run to discover, but cleanup still finishes.
  if (oldPosts.length === 0) f.state.visibleAfter = Infinity;
  f.state.logs.set(1, log());
  // Each reopen is a fresh daemon: a new executor over the serialized handle.
  const reopen = async () => {
    const executor = f.executor();
    const start = executor.start;
    let starts = 0;
    executor.start = async (...args) => {
      starts++;
      return start(...args);
    };
    const persisted = JSON.parse(JSON.stringify(f.saved.at(-1))) as ExecutionHandle;
    const result = await executeGate(req, signal(), {}, executor, persisted, f.persist).catch(
      (e: unknown) => e,
    );
    expect(starts).toBe(0);
    return result;
  };
  const resumed = await reopen();
  expect(f.dispatches()).toHaveLength(oldPosts.length);
  expect(f.saved.every((h) => h.id === old.id)).toBe(true);
  expect(f.calls).not.toContain("push");
  expect(f.calls).not.toContain("dispatch");
  if (completed) {
    expect(resumed).toEqual(completed);
    expect((resumed as GateRun).checks[0]?.exitCode).toBe(7);
  } else {
    expect(resumed).toBeInstanceOf(GateBlockedError);
    expect((resumed as GateBlockedError).classification).toBe("interrupted");
    expect(f.calls).toContain(`delete:${old.githubActions?.dispatch}:${old.githubActions?.dispatchSha}`);
    expect(f.calls).toContain(`delete:${old.githubActions?.candidate}:${req.headSha}`);
    if (oldPosts.length) expect(f.calls).toContain("cancel");
    expect(f.saved.at(-1)?.githubActions).toMatchObject({ interrupted: "interrupted" });
    expect(f.saved.at(-1)?.githubActions?.cleanupFailed).toBeUndefined();
    // Cleanup is confirmed, so a second reopen refuses without touching GitHub.
    f.calls.length = 0;
    f.requests.length = 0;
    expect(await reopen()).toBeInstanceOf(GateBlockedError);
    expect(f.requests).toEqual([]);
    expect(f.calls).toEqual([]);
  }
  expect(f.remote.size).toBe(0);
});

test("discovery uses head branch when the injected host clock is ahead of GitHub", async () => {
  const f = fixture();
  f.state.returnId = false;
  await f.run();
  const h = f.saved[0];
  const discovery = f.requests.find((r) => r.args[1]?.includes("workflow_dispatch"));
  expect(discovery?.args[1]).toContain(`branch=${encodeURIComponent(h?.githubActions?.dispatch ?? "")}`);
  expect(discovery?.args.join(" ")).not.toMatch(/created|title|since/);
  expect(f.calls.filter((c) => c === "dispatch")).toHaveLength(1);
});

test("discard waits for a dispatched run that is not visible yet, then cancels before deleting", async () => {
  const f = fixture();
  f.state.visibleAfter = 2;
  f.state.runStatus = "in_progress";
  const h = await f.stored({ dispatchSent: true });
  await f.executor().discard?.(h);
  expect(f.state.sleeps).toBe(4);
  expect(f.calls.slice(0, 6)).toEqual(["discover", "discover", "discover", "discover", "discover", "cancel"]);
  expect(f.calls.slice(6)).toEqual([
    `delete:${h.githubActions?.dispatch}:${"d".repeat(40)}`,
    `delete:${h.githubActions?.candidate}:${req.headSha}`,
  ]);
  expect(f.remote.size).toBe(0);
});

test.each(["completed", "active"])(
  "discard cancels every discovered run when the first stays %s",
  async (status) => {
    const f = fixture();
    const h = await f.stored({ dispatchIntent: true, runId: 17 });
    f.state.runStatus = "in_progress";
    let secondStatus = "in_progress";
    const gh = f.deps.gh;
    f.deps.gh = async (...args) => {
      const path = args[0][1] ?? "";
      if (status === "active" && path.endsWith("/runs/17/cancel")) {
        f.calls.push("cancel");
        return "null";
      }
      if (path.endsWith("/runs/18/cancel")) {
        f.calls.push("cancel:18");
        secondStatus = "completed";
        return "null";
      }
      if (path.endsWith("/runs/18")) return JSON.stringify({ id: 18, status: secondStatus });
      const raw = await gh(...args);
      if (path.includes("workflow_dispatch") && f.state.discoveries > 2)
        return JSON.stringify({ workflow_runs: [{ id: 18, status: secondStatus }] });
      return raw ?? "";
    };
    if (status === "active")
      await expect(f.executor().discard?.(h)).rejects.toThrow("termination unconfirmed");
    else await f.executor().discard?.(h);
    expect(f.calls.filter((c) => c.startsWith("cancel"))).toEqual(["cancel", "cancel:18"]);
    expect(h.githubActions?.cleanupRunIds).toEqual([17, 18]);
    expect(h.githubActions?.cleanupFailed).toBe(status === "active" ? true : undefined);
    expect(f.remote.size).toBe(status === "active" ? 2 : 0);
  },
);

test("undispatched discard deletes branches, respects moved branch leases and bounds invisible discovery", async () => {
  const f = fixture();
  const h = await f.stored();
  f.remote.set(h.githubActions?.candidate ?? "", "moved");
  await f.executor().discard?.(h);
  expect(f.calls.filter((c) => c.startsWith("delete:"))).toHaveLength(2);
  expect([...f.remote.values()]).toEqual(["moved"]);
  f.calls.length = 0;
  f.state.visibleAfter = Infinity;
  const pending = await f.stored({ dispatchSent: true });
  await f.executor().discard?.(pending);
  expect(f.state.sleeps).toBe(4);
  expect(f.calls.filter((c) => c.startsWith("delete:"))).toHaveLength(2);
  expect(f.remote.has(pending.githubActions?.dispatch ?? "")).toBe(false);
  expect(f.remote.has(pending.githubActions?.candidate ?? "")).toBe(false);
});

test("abort cancels a live run before deleting its two leased branches", async () => {
  const f = fixture();
  f.state.runStatus = "in_progress";
  f.state.jobs[0] = { id: 1, name: "gate-0", status: "in_progress", conclusion: "" };
  const controller = new AbortController();
  f.state.onSleep = () => controller.abort();
  await expect(f.run(controller.signal)).rejects.toThrow();
  expect(f.calls.indexOf("cancel")).toBeGreaterThan(f.calls.indexOf("dispatch"));
  expect(f.calls.slice(-3)).toEqual([
    "cancel",
    expect.stringContaining("/dispatch:"),
    expect.stringContaining("/candidate:"),
  ]);
  expect(f.remote.size).toBe(0);
});

test("a parsing error cancels the other live matrix job before rejecting", async () => {
  const f = fixture();
  req.gates.checks.push({ name: "pending", run: "pending" });
  f.state.runStatus = "in_progress";
  f.state.jobs.push({ id: 2, name: "gate-1", status: "in_progress", conclusion: "" });
  f.state.logs.set(1, log(framed(), `LIMITLESS:${token}:malformed`));
  await expect(f.run()).rejects.toThrow("Malformed gate record");
  expect(f.calls.slice(-3)).toEqual([
    "cancel",
    expect.stringContaining("/dispatch:"),
    expect.stringContaining("/candidate:"),
  ]);
});

test("duplicate matrix indices cannot replace a missing selected check", async () => {
  const f = fixture();
  req.gates.checks.push({ name: "missing", run: "missing" });
  f.state.jobs.push({ id: 2, name: "gate-0", status: "completed", conclusion: "success" });
  await expect(f.run()).rejects.toThrow("duplicate gate matrix index");
  expect(f.remote.size).toBe(0);
});

test.each(["cancelled", "skipped", "startup_failure", "missing-record"])(
  "%s job is unavailable evidence, never a gate result",
  async (conclusion) => {
    const f = fixture();
    req.gates.setup = [];
    f.state.jobs[0] = { id: 1, name: "gate-0", status: "completed", conclusion };
    f.state.logs.set(1, log("", "missing check record"));
    const error = await f.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateBlockedError);
    expect((error as GateBlockedError).classification).toBe("incomplete");
    expect(f.saved.at(-1)?.githubActions?.interrupted).toBe("incomplete");
    expect(f.saved.at(-1)?.githubActions?.completed).toBeUndefined();
    expect(f.dispatches()).toHaveLength(1);
    expect(f.remote.size).toBe(0);
  },
);

test("redaction covers a credential crossing the setup output tail boundary before any clipping", async () => {
  const f = fixture();
  const credential = "synthetic-boundary-credential-for-actions-output";
  registerCredential("ACTIONS_SETUP_BOUNDARY", credential);
  f.state.logs.set(
    1,
    log(
      `${framed()}\nsetup-only\n${credential}${"x".repeat(5980)}`,
      `assertion diagnostics\n(fail) check-only\n${framed(0, 1)}`,
    ),
  );
  const result = await f.run();
  // The factory-authored provenance label "github-actions" shares a window with the credential.
  const serialized = JSON.stringify(result, (key, value) => (key === "executor" ? undefined : value));
  for (let i = 0; i + 8 <= credential.length; i++)
    expect(serialized).not.toContain(credential.slice(i, i + 8));
  expect(result.checks[0]?.output).not.toContain("setup-only");
  expect(result.checks[0]?.output).not.toContain("checkout-only");
  expect(result.checks[0]?.failures).toContain("assertion diagnostics\n(fail) check-only");
});

test("run and job polls send conditional requests and accept unchanged responses", async () => {
  const f = fixture();
  f.state.runStatus = "in_progress";
  f.state.onSleep = () => {
    if (f.state.sleeps === 2) f.state.runStatus = "completed";
  };
  await f.run();
  const conditional = f.requests.filter((r) => r.args.some((a) => a.startsWith("If-None-Match:")));
  expect(conditional.some((r) => r.args[1]?.endsWith("runs/17"))).toBe(true);
  expect(conditional.some((r) => r.args[1]?.includes("/jobs?"))).toBe(true);
});

test("CI configuration changes are refused locally before gh or push", async () => {
  const f = fixture();
  mkdirSync(join(cwd, ".github/workflows"), { recursive: true });
  writeFileSync(join(cwd, ".github/workflows/x.yml"), "name: untrusted\n");
  await sh(["git", "add", "."], { cwd });
  await sh(["git", "commit", "-qm", "workflow candidate"], { cwd });
  req.headSha = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
  await expect(f.executor().start(req, signal())).rejects.toThrow(".github/workflows/x.yml");
  expect(f.requests).toEqual([]);
  expect(f.calls).toEqual([]);
});

async function context(f: ReturnType<typeof fixture>, controller = new AbortController()) {
  const store = new Store(join(cwd, "state.db"));
  const cfg = loadConfig({ home: join(cwd, "data"), configDir: join(cwd, "config") });
  const repo = store.upsertRepo({
    slug: req.repo,
    kind: "github",
    url: "https://github.com/test/repo.git",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = store.createRun(repo, { repo: req.repo, prompt: "gates" });
  const deps = { store, cfg, gateExecutor: f.executor() } as EngineDeps;
  const ctx = new RunContext(deps, { ...run, baseSha: req.baseSha }, repo, controller.signal);
  const push = f.deps.push;
  f.deps.push = async (p, url) => {
    const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle;
    if (durable) f.saved.push(durable);
    await push(p, url);
  };
  return { ctx, store };
}

test.each(["sha", "stage", "round", "purpose"])(
  "mismatched %s cleans up the interrupted run and stays blocked",
  async (mismatch) => {
    const f = fixture();
    const { ctx, store } = await context(f);
    try {
      const handle = await f.stored({ dispatchSent: true, runId: 17 });
      ctx.state.gateExecution = {
        handle,
        sha: mismatch === "sha" ? "old" : req.headSha,
        stage: mismatch === "stage" ? "prepare" : "gates",
        round: mismatch === "round" ? 2 : 0,
        purpose: mismatch === "purpose" ? "baseline" : "initial",
      };
      await ctx.save();
      f.state.runStatus = "in_progress";
      for (let attempt = 0; attempt < 2; attempt++) {
        const restarted = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
        const error = await runGateExecution(restarted, "gates", "initial", cwd, req.gates).catch(
          (e: unknown) => e,
        );
        expect((error as GateBlockedError).classification).toBe("interrupted");
      }
      expect(f.calls.filter((c) => c !== "discover")).toEqual([
        "cancel",
        expect.stringContaining("/dispatch:"),
        expect.stringContaining("/candidate:"),
      ]);
      const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution;
      expect(durable?.handle.id).toBe(handle.id);
      expect(durable?.handle.githubActions).toMatchObject({ interrupted: "interrupted", runId: 17 });
      expect(f.remote.size).toBe(0);
    } finally {
      store.close();
    }
  },
);

test("daemon shutdown preserves progress for cleanup, then restart stays blocked", async () => {
  const f = fixture();
  const controller = new AbortController();
  const { ctx, store } = await context(f, controller);
  try {
    f.state.runStatus = "in_progress";
    f.state.onSleep = () => controller.abort(new Error("shutdown"));
    const push = f.deps.push;
    f.deps.push = async (p, url) => {
      const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle;
      if (durable) f.saved.push(durable);
      await push(p, url);
    };
    await expect(runGateExecution(ctx, "gates", "initial", cwd, req.gates)).rejects.toThrow("shutdown");
    expect(f.calls).toEqual(["push", "dispatch"]);
    expect(f.remote.size).toBe(2);
    const stored = store.getRunState<RunState>(ctx.run.id)?.gateExecution;
    expect(stored?.handle.githubActions).toMatchObject({ pushed: true, dispatchSent: true, runId: 17 });
    f.state.runStatus = "completed";
    const restarted = new RunContext(
      { ...ctx.deps, gateExecutor: f.executor() },
      ctx.run,
      ctx.repo,
      signal(),
    );
    await expect(runGateExecution(restarted, "gates", "initial", cwd, req.gates)).rejects.toThrow(
      "(interrupted)",
    );
    expect(f.calls.filter((c) => c === "dispatch")).toHaveLength(1);
    expect(f.calls.filter((c) => c === "push")).toHaveLength(1);
    expect(f.remote.size).toBe(0);
    expect(store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle.githubActions?.interrupted).toBe(
      "interrupted",
    );
  } finally {
    store.close();
  }
});

test("workflow isolates dispatch caches and command budgets, with pinned actions and env-only inputs", () => {
  const text = readFileSync(new URL("../.github/workflows/limitless-gates.yml", import.meta.url), "utf8");
  const workflow = Bun.YAML.parse(text) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        if: string;
        name: string;
        "runs-on": string;
        "timeout-minutes"?: unknown;
        strategy: { matrix: { check: string } };
        steps: {
          name: string;
          uses?: string;
          with?: Record<string, unknown>;
          env?: Record<string, string>;
          run?: string;
          shell?: string;
          "working-directory"?: string;
          "timeout-minutes"?: unknown;
        }[];
      }
    >;
  };
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(text).not.toContain("secrets.");
  const job = workflow.jobs.gate;
  if (!job) throw new Error("missing gate job");
  expect(job["runs-on"]).toBe("ubuntu-24.04");
  expect(job.if).toContain("github.ref !=");
  expect(job.if).toContain("github.event.repository.default_branch");
  expect(job.name).toContain("matrix.check.index");
  expect(job.strategy.matrix.check).toContain("inputs.checks");
  expect(job["timeout-minutes"]).toBeUndefined();
  for (const step of job.steps) {
    if (step.uses) expect(step.uses).toMatch(/@[a-f\d]{40}$/);
    expect(step.run ?? "").not.toMatch(/\$\{\{\s*(?:inputs|matrix)\./);
  }
  const checkout = job.steps.find((s) => s.name === "Checkout");
  expect(checkout?.with?.["persist-credentials"]).toBe(false);
  expect(job.steps.find((s) => s.name === "Bun")?.with?.["no-cache"]).toBe(true);
  expect(job.steps.findIndex((s) => s.name === "Token")).toBeLessThan(
    job.steps.findIndex((s) => s.name === "Checkout"),
  );
  expect(job.steps.find((s) => s.name === "Setup")?.["timeout-minutes"]).toContain("inputs.setup_minutes");
  const check = job.steps.find((s) => s.name === "Check");
  expect(check?.["timeout-minutes"]).toContain("matrix.check.minutes");
  expect(check?.env?.LIMITLESS_GATE_REPORT).toContain("runner.temp");
  // Trusted steps finish before candidate code; candidate commands then run as an unprivileged user.
  const order = ["Token", "Bun", "Checkout", "Isolate", "Setup", "Check"];
  expect(job.steps.map((s) => s.name).filter((name) => order.includes(name))).toEqual(order);
  for (const name of ["Setup", "Check"]) {
    const step = job.steps.find((s) => s.name === name);
    expect(step?.shell).toStartWith("/bin/bash ");
    expect(step?.["working-directory"]).toContain("runner.temp");
    expect(step?.run).toBe('"$TRUSTED/bun" "$TRUSTED/supervise.mjs"');
    expect(JSON.parse(step?.env?.GATE ?? "[]")).toEqual([
      "/usr/bin/sudo",
      "-n",
      "-u",
      "limitless-gate",
      "--",
    ]);
  }
  expect(job.steps.find((s) => s.name === "Isolate")?.run).toContain("useradd");
});

test.each(["missing", "unexpected"])("%s matrix job is an error", async (kind) => {
  const f = fixture();
  if (kind === "missing") f.state.jobs = [];
  else f.state.jobs[0] = { id: 1, name: "other", status: "completed", conclusion: "success" };
  await expect(f.run()).rejects.toThrow(kind === "missing" ? "Missing gate matrix job" : "Unexpected");
  expect(f.remote.size).toBe(0);
});

test("incomplete setup in any matrix job rejects even beside a recorded setup failure", async () => {
  const f = fixture();
  req.gates.checks.push({ name: "second", run: "second" });
  f.state.jobs = [
    { id: 2, name: "gate-1", status: "completed", conclusion: "failure" },
    { id: 1, name: "gate-0", status: "completed", conclusion: "failure" },
  ];
  f.state.logs.set(2, log(framed(0, 7), ""));
  f.state.logs.set(1, log("missing setup record", ""));
  const error = await f.run().catch((e: unknown) => e);
  expect((error as GateBlockedError).classification).toBe("incomplete");
  expect(f.dispatches()).toHaveLength(1);
});

test("a check step timeout backstop without a record is unavailable evidence, not a result", async () => {
  const f = fixture();
  f.state.jobs[0] = { id: 1, name: "gate-0", status: "completed", conclusion: "timed_out" };
  f.state.logs.set(1, log(framed(), "check did not write its final record"));
  const error = await f.run().catch((e: unknown) => e);
  expect((error as GateBlockedError).classification).toBe("incomplete");
  // A supervisor-recorded timeout remains an ordinary failing result.
  const recorded = fixture();
  recorded.state.jobs[0] = { id: 1, name: "gate-0", status: "completed", conclusion: "timed_out" };
  recorded.state.logs.set(1, log(framed(), framed(0, 137, 345, true)));
  expect((await recorded.run()).checks[0]).toMatchObject({
    ok: false,
    timedOut: true,
    incomplete: undefined,
  });
});

type Step = { name: string; run?: string; shell?: string };
function workflowStep(name: string) {
  const workflow = Bun.YAML.parse(
    readFileSync(new URL("../.github/workflows/limitless-gates.yml", import.meta.url), "utf8"),
  ) as { jobs: { gate: { steps: Step[] } } };
  const step = workflow.jobs.gate.steps.find((s) => s.name === name);
  if (!step?.run || !step.shell) throw new Error(`missing ${name} script`);
  return { run: step.run, shell: step.shell };
}
/** Runs a step the way the runner would; tests replace Isolate's limitless-gate user with the current one. */
async function runStep(name: string, env: Record<string, string>) {
  const step = workflowStep(name);
  const [shell = "", ...args] = step.shell.replace(" {0}", "").split(" ");
  const trusted = join(cwd, "temp/limitless");
  return await sh([shell, ...args, "-c", step.run], {
    cwd: existsSync(trusted) ? trusted : cwd,
    env: { PATH: process.env.PATH ?? "", TRUSTED: trusted, ...env },
    allowFail: true,
  });
}
async function supervisor() {
  mkdirSync(join(cwd, "temp"));
  const generated = await runStep("Token", {});
  const frame = generated.stdout.match(/^LIMITLESS_TOKEN ([a-f\d]{32})$/m)?.[1];
  if (!frame) throw new Error("missing generated token");
  const trusted = join(cwd, "temp/limitless");
  symlinkSync(process.execPath, join(trusted, "bun"));
  const work = join(cwd, "work");
  mkdirSync(work);
  const supervise = (name: "Setup" | "Check", commands: unknown[], env: Record<string, string> = {}) =>
    runStep(name, {
      COMMANDS: JSON.stringify(commands),
      GATE: "[]",
      GATE_HOME: cwd,
      GATE_CWD: work,
      GITHUB_PATH: join(cwd, "temp/github-path"),
      ...env,
    });
  return { frame, trusted, work, supervise };
}

test("the supervisor keeps its token from candidates and records failures, setup stops and timeouts", async () => {
  const { frame, supervise } = await supervisor();
  const commands = [{ run: "env; exit 9" }, { run: "echo should-not-run" }];
  const failed = await supervise("Setup", commands);
  expect(failed.exitCode).toBe(1);
  expect(failed.stdout).toContain("CI=true");
  expect(failed.stdout.match(new RegExp(frame, "g"))).toHaveLength(1);
  expect(failed.stdout).not.toMatch(/TRUSTED|GITHUB_PATH|COMMANDS/);
  expect(failed.stdout).toMatch(new RegExp(`^LIMITLESS:${frame}:0:9:\\d+:false$`, "m"));
  expect(failed.stdout).not.toContain("should-not-run");
  const timed = await supervise("Check", [{ run: "sleep 10", timeoutSec: 0.01 }]);
  expect(timed.exitCode).toBe(1);
  expect(timed.stdout).toMatch(new RegExp(`^LIMITLESS:${frame}:0:137:\\d+:true$`, "m"));
});

test("setup that installs fake interpreters through GITHUB_PATH cannot forge the check's record", async () => {
  const { frame, trusted, supervise } = await supervisor();
  // Same-user tests can reach the trusted paths; on the runner, limitless-gate cannot.
  const fake = `printf '#!/bin/sh\\nprintf "LIMITLESS:%s:0:0:1:false\\\\n" "$(cat ${trusted}/frame)"\\n'`;
  const install = [
    "mkdir fake",
    `for bin in python3 bun bash sh env sudo; do ${fake} > fake/$bin; chmod +x fake/$bin; done`,
    `echo "$PWD/fake" >> ${join(cwd, "temp/github-path")}`,
  ].join(" && ");
  const setup = await supervise("Setup", [{ run: install }]);
  expect(setup.stdout).toMatch(new RegExp(`^LIMITLESS:${frame}:0:0:\\d+:false$`, "m"));
  const added = readFileSync(join(cwd, "temp/github-path"), "utf8").trim();
  expect(readFileSync(join(added, "python3"), "utf8")).toContain("LIMITLESS:");
  const check = await supervise("Check", [{ run: "exit 9" }], { PATH: `${added}:${process.env.PATH}` });
  expect(check.exitCode).toBe(1);
  expect(check.stdout).not.toContain(`LIMITLESS:${frame}:0:0:`);
  expect(check.stdout).toMatch(new RegExp(`^LIMITLESS:${frame}:0:9:\\d+:false$`, "m"));
});

test("candidate Bun configuration in its checkout does not reach the supervisor", async () => {
  const { frame, work, supervise } = await supervisor();
  writeFileSync(join(work, "bunfig.toml"), 'preload = ["./forge.ts"]\n');
  writeFileSync(join(work, "forge.ts"), `console.log("LIMITLESS:${frame}:0:0:1:false"); process.exit(0);\n`);
  writeFileSync(join(work, ".env"), 'COMMANDS=[{"run":"exit 0"}]\n');
  const result = await supervise("Check", [{ run: "exit 9" }]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).not.toContain(`LIMITLESS:${frame}:0:0:`);
  expect(result.stdout).toMatch(new RegExp(`^LIMITLESS:${frame}:0:9:\\d+:false$`, "m"));
});

test("records start on their own line when command output lacks a trailing newline", async () => {
  const { frame, supervise } = await supervisor();
  const setup = await supervise("Setup", [{ run: "printf setup-output" }]);
  const check = await supervise("Check", [{ run: "printf check-output" }]);
  const f = fixture();
  const text = log(setup.stdout.trimEnd(), check.stdout.trimEnd());
  f.state.logs.set(1, text.replace(`LIMITLESS_TOKEN ${token}`, `LIMITLESS_TOKEN ${frame}`));
  const run = await f.run();
  expect(run.setupOk).toBe(true);
  expect(run.setup[0]).toMatchObject({ ok: true, exitCode: 0 });
  expect(run.checks[0]).toMatchObject({ ok: true, exitCode: 0, incomplete: undefined });
  expect(run.checks[0]?.output).toContain("check-output");
});

test("review regression: failed cancellation preserves branches for cleanup retry", async () => {
  const f = fixture();
  f.state.runStatus = "in_progress";
  const h = await f.stored({ dispatchSent: true, runId: 17 });
  const gh = f.deps.gh;
  f.deps.gh = async (...args) => {
    if (args[0][1]?.endsWith("/cancel")) {
      f.calls.push("cancel-failed");
      throw new Error("cancel unavailable");
    }
    return (await gh(...args)) ?? "";
  };
  await expect(f.executor().discard?.(h)).rejects.toThrow("cancel unavailable");
  expect(f.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
  expect(f.remote.size).toBe(2);
});

test("failed cleanup keeps the durable handle so a restart retries it", async () => {
  const f = fixture();
  const { ctx, store } = await context(f);
  try {
    const remove = f.deps.delete;
    let failing = true;
    const push = f.deps.push;
    f.deps.push = async (p, url) => {
      const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle;
      if (durable) f.saved.push(durable);
      await push(p, url);
    };
    f.deps.delete = async (p, branch, sha, url) => {
      if (failing && branch === p.dispatch) throw new Error("lease rejected");
      await remove(p, branch, sha, url);
    };
    await expect(runGateExecution(ctx, "gates", "initial", cwd, req.gates)).rejects.toThrow("lease rejected");
    expect(f.calls.at(-1)).toContain("/candidate:");
    const stored = store.getRunState<RunState>(ctx.run.id)?.gateExecution;
    expect(stored?.handle.githubActions).toMatchObject({
      dispatchSent: true,
      runId: 17,
      cleanupFailed: true,
    });
    expect(f.remote.size).toBe(1);
    failing = false;
    const restarted = new RunContext(
      { ...ctx.deps, gateExecutor: f.executor() },
      ctx.run,
      ctx.repo,
      signal(),
    );
    const run = await runGateExecution(restarted, "gates", "initial", cwd, req.gates);
    expect(run.checks[0]?.ok).toBe(true);
    expect(f.calls.filter((c) => c === "dispatch")).toHaveLength(1);
    expect(f.remote.size).toBe(0);
    expect(store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle.githubActions?.completed).toEqual(
      run,
    );
  } finally {
    store.close();
  }
});

test.each(["malformed evidence", "protected diagnostic"])(
  "original rejection survives cleanup failure and restart: %s",
  async (failure) => {
    const f = fixture();
    const { ctx, store } = await context(f);
    registerCredential("ACTIONS_REJECTION_TEST", credential);
    f.state.logs.set(1, log(framed(), `near ${secret} ${credential}\nLIMITLESS:${token}:bad`));
    const gh = f.deps.gh;
    if (failure === "protected diagnostic")
      f.deps.gh = async (...args) => {
        if (args[0][0] === "run") throw new Error(`Malformed gate record near ${secret} ${credential}`);
        return (await gh(...args)) ?? "";
      };
    const remove = f.deps.delete;
    let failing = true;
    f.deps.delete = async (p, branch, sha, url) => {
      if (failing && branch === p.dispatch) throw new Error(`lease rejected ${secret} ${credential}`);
      await remove(p, branch, sha, url);
    };
    try {
      await withPrivateString(async () => {
        const first = await runGateExecution(ctx, "gates", "initial", cwd, req.gates).catch(
          (e: unknown) => e,
        );
        expect(first).toBeInstanceOf(GateBlockedError);
        if (!(first instanceof GateBlockedError)) throw new Error("Expected blocked execution");
        expect(first.classification).toBe("operational");
        expect(first.message).toContain("Malformed gate record");
        expect(first.message).not.toContain("lease rejected");
        const pending = store.getRunState<RunState>(ctx.run.id)?.gateExecution;
        expect(pending?.handle.githubActions).toMatchObject({
          cleanupFailed: true,
          interrupted: "operational",
          diagnostic: first.message,
        });
        // Reopen while cleanup still fails, then revoke admission and finish cleanup only.
        for (const cleanupFails of [true, false, false]) {
          failing = cleanupFails;
          f.settings.githubActions = false;
          const restarted = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
          const error = await runGateExecution(restarted, "gates", "initial", cwd, req.gates).catch(
            (e: unknown) => e,
          );
          expect(error).toBeInstanceOf(GateBlockedError);
          if (!(error instanceof GateBlockedError)) throw new Error("Expected blocked restart");
          expect(error.classification).toBe("operational");
          expect(error.message).toContain(first.message);
          const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution;
          expect(durable?.handle.id).toBe(pending?.handle.id);
          expect(durable?.handle.githubActions?.diagnostic).toBe(first.message);
          expect(!!durable?.handle.githubActions?.cleanupFailed).toBe(cleanupFails);
          expect(durable?.handle.githubActions?.completed).toBeUndefined();
          expect(durable?.previous ?? []).toEqual([]);
          expect(JSON.stringify([durable, String(error), store.listEvents(ctx.run.id)])).not.toContain(
            secret,
          );
          expect(JSON.stringify([durable, String(error)])).not.toContain(credential);
        }
        expect(published(f)).toEqual({ pushes: 1, dispatches: 1 });
        expect(f.remote.size).toBe(0);
      });
    } finally {
      store.close();
    }
  },
);

test.each(["visible", "never visible"])(
  "lost POST response: %s run uses one POST and bounded discovery",
  async (visibility) => {
    const f = fixture();
    f.state.visibleAfter = visibility === "visible" ? 2 : Infinity;
    const gh = f.deps.gh;
    f.deps.gh = async (...args) => {
      const response = await gh(...args);
      if (args[0][1]?.endsWith("/dispatches")) throw new Error("response lost");
      return response ?? "";
    };
    const result = await f.run().catch((error: unknown) => error);
    expect(f.calls.filter((c) => c === "dispatch")).toHaveLength(1);
    if (visibility === "visible") {
      expect(result).toMatchObject({ checks: [{ ok: true }] });
      expect(f.requests.some((r) => r.args.includes("--include") && r.args[1]?.endsWith("/runs/17"))).toBe(
        true,
      );
    } else {
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toContain("Dispatch unconfirmed");
      expect(f.state.delays.reduce((a, b) => a + b, 0)).toBe(40);
    }
    expect(f.calls.filter((c) => c.startsWith("delete:"))).toHaveLength(2);
    expect(f.remote.size).toBe(0);
    expect(f.saved.at(-1)?.githubActions?.cleanupFailed).toBeUndefined();
  },
);

test("review regression: completion survives restart before the caller saves gate results", async () => {
  const f = fixture();
  const { ctx, store } = await context(f);
  try {
    const result = await runGateExecution(ctx, "gates", "initial", cwd, req.gates);
    const restarted = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
    expect(await runGateExecution(restarted, "gates", "initial", cwd, req.gates)).toEqual(result);
    expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(1);
    expect(store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle.githubActions?.completed).toEqual(
      result,
    );
    restarted.state.phase = "loop";
    restarted.state.worktreePath = cwd;
    const comparisons = compareGates(null, result);
    await restarted.stage("gates", async () => {
      restarted.state.lastGates = comparisons;
      return { summary: "pass", value: comparisons };
    });
    const consumed = store.getRunState<RunState>(ctx.run.id);
    expect(consumed?.gateExecution).toBeUndefined();
    expect(consumed?.lastGates?.[0]?.result.ok).toBe(true);
    expect(consumed?.completedChecks?.values.gates).toEqual(comparisons);
  } finally {
    store.close();
  }
});

test.each(["stage", "round", "purpose"])(
  "completed result cannot satisfy a different %s",
  async (mismatch) => {
    const f = fixture();
    const { ctx, store } = await context(f);
    try {
      await runGateExecution(ctx, "gates", "initial", cwd, req.gates);
      const pending = ctx.state.gateExecution;
      if (!pending) throw new Error("Missing completed identity");
      if (mismatch === "stage") pending.stage = "prepare";
      if (mismatch === "round") pending.round++;
      if (mismatch === "purpose") pending.purpose = "baseline";
      await ctx.save();
      const restarted = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
      await runGateExecution(restarted, "gates", "initial", cwd, req.gates);
      expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(2);
    } finally {
      store.close();
    }
  },
);

test.each(["sha", "configuration", "configuration after failed cleanup"])(
  "a completed result with a changed %s stays blocked through the pipeline",
  async (change) => {
    const f = fixture();
    const { ctx, store } = await context(f);
    try {
      const remove = f.deps.delete;
      let failing = change.endsWith("failed cleanup");
      f.deps.delete = async (p, branch, sha, url) => {
        if (failing && branch === p.dispatch) throw new Error("lease rejected");
        await remove(p, branch, sha, url);
      };
      const first = runGateExecution(ctx, "gates", "initial", cwd, req.gates);
      if (failing) await expect(first).rejects.toThrow("lease rejected");
      else await first;
      // Cleanup can now finish, yet the changed configuration must not replace the work.
      failing = false;
      const pending = ctx.state.gateExecution;
      if (!pending?.handle.githubActions?.completed) throw new Error("Missing completed identity");
      if (change === "sha") pending.sha = "old";
      await ctx.save();
      const gates = change === "sha" ? req.gates : { ...req.gates, setup: ["other install"] };
      for (const attempt of [1, 2]) {
        const restarted = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
        const error = await runGateExecution(restarted, "gates", "initial", cwd, gates).catch((e) => e);
        expect(error, `attempt ${attempt}`).toBeInstanceOf(GateBlockedError);
      }
      expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(1);
      expect(f.calls.filter((call) => call === "push")).toHaveLength(1);
      const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution;
      expect(durable?.handle.id).toBe(pending.handle.id);
      expect(durable?.handle.githubActions?.interrupted).toBe("interrupted");
      expect(durable?.handle.githubActions?.cleanupFailed).toBeUndefined();
      expect(f.remote.size).toBe(0);
    } finally {
      store.close();
    }
  },
);

test.each(["active", "cancel error", "confirmation error"])(
  "cancellation remains pending after %s, then restart confirms termination and stays blocked",
  async (failure) => {
    const f = fixture();
    const { ctx, store } = await context(f);
    try {
      const h = await f.stored({ dispatchSent: true, runId: 17 });
      // A mismatch must finish cleanup before starting replacement work.
      ctx.state.gateExecution = { handle: h, sha: "old", stage: "gates", round: 0, purpose: "initial" };
      await ctx.save();
      f.state.runStatus = "in_progress";
      const gh = f.deps.gh;
      let cancelled = false;
      f.deps.gh = async (...args) => {
        if (args[0][1]?.endsWith("/cancel")) {
          f.calls.push("cancel");
          cancelled = true;
          if (failure === "cancel error") throw new Error("cancel unavailable");
          return "null";
        }
        if (failure === "confirmation error" && cancelled && f.state.runStatus === "in_progress")
          throw new Error("confirmation unavailable");
        return (await gh(...args)) ?? "";
      };
      await expect(runGateExecution(ctx, "gates", "initial", cwd, req.gates)).rejects.toThrow(
        failure === "active" ? "termination unconfirmed" : "unavailable",
      );
      expect(f.calls).not.toContain("dispatch");
      expect(f.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
      expect(
        store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle.githubActions?.cleanupFailed,
      ).toBe(true);
      f.state.runStatus = "completed";
      const restarted = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
      await expect(runGateExecution(restarted, "gates", "initial", cwd, req.gates)).rejects.toThrow(
        "(interrupted)",
      );
      expect(f.calls.filter((call) => call.startsWith("delete:"))).toHaveLength(2);
      expect(f.calls).not.toContain("dispatch");
      expect(f.remote.size).toBe(0);
      const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle;
      expect(durable?.id).toBe(h.id);
      expect(durable?.githubActions?.cleanupFailed).toBeUndefined();
    } finally {
      store.close();
    }
  },
);

test("restart cleanup failure retains the old handle without persisting a replacement", async () => {
  const f = fixture();
  const { ctx, store } = await context(f);
  try {
    const h = await f.stored({ dispatchIntent: true });
    ctx.state.gateExecution = { handle: h, sha: req.headSha, stage: "gates", round: 0, purpose: "initial" };
    await ctx.save();
    f.state.runStatus = "in_progress";
    const gh = f.deps.gh;
    f.deps.gh = async (...args) => {
      if (args[0][1]?.endsWith("/cancel")) throw new Error("cancel unavailable");
      return (await gh(...args)) ?? "";
    };
    const restarted = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
    await expect(runGateExecution(restarted, "gates", "initial", cwd, req.gates)).rejects.toThrow(
      "cancel unavailable",
    );
    const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle;
    expect(durable?.id).toBe(h.id);
    expect(durable?.githubActions?.cleanupFailed).toBe(true);
    expect(f.saved.every((saved) => saved.id === h.id)).toBe(true);
    expect(f.calls).not.toContain("push");
    expect(f.calls).not.toContain("dispatch");
    expect(f.remote.size).toBe(2);
  } finally {
    store.close();
  }
});

test.each(["run", "jobs"])(
  "review regression: a temporary %s poll rate limit does not cancel the gate",
  async (kind) => {
    const f = fixture();
    f.state.runStatus = "in_progress";
    let limited = false;
    const gh = f.deps.gh;
    f.deps.gh = async (...args) => {
      if (!limited && args[0].includes("--include") && (kind === "run" || args[0][1]?.includes("/jobs?"))) {
        limited = true;
        throw new Error("HTTP 429: secondary rate limit; Retry-After: 1");
      }
      return (await gh(...args)) ?? "";
    };
    f.state.onSleep = () => {
      f.state.runStatus = "completed";
    };
    await expect(f.run()).resolves.toMatchObject({ setupOk: true });
    expect(f.state.delays).toEqual(kind === "run" ? [1_000] : [1_000, 10]);
    expect(f.calls).not.toContain("cancel");
    expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(1);
  },
);

test.each(["reset", "date", "fallback"])(
  "secondary rate limits honour %s timing and retain ETags",
  async (timing) => {
    const f = fixture();
    f.state.runStatus = "in_progress";
    const gh = f.deps.gh;
    let limited = false;
    f.deps.gh = async (...args) => {
      if (!limited && args[0].some((arg) => arg.startsWith("If-None-Match:"))) {
        limited = true;
        const headers =
          timing === "reset"
            ? `X-RateLimit-Reset: ${(f.deps.now() + 1_990) / 1_000}`
            : timing === "date"
              ? `Retry-After: ${new Date(f.deps.now() + 1_990).toUTCString()}`
              : "";
        return `HTTP/2.0 403 Forbidden\r\n${headers}\r\n\r\n{"message":"secondary rate limit"}`;
      }
      return (await gh(...args)) ?? "";
    };
    f.state.onSleep = () => {
      if (limited) f.state.runStatus = "completed";
    };
    await f.run();
    expect(f.state.delays).toEqual([10, timing === "fallback" ? 1_000 : 1_990]);
    expect(f.calls).not.toContain("cancel");
    expect(
      f.requests.filter((r) => r.args.some((a) => a.startsWith("If-None-Match:"))).length,
    ).toBeGreaterThan(1);
  },
);

test.each(["run", "jobs"])("structured gh %s errors retain rate-limit timing headers", async (kind) => {
  const f = fixture();
  f.state.runStatus = "in_progress";
  const gh = f.deps.gh;
  let limited = false;
  f.deps.gh = async (...args) => {
    if (
      !limited &&
      args[0].some((arg) => arg.startsWith("If-None-Match:")) &&
      (kind === "run" || args[0][1]?.includes("/jobs?"))
    ) {
      limited = true;
      throw new CommandError(
        "gh api failed",
        1,
        `HTTP/2.0 ${kind === "run" ? "429 Too Many Requests\r\nRetry-After: 5" : `403 Forbidden\r\nX-RateLimit-Reset: ${(f.deps.now() + 4_990) / 1_000}`}\r\n\r\n`,
        kind === "run" ? "gh: request failed" : "gh: secondary rate limit",
        false,
      );
    }
    return (await gh(...args)) ?? "";
  };
  f.state.onSleep = () => {
    if (limited) f.state.runStatus = "completed";
  };
  await expect(f.run()).resolves.toMatchObject({ setupOk: true });
  expect(f.state.delays).toEqual(kind === "run" ? [10, 5_000] : [10, 4_990, 10]);
  expect(f.calls).not.toContain("cancel");
  expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(1);
  expect(
    f.requests.filter((r) => r.args.some((arg) => arg.startsWith("If-None-Match:"))).length,
  ).toBeGreaterThan(1);
});

test("rate-limit waits exhaust the execution deadline without redispatching", async () => {
  const f = fixture();
  req.gates.setup = [];
  req.gates.checks[0] = { name: "test", run: "test", timeoutSec: 3 };
  f.state.runStatus = "in_progress";
  const gh = f.deps.gh;
  f.deps.gh = async (...args) => {
    if (args[0].includes("--include")) throw new Error("HTTP 429; Retry-After: 2");
    return (await gh(...args)) ?? "";
  };
  await expect(f.run()).rejects.toThrow("execution deadline");
  expect(f.state.delays).toEqual([2_000, 1_000]);
  expect(f.calls).toContain("cancel");
  expect(f.calls.filter((c) => c === "dispatch")).toHaveLength(1);
  expect(f.remote.size).toBe(0);
});

test.each(["no quota headers", "remaining quota", "invalid reset"])(
  "ordinary authorization errors with %s do not retry polls",
  async (kind) => {
    const f = fixture();
    f.state.runStatus = "in_progress";
    const gh = f.deps.gh;
    f.deps.gh = async (...args) => {
      if (args[0].includes("--include")) {
        const headers =
          kind === "remaining quota"
            ? `X-RateLimit-Remaining: 1\r\nX-RateLimit-Reset: ${(f.deps.now() + 60_000) / 1_000}`
            : kind === "invalid reset"
              ? "X-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: invalid"
              : "";
        return `HTTP/2.0 403 Forbidden\r\n${headers}\r\n\r\nResource not accessible`;
      }
      return (await gh(...args)) ?? "";
    };
    await expect(f.run()).rejects.toThrow("Resource not accessible");
    expect(f.state.delays).toEqual([10, 10, 10, 10]);
    expect(f.calls).toContain("cancel");
  },
);

test.each(["shutdown", "cancel"])("%s interrupts a pending rate-limit wait", async (reason) => {
  const f = fixture();
  f.state.runStatus = "in_progress";
  const sleeping = Promise.withResolvers<void>();
  const sleep = f.deps.sleep;
  f.deps.sleep = async () => {
    sleeping.resolve();
    await new Promise<void>(() => {});
  };
  const gh = f.deps.gh;
  f.deps.gh = async (...args) => {
    if (args[0].includes("--include")) throw new Error("HTTP 429; Retry-After: 60");
    return (await gh(...args)) ?? "";
  };
  const controller = new AbortController();
  const run = f.run(controller.signal);
  await sleeping.promise;
  f.deps.sleep = sleep;
  controller.abort(new Error(reason));
  await expect(run).rejects.toThrow(reason);
  expect(f.calls.includes("cancel")).toBe(reason !== "shutdown");
  expect(f.remote.size).toBe(reason === "shutdown" ? 2 : 0);
});

test.each(["absent", "wrong kind"])(
  "mismatched handle retains cleanup identity with %s owner",
  async (owner) => {
    const f = fixture();
    const { ctx, store } = await context(f);
    try {
      const h = await f.stored({ dispatchSent: true, runId: 17 });
      ctx.state.gateExecution = { handle: h, sha: "old", stage: "gates", round: 0, purpose: "initial" };
      await ctx.save();
      const unavailable = new RunContext(
        { ...ctx.deps, gateExecutor: owner === "absent" ? undefined : localExecutor() },
        ctx.run,
        ctx.repo,
        signal(),
      );
      await expect(runGateExecution(unavailable, "gates", "initial", cwd, req.gates)).rejects.toThrow(
        "Unavailable gate executor: github-actions",
      );
      expect(store.getRunState<RunState>(ctx.run.id)?.gateExecution).toEqual(ctx.state.gateExecution);
      expect([...f.remote.keys()]).toEqual([
        h.githubActions?.dispatch ?? "",
        h.githubActions?.candidate ?? "",
      ]);
      expect(f.calls).toEqual([]);
      f.state.runStatus = "in_progress";
      const gh = f.deps.gh;
      f.deps.gh = async (...args) => {
        const raw = await gh(...args);
        if (args[0][1]?.endsWith("/runs/17") && f.state.runStatus === "completed")
          f.calls.push("termination-confirmed");
        return raw ?? "";
      };
      await expect(
        runGateExecution(
          new RunContext(ctx.deps, ctx.run, ctx.repo, signal()),
          "gates",
          "initial",
          cwd,
          req.gates,
        ),
      ).rejects.toThrow("(interrupted)");
      const deletion = f.calls.findIndex((call) => call.startsWith("delete:"));
      expect(f.calls.indexOf("cancel")).toBeLessThan(f.calls.indexOf("termination-confirmed"));
      expect(f.calls.indexOf("termination-confirmed")).toBeLessThan(deletion);
      expect(f.calls).not.toContain("dispatch");
      expect(f.remote.size).toBe(0);
    } finally {
      store.close();
    }
  },
);

test.each([
  "timeout",
  "regression-retry",
  "baseline-retry",
  "regression-retry-targeted",
  "baseline-retry-targeted",
])("%s completion replays caller progress and retains retry evidence across restart", async (purpose) => {
  const f = fixture();
  const { ctx, store } = await context(f);
  const stage = purpose.startsWith("baseline") ? "prepare" : "gates";
  const initialPurpose = stage === "prepare" ? "baseline" : "initial";
  try {
    const targeted = purpose.endsWith("targeted");
    if (targeted) req.gates.retryFiles = "bun test {files}";
    if (targeted) {
      mkdirSync(join(cwd, "test"));
      writeFileSync(join(cwd, "test/example.test.ts"), "");
    }
    f.state.logs.set(1, log(framed(), `original failure\n${framed(0, 1, 123, purpose === "timeout")}`));
    const first = await runGateExecution(ctx, stage, initialPurpose, cwd, req.gates);
    // Actions does not collect failedFiles yet; model a checkpoint that can select a targeted retry.
    if (targeted) {
      const original = ctx.state.gateExecution?.handle.githubActions?.completed?.checks[0];
      if (!original) throw new Error("Missing initial result");
      original.failedFiles = ["test/example.test.ts"];
      await ctx.save();
    }
    const caller = async (active: RunContext) => {
      await resumeGateExecution(active, stage, initialPurpose, cwd);
      const original = await runGateExecution(active, stage, initialPurpose, cwd, req.gates);
      if (purpose === "timeout") {
        const retried = await runGateExecution(active, stage, purpose, cwd, req.gates);
        const a = original.checks[0];
        const b = retried.checks[0];
        if (!a || !b) throw new Error("Missing retry checks");
        return compareGates(null, {
          ...retried,
          checks: [{ ...validateRetry(b, a, req.headSha, retried), firstAttempt: a }],
        });
      }
      const runner = (gates: typeof req.gates, options?: { targeted: boolean }) =>
        runGateExecution(
          active,
          stage,
          options?.targeted
            ? `${purpose.replace(/-targeted$/, "")}-targeted`
            : purpose.replace(/-targeted$/, ""),
          cwd,
          gates,
        );
      return stage === "prepare"
        ? compareGates(
            null,
            await retryBaselineFailures(original, cwd, req.gates, signal(), undefined, runner, true),
          )
        : retryRegressions(
            compareGates({ ...original, checks: original.checks.map((r) => ({ ...r, ok: true })) }, original),
            cwd,
            req.gates,
            [],
            signal(),
            undefined,
            runner,
            true,
          );
    };
    // Fail targeted retries, so there is no full-suite attempt after this checkpoint.
    f.state.logs.set(1, log(framed(), targeted ? framed(0, 2) : framed()));
    const result = await caller(ctx);
    const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution;
    expect(durable?.purpose).toBe(purpose);
    expect(durable?.handle.githubActions?.completed).toBeDefined();
    expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(2);
    const restarted = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
    expect(await caller(restarted)).toEqual(result);
    expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(2);
    expect(restarted.state.gateTimeoutReruns ?? 0).toBe(purpose === "timeout" ? 1 : 0);
    expect(result[0]?.result.firstAttempt).toMatchObject({
      output: first.checks[0]?.output,
      executor: { kind: "github-actions", workflowSha: req.baseSha, runsOn: "ubuntu-24.04" },
    });
    expect(result[0]?.blocking).toBe(true);
    if (stage === "gates" && purpose !== "timeout")
      expect(result[0]?.retryOriginal).toEqual({ verdict: "regressed", blocking: true });
    restarted.state.lastGates = result;
    consumeGateExecution(restarted);
    await restarted.save("retry-consumed");
    expect(store.getRunState<RunState>(ctx.run.id)?.gateExecution).toBeUndefined();
    expect(store.getRunState<RunState>(ctx.run.id)?.lastGates).toEqual(result);
  } finally {
    store.close();
  }
});

test.each(["run response", "jobs response", "run CommandError", "jobs CommandError"])(
  "primary quota exhaustion waits until reset for %s",
  async (variant) => {
    const f = fixture();
    const gh = f.deps.gh;
    const start = f.deps.now();
    let limited = false;
    f.deps.gh = async (...args) => {
      if (args[0].includes("--include") && (!variant.startsWith("jobs") || args[0][1]?.includes("/jobs?"))) {
        if (!limited) {
          limited = true;
          const raw = `HTTP/2.0 403 Forbidden\r\nx-RaTeLiMiT-ReMaInInG: 0\r\nX-rAtElImIt-ReSeT: ${(start + 60_000) / 1_000}\r\n\r\n`;
          if (variant.endsWith("CommandError"))
            throw new CommandError("gh api failed", 1, raw, "API rate limit exceeded", false);
          return `${raw}{"message":"API rate limit exceeded"}`;
        }
        expect(f.deps.now()).toBeGreaterThanOrEqual(start + 60_000);
      }
      return (await gh(...args)) ?? "";
    };
    await expect(f.run()).resolves.toMatchObject({ setupOk: true });
    expect(f.state.delays).toEqual([60_000]);
    expect(f.calls).not.toContain("cancel");
  },
);

test.each(["run Retry-After", "jobs reset"])(
  "shutdown checkpoints %s cooldown, then restart cleans up without polling or redispatch",
  async (variant) => {
    const f = fixture();
    const { ctx, store } = await context(f);
    try {
      const controller = new AbortController();
      const start = f.deps.now();
      const gh = f.deps.gh;
      let limited = false;
      const times: number[] = [];
      f.deps.gh = async (...args) => {
        if (args[0].includes("--include")) {
          times.push(f.deps.now());
          if (!limited && (!variant.startsWith("jobs") || args[0][1]?.includes("/jobs?"))) {
            limited = true;
            return variant.startsWith("jobs")
              ? `HTTP/2.0 403 Forbidden\r\nX-RateLimit-Remaining: 0\r\nX-RateLimit-Reset: ${(start + 60_000) / 1_000}\r\n\r\n{}`
              : `HTTP/2.0 429 Too Many Requests\r\nRetry-After: ${(start + 60_000 - f.deps.now()) / 1_000}\r\n\r\n{}`;
          }
        }
        return (await gh(...args)) ?? "";
      };
      const sleep = f.deps.sleep;
      const sleeping = Promise.withResolvers<void>();
      f.deps.sleep = async () => {
        sleeping.resolve();
        await new Promise<void>(() => {});
      };
      const active = new RunContext(ctx.deps, ctx.run, ctx.repo, controller.signal);
      const running = runGateExecution(active, "gates", "initial", cwd, req.gates);
      await sleeping.promise;
      const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle.githubActions;
      expect(durable?.nextPollAt).toBe(start + 60_000);
      controller.abort(new Error("shutdown"));
      await expect(running).rejects.toThrow("shutdown");
      expect(f.remote.size).toBe(2);
      expect(f.calls).not.toContain("cancel");
      times.length = 0;
      f.deps.sleep = sleep;
      await expect(
        runGateExecution(
          new RunContext(ctx.deps, ctx.run, ctx.repo, signal()),
          "gates",
          "initial",
          cwd,
          req.gates,
        ),
      ).rejects.toThrow("(interrupted)");
      // Cleanup needs no result polls, and the interrupted run is never redispatched.
      expect(times).toEqual([]);
      expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(1);
      expect(f.remote.size).toBe(0);
    } finally {
      store.close();
    }
  },
);

test.each(["elapsed", "legacy", "past deadline"])(
  "restart with %s cooldown cleans up and blocks instead of replacing",
  async (kind) => {
    const f = fixture();
    const start = f.deps.now();
    const h = await f.stored({
      dispatchSent: true,
      runId: 17,
      deadline: kind === "past deadline" ? start - 1 : start + 1_000,
      nextPollAt: kind === "legacy" ? undefined : kind === "elapsed" ? start - 1 : start + 60_000,
    });
    f.state.runStatus = "in_progress";
    const error = await f.run(signal(), h).catch((e: unknown) => e);
    expect((error as GateBlockedError).classification).toBe("interrupted");
    expect(f.saved.every((saved) => saved.id === h.id)).toBe(true);
    expect(f.calls).not.toContain("dispatch");
    expect(f.calls).toContain("cancel");
    expect(f.remote.size).toBe(0);
  },
);

test("a completed and cleaned result replays while GitHub is unavailable", async () => {
  const f = fixture();
  const original = await f.run();
  const h = structuredClone(f.saved.at(-1));
  if (!h?.githubActions?.completed) throw new Error("Missing completed handle");
  expect(h.githubActions.cleanupFailed).toBeUndefined();
  expect(f.remote.size).toBe(0);
  f.deps.gh = async () => {
    throw new Error("GitHub unavailable after successful cleanup");
  };
  await expect(f.run(signal(), h)).resolves.toEqual(original);
  expect(f.saved.at(-1)?.id).toBe(h.id);
  expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(1);
});

type Fixture = ReturnType<typeof fixture>;
const publicRepo = { default_branch: "main", full_name: "test/repo", private: false };
const destination = "https://github.com/test/repo.git";
const published = (f: Fixture) => ({
  pushes: f.calls.filter((call) => call === "push").length,
  dispatches: f.dispatches().length,
});

test.each([
  ["public", false, false],
  ["paid private", true, true],
])("authorized %s invocation publishes only to the recorded repository", async (_kind, isPrivate, paid) => {
  const f = fixture();
  f.settings.githubActionsPaidMinutes = paid;
  f.state.meta = () => ({ ...publicRepo, full_name: "Test/Repo", private: isPrivate });
  expect((await f.run()).checks[0]?.ok).toBe(true);
  expect(published(f)).toEqual({ pushes: 1, dispatches: 1 });
  for (const r of f.requests) {
    expect(r.repo).toBe("test/repo");
    if (r.args[0] === "api") expect(r.args[1]).toStartWith("repos/test/repo/");
    else expect(r.args[r.args.indexOf("--repo") + 1]).toBe("test/repo");
  }
  expect([...f.pushes.map((p) => p.url), ...f.deletes]).toEqual([destination, destination, destination]);
});

const git = (...args: string[]) => sh(["git", ...args], { cwd });
test.each<[string, string, (f: Fixture) => unknown]>([
  ["no authorization", "refused", (f) => Object.assign(f.settings, { githubActions: false })],
  [
    "paid minutes without Actions",
    "refused",
    (f) => Object.assign(f.settings, { githubActions: false, githubActionsPaidMinutes: true }),
  ],
  ["unpaid private", "refused", (f) => (f.state.meta = () => ({ ...publicRepo, private: true }))],
  ["discreet", "refused", (f) => Object.assign(f.settings, { discreet: true })],
  ["missing visibility", "refused", (f) => (f.state.meta = () => ({ ...publicRepo, private: undefined }))],
  ["string visibility", "refused", (f) => (f.state.meta = () => ({ ...publicRepo, private: "false" }))],
  [
    "visibility label only",
    "refused",
    (f) => (f.state.meta = () => ({ ...publicRepo, private: undefined, visibility: "public" })),
  ],
  [
    "unavailable metadata",
    "operational",
    (f) =>
      (f.state.meta = () => {
        throw new Error("HTTP 502");
      }),
  ],
  [
    "full_name mismatch",
    "refused",
    (f) => (f.state.meta = () => ({ ...publicRepo, full_name: "other/repo" })),
  ],
  ["option-like metadata head", "refused", (f) => (f.state.dispatchSha = "--output=/dev/null")],
  ["request repository differs from the run", "refused", () => (req.repo = "other/repo")],
  ["no run record", "refused", (f) => (f.state.destination = undefined)],
  ["symbolic candidate SHA", "refused", () => (req.headSha = "HEAD")],
  ...[41, 64].map((n): [string, string, (f: Fixture) => unknown] => [
    `${n}-digit hexadecimal candidate branch`,
    "refused",
    async () => {
      // Git resolves this name as a movable branch, not as the object ID it resembles.
      await git("branch", "a".repeat(n));
      req.headSha = "a".repeat(n);
    },
  ]),
  [
    "hexadecimal branch as metadata head",
    "refused",
    async (f) => {
      await git("branch", "b".repeat(41), req.baseSha);
      f.state.dispatchSha = "b".repeat(41);
    },
  ],
  ["hostile origin", "refused", () => git("config", "remote.origin.url", "https://github.com/evil/repo.git")],
  [
    "insteadOf rewrite",
    "refused",
    () => git("config", "url.https://evil.example/.insteadOf", "https://github.com/"),
  ],
  [
    "pushInsteadOf rewrite",
    "refused",
    () => git("config", "url.ssh://evil/.pushInsteadOf", "https://github.com/"),
  ],
])("%s refuses with zero pushes and dispatches", async (name, classification, arrange) => {
  const f = fixture();
  await arrange(f);
  const error = await f.run().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(GateBlockedError);
  expect((error as GateBlockedError).classification).toBe(classification);
  expect(published(f)).toEqual({ pushes: 0, dispatches: 0 });
  // Only the API can answer identity and visibility; everything else refuses before any handle exists.
  if (!/visibility|metadata|full_name|private/.test(name)) {
    expect(f.saved).toEqual([]);
    expect(f.requests).toEqual([]);
  }
});

test("a candidate origin at the recorded destination is not a redirect", async () => {
  const f = fixture();
  await git("config", "remote.origin.url", destination);
  await f.run();
  expect(published(f)).toEqual({ pushes: 1, dispatches: 1 });
});

test.each(["completed", "interrupted"])(
  "a %s handle bound to another repository is refused",
  async (kind) => {
    const f = fixture();
    const h = await f.stored(
      kind === "completed" ? { completed: { setupOk: true, setup: [], checks: [] } } : {},
    );
    if (!h.githubActions) throw new Error("Missing progress");
    h.githubActions.repo = "other/repo";
    f.requests.length = 0;
    const error = await f.run(signal(), h).catch((e: unknown) => e);
    expect((error as GateBlockedError).classification).toBe("refused");
    expect(f.requests).toEqual([]);
    expect(f.calls).toEqual([]);
  },
);

test.each(["visibility lookup", "inspection", "push"])(
  "revoking authorization during the %s stops publication",
  async (at) => {
    const f = fixture();
    const lookup = Promise.withResolvers<unknown>();
    if (at === "visibility lookup")
      f.state.meta = () => {
        f.settings.githubActions = false;
        return lookup.promise;
      };
    const push = f.deps.push;
    f.deps.push = async (p, url) => {
      await push(p, url);
      if (at === "push") f.settings.githubActions = false;
    };
    // The checkpoint after inspection is the last await before upload.
    const persist = async (h: ExecutionHandle) => {
      await f.persist(h);
      if (at === "inspection" && h.githubActions?.inputs) f.settings.githubActions = false;
    };
    const running = executeGate(req, signal(), {}, f.executor(), undefined, persist).catch((e: unknown) => e);
    lookup.resolve(publicRepo);
    expect(((await running) as GateBlockedError).classification).toBe("refused");
    expect(published(f)).toEqual({ pushes: at === "push" ? 1 : 0, dispatches: 0 });
    expect(f.remote.size).toBe(0);
  },
);

test("revoked authorization still lets discard finish cleanup", async () => {
  const f = fixture();
  f.state.runStatus = "in_progress";
  const h = await f.stored({ dispatchSent: true, runId: 17 });
  Object.assign(f.settings, { githubActions: false, discreet: true });
  await f.executor().discard?.(h);
  expect(f.calls).toContain("cancel");
  expect(f.remote.size).toBe(0);
  expect(h.githubActions?.cleanupFailed).toBeUndefined();
});

const secret = "zebra-internal-codename-41";
const credential = "actions-publication-credential-77";
async function withPrivateString<T>(fn: () => Promise<T>): Promise<T> {
  const dir = process.env.LIMITLESS_CONFIG_DIR ?? "";
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "private-strings.txt");
  writeFileSync(file, `${secret}\n`);
  try {
    return await fn();
  } finally {
    rmSync(file, { force: true });
  }
}
async function commit(files: Record<string, string>, message = "change", env: Record<string, string> = {}) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
  await git("add", "-A");
  await sh(["git", "commit", "-qm", message], {
    cwd,
    env: { ...(process.env as Record<string, string>), ...env },
  });
  req.headSha = (await git("rev-parse", "HEAD")).stdout.trim();
}

test.each<[string, (f: Fixture) => Promise<unknown> | unknown]>([
  ["a filename", () => commit({ [`${secret}.txt`]: "x\n" })],
  [
    "a CI configuration filename",
    async () => {
      mkdirSync(join(cwd, ".github/workflows"), { recursive: true });
      await commit({ [`.github/workflows/${secret}.yml`]: "on: push\n" });
    },
  ],
  ["a blob", () => commit({ "notes.txt": `${secret}\n` })],
  ["a base64 blob", () => commit({ "notes.txt": `${Buffer.from(secret).toString("base64")}\n` })],
  ["a registered credential", () => commit({ "notes.txt": `${credential}\n` })],
  ["a commit message", () => commit({ "notes.txt": "x\n" }, `mention ${secret}`)],
  ["a commit author", () => commit({ "notes.txt": "x\n" }, "change", { GIT_AUTHOR_NAME: secret })],
  [
    "only an intermediate commit",
    async () => {
      await commit({ "notes.txt": `${secret}\n` });
      await commit({ "notes.txt": "clean\n" });
      expect((await git("diff", req.baseSha, req.headSha)).stdout).not.toContain(secret);
    },
  ],
  ["a dispatch command", () => (req.gates.checks[0] = { name: "test", run: `echo ${secret}` })],
  ["a failed inspection", (f) => (f.state.dispatchSha = "e".repeat(40))],
  [
    "a GitHub diagnostic splitting protected text with terminal formatting",
    (f) =>
      (f.state.meta = () => {
        throw new Error(`HTTP 404 for ${secret.slice(0, 6)}\x1b[31m${secret.slice(6)}\x1b[0m`);
      }),
  ],
  [
    "a GitHub diagnostic echoing protected text",
    (f) =>
      (f.state.meta = () => {
        throw new Error(`HTTP 404 for ${secret} with ${credential}`);
      }),
  ],
])("publication inspection refuses %s before any push or dispatch", async (_name, arrange) => {
  registerCredential("ACTIONS_PUBLICATION_TEST", credential);
  const f = fixture();
  await withPrivateString(async () => {
    await arrange(f);
    const error = await f.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateBlockedError);
    expect(published(f)).toEqual({ pushes: 0, dispatches: 0 });
    const persisted = JSON.stringify([f.saved, String(error), (error as Error).stack]);
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain(credential);
    expect(persisted).not.toContain(Buffer.from(secret).toString("base64"));
  });
});

test("protected text in a job log never reaches results or checkpoints", async () => {
  registerCredential("ACTIONS_PUBLICATION_TEST", credential);
  const f = fixture();
  f.state.logs.set(1, log(framed(), `failed near ${secret} using ${credential}\n${framed(0, 1)}`));
  const run = await withPrivateString(() => f.run());
  expect(run.checks[0]).toMatchObject({ ok: false, exitCode: 1 });
  expect(run.checks[0]?.output).toContain("failed near");
  const persisted = JSON.stringify([run, f.saved]);
  expect(persisted).not.toContain(secret);
  expect(persisted).not.toContain(credential);
});

test("protected text split by terminal formatting in a job log never reaches results or checkpoints", async () => {
  const f = fixture();
  const colored = `${secret.slice(0, 6)}\x1b[1;31m${secret.slice(6)}\x1b[0m`;
  f.state.logs.set(1, log(framed(), `failed near ${colored}\n${framed(0, 1)}`));
  const run = await withPrivateString(() => f.run());
  expect(run.checks[0]).toMatchObject({ ok: false, exitCode: 1 });
  expect(JSON.stringify([run, f.saved])).not.toContain(secret);
});

test("a clean candidate publishes exactly the inspected SHAs and inputs, without environment values", async () => {
  const f = fixture();
  req.env = { DAEMON_ONLY: "daemon-env-value-91" };
  process.env.LIMITLESS_ACTIONS_DAEMON_ENV = "process-env-value-92";
  const push = f.deps.push;
  f.deps.push = async (p, url) => {
    expect(f.saved.at(-1)?.githubActions?.inputs).toEqual(p.inputs);
    await push(p, url);
  };
  try {
    await withPrivateString(() => f.run());
  } finally {
    delete process.env.LIMITLESS_ACTIONS_DAEMON_ENV;
  }
  expect(f.pushes).toEqual([{ url: destination, headSha: req.headSha, dispatchSha: req.baseSha }]);
  const inputs = f.saved.at(-1)?.githubActions?.inputs;
  expect(inputs?.sha).toBe(req.headSha);
  expect(f.dispatches()).toHaveLength(1);
  expect(f.dispatches()[0]?.body?.inputs).toEqual(inputs);
  const body = JSON.stringify(f.dispatches()[0]?.body);
  expect(body).not.toContain("daemon-env-value-91");
  expect(body).not.toContain("process-env-value-92");
});

test("Actions results carry trusted provenance and never compare as still failing", async () => {
  const f = fixture();
  f.state.logs.set(1, log(framed(), framed(0, 1)));
  const run = await f.run();
  for (const r of [...run.setup, ...run.checks])
    expect(r.executor).toEqual({ kind: "github-actions", workflowSha: req.baseSha, runsOn: "ubuntu-24.04" });
  const local: GateRun = {
    setupOk: true,
    setup: [],
    checks: [{ name: "test", command: "test", ok: false, exitCode: 1, durationMs: 1, output: "failed" }],
  };
  expect(compareGates(run, local)[0]).toMatchObject({ verdict: "new_failure", blocking: true });
  expect(compareGates(local, run)[0]).toMatchObject({ verdict: "new_failure", blocking: true });
  expect(compareGates(local, local)[0]).toMatchObject({ verdict: "still_failing", blocking: false });
});

test.each<[string, string, (f: Fixture) => void]>([
  ["missing matrix job", "operational", (f) => (f.state.jobs = [])],
  ["malformed record", "operational", (f) => f.state.logs.set(1, log(framed(), `LIMITLESS:${token}:bad`))],
  [
    "duplicate token",
    "operational",
    (f) => f.state.logs.set(1, `${log()}\ngate\tToken\tx LIMITLESS_TOKEN ${"b".repeat(32)}`),
  ],
  [
    "contradictory records",
    "contradictory-records",
    (f) => f.state.logs.set(1, log(framed(), `${framed(0, 0)}\n${framed(0, 1)}`)),
  ],
  [
    "setup failed but check passed",
    "contradictory-records",
    (f) => f.state.logs.set(1, log(framed(0, 7), framed())),
  ],
  [
    "contradictory setup records",
    "contradictory-records",
    (f) => f.state.logs.set(1, log(`${framed(0, 0)}\n${framed(0, 7)}`, "not run")),
  ],
  [
    "contradictory timeout records",
    "contradictory-records",
    (f) => f.state.logs.set(1, log(framed(), `${framed()}\n${framed(0, 0, 123, true)}`)),
  ],
  ["incomplete check", "incomplete", (f) => f.state.logs.set(1, log(framed(), "no record"))],
  [
    "unconfirmed dispatch",
    "dispatch",
    (f) => {
      f.state.returnId = false;
      f.state.visibleAfter = Infinity;
    },
  ],
  [
    "unconfirmed termination",
    "operational",
    (f) => {
      f.state.runStatus = "in_progress";
      f.state.logs.set(1, log(framed(), `LIMITLESS:${token}:bad`));
      const gh = f.deps.gh;
      f.deps.gh = async (...args) => (args[0][1]?.endsWith("/cancel") ? "null" : ((await gh(...args)) ?? ""));
    },
  ],
])("%s stays operationally blocked without local execution or redispatch", async (_name, kind, arrange) => {
  const f = fixture();
  arrange(f);
  const { ctx, store } = await context(f);
  try {
    req.gates.checks[0] = { name: "test", run: "touch ran-locally" };
    for (let attempt = 0; attempt < 2; attempt++) {
      const active = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
      const error = await runGateExecution(active, "gates", "initial", cwd, req.gates).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(GateBlockedError);
      expect((error as GateBlockedError).classification).toBe(
        attempt && kind === "cleanup" ? "cleanup" : kind,
      );
    }
    const durable = store.getRunState<RunState>(ctx.run.id);
    expect(durable?.gateExecution?.handle.kind).toBe("github-actions");
    expect(durable?.gateExecution?.handle.githubActions?.interrupted).toBe(kind);
    expect(durable?.lastGates).toBeUndefined();
    expect(durable?.gateExecution?.handle.githubActions?.completed).toBeUndefined();
    expect(f.dispatches()).toHaveLength(1);
    expect(existsSync(join(cwd, "ran-locally"))).toBe(false);
  } finally {
    store.close();
  }
});

test.each(["sha", "configuration", "legacy binding"])(
  "a completed handle with a changed %s never replays or dispatches",
  async (change) => {
    const f = fixture();
    const original = await f.run();
    const h = JSON.parse(JSON.stringify(f.saved.at(-1))) as ExecutionHandle;
    if (!h.githubActions?.completed) throw new Error("Missing completed handle");
    if (change === "sha") req.headSha = req.baseSha;
    if (change === "configuration") req.gates = { ...req.gates, setup: ["other install"] };
    if (change === "legacy binding") h.githubActions.gateKey = undefined;
    f.calls.length = 0;
    const error = await f.run(signal(), h).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateBlockedError);
    expect(error).not.toEqual(original);
    expect(f.calls).not.toContain("push");
    expect(f.calls).not.toContain("dispatch");
    expect(f.saved.at(-1)?.id).toBe(h.id);
    expect(f.saved.at(-1)?.githubActions?.interrupted).toBe("interrupted");
  },
);

test.each<[string, (p: ActionsProgress) => void]>([
  ["missing owner", (p) => (p.owner = undefined)],
  ["another run", (p) => (p.owner = "run-2")],
  ["missing configuration digest", (p) => (p.gateKey = undefined)],
  ["another configuration", (p) => (p.gateKey = "0".repeat(64))],
  ["another SHA", (p) => (p.headSha = req.baseSha)],
])("attach refuses a handle with %s before any publication", async (_name, mutate) => {
  const f = fixture();
  const h = await f.executor().start(req, signal());
  if (!h.githubActions) throw new Error("Missing progress");
  mutate(h.githubActions);
  const error = await (async () => f.executor().attach(h, signal(), req, {}, f.persist).result)().catch(
    (e: unknown) => e,
  );
  expect((error as GateBlockedError).classification).toBe("refused");
  expect(published(f)).toEqual({ pushes: 0, dispatches: 0 });
  expect(f.requests).toEqual([]);
});

test("a legacy completed handle advanced to another purpose never replays through the pipeline", async () => {
  const f = fixture();
  const { ctx, store } = await context(f);
  try {
    const original = await runGateExecution(ctx, "gates", "initial", cwd, req.gates);
    const p = ctx.state.gateExecution?.handle.githubActions;
    if (!p?.completed) throw new Error("Missing completed identity");
    p.owner = undefined;
    p.gateKey = undefined;
    await ctx.save();
    for (const purpose of ["regression-retry", "initial", "regression-retry"]) {
      const restarted = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
      const result = await runGateExecution(restarted, "gates", purpose, cwd, req.gates).catch((e) => e);
      expect(result, purpose).toBeInstanceOf(GateBlockedError);
      expect(result).not.toEqual(original);
    }
    const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution;
    expect(durable?.previous ?? []).toEqual([]);
    expect(durable?.handle.githubActions?.interrupted).toBe("interrupted");
    expect(f.dispatches()).toHaveLength(1);
    expect(f.calls.filter((c) => c === "push")).toHaveLength(1);
  } finally {
    store.close();
  }
});

test.each([
  "repository",
  "missing repository",
  "missing progress",
  "owner",
  "legacy owner",
  "SHA",
  "digest",
  "legacy digest",
  "envelope SHA",
  "envelope digest",
  "requested initial configuration",
  "requested retry configuration",
])("completed retry binding blocks current and retained replay after restart: %s", async (change) => {
  const f = fixture();
  const { ctx, store } = await context(f);
  const retryGates = { ...req.gates, checks: [{ name: "test", run: "targeted test" }] };
  try {
    const initial = await runGateExecution(ctx, "gates", "initial", cwd, req.gates);
    const retry = await runGateExecution(ctx, "gates", "regression-retry", cwd, retryGates);
    const pending = ctx.state.gateExecution;
    const p = pending?.handle.githubActions;
    if (!pending || !p) throw new Error("Missing retry identity");
    expect(pending.previous?.[0]?.gateKey).not.toBe(pending.gateKey);
    // Both purposes replay with distinct digests before the durable binding is changed.
    const valid = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
    await resumeGateExecution(valid, "gates", "initial", cwd);
    expect(await runGateExecution(valid, "gates", "initial", cwd, req.gates)).toEqual(initial);
    expect(await runGateExecution(valid, "gates", "regression-retry", cwd, retryGates)).toEqual(retry);
    if (change === "repository") p.repo = "other/repo";
    if (change === "missing repository") Reflect.deleteProperty(p, "repo");
    if (change === "missing progress") pending.handle.githubActions = undefined;
    if (change === "owner") p.owner = "another-run";
    if (change === "legacy owner") p.owner = undefined;
    if (change === "SHA") p.headSha = req.baseSha;
    if (change === "digest") p.gateKey = "different";
    if (change === "legacy digest") p.gateKey = undefined;
    if (change === "envelope SHA") pending.sha = req.baseSha;
    if (change === "envelope digest") pending.gateKey = "different";
    await ctx.save();
    const configChange = change.startsWith("requested");
    for (const purpose of configChange
      ? [change.includes("initial") ? "initial" : "regression-retry"]
      : ["initial", "regression-retry"]) {
      const gates = configChange
        ? { ...req.gates, setup: ["changed setup"] }
        : purpose === "initial"
          ? req.gates
          : retryGates;
      for (let reopen = 0; reopen < 2; reopen++) {
        if (!configChange) {
          const resumed = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
          await expect(resumeGateExecution(resumed, "gates", purpose, cwd)).rejects.toBeInstanceOf(
            GateBlockedError,
          );
        }
        const restarted = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
        await expect(runGateExecution(restarted, "gates", purpose, cwd, gates)).rejects.toBeInstanceOf(
          GateBlockedError,
        );
        const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution;
        expect(durable?.handle.id).toBe(pending.handle.id);
        expect(durable?.previous).toEqual(pending.previous);
      }
    }
    expect(published(f)).toEqual({ pushes: 2, dispatches: 2 });
    if (["repository", "missing repository"].includes(change)) {
      expect(f.requests.every((r) => r.repo === "test/repo")).toBe(true);
      expect(
        store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle.githubActions?.cleanupFailed,
      ).toBe(true);
    }
  } finally {
    store.close();
  }
});

test("a rejection checkpoint before cleanup retains cleanup debt across shutdown", async () => {
  const f = fixture();
  f.state.logs.set(1, log(framed(), `LIMITLESS:${token}:bad`));
  const controller = new AbortController();
  await expect(
    executeGate(req, controller.signal, {}, f.executor(), undefined, async (handle) => {
      await f.persist(handle);
      if (handle.githubActions?.interrupted) controller.abort(new Error("shutdown"));
    }),
  ).rejects.toThrow("Malformed gate record");
  const durable = f.saved.at(-1);
  expect(durable?.githubActions).toMatchObject({ cleanupFailed: true, interrupted: "operational" });
  expect(f.remote.size).toBe(2);
  f.settings.githubActions = false;
  await expect(f.run(signal(), durable)).rejects.toThrow("Malformed gate record");
  expect(f.saved.at(-1)?.id).toBe(durable?.id);
  expect(f.saved.at(-1)?.githubActions?.cleanupFailed).toBeUndefined();
  expect(published(f)).toEqual({ pushes: 1, dispatches: 1 });
  expect(f.remote.size).toBe(0);
});

test("retained attempt replay waits for the active retry's cleanup", async () => {
  const f = fixture();
  const { ctx, store } = await context(f);
  const retryGates = { ...req.gates, setup: ["retry install"] };
  try {
    const initial = await runGateExecution(ctx, "gates", "initial", cwd, req.gates);
    const initialKey = ctx.state.gateExecution?.gateKey;
    const remove = f.deps.delete;
    let failing = true;
    f.deps.delete = async (p, branch, sha, url) => {
      if (failing && p.gateKey !== initialKey) throw new Error("lease rejected");
      await remove(p, branch, sha, url);
    };
    await expect(runGateExecution(ctx, "gates", "regression-retry", cwd, retryGates)).rejects.toThrow(
      "lease rejected",
    );
    const pending = ctx.state.gateExecution;
    const restarted = () => new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
    await expect(runGateExecution(restarted(), "gates", "initial", cwd, req.gates)).rejects.toThrow(
      "lease rejected",
    );
    expect(store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle.id).toBe(pending?.handle.id);
    expect(store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle.githubActions?.cleanupFailed).toBe(
      true,
    );
    failing = false;
    f.settings.githubActions = false;
    expect(await runGateExecution(restarted(), "gates", "initial", cwd, req.gates)).toEqual(initial);
    expect(await runGateExecution(restarted(), "gates", "regression-retry", cwd, retryGates)).toMatchObject({
      setupOk: true,
    });
    expect(published(f)).toEqual({ pushes: 2, dispatches: 2 });
    expect(f.remote.size).toBe(0);
  } finally {
    store.close();
  }
});
