import { expect, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import { auditDiff } from "../src/gates/audit.ts";
import { baselineCacheKey, cacheableBaseline } from "../src/gates/cache.ts";
import { detectGates } from "../src/gates/detect.ts";
import type { ExecutionHandle, GateExecutor, GateRequest, GateRunner } from "../src/gates/executor.ts";
import { executeGate, gateExecutorFor, localExecutor } from "../src/gates/executor.ts";
import { redactGateData } from "../src/gates/output.ts";
import {
  compareGates,
  confinementFailed,
  type GateRun,
  retryBaselineFailures,
  retryRegressions,
} from "../src/gates/run.ts";
import { gateSlots } from "../src/gates/slots.ts";
import { readPolicyScope } from "../src/harness/read-policy.ts";
import { type ConfinementBackend, confinementScope } from "../src/harness/sandbox.ts";
import { LandQueue } from "../src/land/queue.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import { runGateExecution } from "../src/pipeline/gate-execution.ts";
import { formatGateFeedback } from "../src/pipeline/prompts.ts";
import { renderReport } from "../src/pipeline/report.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import { fakeConfinement, recordingConfinement } from "./confinement.ts";
import { deferred } from "./evals-support.ts";
import {
  approve,
  type Handler,
  holdout,
  pipelineSetup,
  roleOf,
  spec,
  triage,
  waitFor,
} from "./pipeline-support.ts";
import { expectProcessStopped } from "./process-support.ts";
import { test, testReadPolicy } from "./read-policy-support.ts";

const fixture: { home: string; repoDir: string; factory: Factory | null } = {
  home: "",
  repoDir: "",
  factory: null,
};
const { start, githubFixture, registerGithub, advanceBase, assertUnpublished, wait } = pipelineSetup(fixture);
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
  writeFileSync(
    join(fixture.repoDir, ".limitless.toml"),
    `[gates]\nchecks = [{ name = ${JSON.stringify("colored\x1b[31m")}, run = "true" }]\n`,
  );
  await sh(["git", "add", "."], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "formatted gate identity"], { cwd: fixture.repoDir });
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
  expect(fresh.requests.get("1")?.priority).toBe("finish");
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
    `[gates]\nsetup = ["mkdir -p node_modules; rm -f node_modules/ready"]\nchecks = [{ name = "build", run = "touch node_modules/ready" }, { name = "check", run = ${JSON.stringify(check)} }]\n`,
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
  expect(
    finished.store.getRunState<RunState>(run.id)?.lastGates?.find((c) => c.name === "check"),
  ).toMatchObject({
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
    expect(JSON.stringify(saved?.gateExecution)).not.toContain(secret);
    expect(saved?.gatesConfig).toEqual(cfg);
    f.deps.faults = undefined;
    f.deps.gateExecutor = localExecutor();
    expect(
      (await runGateExecution(restore(), "prepare", "baseline", fixture.repoDir, cfg)).checks[0]?.ok,
    ).toBe(true);
  });
});

test.each([
  ["credential", false],
  ["credential", true],
  ["escape", false],
  ["escape", true],
] as const)("gate inputs survive gate-started restart (%s, restart=%s)", async (kind, restart) => {
  const literal = kind === "credential" ? "synthetic-resume-credential-486" : "\x1b[31moriginal";
  if (kind === "credential") registerCredential("gate-resume-test", literal);
  const script = `test "$(cat expected.txt)" = '${literal}'`;
  const command = `bun run check && ${script}`;
  writeFileSync(join(fixture.repoDir, "expected.txt"), literal);
  writeFileSync(join(fixture.repoDir, "package.json"), JSON.stringify({ scripts: { check: script } }));
  writeFileSync(
    join(fixture.repoDir, ".limitless.toml"),
    `[gates]\nchecks = [{ name = "check", run = ${JSON.stringify(command)} }]\n`,
  );
  await sh(["git", "add", "."], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "literal gate inputs"], { cwd: fixture.repoDir });
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
              when: (c) => c.stage === "gates" && c.checkpoint === "gate-started",
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
    const saved = f.store.getRunState<RunState>(run.id);
    expect(saved?.gatesConfig?.checks[0]?.run).toBe(command);
    expect(saved?.baselineScripts?.check).toBe(script);
    f.store.close();
    finished = start(handler);
  }
  expect(await waitFor(finished, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  const state = finished.store.getRunState<RunState>(run.id);
  expect(state?.gatesConfig?.checks[0]?.run).toBe(command);
  expect(state?.baselineScripts?.check).toBe(script);
  expect(state?.lastGates?.[0]?.result.command).toBe(command);
  expect(state?.lastGates?.[0]).toMatchObject({ verdict: "pass", blocking: false });
  expect(state?.lastAudit?.some((f) => f.rule === "gate-script-changed")).toBe(false);
  const row = finished.store.db.query("SELECT gate_run FROM passing_baselines").get() as {
    gate_run: string;
  } | null;
  if (!row) throw new Error("missing baseline cache");
  expect(
    cacheableBaseline(JSON.parse(row.gate_run), { ...gates, checks: [{ name: "check", run: command }] }),
  ).toBe(true);
  const observable = JSON.stringify([
    finished.store.getArtifact(run.id, "gates-0.json"),
    finished.store.listEvents(run.id),
    finished.store.getArtifact(run.id, "baseline-gates.json"),
  ]);
  expect(observable).not.toContain(JSON.stringify(literal).slice(1, -1));
});

