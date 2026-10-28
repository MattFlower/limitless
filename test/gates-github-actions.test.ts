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
import { type ExecutionHandle, executeGate, type GateRequest } from "../src/gates/executor.ts";
import { type ActionsProgress, githubActionsExecutor } from "../src/gates/github-actions.ts";
import { compareGates } from "../src/gates/run.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import { type EngineDeps, RunContext, type RunState } from "../src/pipeline/context.ts";
import { runGateExecution } from "../src/pipeline/gate-execution.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
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
  const requests: { args: string[]; body: Record<string, unknown> | undefined }[] = [];
  const saved: ExecutionHandle[] = [];
  const remote = new Map<string, string>();
  const state = {
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
  const gh: GhRunner = async (args, _signal, stdin) => {
    const path = args[1] ?? "";
    const body = stdin ? (JSON.parse(stdin) as Record<string, unknown>) : undefined;
    requests.push({ args, body });
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
    else if (path.includes("git/ref/heads/")) data = { object: { sha: "d".repeat(40) } };
    else if (path === "repos/test/repo/") data = { default_branch: "main" };
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
    now: () => now,
    pollMs: 10,
    discardVisibilityMs: 40,
    async sleep(ms: number) {
      state.delays.push(ms);
      now += ms;
      if (++state.sleeps > 20) throw new Error("Unexpected unbounded polling");
      state.onSleep();
    },
    async push(p: ActionsProgress) {
      expect(saved.at(-1)?.githubActions?.dispatchSha).toBe(p.dispatchSha);
      expect(saved.at(-1)?.githubActions?.pushed).toBeUndefined();
      calls.push("push");
      remote.set(p.dispatch, p.dispatchSha ?? "");
      remote.set(p.candidate, p.headSha);
    },
    async delete(_p: ActionsProgress, branch: string, sha: string) {
      calls.push(`delete:${branch}:${sha}`);
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
  return { state, calls, requests, saved, remote, deps, executor, persist, run, stored };
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
  expect(f.saved.find((h) => h.githubActions?.dispatchSha)?.githubActions?.dispatchSha).toBe("d".repeat(40));
  expect(f.calls).toEqual([
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
});

test("restart after branches pushed dispatches exactly once, with intent persisted first", async () => {
  const f = fixture();
  const h = await f.stored();
  const gh = f.deps.gh;
  f.deps.gh = async (...args) => {
    if (args[0][1]?.endsWith("/dispatches")) {
      expect(f.saved.at(-1)?.githubActions).toMatchObject({ dispatchIntent: true });
      expect(f.saved.at(-1)?.githubActions?.dispatchSent).toBeUndefined();
    }
    return (await gh(...args)) ?? "";
  };
  await f.run(signal(), structuredClone(h));
  expect(f.calls.filter((c) => c === "dispatch")).toHaveLength(1);
  expect(f.calls).not.toContain("push");
});

test("restart after dispatch reattaches to the persisted run id and never dispatches", async () => {
  const f = fixture();
  const h = await f.stored({ dispatchSent: true, runId: 17 });
  await f.run(signal(), structuredClone(h));
  expect(f.calls).not.toContain("dispatch");
  expect(f.calls).not.toContain("discover");
  expect(f.requests.some((r) => r.args[1] === "repos/test/repo/actions/runs/17")).toBe(true);
});

test("discovery uses head branch when the injected host clock is ahead of GitHub", async () => {
  const f = fixture();
  f.state.returnId = false;
  const h = await f.stored({ dispatchSent: true });
  await f.run(signal(), structuredClone(h));
  const discovery = f.requests.find((r) => r.args[1]?.includes("workflow_dispatch"));
  expect(discovery?.args[1]).toContain(`branch=${encodeURIComponent(h.githubActions?.dispatch ?? "")}`);
  expect(discovery?.args.join(" ")).not.toMatch(/created|title|since/);
  expect(f.calls).not.toContain("dispatch");
});

test("discard waits for a dispatched run that is not visible yet, then cancels before deleting", async () => {
  const f = fixture();
  f.state.visibleAfter = 2;
  f.state.runStatus = "in_progress";
  const h = await f.stored({ dispatchSent: true });
  await f.executor().discard?.(h);
  expect(f.state.sleeps).toBe(2);
  expect(f.calls.slice(0, 4)).toEqual(["discover", "discover", "discover", "cancel"]);
  expect(f.calls.slice(4)).toEqual([
    `delete:${h.githubActions?.dispatch}:${"d".repeat(40)}`,
    `delete:${h.githubActions?.candidate}:${req.headSha}`,
  ]);
  expect(f.remote.size).toBe(0);
});

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
  await expect(f.executor().discard?.(pending)).rejects.toThrow("discovery deadline");
  expect(f.state.sleeps).toBe(4);
  expect(f.calls.filter((c) => c.startsWith("delete:"))).toEqual([]);
  expect(f.remote.has(pending.githubActions?.dispatch ?? "")).toBe(true);
  expect(f.remote.has(pending.githubActions?.candidate ?? "")).toBe(true);
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
  "%s job stays blocking against a failing baseline",
  async (conclusion) => {
    const f = fixture();
    req.gates.setup = [];
    f.state.jobs[0] = { id: 1, name: "gate-0", status: "completed", conclusion };
    f.state.logs.set(1, log("", "missing check record"));
    const run = await f.run();
    expect(run.checks[0]).toMatchObject({ ok: false, exitCode: null, incomplete: expect.any(String) });
    const baseline = {
      setupOk: true,
      setup: [],
      checks: [{ name: "test", command: "test", ok: false, exitCode: 1, durationMs: 1, output: "failed" }],
    };
    expect(compareGates(baseline, run)[0]).toMatchObject({ blocking: true, verdict: "not_run" });
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
  const serialized = JSON.stringify(result);
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
  f.deps.push = async (p) => {
    const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle;
    if (durable) f.saved.push(durable);
    await push(p);
  };
  return { ctx, store };
}

test.each(["sha", "stage", "round", "purpose"])(
  "mismatched %s discards the old run before a fresh execution",
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
      f.state.runStatus = "in_progress";
      const gh = f.deps.gh;
      f.deps.gh = async (...args) => {
        if (args[0][1]?.endsWith("/dispatches")) f.state.runStatus = "completed";
        return (await gh(...args)) ?? "";
      };
      // Use the actual persistence boundary, observing its stored progress before push.
      const push = f.deps.push;
      f.deps.push = async (p) => {
        const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle;
        if (durable) f.saved.push(durable);
        await push(p);
      };
      await runGateExecution(ctx, "gates", "initial", cwd, req.gates);
      expect(f.calls.slice(0, 3)).toEqual([
        "cancel",
        expect.stringContaining("/dispatch:"),
        expect.stringContaining("/candidate:"),
      ]);
      expect(f.calls.filter((c) => c === "dispatch")).toHaveLength(1);
      expect(ctx.state.gateExecution?.handle.githubActions?.completed?.setupOk).toBe(true);
    } finally {
      store.close();
    }
  },
);

test("daemon shutdown preserves persisted progress, the workflow and both branches for reattach", async () => {
  const f = fixture();
  const controller = new AbortController();
  const { ctx, store } = await context(f, controller);
  try {
    f.state.runStatus = "in_progress";
    f.state.onSleep = () => controller.abort(new Error("shutdown"));
    const push = f.deps.push;
    f.deps.push = async (p) => {
      const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle;
      if (durable) f.saved.push(durable);
      await push(p);
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
    await runGateExecution(restarted, "gates", "initial", cwd, req.gates);
    expect(f.calls.filter((c) => c === "dispatch")).toHaveLength(1);
    expect(f.remote.size).toBe(0);
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

test("incomplete setup is blocking and the lowest matrix index owns the failing setup result", async () => {
  const f = fixture();
  req.gates.checks.push({ name: "second", run: "second" });
  f.state.jobs = [
    { id: 2, name: "gate-1", status: "completed", conclusion: "failure" },
    { id: 1, name: "gate-0", status: "completed", conclusion: "failure" },
  ];
  f.state.logs.set(2, log(framed(0, 7), ""));
  f.state.logs.set(1, log("missing setup record", ""));
  const run = await f.run();
  expect(run).toMatchObject({
    setupOk: false,
    checks: [],
    setup: [{ ok: false, exitCode: null, incomplete: expect.any(String) }],
  });
  expect(compareGates(null, run)[0]?.blocking).toBe(true);
});

test("a check step timeout backstop does not turn completed setup into a setup timeout", async () => {
  const f = fixture();
  f.state.jobs[0] = { id: 1, name: "gate-0", status: "completed", conclusion: "timed_out" };
  f.state.logs.set(1, log(framed(), "check did not write its final record"));
  const run = await f.run();
  expect(run.setupOk).toBe(true);
  expect(run.setup[0]).toMatchObject({ ok: true, timedOut: false });
  expect(run.checks[0]).toMatchObject({
    ok: false,
    exitCode: null,
    timedOut: true,
    incomplete: expect.any(String),
  });
  expect(compareGates(null, run)[0]).toMatchObject({ verdict: "not_run", blocking: true });
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
    f.deps.push = async (p) => {
      const durable = store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle;
      if (durable) f.saved.push(durable);
      await push(p);
    };
    f.deps.delete = async (p, branch, sha) => {
      if (failing && branch === p.dispatch) throw new Error("lease rejected");
      await remove(p, branch, sha);
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

test("review regression: invisible accepted dispatch is not declared cleaned up", async () => {
  const f = fixture();
  f.state.visibleAfter = Infinity;
  f.state.runStatus = "in_progress";
  const h = await f.stored({ dispatchSent: true });
  await expect(f.executor().discard?.(h)).rejects.toThrow("discovery deadline");
  expect(f.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
  expect(f.remote.size).toBe(2);
});

test("review regression: persisted legacy dispatch without a visible run has bounded discovery failure", async () => {
  const f = fixture();
  f.state.visibleAfter = Infinity;
  const h = await f.stored({ dispatchSent: true });
  await expect(f.run(signal(), h)).rejects.toThrow(/dispatch.*unconfirmed|discovery.*deadline/i);
  expect(f.calls).not.toContain("dispatch");
  expect(f.state.delays.reduce((a, b) => a + b, 0)).toBe(80);
  expect(h.githubActions?.cleanupFailed).toBe(true);
  expect(f.remote.size).toBe(2);
});

test.each(["before POST", "after acceptance"])(
  "intent recovery at crash boundary %s discovers before dispatch",
  async (boundary) => {
    const f = fixture();
    const controller = new AbortController();
    if (boundary === "before POST") f.state.visibleAfter = Infinity;
    const persist = async (handle: ExecutionHandle) => {
      const p = handle.githubActions;
      const crash = boundary === "before POST" ? p?.dispatchIntent && !p.dispatchSent : p?.dispatchSent;
      // The accepted POST's checkpoint never reaches the Store in the second boundary.
      if (!(crash && boundary === "after acceptance")) await f.persist(handle);
      if (crash) {
        controller.abort(new Error("shutdown"));
        throw new Error("shutdown");
      }
    };
    await expect(executeGate(req, controller.signal, {}, f.executor(), undefined, persist)).rejects.toThrow(
      "shutdown",
    );
    const durable = structuredClone(f.saved.at(-1));
    expect(durable?.githubActions).toMatchObject({ dispatchIntent: true, pushed: true });
    expect(durable?.githubActions?.dispatchSent).toBeUndefined();
    expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(boundary === "before POST" ? 0 : 1);
    const gh = f.deps.gh;
    f.deps.gh = async (...args) => {
      if (args[0][1]?.endsWith("/dispatches"))
        expect(f.saved.at(-1)?.githubActions?.recoveryAttempted).toBe(true);
      return (await gh(...args)) ?? "";
    };
    await f.run(signal(), durable);
    expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(1);
    expect(f.state.delays.reduce((a, b) => a + b, 0)).toBe(boundary === "before POST" ? 40 : 0);
    expect(
      f.saved.some((saved) => saved.githubActions?.dispatchSent && saved.githubActions.runId === 17),
    ).toBe(true);
  },
);

test("a lost POST response discovers the accepted run instead of dispatching twice", async () => {
  const f = fixture();
  const gh = f.deps.gh;
  f.deps.gh = async (...args) => {
    const response = await gh(...args);
    if (args[0][1]?.endsWith("/dispatches")) throw new Error("response lost");
    return response ?? "";
  };
  await f.run();
  expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(1);
  expect(f.calls).toContain("discover");
});

test("uncertain recovery is persisted before POST and repeated restarts cannot dispatch again", async () => {
  const f = fixture();
  f.state.visibleAfter = Infinity;
  const h = await f.stored({ dispatchIntent: true });
  const controller = new AbortController();
  const gh = f.deps.gh;
  f.deps.gh = async (...args) => {
    const response = await gh(...args);
    if (args[0][1]?.endsWith("/dispatches")) {
      controller.abort(new Error("shutdown"));
      throw new Error("response lost");
    }
    return response ?? "";
  };
  await expect(f.run(controller.signal, h)).rejects.toThrow("shutdown");
  const durable = structuredClone(f.saved.at(-1));
  expect(durable?.githubActions).toMatchObject({ dispatchIntent: true, recoveryAttempted: true });
  expect(durable?.githubActions?.dispatchSent).toBeUndefined();
  await expect(f.run(signal(), durable)).rejects.toThrow(/dispatch.*unconfirmed|discovery.*deadline/i);
  expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(1);
  expect(f.remote.size).toBe(2);
});

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

test.each(["sha", "stage", "round", "purpose"])(
  "completed result cannot satisfy a different %s",
  async (mismatch) => {
    const f = fixture();
    const { ctx, store } = await context(f);
    try {
      await runGateExecution(ctx, "gates", "initial", cwd, req.gates);
      const pending = ctx.state.gateExecution;
      if (!pending) throw new Error("Missing completed identity");
      if (mismatch === "sha") pending.sha = "old";
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

test.each(["active", "cancel error", "confirmation error"])(
  "cancellation remains pending after %s, then restart confirms termination before replacement",
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
      await runGateExecution(restarted, "gates", "initial", cwd, req.gates);
      expect(f.calls.indexOf("dispatch")).toBeGreaterThan(
        f.calls.findIndex((call) => call.startsWith("delete:")),
      );
      expect(f.calls.filter((call) => call === "dispatch")).toHaveLength(1);
      expect(f.remote.size).toBe(0);
    } finally {
      store.close();
    }
  },
);

test("invisible accepted dispatch keeps its durable cleanup obligation until discovery succeeds", async () => {
  const f = fixture();
  const { ctx, store } = await context(f);
  try {
    const h = await f.stored({ dispatchSent: true });
    ctx.state.gateExecution = { handle: h, sha: req.headSha, stage: "gates", round: 0, purpose: "initial" };
    await ctx.save();
    f.state.visibleAfter = Infinity;
    await expect(runGateExecution(ctx, "gates", "initial", cwd, req.gates)).rejects.toThrow(
      "discovery deadline",
    );
    expect(store.getRunState<RunState>(ctx.run.id)?.gateExecution?.handle.id).toBe(h.id);
    expect(f.remote.size).toBe(2);
    f.state.visibleAfter = 0;
    f.state.runStatus = "in_progress";
    const restarted = new RunContext(ctx.deps, ctx.run, ctx.repo, signal());
    await expect(runGateExecution(restarted, "gates", "initial", cwd, req.gates)).rejects.toThrow(
      "retrying cleanup",
    );
    expect(f.calls).toContain("cancel");
    expect(f.calls).not.toContain("dispatch");
    expect(f.remote.size).toBe(0);
    expect(store.getRunState<RunState>(ctx.run.id)?.gateExecution).toBeUndefined();
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

test("rate limits exhaust the original execution deadline across shutdown and restart", async () => {
  const f = fixture();
  const h = await f.stored({ dispatchSent: true, runId: 17, deadline: f.deps.now() + 3_000 });
  f.state.runStatus = "in_progress";
  const controller = new AbortController();
  f.state.onSleep = () => controller.abort(new Error("shutdown"));
  const gh = f.deps.gh;
  f.deps.gh = async (...args) => {
    if (args[0].includes("--include")) throw new Error("HTTP 429; Retry-After: 2");
    return (await gh(...args)) ?? "";
  };
  await expect(f.run(controller.signal, h)).rejects.toThrow("shutdown");
  expect(f.remote.size).toBe(2);
  expect(f.calls).not.toContain("cancel");
  const durable = structuredClone(f.saved.at(-1));
  f.state.onSleep = () => {};
  await expect(f.run(signal(), durable)).rejects.toThrow("execution deadline");
  expect(f.state.delays).toEqual([2_000, 1_000]);
  expect(f.calls).toContain("cancel");
  expect(f.calls).not.toContain("dispatch");
  expect(f.remote.size).toBe(0);
});

test("ordinary authorization errors do not retry polls", async () => {
  const f = fixture();
  f.state.runStatus = "in_progress";
  const gh = f.deps.gh;
  f.deps.gh = async (...args) => {
    if (args[0].includes("--include")) throw new Error("HTTP 403: Resource not accessible");
    return (await gh(...args)) ?? "";
  };
  await expect(f.run()).rejects.toThrow("Resource not accessible");
  expect(f.state.delays).toEqual([]);
  expect(f.calls).toContain("cancel");
});

test.each(["shutdown", "cancel"])("%s interrupts a pending rate-limit wait", async (reason) => {
  const f = fixture();
  f.state.runStatus = "in_progress";
  const sleeping = Promise.withResolvers<void>();
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
  controller.abort(new Error(reason));
  await expect(run).rejects.toThrow(reason);
  expect(f.calls.includes("cancel")).toBe(reason !== "shutdown");
  expect(f.remote.size).toBe(reason === "shutdown" ? 2 : 0);
});
