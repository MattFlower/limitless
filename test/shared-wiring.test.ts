import { afterEach, expect, mock, setDefaultTimeout, spyOn } from "bun:test";
import { join } from "node:path";
import { Factory, type FactoryOptions } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { type CreateRunRequest, type Run, TERMINAL_STATUSES } from "../src/core/types.ts";
import { readOfflineProjection } from "../src/db/portable-projection.ts";
import { Store } from "../src/db/store.ts";
import { githubWait } from "../src/git/github-wait.ts";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { claimGuard } from "../src/integrations/claim-guard.ts";
import { createClaimClient } from "../src/integrations/claim-ref.ts";
import { createControlStore } from "../src/integrations/control-store.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import { createLeaseManager } from "../src/integrations/leases.ts";
import { parsePointer } from "../src/pipeline/checkpoint-settlement.ts";
import { localCheckpointer, NeedsHumanError, RunContext, type RunState } from "../src/pipeline/context.ts";
import { claimKey, claimRef, parseManifest } from "../src/pipeline/portable.ts";
import { createRunObjectExporter } from "../src/pipeline/run-object-export.ts";
import { createRunObjectValidator } from "../src/pipeline/run-object-quarantine.ts";
import { createRunTransfer } from "../src/pipeline/run-transfer.ts";
import { receiptDescriptors } from "../src/pipeline/run-transfer-integrity.ts";
import type { SharedRuntime } from "../src/pipeline/shared-admission.ts";
import { createCheckpointCommitter, sharedCheckpointer } from "../src/pipeline/shared-checkpointer.ts";
import { LEASE } from "../src/util/claim-clock.ts";
import { credentialRegistry } from "../src/util/credential-matcher.ts";
import { GitHub } from "./claim-github-fake.ts";
import { fixture as memberFixture } from "./member-support.ts";
import {
  approve,
  holdout,
  pass,
  pipelineSetup,
  providers,
  roleOf,
  spec,
  triage,
} from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";
import { Remote } from "./shared-store-fake.ts";
import { waitClock } from "./wait-clock.ts";

