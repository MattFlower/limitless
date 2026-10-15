import { afterEach, beforeEach, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { WorkerStore } from "../src/db/workers.ts";
import { executeGate, type GateRequest, gateExecutorFor, localExecutor } from "../src/gates/executor.ts";
import { redactGateData } from "../src/gates/output.ts";
import { type GateRun, runLocalGates } from "../src/gates/run.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import { createApiToken } from "../src/server/api-token.ts";
import { startHttp } from "../src/server/http.ts";
import { startWorkerListener } from "../src/server/workers.ts";
import { privateReadPaths } from "../src/util/private-reads.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import { pairWorker, runWorker } from "../src/workers/client.ts";
import type { Capabilities } from "../src/workers/protocol.ts";
import { privateFile, workerRequest } from "../src/workers/tls.ts";
import { validRun } from "../src/workers/validation.ts";
import { fakeConfinement, seatbeltSkip } from "./confinement.ts";
import { test } from "./read-policy-support.ts";
import { seeded } from "./seeded.ts";

let home: string, cfg: Config, store: Store, workers: WorkerStore;
let listener: Awaited<ReturnType<typeof startWorkerListener>>;
let restoreConfig: string | undefined;
const releaseSha = "f".repeat(40);
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
const fixture = seeded(async (dir) => {
  await sh(["git", "init", "-q", "--template=", dir], { cwd: dir });
  writeFileSync(join(dir, "tracked"), "gate bytes\n");
  await sh(["git", "add", "."], { cwd: dir });
  await sh(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], {
    cwd: dir,
  });
  return (await sh(["git", "rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
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
async function listen(address = "127.0.0.1:0") {
  listener = await startWorkerListener(workers, cfg.paths, address, () => {});
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

test("pairing grants no access before owner approval; claims require a separate secret and revocation is immediate", async () => {
  await listen();
  const pending = (await call("/worker/pair", { name: "runner", fingerprint: "a".repeat(64) })).json() as {
    code: string;
    secret: string;
    token?: string;
  };
  expect(pending.token).toBeUndefined();
  expect((await call("/worker/pair/claim", { secret: pending.secret })).json()).toEqual({ pending: true });
  expect((await call("/worker/heartbeat", caps(), pending.code)).status).toBe(401);
  expect((await call("/worker/lease", {}, pending.secret)).status).toBe(401);
  workers.approve(pending.code);
  const { token } = (await call("/worker/pair/claim", { secret: pending.secret })).json() as {
    token: string;
  };
  expect(token).toHaveLength(64);
  expect(workers.worker("runner")?.token_hash).not.toBe(token);
  expect((await call("/worker/heartbeat", caps(), token)).status).toBe(200);
  expect((await call("/worker/heartbeat", { ...caps(), extra: 1 }, token)).status).toBe(400);
  workers.revoke("runner");
  expect((await call("/worker/heartbeat", caps(), token)).status).toBe(401);
  expect((await call("/worker/lease", {}, token)).status).toBe(401);
  for (let i = 0; i < 4; i++)
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
  const fingerprint = server.tls.fingerprint;
  await server.stop();
  listener = undefined;
  expect((await listen()).tls.fingerprint).toBe(fingerprint);
}, 30_000);

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
    const lease = (await call("/worker/lease", {}, right)).json() as { job: { id: string } };
    expect(lease.job.id).toBe(id);
    expect(workers.job(id)?.lease_expires_at).toBeGreaterThan(Date.now());
    expect((await call(`/worker/jobs/${id}/bundle`, undefined, wrong)).status).toBe(409);
    workers.cancel(id);
    expect((await call("/worker/heartbeat", caps([id]), right)).json()).toEqual({ cancelled: [id] });
  },
  30_000,
);

async function loop(options: Parameters<typeof runWorker>[4] = {}) {
  if (!listener) throw new Error("Missing listener");
  workers.times.poll = 1000;
  const remote = loadConfig({ home: join(home, "remote"), configDir: cfg.paths.configDir, raw: {} });
  await pairWorker(listener.url.origin, join(remote.paths.home, "worker"), "loop-runner", (text) =>
    workers.approve(text.split(": ")[1] ?? ""),
  );
  const controller = new AbortController();
  const task = runWorker(listener.url.origin, remote, releaseSha, controller.signal, {
    confinement: fakeConfinement,
    heartbeatMs: 250,
    retryMs: 5,
    machineState: async () => ({ onAC: true, idleSeconds: 0 }),
    ...options,
  });
  void task.catch(() => {});
  return {
    remote,
    stop: async () => {
      controller.abort();
      await task.catch((e: unknown) => {
        if (!controller.signal.aborted) throw e;
      });
    },
    task,
  };
}

test("a worker runs real checks from the exact bundle head and returns the local outcome, with output redacted", async () => {
  await listen();
  const req = await request(true),
    secret = "worker-output-credential-513";
  registerCredential("WORKER_OUTPUT_TEST", secret);
  req.gates.checks.push({ name: "privacy", run: `echo ${secret}` });
  const firstCheck = req.gates.checks[0];
  if (firstCheck) firstCheck.name = "pass\x1b[31m";
  const worker = await loop();
  const signal = AbortSignal.timeout(150_000);
  try {
    const run = await executeGate(req, signal, {}, gateExecutorFor("lan", workers, [req.repo]));
    const local = await confinementScope.run(fakeConfinement, () =>
      executeGate(req, signal, {}, localExecutor()),
    );
    expect(fields(run)).toEqual(fields(redactGateData(local)));
    expect(run.checks[0]?.name).toBe("pass");
    expect(run.checks[1]?.exitCode).toBe(7);
    expect(run.checks[0]?.output).toContain("gate bytes");
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
  }
}, 180_000);

test("a real worker setup failure completes once without infrastructure retry or local fallback", async () => {
  await listen();
  const req = await request(true);
  req.gates.setup = ["test -f tracked", "echo broken-setup; exit 9", "echo must-not-run"];
  const worker = await loop();
  try {
    const run = await confinementScope.run(fakeConfinement, () =>
      executeGate(req, AbortSignal.timeout(120_000), {}, gateExecutorFor("lan", workers, [req.repo])),
    );
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
      failure_reason: null,
    });
    expect(store.listEvents(req.runId ?? "").filter((e) => e.type === "gate")).toEqual([]);

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
      await worker.stop();
    }
  },
  30_000,
);

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
  expect(workers.job(handle.id)).toMatchObject({ state: "done", attempt: 2 });
  expect(
    store
      .listEvents(req.runId ?? "")
      .filter((e) => e.type === "gate")
      .map((e) => e.message),
  ).toEqual(["LAN infrastructure failure: Lease expired", "LAN infrastructure failure: Lease expired"]);
  expect(store.getRunState(req.runId ?? "")).toBeNull();
  expect(store.listInvocations(req.runId ?? "")).toHaveLength(0);
}, 30_000);

