import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Factory } from "../src/app.ts";
import { agentTestCommand, type WrapperConfig } from "../src/cli/agent-test.ts";
import { startDaemon } from "../src/cli/daemon.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { type AgentJobRequest, tokenHash, WorkerStore } from "../src/db/workers.ts";
import { agentTestLease } from "../src/gates/agent-tests.ts";
import {
  type ExecutionHandle,
  executeGate,
  type GateRequest,
  type GateRunner,
  gateExecutorFor,
  localExecutor,
} from "../src/gates/executor.ts";
import { redactGateData } from "../src/gates/output.ts";
import { loadPrivateStrings, privateStringsDigest } from "../src/gates/private.ts";
import {
  compareGates,
  type GateRun,
  retryBaselineFailures,
  retryFailures,
  retryRegressions,
  runLocalGates,
} from "../src/gates/run.ts";
import { acquireGateSlot, gateSlotScope, gateSlots } from "../src/gates/slots.ts";
import * as gitCommand from "../src/git/command.ts";
import { worktreeGit } from "../src/git/command.ts";
import { withRepoLock } from "../src/git/repos.ts";
import { runClaude } from "../src/harness/claude.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import { ConfinementError, readPolicyScope } from "../src/harness/read-policy.ts";
import { confinementScope, seatbeltProfile } from "../src/harness/sandbox.ts";
import * as scratchPolicy from "../src/harness/scratch.ts";
import { removeScratch } from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { githubToken } from "../src/integrations/github-token.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { runGateExecution } from "../src/pipeline/gate-execution.ts";
import { createApiToken } from "../src/server/api-token.ts";
import { startHttp } from "../src/server/http.ts";
import { startWorkerListener } from "../src/server/workers.ts";
import { privateReadPaths } from "../src/util/private-reads.ts";
import * as proc from "../src/util/proc.ts";
import {
  CommandError,
  invocationScratch,
  type ProcessDiscovery,
  ProcessTerminationError,
  processBootInspection,
  processInspection,
  processRecoveryInspection,
  processScope,
  recoveryProcessStopped,
  redactCredentials,
  registerCredential,
  runProcess,
  sh,
} from "../src/util/proc.ts";
import { AgentEvents } from "../src/workers/agent-protocol.ts";
import { pairWorker, runWorker as runWorkerClient } from "../src/workers/client.ts";
import { type Capabilities, CheckEvent, Heartbeat, pairingCode, Result } from "../src/workers/protocol.ts";
import { publicationFields } from "../src/workers/publication.ts";
import { agentPathMask } from "../src/workers/reporting.ts";
import { certificate, fingerprint, workerRequest } from "../src/workers/tls.ts";
import { updateWorker, WorkerUpdateError } from "../src/workers/update.ts";
import { attemptBudget, credentialBearing, validRun } from "../src/workers/validation.ts";
import { bwrapSkip, fakeConfinement, recordingConfinement, seatbeltSkip } from "./confinement.ts";
import { PreviousHeartbeat } from "./previous-heartbeat.ts";
import { test } from "./read-policy-support.ts";
import {
  captureSetupEnv,
  dependencyPackage,
  expectPrivateSetup,
  expectReaderDependency,
  expectReaderPermissions,
  readerDependencyFixture,
} from "./reader-dependencies-support.ts";
import { seeded } from "./seeded.ts";
import { waitClock } from "./wait-clock.ts";
import { workerStartupFailures } from "./worker-startup-support.ts";

let home: string, cfg: Config, store: Store, workers: WorkerStore;
let listener: Awaited<ReturnType<typeof startWorkerListener>>;
let restoreConfig: string | undefined;
const capabilityRunner: NonNullable<Parameters<typeof runWorkerClient>[4]>["capabilityRunner"] = async (
  args,
) => ({
  exitCode: 0,
  stdout:
    args[1] === "--version"
      ? args[0] === "claude"
        ? "2.1.3 (Claude Code)"
        : "codex-cli 0.50.0"
      : "logged in",
});
const runWorker: typeof runWorkerClient = (coordinator, cfg, release, signal, options) =>
  runWorkerClient(coordinator, cfg, release, signal, { capabilityRunner, ...options });
const releaseSha = "f".repeat(40);
test("strict worker results and check events accept optional bounded skipped-test identities", () => {
  const check = { name: "tests", command: "bun test", ok: true, exitCode: 0, durationMs: 1, output: "" };
  for (const skippedTests of [
    undefined,
    [{ file: "test/one.test.ts", name: "suite > skipped" }],
    [{ file: "test/one.test.ts", name: "suite > skipped", line: 12 }],
    [{ file: "test/one.test.ts", name: "suite > skipped", line: Number.MAX_SAFE_INTEGER }],
    Array.from({ length: 2 }, () => ({ file: "test/one.test.ts", name: "duplicate" })),
  ]) {
    const result = {
      ...check,
      testCoverage: {
        passedFiles: [],
        skippedFiles: ["test/one.test.ts"],
        ...(skippedTests ? { skippedTests, skippedTestsIncomplete: false } : {}),
      },
    };
    const decoded = Result.parse({ sha: releaseSha, run: { setupOk: true, setup: [], checks: [result] } });
    expect(decoded.run.checks[0]?.testCoverage?.skippedTests).toEqual(skippedTests);
    expect(
      CheckEvent.parse({ type: "check", phase: "check", result }).result.testCoverage?.skippedTests,
    ).toEqual(skippedTests);
  }
  for (const sha of [undefined, releaseSha, "f".repeat(64)]) {
    expect(
      Result.safeParse({ sha: releaseSha, run: { sha, setupOk: true, setup: [], checks: [] } }).success,
    ).toBe(true);
  }
  expect(
    Result.safeParse({ sha: releaseSha, run: { sha: "short", setupOk: true, setup: [], checks: [] } })
      .success,
  ).toBe(false);
  for (const skippedTests of [
    ["test/one.test.ts"],
    [{ file: "test/one.test.ts" }],
    [{ file: "", name: "skip" }],
    [{ file: "test/one.test.ts", name: 1 }],
    [{ file: "test/one.test.ts", name: "skip", extra: true }],
    [{ file: "test/one.test.ts", name: "x".repeat(2001) }],
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null].map((line) => [
      { file: "test/one.test.ts", name: "skip", line },
    ]),
    Array.from({ length: 1001 }, () => ({ file: "test/one.test.ts", name: "skip" })),
  ]) {
    const result = { ...check, testCoverage: { passedFiles: [], skippedFiles: [], skippedTests } };
    expect(
      Result.safeParse({ sha: releaseSha, run: { setupOk: true, setup: [], checks: [result] } }).success,
    ).toBe(false);
    expect(CheckEvent.safeParse({ type: "check", phase: "check", result }).success).toBe(false);
  }
});
const fixture = seeded(async (dir) => {
  await sh(["git", "init", "-q", "--template=", dir], { cwd: dir });
  writeFileSync(join(dir, "tracked"), "gate bytes\n");
  await sh(["git", "add", "."], { cwd: dir });
  await sh(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], {
    cwd: dir,
  });
  return (await sh(["git", "rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
});
const caps = (jobs: string[] = []): Capabilities => ({
  releaseSha,
  bunVersion: Bun.version,
  os: "darwin",
  osVersion: "test",
  cpuCount: 4,
  ramBytes: 1024,
  freeSlots: 1,
  onAC: true,
  idleSeconds: 0,
  jobs,
  agents: {
    claude: { version: "2.1.3 (Claude Code)", loggedIn: true },
    codex: { version: "codex-cli 0.50.0", loggedIn: true },
  },
  privateStringsDigest: privateStringsDigest([]),
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "workers-"));
  restoreConfig = process.env.LIMITLESS_CONFIG_DIR;
  process.env.LIMITLESS_CONFIG_DIR = join(home, "config");
  mkdirSync(process.env.LIMITLESS_CONFIG_DIR);
  cfg = loadConfig({ home, configDir: process.env.LIMITLESS_CONFIG_DIR, raw: {} });
  store = new Store(cfg.paths.db);
  workers = new WorkerStore(store, releaseSha, { poll: 30, tick: 5 });
});
afterEach(async () => {
  await listener?.stop();
  listener = undefined;
  store.close();
  if (restoreConfig === undefined) delete process.env.LIMITLESS_CONFIG_DIR;
  else process.env.LIMITLESS_CONFIG_DIR = restoreConfig;
  rmSync(home, { recursive: true, force: true });
});
async function listen(address = "127.0.0.1:0", log = (_text: string) => {}) {
  listener = await startWorkerListener(workers, cfg.paths, address, log);
  if (!listener) throw new Error("Missing listener");
  return listener;
}
async function call(path: string, body?: unknown, token?: string) {
  if (!listener) throw new Error("Missing listener");
  return workerRequest(listener.url.origin, path, body, { token, pin: listener.tls.fingerprint });
}
async function paired(name = "runner") {
  const pending = (await call("/worker/pair", { name, fingerprint: "a".repeat(64) })).json() as {
    code: string;
    secret: string;
  };
  workers.approve(pending.code);
  const { token } = (await call("/worker/pair/claim", { secret: pending.secret })).json() as {
    token: string;
  };
  return token;
}
async function request(bundle = false): Promise<GateRequest> {
  const cwd = join(home, "repo"),
    { value: sha } = await fixture(cwd);
  const repo = store.upsertRepo({
    slug: "test/repo",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "gates" });
  const cache = join(cfg.paths.repos, "test__repo.git");
  if (bundle) await sh(["git", "clone", "--bare", cwd, cache], { cwd: home });
  return {
    runId: run.id,
    repo: repo.slug,
    cwd,
    baseSha: sha,
    headSha: sha,
    gates: {
      setup: ["test -f tracked"],
      checks: [
        { name: "pass", run: "cat tracked" },
        { name: "fail", run: "echo failure; exit 7" },
      ],
      source: "none",
      protectedPaths: [],
    },
  };
}
const fields = (run: GateRun) => run.checks.map(({ name, ok, exitCode }) => ({ name, ok, exitCode }));

test("gate lease captures OS independently of later worker heartbeats", async () => {
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  const id = workers.enqueue(await request());
  expect((await call("/worker/lease", {}, token)).json()).toMatchObject({ job: { id } });
  expect(workers.job(id)?.worker_os).toBe("darwin");
  await call("/worker/heartbeat", { ...caps([id]), os: "linux" }, token);
  expect(workers.job(id)?.worker_os).toBe("darwin");
  const setup = [
    { name: "setup:0", command: "missing", ok: false, exitCode: 127, durationMs: 1, output: "" },
  ];
  expect(workers.complete(id, { setupOk: false, setup, checks: [] })).toBe(true);
  expect(workers.job(id)?.worker_os).toBe("darwin");
  expect(workers.fallbackSetup(id, "missing")).toBe(true);
  expect(workers.complete(id, { setupOk: true, setup: [], checks: [] }, true)).toBe(true);
  expect(workers.job(id)?.worker_os).toBe("darwin");
});

async function failedWorkerSetup(req: GateRequest, afterLease = () => {}, previousFailure = false) {
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  const id = workers.enqueue(req);
  if (previousFailure) workers.fail(id, "Previous worker disconnected");
  expect((await call("/worker/lease", {}, token)).json()).toMatchObject({ job: { id } });
  afterLease();
  const run: GateRun = {
    setupOk: false,
    setup: [
      {
        name: "setup",
        command: req.gates.setup[0] ?? "",
        ok: false,
        exitCode: 9,
        durationMs: 1,
        output: "worker environment failed",
      },
    ],
    checks: [],
  };
  expect((await call(`/worker/jobs/${id}/result`, { sha: req.headSha, run }, token)).status).toBe(200);
  return { kind: "lan" as const, id, startedAt: Date.now() };
}

test.each([
  [true, false],
  [false, false],
  [true, true],
])(
  "worker setup fallback uses the local checks (passing=%s, legacy completion=%s) and keeps sanitized warnings",
  async (passing, legacy) => {
    const req = await request();
    const secret = `setup-warning-credential-595-${passing}-${legacy}`;
    req.gates.setup = [`: '${secret}'`];
    req.gates.checks = [{ name: "check", run: passing ? "cat tracked" : "exit 7" }];
    const handle = await failedWorkerSetup(
      req,
      () => registerCredential("SETUP_WARNING_TEST", secret),
      passing,
    );
    if (legacy) {
      // The previous release retained infrastructure failure reasons on worker completion.
      store.db.query("UPDATE gate_jobs SET failure_reason='Lease expired' WHERE id=?").run(handle.id);
      expect(workers.job(handle.id)).toMatchObject({ state: "done", failure_reason: "Lease expired" });
    }
    expect(workers.list()[0]?.setupWarning).toBeUndefined();
    let localStarts = 0;
    const run = await confinementScope.run(
      {
        ...fakeConfinement,
        async verify(_roots, opts) {
          expect(workers.list()[0]?.setupWarning).toBeUndefined();
          if (opts.cmd.includes(req.gates.setup[0] ?? "missing")) localStarts++;
        },
      },
      () =>
        executeGate(
          req,
          new AbortController().signal,
          {},
          gateExecutorFor("lan", workers, [req.repo]),
          handle,
        ),
    );
    expect(localStarts).toBe(1);
    expect(run.setupOk).toBe(true);
    expect(run.checks[0]?.ok).toBe(passing);
    expect(compareGates(null, run).some((c) => c.blocking)).toBe(!passing);
    const job = workers.job(handle.id);
    expect(job).toMatchObject({ state: "done", worker: "runner", attempt: passing ? 2 : 1 });
    expect(JSON.parse(job?.result ?? "null")).toEqual(run);
    const warning = workers.list()[0]?.setupWarning;
    expect(workers.list()[0]?.state).toBe("available");
    expect(warning).toBe(
      "Worker setup failed: [withheld: private text]; LAN gates falling back to local execution",
    );
    expect(JSON.stringify(store.listEvents(req.runId ?? ""))).not.toContain("runner");
    expect(warning).toContain("[withheld: private text]");
    expect(warning).toContain("falling back to local execution");
    expect(new WorkerStore(store, releaseSha).list()[0]?.setupWarning).toBe(warning);
    expect(job?.events).toContain(warning ?? "missing");
    expect(store.listEvents(req.runId ?? "").some((e) => e.type === "gate" && e.message === warning)).toBe(
      true,
    );
    expect(JSON.stringify([job?.events, workers.list(), store.listEvents(req.runId ?? "")])).not.toContain(
      secret,
    );
    const resumed = await executeGate(
      req,
      new AbortController().signal,
      {},
      gateExecutorFor("lan", workers, [req.repo]),
      handle,
    );
    expect(resumed).toEqual(run);
    expect(localStarts).toBe(1);

    if (passing) {
      const preload = join(home, "workers-fetch.ts");
      writeFileSync(
        preload,
        `globalThis.fetch = async (input) => {
      if (new URL(String(input)).pathname !== '/api/workers') throw new Error('Unexpected request');
      return Response.json(${JSON.stringify([...workers.list(), { name: "pending", state: "pending", code: "PAIRING" }])});
    };`,
      );
      const cli = await sh(
        [
          process.execPath,
          "--preload",
          preload,
          join(import.meta.dir, "../src/cli/main.ts"),
          "workers",
          "ls",
        ],
        { cwd: home, env: { LIMITLESS_HOME: home } },
      );
      expect(cli.exitCode).toBe(0);
      expect(cli.stdout).toContain(`runner\tavailable\t${warning}`);
      expect(cli.stdout).toContain("pending\tpending\tPAIRING");
      expect(cli.stdout).not.toContain(secret);
    }
  },
  30_000,
);

test("successful worker setup clears a confirmed warning and preserves fallback history", async () => {
  const req = await request();
  const first = await failedWorkerSetup(req);
  const failed: GateRun = JSON.parse(workers.job(first.id)?.result ?? "null");
  expect(workers.fallbackSetup(first.id, "test -f tracked")).toBe(true);
  expect(workers.list()[0]?.setupWarning).toBeUndefined();
  expect(workers.complete(first.id, { setupOk: true, setup: [], checks: [] }, true)).toBe(true);
  const warning = workers.list()[0]?.setupWarning;
  expect(warning).toBe(`Worker setup failed: test -f tracked; LAN gates falling back to local execution`);
  expect(JSON.stringify(store.listEvents(req.runId ?? ""))).not.toContain("runner");
  const events = workers.job(first.id)?.events;
  const runEvents = store.listEvents(req.runId ?? "");
  const command = "test -f another-setup";
  const second = workers.enqueue({ ...req, gates: { ...req.gates, setup: [command] } });
  const secondFailed = { ...failed, setup: failed.setup.map((r) => ({ ...r, command })) };
  expect(workers.lease("runner")?.id).toBe(second);
  expect(workers.complete(second, secondFailed)).toBe(true);
  expect(workers.list()[0]?.setupWarning).toBe(warning);
  expect(workers.fallbackSetup(second, command)).toBe(true);
  expect(workers.complete(second, secondFailed, true)).toBe(true);
  expect(workers.list()[0]?.setupWarning).toBe(warning);
  const third = workers.enqueue(req);
  expect(workers.lease("runner")?.id).toBe(third);
  expect(workers.complete(third, { ...failed, setupOk: true, checks: failed.setup })).toBe(true);
  expect(new WorkerStore(store, releaseSha).list()[0]?.setupWarning).toBeUndefined();
  expect(workers.job(first.id)?.events).toBe(events);
  expect(store.listEvents(req.runId ?? "")).toEqual(expect.arrayContaining(runEvents));
});

test("equal timestamps and commands cannot let older or rejected completions change a newer warning", async () => {
  const now = Date.now();
  workers = new WorkerStore(store, releaseSha, { poll: 30, tick: 5 }, () => now);
  const req = await request();
  const first = await failedWorkerSetup(req);
  const failed: GateRun = JSON.parse(workers.job(first.id)?.result ?? "null");
  const passing = { setupOk: true, setup: [], checks: [] };
  const command = req.gates.setup[0] ?? "";
  expect(workers.fallbackSetup(first.id, command)).toBe(true);
  const olderSuccess = workers.enqueue(req);
  expect(workers.lease("runner")?.id).toBe(olderSuccess);
  const worker = workers.worker("runner");
  if (!worker) throw new Error("Missing worker");
  workers.heartbeat(worker, caps([olderSuccess]));
  const newer = workers.enqueue(req);
  expect(workers.lease("runner")?.id).toBe(newer);
  expect(workers.complete(newer, failed)).toBe(true);
  expect(workers.fallbackSetup(newer, command)).toBe(true);
  expect(workers.complete(newer, passing, true)).toBe(true);
  const warning = workers.list()[0]?.setupWarning;
  expect(warning).toContain(command);
  // Simulate a daemon restart before the stale completions arrive.
  workers = new WorkerStore(store, releaseSha, {}, () => now);
  expect(workers.complete(first.id, passing, true)).toBe(true);
  expect(workers.complete(olderSuccess, passing)).toBe(true);
  expect(workers.list()[0]?.setupWarning).toBe(warning);
  expect(workers.fallbackSetup(first.id, "test -f tracked")).toBe(false);
  expect(workers.complete(newer, passing)).toBe(false);
  expect(workers.complete(newer, passing, true)).toBe(false);
  for (const local of [false, true]) {
    const cancelled = workers.enqueue(req);
    expect(workers.lease("runner")?.id).toBe(cancelled);
    if (local) {
      expect(workers.complete(cancelled, failed)).toBe(true);
      expect(workers.fallbackSetup(cancelled, command)).toBe(true);
    }
    workers.cancel(cancelled);
    expect(workers.complete(cancelled, passing, local)).toBe(false);
    expect(workers.list()[0]?.setupWarning).toBe(warning);
  }
  const pending = workers.enqueue(req);
  expect(workers.lease("runner")?.id).toBe(pending);
  expect(workers.complete(pending, failed)).toBe(true);
  expect(workers.fallbackSetup(pending, command)).toBe(true);
  const recovery = workers.enqueue(req);
  expect(workers.lease("runner")?.id).toBe(recovery);
  expect(workers.complete(recovery, passing)).toBe(true);
  expect(workers.complete(pending, passing, true)).toBe(true);
  expect(workers.list()[0]?.setupWarning).toBeUndefined();
});

test.each(["shutdown", "cancel", "stored cancel"])(
  "setup fallback survives %s at a deferred local boundary",
  async (mode) => {
    const req = await request();
    req.gates.checks = [];
    const handle = await failedWorkerSetup(req);
    const started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let localStarts = 0;
    const executor = gateExecutorFor("lan", workers, [req.repo]);
    const execution = confinementScope.run(
      {
        ...fakeConfinement,
        async verify(_roots, opts) {
          if (opts.cmd.includes(req.gates.setup[0] ?? "missing")) localStarts++;
          started.resolve();
          await release.promise;
        },
      },
      () => executor.attach(handle, controller.signal),
    );
    void execution.result.catch(() => {});
    try {
      await started.promise;
      expect(workers.job(handle.id)?.state).toBe("failed");
      expect(workers.list()[0]?.setupWarning).toBeUndefined();
      expect(workers.job(handle.id)?.events).toContain("Worker setup failed: test -f tracked");
      expect(workers.lease("runner")).toBeNull();
      expect(executor.attach(handle, new AbortController().signal)).toBe(execution);
      if (mode === "stored cancel") workers.cancel(handle.id);
      else controller.abort(new Error(mode));
      release.resolve();
      await expect(execution.result).rejects.toThrow();
      expect(workers.job(handle.id)?.state).toBe(mode === "shutdown" ? "failed" : "cancelled");
      expect(workers.list()[0]?.setupWarning).toBeUndefined();
      if (mode === "shutdown") {
        const run = await confinementScope.run(
          {
            ...fakeConfinement,
            async verify() {
              localStarts++;
            },
          },
          () =>
            executeGate(
              req,
              new AbortController().signal,
              {},
              gateExecutorFor("lan", workers, [req.repo]),
              handle,
            ),
        );
        expect(run.setupOk).toBe(true);
        expect(localStarts).toBe(2);
        expect(workers.job(handle.id)?.state).toBe("done");
        expect(workers.list()[0]?.setupWarning).toContain("Worker setup failed");
        const events: { type: string; text?: string }[] = JSON.parse(workers.job(handle.id)?.events ?? "[]");
        expect(events.filter((e) => e.text?.includes("Worker setup failed"))).toHaveLength(1);
      } else {
        const resumed = gateExecutorFor("lan", workers, [req.repo]).attach(
          handle,
          new AbortController().signal,
        );
        await expect(resumed.result).rejects.toThrow("cancelled");
        expect(localStarts).toBe(1);
      }
    } finally {
      release.resolve();
      controller.abort();
      await execution.result.catch(() => {});
    }
  },
  30_000,
);

test("pairing codes carry 80 digest bits and approval requires all sixteen symbols", () => {
  // SHA-256 starts fc579917943cf97e15118b1405dc17eb for these inputs;
  // each symbol encodes the low five bits of a distinct digest byte.
  expect(pairingCode("a".repeat(64), "c".repeat(64), "d".repeat(64))).toBe("6Z3ZW638XTMWF6ZM");
  workers.pairingKey = "test-pairing-key";
  const pending = workers.pair("runner", "c".repeat(64), "a".repeat(64));
  expect(pending.code).toMatch(/^[A-HJ-NP-Z2-9]{16}$/);
  expect(workers.worker("runner")?.pairing_code).toBe(pending.code);
  expect(workers.list()[0]?.code).toBe(pending.code);
  const last = pending.code.endsWith("A") ? "B" : "A";
  for (const code of [pending.code.slice(0, 8), pending.code.slice(0, -1) + last]) {
    expect(() => workers.approve(code)).toThrow("No pending pairing with that code");
    expect(workers.worker("runner")?.state).toBe("pending");
  }
  expect(workers.approve(pending.code)).toEqual({ name: "runner", state: "approved" });
});

test("pairing grants no access before owner approval; claims require a separate secret and revocation is immediate", async () => {
  await listen();
  const pending = (await call("/worker/pair", { name: "runner", fingerprint: "a".repeat(64) })).json() as {
    code: string;
    secret: string;
    token?: string;
  };
  expect(pending.token).toBeUndefined();
  expect(redactCredentials(pending.secret)).toBe("[redacted]");
  expect(redactCredentials(pending.code)).toBe(pending.code);
  expect((await call("/worker/pair/claim", { secret: pending.secret })).json()).toEqual({ pending: true });
  expect((await call("/worker/heartbeat", caps(), pending.code)).status).toBe(401);
  expect((await call("/worker/lease", {}, pending.secret)).status).toBe(401);
  workers.approve(pending.code);
  const { token } = (await call("/worker/pair/claim", { secret: pending.secret })).json() as {
    token: string;
  };
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(workers.worker("runner")?.token_hash).toBe(tokenHash(token));
  expect((await call("/worker/heartbeat", caps(), token)).status).toBe(200);
  expect((await call("/worker/heartbeat", { ...caps(), extra: 1 }, token)).status).toBe(400);
  workers.revoke("runner");
  expect((await call("/worker/heartbeat", caps(), token)).status).toBe(401);
  expect((await call("/worker/lease", {}, token)).status).toBe(401);
  expect((await call(`/worker/jobs/${crypto.randomUUID()}/bundle`, undefined, token)).status).toBe(401);
  for (let i = 0; i < 3; i++)
    expect((await call("/worker/pair", { name: `other${i}`, fingerprint: "a".repeat(64) })).status).toBe(200);
  expect((await call("/worker/pair", { name: "rate-limited", fingerprint: "a".repeat(64) })).status).toBe(
    429,
  );
}, 30_000);

test("TLS is pinned before sending bearer data, material is private, listener is optional and owner routes are isolated", async () => {
  expect(await startWorkerListener(workers, cfg.paths)).toBeUndefined();
  const server = await listen();
  expect((await call("/api/workers")).status).toBe(404);
  expect((await call("/api/runs")).status).toBe(404);
  expect(statSync(server.tls.keyPath).mode & 0o777).toBe(0o600);
  expect(privateReadPaths()).toContain(server.tls.keyPath);
  const authenticate = spyOn(workers, "authenticate");
  await expect(
    workerRequest(server.url.origin, "/worker/heartbeat", caps(), {
      token: "b".repeat(64),
      pin: "0".repeat(64),
    }),
  ).rejects.toThrow("fingerprint changed");
  for (const pin of [undefined, "", "invalid"]) {
    await expect(
      workerRequest(server.url.origin, "/worker/heartbeat", caps(), { token: "b".repeat(64), pin }),
    ).rejects.toThrow("pinned coordinator fingerprint");
  }
  expect(authenticate).not.toHaveBeenCalled();
  authenticate.mockRestore();
  const fingerprint = server.tls.fingerprint;
  await server.stop();
  listener = undefined;
  expect((await listen()).tls.fingerprint).toBe(fingerprint);
}, 30_000);

test.each([false, true])(
  "pairing independently binds both TLS endpoints (relayed: %s)",
  async (relayed) => {
    let coordinatorCode = "";
    const server = await listen("127.0.0.1:0", (text) => {
      coordinatorCode = text.split(": ")[1] ?? "";
    });
    const tls = await certificate(join(home, "relay"));
    let forwardedCode = "";
    const relay = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: tls.key, cert: tls.cert },
      async fetch(req) {
        const reply = await workerRequest(server.url.origin, new URL(req.url).pathname, await req.json(), {
          pin: server.tls.fingerprint,
        });
        const body = reply.json() as { code?: string };
        if (body.code) forwardedCode = body.code;
        return Response.json(body, { status: reply.status });
      },
    });
    const remote = join(home, "pairing-worker");
    let workerCode = "";
    try {
      const task = pairWorker(
        relayed ? relay.url.origin : server.url.origin,
        remote,
        "endpoint-test",
        (text) => {
          workerCode = text.split(": ")[1] ?? "";
          // The owner approves only the code independently displayed by the worker.
          workers.approve(workerCode);
        },
      );
      if (relayed) {
        await expect(task).rejects.toThrow("No pending pairing with that code");
        expect(forwardedCode).toBe(coordinatorCode);
        expect(workerCode).not.toBe(coordinatorCode);
        expect(workers.worker("endpoint-test")?.state).toBe("pending");
        for (const file of ["token", "coordinator-fingerprint"])
          expect(existsSync(join(remote, file))).toBe(false);
      } else {
        await task;
        expect(workerCode).toBe(coordinatorCode);
        expect(readFileSync(join(remote, "coordinator-fingerprint"), "utf8")).toBe(server.tls.fingerprint);
        expect(workers.authenticate(readFileSync(join(remote, "token"), "utf8"))?.name).toBe("endpoint-test");
      }
    } finally {
      await relay.stop(true);
      tls.release();
    }
  },
  30_000,
);

test("the worker registers a received claim secret before displaying its locally derived code", async () => {
  const tls = await certificate(join(home, "redaction-server"));
  const secret = randomBytes(32).toString("hex"),
    nonce = randomBytes(32).toString("hex");
  let workerFingerprint = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: tls.key, cert: tls.cert },
    async fetch(req) {
      workerFingerprint = ((await req.json()) as { fingerprint: string }).fingerprint;
      return Response.json({ code: "UNTRUSTED", secret, nonce, expiresAt: Date.now() + 600_000 });
    },
  });
  try {
    expect(redactCredentials(secret)).toBe(secret);
    await expect(
      pairWorker(server.url.origin, join(home, "redaction-worker"), "redaction", (text) => {
        expect(redactCredentials(secret)).toBe("[redacted]");
        expect(text).toBe(`Worker pairing code: ${pairingCode(tls.fingerprint, workerFingerprint, nonce)}`);
        expect(redactCredentials(text)).toBe(text);
        throw new Error("Owner declined pairing");
      }),
    ).rejects.toThrow("Owner declined pairing");
  } finally {
    await server.stop(true);
    tls.release();
  }
}, 30_000);

test("claim secrets isolate pending, approved, revoked and expired pairings across listener restarts", async () => {
  let now = Date.now();
  workers = new WorkerStore(store, releaseSha, {}, () => now);
  const server = await listen();
  const first = workers.pair("first", "a".repeat(64), server.tls.fingerprint);
  const second = workers.pair("second", "b".repeat(64), server.tls.fingerprint);
  workers.approve(first.code);
  const claim = (secret: string) => call("/worker/pair/claim", { secret });
  const unknown = randomBytes(32).toString("hex");
  expect(redactCredentials(unknown)).toBe(unknown);
  expect((await claim(unknown)).status).toBe(400);
  expect(redactCredentials(unknown)).toBe(unknown);
  expect((await claim(second.secret)).json()).toEqual({ pending: true });
  const firstToken = (await claim(first.secret)).json();
  await server.stop();
  listener = undefined;
  workers = new WorkerStore(store, releaseSha, {}, () => now);
  await listen();
  expect(workers.worker("first")?.pairing_code).toBe(first.code);
  expect((await claim(first.secret)).json()).toEqual(firstToken);
  workers.approve(second.code);
  const secondToken = (await claim(second.secret)).json();
  expect(secondToken).not.toEqual(firstToken);
  expect(workers.authenticate((secondToken as { token: string }).token)?.name).toBe("second");
  workers.revoke("first");
  expect((await claim(first.secret)).status).toBe(400);
  expect((await claim(second.secret)).json()).toEqual(secondToken);
  now += 600_000;
  expect((await claim(second.secret)).status).toBe(400);
});

test("a fresh coordinator process registers an incoming claim secret before reconstructing its token", async () => {
  workers.pairingKey = "test-pairing-key";
  const pending = workers.pair("runner", "a".repeat(64), "b".repeat(64));
  workers.approve(pending.code);
  const expected = workers.claim(pending.secret);
  const script = `
    import assert from "node:assert/strict";
    import { Store } from "./src/db/store.ts";
    import { WorkerStore } from "./src/db/workers.ts";
    import { redactCredentials } from "./src/util/proc.ts";
    const { db, secret, key, expected } = JSON.parse(await Bun.stdin.text());
    const store = new Store(db);
    try {
      const workers = new WorkerStore(store, ${JSON.stringify(releaseSha)});
      workers.pairingKey = key;
      assert.equal(redactCredentials(secret), secret);
      assert.deepEqual(workers.claim(secret), expected);
      assert.equal(redactCredentials(secret), "[redacted]");
    } finally {
      store.close();
    }
  `;
  await sh([process.execPath, "-e", script], {
    cwd: join(import.meta.dir, ".."),
    stdin: JSON.stringify({
      db: cfg.paths.db,
      secret: pending.secret,
      key: workers.pairingKey,
      expected,
    }),
    timeoutMs: 10_000,
  });
});

test("expired pending requests are hidden and pruned within the pending cap without removing other states", () => {
  let now = Date.now();
  workers = new WorkerStore(store, releaseSha, {}, () => now);
  workers.pairingKey = "test-pairing-key";
  const pair = (name: string) => workers.pair(name, "a".repeat(64), "b".repeat(64));
  workers.approve(pair("approved").code);
  workers.approve(pair("revoked").code);
  workers.revoke("revoked");
  for (let cycle = 0; cycle < 3; cycle++) {
    for (let i = 0; i < 100; i++) pair(`pending-${cycle}-${i}`);
    expect(() => pair("over-cap")).toThrow("Too many pending requests");
    expect(store.db.query("SELECT count(*) n FROM workers WHERE state='pending'").get()).toEqual({ n: 100 });
    expect(workers.list().filter((w) => w.state === "pending")).toHaveLength(100);
    now += 600_000;
    expect(workers.list().map((w) => w.name)).toEqual(["approved", "revoked"]);
  }
  pair("fresh");
  expect(store.db.query("SELECT count(*) n FROM workers").get()).toEqual({ n: 3 });
  expect(workers.worker("approved")?.state).toBe("approved");
  expect(workers.worker("revoked")?.state).toBe("revoked");
});

test.each(["releaseSha", "bunVersion"] as const)(
  "fresh matching workers alone can lease; %s mismatch is shown as needs update",
  async (field) => {
    await listen();
    const wrong = await paired("wrong"),
      right = await paired("right");
    await call("/worker/heartbeat", { ...caps(), [field]: "different" }, wrong);
    await call("/worker/heartbeat", caps(), right);
    const id = workers.enqueue({
      repo: "test/repo",
      cwd: home,
      baseSha: releaseSha,
      headSha: releaseSha,
      gates: { setup: [], checks: [], source: "none", protectedPaths: [] },
    });
    expect((await call("/worker/lease", {}, wrong)).json()).toEqual({ job: null, agentJob: null });
    expect(workers.list().find((w) => w.name === "wrong")?.state).toBe("needs update");
    const lease = (await call("/worker/lease", {}, right)).json() as {
      job: { id: string; request: GateRequest };
    };
    expect(lease.job.id).toBe(id);
    expect(workers.job(id)?.lease_expires_at).toBeGreaterThan(Date.now());
    expect(lease.job).toMatchObject({ request: { cwd: "" } });
    for (const action of ["bundle", "events", "result", "failure"])
      expect(
        (await call(`/worker/jobs/${id}/${action}`, action === "bundle" ? undefined : {}, wrong)).status,
      ).toBe(409);
    workers.cancel(id);
    expect((await call("/worker/heartbeat", caps([id]), right)).json()).toEqual({
      cancelled: [id],
      releaseSha,
    });
  },
  30_000,
);

test("heartbeats record capabilities, cancel unknown jobs and become stale after thirty seconds", async () => {
  let now = Date.now();
  workers = new WorkerStore(store, releaseSha, {}, () => now);
  await listen();
  const token = await paired();
  expect(workers.list()[0]?.state).toBe("offline");
  const id = crypto.randomUUID();
  expect((await call("/worker/heartbeat", caps([id]), token)).json()).toEqual({
    cancelled: [id],
    releaseSha,
  });
  expect(workers.list()[0]).toMatchObject({
    state: "available",
    lastHeartbeatAt: now,
    capabilities: Heartbeat.omit({ agents: true, privateStringsDigest: true })
      .strip()
      .parse(caps([id])),
  });
  await call("/worker/heartbeat", { ...caps([id]), freeSlots: 0 }, token);
  expect(workers.list()[0]?.state).toBe("busy");
  now += 30_001;
  expect(workers.list()[0]?.state).toBe("offline");
}, 30_000);