test("changed baseline script diagnostics stay redacted after gate-started restart", async () => {
  const secret = "synthetic-baseline-script-credential-486";
  registerCredential("baseline-script-test", secret);
  const script = `true # ${secret}`;
  const candidate = JSON.stringify({ scripts: { check: "true" } });
  writeFileSync(join(fixture.repoDir, "package.json"), JSON.stringify({ scripts: { check: script } }));
  writeFileSync(
    join(fixture.repoDir, ".limitless.toml"),
    '[gates]\nchecks = [{ name = "check", run = "bun run check" }]\n',
  );
  await sh(["git", "add", "."], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "baseline script credential"], { cwd: fixture.repoDir });
  const changeScript: Handler = (s) =>
    roleOf(s) === "implement" ? { files: { "package.json": candidate } } : handler(s);
  const interrupted = deferred<void>();
  const f = start(changeScript, false, false, {
    faults: {
      "store:save": {
        action: "kill",
        when: (c) => c.stage === "gates" && c.checkpoint === "gate-started",
        onHit: () => interrupted.resolve(),
      },
    },
  });
  const run = await f.createRun({ repo: fixture.repoDir, prompt: "Change check", profile: "quick" });
  await interrupted.promise;
  await f.stop();
  expect(f.store.getRunState<RunState>(run.id)?.baselineScripts).toEqual({ check: script });
  f.store.close();
  const resumed = start(changeScript);
  resumed.deps.cfg.maxRounds = 1;
  expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
  const state = resumed.store.getRunState<RunState>(run.id);
  expect(state?.baselineScripts).toEqual({ check: script });
  expect(state?.lastAudit?.find((finding) => finding.rule === "gate-script-changed")).toMatchObject({
    severity: "block",
    detail: "[redacted diagnostic]",
  });
  const events = resumed.store.listEvents(run.id).filter((event) => event.type === "audit");
  expect(events.length).toBeGreaterThan(0);
  expect(state?.feedback).toContain("[redacted diagnostic]");
  expect(resumed.store.getRun(run.id)?.error).toContain("Last feedback:");
  expect(JSON.stringify([events, state?.feedback, resumed.store.getRun(run.id)?.error])).not.toContain(
    secret,
  );
  if (!state) throw new Error("missing resumed state");
  const report = renderReport({
    success: false,
    runId: run.id,
    prompt: run.prompt,
    state,
    invocations: [],
    totals: { costUsd: 0, costEquivUsd: 0 },
    runUrl: "https://example.com/run",
  });
  expect(report).toContain("[redacted diagnostic]");
  expect(report).not.toContain(secret);
  const colored = `${secret.slice(0, 12)}\x1b[31m${secret.slice(12)}\x1b[0m`;
  const fresh = auditDiff(
    { patch: "", files: [], stat: "", added: 0, removed: 0 },
    {
      taskClass: "question",
      protectedPaths: [],
      gateScripts: { before: { check: script }, after: { check: `true # ${colored} changed` } },
      toolCommands: [`git commit --no-verify -m '${colored}'`],
    },
  );
  expect(fresh.map((finding) => finding.detail)).toEqual(["[redacted diagnostic]", "[redacted diagnostic]"]);
});