const state = { home: "", repoDir: "", factory: null as Factory | null };
const { start, githubFixture, registerGithub, wait } = pipelineSetup(state);
// Real export/read-back work at every shared boundary outlasts local pipeline timings.
setDefaultTimeout(60_000);
afterEach(() => mock.restore());
async function fixture(shared = true, faults?: FactoryOptions["faults"]) {
  const bare = await githubFixture();
  const cfg = loadConfig({
    home: join(state.home, "data"),
    configDir: join(state.home, "cfg"),
    raw: { repos: { "test/repo": { shared } } },
  });
  const store = new Store(cfg.paths.db),
    gh = new GitHub(),
    remote = new Remote(),
    blobs = remote.client();
  const clock = waitClock(),
    member = "m-0123456789abcdef";
  // LeaseManager takes an interval; admission and the terminal sweep take one-shot timers.
  const intervals = new Map<ReturnType<typeof setInterval>, ReturnType<typeof setInterval>>();
  const leaseTimer = {
    set: ((callback: () => void, ms: number) => {
      const tick = () => {
        intervals.set(id, clock.timer.set(tick, ms));
        callback();
      };
      const id = clock.timer.set(tick, ms);
      intervals.set(id, id);
      return id;
    }) as typeof setInterval,
    clear: ((id: ReturnType<typeof setInterval>) => {
      const pending = intervals.get(id);
      if (pending !== undefined) clock.timer.clear(pending);
      intervals.delete(id);
    }) as typeof clearInterval,
  };
  const leaseClock = { sample: () => ({ inclusive: clock.now(), exclusive: clock.now() }) };
  const claims = createClaimClient({ gh: gh.gh, sample: leaseClock.sample });
  const timeGh: GhRunner = async () => `HTTP/2 200 OK\r\nDate: ${new Date(gh.clock).toUTCString()}\r\n\r\n{}`;
  const members = memberFixture();
  const control = createControlStore({
    ...members,
    claims,
    blobs,
    actor: () => ({ kind: "member", id: member }),
  });
  const trace: string[] = [];
  const objects = {
    export: createRunObjectExporter({ scratchRoot: state.home }),
    validate: createRunObjectValidator({ scratchRoot: state.home }),
  };
  const transfer = createRunTransfer({
    source: store,
    key: blobs.newKey,
    objects,
    manifestContext: ({ run, state: saved }) => {
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
          phase: saved.phase,
          round: saved.round,
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
  const leases = await createLeaseManager({
    store,
    client: claims,
    member,
    clock: leaseClock,
    gh: timeGh,
    timer: leaseTimer,
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
  const local = localCheckpointer(store);
  const rt: SharedRuntime = {
    member,
    claims,
    blobs,
    control,
    namer: members.namer,
    committer,
    leases,
    clock,
    gate: {
      admit: mock(async () => []),
      canContinue: mock(async () => []),
      capableNow: () => true,
      forget() {},
    },
    checkpointer: sharedCheckpointer(
      local,
      committer,
      (id) => {
        const row = store.heldLeaseRows().find((r) => r.runId === id);
        if (!row?.confirmed) return;
        return {
          binding: {
            handle: { repo: row.repo, ref: row.ref, run: id, member, generation: row.confirmed.generation },
            guard: claimGuard,
            onLost() {},
          },
          signal: new AbortController().signal,
        };
      },
      { store, shared: () => shared },
    ),
  };
  const update = leases.update;
  spyOn(leases, "update").mockImplementation(async (...args) => {
    const result = await update(...args);
    if (result === "applied" && args[1].checkpoint)
      trace.push(`commit:${store.checkpointRecord(args[0].run)?.pending?.sequence}`);
    return result;
  });
  const createInvocation = store.createInvocation.bind(store);
  spyOn(store, "createInvocation").mockImplementation((invocation) => {
    const stage = store.listStages(invocation.runId).find((s) => s.id === invocation.stageId);
    if (shared) {
      expect(stage).toBeDefined();
      expect(trace).toContain(`stage:${stage?.name}`);
      expect(store.checkpointRecord(invocation.runId)?.committed?.sequence).toBeGreaterThan(1);
    }
    return createInvocation(invocation);
  });
  const startStage = store.startStage.bind(store);
  spyOn(store, "startStage").mockImplementation((...args) => {
    trace.push(`stage:${args[1]}`);
    return startStage(...args);
  });
  const handler = (s: Parameters<Parameters<typeof start>[0]>[0]) => {
    const role = roleOf(s);
    trace.push(`invoke:${role}`);
    if (role === "triage") return { structured: triage() };
    if (role === "spec") return { structured: spec };
    if (role === "holdout") return { structured: holdout };
    if (role === "verify") return { structured: pass };
    if (role === "review") return { structured: approve };
    return { files: { "farewell.txt": "goodbye\n" } };
  };
  const f = start(handler, false, false, { shared: rt, store, faults });
  f.cfg.repos = cfg.repos;
  f.scheduler.setLimit(0);
  registerGithub(f, bare);
  const repo = store.getRepoBySlug("test/repo");
  if (!repo) throw new Error("fixture repo");
  async function record(run: Run) {
    const key = claimKey(run, store);
    if ("none" in key) throw new Error("fixture key");
    const read = await claims.read(run.repoSlug, claimRef(key));
    if (read.kind !== "tip" || read.tip.record === "malformed") throw new Error("fixture tip");
    return read.tip.record;
  }
  const create = (req: Partial<CreateRunRequest> = {}) =>
    f.createRun({ repo: repo.slug, prompt: "Add farewell", profile: "quick", ...req });
  const idle = () => wait(() => f.scheduler.activeRunIds.length === 0, { timeoutMs: 20_000 });
  return { f, rt, store, gh, remote, clock, trace, create, record, transfer, objects, repo, idle };
}

test.each(["quick", "standard"] as const)(
  "%s commits before every execution unit and after holdout completion",
  async (profile) => {
    const x = await fixture(
        true,
        profile === "standard" ? { "stage:verify:before": { action: "hang" } } : undefined,
      ),
      labels: string[] = [];
    const checkpoint = x.rt.checkpointer.checkpoint;
    spyOn(x.rt.checkpointer, "checkpoint").mockImplementation((id, label) => {
      if (label) labels.push(label);
      const previous = x.store.checkpointRecord(id)?.committed?.sequence ?? 0;
      const work = checkpoint(id, label);
      if (label === "holdout-complete") {
        expect(x.store.getRunState<RunState>(id)?.holdoutStatus).toBe("complete");
        return work?.then(() =>
          expect(x.store.checkpointRecord(id)?.committed?.sequence).toBeGreaterThan(previous),
        );
      }
      return work;
    });
    const run = await x.create({ profile });
    x.f.scheduler.setLimit(1);
    x.f.scheduler.tick();
    if (profile === "standard") {
      await wait(() => x.store.listStages(run.id).some((s) => s.name === "verify"), { timeoutMs: 45_000 });
      await x.f.stop();
    } else {
      await wait(() => TERMINAL_STATUSES.includes(x.store.getRun(run.id)?.status ?? "queued"), {
        timeoutMs: 45_000,
      });
      await x.idle();
      expect(x.store.getRun(run.id)).toMatchObject({ status: "succeeded", error: null });
    }
    let last = "";
    for (const event of x.trace) {
      if (event.startsWith("stage:")) expect(last).toStartWith("commit:");
      if (event.startsWith("invoke:"))
        expect(x.trace.slice(0, x.trace.indexOf(event)).some((e) => e.startsWith("commit:"))).toBe(true);
      last = event;
    }
    const sequences = x.trace.filter((s) => s.startsWith("commit:")).map((s) => Number(s.split(":")[1]));
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, i) => i + 1));
    expect(labels).toEqual(expect.arrayContaining(x.trace.filter((s) => s.startsWith("stage:"))));
    if (profile === "standard") {
      expect(labels).toContain("holdout-complete");
      expect(x.store.getRunState<RunState>(run.id)?.holdoutStatus).toBe("complete");
    }
  },
);

test("an unconfirmed third unit waits across a Factory restart", async () => {
  const x = await fixture();
  const run = await x.create();
  const checkpoint = x.rt.checkpointer.checkpoint;
  let units = 0;
  spyOn(x.rt.checkpointer, "checkpoint").mockImplementation((id, label) => {
    if (label?.startsWith("stage:") && ++units === 3)
      spyOn(x.rt.leases, "update").mockResolvedValueOnce("wait");
    return checkpoint(id, label);
  });
  x.f.scheduler.setLimit(1);
  x.f.scheduler.tick();
  await wait(() => x.store.getRun(run.id)?.githubWait?.reason === "claim:lease", { timeoutMs: 20_000 });
  await x.idle();
  expect(x.store.listStages(run.id)).toHaveLength(2);
  await x.f.stop();
  const f = new Factory(x.f.cfg, {
    store: x.store,
    shared: x.rt,
    models: x.f.models,
    providers: providers,
    policy: x.f.policy,
    harnesses: x.f.deps.harnesses,
    confinement: x.f.deps.confinement,
    loadSource: () => 0,
  });
  state.factory = f;
  const queued = x.store.nextQueuedRuns.bind(x.store);
  spyOn(x.store, "nextQueuedRuns").mockImplementation((limit) => queued(limit, x.clock.now()));
  f.start();
  expect(x.store.listStages(run.id)).toHaveLength(2);
  const next = x.store.getRun(run.id)?.githubWait?.nextAttemptAt ?? 0;
  await x.clock.advance(Math.max(0, next - x.clock.now()));
  f.scheduler.tick();
  await wait(() => x.store.listStages(run.id).length >= 3, { timeoutMs: 20_000 });
  const third = x.trace.indexOf("stage:implement");
  expect(x.trace[third - 1]).toStartWith("commit:");
});

test("creation refusals leave no local or remote run; issue retries refuse but run and local retries work", async () => {
  const x = await fixture();
  const counts = () => [x.store.listRuns().length, x.gh.requests.length, x.remote.calls.length];
  const before = counts();
  for (const [req, message] of [
    [{ prompt: "Closes #1\nCloses #2" }, "Shared runs cannot close several issues"],
    [{ prompt: "Closes #1" }, "Shared issue runs require an issue source reference"],
    [{ dependsOn: ["other123"] }, "Shared runs cannot have dependencies"],
  ] as const)
    await expect(
      x.create({ ...req, dependsOn: "dependsOn" in req ? [...req.dependsOn] : undefined }),
    ).rejects.toThrow(message);
  expect(counts()).toEqual(before);
  const issue = await x.create({ sourceRef: { kind: "issue", repo: x.repo.slug, number: 1 } });
  x.store.updateRun(issue.id, { status: "needs_human" });
  await expect(x.f.retryRun(issue.id)).rejects.toThrow(
    "Shared issue and PR runs cannot be retried while their claim is held",
  );
  const run = await x.create();
  x.store.updateRun(run.id, { status: "failed" });
  expect((await x.f.retryRun(run.id)).id).not.toBe(run.id);
  x.f.cfg.repos = {};
  expect((await x.f.retryRun(run.id)).id).not.toBe(run.id);
});

test("zero-capacity admission publishes an importable initial checkpoint", async () => {
  const x = await fixture(),
    run = await x.create();
  await x.f.stop();
  expect(x.store.listStages(run.id)).toHaveLength(0);
  expect(x.store.heldLeaseRows()).toHaveLength(1);
  expect(x.store.checkpointRecord(run.id)).toMatchObject({
    committed: { sequence: 1, generation: 1 },
    indexed: true,
  });
  const pointer = parsePointer((await x.record(run)).checkpoint ?? "");
  if (!pointer) throw new Error("missing pointer");
  const text = new TextDecoder().decode(await x.rt.blobs.get(run.id, "manifest", pointer));
  const manifest = parseManifest(text);
  if (typeof manifest !== "object" || !("blobs" in manifest)) throw new Error("missing manifest");
  const target = new Store(":memory:");
  try {
    const blobs = new Map<string, Uint8Array>();
    for (const d of receiptDescriptors(manifest))
      blobs.set(
        d.key,
        await x.rt.blobs.get(run.id, d.key === manifest.blobs.state.key ? "state" : "objects", d),
      );
    const transfer = createRunTransfer({
      source: x.store,
      offline: { store: target, ownership: "exclusive-offline" },
      key: x.rt.blobs.newKey,
      objects: x.objects,
      manifestContext: () => {
        throw new Error("no export");
      },
    });
    await transfer.importRun({ manifest: text, blobs }, new AbortController().signal);
    expect(readOfflineProjection(target.db, run.id)?.run.id).toBe(run.id);
  } finally {
    target.close();
  }
});

test("queued cancellation defers, sweep publishes then releases, and local terminal leftovers release", async () => {
  const x = await fixture(),
    run = await x.create();
  expect(x.f.cancelRun(run.id)).toBe(true);
  expect(x.store.getRun(run.id)).toMatchObject({
    status: "queued",
    githubWait: { reason: "claim:terminal" },
  });
  await x.clock.advance(LEASE.renewMs);
  await wait(() => x.store.getRun(run.id)?.status === "cancelled", { timeoutMs: 20_000 });
  await wait(() => x.store.heldLeaseRows().length === 0, { timeoutMs: 20_000 });
  expect(await x.record(run)).toMatchObject({
    status: "cancelled",
    state: "released",
    checkpoint: x.store.checkpointRecord(run.id)?.committed?.pointer,
  });
  const other = await x.create(),
    pointer = (await x.record(other)).checkpoint;
  x.store.updateRun(other.id, { status: "succeeded" });
  await x.clock.advance(LEASE.renewMs);
  await wait(() => x.store.heldLeaseRows().length === 0, { timeoutMs: 20_000 });
  expect((await x.record(other)).checkpoint).toBe(pointer);
});

test("lease loop lapses blocked waits, renews terminal waits, and stops with the Factory", async () => {
  const x = await fixture(),
    runs: Run[] = [];
  for (const reason of ["checkpoint", "policy", "capability", "terminal"]) {
    const run = await x.create();
    runs.push(run);
    x.store.setRunState(run.id, {
      ...x.store.getRunState<RunState>(run.id),
      githubWait: {
        reason: `claim:${reason}`,
        since: x.clock.now(),
        nextAttemptAt: x.clock.now() + LEASE.expireMs,
      },
    });
  }
  const before = x.gh.calls("update").length;
  await x.clock.advance(LEASE.renewMs);
  await wait(() => x.gh.calls("update").length > before, { timeoutMs: 20_000 });
  const renewed = x.gh.calls("update").slice(before);
  expect(renewed).toHaveLength(1);
  expect(renewed[0]?.body.variables?.u?.[0]?.name).toContain(runs[3]?.id ?? "missing");
  await x.clock.advance(LEASE.renewMs);
  await wait(() => x.gh.calls("update").length === before + 2, { timeoutMs: 20_000 });
  expect(x.gh.calls("update").at(-1)?.body.variables?.u?.[0]?.name).toContain(runs[3]?.id ?? "missing");
  await x.f.stop();
  expect(x.clock.pending).toBe(0);
  const stopped = x.gh.requests.length;
  await x.clock.advance(LEASE.renewMs);
  expect(x.gh.requests.length).toBe(stopped);
});

test("a runtime leaves local execution and checkpointer scheduling unchanged", async () => {
  const x = await fixture(false);
  const traces: string[][] = [[], []];
  const record = (index: number) => {
    const local = localCheckpointer(x.store);
    return {
      writeRun: (...args: Parameters<typeof local.writeRun>) => {
        traces[index]?.push(`run:${Object.keys(args[1]).join(",")}:${args[2]?.phase ?? ""}`);
        return local.writeRun(...args);
      },
      writeState: (...args: Parameters<typeof local.writeState>) => {
        traces[index]?.push(`state:${args[1].phase}`);
        return local.writeState(...args);
      },
      checkpoint: (id: string, label?: string) => {
        traces[index]?.push(`checkpoint:${label}`);
        return local.checkpoint(id, label);
      },
    };
  };
  const recording = record(0);
  spyOn(x.rt.checkpointer, "writeRun").mockImplementation(recording.writeRun);
  spyOn(x.rt.checkpointer, "writeState").mockImplementation(recording.writeState);
  spyOn(x.rt.checkpointer, "checkpoint").mockImplementation(recording.checkpoint);
  const first = await x.create();
  x.f.scheduler.setLimit(1);
  x.f.scheduler.tick();
  await wait(() => x.store.getRun(first.id)?.status === "succeeded", { timeoutMs: 20_000 });
  await x.idle();
  await x.f.stop();
  const f = new Factory(x.f.cfg, {
    store: x.store,
    providers,
    models: x.f.models,
    policy: x.f.policy,
    harnesses: x.f.deps.harnesses,
    confinement: x.f.deps.confinement,
    loadSource: () => 0,
  });
  state.factory = f;
  f.deps.checkpointer = record(1);
  const second = await f.createRun({ repo: x.repo.slug, prompt: "Add farewell", profile: "quick" });
  f.start();
  await wait(() => x.store.getRun(second.id)?.status === "succeeded", { timeoutMs: 20_000 });
  await f.stop();
  expect(traces[0]).toEqual(traces[1]);
  expect(traces[0]?.some((s) => s.startsWith("checkpoint:stage:"))).toBe(false);
  expect(x.gh.requests).toHaveLength(0);
  expect(x.remote.calls).toHaveLength(0);
  expect(x.rt.gate.admit).not.toHaveBeenCalled();
  expect(x.rt.gate.canContinue).not.toHaveBeenCalled();
  for (const factory of [x.f, f]) {
    const run = x.store.createRun(x.repo, { repo: x.repo.slug, prompt: "Local stage ordering" });
    const ctx = new RunContext(factory.deps, run, x.repo, new AbortController().signal),
      order: string[] = [];
    const stage = ctx.stage("triage", async () => {
      order.push("callback");
      return { summary: "entered", value: undefined };
    });
    expect(x.store.listStages(run.id).map((row) => row.name)).toEqual(["triage"]);
    queueMicrotask(() => order.push("microtask"));
    await stage;
    expect(order).toEqual(["callback", "microtask"]);
  }
  expect(traces.flat().some((entry) => entry.startsWith("checkpoint:stage:"))).toBe(false);
});

test("shared acceptance creation refuses before inserting or contacting companions", async () => {
  const x = await fixture();
  const issue = (number: number, body: string) => ({
    number,
    body,
    author: { login: "owner" },
    userContentEdits: { nodes: [], pageInfo: { hasNextPage: false } },
  });
  await expect(
    x.f.createAcceptanceRun(
      { repo: x.repo.slug, prompt: "Accept" },
      {
        parent: issue(1, "## Goal\n- A file exists."),
        ticket: issue(2, '## The original intent\n#1\'s "Goal" section'),
      },
    ),
  ).rejects.toThrow("Acceptance runs are not supported in shared repositories");
  expect(x.store.listRuns()).toHaveLength(0);
  expect(x.gh.requests).toHaveLength(0);
  expect(x.remote.calls).toHaveLength(0);
});

test.each(["wait", "lost", "policy", "unavailable"])(
  "post-insert admission %s never rejects creation",
  async (kind) => {
    const x = await fixture();
    spyOn(x.rt.gate, "admit").mockRejectedValueOnce(
      kind === "wait"
        ? new ClaimWaitError("capability")
        : kind === "lost"
          ? new ClaimLostError()
          : kind === "policy"
            ? new NeedsHumanError("shared run policy changed")
            : new Error("offline"),
    );
    const run = await x.create();
    expect(x.store.listRuns()).toHaveLength(1);
    if (kind === "lost")
      expect(x.store.getRun(run.id)).toMatchObject({ status: "cancelled", error: "superseded: claim lost" });
    else
      expect(x.store.getRun(run.id)).toMatchObject({
        status: "queued",
        githubWait: {
          reason: `claim:${kind === "wait" ? "capability" : kind === "policy" ? "terminal" : "unavailable"}`,
        },
      });
    if (kind === "policy")
      expect(JSON.parse(x.store.checkpointRecord(run.id)?.terminal ?? "null")).toMatchObject({
        status: "needs_human",
        error: "shared run policy changed",
      });
    expect(x.gh.requests).toHaveLength(0);
    expect(x.remote.calls).toHaveLength(0);
  },
);

test("terminal sweeps stay single-flight and stop waits for publication", async () => {
  const x = await fixture(),
    run = await x.create();
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const commit = x.rt.committer.commit;
  let publications = 0;
  spyOn(x.rt.committer, "commit").mockImplementation(async (...args) => {
    if (args[3]) {
      publications++;
      entered.resolve();
      await resume.promise;
    }
    return commit(...args);
  });
  x.f.cancelRun(run.id);
  let stopping: Promise<void> | undefined;
  try {
    await x.clock.advance(LEASE.renewMs);
    await entered.promise;
    await x.clock.advance(LEASE.renewMs);
    expect(publications).toBe(1);
    let stopped = false;
    stopping = x.f.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    resume.resolve();
    await stopping;
    expect(x.store.getRun(run.id)?.status).toBe("cancelled");
    const writes = x.gh.requests.length;
    await x.clock.advance(LEASE.renewMs);
    expect(x.gh.requests).toHaveLength(writes);
  } finally {
    resume.resolve();
    await stopping;
  }
});

test("the scheduler retries incomplete admission only after its durable wait elapses", async () => {
  const x = await fixture();
  spyOn(x.rt.gate, "admit").mockRejectedValueOnce(new ClaimWaitError("capability"));
  const run = await x.create(),
    queued = x.store.nextQueuedRuns.bind(x.store);
  spyOn(x.store, "nextQueuedRuns").mockImplementation((limit) => queued(limit, x.clock.now()));
  x.f.scheduler.setLimit(1);
  x.f.scheduler.tick();
  expect(x.store.listStages(run.id)).toHaveLength(0);
  expect(x.store.heldLeaseRows()).toHaveLength(0);
  const next = x.store.getRun(run.id)?.githubWait?.nextAttemptAt ?? 0;
  await x.clock.advance(next - x.clock.now());
  x.f.scheduler.tick();
  await wait(() => x.store.listStages(run.id).length > 0, { timeoutMs: 20_000 });
  expect(x.store.checkpointRecord(run.id)).toMatchObject({
    committed: { generation: 1, sequence: 2 },
    indexed: true,
  });
  expect(x.trace.slice(0, 3)).toEqual(["commit:1", "commit:2", "stage:prepare"]);
});

test("a picked deferred cancellation publishes instead of repeatedly finalizing locally", async () => {
  const x = await fixture(),
    run = await x.create();
  x.f.cancelRun(run.id);
  x.f.scheduler.setLimit(1);
  x.f.scheduler.tick();
  await wait(() => x.store.getRun(run.id)?.status === "cancelled", { timeoutMs: 20_000 });
  await x.idle();
  expect(await x.record(run)).toMatchObject({ status: "cancelled", state: "released" });
  expect(x.store.listStages(run.id)).toHaveLength(0);
});

test("a refused initial export preserves needs_human without retrying admission", async () => {
  const x = await fixture(),
    credential = ["synthetic", "wiring", "identity", "credential"].join("-");
  const registrations = spyOn(credentialRegistry, "values").mockReturnValue([
    ...credentialRegistry.values(),
    credential,
  ]);
  const admit = spyOn(x.rt.gate, "admit").mockImplementation(async () => {
    // Bound a broken scheduler's immediate re-picks so the regression fails without spinning.
    if (admit.mock.calls.length > 1) x.f.scheduler.setLimit(0);
    return [];
  });
  try {
    const run = await x.create({ requestedBy: credential }),
      intent = JSON.parse(x.store.checkpointRecord(run.id)?.terminal ?? "null");
    expect(intent).toMatchObject({ status: "needs_human", error: "Shared checkpoint refused: invalid" });
    expect(x.store.checkpointRecord(run.id)?.committed).toBeNull();
    expect(x.store.checkpointRecord(run.id)?.indexed).toBe(false);
    expect(x.store.heldLeaseRows()).toHaveLength(1);
    x.f.scheduler.setLimit(1);
    x.f.scheduler.tick();
    await x.idle();
    expect(x.store.getRun(run.id)).toMatchObject(intent);
    expect(await x.record(run)).toMatchObject({
      status: "needs_human",
      state: "released",
    });
    expect((await x.record(run)).checkpoint).toBeUndefined();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(x.store.heldLeaseRows()).toHaveLength(0);
    expect(x.store.listStages(run.id)).toHaveLength(0);
    expect(x.store.listInvocations(run.id)).toHaveLength(0);
  } finally {
    registrations.mockRestore();
  }
});

test("an unleased cancellation publishes with zero execution slots", async () => {
  const x = await fixture();
  spyOn(x.rt.gate, "admit").mockRejectedValueOnce(new ClaimWaitError("capability"));
  const run = await x.create();
  x.f.cancelRun(run.id);
  expect(x.store.getRun(run.id)).toMatchObject({
    status: "queued",
    githubWait: { reason: "claim:terminal" },
  });
  expect(x.store.heldLeaseRows()).toHaveLength(0);
  const resume = Promise.withResolvers<void>(),
    commit = x.rt.committer.commit;
  let publishing = false;
  spyOn(x.rt.committer, "commit").mockImplementation(async (...args) => {
    if (args[3]) {
      publishing = true;
      await resume.promise;
    }
    return commit(...args);
  });
  try {
    await x.clock.advance(LEASE.renewMs);
    await wait(() => publishing, { timeoutMs: 20_000 });
    expect(x.f.scheduler.activeRunIds).toEqual([]);
    expect(x.store.getRun(run.id)?.status).toBe("queued");
    expect(await x.record(run)).toMatchObject({ status: "queued", state: "held" });
    expect(x.store.listStages(run.id)).toHaveLength(0);
    resume.resolve();
    await wait(() => x.store.getRun(run.id)?.status === "cancelled", { timeoutMs: 20_000 });
    await wait(() => x.store.heldLeaseRows().length === 0, { timeoutMs: 20_000 });
    expect(await x.record(run)).toMatchObject({ status: "cancelled", state: "released" });
    expect(x.f.scheduler.activeRunIds).toEqual([]);
    expect(x.store.listStages(run.id)).toHaveLength(0);
    expect(x.store.listInvocations(run.id)).toHaveLength(0);
  } finally {
    resume.resolve();
  }
});

test("stop waits for a renewal paused inside a claim read and the loop writes nothing after", async () => {
  const x = await fixture();
  await x.create();
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>(),
    read = x.rt.claims.read.bind(x.rt.claims);
  spyOn(x.rt.claims, "read").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await resume.promise;
    return read(...args);
  });
  const renewals = x.gh.calls("update").length;
  let stopping: Promise<void> | undefined;
  try {
    await x.clock.advance(LEASE.renewMs);
    await entered.promise;
    let stopped = false;
    stopping = x.f.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    resume.resolve();
    await stopping;
    expect(x.gh.calls("update")).toHaveLength(renewals + 1);
    const requests = x.gh.requests.length;
    await x.clock.advance(LEASE.renewMs);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(x.gh.requests).toHaveLength(requests);
  } finally {
    resume.resolve();
    await stopping;
  }
});

