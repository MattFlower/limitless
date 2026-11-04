import { afterEach, expect, spyOn, test } from "bun:test";
import { Store } from "../src/db/store.ts";
import { type StoredGateEvent, WorkerStore } from "../src/db/workers.ts";
import type { ExecutionEvent, GateRequest } from "../src/gates/executor.ts";
import { lanExecutor } from "../src/gates/lan.ts";
import { protectGateOutput } from "../src/gates/output-privacy.ts";
import type { GateRun } from "../src/gates/run.ts";
import { gateIdentities } from "../src/gates/text-privacy.ts";
import { verifier } from "../src/util/privacy-proof.ts";
import { Heartbeat } from "../src/workers/protocol.ts";
import { remoteFixture } from "./gate-remote-support.ts";

const resources: { store: Store; privacy: ReturnType<typeof remoteFixture> }[] = [];
afterEach(async () => {
  for (const { store, privacy } of resources.splice(0)) {
    store.close();
    await privacy.checker.dispose();
  }
});
async function fixture() {
  const store = new Store(":memory:"),
    privacy = remoteFixture(),
    releaseSha = "f".repeat(40);
  resources.push({ store, privacy });
  const workers = new WorkerStore(store, releaseSha, { tick: 1 });
  workers.pairingKey = "test-key";
  const pair = workers.pair("runner", "a".repeat(64), "b".repeat(64));
  workers.approve(pair.code);
  const w = workers.worker("runner");
  if (!w) throw Error("Missing worker");
  workers.heartbeat(
    w,
    {
      os: "darwin",
      osVersion: "test",
      cpuCount: 4,
      ramBytes: 1024,
      onAC: true,
      idleSeconds: 0,
      bunVersion: Bun.version,
      releaseSha,
      freeSlots: 1,
      jobs: [],
    },
    "match",
  );
  const req: GateRequest = {
    cwd: process.cwd(),
    repo: "test/repo",
    headSha: releaseSha,
    baseSha: releaseSha,
    gates: { setup: [], checks: [{ name: "test", run: "bun test" }], source: "none", protectedPaths: [] },
  };
  const executor = lanExecutor(workers, [req.repo]);
  const controller = new AbortController();
  const handle = await executor.start(req, controller.signal);
  expect(workers.lease(w.name)?.id).toBe(handle.id);
  const empty: GateRun = { setupOk: true, setup: [], checks: [] };
  const attach = () => privacy.scoped(() => executor.attach(handle, controller.signal));
  return { store, workers, privacy, controller, handle, empty, attach };
}

test("LAN setup/check events, final results and retained attempts are rechecked", async () => {
  const f = await fixture(),
    r = f.privacy.result();
  const retained = { ...r, firstAttempt: r, targetedRetry: r, retryAttempt: r };
  f.workers.event(f.handle.id, {
    type: "check",
    phase: "setup",
    result: retained,
    worker: "spoofed",
    attempt: 99,
  });
  f.workers.event(f.handle.id, { type: "check", phase: "check", result: retained });
  const job = f.workers.job(f.handle.id);
  const stored: StoredGateEvent[] = JSON.parse(job?.events ?? "[]");
  expect(stored).toHaveLength(2);
  for (const event of stored) {
    expect(event.worker).toBe("runner");
    expect(event.attempt).toBe(1);
    expect(event.worker).toBe(job?.worker);
    expect(event.attempt).toBe(job?.attempt);
  }
  const execution = f.attach(),
    events: ExecutionEvent[] = [];
  const streamed = Promise.withResolvers<void>();
  const drain = (async () => {
    for await (const e of execution.events) {
      events.push(e);
      if (events.length === 2) streamed.resolve();
    }
  })();
  await streamed.promise;
  expect(f.workers.job(f.handle.id)?.state).toBe("leased");
  expect(f.workers.complete(f.handle.id, { setupOk: true, setup: [retained], checks: [retained] })).toBe(
    true,
  );
  const run = await execution.result;
  await drain;
  const values = [
    ...run.setup,
    ...run.checks,
    ...events.flatMap((e) => (e.type === "check" ? [e.result] : [])),
  ];
  expect(values).toHaveLength(4);
  for (const item of values) {
    for (const r of [item, item.firstAttempt, item.targetedRetry, item.retryAttempt]) {
      expect(r?.textPrivacy?.output.kind).toBe("attested:lan");
      expect(
        verifier(f.privacy.registry, f.privacy.signer).verify(
          r?.textPrivacy?.output,
          "output",
          r?.output ?? "",
        ),
      ).toBe(true);
    }
  }
});