test("worker routes authenticate first and reject jobs without the caller's lease", async () => {
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  for (const action of ["bundle", "events", "result", "failure"]) {
    const path = `/worker/jobs/${crypto.randomUUID()}/${action}`;
    const body = action === "bundle" ? undefined : {};
    expect((await call(path, body)).status).toBe(401);
    expect((await call(path, body, token)).status).toBe(409);
  }
  expect((await call("/worker/lease", {}, token)).json()).toEqual({ job: null, agentJob: null });
  expect((await call("/worker/unknown", {}, token)).status).toBe(404);
  expect(store.db.query("SELECT COUNT(*) n FROM gate_jobs").get()).toEqual({ n: 0 });
}, 30_000);

async function loop(
  options: Parameters<typeof runWorker>[4] = {},
  name = "loop-runner",
  configDir = cfg.paths.configDir,
) {
  if (!listener) throw new Error("Missing listener");
  const remote = loadConfig({
    home: join(home, name === "loop-runner" ? "remote" : name),
    configDir,
    raw: {},
  });
  await pairWorker(listener.url.origin, join(remote.paths.home, "worker"), name, (text) =>
    workers.approve(text.split(": ")[1] ?? ""),
  );
  const controller = new AbortController();
  const task = runWorker(listener.url.origin, remote, releaseSha, controller.signal, {
    platform: "darwin",
    confinement: fakeConfinement,
    heartbeatMs: 10,
    retryMs: 5,
    machineState: async () => ({ onAC: true, idleSeconds: 0 }),
    ...options,
  });
  void task.catch(() => {});
  return {
    remote,
    controller,
    task,
    stop: async () => {
      controller.abort();
      await task;
    },
  };
}

function workerCleanupRecords(remote: Config) {
  const local = new Store(join(remote.paths.home, "worker", "worker.db"));
  try {
    expect(local.getSetting("worker.cleanups", {})).toEqual({});
    return local.listProcessCleanups();
  } finally {
    local.close();
  }
}

test("the idle worker pairs, heartbeats and long-polls until cleanly aborted", async () => {
  await listen();
  const paths: string[] = [];
  const transport = await import("../src/workers/tls.ts"),
    original = transport.workerRequest;
  const secondHeartbeat = Promise.withResolvers<void>();
  const spy = spyOn(transport, "workerRequest").mockImplementation(async (...args) => {
    paths.push(args[1]);
    const reply = await original(...args);
    if (paths.filter((p) => p === "/worker/heartbeat").length >= 2) secondHeartbeat.resolve();
    return reply;
  });
  let worker: Awaited<ReturnType<typeof loop>> | undefined;
  try {
    worker = await loop();
    await Promise.race([
      secondHeartbeat.promise,
      worker.task.then(() => {
        throw new Error("Worker stopped early");
      }),
    ]);
    expect(workers.list()[0]).toMatchObject({ state: "available", capabilities: { jobs: [] } });
    expect(workers.list()[0]?.lastHeartbeatAt).toBeNumber();
    expect(new Set(paths)).toEqual(
      new Set(["/worker/pair", "/worker/pair/claim", "/worker/heartbeat", "/worker/lease"]),
    );
    for (const name of ["token", "key.pem", "coordinator-fingerprint"]) {
      const path = join(worker.remote.paths.home, "worker", name);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(privateReadPaths()).toContain(path);
    }
    worker.controller.abort();
    await worker.task;
    for (const name of ["token", "key.pem", "coordinator-fingerprint"])
      expect(privateReadPaths()).not.toContain(join(worker.remote.paths.home, "worker", name));
  } finally {
    await worker?.stop();
    spy.mockRestore();
  }
}, 30_000);

test.each([401, 403])(
  "a %d response stops the worker without retrying",
  async (status) => {
    await listen();
    let requests = 0;
    const worker = await loop({
      async request(...args) {
        requests++;
        return { ...(await workerRequest(...args)), status };
      },
    });
    try {
      await expect(worker.task).rejects.toThrow(`Coordinator refused worker request (${status})`);
      expect(requests).toBe(1);
    } finally {
      worker.controller.abort();
      await worker.task.catch(() => {});
    }
  },
  30_000,
);

test.skipIf(seatbeltSkip !== null)(
  `worker credentials and coordinator TLS key are denied inside real gates (${seatbeltSkip})`,
  async () => {
    // Retained files must stay protected even after their listener/worker has stopped.
    const tls = await certificate(join(home, "worker-tls"));
    tls.release();
    const dir = join(home, "worker");
    mkdirSync(dir);
    const files = [
      tls.keyPath,
      join(dir, "token"),
      join(dir, "key.pem"),
      join(dir, "coordinator-fingerprint"),
    ];
    for (const p of files.slice(1)) writeFileSync(p, "synthetic-private-file", { mode: 0o600 });
    cfg.port = 0;
    const factory = new Factory(cfg, { store, bootSha: releaseSha, models: [], providers: [] });
    const start = spyOn(factory, "start").mockImplementation(() => {});
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    const readable = join(home, "readable");
    writeFileSync(readable, "gate-read-control");
    try {
      expect(cfg.workers.listen).toBeUndefined();
      daemon = await startDaemon(factory, {}, async () => ({ routes: {}, notes: [], stop: async () => {} }));
      for (const p of files) {
        expect(statSync(p).mode & 0o777).toBe(0o600);
        expect(privateReadPaths()).toContain(p);
      }
      const run = await runLocalGates(
        home,
        {
          setup: [`cat '${readable}'`],
          source: "none",
          protectedPaths: [],
          checks: files.map((p, i) => ({ name: `deny-${i}`, run: `cat '${p}'` })),
        },
        new AbortController().signal,
      );
      expect(run.setupOk).toBe(true);
      expect(run.setup[0]?.output).toContain("gate-read-control");
      expect(run.checks).toHaveLength(4);
      for (const check of run.checks) {
        expect(check.ok).toBe(false);
        expect(check.confinementError).toBe(false);
        expect(check.output).toMatch(/Operation not permitted|Permission denied/);
        expect(check.output).not.toContain("synthetic-private-file");
      }
      for (const p of files) expect(statSync(p).mode & 0o777).toBe(0o600);
    } finally {
      await daemon?.server.stop(true);
      start.mockRestore();
      await factory.stop();
    }
    for (const p of files) expect(privateReadPaths()).not.toContain(p);
  },
);

