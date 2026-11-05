import { afterEach, expect, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { type RunStatus, TERMINAL_STATUSES } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { cachePath, iterationRefs } from "../src/git/repos.ts";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { claimScope } from "../src/integrations/claim-guard.ts";
import { createClaimClient } from "../src/integrations/claim-ref.ts";
import { createControlStore } from "../src/integrations/control-store.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import { createLeaseManager } from "../src/integrations/leases.ts";
import { finalizeRecordedCancellation } from "../src/pipeline/cancellation.ts";
import { mapClaimInterruption } from "../src/pipeline/claim-interruption.ts";
import { initialRunState, localCheckpointer, RunContext, type RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { claimKey, claimRef } from "../src/pipeline/portable.ts";
import { createRunObjectExporter } from "../src/pipeline/run-object-export.ts";
import { createRunObjectValidator } from "../src/pipeline/run-object-quarantine.ts";
import { pinPolicy } from "../src/pipeline/run-policy-pins.ts";
import { createRunTransfer } from "../src/pipeline/run-transfer.ts";
import { RunTransferError } from "../src/pipeline/run-transfer-errors.ts";
import type { SharedRuntime } from "../src/pipeline/shared-admission.ts";
import { authorityFor, claimHooks, publishTerminal } from "../src/pipeline/shared-authority.ts";
import { createCheckpointCommitter, sharedCheckpointer } from "../src/pipeline/shared-checkpointer.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { Router } from "../src/router/router.ts";
import { LEASE } from "../src/util/claim-clock.ts";
import { sh } from "../src/util/proc.ts";
import { GitHub } from "./claim-github-fake.ts";
import { fixture as memberFixture } from "./member-support.ts";
import { test } from "./read-policy-support.ts";
import { seeded } from "./seeded.ts";
import { Remote } from "./shared-store-fake.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  mock.restore();
  for (const fn of cleanup.splice(0).reverse()) fn();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "shared-authority-"));
  const cfg = loadConfig({
    home: root,
    configDir: join(root, "config"),
    raw: { repos: { "example/project": { shared: true } } },
  });
  let store = new Store(cfg.paths.db);
  const repo = store.upsertRepo({
    slug: "example/project",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "Request" });
  const gh = new GitHub(),
    remote = new Remote(),
    blobs = remote.client(),
    member = "m-0123456789abcdef";
  let now = 1000;
  const leaseClock = { sample: () => ({ inclusive: now, exclusive: now }) };
  const claims = createClaimClient({ gh: gh.gh, sample: leaseClock.sample });
  const timeGh: GhRunner = async (args, _signal, _stdin, target) => {
    expect(args).toEqual(["api", "--include", "rate_limit"]);
    expect(target).toBe(repo.slug);
    return `HTTP/2 200 OK\r\nDate: ${new Date(gh.clock).toUTCString()}\r\n\r\n{}`;
  };
  const c = memberFixture();
  const control = createControlStore({ ...c, claims, blobs, actor: () => ({ kind: "member", id: member }) });
  const signal = new AbortController().signal;
  const objects = {
    export: createRunObjectExporter({ scratchRoot: root }),
    validate: createRunObjectValidator({ scratchRoot: root }),
  };
  function transferFor() {
    return createRunTransfer({
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
            baseSha: null,
            headSha: null,
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
  }
  let transfer = transferFor();
  async function runtime(): Promise<SharedRuntime> {
    const leases = await createLeaseManager({ store, client: claims, member, clock: leaseClock, gh: timeGh });
    transfer = transferFor();
    const committer = createCheckpointCommitter({
      store,
      paths: cfg.paths,
      member,
      transfer,
      blobs,
      leases,
      claims,
    });
    return {
      member,
      leases,
      claims,
      blobs,
      control,
      namer: c.namer,
      committer,
      checkpointer: sharedCheckpointer(localCheckpointer(store), committer, () => undefined, {
        store,
        shared: () => true,
      }),
      gate: { admit: async () => [], canContinue: async () => [], capableNow: () => true, forget() {} },
      clock: {
        now: () => now,
        timer: {
          set: (fn, ms) => setTimeout(fn, ms),
          clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        },
      },
    };
  }
  const f = {
    cfg,
    repo,
    run,
    gh,
    remote,
    blobs,
    claims,
    signal,
    rt: await runtime(),
    get store() {
      return store;
    },
    get transfer() {
      return transfer;
    },
    authority: () => authorityFor(f.rt, store, cfg, store.getRun(run.id) ?? run, signal),
    publish: () => publishTerminal(f.rt, store, run.id),
    defer: (status: RunStatus = "succeeded") =>
      f.rt.checkpointer.writeRun(run.id, { status, error: "final reason", finishedAt: 1234 }),
    async reopen() {
      store.close();
      store = new Store(cfg.paths.db);
      f.rt = await runtime();
    },
    expire() {
      now += LEASE.expireMs + 2000;
      gh.clock += LEASE.expireMs + 2000;
    },
    async record() {
      const key = claimKey(run, store);
      if ("none" in key) throw new Error("fixture key");
      const read = await claims.read(repo.slug, claimRef(key));
      if (read.kind !== "tip" || read.tip.record === "malformed") throw new Error("fixture tip");
      return read.tip.record;
    },
    engineDeps() {
      const tracker = new ProviderTracker([], store, cfg.reserves, {});
      return {
        cfg,
        store,
        tracker,
        router: new Router(tracker, undefined, []),
        harnesses: {},
        capability: f.rt.gate,
        checkpointer: f.rt.checkpointer,
        gh: gh.gh,
        confinement: { verify: async () => {}, wrap: (cmd: string[]) => cmd },
      };
    },
  };
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function held(f: Fixture) {
  const authority = await f.authority();
  if (authority === "finished") throw new Error("expected authority");
  return authority;
}
function expectDeferred(f: Fixture, status: RunStatus) {
  expect(f.store.getRun(f.run.id)).toMatchObject({ status: "queued", stage: null, finishedAt: null });
  expect(f.store.getRunState<RunState>(f.run.id)?.githubWait?.reason).toBe("claim:terminal");
  expect(JSON.parse(f.store.checkpointRecord(f.run.id)?.terminal ?? "null")).toMatchObject({ status });
}
function failUpdate(f: Fixture, apply = false) {
  const before = f.gh.calls("update").length;
  f.gh.fault = (r) => {
    if (r.step === "update") {
      if (apply) f.gh.apply(r);
      throw new Error("Something went wrong");
    }
    if (r.step === "ref" && f.gh.calls("update").length > before) throw new Error("Something went wrong");
  };
}

test.each([
  ["success", "succeeded"],
  ["engine cancellation", "cancelled"],
  ["failure", "failed"],
  ["human intervention", "needs_human"],
  ["post-merge rejection", "needs_human"],
  ["recorded cancellation", "cancelled"],
  ["scheduler internal error", "failed"],
] as const)("terminal deferral: %s", async (site, status) => {
  const f = await fixture();
  f.store.updateRun(f.run.id, {
    error: site === "recorded cancellation" ? "cancelled by user" : "old error",
    stage: "implement",
  });
  const state = initialRunState(f.run);
  state.feedback = "final state";
  if (site === "recorded cancellation") finalizeRecordedCancellation(f.store, f.run.id, f.rt.checkpointer);
  else f.rt.checkpointer.writeRun(f.run.id, { status, error: "final error", finishedAt: 1234 }, state);
  expectDeferred(f, status);
  expect(f.store.getRun(f.run.id)?.error).toBe(
    site === "recorded cancellation" ? "cancelled by user" : "old error",
  );
  if (site !== "recorded cancellation") {
    expect(f.store.getRunState<RunState>(f.run.id)?.feedback).toBe("final state");
    expect(JSON.parse(f.store.checkpointRecord(f.run.id)?.terminal ?? "null")).toEqual({
      status,
      error: "final error",
      finishedAt: 1234,
    });
  }
  const local = sharedCheckpointer(localCheckpointer(f.store), f.rt.committer, () => undefined, {
    store: f.store,
    shared: () => false,
  });
  local.writeRun(f.run.id, { status, finishedAt: 1234 });
  expect(f.store.getRun(f.run.id)).toMatchObject({ status, finishedAt: 1234 });
});

const seed = seeded(async (dir) => {
  await sh(["git", "init", "-b", "main", dir], { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "content\n");
  await sh(["git", "-C", dir, "add", "."], { cwd: dir });
  await sh(["git", "-C", dir, "commit", "-m", "seed"], { cwd: dir });
  return (await sh(["git", "-C", dir, "rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
});
test.each([false, true])("engine success publishes upload-first, update fails=%s", async (fault) => {
  const f = await fixture(),
    authority = await held(f);
  const state = f.store.getRunState<RunState>(f.run.id) ?? initialRunState(f.run);
  const cache = cachePath(f.cfg.paths, f.repo),
    { value: sha } = await seed(cache);
  await sh(["git", "-C", cache, "update-ref", `refs/limitless/iterations/${f.run.id}/1`, sha], {
    cwd: cache,
  });
  expect(await iterationRefs(cache, f.run.id)).toHaveLength(1);
  Object.assign(state, {
    phase: "done",
    gatesConfig: { setup: [], checks: [], source: "none", protectedPaths: [] },
    previewConfig: null,
    slottedCommands: [],
    agentFullSuite: "slot",
  });
  pinPolicy(f.store, f.run.id, state, { kind: "prepared", trustedBase: sha });
  expect(await executeRun({ ...f.engineDeps(), runClaim: authority }, f.run.id, f.signal)).toBe("succeeded");
  expectDeferred(f, "succeeded");
  expect(await iterationRefs(cache, f.run.id)).toHaveLength(0);
  const before = (await f.record()).checkpoint;
  if (fault) failUpdate(f);
  expect(await f.publish()).toBe(fault ? "wait" : "done");
  if (fault) expectDeferred(f, "succeeded");
  else {
    expect(f.store.getRun(f.run.id)?.status).toBe("succeeded");
    expect(f.store.checkpointRecord(f.run.id)?.terminal).toBeNull();
    expect(f.store.getRunState<RunState>(f.run.id)?.githubWait).toBeUndefined();
    expect(await f.record()).toMatchObject({
      state: "released",
      status: "succeeded",
      checkpoint: f.store.checkpointRecord(f.run.id)?.committed?.pointer,
    });
    expect((await f.record()).checkpoint).not.toBe(before);
  }
});

test("ambiguous terminal successor is promoted before release", async () => {
  const f = await fixture();
  await held(f);
  const before = (await f.record()).checkpoint;
  f.defer();
  failUpdate(f, true);
  expect(await f.publish()).toBe("wait");
  expectDeferred(f, "succeeded");
  f.gh.fault = undefined;
  const published = (await f.record()).checkpoint;
  expect(published).not.toBe(before);
  expect(await f.publish()).toBe("done");
  expect(await f.record()).toMatchObject({ state: "released", status: "succeeded", checkpoint: published });
});

test("refused final candidate publishes status without changing the pointer", async () => {
  const f = await fixture();
  await held(f);
  const pointer = (await f.record()).checkpoint;
  f.defer("needs_human");
  spyOn(f.transfer, "exportRun").mockRejectedValue(new RunTransferError("invalid"));
  expect(await f.publish()).toBe("done");
  expect(await f.record()).toMatchObject({ state: "released", status: "needs_human", checkpoint: pointer });
});

test.each(["intent", "no-intent", "different-intent", "released"])(
  "terminal restart never acquires: %s",
  async (kind) => {
    const f = await fixture();
    await held(f);
    f.defer();
    if (kind === "released") {
      await f.publish();
      f.store.updateRun(f.run.id, { status: "queued", finishedAt: null });
    } else {
      const update = f.rt.leases.update.bind(f.rt.leases);
      spyOn(f.rt.leases, "update").mockImplementation(async (...args) => {
        const result = await update(...args);
        if (result === "applied") throw new Error("crash after remote terminal");
        return result;
      });
      await expect(f.publish()).rejects.toThrow("crash after remote terminal");
      expectDeferred(f, "succeeded");
      if (kind === "no-intent") f.store.clearTerminalIntent(f.run.id);
      if (kind === "different-intent") f.defer("failed");
    }
    const tip = await f.record();
    f.expire();
    await f.reopen();
    const acquire = spyOn(f.rt.leases, "acquire"),
      writes = f.gh.calls("update").length;
    expect(await f.authority()).toBe("finished");
    expect(f.store.getRun(f.run.id)).toMatchObject({
      status: "succeeded",
      error: kind === "intent" ? "final reason" : "finished before restart",
    });
    expect(f.store.checkpointRecord(f.run.id)?.terminal).toBeNull();
    expect(f.store.listStages(f.run.id)).toHaveLength(0);
    expect(acquire).not.toHaveBeenCalled();
    expect(f.gh.calls("update")).toHaveLength(writes);
    expect(await f.record()).toEqual(tip);
  },
);

test.each(["upload", "lost-response", "lost-ledger"])("held indexed restart: %s", async (kind) => {
  const f = await fixture(),
    authority = await held(f);
  const previous = (await f.record()).checkpoint;
  if (kind === "upload") spyOn(f.rt.leases, "update").mockResolvedValueOnce("wait");
  else failUpdate(f, true);
  await expect(
    f.rt.committer.commit(
      f.run.id,
      { handle: authority.binding.handle, guard() {}, onLost: authority.binding.onLost },
      f.signal,
    ),
  ).rejects.toMatchObject({ reason: "lease" });
  f.gh.fault = undefined;
  const pending = f.store.checkpointRecord(f.run.id)?.pending?.pointer;
  expect(pending).toBeDefined();
  if (kind === "lost-ledger") {
    f.store.db.query("DELETE FROM shared_checkpoints WHERE run_id=?").run(f.run.id);
    f.store.markRunIndexed(f.run.id);
  }
  await f.reopen();
  const writes = f.gh.calls("update").length,
    puts = spyOn(f.blobs, "put"),
    state = f.store.getRunState<RunState>(f.run.id),
    tip = await f.record();
  if (kind === "lost-ledger") await expect(f.authority()).rejects.toMatchObject({ reason: "checkpoint" });
  else {
    expect(await f.authority()).not.toBe("finished");
    expect(f.store.checkpointRecord(f.run.id)?.pending).toBeNull();
    expect(f.store.checkpointRecord(f.run.id)?.committed?.pointer).toBe(
      kind === "upload" ? previous : pending,
    );
  }
  expect(f.store.getRunState<RunState>(f.run.id)).toEqual(state);
  expect(await f.record()).toEqual(tip);
  expect(f.gh.calls("update")).toHaveLength(writes);
  expect(puts).not.toHaveBeenCalled();
});

test("loss routes by generation and guards the next save without terminal publication", async () => {
  const f = await fixture(),
    authority = await held(f),
    hooks = claimHooks(f.rt, f.store),
    handle = authority.binding.handle;
  const ctx = new RunContext(
    { ...f.engineDeps(), runClaim: authority },
    f.run,
    f.repo,
    f.signal,
    undefined,
    undefined,
    { shared: true, claim: authority },
  );
  hooks.onLost({ ...handle, generation: handle.generation + 1 }, null);
  expect(authority.binding.lost).toBe(false);
  hooks.onLost({ ...handle, run: "unknown" }, null);
  const writes = f.gh.calls("update").length;
  hooks.onLost(handle, null);
  expect(() =>
    claimScope.run([authority.binding], () => ctx.checkpointer.writeRun(f.run.id, { status: "running" })),
  ).toThrow(ClaimLostError);
  mapClaimInterruption(f.store, f.run.id, new ClaimLostError());
  expect(f.store.getRun(f.run.id)).toMatchObject({ status: "cancelled", error: "superseded: claim lost" });
  expect(f.store.checkpointRecord(f.run.id)?.terminal).toBeNull();
  expect(f.gh.calls("update")).toHaveLength(writes);
});

test("lapse keeps terminal publication active", async () => {
  const f = await fixture(),
    { binding } = await held(f),
    hooks = claimHooks(f.rt, f.store);
  expect(hooks.active({ ...binding.handle, run: "missing" })).toBe(false);
  for (const status of [...TERMINAL_STATUSES, "queued", "running", "waiting_input"] as const) {
    f.store.updateRun(f.run.id, { status });
    expect(hooks.active(binding.handle)).toBe(!TERMINAL_STATUSES.includes(status));
  }
  f.store.updateRun(f.run.id, { status: "queued" });
  for (const reason of ["checkpoint", "policy", "terminal", "lease", "unavailable"]) {
    const state = initialRunState(f.run);
    state.githubWait = { reason: `claim:${reason}`, since: 0, nextAttemptAt: 0 };
    f.store.setRunState(f.run.id, state);
    expect(hooks.active(binding.handle)).toBe(!["checkpoint", "policy"].includes(reason));
  }
});

test("terminal wait maps to the durable projection", async () => {
  const f = await fixture(),
    error = new ClaimWaitError("terminal");
  expect(error.reason).toBe("terminal");
  expect(error.message).toBe("Claim wait: terminal");
  mapClaimInterruption(f.store, f.run.id, error);
  expect(f.store.getRunState<RunState>(f.run.id)?.githubWait?.reason).toBe("claim:terminal");
});

test.each(["cancelled", "failed", "needs_human"] as const)(
  "engine %s uses terminal deferral",
  async (status) => {
    const f = await fixture(),
      authority = await held(f);
    const state = f.store.getRunState<RunState>(f.run.id) ?? initialRunState(f.run);
    Object.assign(state, { phase: "done", previewConfig: null, slottedCommands: [], agentFullSuite: "slot" });
    if (status === "failed") state.flow = "verify-change";
    if (status === "needs_human") state.needsHumanReason = "requires a decision";
    f.store.setRunState(f.run.id, state);
    const controller = new AbortController();
    if (status === "cancelled") controller.abort(new Error("cancelled"));
    expect(await executeRun({ ...f.engineDeps(), runClaim: authority }, f.run.id, controller.signal)).toBe(
      status,
    );
    expectDeferred(f, status);
  },
);

test.each(["wait", "blocked", "lost", "mismatch"] as const)(
  "terminal publication handles %s",
  async (kind) => {
    const f = await fixture(),
      authority = await held(f);
    f.defer("failed");
    const before = f.gh.calls("update").length;
    if (kind === "wait") spyOn(f.rt.leases, "settle").mockResolvedValue("pending");
    if (kind === "blocked")
      f.store.db.query("UPDATE shared_checkpoints SET committed_pointer=NULL WHERE run_id=?").run(f.run.id);
    if (kind === "lost") spyOn(f.rt.leases, "update").mockResolvedValue("lost");
    if (kind === "mismatch") spyOn(f.rt.leases, "update").mockResolvedValue("mismatch");
    expect(await f.publish()).toBe(kind === "lost" ? "done" : "wait");
    if (kind === "lost") {
      expect(f.store.getRun(f.run.id)).toMatchObject({
        status: "cancelled",
        error: "superseded: claim lost",
      });
      expect(authority.binding.lost).toBe(true);
      expect(f.store.checkpointRecord(f.run.id)?.terminal).toBeNull();
    } else {
      expect(f.store.getRun(f.run.id)?.status).toBe("queued");
      expect(f.store.getRunState<RunState>(f.run.id)?.githubWait?.reason).toBe(
        `claim:${kind === "wait" ? "terminal" : "checkpoint"}`,
      );
      expect(f.store.checkpointRecord(f.run.id)?.terminal).not.toBeNull();
    }
    expect(f.gh.calls("update")).toHaveLength(before);
  },
);

test("unconfirmed authority never admits, and a confirmed loss wins", async () => {
  const f = await fixture(),
    authority = await held(f);
  const acquire = spyOn(f.rt.leases, "acquire");
  spyOn(f.claims, "read").mockResolvedValue({ kind: "unconfirmed", error: "unavailable" });
  await expect(f.authority()).rejects.toMatchObject({ reason: "unavailable" });
  f.store.db.query("UPDATE claim_leases SET confirmed_state='lost' WHERE run_id=?").run(f.run.id);
  await expect(f.authority()).rejects.toBeInstanceOf(ClaimLostError);
  expect(acquire).not.toHaveBeenCalled();
  expect(authority.binding.handle.run).toBe(f.run.id);
});

test("terminal intent survives without a held row; empty publication is done", async () => {
  const f = await fixture();
  expect(await f.publish()).toBe("done");
  f.defer("failed");
  expect(await f.publish()).toBe("wait");
  expectDeferred(f, "failed");
  expect(f.gh.calls("update")).toHaveLength(0);
});

test.each(["hook", "row"])("loss confirmed during terminal upload is a loss, by %s", async (kind) => {
  const f = await fixture(),
    { binding } = await held(f),
    hooks = claimHooks(f.rt, f.store);
  f.defer();
  const put = f.blobs.put.bind(f.blobs);
  spyOn(f.blobs, "put").mockImplementation(async (...args) => {
    if (kind === "hook") hooks.onLost(binding.handle, null);
    else f.store.markLeaseLost(binding.handle.repo, binding.handle.ref);
    return put(...args);
  });
  const writes = f.gh.calls("update").length;
  expect(await f.publish()).toBe("done");
  expect(f.store.getRun(f.run.id)).toMatchObject({ status: "cancelled", error: "superseded: claim lost" });
  expect(f.store.checkpointRecord(f.run.id)?.terminal).toBeNull();
  expect(f.gh.calls("update")).toHaveLength(writes);
  expect(await f.publish()).toBe("done");
});

test("overlapping publications serialize and never requeue a finished run", async () => {
  const f = await fixture();
  await held(f);
  f.defer();
  expect(await Promise.all([f.publish(), f.publish()])).toEqual(["done", "done"]);
  expect(f.store.getRun(f.run.id)?.status).toBe("succeeded");
  expect(f.store.checkpointRecord(f.run.id)?.terminal).toBeNull();
  expect(await f.record()).toMatchObject({ state: "released", status: "succeeded" });
});

test("a terminal intent recorded before admission is published instead of granting authority", async () => {
  const f = await fixture();
  f.defer("failed");
  expect(await f.authority()).toBe("finished");
  expect(f.store.getRun(f.run.id)).toMatchObject({ status: "failed", error: "final reason" });
  expect(f.store.checkpointRecord(f.run.id)?.terminal).toBeNull();
  expect(await f.record()).toMatchObject({ state: "released", status: "failed" });
});

test("a terminal intent replaced during publication is published, not erased", async () => {
  const f = await fixture();
  await held(f);
  f.defer();
  const update = f.rt.leases.update.bind(f.rt.leases),
    statuses: unknown[] = [];
  spyOn(f.rt.leases, "update").mockImplementation(async (h, patch, opts) => {
    statuses.push(patch.status);
    if (statuses.length === 1) f.defer("cancelled");
    return update(h, patch, opts);
  });
  expect(await f.publish()).toBe("done");
  expect([statuses[0], statuses.at(-1)]).toEqual(["succeeded", "cancelled"]);
  expect(f.store.getRun(f.run.id)).toMatchObject({ status: "cancelled", error: "final reason" });
  expect(f.store.checkpointRecord(f.run.id)?.terminal).toBeNull();
  expect(await f.record()).toMatchObject({ state: "released", status: "cancelled" });
});

test("authority overlapping a publication lets the publisher reconcile a replaced intent", async () => {
  const f = await fixture();
  await held(f);
  f.defer();
  const update = f.rt.leases.update.bind(f.rt.leases);
  let overlapping: Promise<unknown> | undefined;
  spyOn(f.rt.leases, "update").mockImplementation(async (h, patch, opts) => {
    const result = await update(h, patch, opts);
    if (!overlapping) {
      f.defer("cancelled");
      overlapping = f.authority();
      await Promise.race([overlapping, Bun.sleep(100)]);
    }
    return result;
  });
  expect(await f.publish()).toBe("done");
  expect(await overlapping).toBe("finished");
  expect(f.store.getRun(f.run.id)).toMatchObject({ status: "cancelled", error: "final reason" });
  expect(f.store.checkpointRecord(f.run.id)?.terminal).toBeNull();
  expect(await f.record()).toMatchObject({ state: "released", status: "cancelled" });
});

test("a replaced intent survives an overlapping authority when the publisher waits", async () => {
  const f = await fixture();
  await held(f);
  f.defer();
  const update = f.rt.leases.update.bind(f.rt.leases);
  let overlapping: Promise<unknown> | undefined;
  spyOn(f.rt.leases, "update").mockImplementation(async (h, patch, opts) => {
    const result = await update(h, patch, opts);
    if (overlapping) return result;
    f.defer("cancelled");
    overlapping = f.authority();
    return "wait";
  });
  expect(await f.publish()).toBe("wait");
  expect(await overlapping).toBe("finished");
  expect(f.store.getRun(f.run.id)).toMatchObject({ status: "cancelled", error: "final reason" });
  expect(f.store.checkpointRecord(f.run.id)?.terminal).toBeNull();
  expect(await f.record()).toMatchObject({ state: "released", status: "cancelled" });
});
