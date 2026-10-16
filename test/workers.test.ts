import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { startDaemon } from "../src/cli/daemon.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { tokenHash, WorkerStore } from "../src/db/workers.ts";
import { runLocalGates } from "../src/gates/run.ts";
import { createApiToken } from "../src/server/api-token.ts";
import { startHttp } from "../src/server/http.ts";
import { startWorkerListener } from "../src/server/workers.ts";
import { privateReadPaths } from "../src/util/private-reads.ts";
import { redactCredentials, sh } from "../src/util/proc.ts";
import { pairWorker, runWorker } from "../src/workers/client.ts";
import { type Capabilities, pairingCode } from "../src/workers/protocol.ts";
import { certificate, workerRequest } from "../src/workers/tls.ts";
import { seatbeltSkip } from "./confinement.ts";
import { test } from "./read-policy-support.ts";

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
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "workers-"));
  restoreConfig = process.env.LIMITLESS_CONFIG_DIR;
  process.env.LIMITLESS_CONFIG_DIR = join(home, "config");
  mkdirSync(process.env.LIMITLESS_CONFIG_DIR);
  cfg = loadConfig({ home, configDir: process.env.LIMITLESS_CONFIG_DIR, raw: {} });
  store = new Store(cfg.paths.db);
  workers = new WorkerStore(store, releaseSha);
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
  "fresh matching workers are available; %s mismatch is shown as needs update",
  async (field) => {
    await listen();
    const wrong = await paired("wrong"),
      right = await paired("right");
    await call("/worker/heartbeat", { ...caps(), [field]: "different" }, wrong);
    await call("/worker/heartbeat", caps(), right);
    expect(workers.list().find((w) => w.name === "wrong")?.state).toBe("needs update");
    expect(workers.list().find((w) => w.name === "right")?.state).toBe("available");
  },
  30_000,
);

test("heartbeats record capabilities, cancel every reported job and become stale after thirty seconds", async () => {
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

test("removed and unknown worker routes authenticate first, and migrations create no gate jobs table", async () => {
  await listen();
  const token = await paired();
  await call("/worker/heartbeat", caps(), token);
  for (const [path, body] of [
    ["/worker/lease", {}],
    [`/worker/jobs/${crypto.randomUUID()}/bundle`, undefined],
    ["/worker/unknown", {}],
  ] as const) {
    expect((await call(path, body)).status).toBe(401);
    expect((await call(path, body, token)).status).toBe(404);
  }
  expect(store.db.query("SELECT name FROM sqlite_master WHERE name='gate_jobs'").get()).toBeNull();
}, 30_000);

async function loop(options: Parameters<typeof runWorker>[4] = {}) {
  if (!listener) throw new Error("Missing listener");
  const remote = loadConfig({ home: join(home, "remote"), configDir: cfg.paths.configDir, raw: {} });
  await pairWorker(listener.url.origin, join(remote.paths.home, "worker"), "loop-runner", (text) =>
    workers.approve(text.split(": ")[1] ?? ""),
  );
  const controller = new AbortController();
  const task = runWorker(listener.url.origin, remote, releaseSha, controller.signal, {
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

test("the worker pairs and sends only heartbeats until cleanly aborted", async () => {
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
    expect(new Set(paths)).toEqual(new Set(["/worker/pair", "/worker/pair/claim", "/worker/heartbeat"]));
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
    expect((await post("/api/workers/owner-approved/revoke", {}, false)).status).toBe(401);
    expect((await post("/api/workers/owner-approved/revoke", {})).status).toBe(200);
    expect((await call("/worker/heartbeat", caps(), token)).status).toBe(401);
  } finally {
    await owner.stop(true);
    credential.release();
    await factory.stop();
  }
}, 30_000);