test("owner API requires authentication for approval, listing and revocation and never serves worker routes", async () => {
  cfg.port = 0;
  const factory = new Factory(cfg, { store, bootSha: releaseSha, models: [], providers: [] });
  workers = factory.workers;
  await listen();
  const credential = createApiToken(cfg.paths.home);
  const owner = await startHttp(factory, {}, Bun.serve, credential);
  const post = (path: string, body: unknown, authorized = true) =>
    fetch(new URL(path, owner.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: `Bearer ${credential.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const pending = (
      await call("/worker/pair", { name: "owner-approved", fingerprint: "a".repeat(64) })
    ).json() as { code: string; secret: string };
    expect((await post("/api/workers/approve", { code: pending.code }, false)).status).toBe(401);
    expect((await fetch(new URL("/api/workers", owner.url))).status).toBe(401);
    expect((await post("/api/workers/approve", { code: pending.code })).status).toBe(200);
    const { token } = (await call("/worker/pair/claim", { secret: pending.secret })).json() as {
      token: string;
    };
    expect((await call("/worker/heartbeat", caps(), token)).status).toBe(200);
    expect(
      (
        await fetch(new URL("/api/workers", owner.url), {
          headers: { authorization: `Bearer ${credential.token}` },
        })
      ).status,
    ).toBe(200);
    for (const required of [true, false]) {
      cfg.requireApiToken = required;
      expect((await post("/worker/heartbeat", caps())).status).toBe(404);
      expect((await post("/worker/pair", {})).status).toBe(404);
      expect((await post("/worker/heartbeat", caps(), false)).status).toBe(404);
      expect((await fetch(new URL("/api/workers", owner.url))).status).toBe(401);
      expect((await post("/api/workers/approve", { code: pending.code }, false)).status).toBe(401);
      expect((await post("/api/workers/owner-approved/revoke", {}, false)).status).toBe(401);
    }
    const req = await request();
    const id = workers.enqueue(req);
    const agentReq: AgentJobRequest = {
      runId: req.runId ?? "",
      invocationId: 1,
      parentSha: releaseSha,
      prompt: "agent",
      timeoutMs: 1000,
      target: {
        modelId: "fake",
        provider: "fake",
        harness: "claude",
        model: "fake",
        vendor: "fake",
        tier: 1,
        billing: "free",
      },
    };
    const agentIds = Array.from({ length: 5 }, () => workers.enqueueAgentJob(agentReq) ?? "");
    const [done = "", leased = "", failed = "", queued = "", other = ""] = agentIds;
    expect(workers.leaseAgentJob("owner-approved")?.id).toBe(done);
    expect(workers.completeAgentJob(done, {}, releaseSha)).toBe(true);
    expect(workers.leaseAgentJob("owner-approved")?.id).toBe(leased);
    workers.failAgentJob(failed, "failure");
    workers.failAgentJob(failed, "failure");
    store.db.query("UPDATE agent_jobs SET run_id='other-run' WHERE id=?").run(other);
    const persisted = workers.agentJob(leased);
    const restarted = new Factory(cfg, { store, bootSha: releaseSha, models: [], providers: [] });
    expect(restarted.workers.agentJob(leased)).toEqual(persisted);
    expect(factory.cancelRun(req.runId ?? "")).toBe(true);
    for (const id of [leased, failed, queued]) expect(workers.agentJob(id)?.state).toBe("cancelled");
    expect(workers.agentJob(done)?.state).toBe("done");
    expect(workers.agentJob(other)?.state).toBe("queued");
    expect(factory.cancelRun("missing-run")).toBe(false);
    expect(workers.agentJob(other)?.state).toBe("queued");
    expect(workers.job(id)?.state).toBe("cancelled");
    const warningJob = workers.enqueue(req);
    expect(workers.lease("owner-approved")?.id).toBe(warningJob);
    workers.complete(warningJob, { setupOk: false, setup: [], checks: [] });
    workers.fallbackSetup(warningJob, "test -f tracked");
    expect(workers.list()[0]?.setupWarning).toBeUndefined();
    workers.complete(warningJob, { setupOk: true, setup: [], checks: [] }, true);
    const listing = await fetch(new URL("/api/workers", owner.url), {
      headers: { authorization: `Bearer ${credential.token}` },
    });
    expect(await listing.json()).toMatchObject([
      { name: "owner-approved", state: "available", setupWarning: workers.list()[0]?.setupWarning },
    ]);
    expect((await post("/api/workers/owner-approved/revoke", {}, false)).status).toBe(401);
    expect((await post("/api/workers/owner-approved/revoke", {})).status).toBe(200);
    expect((await call("/worker/heartbeat", caps(), token)).status).toBe(401);
  } finally {
    await owner.stop(true);
    credential.release();
    await factory.stop();
  }
}, 30_000);

test("a worker runs real checks from the exact bundle head and returns the local outcome, with output redacted", async () => {
  await listen();
  const req = await request(true),
    secret = "worker-output-credential-513";
  registerCredential("WORKER_OUTPUT_TEST", secret);
  req.priority = "start";
  req.gates.checks.push({ name: "privacy", run: "cat output-credential" });
  writeFileSync(join(req.cwd, "output-credential"), secret);
  const firstCheck = req.gates.checks[0];
  if (firstCheck) {
    firstCheck.name = "pass\x1b[31m";
    firstCheck.run = "cat tracked; git rev-parse HEAD";
  }
  const worker = await loop({
    confinement: {
      ...fakeConfinement,
      async verify(_roots, opts) {
        writeFileSync(join(opts.cwd, "output-credential"), secret);
      },
    },
  });
  const signal = AbortSignal.timeout(150_000);
  const acquisition = spyOn(gateSlots, "acquire");
  try {
    const run = await executeGate(req, signal, {}, gateExecutorFor("lan", workers, [req.repo]));
    expect(acquisition.mock.calls[0]?.[4]).toBe("start");
    expect(acquisition).toHaveBeenCalledTimes(1);
    expect(workers.list()[0]?.setupWarning).toBeUndefined();
    const local = await confinementScope.run(fakeConfinement, () =>
      executeGate(req, signal, {}, localExecutor()),
    );
    expect(fields(run)).toEqual(fields(redactGateData(local)));
    expect(run.checks[0]?.name).toBe("pass");
    expect(run.checks[1]?.exitCode).toBe(7);
    expect(readdirSync(worker.remote.paths.work)).toEqual([]);
    expect(workerCleanupRecords(worker.remote)).toEqual([]);
    expect(run.checks[0]?.output).toContain("gate bytes");
    expect(run.checks[0]?.output).toContain(req.headSha);
    const jobs = workers.jobs("1=1");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: "done", attempt: 1, worker: "loop-runner", failure_reason: null });
    expect(jobs[0]?.result).not.toContain(secret);
    expect(jobs[0]?.events).not.toContain(secret);
    expect(jobs[0]?.events).toContain("withheld");
    for (const name of ["token", "coordinator-fingerprint"])
      expect(statSync(join(worker.remote.paths.home, "worker", name)).mode & 0o777).toBe(0o600);
  } finally {
    await worker.stop();
    acquisition.mockRestore();
  }
}, 180_000);

test.each([
  ["rewrite", "echo changed > tracked", false],
  ["staged", "echo changed > tracked && git add tracked", false],
  ["deleted", "rm tracked", false],
  ["untracked", "echo generated > build-output", true],
  ["ignored", "echo cache-output >> .git/info/exclude; echo generated > cache-output", true],
] as const)(
  "worker gate provenance inspects its own checkout: %s",
  async (_kind, command, clean) => {
    await listen();
    const req = await request(true);
    req.gates.setup = [];
    req.gates.checks = [{ name: "test", run: command }];
    const worker = await loop();
    try {
      const run = await executeGate(
        req,
        AbortSignal.timeout(30_000),
        {},
        gateExecutorFor("lan", workers, [req.repo]),
      );
      expect(run.checks[0]).toMatchObject({ ok: true, exitCode: 0 });
      expect(run.sha).toBe(req.headSha);
      expect(run.trackedClean).toBe(clean);
      if (!clean) expect(run.provenanceError).toContain("tracked");
      expect(readFileSync(join(req.cwd, "tracked"), "utf8")).toBe("gate bytes\n");
      expect(
        (await worktreeGit(["git", "diff", "--cached", "--name-only", req.headSha, "--"], { cwd: req.cwd }))
          .stdout,
      ).toBe("");
      expect(workers.jobs("1=1")[0]?.worker).toBe("loop-runner");
      expect(readdirSync(worker.remote.paths.work)).toEqual([]);
    } finally {
      await worker.stop();
    }
  },
  45_000,
);

test("a real worker setup failure reruns locally once and the local setup failure blocks", async () => {
  await listen();
  const req = await request(true);
  req.gates.setup = ["test -f tracked", "echo broken-setup; exit 9", "echo must-not-run"];
  const worker = await loop();
  let localStarts = 0;
  try {
    const run = await confinementScope.run(
      {
        ...fakeConfinement,
        async verify(_roots, opts) {
          if (opts.cmd.includes(req.gates.setup[0] ?? "missing")) localStarts++;
          expect(workers.list()[0]?.setupWarning).toBeUndefined();
        },
      },
      () => executeGate(req, AbortSignal.timeout(120_000), {}, gateExecutorFor("lan", workers, [req.repo])),
    );
    expect(localStarts).toBe(1);
    expect(run.setupOk).toBe(false);
    expect(workers.list()[0]?.setupWarning).toBeUndefined();
    expect(run.setup.map(({ name, ok, exitCode }) => ({ name, ok, exitCode }))).toEqual([
      { name: "setup-1", ok: true, exitCode: 0 },
      { name: "setup-2", ok: false, exitCode: 9 },
    ]);
    expect(run.checks).toEqual([]);
    expect(workers.jobs("1=1")).toHaveLength(1);
    expect(workers.jobs("1=1")[0]).toMatchObject({
      state: "done",
      attempt: 1,
      worker: "loop-runner",
    });
    const job = workers.jobs("1=1")[0];
    expect(JSON.parse(job?.result ?? "null")).toEqual(run);
    expect(job?.failure_reason).toContain("echo broken-setup; exit 9");
    expect(compareGates(null, run).some((c) => c.blocking)).toBe(true);
    const resumed = await executeGate(
      req,
      new AbortController().signal,
      {},
      gateExecutorFor("lan", workers, [req.repo]),
      { kind: "lan", id: job?.id ?? "", startedAt: Date.now() },
    );
    expect(resumed).toEqual(run);
    expect(localStarts).toBe(1);

    // A setup failure permits only a matching prefix ending at the first failure.
    const first = run.setup[0],
      failed = run.setup[1];
    if (!first || !failed) throw new Error("Missing setup results");
    for (const invalid of [
      { ...run, setup: [] },
      { ...run, setup: [first] },
      { ...run, setup: [failed] },
      { ...run, setup: [failed, first] },
      { ...run, setup: [first, { ...failed, name: "setup-1" }] },
      { ...run, setup: [...run.setup, { ...first, name: "setup-3", command: req.gates.setup[2] ?? "" }] },
      { ...run, checks: [first] },
      { ...run, setupOk: true },
    ])
      expect(validRun(req, invalid)).toBe(false);
  } finally {
    await worker.stop();
  }
}, 150_000);

test.each([
  ["baseline", false],
  ["baseline", true],
  ["regression", false],
  ["regression", true],
] as const)(
  "LAN %s retries rebuild setup in their fresh worker checkout (targeted=%s)",
  async (kind, targeted) => {
    await listen();
    const req = await request(true),
      attempted = join(home, "attempted");
    req.gates.setup = ["mkdir -p node_modules; touch node_modules/ready"];
    req.gates.checks = [
      {
        name: "check",
        run: `test -f node_modules/ready || { echo missing-setup; exit 2; }; test -f '${attempted}' || { touch '${attempted}'; echo transient; exit 1; }`,
      },
    ];
    if (targeted) req.gates.retryFiles = `${req.gates.checks[0]?.run}; : {files}`;
    cfg.workers.repos = [req.repo];
    cfg.gateExecutor = "lan";
    const factory = new Factory(cfg, {
      store,
      bootSha: releaseSha,
      models: [],
      providers: [],
      gateExecutor: gateExecutorFor("lan", workers, [req.repo]),
    });
    const run = store.getRun(req.runId ?? ""),
      repo = store.getRepoBySlug(req.repo);
    if (!run || !repo) throw new Error("Missing run or repo");
    const ctx = new RunContext(factory.deps, run, repo, AbortSignal.timeout(120_000));
    ctx.state.gatesConfig = req.gates;
    const worker = await loop();
    const stage = kind === "baseline" ? "prepare" : "gates";
    try {
      const first = await runGateExecution(
        ctx,
        stage,
        kind === "baseline" ? "baseline" : "initial",
        req.cwd,
        req.gates,
      );
      expect(first.checks[0]).toMatchObject({ ok: false, exitCode: 1 });
      expect(first.checks[0]?.output).toContain("transient");
      expect(existsSync(join(req.cwd, "node_modules", "ready"))).toBe(false);
      if (targeted && first.checks[0]) first.checks[0].failedFiles = ["tracked"];
      const retry: GateRunner = (gates, options) =>
        runGateExecution(ctx, stage, `${kind}-retry${options?.targeted ? "-targeted" : ""}`, req.cwd, gates);
      if (kind === "baseline") {
        const retried = await retryBaselineFailures(
          first,
          req.cwd,
          req.gates,
          ctx.signal,
          undefined,
          retry,
          ctx.deps.gateExecutor?.freshCheckoutFor?.(req.repo),
        );
        expect(retried.checks[0]).toMatchObject({ ok: true, firstAttempt: { ok: false } });
      } else {
        const baseline = {
          ...first,
          checks: first.checks.map((check) => ({ ...check, ok: true, exitCode: 0 })),
        };
        const retried = await retryRegressions(
          compareGates(baseline, first),
          req.cwd,
          req.gates,
          [],
          ctx.signal,
          undefined,
          retry,
          ctx.deps.gateExecutor?.freshCheckoutFor?.(req.repo),
        );
        expect(retried[0]).toMatchObject({ verdict: "flaky", blocking: false, firstAttempt: { ok: false } });
      }
      const jobs = workers.jobs("1=1");
      expect(jobs).toHaveLength(targeted ? 3 : 2);
      for (const job of jobs) {
        expect(job).toMatchObject({ state: "done", worker: "loop-runner", attempt: 1 });
        expect(JSON.parse(job.request).gates.setup).toEqual(req.gates.setup);
      }
    } finally {
      await worker.stop();
      await factory.stop();
    }
  },
  150_000,
);

test.each([
  ["gate", "done"],
  ["gate", "failed"],
  ["gate", "cancelled"],
  ["agent", "done"],
  ["agent", "failed"],
  ["agent", "cancelled"],
] as const)(
  "worker renews a %s job through cleanup and %s reporting, excluding cancellation",
  async (kind, state) => {
    let now = Date.now();
    workers = new WorkerStore(store, releaseSha, { poll: 30, tick: 5 }, () => now);
    await listen();
    const req = await request(true);
    req.gates.setup = [];
    req.gates.checks = [{ name: "check", run: "true" }];
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      finished = Promise.withResolvers<void>(),
      posting = Promise.withResolvers<void>();
    const reports = new Map(
      ["/worker/heartbeat", "/worker/lease"].map((path) => [path, Promise.withResolvers<string[]>()]),
    );
    const postingReports = new Map(
      ["/worker/heartbeat", "/worker/lease"].map((path) => [path, Promise.withResolvers<string[]>()]),
    );
    let lock: Promise<void> | undefined,
      terminal = false,
      executing = false,
      allowReport = false;
    const id =
      kind === "gate"
        ? workers.enqueue(req)
        : enqueueAgent({
            runId: req.runId,
            parentSha: req.headSha,
            branch: "change/worker-agent",
            target: { ...agentRequest().target, harness: "claude" },
          });
    const row = () => (kind === "gate" ? workers.job(id) : workers.agentJob(id));
    const execute = async (cwd: string, signal?: AbortSignal) => {
      const cache =
        kind === "gate"
          ? join(home, "remote", "repos", `${encodeURIComponent(req.repo)}.git`)
          : join(dirname(cwd), "repo.git");
      // Hold cleanup at the real cache lock, after bundle import has released it.
      lock = withRepoLock(cache, async () => {
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      if (state === "cancelled") {
        if (kind === "gate") workers.cancel(id);
        else workers.cancelAgentJob(id);
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      executing = true;
      finished.resolve();
      if (state === "failed") throw new Error("Worker execution failed");
      signal?.throwIfAborted();
      return {};
    };
    const worker = await loop({
      harnesses: { claude: fakeHarness((spec) => execute(spec.cwd, spec.signal)) },
      confinement: {
        ...fakeConfinement,
        async verify(_roots, opts) {
          if (kind === "gate") await execute(opts.cwd, opts.signal);
        },
      },
      async request(...args) {
        const [_, path, body] = args;
        if (path.endsWith("/result") || path.endsWith("/failure")) {
          terminal = true;
          posting.resolve();
          if (!allowReport) throw new Error("Coordinator temporarily unavailable");
        }
        const observing = executing ? (terminal ? postingReports : reports).get(path) : undefined;
        const reply = await workerRequest(...args);
        observing?.resolve((body as { jobs: string[] }).jobs);
        return reply;
      },
    });
    try {
      await finished.promise;
      now += 1000;
      for (const report of reports.values()) {
        const ids = await report.promise;
        if (state === "cancelled") expect(ids).not.toContain(id);
        else expect(ids).toContain(id);
      }
      // Results and failures wait until directory cleanup has settled.
      expect(row()?.state).toBe(state === "cancelled" ? "cancelled" : "leased");
      if (state === "cancelled") {
        // The worker must still await cleanup when shutting down.
        let stopped = false;
        const stopping = worker.stop().then(() => {
          stopped = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(stopped).toBe(false);
        release.resolve();
        await stopping;
      } else {
        const expiry = row()?.lease_expires_at ?? 0;
        release.resolve();
        await posting.promise;
        now += 1000;
        for (const report of postingReports.values()) expect(await report.promise).toContain(id);
        expect(row()?.lease_expires_at).toBeGreaterThan(expiry);
        expect(row()?.state).toBe("leased");
        allowReport = true;
        await until(() => row()?.state === (state === "done" ? "done" : "queued"));
      }
      expect(readdirSync(worker.remote.paths.work)).toEqual([]);
      expect(workerCleanupRecords(worker.remote)).toEqual([]);
    } finally {
      release.resolve();
      await worker.stop();
      await lock;
    }
  },
  30_000,
);

test.each(["darwin", "linux"])(
  "a %s worker survives connection failures, 503s and a coordinator restart with its job still running",
  async (platform) => {
    const server = await listen(),
      address = `127.0.0.1:${server.url.port}`,
      req = await request(true);
    req.gates.setup = [];
    const started = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    const paths = ["/worker/heartbeat", "/worker/lease"];
    const disconnected = new Map(paths.map((p) => [p, Promise.withResolvers<void>()])),
      recovered = new Map(paths.map((p) => [p, Promise.withResolvers<void>()])),
      unavailable = new Set<string>();
    let offline = false;
    const worker = await loop({
      heartbeatMs: 10,
      platform,
      confinement: {
        ...fakeConfinement,
        async verify(_roots, opts) {
          // A Linux worker's startup preflight verifies too, before any job.
          if (opts.cwd.includes("limitless-worker-preflight-")) return;
          started.resolve();
          const abort = () => finish.resolve();
          opts.signal?.addEventListener("abort", abort, { once: true });
          await finish.promise;
          opts.signal?.removeEventListener("abort", abort);
          opts.signal?.throwIfAborted();
        },
      },
      async request(...args) {
        const path = args[1];
        try {
          const reply = await workerRequest(...args);
          if (offline && paths.includes(path)) {
            if (!unavailable.has(path)) {
              unavailable.add(path);
              return { ...reply, status: 503 };
            }
            recovered.get(path)?.resolve();
          }
          return reply;
        } catch (error) {
          if (offline) disconnected.get(path)?.resolve();
          throw error;
        }
      },
    });
    const alive = <T>(promise: Promise<T>) =>
      Promise.race([
        promise,
        worker.task.then(() => {
          throw new Error("Worker exited before reconnecting");
        }),
      ]);
    const executor = gateExecutorFor("lan", workers, [req.repo]);
    const handle = await executor.start(req, new AbortController().signal);
    try {
      await alive(started.promise);
      offline = true;
      await server.stop();
      listener = undefined;
      await alive(Promise.all([...disconnected.values()].map((p) => p.promise)));
      store.close();
      store = new Store(cfg.paths.db);
      workers = new WorkerStore(store, releaseSha, { poll: 30, tick: 5 });
      await listen(address);
      await alive(Promise.all([...recovered.values()].map((p) => p.promise)));
      expect(unavailable.size).toBe(2);
      finish.resolve();
      const run = await alive(
        executeGate(
          req,
          AbortSignal.timeout(120_000),
          {},
          gateExecutorFor("lan", workers, [req.repo]),
          handle,
        ),
      );
      expect(fields(run)).toEqual([
        { name: "pass", ok: true, exitCode: 0 },
        { name: "fail", ok: false, exitCode: 7 },
      ]);
      expect(workers.jobs("1=1")).toHaveLength(1);
      expect(workers.job(handle.id)).toMatchObject({ state: "done", attempt: 1, failure_reason: null });
    } finally {
      finish.resolve();
      await worker.stop();
    }
  },
  150_000,
);

test("repos without opt-in use local execution without creating jobs", async () => {
  const req = await request();
  req.gates.setup = ["rm -f built; echo setup >> setup-runs"];
  req.gates.checks = [
    { name: "pass", run: "cat tracked; touch built" },
    {
      name: "fail",
      run: "test -f built || exit 2; test -f attempted || { touch attempted; echo failure; exit 7; }",
    },
  ];
  const executor = gateExecutorFor("lan", workers, []);
  const signal = new AbortController().signal;
  await confinementScope.run(fakeConfinement, async () => {
    const result = await executeGate(req, signal, {}, executor);
    expect(result.checks[1]?.exitCode).toBe(7);
    const retried = await retryBaselineFailures(
      result,
      req.cwd,
      req.gates,
      signal,
      undefined,
      (gates) => executeGate({ ...req, gates }, signal, {}, executor),
      executor.freshCheckoutFor?.(req.repo),
    );
    expect(retried.checks[1]).toMatchObject({ ok: true, firstAttempt: { ok: false, exitCode: 7 } });
  });
  expect(readFileSync(join(req.cwd, "setup-runs"), "utf8")).toBe("setup\n");
  expect(workers.jobs("1=1")).toHaveLength(0);
}, 30_000);

test.each(["dispatch", "reattach"])("a sibling LAN %s keeps an active local reservation", async (mode) => {
  const req = await request();
  const executor = gateExecutorFor("lan", workers, [req.repo]);
  const controller = new AbortController();
  const previous = gateSlots.limit;
  gateSlots.setLimit(1);
  let competitor: Promise<() => void> | undefined;
  let remote: ReturnType<typeof executor.attach> | undefined;
  const outside = AsyncLocalStorage.snapshot();
  try {
    const saved = mode === "reattach" ? await executor.start(req, controller.signal) : undefined;
    await gateSlotScope(async () => {
      const release = await acquireGateSlot(controller.signal, undefined, "local attempt");
      const sibling = await acquireGateSlot(controller.signal);
      let admitted = false;
      competitor = outside(() =>
        gateSlots.acquire(controller.signal, undefined, "competitor").then((free) => {
          admitted = true;
          return free;
        }),
      );
      try {
        if (saved) remote = executor.attach(saved, controller.signal);
        else await executor.start(req, controller.signal);
        release();
        release();
        await new Promise(setImmediate);
        expect(admitted).toBe(false);
        expect(gateSlots.snapshot().holders).toEqual(["local attempt"]);
      } finally {
        release();
        sibling();
      }
      (await competitor)();
      expect(admitted).toBe(true);
      const next = await acquireGateSlot(controller.signal, undefined, "later local attempt");
      next();
      expect(gateSlots.snapshot().holders).toEqual(["later local attempt"]);
    })();
    expect(gateSlots.snapshot().occupied).toBe(0);
  } finally {
    controller.abort();
    await remote?.result.catch(() => {});
    (await competitor?.catch(() => undefined))?.();
    gateSlots.setLimit(previous);
  }
});

test.each(["dispatch", "reattach", "live"])(
  "a LAN retry releases the coordinator slot held by its local fallback (%s)",
  async (mode) => {
    const req = await request();
    req.gates = { ...req.gates, setup: [], checks: [{ name: "test", run: "false" }] };
    const now = Date.now();
    workers = new WorkerStore(store, releaseSha, { tick: 1 }, () => now);
    workers.pairingKey = "test-pairing-key";
    const pairing = workers.pair("runner", "a".repeat(64), "b".repeat(64));
    workers.approve(pairing.code);
    const worker = workers.worker("runner");
    if (!worker) throw new Error("missing worker fixture");
    workers.heartbeat(worker, caps());
    const executor = gateExecutorFor("lan", workers, [req.repo]);
    const controller = new AbortController();
    const previous = gateSlots.limit;
    gateSlots.setLimit(1);
    const localStarted = Promise.withResolvers<void>();
    const finishLocal = Promise.withResolvers<void>();
    const localDone = Promise.withResolvers<void>();
    const dispatchRetry = Promise.withResolvers<void>();
    const remoteStarted = Promise.withResolvers<ExecutionHandle>();
    let admitted = false;
    let competitor: Promise<() => void> | undefined;
    let settled = false;
    const outside = AsyncLocalStorage.snapshot();
    const scope = confinementScope.run(
      {
        ...fakeConfinement,
        async verify() {
          localStarted.resolve();
          await finishLocal.promise;
        },
      },
      gateSlotScope(async () => {
        const first = await executor.start(req, controller.signal);
        expect(workers.lease(worker.name)?.id).toBe(first.id);
        workers.fail(first.id, "Worker disconnected");
        workers.fail(first.id, "No remaining worker");
        const initial = await executeGate(req, controller.signal, {}, executor, first);
        expect(initial.checks[0]?.ok).toBe(false);
        localDone.resolve();
        await dispatchRetry.promise;
        return retryBaselineFailures(
          initial,
          req.cwd,
          req.gates,
          controller.signal,
          undefined,
          async (gates) => {
            const retryRequest = { ...req, gates };
            const saved =
              mode === "dispatch"
                ? undefined
                : await outside(() => executor.start(retryRequest, controller.signal));
            if (saved) {
              if (mode === "live") outside(() => executor.attach(saved, controller.signal));
              remoteStarted.resolve(saved);
            }
            return executeGate(retryRequest, controller.signal, {}, executor, saved, async (handle) => {
              remoteStarted.resolve(handle);
            });
          },
        );
      }),
    );
    void scope.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await localStarted.promise;
      competitor = gateSlots
        .acquire(controller.signal, undefined, "local waiter", false, "ship")
        .then((release) => {
          admitted = true;
          return release;
        });
      finishLocal.resolve();
      await localDone.promise;
      expect(admitted).toBe(false);
      expect(gateSlots.snapshot().occupied).toBe(1);
      dispatchRetry.resolve();
      const retry = await remoteStarted.promise;
      expect(workers.lease(worker.name)?.id).toBe(retry.id);
      await new Promise(setImmediate);
      expect(admitted).toBe(true);
      expect(gateSlots.snapshot().holders).toEqual(["local waiter"]);
      expect(workers.job(retry.id)?.state).toBe("leased");
      expect(settled).toBe(false);
      (await competitor)();
      expect(gateSlots.snapshot().occupied).toBe(0);
      expect(
        workers.complete(retry.id, {
          sha: req.headSha,
          trackedClean: true,
          setupOk: true,
          setup: [],
          checks: [
            { name: "test", command: "false", ok: true, exitCode: 0, durationMs: 1, output: "passed" },
          ],
        }),
      ).toBe(true);
      expect((await scope).checks[0]).toMatchObject({ ok: true, firstAttempt: { ok: false } });
      expect(gateSlots.snapshot().occupied).toBe(0);
    } finally {
      controller.abort();
      finishLocal.resolve();
      dispatchRetry.resolve();
      await scope.catch(() => {});
      (await competitor?.catch(() => undefined))?.();
      gateSlots.setLimit(previous);
    }
  },
);

test("restart reattaches to the durable job without enqueueing again", async () => {
  const req = await request(true);
  const signal = new AbortController().signal;
  const handle = await gateExecutorFor("lan", workers, [req.repo]).start(req, signal);
  await listen();
  await listener?.stop();
  listener = undefined;
  store.close();
  store = new Store(cfg.paths.db);
  workers = new WorkerStore(store, releaseSha, { poll: 30, tick: 5 });
  await listen();
  const worker = await loop();
  try {
    const run = await executeGate(req, signal, {}, gateExecutorFor("lan", workers, [req.repo]), handle);
    expect(fields(run)).toEqual([
      { name: "pass", ok: true, exitCode: 0 },
      { name: "fail", ok: false, exitCode: 7 },
    ]);
    expect(workers.jobs("1=1")).toHaveLength(1);
    expect(workers.job(handle.id)?.state).toBe("done");
  } finally {
    await worker.stop();
  }
}, 180_000);

test("a Linux worker starts only when its confinement verifies, and refuses with the preflight's reason", async () => {
  await listen();
  let preflight: scratchPolicy.WriteRoots | undefined;
  const worker = await loop({
    platform: "linux",
    confinement: {
      ...fakeConfinement,
      async verify(roots) {
        preflight = roots;
        throw new ConfinementError("bubblewrap missing");
      },
    },
  });
  await expect(worker.task).rejects.toThrow(
    "Linux workers need bubblewrap and Landlock confinement: bubblewrap missing",
  );
  // Gate-shaped roots: the home is denied and only the probe's checkout and scratch are readable.
  expect(preflight?.denyRead).toContain(realpathSync(homedir()));
  expect(preflight?.allowRead?.length).toBeGreaterThan(0);
  expect(workers.worker("loop-runner")?.last_heartbeat_at).toBeNull();
  const other = runWorker("https://127.0.0.1:1", cfg, releaseSha, new AbortController().signal, {
    platform: "win32",
  });
  await expect(other).rejects.toThrow("Workers require macOS Seatbelt or Linux bubblewrap and Landlock");
});

test("a Linux worker advertises its platform and backend, runs gate jobs and is never leased an agent job", async () => {
  await listen();
  const req = await request(true);
  const agent = enqueueAgent();
  const worker = await loop({ platform: "linux" });
  try {
    // It reports logged-in agents, so only the coordinator's filter keeps the agent job queued.
    await until(
      () => workers.list().find((w) => w.name === "loop-runner")?.agents?.claude?.loggedIn === true,
    );
    const run = await executeGate(
      req,
      AbortSignal.timeout(60_000),
      {},
      gateExecutorFor("lan", workers, [req.repo]),
    );
    expect(fields(run)).toEqual([
      { name: "pass", ok: true, exitCode: 0 },
      { name: "fail", ok: false, exitCode: 7 },
    ]);
    expect(workers.jobs("1=1")[0]).toMatchObject({ state: "done", worker: "loop-runner" });
    expect(workers.list().find((w) => w.name === "loop-runner")?.capabilities).toMatchObject({
      os: "linux",
      confinement: "bwrap-landlock",
    });
    expect(workers.agentJob(agent)).toMatchObject({ state: "queued", worker: null, failure_reason: null });
  } finally {
    await worker.stop();
  }
}, 60_000);

test("a Linux worker reports an agent job it is sent as failed instead of running it", async () => {
  await listen();
  const agent = enqueueAgent();
  let ran = false;
  const worker = await loop({
    platform: "linux",
    harnesses: {
      claude: fakeHarness(async () => {
        ran = true;
        return {};
      }),
    },
    // A coordinator that believes the worker is macOS leases it the agent job.
    async request(origin, path, body, options) {
      const claimed = path === "/worker/heartbeat" ? { ...(body as object), os: "darwin" } : body;
      return workerRequest(origin, path, claimed, options);
    },
  });
  try {
    await until(() => workers.agentJob(agent)?.failure_reason === "Agent rounds run on macOS workers only");
    expect(JSON.parse(workers.agentJob(agent)?.excluded ?? "[]")).toEqual(["loop-runner"]);
    expect(ran).toBe(false);
  } finally {
    await worker.stop();
  }
});

test("expired leases retry once on a different worker then fall back locally without implementer feedback", async () => {
  let now = Date.now();
  workers = new WorkerStore(store, releaseSha, { poll: 0, tick: 5, lease: 60, fresh: 1000 }, () => now);
  await listen();
  const req = await request(),
    signal = new AbortController().signal;
  const a = await paired("first"),
    b = await paired("second");
  await call("/worker/heartbeat", caps(), a);
  await call("/worker/heartbeat", caps(), b);
  const executor = gateExecutorFor("lan", workers, [req.repo]),
    handle = await confinementScope.run(fakeConfinement, () => executor.start(req, signal));
  await call("/worker/lease", {}, a);
  now += 61;
  workers.sweep();
  expect(workers.job(handle.id)).toMatchObject({ state: "queued", attempt: 2, worker: null });
  expect((await call("/worker/heartbeat", caps([handle.id]), a)).json()).toEqual({
    cancelled: [handle.id],
    releaseSha,
  });
  expect((await call("/worker/lease", {}, a)).json()).toEqual({ job: null, agentJob: null });
  const second = (await call("/worker/lease", {}, b)).json() as { job: { id: string } };
  expect(second.job.id).toBe(handle.id);
  now += 61;
  workers.sweep();
  const run = await confinementScope.run(fakeConfinement, () =>
    executeGate(req, signal, {}, executor, handle),
  );
  expect(run.checks[1]?.exitCode).toBe(7);
  expect(workers.job(handle.id)).toMatchObject({
    state: "done",
    attempt: 2,
    excluded: JSON.stringify(["first", "second"]),
  });
  expect(
    store
      .listEvents(req.runId ?? "")
      .filter((e) => e.type === "gate")
      .map((e) => e.message),
  ).toEqual([
    "LAN infrastructure failure: Lease expired",
    "LAN infrastructure failure: Lease expired",
    "LAN gates falling back to local execution",
  ]);
  expect(store.getRunState(req.runId ?? "")).toBeNull();
  expect(store.listInvocations(req.runId ?? "")).toHaveLength(0);
}, 30_000);

test("a job that no worker picks up falls back and cannot pass a failing local check", async () => {
  const req = await request();
  req.priority = "ship";
  workers = new WorkerStore(store, releaseSha, { pickup: 0, tick: 1 });
  const acquisition = spyOn(gateSlots, "acquire");
  try {
    const result = await confinementScope.run(fakeConfinement, () =>
      executeGate(req, new AbortController().signal, {}, gateExecutorFor("lan", workers, [req.repo])),
    );
    expect(acquisition.mock.calls[0]?.[4]).toBe("ship");
    expect(result.checks[1]?.ok).toBe(false);
    expect(workers.jobs("1=1")[0]).toMatchObject({
      state: "done",
      attempt: 2,
      failure_reason: "No worker picked up job",
    });
  } finally {
    acquisition.mockRestore();
  }
}, 30_000);

test.each([true, false, undefined])(
  "LAN attribution metadata %s controls targeted land retry",
  async (complete) => {
    const req = await request();
    mkdirSync(join(req.cwd, "test"));
    writeFileSync(join(req.cwd, "test/a.test.ts"), "");
    const check = { name: "test", run: "bun test" };
    req.gates = { ...req.gates, setup: [], checks: [check], retryFiles: "bun test --isolate {files}" };
    await listen();
    const token = await paired();
    await call("/worker/heartbeat", caps(), token);
    const id = workers.enqueue(req);
    await call("/worker/lease", {}, token);
    const original = {
      name: "test",
      command: check.run,
      ok: false,
      exitCode: 1,
      durationMs: 1,
      output: "failure",
      failedFiles: ["test/a.test.ts"],
      failedFileTimes: { "test/a.test.ts": 1 },
      ...(complete === undefined ? {} : { failureAttributionComplete: complete }),
      ...(complete === false ? { failureAttributionReason: "1 unattributed error" } : {}),
    };
    expect(
      (await call(`/worker/jobs/${id}/events`, { type: "check", phase: "check", result: original }, token))
        .status,
    ).toBe(200);
    expect(
      (
        await call(
          `/worker/jobs/${id}/result`,
          {
            sha: req.headSha,
            run: { setupOk: true, setup: [], checks: [original] },
          },
          token,
        )
      ).status,
    ).toBe(200);
    const run = await confinementScope.run(fakeConfinement, () =>
      executeGate(req, new AbortController().signal, {}, gateExecutorFor("lan", workers, [req.repo]), {
        kind: "lan",
        id,
        startedAt: Date.now(),
      }),
    );
    expect(workers.jobs("1=1")[0]).toMatchObject({ state: "done", failure_reason: null });
    const result = run.checks[0];
    if (!result) throw new Error("Missing worker check");
    expect(result.failureAttributionComplete).toBe(complete);
    expect(result.failureAttributionReason).toBe(complete === false ? "1 unattributed error" : undefined);
    const calls: string[] = [];
    const retried = await retryFailures(
      [{ check, original: result }],
      req.cwd,
      req.gates,
      new AbortController().signal,
      undefined,
      async (gates, options) => {
        expect(options).toEqual({ targeted: true, skipGateSlot: true });
        calls.push(...gates.checks.map((c) => c.run));
        return { setupOk: true, setup: [], checks: [{ ...result, ok: true, exitCode: 0 }] };
      },
      true,
    );
    expect(calls).toEqual(complete === true ? ["bun test --isolate './test/a.test.ts'"] : []);
    expect(retried.size).toBe(complete === true ? 1 : 0);
  },
);

test.each([
  "sha",
  "extra",
  "missing",
  "schema",
  "duplicate",
  "alias",
  "command",
  "confinement",
  "reordered",
] as const)(
  "invalid %s result fails infrastructure and preserves the failing local outcome",
  async (kind) => {
    workers = new WorkerStore(store, releaseSha, { poll: 0, tick: 1, pickup: 0 });
    const req = await request();
    await listen();
    const token = await paired();
    await call("/worker/heartbeat", caps(), token);
    // Keep pickup enabled until a worker has taken the job.
    workers.times.pickup = 60_000;
    const id = workers.enqueue(req);
    await call("/worker/lease", {}, token);
    const good = await confinementScope.run(fakeConfinement, () =>
      runLocalGates(req.cwd, req.gates, new AbortController().signal),
    );
    const run = { ...good, checks: good.checks.map((r) => ({ ...r, ok: true, exitCode: 0 })) };
    if (kind === "extra" && run.checks[0]) run.checks.push({ ...run.checks[0], name: "extra" });
    if (kind === "missing") run.checks.pop();
    if (kind === "duplicate" && run.checks[0]) run.checks[1] = { ...run.checks[0] };
    if (kind === "alias" && run.checks[0])
      run.checks[1] = { ...run.checks[0], name: `${run.checks[0].name}\x1b[31m` };
    if (kind === "reordered") {
      expect(validRun(req, good)).toBe(true);
      expect(validRun(req, { ...good, checks: [...good.checks].reverse() })).toBe(false);
      run.checks.reverse();
    }
    if (kind === "command" && run.checks[0]) run.checks[0].command = "different";
    if (kind === "confinement" && run.checks[0]) run.checks[0].confinementError = true;
    const body =
      kind === "schema"
        ? { sha: req.headSha, run: { setupOk: true } }
        : { sha: kind === "sha" ? "0".repeat(40) : req.headSha, run };
    expect((await call(`/worker/jobs/${id}/result`, body, token)).status).toBe(400);
    expect(workers.job(id)?.state).toBe("queued");
    expect(workers.job(id)?.failure_reason).toContain(kind === "sha" ? "SHA" : "Invalid");
    workers.times.pickup = 0;
    const result = await confinementScope.run(fakeConfinement, () =>
      executeGate(req, new AbortController().signal, {}, gateExecutorFor("lan", workers, [req.repo]), {
        kind: "lan",
        id,
        startedAt: Date.now(),
      }),
    );
    expect(fields(result)).toEqual(fields(good));
  },
  30_000,
);

test("streamed and final crafted output is validated and redacted at the coordinator", async () => {
  await listen();
  const req = await request(),
    token = await paired();
  const credential = "coordinator-output-credential-513";
  registerCredential("COORDINATOR_OUTPUT_TEST", credential);
  writeFileSync(join(cfg.paths.configDir, "private-strings.txt"), "synthetic-private-worker-host\n");
  await call("/worker/heartbeat", caps(), token);
  const id = workers.enqueue(req);
  await call("/worker/lease", {}, token);
  const run = await confinementScope.run(fakeConfinement, () =>
    runLocalGates(req.cwd, req.gates, new AbortController().signal),
  );
  const check = run.checks[0];
  if (!check) throw new Error("Missing check");
  check.output = `${credential} ${token} synthetic-private-worker-host`;
  expect(
    (await call(`/worker/jobs/${id}/events`, { type: "check", phase: "check", result: check }, token)).status,
  ).toBe(200);
  expect((await call(`/worker/jobs/${id}/result`, { sha: req.headSha, run }, token)).status).toBe(200);
  expect(workers.job(id)?.result).not.toContain(credential);
  expect(workers.job(id)?.result).not.toContain(token);
  expect(workers.job(id)?.events).not.toContain("synthetic-private-worker-host");
  expect(workers.job(id)?.result).toContain("withheld");
}, 30_000);

test("cancellation is durable and is returned by both lease and heartbeat replies", async () => {
  await listen();
  const req = await request(),
    token = await paired();
  await call("/worker/heartbeat", caps(), token);
  const controller = new AbortController(),
    executor = gateExecutorFor("lan", workers, [req.repo]);
  const handle = await executor.start(req, controller.signal);
  await call("/worker/lease", {}, token);
  const attached = executor.attach(handle, controller.signal);
  expect(executor.attach(handle, new AbortController().signal)).toBe(attached);
  controller.abort();
  await expect(attached.result).rejects.toThrow();
  expect(workers.job(handle.id)?.state).toBe("cancelled");
  expect((await call("/worker/lease", { jobs: [handle.id] }, token)).json()).toEqual({
    job: null,
    agentJob: null,
    cancelled: [handle.id],
  });
  expect((await call("/worker/heartbeat", caps([handle.id]), token)).json()).toEqual({
    cancelled: [handle.id],
    releaseSha,
  });
  expect((await call(`/worker/jobs/${handle.id}/result`, {}, token)).status).toBe(409);
}, 30_000);

test("daemon shutdown detaches a LAN handle, which reattaches without creating another row", async () => {
  const req: GateRequest = {
    repo: "test/repo",
    cwd: home,
    headSha: releaseSha,
    baseSha: releaseSha,
    gates: { setup: [], checks: [], source: "none", protectedPaths: [] },
  };
  const controller = new AbortController(),
    executor = gateExecutorFor("lan", workers, [req.repo]);
  const handle = await executor.start(req, new AbortController().signal);
  const execution = executor.attach(handle, new AbortController().signal);
  const reattached = executor.attach(handle, controller.signal);
  expect(reattached).toBe(execution);
  controller.abort(new Error("shutdown"));
  await expect(execution.result).rejects.toThrow();
  expect(workers.job(handle.id)?.state).toBe("queued");
  const resumed = gateExecutorFor("lan", workers, [req.repo]).attach(handle, new AbortController().signal);
  await resumed.cancel();
  await expect(resumed.result).rejects.toThrow();
  expect(workers.jobs("1=1")).toHaveLength(1);
  expect(workers.job(handle.id)?.state).toBe("cancelled");
}, 30_000);

const gateTimers = ["fresh", "pickup", "lease"] as const;
type GateTimer = (typeof gateTimers)[number];
const gateFailure = {
  fresh: "Worker disconnected",
  pickup: "No worker picked up job",
  lease: "Lease expired",
};

function restartGate(timer: GateTimer, resumedAt: number | null | undefined, persistedAt = 1000) {
  let now = 1000;
  workers = new WorkerStore(store, releaseSha, { fresh: 30, pickup: 40, lease: 60 }, () => now);
  workers.pairingKey = "test-pairing-key";
  workers.approve(workers.pair("runner", "a".repeat(64), "b".repeat(64)).code);
  const worker = workers.worker("runner");
  if (!worker) throw new Error("missing worker fixture");
  workers.heartbeat(worker, caps());
  const id = workers.enqueue({
    repo: "test/repo",
    cwd: home,
    baseSha: releaseSha,
    headSha: releaseSha,
    gates: { setup: [], checks: [], source: "none", protectedPaths: [] },
  });
  if (timer !== "pickup") expect(workers.lease(worker.name)?.id).toBe(id);
  store.db
    .query("UPDATE workers SET last_heartbeat_at=? WHERE name=?")
    .run(timer === "fresh" ? persistedAt : 100_000, worker.name);
  store.db
    .query("UPDATE gate_jobs SET updated_at=?,lease_expires_at=?,attempt_deadline_at=? WHERE id=?")
    .run(persistedAt, timer === "lease" ? persistedAt + 60 : 100_000, 100_000, id);
  workers.resumedAt = resumedAt;
  return {
    id,
    worker,
    at: (time: number) => {
      now = time;
    },
  };
}

async function sweepGateVia(via: string, id: string, worker: NonNullable<ReturnType<WorkerStore["worker"]>>) {
  if (via === "heartbeat") return workers.heartbeat(worker, caps([id])).cancelled;
  if (via === "lease") workers.lease("unknown-worker");
  else if (via === "holds") workers.holds(id, worker.name);
  else {
    const controller = new AbortController();
    // End the attach loop after its first sweep without an elapsed-time sleep or cancelling the job.
    const sleep = spyOn(Bun, "sleep").mockImplementation(async () => {
      controller.abort(new Error("shutdown"));
    });
    try {
      const execution = gateExecutorFor("lan", workers, ["test/repo"]).attach(
        { kind: "lan", id, startedAt: 1000 },
        controller.signal,
      );
      await expect(execution.result).rejects.toThrow("abort");
    } finally {
      sleep.mockRestore();
    }
  }
  return undefined;
}

for (const timer of gateTimers) {
  for (const via of ["heartbeat", "lease", "attach", "holds"]) {
    test.each([false, true])(`gate ${timer} restart grace via ${via}, expired=%s`, async (expired) => {
      const { id, worker, at } = restartGate(timer, 10_000);
      at(10_000 + (expired ? workers.times[timer] + 1 : workers.times[timer] - 1));
      const cancelled = await sweepGateVia(via, id, worker);
      expect(workers.resumedAt).toBe(10_000);
      expect(workers.job(id)).toMatchObject(
        expired
          ? {
              state: "queued",
              attempt: 2,
              worker: null,
              failure_reason: gateFailure[timer],
              excluded: JSON.stringify(timer === "pickup" ? [] : ["runner"]),
            }
          : {
              state: timer === "pickup" ? "queued" : "leased",
              attempt: 1,
              worker: timer === "pickup" ? null : "runner",
              failure_reason: null,
              excluded: "[]",
            },
      );
      if (via === "heartbeat") expect(cancelled).toEqual(expired || timer === "pickup" ? [id] : []);
      expect(workers.job(id)?.events).not.toContain("falling back");
    });
  }

  for (const resumedAt of [undefined, null, 10_000]) {
    test.each([-1, 0, 1])(`gate ${timer} boundary with resumedAt=${resumedAt}, offset=%s`, (offset) => {
      const { id, at } = restartGate(timer, resumedAt);
      at((resumedAt ?? 1000) + workers.times[timer] + offset);
      workers.sweep();
      const expired = timer === "fresh" ? offset > 0 : offset >= 0;
      expect(workers.job(id)).toMatchObject(
        expired
          ? {
              attempt: 2,
              failure_reason: gateFailure[timer],
              excluded: JSON.stringify(timer === "pickup" ? [] : ["runner"]),
            }
          : { attempt: 1, failure_reason: null, excluded: "[]" },
      );
    });
  }

  test(`gate ${timer} preserves timestamps newer than the restart`, () => {
    const { id, at } = restartGate(timer, 10_000, 10_020);
    at(10_000 + workers.times[timer] + 1);
    workers.sweep();
    expect(workers.job(id)?.attempt).toBe(1);
    at(10_020 + workers.times[timer] + (timer === "fresh" ? 1 : 0));
    workers.sweep();
    expect(workers.job(id)).toMatchObject({ attempt: 2, failure_reason: gateFailure[timer] });
  });
}

test.each(["deadline", "revoked", "legacy"])("gate restart grace preserves %s enforcement", (mode) => {
  const { id, at } = restartGate("lease", 10_000);
  at(10_001);
  if (mode === "revoked") workers.revoke("runner");
  else
    store.db
      .query("UPDATE gate_jobs SET attempt_deadline_at=? WHERE id=?")
      .run(mode === "legacy" ? null : 10_001, id);
  workers.sweep();
  if (mode === "legacy") {
    const job = workers.job(id);
    expect(job).toMatchObject({ state: "leased", attempt: 1, failure_reason: null });
    expect(job?.attempt_deadline_at).toBe(1000 + attemptBudget(JSON.parse(job?.request ?? "{}")));
  } else
    expect(workers.job(id)).toMatchObject({
      state: "queued",
      attempt: 2,
      worker: null,
      excluded: '["runner"]',
      failure_reason: mode === "revoked" ? "Worker disconnected or revoked" : "Attempt deadline expired",
    });
});

test("heartbeats renew held leases, while a disconnected worker loses them before renewal", async () => {
  let now = Date.now();
  workers = new WorkerStore(store, releaseSha, { poll: 0, fresh: 30, lease: 60 }, () => now);
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  const id = workers.enqueue({
    repo: "test/repo",
    cwd: home,
    baseSha: releaseSha,
    headSha: releaseSha,
    gates: { setup: [], checks: [], source: "none", protectedPaths: [] },
  });
  await call("/worker/lease", {}, token);
  const expiry = workers.job(id)?.lease_expires_at ?? 0;
  now += 20;
  await call("/worker/heartbeat", caps([id]), token);
  expect(workers.job(id)?.lease_expires_at).toBe(expiry + 20);
  now += 31;
  workers.sweep();
  expect(workers.job(id)).toMatchObject({
    state: "queued",
    attempt: 2,
    worker: null,
    failure_reason: "Worker disconnected",
  });
  expect((await call("/worker/heartbeat", caps([id]), token)).json()).toEqual({
    cancelled: [id],
    releaseSha,
  });
}, 30_000);

test("cancelling execution aborts the worker's running gate on a held-job reply", async () => {
  await listen();
  const req = await request(true);
  req.gates.setup = [];
  req.gates.checks = [{ name: "waiting", run: "echo $$ > gate.pid; exec sleep 900" }];
  const started = Promise.withResolvers<{ signal: AbortSignal; cwd: string }>(),
    stopped = Promise.withResolvers<void>();
  const cancelledReply = Promise.withResolvers<void>();
  let id = "",
    scratch = "";
  const worker = await loop({
    confinement: {
      ...fakeConfinement,
      async verify(_roots, opts) {
        if (!opts.signal) throw new Error("Missing job signal");
        scratch = invocationScratch.getStore() ?? "";
        opts.signal.addEventListener("abort", () => stopped.resolve(), { once: true });
        started.resolve({ signal: opts.signal, cwd: opts.cwd });
      },
    },
    async request(...args) {
      const reply = await workerRequest(...args);
      if (
        ["/worker/heartbeat", "/worker/lease"].includes(args[1]) &&
        (reply.json() as { cancelled?: string[] }).cancelled?.includes(id)
      )
        cancelledReply.resolve();
      return reply;
    },
  });
  const controller = new AbortController();
  const executor = gateExecutorFor("lan", workers, [req.repo]);
  const handle = await executor.start(req, controller.signal);
  id = handle.id;
  const result = executeGate(req, controller.signal, {}, executor, handle);
  void result.catch(() => {});
  try {
    const { signal, cwd } = await started.promise;
    const deadline = Date.now() + 10_000;
    const pidFile = join(cwd, "gate.pid");
    while (!existsSync(pidFile) || !/^[1-9]\d*$/.test(readFileSync(pidFile, "utf8").trim())) {
      if (Date.now() > deadline) throw new Error("Worker gate did not start");
      await Bun.sleep(10);
    }
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    process.kill(pid, 0);
    controller.abort();
    await expect(result).rejects.toThrow();
    await cancelledReply.promise;
    await stopped.promise;
    expect(signal.aborted).toBe(true);
    while (true) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      if (Date.now() > deadline) throw new Error("Worker gate did not exit");
      await Bun.sleep(10);
    }
    expect(workers.job(id)?.state).toBe("cancelled");
    expect(workers.lease("loop-runner")).toBeNull();
    await until(() => readdirSync(worker.remote.paths.work).length === 0);
    expect(scratch).not.toBe("");
    expect(existsSync(scratch)).toBe(false);
    expect(workerCleanupRecords(worker.remote)).toEqual([]);
  } finally {
    controller.abort();
    await worker.stop();
    await result.catch(() => {});
  }
}, 30_000);

const platformSkip = process.platform === "linux" ? bwrapSkip : seatbeltSkip;
test.skipIf(platformSkip !== null)(
  `worker gates cannot read their token, pin or coordinator TLS key (${platformSkip})`,
  async () => {
    const server = await listen(),
      req = await request(true);
    const worker = await loop({ confinement: undefined, platform: process.platform });
    const files = [
      server.tls.keyPath,
      ...["token", "coordinator-fingerprint"].map((name) => join(worker.remote.paths.home, "worker", name)),
    ];
    req.gates.checks = files.map((file, i) => ({ name: `private-${i}`, run: `cat '${file}'` }));
    try {
      const run = await executeGate(
        req,
        AbortSignal.timeout(30_000),
        {},
        gateExecutorFor("lan", workers, [req.repo]),
      );
      expect(run.setupOk).toBe(true);
      expect(run.checks).toHaveLength(files.length);
      for (const check of run.checks) {
        expect(check.ok).toBe(false);
        expect(check.confinementError).toBe(false);
        // Seatbelt denies the read; bubblewrap leaves the files out of the sandbox.
        expect(check.output).toMatch(/Operation not permitted|Permission denied|No such file or directory/);
      }
      expect(workers.jobs("1=1")[0]).toMatchObject({ state: "done", attempt: 1, worker: "loop-runner" });
    } finally {
      await worker.stop();
    }
  },
  60_000,
);

test("short registered credentials in executable inputs never reach a lease reply", async () => {
  const req = await request();
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  const secret = "p7x9k2v";
  req.gates.checks = [{ name: "short-secret", run: `printf '%s' '${secret}'` }];
  const queued = workers.enqueue(req);
  expect(workers.job(queued)?.state).toBe("queued");
  registerCredential("TEST_PASSWORD", secret);
  expect(credentialBearing(req)).toBe(true);
  const formatted = {
    ...req,
    gates: { ...req.gates, checks: [{ name: "short-secret", run: "printf '%s' 'p7x\x1b[31m9k2v'" }] },
  };
  expect(credentialBearing(formatted)).toBe(true);
  const immediate = workers.enqueue(req);
  expect(workers.job(immediate)?.state).toBe("failed");
  const reply = await call("/worker/lease", {}, token);
  expect(reply.json()).toEqual({ job: null, agentJob: null });
  expect(reply.data.toString()).not.toContain(secret);
  expect(workers.job(queued)?.state).toBe("failed");
}, 30_000);

test("registering a credential after dispatch preserves the active lease and its normal lifecycle", async () => {
  const req = await request();
  const secret = "active-lease-credential-570";
  req.gates.checks = [{ name: "check", run: `printf '%s' '${secret}'` }];
  workers.pairingKey = "test-pairing-key";
  const pending = workers.pair("runner", "a".repeat(64), "b".repeat(64));
  workers.approve(pending.code);
  const worker = workers.worker("runner");
  if (!worker) throw new Error("Missing worker");
  workers.heartbeat(worker, caps());
  const id = workers.enqueue(req);
  const leased = workers.lease(worker.name);
  expect(leased).toMatchObject({ id, state: "leased", worker: worker.name });
  registerCredential("ACTIVE_LEASE_TEST", secret);
  workers.sweep();
  expect(workers.job(id)).toEqual(leased);
  expect(workers.heartbeat(worker, caps([id]))).toEqual({ cancelled: [], releaseSha });
  expect(workers.holds(id, worker.name)).toMatchObject({ state: "leased", attempt: 1 });
  const run: GateRun = { setupOk: true, setup: [], checks: [] };
  workers.complete(id, run);
  expect(workers.job(id)).toMatchObject({ state: "done", worker: worker.name, attempt: 1 });
  expect(JSON.parse(workers.job(id)?.result ?? "null")).toEqual(run);
});

test("credential-bearing executable inputs stay local, including requests queued before registration", async () => {
  const req = await request();
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  const secret = "dispatch-credential-570";
  const formatted = `${secret.slice(0, 9)}\x1b[31m${secret.slice(9)}`;
  const original = `printf '%s' '${secret}' > preserved-command`;
  const variants: GateRequest[] = [
    { ...req, gates: { ...req.gates, setup: [original] } },
    { ...req, gates: { ...req.gates, checks: [{ name: "secret", run: original }] } },
    { ...req, gates: { ...req.gates, checks: [{ name: secret, run: "true" }] } },
    { ...req, checks: [secret] },
    { ...req, gates: { ...req.gates, retryFiles: `${secret} {files}` } },
    { ...req, gates: { ...req.gates, setup: [`: '${formatted}'`] } },
  ];
  const queued = workers.enqueue(variants[0] ?? req);
  expect(workers.job(queued)?.state).toBe("queued");
  registerCredential("DISPATCH_TEST", secret);
  expect((await call("/worker/lease", {}, token)).json()).toEqual({ job: null, agentJob: null });
  expect(workers.job(queued)?.state).toBe("failed");
  await confinementScope.run(fakeConfinement, () =>
    executeGate(
      variants[0] ?? req,
      AbortSignal.timeout(30_000),
      {},
      gateExecutorFor("lan", workers, [req.repo]),
      { kind: "lan", id: queued, startedAt: Date.now() },
    ),
  );
  expect(readFileSync(join(req.cwd, "preserved-command"), "utf8")).toBe(secret);
  const executor = gateExecutorFor("lan", workers, [req.repo]);
  for (const input of variants) {
    expect(credentialBearing(input)).toBe(true);
    const handle = await confinementScope.run(fakeConfinement, () =>
      executor.start(input, new AbortController().signal),
    );
    expect(workers.job(handle.id)?.state).toBe("failed");
    const reply = await call("/worker/lease", {}, token);
    expect(reply.data.toString()).not.toContain(secret);
    expect(reply.json()).toEqual({ job: null, agentJob: null });
    const preservesCommand =
      input.gates.setup.includes(original) || input.gates.checks.some((c) => c.run === original);
    if (preservesCommand) rmSync(join(req.cwd, "preserved-command"), { force: true });
    const run = await confinementScope.run(fakeConfinement, () =>
      executeGate(input, AbortSignal.timeout(30_000), {}, executor, handle),
    );
    expect(run.setupOk).toBe(true);
    expect(workers.job(handle.id)?.state).toBe("done");
    const events = workers.job(handle.id)?.events ?? "";
    expect(events).toContain("executable inputs contain a registered credential");
    expect(events).not.toContain(secret);
    if (preservesCommand) expect(readFileSync(join(req.cwd, "preserved-command"), "utf8")).toBe(secret);
  }
  expect(
    store
      .listEvents(req.runId ?? "")
      .map((e) => e.message)
      .join("\n"),
  ).not.toContain(secret);
  // Formatting changes alone do not signal a credential replacement.
  const safe = { ...req, gates: { ...req.gates, checks: [{ name: "safe\x1b[31m", run: "true" }] } };
  expect(credentialBearing(safe)).toBe(false);
  const handle = await executor.start(safe, new AbortController().signal);
  expect((await call("/worker/lease", {}, token)).json()).toMatchObject({ job: { id: handle.id } });
}, 60_000);

test.each([1, 128])(
  "one lease poll batches ownership of %d held jobs with one sweep",
  async (count) => {
    let now = Date.now();
    workers = new WorkerStore(store, releaseSha, { poll: 0 }, () => now);
    await listen();
    const token = await paired(),
      other = await paired("other");
    // Exercise expired leases after the listener's restart grace.
    now += workers.times.lease;
    await call("/worker/heartbeat", { ...caps(), freeSlots: 128 }, token);
    await call("/worker/heartbeat", caps(), other);
    const req: GateRequest = {
      repo: "test/repo",
      cwd: home,
      headSha: releaseSha,
      baseSha: releaseSha,
      gates: { setup: [], checks: [], source: "none", protectedPaths: [] },
    };
    const ids = Array.from({ length: count }, () => workers.enqueue(req));
    for (const id of ids) {
      store.db
        .query(
          "UPDATE gate_jobs SET state='leased',worker='runner',lease_expires_at=?,attempt_deadline_at=? WHERE id=?",
        )
        .run(now + 60_000, now + 360_000, id);
    }
    const expired = ids[0] ?? "";
    store.db.query("UPDATE gate_jobs SET lease_expires_at=? WHERE id=?").run(now, expired);
    if (count > 1) {
      store.db.query("UPDATE gate_jobs SET worker='other' WHERE id=?").run(ids[1] ?? "");
      workers.cancel(ids[2] ?? "");
    }
    const sweep = spyOn(workers, "sweep"),
      lookup = spyOn(workers, "cancelledHeld");
    const query = spyOn(store.db, "query");
    try {
      const cancelled = (await call("/worker/lease", { jobs: ids }, token)).json();
      expect(cancelled).toEqual({ job: null, agentJob: null, cancelled: ids.slice(0, Math.min(count, 3)) });
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(query.mock.calls.filter(([sql]) => sql.includes("json_each"))).toHaveLength(1);
      expect(query.mock.calls.length).toBeLessThan(count + 20);
    } finally {
      sweep.mockRestore();
      lookup.mockRestore();
      query.mockRestore();
    }
    workers.revoke("other");
    now += 1;
    workers.sweep();
    if (count > 1) expect(workers.job(ids[1] ?? "")?.failure_reason).toBe("Worker disconnected or revoked");
  },
  30_000,
);

test("fresh heartbeats cannot perpetuate bundle 503s, including across store restart", async () => {
  let now = Date.now();
  const times = { poll: 0, tick: 5 };
  workers = new WorkerStore(store, releaseSha, times, () => now);
  const req = await request();
  req.gates.setup = [];
  req.gates.checks = [{ name: "fail", run: "exit 7", timeoutSec: 1 }];
  const server = await listen();
  const address = `127.0.0.1:${server.url.port}`;
  const executor = gateExecutorFor("lan", workers, [req.repo]);
  const handle = await executor.start(req, new AbortController().signal);
  const cancellations: string[] = [],
    owners: string[] = [];
  let deadline = 0,
    renewed = 0,
    restarted = false;
  const blocked = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const transport: NonNullable<Parameters<typeof runWorker>[4]>["request"] = async (...args) => {
    const path = args[1];
    if (path.endsWith("/bundle")) {
      const data = Buffer.from("{}");
      return { status: 503, data, fingerprint: server.tls.fingerprint, json: () => ({}) };
    }
    const held = (args[2] as { jobs?: string[] } | undefined)?.jobs ?? [];
    if (path === "/worker/heartbeat" && held.includes(handle.id)) {
      now += 20_000;
      if (!restarted) {
        restarted = true;
        blocked.resolve();
        await resume.promise;
      }
    }
    const reply = await workerRequest(...args);
    if (path === "/worker/lease") {
      const job = (reply.json() as { job?: { id: string } }).job;
      if (job) {
        owners.push(workers.job(job.id)?.worker ?? "");
        deadline = workers.job(job.id)?.attempt_deadline_at ?? 0;
        expect(deadline).toBe(now + attemptBudget(req));
      }
    }
    if (path === "/worker/heartbeat" && held.includes(handle.id)) {
      const job = workers.job(handle.id);
      if (job?.state === "leased") {
        renewed++;
        expect(job.attempt_deadline_at).toBe(deadline);
        expect(job.lease_expires_at).toBeLessThanOrEqual(deadline);
      }
      cancellations.push(...(reply.json() as { cancelled: string[] }).cancelled);
    }
    return reply;
  };
  let first: Awaited<ReturnType<typeof loop>> | undefined;
  let second: Awaited<ReturnType<typeof loop>> | undefined;
  try {
    first = await loop({ request: transport });
    await blocked.promise;
    const persisted = workers.job(handle.id)?.attempt_deadline_at;
    await server.stop();
    listener = undefined;
    store.close();
    store = new Store(cfg.paths.db);
    workers = new WorkerStore(store, releaseSha, times, () => now);
    await listen(address);
    expect(workers.job(handle.id)?.attempt_deadline_at).toBe(persisted);
    resume.resolve();
    const waitState = async (state: string) => {
      const end = Date.now() + 10_000;
      while (workers.job(handle.id)?.state !== state || !cancellations.includes(handle.id)) {
        if (Date.now() > end) throw new Error(`Job did not reach ${state}`);
        await Bun.sleep(5);
      }
    };
    await waitState("queued");
    expect(workers.job(handle.id)).toMatchObject({ attempt: 2, failure_reason: "Attempt deadline expired" });
    const token = readFileSync(join(first.remote.paths.home, "worker", "token"), "utf8");
    for (const action of ["events", "result"])
      expect((await call(`/worker/jobs/${handle.id}/${action}`, {}, token)).status).toBe(409);
    cancellations.length = 0;
    second = await loop({ request: transport }, "second-runner");
    await waitState("failed");
    expect(owners).toEqual(["loop-runner", "second-runner"]);
    expect(renewed).toBeGreaterThan(2);
    const result = await confinementScope.run(fakeConfinement, () =>
      executeGate(req, AbortSignal.timeout(30_000), {}, gateExecutorFor("lan", workers, [req.repo]), handle),
    );
    expect(result.checks[0]).toMatchObject({ ok: false, exitCode: 7 });
    expect(workers.job(handle.id)?.state).toBe("done");
    expect(store.getRunState(req.runId ?? "")).toBeNull();
    expect(store.listInvocations(req.runId ?? "")).toHaveLength(0);
    const events = store.listEvents(req.runId ?? "").filter((e) => e.type === "gate");
    expect(events.map((e) => e.message)).toEqual([
      "LAN infrastructure failure: Attempt deadline expired",
      "LAN infrastructure failure: Attempt deadline expired",
      "LAN gates falling back to local execution",
    ]);
  } finally {
    resume.resolve();
    await first?.stop();
    await second?.stop();
  }
}, 60_000);

async function until(predicate: () => boolean) {
  const end = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Worker condition did not settle");
    await Bun.sleep(5);
  }
}

test("the worker's attempt deadline aborts retries and bounds an unavailable failure notification", async () => {
  await listen();
  const req = await request();
  const id = workers.enqueue(req);
  const notified = Promise.withResolvers<AbortSignal>();
  let bundleSignal: AbortSignal | undefined;
  const worker = await loop({
    async request(...args) {
      const path = args[1];
      if (path.endsWith("/bundle")) {
        bundleSignal = args[3]?.signal;
        return { status: 503, data: Buffer.from("{}"), fingerprint: "", json: () => ({}) };
      }
      if (path.endsWith("/failure")) {
        const signal = args[3]?.signal;
        if (!signal) throw new Error("Missing bounded failure signal");
        notified.resolve(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new Error("Notification unavailable");
      }
      const reply = await workerRequest(...args);
      if (path === "/worker/lease") {
        const body = reply.json() as { job: { remainingMs?: number } | null };
        if (body.job) body.job.remainingMs = 30;
        return { ...reply, json: () => body };
      }
      return reply;
    },
  });
  try {
    const signal = await notified.promise;
    expect(bundleSignal?.aborted).toBe(true);
    await until(() => signal.aborted && readdirSync(worker.remote.paths.work).length === 0);
    // The coordinator recovers independently when the best-effort notification is lost.
    store.db.query("UPDATE gate_jobs SET attempt_deadline_at=0 WHERE id=?").run(id);
    workers.sweep();
    expect(workers.job(id)).toMatchObject({
      state: "queued",
      attempt: 2,
      failure_reason: "Attempt deadline expired",
    });
  } finally {
    await worker.stop();
  }
}, 30_000);

test("worker cleanup restores locked directories without following symlinks and survives a cleanup error", async () => {
  await listen();
  const req = await request(true);
  req.gates.setup = [];
  req.gates.checks = [{ name: "locked", run: "mkdir locked; touch locked/file; chmod 000 locked" }];
  const outside = join(home, "outside");
  mkdirSync(outside);
  chmodSync(outside, 0o500);
  const checkouts: string[] = [],
    scratches: string[] = [],
    diagnostics: string[] = [];
  const command = await import("../src/git/command.ts"),
    original = command.worktreeGit;
  let failRemoval = false;
  const externalWrites: { args: string[]; roots: string[] | undefined }[] = [];
  const spy = spyOn(command, "worktreeGit").mockImplementation(async (args, options) => {
    if ((args[1] === "worktree" && args[2] === "remove") || (args[1] === "bundle" && args[2] === "create"))
      externalWrites.push({ args, roots: options.additionalWriteRoots });
    if (failRemoval && args[1] === "worktree" && args[2] === "remove") {
      failRemoval = false;
      throw new Error("cleanup-sensitive-diagnostic-570");
    }
    return original(args, options);
  });
  const worker = await loop({
    log: (text) => diagnostics.push(text),
    confinement: {
      ...fakeConfinement,
      async verify(_roots, opts) {
        const local = new Store(join(home, "remote", "worker", "worker.db"));
        try {
          expect(local.getSetting("worker.cleanups", {})).toMatchObject({
            [dirname(opts.cwd)]: {
              pending: [],
              ownership: { marker: processScope.getStore()?.ownershipMarker },
            },
          });
        } finally {
          local.close();
        }
        if (!checkouts.includes(opts.cwd)) {
          checkouts.push(opts.cwd);
          scratches.push(invocationScratch.getStore() ?? "");
          symlinkSync(outside, join(opts.cwd, "outside"));
        }
      },
    },
  });
  try {
    const execute = () =>
      executeGate(req, AbortSignal.timeout(30_000), {}, gateExecutorFor("lan", workers, [req.repo]));
    const first = await execute();
    expect(first.checks[0]?.ok).toBe(true);
    await until(() => readdirSync(worker.remote.paths.work).length === 0);
    expect(statSync(outside).mode & 0o777).toBe(0o500);
    expect(diagnostics).toEqual([]);
    failRemoval = true;
    const second = await execute();
    expect(second.checks[0]?.ok).toBe(true);
    await until(() => readdirSync(worker.remote.paths.work).length === 0);
    expect(diagnostics).toEqual(["Worker checkout cleanup failed"]);
    expect(diagnostics.join()).not.toContain("cleanup-sensitive-diagnostic-570");
    req.gates.checks = [{ name: "after", run: "true" }];
    expect((await execute()).checks[0]?.ok).toBe(true);
    await until(() => readdirSync(worker.remote.paths.work).length === 0);
    expect(checkouts).toHaveLength(3);
    expect(checkouts.every((path) => !existsSync(path))).toBe(true);
    expect(scratches).toHaveLength(3);
    for (const path of scratches) {
      expect(path).not.toBe("");
      expect(existsSync(path)).toBe(false);
    }
    expect(workerCleanupRecords(worker.remote)).toEqual([]);
    expect(externalWrites.filter(({ args }) => args[1] === "bundle")).toHaveLength(3);
    expect(externalWrites.filter(({ args }) => args[1] === "worktree")).toHaveLength(3);
    for (const { args, roots } of externalWrites)
      expect(roots).toEqual([args[1] === "bundle" ? dirname(args[3] ?? "") : (args.at(-1) ?? "")]);
    expect(workers.jobs("1=1").every((j) => j.state === "done" && j.attempt === 1)).toBe(true);
    expect(statSync(outside).mode & 0o777).toBe(0o500);
  } finally {
    await worker.stop();
    spy.mockRestore();
    chmodSync(outside, 0o700);
  }
}, 60_000);

test.each(["changed work path", "removal error"] as const)(
  "worker startup discards completed cleanup after a %s and accepts jobs",
  async (kind) => {
    await listen();
    const remote = loadConfig({ home: join(home, "remote"), configDir: cfg.paths.configDir, raw: {} });
    const root = mkdtempSync(join(kind === "changed work path" ? home : remote.paths.work, "worker-"));
    const marker = join(root, "keep");
    writeFileSync(marker, "retained directory");
    mkdirSync(join(remote.paths.home, "worker"));
    const local = new Store(join(remote.paths.home, "worker", "worker.db"));
    local.setSetting("worker.cleanups", {
      [root]: {
        root,
        cache: join(root, "repo.git"),
        scratch: [],
        confirmed: true,
        ownership: { marker: crypto.randomUUID(), runId: "completed", started: 0, boot: "old-boot" },
      },
    });
    local.close();
    const scratch = await import("../src/harness/scratch.ts"),
      original = scratch.removeScratch;
    const spy = spyOn(scratch, "removeScratch").mockImplementation((directory) => {
      if (directory === root) throw new Error("private-cleanup-diagnostic");
      original(directory);
    });
    const diagnostics: string[] = [];
    const id = await queuedLocalAgent();
    const worker = await loop({
      log: (text) => diagnostics.push(text),
      harnesses: { claude: fakeHarness(() => ({})) },
    });
    try {
      await until(() => workers.agentJob(id)?.state === "done");
      await worker.stop();
      expect(diagnostics).toEqual(["Worker checkout cleanup failed"]);
      expect(readFileSync(marker, "utf8")).toBe("retained directory");
      const reopened = new Store(join(remote.paths.home, "worker", "worker.db"));
      try {
        expect(reopened.getSetting("worker.cleanups", {})).toEqual({});
        expect(reopened.listProcessCleanups()).toEqual([]);
      } finally {
        reopened.close();
      }
    } finally {
      try {
        await worker.stop();
      } finally {
        spy.mockRestore();
      }
    }
  },
  30_000,
);

test.each(["changed", "equal", "unavailable", "unrecorded"] as const)(
  "worker confirms retained ownership only from a scan or changed boot (%s)",
  async (kind) => {
    const server = await listen();
    const remote = loadConfig({ home: join(home, "remote"), configDir: cfg.paths.configDir, raw: {} });
    await pairWorker(server.url.origin, join(remote.paths.home, "worker"), "recovering", (text) =>
      workers.approve(text.split(": ")[1] ?? ""),
    );
    const root = mkdtempSync(join(remote.paths.work, "worker-"));
    const scratch = mkdtempSync(join(home, "kept-scratch-"));
    const legacyRoot = mkdtempSync(join(remote.paths.work, "worker-"));
    const database = join(remote.paths.home, "worker", "worker.db");
    const local = new Store(database);
    const marker = crypto.randomUUID();
    local.setSetting("worker.cleanups", {
      [legacyRoot]: { root: legacyRoot, cache: join(legacyRoot, "repo.git"), scratch: [] },
      [root]: {
        root,
        cache: join(root, "repo.git"),
        scratch: [scratch],
        confirmed: false,
        ownership: {
          marker,
          runId: "retained",
          started: 0,
          ...(kind === "unrecorded" ? {} : { boot: "previous-boot" }),
        },
      },
    });
    // Old PID evidence must be discarded on a reboot without signalling it.
    local.recordProcessCleanup({
      runId: "retained",
      invocation: marker,
      directory: join(root, "checkout"),
      pid: 2_000_000_000,
      birth: "old-birth",
      boot: "previous-boot",
      createdAt: 0,
    });
    local.close();
    const controller = new AbortController();
    const diagnostics: string[] = [];
    let scansAvailable = false,
      heartbeats = 0,
      signals = 0;
    const kill = spyOn(process, "kill").mockImplementation(() => {
      signals++;
      return true;
    });
    try {
      await processBootInspection.run(
        () => {
          if (kind === "unavailable") throw new Error("boot unavailable");
          return kind === "changed" ? "new-boot" : "previous-boot";
        },
        () =>
          processRecoveryInspection.run(
            {
              stopped: recoveryProcessStopped,
              timeoutMs: 100,
              discover: async () => {
                if (!scansAvailable) throw new Error("scan unavailable");
                return [];
              },
            },
            () =>
              runWorker(server.url.origin, remote, releaseSha, controller.signal, {
                platform: "darwin",
                confinement: fakeConfinement,
                heartbeatMs: 5,
                machineState: async () => ({ onAC: true, idleSeconds: 0 }),
                log: (text) => diagnostics.push(text),
                request: async (...args) => {
                  if (args[1] === "/worker/heartbeat") {
                    heartbeats++;
                    if (heartbeats === 1) {
                      expect(existsSync(root)).toBe(kind !== "changed");
                      expect(existsSync(scratch)).toBe(kind !== "changed");
                      expect(existsSync(legacyRoot)).toBe(true);
                      scansAvailable = true;
                    } else if (!existsSync(root)) {
                      expect(existsSync(root)).toBe(false);
                      expect(existsSync(scratch)).toBe(false);
                      expect(existsSync(legacyRoot)).toBe(true);
                      const reopened = new Store(database);
                      try {
                        expect(Object.keys(reopened.getSetting("worker.cleanups", {}))).toEqual([legacyRoot]);
                        expect(reopened.listProcessCleanups()).toEqual([]);
                      } finally {
                        reopened.close();
                      }
                      controller.abort();
                    }
                  }
                  return workerRequest(...args);
                },
              }),
          ),
      );
      expect(heartbeats).toBeGreaterThanOrEqual(2);
      expect(signals).toBe(0);
      expect(diagnostics.some((text) => text.includes("missing worker discovery evidence"))).toBe(true);
      if (kind !== "changed")
        expect(diagnostics.some((text) => text.includes("scan unavailable"))).toBe(true);
    } finally {
      controller.abort();
      kill.mockRestore();
    }
  },
);

test("pending recovery requires a changed boot while saved null-leader context and new jobs recover independently", async () => {
  const server = await listen();
  const id = await queuedLocalAgent();
  const remote = loadConfig({ home: join(home, "remote"), configDir: cfg.paths.configDir, raw: {} });
  await pairWorker(server.url.origin, join(remote.paths.home, "worker"), "recovering", (text) =>
    workers.approve(text.split(": ")[1] ?? ""),
  );
  const root = mkdtempSync(join(remote.paths.work, "worker-"));
  const scratch = mkdtempSync(join(home, "pending-scratch-"));
  const savedRoot = mkdtempSync(join(remote.paths.work, "worker-"));
  const pending = crypto.randomUUID();
  const database = join(remote.paths.home, "worker", "worker.db");
  const local = new Store(database);
  const entry = {
    root,
    cache: join(root, "repo.git"),
    scratch: [scratch],
    pending: [pending],
    discoveries: [],
    ownership: { marker: crypto.randomUUID(), runId: "pending", started: 0, boot: "test-boot" },
  };
  local.setSetting("worker.cleanups", {
    [root]: entry,
    [savedRoot]: {
      root: savedRoot,
      cache: join(savedRoot, "repo.git"),
      scratch: [],
      pending: [],
      discoveries: [
        {
          invocation: crypto.randomUUID(),
          runId: "saved",
          directory: join(savedRoot, "checkout"),
          boot: "test-boot",
          createdAt: 0,
          discovery: { group: 0, started: 0, directories: [], leader: null, spawnedAt: "0" },
        },
      ],
    },
  });
  local.close();
  for (const [attempt, boot] of ["test-boot", "test-boot", "next-boot"].entries()) {
    const controller = new AbortController();
    const diagnostics: string[] = [];
    let heartbeats = 0;
    const task = processBootInspection.run(
      () => boot,
      () =>
        processRecoveryInspection.run(
          { stopped: recoveryProcessStopped, timeoutMs: 1000, discover: async () => [] },
          () =>
            runWorker(server.url.origin, remote, releaseSha, controller.signal, {
              platform: "darwin",
              confinement: fakeConfinement,
              heartbeatMs: 5,
              machineState: async () => ({ onAC: true, idleSeconds: 0 }),
              log: (text) => diagnostics.push(text),
              harnesses: { claude: fakeHarness(() => ({})) },
              request: async (...args) => {
                if (attempt > 0 && args[1] === "/worker/heartbeat" && ++heartbeats === 2) controller.abort();
                return workerRequest(...args);
              },
            }),
        ),
    );
    try {
      if (attempt === 0) {
        await until(() => workers.agentJob(id)?.state === "done");
        controller.abort();
      }
      await task;
    } finally {
      controller.abort();
      await task;
    }
    const changed = boot === "next-boot";
    expect(existsSync(root)).toBe(!changed);
    expect(existsSync(scratch)).toBe(!changed);
    expect(existsSync(savedRoot)).toBe(false);
    const reopened = new Store(database);
    try {
      expect(reopened.getSetting("worker.cleanups", {})).toEqual(changed ? {} : { [root]: entry });
      expect(reopened.listProcessCleanups()).toEqual([]);
    } finally {
      reopened.close();
    }
    if (!changed) expect(diagnostics.some((text) => text.includes("awaiting changed boot"))).toBe(true);
  }
});

test.each([true, false])(
  "discovery save failure retains pending evidence unless live termination confirms it (%s)",
  async (confirmed) => {
    const server = await listen();
    const id = await queuedLocalAgent();
    const failed = Promise.withResolvers<void>();
    let root = "",
      scratch = "",
      invocation = "";
    let delayedTermination = false;
    const worker = await loop({
      heartbeatMs: 60_000,
      harnesses: {
        claude: fakeHarness(async (spec) => {
          root = dirname(spec.cwd);
          scratch = spec.scratchDir ?? "";
          const original = Store.prototype.setSetting;
          const saving = spyOn(Store.prototype, "setSetting").mockImplementation(function (
            this: Store,
            key,
            value,
          ) {
            const job = (value as Record<string, { discoveries?: ProcessDiscovery[] }>)[root];
            const row = job?.discoveries?.[0];
            if (key === "worker.cleanups" && row) {
              invocation = row.invocation;
              throw new Error("injected discovery save failure");
            }
            original.call(this, key, value);
          });
          const controller = new AbortController();
          // Bound a regression's long-running child without letting the watchdog count as prompt cleanup.
          const watchdog = setTimeout(() => {
            delayedTermination = true;
            controller.abort();
          }, 5000);
          try {
            const command = () =>
              runProcess({
                cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
                cwd: spec.cwd,
                env: {},
                signal: controller.signal,
              });
            await expect(
              confirmed
                ? command()
                : processInspection.run(async () => {
                    throw new Error("injected termination failure");
                  }, command),
            ).rejects.toThrow(ProcessTerminationError.prefix);
          } finally {
            clearTimeout(watchdog);
            controller.abort();
            saving.mockRestore();
          }
          return {};
        }),
      },
      request: async (...args) => {
        const reply = await workerRequest(...args);
        if (args[1] === agentPath(id, "failure")) failed.resolve();
        return reply;
      },
    });
    const database = join(worker.remote.paths.home, "worker", "worker.db");
    try {
      await failed.promise;
      await worker.stop();
      expect(delayedTermination).toBe(false);
      expect(workers.agentJob(id)?.state).not.toBe("done");
      expect(existsSync(root)).toBe(true);
      expect(existsSync(scratch)).toBe(true);
      const local = new Store(database);
      try {
        expect(invocation).not.toBe("");
        expect(local.getSetting("worker.cleanups", {})).toMatchObject({
          [root]: { pending: confirmed ? [] : [invocation], discoveries: [], scratch: [scratch] },
        });
      } finally {
        local.close();
      }
      const controller = new AbortController();
      const diagnostics: string[] = [];
      await processRecoveryInspection.run(
        { stopped: recoveryProcessStopped, timeoutMs: 1000, discover: async () => [] },
        () =>
          runWorker(server.url.origin, worker.remote, releaseSha, controller.signal, {
            platform: "darwin",
            confinement: fakeConfinement,
            machineState: async () => ({ onAC: true, idleSeconds: 0 }),
            log: (text) => diagnostics.push(text),
            request: async (...args) => {
              controller.abort();
              return workerRequest(...args);
            },
          }),
      );
      expect(existsSync(root)).toBe(!confirmed);
      expect(existsSync(scratch)).toBe(!confirmed);
      const reopened = new Store(database);
      try {
        if (confirmed) expect(reopened.getSetting("worker.cleanups", {})).toEqual({});
        else
          expect(reopened.getSetting("worker.cleanups", {})).toMatchObject({
            [root]: { pending: [invocation] },
          });
      } finally {
        reopened.close();
      }
      if (!confirmed) expect(diagnostics.some((text) => text.includes("awaiting changed boot"))).toBe(true);
    } finally {
      await worker.stop();
      removeScratch(scratch);
    }
  },
  30_000,
);

test("worker persists concurrent invocation markers before spawn and clears only saved discoveries", async () => {
  await listen();
  const id = await queuedLocalAgent();
  const worker = await loop({
    harnesses: {
      claude: fakeHarness(async (spec) => {
        const scope = processScope.getStore();
        if (!scope?.cleanups?.recordProcessDiscovery) throw new Error("Missing process scope");
        const read = () => {
          const local = new Store(join(home, "remote", "worker", "worker.db"));
          try {
            return local.getSetting<
              Record<string, { pending: string[]; discoveries: ProcessDiscovery[]; scratch: string[] }>
            >("worker.cleanups", {})[dirname(spec.cwd)];
          } finally {
            local.close();
          }
        };
        expect(read()?.pending).toEqual([]); // withScratch's markerless save owns scratch only.
        expect(read()?.scratch).toContain(spec.scratchDir ?? "");
        const sentinel = join(spec.cwd, "must-not-spawn");
        const originalSave = Store.prototype.setSetting;
        const preSpawn = spyOn(Store.prototype, "setSetting").mockImplementation(function (
          this: Store,
          key,
          value,
        ) {
          if (key === "worker.cleanups") throw new Error("pre-spawn save failed");
          originalSave.call(this, key, value);
        });
        try {
          await expect(
            runProcess({
              cmd: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(sentinel)}, '')`],
              cwd: spec.cwd,
              env: {},
            }),
          ).rejects.toThrow("pre-spawn save failed");
        } finally {
          preSpawn.mockRestore();
        }
        expect(existsSync(sentinel)).toBe(false);
        expect(read()?.pending).toEqual([]);
        const rows: ProcessDiscovery[] = [];
        const record = scope.cleanups.recordProcessDiscovery;
        scope.cleanups.recordProcessDiscovery = (row) => {
          rows.push(row);
        };
        const release = join(spec.cwd, "release");
        const ready = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
        const commands = ready.map((signal) =>
          runProcess({
            cmd: [
              process.execPath,
              "-e",
              `console.log(process.env.LIMITLESS_INVOCATION); while (!require('fs').existsSync(${JSON.stringify(release)})) await Bun.sleep(10);`,
            ],
            cwd: spec.cwd,
            env: {},
            timeoutMs: 5000,
            onStdoutLine: (marker) => {
              expect(read()?.pending).toContain(marker);
              signal.resolve(marker);
            },
          }),
        );
        try {
          const markers = await Promise.all(ready.map((signal) => signal.promise));
          expect(new Set(markers).size).toBe(2);
          expect(read()?.pending?.sort()).toEqual([...markers].sort());
          const first = rows[0],
            second = rows[1];
          if (!first || !second) throw new Error("Missing discovery context");
          record(first);
          expect(read()?.pending).toEqual([second.invocation]);
          expect(read()?.discoveries).toEqual([first]);
          // A failed save must retain the remaining marker and not publish discovery in memory.
          const original = Store.prototype.setSetting;
          const saving = spyOn(Store.prototype, "setSetting").mockImplementation(function (
            this: Store,
            key,
            value,
          ) {
            if (key === "worker.cleanups") throw new Error("injected save failure");
            original.call(this, key, value);
          });
          try {
            expect(() => record(second)).toThrow("injected save failure");
            expect(() => scope.cleanups?.deleteInvocationCleanups(second.invocation)).toThrow(
              "injected save failure",
            );
            expect(() => scope.cleanups?.deleteInvocationCleanups(first.invocation)).toThrow(
              "injected save failure",
            );
          } finally {
            saving.mockRestore();
          }
          expect(read()?.pending).toEqual([second.invocation]);
          expect(scope.cleanups.listProcessDiscoveries?.()).toContainEqual(first);
          expect(scope.cleanups.listProcessDiscoveries?.()).not.toContainEqual(second);
          record(second);
          expect(read()?.pending).toEqual([]);
        } finally {
          writeFileSync(release, "");
          await Promise.all(commands);
          rmSync(release);
          scope.cleanups.recordProcessDiscovery = record;
        }
        expect(read()?.pending).toEqual([]);
        expect(read()?.discoveries).toEqual([]);
        return {};
      }),
    },
  });
  try {
    await until(() => workers.agentJob(id)?.state === "done");
    await worker.stop();
    expect(workerCleanupRecords(worker.remote)).toEqual([]);
    expect(readdirSync(worker.remote.paths.work)).toEqual([]);
  } finally {
    await worker.stop();
  }
}, 30_000);

