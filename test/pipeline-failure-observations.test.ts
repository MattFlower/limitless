import { expect, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import { WorkerStore } from "../src/db/workers.ts";
import type { ExecutionHandle, GateExecutor, GateRequest } from "../src/gates/executor.ts";
import type { GateResult, GateRun } from "../src/gates/run.ts";
import { ciSignature } from "../src/integrations/ci-classifier.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { type FaultPlan, SimulatedTermination } from "../src/pipeline/faults.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import { approve, pipelineSetup, roleOf, triage } from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";

const state = { home: "", repoDir: "", factory: null as Factory | null };
const { start } = pipelineSetup(state);
const handler: Parameters<typeof start>[0] = (s) =>
  roleOf(s) === "triage"
    ? { structured: triage({ suggested_profile: "quick" }) }
    : roleOf(s) === "review"
      ? { structured: approve }
      : { files: { "farewell.txt": "goodbye\n" } };
const auditFault = { "stage:audit:before": { action: "kill" } } satisfies FaultPlan;
let load = 3.25;
const result = (req: GateRequest, changes: Partial<GateResult> = {}): GateRun => ({
  setupOk: true,
  setup: [],
  sha: req.headSha,
  trackedClean: true,
  checks: req.gates.checks.map((c) => ({
    name: c.name,
    command: c.run,
    ok: true,
    exitCode: 0,
    durationMs: 7,
    output: "pass",
    ...changes,
  })),
});
function executor(
  f: Factory,
  kind: ExecutionHandle["kind"],
  make: (req: GateRequest, attempt: number) => GateRun,
) {
  const workers = new WorkerStore(f.store, f.deps.buildSha);
  workers.loadSource = () => load;
  const starts: ExecutionHandle[] = [],
    attaches: string[] = [];
  let attempts = 0;
  const value: GateExecutor = {
    kind,
    canResume: () => true,
    async start(req) {
      const id = kind === "local" ? crypto.randomUUID() : workers.enqueue(req, undefined, kind === "inplace");
      const h = { kind, id, startedAt: Date.now() };
      starts.push(h);
      return h;
    },
    attach(h, _signal, req) {
      if (!req) throw new Error("missing request");
      attaches.push(h.id);
      const job = kind === "local" ? null : workers.job(h.id);
      const gates = job?.result
        ? (JSON.parse(job.result) as GateRun)
        : f.store.getRun(req.runId ?? "")?.stage === "gates"
          ? make(req, ++attempts)
          : result(req);
      if (job && !job.result) {
        f.store.db
          .query("UPDATE gate_jobs SET state='leased',worker='worker-a',worker_os='linux' WHERE id=?")
          .run(h.id);
        workers.complete(h.id, gates);
      }
      return {
        result: Promise.resolve(gates),
        cancel: async () => {},
        events: { async *[Symbol.asyncIterator]() {} },
      };
    },
  };
  f.deps.gateExecutor = value;
  return { starts, attaches };
}
async function fixture(faults: FaultPlan = { ...auditFault }) {
  load = 3.25;
  const f = start(handler, false, false, { faults, loadSource: () => load });
  await f.stop();
  const run = await f.createRun({ repo: state.repoDir, prompt: "Add farewell", profile: "quick" });
  return { f, run, execute: (signal = new AbortController().signal) => executeRun(f.deps, run.id, signal) };
}

test.each([
  ["pass", null, null],
  ["timeout", "load", "rerun_passed"],
  ["setup", "setup", "no_retry"],
  ["base", "base_failure", "no_retry"],
  ["no retry", "regression", "no_retry"],
  ["retry failed", "regression", "retry_failed"],
  ["retry passed", "flaky", "retry_passed"],
  ["retry rejected", "regression", "retry_rejected"],
  ["confinement", "confinement", "rerun_failed"],
  ["skipped", null, null],
  ["reused", null, null],
] as const)("real gates stage: %s", async (scenario, cls, history) => {
  const { f, execute } = await fixture();
  executor(f, "local", (req, attempt) => {
    if (scenario === "pass") return result(req);
    if (scenario === "setup")
      return {
        ...result(req),
        setupOk: false,
        checks: [],
        setup: [
          {
            name: "setup:0",
            command: "missing",
            ok: false,
            exitCode: 127,
            durationMs: 1,
            output: "not found",
          },
        ],
      };
    if (scenario === "retry rejected" && attempt === 2)
      writeFileSync(join(req.cwd, "greeting.txt"), "gate edit\n");
    return result(req, {
      ok: ["timeout", "retry passed", "retry rejected"].includes(scenario) && attempt > 1,
      exitCode: 1,
      output: scenario === "no retry" ? "farewell.txt:1: error" : "error: failure",
      timedOut: ["timeout", "confinement"].includes(scenario) && attempt === 1,
      confinementError: scenario === "confinement",
      ...(scenario === "skipped"
        ? { docsOnly: { mode: "skipped", reason: "docs", files: [], changedPaths: [] } }
        : {}),
      ...(scenario === "reused" ? { reused: { executionId: "agent", treeHash: "tree", createdAt: 1 } } : {}),
    });
  });
  if (scenario === "base") {
    // Prepare's two failing baseline attempts are not observations.
    const attach = f.deps.gateExecutor?.attach;
    if (!attach) throw new Error("missing executor");
    f.deps.gateExecutor = {
      ...(f.deps.gateExecutor as GateExecutor),
      attach(h, signal, req, hooks) {
        if (req && f.store.getRun(req.runId ?? "")?.stage === "prepare")
          return {
            result: Promise.resolve(result(req, { ok: false, exitCode: 1, output: "base failure" })),
            cancel: async () => {},
            events: { async *[Symbol.asyncIterator]() {} },
          };
        return attach(h, signal, req, hooks);
      },
    };
  }
  expect(await execute()).toBe("running");
  const rows = f.store.failureObservations({});
  expect(rows).toHaveLength(cls ? 1 : 0);
  if (!cls) return;
  expect(rows[0]).toMatchObject({
    class: cls,
    history,
    interim: 0,
    location: "coordinator",
    os: process.platform,
    load_per_core: 3.25,
    phase: scenario === "setup" ? "setup" : "check",
  });
  expect(rows[0]?.finalized_at).toBeNumber();
});

test("failed-attempt signature and evidence redact before truncation and survive a passing retry", async () => {
  const secret = "synthetic-observation-credential";
  registerCredential("observation", secret);
  writeFileSync(
    join(state.repoDir, ".limitless.toml"),
    `[gates]\nchecks = [{ name = "check", run = "true # ${secret}" }]\n`,
  );
  await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "privacy fixture"], {
    cwd: state.repoDir,
  });
  const { f, execute } = await fixture();
  executor(f, "local", (req, attempt) =>
    result(req, {
      ok: attempt > 1,
      exitCode: attempt > 1 ? 0 : 1,
      command: req.gates.checks[0]?.run ?? "",
      output: `error: ${secret} failed\n${"x".repeat(5990)}${secret}`,
    }),
  );
  await execute();
  const row = f.store.failureObservations({})[0];
  expect(row).toBeDefined();
  expect(JSON.stringify(row)).not.toContain(secret);
  expect(row?.output_tail.length).toBeLessThanOrEqual(6000);
  expect(row?.signature).toBe(
    ciSignature(row?.name ?? "", row?.output_tail ?? "", row?.command ?? "").signature,
  );
  expect(row).toMatchObject({ class: "flaky", history: "retry_passed" });
});

