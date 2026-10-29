import { expect, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { reloadedConfig } from "../src/config-reload.ts";
import { WorkerStore } from "../src/db/workers.ts";
import type { ExecutionEvent, ExecutionHandle, GateRequest } from "../src/gates/executor.ts";
import { executeGate, gateExecutorFor } from "../src/gates/executor.ts";
import { gateEnv } from "../src/gates/run.ts";
import { attachSlotPools, gateSlotScope } from "../src/gates/slots.ts";
import * as repos from "../src/git/repos.ts";
import { headSha } from "../src/git/repos.ts";
import { commandScope, confinementScope } from "../src/harness/sandbox.ts";
import { createScratch, removeScratch } from "../src/harness/scratch.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { gateCommandScope, runGateExecution } from "../src/pipeline/gate-execution.ts";
import {
  agentEnv,
  invocationScratch,
  ProcessTerminationError,
  processBirthSync,
  recoverProcessCleanups,
  recoveryProcessStopped,
  sh,
} from "../src/util/proc.ts";
import { fakeConfinement, seatbeltSkip } from "./confinement.ts";
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

async function waitForPid(path: string): Promise<number> {
  let contents = "";
  await wait(
    () => {
      contents = existsSync(path) ? readFileSync(path, "utf8") : "";
      return /^[1-9]\d*\n$/.test(contents);
    },
    { timeoutMs: 10_000 },
  );
  return Number(contents);
}

test("waitForPid waits for a complete PID line after file creation", async () => {
  const path = join(fixture.home, "delayed-pid");
  writeFileSync(path, "");
  let resolved = false;
  const pending = waitForPid(path).then((pid) => {
    resolved = true;
    return pid;
  });
  await wait(() => existsSync(path), { timeoutMs: 10_000 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(resolved).toBe(false);
  writeFileSync(path, "123\n");
  expect(await pending).toBe(123);
});

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
  const cwd = join(fixture.home, "repo-link");
  symlinkSync(realpathSync(fixture.repoDir), cwd);
  const req: GateRequest = {
    repo: repo.slug,
    cwd,
    baseSha: "",
    headSha: await headSha(fixture.repoDir),
    gates,
    env: gateEnv(),
    releaseSha: release,
    daemonPort: f.cfg.port,
  };
  return { f, context, req };
}

async function withExecutor(
  f: Factory,
  fn: (workers: WorkerStore, crash: () => Promise<void>) => Promise<void>,
  sha = release,
  realConfinement = false,
  beforeRun = "",
) {
  const script = `
    import { runInplaceExecutor } from ${JSON.stringify(new URL("../src/gates/inplace.ts", import.meta.url).pathname)};
    import { seatbeltBackend } from ${JSON.stringify(new URL("../src/harness/sandbox.ts", import.meta.url).pathname)};
    import { linuxBackend } from ${JSON.stringify(new URL("../src/harness/sandbox-linux.ts", import.meta.url).pathname)};
    import { appendFileSync } from 'node:fs';
    import { gitBackend } from ${JSON.stringify(new URL("../src/git/confinement.ts", import.meta.url).pathname)};
    import { processBootInspection } from ${JSON.stringify(new URL("../src/util/proc.ts", import.meta.url).pathname)};
    const controller = new AbortController();
    process.once('SIGTERM', () => controller.abort());
    const cfg = ${JSON.stringify({ paths: f.cfg.paths, port: f.cfg.port, maxConcurrentGates: 1, readPolicy: f.cfg.readPolicy })};
    if (!${realConfinement}) {
      gitBackend.default = { wrap: async cmd => cmd };
      for (const backend of [seatbeltBackend, linuxBackend]) {
        backend.verify = async (roots) => appendFileSync(${JSON.stringify(join(fixture.home, "executor-ports"))}, String(roots.daemonPort) + '\\n');
        backend.wrap = cmd => cmd;
        backend.launch = (cmd, _roots, payload) => ({ cmd, ...payload });
      }
    }
    ${beforeRun}
    await processBootInspection.run(() => "test-boot", () => runInplaceExecutor(cfg, ${JSON.stringify(sha)}, controller.signal));
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
    if (child.exitCode === null && child.signalCode === null) child.kill(beforeRun ? "SIGKILL" : "SIGTERM");
    await child.exited;
    expect(await stderr).toBe("");
  }
}

const outcomes = (run: Awaited<ReturnType<typeof executeGate>>) =>
  [...run.setup, ...run.checks].map(({ name, ok, exitCode }) => ({ name, ok, exitCode }));

test("each job confines the current daemon port and refuses invalid ports before commands", async () => {
  const { f, req } = await setup();
  const server = Bun.serve({ port: 0, fetch: () => new Response("daemon") });
  req.daemonPort = server.port;
  req.gates = { ...gates, setup: [], checks: [{ name: "marker", run: "touch port-marker" }] };
  try {
    await withExecutor(f, async (workers) => {
      expect(req.daemonPort).not.toBe(f.cfg.port);
      const id = workers.enqueue(req, randomUUID(), true);
      await wait(() => workers.job(id)?.state === "done" && workers.job(id)?.stopped === 1, {
        timeoutMs: 10_000,
      });
      expect(workers.job(id)?.state).toBe("done");
      expect(readFileSync(join(fixture.home, "executor-ports"), "utf8").trim()).toBe(String(server.port));
      expect(existsSync(join(req.cwd, "port-marker"))).toBe(true);
      for (const daemonPort of [undefined, 0, -1, 65536, 1.5]) {
        const marker = `invalid-port-${String(daemonPort)}`;
        const invalid = workers.enqueue(
          { ...req, daemonPort, gates: { ...req.gates, checks: [{ name: marker, run: `touch ${marker}` }] } },
          randomUUID(),
          true,
        );
        await wait(() => workers.job(invalid)?.state === "failed" && workers.job(invalid)?.stopped === 1, {
          timeoutMs: 10_000,
        });
        expect(workers.job(invalid)).toMatchObject({
          state: "failed",
          failure_reason: expect.stringContaining("daemon port"),
        });
        expect(existsSync(join(req.cwd, marker))).toBe(false);
      }
    });
  } finally {
    await server.stop(true);
  }
});

test.skipIf(seatbeltSkip !== null)(
  `executor denies the request's daemon port (${seatbeltSkip})`,
  async () => {
    const { f, req } = await setup();
    const server = Bun.serve({ port: 0, fetch: () => new Response("daemon") });
    req.daemonPort = server.port;
    req.gates = {
      ...gates,
      setup: [],
      checks: [{ name: "port", run: `curl --noproxy '*' --max-time 2 http://127.0.0.1:${server.port}` }],
    };
    try {
      await withExecutor(
        f,
        async (workers) => {
          const id = workers.enqueue(req, randomUUID(), true);
          await wait(() => workers.job(id)?.state === "done" && workers.job(id)?.stopped === 1, {
            timeoutMs: 10_000,
          });
          const run = JSON.parse(workers.job(id)?.result ?? "null");
          expect(workers.job(id)?.state).toBe("done");
          expect(run.checks[0].ok).toBe(false);
          expect(run.checks[0].exitCode).toBe(7);
        },
        release,
        true,
      );
    } finally {
      await server.stop(true);
    }
  },
);

test("executor retries share the daemon's setup scratch without removing it", async () => {
  const { f, context, req } = await setup();
  await withExecutor(f, async () => {
    for (const kind of ["local", "inplace"]) {
      const counter = join(fixture.home, `attempt-${kind}`);
      const attempt = {
        ...gates,
        setup: ['touch "$HOME/setup-token"'],
        checks: [
          {
            name: "retry",
            run: `if [ ! -f '${counter}' ]; then touch '${counter}'; exit 1; fi; test -f "$HOME/setup-token"`,
          },
        ],
      };
      const base = context();
      const ctx =
        kind === "local"
          ? new RunContext({ ...f.deps, gateExecutor: gateExecutorFor("local") }, base.run, base.repo, signal)
          : base;
      let scratch: string | undefined;
      await commandScope(req.cwd, async () => {
        scratch = invocationScratch.getStore();
        expect(scratch).toBeDefined();
        expect((await runGateExecution(ctx, "gates", "initial", req.cwd, attempt)).checks[0]?.ok).toBe(false);
        expect(
          (
            await runGateExecution(ctx, "gates", "regression-retry-targeted", req.cwd, {
              ...attempt,
              setup: [],
            })
          ).checks[0]?.ok,
        ).toBe(true);
        expect(existsSync(join(scratch ?? "", "setup-token"))).toBe(true);
      })();
      expect(existsSync(scratch ?? "")).toBe(false);
    }
  });
});

test("a canonical-path start recovers an earlier symlink job before unlocking the worktree", async () => {
  const { f, req } = await setup();
  const pidFile = join(fixture.home, "symlink-pid");
  const proceed = join(fixture.home, "symlink-proceed");
  req.gates = {
    ...gates,
    setup: [],
    checks: [
      { name: "long", run: `echo $$ > '${pidFile}'; while [ ! -f '${proceed}' ]; do sleep 0.05; done` },
    ],
  };
  await withExecutor(f, async (workers, crash) => {
    const id = workers.enqueue(req, randomUUID(), true);
    try {
      const pid = await waitForPid(pidFile);
      expect(recoveryProcessStopped(pid)).toBe(false);
      expect(workers.job(id)?.stopped).toBe(0);
      await crash();
      const executor = gateExecutorFor("local", workers, [], true);
      const next = { ...req, cwd: realpathSync(req.cwd), gates };
      await executor.start(next, signal);
      expect(workers.job(id)).toMatchObject({ state: "cancelled", stopped: 1 });
      expect(recoveryProcessStopped(pid)).toBe(true);
    } finally {
      writeFileSync(proceed, "");
      await recoverProcessCleanups(f.store);
    }
  });
});

test("an expired lease with a live executor bounds every stop-wait entry point", async () => {
  const { f, req } = await setup();
  await withExecutor(f, async (workers) => {
    const timed = new WorkerStore(f.store, release, { lease: 30, tick: 5 });
    const executor = gateExecutorFor("local", timed, [], true);
    for (const path of ["wait", "discard", "cancel", "fallback", "start"]) {
      const id = workers.enqueue({ ...req, releaseSha: "unleaseable" }, randomUUID(), true);
      f.store.db
        .query("UPDATE gate_jobs SET state='failed',worker=?,stopped=0,lease_expires_at=? WHERE id=?")
        .run(workers.executor()?.id ?? "", Date.now() + 30, id);
      const handle = { kind: "inplace" as const, id, startedAt: Date.now() };
      const abort = new AbortController();
      const execution =
        path === "cancel" || path === "fallback" ? executor.attach(handle, abort.signal) : undefined;
      const result = execution?.result.catch(() => {});
      const pending =
        path === "wait"
          ? timed.waitStopped(id, abort.signal)
          : path === "discard"
            ? executor.discard?.(handle)
            : path === "cancel"
              ? execution?.cancel()
              : path === "fallback"
                ? execution?.result
                : executor.start({ ...req, cwd: realpathSync(req.cwd) }, abort.signal);
      try {
        const error = await Promise.race([
          Promise.resolve(pending).catch((e: unknown) => e),
          Bun.sleep(1000).then(() => "hung"),
        ]);
        expect(error).toBeInstanceOf(ProcessTerminationError);
        expect(String(error)).toContain(
          `${ProcessTerminationError.prefix}: in-place job ${id}; process recovery required`,
        );
        expect(workers.job(id)?.stopped).toBe(0);
        expect(workers.executor()).toBeDefined();
      } finally {
        abort.abort();
        await result;
        // This synthetic lease never ran commands.
        f.store.db.query("UPDATE gate_jobs SET stopped=1 WHERE id=?").run(id);
      }
    }
  });
});

test("executor crash fallback restores committed bytes after stopping the original check", async () => {
  const { f, context, req } = await setup();
  const pidFile = join(fixture.home, "fallback-pid");
  const proceed = join(fixture.home, "fallback-proceed");
  const observed = join(fixture.home, "fallback-observed");
  const spawned = join(fixture.home, "fallback-spawned");
  req.gates = {
    ...gates,
    setup: [],
    checks: [
      {
        name: "clean",
        run: `if [ ! -f '${pidFile}' ]; then echo dirty > greeting.txt; echo $$ > '${pidFile}'; while [ ! -f '${proceed}' ]; do sleep 0.05; done; else echo stopped > '${observed}'; fi; test "$(cat greeting.txt)" = hello`,
      },
    ],
  };
  await withExecutor(
    f,
    async (workers, crash) => {
      let pid = 0;
      let stoppedBeforeFallback = false;
      const record = workers.event.bind(workers);
      const events = spyOn(workers, "event").mockImplementation((id, event) => {
        if (event.type === "status" && event.text.includes("gates falling back"))
          stoppedBeforeFallback = recoveryProcessStopped(pid);
        return record(id, event);
      });
      const checkoutCommitted = repos.checkoutCommitted;
      const restore = spyOn(repos, "checkoutCommitted").mockImplementation((...args) => {
        expect(recoveryProcessStopped(pid)).toBe(true);
        expect(readFileSync(join(req.cwd, "greeting.txt"), "utf8")).toBe("dirty\n");
        return checkoutCommitted(...args);
      });
      const pending = runGateExecution(context(), "gates", "initial", req.cwd, req.gates);
      const rejected = pending.catch((e) => e);
      try {
        pid = await waitForPid(pidFile);
        if (process.platform === "linux") await wait(() => existsSync(spawned), { timeoutMs: 10_000 });
        expect(readFileSync(join(req.cwd, "greeting.txt"), "utf8")).toBe("dirty\n");
        await crash();
        expect((await pending).checks[0]?.ok).toBe(true);
        expect(recoveryProcessStopped(pid)).toBe(true);
        expect(stoppedBeforeFallback).toBe(true);
        expect(readFileSync(observed, "utf8")).toBe("stopped\n");
        expect(readFileSync(join(req.cwd, "greeting.txt"), "utf8")).toBe("hello\n");
        expect(workers.jobs("in_place=1")[0]?.stopped).toBe(1);
      } finally {
        events.mockRestore();
        restore.mockRestore();
        writeFileSync(proceed, "");
        await rejected;
        await recoverProcessCleanups(f.store);
      }
    },
    release,
    false,
    `
    import * as childProcess from 'node:child_process';
    import { spyOn } from 'bun:test';
    import { writeFileSync } from 'node:fs';
    const spawn = childProcess.spawn;
    spyOn(childProcess, 'spawn').mockImplementation((...args) => {
      const child = spawn(...args);
      if (process.platform === 'linux' && args[0] === '/bin/sh' && String(args[1]).includes('echo dirty')) {
        writeFileSync(${JSON.stringify(spawned)}, '');
        // The parent crashes us while spawn has not returned to runProcess.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
      return child;
    });
  `,
  );
});

test.each(["baseline", "initial"])(
  "a failed %s retry recreates setup output after cleaning for local fallback",
  async (purpose) => {
    mkdirSync(join(fixture.home, "cfg"));
    writeFileSync(join(fixture.home, "cfg", "config.toml"), "[executor]\nenabled = true\n");
    const counter = join(fixture.home, "first-attempt");
    const pidFile = join(fixture.home, "retry-pid");
    const proceed = join(fixture.home, "retry-proceed");
    const setups = join(fixture.home, "setups");
    const setup = `mkdir -p node_modules; touch node_modules/token generated-file; echo setup >> '${setups}'`;
    const selected = purpose === "baseline" ? "! test -f farewell.txt" : "test -f farewell.txt";
    const command = `test -f node_modules/token && test -f generated-file || exit 9; if ${selected}; then if [ ! -f '${counter}' ]; then touch '${counter}'; exit 1; fi; if [ ! -f '${pidFile}' ]; then echo $$ > '${pidFile}'; while [ ! -f '${proceed}' ]; do sleep 0.05; done; fi; fi`;
    writeFileSync(join(fixture.repoDir, ".gitignore"), "node_modules/\n");
    writeFileSync(
      join(fixture.repoDir, ".limitless.toml"),
      `[gates]\nsetup = [${JSON.stringify(setup)}]\nchecks = [{ name = "build", run = ${JSON.stringify(command)} }]\n`,
    );
    await sh(["git", "add", "."], { cwd: fixture.repoDir });
    await sh(["git", "commit", "-qm", "gate setup prerequisites"], { cwd: fixture.repoDir });
    const f = start((s) => {
      if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (roleOf(s) === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    f.store.setSetting("executor.daemonRelease", release);
    await withExecutor(f, async (workers, crash) => {
      try {
        const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell", profile: "quick" });
        const pid = await waitForPid(pidFile);
        const state = f.store.getRunState<RunContext["state"]>(run.id);
        expect(state?.gateExecution?.purpose).toBe(
          purpose === "baseline" ? "baseline-retry" : "regression-retry",
        );
        const id = state?.gateExecution?.handle.id ?? "";
        const request = JSON.parse(workers.job(id)?.request ?? "{}") as GateRequest;
        expect(request.gates.setup).toEqual([]);
        expect(request.fallbackSetup).toEqual([setup]);
        // A healthy in-place retry reused setup; it has not rebuilt these outputs yet.
        const before = readFileSync(setups, "utf8");
        expect(before).toBe(purpose === "baseline" ? "setup\n" : "setup\nsetup\n");
        await crash();
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        expect(recoveryProcessStopped(pid)).toBe(true);
        const result = JSON.parse(workers.job(id)?.result ?? "null");
        expect(result).toMatchObject({
          setupOk: true,
          setup: [{ command: setup, ok: true }],
          checks: [{ name: "build", ok: true }],
        });
        expect(readFileSync(setups, "utf8")).toBe("setup\nsetup\nsetup\n");
      } finally {
        writeFileSync(proceed, "");
        await f.stop();
        await recoverProcessCleanups(f.store);
      }
    });
  },
);

test("leftover canonical process records keep the lock and surface needs_human within the bound", async () => {
  mkdirSync(join(fixture.home, "cfg"));
  writeFileSync(join(fixture.home, "cfg", "config.toml"), "[executor]\nenabled = true\n");
  const ready = join(fixture.home, "cleanup-ready");
  const proceed = join(fixture.home, "cleanup-proceed");
  writeFileSync(
    join(fixture.repoDir, ".limitless.toml"),
    `[gates]\nchecks = [{ name = "cleanup", run = ${JSON.stringify(`echo dirty > greeting.txt; touch '${ready}'; while [ ! -f '${proceed}' ]; do sleep 0.05; done`)} }]\n`,
  );
  await sh(["git", "add", ".limitless.toml"], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "cleanup gate"], { cwd: fixture.repoDir });
  const f = start(() => ({}));
  f.store.setSetting("executor.daemonRelease", release);
  f.workers.times.lease = 50;
  f.workers.times.tick = 5;
  await withExecutor(f, async (workers) => {
    const invocation = randomUUID();
    const enqueue = workers.enqueue.bind(workers);
    const queued = spyOn(workers, "enqueue").mockImplementation((req, id, inplace) => {
      const cwd = join(fixture.home, "cleanup-link");
      symlinkSync(realpathSync(req.cwd), cwd);
      writeFileSync(`${cwd}.git-paths`, readFileSync(`${req.cwd}.git-paths`));
      return enqueue({ ...req, cwd }, id, inplace);
    });
    try {
      const run = await f.createRun({ repo: fixture.repoDir, prompt: "cleanup", profile: "quick" });
      await wait(() => existsSync(ready), { timeoutMs: 10_000 });
      const pending = f.store.getRunState<RunContext["state"]>(run.id)?.gateExecution;
      const id = pending?.handle.id ?? "";
      const job = workers.job(id);
      const request = JSON.parse(job?.request ?? "{}") as GateRequest;
      const owner = workers.executor();
      if (!owner) throw new Error("Missing executor");
      // A failed cleanup leaves its canonical discovery behind, even for a symlink request.
      f.store.recordProcessDiscovery({
        invocation,
        runId: run.id,
        directory: realpathSync(request.cwd),
        boot: "test-boot",
        createdAt: Date.now(),
        ownerId: "synthetic-cleanup",
        ownerPid: owner.pid,
        ownerBirth: owner.birth,
        discovery: { group: 0, started: Date.now(), directories: [], leader: null, spawnedAt: "0" },
      });
      workers.fail(id, "simulated failed cleanup");
      writeFileSync(proceed, "");
      // Expire the final lease after the executor has stopped renewing it.
      f.store.db
        .query("UPDATE gate_jobs SET lease_expires_at=? WHERE id=?")
        .run(Date.now() - 2 * workers.times.lease, id);
      expect(await waitFor(f, run.id, ["needs_human", "failed"])).toBe("needs_human");
      const error = f.store.getRun(run.id)?.error;
      expect(error).toStartWith(ProcessTerminationError.prefix);
      expect(error).toContain(id);
      expect(error).toContain("process recovery required");
      expect(workers.job(id)?.stopped).toBe(0);
      expect(workers.executor()).toBeDefined();
      expect(readFileSync(join(request.cwd, "greeting.txt"), "utf8")).toBe("dirty\n");
      // Allow the executor's finally to run; it must also observe the canonical leftover record.
      await wait(() => f.store.listProcessDiscoveries(undefined, realpathSync(request.cwd)).length === 1, {
        timeoutMs: 10_000,
      });
      expect(workers.job(id)?.stopped).toBe(0);
    } finally {
      queued.mockRestore();
      writeFileSync(proceed, "");
      await f.stop();
      f.store.deleteInvocationCleanups(invocation);
    }
  });
});

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
    setup: ['touch "$HOME/setup-token"'],
    checks: [
      {
        name: "long",
        run: 'echo run >> counter; echo $$ > gate-pid; while [ ! -f proceed ]; do sleep 0.05; done; test -f "$HOME/setup-token"',
      },
    ],
  };
  try {
    await withExecutor(f, async (workers) => {
      const first = context(controller.signal);
      const pending = gateSlotScope(
        gateCommandScope(first, "gates", "initial", req.cwd, () =>
          runGateExecution(first, "gates", "initial", req.cwd, req.gates),
        ),
      )();
      const rejected = pending.catch((error) => error);
      try {
        await waitForPid(join(req.cwd, "gate-pid"));
        const handle = first.state.gateExecution?.handle;
        expect(handle?.kind).toBe("inplace");
        const slots = () =>
          f.store.db.query("SELECT owner_pid,priority,state FROM slot_requests WHERE pool='gate'").all();
        const expected = [{ owner_pid: workers.executor()?.pid, priority: "finish", state: "held" }];
        expect(slots()).toEqual(expected);
        const discoveries = f.store.listProcessDiscoveries(undefined, realpathSync(req.cwd));
        expect(discoveries.some((d) => d.ownerPid === workers.executor()?.pid)).toBe(true);
        controller.abort(new Error("shutdown"));
        expect(await rejected).toBeInstanceOf(Error);
        expect(first.state.gateExecution?.handle).toEqual(handle);
        const scratch = (JSON.parse(workers.job(handle?.id ?? "")?.request ?? "{}") as GateRequest).scratch;
        expect(existsSync(join(scratch ?? "", "setup-token"))).toBe(true);
        expect(slots()).toEqual(expected);
        await recoverProcessCleanups(f.store);
        expect(slots()).toEqual(expected);
        const second = context();
        const resumed = gateCommandScope(second, "gates", "initial", req.cwd, async () => {
          const result = await runGateExecution(second, "gates", "initial", req.cwd, req.gates);
          expect(workers.jobs("in_place=1")).toHaveLength(1);
          const retry = await runGateExecution(second, "gates", "regression-retry", req.cwd, {
            ...req.gates,
            setup: [],
            checks: [{ name: "scratch", run: 'test -f "$HOME/setup-token"' }],
          });
          expect(retry.checks[0]?.ok).toBe(true);
          return result;
        })();
        await wait(() => second.state.gateExecution?.handle.id === handle?.id, { timeoutMs: 10_000 });
        writeFileSync(join(req.cwd, "proceed"), "");
        expect((await resumed).checks[0]?.ok).toBe(true);
        expect(workers.jobs("in_place=1")).toHaveLength(2);
        expect(existsSync(scratch ?? "")).toBe(false);
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

test.each(["confirmed", "failed"])(
  "cancelling a detached scoped gate removes scratch only after waitStopped succeeds (%s)",
  async (confirmation) => {
    const failure = confirmation === "failed";
    const { f, context, req } = await setup();
    const controller = new AbortController();
    req.gates = {
      ...gates,
      setup: ['touch "$HOME/setup-token"'],
      checks: [{ name: "long", run: "echo $$ > gate-pid; while [ ! -f proceed ]; do sleep 0.05; done" }],
    };
    await withExecutor(f, async (workers) => {
      const first = context(controller.signal);
      const pending = gateCommandScope(first, "gates", "initial", req.cwd, () =>
        runGateExecution(first, "gates", "initial", req.cwd, req.gates),
      )().catch((error: unknown) => error);
      const confirmed = Promise.withResolvers<void>();
      const releaseWait = Promise.withResolvers<void>();
      const originalWait = workers.waitStopped.bind(workers);
      let scratch = "";
      let id = "";
      let stopped: ReturnType<typeof spyOn> | undefined;
      const warning = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await wait(
          () => {
            const job = workers.job(first.state.gateExecution?.handle.id ?? "");
            const events: ExecutionEvent[] = JSON.parse(job?.events ?? "[]");
            // A lease precedes execution; also wait for setup to finish.
            return (
              job?.state === "leased" &&
              events.some((e) => e.type === "check" && e.phase === "setup" && e.result.ok)
            );
          },
          { timeoutMs: 10_000 },
        );
        const pid = await waitForPid(join(req.cwd, "gate-pid"));
        const handle = first.state.gateExecution?.handle;
        expect(handle?.kind).toBe("inplace");
        id = handle?.id ?? "";
        scratch = (JSON.parse(workers.job(id)?.request ?? "{}") as GateRequest).scratch ?? "";
        if (!scratch) throw new Error("missing gate scratch");
        controller.abort(new Error("shutdown"));
        expect(await pending).toBeInstanceOf(Error);
        expect(workers.job(id)).toMatchObject({ state: "leased", stopped: 0 });
        expect(recoveryProcessStopped(pid)).toBe(false);
        expect(existsSync(join(scratch, "setup-token"))).toBe(true);
        expect(f.store.getRun(first.run.id)?.status).toBe("queued");
        stopped = spyOn(workers, "waitStopped").mockImplementation(async (jobId) => {
          await originalWait(jobId);
          confirmed.resolve();
          await releaseWait.promise;
          if (failure) throw new Error("fixture stop confirmation failed");
        });
        expect(f.cancelRun(first.run.id)).toBe(true);
        expect(stopped.mock.calls).toEqual([[id]]);
        await confirmed.promise;
        expect(workers.job(id)).toMatchObject({ state: "cancelled", stopped: 1 });
        expect(recoveryProcessStopped(pid)).toBe(true);
        expect(existsSync(scratch)).toBe(true);
        releaseWait.resolve();
        if (failure) {
          await wait(() => warning.mock.calls.length > 0, { timeoutMs: 10_000 });
          expect(warning.mock.calls[0]?.[0]).toContain(
            "Kept in-place gate scratch: Error: fixture stop confirmation failed",
          );
          expect(existsSync(scratch)).toBe(true);
        } else {
          await wait(() => !existsSync(scratch), { timeoutMs: 10_000 });
          expect(warning).not.toHaveBeenCalled();
        }
      } finally {
        releaseWait.resolve();
        stopped?.mockRestore();
        writeFileSync(join(req.cwd, "proceed"), "");
        controller.abort(new Error("shutdown"));
        await pending;
        if (id) {
          workers.cancel(id);
          await originalWait(id);
        }
        // The failure case deliberately retains scratch; the test owns its final cleanup.
        if (scratch) removeScratch(scratch);
        warning.mockRestore();
      }
    });
  },
);

test("cancelling shared scratch waits for the stopped first attempt and its running retry", async () => {
  const { f, context, req } = await setup();
  const runId = context().run.id;
  const scratch = createScratch(req.cwd);
  const request = { ...req, runId, scratch };
  const first = f.workers.enqueue(request, randomUUID(), true);
  const retry = f.workers.enqueue(request, randomUUID(), true);
  // Model the retained jobs after detaching from a stage's retry.
  f.store.db.query("UPDATE gate_jobs SET state='done',stopped=1 WHERE id=?").run(first);
  f.store.db.query("UPDATE gate_jobs SET state='leased',stopped=0 WHERE id=?").run(retry);
  const releaseRetry = Promise.withResolvers<void>();
  const originalWait = f.workers.waitStopped.bind(f.workers);
  const stopped = spyOn(f.workers, "waitStopped").mockImplementation(async (id) => {
    if (id === retry) await releaseRetry.promise;
    await originalWait(id);
  });
  try {
    expect(f.cancelRun(runId)).toBe(true);
    expect(stopped.mock.calls).toEqual([[first], [retry]]);
    // Drain the completed attempt's promise chain, including any premature scratch removal.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.workers.job(first)).toMatchObject({ state: "done", stopped: 1 });
    expect(f.workers.job(retry)).toMatchObject({ state: "cancelled", stopped: 0 });
    expect(existsSync(scratch)).toBe(true);

    f.store.db.query("UPDATE gate_jobs SET stopped=1 WHERE id=?").run(retry);
    releaseRetry.resolve();
    await wait(() => !existsSync(scratch), { timeoutMs: 10_000 });
  } finally {
    f.store.db.query("UPDATE gate_jobs SET stopped=1 WHERE id=?").run(retry);
    releaseRetry.resolve();
    await Promise.all(stopped.mock.results.map(({ value }) => value));
    await new Promise<void>((resolve) => setImmediate(resolve));
    stopped.mockRestore();
    removeScratch(scratch);
  }
});

test.each(["sha", "missing", "release", "environment"])(
  "resume rejects a %s mismatch instead of waiting on the old handle",
  async (kind) => {
    const { f, context, req } = await setup();
    const ctx = context();
    const scratch = kind === "missing" ? undefined : createScratch(req.cwd);
    const pidFile = join(fixture.home, "stale-pid");
    const proceed = join(fixture.home, "stale-proceed");
    // A short stale job can finish before resume. Persist first, then wait for cancellable work.
    const old = f.workers.enqueue(
      {
        ...req,
        scratch,
        gates: {
          ...gates,
          setup: [],
          checks: [
            {
              name: "stale",
              run: `echo $$ > '${pidFile}'; while [ ! -f '${proceed}' ]; do sleep 0.05; done`,
            },
          ],
        },
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
    try {
      await withExecutor(f, async (workers) => {
        if (kind === "sha" || kind === "environment") {
          await wait(() => existsSync(pidFile) || workers.job(old)?.state === "done", {
            timeoutMs: 10_000,
          });
          expect(workers.job(old)?.state).toBe("leased");
          await waitForPid(pidFile);
        }
        const executor = f.deps.gateExecutor;
        if (!executor) throw new Error("missing gate executor");
        const attach = executor.attach.bind(executor);
        const attached = spyOn(executor, "attach").mockImplementation((handle, ...args) => {
          if (handle.id === old) throw new Error("attached to stale gate result");
          return attach(handle, ...args);
        });
        try {
          expect(await runGateExecution(context(), "gates", "initial", req.cwd, gates)).toMatchObject({
            setupOk: true,
            sha: req.headSha,
          });
          expect(attached.mock.calls).toHaveLength(1);
          expect(attached.mock.calls[0]?.[0]).toMatchObject({ kind: "inplace" });
          expect(readFileSync(join(req.cwd, "greeting.txt"), "utf8")).toBe("hello\n");
          expect(existsSync(join(req.cwd, "old-build"))).toBe(false);
          if (kind !== "missing") expect(workers.job(old)?.state).toBe("cancelled");
          if (scratch) expect(existsSync(scratch)).toBe(false);
          expect(workers.jobs("in_place=1 AND state='done'")).toHaveLength(1);
        } finally {
          attached.mockRestore();
        }
      });
    } finally {
      writeFileSync(proceed, "");
      f.workers.cancel(old);
      await f.workers.waitStopped(old);
      if (scratch) removeScratch(scratch);
    }
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

test.each(["SHA", "daemon port"])(
  "a running %s mismatch waits for the executor to acknowledge process shutdown",
  async (kind) => {
    const { f, context, req } = await setup();
    const port = f.cfg.port === 65535 ? 1 : f.cfg.port + 1;
    await withExecutor(f, async (workers) => {
      const first = context();
      const controller = new AbortController();
      const current = new RunContext(f.deps, first.run, first.repo, controller.signal);
      const long = {
        ...gates,
        setup: [],
        checks: [
          { name: "long", run: "echo $$ > previous-pid; while [ ! -f stop-old ]; do sleep 0.05; done" },
        ],
      };
      const pending = gateCommandScope(current, "gates", "initial", req.cwd, () =>
        runGateExecution(current, "gates", "initial", req.cwd, long),
      )().catch((e) => e);
      const confirmed = Promise.withResolvers<void>();
      const releaseWait = Promise.withResolvers<void>();
      let stopped: ReturnType<typeof spyOn> | undefined;
      let checkout: ReturnType<typeof spyOn> | undefined;
      let replacement: ReturnType<typeof runGateExecution> | undefined;
      try {
        const pid = await waitForPid(join(req.cwd, "previous-pid"));
        const old = current.state.gateExecution?.handle.id ?? "";
        const scratch = (JSON.parse(workers.job(old)?.request ?? "{}") as GateRequest).scratch;
        if (!scratch) throw new Error("missing gate scratch");
        controller.abort(new Error("shutdown"));
        await pending;
        writeFileSync(join(req.cwd, "greeting.txt"), "old gate output\n");
        writeFileSync(join(req.cwd, "old-build"), "old gate output\n");
        if (kind === "SHA") {
          writeFileSync(join(req.cwd, "new-file"), "head moved");
          await sh(["git", "add", "new-file"], { cwd: req.cwd });
          await sh(["git", "commit", "-qm", "new head"], { cwd: req.cwd });
        }
        const resumed =
          kind === "SHA"
            ? context()
            : new RunContext({ ...f.deps, cfg: { ...f.deps.cfg, port } }, first.run, first.repo, signal);
        let stoppedBeforeResult = false;
        const originalWait = WorkerStore.prototype.waitStopped;
        stopped = spyOn(WorkerStore.prototype, "waitStopped").mockImplementation(async function (
          this: WorkerStore,
          id,
          signal,
        ) {
          await originalWait.call(this, id, signal);
          if (id === old) {
            confirmed.resolve();
            await releaseWait.promise;
          }
        });
        checkout = spyOn(repos, "checkoutCommitted");
        replacement = runGateExecution(resumed, "gates", "initial", req.cwd, gates, {
          onResult: () => {
            stoppedBeforeResult = recoveryProcessStopped(pid);
          },
        });
        void replacement.catch(() => {});
        await Promise.race([
          confirmed.promise,
          replacement.then(() => {
            throw new Error("replacement finished before stop confirmation");
          }),
        ]);
        expect(workers.job(old)).toMatchObject({ state: "cancelled", stopped: 1 });
        expect(recoveryProcessStopped(pid)).toBe(true);
        expect(checkout).not.toHaveBeenCalled();
        expect(workers.jobs("in_place=1")).toHaveLength(1);
        expect(readFileSync(join(req.cwd, "greeting.txt"), "utf8")).toBe("old gate output\n");
        expect(existsSync(join(req.cwd, "old-build"))).toBe(true);
        expect(existsSync(scratch)).toBe(true);
        releaseWait.resolve();
        expect((await replacement).setupOk).toBe(true);
        expect(checkout).toHaveBeenCalledTimes(1);
        expect(readFileSync(join(req.cwd, "greeting.txt"), "utf8")).toBe("hello\n");
        expect(existsSync(join(req.cwd, "old-build"))).toBe(false);
        expect(existsSync(scratch)).toBe(false);
        expect(workers.job(old)).toMatchObject({ state: "cancelled", stopped: 1 });
        expect(stoppedBeforeResult).toBe(true);
        expect(workers.jobs("in_place=1")).toHaveLength(2);
        const ports = readFileSync(join(fixture.home, "executor-ports"), "utf8").trim().split("\n");
        expect(ports.at(-1)).toBe(String(kind === "SHA" ? f.cfg.port : port));
      } finally {
        releaseWait.resolve();
        await replacement?.catch(() => {});
        stopped?.mockRestore();
        checkout?.mockRestore();
        writeFileSync(join(req.cwd, "stop-old"), "");
        controller.abort(new Error("shutdown"));
        await pending;
      }
    });
  },
);

test("a daemon release change stops a running job before in-process fallback", async () => {
  const { f, context, req } = await setup();
  const attempted = join(fixture.home, "attempted");
  await withExecutor(f, async (workers) => {
    const long = {
      ...gates,
      setup: [],
      checks: [
        {
          name: "long",
          run: `if [ ! -f '${attempted}' ]; then touch '${attempted}'; echo $$ > previous-pid; while [ ! -f proceed ]; do sleep 0.05; done; fi`,
        },
      ],
    };
    const pending = runGateExecution(context(), "gates", "initial", req.cwd, long);
    const rejected = pending.catch((e) => e);
    try {
      const pid = await waitForPid(join(req.cwd, "previous-pid"));
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
        const pid = await waitForPid(pidFile);
        const id = first.state.gateExecution?.handle.id ?? "";
        controller.abort(new Error("shutdown"));
        await pending;
        await crash();
        expect(workers.job(id)?.stopped).toBe(0);
        expect(f.store.listProcessDiscoveries(undefined, realpathSync(req.cwd)).length).toBeGreaterThan(0);
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
        expect(f.store.listProcessDiscoveries(undefined, realpathSync(req.cwd))).toHaveLength(0);
        expect(f.store.listProcessCleanups(undefined, realpathSync(req.cwd))).toHaveLength(0);
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
      expect(await waitFor(next, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        purpose === "initial" ? "needs_human" : "succeeded",
      );
      if (purpose === "initial") {
        // The resumed gate passes against its edited file, so it cannot attest to the commit.
        const completed = next.store.getRunState<RunContext["state"]>(run.id);
        expect(completed?.lastGates?.find((check) => check.name === "build")?.result.ok).toBe(true);
        expect(completed?.gateEvidence).toBeUndefined();
        expect(next.store.getRun(run.id)?.error).toContain("missing or inconsistent passing round evidence");
      }
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
