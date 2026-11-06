import { afterEach, expect, mock, setDefaultTimeout, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { CreateRunRequest, Run } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import * as repos from "../src/git/repos.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { createClaimClient, parseRecord } from "../src/integrations/claim-ref.ts";
import { controlKey } from "../src/integrations/control-record.ts";
import { createControlStore } from "../src/integrations/control-store.ts";
import { createLeaseManager } from "../src/integrations/leases.ts";
import { parsePointer } from "../src/pipeline/checkpoint-settlement.ts";
import { localCheckpointer, NeedsHumanError, RunContext, type RunState } from "../src/pipeline/context.ts";
import { untilAborted } from "../src/pipeline/faults.ts";
import { claimKey, claimRef, parseManifest } from "../src/pipeline/portable.ts";
import { createRunObjectExporter } from "../src/pipeline/run-object-export.ts";
import { createRunObjectValidator } from "../src/pipeline/run-object-quarantine.ts";
import { createRunTransfer } from "../src/pipeline/run-transfer.ts";
import { receiptDescriptors } from "../src/pipeline/run-transfer-integrity.ts";
import type { SharedRuntime } from "../src/pipeline/shared-admission.ts";
import { authorityFor, executionClaim } from "../src/pipeline/shared-authority.ts";
import { createCheckpointCommitter, sharedCheckpointer } from "../src/pipeline/shared-checkpointer.ts";
import { LEASE } from "../src/util/claim-clock.ts";
import { sh } from "../src/util/proc.ts";
import { GitHub } from "./claim-github-fake.ts";
import { fakeConfinement } from "./confinement.ts";
import { fixture as memberFixture } from "./member-support.ts";
import {
  approve,
  holdout,
  models,
  pass,
  policy,
  providers,
  roleOf,
  spec,
  triage,
} from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";
import { seeded } from "./seeded.ts";
import { Remote } from "./shared-store-fake.ts";
import { testWaits } from "./wait-support.ts";

setDefaultTimeout(30_000);
const waits = testWaits();
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  mock.restore();
});
const seed = seeded(async (root) => {
  writeFileSync(join(root, "hello.txt"), "hello\n");
  await sh(["git", "init", "-q", "-b", "main"], { cwd: root });
  await sh(["git", "add", "."], { cwd: root });
  await sh(["git", "commit", "-qm", "seed"], { cwd: root });
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(shared = true, withRuntime = true) {
  spyOn(repos, "createPullRequest").mockResolvedValue("https://github.com/example/project/pull/1");
  spyOn(repos, "findPullRequest").mockResolvedValue(null);
  const root = mkdtempSync(join(tmpdir(), "shared-wiring-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, "target");
  mkdirSync(target);
  await seed(target);
  const cfg = loadConfig({
    home: join(root, "data"),
    configDir: join(root, "cfg"),
    raw: { repos: { "example/project": { shared } } },
  });
  cfg.maxConcurrentRuns = 0;
  cfg.maxLoadPerCore = 0;
  cfg.reviewSamples = 1;
  const store = new Store(cfg.paths.db);
  cleanup.push(() => store.close());
  const repo = store.upsertRepo({
    slug: "example/project",
    kind: "github",
    url: target,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const gh = new GitHub(),
    remote = new Remote(),
    blobs = remote.client();
  const member = "m-0123456789abcdef";
  let now = Date.now();
  const tasks = new Map<object, { fn(): unknown; ms: number; repeat: boolean }>();
  const timer = {
    set(fn: () => unknown, ms: number, repeat = false) {
      const h = {};
      tasks.set(h, { fn, ms, repeat });
      return h;
    },
    clear(h: unknown) {
      tasks.delete(h as object);
    },
  };
  const sample = () => ({ inclusive: now, exclusive: now });
  const claims = createClaimClient({ gh: gh.gh, sample });
  const c = memberFixture();
  const control = createControlStore({ ...c, claims, blobs, actor: () => ({ kind: "member", id: member }) });
  const objects = {
    export: createRunObjectExporter({ scratchRoot: root }),
    validate: createRunObjectValidator({ scratchRoot: root }),
  };
  const transfer = createRunTransfer({
    source: store,
    key: blobs.newKey,
    objects,
    manifestContext: ({ run, state }) => {
      const key = claimKey(run, store);
      if ("none" in key) throw new Error("fixture key");
      return {
        manifest: {
          schema: 3,
          runId: run.id,
          key,
          generation: 1,
          sequence: 0,
          previous: null,
          baseSha: run.baseSha,
          headSha: run.headSha,
          phase: state.phase,
          round: state.round,
          createdBy: member,
          effects: [],
          blobs: {
            state: { key: "0".repeat(32), digest: "0".repeat(64), size: 0 },
            objects: [],
            artifacts: [],
          },
        },
      };
    },
  });
  const trace: string[] = [],
    localTrace: unknown[] = [];
  const local = localCheckpointer(store);
  const recording = {
    writeState: (...args: Parameters<typeof local.writeState>) => {
      localTrace.push(["state"]);
      if (
        args[1].holdoutStatus === "complete" &&
        store.getRunState<RunState>(args[0])?.holdoutStatus !== "complete"
      )
        trace.push("holdout:complete");
      return local.writeState(...args);
    },
    writeRun: (...args: Parameters<typeof local.writeRun>) => {
      localTrace.push(["run", Object.keys(args[1]), args[1].status, !!args[2]]);
      return local.writeRun(...args);
    },
    checkpoint: (...args: Parameters<typeof local.checkpoint>) => {
      localTrace.push(["checkpoint", args[1]]);
      return local.checkpoint(...args);
    },
  };
  let failSequence = 0;
  async function runtime(): Promise<SharedRuntime> {
    const leases = await createLeaseManager({
      store,
      client: claims,
      member,
      clock: { sample },
      gh: async (args, _signal, _stdin, repoSlug) => {
        expect(args).toEqual(["api", "--include", "rate_limit"]);
        expect(repoSlug).toBe(repo.slug);
        return `HTTP/2 200 OK\r\nDate: ${new Date(gh.clock).toUTCString()}\r\n\r\n{}`;
      },
      timer: {
        set: ((fn: () => unknown, ms: number) => timer.set(fn, ms, true)) as typeof setInterval,
        clear: timer.clear as typeof clearInterval,
      },
    });
    const update = leases.update;
    spyOn(leases, "update").mockImplementation(async (...args) => {
      const pointer = args[1].checkpoint;
      const sequence = pointer ? store.checkpointRecord(args[0].run)?.pending?.sequence : undefined;
      if (sequence === failSequence) {
        trace.push(`wait:${sequence}`);
        return "wait";
      }
      const result = await update(...args);
      if (result === "applied" && sequence) trace.push(`commit:${sequence}`);
      return result;
    });
    const committer = createCheckpointCommitter({
      store,
      paths: cfg.paths,
      member,
      transfer,
      blobs,
      leases,
      claims,
    });
    const rt: SharedRuntime = {
      member,
      leases,
      claims,
      blobs,
      control,
      namer: c.namer,
      committer,
      checkpointer: local,
      clock: { now: () => now, timer },
      gate: { admit: mock(async () => []), canContinue: async () => [], capableNow: () => true, forget() {} },
    };
    const checkpointer = sharedCheckpointer(
      recording,
      committer,
      (id) => executionClaim(rt, id, waits.signal),
      { store, shared: () => shared },
    );
    const checkpoint = checkpointer.checkpoint;
    spyOn(checkpointer, "checkpoint").mockImplementation((...args) => {
      if (args[1] !== undefined) trace.push(`checkpoint:${args[1]}`);
      return checkpoint(...args);
    });
    Object.assign(rt, { checkpointer });
    return rt;
  }
  let rt = await runtime();
  const startStage = store.startStage.bind(store);
  spyOn(store, "startStage").mockImplementation((...args) => {
    trace.push(`stage:${args[1]}`);
    return startStage(...args);
  });
  const makeFactory = () => {
    const f = new Factory(cfg, {
      store,
      ...(withRuntime ? { shared: rt } : {}),
      loadSource: () => 0,
      confinement: fakeConfinement,
      providers,
      models,
      policy,
      harnesses: {
        fake: fakeHarness((s) => {
          const role = roleOf(s);
          trace.push(`invoke:${role}`);
          if (role === "triage") return { structured: triage() };
          if (role === "spec") return { structured: spec };
          if (role === "holdout") return { structured: holdout };
          if (role === "verify") return { structured: pass };
          if (role === "review") return { structured: approve };
          return { files: { "farewell.txt": "goodbye\n" } };
        }),
      },
      cleanup: async () => ({
        dryRun: false,
        worktrees: [],
        logs: [],
        metadata: [],
        debugEvents: 0,
        baselineCache: 0,
        feedItems: 0,
        errors: [],
      }),
    });
    f.deps.gh = async () => "[]";
    if (!withRuntime) {
      expect(f.deps.checkpointer).toBeUndefined();
      f.deps.checkpointer = recording;
    }
    cleanup.push(() => f.stop());
    return f;
  };
  let factory = makeFactory();
  return {
    store,
    repo,
    cfg,
    gh,
    remote,
    blobs,
    control,
    transfer,
    trace,
    localTrace,
    tasks,
    get rt() {
      return rt;
    },
    get factory() {
      return factory;
    },
    create: (over: Partial<CreateRunRequest> = {}) =>
      factory.createRun({ repo: repo.slug, prompt: "Add farewell", profile: "quick", ...over }),
    fail: (sequence: number) => {
      failSequence = sequence;
    },
    async restart() {
      await factory.stop();
      rt = await runtime();
      factory = makeFactory();
      factory.start();
    },
    async tick() {
      now += LEASE.renewMs;
      gh.clock += LEASE.renewMs;
      for (const [h, task] of [...tasks])
        if (task.ms === LEASE.renewMs) {
          if (!task.repeat) tasks.delete(h);
          await task.fn();
        }
      await flush();
    },
    async ready(check: () => boolean) {
      await waits.until(check, { timeoutMs: 20_000, subscribe: (wake) => store.subscribe(wake) });
    },
    async tip(run: Run) {
      const key = claimKey(run, store);
      if ("none" in key) throw new Error("fixture key");
      const r = await claims.read(repo.slug, claimRef(key));
      if (r.kind !== "tip" || r.tip.record === "malformed") throw new Error("fixture tip");
      return r.tip.record;
    },
  };
}

test("Factory commits every execution unit before stages and invocations, with contiguous pointers", async () => {
  const f = await fixture();
  const run = await f.create();
  f.factory.start();
  f.factory.scheduler.setLimit(1);
  f.factory.scheduler.tick();
  await f.ready(() => !!f.store.checkpointRecord(run.id)?.terminal);
  expect(JSON.parse(f.store.checkpointRecord(run.id)?.terminal ?? "null")).toMatchObject({
    status: "succeeded",
  });
  let pointer = 0,
    stagePointer = 0;
  for (const [index, event] of f.trace.entries()) {
    if (event.startsWith("commit:")) {
      expect(Number(event.slice(7))).toBe(++pointer);
    }
    if (event.startsWith("stage:")) {
      expect(pointer).toBeGreaterThan(stagePointer);
      expect(f.trace[index - 2]).toBe(`checkpoint:${event}`);
      expect(f.trace[index - 1]).toBe(`commit:${pointer}`);
      stagePointer = pointer;
    }
    if (event.startsWith("invoke:")) expect(stagePointer).toBeGreaterThan(1);
  }
  expect(f.trace.filter((e) => e.startsWith("stage:"))).toEqual([
    "stage:prepare",
    "stage:triage",
    "stage:implement",
    "stage:gates",
    "stage:audit",
    "stage:review",
    "stage:deliver",
  ]);
  await f.tick();
  await f.ready(() => f.store.getRun(run.id)?.status === "succeeded");
  expect((await f.tip(run)).status).toBe("succeeded");
});

test("the independent holdout completion is committed before its background stage finishes", async () => {
  const f = await fixture();
  const finish = f.store.finishStage.bind(f.store);
  spyOn(f.store, "finishStage").mockImplementation((...args) => {
    const stage = f.store.listStages(f.store.listRuns()[0]?.id ?? "").find((s) => s.id === args[0]);
    if (stage?.name === "holdout" && args[1] === "succeeded") f.trace.push("holdout:finished");
    return finish(...args);
  });
  await f.create({ profile: "standard" });
  f.factory.start();
  f.factory.scheduler.setLimit(1);
  f.factory.scheduler.tick();
  await f.ready(() => f.trace.includes("holdout:finished"));
  const completed = f.trace.indexOf("holdout:complete"),
    boundary = f.trace.indexOf("checkpoint:holdout-complete"),
    finished = f.trace.indexOf("holdout:finished");
  expect(completed).toBeGreaterThan(0);
  expect(boundary).toBeGreaterThan(completed);
  expect(f.trace.slice(boundary + 1, finished).some((e) => e.startsWith("commit:"))).toBe(true);
});

test("an unconfirmed third unit never starts, and a restarted Factory commits before resuming", async () => {
  const f = await fixture();
  const run = await f.create();
  f.fail(4);
  f.factory.start();
  f.factory.scheduler.setLimit(1);
  f.factory.scheduler.tick();
  await f.ready(() => f.store.getRunState<RunState>(run.id)?.githubWait?.reason === "claim:lease");
  expect(f.store.listStages(run.id).map((s) => s.name)).toEqual(["prepare", "triage"]);
  expect(f.trace).not.toContain("invoke:implement");
  f.fail(0);
  f.cfg.maxConcurrentRuns = 1;
  const state = f.store.getRunState<RunState>(run.id);
  if (!state?.githubWait) throw new Error("fixture wait");
  state.githubWait.nextAttemptAt = 0;
  f.store.setRunState(run.id, state);
  await f.restart();
  await f.ready(() => !!f.store.checkpointRecord(run.id)?.terminal);
  expect(f.trace.indexOf("commit:4")).toBeLessThan(f.trace.indexOf("stage:implement"));
  expect(JSON.parse(f.store.checkpointRecord(run.id)?.terminal ?? "null")).toMatchObject({
    status: "succeeded",
  });
});

test("Factory refuses unportable requests before inserting or contacting companions; admission waits resolve", async () => {
  const f = await fixture();
  const acquire = spyOn(f.rt.leases, "acquire"),
    read = spyOn(f.rt.claims, "read"),
    mutate = spyOn(f.control, "mutate");
  for (const [request, message] of [
    [{ prompt: "Closes #12\nCloses #13" }, "Shared runs cannot close several issues"],
    [{ prompt: "Closes #12" }, "Shared issue runs require an issue source reference"],
    [{ dependsOn: ["abc123"] }, "Shared runs cannot have dependencies"],
  ] as const)
    await expect(f.create(request as Partial<CreateRunRequest>)).rejects.toThrow(message);
  await expect(
    f.factory.createAcceptanceRun(
      { repo: f.repo.slug, prompt: "Accept" },
      {
        ticket: { number: 2, author: null, body: '## The original intent\n#1\'s "Requirements" section' },
        parent: { number: 1, author: null, body: "## Requirements\n- Farewell exists" },
      },
    ),
  ).rejects.toThrow("Shared repositories do not support acceptance runs");
  expect(f.store.listRuns()).toHaveLength(0);
  expect(f.gh.requests).toHaveLength(0);
  expect(f.remote.calls).toHaveLength(0);
  expect(acquire).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(mutate).not.toHaveBeenCalled();
  expect(f.rt.gate.admit).not.toHaveBeenCalled();
  acquire.mockResolvedValue({
    kind: "refused",
    reason: "live",
  });
  const run = await f.create();
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(f.store.getRun(run.id)?.status).toBe("queued");
  expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:lease");
});

test("post-insert admission deadlines and human refusals resolve with deferred state", async () => {
  const f = await fixture();
  const blocked = Promise.withResolvers<void>();
  const gate = spyOn(f.rt.gate, "admit").mockImplementation(async () => {
    await blocked.promise;
    return [];
  });
  try {
    const creating = f.create();
    await f.ready(() => gate.mock.calls.length === 1);
    const deadline = [...f.tasks.values()].find((task) => task.ms === 600_000);
    if (!deadline) throw new Error("missing admission deadline");
    deadline.fn();
    const run = await creating;
    expect(f.store.getRun(run.id)?.status).toBe("queued");
    expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:unavailable");
  } finally {
    blocked.resolve();
    await flush();
  }
  gate.mockImplementation(async () => {
    throw new NeedsHumanError("shared run policy changed");
  });
  const run = await f.create();
  expect(f.store.getRun(run.id)?.status).toBe("queued");
  expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:terminal");
  expect(JSON.parse(f.store.checkpointRecord(run.id)?.terminal ?? "null")).toMatchObject({
    status: "needs_human",
    error: "shared run policy changed",
  });
});

test("disabling the scheduler leaves shared lease and publication timers stopped", async () => {
  const f = await fixture();
  const start = spyOn(f.rt.leases, "start");
  const previous = process.env.LIMITLESS_NO_SCHEDULER;
  try {
    process.env.LIMITLESS_NO_SCHEDULER = "1";
    f.factory.start();
  } finally {
    if (previous === undefined) delete process.env.LIMITLESS_NO_SCHEDULER;
    else process.env.LIMITLESS_NO_SCHEDULER = previous;
  }
  expect(start).not.toHaveBeenCalled();
  expect(f.tasks.size).toBe(0);
});

test("zero-capacity admission publishes one generation, initial checkpoint and importable run index", async () => {
  const f = await fixture();
  const mutate = spyOn(f.control, "mutate");
  f.factory.start();
  const run = await f.create();
  await f.factory.stop();
  const record = await f.tip(run),
    pointer = parsePointer(record.checkpoint ?? "");
  expect(record.generation).toBe(1);
  expect(f.store.checkpointRecord(run.id)?.committed?.sequence).toBe(1);
  expect(f.store.listStages(run.id)).toHaveLength(0);
  expect(mutate).toHaveBeenCalledTimes(1);
  const authority = await authorityFor(f.rt, f.store, f.cfg, run, waits.signal);
  expect(authority).not.toBe("finished");
  expect(mutate).toHaveBeenCalledTimes(1);
  const key = claimKey(run, f.store);
  if ("none" in key || !pointer) throw new Error("fixture pointer");
  const indexed = await f.control.read(
    controlKey(f.rt.namer, { kind: "run-index", runId: run.id, claim: key }),
  );
  expect(indexed?.manifest.value).toEqual({ kind: "run-index", runId: run.id, claim: key });
  const bytes = await f.blobs.get(run.id, "manifest", pointer);
  const manifest = parseManifest(new TextDecoder().decode(bytes));
  if (manifest === "malformed" || "unsupported" in manifest) throw new Error("fixture manifest");
  const imported = new Store(":memory:");
  try {
    const transfer = createRunTransfer({
      source: f.store,
      offline: { store: imported, ownership: "exclusive-offline" },
      key: f.blobs.newKey,
      objects: {
        export: async () => {
          throw new Error("no export");
        },
        validate: async () => {
          throw new Error("no objects");
        },
      },
      manifestContext: () => {
        throw new Error("no export");
      },
    });
    const blobs = new Map<string, Uint8Array>();
    for (const ref of receiptDescriptors(manifest))
      blobs.set(
        ref.key,
        await f.blobs.get(run.id, ref.key === manifest.blobs.state.key ? "state" : "objects", ref),
      );
    await transfer.importRun({ manifest: new TextDecoder().decode(bytes), blobs }, waits.signal);
  } finally {
    imported.close();
  }
  expect((await f.tip(run)).checkpoint).toBe(record.checkpoint);
});

test.each([0, 1])(
  "queued cancellation at capacity %s waits for publication without spinning",
  async (capacity) => {
    const f = await fixture();
    f.factory.start();
    const run = await f.create();
    f.factory.cancelRun(run.id);
    expect(f.store.getRun(run.id)?.status).toBe("queued");
    expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:terminal");
    expect(JSON.parse(f.store.checkpointRecord(run.id)?.terminal ?? "null").status).toBe("cancelled");
    const intent = f.store.checkpointRecord(run.id)?.terminal;
    const update = f.store.updateRun.bind(f.store);
    let writes = 0;
    spyOn(f.store, "updateRun").mockImplementation((...args) => {
      // Bound the regression so a microtask loop cannot starve the test's own deadline.
      if (args[0] === run.id && ++writes === 5) f.factory.scheduler.setLimit(0);
      return update(...args);
    });
    f.factory.scheduler.setLimit(capacity);
    f.factory.scheduler.tick();
    await flush();
    expect(writes).toBe(0);
    expect(f.store.checkpointRecord(run.id)?.terminal).toBe(intent);
    await f.tick();
    await f.ready(() => f.store.getRun(run.id)?.status === "cancelled");
    expect((await f.tip(run)).status).toBe("cancelled");
    await f.ready(() => f.store.heldLeaseRows().length === 0);
    await f.factory.stop();
    expect(f.tasks.size).toBe(0);
    const calls = f.gh.requests.length;
    await f.tick();
    expect(f.gh.requests.length).toBe(calls);
  },
);

test("shutdown during authority acquisition preserves the queued run for a new Factory", async () => {
  const f = await fixture();
  const run = await f.create();
  const entered = Promise.withResolvers<void>();
  const read = spyOn(f.rt.claims, "read").mockImplementationOnce(async (_repo, _ref, signal) => {
    if (!signal) throw new Error("missing authority signal");
    entered.resolve();
    await untilAborted(signal);
    throw signal.reason;
  });
  f.factory.start();
  f.factory.scheduler.setLimit(1);
  f.factory.scheduler.tick();
  await entered.promise;
  await f.factory.stop();
  expect(f.store.getRun(run.id)).toMatchObject({ status: "queued", error: null, finishedAt: null });
  expect(f.store.checkpointRecord(run.id)?.terminal).toBeNull();
  expect(f.store.listStages(run.id)).toHaveLength(0);
  read.mockRestore();
  f.cfg.maxConcurrentRuns = 1;
  await f.restart();
  await f.ready(() => !!f.store.checkpointRecord(run.id)?.terminal);
  expect(f.store.listStages(run.id).map((stage) => stage.name)).toContain("implement");
  expect(JSON.parse(f.store.checkpointRecord(run.id)?.terminal ?? "null").status).toBe("succeeded");
});

test("terminal sweeps deduplicate publications and stop waits for in-flight work", async () => {
  const f = await fixture();
  f.factory.start();
  const run = await f.create();
  f.factory.cancelRun(run.id);
  const blocked = Promise.withResolvers<void>();
  const commit = f.rt.committer.commit;
  const commits = spyOn(f.rt.committer, "commit").mockImplementation(async (...args) => {
    await blocked.promise;
    return commit(...args);
  });
  try {
    await f.tick();
    await f.ready(() => commits.mock.calls.length === 1);
    await f.tick();
    expect(commits).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = f.factory.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    expect(f.tasks.size).toBe(0);
    blocked.resolve();
    await stopping;
    expect(f.store.getRun(run.id)?.status).toBe("cancelled");
  } finally {
    blocked.resolve();
  }
});

test("Factory lease loop lapses checkpoint, policy, capability and terminal locals, renewing other waits", async () => {
  const f = await fixture();
  const runs = [];
  for (const reason of [
    "checkpoint",
    "policy",
    "capability",
    "terminal",
    "lease",
    "unavailable",
    "queued",
    "running",
    "waiting_input",
    "succeeded",
  ]) {
    const run = await f.create();
    const state = f.store.getRunState<RunState>(run.id);
    if (!state) throw new Error("fixture state");
    if (!["queued", "running", "waiting_input", "succeeded"].includes(reason))
      state.githubWait = {
        reason: `claim:${reason}`,
        since: Date.now(),
        nextAttemptAt: Date.now() + 1_000_000,
      };
    f.store.updateRun(
      run.id,
      {
        status:
          reason === "running" || reason === "waiting_input" || reason === "succeeded" ? reason : "queued",
      },
      state,
    );
    runs.push({ run, reason });
  }
  f.factory.start();
  // Startup deliberately requeues interrupted runs; restore running/input states for the lease pass.
  for (const { run, reason } of runs)
    if (reason === "running" || reason === "waiting_input") f.store.updateRun(run.id, { status: reason });
  const before = f.gh.calls("update").length;
  await f.tick();
  const renewed = f.gh
    .calls("update")
    .slice(before)
    .flatMap((r) => {
      const update = r.body.variables?.u?.[0];
      const commit = update && f.gh.commits.get(update.afterOid);
      const record = commit && update && parseRecord(commit.message, update.name);
      return record && record !== "malformed" && record.state === "held" ? [update?.name] : [];
    });
  for (const { run, reason } of runs) {
    const key = claimKey(run, f.store);
    if ("none" in key) throw new Error("fixture key");
    expect(renewed.includes(claimRef(key))).toBe(
      !["checkpoint", "policy", "capability", "succeeded"].includes(reason),
    );
  }
  const terminal = runs.find((r) => r.reason === "succeeded");
  expect(f.store.heldLeaseRows().some((r) => r.runId === terminal?.run.id)).toBe(false);
});

test("retry refuses held issue/PR claims but preserves run-kind and local retries", async () => {
  const f = await fixture();
  for (const kind of ["issue", "pull_request"] as const) {
    const run = f.store.createRun(f.repo, {
      repo: f.repo.slug,
      prompt: "Request",
      sourceRef: { kind, repo: f.repo.slug, number: kind === "issue" ? 12 : 13 },
    });
    f.store.updateRun(run.id, { status: "needs_human" });
    const count = f.store.listRuns().length;
    await expect(f.factory.retryRun(run.id)).rejects.toThrow(
      "Shared issue and PR runs cannot be retried while their claim is held",
    );
    expect(f.store.listRuns()).toHaveLength(count);
  }
  const run = await f.create();
  f.store.updateRun(run.id, { status: "needs_human" });
  expect((await f.factory.retryRun(run.id)).id).not.toBe(run.id);
  const local = await fixture(false);
  const issue = await local.create({ sourceRef: { kind: "issue", repo: local.repo.slug, number: 12 } });
  local.store.updateRun(issue.id, { status: "failed" });
  expect((await local.factory.retryRun(issue.id)).id).not.toBe(issue.id);
});

test("configured runtime leaves local traces and save microtasks unchanged, with no shared IO", async () => {
  const traces: unknown[][] = [];
  for (const configured of [false, true]) {
    const f = await fixture(false, configured);
    const run = await f.create();
    const ctx = new RunContext(f.factory.deps, run, f.repo, waits.signal);
    const p = ctx.save("visible");
    let done = false;
    p.then(() => {
      done = true;
    });
    expect(f.store.getRunState<RunState>(run.id)).toEqual(ctx.state);
    await null;
    expect(done).toBe(true);
    const before = f.localTrace.length;
    await ctx.boundary("local-unit");
    expect(f.localTrace).toHaveLength(before);
    f.factory.start();
    f.factory.scheduler.setLimit(1);
    f.factory.scheduler.tick();
    await f.ready(() => f.store.getRun(run.id)?.status === "succeeded");
    traces.push(f.localTrace);
    expect(f.rt.gate.admit).not.toHaveBeenCalled();
    expect(f.gh.requests).toHaveLength(0);
    expect(f.remote.calls).toHaveLength(0);
    await f.factory.stop();
  }
  expect(traces[1]).toEqual(traces[0]);
});