for (const kind of ["local", "lan", "inplace"] as const) {
  test(`fault before evidence: ${kind} identity and replay`, async () => {
    const { f, run, execute } = await fixture({
      ...auditFault,
      "gate:executed": { action: "kill", when: (c) => c.stage === "gates" },
    });
    const first = executor(f, kind, (req) =>
      result(req, { ok: false, exitCode: 1, output: "farewell.txt:1: failed" }),
    );
    expect(await execute()).toBe("running");
    const handle = f.store.getRunState<RunState>(run.id)?.gateExecution?.handle;
    expect(handle).toBeDefined();
    expect(f.store.failureObservations({})).toEqual([]);
    // A replay keeps the load measured at completion; only a fresh local execution samples anew.
    load = 8;
    const resumed = executor(f, kind, (req) =>
      result(req, { ok: false, exitCode: 1, output: "farewell.txt:1: failed" }),
    );
    expect(await execute()).toBe("running");
    const rows = f.store.failureObservations({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.handle_kind).toBe(kind);
    expect(rows[0]?.load_per_core).toBe({ local: 8, lan: null, inplace: 3.25 }[kind]);
    if (kind === "local") {
      expect(resumed.starts).toHaveLength(1);
      expect(rows[0]?.handle_id).not.toBe(handle?.id);
    } else {
      expect(resumed.starts).toHaveLength(0);
      expect(resumed.attaches).toEqual([handle?.id ?? ""]);
      expect(rows[0]?.handle_id).toBe(handle?.id ?? "");
    }
    expect(first.starts.length).toBeGreaterThan(0);
  });
}

test.each([true, false])(
  "restart before completion finalizes every execution (passes=%s)",
  async (passes) => {
    const { f, execute } = await fixture({ ...auditFault, "stage:gates:after": { action: "kill" } });
    executor(f, "local", (req) => result(req, { ok: false, exitCode: 1, output: "farewell.txt:1: failed" }));
    expect(await execute()).toBe("running");
    expect(f.store.failureObservations({ finalized: false })).toHaveLength(1);
    executor(f, "local", (req) =>
      result(req, { ok: passes, exitCode: passes ? 0 : 1, output: "farewell.txt:1: failed" }),
    );
    expect(await execute()).toBe("running");
    const rows = f.store.failureObservations({});
    expect(rows).toHaveLength(passes ? 1 : 2);
    expect(rows[0]).toMatchObject({
      class: passes ? "flaky" : "regression",
      history: passes ? "retry_passed" : "no_retry",
      interim: 0,
    });
    expect(rows.every((r) => r.finalized_at !== null)).toBe(true);
    // A crash after completion takes the cached gates path without changing finalization.
    f.deps.faults = { ...auditFault };
    await execute();
    expect(f.store.failureObservations({})).toEqual(rows);
  },
);

test.each(["cancel", "shutdown"])(
  "result checkpoint before %s keeps evidence and resume overrides interim",
  async (reason) => {
    const controller = new AbortController();
    const { f, run, execute } = await fixture({ ...auditFault });
    executor(f, "inplace", (req) =>
      result(req, { ok: false, exitCode: 1, output: "farewell.txt:1: failed" }),
    );
    const insert = f.store.observations.insert.bind(f.store.observations);
    const spy = spyOn(f.store.observations, "insert").mockImplementation((row) => {
      insert(row);
      controller.abort(new Error(reason));
    });
    expect(await execute(controller.signal)).toBe(reason === "shutdown" ? "queued" : "cancelled");
    spy.mockRestore();
    const before = f.store.failureObservations({});
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      history: reason === "shutdown" ? null : "interrupted",
      interim: reason === "shutdown" ? 0 : 1,
    });
    if (reason === "shutdown")
      expect(f.store.getRunState<RunState>(run.id)?.gateExecution?.handle.id).toBe(before[0]?.handle_id);
    // Explicitly requeue a cancelled run as the operator's retry path does.
    f.store.updateRun(run.id, { status: "queued", error: null });
    const resumed = executor(f, "inplace", (req) => result(req));
    expect(await execute()).toBe("running");
    expect(f.store.failureObservations({})).toHaveLength(1);
    expect(f.store.failureObservations({})[0]).toMatchObject({
      class: "regression",
      interim: 0,
    });
    if (reason === "shutdown") expect(resumed.starts).toHaveLength(0);
  },
);