test.each([
  ["local", "formatting"],
  ["local", "credential"],
  ["github", "formatting"],
  ["github", "credential"],
])("prepare refuses colliding gate names before %s delivery (%s)", async (repoKind, kind) => {
  const secret = "synthetic-gate-name-collision-486";
  if (kind === "credential") registerCredential("gate-name-collision", secret);
  const sanitized = kind === "formatting" ? "check" : "check [redacted]";
  const names = [sanitized, kind === "formatting" ? "check\x1b[31m" : `check ${secret}`];
  writeFileSync(
    join(fixture.repoDir, ".limitless.toml"),
    `[gates]\nchecks = [${names.map((name) => `{ name = ${JSON.stringify(name)}, run = "false" }`).join(", ")}]\n`,
  );
  await sh(["git", "add", "."], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "colliding gate identities"], { cwd: fixture.repoDir });
  const bare = repoKind === "github" ? await githubFixture() : undefined;
  const scripted = fake(async (_h, req) => result(req));
  const f = start(handler, false, false, { gateExecutor: scripted.executor });
  if (bare) registerGithub(f, bare);
  const run = await f.createRun({
    repo: bare ? "test/repo" : fixture.repoDir,
    prompt: "Add farewell",
    profile: "quick",
  });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("failed");
  const error = `.limitless.toml gate names must stay distinct once sanitized: "${sanitized}"`;
  expect(f.store.getRun(run.id)?.error).toBe(error);
  const events = f.store.listEvents(run.id);
  expect(events.some((event) => event.message?.includes(error))).toBe(true);
  expect(JSON.stringify([f.store.getRun(run.id)?.error, events])).not.toContain(secret);
  expect(scripted.starts).toHaveLength(0);
  if (bare) await assertUnpublished(bare);
});

test.each([
  ["implement", "formatting"],
  ["comparison", "formatting"],
  ["comparison", "late credential"],
  ["comparison", "literal duplicate"],
  ["post-merge", "literal duplicate"],
  ["comparison", "distinct"],
  ["comparison", "single ESC"],
] as const)("stored gate names on %s resume: %s", async (boundary, kind) => {
  const secret = `synthetic-stored-gate-${boundary}-${kind}-486`;
  const collision = kind !== "distinct" && kind !== "single ESC";
  if (kind !== "late credential") registerCredential("stored-gate-resume-test", secret);
  writeFileSync(
    join(fixture.repoDir, ".limitless.toml"),
    '[gates]\nchecks = [{ name = "first", run = "true" }, { name = "second", run = "true" }]\n',
  );
  await sh(["git", "add", "."], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "distinct gate identities"], { cwd: fixture.repoDir });
  const bare = await githubFixture();
  const interrupted = deferred<void>();
  const scripted = fake(async (_h, req) => result(req));
  const f = start(handler, false, false, {
    gateExecutor: scripted.executor,
    faults: {
      [boundary === "implement"
        ? "stage:implement:before"
        : boundary === "post-merge"
          ? "stage:deliver:before"
          : "stage:gates:before"]: {
        action: "kill",
        onHit: () => interrupted.resolve(),
      },
    },
  });
  registerGithub(f, bare);
  const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
  await interrupted.promise;
  await f.stop();
  await assertUnpublished(bare);
  const saved = f.store.getRunState<RunState>(run.id);
  if (!saved?.gatesConfig) throw new Error("missing stored gate configuration");
  expect(saved.phase).toBe(boundary === "post-merge" ? "deliver" : "loop");
  expect(saved.implementedRound).toBe(boundary === "implement" ? undefined : 0);
  if (boundary === "post-merge") {
    const head = f.store.getRun(run.id)?.headSha;
    if (!head) throw new Error("missing approved head");
    expect(saved.lastVerifiedSha).toBe(head);
  }
  const sanitized = "check [redacted]";
  const names =
    kind === "single ESC"
      ? ["check\x1b[31m"]
      : kind === "distinct"
        ? ["check\x1b[31m", `other ${secret}`]
        : kind === "formatting"
          ? [`check ${secret}`, `check\x1b[31m ${secret}`]
          : kind === "late credential"
            ? [sanitized, `check ${secret}`]
            : [`check ${secret}`, `check ${secret}`];
  if (kind === "late credential") {
    // Detection succeeded before this credential was known; resuming must validate it again.
    writeFileSync(
      join(fixture.repoDir, ".limitless.toml"),
      `[gates]\nchecks = [${names.map((name) => `{ name = ${JSON.stringify(name)}, run = "true" }`).join(", ")}]\n`,
    );
    saved.gatesConfig = detectGates(fixture.repoDir);
    expect(saved.gatesConfig.checks.map((check) => check.name)).toEqual(names);
    registerCredential("stored-gate-late-registration-test", secret);
  } else {
    // Legacy persisted configurations can predate detection-time validation entirely.
    saved.gatesConfig.checks = names.map((name) => ({ name, run: "true" }));
  }
  // Legacy evidence was produced by these same names; only its observable copy is sanitized.
  saved.baseline = result({ ...request(saved.worktreePath ?? fixture.repoDir), gates: saved.gatesConfig });
  if (saved.lastGates) saved.lastGates = compareGates(saved.baseline, saved.baseline);
  f.store.setRunState(run.id, saved);
  const eventsBefore = f.store.listEvents(run.id).length;
  const recordedBase = f.store.getRun(run.id)?.baseSha;
  if (!recordedBase) throw new Error("missing recorded base");
  let base = recordedBase;
  if (boundary === "post-merge") base = await advanceBase(bare, "base.txt", "base advanced\n");
  f.store.close();
  const fresh = fake(async (_h, req) => result(req));
  let invocations = 0;
  const resumed = start(
    (s) => {
      invocations++;
      return handler(s);
    },
    false,
    false,
    { gateExecutor: fresh.executor },
  );
  const status = await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"]);
  const finished = resumed.store.getRun(run.id);
  const events = resumed.store.listEvents(run.id);
  if (collision) {
    expect(status).toBe(boundary === "post-merge" ? "needs_human" : "failed");
    const error = `.limitless.toml gate names must stay distinct once sanitized: "${sanitized}"`;
    expect(finished?.error).toBe(error);
    expect(events.some((event) => event.message?.includes(error))).toBe(true);
    expect(JSON.stringify([finished?.error, events])).not.toContain(secret);
    expect(JSON.stringify([finished?.error, events])).not.toContain("\\u001b");
    expect(fresh.starts).toHaveLength(0);
    expect(fresh.attaches).toHaveLength(0);
    expect(invocations).toBe(0);
    expect(events.slice(eventsBefore).some((event) => event.type === "gate")).toBe(false);
    expect(finished?.prUrl).toBeNull();
    expect(finished?.merged).toBe(false);
    expect(
      (await sh(["git", "for-each-ref", "--format=%(refname)", "refs/heads/limitless"], { cwd: bare }))
        .stdout,
    ).toBe("");
    const ghCalls = existsSync(join(fixture.home, "gh-calls"))
      ? readFileSync(join(fixture.home, "gh-calls"), "utf8")
      : "";
    expect(ghCalls).not.toMatch(/pr (create|merge|comment)/);
    expect((await sh(["git", "rev-parse", "main"], { cwd: bare })).stdout.trim()).toBe(base);
  } else {
    expect(status).toBe("succeeded");
    expect(fresh.starts).toHaveLength(1);
    expect(resumed.store.getRunState<RunState>(run.id)?.lastGates).toHaveLength(names.length);
    expect(
      resumed.store
        .getRunState<RunState>(run.id)
        ?.lastGates?.every((check) => check.verdict === "pass" && !check.blocking),
    ).toBe(true);
  }
});