test("a job that no worker picks up falls back and cannot pass a failing local check", async () => {
  const req = await request();
  workers = new WorkerStore(store, releaseSha, { pickup: 0, tick: 1 });
  const result = await confinementScope.run(fakeConfinement, () =>
    executeGate(req, new AbortController().signal, {}, gateExecutorFor("lan", workers, [req.repo])),
  );
  expect(result.checks[1]?.ok).toBe(false);
  expect(workers.jobs("1=1")[0]).toMatchObject({
    state: "done",
    attempt: 2,
    failure_reason: "No worker picked up job",
  });
}, 30_000);

test.each(["sha", "extra", "missing", "schema"] as const)(
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

test.skipIf(seatbeltSkip !== null)(
  `worker credentials and coordinator TLS key are denied inside real gates (${seatbeltSkip})`,
  async () => {
    const server = await listen(),
      req = await request();
    const dir = join(home, "private");
    mkdirSync(dir);
    const files = [server.tls.keyPath, join(dir, "token"), join(dir, "fingerprint")];
    const protectedFiles = files.slice(1).map((p) => privateFile(p, "synthetic-private-file"));
    try {
      const run = await runLocalGates(
        req.cwd,
        { ...req.gates, checks: files.map((p, i) => ({ name: `deny-${i}`, run: `cat '${p}'` })) },
        new AbortController().signal,
      );
      expect(run.checks).toHaveLength(3);
      expect(run.checks.every((r) => !r.ok)).toBe(true);
      for (const p of files) expect(statSync(p).mode & 0o777).toBe(0o600);
    } finally {
      for (const p of protectedFiles) p.release();
    }
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
    }
    const repo = store.upsertRepo({
      slug: "cancel/repo",
      kind: "github",
      url: null,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "queued cancellation" });
    const job = workers.enqueue({
      runId: run.id,
      repo: repo.slug,
      cwd: home,
      headSha: releaseSha,
      baseSha: releaseSha,
      gates: { setup: [], checks: [], source: "none", protectedPaths: [] },
    });
    expect(factory.cancelRun(run.id)).toBe(true);
    expect(workers.job(job)?.state).toBe("cancelled");
    expect((await post("/api/workers/owner-approved/revoke", {}, false)).status).toBe(401);
    expect((await post("/api/workers/owner-approved/revoke", {})).status).toBe(200);
    expect((await call("/worker/heartbeat", caps(), token)).status).toBe(401);
  } finally {
    await owner.stop(true);
    credential.release();
    await factory.stop();
  }
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
  const handle = await executor.start(req, controller.signal);
  const execution = executor.attach(handle, controller.signal);
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
