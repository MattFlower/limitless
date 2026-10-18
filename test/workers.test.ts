import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { startDaemon } from "../src/cli/daemon.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { tokenHash, WorkerStore } from "../src/db/workers.ts";
import {
  executeGate,
  type GateRequest,
  type GateRunner,
  gateExecutorFor,
  localExecutor,
} from "../src/gates/executor.ts";
import { redactGateData } from "../src/gates/output.ts";
import {
  compareGates,
  type GateRun,
  retryBaselineFailures,
  retryFailures,
  retryRegressions,
  runLocalGates,
} from "../src/gates/run.ts";
import { gateSlots } from "../src/gates/slots.ts";
import { worktreeGit } from "../src/git/command.ts";
import { withRepoLock } from "../src/git/repos.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { runGateExecution } from "../src/pipeline/gate-execution.ts";
import { createApiToken } from "../src/server/api-token.ts";
import { startHttp } from "../src/server/http.ts";
import { startWorkerListener } from "../src/server/workers.ts";
import { privateReadPaths } from "../src/util/private-reads.ts";
import { redactCredentials, registerCredential, sh } from "../src/util/proc.ts";
import { pairWorker, runWorker } from "../src/workers/client.ts";
import { type Capabilities, pairingCode } from "../src/workers/protocol.ts";
import { certificate, workerRequest } from "../src/workers/tls.ts";
import { attemptBudget, credentialBearing, validRun } from "../src/workers/validation.ts";
import { fakeConfinement, seatbeltSkip } from "./confinement.ts";
import { test } from "./read-policy-support.ts";
import { seeded } from "./seeded.ts";