test("formatted gate identities keep baseline verdicts after gate-started restart", async () => {
  const name = "colored\x1b[31m";
  writeFileSync(
    join(fixture.repoDir, ".limitless.toml"),
    `[gates]\nchecks = [{ name = ${JSON.stringify(name)}, run = "false" }]\n`,
  );
  await sh(["git", "add", "."], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "formatted gate identity"], { cwd: fixture.repoDir });
  const interrupted = deferred<void>();
  const f = start(handler, false, false, {
    faults: {
      "store:save": {
        action: "kill",
        when: (c) => c.stage === "gates" && c.checkpoint === "gate-started",
        onHit: () => interrupted.resolve(),
      },
    },
  });
  const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell", profile: "quick" });
  await interrupted.promise;
  await f.stop();
  expect(f.store.getRunState<RunState>(run.id)?.baseline?.checks[0]).toMatchObject({
    name,
    ok: false,
  });
  f.store.close();
  const resumed = start(handler);
  resumed.deps.cfg.maxRounds = 1;
  await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"]);
  const state = resumed.store.getRunState<RunState>(run.id);
  expect(state?.gatesConfig?.checks[0]?.name).toBe(name);
  expect(state?.lastGates?.[0]).toMatchObject({
    name,
    verdict: "still_failing",
    blocking: false,
  });
  const outward = JSON.stringify([
    resumed.store.listEvents(run.id),
    resumed.store.getArtifact(run.id, "baseline-gates.json"),
    resumed.store.getArtifact(run.id, "gates-0.json"),
  ]);
  expect(outward).toContain("colored");
  expect(outward).not.toContain("\\u001b");
  expect(resumed.store.getRun(run.id)?.status).toBe("succeeded");
  const cfg = { ...gates, checks: [{ name, run: "false", timeoutSec: 37 }] };
  const baseline = state?.baseline;
  if (!baseline) throw new Error("missing baseline");
  const retry: GateRunner = async (selected) => {
    expect(selected.checks).toEqual(cfg.checks);
    return result({ ...request(fixture.repoDir), gates: selected });
  };
  const signal = new AbortController().signal;
  const retried = await retryBaselineFailures(baseline, fixture.repoDir, cfg, signal, undefined, retry);
  expect(retried.checks[0]).toMatchObject({ ok: true, firstAttempt: { ok: false } });
  const regression = compareGates(
    { ...baseline, checks: baseline.checks.map((check) => ({ ...check, ok: true })) },
    baseline,
  );
  const flaky = await retryRegressions(regression, fixture.repoDir, cfg, [], signal, undefined, retry);
  expect(flaky[0]).toMatchObject({ verdict: "flaky", blocking: false, firstAttempt: { ok: false } });
  expect(
    formatGateFeedback(
      regression.map((check) => ({ ...check, result: { ...check.result, timedOut: true } })),
      cfg,
    ),
  ).toContain("timed out after 37 s");
});