test.each(["remote", "legacy", "fallback", "unknown"])("execution attribution: %s", async (where) => {
  const { f, execute } = await fixture({
    ...auditFault,
    "gate:executed": {
      action: "continue",
      when: (c) => c.stage === "gates",
      onHit: (c) => {
        const h = f.store.getRunState<RunState>(c.runId)?.gateExecution?.handle;
        if (!h) throw new Error("missing execution handle");
        if (where === "legacy") f.store.db.query("UPDATE gate_jobs SET worker_os=NULL WHERE id=?").run(h.id);
        if (where === "fallback") {
          // The real fallback path: the coordinator re-runs the job and records its own load.
          const workers = new WorkerStore(f.store, f.deps.buildSha);
          workers.loadSource = () => 4.5;
          const job = workers.job(h.id);
          expect(workers.fallbackSetup(h.id, "setup")).toBe(true);
          expect(workers.complete(h.id, JSON.parse(job?.result ?? "null"), true)).toBe(true);
        }
        if (where === "unknown") f.store.db.query("UPDATE gate_jobs SET worker=NULL WHERE id=?").run(h.id);
      },
    },
  });
  executor(f, "lan", (req) => result(req, { ok: false, exitCode: 1, output: "farewell.txt:1: failed" }));
  expect(await execute()).toBe("running");
  expect(f.store.failureObservations({})[0]).toMatchObject({
    location: where === "fallback" ? "coordinator" : where === "unknown" ? null : "worker-a",
    os: where === "fallback" ? process.platform : where === "remote" ? "linux" : null,
    load_per_core: where === "fallback" ? 4.5 : null,
  });
});