test("a deferred cancellation backs off after an unconfirmed claim read instead of re-picking", async () => {
  const x = await fixture(),
    run = await x.create();
  // A regression re-picks in a tight loop; stopping the scheduler ends it so the count assertion fails.
  const read = spyOn(x.rt.claims, "read").mockImplementation(async () => {
    if (read.mock.calls.length > 3) void x.f.scheduler.stop();
    return { kind: "unconfirmed", error: "unavailable" };
  });
  x.f.cancelRun(run.id);
  x.f.scheduler.setLimit(1);
  x.f.scheduler.tick();
  await wait(() => read.mock.calls.length > 0, { timeoutMs: 20_000 });
  await x.idle();
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  x.f.scheduler.tick();
  await x.idle();
  expect(read).toHaveBeenCalledTimes(1);
  expect(x.store.getRun(run.id)).toMatchObject({
    status: "queued",
    githubWait: { reason: "claim:terminal", nextAttemptAt: x.clock.now() + githubWait.intervalMs },
  });
  read.mockRestore();
  await x.clock.advance(LEASE.renewMs);
  await wait(() => x.store.getRun(run.id)?.status === "cancelled", { timeoutMs: 20_000 });
  expect(await x.record(run)).toMatchObject({ status: "cancelled", state: "released" });
});
