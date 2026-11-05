import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { CreateRunRequest } from "../src/core/types.ts";
import { readOfflineProjection } from "../src/db/portable-projection.ts";
import { Store } from "../src/db/store.ts";
import { cachePath } from "../src/git/repos.ts";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { createClaimClient } from "../src/integrations/claim-ref.ts";
import { controlKey } from "../src/integrations/control-record.ts";
import { createControlStore } from "../src/integrations/control-store.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import { createLeaseManager } from "../src/integrations/leases.ts";
import type { CapabilityGate } from "../src/integrations/member-eligibility.ts";
import { parsePointer } from "../src/pipeline/checkpoint-settlement.ts";
import { localCheckpointer, NeedsHumanError } from "../src/pipeline/context.ts";
import { claimKey, claimRef, parseManifest } from "../src/pipeline/portable.ts";
import { createRunObjectExporter } from "../src/pipeline/run-object-export.ts";
import { createRunObjectValidator } from "../src/pipeline/run-object-quarantine.ts";
import { createRunTransfer } from "../src/pipeline/run-transfer.ts";
import { receiptDescriptors } from "../src/pipeline/run-transfer-integrity.ts";
import { admitRun, refuseSharedRequest, type SharedRuntime } from "../src/pipeline/shared-admission.ts";
import { createCheckpointCommitter } from "../src/pipeline/shared-checkpointer.ts";
import { LEASE } from "../src/util/claim-clock.ts";
import { sh } from "../src/util/proc.ts";
import { GitHub } from "./claim-github-fake.ts";
import { fixture as memberFixture } from "./member-support.ts";
import { seeded } from "./seeded.ts";
import { deferred, Remote } from "./shared-store-fake.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  mock.restore();
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function admissionClock() {
  let now = 0;
  const pending = new Map<object, { at: number; fn(): void }>();
  return {
    now: () => now,
    pending,
    timer: {
      set(fn: () => void, ms: number) {
        const handle = {};
        pending.set(handle, { at: now + ms, fn });
        return handle;
      },
      clear(handle: unknown) {
        pending.delete(handle as object);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const [id, task] of pending)
        if (task.at <= now) {
          pending.delete(id);
          task.fn();
        }
    },
  };
}
async function fixture(disk = false, sourceRef?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "shared-admission-"));
  const cfg = loadConfig({
    home: root,
    configDir: join(root, "config"),
    raw: { repos: { "example/project": { shared: true } } },
  });
  let store = new Store(disk ? cfg.paths.db : ":memory:");
  const gh = new GitHub(),
    remote = new Remote(),
    blobs = remote.client(),
    member = "m-0123456789abcdef";
  const repo = store.upsertRepo({
    slug: "example/project",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "Request", sourceRef });
  const clock = admissionClock();
  let inclusive = 1000,
    exclusive = 1000;
  const leaseClock = { sample: () => ({ inclusive, exclusive }) };
  const claims = createClaimClient({ gh: gh.gh, sample: leaseClock.sample });
  const timeGh: GhRunner = async (args, _signal, _stdin, target) => {
    expect(args).toEqual(["api", "--include", "rate_limit"]);
    expect(target).toBe(repo.slug);
    return `HTTP/2 200 OK\r\nDate: ${new Date(gh.clock).toUTCString()}\r\n\r\n{}`;
  };
  const c = memberFixture();
  const control = createControlStore({ ...c, claims, blobs, actor: () => ({ kind: "member", id: member }) });
  const gate: CapabilityGate = {
    admit: mock(async () => []),
    canContinue: async () => [],
    capableNow: () => true,
    forget() {},
  };
  const objects = {
    export: createRunObjectExporter({ scratchRoot: root }),
    validate: createRunObjectValidator({ scratchRoot: root }),
  };
  async function runtime(): Promise<SharedRuntime> {
    const leases = await createLeaseManager({ store, client: claims, member, clock: leaseClock, gh: timeGh });
    const transfer = createRunTransfer({
      source: store,
      objects,
      key: blobs.newKey,
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
    return {
      member,
      leases,
      claims,
      blobs,
      control,
      namer: c.namer,
      committer: createCheckpointCommitter({
        store,
        paths: cfg.paths,
        member,
        transfer,
        blobs,
        leases,
        claims,
      }),
      checkpointer: localCheckpointer(store),
      gate,
      clock,
      refreshCache: async () => {},
    };
  }
  const key = claimKey(run, store);
  if ("none" in key) throw new Error("fixture key");
  const f = {
    root,
    cfg,
    repo,
    run,
    gh,
    remote,
    blobs,
    claims,
    control,
    clock,
    objects,
    gate,
    key,
    rt: await runtime(),
    get store() {
      return store;
    },
    admit: (signal = new AbortController().signal) => admitRun(f.rt, store, cfg, run, signal),
    async reopen() {
      store.close();
      store = new Store(cfg.paths.db);
      f.rt = await runtime();
    },
    expire() {
      inclusive += LEASE.expireMs + 2000;
      exclusive = inclusive;
      gh.clock += LEASE.expireMs + 2000;
    },
  };
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function tip(f: Fixture) {
  const result = await f.claims.read(f.repo.slug, claimRef(f.key));
  if (result.kind !== "tip" || result.tip.record === "malformed") throw new Error("fixture tip");
  return result.tip.record;
}
function indexKey(f: Fixture) {
  return controlKey(f.rt.namer, { kind: "run-index", runId: f.run.id, claim: f.key });
}
async function remoteCheckpoint(f: Fixture) {
  const pointer = parsePointer((await tip(f)).checkpoint ?? "");
  if (!pointer) throw new Error("fixture pointer");
  const bytes = await f.blobs.get(f.run.id, "manifest", pointer);
  const text = new TextDecoder().decode(bytes),
    manifest = parseManifest(text);
  if (typeof manifest !== "object" || !("runId" in manifest)) throw new Error("fixture manifest");
  return { text, manifest };
}

test("gate precedes acquire, verified checkpoint and immutable index; concurrency joins admission", async () => {
  const f = await fixture(),
    order: string[] = [];
  spyOn(f.gate, "admit").mockImplementation(async (task, signal) => {
    expect(task).toEqual({ runId: f.run.id, phase: "prepare", models: f.run.models, repo: f.repo });
    expect(signal).toBeInstanceOf(AbortSignal);
    order.push("admit");
    return [];
  });
  const acquire = f.rt.leases.acquire,
    update = f.rt.leases.update,
    put = f.blobs.put,
    get = f.blobs.get,
    mutate = f.control.mutate;
  const acquisitions = spyOn(f.rt.leases, "acquire").mockImplementation(async (...args) => {
    expect(args[3]).toEqual({ takeover: false });
    order.push("acquire");
    return acquire(...args);
  });
  spyOn(f.blobs, "put").mockImplementation((...args) => {
    order.push(`put:${args[1]}`);
    return put(...args);
  });
  spyOn(f.blobs, "get").mockImplementation((...args) => {
    order.push(`get:${args[1]}`);
    return get(...args);
  });
  const updates = spyOn(f.rt.leases, "update").mockImplementation((...args) => {
    expect(parsePointer(args[1].checkpoint ?? "")).not.toBeNull();
    order.push("update");
    return update(...args);
  });
  spyOn(f.control, "mutate").mockImplementation((...args) => {
    order.push("index");
    return mutate(...args);
  });
  const commits = spyOn(f.rt.committer, "commit");
  const handles = await Promise.all([f.admit(), f.admit()]);
  expect(handles[0]).toEqual(handles[1]);
  expect(handles[0]?.generation).toBe(1);
  expect(acquisitions).toHaveBeenCalledTimes(1);
  expect(commits).toHaveBeenCalledTimes(1);
  expect(updates).toHaveBeenCalledTimes(1);
  expect(order).toEqual([
    "admit",
    "acquire",
    "put:state",
    "get:state",
    "put:manifest",
    "get:manifest",
    "update",
    "index",
  ]);
  expect(f.store.checkpointRecord(f.run.id)).toMatchObject({ committed: { sequence: 1 }, indexed: true });
  expect(f.clock.pending.size).toBe(0);
});

test("a refusing gate performs no remote writes", async () => {
  const f = await fixture();
  spyOn(f.gate, "admit").mockResolvedValue(["stale"]);
  const acquire = spyOn(f.rt.leases, "acquire"),
    mutate = spyOn(f.control, "mutate");
  await expect(f.admit()).rejects.toMatchObject({ reason: "capability" });
  expect(acquire).not.toHaveBeenCalled();
  expect(mutate).not.toHaveBeenCalled();
  expect(f.gh.requests).toHaveLength(0);
  expect(f.remote.calls).toHaveLength(0);
  expect(f.clock.pending.size).toBe(0);
});

test("admission rechecks the lease window after upload before selecting a pointer", async () => {
  const f = await fixture(),
    put = f.blobs.put,
    update = spyOn(f.rt.leases, "update"),
    mutate = spyOn(f.control, "mutate");
  spyOn(f.blobs, "put").mockImplementationOnce(async (...args) => {
    const result = await put(...args);
    spyOn(f.rt.leases, "windowOpen").mockReturnValue(false);
    return result;
  });
  await expect(f.admit()).rejects.toMatchObject({ reason: "lease" });
  expect(update).not.toHaveBeenCalled();
  expect(mutate).not.toHaveBeenCalled();
  expect((await tip(f)).checkpoint).toBeUndefined();
  expect(f.store.checkpointRecord(f.run.id)?.committed).toBeFalsy();
  expect(f.store.getRun(f.run.id)?.status).toBe("queued");
});

test.each(["terminal", "live", "wait", "superseded"])(
  "acquisition %s maps to claim control without uploading",
  async (outcome) => {
    const f = await fixture();
    const acquire = f.rt.leases.acquire;
    const held = await acquire(
      f.repo.slug,
      claimRef(f.key),
      { kind: "run", run: f.run.id, status: "queued" },
      { takeover: false },
    );
    if (held.kind !== "held") throw new Error("fixture acquire");
    spyOn(f.rt.leases, "windowOpen").mockReturnValue(false);
    spyOn(f.rt.leases, "acquire").mockResolvedValue(
      outcome === "terminal" || outcome === "live"
        ? { kind: "refused", reason: outcome }
        : outcome === "wait"
          ? { kind: "wait", reason: "unknown" }
          : { kind: "superseded", tip: held.tip },
    );
    const result = await f.admit().catch((e: unknown) => e);
    if (outcome === "superseded") expect(result).toBeInstanceOf(ClaimLostError);
    else expect(result).toMatchObject({ reason: outcome === "terminal" ? "checkpoint" : "lease" });
    expect(f.remote.calls).toHaveLength(0);
  },
);

test.each(["equal", "conflict", "unconfirmed", "moved", "send"])(
  "index outcome %s marks indexed only on confirmed equality",
  async (outcome) => {
    const f = await fixture();
    await f.admit();
    f.store.db.query("UPDATE shared_checkpoints SET indexed=0 WHERE run_id=?").run(f.run.id);
    const published = await f.control.read(indexKey(f));
    if (!published) throw new Error("fixture index");
    spyOn(f.control, "mutate").mockImplementation(async (_key, _mutation, reduce) => {
      if (outcome === "unconfirmed") return { kind: "unconfirmed" };
      if (outcome === "moved") return { kind: "moved", tip: published };
      if (outcome === "send") return { kind: "unchanged", reason: "send", tip: published };
      if (outcome === "conflict") {
        reduce({
          ...published.manifest.value,
          kind: "run-index",
          runId: "other123",
          claim: { kind: "run", repo: f.repo.slug, runId: "other123" },
        });
        throw new Error("Should have refused");
      }
      expect(reduce(published.manifest.value)).toBeUndefined();
      return { kind: "unchanged", reason: "precondition", tip: published };
    });
    const commits = spyOn(f.rt.committer, "commit");
    if (outcome === "equal") await f.admit();
    else await expect(f.admit()).rejects.toMatchObject({ reason: "unavailable" });
    expect(f.store.checkpointRecord(f.run.id)?.indexed).toBe(outcome === "equal");
    expect(commits).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "caller cancellation is bounded and clears its timer, pre-aborted=%s",
  async (before) => {
    const f = await fixture(),
      controller = new AbortController(),
      entered = deferred<void>(),
      release = deferred<void>();
    spyOn(f.gate, "admit").mockImplementation(async (_task, signal) => {
      entered.resolve();
      await release.promise;
      expect(signal?.aborted).toBe(true);
      return [];
    });
    if (before) controller.abort();
    const result = f.admit(controller.signal).catch((e: unknown) => e);
    if (!before) {
      await entered.promise;
      controller.abort();
    }
    expect(await result).toMatchObject({ reason: "unavailable" });
    release.resolve();
    await flush();
    expect(f.clock.pending.size).toBe(0);
    expect(f.gh.requests).toHaveLength(0);
  },
);

test.each(["pin", "gate", "acquire", "update", "index"])(
  "restart after %s keeps one initial checkpoint and mutation",
  async (site) => {
    const f = await fixture(true);
    if (site === "pin") spyOn(f.gate, "admit").mockRejectedValueOnce(new Error("crash"));
    else if (site === "gate") spyOn(f.rt.leases, "acquire").mockRejectedValueOnce(new Error("crash"));
    else if (site === "acquire") {
      const acquire = f.rt.leases.acquire;
      spyOn(f.rt.leases, "acquire").mockImplementationOnce(async (...args) => {
        await acquire(...args);
        throw new Error("crash");
      });
    } else if (site === "update") {
      const update = f.rt.leases.update;
      spyOn(f.rt.leases, "update").mockImplementationOnce(async (...args) => {
        await update(...args);
        throw new Error("crash");
      });
    } else
      spyOn(f.store, "markRunIndexed").mockImplementationOnce(() => {
        throw new Error("crash");
      });
    await expect(f.admit()).rejects.toBeInstanceOf(ClaimWaitError);
    const index = await f.control.read(indexKey(f));
    // Inspect only the remotes at each crash: a published index always selects a readable manifest.
    if (index) expect((await remoteCheckpoint(f)).manifest.runId).toBe(f.run.id);
    await f.reopen();
    const acquire = spyOn(f.rt.leases, "acquire"),
      mutate = spyOn(f.control, "mutate");
    expect((await f.admit()).generation).toBe(1);
    for (const call of acquire.mock.calls) expect(call[3]).toEqual({ takeover: false });
    expect(f.store.checkpointRecord(f.run.id)).toMatchObject({
      committed: { sequence: 1 },
      pending: null,
      indexed: true,
    });
    expect(
      f.store.db.query("SELECT count(*) AS n FROM shared_checkpoints WHERE run_id=?").get(f.run.id),
    ).toEqual({ n: 1 });
    const published = await f.control.read(indexKey(f));
    expect(published?.manifest.mutations).toHaveLength(1);
    expect(published?.manifest.mutations[0]).toMatchObject({
      id: createHash("sha256").update(`run-index${f.run.id}`).digest("hex").slice(0, 32),
      actor: { kind: "member", id: f.rt.member },
    });
    if (site === "index")
      expect(await mutate.mock.results[0]?.value).toMatchObject({ kind: "applied", replayed: true });
  },
);

test("an expired restart never takes over or creates a second generation", async () => {
  const f = await fixture(true);
  spyOn(f.blobs, "put").mockRejectedValueOnce(new Error("crash"));
  await expect(f.admit()).rejects.toMatchObject({ reason: "unavailable" });
  f.expire();
  await f.reopen();
  const acquire = spyOn(f.rt.leases, "acquire");
  await expect(f.admit()).rejects.toBeInstanceOf(ClaimLostError);
  expect(acquire.mock.calls[0]?.[3]).toEqual({ takeover: false });
  expect((await tip(f)).generation).toBe(1);
});

test("a fresh coordinator imports the initial checkpoint using only shared records and blobs", async () => {
  const f = await fixture();
  await f.admit();
  const fresh = new Store(":memory:"),
    offline = new Store(":memory:");
  cleanup.push(() => {
    fresh.close();
    offline.close();
  });
  const index = await f.control.read(indexKey(f));
  expect(index?.manifest.value).toEqual({ kind: "run-index", runId: f.run.id, claim: f.key });
  const { text, manifest } = await remoteCheckpoint(f),
    blobs = new Map<string, Uint8Array>();
  for (const ref of receiptDescriptors(manifest))
    blobs.set(
      ref.key,
      await f.blobs.get(f.run.id, ref.key === manifest.blobs.state.key ? "state" : "objects", ref),
    );
  const transfer = createRunTransfer({
    source: fresh,
    offline: { store: offline, ownership: "exclusive-offline" },
    key: f.blobs.newKey,
    objects: f.objects,
    manifestContext: () => {
      throw new Error("No local export");
    },
  });
  await transfer.importRun({ manifest: text, blobs }, new AbortController().signal);
  expect(readOfflineProjection(offline.db, f.run.id)).toMatchObject({
    run: { id: f.run.id, status: "queued" },
    state: { phase: "prepare" },
  });
});

test("an ambiguous initial update settles without a second candidate", async () => {
  const f = await fixture(),
    puts = spyOn(f.blobs, "put"),
    commits = spyOn(f.rt.committer, "commit");
  let applied = false;
  f.gh.fault = (r) => {
    if (r.step === "update" && f.store.checkpointRecord(f.run.id)?.pending) {
      f.gh.apply(r);
      applied = true;
      throw new Error("Lost response");
    }
    if (applied && r.step === "ref") throw new Error("Unreadable");
  };
  await expect(f.admit()).rejects.toMatchObject({ reason: "lease" });
  const count = puts.mock.calls.length;
  await expect(f.admit()).rejects.toMatchObject({ reason: "lease" });
  expect(puts).toHaveBeenCalledTimes(count);
  f.gh.fault = undefined;
  await f.admit();
  expect(puts).toHaveBeenCalledTimes(count);
  expect(commits).toHaveBeenCalledTimes(1);
  expect(f.store.checkpointRecord(f.run.id)).toMatchObject({
    committed: { sequence: 1 },
    pending: null,
    indexed: true,
  });
});

test("losing the ledger after CAS blocks without overwriting the remote pointer", async () => {
  const f = await fixture();
  await f.admit();
  const before = await tip(f),
    update = spyOn(f.rt.leases, "update");
  f.store.db.query("DELETE FROM shared_checkpoints WHERE run_id=?").run(f.run.id);
  await expect(f.admit()).rejects.toMatchObject({ reason: "checkpoint" });
  expect(update).not.toHaveBeenCalled();
  expect(await tip(f)).toEqual(before);
});

test("one overall deadline aborts a stalled upload and leaves queued held work retryable", async () => {
  const f = await fixture(),
    entered = deferred<void>(),
    release = deferred<void>(),
    put = f.blobs.put;
  f.rt = { ...f.rt, admissionDeadlineMs: 100 };
  spyOn(f.blobs, "put").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return put(...args);
  });
  const result = f.admit().catch((e: unknown) => e);
  await entered.promise;
  f.clock.advance(101);
  expect(await result).toMatchObject({ reason: "unavailable" });
  expect(f.store.getRun(f.run.id)?.status).toBe("queued");
  expect(f.store.leaseRow(f.repo.slug, claimRef(f.key))?.confirmed?.state).toBe("held");
  expect(f.clock.pending.size).toBe(0);
  release.resolve();
  await flush();
  expect((await f.admit()).generation).toBe(1);
  expect(f.store.checkpointRecord(f.run.id)?.indexed).toBe(true);
});

test("a reused held lease never returns authority for a remotely finished run", async () => {
  const f = await fixture(),
    handle = await f.admit(),
    { checkpoint } = await tip(f);
  expect(
    await f.rt.leases.update(handle, { status: "succeeded" }, { expect: { checkpoint: checkpoint ?? null } }),
  ).toBe("applied");
  expect(f.store.getRun(f.run.id)?.status).toBe("queued");
  const acquire = spyOn(f.rt.leases, "acquire"),
    update = spyOn(f.rt.leases, "update");
  await expect(f.admit()).rejects.toMatchObject({ reason: "checkpoint" });
  expect(acquire).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect((await tip(f)).status).toBe("succeeded");
});

test("deadline expiry cancels settlement IO and a later pick starts fresh once it drains", async () => {
  const f = await fixture();
  f.rt = { ...f.rt, admissionDeadlineMs: 100 };
  spyOn(f.blobs, "put").mockRejectedValueOnce(new Error("crash"));
  await expect(f.admit()).rejects.toMatchObject({ reason: "unavailable" });
  expect(f.store.leaseRow(f.repo.slug, claimRef(f.key))?.confirmed?.state).toBe("held");
  const entered = deferred<AbortSignal | undefined>(),
    drain = deferred<void>();
  spyOn(f.claims, "read").mockImplementationOnce(async (_repo, _ref, signal) => {
    entered.resolve(signal);
    if (!signal) throw new Error("settlement read without a signal");
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    await drain.promise;
    throw signal.reason;
  });
  const expired = f.admit().catch((e: unknown) => e);
  const signal = await entered.promise;
  expect(signal).toBeInstanceOf(AbortSignal);
  f.clock.advance(101);
  expect(signal?.aborted).toBe(true);
  expect(await expired).toMatchObject({ reason: "unavailable" });
  const retry = f.admit();
  await flush();
  drain.resolve();
  expect((await retry).generation).toBe(1);
  expect(f.store.checkpointRecord(f.run.id)).toMatchObject({ committed: { sequence: 1 }, indexed: true });
});

test("fast individual steps still share one admission deadline", async () => {
  const f = await fixture();
  f.rt = { ...f.rt, admissionDeadlineMs: 100 };
  spyOn(f.gate, "admit").mockImplementation(async () => {
    f.clock.advance(60);
    return [];
  });
  const acquire = f.rt.leases.acquire;
  spyOn(f.rt.leases, "acquire").mockImplementation(async (...args) => {
    const r = await acquire(...args);
    f.clock.advance(60);
    return r;
  });
  await expect(f.admit()).rejects.toMatchObject({ reason: "unavailable" });
  expect(f.remote.calls).toHaveLength(0);
  expect(f.store.getRun(f.run.id)?.status).toBe("queued");
});

const seed = seeded(async (dir) => {
  await sh(["git", "init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "file.txt"), "initial\n");
  await sh(["git", "add", "."], { cwd: dir });
  await sh(["git", "commit", "-qm", "initial"], { cwd: dir });
  return (await sh(["git", "rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
});
test.each([false, true])(
  "cold PR cache refresh supplies commits before the real exporter: %s",
  async (supply) => {
    const f = await fixture(false, { kind: "pull_request", repo: "example/project", number: 12 });
    const source = join(f.root, "source"),
      { value: sha } = await seed(source);
    f.store.db
      .query("UPDATE runs SET source_ref=? WHERE id=?")
      .run(JSON.stringify({ ...f.run.sourceRef, baseSha: sha, headSha: sha }), f.run.id);
    const run = f.store.getRun(f.run.id);
    if (!run) throw new Error("fixture run");
    const cache = cachePath(f.cfg.paths, f.repo);
    mkdirSync(cache, { recursive: true });
    await sh(["git", "init", "--bare", "-q", cache], { cwd: f.root });
    let refreshed = false;
    const exporter = f.objects.export;
    spyOn(f.objects, "export").mockImplementation((...args) => {
      expect(refreshed).toBe(true);
      return exporter(...args);
    });
    f.rt = {
      ...f.rt,
      refreshCache: async (_repo, signal) => {
        if (supply) await sh(["git", "fetch", source, "main"], { cwd: cache, signal });
        refreshed = true;
      },
    };
    if (supply) {
      await admitRun(f.rt, f.store, f.cfg, run, new AbortController().signal);
      const { manifest } = await remoteCheckpoint(f);
      expect(manifest.blobs.objects).toHaveLength(1);
      expect(f.store.checkpointRecord(run.id)?.committed?.commits).toEqual([sha]);
    } else {
      await expect(admitRun(f.rt, f.store, f.cfg, run, new AbortController().signal)).rejects.toMatchObject({
        reason: "unavailable",
      });
      expect(f.remote.calls).toHaveLength(0);
    }
  },
);

test("request refusals happen without writes and preserve PR authority and local mode", async () => {
  const f = await fixture();
  const cases: [Partial<CreateRunRequest>, string | null][] = [
    [{ prompt: "Closes #12\nCloses #13" }, "Shared runs cannot close several issues"],
    [{ prompt: "Closes #12" }, "Shared issue runs require an issue source reference"],
    [{ dependsOn: [f.run.id] }, "Shared runs cannot have dependencies"],
    [{ sourceRef: { kind: "issue", repo: f.repo.slug, number: 12 }, prompt: "Closes #12\nCloses #13" }, null],
    [
      {
        sourceRef: { kind: "pull_request", repo: f.repo.slug, number: 12 },
        prompt: "Closes #12\nCloses #13",
      },
      null,
    ],
    [
      {
        sourceRef: { kind: "review-round", prUrl: "https://github.com/example/project/pull/12" },
        prompt: "Closes #12\nCloses #13",
      },
      null,
    ],
  ];
  for (const [partial, error] of cases) {
    const req = { repo: f.repo.slug, prompt: "Request", ...partial },
      before = f.store.db.serialize();
    const call = () => refuseSharedRequest(f.store, f.cfg, f.repo, req);
    if (error) expect(call).toThrow(error);
    else expect(call).not.toThrow();
    expect(f.store.db.serialize()).toEqual(before);
    expect(() => refuseSharedRequest(f.store, { ...f.cfg, repos: {} }, f.repo, req)).not.toThrow();
  }
});

test("commit needs-human and claim-control failures preserve identity; other failures are unavailable", async () => {
  const f = await fixture();
  for (const error of [new NeedsHumanError("refused"), new ClaimLostError(), new Error("private detail")]) {
    spyOn(f.rt.committer, "commit").mockRejectedValueOnce(error);
    const result = await f.admit().catch((e: unknown) => e);
    if (error instanceof NeedsHumanError || error instanceof ClaimLostError) expect(result).toBe(error);
    else expect(result).toMatchObject({ reason: "unavailable" });
    expect(f.store.getRun(f.run.id)?.status).toBe("queued");
  }
});
