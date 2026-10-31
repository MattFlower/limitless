import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TERMINAL_STATUSES } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { bindClaim, claimGuard, claimScope } from "../src/integrations/claim-guard.ts";
import { createClaimClient } from "../src/integrations/claim-ref.ts";
import { createLeaseManager } from "../src/integrations/leases.ts";
import { bindRunClaim, renewRunClaim, validateRunClaim } from "../src/pipeline/run-claim.ts";
import { LEASE } from "../src/util/claim-clock.ts";
import { GitHub } from "./claim-github-fake.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const checkpoint = `ckpt1:${"a".repeat(32)}:${"b".repeat(64)}`;
async function fixture(disk = false) {
  const dir = mkdtempSync(join(tmpdir(), "run-claim-"));
  const path = disk ? join(dir, "store.db") : ":memory:";
  const store = new Store(path);
  const repo = store.upsertRepo({
    slug: "owner/project",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, {
    repo: repo.slug,
    prompt: "work",
    sourceRef: { kind: "issue", repo: repo.slug, number: 12 },
  });
  const gh = new GitHub();
  const now = { inclusive: 1_000, exclusive: 1_000 };
  const clock = { sample: () => ({ ...now }) };
  const raw = createClaimClient({ gh: gh.gh, sample: clock.sample });
  const client = { read: mock(raw.read), write: mock(raw.write) };
  const f = { store, run, gh, now, client };
  cleanup.push(() => {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const create = () =>
    createLeaseManager({
      client,
      store: f.store,
      clock,
      member: "m-0123456789abcdef",
      gh: async () => `HTTP/2 200 OK\r\nDate: ${new Date(gh.clock).toUTCString()}\r\n\r\n{}`,
    });
  const manager = await create();
  const acquired = await manager.acquire(
    repo.slug,
    "refs/limitless/claims/12",
    { kind: "issue", number: 12, run: run.id, status: "running", checkpoint },
    { takeover: false },
  );
  if (acquired.kind !== "held") throw new Error("Expected fixture acquisition");
  const caller = mock(() => false);
  const binding = bindClaim(manager, acquired.handle, caller);
  const update = mock(manager.update);
  const authority = { binding, leases: { update } };
  return Object.assign(f, {
    create,
    manager,
    caller,
    binding,
    update,
    authority,
    path,
    execution: () => bindRunClaim(run, f.store, authority),
  });
}
const check = (binding: ReturnType<typeof bindClaim>) => () => claimScope.run([binding], claimGuard);

test("identity validation rejects missing, mismatched and unusable claims without renewal", async () => {
  const f = await fixture();
  const acquire = spyOn(f.manager, "acquire");
  for (const patch of [
    { run: "another" },
    { repo: "other/project" },
    { ref: "refs/limitless/claims/13" },
    { repo: "invalid" },
  ]) {
    const binding = bindClaim(f.manager, { ...f.binding.handle, ...patch }, () => false);
    expect(() => bindRunClaim(f.run, f.store, { ...f.authority, binding })).toThrow(
      new ClaimWaitError("unavailable"),
    );
  }
  for (const authority of [null, undefined])
    expect(() => bindRunClaim(f.run, f.store, authority)).toThrow(new ClaimWaitError("unavailable"));
  for (const run of [
    { ...f.run, repoSlug: "invalid" },
    { ...f.run, sourceRef: { kind: "issue" as const, repo: "other/project", number: 12 } },
    { ...f.run, sourceRef: { kind: "pull_request" as const, repo: "other/project", number: 12 } },
    { ...f.run, sourceRef: null, prompt: "Closes #7\nCloses #8" },
    { ...f.run, id: "!", sourceRef: null },
  ])
    expect(() => validateRunClaim(run, f.store, f.authority)).toThrow(new ClaimWaitError("unavailable"));
  f.store.upsertRepo({
    slug: "local/repo",
    kind: "local",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  expect(() => validateRunClaim({ ...f.run, repoSlug: "local/repo" }, f.store, f.authority)).toThrow(
    new ClaimWaitError("unavailable"),
  );
  const binding = bindClaim(f.manager, { ...f.binding.handle, repo: "OWNER/Project" }, () => false);
  expect(
    validateRunClaim({ ...f.run, repoSlug: "OWNER/PROJECT" }, f.store, { ...f.authority, binding }).binding,
  ).toBe(binding);
  expect(f.update).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
  acquire.mockRestore();
});

test("composition captures exact authority, delegates live behavior and preserves inherited scopes", async () => {
  const f = await fixture();
  const execution = f.execution();
  expect(Object.isFrozen(execution)).toBe(true);
  expect(Object.isFrozen(execution.binding)).toBe(true);
  expect(execution.binding.handle).toBe(f.binding.handle);
  await renewRunClaim(execution);
  expect(f.update).toHaveBeenCalledWith(f.binding.handle, {});
  expect(f.update.mock.calls[0]?.[0]).toBe(f.binding.handle);
  const inherited = bindClaim({ windowOpen: () => false }, f.binding.handle, () => false);
  await expect(claimScope.run([inherited], () => renewRunClaim(execution))).rejects.toEqual(
    new ClaimWaitError("lease"),
  );
  claimScope.run([inherited], () => expect(check(execution.binding)).toThrow(new ClaimWaitError("lease")));
  f.now.inclusive += LEASE.windowMs;
  f.now.exclusive += LEASE.windowMs;
  expect(execution.binding.windowOpen()).toBe(false);
  execution.binding.onLost(execution.binding.handle, null);
  expect(f.binding.lost).toBe(true);
  expect(execution.binding.lost).toBe(true);
});

test("durable decisions precede the inherited probe; missing and unreadable records fail closed", async () => {
  const f = await fixture();
  const { binding } = f.execution();
  for (const status of TERMINAL_STATUSES) {
    f.store.updateRun(
      f.run.id,
      { status, error: "rejected" },
      {
        postMergeRejection: { reason: "rejected" },
        needsHumanReason: "rejected",
        terminalReason: "rejected",
      },
    );
    expect(check(binding)).toThrow(new ClaimWaitError("cancelled"));
  }
  f.store.updateRun(f.run.id, { status: "running", error: "cancelled by owner" });
  expect(check(binding)).toThrow(new ClaimWaitError("cancelled"));
  expect(f.caller).not.toHaveBeenCalled();
  f.store.updateRun(f.run.id, { error: null });
  expect(check(binding)).not.toThrow();
  f.caller.mockReturnValue(true);
  expect(check(binding)).toThrow(new ClaimWaitError("cancelled"));
  f.caller.mockReturnValue(false);
  const get = spyOn(f.store, "getRun");
  try {
    get.mockReturnValue(null);
    expect(check(binding)).toThrow(new ClaimWaitError("unavailable"));
    get.mockImplementation(() => {
      throw new Error("unreadable");
    });
    expect(check(binding)).toThrow(new ClaimWaitError("unavailable"));
    const control = new ClaimLostError();
    get.mockImplementation(() => {
      throw control;
    });
    expect(
      await Promise.resolve()
        .then(() => binding.cancelled())
        .catch((error: unknown) => error),
    ).toBe(control);
  } finally {
    get.mockRestore();
  }
});

test.each(["prelost", "applied", "applied-lost", "closed", "wait", "wait-lost", "lost", "obsolete"])(
  "renewal matrix: %s",
  async (kind) => {
    const f = await fixture();
    if (kind === "prelost") f.binding.onLost(f.binding.handle, null);
    f.update.mockImplementation(async () => {
      if (kind === "wait-lost" || kind === "applied-lost") f.binding.onLost(f.binding.handle, null);
      if (kind === "closed") f.now.inclusive += 1_001;
      return kind === "lost" || kind === "obsolete" ? kind : kind.startsWith("wait") ? "wait" : "applied";
    });
    const work = renewRunClaim(f.execution());
    if (kind === "applied") await work;
    else
      await expect(work).rejects.toEqual(
        kind === "closed" || kind === "wait" ? new ClaimWaitError("lease") : new ClaimLostError(),
      );
    expect(f.update).toHaveBeenCalledTimes(kind === "prelost" ? 0 : 1);
    if (["lost", "obsolete", "wait-lost"].includes(kind)) expect(f.binding.lost).toBe(true);
  },
);

test("renewal preserves control identity and discards ordinary error text and causes", async () => {
  const f = await fixture();
  for (const error of [
    new ClaimLostError(),
    new ClaimWaitError("cancelled"),
    new ClaimWaitError("unavailable"),
    new Error(["private", "detail"].join(":")),
  ]) {
    const message = error.message;
    f.update.mockRejectedValue(error);
    const caught = await renewRunClaim(f.execution()).catch((e: unknown) => e);
    if (error instanceof ClaimWaitError || error instanceof ClaimLostError) expect(caught).toBe(error);
    else {
      expect(caught).toEqual(new ClaimWaitError("unavailable"));
      expect(caught).not.toHaveProperty("cause");
      expect(String(caught)).not.toContain(message);
    }
  }
});

test.each(["before-cas", "after-cas", "before-dispatch"])(
  "restart requires renewal after interruption %s",
  async (point) => {
    const f = await fixture(true);
    const h = f.binding.handle;
    let interrupted = false;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    f.gh.fault = async (request) => {
      if (request.step === "ref" && interrupted) throw new Error("Unreadable during interruption");
      if (request.step !== "update" || point === "before-dispatch") return;
      entered.resolve();
      await resume.promise;
      interrupted = true;
      if (point === "after-cas") f.gh.apply(request);
      throw new Error("Interrupted response");
    };
    const first = renewRunClaim(f.execution()).catch((e: unknown) => e);
    if (point !== "before-dispatch") {
      await entered.promise;
      resume.resolve();
      expect(await first).toEqual(new ClaimWaitError("lease"));
      expect(f.store.leaseRow(h.repo, h.ref)?.intent).not.toBeNull();
    } else await first;
    f.store.close();
    f.store = new Store(f.path);
    const manager = await f.create();
    const binding = bindClaim(manager, h, () => false);
    const update = mock(manager.update);
    const execution = bindRunClaim(f.run, f.store, { binding, leases: { update } });
    expect(check(binding)).toThrow(new ClaimWaitError("lease"));
    if (interrupted) {
      await expect(renewRunClaim(execution)).rejects.toEqual(new ClaimWaitError("lease"));
      expect(f.store.leaseRow(h.repo, h.ref)?.intent).not.toBeNull();
    }
    interrupted = false;
    f.gh.fault = undefined;
    const before = f.gh.calls("update").length;
    await renewRunClaim(execution);
    expect(f.gh.calls("update")).toHaveLength(before + 1);
    expect(f.store.leaseRow(h.repo, h.ref)?.intent).toBeNull();
    expect(check(execution.binding)).not.toThrow();
    await renewRunClaim(execution);
    expect(f.gh.calls("update")).toHaveLength(before + 2);
  },
);

test("renewal serializes checkpoint and release; stale callbacks cannot borrow successor ownership", async () => {
  const f = await fixture();
  const h = f.binding.handle;
  const execution = f.execution();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  f.gh.fault = async (request) => {
    if (request.step !== "update") return;
    entered.resolve();
    await resume.promise;
  };
  const renewing = renewRunClaim(execution).catch((e: unknown) => e);
  await entered.promise;
  const nextCheckpoint = `ckpt1:${"c".repeat(32)}:${"d".repeat(64)}`;
  const updating = f.manager.update(h, { checkpoint: nextCheckpoint, status: "waiting_input" });
  const releasing = f.manager.release(h);
  expect(f.gh.calls("update")).toHaveLength(2);
  expect(execution.binding.windowOpen()).toBe(false);
  f.gh.fault = undefined;
  resume.resolve();
  expect(await renewing).toEqual(new ClaimWaitError("lease"));
  expect(await updating).toBe("applied");
  expect(await releasing).toBe("released");
  const tip = await f.client.read(h.repo, h.ref);
  expect(tip).toMatchObject({
    kind: "tip",
    tip: { record: { state: "released", checkpoint: nextCheckpoint, status: "waiting_input" } },
  });
  const successor = await f.manager.acquire(
    h.repo,
    h.ref,
    { kind: "issue", number: 12, run: h.run, status: "running" },
    { takeover: false },
  );
  if (successor.kind !== "held") throw new Error("Expected successor");
  expect(successor.handle.generation).toBe(h.generation + 1);
  const before = f.gh.requests.length;
  await expect(renewRunClaim(execution)).rejects.toEqual(new ClaimLostError());
  expect(execution.binding.handle).toBe(h);
  expect(f.gh.requests).toHaveLength(before);
  expect(f.manager.windowOpen(successor.handle)).toBe(true);
});

test.each(["null-anchor", "stale-anchor", "unusable-time", "expired"])(
  "real manager cannot authorize %s renewal",
  async (kind) => {
    const f = await fixture();
    const write = f.client.write.getMockImplementation();
    if (!write) throw new Error("Missing client");
    if (kind.endsWith("anchor"))
      f.client.write.mockImplementation(async (...args) => {
        const result = await write(...args);
        if (result.kind !== "applied") return result;
        if (kind === "stale-anchor") f.now.inclusive += LEASE.windowMs;
        return { ...result, anchor: kind === "null-anchor" ? null : result.anchor };
      });
    else {
      f.now.inclusive += LEASE.expireMs;
      f.now.exclusive += LEASE.expireMs;
      if (kind === "expired") f.gh.clock += LEASE.expireMs;
      else f.gh.clock = Number.NaN;
    }
    const before = f.gh.calls("update").length;
    await expect(renewRunClaim(f.execution())).rejects.toEqual(
      kind === "expired" ? new ClaimLostError() : new ClaimWaitError("lease"),
    );
    expect(f.gh.calls("update")).toHaveLength(before + (kind.endsWith("anchor") ? 1 : 0));
  },
);