test("LAN retained events cannot use a replacement worker's matching parity", async () => {
  const f = await fixture(),
    r = f.privacy.result();
  f.workers.event(f.handle.id, { type: "check", phase: "check", result: r });
  const a = f.workers.worker("runner");
  if (!a) throw Error("Missing worker");
  const capabilities = Heartbeat.parse(JSON.parse(a.capabilities ?? "null"));
  f.workers.fail(f.handle.id, "worker disconnected");
  const pair = f.workers.pair("replacement", "c".repeat(64), "d".repeat(64));
  f.workers.approve(pair.code);
  const b = f.workers.worker("replacement");
  if (!b) throw Error("Missing replacement");
  f.workers.heartbeat(b, capabilities, "match");
  expect(f.workers.lease(b.name)?.id).toBe(f.handle.id);
  f.workers.heartbeat(a, capabilities, "differs");
  expect(f.workers.privateStringsMatch(a.name)).toBe(false);
  f.workers.event(f.handle.id, { type: "check", phase: "check", result: r });
  const stored: StoredGateEvent[] = JSON.parse(f.workers.job(f.handle.id)?.events ?? "[]");
  expect(stored.filter((e) => e.type === "check").map((e) => [e.worker, e.attempt])).toEqual([
    ["runner", 1],
    ["replacement", 2],
  ]);
  f.workers.complete(f.handle.id, f.empty);
  const execution = f.attach(),
    events: ExecutionEvent[] = [];
  for await (const event of execution.events) events.push(event);
  await execution.result;
  const checks = events.filter((e) => e.type === "check");
  expect(checks).toHaveLength(2);
  expect(checks[0]?.result.textPrivacy).toBeUndefined();
  const current = checks[1]?.result;
  expect(current?.textPrivacy?.output.kind).toBe("attested:lan");
  expect(
    verifier(f.privacy.registry, f.privacy.signer).verify(
      current?.textPrivacy?.output,
      "output",
      current?.output ?? "",
    ),
  ).toBe(true);
});

test.each(["legacy", "missing worker", "missing attempt", "worker", "attempt", "unassigned"])(
  "LAN events with %s producer metadata stay retained and unproven",
  async (scenario) => {
    const f = await fixture(),
      r = f.privacy.result();
    f.workers.event(f.handle.id, { type: "check", phase: "check", result: r });
    const stored: StoredGateEvent[] = JSON.parse(f.workers.job(f.handle.id)?.events ?? "[]");
    const event = stored[0];
    if (!event) throw Error("Missing event");
    // A matching event first populates the memo with identical text.
    stored.push({ ...event });
    if (scenario === "legacy" || scenario === "missing worker") delete event.worker;
    if (scenario === "legacy" || scenario === "missing attempt") delete event.attempt;
    if (scenario === "worker") event.worker = "other";
    if (scenario === "attempt") event.attempt = 2;
    if (scenario === "unassigned") {
      event.worker = null;
      f.store.db.query("UPDATE gate_jobs SET worker=NULL WHERE id=?").run(f.handle.id);
    }
    stored.reverse();
    f.store.db.query("UPDATE gate_jobs SET events=? WHERE id=?").run(JSON.stringify(stored), f.handle.id);
    f.workers.complete(f.handle.id, f.empty);
    const execution = f.attach(),
      events: ExecutionEvent[] = [];
    for await (const event of execution.events) events.push(event);
    await execution.result;
    expect(events).toHaveLength(2);
    const invalid = events[1];
    expect(invalid?.type === "check" ? invalid.result.textPrivacy : "missing").toBeUndefined();
    expect(JSON.parse(f.workers.job(f.handle.id)?.events ?? "[]")).toEqual(stored);
  },
);

test.each(["setup", "infrastructure"])(
  "LAN resume preserves signed local %s fallback diagnostics",
  async (kind) => {
    const f = await fixture(),
      remote = f.privacy.result();
    f.workers.event(f.handle.id, { type: "check", phase: "setup", result: remote });
    if (kind === "setup") {
      f.workers.complete(f.handle.id, { setupOk: false, setup: [{ ...remote, ok: false }], checks: [] });
      expect(f.workers.fallbackSetup(f.handle.id, remote.command)).toBe(true);
    } else {
      f.workers.fail(f.handle.id, "worker disconnected");
      f.workers.fail(f.handle.id, "no replacement worker");
    }
    const protectedOutput = await f.privacy.scoped(() =>
      protectGateOutput(
        {
          stdout: "local fallback diagnostic",
          stderr: "",
          exitCode: 1,
          signal: null,
          cancelled: false,
          timedOut: false,
          idleTimedOut: false,
          truncated: false,
          durationMs: 1,
          capture: { provenance: { kind: "complete" }, stdout: "local fallback diagnostic", stderr: "" },
        },
        gateIdentities(remote),
        { deadline: Date.now() + 120_000 },
      ),
    );
    const { remoteAttestation: _claim, ...local } = {
      ...remote,
      ...protectedOutput,
      failures: "local failure detail",
    };
    const retained = { ...local, firstAttempt: local, targetedRetry: local, retryAttempt: local };
    const run = { setupOk: true, setup: [retained], checks: [retained] };
    for (const phase of ["setup", "check"] as const)
      f.workers.event(f.handle.id, { type: "check", phase, result: retained });
    expect(f.workers.complete(f.handle.id, run, true)).toBe(true);
    const stored = f.workers.job(f.handle.id);
    const execution = f.privacy.scoped(() =>
      lanExecutor(new WorkerStore(f.store, "f".repeat(40), { tick: 1 }), []).attach(
        f.handle,
        f.controller.signal,
      ),
    );
    const events: ExecutionEvent[] = [];
    const drain = (async () => {
      for await (const event of execution.events) events.push(event);
    })();
    const resumed = await execution.result;
    await drain;
    expect(resumed).toEqual(JSON.parse(stored?.result ?? "null"));
    const checks = events.filter((event) => event.type === "check");
    expect(checks).toHaveLength(3);
    expect(checks[0]?.result.textPrivacy?.output.kind).not.toBe("complete");
    expect(checks.slice(1)).toEqual(
      JSON.parse(stored?.events ?? "[]")
        .filter((event: ExecutionEvent) => event.type === "check")
        .slice(1),
    );
    for (const result of [resumed.checks[0], ...checks.slice(1).map((event) => event.result)]) {
      expect(result?.output).toBe("local fallback diagnostic");
      expect(result?.failures).toBe("local failure detail");
      expect(
        verifier(f.privacy.registry, f.privacy.signer).verify(
          result?.textPrivacy?.output,
          "output",
          result?.output ?? "",
        ),
      ).toBe(true);
    }
  },
);

