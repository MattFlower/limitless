import { afterAll, beforeAll, expect, setDefaultTimeout } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../src/core/types.ts";
import type { GateConfig } from "../src/gates/detect.ts";
import { executeGate, type GateRequest, localExecutor } from "../src/gates/executor.ts";
import {
  type ActionsDependencies,
  type ActionsProgress,
  githubActionsExecutor,
} from "../src/gates/github-actions.ts";
import { compareGates, type GateResult, type GateRun } from "../src/gates/run.ts";
import { deleteBranchAt } from "../src/git/repos.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import type { RunContext, RunState } from "../src/pipeline/context.ts";
import { runGateExecution } from "../src/pipeline/gate-execution.ts";
import { CommandError, registerCredential, sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { test } from "./read-policy-support.ts";

// Real git and the local executor's subprocesses outlast Bun's 5 s default under load (#140).
setDefaultTimeout(30_000);

const MAIN = "a".repeat(40);
const TOKEN = "0123456789abcdef0123456789abcdef";
let dir: string;
let base: string;
let head: string;
let ciHead: string;
const git = (cwd: string, ...args: string[]) => sh(["git", ...args], { cwd });
const commit = async (file: string, text: string) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", file);
  return (await git(dir, "rev-parse", "HEAD")).stdout.trim();
};
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "gate-actions-"));
  await git(dir, "init", "-q", "-b", "main");
  base = await commit("a.txt", "a\n");
  await git(dir, "checkout", "-qb", "ci");
  ciHead = await commit(".github/workflows/x.yml", "on: push\n");
  await git(dir, "checkout", "-q", "main");
  head = await commit("a.txt", "b\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Section {
  output?: string;
  code: number;
  timedOut?: boolean;
}
/** A job log as GitHub serves it: timestamped lines, the token step first, then framed sections. */
const jobLog = (sections: Section[], extra: string[] = []) =>
  [
    "Run token=$(openssl rand -hex 16)",
    `LIMITLESS_TOKEN ${TOKEN}`,
    ...extra,
    ...sections.flatMap((s, i) => [
      `${TOKEN} START ${i}`,
      ...(s.output ?? "").split("\n"),
      "",
      `${TOKEN} END ${i} ${s.code} 5 ${s.timedOut ? 1 : 0}`,
    ]),
  ]
    .map((line) => `2020-01-01T00:00:00.0000000Z ${line}`)
    .join("\n");

interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  log?: string;
}
interface Run {
  id: number;
  status: string;
  head_branch: string;
  event: string;
  created_at: string;
  jobs: Job[];
}
const done = (index: number, log?: string, conclusion = "success"): Job => ({
  id: 100 + index,
  name: `gate ${index}`,
  status: "completed",
  conclusion,
  log,
});