test("reload preserves literal control state while redacting legacy feedback", async () => {
  const literal = "synthetic-state-credential-486\x1b[31m";
  registerCredential("gate-state-test", "synthetic-state-credential-486");
  const { f, ctx, restore } = await context();
  ctx.state.spec = { ...spec, summary: literal };
  ctx.state.holdout = {
    scenarios: [
      {
        ...holdout.scenarios[0],
        id: "H-1",
        description: literal,
        steps: literal,
        expected: literal,
        edge_case: false,
      },
    ],
  };
  ctx.state.feedback = literal;
  ctx.state.answers = [literal];
  ctx.state.gatesConfig = { ...gates, checks: [{ name: "check", run: literal }] };
  ctx.state.baselineScripts = { check: literal };
  // Baseline identities decide verdicts after a resume; retry history keeps a check uncitable.
  const name = "\x1b[31mcheck";
  const passing = { name, command: "true", ok: true, exitCode: 0, durationMs: 1, output: "pass" };
  ctx.state.baseline = { setupOk: true, setup: [], checks: [passing] };
  ctx.state.gateEvidence = {
    stageId: 1,
    sha: "a".repeat(40),
    checks: [
      {
        name,
        verdict: "pass",
        blocking: false,
        testCommand: "bun test",
        result: passing,
        firstAttempt: { ...passing, ok: false, exitCode: 1 },
      },
    ],
  };
  await ctx.save();
  expect(f.store.getRunState<RunState>(ctx.run.id)).toMatchObject({
    spec: { summary: literal },
    holdout: { scenarios: [{ description: literal, steps: literal, expected: literal }] },
    feedback: literal,
    answers: [literal],
    gatesConfig: { checks: [{ run: literal }] },
    baselineScripts: { check: literal },
  });
  const resumed = restore();
  expect(resumed.state.spec).toEqual(ctx.state.spec);
  expect(resumed.state.holdout).toEqual(ctx.state.holdout);
  expect(resumed.state.feedback).toBe("[redacted]");
  expect(resumed.state.answers).toEqual([literal]);
  expect(resumed.state.gatesConfig?.checks[0]?.run).toBe(literal);
  expect(resumed.state.baselineScripts?.check).toBe(literal);
  expect(resumed.state.baseline?.checks[0]?.name).toBe(name);
  expect(resumed.state.gateEvidence?.checks[0]).toMatchObject({ name, firstAttempt: { ok: false } });
});

