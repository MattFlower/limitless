import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { ExecutionHandle, GateExecutor, GateRequest } from "../src/gates/executor.ts";
import { localExecutor } from "../src/gates/executor.ts";
import type { GateRun } from "../src/gates/run.ts";
import { gateSlots } from "../src/gates/slots.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import { LandQueue } from "../src/land/queue.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { deferred } from "./evals-support.ts";
import { approve, type Handler, pipelineSetup, roleOf, triage, waitFor } from "./pipeline-support.ts";

const fixture: { home: string; repoDir: string; factory: Factory | null } = {
  home: "",
  repoDir: "",
  factory: null,
};
const { start } = pipelineSetup(fixture);
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
    attach(h) {
      attaches.push(h);
      const req = requests.get(h.id) ?? request(fixture.repoDir);
      return { result: onAttach(h, req), events: { async *[Symbol.asyncIterator]() {} }, async cancel() {} };
    },
  };
  return { executor, starts, attaches, requests };
}

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
  "restart reattaches the exact pending %s handle",
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
    const fresh = fake(async (h, req) =>
      result(h.id === handle?.id ? (scripted.requests.get(h.id) ?? req) : req),
    );
    const resumed = start(handler, false, false, { gateExecutor: fresh.executor });
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(fresh.attaches[0]).toEqual(handle);
    expect(fresh.starts).toHaveLength(purpose === "baseline-retry" ? 1 : 0);
    expect(resumed.store.getRunState<RunState>(run.id)?.gateExecution).toBeUndefined();
    if (purpose === "regression-retry")
      expect(resumed.store.getRunState<RunState>(run.id)?.lastGates?.[0]).toMatchObject({
        verdict: "flaky",
        firstAttempt: { ok: false },
      });
    if (purpose === "timeout") expect(resumed.store.getRunState<RunState>(run.id)?.gateTimeoutReruns).toBe(1);
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
    const execution = executor.attach(JSON.parse(JSON.stringify(handle)), signal);
    expect(executor.attach(handle, signal)).toBe(execution);
    expect((await execution.result).checks[0]?.ok).toBe(true);
    const events = [];
    for await (const event of execution.events) events.push(event);
    expect(events).toMatchObject([{ type: "check", result: { name: "check", ok: true } }]);
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

test("landing checks consume the injected executor result", async () => {
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
  const blocked = deferred<void>();
  const scripted = fake(async (_h, req) => result(req, false));
  const queue = new LandQueue({
    store: f.store,
    paths: f.deps.cfg.paths,
    confinement: fakeConfinement,
    gateExecutor: scripted.executor,
    client: async () => ({
      url: prUrl,
      headRefOid: sha,
      state: "OPEN",
      mergedAt: null,
      mergedBy: null,
      ci: "SUCCESS",
      failing: [],
    }),
    gh: async () => {
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
    expect(scripted.starts).toHaveLength(1);
    expect(scripted.attaches).toEqual(scripted.starts);
    expect(scripted.requests.get("1")).toMatchObject({ repo: repo.slug, baseSha: sha, headSha: sha });
  } finally {
    await queue.stop();
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
      { name: "pending", run: "sleep 900" },
    ],
  };
  const handle = await executor.start(req, controller.signal);
  await confinementScope.run(fakeConfinement, async () => {
    const execution = executor.attach(handle, new AbortController().signal);
    try {
      const event = await execution.events[Symbol.asyncIterator]().next();
      expect(event.value).toMatchObject({ type: "check", result: { name: "first", ok: true } });
    } finally {
      controller.abort();
    }
    const completed = await execution.result;
    expect(completed.checks.length).toBeLessThanOrEqual(2);
    expect(completed.checks.find((c) => c.name === "pending")?.ok ?? false).toBe(false);
    await execution.cancel();
  });
});
