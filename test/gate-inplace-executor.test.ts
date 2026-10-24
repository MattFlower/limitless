import { expect, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { reloadedConfig } from "../src/config-reload.ts";
import { WorkerStore } from "../src/db/workers.ts";
import type { ExecutionHandle, GateRequest } from "../src/gates/executor.ts";
import { executeGate, gateExecutorFor } from "../src/gates/executor.ts";
import { gateEnv } from "../src/gates/run.ts";
import { attachSlotPools, gateSlotScope } from "../src/gates/slots.ts";
import { headSha } from "../src/git/repos.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { runGateExecution } from "../src/pipeline/gate-execution.ts";
import {
  agentEnv,
  processBirthSync,
  recoverProcessCleanups,
  recoveryProcessStopped,
  sh,
} from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { approve, pipelineSetup, roleOf, triage, waitFor } from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";

const fixture: { home: string; repoDir: string; factory: Factory | null } = {
  home: "",
  repoDir: "",
  factory: null,
};
const { start, wait, githubFixture, registerGithub, advanceBase } = pipelineSetup(fixture);
const release = "test-build";
const signal = new AbortController().signal;
const gates = {
  setup: ["echo setup"],
  checks: [
    { name: "pass", run: "echo pass" },
    { name: "fail", run: "exit 3" },
  ],
  source: "none" as const,
  protectedPaths: [],
};

async function setup(enabled = true) {
  mkdirSync(join(fixture.home, "cfg"));
  writeFileSync(join(fixture.home, "cfg", "config.toml"), `[executor]\nenabled = ${enabled}\n`);
  const f = start(() => ({}));
  await f.stop();
  f.store.setSetting("executor.daemonRelease", release);
  const repo = f.store.upsertRepo({
    slug: "test/repo",
    kind: "local",
    url: fixture.repoDir,
    localPath: fixture.repoDir,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = f.store.createRun(repo, { repo: repo.slug, prompt: "gates" });
  const context = (abort = signal) => new RunContext(f.deps, run, repo, abort);
  const req: GateRequest = {
    repo: repo.slug,
    cwd: fixture.repoDir,
    baseSha: "",
    headSha: await headSha(fixture.repoDir),
    gates,
    env: gateEnv(),
    releaseSha: release,
  };
  return { f, context, req };
}

async function withExecutor(
  f: Factory,
  fn: (workers: WorkerStore, crash: () => Promise<void>) => Promise<void>,
  sha = release,
) {
  const script = `
    import { runInplaceExecutor } from ${JSON.stringify(new URL("../src/gates/inplace.ts", import.meta.url).pathname)};
    import { confinementScope } from ${JSON.stringify(new URL("../src/harness/sandbox.ts", import.meta.url).pathname)};
    import { processBootInspection } from ${JSON.stringify(new URL("../src/util/proc.ts", import.meta.url).pathname)};
    const controller = new AbortController();
    process.once('SIGTERM', () => controller.abort());
    const cfg = ${JSON.stringify({ paths: f.cfg.paths, port: f.cfg.port, maxConcurrentGates: 1, readPolicy: f.cfg.readPolicy })};
    await processBootInspection.run(() => "test-boot", () => confinementScope.run({ verify: async () => {}, wrap: cmd => cmd }, () => runInplaceExecutor(cfg, ${JSON.stringify(sha)}, controller.signal)));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: fixture.home,
    env: {
      ...agentEnv({ EXTRA_MARKER: "executor", PATH: `/executor-shim:${process.env.PATH}` }),
      LIMITLESS_CONFIG_DIR: f.cfg.paths.configDir,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  try {
    await wait(() => f.workers.executor(undefined, false)?.pid === child.pid, { timeoutMs: 10_000 });
    await confinementScope.run(fakeConfinement, () =>
      fn(f.workers, async () => {
        child.kill("SIGKILL");
        await child.exited;
      }),
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await child.exited;
    expect(await stderr).toBe("");
  }
}

const outcomes = (run: Awaited<ReturnType<typeof executeGate>>) =>
  [...run.setup, ...run.checks].map(({ name, ok, exitCode }) => ({ name, ok, exitCode }));

test("executor runs in place with the request environment and ordered check results", async () => {
  const { f, context, req } = await setup();
  req.gates = {
    ...gates,
    checks: [{ name: "env", run: 'printf "%s|%s" "$PATH" "$EXTRA_MARKER"' }, ...gates.checks],
  };
  const local = await confinementScope.run(fakeConfinement, () => executeGate(req, signal));
  await withExecutor(f, async (workers) => {
    expect(f.deps.gateExecutor?.kind).toBe("inplace");
    expect(workers.executor()).toBeDefined();
    const events: string[] = [];
    let setupReady = false;
    const result = await runGateExecution(
      context(),
      "gates",
      "initial",
      req.cwd,
      req.gates,
      {
        onResult: (r) => events.push(r.name),
        onLocalSetup: () => {
          setupReady = true;
        },
      },
      req.env,
    );
    expect(setupReady).toBe(true);
    expect(outcomes(result)).toEqual(outcomes(local));
    expect(events).toEqual(["setup", "env", "pass", "fail"]);
    expect(result.checks[0]?.output).toBe(`${req.env?.PATH}|`);
    const jobs = workers.jobs("in_place=1");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.failure_reason).toBeNull();
    expect(jobs[0]).toMatchObject({ state: "done", worker: workers.executor()?.id });
    expect(JSON.parse(jobs[0]?.request ?? "{}").env).toEqual(req.env);
    expect(
      JSON.parse(jobs[0]?.events ?? "[]").map((e: { result: { name: string } }) => e.result.name),
    ).toEqual(events);
  });
});

test("shutdown detaches and a new context reattaches to the same job and executor slot", async () => {
  const { f, context, req } = await setup();
  const detach = attachSlotPools(f.store.db, 1);
  const controller = new AbortController();
  req.gates = {
    ...gates,
    setup: [],
    checks: [
      {
        name: "long",
        run: "echo run >> counter; echo $$ > gate-pid; while [ ! -f proceed ]; do sleep 0.05; done",
      },
    ],
  };
  try {
    await withExecutor(f, async (workers) => {
      const first = context(controller.signal);
      const pending = gateSlotScope(() => runGateExecution(first, "gates", "initial", req.cwd, req.gates))();
      const rejected = pending.catch((error) => error);
      try {
        await wait(() => existsSync(join(req.cwd, "gate-pid")), { timeoutMs: 10_000 });
        const handle = first.state.gateExecution?.handle;
        expect(handle?.kind).toBe("inplace");
        const slots = () =>
          f.store.db.query("SELECT owner_pid,priority,state FROM slot_requests WHERE pool='gate'").all();
        const expected = [{ owner_pid: workers.executor()?.pid, priority: "finish", state: "held" }];
        expect(slots()).toEqual(expected);
        const discoveries = f.store.listProcessDiscoveries(undefined, req.cwd);
        expect(discoveries.some((d) => d.ownerPid === workers.executor()?.pid)).toBe(true);
        controller.abort(new Error("shutdown"));
        expect(await rejected).toBeInstanceOf(Error);
        expect(first.state.gateExecution?.handle).toEqual(handle);
        expect(slots()).toEqual(expected);
        await recoverProcessCleanups(f.store);
        expect(slots()).toEqual(expected);
        const second = context();
        const resumed = runGateExecution(second, "gates", "initial", req.cwd, req.gates);
        await wait(() => second.state.gateExecution?.handle.id === handle?.id, { timeoutMs: 10_000 });
        writeFileSync(join(req.cwd, "proceed"), "");
        expect((await resumed).checks[0]?.ok).toBe(true);
        expect(workers.jobs("in_place=1")).toHaveLength(1);
        expect(readFileSync(join(req.cwd, "counter"), "utf8")).toBe("run\n");
        await wait(() => slots().length === 0, { timeoutMs: 10_000 });
      } finally {
        writeFileSync(join(req.cwd, "proceed"), "");
        controller.abort(new Error("shutdown"));
        await rejected;
      }
    });
  } finally {
    detach();
  }
});

test.each(["sha", "missing", "release", "environment"])(
  "resume rejects a %s mismatch instead of waiting on the old handle",
  async (kind) => {
    const { f, context, req } = await setup();
    await withExecutor(f, async (workers) => {
      const ctx = context();
      const old = workers.enqueue(
        {
          ...req,
          releaseSha: kind === "release" ? "older" : release,
          env: kind === "environment" ? { ...req.env, EXTRA_MARKER: "old-daemon" } : req.env,
        },
        randomUUID(),
        true,
      );
      ctx.state.gateExecution = {
        stage: "gates",
        round: 0,
        purpose: "initial",
        sha: kind === "sha" ? "older" : req.headSha,
        handle: { kind: "inplace", id: old, startedAt: Date.now() },
      };
      if (kind === "missing") f.store.db.query("DELETE FROM gate_jobs WHERE id=?").run(old);
      writeFileSync(join(req.cwd, "greeting.txt"), "old gate output\n");
      writeFileSync(join(req.cwd, "old-build"), "old gate output\n");
      await ctx.save();
      expect((await runGateExecution(context(), "gates", "initial", req.cwd, gates)).setupOk).toBe(true);
      expect(readFileSync(join(req.cwd, "greeting.txt"), "utf8")).toBe("hello\n");
      expect(existsSync(join(req.cwd, "old-build"))).toBe(false);
      if (kind !== "missing") expect(workers.job(old)?.state).toBe("cancelled");
      expect(workers.jobs("in_place=1 AND state='done'")).toHaveLength(1);
    });
  },
);

test.each(["disabled", "absent", "dead", "release"])(
  "%s executor falls back to the in-process path",
  async (kind) => {
    const { f, context, req } = await setup(kind !== "disabled");
    if (kind === "dead" || kind === "release")
      f.store.db
        .query("INSERT INTO executors VALUES (?,?,?,?)")
        .run(
          "unavailable",
          kind === "dead" ? 2147483647 : process.pid,
          processBirthSync(process.pid) ?? "",
          kind === "release" ? "older" : release,
        );
    const ctx = context();
    const result = await confinementScope.run(fakeConfinement, () =>
      runGateExecution(ctx, "gates", "initial", req.cwd, gates),
    );
    expect(result.checks.map((c) => c.exitCode)).toEqual([0, 3]);
    expect(f.workers.jobs("1=1")).toHaveLength(0);
    if (kind !== "disabled")
      expect(f.store.listEvents(ctx.run.id).some((e) => e.message.includes("executor unavailable"))).toBe(
        true,
      );
  },
);

test("idle executor uses no write transactions, and release mismatches never lease", async () => {
  const { f, req } = await setup();
  await withExecutor(f, async (workers) => {
    const version = () => f.store.db.query("PRAGMA data_version").get();
    const before = version();
    await Bun.sleep(workers.times.tick * 4);
    expect(version()).toEqual(before);
    workers.enqueue({ ...req, releaseSha: "older" }, randomUUID(), true);
    const unchanged = version();
    await Bun.sleep(workers.times.tick * 4);
    expect(workers.jobs("in_place=1")[0]?.state).toBe("queued");
    expect(version()).toEqual(unchanged);
    f.store.setSetting("executor.daemonRelease", "older");
    const id = workers.enqueue(req, randomUUID(), true);
    expect(workers.leaseInplace(workers.executor()?.id ?? "")).toBeNull();
    expect(workers.job(id)?.state).toBe("queued");
  });
});

test("LAN and in-place leases select disjoint queues; pickup failure does not requeue", async () => {
  const { f, req } = await setup();
  const caps = {
    releaseSha: release,
    bunVersion: Bun.version,
    os: "darwin",
    osVersion: "test",
    cpuCount: 1,
    ramBytes: 1,
    freeSlots: 1,
    onAC: true,
    idleSeconds: 0,
    jobs: [],
  };
  f.store.db
    .query(
      "INSERT INTO workers (name,fingerprint,state,pairing_code,pairing_secret_hash,pairing_expires_at,created_at,last_heartbeat_at,capabilities) VALUES ('lan','fingerprint','approved','code','hash',0,0,?,?)",
    )
    .run(Date.now(), JSON.stringify(caps));
  const id = f.workers.enqueue(req, randomUUID(), true);
  expect(f.workers.lease("lan")).toBeNull();
  const lan = f.workers.enqueue(req);
  f.store.db
    .query("INSERT INTO executors VALUES (?,?,?,?)")
    .run("local", process.pid, processBirthSync(process.pid) ?? "", release);
  expect(f.workers.leaseInplace("local")?.id).toBe(id);
  expect(f.workers.job(lan)?.state).toBe("queued");
  const missed = f.workers.enqueue(req, randomUUID(), true);
  const later = new WorkerStore(f.store, release, { pickup: 1 }, () => Date.now() + 2);
  later.sweep();
  expect(later.job(missed)?.state).toBe("failed");
  expect(later.job(missed)?.attempt).toBe(1);
});

test("a checkpoint is durable before the in-place job is enqueued", async () => {
  const { f, context, req } = await setup();
  await withExecutor(f, async (workers) => {
    const ctx = context();
    const original = ctx.save.bind(ctx);
    let recorded: ExecutionHandle | undefined;
    const save = spyOn(ctx, "save").mockImplementation(async (checkpoint) => {
      if (checkpoint === "gate-started") {
        recorded = ctx.state.gateExecution?.handle;
        expect(recorded?.kind).toBe("inplace");
        expect(workers.job(recorded?.id ?? "")).toBeNull();
      }
      await original(checkpoint);
    });
    try {
      await runGateExecution(ctx, "gates", "initial", req.cwd, gates);
    } finally {
      save.mockRestore();
    }
    expect(workers.job(recorded?.id ?? "")?.state).toBe("done");
  });
});

test("executor opt-in defaults off and reload requires a restart", () => {
  const cfg = loadConfig({ home: fixture.home, configDir: join(fixture.home, "cfg"), raw: {} });
  expect(cfg.executorEnabled).toBe(false);
  const next = loadConfig({
    home: fixture.home,
    configDir: join(fixture.home, "cfg"),
    raw: { executor: { enabled: true } },
  });
  expect(reloadedConfig(cfg, next).result.restartRequired).toContain("executor.enabled");
  expect(reloadedConfig(cfg, next).cfg.executorEnabled).toBe(false);
  expect(gateExecutorFor("local", undefined, [], true).kind).toBe("local");
});

test("a running SHA mismatch waits for the executor to acknowledge process shutdown", async () => {
  const { f, context, req } = await setup();
  await withExecutor(f, async (workers) => {
    const first = context();
    const controller = new AbortController();
    const current = new RunContext(f.deps, first.run, first.repo, controller.signal);
    const long = {
      ...gates,
      setup: [],
      checks: [{ name: "long", run: "echo $$ > previous-pid; while [ ! -f stop-old ]; do sleep 0.05; done" }],
    };
    const pending = runGateExecution(current, "gates", "initial", req.cwd, long).catch((e) => e);
    try {
      await wait(() => existsSync(join(req.cwd, "previous-pid")), { timeoutMs: 10_000 });
      const old = current.state.gateExecution?.handle.id ?? "";
      const pid = Number(readFileSync(join(req.cwd, "previous-pid"), "utf8"));
      controller.abort(new Error("shutdown"));
      await pending;
      writeFileSync(join(req.cwd, "new-file"), "head moved");
      await sh(["git", "add", "new-file"], { cwd: req.cwd });
      await sh(["git", "commit", "-qm", "new head"], { cwd: req.cwd });
      let stoppedBeforeResult = false;
      const result = await runGateExecution(context(), "gates", "initial", req.cwd, gates, {
        onResult: () => {
          stoppedBeforeResult = recoveryProcessStopped(pid);
        },
      });
      expect(result.setupOk).toBe(true);
      expect(workers.job(old)).toMatchObject({ state: "cancelled", stopped: 1 });
      expect(stoppedBeforeResult).toBe(true);
      expect(workers.jobs("in_place=1")).toHaveLength(2);
    } finally {
      writeFileSync(join(req.cwd, "stop-old"), "");
      controller.abort(new Error("shutdown"));
      await pending;
    }
  });
});

test("a daemon release change stops a running job before in-process fallback", async () => {
  const { f, context, req } = await setup();
  await withExecutor(f, async (workers) => {
    const long = {
      ...gates,
      setup: [],
      checks: [
        {
          name: "long",
          run: "if [ ! -f attempted ]; then touch attempted; echo $$ > previous-pid; while [ ! -f proceed ]; do sleep 0.05; done; fi",
        },
      ],
    };
    const pending = runGateExecution(context(), "gates", "initial", req.cwd, long);
    const rejected = pending.catch((e) => e);
    try {
      await wait(() => existsSync(join(req.cwd, "previous-pid")), { timeoutMs: 10_000 });
      const pid = Number(readFileSync(join(req.cwd, "previous-pid"), "utf8"));
      f.store.setSetting("executor.daemonRelease", "new-release");
      expect((await pending).checks[0]?.ok).toBe(true);
      expect(recoveryProcessStopped(pid)).toBe(true);
      const job = workers.jobs("in_place=1")[0];
      expect(job?.stopped).toBe(1);
      expect(job?.failure_reason).toContain("release changed");
    } finally {
      writeFileSync(join(req.cwd, "proceed"), "");
      await rejected;
    }
  });
});

test.each(["during resume", "before resume"])(
  "executor crash recovery %s unblocks the worktree",
  async (when) => {
    const { f, context, req } = await setup();
    const pidFile = join(fixture.home, "orphan-pid");
    const proceed = join(fixture.home, "proceed");
    const controller = new AbortController();
    const long = {
      ...gates,
      setup: [],
      checks: [
        {
          name: "crash",
          run: `if [ ! -f '${pidFile}' ]; then echo dirty > greeting.txt; echo $$ > '${pidFile}'; while [ ! -f '${proceed}' ]; do sleep 0.05; done; fi; test "$(cat greeting.txt)" = hello`,
        },
      ],
    };
    await withExecutor(f, async (workers, crash) => {
      const first = context(controller.signal);
      const pending = runGateExecution(first, "gates", "initial", req.cwd, long).catch((e) => e);
      try {
        await wait(() => existsSync(pidFile), { timeoutMs: 10_000 });
        const pid = Number(readFileSync(pidFile, "utf8"));
        const id = first.state.gateExecution?.handle.id ?? "";
        controller.abort(new Error("shutdown"));
        await pending;
        await crash();
        expect(workers.job(id)?.stopped).toBe(0);
        expect(f.store.listProcessDiscoveries(undefined, req.cwd).length).toBeGreaterThan(0);
        expect(recoveryProcessStopped(pid)).toBe(false);
        if (when === "before resume") await recoverProcessCleanups(f.store);
        let stoppedBeforeResult = false;
        const resumed = await runGateExecution(context(), "gates", "initial", req.cwd, long, {
          onResult: () => {
            stoppedBeforeResult = recoveryProcessStopped(pid);
          },
        });
        expect(resumed.checks[0]?.ok).toBe(true);
        expect(stoppedBeforeResult).toBe(true);
        expect(workers.job(id)).toMatchObject({ state: "cancelled", stopped: 1 });
        expect(f.store.listProcessDiscoveries(undefined, req.cwd)).toHaveLength(0);
        expect(f.store.listProcessCleanups(undefined, req.cwd)).toHaveLength(0);
        expect((await runGateExecution(context(), "gates", "initial", req.cwd, long)).checks[0]?.ok).toBe(
          true,
        );
      } finally {
        writeFileSync(proceed, "");
        controller.abort(new Error("shutdown"));
        await pending;
        await recoverProcessCleanups(f.store);
      }
    });
  },
);

test.each([
  ["baseline", "matching"],
  ["baseline", "changed"],
  ["initial", "matching"],
  ["initial", "changed"],
  ["rebase", "matching"],
  ["rebase", "changed"],
] as const)("a new engine prepares %s gates safely (%s environment)", async (purpose, environment) => {
  const mismatch = environment === "changed";
  mkdirSync(join(fixture.home, "cfg"));
  writeFileSync(join(fixture.home, "cfg", "config.toml"), "[executor]\nenabled = true\n");
  const counter = join(fixture.home, "counter");
  const proceed = join(fixture.home, "proceed");
  const condition =
    purpose === "baseline"
      ? "! test -f farewell.txt"
      : purpose === "initial"
        ? "test -f farewell.txt && ! test -f base.txt"
        : "test -f base.txt";
  const command = `if ${condition}; then test "$(cat greeting.txt)" = hello && test ! -f active-build || exit 9; echo run >> '${counter}'; echo gate-output > greeting.txt; touch active-build; while [ ! -f '${proceed}' ]; do sleep 0.05; done; test -f active-build && test "$(cat greeting.txt)" = gate-output; fi`;
  mkdirSync(join(fixture.repoDir, "test"));
  writeFileSync(
    join(fixture.repoDir, "test/unrelated.test.ts"),
    'import { test } from "bun:test"; test("unrelated", () => {});\n',
  );
  writeFileSync(
    join(fixture.repoDir, ".limitless.toml"),
    `[gates]\ndocs = ["farewell.txt"]\nretry_files = "bun test {files}"\nchecks = [{ name = "build", run = ${JSON.stringify(command)} }, { name = "test", run = "bun test --reporter=junit --reporter-outfile=$LIMITLESS_GATE_REPORT" }]\n`,
  );
  await sh(["git", "add", "."], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "long baseline"], { cwd: fixture.repoDir });
  const bare = purpose === "rebase" ? await githubFixture() : undefined;
  process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;
  let advanced = false;
  let implementations = 0;
  const handler = async (s: Parameters<typeof roleOf>[0]) => {
    if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
    if (roleOf(s) === "review") {
      if (bare && !advanced) {
        advanced = true;
        await advanceBase(bare, "base.txt", "new base\n");
      }
      return { structured: approve };
    }
    implementations++;
    return { files: { "farewell.txt": "goodbye\n" } };
  };
  const f = start(handler);
  if (bare) registerGithub(f, bare);
  f.store.setSetting("executor.daemonRelease", release);
  try {
    await withExecutor(f, async (workers) => {
      const run = await f.createRun({
        repo: bare ? "test/repo" : fixture.repoDir,
        prompt: "Add farewell",
        profile: "quick",
      });
      await wait(() => existsSync(counter), { timeoutMs: 10_000 });
      const state = f.store.getRunState<RunContext["state"]>(run.id);
      expect(state?.gateExecution?.purpose).toBe(purpose);
      const job = workers.job(state?.gateExecution?.handle.id ?? "");
      expect(job?.state).toBe("leased");
      expect((JSON.parse(job?.request ?? "{}") as GateRequest).checks).toEqual(
        purpose === "baseline" ? ["build", "test"] : ["build"],
      );
      await f.stop();
      expect(readFileSync(counter, "utf8")).toBe("run\n");
      if (mismatch && job) {
        const request = JSON.parse(job.request) as GateRequest;
        f.store.db
          .query("UPDATE gate_jobs SET request=? WHERE id=?")
          .run(JSON.stringify({ ...request, env: { ...request.env, CHANGED_ENV: "1" } }), job.id);
      }
      const next = start(handler);
      const executor = next.deps.gateExecutor;
      if (!executor) throw new Error("missing executor");
      const attach = spyOn(executor, "attach");
      try {
        await wait(
          () => attach.mock.calls.some(([h]) => h.kind === "inplace" && (h.id === job?.id) !== mismatch),
          { timeoutMs: 10_000 },
        );
      } finally {
        attach.mockRestore();
      }
      writeFileSync(proceed, "");
      expect(await waitFor(next, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(implementations).toBe(1);
      expect(workers.job(job?.id ?? "")?.state).toBe(mismatch ? "cancelled" : "done");
      expect(readFileSync(counter, "utf8")).toBe(mismatch ? "run\nrun\n" : "run\n");
      const baseline = JSON.parse(next.store.getArtifact(run.id, "baseline-gates.json") ?? "null");
      expect(baseline).toMatchObject({
        setupOk: true,
        setup: [],
        checks: [
          { name: "build", ok: true, exitCode: 0 },
          { name: "test", ok: true, exitCode: 0 },
        ],
      });
    });
  } finally {
    writeFileSync(proceed, "");
    await fixture.factory?.stop();
    if (fixture.factory !== f) f.store.close();
  }
});