test("worker retains a pending job until a change from its first readable boot", async () => {
  const server = await listen();
  const id = await queuedLocalAgent();
  let initialBoot = true;
  let root = "",
    scratch = "";
  const failed = Promise.withResolvers<void>();
  const worker = await processBootInspection.run(
    () => {
      if (initialBoot) {
        initialBoot = false;
        throw new Error("initial boot unavailable");
      }
      return "test-boot";
    },
    () =>
      loop({
        heartbeatMs: 60_000,
        harnesses: {
          claude: fakeHarness(async (spec) => {
            root = dirname(spec.cwd);
            scratch = spec.scratchDir ?? "";
            await processBootInspection.run(
              () => {
                throw new Error("discovery boot unavailable");
              },
              () =>
                processInspection.run(
                  async () => {
                    throw new Error("termination inspection unavailable");
                  },
                  () => runProcess({ cmd: [process.execPath, "-e", ""], cwd: spec.cwd, env: {} }),
                ),
            );
            return {};
          }),
        },
        request: async (...args) => {
          const reply = await workerRequest(...args);
          if (args[1] === agentPath(id, "failure")) failed.resolve();
          return reply;
        },
      }),
  );
  try {
    await failed.promise;
    await worker.stop();
    const database = join(worker.remote.paths.home, "worker", "worker.db");
    const local = new Store(database);
    try {
      expect(local.getSetting("worker.cleanups", {})).toMatchObject({
        [root]: {
          pending: [expect.any(String)],
          discoveries: [],
          scratch: [scratch],
          ownership: { marker: expect.any(String) },
        },
      });
      const jobs = local.getSetting<Record<string, { ownership: { boot?: string } }>>("worker.cleanups", {});
      expect(jobs[root]?.ownership.boot).toBeUndefined();
    } finally {
      local.close();
    }
    for (const boot of [undefined, "test-boot", "test-boot", "next-boot"]) {
      const controller = new AbortController();
      const diagnostics: string[] = [];
      let heartbeats = 0;
      await processBootInspection.run(
        () => {
          if (!boot) throw new Error("recovery boot unavailable");
          return boot;
        },
        () =>
          processRecoveryInspection.run(
            { stopped: recoveryProcessStopped, timeoutMs: 1000, discover: async () => [] },
            () =>
              runWorker(server.url.origin, worker.remote, releaseSha, controller.signal, {
                platform: "darwin",
                confinement: fakeConfinement,
                heartbeatMs: 5,
                machineState: async () => ({ onAC: true, idleSeconds: 0 }),
                log: (text) => diagnostics.push(text),
                request: async (...args) => {
                  if (args[1] === "/worker/heartbeat" && ++heartbeats === 2) controller.abort();
                  return workerRequest(...args);
                },
              }),
          ),
      );
      const changed = boot === "next-boot";
      expect(existsSync(root)).toBe(!changed);
      expect(existsSync(scratch)).toBe(!changed);
      const reopened = new Store(database);
      try {
        const jobs = reopened.getSetting<Record<string, { pending: string[]; ownership: { boot?: string } }>>(
          "worker.cleanups",
          {},
        );
        if (changed) expect(jobs).toEqual({});
        else {
          expect(jobs[root]?.pending).toEqual([expect.any(String)]);
          expect(jobs[root]?.ownership.boot).toBe(boot);
        }
      } finally {
        reopened.close();
      }
      if (!changed) expect(diagnostics.some((text) => text.includes("awaiting changed boot"))).toBe(true);
    }
    expect(workers.agentJob(id)?.state).not.toBe("done");
  } finally {
    await worker.stop();
  }
}, 30_000);

test.each(["legacy job", "orphan identities"] as const)(
  "worker startup recovers existing %s evidence from its local store",
  async (kind) => {
    await listen();
    const remote = loadConfig({ home: join(home, "remote"), configDir: cfg.paths.configDir, raw: {} });
    mkdirSync(join(remote.paths.home, "worker"));
    const root = mkdtempSync(join(remote.paths.work, "worker-"));
    const database = join(remote.paths.home, "worker", "worker.db");
    const local = new Store(database);
    if (kind === "legacy job")
      local.setSetting("worker.cleanups", {
        [root]: { root, cache: join(root, "repo.git"), scratch: [] },
      });
    local.recordProcessCleanup({
      invocation: crypto.randomUUID(),
      runId: "legacy",
      directory: join(root, "checkout"),
      boot: "test-boot",
      pid: 2_000_000_000,
      birth: "old",
      createdAt: 0,
      discovery: { group: 0, started: 0, directories: [root], leader: null, spawnedAt: "0" },
    });
    local.close();
    const observed = Promise.withResolvers<void>();
    const diagnostics: string[] = [];
    const worker = await loop({
      log: (text) => diagnostics.push(text),
      request: async (...args) => {
        if (args[1] === "/worker/heartbeat") observed.resolve();
        return workerRequest(...args);
      },
    });
    try {
      await observed.promise;
      await worker.stop();
      expect(workerCleanupRecords(remote)).toEqual([]);
      expect(existsSync(root)).toBe(kind === "orphan identities");
      expect(diagnostics).toEqual([]);
    } finally {
      await worker.stop();
    }
  },
);

test("worker startup retains legacy cleanup without termination evidence across restarts", async () => {
  const server = await listen();
  const remote = loadConfig({ home: join(home, "remote"), configDir: cfg.paths.configDir, raw: {} });
  const root = mkdtempSync(join(remote.paths.work, "worker-"));
  const scratch = mkdtempSync(join(home, "scratch-"));
  mkdirSync(join(root, "checkout"));
  mkdirSync(join(remote.paths.home, "worker"));
  const database = join(remote.paths.home, "worker", "worker.db");
  const legacy = { [root]: { root, cache: join(root, "repo.git"), scratch: [scratch], confirmed: true } };
  const local = new Store(database);
  local.setSetting("worker.cleanups", legacy);
  local.close();
  await pairWorker(server.url.origin, join(remote.paths.home, "worker"), "restarted", (text) =>
    workers.approve(text.split(": ")[1] ?? ""),
  );
  const req = await request(true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const diagnostics: string[] = [];
    const id = enqueueAgent({
      runId: req.runId,
      parentSha: req.headSha,
      branch: "change/worker-agent",
      target: { ...agentRequest().target, harness: "claude" },
    });
    const controller = new AbortController();
    const task = runWorker(server.url.origin, remote, releaseSha, controller.signal, {
      platform: "darwin",
      confinement: fakeConfinement,
      heartbeatMs: 10,
      retryMs: 5,
      machineState: async () => ({ onAC: true, idleSeconds: 0 }),
      log: (text) => diagnostics.push(text),
      harnesses: {
        claude: fakeHarness((spec) => {
          expect(dirname(spec.cwd)).not.toBe(root);
          expect(existsSync(join(root, "checkout"))).toBe(true);
          return {};
        }),
      },
    });
    try {
      await until(() => workers.agentJob(id)?.state === "done");
      controller.abort();
      await task;
      expect(diagnostics.some((text) => text.includes("missing worker discovery evidence"))).toBe(true);
      expect(existsSync(join(root, "checkout"))).toBe(true);
      expect(existsSync(scratch)).toBe(true);
      const reopened = new Store(database);
      try {
        expect(reopened.listProcessCleanups()).toEqual([]);
        expect(reopened.getSetting("worker.cleanups", {})).toEqual(legacy);
      } finally {
        reopened.close();
      }
    } finally {
      controller.abort();
      await task;
    }
  }
});

test("worker removes a NUL-argument job's directories and pending marker after synchronous spawn failure", async () => {
  await listen();
  const id = await queuedLocalAgent();
  let cwd = "",
    scratch = "";
  let pending: string[] | undefined;
  const worker = await loop({
    heartbeatMs: 60_000,
    harnesses: {
      claude: fakeHarness(async (spec) => {
        cwd = spec.cwd;
        scratch = spec.scratchDir ?? "";
        try {
          await runProcess({ cmd: [process.execPath, "-e", "\0"], cwd, env: {} });
        } finally {
          const local = new Store(join(home, "remote", "worker", "worker.db"));
          try {
            pending = local.getSetting<Record<string, { pending: string[] }>>("worker.cleanups", {})[
              dirname(cwd)
            ]?.pending;
          } finally {
            local.close();
          }
        }
        return {};
      }),
    },
  });
  try {
    await until(() => workers.agentJob(id)?.failure_reason != null);
    await worker.stop();
    expect(workers.agentJob(id)?.failure_reason).toContain("null bytes");
    expect(pending).toEqual([]);
    expect(cwd).not.toBe("");
    expect(scratch).not.toBe("");
    for (const directory of [dirname(cwd), cwd, scratch]) expect(existsSync(directory)).toBe(false);
    expect(workerCleanupRecords(worker.remote)).toEqual([]);
  } finally {
    await worker.stop();
  }
}, 30_000);

test("worker retains a job after an ordinary final confirmation error and later recovers its directories", async () => {
  const server = await listen();
  const id = await queuedLocalAgent();
  const secret = "synthetic-confirmation-secret";
  registerCredential("worker-confirmation-test", secret);
  const failure = new Error(`final discovery unavailable ${secret}`);
  let cwd = "",
    scratch = "",
    transmitted = "";
  const proc = await import("../src/util/proc.ts"),
    original = proc.recoverProcessCleanups;
  // Recovery normally wraps discovery errors. Expose the plain error at confirm's boundary.
  const recover = spyOn(proc, "recoverProcessCleanups").mockImplementation((...args) => {
    const owner = args[4];
    if (!cwd || owner?.runId !== id) return original(...args);
    const inspection = processRecoveryInspection.getStore();
    if (!inspection?.discover) throw new Error("Missing recovery inspection");
    return inspection
      .discover(owner.invocation, 0, owner.createdAt, owner.discovery.directories, null, new Set(), 0n)
      .then(() => {});
  });
  const worker = await processRecoveryInspection.run(
    {
      stopped: recoveryProcessStopped,
      timeoutMs: 100,
      discover: async () => {
        throw failure;
      },
    },
    () =>
      loop({
        heartbeatMs: 60_000,
        request: async (...args) => {
          if (args[1] === agentPath(id, "failure")) transmitted = (args[2] as { reason: string }).reason;
          return workerRequest(...args);
        },
        harnesses: {
          claude: fakeHarness((spec) => {
            cwd = spec.cwd;
            scratch = mkdtempSync(join(home, "final-confirm-scratch-"));
            processScope.getStore()?.scratchDirs.add(scratch);
            return {};
          }),
        },
      }),
  );
  try {
    await until(() => workers.agentJob(id)?.state === "done" || workers.agentJob(id)?.failure_reason != null);
    await worker.stop();
    expect(workers.agentJob(id)?.state).not.toBe("done");
    expect(transmitted).toBe(`${ProcessTerminationError.prefix}: final discovery unavailable [redacted]`);
    for (const directory of [dirname(cwd), cwd, scratch]) expect(existsSync(directory)).toBe(true);
    const local = new Store(join(worker.remote.paths.home, "worker", "worker.db"));
    try {
      expect(local.getSetting("worker.cleanups", {})).toMatchObject({
        [dirname(cwd)]: { root: dirname(cwd), scratch: [scratch], pending: [] },
      });
    } finally {
      local.close();
    }
    recover.mockRestore();
    const controller = new AbortController();
    await processRecoveryInspection.run(
      { stopped: recoveryProcessStopped, timeoutMs: 100, discover: async () => [] },
      () =>
        runWorker(server.url.origin, worker.remote, releaseSha, controller.signal, {
          platform: "darwin",
          confinement: fakeConfinement,
          machineState: async () => ({ onAC: true, idleSeconds: 0 }),
          request: async (...args) => {
            controller.abort();
            return workerRequest(...args);
          },
        }),
    );
    for (const directory of [dirname(cwd), cwd, scratch]) expect(existsSync(directory)).toBe(false);
    expect(workerCleanupRecords(worker.remote)).toEqual([]);
  } finally {
    await worker.stop();
    recover.mockRestore();
  }
}, 30_000);

