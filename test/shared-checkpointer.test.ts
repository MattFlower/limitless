import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Paths } from "../src/config.ts";
import { recordProvisionalPolicy } from "../src/db/portable-policies.ts";
import { Store } from "../src/db/store.ts";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { bindClaim, claimGuard, claimScope } from "../src/integrations/claim-guard.ts";
import { type ClaimRecord, createClaimClient, formatRecord } from "../src/integrations/claim-ref.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import { createLeaseManager } from "../src/integrations/leases.ts";
import { formatPointer, parsePointer, settleCheckpoint } from "../src/pipeline/checkpoint-settlement.ts";
import { initialRunState, localCheckpointer, NeedsHumanError } from "../src/pipeline/context.ts";
import { claimKey, claimRef, parseManifest } from "../src/pipeline/portable.ts";
import { createRunTransfer } from "../src/pipeline/run-transfer.ts";
import { RunTransferError } from "../src/pipeline/run-transfer-errors.ts";
import { createCheckpointCommitter, sharedCheckpointer } from "../src/pipeline/shared-checkpointer.ts";
import { LEASE } from "../src/util/claim-clock.ts";
import { GitHub } from "./claim-github-fake.ts";
import { policyFixture, seal } from "./run-transfer-policy-support.ts";
import { deferred, Remote } from "./shared-store-fake.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  mock.restore();
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const foreign = formatPointer("f".repeat(32), "f".repeat(64));
async function fixture(disk = false) {
  const root = mkdtempSync(join(tmpdir(), "shared-checkpointer-"));
  const store = new Store(disk ? join(root, "db") : ":memory:"),
    gh = new GitHub(),
    remote = new Remote(),
    blobs = remote.client();
  const repo = store.upsertRepo({
    slug: "example/project",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "Request" });
  recordProvisionalPolicy(store, {
    runId: run.id,
    record: policyFixture().provisional,
    state: initialRunState(run),
    expected: null,
    expectedState: null,
  });
  let inclusive = 1000,
    exclusive = 1000;
  const clock = { sample: () => ({ inclusive, exclusive }) },
    member = "m-0123456789abcdef";
  const claims = createClaimClient({ gh: gh.gh, sample: clock.sample });
  const timeGh: GhRunner = async (args, _signal, _stdin, target) => {
    await Promise.resolve();
    expect(args).toEqual(["api", "--include", "rate_limit"]);
    expect(target).toBe(repo.slug);
    return `HTTP/2 200 OK\r\nDate: ${new Date(gh.clock).toUTCString()}\r\n\r\n{}`;
  };
  const managerDeps = { store, client: claims, clock, gh: timeGh, member };
  const leases = await createLeaseManager(managerDeps),
    key = claimKey(run, store);
  if ("none" in key) throw new Error("fixture claim");
  const acquired = await leases.acquire(
    repo.slug,
    claimRef(key),
    { kind: "run", run: run.id, status: run.status },
    { takeover: false },
  );
  if (acquired.kind !== "held") throw new Error("fixture acquire");
  const handle = acquired.handle,
    binding = bindClaim(leases, handle, () => false);
  const claim = {
    handle,
    guard: mock(() => claimScope.run([binding], claimGuard)),
    onLost: mock(binding.onLost),
  };
  const transfer = createRunTransfer({
    source: store,
    key: blobs.newKey,
    objects: {
      export: async (input) => {
        expect(input.commits).toEqual([]);
        return null;
      },
      validate: async () => {
        throw new Error("No objects expected");
      },
    },
    manifestContext: ({ run, state }) => {
      const key = claimKey(run, store);
      if ("none" in key) throw new Error("fixture claim");
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
  const paths: Paths = {
    home: root,
    db: join(root, "db"),
    repos: join(root, "repos"),
    work: join(root, "work"),
    runs: join(root, "runs"),
    configDir: join(root, "config"),
  };
  const deps = { store, paths, member, transfer, blobs, leases, claims };
  const committer = createCheckpointCommitter(deps),
    signal = new AbortController().signal;
  const f = {
    root,
    store,
    gh,
    remote,
    blobs,
    run,
    deps,
    managerDeps,
    leases,
    claims,
    binding,
    claim,
    signal,
    committer,
    commit: (patch?: { status: "succeeded" | "needs_human" }) =>
      committer.commit(run.id, claim, signal, patch),
    suspend() {
      inclusive += LEASE.suspendToleranceMs + 1;
    },
    expire() {
      inclusive += LEASE.expireMs + 2000;
      exclusive = inclusive;
      gh.clock += LEASE.expireMs + 2000;
    },
  };
  cleanup.push(() => {
    f.store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function record(f: Fixture): Promise<ClaimRecord> {
  const read = await f.claims.read(f.claim.handle.repo, f.claim.handle.ref);
  if (read.kind !== "tip" || read.tip.record === "malformed") throw new Error("fixture tip");
  return read.tip.record;
}
function manifest(f: Fixture) {
  const row = f.store.checkpointRecord(f.run.id)?.committed;
  const m = parseManifest(row?.manifest ?? "");
  if (typeof m !== "object" || !("runId" in m)) throw new Error("fixture manifest");
  return m;
}
function holdPut(f: Fixture) {
  const entered = deferred<void>(),
    release = deferred<void>(),
    put = f.blobs.put;
  spyOn(f.blobs, "put").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return put(...args);
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

test("journal crash leaves uploads unselected; reopening drops pending against the old pointer", async () => {
  const f = await fixture(true);
  await f.commit();
  const old = await record(f),
    committed = f.store.checkpointRecord(f.run.id)?.committed;
  f.claim.guard.mockImplementation(() => {
    if (f.store.checkpointRecord(f.run.id)?.pending) throw new Error("crash");
  });
  await expect(f.commit()).rejects.toThrow("crash");
  const pending = f.store.checkpointRecord(f.run.id)?.pending;
  expect(pending?.sequence).toBe(2);
  expect(f.remote.retained(f.run.id).has(parsePointer(pending?.pointer ?? "")?.key ?? "")).toBe(true);
  expect((await record(f)).checkpoint).toBe(old.checkpoint);
  expect(f.store.checkpointRecord(f.run.id)?.committed).toEqual(committed);
  f.store.close();
  f.store = new Store(join(f.root, "db"));
  const leases = await createLeaseManager({ ...f.managerDeps, store: f.store });
  expect((await settleCheckpoint({ ...f.deps, store: f.store, leases }, f.claim.handle)).settlement).toBe(
    "drop-pending",
  );
  expect(f.store.checkpointRecord(f.run.id)).toMatchObject({ committed, pending: null });
});

test("lost update response retains pending, then settlement promotes before building sequence three", async () => {
  const f = await fixture();
  await f.commit();
  let applied = false;
  f.gh.fault = (r) => {
    if (r.step === "update") {
      f.gh.apply(r);
      applied = true;
      throw new Error("Something went wrong");
    }
    if (applied && r.step === "ref") throw new Error("Unreadable");
  };
  await expect(f.commit()).rejects.toMatchObject({ reason: "lease" });
  const row = f.store.checkpointRecord(f.run.id);
  expect(row).toMatchObject({ committed: { sequence: 1 }, pending: { sequence: 2 } });
  await expect(f.commit()).rejects.toMatchObject({ reason: "lease" });
  expect(f.store.checkpointRecord(f.run.id)).toEqual(row);
  f.gh.fault = undefined;
  // A confirmed renewal restores the execution window after ambiguous lease recovery.
  expect(await f.leases.update(f.claim.handle, {})).toBe("applied");
  expect(await f.commit()).toBe("committed");
  expect(manifest(f)).toMatchObject({
    sequence: 3,
    previous: parsePointer(row?.pending?.pointer ?? "")?.digest,
  });
  expect(f.store.checkpointRecord(f.run.id)?.pending).toBeNull();
  expect((await record(f)).checkpoint).toBe(f.store.checkpointRecord(f.run.id)?.committed?.pointer);
});

test("saves queued during upload wait for a later commit and compatible requests coalesce", async () => {
  const f = await fixture(),
    hold = holdPut(f),
    order: number[] = [];
  const first = f.commit().then(() => order.push(1));
  await hold.entered;
  const second = f.commit().then(() => order.push(2)),
    third = f.commit().then(() => order.push(3));
  expect(order).toEqual([]);
  hold.release();
  await first;
  expect(order).toEqual([1]);
  const initial = f.store.checkpointRecord(f.run.id)?.committed?.pointer;
  await Promise.all([second, third]);
  expect(manifest(f)).toMatchObject({ sequence: 2, previous: parsePointer(initial ?? "")?.digest });
  expect(order).toEqual([1, 2, 3]);
});

test("queued requests with different status or authority cannot share publication", async () => {
  const f = await fixture(),
    hold = holdPut(f),
    first = f.commit();
  await hold.entered;
  const second = f.commit({ status: "succeeded" });
  const third = f.committer.commit(f.run.id, { ...f.claim, guard: () => f.claim.guard() }, f.signal, {
    status: "succeeded",
  });
  const fourth = f.commit({ status: "needs_human" });
  hold.release();
  await Promise.all([first, second, third, fourth]);
  expect(manifest(f).sequence).toBe(4);
  expect((await record(f)).status).toBe("needs_human");
});

test("another run commits while one is uploading; a queued abort does not block later work", async () => {
  const f = await fixture(),
    repo = f.store.getRepo(f.run.repoId);
  if (!repo) throw new Error("fixture repo");
  const run = f.store.createRun(repo, { repo: repo.slug, prompt: "Other request" });
  recordProvisionalPolicy(f.store, {
    runId: run.id,
    record: seal({ ...policyFixture().provisional, policyId: run.id }),
    state: initialRunState(run),
    expected: null,
    expectedState: null,
  });
  const key = claimKey(run, f.store);
  if ("none" in key) throw new Error("fixture claim");
  const held = await f.leases.acquire(
    repo.slug,
    claimRef(key),
    { kind: "run", run: run.id, status: "queued" },
    { takeover: false },
  );
  if (held.kind !== "held") throw new Error("fixture acquire");
  const binding = bindClaim(f.leases, held.handle, () => false),
    hold = holdPut(f),
    first = f.commit();
  await hold.entered;
  const controller = new AbortController(),
    reason = new Error("cancelled request");
  const aborted = f.committer.commit(f.run.id, f.claim, controller.signal).catch((error) => error);
  const next = f.commit();
  controller.abort(reason);
  expect(
    await f.committer.commit(
      run.id,
      { handle: held.handle, onLost: binding.onLost, guard: () => claimScope.run([binding], claimGuard) },
      f.signal,
    ),
  ).toBe("committed");
  expect(f.store.checkpointRecord(f.run.id)).toBeNull();
  hold.release();
  await first;
  expect(await aborted).toBe(reason);
  expect(await next).toBe("committed");
  expect(manifest(f).sequence).toBe(2);
});

test("settlement waits through journal/update/confirm and reports current", async () => {
  const f = await fixture(),
    entered = deferred<void>(),
    release = deferred<void>();
  f.gh.fault = async (r) => {
    if (r.step === "update") {
      entered.resolve();
      await release.promise;
    }
  };
  const commit = f.commit();
  await entered.promise;
  expect(f.store.checkpointRecord(f.run.id)).toMatchObject({ committed: null, pending: { sequence: 1 } });
  let settled = false;
  const settling = settleCheckpoint(f.deps, f.claim.handle).then((r) => {
    settled = true;
    return r;
  });
  await f.store.coordinateCheckpoint("independent", async () => {});
  expect(settled).toBe(false);
  release.resolve();
  await commit;
  expect((await settling).settlement).toBe("current");
});

test.each(["during-build", "before-journal"])(
  "an intervening commit %s forces a fresh successor",
  async (when) => {
    const f = await fixture(),
      other = createCheckpointCommitter(f.deps);
    const coordinate = f.store.coordinateCheckpoint;
    let calls = 0,
      intervened = "";
    if (when === "before-journal")
      spyOn(f.store, "coordinateCheckpoint").mockImplementation(async (id, fn) => {
        if (++calls === 2) {
          await other.commit(f.run.id, f.claim, f.signal);
          intervened = f.store.checkpointRecord(f.run.id)?.committed?.pointer ?? "";
        }
        return coordinate(id, fn);
      });
    const hold = when === "during-build" ? holdPut(f) : undefined,
      commit = f.commit();
    if (hold) {
      await hold.entered;
      await other.commit(f.run.id, f.claim, f.signal);
      intervened = f.store.checkpointRecord(f.run.id)?.committed?.pointer ?? "";
      hold.release();
    }
    await commit;
    expect(manifest(f)).toMatchObject({ sequence: 2, previous: parsePointer(intervened)?.digest });
    expect(f.gh.calls("update")).toHaveLength(3); // acquire plus two successors
  },
);

test.each(["removed", "fenced"])("fenced confirmation re-settles a %s ledger", async (kind) => {
  const f = await fixture(),
    confirm = f.store.confirmCheckpoint;
  spyOn(f.store, "confirmCheckpoint").mockImplementationOnce((id, pointer, expected) => {
    if (kind === "fenced") {
      f.store.setTerminalIntent(id, "{}");
    } else f.store.dropPendingCheckpoint(id, f.store.checkpointRecord(id));
    return confirm(id, pointer, expected);
  });
  if (kind === "removed") {
    await expect(f.commit()).rejects.toMatchObject({ reason: "checkpoint" });
    expect(f.store.checkpointRecord(f.run.id)).toMatchObject({ committed: null, pending: null });
  } else {
    expect(await f.commit()).toBe("committed");
    expect(manifest(f).sequence).toBe(2);
  }
  expect((await record(f)).checkpoint).toBeDefined();
});

test.each(["foreign", "unsupported", "empty-ledger"])(
  "initial divergence: %s blocks without writes",
  async (kind) => {
    const f = await fixture();
    if (kind !== "empty-ledger") await f.commit();
    const remote = formatRecord({ ...(await record(f)), checkpoint: foreign });
    f.gh.seed(
      kind === "unsupported" ? remote.replace(foreign, "ckpt2:unknown") : remote,
      f.claim.handle.ref,
      f.claim.handle.repo,
    );
    const before = f.store.checkpointRecord(f.run.id),
      run = f.store.getRun(f.run.id),
      writes = f.gh.calls("update").length;
    await expect(f.commit()).rejects.toMatchObject({ reason: "checkpoint" });
    expect(f.gh.calls("update")).toHaveLength(writes);
    expect(f.store.checkpointRecord(f.run.id)).toEqual(before);
    expect(f.store.getRun(f.run.id)).toEqual(run);
  },
);

test.each([false, true])(
  "divergence after settlement is atomically rejected, fallback=%s",
  async (fallback) => {
    const f = await fixture();
    if (fallback) spyOn(f.deps.transfer, "exportRun").mockRejectedValue(new RunTransferError("invalid"));
    f.claim.guard.mockImplementation(() => {
      f.gh.seed({ ...acquiredRecord, checkpoint: foreign }, f.claim.handle.ref, f.claim.handle.repo);
    });
    const acquiredRecord = await record(f),
      writes = f.gh.calls("update").length;
    const state = f.store.getRun(f.run.id);
    await expect(f.commit(fallback ? { status: "needs_human" } : undefined)).rejects.toMatchObject({
      reason: "checkpoint",
    });
    expect(f.gh.calls("update")).toHaveLength(writes);
    expect((await record(f)).checkpoint).toBe(foreign);
    expect(f.store.checkpointRecord(f.run.id)?.pending?.sequence).toBe(fallback ? undefined : 1);
    expect(f.store.getRun(f.run.id)).toEqual(state);
  },
);

test.each(["suspend", "successor"] as const)("paused upload cannot publish after %s", async (kind) => {
  const f = await fixture(),
    hold = holdPut(f),
    commit = f.commit();
  await hold.entered;
  if (kind === "suspend") f.suspend();
  else {
    f.expire();
    const successorStore = new Store(":memory:");
    cleanup.push(() => successorStore.close());
    const successor = await createLeaseManager({
      ...f.managerDeps,
      store: successorStore,
      member: "m-fedcba9876543210",
    });
    const acquired = await successor.acquire(
      f.claim.handle.repo,
      f.claim.handle.ref,
      { kind: "run", run: f.run.id, status: "running" },
      { takeover: true },
    );
    expect(acquired).toMatchObject({ kind: "held", handle: { generation: 2 } });
  }
  const writes = f.gh.calls("update").length;
  hold.release();
  await expect(commit).rejects.toBeInstanceOf(ClaimWaitError);
  expect(f.gh.calls("update")).toHaveLength(writes);
  expect((await record(f)).checkpoint).toBeUndefined();
  expect(f.leases.windowOpen(f.claim.handle)).toBe(false);
});

test.each(["lost", "obsolete"] as const)("%s notifies onLost and rejects", async (outcome) => {
  const f = await fixture();
  spyOn(f.leases, "update").mockResolvedValue(outcome);
  await expect(f.commit()).rejects.toBeInstanceOf(ClaimLostError);
  expect(f.claim.onLost).toHaveBeenCalledWith(f.claim.handle, null);
  expect(f.store.checkpointRecord(f.run.id)).toMatchObject({ committed: null, pending: { sequence: 1 } });
});

test.each([false, true])("refusal fallback preserves the settled pointer, existing=%s", async (existing) => {
  const f = await fixture();
  if (existing) await f.commit();
  const pointer = (await record(f)).checkpoint,
    before = f.store.checkpointRecord(f.run.id);
  spyOn(f.deps.transfer, "exportRun").mockRejectedValue(new RunTransferError("invalid"));
  await expect(f.commit()).rejects.toBeInstanceOf(NeedsHumanError);
  await expect(f.commit()).rejects.toThrow("Shared checkpoint refused: invalid");
  expect(await f.commit({ status: "needs_human" })).toBe("unchanged");
  expect((await record(f)).checkpoint).toBe(pointer);
  expect((await record(f)).status).toBe("needs_human");
  expect(f.store.checkpointRecord(f.run.id)).toEqual(before);
  expect(f.store.getRun(f.run.id)?.status).toBe("queued");
});

test.each(["wait", "abort", "transient", "lost"] as const)(
  "terminal patch does not mask %s",
  async (kind) => {
    const f = await fixture();
    const error =
      kind === "lost"
        ? new ClaimLostError()
        : new RunTransferError(kind === "abort" ? "aborted" : "unavailable");
    spyOn(f.deps.transfer, "exportRun").mockRejectedValue(
      kind === "wait" ? new RunTransferError("invalid") : error,
    );
    if (kind === "wait")
      f.gh.fault = (r) => {
        if (r.step === "update" || (r.step === "ref" && f.gh.calls("update").length > 1))
          throw new Error("Something went wrong");
      };
    await expect(f.commit({ status: "needs_human" })).rejects.toMatchObject(
      kind === "wait"
        ? { reason: "lease" }
        : kind === "transient"
          ? { reason: "unavailable" }
          : { name: error.name },
    );
    expect(f.store.checkpointRecord(f.run.id)).toBeNull();
  },
);

test("wrapper writes are synchronous, unlabelled/unregistered saves are local, labelled saves await and fail", async () => {
  const f = await fixture(),
    local = localCheckpointer(f.store),
    writeState = spyOn(local, "writeState"),
    writeRun = spyOn(local, "writeRun");
  const commit = spyOn(f.committer, "commit"),
    wrapper = sharedCheckpointer(local, f.committer, (id) =>
      id === f.run.id ? { binding: f.binding, signal: f.signal } : undefined,
    );
  const state = initialRunState(f.run),
    patch = { status: "running" as const };
  expect(wrapper.writeState(f.run.id, state)).toBeUndefined();
  const run = wrapper.writeRun(f.run.id, patch, state);
  expect<unknown>(run).toBe(writeRun.mock.results[0]?.value);
  expect(writeState.mock.calls[0]).toEqual([f.run.id, state]);
  expect(writeRun.mock.calls[0]?.[1]).toBe(patch);
  expect(writeRun.mock.calls[0]?.[2]).toBe(state);
  wrapper.writeRun(f.run.id, patch);
  expect(writeRun.mock.calls.at(-1)).toEqual([f.run.id, patch]);
  expect(wrapper.checkpoint(f.run.id)).toBeUndefined();
  expect(wrapper.checkpoint("unregistered", "label")).toBeUndefined();
  expect(commit).not.toHaveBeenCalled();
  const hold = holdPut(f),
    saving = wrapper.checkpoint(f.run.id, "label");
  await hold.entered;
  expect(f.store.checkpointRecord(f.run.id)).toBeNull();
  hold.release();
  expect(await saving).toBeUndefined();
  f.suspend();
  await expect(wrapper.checkpoint(f.run.id, "label")).rejects.toMatchObject({ reason: "lease" });
});