test.each(["hook", "purpose", "sha"] as const)(
  "forgotten local execution stops before replacement (%s)",
  async (reason) => {
    const executor = localExecutor();
    const { ctx, f } = await context(executor);
    const pidFile = join(fixture.home, "gate-child.pid");
    const req = request(fixture.repoDir);
    req.gates = {
      ...gates,
      checks: [
        { name: "first", run: "true" },
        { name: "pending", run: `echo $$ > '${pidFile}'; exec sleep 900` },
      ],
    };
    await confinementScope.run(fakeConfinement, async () => {
      const handle = await executor.start(req, ctx.signal);
      const execution = executor.attach(handle, ctx.signal);
      const settled = execution.result.catch(() => undefined);
      try {
        const deadline = Date.now() + 5_000;
        while (!existsSync(pidFile) || !/^[1-9]\d*$/.test(readFileSync(pidFile, "utf8").trim())) {
          if (Date.now() > deadline) throw new Error("gate child did not start");
          await Bun.sleep(10);
        }
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        process.kill(pid, 0);
        expect(gateSlots.snapshot().occupied).toBe(1);
        const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: fixture.repoDir })).stdout.trim();
        ctx.state.gateExecution = {
          stage: "gates",
          round: 0,
          purpose: reason === "purpose" ? "rebase" : "initial",
          sha: reason === "sha" ? "stale" : sha,
          handle,
        };
        await ctx.save();
        const start = executor.start.bind(executor);
        executor.start = (...args) => {
          expectProcessStopped(pid);
          expect(gateSlots.snapshot().occupied).toBe(0);
          return start(...args);
        };
        const failure = new Error("log write failed");
        const hooks = {
          onResult() {
            if (reason === "hook") throw failure;
            expectProcessStopped(pid);
          },
        };
        const attempt = runGateExecution(ctx, "gates", "initial", fixture.repoDir, gates, hooks);
        if (reason === "hook") await expect(attempt).rejects.toBe(failure);
        else expect((await attempt).checks[0]?.ok).toBe(true);
        expectProcessStopped(pid);
        expect(gateSlots.snapshot().occupied).toBe(0);
        expect(f.store.getRunState<RunState>(ctx.run.id)?.gateExecution).toBeUndefined();
      } finally {
        await execution.cancel();
        await settled;
      }
    });
  },
);

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
    const priorities: string[] = [];
    const fresh = fake(async (h, req) => {
      priorities.push(req.priority ?? "missing");
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
    const originalPriorities: GateRequest["priority"][] =
      purpose === "baseline-retry"
        ? ["start", "start"]
        : ["start", "finish", ...(purpose === "initial" ? [] : ["finish" as const])];
    expect([...scripted.requests.values()].map((req) => req.priority)).toEqual(originalPriorities);
    expect(priorities).toEqual(
      purpose === "baseline-retry" ? ["start", "finish"] : Array(fresh.attaches.length).fill("finish"),
    );
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

test("local attachment preserves start-time read policy and confinement", async () => {
  const executor = localExecutor();
  const signal = new AbortController().signal;
  const recording = recordingConfinement();
  const handle = await readPolicyScope.run(testReadPolicy, () =>
    confinementScope.run(recording.backend, () => executor.start(request(fixture.repoDir), signal)),
  );
  const execution = readPolicyScope.run(undefined, () =>
    confinementScope.exit(() => {
      expect(readPolicyScope.getStore()).toBeUndefined();
      expect(confinementScope.getStore()).toBeUndefined();
      return executor.attach(handle, signal);
    }),
  );
  expect((await execution.result).checks[0]?.ok).toBe(true);
  expect(recording.calls).toHaveLength(1);
  expect(recording.calls[0]?.opts.cmd).toContain("true");
});

test.each([false, true])("shared local executor releases settled work (rejected=%s)", async (rejected) => {
  const executor = gateExecutorFor("local");
  const signal = new AbortController().signal;
  const req = request(fixture.repoDir);
  const recording = recordingConfinement();
  const backend = {
    ...recording.backend,
    async verify(...args: Parameters<typeof recording.backend.verify>) {
      await recording.backend.verify(...args);
      if (rejected && recording.calls.length === 1) throw new Error("execution failed");
    },
  };
  let handle: ExecutionHandle | undefined;
  await confinementScope.run(backend, async () => {
    const first = executeGate(req, signal, {}, executor, undefined, async (started) => {
      handle = started;
    });
    if (rejected) await expect(first).rejects.toThrow("execution failed");
    else expect((await first).checks[0]?.ok).toBe(true);
    if (!handle) throw new Error("missing handle");
    const settledHandle = handle;
    // Neither the cached execution nor its original request survives settlement.
    expect(() => executor.attach(settledHandle, signal)).toThrow("missing its request");
    const replay = await executeGate(req, signal, {}, executor, settledHandle);
    expect(replay.checks[0]?.ok).toBe(true);
    expect(recording.calls).toHaveLength(2);
    expect(() => executor.attach(settledHandle, signal)).toThrow("missing its request");
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
  const acquisition = spyOn(gateSlots, "acquire");
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
    readPolicy: testReadPolicy,
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
    gh: async (args) => {
      if (args.includes("url,state,isDraft,headRefOid,mergedBy,mergedAt"))
        return JSON.stringify({ url: prUrl, state: "OPEN", isDraft: false, headRefOid: sha });
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
      expect(scripted.requests.get("1")).toMatchObject({
        repo: repo.slug,
        baseSha: sha,
        headSha: sha,
        priority: "ship",
      });
    } else {
      expect(acquisition.mock.calls[0]?.[4]).toBe("ship");
    }
  } finally {
    await queue.stop();
    acquisition.mockRestore();
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
      { name: "pending", run: "touch pending-started; sleep 900" },
    ],
  };
  await confinementScope.run(fakeConfinement, async () => {
    const handle = await executor.start(req, controller.signal);
    const execution = executor.attach(handle, new AbortController().signal);
    try {
      const event = await execution.events[Symbol.asyncIterator]().next();
      expect(event.value).toMatchObject({ type: "check", result: { name: "first", ok: true } });
      // Cancel the second check once it runs, not while its sandbox is still starting.
      await wait(() => existsSync(join(fixture.repoDir, "pending-started")), {
        timeoutMs: 10_000,
        description: "pending check did not start",
      });
    } finally {
      controller.abort();
    }
    const completed = await execution.result;
    expect(completed.checks.map((c) => [c.name, c.ok])).toEqual([
      ["first", true],
      ["pending", false],
    ]);
    await execution.cancel();
  });
});

test("a cancel while a check's sandbox is still starting returns a cancelled check, not a confinement error", async () => {
  const controller = new AbortController();
  const executor = localExecutor();
  const req = request(fixture.repoDir);
  req.gates = {
    ...gates,
    checks: [
      { name: "first", run: "true" },
      { name: "pending", run: "touch pending-ran" },
    ],
  };
  let launches = 0;
  const held: ConfinementBackend = {
    verify: async () => {},
    // wrap runs just before the spawn: cancel there and never let the startup shell report.
    wrap: (cmd) => {
      if (++launches === 1) return cmd;
      controller.abort();
      return ["/bin/sh", "-c", 'sleep 900; exec "$@"', "sh", ...cmd];
    },
  };
  await confinementScope.run(held, async () => {
    const handle = await executor.start(req, controller.signal);
    const completed = await executor.attach(handle, new AbortController().signal).result;
    expect(completed.checks.map((c) => [c.name, c.ok, confinementFailed(c)])).toEqual([
      ["first", true, false],
      ["pending", false, false],
    ]);
  });
  expect(launches).toBe(2);
  expect(existsSync(join(fixture.repoDir, "pending-ran"))).toBe(false);
});

test.each([false, true])(
  "targeted retry config stays on the base commit across opposite PR edits (base enabled=%s)",
  async (enabled) => {
    const baseConfig = `[gates]\nchecks = [{ name = "check", run = "full-check" }]\n${enabled ? 'retry_files = "base-target {files}"\n' : ""}`;
    const changedConfig = `[gates]\nchecks = [{ name = "check", run = "full-check" }]\n${enabled ? "" : 'retry_files = "candidate-target {files}"\n'}`;
    writeFileSync(join(fixture.repoDir, ".limitless.toml"), baseConfig);
    await sh(["git", "commit", "-qam", "base retry configuration"], { cwd: fixture.repoDir });
    const purposes: string[] = [];
    const scripted = fake(async (handle, req) => {
      const state = fixture.factory?.store.listRuns()[0];
      if (state)
        purposes.push(fixture.factory?.store.getRunState<RunState>(state.id)?.gateExecution?.purpose ?? "");
      const run = result(req, handle.id !== "2");
      if (handle.id === "2")
        run.checks = run.checks.map((check) => ({
          ...check,
          output: "test failure",
          failedFiles: ["greeting.txt"],
          failedFileTimes: { "greeting.txt": 1 },
        }));
      return run;
    });
    const f = start(
      (s) =>
        roleOf(s) === "implement"
          ? { files: { ".limitless.toml": changedConfig, "farewell.txt": "goodbye\n" } }
          : handler(s),
      false,
      false,
      { gateExecutor: scripted.executor },
    );
    const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const requests = [...scripted.requests.values()];
    expect(requests.map((req) => req.gates.retryFiles)).toEqual(
      Array(enabled ? 4 : 3).fill(enabled ? "base-target {files}" : undefined),
    );
    expect(requests.map((req) => req.gates.checks[0]?.run)).toEqual(
      enabled
        ? ["full-check", "full-check", "base-target './greeting.txt'", "full-check"]
        : ["full-check", "full-check", "full-check"],
    );
    expect(purposes).toEqual(
      enabled
        ? ["baseline", "initial", "regression-retry-targeted", "regression-retry"]
        : ["baseline", "initial", "regression-retry"],
    );
    expect(requests.map((req) => req.priority)).toEqual(
      enabled ? ["start", "finish", "finish", "finish"] : ["start", "finish", "finish"],
    );
    expect(requests[2]?.skipGateSlot).toBe(enabled);
    const comparison = f.store.getRunState<RunState>(run.id)?.lastGates?.[0];
    expect(comparison?.verdict).toBe("flaky");
    expect(comparison?.firstAttempt?.ok).toBe(false);
    if (enabled)
      expect(
        f.store
          .listEvents(run.id)
          .some((event) => event.message.includes("targeted: 1 files, then full retry")),
      ).toBe(true);
  },
);

test.each([false, true])("baseline targeted evidence is redacted before caching (pass=%s)", async (pass) => {
  const secret = "synthetic-baseline-retry-file-credential-548";
  registerCredential("BASELINE_RETRY_FILE_TEST_TOKEN", secret);
  const file = `${secret}.test.ts`;
  writeFileSync(join(fixture.repoDir, file), "");
  writeFileSync(
    join(fixture.repoDir, ".limitless.toml"),
    '[gates]\nchecks = [{ name = "check", run = "full-check" }]\nretry_files = "base-target {files}"\n',
  );
  await sh(["git", "add", "."], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "baseline targeted retry"], { cwd: fixture.repoDir });
  const purposes: string[] = [];
  const scripted = fake(async (handle, req) => {
    const state = fixture.factory?.store.listRuns()[0];
    if (state)
      purposes.push(fixture.factory?.store.getRunState<RunState>(state.id)?.gateExecution?.purpose ?? "");
    const run = result(req, Number(handle.id) > (pass ? 1 : 2));
    if (handle.id === "1")
      run.checks = run.checks.map((check) => ({
        ...check,
        failedFiles: [file],
        failedFileTimes: { [file]: 1 },
      }));
    return run;
  });
  const f = start(handler, false, false, { gateExecutor: scripted.executor });
  const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell", profile: "quick" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(purposes).toEqual(
    pass
      ? ["baseline", "baseline-retry-targeted", "baseline-retry", "initial"]
      : ["baseline", "baseline-retry-targeted", "initial"],
  );
  expect([...scripted.requests.values()].map((req) => req.priority)).toEqual(
    pass ? ["start", "start", "start", "finish"] : ["start", "start", "finish"],
  );
  expect([...scripted.requests.values()].map((req) => req.gates.checks[0]?.run)).toEqual([
    "full-check",
    `base-target './${file}'`,
    ...(pass ? ["full-check"] : []),
    "full-check",
  ]);
  const state = f.store.getRunState<RunState>(run.id);
  const baseline = state?.baseline?.checks[0];
  expect(baseline).toMatchObject({
    ok: pass,
    firstAttempt: {
      ok: false,
      failedFiles: [file],
      failedFileTimes: { [file]: 1 },
    },
    targetedRetry: { ok: pass, command: `base-target './${file}'` },
  });
  const row = f.store.db.query("SELECT gate_run FROM passing_baselines").get() as {
    gate_run: string;
  } | null;
  if (pass) {
    if (!row) throw new Error("missing baseline cache");
    expect(JSON.parse(row.gate_run)).toEqual(redactGateData(state?.baseline));
    expect(row.gate_run).not.toContain(secret);
  } else expect(row).toBeNull();
  const artifact = f.store.getArtifact(run.id, "baseline-gates.json");
  if (!artifact) throw new Error("missing baseline artifact");
  expect(JSON.parse(artifact)).toEqual(redactGateData(state?.baseline));
  for (const persisted of [artifact, JSON.stringify(f.store.listEvents(run.id))])
    expect(persisted).not.toContain(secret);
  expect(
    f.store
      .listEvents(run.id)
      .some(
        (event) =>
          event.message ===
          (pass
            ? "baseline check: flaky (targeted: 1 files, then full retry)"
            : "baseline check: retry FAIL again (targeted: 1 files)"),
      ),
  ).toBe(true);
});

test("baseline environment hashes separate LAN and local execution", () => {
  const input = {
    repoId: "test/repo",
    baseSha: "base",
    gates,
    lockfileHash: "lock",
    bunVersion: Bun.version,
    platform: "darwin",
    arch: "arm64",
    buildSha: "build",
    envDigest: "env",
  };
  expect(baselineCacheKey(input)).toEqual(baselineCacheKey({ ...input, executor: "local" }));
  expect(baselineCacheKey({ ...input, executor: "lan" }).envHash).not.toBe(baselineCacheKey(input).envHash);
});