test("a job's ordinary directory cleanup failure drops retained metadata after confirmed termination", async () => {
  await listen();
  const id = await queuedLocalAgent();
  let root = "";
  const scratch = await import("../src/harness/scratch.ts"),
    original = scratch.removeScratch;
  const spy = spyOn(scratch, "removeScratch").mockImplementation((directory) => {
    if (directory === root) throw new Error("private-cleanup-diagnostic");
    original(directory);
  });
  const diagnostics: string[] = [];
  const worker = await loop({
    log: (text) => diagnostics.push(text),
    harnesses: {
      claude: fakeHarness((spec) => {
        root = dirname(spec.cwd);
        const cleanups = processScope.getStore()?.cleanups;
        if (!cleanups) throw new Error("Missing cleanup store");
        // Model an ownership record whose process has already been confirmed stopped.
        cleanups.recordProcessCleanup({
          runId: id,
          invocation: id,
          directory: spec.cwd,
          pid: 1,
          birth: "test",
          boot: "test",
          createdAt: 0,
        });
        cleanups.deleteInvocationCleanups(id);
        return {};
      }),
    },
  });
  try {
    await until(() => workers.agentJob(id)?.state === "done");
    await worker.stop();
    expect(diagnostics).toEqual(["Worker checkout cleanup failed"]);
    expect(existsSync(root)).toBe(true);
    const local = new Store(join(worker.remote.paths.home, "worker", "worker.db"));
    try {
      expect(local.getSetting("worker.cleanups", {})).toEqual({});
      expect(local.listProcessCleanups()).toEqual([]);
    } finally {
      local.close();
    }
  } finally {
    try {
      await worker.stop();
    } finally {
      spy.mockRestore();
    }
  }
}, 30_000);

