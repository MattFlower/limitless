import { expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { ExecutionHandle, GateRequest } from "../src/gates/executor.ts";
import { executeGate, localExecutor } from "../src/gates/executor.ts";
import { githubActionsExecutor } from "../src/gates/github-actions.ts";
import type { GateResult, GateRun } from "../src/gates/run.ts";
import { headSha } from "../src/git/repos.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { runGateExecution } from "../src/pipeline/gate-execution.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { pipelineSetup } from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";

const fixture: { home: string; repoDir: string; factory: Factory | null } = {
  home: "",
  repoDir: "",
  factory: null,
};
const { start } = pipelineSetup(fixture);
const expression = (value: string) => `\${{ ${value} }}`;
const signal = new AbortController().signal;
const gates = {
  setup: ["echo setup"],
  checks: [
    { name: "pass", run: "echo pass" },
    { name: "fail", run: "echo fail; exit 1" },
  ],
  source: "none" as const,
  protectedPaths: [],
};
const request = (): GateRequest => ({
  repo: "test/repo",
  cwd: fixture.repoDir,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  gates,
});
const response = (body: unknown, status = 200, etag?: string) =>
  `HTTP/2.0 ${status} OK\r\n${etag ? `ETag: ${etag}\r\n` : ""}\r\n${typeof body === "string" ? body : JSON.stringify(body)}`;
const step = (name: string, conclusion = "success") => ({
  name,
  conclusion,
  started_at: "2026-01-01T00:00:00Z",
  completed_at: "2026-01-01T00:00:01Z",
});
const job = (i: number, conclusion = "success", setup = "success") => ({
  ...step(`gate-${i}`, conclusion),
  id: i + 10,
  status: "completed",
  steps: [step("Setup gates", setup), step("Check gate", conclusion)],
});
type Job = ReturnType<typeof job>;
function fake() {
  const calls: {
    op: string;
    path?: string;
    body?: { ref: string; inputs: Record<string, string> };
    etag?: string;
  }[] = [];
  const runs = new Map<number, { id: number; display_title: string; html_url: string }>();
  const branches = new Set<string>();
  const logs = new Map<number, string>([
    [10, "pass"],
    [11, "fail"],
  ]);
  const sleeping = Promise.withResolvers<void>();
  let clock = 1_000;
  const sleeps: number[] = [];
  const diagnostics: string[] = [];
  const state = {
    jobs: [job(1, "failure"), job(0)],
    replies: [] as (Job[] | 304)[],
    pause: false,
    runConclusion: null as string | null,
    missing: false,
    deleteFails: false,
    dispatchDetails: false,
    visible: true,
    totalCount: undefined as number | undefined,
  };
  const gh: GhRunner = async (args, _signal, stdin) => {
    const path = args[1] ?? "";
    const method = args[args.indexOf("--method") + 1];
    const etag = args.includes("--header") ? args[args.indexOf("--header") + 1] : undefined;
    if (path.endsWith("/dispatches")) {
      const body = JSON.parse(stdin ?? "") as { ref: string; inputs: Record<string, string> };
      calls.push({ op: "dispatch", path, body });
      const id = runs.size + 1;
      const run = {
        id,
        display_title: `limitless-gates/${body.inputs.request_id}`,
        html_url: `https://github.com/test/repo/actions/runs/${id}`,
      };
      runs.set(id, run);
      return state.dispatchDetails
        ? response({ workflow_run_id: id, html_url: run.html_url })
        : response("", 204);
    }
    if (path.includes("/workflows/limitless-gates.yml/runs?")) {
      calls.push({ op: "find", path });
      return response({ workflow_runs: state.visible ? [...runs.values()] : [] });
    }
    if (path.includes("/matching-refs/"))
      return response([...branches].map((branch) => ({ ref: `refs/heads/${branch}` })));
    if (path.endsWith("/cancel") && method === "POST") {
      calls.push({ op: "cancel", path });
      return response("", 202);
    }
    if (path.includes("/jobs?")) {
      calls.push({ op: "jobs", path, etag });
      const jobs = state.replies.shift() ?? state.jobs;
      return jobs === 304
        ? response("", 304)
        : response({ total_count: state.totalCount ?? jobs.length, jobs }, 200, '"jobs-v1"');
    }
    if (path.endsWith("/logs")) {
      calls.push({ op: "logs", path });
      return response(logs.get(Number(path.split("/").at(-2))) ?? "");
    }
    if (/\/actions\/runs\/\d+$/.test(path))
      return response({ status: "in_progress", conclusion: state.runConclusion }, state.missing ? 404 : 200);
    throw new Error(`Unexpected gh: ${args.join(" ")}`);
  };
  const deps = {
    gh,
    log: (message: string) => diagnostics.push(message),
    now: () => clock,
    pollIntervalMs: 7,
    discoveryTimeoutMs: 21,
    defaultBranch: async () => "main",
    push: async (_req: GateRequest, branch: string) => {
      calls.push({ op: "push", path: branch });
      branches.add(branch);
    },
    deleteBranch: async (_repo: string, branch: string) => {
      calls.push({ op: "delete", path: branch });
      if (state.deleteFails) throw new Error("delete failed");
      branches.delete(branch);
    },
    sleep: async (ms: number, abort: AbortSignal) => {
      sleeps.push(ms);
      clock += ms;
      if (!state.pause) {
        abort.throwIfAborted();
        return;
      }
      sleeping.resolve();
      await new Promise<void>((_resolve, reject) => {
        if (abort.aborted) reject(abort.reason);
        else abort.addEventListener("abort", () => reject(abort.reason), { once: true });
      });
    },
  };
  return {
    deps,
    calls,
    runs,
    branches,
    state,
    logs,
    sleeps,
    sleeping,
    diagnostics,
    executor: () => githubActionsExecutor(deps),
  };
}
const project = (r: GateRun) => ({
  setupOk: r.setupOk,
  setup: r.setup.map(fields),
  checks: r.checks.map(fields),
});
const fields = ({ name, command, ok, exitCode, timedOut }: GateResult) => ({
  name,
  command,
  ok,
  exitCode,
  timedOut,
});

test.each([false, true])("remote results agree with local gates (setup fails=%s)", async (setupFails) => {
  const req = request();
  if (setupFails) req.gates = { ...gates, setup: ["echo setup; exit 1"] };
  const f = fake();
  if (setupFails) f.state.jobs = [job(0, "failure", "failure"), job(1, "failure", "failure")];
  const local = await confinementScope.run(fakeConfinement, () =>
    executeGate(req, signal, {}, localExecutor()),
  );
  const events: GateResult[] = [];
  const remote = await executeGate(req, signal, { onResult: (r) => events.push(r) }, f.executor());
  expect(project(remote)).toEqual(project(local));
  if (!setupFails) {
    expect(remote.checks.map((c) => c.output)).toEqual(["pass", "fail"]);
    expect(remote.checks.map((c) => c.durationMs)).toEqual([1000, 1000]);
    expect(events.filter((e) => e.name === "pass")).toHaveLength(1);
  }
  expect(f.calls.filter((c) => c.op === "logs")).toHaveLength(2);
  expect(f.calls.at(-1)?.op).toBe("delete");
});

test("conditional jobs polls retain ETags across 304 and use only the injected clock", async () => {
  const f = fake();
  f.state.replies = [
    [
      { ...job(0), status: "in_progress" },
      { ...job(1), status: "queued" },
    ],
    304,
    304,
    f.state.jobs,
  ];
  await executeGate(request(), signal, {}, f.executor());
  expect(f.calls.filter((c) => c.op === "jobs").map((c) => c.etag)).toEqual([
    undefined,
    'If-None-Match: "jobs-v1"',
    'If-None-Match: "jobs-v1"',
    'If-None-Match: "jobs-v1"',
  ]);
  expect(f.sleeps).toEqual([7, 7, 7]);
});

test("identity is persisted before push and dispatch, and returned run details set its URL", async () => {
  const f = fake();
  f.state.dispatchDetails = true;
  let stored: ExecutionHandle | undefined;
  const req = request();
  await executeGate(req, signal, {}, f.executor(), undefined, async (handle) => {
    stored = handle;
    expect(f.calls).toEqual([]);
  });
  expect(f.calls.filter((c) => ["push", "dispatch"].includes(c.op)).map((c) => c.op)).toEqual([
    "push",
    "dispatch",
  ]);
  expect(f.calls.find((c) => c.op === "dispatch")).toMatchObject({
    path: "repos/test/repo/actions/workflows/limitless-gates.yml/dispatches",
    body: {
      ref: "main",
      inputs: {
        base_sha: req.baseSha,
        head_sha: req.headSha,
        request_id: stored?.id,
        setup: JSON.stringify(gates.setup),
      },
    },
  });
  const checks = JSON.parse(f.calls.find((c) => c.op === "dispatch")?.body?.inputs.checks ?? "[]");
  expect(checks.map((c: { name: string; run: string }) => [c.name, c.run])).toEqual(
    gates.checks.map((c) => [c.name, c.run]),
  );
  expect(stored?.url).toBe("https://github.com/test/repo/actions/runs/1");
  expect(f.calls.some((c) => c.op === "find")).toBe(false);
});

async function context(f: ReturnType<typeof fake>, abort = signal) {
  const factory = start(() => ({}), false, false, { gateExecutor: f.executor() });
  await factory.stop();
  const repo = factory.store.upsertRepo({
    slug: "test/repo",
    kind: "local",
    url: fixture.repoDir,
    localPath: fixture.repoDir,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = factory.store.createRun(repo, { repo: repo.slug, prompt: "gates" });
  return {
    factory,
    ctx: new RunContext(factory.deps, run, repo, abort),
    restore: () => new RunContext(factory.deps, run, repo, signal),
  };
}

test("shutdown preserves the pipeline handle and a fresh executor reattaches without another dispatch", async () => {
  const f = fake();
  f.state.pause = true;
  f.state.replies = [
    [
      { ...job(0), status: "in_progress" },
      { ...job(1), status: "queued" },
    ],
  ];
  const controller = new AbortController();
  const { factory, ctx, restore } = await context(f, controller.signal);
  const pending = runGateExecution(ctx, "gates", "initial", fixture.repoDir, gates).catch((e: unknown) => e);
  await f.sleeping.promise;
  const handle = ctx.state.gateExecution?.handle;
  controller.abort(new Error("shutdown"));
  expect(await pending).toBeInstanceOf(Error);
  expect(ctx.state.gateExecution?.handle).toEqual(handle);
  expect(f.calls.some((c) => ["cancel", "delete"].includes(c.op))).toBe(false);
  factory.deps.gateExecutor = f.executor();
  f.state.pause = false;
  const restored = restore();
  expect(
    (await runGateExecution(restored, "gates", "initial", fixture.repoDir, gates)).checks.map((c) => c.ok),
  ).toEqual([true, false]);
  expect(f.calls.filter((c) => c.op === "dispatch")).toHaveLength(1);
  expect(f.calls.filter((c) => c.op === "push")).toHaveLength(1);
  expect(restored.state.gateExecution).toBeUndefined();
});

test.each(["sha", "stage", "round", "purpose"])(
  "a stored %s mismatch discards the old job before dispatching anew",
  async (mismatch) => {
    const f = fake();
    const { ctx } = await context(f);
    const handle = { kind: "github-actions" as const, id: "test/repo/old-nonce", startedAt: 1000 };
    f.runs.set(1, {
      id: 1,
      display_title: `limitless-gates/${handle.id}`,
      html_url: "https://github.com/test/repo/actions/runs/1",
    });
    ctx.state.gateExecution = {
      handle,
      stage: mismatch === "stage" ? "prepare" : "gates",
      round: mismatch === "round" ? 99 : ctx.state.round,
      purpose: mismatch === "purpose" ? "baseline" : "initial",
      sha: mismatch === "sha" ? "old-sha" : await headSha(fixture.repoDir),
    };
    await ctx.save();
    await runGateExecution(ctx, "gates", "initial", fixture.repoDir, gates);
    expect(
      f.calls.filter((c) => ["cancel", "delete", "push", "dispatch"].includes(c.op)).map((c) => c.op),
    ).toEqual(["cancel", "delete", "push", "dispatch", "delete"]);
    expect(f.calls.find((c) => c.op === "cancel")?.path).toEndWith("/actions/runs/1/cancel");
    expect(ctx.state.gateExecution).toBeUndefined();
  },
);

test("owner abort cancels once before branch deletion and rejects its result", async () => {
  const f = fake();
  f.state.pause = true;
  f.state.replies = [[{ ...job(0), status: "in_progress" }]];
  const controller = new AbortController();
  const executor = f.executor();
  const handle = await executor.start(request(), controller.signal);
  const execution = executor.attach(handle, controller.signal);
  const result = execution.result.catch((e: unknown) => e);
  await f.sleeping.promise;
  controller.abort(new Error("owner cancelled"));
  expect(await result).toBeInstanceOf(Error);
  await execution.cancel();
  await execution.cancel();
  expect(f.calls.filter((c) => ["cancel", "delete"].includes(c.op)).map((c) => c.op)).toEqual([
    "cancel",
    "delete",
  ]);
});

test("branch deletion failure does not alter the completed GateRun", async () => {
  const f = fake();
  f.state.deleteFails = true;
  expect((await executeGate(request(), signal, {}, f.executor())).checks.map((c) => c.ok)).toEqual([
    true,
    false,
  ]);
  expect(f.calls.at(-1)?.op).toBe("delete");
  expect(f.diagnostics[0]).toContain("delete failed");
});

test.each(["cancelled", "missing"])("a remote run that is %s rejects instead of passing", async (kind) => {
  const f = fake();
  f.state.missing = kind === "missing";
  f.state.runConclusion = kind === "cancelled" ? "cancelled" : null;
  await expect(executeGate(request(), signal, {}, f.executor())).rejects.toThrow();
  expect(f.calls.at(-1)?.op).toBe("delete");
});

test("a candidate workflow edit cannot change the default-branch workflow dispatch", async () => {
  const dir = join(fixture.repoDir, ".github/workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "limitless-gates.yml"), "on: push\njobs: {}\n");
  await sh(["git", "add", ".github"], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "candidate workflow edit"], { cwd: fixture.repoDir });
  const f = fake();
  const req = { ...request(), headSha: await headSha(fixture.repoDir) };
  await executeGate(req, signal, {}, f.executor());
  expect(f.calls.find((c) => c.op === "dispatch")).toMatchObject({
    path: "repos/test/repo/actions/workflows/limitless-gates.yml/dispatches",
    body: { ref: "main", inputs: { head_sha: req.headSha } },
  });
});

test("dispatch workflow has a read-only pinned matrix and treats inputs as environment data", () => {
  const source = readFileSync(new URL("../.github/workflows/limitless-gates.yml", import.meta.url), "utf8");
  const workflow = Bun.YAML.parse(source) as {
    on: Record<string, { inputs: Record<string, unknown> }>;
    permissions: unknown;
    "run-name": string;
    jobs: {
      gate: {
        "runs-on": string;
        "timeout-minutes": string;
        strategy: { "fail-fast": boolean; matrix: { check: string } };
        steps: {
          name?: string;
          uses?: string;
          run?: string;
          env?: Record<string, string>;
          with?: Record<string, unknown>;
        }[];
      };
    };
  };
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(Object.keys(workflow.on.workflow_dispatch?.inputs ?? {}).sort()).toEqual([
    "base_sha",
    "checks",
    "head_sha",
    "request_id",
    "setup",
  ]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(source).not.toContain("secrets.");
  expect(workflow["run-name"]).toContain("inputs.request_id");
  const job = workflow.jobs.gate;
  expect(job["runs-on"]).toBe("ubuntu-24.04");
  expect(job.strategy).toEqual({
    "fail-fast": false,
    matrix: { check: expression("fromJSON(inputs.checks)") },
  });
  expect(job["timeout-minutes"]).toBe(expression("matrix.check.timeout"));
  for (const step of job.steps) {
    if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    if (step.run) expect(step.run).not.toContain("${{");
  }
  const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  expect(checkout?.with).toEqual({ ref: expression("inputs.head_sha"), "persist-credentials": false });
  const validation = job.steps[0];
  expect(validation?.env).toEqual({
    BASE_SHA: expression("inputs.base_sha"),
    HEAD_SHA: expression("inputs.head_sha"),
  });
  expect(validation?.run?.match(/\^\[a-fA-F0-9\]\{40\}\$/g)).toHaveLength(2);
  expect(job.steps.findIndex((s) => s.name === "Setup gates")).toBeLessThan(
    job.steps.findIndex((s) => s.name === "Check gate"),
  );
});

test.each([false, true])(
  "a pre-attach restart dispatches only when the scratch branch is absent (exists=%s)",
  async (exists) => {
    const f = fake();
    const executor = f.executor();
    const req = request();
    const handle = await executor.start(req, signal);
    if (exists) f.branches.add(`limitless-gates/${handle.id}`);
    const resumed = f.executor();
    const result = resumed.attach(handle, signal, req).result;
    if (exists) {
      await expect(result).rejects.toThrow("did not become visible");
      expect(f.sleeps).toEqual([7, 7, 7]);
      expect(f.calls.some((c) => ["push", "dispatch"].includes(c.op))).toBe(false);
    } else {
      expect((await result).checks.map((c) => c.ok)).toEqual([true, false]);
      expect(f.calls.filter((c) => c.op === "dispatch")).toHaveLength(1);
    }
  },
);

test("setup markers preserve command ordering, failure boundaries and decoded redaction", async () => {
  const f = fake();
  const secret = "synthetic-remote-setup-credential-817";
  registerCredential("REMOTE_SETUP_TEST", secret);
  const req = request();
  req.gates = { ...gates, setup: ["echo first", "echo second; exit 3", "echo never"] };
  f.state.jobs = [job(0, "failure", "failure"), job(1, "failure", "failure")];
  const markers = [
    { ok: true, exitCode: 0, durationMs: 12, output: `first ${secret}` },
    { ok: false, exitCode: 3, durationMs: 14, output: "second" },
  ]
    .map(
      (result, i) =>
        `LIMITLESS_SETUP_${i}=${JSON.stringify(result).replaceAll("synthetic", "\\u0073ynthetic")}`,
    )
    .join("\n");
  for (const j of f.state.jobs) f.logs.set(j.id, markers);
  const remote = await executeGate(req, signal, {}, f.executor());
  const local = await confinementScope.run(fakeConfinement, () =>
    executeGate(req, signal, {}, localExecutor()),
  );
  expect(project(remote)).toEqual(project(local));
  expect(remote.setup.map((s) => s.output)).toEqual(["first [redacted]", "second"]);
  expect(remote.checks).toEqual([]);
});

test("setup log claims cannot override a failing setup step", async () => {
  const f = fake();
  f.state.jobs = [job(0, "failure", "failure"), job(1, "failure", "failure")];
  for (const j of f.state.jobs)
    f.logs.set(j.id, 'LIMITLESS_SETUP_0={"ok":true,"exitCode":0,"durationMs":1,"output":"claimed pass"}');
  const result = await executeGate(request(), signal, {}, f.executor());
  expect(result.setupOk).toBe(false);
  expect(result.checks).toEqual([]);
});

test("timed-out jobs are failures with a null exit code and redacted output tails", async () => {
  const f = fake();
  const req = { ...request(), checks: ["pass"] };
  f.state.jobs = [job(0, "timed_out")];
  const secret = "synthetic-remote-log-credential-817";
  registerCredential("REMOTE_LOG_TEST", secret);
  f.logs.set(10, `${"x".repeat(7000)}${secret}`);
  const result = await executeGate(req, signal, {}, f.executor());
  expect(result.checks).toHaveLength(1);
  expect(result.checks[0]).toMatchObject({ name: "pass", ok: false, exitCode: null, timedOut: true });
  expect(result.checks[0]?.output).toBe(`[timed out]\n${`${"x".repeat(7000)}[redacted]`.slice(-6000)}`);
});

test("workflow setup script reports separate commands and stops at the first failure", async () => {
  const workflow = Bun.YAML.parse(
    readFileSync(new URL("../.github/workflows/limitless-gates.yml", import.meta.url), "utf8"),
  ) as { jobs: { gate: { steps: { name?: string; run?: string }[] } } };
  const script = workflow.jobs.gate.steps.find((s) => s.name === "Setup gates")?.run;
  if (!script) throw new Error("Missing setup script");
  const result = await sh(["bash", "-c", script], {
    cwd: fixture.repoDir,
    env: { ...process.env, SETUP: JSON.stringify(["echo first", "echo second; exit 3", "echo never"]) },
    allowFail: true,
  });
  expect(result.exitCode).toBe(3);
  expect(result.stdout).toContain('LIMITLESS_SETUP_0={"ok": true, "exitCode": 0');
  expect(result.stdout).toContain('LIMITLESS_SETUP_1={"ok": false, "exitCode": 3');
  expect(result.stdout).not.toContain("never");
});

test("paginated jobs keep independent conditional caches and fetch each completed log once", async () => {
  const f = fake();
  const jobs = Array.from({ length: 101 }, (_, i) => job(i));
  const req = {
    ...request(),
    gates: { ...gates, setup: [], checks: jobs.map((_, i) => ({ name: `check-${i}`, run: "true" })) },
  };
  f.state.totalCount = 101;
  f.state.replies = [jobs.slice(0, 100), [{ ...job(100), status: "in_progress" }], 304, [job(100)]];
  const result = await executeGate(req, signal, {}, f.executor());
  expect(result.checks).toHaveLength(101);
  expect(result.checks.every((c) => c.ok)).toBe(true);
  expect(f.calls.filter((c) => c.op === "jobs").map((c) => [c.path?.includes("page=2"), c.etag])).toEqual([
    [false, undefined],
    [true, undefined],
    [false, 'If-None-Match: "jobs-v1"'],
    [true, 'If-None-Match: "jobs-v1"'],
  ]);
  expect(f.calls.filter((c) => c.op === "logs")).toHaveLength(101);
  expect(f.sleeps).toEqual([7]);
});

test("discard finds the run without its request and cancels it idempotently", async () => {
  const f = fake();
  const handle = { kind: "github-actions" as const, id: "test/repo/discarded", startedAt: 1234 };
  f.runs.set(1, {
    id: 1,
    display_title: `limitless-gates/${handle.id}`,
    html_url: "https://github.com/test/repo/actions/runs/1",
  });
  const executor = f.executor();
  await Promise.all([executor.discard?.(handle), executor.discard?.(handle)]);
  expect(f.calls.filter((c) => ["cancel", "delete"].includes(c.op)).map((c) => c.op)).toEqual([
    "cancel",
    "delete",
  ]);
  const path = f.calls.find((c) => c.op === "find")?.path;
  expect(new URL(`https://api.github.com/${path}`).searchParams.get("created")).toBe(
    ">=1970-01-01T00:00:01.000Z",
  );
  f.calls.length = 0;
  await f.executor().discard?.({ ...handle, id: "test/repo/missing" });
  expect(f.calls.map((c) => c.op)).toEqual(["find"]);
});

test("abort during dispatch discovers an eventually visible run before cancelling and deleting", async () => {
  const f = fake();
  const controller = new AbortController();
  f.state.visible = false;
  const gh = f.deps.gh;
  f.deps.gh = async (args, signal, stdin) => {
    const result = await gh(args, signal, stdin);
    if (args[1]?.endsWith("/dispatches")) controller.abort(new Error("owner cancelled during dispatch"));
    return result ?? "";
  };
  const sleep = f.deps.sleep;
  f.deps.sleep = async (ms, active) => {
    if (!active.aborted) f.state.visible = true;
    await sleep(ms, active);
  };
  await expect(executeGate(request(), controller.signal, {}, f.executor())).rejects.toThrow();
  expect(f.calls.filter((c) => ["cancel", "delete"].includes(c.op)).map((c) => c.op)).toEqual([
    "cancel",
    "delete",
  ]);
  expect(f.calls.filter((c) => c.op === "dispatch")).toHaveLength(1);
});

test("completed jobs emit check events while another matrix job is still running", async () => {
  const f = fake();
  f.state.pause = true;
  f.state.replies = [[job(0), { ...job(1), status: "in_progress" }]];
  const req = { ...request(), gates: { ...gates, setup: [] } };
  const executor = f.executor();
  const execution = executor.attach(await executor.start(req, signal), signal);
  const rejected = execution.result.catch((e: unknown) => e);
  const event = await execution.events[Symbol.asyncIterator]().next();
  expect(event.value).toMatchObject({ type: "check", phase: "check", result: { name: "pass", ok: true } });
  expect(f.calls.filter((c) => c.op === "logs")).toHaveLength(1);
  await execution.cancel();
  expect(await rejected).toBeInstanceOf(Error);
});

test("a successful job without a successful check step cannot pass a gate", async () => {
  const f = fake();
  f.state.jobs = [{ ...job(0), steps: [] }];
  const req = { ...request(), checks: ["pass"], gates: { ...gates, setup: [] } };
  const result = await executeGate(req, signal, {}, f.executor());
  expect(result.checks[0]).toMatchObject({ ok: false, exitCode: 1 });
});

test("an empty matrix cannot report successful setup that never executed", async () => {
  const f = fake();
  await expect(executeGate({ ...request(), checks: [] }, signal, {}, f.executor())).rejects.toThrow(
    "at least one selected check",
  );
  expect(f.calls.some((c) => ["push", "dispatch"].includes(c.op))).toBe(false);
});
