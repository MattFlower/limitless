import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { ExecutionHandle, GateExecutor, GateRequest } from "../src/gates/executor.ts";
import { gateExecutorFor, localExecutor } from "../src/gates/executor.ts";
import { type GateRun, retryBaselineFailures } from "../src/gates/run.ts";
import { gateSlots } from "../src/gates/slots.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import { LandQueue } from "../src/land/queue.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import { runGateExecution } from "../src/pipeline/gate-execution.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { deferred } from "./evals-support.ts";
import { approve, type Handler, pipelineSetup, roleOf, triage, waitFor } from "./pipeline-support.ts";

const fixture: { home: string; repoDir: string; factory: Factory | null } = {
  home: "",
  repoDir: "",
  factory: null,
};
const { start, githubFixture, registerGithub, advanceBase, assertUnpublished } = pipelineSetup(fixture);
const handler: Handler = (s) => {
  const role = roleOf(s);
  if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
  if (role === "review") return { structured: approve };
  return { files: { "farewell.txt": "goodbye\n" } };
};
const gates = {
  setup: [],
  checks: [{ name: "check", run: "true" }],
  source: "none" as const,
  protectedPaths: [],
};
const request = (cwd: string): GateRequest => ({
  repo: "test/repo",
  cwd,
  baseSha: "base",
  headSha: "head",
  gates,
});
const result = (req: GateRequest, ok = true): GateRun => ({
  setupOk: true,
  setup: [],
  checks: req.gates.checks.map((c) => ({
    name: c.name,
    command: c.run,
    ok,
    exitCode: ok ? 0 : 1,
    durationMs: 1,
    output: ok ? "pass" : "farewell.txt:12: failure",
  })),
});
function fake(
  onAttach: (h: ExecutionHandle, req: GateRequest) => Promise<GateRun>,
  kind: GateExecutor["kind"] = "lan",
) {
  const requests = new Map<string, GateRequest>();
  const starts: ExecutionHandle[] = [];
  const attaches: ExecutionHandle[] = [];
  const executor: GateExecutor = {
    kind,
    async start(req) {
      const handle = { kind, id: String(starts.length + 1), startedAt: Date.now() };
      starts.push(handle);
      requests.set(handle.id, req);
      return handle;
    },
    attach(h, _signal, rebuilt) {
      attaches.push(h);
      const req = rebuilt ?? requests.get(h.id) ?? request(fixture.repoDir);
      const completed = onAttach(h, req);
      return {
        result: completed,
        events: {
          async *[Symbol.asyncIterator]() {
            const run = await completed;
            for (const r of run.setup) yield { type: "check" as const, phase: "setup" as const, result: r };
            for (const r of run.checks) yield { type: "check" as const, phase: "check" as const, result: r };
          },
        },
        async cancel() {},
      };
    },
  };
  return { executor, starts, attaches, requests };
}

