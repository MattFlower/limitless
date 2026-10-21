import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import { type AgentJobRequest, WorkerStore } from "../src/db/workers.ts";
import { registerCredential } from "../src/util/proc.ts";
import type { Capabilities } from "../src/workers/protocol.ts";

const releaseSha = "f".repeat(40);
const request: AgentJobRequest = {
  runId: "run-one",
  invocationId: 12,
  parentSha: releaseSha,
  prompt: "Edit the code",
  timeoutMs: 1000,
  target: {
    modelId: "fake",
    provider: "fake",
    harness: "fake",
    model: "fake",
    vendor: "fake",
    tier: 1,
    billing: "free",
  },
};
const caps = (jobs: string[] = []): Capabilities => ({
  releaseSha,
  bunVersion: Bun.version,
  os: "darwin",
  osVersion: "test",
  cpuCount: 4,
  ramBytes: 1024,
  freeSlots: 0,
  onAC: true,
  idleSeconds: 0,
  jobs,
});
let store: Store, workers: WorkerStore, now: number;
beforeEach(() => {
  now = 1_000_000;
  store = new Store(":memory:");
  workers = new WorkerStore(store, releaseSha, {}, () => now);
  workers.pairingKey = "test-pairing-key";
});
afterEach(() => store.close());
function pair(name: string) {
  const pending = workers.pair(name, "a".repeat(64), "b".repeat(64));
  workers.approve(pending.code);
  beat(name);
}
function beat(name: string, c = caps()) {
  const w = workers.worker(name);
  if (!w) throw new Error("Missing worker");
  return workers.heartbeat(w, c);
}
function enqueue(req = request) {
  const id = workers.enqueueAgentJob(req);
  if (!id) throw new Error("Request refused");
  return id;
}

