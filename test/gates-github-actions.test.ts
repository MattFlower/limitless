import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    if (args[0][1]?.endsWith("/dispatches")) expect(f.saved.at(-1)?.githubActions?.dispatchSent).toBe(true);
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
  await f.executor().discard?.(pending);
  expect(f.state.sleeps).toBe(4);
  expect(f.calls.at(-1)).toContain("/candidate:");
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
      expect(ctx.state.gateExecution).toBeUndefined();
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

test("workflow command wrapper hides its token and records failures, setup stops and timeouts", async () => {
  const workflow = Bun.YAML.parse(
    readFileSync(new URL("../.github/workflows/limitless-gates.yml", import.meta.url), "utf8"),
  ) as {
    jobs: { gate: { steps: { name: string; run?: string }[] } };
  };
  const tokenScript = workflow.jobs.gate.steps.find((s) => s.name === "Token")?.run;
  const commandScript = workflow.jobs.gate.steps.find((s) => s.name === "Check")?.run;
  if (!tokenScript || !commandScript) throw new Error("missing gate scripts");
  const env = { ...process.env, RUNNER_TEMP: cwd, GITHUB_OUTPUT: join(cwd, "outputs") };
  const generated = await sh(["bash", "-c", tokenScript], { cwd, env });
  const frame = generated.stdout.match(/LIMITLESS_TOKEN ([a-f\d]{32})/)?.[1];
  if (!frame) throw new Error("missing generated token");
  const commands = [{ run: 'test -z "$FRAME" && echo check-only; exit 9' }, { run: "echo should-not-run" }];
  const failed = await sh(["bash", "-c", commandScript], {
    cwd,
    env: { ...env, FRAME: frame, COMMANDS: JSON.stringify(commands) },
    allowFail: true,
  });
  expect(failed.exitCode).toBe(1);
  expect(failed.stdout).toContain("check-only");
  expect(failed.stdout).toMatch(new RegExp(`LIMITLESS:${frame}:0:9:\\d+:false`));
  expect(failed.stdout).not.toContain("should-not-run");
  const timed = await sh(["bash", "-c", commandScript], {
    cwd,
    env: { ...env, FRAME: frame, COMMANDS: JSON.stringify([{ run: "sleep 10", timeoutSec: 0.01 }]) },
    allowFail: true,
  });
  expect(timed.exitCode).toBe(1);
  expect(timed.stdout).toMatch(new RegExp(`LIMITLESS:${frame}:0:137:\\d+:true`));
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

function workflowScripts() {
  const workflow = Bun.YAML.parse(
    readFileSync(new URL("../.github/workflows/limitless-gates.yml", import.meta.url), "utf8"),
  ) as { jobs: { gate: { steps: { name: string; run?: string }[] } } };
  return ["Setup", "Check"].map((name) => {
    const script = workflow.jobs.gate.steps.find((s) => s.name === name)?.run;
    if (!script) throw new Error(`missing ${name} script`);
    return script;
  });
}
const wrap = (script: string, commands: unknown[]) =>
  sh(["bash", "-c", script], {
    cwd,
    env: { ...process.env, FRAME: token, COMMANDS: JSON.stringify(commands) },
    allowFail: true,
  });

test("candidate Python modules cannot shadow the wrapper's imports to forge a record", async () => {
  writeFileSync(
    join(cwd, "json.py"),
    `import os\nprint("LIMITLESS:" + os.environ["FRAME"] + ":0:0:1:false", flush=True)\nos._exit(0)\n`,
  );
  for (const script of workflowScripts()) {
    const result = await wrap(script, [{ run: "exit 9" }]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain(`LIMITLESS:${token}:0:0:`);
    expect(result.stdout).toMatch(new RegExp(`^LIMITLESS:${token}:0:9:\\d+:false$`, "m"));
  }
});

test("records start on their own line when command output lacks a trailing newline", async () => {
  const [setupScript = "", checkScript = ""] = workflowScripts();
  const setup = await wrap(setupScript, [{ run: "printf setup-output" }]);
  const check = await wrap(checkScript, [{ run: "printf check-output" }]);
  const f = fixture();
  f.state.logs.set(1, log(setup.stdout.trimEnd(), check.stdout.trimEnd()));
  const run = await f.run();
  expect(run.setupOk).toBe(true);
  expect(run.setup[0]).toMatchObject({ ok: true, exitCode: 0 });
  expect(run.checks[0]).toMatchObject({ ok: true, exitCode: 0, incomplete: undefined });
  expect(run.checks[0]?.output).toContain("check-output");
});

test("one failed cleanup step does not skip the others", async () => {
  const f = fixture();
  f.state.runStatus = "in_progress";
  const h = await f.stored({ dispatchSent: true, runId: 17 });
  const remove = f.deps.delete;
  f.deps.delete = async (p, branch, sha) => {
    await remove(p, branch, sha);
    if (branch === p.dispatch) throw new Error("lease rejected");
  };
  const gh = f.deps.gh;
  f.deps.gh = async (...args) => {
    if (args[0][1]?.endsWith("/cancel")) {
      f.calls.push("cancel-failed");
      throw new Error("cancel unavailable");
    }
    return (await gh(...args)) ?? "";
  };
  await expect(f.executor().discard?.(h)).rejects.toThrow(/cancel unavailable.*lease rejected/);
  expect(f.calls).toEqual([
    "cancel-failed",
    `delete:${h.githubActions?.dispatch}:${"d".repeat(40)}`,
    `delete:${h.githubActions?.candidate}:${req.headSha}`,
  ]);
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
    expect(store.getRunState<RunState>(ctx.run.id)?.gateExecution).toBeUndefined();
  } finally {
    store.close();
  }
});