test.each(["event", "final"])(
  "LAN %s checks discard candidates if state, worker or attempt changes",
  async (path) => {
    for (const change of ["state", "worker", "attempt", "disappear"] as const) {
      const f = await fixture(),
        r = f.privacy.result({ output: "old-attempt" });
      if (path === "event") f.workers.event(f.handle.id, { type: "check", phase: "check", result: r });
      f.workers.complete(f.handle.id, path === "final" ? { ...f.empty, checks: [r] } : f.empty);
      const ready = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>();
      const original = f.privacy.checker.protectText;
      spyOn(f.privacy.checker, "protectText").mockImplementation(async (...args) => {
        const receipt = await original(...args);
        ready.resolve();
        await finish.promise;
        return receipt;
      });
      const execution = f.attach(),
        events: ExecutionEvent[] = [];
      const result = execution.result.catch(() => undefined);
      const drain = (async () => {
        try {
          for await (const e of execution.events) events.push(e);
        } catch {}
      })();
      await ready.promise;
      f.store.db
        .query("UPDATE gate_jobs SET result=?,events='[]' WHERE id=?")
        .run(JSON.stringify(f.empty), f.handle.id);
      if (change === "disappear") f.store.db.query("DELETE FROM gate_jobs WHERE id=?").run(f.handle.id);
      else
        f.store.db
          .query(
            change === "state"
              ? "UPDATE gate_jobs SET state='cancelled' WHERE id=?"
              : change === "worker"
                ? "UPDATE gate_jobs SET worker='replacement' WHERE id=?"
                : "UPDATE gate_jobs SET attempt=attempt+1 WHERE id=?",
          )
          .run(f.handle.id);
      finish.resolve();
      const run = await result;
      await drain;
      expect(events).toEqual([]);
      expect(run?.checks ?? []).toEqual([]);
    }
  },
);

test("LAN shares one deadline through events, finals and attempts; abort cancels checking", async () => {
  const f = await fixture(),
    deadlines: (number | undefined)[] = [],
    signals: (AbortSignal | undefined)[] = [];
  const r = f.privacy.result();
  f.workers.event(f.handle.id, { type: "check", phase: "setup", result: r });
  f.workers.complete(f.handle.id, {
    ...f.empty,
    checks: [{ ...r, output: "final", firstAttempt: { ...r, output: "attempt" } }],
  });
  const original = f.privacy.checker.protectText;
  spyOn(f.privacy.checker, "protectText").mockImplementation((input, control) => {
    deadlines.push(control?.deadline);
    signals.push(control?.signal);
    return original(input, control);
  });
  await f.attach().result;
  expect(deadlines.length).toBeGreaterThan(3);
  expect(new Set(deadlines).size).toBe(1);
  expect(new Set(signals).size).toBe(1);
  const cancelled = await fixture();
  cancelled.workers.complete(cancelled.handle.id, {
    ...cancelled.empty,
    checks: [cancelled.privacy.result()],
  });
  const ready = Promise.withResolvers<void>();
  spyOn(cancelled.privacy.checker, "protectText").mockImplementation(
    (_input, control) =>
      new Promise((_resolve, reject) => {
        control?.signal?.addEventListener("abort", () => reject(Error("cancelled")), { once: true });
        ready.resolve();
      }),
  );
  const execution = cancelled.attach();
  const result = execution.result.catch(() => undefined);
  await ready.promise;
  cancelled.controller.abort();
  expect(await result).toBeUndefined();
});