test.each(["failure", "cancellation"] as const)(
  "temporary bundle refs are removed after success and checkout %s",
  async (kind) => {
    await listen();
    const req = await request(true);
    req.gates.setup = [];
    req.gates.checks = [{ name: "pass", run: "true" }];
    const worker = await loop();
    const cache = join(worker.remote.paths.repos, `${encodeURIComponent(req.repo)}.git`);
    const repos = await import("../src/git/repos.ts"),
      original = repos.addDetachedWorktree;
    let imported = false,
      failedId = "";
    const spy = spyOn(repos, "addDetachedWorktree").mockImplementation(async (...args) => {
      if (!failedId) return original(...args);
      const refs = await worktreeGit(
        ["git", "for-each-ref", "--format=%(refname)", `refs/limitless-bundles/${failedId}/`],
        { cwd: cache },
      );
      imported = refs.stdout.includes(failedId);
      if (kind === "cancellation") {
        workers.cancel(failedId);
        const signal = args[3];
        if (!signal) throw new Error("Missing checkout signal");
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      throw new Error("Injected checkout failure after import");
    });
    try {
      const first = await executeGate(
        req,
        AbortSignal.timeout(30_000),
        {},
        gateExecutorFor("lan", workers, [req.repo]),
      );
      expect(first.checks[0]?.ok).toBe(true);
      await until(() => readdirSync(worker.remote.paths.work).length === 0);
      const refs = () =>
        worktreeGit(["git", "for-each-ref", "--format=%(refname)", "refs/limitless-bundles/"], {
          cwd: cache,
        });
      expect((await refs()).stdout).toBe("");
      await withRepoLock(cache, () =>
        worktreeGit(["git", "update-ref", "refs/limitless-bundles/unrelated/0", req.headSha], { cwd: cache }),
      );
      failedId = workers.enqueue(req);
      await until(
        () =>
          imported &&
          workers.job(failedId)?.state !== "leased" &&
          readdirSync(worker.remote.paths.work).length === 0,
      );
      expect(workers.job(failedId)?.state).toBe(kind === "failure" ? "queued" : "cancelled");
      expect(workerCleanupRecords(worker.remote)).toEqual([]);
      expect((await refs()).stdout.trim()).toBe("refs/limitless-bundles/unrelated/0");
    } finally {
      await worker.stop();
      spy.mockRestore();
    }
  },
  60_000,
);

test("pre-deadline leases gain one durable deadline without extending it on later heartbeats", async () => {
  let now = Date.now();
  workers = new WorkerStore(store, releaseSha, {}, () => now);
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  const req: GateRequest = {
    repo: "test/repo",
    cwd: home,
    headSha: releaseSha,
    baseSha: releaseSha,
    gates: { setup: [], checks: [], source: "none", protectedPaths: [] },
  };
  const id = workers.enqueue(req);
  await call("/worker/lease", {}, token);
  store.db.query("UPDATE gate_jobs SET attempt_deadline_at=NULL WHERE id=?").run(id);
  const expected = now + attemptBudget(req);
  now += 20_000;
  await call("/worker/heartbeat", caps([id]), token);
  expect(workers.job(id)?.attempt_deadline_at).toBe(expected);
  // Reconstruct the store wrapper without changing the persisted attempt.
  const resumed = new WorkerStore(store, releaseSha, {}, () => now);
  const w = resumed.authenticate(token);
  if (!w) throw new Error("Missing worker");
  now += 20_000;
  resumed.heartbeat(w, caps([id]));
  expect(resumed.job(id)?.attempt_deadline_at).toBe(expected);
}, 30_000);

test("a release change drains reporting and cleanup and rejects an in-flight lease before re-exec", async () => {
  await listen();
  const req = await request(true);
  req.gates.setup = [];
  req.gates.checks = [{ name: "pass", run: "true" }];
  const first = workers.enqueue(req),
    second = workers.enqueue(req),
    target = "a".repeat(40);
  const started = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>(),
    cleanup = Promise.withResolvers<void>(),
    reported = Promise.withResolvers<void>(),
    late = Promise.withResolvers<void>(),
    releaseLease = Promise.withResolvers<void>(),
    observed = Promise.withResolvers<void>(),
    replaced = Promise.withResolvers<void>();
  let lock: Promise<void> | undefined,
    captured = false,
    polls = 0,
    advertised = "b".repeat(40),
    latestObserved = false;
  const commands: string[][] = [],
    bundles: string[] = [];
  const worker = await loop({
    confinement: {
      ...fakeConfinement,
      async verify() {
        const cache = join(home, "remote", "repos", `${encodeURIComponent(req.repo)}.git`);
        lock = withRepoLock(cache, () => cleanup.promise);
        started.resolve();
        await finish.promise;
      },
    },
    async request(...args) {
      const path = args[1];
      if (path.endsWith("/bundle")) bundles.push(path);
      const reply = await workerRequest(...args);
      if (path.endsWith("/result")) reported.resolve();
      if (path === "/worker/lease" && ++polls === 2) {
        captured = true;
        late.resolve();
        await releaseLease.promise;
      }
      if (path === "/worker/heartbeat" && captured) {
        if ((args[2] as Capabilities).freeSlots === 0) observed.resolve();
        const coordinatorRelease = advertised;
        if (coordinatorRelease === target) latestObserved = true;
        return { ...reply, json: () => ({ ...(reply.json() as object), releaseSha: coordinatorRelease }) };
      }
      return reply;
    },
    update: {
      async command(args) {
        expect(readdirSync(join(home, "remote", "work"))).toEqual([]);
        expect(workers.job(first)?.state).toBe("done");
        expect(workers.job(second)?.state).toBe("queued");
        commands.push(args);
        return { stdout: args.includes(`${target}^{commit}`) ? target : releaseSha, stderr: "", exitCode: 0 };
      },
      exec(file, args, env) {
        expect(file).toBe(process.execPath);
        expect(args).toEqual([process.execPath, ...process.execArgv, ...process.argv.slice(1)]);
        expect(env).toBe(process.env);
        replaced.resolve();
      },
    },
  });
  try {
    await started.promise;
    await late.promise;
    await observed.promise;
    expect(commands).toEqual([]);
    releaseLease.resolve();
    finish.resolve();
    expect(commands).toEqual([]);
    advertised = target;
    await until(() => latestObserved);
    expect(commands).toEqual([]);
    cleanup.resolve();
    await reported.promise;
    await replaced.promise;
    expect(commands).toEqual([
      ["git", "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      ["git", "rev-parse", "--verify", `${target}^{commit}`],
      ["git", "merge-base", "--is-ancestor", target, "refs/remotes/origin/main"],
      ["git", "rev-parse", "HEAD"],
      ["git", "checkout", "--detach", target],
      [process.execPath, "install", "--frozen-lockfile"],
    ]);
    expect(bundles).toEqual([`/worker/jobs/${first}/bundle`]);
  } finally {
    finish.resolve();
    cleanup.resolve();
    releaseLease.resolve();
    await worker.stop();
    await lock;
  }
}, 30_000);

test.each(["malformed", "ancestry", "fetch", "install", "exec", "restore"])(
  "a failed worker update (%s) remains blocked and heartbeats a durable redacted warning",
  async (failure) => {
    await listen();
    const target = failure === "malformed" ? "main" : "a".repeat(40);
    const secret = `update-credential-${failure}-632`;
    registerCredential("WORKER_UPDATE_TEST", secret);
    let head = releaseSha,
      leases = 0,
      execs = 0,
      warningBeats = 0;
    const commands: string[][] = [];
    let transmittedWarning = "";
    const worker = await loop({
      async request(...args) {
        if (args[1] === "/worker/lease") leases++;
        const reply = await workerRequest(...args);
        if (args[1] === "/worker/heartbeat") {
          const body = args[2] as Capabilities;
          if (body.updateWarning) {
            transmittedWarning = body.updateWarning;
            expect(body.updateWarning).not.toContain(secret);
            expect(body.releaseSha).toBe(releaseSha);
            expect(body.freeSlots).toBe(0);
            warningBeats++;
          }
          return { ...reply, json: () => ({ cancelled: [], releaseSha: target }) };
        }
        return reply;
      },
      update: {
        async command(args) {
          commands.push(args);
          if (failure === "ancestry" && args[1] === "merge-base")
            throw new CommandError(`injected ancestry: ${secret}`, 1, "", secret, false);
          if (
            (failure === "fetch" && args[1] === "fetch") ||
            (["install", "restore"].includes(failure) && args[1] === "install") ||
            (failure === "restore" && args[1] === "checkout" && args[3] === releaseSha)
          )
            throw new Error(`injected ${failure}: ${secret}`);
          if (args[1] === "checkout") head = args[3] ?? "";
          return { stdout: args.includes(`${target}^{commit}`) ? target : head, stderr: "", exitCode: 0 };
        },
        exec() {
          execs++;
          throw new Error(`exec failed: ${secret}`);
        },
      },
    });
    try {
      await until(() => warningBeats >= 2);
      expect(leases).toBe(0);
      expect(execs).toBe(failure === "exec" ? 1 : 0);
      expect(head).toBe(failure === "restore" ? target : releaseSha);
      if (["malformed", "ancestry", "fetch"].includes(failure))
        expect(commands.some((args) => ["checkout", "install"].includes(args[1] ?? ""))).toBe(false);
      const warning = workers.list()[0]?.setupWarning;
      expect(transmittedWarning).toContain("Worker update failed:");
      expect(warning).toBe(
        ["malformed", "ancestry"].includes(failure) ? transmittedWarning : "[withheld: private text]",
      );
      expect(warning).not.toContain(secret);
      if (failure === "restore") expect(transmittedWarning).toContain("restoring original HEAD failed");
      await worker.stop();
      // A clean restart reports its current state rather than inheriting an old update warning.
      const row = workers.worker("loop-runner");
      if (!row) throw new Error("Missing worker");
      workers.heartbeat(row, caps());
      store.close();
      store = new Store(cfg.paths.db);
      workers = new WorkerStore(store, releaseSha);
      expect(workers.list()[0]?.setupWarning).toBeUndefined();
      expect(workers.list()[0]?.capabilities?.updateWarning).toBeUndefined();
    } finally {
      await worker.stop();
    }
  },
  30_000,
);

test.each(["legacy", "unchanged", "bun-only"])("%s heartbeats never invoke the updater", async (kind) => {
  await listen();
  let beats = 0,
    updates = 0;
  const worker = await loop({
    async request(...args) {
      if (kind === "bun-only" && args[1] === "/worker/heartbeat")
        args[2] = { ...(args[2] as Capabilities), bunVersion: "different" };
      const reply = await workerRequest(...args);
      if (args[1] === "/worker/heartbeat") {
        beats++;
        if (kind === "legacy") return { ...reply, json: () => ({ cancelled: [] }) };
      }
      return reply;
    },
    update: {
      async command() {
        updates++;
        throw new Error("Unexpected update");
      },
    },
  });
  try {
    await until(() => beats >= 2);
    expect(updates).toBe(0);
    expect(workers.list()[0]?.state).toBe(kind === "bun-only" ? "needs update" : "available");
  } finally {
    await worker.stop();
  }
});

const updateFixture = seeded(async (dir) => {
  const { value: original } = await fixture(dir);
  const git = (args: string[]) => sh(["git", ...args], { cwd: dir });
  await git(["branch", "-M", "main"]);
  writeFileSync(join(dir, "tracked"), "new release bytes\n");
  await git(["add", "tracked"]);
  await git(["commit", "-qm", "main release"]);
  const main = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["checkout", "-qb", "side", original]);
  await git(["commit", "--allow-empty", "-qm", "unmerged release"]);
  const side = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await git(["checkout", "--detach", original]);
  await git(["remote", "add", "origin", "."]);
  return { original, main, side };
});

test.each(["side", "missing", "malformed", "dirty", "install", "exec", "unavailable"])(
  "worker updater enforces fetched main ancestry and restores real HEAD after %s failure",
  async (failure) => {
    const cwd = join(home, "update-checkout");
    const {
      value: { original, main, side },
    } = await updateFixture(cwd);
    const target =
      failure === "side"
        ? side
        : failure === "missing"
          ? "0".repeat(40)
          : failure === "malformed"
            ? "a".repeat(41)
            : main;
    if (failure === "dirty") writeFileSync(join(cwd, "tracked"), "local changes\n");
    const installs: string[] = [];
    let execs = 0;
    const commands: string[][] = [];
    await expect(
      updateWorker(target, {
        cwd,
        async command(args, opts) {
          expect(opts.cwd).toBe(cwd);
          commands.push(args);
          if (args[1] === "install") {
            installs.push((await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim());
            if (failure === "install" && installs.length === 1) throw new Error("Frozen installation failed");
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return sh(args, opts);
        },
        exec:
          failure === "unavailable"
            ? null
            : () => {
                execs++;
                throw new Error("Replacement failed");
              },
      }),
    ).rejects.toThrow(
      failure === "unavailable"
        ? "Process replacement is unavailable"
        : failure === "install"
          ? "Frozen installation failed"
          : failure === "exec"
            ? "Replacement failed"
            : failure === "malformed"
              ? "full commit SHA"
              : failure === "dirty"
                ? "checkout"
                : "reachable from origin/main",
    );
    expect((await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim()).toBe(original);
    expect(installs).toEqual(["install", "exec"].includes(failure) ? [main, original] : []);
    expect(execs).toBe(failure === "exec" ? 1 : 0);
    if (failure === "dirty") expect(readFileSync(join(cwd, "tracked"), "utf8")).toBe("local changes\n");
    else if (!["install", "exec"].includes(failure))
      expect(commands.some((args) => args[1] === "checkout")).toBe(false);
    // Main must be observed through a fresh fetch, not a pre-existing tracking ref.
    if (!["malformed", "unavailable"].includes(failure))
      expect((await sh(["git", "rev-parse", "refs/remotes/origin/main"], { cwd })).stdout.trim()).toBe(main);
    if (failure === "unavailable") expect(commands).toEqual([]);
  },
  30_000,
);

test.each(["HEAD", "dependencies", "cancelled"])(
  "worker rollback after a partial installation handles %s restoration",
  async (failure) => {
    const cwd = join(home, "restore-checkout");
    const {
      value: { original, main },
    } = await updateFixture(cwd);
    const controller = new AbortController();
    const installs: string[] = [];
    let restoring = false;
    let caught: unknown;
    try {
      await updateWorker(main, {
        cwd,
        signal: controller.signal,
        exec() {
          throw new Error("Unexpected replacement");
        },
        async command(args, opts) {
          if (restoring) expect(opts.signal).toBeUndefined();
          if (restoring && failure === "HEAD" && args[1] === "checkout")
            throw new Error("restore checkout refused");
          if (args[1] === "install") {
            installs.push((await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim());
            if (installs.length === 1) {
              restoring = true;
              if (failure === "cancelled") controller.abort(new Error("cancelled installation"));
              throw new Error(
                `partial target installation failed${failure === "dependencies" ? "x".repeat(5000) : ""}`,
              );
            }
            if (failure === "dependencies") throw new Error("original dependency installation failed");
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          return sh(args, opts);
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkerUpdateError);
    expect(String(caught)).toContain("partial target installation failed");
    expect((caught as WorkerUpdateError).restored).toBe(failure === "cancelled");
    expect((caught as WorkerUpdateError).retryable).toBe(false);
    expect(installs).toEqual(failure === "HEAD" ? [main] : [main, original]);
    expect((await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim()).toBe(
      failure === "HEAD" ? main : original,
    );
    if (failure !== "cancelled") expect(String(caught)).toContain(`restoring original ${failure} failed`);
  },
  30_000,
);

test("current update warnings and ordered setup warnings survive and clear independently across rollback", async () => {
  const req = await request();
  const first = await failedWorkerSetup(req);
  const failed: GateRun = JSON.parse(workers.job(first.id)?.result ?? "null");
  const passing = { setupOk: true, setup: [], checks: [] };
  workers.fallbackSetup(first.id, "first setup");
  workers.complete(first.id, passing, true);
  const originalWarning = workers.worker("runner")?.setup_warning;
  expect(originalWarning).toContain("first setup");
  const beat = (warning?: string) => {
    const row = workers.worker("runner");
    if (!row) throw new Error("Missing worker");
    workers.heartbeat(row, { ...caps(), ...(warning ? { updateWarning: warning } : {}) });
  };
  const warning = "Worker update failed: frozen installation failed";
  workers = new WorkerStore(store, "a".repeat(40));
  beat(warning);
  expect(workers.list()[0]?.setupWarning).toBe(warning);
  expect(workers.worker("runner")?.setup_warning).toBe(originalWarning);
  // Coordinator rollback permits setup completions even while the update warning is active.
  workers = new WorkerStore(store, releaseSha);
  const success = workers.enqueue(req);
  expect(workers.lease("runner")?.id).toBe(success);
  expect(workers.complete(success, passing)).toBe(true);
  expect(workers.worker("runner")?.setup_warning).toBeNull();
  expect(workers.list()[0]?.setupWarning).toBe(warning);
  const later = workers.enqueue(req);
  expect(workers.lease("runner")?.id).toBe(later);
  workers.complete(later, failed);
  workers.fallbackSetup(later, "later setup");
  workers.complete(later, passing, true);
  expect(workers.worker("runner")?.setup_warning).toContain("later setup");
  expect(workers.list()[0]?.setupWarning).toBe(warning);
  // A clean worker restart omits the update warning; the independent setup warning remains.
  beat();
  expect(workers.list()[0]?.capabilities?.updateWarning).toBeUndefined();
  expect(workers.list()[0]?.setupWarning).toContain("later setup");
  const recovered = workers.enqueue(req);
  expect(workers.lease("runner")?.id).toBe(recovered);
  workers.complete(recovered, passing);
  expect(workers.list()[0]?.setupWarning).toBeUndefined();
});

const fetchFailure = (attempt = 1) =>
  new CommandError(
    `temporary fetch failure attempt ${attempt}`,
    128,
    "",
    "fatal: unable to access 'https://example.com/repo': Could not resolve host: example.com",
    false,
  );

test.each(["fetch", "lock", "fetch lock"])(
  "a transient %s failure retries after backoff and replaces the worker",
  async (failure) => {
    await listen();
    const target = "a".repeat(40),
      replaced = Promise.withResolvers<void>();
    let clock = 0,
      attempts = 0,
      beats = 0,
      leases = 0,
      head = releaseSha;
    const warnings: Capabilities[] = [];
    const worker = await loop({
      updateRetry: { initialMs: 100, maxMs: 200, deadlineMs: 1000, now: () => clock },
      async request(...args) {
        if (args[1] === "/worker/lease") leases++;
        const reply = await workerRequest(...args);
        if (args[1] !== "/worker/heartbeat") return reply;
        beats++;
        const body = args[2] as Capabilities;
        if (body.updateWarning) warnings.push(body);
        return { ...reply, json: () => ({ cancelled: [], releaseSha: target }) };
      },
      update: {
        async command(args) {
          if (args[1] === "fetch") {
            attempts++;
            if (attempts === 1 && failure === "fetch") throw fetchFailure();
            if (attempts === 1 && failure === "fetch lock")
              throw new CommandError(
                "fetch lock contention",
                1,
                "",
                "error: cannot lock ref 'refs/remotes/origin/main': Unable to create '/checkout/.git/refs/remotes/origin/main.lock': File exists.",
                false,
              );
          }
          if (args[1] === "checkout") {
            if (attempts === 1 && failure === "lock")
              throw new CommandError(
                "checkout lock contention",
                128,
                "",
                "fatal: Unable to create '/checkout/.git/index.lock': File exists.",
                false,
              );
            head = args[3] ?? "";
          }
          return { stdout: args.includes(`${target}^{commit}`) ? target : head, stderr: "", exitCode: 0 };
        },
        exec() {
          replaced.resolve();
        },
      },
    });
    try {
      await until(() => warnings.length >= 1);
      expect(attempts).toBe(1);
      clock = 99;
      const before = beats;
      await until(() => beats > before);
      expect(attempts).toBe(1);
      clock = 100;
      await replaced.promise;
      expect(attempts).toBe(2);
      expect(head).toBe(target);
      expect(leases).toBe(0);
      expect(warnings.every((c) => c.freeSlots === 0 && !!c.updateWarning)).toBe(true);
    } finally {
      await worker.stop();
    }
  },
);

test.each(["transient", "message only", "ancestry", "malformed"])(
  "%s update failures remain blocked with bounded attempts and a retained warning",
  async (failure) => {
    await listen();
    const target = failure === "malformed" ? "main" : "a".repeat(40);
    let clock = 0,
      attempts = 0,
      commands = 0,
      leases = 0,
      beats = 0;
    const warnings: string[] = [];
    const worker = await loop({
      updateRetry: { initialMs: 100, maxMs: 200, deadlineMs: 600, now: () => clock },
      async request(...args) {
        if (args[1] === "/worker/lease") leases++;
        const reply = await workerRequest(...args);
        if (args[1] !== "/worker/heartbeat") return reply;
        beats++;
        const body = args[2] as Capabilities;
        if (body.updateWarning) {
          warnings.push(body.updateWarning);
          expect(body.freeSlots).toBe(0);
        }
        return { ...reply, json: () => ({ cancelled: [], releaseSha: target }) };
      },
      update: {
        async command(args) {
          commands++;
          if (args[1] === "fetch") {
            attempts++;
            if (failure === "transient") throw fetchFailure(attempts);
            if (failure === "message only") throw new Error("Could not resolve host: arbitrary text");
          }
          if (args[1] === "merge-base") throw new CommandError("ancestry rejection", 1, "", "", false);
          return { stdout: target, stderr: "", exitCode: 0 };
        },
        exec() {
          throw new Error("Unexpected replacement");
        },
      },
    });
    try {
      await until(() => warnings.length >= 1);
      if (failure === "transient") {
        clock = 100;
        await until(() => attempts === 2);
        clock = 300;
        await until(() => attempts === 3);
      }
      clock = 600;
      const before = beats;
      await until(() => beats >= before + 3);
      expect(attempts).toBe(failure === "transient" ? 3 : failure === "malformed" ? 0 : 1);
      if (failure === "malformed") expect(commands).toBe(0);
      expect(leases).toBe(0);
      expect(warnings.length).toBeGreaterThan(2);
      if (failure === "transient") {
        expect(warnings[0]).toContain("attempt 1");
        expect(warnings.at(-1)).toContain("attempt 3");
      } else expect(warnings.at(-1)).toBe(warnings[0]);
    } finally {
      await worker.stop();
    }
  },
);

test.each([
  "new target",
  "match",
  "failed restoration",
  "failed restoration new target",
  "recovered restoration",
])("after an update failure a coordinator %s resets only safe update state", async (change) => {
  await listen();
  const first = "a".repeat(40),
    next = "b".repeat(40);
  let advertised = first,
    head = releaseSha,
    installs = 0,
    leases = 0,
    warningBeats = 0;
  let observed = "";
  const targets: string[] = [],
    warnings: Capabilities[] = [];
  const replaced = Promise.withResolvers<void>();
  const worker = await loop({
    async request(...args) {
      if (args[1] === "/worker/lease") leases++;
      const reply = await workerRequest(...args);
      if (args[1] !== "/worker/heartbeat") return reply;
      const body = args[2] as Capabilities;
      if (body.updateWarning) {
        warningBeats++;
        warnings.push(body);
      }
      observed = advertised;
      return { ...reply, json: () => ({ cancelled: [], releaseSha: observed }) };
    },
    update: {
      async command(args) {
        if (args[1] === "fetch") targets.push(advertised);
        if (args[1] === "checkout") head = args[3] ?? "";
        if (args[1] === "install") {
          installs++;
          if (installs === 1 || (change === "recovered restoration" && installs === 3))
            throw new Error("target install failed");
          if (
            (change.startsWith("failed restoration") || change === "recovered restoration") &&
            installs === 2
          )
            throw new Error("dependency restore failed");
        }
        return {
          stdout: args[1] === "rev-parse" && args[2] === "--verify" ? advertised : head,
          stderr: "",
          exitCode: 0,
        };
      },
      exec() {
        replaced.resolve();
      },
    },
  });
  try {
    await until(() => warningBeats >= 2);
    expect(targets).toEqual([first]);
    expect(head).toBe(releaseSha);
    expect(installs).toBe(2);
    expect(leases).toBe(0);
    const before = warningBeats;
    advertised = change.endsWith("new target") || change === "recovered restoration" ? next : releaseSha;
    await until(() => observed === advertised);
    if (change.endsWith("new target")) {
      await replaced.promise;
      expect(targets).toEqual([first, next]);
      expect(head).toBe(next);
      expect(leases).toBe(0);
    } else if (change === "match" || change === "recovered restoration") {
      if (change === "recovered restoration") {
        await until(() => installs === 4);
        advertised = releaseSha;
      }
      await until(() => leases > 0 && workers.list()[0]?.setupWarning === undefined);
      expect(targets).toEqual(change === "recovered restoration" ? [first, next] : [first]);
      expect(workers.list()[0]?.capabilities?.freeSlots).toBeGreaterThan(0);
    } else {
      await until(() => warningBeats >= before + 3);
      expect(leases).toBe(0);
      expect(targets).toEqual([first]);
      expect(warnings.at(-1)?.freeSlots).toBe(0);
      expect(warnings.at(-1)?.updateWarning).toContain("restoring original dependencies failed");
    }
  } finally {
    await worker.stop();
  }
});

test("a target change during installation restores before attempting the latest release", async () => {
  await listen();
  const first = "a".repeat(40),
    next = "b".repeat(40);
  let advertised = first,
    observed = "",
    head = releaseSha,
    leases = 0;
  const installing = Promise.withResolvers<void>(),
    finishInstall = Promise.withResolvers<void>(),
    replaced = Promise.withResolvers<void>();
  const installs: string[] = [],
    targets: string[] = [],
    warnings: string[] = [];
  const worker = await loop({
    async request(...args) {
      if (args[1] === "/worker/lease") leases++;
      const reply = await workerRequest(...args);
      if (args[1] !== "/worker/heartbeat") return reply;
      const body = args[2] as Capabilities;
      if (body.updateWarning) warnings.push(body.updateWarning);
      const target = advertised;
      observed = target;
      return { ...reply, json: () => ({ cancelled: [], releaseSha: target }) };
    },
    update: {
      async command(args) {
        if (args[1] === "fetch") targets.push(advertised);
        if (args[1] === "checkout") head = args[3] ?? "";
        if (args[1] === "install") {
          installs.push(head);
          if (head === first) {
            installing.resolve();
            await finishInstall.promise;
          }
        }
        return {
          stdout: args[1] === "rev-parse" && args[2] === "--verify" ? advertised : head,
          stderr: "",
          exitCode: 0,
        };
      },
      exec() {
        replaced.resolve();
      },
    },
  });
  try {
    await installing.promise;
    advertised = next;
    await until(() => observed === next);
    expect(targets).toEqual([first]);
    expect(leases).toBe(0);
    finishInstall.resolve();
    await replaced.promise;
    expect(targets).toEqual([first, next]);
    expect(installs).toEqual([first, releaseSha, next]);
    expect(head).toBe(next);
    expect(warnings).toEqual([]);
  } finally {
    finishInstall.resolve();
    await worker.stop();
  }
});

test("a macOS worker negotiates heartbeats with the coordinator before confinement metadata", async () => {
  const server = await listen();
  const legacy = PreviousHeartbeat;
  const accepted = Promise.withResolvers<void>();
  let rejected = 0;
  const worker = await loop({
    async request(...args) {
      if (args[1] === "/worker/heartbeat" && !legacy.safeParse(args[2]).success) {
        rejected++;
        return {
          status: 400,
          data: Buffer.from("{}"),
          fingerprint: server.tls.fingerprint,
          json: () => ({ error: "Invalid heartbeat" }),
        };
      }
      const reply = await workerRequest(...args);
      if (args[1] === "/worker/heartbeat") accepted.resolve();
      return reply;
    },
  });
  try {
    await Promise.race([
      accepted.promise,
      worker.task.then(() => {
        throw new Error("Worker stopped before an accepted heartbeat");
      }),
    ]);
    expect(rejected).toBeLessThanOrEqual(1);
    expect(workers.worker("loop-runner")?.last_heartbeat_at).toBeNumber();
  } finally {
    worker.controller.abort();
    await worker.task.catch(() => {});
  }
});

test.each(["initial", "rollback"])("the worker survives a strict legacy coordinator on %s", async (kind) => {
  await listen();
  // A coordinator from before optional worker metadata.
  const legacy = PreviousHeartbeat.omit({
    updateWarning: true,
    agents: true,
    privateStringsDigest: true,
  }).strict();
  const target = "a".repeat(40);
  let oldProtocol = kind === "initial",
    accepted = 0,
    rejected = 0,
    attempts = 0,
    leases = 0;
  const worker = await loop({
    async request(...args) {
      if (args[1] === "/worker/lease") leases++;
      if (args[1] !== "/worker/heartbeat") return workerRequest(...args);
      const body = args[2] as Capabilities;
      const reply = await workerRequest(...args);
      if (body.updateWarning) oldProtocol = true;
      if (oldProtocol) {
        if (!legacy.safeParse(body).success) {
          rejected++;
          return { ...reply, status: 400, json: () => ({ error: "Invalid heartbeat" }) };
        }
        expect(body.agents).toBeUndefined();
        expect(body.privateStringsDigest).toBeUndefined();
        expect(body.updateWarning).toBeUndefined();
        accepted++;
        return {
          ...reply,
          json: () => ({ cancelled: [], releaseSha: kind === "initial" ? releaseSha : target }),
        };
      }
      expect(body.updateWarning).toBeUndefined();
      return { ...reply, json: () => ({ cancelled: [], releaseSha: target }) };
    },
    update: {
      async command() {
        attempts++;
        throw new Error("update failed before checkout");
      },
      exec() {
        throw new Error("Unexpected replacement");
      },
    },
  });
  try {
    await until(() => accepted >= 4);
    expect(worker.controller.signal.aborted).toBe(false);
    expect(rejected).toBe(1);
    expect(attempts).toBe(kind === "rollback" ? 1 : 0);
    if (kind === "initial") expect(leases).toBeGreaterThan(0);
    if (kind === "rollback") {
      expect(leases).toBe(0);
      expect(workers.list()[0]?.capabilities?.freeSlots).toBe(0);
    }
  } finally {
    await worker.stop();
  }
});

test("the target deadline cancels an active update while heartbeats continue", async () => {
  await listen();
  const target = "a".repeat(40),
    active = Promise.withResolvers<void>();
  let attempts = 0,
    beats = 0,
    leases = 0,
    warned = false;
  const worker = await loop({
    updateRetry: { deadlineMs: 100 },
    async request(...args) {
      if (args[1] === "/worker/lease") leases++;
      const reply = await workerRequest(...args);
      if (args[1] !== "/worker/heartbeat") return reply;
      beats++;
      const body = args[2] as Capabilities;
      if (body.updateWarning) {
        warned = true;
        expect(body.freeSlots).toBe(0);
      }
      return { ...reply, json: () => ({ cancelled: [], releaseSha: target }) };
    },
    update: {
      async command(_args, options) {
        attempts++;
        active.resolve();
        const signal = options.signal;
        if (!signal) throw new Error("Missing bounded update signal");
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        signal.throwIfAborted();
        throw new Error("Update outlived its deadline");
      },
      exec() {
        throw new Error("Unexpected replacement");
      },
    },
  });
  try {
    await active.promise;
    await until(() => warned);
    const before = beats;
    await until(() => beats >= before + 2);
    expect(attempts).toBe(1);
    expect(leases).toBe(0);
  } finally {
    await worker.stop();
  }
});

const agentRequest = (overrides: Partial<AgentJobRequest> = {}): AgentJobRequest => ({
  runId: "test-agent-run",
  invocationId: 1,
  parentSha: releaseSha,
  prompt: "Edit code",
  timeoutMs: 1000,
  target: {
    modelId: "fake",
    provider: "fake",
    harness: "claude",
    model: "fake",
    vendor: "fake",
    tier: 1,
    billing: "free",
  },
  ...overrides,
});

test.each(["backend", "openai", "decisions"] as const)(
  "agent targets with %s stay local regardless of contents",
  (field) => {
    for (const value of [
      { baseUrl: "http://localhost:8080", authToken: "" },
      { baseUrl: "http://localhost:8080" },
      undefined,
    ]) {
      const req = agentRequest();
      Object.assign(req.target, { [field]: value });
      expect(workers.enqueueAgentJob(req)).toBeNull();
      expect(store.db.query("SELECT * FROM agent_jobs").all()).toEqual([]);
    }
  },
);

test.each(["claude", "codex"] as const)("plain %s CLI agent targets still enqueue", (harness) => {
  const req = agentRequest();
  req.target.harness = harness;
  const id = workers.enqueueAgentJob(req);
  expect(id).not.toBeNull();
  expect(workers.agentJob(id ?? "")?.request).toBe(JSON.stringify(req));
});

test("agent enqueue preserves the durable coordinator job id", () => {
  const req = agentRequest();
  const id = "durable-agent-job";
  expect(workers.enqueueAgentJob(req, id)).toBe(id);
  expect(workers.agentJob(id)).toMatchObject({ id, state: "queued", request: JSON.stringify(req) });
  req.target.backend = { baseUrl: "http://localhost:8080", authToken: "" };
  expect(workers.enqueueAgentJob(req, "refused-agent-job")).toBeNull();
  expect(workers.agentJob("refused-agent-job")).toBeNull();
});

function enqueueAgent(overrides: Partial<AgentJobRequest> = {}) {
  const id = workers.enqueueAgentJob(agentRequest(overrides));
  if (!id) throw new Error("Agent request refused");
  return id;
}
const agentResult = (parentSha = releaseSha) => ({
  status: "ok",
  finalText: "Completed",
  structured: null,
  sessionId: null,
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  numTurns: 1,
  costUsd: 0,
  costEquivUsd: 0,
  error: null,
  quota: null,
  parentSha,
  sha: parentSha,
  branch: "change/example",
});
const agentPath = (id: string, action: string) => `/worker/agent-jobs/${id}/${action}`;
const batches = (id: string) => workers.listAgentJobEvents(id);

// Streaming requests exercise the byte limit and authorization across body-reading awaits.
function streamingReport(path: string, token: string, contentLength?: number, expectedPin?: string) {
  if (!listener) throw new Error("Missing listener");
  const pin = expectedPin ?? listener.tls.fingerprint;
  const response = Promise.withResolvers<number>();
  const req = httpsRequest(
    new URL(path, listener.url),
    {
      method: "POST",
      agent: false,
      ca: listener.tls.cert,
      checkServerIdentity: (_host, cert) =>
        fingerprint(cert.raw) === pin ? undefined : new Error("Coordinator certificate fingerprint changed"),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(contentLength === undefined
          ? { "transfer-encoding": "chunked" }
          : { "content-length": contentLength }),
      },
    },
    (res) => {
      res.resume();
      res.on("end", () => response.resolve(res.statusCode ?? 0));
      res.on("error", response.reject);
    },
  );
  req.on("error", response.reject);
  return { req, response: response.promise };
}

test("streaming reports reject an incorrect listener fingerprint", async () => {
  await listen();
  const token = await paired();
  const { req, response } = streamingReport("/worker/heartbeat", token, undefined, "0".repeat(64));
  req.end(JSON.stringify(caps()));
  await expect(response).rejects.toThrow("Coordinator certificate fingerprint changed");
  expect(workers.list()[0]?.capabilities).toBeNull();
});

test("gate-first leases preserve both payload fields, agent inputs and cancellation", async () => {
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  const gate = workers.enqueue(await request());
  const fields: Partial<AgentJobRequest> = {
    role: "implement",
    mode: "edit",
    systemAppend: "System instructions",
    jsonSchema: { type: "object" },
    idleTimeoutMs: 5000,
    maxToolCalls: 10,
    fast: true,
    privateSession: true,
    confineReads: true,
    slottedCommands: [["bun", "test"]],
    agentFullSuite: "refuse",
    branch: "change/agent",
    baseSha: releaseSha,
    commit: publicationCommit,
    allow: ["workflows"],
    privateStringsDigest: privateStringsDigest([]),
    repoUrl: "https://github.com/example/repository.git",
    expectedRemoteSha: null,
    discreet: true,
    uiUrl: "https://coordinator.example.com",
  };
  const agent = enqueueAgent(fields);
  const stored = workers.agentJob(agent);
  store.db
    .query("UPDATE agent_jobs SET request=? WHERE id=?")
    .run(
      JSON.stringify({ ...JSON.parse(stored?.request ?? "{}"), cwd: home, scratchDir: home, logPath: home }),
      agent,
    );
  expect((await call("/worker/lease", {}, token)).json()).toMatchObject({
    job: { id: gate },
    agentJob: null,
  });
  expect(workers.agentJob(agent)?.state).toBe("queued");
  const reply = (await call("/worker/lease", {}, token)).json() as {
    job: null;
    agentJob: { id: string; remainingMs: number; request: unknown };
  };
  expect(reply.job).toBeNull();
  expect(reply.agentJob.id).toBe(agent);
  expect(reply.agentJob.remainingMs).toBeGreaterThanOrEqual(0);
  expect(reply.agentJob.request).toEqual(agentRequest(fields));
  expect(JSON.stringify(reply)).not.toContain(home);
  expect((await call("/worker/lease", { jobs: [agent] }, token)).json()).toEqual({
    job: null,
    agentJob: null,
  });
  workers.cancelAgentJob(agent);
  expect((await call("/worker/lease", { jobs: [agent] }, token)).json()).toEqual({
    job: null,
    agentJob: null,
    cancelled: [agent],
  });
  const queued = enqueueAgent();
  await call("/worker/heartbeat", { ...caps(), releaseSha: "different" }, token);
  expect((await call("/worker/lease", {}, token)).json()).toEqual({ job: null, agentJob: null });
  expect(workers.agentJob(queued)?.state).toBe("queued");
});

test("all agent routes authenticate holders and reject a token revoked during a job", async () => {
  await listen();
  const owner = await paired(),
    other = await paired("other");
  await call("/worker/heartbeat", caps(), owner);
  const id = enqueueAgent();
  workers.leaseAgentJob("runner");
  for (const action of ["bundle", "events", "result", "failure"]) {
    const body = action === "bundle" ? undefined : {};
    expect((await call(agentPath(id, action), body)).status).toBe(401);
    expect((await call(agentPath(id, action), body, "0".repeat(64))).status).toBe(401);
    expect((await call(agentPath(id, action), body, other)).status).toBe(409);
  }
  workers.revoke("runner");
  for (const action of ["bundle", "events", "result", "failure"])
    expect((await call(agentPath(id, action), action === "bundle" ? undefined : {}, owner)).status).toBe(401);
  expect(batches(id)).toEqual([]);
});

test.each(["events", "result", "failure"])(
  "agent %s enforces byte limits with and without Content-Length",
  async (action) => {
    await listen();
    const token = await paired();
    await call("/worker/heartbeat", caps(), token);
    const id = enqueueAgent();
    workers.leaseAgentJob("runner");
    const payload = JSON.stringify({ reason: "é".repeat((action === "events" ? 512 : 1024) * 1024) });
    for (const length of [undefined, Buffer.byteLength(payload)]) {
      const { req, response } = streamingReport(agentPath(id, action), token, length);
      req.end(payload);
      expect(await response).toBe(413);
    }
    expect(batches(id)).toEqual([]);
    expect(workers.agentJob(id)?.state).toBe("leased");
  },
);

test.each(["events", "result", "failure"])(
  "agent %s rechecks ownership and revocation after reading a body",
  async (action) => {
    let now = 1_000_000;
    workers = new WorkerStore(store, releaseSha, {}, () => now);
    await listen();
    const token = await paired(),
      retryToken = await paired("retry");
    await call("/worker/heartbeat", caps(), token);
    for (const change of ["cancelled", "reassigned", "revoked"]) {
      await call("/worker/heartbeat", caps(), token);
      const id = enqueueAgent();
      expect(workers.leaseAgentJob("runner")?.id).toBe(id);
      const started = Promise.withResolvers<void>(),
        original = workers.holdsAgentJob.bind(workers);
      const spy = spyOn(workers, "holdsAgentJob").mockImplementation((...args) => {
        const job = original(...args);
        started.resolve();
        return job;
      });
      const payload = JSON.stringify(
        action === "events"
          ? { seq: 0, events: [] }
          : action === "result"
            ? agentResult()
            : { reason: "failed" },
      );
      const { req, response } = streamingReport(agentPath(id, action), token);
      try {
        req.write(payload.slice(0, 1));
        await started.promise;
        if (change === "revoked") workers.revoke("runner");
        else if (change === "reassigned") {
          now += workers.times.lease;
          await call("/worker/heartbeat", caps(), retryToken);
          expect(workers.leaseAgentJob("retry")?.id).toBe(id);
        } else workers.cancelAgentJob(id);
        req.end(payload.slice(1));
        expect(await response).toBe(change === "revoked" ? 401 : 409);
        expect(workers.agentJob(id)?.state).not.toBe("done");
        expect(batches(id)).toEqual([]);
        if (change === "reassigned" && action === "events") {
          expect((await call(agentPath(id, action), JSON.parse(payload), token)).status).toBe(409);
          expect((await call(agentPath(id, action), JSON.parse(payload), retryToken)).status).toBe(200);
          expect(batches(id)).toMatchObject([{ attempt: 2, seq: 0, events: "[]" }]);
        }
      } finally {
        req.destroy();
        spy.mockRestore();
      }
    }
  },
);

test.each(["events", "result"])("agent %s requires valid UTF-8 across body chunks", async (action) => {
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  const id = enqueueAgent();
  workers.leaseAgentJob("runner");
  await call(agentPath(id, "events"), { seq: 0, events: [{ type: "text", text: "earlier" }] }, token);
  const saved = batches(id),
    leased = workers.agentJob(id);
  const body = (text: string) =>
    JSON.stringify(
      action === "events"
        ? { seq: 1, events: [{ type: "text", text }] }
        : { ...agentResult(), finalText: text },
    );
  const [prefix, suffix] = body("REPLACE").split("REPLACE");
  const malformed = Buffer.concat([
    Buffer.from(prefix ?? ""),
    Buffer.from([0xff]),
    Buffer.from(suffix ?? ""),
  ]);
  const invalid = streamingReport(agentPath(id, action), token, malformed.byteLength);
  invalid.req.end(malformed);
  expect(await invalid.response).toBe(400);
  expect(batches(id)).toEqual(saved);
  expect(workers.agentJob(id)).toEqual(leased);

  const text = "before 🌍 after",
    payload = Buffer.from(body(text)),
    split = payload.indexOf(Buffer.from("🌍")) + 1,
    started = Promise.withResolvers<void>(),
    original = workers.holdsAgentJob.bind(workers);
  const spy = spyOn(workers, "holdsAgentJob").mockImplementation((...args) => {
    started.resolve();
    return original(...args);
  });
  const valid = streamingReport(agentPath(id, action), token);
  try {
    valid.req.write(payload.subarray(0, split));
    await started.promise;
    valid.req.end(payload.subarray(split));
    expect(await valid.response).toBe(200);
    if (action === "events") {
      expect(JSON.parse(batches(id)[1]?.events ?? "null")).toEqual([{ type: "text", text }]);
      expect(workers.agentJob(id)).toEqual(leased);
    } else {
      expect(JSON.parse(workers.agentJob(id)?.result ?? "null").finalText).toBe(text);
      expect(workers.agentJob(id)).toMatchObject({ state: "done", result_sha: agentResult().sha });
      expect(batches(id)).toEqual(saved);
    }
  } finally {
    valid.req.destroy();
    spy.mockRestore();
  }
});

test("agent event batches validate every variant, redact nested data, deduplicate and survive reopening", async () => {
  let now = 1_000_000;
  workers = new WorkerStore(store, releaseSha, {}, () => now);
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  const id = enqueueAgent();
  workers.leaseAgentJob("runner");
  const secret = randomBytes(24).toString("hex");
  registerCredential("AGENT_EVENT_TEST", secret);
  const events = [
    { type: "init", sessionId: "session", model: "fake" },
    ...["text", "thinking", "stderr", "status"].map((type) => ({ type, text: secret })),
    { type: "tool_call", id: "t", name: "tool", input: { nested: [{ [secret]: secret }] } },
    { type: "tool_result", id: "t", output: secret, isError: false },
    {
      type: "rate_limit",
      status: "allowed",
      windows: { short: { utilization: 0.5, resetsAt: null } },
      resetsAt: null,
    },
    { type: "warning", id: "warning", text: secret },
  ];
  for (const body of [
    { seq: -1, events },
    { seq: 1.5, events },
    { seq: Number.MAX_SAFE_INTEGER + 1, events },
    { seq: 0, events, extra: true },
    ...events.map((event) => ({ seq: 0, events: [{ ...event, extra: true }] })),
    {
      seq: 0,
      events: [
        {
          type: "rate_limit",
          status: "allowed",
          resetsAt: null,
          windows: { short: { utilization: 0, resetsAt: null, extra: true } },
        },
      ],
    },
    { seq: 0, events: [{ type: "tool_call", id: "t", name: "tool" }] },
    { seq: 0, events: [{ type: "unknown" }] },
  ])
    expect((await call(agentPath(id, "events"), body, token)).status).toBe(400);
  expect(batches(id)).toEqual([]);
  expect((await call(agentPath(id, "events"), { seq: 7, events }, token)).json()).toEqual({ ok: true });
  const saved = batches(id);
  expect(saved).toHaveLength(1);
  expect(saved[0]?.events).not.toContain(secret);
  expect(JSON.parse(saved[0]?.events ?? "[]").map((e: { type: string }) => e.type)).toEqual(
    events.map((e) => e.type),
  );
  now++;
  expect((await call(agentPath(id, "events"), { seq: 7, events: [] }, token)).status).toBe(200);
  expect(batches(id)).toEqual(saved);
  const retryToken = await paired("retry");
  await call("/worker/heartbeat", caps(), retryToken);
  workers.failAgentJob(id, "Disconnected");
  expect(workers.leaseAgentJob("retry")?.id).toBe(id);
  expect((await call(agentPath(id, "events"), { seq: 7, events: [] }, retryToken)).status).toBe(200);
  const retried = batches(id);
  expect(retried).toEqual([...saved, { attempt: 2, seq: 7, events: "[]", created_at: now }]);
  now++;
  expect((await call(agentPath(id, "events"), { seq: 7, events }, retryToken)).status).toBe(200);
  expect(batches(id)).toEqual(retried);
  store.close();
  store = new Store(cfg.paths.db);
  workers = new WorkerStore(store, releaseSha);
  expect(batches(id)).toEqual(retried);
});

test("agent reports validate result metadata and persist changed and unchanged completions without fetching", async () => {
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  for (const unchanged of [false, true]) {
    const id = enqueueAgent(
      unchanged
        ? {}
        : {
            commit: publicationCommit,
            branch: "change/example",
            privateStringsDigest: privateStringsDigest([]),
          },
    );
    workers.leaseAgentJob("runner");
    const result = {
      ...agentResult(),
      ...(unchanged ? {} : { privateStringsDigest: privateStringsDigest([]) }),
    };
    for (const bad of [
      { parentSha: "b".repeat(40) },
      ...["short", "g".repeat(40), "a".repeat(41), "a".repeat(63)].map((sha) => ({ sha })),
      ...["-branch", "a..b", "a.lock", "a/", "@{-1}", "a b", "HEAD"].map((branch) => ({ branch })),
      { extra: true },
      { status: "running" },
      { status: "unknown" },
      { usage: { ...result.usage, extra: 1 } },
      { quota: { windows: { short: { utilization: "bad", resetsAt: null } }, exhaustedUntil: null } },
      { decline: { reason: "unsure", lastResort: false, extra: 1 } },
      { confinement: { ok: false, path: null, version: null, reason: "unknown", exitCode: null } },
    ]) {
      expect((await call(agentPath(id, "result"), { ...result, ...bad }, token)).status).toBe(400);
      expect(workers.agentJob(id)).toMatchObject({ state: "leased", result: null, result_sha: null });
    }
    if (unchanged) {
      expect((await call(agentPath(id, "result"), { ...result, sha: "a".repeat(40) }, token)).status).toBe(
        400,
      );
      expect(workers.agentJob(id)).toMatchObject({ state: "leased", result: null, result_sha: null });
    }
    const report = {
      ...result,
      sha: unchanged ? releaseSha : "a".repeat(64),
      structured: { arbitrary: [1, null] },
      modelCooldownMs: 100,
      quota: { windows: { short: { utilization: 0.3, resetsAt: null } }, exhaustedUntil: null },
      decline: { reason: "unsure", lastResort: true },
      confinement: { ok: true, path: null, version: null, reason: null, exitCode: 0 },
    };
    expect((await call(agentPath(id, "result"), report, token)).json()).toEqual({ ok: true });
    expect(workers.agentJob(id)).toMatchObject({ state: "done", result_sha: report.sha });
    expect(JSON.parse(workers.agentJob(id)?.result ?? "null")).toEqual(report);
  }
});

test("agent failure validates the supplied reason and preserves sanitized retry and exclusion transitions", async () => {
  await listen();
  const first = await paired(),
    second = await paired("second");
  await call("/worker/heartbeat", caps(), first);
  await call("/worker/heartbeat", caps(), second);
  const id = enqueueAgent(),
    secret = randomBytes(24).toString("hex");
  registerCredential("AGENT_FAILURE_TEST", secret);
  workers.leaseAgentJob("runner");
  for (const body of [{}, { reason: 3 }, { reason: "bad", extra: true }])
    expect((await call(agentPath(id, "failure"), body, first)).status).toBe(400);
  for (const [worker, token] of [
    ["runner", first],
    ["second", second],
  ]) {
    if (!token || !worker) throw new Error("Missing worker");
    if (worker === "second") workers.leaseAgentJob(worker);
    const reason = worker === "runner" ? "Agent execution interrupted" : `Failed: ${secret}`;
    expect((await call(agentPath(id, "failure"), { reason }, token)).status).toBe(200);
    expect(workers.agentJob(id)?.failure_reason).toBe(
      worker === "runner" ? reason : "[withheld: private text]",
    );
  }
  expect(workers.agentJob(id)).toMatchObject({
    state: "failed",
    attempt: 2,
    excluded: '["runner","second"]',
  });
});

test("publishing result requires the assigned branch and matching private-list echo", async () => {
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  const digest = privateStringsDigest([]);
  for (const requestDigest of [digest, undefined]) {
    const id = enqueueAgent({
      commit: publicationCommit,
      branch: "change/example",
      privateStringsDigest: requestDigest,
    });
    expect(workers.leaseAgentJob("runner")?.id).toBe(id);
    for (const invalid of [
      {},
      { privateStringsDigest: "0".repeat(64) },
      { privateStringsDigest: digest, branch: "change/other" },
      ...(requestDigest ? [] : [{ privateStringsDigest: digest }]),
    ]) {
      expect((await call(agentPath(id, "result"), { ...agentResult(), ...invalid }, token)).status).toBe(400);
      expect(workers.agentJob(id)?.state).toBe("leased");
    }
    if (requestDigest) {
      expect(
        (await call(agentPath(id, "result"), { ...agentResult(), privateStringsDigest: digest }, token))
          .status,
      ).toBe(200);
      expect(workers.agentJob(id)?.state).toBe("done");
    } else workers.cancelAgentJob(id);
  }
  const legacy = enqueueAgent();
  workers.leaseAgentJob("runner");
  expect((await call(agentPath(legacy, "result"), agentResult(), token)).status).toBe(200);
  expect(workers.agentJob(legacy)?.state).toBe("done");
});

test.each(["start", "stop"])(
  "Factory %s cancels only open agent jobs and heartbeats report cancellation",
  async (action) => {
    await listen();
    const token = await paired();
    await call("/worker/heartbeat", caps(), token);
    const done = enqueueAgent();
    workers.leaseAgentJob("runner");
    workers.completeAgentJob(done, {}, releaseSha);
    const failed = enqueueAgent();
    workers.failAgentJob(failed, "failed");
    workers.failAgentJob(failed, "failed");
    const leased = enqueueAgent();
    workers.leaseAgentJob("runner");
    const queued = enqueueAgent();
    const factory = new Factory(cfg, { store, bootSha: releaseSha, models: [], providers: [] });
    expect(workers.agentJob(leased)?.state).toBe("leased");
    expect(workers.agentJob(queued)?.state).toBe("queued");
    try {
      if (action === "start") factory.start();
      else await factory.stop();
      expect(workers.agentJob(done)?.state).toBe("done");
      expect(workers.agentJob(failed)?.state).toBe("failed");
      expect(workers.agentJob(leased)?.state).toBe("cancelled");
      expect(workers.agentJob(queued)?.state).toBe("cancelled");
      expect((await call("/worker/heartbeat", caps([leased]), token)).json()).toMatchObject({
        cancelled: [leased],
      });
    } finally {
      await factory.stop();
    }
  },
);

test("agent event volume stores 2,000 ordered events in 10 durable batches", async () => {
  for (let i = 0; i < 600; i++) registerCredential(`AGENT_VOLUME_${i}`, randomBytes(24).toString("hex"));
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  const id = enqueueAgent();
  workers.leaseAgentJob("runner");
  const start = performance.now();
  for (let seq = 0; seq < 10; seq++) {
    const events = Array.from({ length: 200 }, (_, i) => ({
      type: "text",
      text: `${seq * 200 + i}: ${"event output ".repeat(80)}`,
    }));
    expect((await call(agentPath(id, "events"), { seq, events }, token)).status).toBe(200);
  }
  console.log(
    `Agent events: 2,000 events / 10 batches stored in ${(performance.now() - start).toFixed(1)} ms`,
  );
  const rows = batches(id);
  expect(rows).toHaveLength(10);
  const events = rows.flatMap((row) => JSON.parse(row.events) as { text: string }[]);
  expect(events).toHaveLength(2000);
  expect(events.map((e) => Number(e.text.split(":")[0]))).toEqual(Array.from({ length: 2000 }, (_, i) => i));
});

test.each([false, true])(
  "agent bundles include the exact parent and optional base (base=%s), with cleanup",
  async (withBase) => {
    const gate = await request();
    await sh(["git", "commit", "--allow-empty", "-qm", "second"], { cwd: gate.cwd });
    const parent = (await sh(["git", "rev-parse", "HEAD"], { cwd: gate.cwd })).stdout.trim();
    const cache = join(cfg.paths.repos, "test__repo.git");
    await sh(["git", "clone", "--bare", gate.cwd, cache], { cwd: home });
    await listen();
    const token = await paired();
    await call("/worker/heartbeat", caps(), token);
    const id = enqueueAgent({
      runId: gate.runId,
      parentSha: parent,
      ...(withBase ? { baseSha: gate.baseSha } : {}),
    });
    workers.leaseAgentJob("runner");
    const command = await import("../src/git/command.ts"),
      original = command.worktreeGit;
    const dirs: string[] = [];
    const spy = spyOn(command, "worktreeGit").mockImplementation((args, options) => {
      if (args[1] === "bundle" && args[2] === "create") dirs.push(dirname(args[3] ?? ""));
      return original(args, options);
    });
    try {
      const response = await call(agentPath(id, "bundle"), undefined, token);
      expect(response.status).toBe(200);
      const bundle = join(home, "agent.bundle");
      writeFileSync(bundle, response.data);
      const heads = (await sh(["git", "bundle", "list-heads", bundle], { cwd: home })).stdout;
      expect(heads).toContain(`${parent} refs/limitless-bundles/${id}/0`);
      if (withBase) expect(heads).toContain(`${gate.baseSha} refs/limitless-bundles/${id}/1`);
      else expect(heads.trim().split("\n")).toHaveLength(1);
      const imported = join(home, "imported.git");
      await sh(["git", "init", "--bare", "--template=", imported], { cwd: home });
      await sh(["git", "bundle", "verify", bundle], { cwd: imported });
      await sh(["git", "fetch", bundle, "+refs/*:refs/*"], { cwd: imported });
      for (const sha of [parent, ...(withBase ? [gate.baseSha] : [])])
        expect((await sh(["git", "cat-file", "-t", sha], { cwd: imported })).stdout.trim()).toBe("commit");
      // A missing commit fails after creating the first temporary ref, which must still be removed.
      const invalid = enqueueAgent({ runId: gate.runId, parentSha: parent, baseSha: "0".repeat(40) });
      workers.leaseAgentJob("runner");
      expect((await call(agentPath(invalid, "bundle"), undefined, token)).status).toBe(400);
      expect(
        (
          await worktreeGit(["git", "for-each-ref", "--format=%(refname)", "refs/limitless-bundles/"], {
            cwd: cache,
          })
        ).stdout,
      ).toBe("");
      expect(dirs.length).toBeGreaterThan(0);
      expect(dirs.every((dir) => !existsSync(dir))).toBe(true);
      workers.cancelAgentJob(id);
      workers.cancelAgentJob(invalid);
      const missing = enqueueAgent();
      workers.leaseAgentJob("runner");
      expect((await call(agentPath(missing, "bundle"), undefined, token)).status).toBe(400);
    } finally {
      spy.mockRestore();
    }
  },
);

test.each(["revoked", "cancelled"])(
  "agent bundle rechecks a %s holder after asynchronous creation",
  async (kind) => {
    const gate = await request(true),
      cache = join(cfg.paths.repos, "test__repo.git");
    await listen();
    const token = await paired();
    await call("/worker/heartbeat", caps(), token);
    const id = enqueueAgent({ runId: gate.runId, parentSha: gate.headSha });
    workers.leaseAgentJob("runner");
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const lock = withRepoLock(cache, async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const entered = Promise.withResolvers<void>(),
      original = workers.holdsAgentJob.bind(workers);
    const spy = spyOn(workers, "holdsAgentJob").mockImplementation((...args) => {
      const job = original(...args);
      entered.resolve();
      return job;
    });
    try {
      const response = call(agentPath(id, "bundle"), undefined, token);
      await entered.promise;
      if (kind === "revoked") workers.revoke("runner");
      else workers.cancelAgentJob(id);
      release.resolve();
      expect((await response).status).toBe(kind === "revoked" ? 401 : 409);
      expect(
        (
          await worktreeGit(["git", "for-each-ref", "--format=%(refname)", "refs/limitless-bundles/"], {
            cwd: cache,
          })
        ).stdout,
      ).toBe("");
    } finally {
      release.resolve();
      await lock;
      spy.mockRestore();
    }
  },
);

async function queuedLocalAgent(overrides: Partial<AgentJobRequest> = {}) {
  const req = await request(true);
  return enqueueAgent({
    runId: req.runId,
    parentSha: req.headSha,
    branch: "change/worker-agent",
    target: { ...agentRequest().target, harness: "claude" },
    ...overrides,
  });
}

test.each([
  { configured: true, rejected: false, overlapping: false },
  { configured: true, rejected: true, overlapping: false },
  { configured: false, rejected: false, overlapping: false },
  { configured: false, rejected: false, overlapping: true },
])(
  "worker Claude uses only local subscription authentication: %j",
  async ({ configured, rejected, overlapping }) => {
    await listen();
    const id = await queuedLocalAgent({
      target: { ...agentRequest().target, billing: "subscription" },
    });
    const coordinatorToken = `coordinator-${crypto.randomUUID()}`;
    const localToken = `worker-${crypto.randomUUID()}`;
    cfg.secrets.CLAUDE_CODE_OAUTH_TOKEN = coordinatorToken;
    const configDir = join(home, "worker-config");
    mkdirSync(configDir);
    writeFileSync(
      join(configDir, "secrets.env"),
      configured ? `CLAUDE_CODE_OAUTH_TOKEN=${localToken}\n` : "",
    );
    const syntheticHome = join(home, "synthetic-home");
    const keychain = join(syntheticHome, "Library/Keychains");
    const canonical = join(home, "keychain-store");
    mkdirSync(dirname(keychain), { recursive: true });
    mkdirSync(canonical);
    symlinkSync(canonical, keychain);
    const keychains = [keychain, realpathSync(keychain)];
    const original = scratchPolicy.writeRoots;
    const rootsSpy = spyOn(scratchPolicy, "writeRoots").mockImplementation((...args) => {
      const roots = original(...args);
      return {
        ...roots,
        denyRead: [...new Set([...(roots.denyRead ?? []), ...keychains])],
        keychainOnlyReadPaths: args[3]?.length ? [] : keychains,
      };
    });
    const priorToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const recording = recordingConfinement();
    const environments: (Record<string, string> | undefined)[] = [];
    let lease = "",
      transmitted = "";
    let worker: Awaited<ReturnType<typeof loop>> | undefined;
    try {
      worker = await loop(
        {
          confinement: recording.backend,
          harnesses: {
            claude: (spec) =>
              readPolicyScope.run({ ...cfg.readPolicy, home: syntheticHome, environment: {} }, () =>
                runClaude({ ...spec, denyRead: overlapping ? [keychain] : [] }, async (opts) => {
                  environments.push(opts.env);
                  opts.onStdoutLine?.(opts.cmd[4] ?? "");
                  const diagnostic = `Failed to authenticate. API Error: 401 rejected ${localToken}`;
                  opts.onStdoutLine?.(
                    JSON.stringify({
                      type: "result",
                      is_error: rejected,
                      result: rejected ? diagnostic : "done",
                    }),
                  );
                  return {
                    exitCode: rejected ? 1 : 0,
                    signal: null,
                    truncated: false,
                    durationMs: 1,
                    stdout: "",
                    stderr: rejected ? diagnostic : "",
                    timedOut: false,
                    idleTimedOut: false,
                    cancelled: false,
                  };
                }),
              ),
          },
          async request(...args) {
            if (args[1] === agentPath(id, "result")) transmitted = JSON.stringify(args[2]);
            const reply = await workerRequest(...args);
            if (args[1] === "/worker/lease") {
              const body = JSON.stringify(reply.json());
              if (body.includes(id)) lease = body;
            }
            return reply;
          },
        },
        "loop-runner",
        configDir,
      );
      await until(() => workers.agentJob(id)?.state === "done" || !!workers.agentJob(id)?.failure_reason);
      expect(environments).toHaveLength(1);
      expect(environments[0]?.CLAUDE_CODE_OAUTH_TOKEN).toBe(configured ? localToken : undefined);
      expect(environments[0]?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(environments[0]?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(lease).toContain(id);
      expect(lease).not.toContain(coordinatorToken);
      expect(lease).not.toContain("claudeSubscriptionToken");
      const roots = recording.calls[0]?.roots;
      if (!roots) throw new Error("missing worker editor profile");
      for (const path of keychains) {
        expect(roots.denyRead?.includes(path)).toBe(configured || overlapping);
        expect(seatbeltProfile(roots).includes(`(subpath "${path}")`)).toBe(configured || overlapping);
      }
      expect(workers.agentJob(id)?.state).toBe("done");
      const report = JSON.parse(transmitted);
      expect(report.status).toBe(rejected ? "error" : "ok");
      if (rejected) {
        expect(report.error).toBe("Failed to authenticate. API Error: 401 rejected [redacted]");
        expect(transmitted).not.toContain(localToken);
      }
    } finally {
      await worker?.stop();
      rootsSpy.mockRestore();
      if (priorToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = priorToken;
    }
  },
);

function reportPathForms(paths: string[]) {
  return [
    ...new Set(
      paths.flatMap((path) => {
        const forms = [path];
        for (const [a, b] of [
          ["/tmp/", "/private/tmp/"],
          ["/var/", "/private/var/"],
        ] as const) {
          if (path.startsWith(a)) forms.push(b + path.slice(a.length));
          if (path.startsWith(b)) forms.push(a + path.slice(b.length));
        }
        return forms.flatMap((form) => [form, form.replaceAll("/", "\\/")]);
      }),
    ),
  ];
}

test("agent reporting masks temporary aliases in both directions, escaped paths, keys and nested JSON", () => {
  for (const prefix of ["/tmp/", "/private/tmp/", "/var/", "/private/var/"]) {
    const root = `${prefix}report-job`,
      checkout = `${root}/checkout`,
      scratch = `${root}/scratch`;
    const mask = agentPathMask([root, checkout, scratch]);
    for (const form of reportPathForms([root, checkout, scratch])) {
      const input = {
        [form]: [{ path: form, json: JSON.stringify({ [form]: form }) }],
        keep: [42, null, true, "unrelated /tmp/elsewhere"],
      };
      expect(mask(input)).toEqual({
        "<worktree>": [{ path: "<worktree>", json: JSON.stringify({ "<worktree>": "<worktree>" }) }],
        keep: input.keep,
      });
      expect(mask(`failure: ${form}`)).toBe("failure: <worktree>");
    }
  }
});

test("agent reporting captures supplied and canonical paths before scratch cleanup", () => {
  const target = join(home, "canonical"),
    alias = join(home, "alias");
  mkdirSync(target);
  symlinkSync(target, alias);
  const canonical = realpathSync(alias);
  // Checkout failures can be reported before the checkout itself exists.
  const forms = reportPathForms([alias, canonical, join(alias, "checkout"), join(canonical, "checkout")]);
  const mask = agentPathMask([alias, join(alias, "checkout")]);
  rmSync(alias);
  rmSync(target, { recursive: true });
  expect(mask(forms)).toEqual(forms.map(() => "<worktree>"));
});

test.each([0, 450])(
  "worker batches agent events during an idle session (burst=%s)",
  async (count) => {
    await listen();
    const id = await queuedLocalAgent();
    const started = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    let emittedAt = 0;
    const worker = await loop({
      harnesses: {
        claude: fakeHarness(async (spec) => {
          emittedAt = performance.now();
          for (let i = 0; i < count; i++) spec.onEvent({ type: "text", text: String(i) });
          started.resolve();
          await finish.promise;
          return {};
        }),
      },
    });
    try {
      await started.promise;
      await until(() => batches(id).length === Math.ceil((count + 1) / 200));
      const elapsed = performance.now() - emittedAt;
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(2000);
      expect(workers.agentJob(id)?.state).toBe("leased");
      const rows = batches(id);
      expect(rows.map((row) => row.seq)).toEqual(count ? [0, 1, 2] : [0]);
      const events = rows.map((row) => JSON.parse(row.events) as { type: string; text?: string }[]);
      expect(events.map((batch) => batch.length)).toEqual(count ? [200, 200, 51] : [1]);
      expect(
        events
          .flat()
          .filter((event) => event.type === "text")
          .map((event) => event.text),
      ).toEqual(Array.from({ length: count }, (_, i) => String(i)));
      finish.resolve();
      await until(() => workers.agentJob(id)?.state === "done");
    } finally {
      finish.resolve();
      await worker.stop();
    }
  },
  30_000,
);

test("worker fences an agent after one lease period without a successful heartbeat", async () => {
  await listen();
  const id = await queuedLocalAgent();
  const started = Promise.withResolvers<AgentSpec>(),
    partitioned = Promise.withResolvers<void>();
  const leaseMs = 400;
  let partition = false,
    lastSuccess = 0,
    results = 0;
  const worker = await loop({
    leaseMs,
    harnesses: {
      claude: fakeHarness((spec) => {
        started.resolve(spec);
        return { fault: "block" };
      }),
    },
    async request(...args) {
      if (args[1] === "/worker/heartbeat" && partition) {
        partitioned.resolve();
        throw new Error("injected partition");
      }
      if (args[1] === agentPath(id, "result")) results++;
      const reply = await workerRequest(...args);
      if (args[1] === "/worker/heartbeat" && reply.status === 200) lastSuccess = performance.now();
      return reply;
    },
  });
  try {
    const spec = await started.promise;
    partition = true;
    await partitioned.promise;
    await Bun.sleep(100);
    expect(spec.signal.aborted).toBe(false);
    await until(() => spec.signal.aborted);
    expect(performance.now() - lastSuccess).toBeGreaterThanOrEqual(leaseMs);
    expect(performance.now() - lastSuccess).toBeLessThan(2000);
    await until(() => readdirSync(worker.remote.paths.work).length === 0);
    expect(results).toBe(0);
    expect(workers.agentJob(id)?.state).not.toBe("done");
    expect(worker.controller.signal.aborted).toBe(false);
  } finally {
    await worker.stop();
  }
}, 30_000);

test("retained recovery does not delay active lease renewal and drains before the store closes", async () => {
  await listen();
  const id = await queuedLocalAgent();
  const remote = loadConfig({ home: join(home, "remote"), configDir: cfg.paths.configDir, raw: {} });
  mkdirSync(join(remote.paths.home, "worker"), { recursive: true });
  mkdirSync(remote.paths.work, { recursive: true });
  const root = mkdtempSync(join(remote.paths.work, "worker-"));
  const scratch = mkdtempSync(join(home, "kept-scratch-"));
  const marker = crypto.randomUUID();
  const local = new Store(join(remote.paths.home, "worker", "worker.db"));
  local.setSetting("worker.cleanups", {
    [root]: {
      root,
      cache: join(root, "repo.git"),
      scratch: [scratch],
      confirmed: false,
      ownership: { marker, runId: "retained", started: 0, boot: "test-boot" },
    },
  });
  local.close();
  const clock = waitClock(),
    scheduled = spyOn(clock.timer, "set");
  const started = Promise.withResolvers<AgentSpec>(),
    releaseRecovery = Promise.withResolvers<number[]>();
  let running = false,
    scans = 0;
  const worker = await processBootInspection.run(
    () => "test-boot",
    () =>
      processRecoveryInspection.run(
        {
          stopped: recoveryProcessStopped,
          timeoutMs: 1000,
          discover: async (invocation) => {
            if (invocation !== marker) return [];
            if (!running) throw new Error("recovery scan unavailable");
            scans++;
            return releaseRecovery.promise;
          },
        },
        () =>
          loop({
            heartbeatMs: 5,
            leaseMs: 400,
            fenceTimer: clock.timer,
            log: () => {},
            harnesses: {
              claude: fakeHarness((spec) => {
                running = true;
                started.resolve(spec);
                return { fault: "block" };
              }),
            },
          }),
      ),
  );
  try {
    const spec = await started.promise;
    await until(() => scans > 0);
    for (let i = 0; i < 2; i++) {
      const renewals = scheduled.mock.calls.length;
      await until(() => scheduled.mock.calls.length > renewals);
      await clock.advance(300);
      expect(spec.signal.aborted).toBe(false);
      expect(workers.agentJob(id)?.state).toBe("leased");
    }
    expect(scans).toBe(1); // Other heartbeats reuse the pending recovery attempt.
    expect(existsSync(root)).toBe(true);
    expect(existsSync(scratch)).toBe(true);
    expect(existsSync(spec.cwd)).toBe(true);
    expect(existsSync(spec.scratchDir ?? "")).toBe(true);
    worker.controller.abort();
    await until(() => !existsSync(spec.cwd));
    let stopped = false;
    void worker.task.finally(() => {
      stopped = true;
    });
    await clock.flush();
    expect(stopped).toBe(false);
    releaseRecovery.resolve([]);
    await worker.task;
    expect(existsSync(root)).toBe(false);
    expect(existsSync(scratch)).toBe(false);
    expect(workerCleanupRecords(remote)).toEqual([]);
    expect(clock.pending).toBe(0);
  } finally {
    releaseRecovery.resolve([]);
    await worker.stop();
    scheduled.mockRestore();
  }
}, 30_000);

test("worker renews the fence at heartbeat success and aborts exactly at its deadline", async () => {
  await listen();
  const id = await queuedLocalAgent();
  const clock = waitClock(),
    scheduled = spyOn(clock.timer, "set");
  const started = Promise.withResolvers<AgentSpec>(),
    second = Promise.withResolvers<void>(),
    releaseSecond = Promise.withResolvers<void>(),
    failed = Promise.withResolvers<void>();
  let heartbeats = 0,
    results = 0;
  const worker = await loop({
    leaseMs: 400,
    heartbeatMs: 200,
    fenceTimer: clock.timer,
    harnesses: {
      claude: fakeHarness((spec) => {
        started.resolve(spec);
        return { fault: "block" };
      }),
    },
    async request(...args) {
      if (args[1] === "/worker/heartbeat") {
        heartbeats++;
        if (heartbeats === 2) {
          second.resolve();
          await releaseSecond.promise;
        } else if (heartbeats > 2) {
          failed.resolve();
          throw new Error("injected partition");
        }
      }
      if (args[1] === agentPath(id, "result")) results++;
      return workerRequest(...args);
    },
  });
  try {
    const spec = await started.promise;
    await second.promise;
    await clock.advance(200);
    expect(scheduled).toHaveBeenCalledTimes(1);
    await clock.advance(100);
    releaseSecond.resolve();
    await until(() => scheduled.mock.calls.length === 2);
    expect(clock.pending).toBe(1);
    await clock.advance(100); // The first heartbeat's deadline must have been cancelled.
    expect(spec.signal.aborted).toBe(false);
    await failed.promise;
    await clock.advance(299);
    expect(spec.signal.aborted).toBe(false);
    expect(scheduled).toHaveBeenCalledTimes(2); // Retries and lease replies never renew it.
    await clock.advance(1);
    expect(spec.signal.aborted).toBe(true);
    await until(() => readdirSync(worker.remote.paths.work).length === 0);
    expect(results).toBe(0);
    expect(worker.controller.signal.aborted).toBe(false);
    await worker.stop();
    expect(clock.pending).toBe(0);
  } finally {
    releaseSecond.resolve();
    await worker.stop();
    scheduled.mockRestore();
  }
}, 30_000);

test("worker shutdown clears the fence and a late heartbeat cannot rearm it", async () => {
  await listen();
  const clock = waitClock(),
    scheduled = spyOn(clock.timer, "set");
  const pending = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let beats = 0;
  const worker = await loop({
    leaseMs: 400,
    fenceTimer: clock.timer,
    async request(...args) {
      const reply = await workerRequest(...args);
      if (args[1] === "/worker/heartbeat" && ++beats === 2) {
        pending.resolve();
        await release.promise; // Deliberately return success even after the signal aborts.
      }
      return reply;
    },
  });
  try {
    await pending.promise;
    expect(clock.pending).toBe(1);
    worker.controller.abort();
    await until(() => clock.pending === 0);
    expect(clock.pending).toBe(0);
    release.resolve();
    await worker.task;
    expect(clock.pending).toBe(0);
    expect(scheduled).toHaveBeenCalledTimes(1);
    await clock.advance(1000);
    expect(clock.pending).toBe(0);
  } finally {
    release.resolve();
    await worker.stop();
    scheduled.mockRestore();
  }
});

test.each(["claude", "codex"] as const)(
  "readonly worker dependencies: %s",
  async (harness) => {
    await listen();
    const req = await request();
    const install = await readerDependencyFixture(req.cwd);
    await sh(["git", "add", "."], { cwd: req.cwd });
    await sh(["git", "commit", "-qm", "offline dependency fixture"], { cwd: req.cwd });
    const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: req.cwd })).stdout.trim();
    await sh(["git", "clone", "--bare", req.cwd, join(cfg.paths.repos, "test__repo.git")], { cwd: home });
    const ancestor = join(home, "remote/node_modules/zod");
    dependencyPackage(ancestor, "3.0.0");
    const before = readFileSync(join(ancestor, "index.js"), "utf8");
    const id = enqueueAgent({
      runId: req.runId,
      parentSha: sha,
      branch: "change/worker-agent",
      role: "review",
      mode: "readonly",
      timeoutMs: 15_000,
      readerSetup: [install, captureSetupEnv],
      target: { ...agentRequest().target, harness },
    });
    let imports = 0;
    const worker = await loop({
      harnesses: {
        [harness]: fakeHarness(async (spec) => {
          await expectReaderDependency(spec.cwd);
          expectPrivateSetup(spec.cwd);
          expectReaderPermissions(spec);
          imports++;
          return { text: "checked dependencies" };
        }),
      },
    });
    try {
      await until(() => workers.agentJob(id)?.state === "done");
      expect(imports).toBe(1);
      expect(workers.agentJob(id)?.result_sha).toBe(sha);
      expect(readFileSync(join(ancestor, "index.js"), "utf8")).toBe(before);
    } finally {
      await worker.stop();
    }
  },
  30_000,
);

test("readonly worker agent runs at its parent, hides paths, uses local slots and discards edits", async () => {
  await listen();
  const id = await queuedLocalAgent({
    mode: "readonly",
    role: "verify",
    agentFullSuite: "refuse",
    slottedCommands: [["bun", "test"]],
  });
  let cwd = "",
    scratch = "";
  let forms: string[] = [];
  const posted: unknown[] = [];
  const worker = await loop({
    async request(...args) {
      if (args[1].endsWith("/events") || args[1].endsWith("/result")) posted.push(args[2]);
      return workerRequest(...args);
    },
    harnesses: {
      claude: fakeHarness(async (spec) => {
        cwd = spec.cwd;
        scratch = spec.scratchDir ?? "";
        expect((await worktreeGit(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim()).toBe(
          workers.agentJob(id)?.parent_sha ?? "",
        );
        expect(
          (await worktreeGit(["git", "symbolic-ref", "-q", "HEAD"], { cwd, allowFail: true })).exitCode,
        ).not.toBe(0);
        const wrappers = spec.commandPath?.split(":")[0] ?? "";
        const config = JSON.parse(readFileSync(join(wrappers, "config.json"), "utf8"));
        expect(config).not.toHaveProperty("port");
        expect(config).toMatchObject({ role: "verify", agentFullSuite: "refuse" });
        const lease = await agentTestLease({ token: config.token, name: "bun test", lane: "gate" });
        expect(lease.acquired).toBe(true);
        await agentTestLease({ token: config.token, id: lease.id, release: true });
        forms = reportPathForms([cwd, scratch, dirname(cwd), realpathSync(cwd), realpathSync(scratch)]);
        const structured = forms.map((form) => ({ [form]: [form, JSON.stringify({ path: form })] }));
        spec.onEvent({ type: "tool_call", id: "paths", name: "inspect", input: structured });
        return {
          files: { edited: "discard this" },
          text: forms.join(" "),
          structured,
        };
      }),
    },
  });
  try {
    await until(() => workers.agentJob(id)?.state === "done");
    await until(() => readdirSync(worker.remote.paths.work).length === 0);
    const job = workers.agentJob(id);
    expect(job?.result_sha).toBe(job?.parent_sha);
    expect(JSON.parse(job?.result ?? "null")).toMatchObject({
      branch: "change/worker-agent",
      finalText: forms.map(() => "<worktree>").join(" "),
      structured: forms.map(() => ({ "<worktree>": ["<worktree>", JSON.stringify({ path: "<worktree>" })] })),
    });
    const rows = batches(id);
    expect(rows.map((row) => row.seq)).toEqual(rows.map((_, i) => i));
    const events = rows.flatMap((row) => JSON.parse(row.events));
    expect(events.at(-1)).toEqual({ type: "text", text: forms.map(() => "<worktree>").join(" ") });
    expect(events.find((event) => event.id === "paths")?.input).toEqual(
      forms.map(() => ({ "<worktree>": ["<worktree>", JSON.stringify({ path: "<worktree>" })] })),
    );
    for (const form of forms) expect(JSON.stringify(posted)).not.toContain(form);
    expect(JSON.stringify(events)).not.toContain(cwd);
    expect(JSON.stringify(events)).not.toContain(scratch);
    expect(existsSync(scratch)).toBe(false);
    expect(readdirSync(worker.remote.paths.work)).toEqual([]);
    expect(workerCleanupRecords(worker.remote)).toEqual([]);
  } finally {
    await worker.stop();
  }
}, 30_000);

test("worker implement full-suite refusal is forwarded once with a redacted command", async () => {
  await listen();
  const secret = `credential-${crypto.randomUUID()}`;
  registerCredential("WORKER_REFUSAL_TEST", secret);
  const id = await queuedLocalAgent({
    role: "implement",
    agentFullSuite: "refuse",
    slottedCommands: [["bun", "test"]],
  });
  const worker = await loop({
    harnesses: {
      claude: fakeHarness(async (spec) => {
        const wrapper = spec.commandPath?.split(":")[0] ?? "";
        const config: WrapperConfig = JSON.parse(readFileSync(join(wrapper, "config.json"), "utf8"));
        expect(config).toMatchObject({ role: "implement", agentFullSuite: "refuse" });
        expect(
          await agentTestCommand(config, ["bun", "test", "-t", secret], async (body) => {
            await agentTestLease(body);
            return agentTestLease(body);
          }),
        ).not.toBe(0);
        return {};
      }),
    },
  });
  try {
    await until(() => workers.agentJob(id)?.state === "done");
    const events = batches(id).flatMap((row) => JSON.parse(row.events));
    const refusals = events.filter((event) => event.text?.startsWith("agent-test refused:"));
    expect(refusals).toEqual([
      { type: "status", text: "agent-test refused: full suite: bun test -t [redacted]" },
    ]);
    expect(AgentEvents.safeParse({ seq: 0, events: refusals }).success).toBe(true);
    expect(
      AgentEvents.safeParse({ seq: 0, events: [{ ...refusals[0], data: { command: "bun test" } }] }).success,
    ).toBe(false);
    expect(JSON.parse(workers.agentJob(id)?.result ?? "null")).toMatchObject({ status: "ok" });
    expect(JSON.stringify(events)).not.toContain(secret);
  } finally {
    await worker.stop();
  }
}, 30_000);

test("worker rejects unsupported providers without invoking a harness", async () => {
  await listen();
  const id = enqueueAgent();
  const worker = await loop({
    async request(...args) {
      const reply = await workerRequest(...args);
      if (args[1] !== "/worker/lease") return reply;
      const body = reply.json() as { agentJob?: { request: { target: { harness: string } } } };
      if (body.agentJob) body.agentJob.request.target.harness = "fake";
      return { ...reply, json: () => body };
    },
    harnesses: {
      claude: fakeHarness(() => {
        throw new Error("unexpected harness");
      }),
    },
  });
  try {
    await until(() => workers.agentJob(id)?.failure_reason !== null);
    expect(workers.agentJob(id)?.failure_reason).toBe("provider unavailable on worker");
    expect(JSON.parse(workers.agentJob(id)?.excluded ?? "[]")).toContain("loop-runner");
    expect(readdirSync(worker.remote.paths.work)).toEqual([]);
  } finally {
    await worker.stop();
  }
});

test("worker sanitizes harness failures and keeps running", async () => {
  await listen();
  const id = await queuedLocalAgent();
  const secret = "synthetic-worker-agent-secret-733";
  registerCredential("worker-agent-test", secret);
  let cwd = "",
    scratch = "",
    transmitted = "";
  let expected = "";
  const worker = await loop({
    async request(...args) {
      if (args[1].endsWith("/failure")) transmitted = (args[2] as { reason: string }).reason;
      return workerRequest(...args);
    },
    harnesses: {
      claude: fakeHarness((spec) => {
        cwd = spec.cwd;
        scratch = spec.scratchDir ?? "";
        const forms = reportPathForms([cwd, scratch, dirname(cwd), realpathSync(cwd), realpathSync(scratch)]);
        expected = `${forms.map(() => "<worktree>").join(" ")} [redacted] ${"x".repeat(5000)}`.slice(0, 4000);
        throw new Error(`${forms.join(" ")} ${secret} ${"x".repeat(5000)}`);
      }),
    },
  });
  try {
    await until(() => workers.agentJob(id)?.failure_reason !== null);
    const reason = workers.agentJob(id)?.failure_reason;
    expect(transmitted).toBe(expected);
    expect(reason).toBe("[withheld: private text]");
    expect(reason).not.toContain(cwd);
    expect(reason).not.toContain(scratch);
    expect(reason).not.toContain(secret);
    expect(worker.controller.signal.aborted).toBe(false);
    expect(readdirSync(worker.remote.paths.work)).toEqual([]);
    expect(existsSync(scratch)).toBe(false);
    expect(workerCleanupRecords(worker.remote)).toEqual([]);
  } finally {
    await worker.stop();
  }
}, 30_000);

test("worker cancels agent sessions while gates retain all their slots", async () => {
  await listen();
  const id = await queuedLocalAgent();
  const started = Promise.withResolvers<AgentSpec>();
  const beat = Promise.withResolvers<Capabilities>();
  const worker = await loop({
    harnesses: {
      codex: fakeHarness(() => ({ text: "Next job" })),
      claude: fakeHarness((spec) => {
        started.resolve(spec);
        return { fault: "block" };
      }),
    },
    async request(...args) {
      if (args[1] === "/worker/heartbeat") {
        const body = args[2] as Capabilities;
        if (body.jobs.includes(id)) beat.resolve(body);
      }
      return workerRequest(...args);
    },
  });
  try {
    const spec = await started.promise;
    expect((await beat.promise).freeSlots).toBe(gateSlots.snapshot().limit);
    const gate = workers.enqueue({
      repo: "test/repo",
      cwd: "",
      headSha: workers.agentJob(id)?.parent_sha ?? "",
      baseSha: "",
      gates: { setup: [], checks: [], source: "none", protectedPaths: [] },
    });
    await until(() => workers.job(gate)?.state === "done");
    workers.cancelAgentJob(id);
    await until(() => spec.signal.aborted);
    expect(workers.agentJob(id)?.state).toBe("cancelled");
    const next = enqueueAgent({
      ...agentRequest(),
      runId: workers.agentJob(id)?.run_id ?? "",
      parentSha: workers.agentJob(id)?.parent_sha ?? "",
      target: { ...agentRequest().target, harness: "codex" },
      branch: "change/next",
    });
    await until(() => workers.agentJob(next)?.state === "done");
    expect(worker.controller.signal.aborted).toBe(false);
    await until(() => readdirSync(worker.remote.paths.work).length === 0);
    expect(existsSync(spec.scratchDir ?? "")).toBe(false);
    expect(workerCleanupRecords(worker.remote)).toEqual([]);
  } finally {
    await worker.stop();
  }
}, 30_000);

test("worker never reports an agent result after its events are rejected", async () => {
  await listen();
  const id = await queuedLocalAgent();
  let results = 0;
  const worker = await loop({
    harnesses: { claude: fakeHarness(() => ({ text: "Progress", fault: "block" })) },
    async request(...args) {
      if (args[1] === agentPath(id, "result")) results++;
      const reply = await workerRequest(...args);
      return args[1] === agentPath(id, "events") ? { ...reply, status: 409 } : reply;
    },
  });
  try {
    await until(() => batches(id).length > 0);
    await until(() => readdirSync(worker.remote.paths.work).length === 0);
    expect(results).toBe(0);
    expect(workers.agentJob(id)?.state).not.toBe("done");
  } finally {
    await worker.stop();
  }
}, 30_000);

test("worker update drains the agent session and its checkout before replacing itself", async () => {
  await listen();
  const id = await queuedLocalAgent();
  const started = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>(),
    observed = Promise.withResolvers<void>();
  let advertised = releaseSha,
    commands = 0,
    replaced = false;
  const target = "b".repeat(40);
  const worker = await loop({
    harnesses: {
      claude: fakeHarness(async () => {
        started.resolve();
        await finish.promise;
        return { text: "Done" };
      }),
    },
    async request(...args) {
      const reply = await workerRequest(...args);
      if (args[1] === "/worker/heartbeat") {
        if (advertised === target) observed.resolve();
        return { ...reply, json: () => ({ ...(reply.json() as object), releaseSha: advertised }) };
      }
      return reply;
    },
    update: {
      async command(args) {
        commands++;
        expect(workers.agentJob(id)?.state).toBe("done");
        expect(readdirSync(join(home, "remote", "work"))).toEqual([]);
        return { stdout: args.includes(`${target}^{commit}`) ? target : releaseSha, stderr: "", exitCode: 0 };
      },
      exec() {
        replaced = true;
      },
    },
  });
  try {
    await started.promise;
    advertised = target;
    await observed.promise;
    expect(commands).toBe(0);
    finish.resolve();
    await until(() => replaced);
    expect(commands).toBeGreaterThan(0);
  } finally {
    finish.resolve();
    await worker.stop();
  }
}, 30_000);

test.each([
  ["agent", true],
  ["gate", true],
  ["agent", false],
  ["gate", false],
] as const)(
  "worker recovers a crashed %s invocation only with discovery evidence or a changed boot (saved=%s)",
  async (kind, savedDiscovery) => {
    const server = await listen();
    const req = await request(true);
    req.gates.setup = [];
    req.gates.checks = [{ name: "probe", run: "true" }];
    const id =
      kind === "agent"
        ? enqueueAgent({
            runId: req.runId,
            parentSha: req.headSha,
            branch: "change/worker-agent",
            target: { ...agentRequest().target, harness: "claude" },
          })
        : workers.enqueue(req);
    const remote = loadConfig({ home: join(home, "remote"), configDir: cfg.paths.configDir, raw: {} });
    await pairWorker(server.url.origin, join(remote.paths.home, "worker"), "crashing-worker", (text) =>
      workers.approve(text.split(": ")[1] ?? ""),
    );
    const ready = join(home, "ready.json");
    const script = join(home, "worker.ts");
    const source = (path: string) => JSON.stringify(new URL(path, import.meta.url).pathname);
    writeFileSync(
      script,
      `
      import ${source("./git-preload.ts")};
      import { writeFileSync } from 'node:fs';
      import { loadConfig } from ${source("../src/config.ts")};
      import { fakeHarness } from ${source("../src/harness/fake.ts")};
      import { invocationScratch, processBootInspection, processScope, runProcess } from ${source("../src/util/proc.ts")};
      import { runWorker } from ${source("../src/workers/client.ts")};
      const invoke = async (cwd) => {
        const scope = processScope.getStore();
        await runProcess({ cmd: [process.execPath, '-e', ''], cwd, env: {} });
        const local = new (await import(${source("../src/db/store.ts")})).Store(${JSON.stringify(join(remote.paths.home, "worker", "worker.db"))});
        const kept = local.getSetting('worker.cleanups', {})[cwd.slice(0, -'/checkout'.length)];
        if (kept.pending.length || kept.ownership.marker !== scope.ownershipMarker) throw new Error('premature confirmation');
        local.close();
        const record = scope.cleanups.recordProcessDiscovery;
        scope.cleanups.recordProcessDiscovery = (row) => {
          if (${savedDiscovery}) record(row);
          for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        };
        return runProcess({
          cmd: [process.execPath, '-e',
            // Written aside and renamed, so the test never parses a partly written file.
            "const fs = require('node:fs'); fs.writeFileSync(" + ${JSON.stringify(JSON.stringify(`${ready}.tmp`))} + ", JSON.stringify({" +
            "pid: process.pid, invocation: process.env.LIMITLESS_INVOCATION, ownership: process.env[" +
            JSON.stringify('LIMITLESS_INVOCATION_' + scope.ownershipMarker.replaceAll('-', '_')) + "]," +
            "cwd: " + JSON.stringify(cwd) + ", scratch: " + JSON.stringify(invocationScratch.getStore()) +
            "})); fs.renameSync(" + ${JSON.stringify(JSON.stringify(`${ready}.tmp`))} + ", " + ${JSON.stringify(JSON.stringify(ready))} + ");" +
            " setInterval(() => {}, 1000);"],
          cwd, env: {},
        });
      };
      await processBootInspection.run(() => 'test-boot', () => runWorker(${JSON.stringify(server.url.origin)}, loadConfig({
        home: ${JSON.stringify(remote.paths.home)}, configDir: ${JSON.stringify(cfg.paths.configDir)}, raw: {},
      }), ${JSON.stringify(releaseSha)}, new AbortController().signal, {
        platform: "darwin",
        heartbeatMs: 10, retryMs: 5,
        capabilityRunner: async (args) => ({ exitCode: 0, stdout: args[1] === "--version" ? "2.1.3 (Claude Code)" : "logged in" }),
        machineState: async () => ({ onAC: true, idleSeconds: 0 }),
        confinement: {
          wrap: (cmd) => cmd,
          async verify(_roots, opts) { if (${JSON.stringify(kind)} === 'gate') await invoke(opts.cwd); },
        },
        harnesses: { claude: fakeHarness(async (spec) => { await invoke(spec.cwd); return {}; }) },
      }));
      `,
    );
    const supervisor = Bun.spawn([process.execPath, script], {
      cwd: home,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    try {
      await until(() => existsSync(ready));
      const { pid, ownership, cwd, scratch } = JSON.parse(readFileSync(ready, "utf8")) as {
        pid: number;
        ownership: string;
        cwd: string;
        scratch: string;
      };
      expect(ownership).toBe("1");
      // Checkout setup has already completed several successful scoped commands.
      expect(existsSync(join(cwd, "tracked"))).toBe(true);
      expect(existsSync(scratch)).toBe(true);
      supervisor.kill("SIGKILL");
      await supervisor.exited;
      expect(recoveryProcessStopped(pid)).toBe(false);
      const database = join(remote.paths.home, "worker", "worker.db");
      const local = new Store(database);
      let unresolved: Record<string, unknown>;
      try {
        expect(local.listProcessCleanups()).toEqual([]);
        unresolved = local.getSetting("worker.cleanups", {});
        expect(unresolved[dirname(cwd)]).toMatchObject({
          pending: savedDiscovery ? [] : [expect.any(String)],
          scratch: [scratch],
          discoveries: savedDiscovery ? [expect.objectContaining({ invocation: expect.any(String) })] : [],
          ownership: expect.objectContaining({ runId: id, marker: expect.any(String) }),
        });
      } finally {
        local.close();
      }
      let requests = 0;
      const unavailable = new AbortController();
      const diagnostics: string[] = [];
      await processRecoveryInspection.run(
        {
          stopped: recoveryProcessStopped,
          timeoutMs: 1000,
          discover: async () => {
            if (savedDiscovery) throw new Error("recovery inspection unavailable");
            return [];
          },
        },
        () =>
          runWorker(server.url.origin, remote, releaseSha, unavailable.signal, {
            platform: "darwin",
            confinement: fakeConfinement,
            log: (text) => diagnostics.push(text),
            machineState: async () => ({ onAC: true, idleSeconds: 0 }),
            request: async (...args) => {
              requests++;
              unavailable.abort();
              return workerRequest(...args);
            },
          }),
      );
      expect(requests).toBe(1);
      expect(
        diagnostics.some((text) =>
          text.includes(savedDiscovery ? "recovery inspection unavailable" : "awaiting changed boot"),
        ),
      ).toBe(true);
      expect(recoveryProcessStopped(pid)).toBe(false);
      expect(existsSync(cwd)).toBe(true);
      expect(existsSync(scratch)).toBe(true);
      const reopened = new Store(database);
      try {
        expect(reopened.getSetting("worker.cleanups", {})).toEqual(unresolved);
      } finally {
        reopened.close();
      }
      requests = 0;
      const controller = new AbortController();
      // A reboot would stop the orphan; emulate that using only the PID this test started.
      if (!savedDiscovery) {
        process.kill(pid, "SIGKILL");
        await until(() => recoveryProcessStopped(pid));
      }
      await processBootInspection.run(
        () => (savedDiscovery ? "test-boot" : "next-boot"),
        () =>
          runWorker(server.url.origin, remote, releaseSha, controller.signal, {
            platform: "darwin",
            confinement: fakeConfinement,
            machineState: async () => ({ onAC: true, idleSeconds: 0 }),
            request: async (...args) => {
              requests++;
              expect(recoveryProcessStopped(pid)).toBe(true);
              expect(existsSync(dirname(cwd))).toBe(false);
              expect(existsSync(scratch)).toBe(false);
              expect(workerCleanupRecords(remote)).toEqual([]);
              controller.abort();
              return workerRequest(...args);
            },
          }),
      );
      expect(requests).toBe(1);
    } finally {
      if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
      await supervisor.exited;
      if (existsSync(ready)) {
        const { pid, scratch } = JSON.parse(readFileSync(ready, "utf8")) as {
          pid: number;
          scratch: string;
        };
        if (!recoveryProcessStopped(pid)) process.kill(pid, "SIGKILL");
        await until(() => recoveryProcessStopped(pid));
        removeScratch(scratch);
      }
    }
  },
  30_000,
);

test.each([
  ["agent", 0],
  ["gate", 0],
  ["agent", 1],
  ["gate", 1],
] as const)(
  "worker retains a %s job after discovery fails with %i recorded scans and recovers before work",
  async (kind, recordedScans) => {
    const server = await listen();
    const req = await request(true);
    req.gates.setup = [];
    req.gates.checks = [{ name: "probe", run: "true" }];
    const id =
      kind === "agent"
        ? enqueueAgent({
            runId: req.runId,
            parentSha: req.headSha,
            branch: "change/worker-agent",
            target: { ...agentRequest().target, harness: "claude" },
          })
        : workers.enqueue(req);
    const pidFile = join(home, "owned-descendant");
    let pid: number | undefined;
    let invocation = "";
    let root = "",
      scratch = "",
      database = "",
      results = 0;
    const failed = Promise.withResolvers<void>();
    const inject = async (cwd: string) => {
      if (root) return;
      root = dirname(cwd);
      scratch = invocationScratch.getStore() ?? "";
      database = join(home, "remote", "worker", "worker.db");
      expect(scratch).not.toBe("");
      expect(processScope.getStore()?.runId).toBe(id);
      for (const path of [database, `${database}-wal`, `${database}-shm`])
        expect(privateReadPaths()).toContain(path);
      let scans = 0;
      await expect(
        processInspection.run(
          async (withEnvironment, marker) => {
            if (withEnvironment && ++scans > recordedScans) throw new Error("injected discovery failure");
            const owned = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; marker: string };
            const uid = process.getuid?.();
            return (
              `${process.pid} ${uid} S scanner LIMITLESS_PROCESS_SCAN=${marker}\n` +
              `${owned.pid} ${uid} S member${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}`
            );
          },
          () =>
            runProcess({
              cmd: [
                process.execPath,
                "-e",
                `
              const { spawn } = require('node:child_process');
              const { existsSync } = require('node:fs');
              const child = spawn(process.execPath, ['-e', ${JSON.stringify(`
                require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({
                  pid: process.pid, marker: process.env.LIMITLESS_INVOCATION,
                }));
                setInterval(() => {}, 1000);
              `)}], { detached: true, stdio: 'ignore' });
              child.unref();
              while (!existsSync(${JSON.stringify(pidFile)})) await Bun.sleep(10);
            `,
              ],
              cwd,
              env: {},
            }),
        ),
      ).rejects.toThrow(ProcessTerminationError.prefix);
      const owned = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; marker: string };
      pid = owned.pid;
      invocation = owned.marker;
      // Even a harness which catches the error must not turn this into success.
    };
    const worker = await loop({
      heartbeatMs: 60_000,
      harnesses: {
        claude: fakeHarness(async (spec) => {
          await inject(spec.cwd);
          return {};
        }),
      },
      confinement: {
        ...fakeConfinement,
        async verify(_roots, opts) {
          if (kind === "gate") await inject(opts.cwd);
        },
      },
      async request(...args) {
        if (args[1].endsWith("/result")) results++;
        const reply = await workerRequest(...args);
        if (args[1].endsWith("/failure")) failed.resolve();
        return reply;
      },
    });
    const retained = () => {
      const local = new Store(database);
      try {
        return local.getSetting<Record<string, { discoveries: { invocation: string; runId: string }[] }>>(
          "worker.cleanups",
          {},
        );
      } finally {
        local.close();
      }
    };
    const records = () => {
      const local = new Store(database);
      try {
        return local.listProcessCleanups();
      } finally {
        local.close();
      }
    };
    try {
      await failed.promise;
      expect(results).toBe(0);
      // A retained attempt must not poison the other kind of job on this worker.
      const next =
        kind === "agent"
          ? workers.enqueue(req)
          : enqueueAgent({
              runId: req.runId,
              parentSha: req.headSha,
              branch: "change/next",
              target: { ...agentRequest().target, harness: "claude" },
            });
      await until(() => (kind === "agent" ? workers.job(next) : workers.agentJob(next))?.state === "done");
      expect(readdirSync(worker.remote.paths.work)).toEqual([basename(root)]);
      await worker.stop();
      expect(existsSync(root)).toBe(true);
      expect(existsSync(join(root, "checkout"))).toBe(true);
      expect(existsSync(scratch)).toBe(true);
      if (pid === undefined) throw new Error("Missing descendant PID");
      const descendantPid = pid;
      expect(recoveryProcessStopped(pid)).toBe(recordedScans > 0);
      expect(records()).toEqual(
        recordedScans ? [expect.objectContaining({ runId: id, pid, discovery: expect.any(Object) })] : [],
      );
      expect(retained()[root]?.discoveries).toEqual([
        expect.objectContaining({ invocation, runId: id, discovery: expect.any(Object) }),
      ]);
      const unresolved = retained();
      for (const path of [database, `${database}-wal`, `${database}-shm`])
        expect(privateReadPaths()).not.toContain(path);
      let requests = 0;
      const restart = (
        signal: AbortSignal,
        request: NonNullable<Parameters<typeof runWorker>[4]>["request"],
      ) =>
        runWorker(server.url.origin, worker.remote, releaseSha, signal, {
          platform: "darwin",
          confinement: fakeConfinement,
          machineState: async () => ({ onAC: true, idleSeconds: 0 }),
          request,
        });
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        await processRecoveryInspection.run(
          {
            stopped: recoveryProcessStopped,
            timeoutMs: 1000,
            discover: async () => {
              throw new Error("recovery inspection unavailable");
            },
          },
          () =>
            restart(controller.signal, async (...args) => {
              requests++;
              controller.abort();
              return workerRequest(...args);
            }),
        );
        expect(requests).toBe(attempt + 1);
        expect(records()).toHaveLength(recordedScans);
        expect(retained()).toEqual(unresolved);
        expect(recoveryProcessStopped(pid)).toBe(recordedScans > 0);
        expect(existsSync(join(root, "checkout"))).toBe(true);
        expect(existsSync(scratch)).toBe(true);
      }
      requests = 0;
      const controller = new AbortController();
      const kill = process.kill;
      let recordedBeforeKill = false;
      const signaling = spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target === pid && signal === "SIGKILL") {
          expect(records()).toContainEqual(expect.objectContaining({ pid }));
          expect(existsSync(root)).toBe(true);
          expect(existsSync(scratch)).toBe(true);
          recordedBeforeKill = true;
        }
        return kill(target, signal);
      });
      try {
        await processRecoveryInspection.run(
          {
            stopped: (target) => {
              expect(existsSync(root)).toBe(true);
              expect(existsSync(scratch)).toBe(true);
              return recoveryProcessStopped(target);
            },
            timeoutMs: 2000,
          },
          () =>
            restart(controller.signal, async (...args) => {
              requests++;
              expect(recoveryProcessStopped(descendantPid)).toBe(true);
              expect(existsSync(root)).toBe(false);
              expect(existsSync(scratch)).toBe(false);
              expect(records()).toEqual([]);
              expect(retained()).toEqual({});
              controller.abort();
              return workerRequest(...args);
            }),
        );
        expect(recordedBeforeKill).toBe(recordedScans === 0);
      } finally {
        signaling.mockRestore();
      }
      expect(requests).toBe(1);
      if (kind === "gate") {
        const cache = join(worker.remote.paths.repos, `${encodeURIComponent(req.repo)}.git`);
        expect(existsSync(cache)).toBe(true);
        expect(
          (await worktreeGit(["git", "worktree", "list", "--porcelain"], { cwd: cache })).stdout,
        ).not.toContain(join(root, "checkout"));
      }
    } finally {
      await worker.stop();
      if (existsSync(pidFile)) {
        const owned = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number };
        if (!recoveryProcessStopped(owned.pid)) process.kill(owned.pid, "SIGKILL");
      }
    }
  },
  30_000,
);

test("worker retains scratch when a harness directly throws a termination error", async () => {
  await listen();
  const id = await queuedLocalAgent();
  let cwd = "",
    scratch = "",
    results = 0;
  const failed = Promise.withResolvers<void>();
  const worker = await loop({
    heartbeatMs: 60_000,
    harnesses: {
      claude: fakeHarness((spec) => {
        cwd = spec.cwd;
        scratch = spec.scratchDir ?? "";
        throw new ProcessTerminationError(ProcessTerminationError.prefix);
      }),
    },
    async request(...args) {
      if (args[1].endsWith("/result")) results++;
      const reply = await workerRequest(...args);
      if (args[1] === agentPath(id, "failure")) failed.resolve();
      return reply;
    },
  });
  try {
    await failed.promise;
    await worker.stop();
    expect(results).toBe(0);
    expect(existsSync(cwd)).toBe(true);
    expect(existsSync(scratch)).toBe(true);
    const local = new Store(join(worker.remote.paths.home, "worker", "worker.db"));
    try {
      expect(local.getSetting("worker.cleanups", {})).toEqual({
        [dirname(cwd)]: {
          root: dirname(cwd),
          cache: join(dirname(cwd), "repo.git"),
          scratch: [scratch],
          discoveries: [],
          pending: [],
          ownership: expect.objectContaining({ marker: expect.any(String), runId: id }),
        },
      });
    } finally {
      local.close();
    }
  } finally {
    await worker.stop();
    // This injected error has no live process to recover.
    removeScratch(scratch);
  }
}, 30_000);

const publicationCommit = {
  message: "Worker change\n\nKeep this body.  \n# preserve this line\n",
  authorName: "Requested Author",
  authorEmail: "author@example.com",
  committerName: "Requested Committer",
  committerEmail: "committer@example.com",
};

test("worker publication fields reject malformed identities, destinations and leases", () => {
  for (const invalid of [
    { message: "bad\0message" },
    { authorName: "" },
    { committerName: "Other\nidentity" },
    { authorEmail: "missing-address" },
    { committerEmail: "name <email@example.com>" },
  ])
    expect(publicationFields.commit.safeParse({ ...publicationCommit, ...invalid }).success).toBe(false);
  for (const repoUrl of ["--help", "http://github.com/o/r.git", "https://token@github.com/o/r.git"])
    expect(publicationFields.repoUrl.safeParse(repoUrl).success).toBe(false);
  expect(publicationFields.expectedRemoteSha.safeParse("short").success).toBe(false);
  expect(publicationFields.discreet.safeParse("true").success).toBe(false);
  expect(publicationFields.uiUrl.safeParse("not-a-url").success).toBe(false);
});

test("invalid publication metadata fails only its job while another session stays active", async () => {
  await listen();
  const active = await queuedLocalAgent({ timeoutMs: 20_000 });
  const activeRequest: AgentJobRequest = JSON.parse(workers.agentJob(active)?.request ?? "{}");
  const started = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const invoked: string[] = [];
  const worker = await loop({
    harnesses: {
      claude: fakeHarness(async (spec) => {
        invoked.push(spec.prompt);
        if (spec.prompt === "Edit code") {
          started.resolve();
          await finish.promise;
        }
        return {};
      }),
    },
    tokenLookup: async () => {
      throw new Error("Unexpected token lookup");
    },
  });
  const enqueue = () =>
    enqueueAgent({
      ...activeRequest,
      prompt: "Next session",
    });
  try {
    await Promise.race([started.promise, worker.task]);
    for (const invalid of [
      { commit: { ...publicationCommit, authorName: "<invalid>" } },
      { commit: { ...publicationCommit, authorEmail: "missing-address" } },
      { commit: null },
      { repoUrl: "https://token@github.com/o/r.git" },
      { repoUrl: 42 },
      { expectedRemoteSha: "short" },
      { discreet: "true" },
      { uiUrl: "not-a-url" },
      { uiUrl: 42 },
    ]) {
      const id = enqueue();
      const req: AgentJobRequest = JSON.parse(workers.agentJob(id)?.request ?? "{}");
      store.db
        .query("UPDATE agent_jobs SET request=? WHERE id=?")
        .run(JSON.stringify({ ...req, ...invalid }), id);
      await Promise.race([until(() => !!workers.agentJob(id)?.failure_reason), worker.task]);
      expect(workers.agentJob(id)?.failure_reason).toBe("Invalid agent publication metadata");
      expect(workers.agentJob(id)?.result).toBeNull();
      expect(workers.agentJob(active)?.state).toBe("leased");
    }
    const next = enqueue();
    await Promise.race([until(() => workers.agentJob(next)?.state === "done"), worker.task]);
    expect(workers.agentJob(next)?.result_sha).toBe(workers.agentJob(active)?.parent_sha ?? "");
    expect(invoked).toEqual(["Edit code", "Next session"]);
    finish.resolve();
    await until(() => workers.agentJob(active)?.state === "done");
  } finally {
    finish.resolve();
    await worker.stop();
  }
}, 30_000);

test.each([
  "create",
  "workflows",
  "allowed workflows",
  "replace",
  "clean discreet",
  "unchanged",
  "readonly",
  "readonly legacy",
  "legacy",
  "legacy changed",
  "missing digest",
  "different digest",
  "list changed during session",
  "missing lease",
  "missing base",
  "missing ui",
  "private diff",
  "private message",
  "private ancestor message",
  "private ancestor diff",
  "private branch",
  "private published ancestor",
  "nonancestor remote",
  "private nonancestor remote",
  "discreet message",
  "discreet identity",
  "discreet ancestor",
  "discreet coordinator link",
  "discreet branch prefix",
  "discreet branch run id",
  "discreet existing branch",
  "credential",
  "credential ancestor",
  "credential branch",
  "unknown remote",
  "session committed",
  "session committed dirty",
  "HEAD inspection failure",
  "moved",
  "null existing",
  "auth failure",
  "push failure",
])(
  "worker publication: %s",
  async (kind) => {
    await listen();
    const remote = join(home, "published.git");
    const workerConfig = join(home, "publication-worker-config");
    mkdirSync(workerConfig);
    const secret = `synthetic-worker-secret-${randomBytes(16).toString("hex")}`;
    const token = `synthetic-gh-token-${randomBytes(16).toString("hex")}`;
    registerCredential("PUBLICATION_TOKEN", token);
    if (kind.startsWith("credential")) registerCredential("PUBLICATION_SECRET", secret);
    if (kind.startsWith("private")) {
      writeFileSync(join(workerConfig, "private-strings.txt"), `${secret}\n`);
      writeFileSync(join(cfg.paths.configDir, "private-strings.txt"), `${secret}\n`);
    }
    const id = await queuedLocalAgent({
      timeoutMs: 20_000,
      mode: kind.startsWith("readonly")
        ? "readonly"
        : kind === "session committed dirty"
          ? "edit"
          : undefined,
      ...(!kind.includes("legacy") && kind !== "readonly"
        ? {
            ...(kind === "allowed workflows" ? { allow: ["workflows"] as const } : {}),
            privateStringsDigest:
              kind === "missing digest"
                ? undefined
                : kind === "different digest"
                  ? "0".repeat(64)
                  : privateStringsDigest(loadPrivateStrings(workerConfig)),
            repoUrl: remote,
            expectedRemoteSha: kind === "missing lease" ? undefined : null,
            discreet: kind.includes("discreet") || kind === "private branch",
            uiUrl: kind === "missing ui" ? undefined : "https://coordinator.example.com",
            commit: {
              ...publicationCommit,
              ...(kind === "private message" ? { message: `Change\n\n${secret}\n` } : {}),
              ...(kind === "discreet message"
                ? { message: "Change\n\nCo-Authored-By: Claude Code <claude@example.com>\n" }
                : {}),
              ...(kind === "discreet identity" ? { authorName: "Limitless" } : {}),
              ...(kind === "discreet coordinator link"
                ? { message: "See https://coordinator.example.com/runs/another-run" }
                : {}),
            },
          }
        : {}),
    });
    const originalRequest: AgentJobRequest = JSON.parse(workers.agentJob(id)?.request ?? "{}");
    const source = join(home, "repo");
    const base = originalRequest.parentSha;
    let parent = base;
    if (kind.includes("ancestor")) {
      writeFileSync(
        join(source, "ancestor"),
        ["discreet ancestor", "private ancestor message"].includes(kind) ? "clean" : secret,
      );
      await sh(["git", "add", "ancestor"], { cwd: source });
      await sh(
        [
          "git",
          "commit",
          "-qm",
          kind === "private ancestor message"
            ? secret
            : kind === "discreet ancestor"
              ? "Generated by Limitless"
              : "Earlier change",
        ],
        { cwd: source },
      );
      // A net-diff scan would miss this ancestor's private blob entirely.
      await sh(["git", "rm", "ancestor"], { cwd: source });
      await sh(["git", "commit", "-qm", "Remove earlier file"], { cwd: source });
      parent = (await sh(["git", "rev-parse", "HEAD"], { cwd: source })).stdout.trim();
      await sh(["git", "fetch", source, "HEAD"], { cwd: join(cfg.paths.repos, "test__repo.git") });
    }
    const branch =
      kind === "private branch" || kind === "credential branch"
        ? `change/${secret}`
        : kind === "discreet branch prefix" || kind === "discreet existing branch"
          ? "limitless/worker-agent"
          : kind === "discreet branch run id"
            ? `change/${originalRequest.runId}`
            : "change/worker-agent";
    const expectedRemoteSha =
      kind === "private published ancestor"
        ? parent
        : kind === "unknown remote"
          ? "0".repeat(40)
          : originalRequest.expectedRemoteSha;
    store.db.query("UPDATE agent_jobs SET parent_sha=?, request=? WHERE id=?").run(
      parent,
      JSON.stringify({
        ...originalRequest,
        parentSha: parent,
        baseSha: kind === "missing base" || kind.includes("legacy") ? undefined : base,
        branch,
        expectedRemoteSha,
      }),
      id,
    );
    await sh(["git", "clone", "--bare", join(home, "repo"), remote], { cwd: home });
    const ref = `refs/heads/${branch}`;
    let remoteBefore = "";
    if (
      [
        "replace",
        "moved",
        "null existing",
        "private published ancestor",
        "discreet existing branch",
      ].includes(kind)
    ) {
      remoteBefore = parent;
      if (kind === "moved") {
        await sh(["git", "commit", "--allow-empty", "-qm", "independent change"], {
          cwd: join(home, "repo"),
        });
        remoteBefore = (await sh(["git", "rev-parse", "HEAD"], { cwd: join(home, "repo") })).stdout.trim();
        await sh(["git", "fetch", join(home, "repo"), "HEAD"], { cwd: remote });
      }
      await sh(["git", "update-ref", ref, remoteBefore], { cwd: remote });
      if (kind !== "null existing") {
        const req = JSON.parse(workers.agentJob(id)?.request ?? "{}");
        store.db
          .query("UPDATE agent_jobs SET request=? WHERE id=?")
          .run(JSON.stringify({ ...req, expectedRemoteSha: parent }), id);
      }
    }
    if (kind.endsWith("nonancestor remote")) {
      remoteBefore = (
        await sh(["git", "commit-tree", `${base}^{tree}`, "-p", base, "-m", "Independent remote head"], {
          cwd: remote,
        })
      ).stdout.trim();
      await sh(["git", "update-ref", ref, remoteBefore], { cwd: remote });
      await sh(["git", "fetch", remote, remoteBefore], { cwd: join(cfg.paths.repos, "test__repo.git") });
      const req: AgentJobRequest = JSON.parse(workers.agentJob(id)?.request ?? "{}");
      store.db
        .query("UPDATE agent_jobs SET request=? WHERE id=?")
        .run(JSON.stringify({ ...req, expectedRemoteSha: remoteBefore }), id);
    }
    const argv: string[][] = [],
      transmitted: unknown[] = [],
      commits: string[][] = [];
    let pushEnv: Record<string, string> | undefined,
      session = "",
      lookups = 0;
    const realProcess = proc.runProcess;
    const processes = spyOn(proc, "runProcess").mockImplementation((opts) => {
      argv.push(opts.cmd);
      return realProcess(opts);
    });
    const realGit = gitCommand.cacheGit;
    const push = spyOn(gitCommand, "cacheGit").mockImplementation((args, opts, guard) => {
      if (args.includes("push")) {
        pushEnv = opts.env;
        if (kind === "push failure")
          return Promise.reject(
            new Error(`push rejected ${token} ${Buffer.from(`x-access-token:${token}`).toString("base64")}`),
          );
      }
      return realGit(args, opts, guard);
    });
    const realWorktreeGit = gitCommand.worktreeGit;
    const commitSpy = spyOn(gitCommand, "worktreeGit").mockImplementation((args, opts, retry) => {
      if (kind === "HEAD inspection failure" && args.join(" ") === "git rev-parse --verify HEAD")
        return Promise.reject(new Error("Injected HEAD inspection failure"));
      if (args.includes("commit")) commits.push(args);
      return realWorktreeGit(args, opts, retry);
    });
    const sentinel = join(home, "hook-ran");
    const worker = await loop(
      {
        tokenLookup: (signal) =>
          githubToken(signal, async (opts) => {
            lookups++;
            expect(opts.cmd).toEqual(["gh", "auth", "token"]);
            expect(opts.timeoutMs).toBe(30_000);
            const result = await realProcess({ ...opts, cmd: [process.execPath, "-e", ""] });
            return { ...result, stdout: token, stderr: token, exitCode: kind === "auth failure" ? 1 : 0 };
          }),
        async request(...args) {
          if (args[1].endsWith("/events") || args[1].endsWith("/result") || args[1].endsWith("/failure"))
            transmitted.push(args[2]);
          return workerRequest(...args);
        },
        harnesses: {
          claude: fakeHarness(async (spec): Promise<FakeReply> => {
            expect(lookups).toBe(0);
            session = JSON.stringify({ spec, env: proc.agentEnv() });
            expect(session).not.toContain(token);
            if (kind === "list changed during session")
              writeFileSync(join(workerConfig, "private-strings.txt"), "changed-list-entry");
            if (kind.startsWith("session committed")) {
              writeFileSync(join(spec.cwd, "session-change"), "Session commit\n");
              await realWorktreeGit(["git", "add", "."], { cwd: spec.cwd });
              await realWorktreeGit(["git", "commit", "-qm", "Session made its own commit"], {
                cwd: spec.cwd,
              });
            }
            const hooks = join(dirname(spec.cwd), "repo.git", "hooks");
            mkdirSync(hooks, { recursive: true });
            for (const hook of ["pre-commit", "pre-push"])
              writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
            return {
              files: ["unchanged", "legacy", "session committed"].includes(kind)
                ? undefined
                : kind.includes("workflows")
                  ? { ".github/workflows/worker.yml": "on: push\njobs: {}\n" }
                  : { edited: kind === "private diff" || kind === "credential" ? secret : "new bytes\n" },
              text: token,
              status: "error",
              error: token,
            };
          }),
        },
      },
      "loop-runner",
      workerConfig,
    );
    try {
      await until(
        () => workers.agentJob(id)?.state === "done" || workers.agentJob(id)?.failure_reason !== null,
      );
      const job = workers.agentJob(id);
      const published = [
        "create",
        "allowed workflows",
        "replace",
        "clean discreet",
        "private published ancestor",
        "nonancestor remote",
        "discreet existing branch",
      ].includes(kind);
      const unchanged = ["unchanged", "readonly", "readonly legacy", "legacy"].includes(kind);
      expect(job?.result !== null).toBe(published || unchanged);
      const remoteRef = await sh(["git", "rev-parse", "--verify", ref], { cwd: remote, allowFail: true });
      const actual = remoteRef.stdout.trim();
      if (published) {
        const sha = job?.result_sha ?? "";
        expect(sha).not.toBe(parent);
        expect(actual).toBe(sha);
        expect(
          (await sh(["git", "rev-list", "--parents", "-n", "1", sha], { cwd: remote })).stdout.trim(),
        ).toBe(`${sha} ${parent}`);
        expect(
          (await sh(["git", "show", "-s", "--format=%B%x00%an%x00%ae%x00%cn%x00%ce", sha], { cwd: remote }))
            .stdout,
        ).toBe(
          `${publicationCommit.message}\0${publicationCommit.authorName}\0${publicationCommit.authorEmail}\0${publicationCommit.committerName}\0${publicationCommit.committerEmail}\n`,
        );
        expect(JSON.parse(job?.result ?? "null")).toMatchObject({
          sha,
          branch,
          status: "error",
          privateStringsDigest: originalRequest.privateStringsDigest,
        });
      } else {
        expect(actual).toBe(remoteBefore);
        if (unchanged) {
          expect(job?.result_sha).toBe(parent);
          if (originalRequest.commit)
            expect(JSON.parse(job?.result ?? "{}").privateStringsDigest).toBe(
              originalRequest.privateStringsDigest,
            );
        } else {
          const reason =
            kind === "workflows"
              ? "Allow: workflows"
              : ["missing digest", "different digest", "list changed during session"].includes(kind)
                ? "Worker private-strings list differs from the coordinator's; publication blocked"
                : kind.startsWith("private")
                  ? "private string"
                  : kind.startsWith("discreet")
                    ? "factory-marked"
                    : kind.startsWith("credential")
                      ? "credential"
                      : kind.includes("existing") || kind === "moved"
                        ? "branch moved"
                        : kind === "legacy changed" || kind.startsWith("missing")
                          ? "publication metadata"
                          : kind === "HEAD inspection failure"
                            ? "Cannot inspect worker HEAD"
                            : kind.startsWith("session committed")
                              ? "session moved HEAD"
                              : kind === "unknown remote"
                                ? "Coordinator refused worker request (400)"
                                : kind === "auth failure"
                                  ? "gh auth token failed: non-zero exit"
                                  : "withheld";
          expect(job?.failure_reason).toContain(reason);
          if (kind === "workflows") expect(job?.failure_reason).toContain(".github/workflows/worker.yml");
          if (kind === "credential branch") {
            expect(job?.failure_reason).toBe("Registered worker credential in publication; push blocked");
            expect(remoteRef.exitCode).not.toBe(0);
          }
        }
      }
      const shouldPush = published || ["moved", "null existing", "push failure"].includes(kind);
      const pushCalls = push.mock.calls.filter(([args]) => args.includes("push"));
      expect(pushCalls).toHaveLength(shouldPush ? 1 : 0);
      if (shouldPush) {
        const args = pushCalls[0]?.[0] ?? [];
        expect(args).toContain(
          `--force-with-lease=${ref}:${kind === "nonancestor remote" ? remoteBefore : ["replace", "moved", "private published ancestor", "discreet existing branch"].includes(kind) ? parent : ""}`,
        );
        expect(args.at(-1)).toMatch(new RegExp(`^[a-f0-9]{40}:${ref}$`));
        expect(args).toContain("--no-follow-tags");
        const authIndex = Number(pushEnv?.GIT_CONFIG_COUNT) - 1;
        expect(pushEnv?.[`GIT_CONFIG_KEY_${authIndex}`]).toBe("http.extraHeader");
        expect(pushEnv?.[`GIT_CONFIG_VALUE_${authIndex}`]).toBe(
          `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        );
        if (kind === "create") {
          // Exercise effective config with a lower-precedence helper that must be reset.
          const global = join(home, "push-gitconfig");
          writeFileSync(global, "[credential]\n\thelper = synthetic-helper\n");
          const env = { ...pushEnv, GIT_CONFIG_GLOBAL: global };
          const helpers = await sh(["git", "config", "--get-all", "credential.helper"], { cwd: remote, env });
          expect(helpers.stdout.endsWith("synthetic-helper\n\n")).toBe(true);
          expect(
            (await sh(["git", "config", "--get", "diff.autoRefreshIndex"], { cwd: remote, env })).stdout,
          ).toBe("false\n");
          expect(
            (
              await sh(["git", "config", "--name-only", "--get-regexp", "^http\\.extraHeader$"], {
                cwd: remote,
                env,
              })
            ).stdout,
          ).toBe("http.extraheader\n");
        }
      }
      if (kind === "unknown remote")
        expect(
          argv.filter((args) => args.includes("fetch")).some((args) => args.includes("0".repeat(40))),
        ).toBe(false);
      if (
        unchanged ||
        kind === "legacy changed" ||
        kind.startsWith("missing") ||
        kind.startsWith("session committed")
      ) {
        expect(commits).toHaveLength(0);
        expect(lookups).toBe(0);
      }
      if (["missing digest", "different digest"].includes(kind)) {
        expect(session).toBe("");
        expect(argv.some((args) => args.includes("bundle"))).toBe(false);
        expect(remoteRef.exitCode).not.toBe(0);
      }
      if (originalRequest.privateStringsDigest)
        expect(session).not.toContain(originalRequest.privateStringsDigest);
      expect(existsSync(sentinel)).toBe(false);
      expect(JSON.stringify(argv)).not.toContain(token);
      expect(JSON.stringify(argv)).not.toContain(Buffer.from(`x-access-token:${token}`).toString("base64"));
      expect(JSON.stringify(transmitted)).not.toContain(token);
      expect(JSON.stringify(transmitted)).not.toContain(
        Buffer.from(`x-access-token:${token}`).toString("base64"),
      );
      expect(JSON.stringify(job)).not.toContain(token);
      expect(JSON.stringify(transmitted)).not.toContain(secret);
      expect(JSON.stringify(process.env)).not.toContain(token);
    } finally {
      await worker.stop();
      processes.mockRestore();
      push.mockRestore();
      commitSpy.mockRestore();
    }
  },
  30_000,
);

test.each(["match", "differs", "absent", "unreadable"])(
  "heartbeat stores parity without retaining the digest (%s)",
  async (kind) => {
    const logs: string[] = [];
    await listen("127.0.0.1:0", (text) => logs.push(text));
    const token = await paired();
    const file = join(cfg.paths.configDir, "private-strings.txt");
    writeFileSync(file, "one.example\n");
    const digest = privateStringsDigest(loadPrivateStrings(cfg.paths.configDir));
    if (kind === "differs") writeFileSync(file, "two.example\n");
    if (kind === "unreadable") linkSync(file, join(home, "private-link"));
    const account = `account=${["synthetic", "worker"].join("-")}@example.com`;
    const agents = {
      claude: { version: null, loggedIn: true },
      codex: { version: null, loggedIn: true },
    };
    const body = {
      ...caps(),
      agents: {
        claude: { version: account, loggedIn: true },
        codex: { version: account, loggedIn: true },
      },
      privateStringsDigest: kind === "absent" ? undefined : digest,
    };
    const heartbeat = await call("/worker/heartbeat", body, token);
    expect(heartbeat.status).toBe(200);
    expect(JSON.stringify(heartbeat.json())).not.toContain(account);
    const row = workers.worker("runner");
    if (!row) throw new Error("Missing worker");
    expect(
      store.db
        .query<{ name: string }, []>("PRAGMA table_info(workers)")
        .all()
        .map((c) => c.name),
    ).toContain("agent_capabilities");
    const legacy = Heartbeat.omit({ agents: true, privateStringsDigest: true }).strict();
    expect(legacy.parse(JSON.parse(row.capabilities ?? "null"))).toEqual(legacy.strip().parse(caps()));
    expect(workers.available(row)).toBe(true);
    const privateStrings = kind === "match" || kind === "differs" ? kind : "unknown";
    expect(JSON.parse(row.agent_capabilities ?? "null")).toEqual({ agents, privateStrings });
    expect(workers.list()[0]).toMatchObject({
      ...(kind === "unreadable" ? {} : { agents }),
      privateStrings,
    });
    expect(JSON.stringify(row)).not.toContain(digest);
    expect(JSON.stringify(workers.list())).not.toContain(digest);
    expect(JSON.stringify(row)).not.toContain(account);
    expect(JSON.stringify(workers.list())).not.toContain(account);
    expect(JSON.stringify(logs)).not.toContain(account);
    cfg.port = 0;
    const factory = new Factory(cfg, { store, bootSha: releaseSha, models: [], providers: [] });
    const credential = createApiToken(cfg.paths.home);
    const api = await startHttp(factory, {}, Bun.serve, credential);
    try {
      const response = await fetch(`${api.url.origin}/api/workers`, {
        headers: { authorization: `Bearer ${credential.token}` },
      });
      expect(response.status).toBe(200);
      const listing = await response.text();
      expect(listing).not.toContain(digest);
      expect(listing).not.toContain(account);
      if (kind === "match") {
        const cli = await runProcess({
          cmd: [process.execPath, "src/cli/main.ts", "workers", "ls"],
          cwd: join(import.meta.dir, ".."),
          env: {
            ...process.env,
            LIMITLESS_HOME: cfg.paths.home,
            LIMITLESS_CONFIG_DIR: cfg.paths.configDir,
            LIMITLESS_URL: api.url.origin,
          },
          timeoutMs: 10_000,
        });
        expect(cli.exitCode).toBe(0);
        expect(cli.stdout.trim()).toBe(
          "runner\tavailable\tclaude:unknown\tcodex:unknown\tprivate-strings:match\tagent-jobs:0",
        );
        expect(cli.stdout).not.toContain(account);
        expect(cli.stderr).not.toContain(account);
      }
    } finally {
      await api.stop(true);
      credential.release();
    }
  },
);

test("heartbeat uses cached sanitized capabilities while a refresh is pending", async () => {
  const file = join(cfg.paths.configDir, "private-strings.txt");
  writeFileSync(file, "one.example\n");
  linkSync(file, join(home, "worker-private-link"));
  await listen();
  const { probeAgents } = await import("../src/workers/capabilities.ts");
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof probeAgents>>>();
  let probes = 0,
    beats = 0;
  const bodies: Capabilities[] = [];
  const worker = await loop({
    capabilityRefreshMs: 10,
    probeAgents: async (run, signal) =>
      ++probes === 1
        ? probeAgents(
            async (args, opts) => ({
              ...(await (run ?? capabilityRunner)(args, opts)),
              stdout: args[1] === "--version" ? "2.1.3 (Claude Code)\nuser@example.com" : "user@example.com",
            }),
            signal,
          )
        : probes === 2
          ? pending.promise
          : Promise.reject(new Error("user@example.com")),
    async request(...args) {
      if (args[1] === "/worker/heartbeat") {
        bodies.push(structuredClone(args[2]) as Capabilities);
        beats++;
      }
      return workerRequest(...args);
    },
  });
  try {
    await until(() => probes === 2 && beats >= 3);
    expect(probes).toBe(2);
    expect(bodies.every((body) => body.agents?.claude?.loggedIn)).toBe(true);
    expect(JSON.stringify(bodies)).not.toContain("user@example.com");
    expect(bodies.every((body) => body.privateStringsDigest === undefined)).toBe(true);
    pending.resolve({
      claude: { version: null, loggedIn: false },
      codex: { version: null, loggedIn: false },
    });
    await until(() => bodies.some((body) => body.agents?.claude?.loggedIn === false));
    const changedAt = beats;
    await until(() => probes >= 3 && beats >= changedAt + 2);
    expect(bodies.at(-1)?.agents?.claude?.loggedIn).toBe(false);
  } finally {
    pending.resolve({
      claude: { version: null, loggedIn: false },
      codex: { version: null, loggedIn: false },
    });
    await worker.stop();
  }
});

test.each([
  { configured: true, statusFailed: false },
  { configured: true, statusFailed: true },
  { configured: false, statusFailed: false },
])(
  "worker-local authentication covers startup, refreshed capabilities and jobs: %j",
  async ({ configured, statusFailed }) => {
    await listen();
    const token = `worker-probe-${crypto.randomUUID()}`;
    const priorToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (configured)
      writeFileSync(join(cfg.paths.configDir, "secrets.env"), `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`);
    const bodies: Capabilities[] = [];
    const transmitted: unknown[] = [];
    const diagnostics: string[] = [];
    const checks: string[][] = [];
    let versions = 0,
      harnessCalls = 0;
    const worker = await loop({
      capabilityRefreshMs: 10,
      capabilityRunner: async (args, options) => {
        if (args[1] === "--version") {
          expect(args).toHaveLength(2);
          if (args[0] !== "claude") return { exitCode: 1, stdout: "not installed" };
          return { exitCode: 0, stdout: `2.1.${++versions === 1 ? 3 : 4} (Claude Code)` };
        }
        checks.push(args);
        const supplied = options.env?.CLAUDE_CODE_OAUTH_TOKEN;
        expect(supplied).toBe(configured ? token : undefined);
        expect(args).toEqual(["claude", "auth", "status"]);
        const authenticated = !statusFailed && (!configured || supplied === token);
        return {
          exitCode: authenticated ? 0 : 1,
          stdout: authenticated ? '{"loggedIn":true}' : `Status failed: ${token}`,
        };
      },
      harnesses: {
        claude: fakeHarness((spec) => {
          harnessCalls++;
          expect(spec.claudeSubscriptionToken).toBe(configured ? token : undefined);
          return {};
        }),
      },
      log: (text) => diagnostics.push(text),
      async request(...args) {
        transmitted.push(structuredClone(args[2]));
        if (args[1] === "/worker/heartbeat") bodies.push(structuredClone(args[2]) as Capabilities);
        return workerRequest(...args);
      },
    });
    try {
      await until(() => bodies.some((body) => body.agents?.claude?.version === "2.1.4 (Claude Code)"));
      expect(bodies[0]?.agents?.claude).toEqual({ version: "2.1.3 (Claude Code)", loggedIn: !statusFailed });
      expect(bodies.at(-1)?.agents?.claude?.loggedIn).toBe(!statusFailed);
      expect(checks.length).toBeGreaterThanOrEqual(2);
      if (!statusFailed) {
        const priorChecks = checks.length;
        const id = await queuedLocalAgent();
        await until(() => workers.agentJob(id)?.state === "done" || !!workers.agentJob(id)?.failure_reason);
        expect(workers.agentJob(id)?.state).toBe("done");
        expect(checks.length).toBeGreaterThan(priorChecks);
      }
      for (const args of checks) expect(args).toEqual(["claude", "auth", "status"]);
      expect(harnessCalls).toBe(statusFailed ? 0 : 1);
      expect(JSON.stringify({ transmitted, diagnostics })).not.toContain(token);
    } finally {
      await worker.stop();
      if (priorToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = priorToken;
    }
  },
);

test.each([false, true])(
  "a logged-out session fails before checkout, is excluded and leaves provider health unchanged, token=%s",
  async (configured) => {
    await listen();
    const token = `worker-rejected-${crypto.randomUUID()}`;
    const priorToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (configured)
      writeFileSync(join(cfg.paths.configDir, "secrets.env"), `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`);
    const id = enqueueAgent({ branch: "change/login" });
    const factory = new Factory(cfg, {
      store,
      bootSha: releaseSha,
      models: [],
      providers: [
        { id: "fake", label: "Test", harness: "claude", billing: "subscription", maxConcurrent: 2 },
      ],
    });
    factory.tracker.record("fake", "unavailable");
    const snapshot = () => {
      const value = factory.tracker.status("fake");
      if (!value) throw new Error("Missing provider");
      const { updatedAt: _time, ...status } = value;
      return status;
    };
    const health = store.getProviderRow("fake"),
      status = snapshot();
    expect(health).not.toBeNull();
    expect(status.state).toBe("degraded");
    let calls = 0;
    const loginTokens: (string | undefined)[] = [];
    const failures: unknown[] = [];
    const transmitted: unknown[] = [];
    const worker = await loop({
      probeAgents: async () => ({
        claude: { version: "2.1.3 (Claude Code)", loggedIn: true },
        codex: { version: null, loggedIn: false },
      }),
      capabilityRunner: async (args, options) => {
        const supplied = options.env?.CLAUDE_CODE_OAUTH_TOKEN;
        loginTokens.push(supplied);
        expect(args).toEqual(["claude", "auth", "status"]);
        return configured
          ? supplied
            ? { exitCode: 1, stdout: "", stderr: `Status failed: ${token}` }
            : { exitCode: 0, stdout: "stored login works" }
          : { exitCode: 0, stdout: '{"loggedIn":false,"account":"user@example.com"}' };
      },
      harnesses: {
        claude: fakeHarness(() => {
          calls++;
          return {};
        }),
      },
      async request(...args) {
        transmitted.push(structuredClone(args[2]));
        if (args[1] === agentPath(id, "failure")) failures.push(args[2]);
        return workerRequest(...args);
      },
    });
    try {
      await until(() => calls > 0 || (failures.length > 0 && workers.agentJob(id)?.state === "queued"));
      expect(failures).toEqual([
        { reason: configured ? "Status failed: [redacted]" : "Worker CLI not logged in" },
      ]);
      expect(JSON.stringify(transmitted)).not.toContain(token);
      expect(loginTokens).toEqual([configured ? token : undefined]);
      expect(calls).toBe(0);
      expect(readdirSync(worker.remote.paths.work)).toEqual([]);
      expect(workers.agentJob(id)).toMatchObject({ state: "queued", excluded: '["loop-runner"]' });
      expect(store.getProviderRow("fake")).toEqual(health);
      expect(snapshot()).toEqual(status);
    } finally {
      await worker.stop();
      if (priorToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = priorToken;
    }
  },
);

test("heartbeat optional fields return only after the observed coordinator release changes", async () => {
  await listen();
  let rejected = 0,
    accepted = 0,
    modern = false,
    resumed = false;
  const worker = await loop({
    async request(...args) {
      const reply = await workerRequest(...args);
      if (args[1] !== "/worker/heartbeat") return reply;
      const body = args[2] as Capabilities;
      if (!modern && body.agents) {
        rejected++;
        return { ...reply, status: 400 };
      }
      if (!modern) {
        expect(body.agents).toBeUndefined();
        expect(body.privateStringsDigest).toBeUndefined();
        expect(body.updateWarning).toBeUndefined();
        modern = ++accepted >= 3;
      } else resumed = !!body.agents && !!body.privateStringsDigest;
      return { ...reply, json: () => ({ cancelled: [], ...(modern ? { releaseSha } : {}) }) };
    },
  });
  try {
    await until(() => resumed);
    expect(rejected).toBe(1);
  } finally {
    await worker.stop();
  }
});

test.each([
  { role: "review", mode: "edit" },
  ...["review", "implement"].flatMap((role) => [
    { role, mode: "readonly", commit: publicationCommit },
    { role, mode: "readonly", repoUrl: "https://github.com/test/repo.git" },
    { role, mode: "readonly", expectedRemoteSha: null },
    { role, mode: "readonly", expectedRemoteSha: releaseSha },
    { role, mode: "readonly", privateStringsDigest: privateStringsDigest([]) },
    { role, mode: "readonly", discreet: false },
    { role, mode: "readonly", uiUrl: "https://example.com" },
  ]),
])("worker refuses readonly publication before fetching: %j", async (fields) => {
  await listen();
  const id = enqueueAgent({
    ...fields,
    role: fields.role as AgentJobRequest["role"],
    mode: fields.mode as AgentJobRequest["mode"],
  });
  let bundles = 0;
  const harness = spyOn({ run: fakeHarness(() => ({})) }, "run");
  const worker = await loop({
    capabilityRunner: async () => ({ exitCode: 0, stdout: "logged in" }),
    harnesses: { claude: harness },
    request: async (...args) => {
      if (args[1].endsWith("/bundle")) bundles++;
      return workerRequest(...args);
    },
  });
  try {
    await until(() => workers.agentJob(id)?.failure_reason !== null);
    expect(workers.agentJob(id)?.failure_reason).toBe("Readonly jobs carry no publication fields");
    expect(bundles).toBe(0);
    expect(harness).not.toHaveBeenCalled();
    expect(readdirSync(worker.remote.paths.work)).toEqual([]);
  } finally {
    await worker.stop();
  }
});

const workerStartupCases: {
  label: string;
  error: string;
  infrastructure: boolean;
  numTurns?: number;
  failedProbe?: boolean;
  progress?: "tool_call" | "text";
}[] = [
  ...workerStartupFailures.flatMap(([label, error]) => [
    { label: `${label} before startup`, error, infrastructure: true },
    { label: `${label} after turns`, error, infrastructure: false, numTurns: 3 },
    { label: `${label} after a tool call`, error, infrastructure: false, progress: "tool_call" as const },
    { label: `${label} after model output`, error, infrastructure: false, progress: "text" as const },
  ]),
  {
    label: "failed confinement probe",
    error: "probe failed",
    infrastructure: true,
    failedProbe: true,
    numTurns: 3,
  },
  { label: "ordinary agent failure", error: "agent could not complete the task", infrastructure: false },
  {
    label: "unrelated EPERM",
    error: "API Error: EPERM: operation not permitted, mkdir '/workspace/credentials.lock'",
    infrastructure: false,
  },
  {
    label: "unrelated helper failure",
    error: "fs sandbox helper failed: invalid configuration",
    infrastructure: false,
  },
];
test.each(workerStartupCases)(
  "worker startup classification: $label",
  async ({ error, infrastructure, numTurns = 0, failedProbe = false, progress }) => {
    await listen();
    const id = await queuedLocalAgent();
    const secret = randomBytes(24).toString("hex");
    registerCredential("WORKER_STARTUP_TEST", secret);
    let results = 0;
    let transmitted = "";
    const worker = await loop({
      harnesses: {
        claude: async (spec) => ({
          ...(await fakeHarness(() => ({
            fault: "exit",
            error: `${error} ${secret}`,
            events:
              progress === "tool_call"
                ? [{ type: "tool_call", id: "read", name: "Read", input: {} }]
                : progress === "text"
                  ? [{ type: "text", text: "working" }]
                  : [],
          }))(spec)),
          numTurns,
          ...(failedProbe
            ? {
                confinement: {
                  ok: false,
                  path: null,
                  version: null,
                  reason: "probe inconclusive" as const,
                  exitCode: null,
                },
              }
            : {}),
        }),
      },
      async request(...args) {
        if (args[1] === agentPath(id, "result")) results++;
        if (args[1] === agentPath(id, "failure")) transmitted = (args[2] as { reason: string }).reason;
        return workerRequest(...args);
      },
    });
    try {
      await until(() => !!workers.agentJob(id)?.failure_reason || workers.agentJob(id)?.state === "done");
      const job = workers.agentJob(id);
      if (infrastructure) {
        expect(job).toMatchObject({
          state: "queued",
          result: null,
          result_sha: null,
          excluded: '["loop-runner"]',
        });
        expect(transmitted).toBe(`${error} [redacted]`);
        expect(job?.failure_reason).toBeTruthy();
        expect(job?.failure_reason).not.toContain(secret);
        expect(results).toBe(0);
        const token = await paired("retry");
        await call("/worker/heartbeat", caps(), token);
        expect(workers.leaseAgentJob("loop-runner")).toBeNull();
        expect(workers.leaseAgentJob("retry")?.id).toBe(id);
      } else {
        expect(results).toBe(1);
        expect(JSON.parse(job?.result ?? "null")).toMatchObject({
          status: "error",
          error: "[withheld: private text]",
        });
        expect(job?.excluded).toBe("[]");
      }
      expect(worker.controller.signal.aborted).toBe(false);
    } finally {
      await worker.stop();
    }
  },
  30_000,
);