test("completion checkpoint rolls classification back when its state write fails", async () => {
  const { f, run, execute } = await fixture();
  executor(f, "local", (req) => result(req, { ok: false, exitCode: 1, output: "farewell.txt:1: failed" }));
  const save = f.store.setRunState.bind(f.store);
  let interrupted = false;
  const spy = spyOn(f.store, "setRunState").mockImplementation((id, state) => {
    if (!interrupted && (state as RunState).completedChecks?.values.gates) {
      interrupted = true;
      expect(f.store.failureObservations({ finalized: true })).toHaveLength(1);
      throw new SimulatedTermination("during completion transaction");
    }
    save(id, state);
  });
  try {
    expect(await execute()).toBe("running");
  } finally {
    spy.mockRestore();
  }
  expect(interrupted).toBe(true);
  expect(f.store.failureObservations({ finalized: false })).toHaveLength(1);
  expect(f.store.getRunState<RunState>(run.id)?.completedChecks?.values.gates).toBeUndefined();
  executor(f, "local", (req) => result(req));
  expect(await execute()).toBe("running");
  expect(f.store.failureObservations({})[0]).toMatchObject({
    class: "flaky",
    history: "retry_passed",
    interim: 0,
  });
});

test("a failed evidence insert rolls back the entire execution checkpoint", async () => {
  const { f, run, execute } = await fixture();
  executor(f, "local", (req) => {
    const gates = result(req, { ok: false, exitCode: 1, output: "farewell.txt:1: failed" });
    const first = gates.checks[0];
    if (!first) throw new Error("missing check");
    gates.checks.push({ ...first, name: "second", command: "second" });
    return gates;
  });
  const insert = f.store.observations.insert.bind(f.store.observations);
  let calls = 0;
  const spy = spyOn(f.store.observations, "insert").mockImplementation((row) => {
    if (++calls === 2) throw new SimulatedTermination("during evidence transaction");
    insert(row);
  });
  try {
    expect(await execute()).toBe("running");
  } finally {
    spy.mockRestore();
  }
  expect(calls).toBe(2);
  expect(f.store.failureObservations({})).toEqual([]);
  const old = f.store.getRunState<RunState>(run.id)?.gateExecution?.handle.id;
  expect(old).toBeString();
  expect(await execute()).toBe("running");
  const rows = f.store.failureObservations({});
  expect(rows).toHaveLength(2);
  expect(rows.every((r) => r.handle_id !== old && r.finalized_at !== null)).toBe(true);
});