async function context(executor?: GateExecutor) {
  const f = start(handler, false, false, { gateExecutor: executor });
  await f.stop();
  const repo = f.store.upsertRepo({
    slug: "test/repo",
    kind: "local",
    url: fixture.repoDir,
    localPath: fixture.repoDir,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = f.store.createRun(repo, { repo: repo.slug, prompt: "gates" });
  const ctx = new RunContext(f.deps, run, repo, new AbortController().signal);
  return { f, ctx, restore: () => new RunContext(f.deps, run, repo, new AbortController().signal) };
}

test("executor selection defaults to config and an injected instance overrides it", async () => {
  expect(gateExecutorFor("local").kind).toBe("local");
  const f = start(handler);
  expect(f.deps.gateExecutor?.kind).toBe("local");
  await f.stop();
  f.store.close();
  const injected = fake(async (_h, req) => result(req)).executor;
  expect(start(handler, false, false, { gateExecutor: injected }).deps.gateExecutor).toBe(injected);
});

test("a rejected execution clears its durable handle before another attempt", async () => {
  const scripted = fake(async (h, req) => {
    if (h.id === "1") throw new Error("execution failed");
    return result(req);
  });
  const { f, ctx } = await context(scripted.executor);
  await expect(runGateExecution(ctx, "gates", "initial", fixture.repoDir, gates)).rejects.toThrow(
    "execution failed",
  );
  expect(f.store.getRunState<RunState>(ctx.run.id)?.gateExecution).toBeUndefined();
  expect((await runGateExecution(ctx, "gates", "initial", fixture.repoDir, gates)).checks[0]?.ok).toBe(true);
  expect(scripted.starts).toHaveLength(2);
  expect(scripted.attaches.map((h) => h.id)).toEqual(["1", "2"]);
});

test.each([
  ["initial", "pending"],
  ["initial", "after-result"],
  ["rebase", "pending"],
  ["rebase", "after-result"],
] as const)("restart runs a moved %s head afresh (%s)", async (purpose, checkpoint) => {
  const interrupted = deferred<void>();
  const scripted = fake(async (_h, req) => ({
    ...result(req),
    checks: result(req).checks.map((r) => ({ ...r, output: req.headSha })),
  }));
  const bare = purpose === "rebase" ? await githubFixture() : undefined;
  const runHandler: Handler = async (spec) => {
    if (bare && roleOf(spec) === "review") await advanceBase(bare, "base.txt", "base advanced\n");
    return handler(spec);
  };
  const f = start(runHandler, false, false, {
    gateExecutor: scripted.executor,
    faults:
      checkpoint === "pending"
        ? {
            "store:save": {
              action: "kill",
              when: (c) =>
                c.checkpoint === "gate-result" &&
                f.store.getRunState<RunState>(c.runId)?.gateExecution?.purpose === purpose,
              onHit: () => interrupted.resolve(),
            },
          }
        : {
            "stage:gates:after": {
              action: "kill",
              when: (c) =>
                f.store.getRunState<RunState>(c.runId)?.phase === (purpose === "rebase" ? "deliver" : "loop"),
              onHit: () => interrupted.resolve(),
            },
          },
  });
  if (bare) registerGithub(f, bare);
  const run = await f.createRun({
    repo: bare ? "test/repo" : fixture.repoDir,
    prompt: "Add farewell",
    profile: "quick",
  });
  await interrupted.promise;
  await f.stop();
  if (bare) await assertUnpublished(bare);
  const state = f.store.getRunState<RunState>(run.id);
  const cwd = state?.worktreePath;
  if (!cwd) throw new Error("missing checkout");
  const oldHead = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
  writeFileSync(join(cwd, "farewell.txt"), "moved commit\n");
  await sh(["git", "add", "farewell.txt"], { cwd });
  await sh(["git", "commit", "--amend", "-qm", "moved head"], { cwd });
  const moved = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
  expect(moved).not.toBe(oldHead);
  f.store.close();
  const fresh = fake(async (_h, req) => ({
    ...result(req),
    checks: result(req).checks.map((r) => ({ ...r, output: req.headSha })),
  }));
  const resumed = start(handler, false, false, { gateExecutor: fresh.executor });
  expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(fresh.starts).toHaveLength(1);
  expect(fresh.attaches).toEqual(fresh.starts);
  expect(fresh.requests.get("1")?.headSha).toBe(moved);
  if (purpose === "initial")
    expect(resumed.store.getRunState<RunState>(run.id)?.gateEvidence?.sha).toBe(moved);
  else expect(resumed.store.getRunState<RunState>(run.id)?.lastGates?.[0]?.result.output).toBe(moved);
  expect(resumed.store.getRun(run.id)?.headSha).toBe(moved);
});

test.each([false, true])("setup-dependent retries remain flaky after restart (%s)", async (restart) => {
  const counter = join(fixture.home, "counter");
  const check = `test -f node_modules/ready || { echo missing-setup; exit 1; }; if test -f farewell.txt; then n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'; test $((n%2)) -eq 0 || { echo transient; exit 1; }; fi`;
  writeFileSync(join(fixture.repoDir, ".gitignore"), "node_modules/\n");
  writeFileSync(
    join(fixture.repoDir, ".limitless.toml"),
    `[gates]\nsetup = ["mkdir -p node_modules; touch node_modules/ready"]\nchecks = [{ name = "check", run = ${JSON.stringify(check)} }]\n`,
  );
  await sh(["git", "add", "."], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "setup-dependent gate"], { cwd: fixture.repoDir });
  const interrupted = deferred<void>();
  const f = start(
    handler,
    false,
    false,
    restart
      ? {
          faults: {
            "store:save": {
              action: "kill",
              when: (c) =>
                c.checkpoint === "gate-result" &&
                f.store.getRunState<RunState>(c.runId)?.gateExecution?.purpose === "regression-retry",
              onHit: () => interrupted.resolve(),
            },
          },
        }
      : {},
  );
  const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell", profile: "quick" });
  let finished = f;
  if (restart) {
    await interrupted.promise;
    await f.stop();
    expect(f.store.getRunState<RunState>(run.id)?.gateExecution?.purpose).toBe("regression-retry");
    f.store.close();
    finished = start(handler);
  }
  expect(await waitFor(finished, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(finished.store.getRunState<RunState>(run.id)?.lastGates?.[0]).toMatchObject({
    verdict: "flaky",
    blocking: false,
    firstAttempt: { output: "transient" },
  });
  expect(finished.store.getRunState<RunState>(run.id)?.round).toBe(0);
});

test("credential-bearing commands retry and replay from an identity without executable data", async () => {
  const secret = "synthetic-gate-credential-486";
  registerCredential("gate-executor-test", secret);
  const counter = join(fixture.home, "attempted");
  const expected = join(fixture.home, "expected-secret");
  writeFileSync(expected, secret);
  const cfg = {
    ...gates,
    checks: [
      {
        name: "secret",
        run: `test "$(cat '${expected}')" = '${secret}' || exit 1; echo '${secret}'; if test -f '${counter}'; then exit 0; else touch '${counter}'; exit 1; fi`,
      },
    ],
  };
  const { f, ctx, restore } = await context();
  ctx.state.gatesConfig = cfg;
  await confinementScope.run(fakeConfinement, async () => {
    const baseline = await runGateExecution(ctx, "prepare", "baseline", fixture.repoDir, cfg);
    expect(baseline.checks[0]?.command).toContain(secret);
    const retried = await retryBaselineFailures(
      baseline,
      fixture.repoDir,
      cfg,
      ctx.signal,
      undefined,
      (retry) => runGateExecution(ctx, "prepare", "baseline-retry", fixture.repoDir, retry),
    );
    expect(retried.checks[0]).toMatchObject({ ok: true, firstAttempt: { ok: false } });
    f.deps.faults = { "store:save": { action: "kill", when: (c) => c.checkpoint === "gate-result" } };
    const interrupted = restore();
    await expect(runGateExecution(interrupted, "prepare", "baseline", fixture.repoDir, cfg)).rejects.toThrow(
      "terminated",
    );
    const saved = f.store.getRunState<RunState>(ctx.run.id);
    expect(saved?.gateExecution).toBeDefined();
    expect(saved?.gateExecution?.handle).not.toHaveProperty("request");
    expect(saved?.gateExecution).not.toHaveProperty("gates");
    expect(JSON.stringify(saved)).not.toContain(secret);
    f.deps.faults = undefined;
    f.deps.gateExecutor = localExecutor();
    expect(
      (await runGateExecution(restore(), "prepare", "baseline", fixture.repoDir, cfg)).checks[0]?.ok,
    ).toBe(true);
  });
});

test.each([true, false])("executor results decide gate verdicts (pass=%s)", async (passing) => {
  const scripted = fake(async (h, req) => result(req, h.id === "1" || passing));
  const f = start(handler, false, false, { gateExecutor: scripted.executor });
  f.deps.cfg.maxRounds = 1;
  const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell", profile: "quick" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
    passing ? "succeeded" : "needs_human",
  );
  expect(f.store.getRunState<RunState>(run.id)?.lastGates?.[0]).toMatchObject({
    verdict: passing ? "pass" : "regressed",
    blocking: !passing,
  });
  expect(f.store.listEvents(run.id).some((e) => e.type === "gate" && e.message.startsWith("no-bad:"))).toBe(
    true,
  );
  expect(scripted.starts.length).toBeGreaterThanOrEqual(2);
  expect(scripted.attaches).toEqual(scripted.starts);
  expect(f.store.listStages(run.id).findLast((s) => s.name === "gates")?.summary).toContain(
    passing ? "checks ok" : "blocking",
  );
});

test("the handle is durable before attach/result, and cleared after consumption", async () => {
  const ready = deferred<void>();
  const pending = deferred<GateRun>();
  let f: Factory;
  let req: GateRequest | undefined;
  const scripted = fake(async (h, r) => {
    const runs = f.store.listRuns();
    const run = runs[0];
    if (!run) throw new Error("no run");
    expect(f.store.getRunState<RunState>(run.id)?.gateExecution?.handle).toEqual(h);
    if (h.id === "1") return result(r);
    req = r;
    ready.resolve();
    return pending.promise;
  });
  f = start(handler, false, false, { gateExecutor: scripted.executor });
  const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell", profile: "quick" });
  await ready.promise;
  expect(f.store.getRunState<RunState>(run.id)?.gateExecution).toMatchObject({
    stage: "gates",
    round: 0,
    handle: { kind: "lan", id: "2" },
  });
  if (!req) throw new Error("no request");
  pending.resolve(result(req));
  expect(await waitFor(f, run.id, ["succeeded", "failed"])).toBe("succeeded");
  expect(f.store.getRunState<RunState>(run.id)?.gateExecution).toBeUndefined();
});

test.each(["initial", "regression-retry", "timeout", "baseline-retry"])(
  "restart reattaches the first execution but replays setup for pending %s",
  async (purpose) => {
    const interrupted = deferred<void>();
    const scripted = fake(async (h, req) => {
      if (purpose === "baseline-retry" && h.id === "1") return result(req, false);
      if ((purpose === "regression-retry" || purpose === "timeout") && h.id === "2") {
        const run = result(req, false);
        if (purpose === "timeout") for (const c of run.checks) c.timedOut = true;
        else for (const c of run.checks) c.output = "transient error";
        return run;
      }
      return result(req);
    });
    const f = start(handler, false, false, {
      gateExecutor: scripted.executor,
      faults: {
        "store:save": {
          action: "kill",
          when: (c) =>
            c.checkpoint === "gate-result" &&
            f.store.getRunState<RunState>(c.runId)?.gateExecution?.purpose === purpose,
          onHit: () => interrupted.resolve(),
        },
      },
    });
    const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell", profile: "quick" });
    await interrupted.promise;
    await f.stop();
    const state = f.store.getRunState<RunState>(run.id);
    const handle = state?.gateExecution?.handle;
    expect(handle).toBeDefined();
    f.store.close();
    const fresh = fake(async (h, req) => {
      const run = result(req);
      if ((purpose === "regression-retry" || purpose === "timeout") && h.id === "1") {
        for (const c of run.checks) {
          c.ok = false;
          c.output = "transient error";
          if (purpose === "timeout") c.timedOut = true;
        }
      }
      return run;
    });
    const resumed = start(handler, false, false, { gateExecutor: fresh.executor });
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    if (purpose === "initial") {
      expect(fresh.attaches[0]).toEqual(handle);
      expect(fresh.starts).toHaveLength(0);
    } else {
      expect(fresh.attaches).not.toContainEqual(handle);
      expect(fresh.starts).toHaveLength(2);
    }
    expect(resumed.store.getRunState<RunState>(run.id)?.gateExecution).toBeUndefined();
    if (purpose === "regression-retry")
      expect(resumed.store.getRunState<RunState>(run.id)?.lastGates?.[0]).toMatchObject({
        verdict: "flaky",
        firstAttempt: { ok: false },
      });
    if (purpose === "timeout") expect(resumed.store.getRunState<RunState>(run.id)?.gateTimeoutReruns).toBe(2);
  },
);

test("normal cancellation cancels an in-flight execution exactly once", async () => {
  const ready = deferred<void>();
  const pending = deferred<GateRun>();
  let cancels = 0;
  const scripted = fake(async (h, req) => {
    if (h.id === "1") return result(req);
    ready.resolve();
    return pending.promise;
  });
  const attach = scripted.executor.attach.bind(scripted.executor);
  scripted.executor.attach = (h, signal) => {
    const execution = attach(h, signal);
    execution.cancel = async () => {
      cancels++;
      pending.resolve({ setupOk: true, setup: [], checks: [] });
    };
    return execution;
  };
  const f = start(handler, false, false, { gateExecutor: scripted.executor });
  const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell", profile: "quick" });
  await ready.promise;
  f.cancelRun(run.id);
  expect(await waitFor(f, run.id, ["cancelled", "failed"])).toBe("cancelled");
  expect(cancels).toBe(1);
  expect(f.store.listStages(run.id).findLast((s) => s.name === "gates")?.status).toBe("cancelled");
});

test("legacy gates state with no handle resumes on local", async () => {
  const interrupted = deferred<void>();
  const f = start(handler, false, false, {
    faults: { "stage:gates:before": { action: "kill", onHit: () => interrupted.resolve() } },
  });
  const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell", profile: "quick" });
  await interrupted.promise;
  await f.stop();
  expect(f.store.getRunState<RunState>(run.id)?.gateExecution).toBeUndefined();
  f.store.close();
  const resumed = start(handler);
  expect(await waitFor(resumed, run.id, ["succeeded", "failed"])).toBe("succeeded");
  expect(
    resumed.store.listEvents(run.id).some((e) => e.type === "gate" && e.message?.startsWith("no-bad: pass")),
  ).toBe(true);
  expect(readFileSync(join(fixture.repoDir, "greeting.txt"), "utf8")).toBe("hello\n");
});

test("local attachment replays an unknown handle, reuses known work and emits checks", async () => {
  const signal = new AbortController().signal;
  const handle = await localExecutor().start(request(fixture.repoDir), signal);
  const executor = localExecutor();
  await confinementScope.run(fakeConfinement, async () => {
    const execution = executor.attach(JSON.parse(JSON.stringify(handle)), signal, request(fixture.repoDir));
    expect(executor.attach(handle, signal)).toBe(execution);
    expect((await execution.result).checks[0]?.ok).toBe(true);
    const events = [];
    for await (const event of execution.events) events.push(event);
    expect(events).toMatchObject([{ type: "check", result: { name: "check", ok: true } }]);
  });
});

test("local cancel is idempotent and stops work queued for a slot", async () => {
  const previous = gateSlots.limit;
  gateSlots.setLimit(1);
  const signal = new AbortController().signal;
  const release = await gateSlots.acquire(signal);
  try {
    const executor = localExecutor();
    const handle = await executor.start(request(fixture.repoDir), signal);
    const execution = executor.attach(handle, signal);
    const settled = execution.result.catch(() => undefined);
    await execution.cancel();
    await execution.cancel();
    expect(await settled).toBeUndefined();
  } finally {
    release();
    gateSlots.setLimit(previous);
  }
});

test.each(["injected", "local"])("landing checks log setup and check events once (%s)", async (kind) => {
  writeFileSync(
    join(fixture.repoDir, ".limitless.toml"),
    '[gates]\nsetup = ["echo setup"]\nchecks = [{ name = "no-bad", run = "echo check; false" }]\n',
  );
  await sh(["git", "add", "."], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "gate log fixture"], { cwd: fixture.repoDir });
  const f = start(handler);
  await f.stop();
  const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: fixture.repoDir })).stdout.trim();
  await sh(["git", "branch", "candidate"], { cwd: fixture.repoDir });
  const repo = f.store.upsertRepo({
    slug: "test/repo",
    kind: "github",
    url: join(fixture.repoDir, ".git"),
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = f.store.createRun(repo, { repo: repo.slug, prompt: "land" });
  const prUrl = "https://github.com/test/repo/pull/1";
  f.store.updateRun(run.id, {
    status: "succeeded",
    branch: "candidate",
    baseBranch: "main",
    baseSha: sha,
    headSha: sha,
    prUrl,
  });
  f.store.recordApproval(run.id, prUrl, sha, "test");
  const blocked = deferred<void>();
  const scripted = fake(async (_h, req) => ({
    ...result(req, false),
    setup: [
      {
        name: "setup",
        command: req.gates.setup[0] ?? "",
        ok: true,
        exitCode: 0,
        durationMs: 1,
        output: "setup",
      },
    ],
  }));
  const queue = new LandQueue({
    store: f.store,
    paths: f.deps.cfg.paths,
    confinement: fakeConfinement,
    gateExecutor: kind === "local" ? localExecutor() : scripted.executor,
    client: async () => ({
      url: prUrl,
      headRefOid: sha,
      state: "OPEN",
      mergedAt: null,
      mergedBy: null,
      ci: "SUCCESS",
      failing: [],
    }),
    gh: async () => {
      throw new Error("Unexpected GitHub call");
    },
    log: (message) => {
      if (message.includes("blocked")) blocked.resolve();
    },
  });
  try {
    const entry = await queue.request({ target: run.id });
    await blocked.promise;
    expect(f.store.getLandEntry(entry.id)).toMatchObject({
      state: "blocked",
      reason: expect.stringContaining("no-bad failed"),
    });
    const logPath = f.store.getLandEntry(entry.id)?.logPath;
    if (!logPath) throw new Error("missing land log");
    const log = readFileSync(logPath, "utf8");
    expect(log.split("$ echo setup")).toHaveLength(2);
    expect(log.split("$ echo check; false")).toHaveLength(2);
    if (kind === "injected") {
      expect(scripted.starts).toHaveLength(1);
      expect(scripted.attaches).toEqual(scripted.starts);
      expect(scripted.requests.get("1")).toMatchObject({ repo: repo.slug, baseSha: sha, headSha: sha });
    }
  } finally {
    await queue.stop();
  }
});

test("local check events stream before completion and the start signal cancels running work", async () => {
  const controller = new AbortController();
  const executor = localExecutor();
  const req = request(fixture.repoDir);
  req.gates = {
    ...gates,
    checks: [
      { name: "first", run: "true" },
      { name: "pending", run: "sleep 900" },
    ],
  };
  const handle = await executor.start(req, controller.signal);
  await confinementScope.run(fakeConfinement, async () => {
    const execution = executor.attach(handle, new AbortController().signal);
    try {
      const event = await execution.events[Symbol.asyncIterator]().next();
      expect(event.value).toMatchObject({ type: "check", result: { name: "first", ok: true } });
    } finally {
      controller.abort();
    }
    const completed = await execution.result;
    expect(completed.checks.length).toBeLessThanOrEqual(2);
    expect(completed.checks.find((c) => c.name === "pending")?.ok ?? false).toBe(false);
    await execution.cancel();
  });
});