test("schema is independent, and queued and retried leased jobs survive a store reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-jobs-"));
  const path = join(dir, "store.db");
  store.close();
  store = new Store(path);
  workers = new WorkerStore(store, releaseSha, {}, () => now);
  workers.pairingKey = "test-pairing-key";
  try {
    const columns = store.db.query<{ name: string; type: string }, []>("PRAGMA table_info(agent_jobs)").all();
    expect(columns.find((c) => c.name === "invocation_id")?.type).toBe("INTEGER");
    expect(
      store.db
        .query<{ name: string }, []>("PRAGMA index_info(agent_jobs_state_created)")
        .all()
        .map((c) => c.name),
    ).toEqual(["state", "created_at"]);
    pair("one");
    pair("two");
    const leased = enqueue();
    workers.leaseAgentJob("one");
    workers.failAgentJob(leased, "First failure");
    workers.leaseAgentJob("two");
    const queued = enqueue();
    const saved = [workers.agentJob(leased), workers.agentJob(queued)];
    expect(saved[0]).toMatchObject({
      invocation_id: 12,
      parent_sha: releaseSha,
      attempt: 2,
      worker: "two",
      excluded: '["one"]',
    });
    expect(() => store.db.query("UPDATE agent_jobs SET state='invalid' WHERE id=?").run(queued)).toThrow();
    workers.sweep();
    expect(workers.jobs("1=1")).toEqual([]);
    store.close();
    store = new Store(path);
    workers = new WorkerStore(store, releaseSha, {}, () => now);
    expect([workers.agentJob(leased), workers.agentJob(queued)]).toEqual(saved);
    workers.sweepAgentJobs();
    expect([workers.agentJob(leased), workers.agentJob(queued)]).toEqual(saved);
    now += 60_001;
    workers.sweepAgentJobs();
    expect(workers.agentJob(leased)?.state).toBe("failed");
    expect(workers.agentJob(queued)).toMatchObject({ state: "queued", attempt: 2 });
  } finally {
    store.close();
    store = new Store(":memory:");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two store connections contend for one job and share persisted capacity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-race-"));
  store.close();
  store = new Store(join(dir, "store.db"));
  workers = new WorkerStore(store, releaseSha, {}, () => now);
  workers.pairingKey = "test-pairing-key";
  const second = new Store(join(dir, "store.db"));
  const competitor = new WorkerStore(second, releaseSha, {}, () => now);
  try {
    pair("one");
    pair("two");
    const id = enqueue();
    const leases = await Promise.all([
      Promise.resolve().then(() => workers.leaseAgentJob("one")),
      Promise.resolve().then(() => competitor.leaseAgentJob("two")),
    ]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    expect(workers.agentJob(id)?.worker).toBe(leases.find(Boolean)?.worker);
    const owner = workers.agentJob(id)?.worker ?? "";
    enqueue();
    enqueue();
    const secondLease = competitor.leaseAgentJob(owner);
    expect(secondLease).not.toBeNull();
    beat(owner, caps([id]));
    expect(workers.leaseAgentJob(owner)).toBeNull();
    expect(competitor.leaseAgentJob(owner)).toBeNull();
    beat(owner, caps([id, secondLease?.id ?? ""]));
    expect(competitor.leaseAgentJob(owner)).toBeNull();
  } finally {
    second.close();
    store.close();
    store = new Store(":memory:");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent capacity can be overridden and ignores gate free slots", () => {
  workers = new WorkerStore(store, releaseSha, {}, () => now, 1);
  workers.pairingKey = "test-pairing-key";
  pair("one");
  const first = enqueue();
  enqueue();
  expect(workers.leaseAgentJob("one")?.id).toBe(first);
  expect(workers.leaseAgentJob("one")).toBeNull();
  workers.completeAgentJob(first, {}, releaseSha);
  expect(workers.leaseAgentJob("one")).not.toBeNull();
});

test.each([
  "missing",
  "pending",
  "revoked",
  "stale",
  "release",
  "bun",
  "capabilities",
  "unknown coordinator",
])("ineligible agent worker: %s", (kind) => {
  if (kind !== "missing") pair("one");
  if (kind === "pending") store.db.query("UPDATE workers SET state='pending'").run();
  if (kind === "revoked") workers.revoke("one");
  if (kind === "stale") now += workers.times.fresh + 1;
  if (kind === "release") beat("one", { ...caps(), releaseSha: "other" });
  if (kind === "bun") beat("one", { ...caps(), bunVersion: "other" });
  if (kind === "capabilities") store.db.query("UPDATE workers SET capabilities=NULL").run();
  if (kind === "unknown coordinator") workers = new WorkerStore(store, undefined, {}, () => now);
  const id = enqueue();
  expect(workers.leaseAgentJob("one")).toBeNull();
  expect(workers.agentJob(id)?.state).toBe("queued");
});

test.each(["lease", "deadline", "heartbeat", "revoked", "missing", "pickup"])(
  "agent sweep bounds failures for %s",
  (kind) => {
    workers = new WorkerStore(store, releaseSha, { fresh: 1_000_000, lease: 1_000_000 }, () => now);
    workers.pairingKey = "test-pairing-key";
    pair("one");
    pair("two");
    const id = enqueue();
    if (kind !== "pickup") expect(workers.leaseAgentJob("one")?.id).toBe(id);
    if (kind === "lease") store.db.query("UPDATE agent_jobs SET lease_expires_at=? WHERE id=?").run(now, id);
    if (kind === "deadline") now += 361_000;
    if (kind === "heartbeat")
      store.db.query("UPDATE workers SET last_heartbeat_at=? WHERE name='one'").run(now - 1_000_001);
    if (kind === "revoked") workers.revoke("one");
    if (kind === "missing") store.db.query("DELETE FROM workers WHERE name='one'").run();
    if (kind === "pickup") now += workers.times.pickup;
    workers.sweepAgentJobs();
    const reasons: Record<string, string> = {
      lease: "Lease expired",
      deadline: "Attempt deadline expired",
      heartbeat: "Worker disconnected",
      revoked: "Worker disconnected or revoked",
      missing: "Worker disconnected or revoked",
      pickup: "No worker picked up job",
    };
    expect(workers.agentJob(id)).toMatchObject({
      state: "queued",
      attempt: 2,
      worker: null,
      lease_expires_at: null,
      attempt_deadline_at: null,
      failure_reason: reasons[kind],
    });
    expect(JSON.parse(workers.agentJob(id)?.excluded ?? "null")).toEqual(kind === "pickup" ? [] : ["one"]);
    if (["lease", "deadline"].includes(kind)) expect(workers.leaseAgentJob("one")).toBeNull();
    beat("two");
    expect(workers.leaseAgentJob("two")?.id).toBe(id);
    workers.failAgentJob(id, "Second failure");
    const terminal = workers.agentJob(id);
    expect(terminal).toMatchObject({ state: "failed", attempt: 2, worker: null });
    expect(JSON.parse(terminal?.excluded ?? "null")).toContain("two");
    workers.failAgentJob(id, "Third failure");
    now += 1_000_000;
    workers.sweepAgentJobs();
    expect(workers.agentJob(id)).toEqual(terminal);
  },
);

test("mixed heartbeats renew both tables, preserve deadlines and reject lost ownership", () => {
  workers = new WorkerStore(store, releaseSha, { fresh: 1_000_000, lease: 1_000_000 }, () => now);
  workers.pairingKey = "test-pairing-key";
  pair("one");
  pair("two");
  const gate = workers.enqueue({
    runId: request.runId,
    repo: "owner/repo",
    cwd: ".",
    baseSha: releaseSha,
    headSha: releaseSha,
    gates: { setup: [], checks: [], source: "none", protectedPaths: [] },
  });
  beat("one", { ...caps(), freeSlots: 1 });
  expect(workers.lease("one")?.id).toBe(gate);
  const agent = enqueue(),
    foreign = enqueue();
  workers.leaseAgentJob("one");
  workers.leaseAgentJob("two");
  const deadline = workers.agentJob(agent)?.attempt_deadline_at;
  const gateDeadline = workers.job(gate)?.attempt_deadline_at;
  const unknown = randomUUID();
  now += 10;
  expect(beat("one", caps([gate, agent, foreign, unknown])).cancelled).toEqual([foreign, unknown]);
  expect(workers.agentJob(agent)).toMatchObject({
    lease_expires_at: deadline,
    attempt_deadline_at: deadline,
  });
  expect(workers.job(gate)).toMatchObject({
    lease_expires_at: gateDeadline,
    attempt_deadline_at: gateDeadline,
  });
  expect(workers.holdsAgentJob(agent, "two")).toBeNull();
  expect(workers.holdsAgentJob(agent, "one")?.id).toBe(agent);
  now += 361_000;
  expect(beat("one", caps([agent, gate])).cancelled).toEqual([agent, gate]);
  expect(workers.holdsAgentJob(agent, "one")).toBeNull();
});

test("heartbeats extend a live lease but cannot revive an expired lease", () => {
  pair("one");
  const id = enqueue();
  workers.leaseAgentJob("one");
  const expiry = workers.agentJob(id)?.lease_expires_at ?? 0;
  now += 20_000;
  expect(beat("one", caps([id])).cancelled).toEqual([]);
  expect(workers.agentJob(id)?.lease_expires_at).toBe(expiry + 20_000);
  now += workers.times.lease;
  expect(beat("one", caps([id])).cancelled).toEqual([id]);
  expect(workers.agentJob(id)).toMatchObject({
    state: "queued",
    attempt: 2,
    failure_reason: "Lease expired",
  });
});

test("completion and cancellation are conditional and sanitize persisted diagnostics", () => {
  pair("one");
  const id = enqueue();
  expect(workers.completeAgentJob(id, {}, releaseSha)).toBe(false);
  workers.leaseAgentJob("one");
  const secret = randomBytes(20).toString("hex");
  registerCredential("AGENT_TEST_RESULT", secret);
  expect(workers.completeAgentJob(id, { text: secret }, releaseSha)).toBe(true);
  const saved = workers.agentJob(id);
  expect(saved).toMatchObject({ state: "done", result_sha: releaseSha });
  expect(saved?.result).not.toContain(secret);
  expect(workers.completeAgentJob(id, { different: true }, "other")).toBe(false);
  workers.cancelAgentJob(id);
  workers.cancelRunAgentJobs(request.runId);
  expect(workers.agentJob(id)).toEqual(saved);
  const failed = enqueue();
  workers.failAgentJob(failed, secret);
  workers.failAgentJob(failed, secret);
  expect(workers.agentJob(failed)?.failure_reason).not.toContain(secret);
  expect(workers.completeAgentJob(failed, {}, releaseSha)).toBe(false);
  workers.cancelAgentJob(failed);
  const cancelled = workers.agentJob(failed);
  now++;
  workers.cancelAgentJob(failed);
  expect(workers.agentJob(failed)).toEqual(cancelled);
  expect(workers.completeAgentJob(failed, {}, releaseSha)).toBe(false);
  expect(workers.completeAgentJob("missing", {}, releaseSha)).toBe(false);
});

test("credential-bearing requests are refused before persistence without modifying executable inputs", () => {
  for (const field of ["backend", "openai", "decisions"] as const) {
    expect(
      workers.enqueueAgentJob({
        ...request,
        target: {
          ...request.target,
          [field]: { baseUrl: "https://example.com", authToken: "unregistered-token" },
        },
      }),
    ).toBeNull();
  }
  const secret = `credential-${randomBytes(20).toString("hex")}\nend`;
  registerCredential("AGENT_TEST_REQUEST", secret);
  expect(workers.enqueueAgentJob({ ...request, prompt: `Execute ${secret}` })).toBeNull();
  expect(store.db.query("SELECT * FROM agent_jobs").all()).toEqual([]);
  expect(store.listEvents(request.runId)).toEqual([]);
  const id = enqueue();
  expect(JSON.parse(workers.agentJob(id)?.request ?? "null")).toEqual(request);
});

test("agent deadlines retain the maximum timer bound, and queued retries expire twice", () => {
  pair("one");
  const long = enqueue({ ...request, timeoutMs: Number.MAX_SAFE_INTEGER });
  expect(workers.leaseAgentJob("one")?.attempt_deadline_at).toBe(now + 2_147_483_647);
  workers.cancelAgentJob(long);
  const queued = enqueue();
  now += workers.times.pickup;
  workers.sweepAgentJobs();
  expect(workers.agentJob(queued)).toMatchObject({ state: "queued", attempt: 2, updated_at: now });
  now += workers.times.pickup;
  workers.sweepAgentJobs();
  expect(workers.agentJob(queued)).toMatchObject({ state: "failed", attempt: 2 });
});