let home: string, cfg: Config, store: Store, workers: WorkerStore;
let listener: Awaited<ReturnType<typeof startWorkerListener>>;
let restoreConfig: string | undefined;
const releaseSha = "f".repeat(40);
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
    let localStarts = 0;
    const run = await confinementScope.run(
      {
        ...fakeConfinement,
        async verify(_roots, opts) {
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
    expect(warning).toContain("Worker runner setup failed");
    expect(warning).toContain("[withheld: private text]");
    expect(warning).toContain("falling back to local execution");
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

test("the latest worker setup warning survives an older fallback finishing later", async () => {
  const req = await request();
  const first = await failedWorkerSetup(req);
  const failed: GateRun = JSON.parse(workers.job(first.id)?.result ?? "null");
  expect(workers.fallbackSetup(first.id, "test -f tracked")).toBe(true);
  const command = "test -f newer-setup";
  const second = workers.enqueue({ ...req, gates: { ...req.gates, setup: [command] } });
  expect(workers.lease("runner")?.id).toBe(second);
  workers.complete(second, { ...failed, setup: failed.setup.map((r) => ({ ...r, command })) });
  expect(workers.fallbackSetup(second, command)).toBe(true);
  expect(workers.complete(first.id, { setupOk: true, setup: [], checks: [] }, true)).toBe(true);
  expect(new WorkerStore(store, releaseSha).list()[0]?.setupWarning).toContain("test -f newer-setup");
  expect(workers.fallbackSetup(first.id, "test -f tracked")).toBe(false);
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
      expect(workers.lease("runner")).toBeNull();
      expect(executor.attach(handle, new AbortController().signal)).toBe(execution);
      if (mode === "stored cancel") workers.cancel(handle.id);
      else controller.abort(new Error(mode));
      release.resolve();
      await expect(execution.result).rejects.toThrow();
      expect(workers.job(handle.id)?.state).toBe(mode === "shutdown" ? "failed" : "cancelled");
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
        const events: { type: string; text?: string }[] = JSON.parse(workers.job(handle.id)?.events ?? "[]");
        expect(events.filter((e) => e.text?.includes("Worker runner setup failed"))).toHaveLength(1);
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
    expect((await call("/worker/lease", {}, wrong)).json()).toEqual({ job: null });
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
    expect((await call("/worker/heartbeat", caps([id]), right)).json()).toEqual({ cancelled: [id] });
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
  expect((await call("/worker/heartbeat", caps([id]), token)).json()).toEqual({ cancelled: [id] });
  expect(workers.list()[0]).toMatchObject({
    state: "available",
    lastHeartbeatAt: now,
    capabilities: caps([id]),
  });
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
  expect((await call("/worker/lease", {}, token)).json()).toEqual({ job: null });
  expect((await call("/worker/unknown", {}, token)).status).toBe(404);
  expect(store.db.query("SELECT COUNT(*) n FROM gate_jobs").get()).toEqual({ n: 0 });
}, 30_000);

async function loop(options: Parameters<typeof runWorker>[4] = {}, name = "loop-runner") {
  if (!listener) throw new Error("Missing listener");
  const remote = loadConfig({
    home: join(home, name === "loop-runner" ? "remote" : name),
    configDir: cfg.paths.configDir,
    raw: {},
  });
  await pairWorker(listener.url.origin, join(remote.paths.home, "worker"), name, (text) =>
    workers.approve(text.split(": ")[1] ?? ""),
  );
  const controller = new AbortController();
  const task = runWorker(listener.url.origin, remote, releaseSha, controller.signal, {
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
    expect(factory.cancelRun(req.runId ?? "")).toBe(true);
    expect(workers.job(id)?.state).toBe("cancelled");
    const warningJob = workers.enqueue(req);
    expect(workers.lease("owner-approved")?.id).toBe(warningJob);
    workers.complete(warningJob, { setupOk: false, setup: [], checks: [] });
    workers.fallbackSetup(warningJob, "test -f tracked");
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
        },
      },
      () => executeGate(req, AbortSignal.timeout(120_000), {}, gateExecutorFor("lan", workers, [req.repo])),
    );
    expect(localStarts).toBe(1);
    expect(run.setupOk).toBe(false);
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
        const retried = await retryBaselineFailures(first, req.cwd, req.gates, ctx.signal, undefined, retry);
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

test.each(["done", "cancelled", "failed"] as const)(
  "worker stops reporting a %s job while repository cleanup is blocked",
  async (state) => {
    await listen();
    const req = await request(true);
    req.gates.setup = [];
    req.gates.checks = [{ name: "check", run: "true" }];
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      finished = Promise.withResolvers<void>();
    const reports = new Map(
      ["/worker/heartbeat", "/worker/lease"].map((path) => [path, Promise.withResolvers<string[]>()]),
    );
    let lock: Promise<void> | undefined,
      terminal = false;
    const id = workers.enqueue(req);
    const worker = await loop({
      confinement: {
        ...fakeConfinement,
        async verify(_roots, opts) {
          // Hold cleanup at the real cache lock, after bundle import has released it.
          const cache = join(home, "remote", "repos", `${encodeURIComponent(req.repo)}.git`);
          lock = withRepoLock(cache, async () => {
            locked.resolve();
            await release.promise;
          });
          await locked.promise;
          if (state === "failed") throw new Error("Worker execution failed");
          if (state === "cancelled") {
            workers.cancel(id);
            await new Promise<void>((resolve) =>
              opts.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
            terminal = true;
            finished.resolve();
            opts.signal?.throwIfAborted();
          }
        },
      },
      async request(...args) {
        const [_, path, body] = args;
        if (terminal && reports.has(path)) reports.get(path)?.resolve((body as { jobs: string[] }).jobs);
        const reply = await workerRequest(...args);
        if (path.endsWith("/result") || path.endsWith("/failure")) {
          terminal = true;
          finished.resolve();
        }
        return reply;
      },
    });
    try {
      await finished.promise;
      for (const report of reports.values()) expect(await report.promise).not.toContain(id);
      expect(workers.job(id)?.state).toBe(state === "failed" ? "queued" : state);
      // The worker must still await cleanup when shutting down.
      let stopped = false;
      worker.controller.abort();
      const stopping = worker.task.then(() => {
        stopped = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      release.resolve();
      await stopping;
    } finally {
      release.resolve();
      await worker.stop();
      await lock;
    }
  },
  30_000,
);

test("a worker survives connection failures, 503s and a coordinator restart with its job still running", async () => {
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
    confinement: {
      ...fakeConfinement,
      async verify(_roots, opts) {
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
      executeGate(req, AbortSignal.timeout(120_000), {}, gateExecutorFor("lan", workers, [req.repo]), handle),
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
}, 150_000);

test("repos without opt-in use local execution without creating jobs", async () => {
  const req = await request();
  const result = await confinementScope.run(fakeConfinement, () =>
    executeGate(req, new AbortController().signal, {}, gateExecutorFor("lan", workers, [])),
  );
  expect(result.checks[1]?.exitCode).toBe(7);
  expect(workers.jobs("1=1")).toHaveLength(0);
}, 30_000);

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
  expect((await call("/worker/heartbeat", caps([handle.id]), a)).json()).toEqual({ cancelled: [handle.id] });
  expect((await call("/worker/lease", {}, a)).json()).toEqual({ job: null });
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
    const check = { name: "test", run: "full-test" };
    req.gates = { ...req.gates, setup: [], checks: [check], retryFiles: "base-retry {files}" };
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
    expect(calls).toEqual(complete === true ? ["base-retry './test/a.test.ts'"] : []);
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
    cancelled: [handle.id],
  });
  expect((await call("/worker/heartbeat", caps([handle.id]), token)).json()).toEqual({
    cancelled: [handle.id],
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
  expect((await call("/worker/heartbeat", caps([id]), token)).json()).toEqual({ cancelled: [id] });
}, 30_000);

test("cancelling execution aborts the worker's running gate on a held-job reply", async () => {
  await listen();
  const req = await request(true);
  req.gates.setup = [];
  req.gates.checks = [{ name: "waiting", run: "echo $$ > gate.pid; exec sleep 900" }];
  const started = Promise.withResolvers<{ signal: AbortSignal; cwd: string }>(),
    stopped = Promise.withResolvers<void>();
  const cancelledReply = Promise.withResolvers<void>();
  let id = "";
  const worker = await loop({
    confinement: {
      ...fakeConfinement,
      async verify(_roots, opts) {
        if (!opts.signal) throw new Error("Missing job signal");
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
    while (!existsSync(join(cwd, "gate.pid"))) {
      if (Date.now() > deadline) throw new Error("Worker gate did not start");
      await Bun.sleep(10);
    }
    const pid = Number(readFileSync(join(cwd, "gate.pid"), "utf8").trim());
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
  } finally {
    controller.abort();
    await worker.stop();
    await result.catch(() => {});
  }
}, 30_000);

test.skipIf(seatbeltSkip !== null)(
  `worker gates cannot read their token, pin or coordinator TLS key (${seatbeltSkip})`,
  async () => {
    const server = await listen(),
      req = await request(true);
    const worker = await loop({ confinement: undefined });
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
        expect(check.output).toMatch(/Operation not permitted|Permission denied/);
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
  expect(reply.json()).toEqual({ job: null });
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
  expect(workers.heartbeat(worker, caps([id]))).toEqual({ cancelled: [] });
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
  expect((await call("/worker/lease", {}, token)).json()).toEqual({ job: null });
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
    expect(reply.json()).toEqual({ job: null });
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
      expect(cancelled).toEqual({ job: null, cancelled: ids.slice(0, Math.min(count, 3)) });
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
    diagnostics: string[] = [];
  const command = await import("../src/git/command.ts"),
    original = command.worktreeGit;
  let failRemoval = false;
  const spy = spyOn(command, "worktreeGit").mockImplementation(async (args, options) => {
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
        if (!checkouts.includes(opts.cwd)) {
          checkouts.push(opts.cwd);
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
    expect(workers.jobs("1=1").every((j) => j.state === "done" && j.attempt === 1)).toBe(true);
    expect(statSync(outside).mode & 0o777).toBe(0o500);
  } finally {
    await worker.stop();
    spy.mockRestore();
    chmodSync(outside, 0o700);
  }
}, 60_000);

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