function fakeGitHub(
  jobsFor: (inputs: Record<string, string>) => Job[] = () => [done(0, jobLog([{ code: 0 }]))],
) {
  const calls: string[][] = [];
  const order: string[] = [];
  const refs = new Map<string, string>();
  const runs: Run[] = [];
  const state = { hidden: 0, returnId: true, runStatus: "completed", notModified: 0 };
  const dispatches: { ref: string; return_run_details: boolean; inputs: Record<string, string> }[] = [];
  const clock = { now: Date.parse("2030-01-01T00:00:00Z"), onSleep: async () => {} };
  const gh: GhRunner = async (args, _signal, stdin) => {
    calls.push(args);
    const path = (args[1] ?? "").replace(/^repos\/o\/r\/?/, "");
    const body = stdin ? JSON.parse(stdin) : undefined;
    const match = args.find((a) => a.startsWith("If-None-Match: "))?.slice(15);
    const respond = (data: unknown) => {
      const json = JSON.stringify(data);
      if (!args.includes("--include")) return json;
      const etag = `"${Bun.hash(json)}"`;
      if (match === etag) {
        state.notModified++;
        throw new CommandError("gh: HTTP 304", 1, "HTTP/2.0 304 Not Modified\r\n\r\n", "", false);
      }
      return `HTTP/2.0 200 OK\r\nEtag: ${etag}\r\n\r\n${json}`;
    };
    const run = runs.find((r) => path.startsWith(`actions/runs/${r.id}`));
    if (path === "") return respond({ default_branch: "main" });
    if (path === "commits/main") return respond({ sha: MAIN });
    if (path === "git/refs") {
      const branch = body.ref.slice("refs/heads/".length);
      order.push(`create ${branch}@${body.sha}`);
      if (refs.has(branch))
        throw new CommandError("gh: Reference already exists (HTTP 422)", 1, "", "", false);
      refs.set(branch, body.sha);
      return "{}";
    }
    if (path.startsWith("git/ref/heads/")) {
      const sha = refs.get(path.slice("git/ref/heads/".length));
      if (!sha) throw new CommandError("gh: Not Found (HTTP 404)", 1, "", "", false);
      return respond({ object: { sha } });
    }
    if (path.endsWith("/dispatches")) {
      order.push(`dispatch ${body.ref}`);
      dispatches.push(body);
      const created: Run = {
        id: 7 + runs.length,
        status: state.runStatus,
        head_branch: body.ref,
        event: "workflow_dispatch",
        created_at: "2020-01-01T00:00:00Z",
        jobs: jobsFor(body.inputs),
      };
      runs.push(created);
      return state.returnId
        ? JSON.stringify({
            workflow_run_id: created.id,
            html_url: `https://github.com/o/r/actions/runs/${created.id}`,
          })
        : "";
    }
    if (path.startsWith("actions/workflows/limitless-gates.yml/runs?")) {
      order.push("discover");
      if (state.hidden > 0) {
        state.hidden--;
        return respond({ workflow_runs: [] });
      }
      return respond({ workflow_runs: runs.map(({ jobs: _, ...r }) => r) });
    }
    if (run && path === `actions/runs/${run.id}/cancel`) {
      order.push(`cancel ${run.id}`);
      run.status = "completed";
      for (const job of run.jobs)
        if (job.status !== "completed") Object.assign(job, { status: "completed", conclusion: "cancelled" });
      return "{}";
    }
    if (run && path.startsWith(`actions/runs/${run.id}/jobs?`))
      return respond({ jobs: run.jobs.map(({ log: _, ...j }) => j) });
    if (run && path === `actions/runs/${run.id}`) return respond({ id: run.id, status: run.status });
    const job = runs.flatMap((r) => r.jobs).find((j) => path === `actions/jobs/${j.id}/logs`);
    if (job?.log !== undefined) return job.log;
    if (job) throw new CommandError("gh: HTTP 404: logs not found", 1, "", "", false);
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const deps: ActionsDependencies = {
    gh,
    async push(_req, branch, sha) {
      order.push(`push ${branch}@${sha}`);
      if (refs.has(branch) && refs.get(branch) !== sha) throw new Error("stale info");
      refs.set(branch, sha);
    },
    async deleteBranch(_repo, branch, expected) {
      order.push(`delete ${branch}@${expected}`);
      if (refs.get(branch) === expected) refs.delete(branch);
    },
    now: () => clock.now,
    async sleep(ms) {
      clock.now += ms;
      await clock.onSleep();
    },
  };
  return { executor: githubActionsExecutor(deps), deps, calls, order, refs, runs, state, dispatches, clock };
}

const gates = (checks: GateConfig["checks"], setup: string[] = []): GateConfig => ({
  setup,
  checks,
  source: ".limitless.toml",
  protectedPaths: [],
});
const request = (cfg: GateConfig, headSha = head): GateRequest => ({
  repo: "o/r",
  cwd: dir,
  baseSha: base,
  headSha,
  gates: cfg,
  skipGateSlot: true,
});
const one = gates([{ name: "check", run: "true" }]);
const remote = (fake: ReturnType<typeof fakeGitHub>, cfg = one, signal = new AbortController().signal) =>
  executeGate(request(cfg), signal, {}, fake.executor);

/** The slice of RunContext that runGateExecution reads, with saves recorded in call order. */
function context(
  fake: ReturnType<typeof fakeGitHub>,
  state: Partial<RunState> = {},
  signal = new AbortController().signal,
): RunContext {
  const ctx = {
    state: { round: 0, ...state },
    signal,
    run: { id: "run-1", baseSha: base },
    repo: { slug: "o/r" },
    store: {},
    deps: { gateExecutor: fake.executor, buildSha: "test", cfg: { port: 0 } },
    checkCancelled: () => signal.throwIfAborted(),
    async save() {
      fake.order.push(`save ${JSON.stringify(ctx.state.gateExecution?.handle.progress ?? null)}`);
    },
  } as unknown as RunContext;
  return ctx;
}
const handle = (progress: Partial<ActionsProgress>, sha = head): NonNullable<RunState["gateExecution"]> => ({
  stage: "gates",
  round: 0,
  purpose: "initial",
  sha,
  handle: {
    kind: "github-actions",
    id: "old",
    startedAt: 0,
    progress: {
      repo: "o/r",
      dispatch: "limitless-gates/old/dispatch",
      candidate: "limitless-gates/old/candidate",
      dispatchSha: MAIN,
      candidateSha: sha,
      ...progress,
    },
  },
});
const expr = (name: string) => `\${{ ${name} }}`;

test("the executor is a github-actions executor that reports fresh checkouts", () => {
  const { executor } = fakeGitHub();
  expect(executor.kind).toBe("github-actions");
  expect(executor.freshCheckoutFor?.("o/r")).toBe(true);
});

test("dispatch targets the handle's dispatch branch at the default branch tip, never the default branch", async () => {
  const fake = fakeGitHub();
  const run = await remote(fake);
  expect(run.checks[0]).toMatchObject({ ok: true, exitCode: 0 });
  const [dispatch] = fake.dispatches;
  expect(fake.dispatches).toHaveLength(1);
  expect(dispatch?.ref).toMatch(/^limitless-gates\/[\w-]+\/dispatch$/);
  expect(dispatch?.ref).not.toBe("main");
  expect(dispatch?.return_run_details).toBe(true);
  expect(dispatch?.inputs.sha).toBe(head);
  const candidate = dispatch?.ref.replace(/dispatch$/, "candidate");
  expect(fake.order.slice(0, 3)).toEqual([
    `create ${dispatch?.ref}@${MAIN}`,
    `push ${candidate}@${head}`,
    `dispatch ${dispatch?.ref}`,
  ]);
  // Both branches are gone once the result is in.
  expect(fake.refs.size).toBe(0);
});

test("a candidate that changes CI configuration is refused before any push or gh call", async () => {
  const fake = fakeGitHub();
  await expect(
    executeGate(request(one, ciHead), new AbortController().signal, {}, fake.executor),
  ).rejects.toThrow(".github/workflows/x.yml");
  expect(fake.calls).toEqual([]);
  expect(fake.order).toEqual([]);
});

test("passing, failing, timed-out and setup-failing jobs match the local executor", async () => {
  const failing = "echo '(fail) suite > case [1.00ms]'; echo boom; exit 3";
  const checks = [
    { name: "pass", run: "exit 0" },
    { name: "fail", run: failing },
    { name: "slow", run: "sleep 5", timeoutSec: 1 },
  ];
  const brokenSetup = gates([{ name: "pass", run: "exit 0" }], ["echo prepared", "exit 4"]);
  const local = (cfg: GateConfig) =>
    confinementScope.run(fakeConfinement, () =>
      executeGate(request(cfg), new AbortController().signal, {}, localExecutor()),
    );
  const [localChecks, localSetup] = await Promise.all([local(gates(checks)), local(brokenSetup)]);
  const remoteChecks = await remote(
    fakeGitHub(() => [
      done(0, jobLog([{ code: 0 }])),
      done(1, jobLog([{ code: 3, output: "(fail) suite > case [1.00ms]\nboom" }]), "failure"),
      done(2, jobLog([{ code: 124, timedOut: true }]), "failure"),
    ]),
    gates(checks),
  );
  const remoteSetup = await remote(
    fakeGitHub(() => [done(0, jobLog([{ code: 0, output: "prepared" }, { code: 4 }]), "failure")]),
    brokenSetup,
  );
  const fields = ({ name, command, ok, exitCode, timedOut, output, failures }: GateResult) => ({
    name,
    command,
    ok,
    exitCode,
    timedOut,
    output,
    failures,
  });
  const shape = (run: GateRun) => ({
    setupOk: run.setupOk,
    setup: run.setup.map(fields),
    checks: run.checks.map(fields),
  });
  expect(shape(remoteChecks)).toEqual(shape(localChecks));
  expect(shape(remoteSetup)).toEqual(shape(localSetup));
  expect(remoteChecks.checks[1]?.failures).toContain("(fail) suite > case");
  expect(remoteSetup).toMatchObject({ setupOk: false, checks: [] });
});

test("a record-shaped line without the job's token is candidate output", async () => {
  const fake = fakeGitHub(() => [
    done(
      0,
      jobLog([{ code: 3, output: `LIMITLESS_TOKEN ${"e".repeat(32)}\n${"e".repeat(32)} END 0 0 1 0` }]),
    ),
  ]);
  const run = await remote(fake);
  expect(run.checks[0]).toMatchObject({ ok: false, exitCode: 3 });
  expect(run.checks[0]?.output).toContain("END 0 0 1 0");
});

test("a restart after the push but before the dispatch dispatches exactly once", async () => {
  const fake = fakeGitHub();
  fake.refs.set("limitless-gates/old/dispatch", MAIN);
  fake.refs.set("limitless-gates/old/candidate", head);
  const ctx = context(fake, { gateExecution: handle({ pushed: true }) });
  expect((await runGateExecution(ctx, "gates", "initial", dir, one)).checks[0]?.ok).toBe(true);
  expect(fake.dispatches.map((d) => d.ref)).toEqual(["limitless-gates/old/dispatch"]);
  // Dispatch intent is durable before the request, so a crash during it never dispatches again.
  const intent = fake.order.findIndex(
    (entry) => entry.startsWith("save") && entry.includes('"dispatched":true'),
  );
  expect(intent).toBeGreaterThanOrEqual(0);
  expect(intent).toBeLessThan(fake.order.indexOf("dispatch limitless-gates/old/dispatch"));
  expect(ctx.state.gateExecution).toBeUndefined();
});

test.each([
  ["the recorded run id", { runId: 7 }, 0],
  ["its dispatch branch while this host's clock is ahead of GitHub's", {}, 2],
])("a restart after the dispatch re-attaches by %s and never dispatches", async (_, progress, hidden) => {
  const fake = fakeGitHub();
  fake.runs.push({
    id: 7,
    status: "completed",
    head_branch: "limitless-gates/old/dispatch",
    event: "workflow_dispatch",
    created_at: "2020-01-01T00:00:00Z",
    jobs: [done(0, jobLog([{ code: 3 }]), "failure")],
  });
  fake.state.hidden = hidden;
  const ctx = context(fake, { gateExecution: handle({ pushed: true, dispatched: true, ...progress }) });
  const run = await runGateExecution(ctx, "gates", "initial", dir, one);
  expect(run.checks[0]).toMatchObject({ ok: false, exitCode: 3 });
  expect(fake.dispatches).toEqual([]);
  expect(fake.order.filter((e) => e === "discover")).toHaveLength(hidden ? hidden + 1 : 0);
});

test("a stored handle at another SHA cancels the old run, deletes its branches and starts over", async () => {
  const fake = fakeGitHub();
  const old = "b".repeat(40);
  fake.refs.set("limitless-gates/old/dispatch", MAIN);
  fake.refs.set("limitless-gates/old/candidate", old);
  fake.runs.push({
    id: 7,
    status: "in_progress",
    head_branch: "limitless-gates/old/dispatch",
    event: "workflow_dispatch",
    created_at: "2020-01-01T00:00:00Z",
    jobs: [],
  });
  const ctx = context(fake, { gateExecution: handle({ pushed: true, dispatched: true, runId: 7 }, old) });
  expect((await runGateExecution(ctx, "gates", "initial", dir, one)).checks[0]?.ok).toBe(true);
  const cancel = fake.order.indexOf("cancel 7");
  expect(cancel).toBeGreaterThanOrEqual(0);
  expect(fake.order.indexOf(`delete limitless-gates/old/candidate@${old}`)).toBeGreaterThan(cancel);
  expect(fake.order.indexOf(`delete limitless-gates/old/dispatch@${MAIN}`)).toBeGreaterThan(cancel);
  expect(fake.dispatches).toHaveLength(1);
  expect(fake.dispatches[0]?.ref).not.toContain("/old/");
});

const live = () => {
  const fake = fakeGitHub(() => [{ id: 100, name: "gate 0", status: "in_progress", conclusion: null }]);
  fake.state.runStatus = "in_progress";
  return fake;
};

test("abort cancels the live run, then deletes both branches", async () => {
  const fake = live();
  const controller = new AbortController();
  fake.clock.onSleep = async () => controller.abort();
  await expect(remote(fake, one, controller.signal)).rejects.toThrow();
  const branch = fake.dispatches[0]?.ref ?? "";
  expect(fake.order.slice(-3)).toEqual([
    "cancel 7",
    `delete ${branch.replace(/dispatch$/, "candidate")}@${head}`,
    `delete ${branch}@${MAIN}`,
  ]);
  expect(fake.refs.size).toBe(0);
});

test("daemon shutdown cancels nothing, deletes nothing and keeps the run state", async () => {
  const fake = live();
  const controller = new AbortController();
  fake.clock.onSleep = async () => controller.abort(new Error("shutdown"));
  const ctx = context(fake, {}, controller.signal);
  await expect(runGateExecution(ctx, "gates", "initial", dir, one)).rejects.toThrow("shutdown");
  expect(fake.order.filter((e) => e.startsWith("cancel") || e.startsWith("delete"))).toEqual([]);
  expect(fake.refs.size).toBe(2);
  expect(ctx.state.gateExecution?.handle.progress).toMatchObject({ dispatched: true, runId: 7 });
});

test("a failed cleanup keeps the durable handle so the remote work can still be cleaned up", async () => {
  const fake = fakeGitHub();
  fake.deps.deleteBranch = async () => {
    throw new Error("delete failed");
  };
  const ctx = context(fake);
  await expect(runGateExecution(ctx, "gates", "initial", dir, one)).rejects.toThrow("cleanup failed");
  expect(ctx.state.gateExecution?.handle.progress).toMatchObject({ dispatched: true, runId: 7 });
});

test("discard waits for a dispatched run that is not visible yet, cancels it and deletes both branches", async () => {
  const fake = live();
  const controller = new AbortController();
  fake.clock.onSleep = async () => controller.abort(new Error("shutdown"));
  const ctx = context(fake, {}, controller.signal);
  await expect(runGateExecution(ctx, "gates", "initial", dir, one)).rejects.toThrow("shutdown");
  const stored = ctx.state.gateExecution?.handle;
  if (!stored?.progress) throw new Error("missing handle");
  // As if the dispatch response was lost: only the dispatch branch identifies the run.
  stored.progress = { ...stored.progress, runId: undefined };
  fake.state.hidden = 3;
  fake.clock.onSleep = async () => {};
  const started = fake.clock.now;
  await fake.executor.discard?.(stored);
  expect(fake.order.filter((e) => e === "discover")).toHaveLength(4);
  expect(fake.clock.now - started).toBe(3_000);
  expect(fake.order.slice(-3)).toEqual([
    "cancel 7",
    expect.stringMatching(/candidate@/),
    expect.stringMatching(/dispatch@/),
  ]);
  expect(fake.refs.size).toBe(0);
});

test("discard with nothing dispatched deletes the pushed branches", async () => {
  const fake = fakeGitHub();
  fake.refs.set("limitless-gates/old/dispatch", MAIN);
  fake.refs.set("limitless-gates/old/candidate", head);
  await fake.executor.discard?.(handle({ pushed: true }).handle);
  expect(fake.order).toEqual([
    `delete limitless-gates/old/candidate@${head}`,
    `delete limitless-gates/old/dispatch@${MAIN}`,
  ]);
  expect(fake.refs.size).toBe(0);
  expect(fake.calls).toEqual([]);
});

test("branch deletion leases the pushed SHA and leaves a moved branch alone", async () => {
  const remoteDir = join(dir, "..", `${dir.split("/").pop()}-remote.git`);
  await git(dir, "init", "-q", "--bare", remoteDir);
  try {
    await git(dir, "push", "-q", remoteDir, `${head}:refs/heads/kept`, `${head}:refs/heads/gone`);
    const repo = { kind: "github", url: remoteDir, slug: "o/r" } as Repo;
    await deleteBranchAt(repo, dir, "gone", head);
    await deleteBranchAt(repo, dir, "kept", base);
    await deleteBranchAt(repo, dir, "missing", head);
    const refs = (await git(dir, "ls-remote", remoteDir)).stdout;
    expect(refs).toContain("refs/heads/kept");
    expect(refs).not.toContain("refs/heads/gone");
  } finally {
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("duplicate job names cannot stand in for a missing selected check", async () => {
  const fake = fakeGitHub(() => [
    done(0, jobLog([{ code: 0 }])),
    { ...done(0, jobLog([{ code: 0 }])), id: 101 },
  ]);
  const two = gates([
    { name: "a", run: "true" },
    { name: "b", run: "true" },
  ]);
  await expect(remote(fake, two)).rejects.toThrow("Duplicate or unknown gate job");
});

test("a parsing error on one job cancels the remaining live matrix job", async () => {
  const fake = fakeGitHub(() => [
    done(0, `2020-01-01T00:00:00Z LIMITLESS_TOKEN ${TOKEN}\n${TOKEN} START 0\n${TOKEN} END 0 x 5 0`),
    { id: 101, name: "gate 1", status: "in_progress", conclusion: null },
  ]);
  fake.state.runStatus = "in_progress";
  const two = gates([
    { name: "a", run: "true" },
    { name: "b", run: "true" },
  ]);
  await expect(remote(fake, two)).rejects.toThrow("Invalid gate end record");
  expect(fake.order).toContain("cancel 7");
  expect(fake.order.indexOf("cancel 7")).toBeLessThan(fake.order.findIndex((e) => e.startsWith("delete")));
});

test("a cancelled job stays blocking against a failing baseline and its logs are never fetched", async () => {
  const two = gates([
    { name: "a", run: "true" },
    { name: "b", run: "true" },
  ]);
  // The cancelled job has no logs: fetching them would fail with a 404.
  const fake = fakeGitHub(() => [done(0, jobLog([{ code: 0 }])), done(1, undefined, "cancelled")]);
  const run = await remote(fake, two);
  expect(run.checks[1]).toMatchObject({ name: "b", ok: false, incomplete: true });
  const baseline: GateRun = {
    setupOk: true,
    setup: [],
    checks: two.checks.map((c) => ({
      ...c,
      command: c.run,
      ok: false,
      exitCode: 1,
      durationMs: 1,
      output: "x",
    })),
  };
  expect(compareGates(baseline, run).find((c) => c.name === "b")).toMatchObject({ blocking: true });
});

test("a credential crossing the output tail boundary in setup output does not survive", async () => {
  const secret = "synthetic-actions-credential-861-q7Lm2Xv9";
  registerCredential("gate-github-actions-test", secret);
  // Clipping the 6,000-character tail before redaction would keep the credential's last 19 characters.
  const output = `${secret}\n${"y".repeat(6_000 - 20)}`;
  const fake = fakeGitHub(() => [done(0, jobLog([{ code: 2, output }]), "failure")]);
  const run = await remote(fake, gates([{ name: "check", run: "true" }], ["prepare"]));
  expect(run.setupOk).toBe(false);
  const text = JSON.stringify(run);
  for (let i = 0; i + 8 <= secret.length; i++) expect(text).not.toContain(secret.slice(i, i + 8));
});

test("run and job polls are conditional and a 304 changes nothing", async () => {
  const fake = live();
  let sleeps = 0;
  fake.clock.onSleep = async () => {
    if (++sleeps < 3) return;
    const run = fake.runs[0];
    if (!run) return;
    run.status = "completed";
    run.jobs = [done(0, jobLog([{ code: 0 }]))];
  };
  expect((await remote(fake)).checks[0]?.ok).toBe(true);
  const polls = (suffix: RegExp) =>
    fake.calls.filter((c) => c.includes("--include") && suffix.test(c[1] ?? ""));
  for (const kind of [/runs\/7$/, /runs\/7\/jobs\?/]) {
    const [first, ...later] = polls(kind);
    expect(first?.some((a) => a.startsWith("If-None-Match"))).toBe(false);
    expect(later.length).toBeGreaterThanOrEqual(2);
    for (const call of later) expect(call.some((a) => a.startsWith("If-None-Match: "))).toBe(true);
  }
  expect(fake.state.notModified).toBeGreaterThan(0);
});

test("the gates workflow is dispatch-only, pinned, uncached and refuses the default branch", () => {
  const workflow = Bun.YAML.parse(readFileSync(".github/workflows/limitless-gates.yml", "utf8")) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        "runs-on": string;
        "timeout-minutes"?: unknown;
        steps: {
          name?: string;
          uses?: string;
          run?: string;
          with?: Record<string, unknown>;
          env?: Record<string, string>;
          "timeout-minutes"?: unknown;
        }[];
      }
    >;
  };
  const text = readFileSync(".github/workflows/limitless-gates.yml", "utf8");
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(text).not.toContain("secrets.");
  const jobs = Object.values(workflow.jobs);
  expect(jobs).toHaveLength(1);
  const [job] = jobs;
  if (!job) throw new Error("missing job");
  expect(job["runs-on"]).toBe("ubuntu-24.04");
  expect(job["timeout-minutes"]).toBeUndefined();
  const steps = job.steps;
  for (const step of steps.filter((s) => s.uses)) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
  const checkout = steps.findIndex((s) => s.uses?.startsWith("actions/checkout@"));
  expect(steps[checkout]?.with?.["persist-credentials"]).toBe(false);
  expect(steps.find((s) => s.uses?.startsWith("oven-sh/setup-bun@"))?.with?.["no-cache"]).toBe(true);
  const guard = steps.findIndex(
    (s) =>
      s.env?.REF === expr("github.ref") &&
      s.env.DEFAULT_BRANCH === expr("github.event.repository.default_branch") &&
      s.run?.includes('"$REF" = "refs/heads/$DEFAULT_BRANCH"'),
  );
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(guard).toBeLessThan(checkout);
  const token = steps.findIndex((s) => s.run?.includes('echo "LIMITLESS_TOKEN $token"'));
  expect(token).toBeGreaterThanOrEqual(0);
  expect(token).toBeLessThan(checkout);
  const setup = steps.find((s) => s.name === "Setup");
  const check = steps.find((s) => s.name === "Check");
  expect(setup?.["timeout-minutes"]).toBeDefined();
  expect(check?.["timeout-minutes"]).toBeDefined();
  expect(check?.env?.LIMITLESS_GATE_REPORT).toStartWith(`${expr("runner.temp")}/`);
  // Inputs reach scripts only through env; no expression is ever interpolated into a script.
  for (const step of steps) expect(step.run ?? "").not.toContain("{{");
});
