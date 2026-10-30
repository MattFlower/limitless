import { afterEach, expect, mock, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { Store } from "../src/db/store.ts";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { bindClaim, claimGuard, claimScope, type ScopedClaim } from "../src/integrations/claim-guard.ts";
import {
  type ClaimClient,
  type ClaimRecord,
  type ClaimTip,
  createClaimClient,
  parseRecord,
} from "../src/integrations/claim-ref.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import {
  type AcquireResult,
  createLeaseManager,
  type LeaseHandle,
  type LeaseWant,
} from "../src/integrations/leases.ts";
import { LEASE } from "../src/util/claim-clock.ts";
import { GitHub } from "./claim-github-fake.ts";

const repo = "owner/project";
const ref = "refs/limitless/claims/12";
const member = "m-0123456789abcdef";
const other = "m-fedcba9876543210";
const checkpoint = `ckpt1:${"a".repeat(32)}:${"b".repeat(64)}`;
const want: LeaseWant = { kind: "issue", number: 12, run: "run-a", status: "running" };
const record: ClaimRecord = { ...want, holder: member, generation: 1, state: "held", checkpoint };
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function held(result: AcquireResult) {
  expect(result.kind).toBe("held");
  if (result.kind !== "held") throw new Error(`Expected held, got ${result.kind}`);
  return result;
}
function fixture(gh = new GitHub(), identity = member, probe = () => {}) {
  const store = new Store(":memory:");
  cleanup.push(() => store.close());
  let inclusive = 1_000;
  let exclusive = 1_000;
  let server = gh.clock;
  let usable = true;
  let callback: (() => void) | undefined;
  const wall = mock((): number => {
    throw new Error("Local wall time is forbidden");
  });
  const clock = { sample: () => ({ inclusive, exclusive }), wall };
  const times: number[] = [];
  const timeGh = mock<GhRunner>(async (args, _signal, _stdin, target) => {
    probe();
    await Promise.resolve();
    probe();
    expect(args).toEqual(["api", "--include", "rate_limit"]);
    expect(target).toBe(repo);
    times.push(server);
    return usable ? `HTTP/2 200 OK\r\nDate: ${new Date(server).toUTCString()}\r\n\r\n{}` : "";
  });
  const timer = {
    set: ((fn: () => void, ms: number) => {
      probe();
      expect(ms).toBe(LEASE.renewMs);
      callback = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clear: (() => {
      callback = undefined;
    }) as typeof clearInterval,
  };
  const underlying = createClaimClient({ gh: gh.gh, sample: clock.sample });
  const read = mock<ClaimClient["read"]>(async (...args) => {
    probe();
    await Promise.resolve();
    probe();
    return underlying.read(...args);
  });
  const write = mock<ClaimClient["write"]>(async (...args) => {
    probe();
    await Promise.resolve();
    probe();
    return underlying.write(...args);
  });
  const client: ClaimClient = { read, write };
  const bindings: ScopedClaim[] = [];
  const lost = mock((h: LeaseHandle, tip: ClaimTip | null) => {
    probe();
    for (const claim of bindings) claim.onLost(h, tip);
  });
  return {
    gh,
    store,
    clock,
    times,
    timeGh,
    lost,
    read,
    write,
    bind(manager: Awaited<ReturnType<typeof createLeaseManager>>, h: LeaseHandle) {
      const claim = bindClaim(manager, h, () => false);
      bindings.push(claim);
      return claim;
    },
    capture(): LeaseHandle {
      const row = store.leaseRow(repo, ref);
      if (!row) throw new Error("Missing recovery identity");
      return {
        repo: row.repo,
        ref: row.ref,
        run: row.runId,
        member: identity,
        generation: row.confirmed?.generation ?? row.intent?.record.generation ?? 0,
      };
    },
    create: () => createLeaseManager({ client, store, clock, gh: timeGh, member: identity, timer }),
    advance(ms: number, suspend = false) {
      inclusive += ms;
      if (!suspend) exclusive += ms;
      server += ms;
      gh.clock = server;
    },
    time(ms: number) {
      server = ms;
      gh.clock = ms;
    },
    usable(value: boolean) {
      usable = value;
    },
    async tick() {
      await callback?.();
    },
    start(manager: Awaited<ReturnType<typeof createLeaseManager>>, active = true) {
      const stop = manager.start({ active: () => active, onLost: lost });
      cleanup.push(stop);
      return stop;
    },
    acquire(manager: Awaited<ReturnType<typeof createLeaseManager>>, takeover = false, request = want) {
      return manager.acquire(repo, ref, request, { takeover });
    },
    row: () => store.leaseRow(repo, ref),
    raw: () => store.db.query("SELECT * FROM claim_leases").all(),
    tip() {
      const sha = gh.refs.get(gh.key(repo, ref));
      const commit = sha && gh.commits.get(sha);
      if (!commit) throw new Error("Missing tip");
      const r = parseRecord(commit.message, ref);
      if (r === "malformed") throw new Error("Malformed tip");
      return r;
    },
    confirmed(r = record) {
      const tip = gh.seed(r);
      store.beginLeaseIntent(repo, ref, r.run, {
        op: "acquire",
        before: "0".repeat(40),
        record: r,
        commit: tip.sha,
      });
      store.confirmLease(repo, ref, { generation: r.generation, tip: tip.sha, state: r.state });
      return tip;
    },
  };
}

function expectGuard(claim: ScopedClaim, reason?: "lease" | "lost") {
  const check = () => claimScope.run([claim], claimGuard);
  if (!reason) expect(check).not.toThrow();
  else if (reason === "lost") expect(check).toThrow(ClaimLostError);
  else expect(check).toThrow(expect.objectContaining({ name: "ClaimWaitError", reason }));
}

async function race(unconditional: boolean, takeover: boolean) {
  const gh = new GitHub(unconditional);
  if (takeover) {
    gh.seed(record);
    gh.clock += LEASE.expireMs;
  }
  const a = fixture(gh, other);
  const b = fixture(gh, "m-aaaaaaaaaaaaaaaa");
  const [ma, mb] = await Promise.all([a.create(), b.create()]);
  // Hold both commits until both managers have decided from the same old ref.
  const ready = Promise.withResolvers<void>();
  let commits = 0;
  gh.fault = async (r) => {
    if (r.step === "commit") {
      if (++commits === 2) ready.resolve();
      await ready.promise;
    }
  };
  const results = await Promise.all([a.acquire(ma, takeover), b.acquire(mb, takeover)]);
  const winners = results.filter((r) => r.kind === "held");
  expect(winners).toHaveLength(1);
  for (const winner of winners) expect(held(winner).handle.generation).toBe(takeover ? 2 : 1);
  expect(results.find((r) => r.kind !== "held")).toMatchObject({ kind: "refused", reason: "live" });
}
test.each(["create", "takeover"])("concurrent %s: CAS single winner", (mode) =>
  race(false, mode === "takeover"),
);
test.each(["create", "takeover"])(
  "concurrent %s: unconditional-ref-write mutant fails the same single-winner assertions",
  async (mode) => {
    await expect(race(true, mode === "takeover")).rejects.toThrow("toHaveLength");
  },
);

test.each([
  ["same run", "run-a", "succeeded", "held"],
  ["fresh lineage", "run-b", "succeeded", "held"],
  ["needs human", "run-b", "needs_human", "refused"],
] as const)("released tip: %s", async (_name, run, status, expected) => {
  const f = fixture();
  f.confirmed({ ...record, state: "released", status });
  const manager = await f.create();
  const before = f.raw();
  const result = await f.acquire(manager, false, { ...want, run, checkpoint });
  expect(result.kind).toBe(expected);
  if (expected === "held") {
    expect(held(result).handle.generation).toBe(2);
    expect(f.tip()).toMatchObject({ generation: 2, run });
    expect(f.tip().checkpoint).toBe(run === want.run ? checkpoint : undefined);
    expect(f.row()).toMatchObject({ runId: run, confirmed: { state: "held", generation: 2 }, intent: null });
  } else expect(f.raw()).toEqual(before);
});

test("fresh lineage protects confirmed ownership and reconciles pending intents first", async () => {
  for (const pending of [false, true]) {
    const f = fixture();
    const before = f.confirmed();
    const manager = await f.create();
    f.gh.seed({ ...record, state: "released", status: "succeeded" });
    if (pending)
      f.store.beginLeaseIntent(repo, ref, want.run, {
        op: "update",
        before: before.sha,
        record,
        commit: null,
      });
    const snapshot = f.raw();
    const requests = f.gh.requests.length;
    expect(await f.acquire(manager, true, { ...want, run: "run-b" })).toMatchObject(
      pending ? { kind: "wait" } : { kind: "refused", reason: "live" },
    );
    expect(f.raw()).toEqual(snapshot);
    expect(f.gh.requests.slice(requests).map((r) => r.step)).toEqual(pending ? ["ref", "commitRead"] : []);
  }
});

test("takeover lower bound: 9:59 refused, 10:00 inherited; unusable sample waits", async () => {
  const f = fixture();
  const tip = f.gh.seed({ ...record, holder: other });
  const manager = await f.create();
  f.time(Date.parse(tip.committedAt) + 599_000);
  expect(await f.acquire(manager, true)).toMatchObject({ kind: "refused", reason: "live" });
  f.usable(false);
  expect((await f.acquire(manager, true)).kind).toBe("wait");
  f.usable(true);
  f.time(Date.parse(tip.committedAt) + 600_000);
  const result = held(await f.acquire(manager, true));
  expect(result.tip.record).toMatchObject({ generation: 2, checkpoint });
  expect(f.clock.wall).not.toHaveBeenCalled();
});

test("expired own generation is lost, never renewed, and takeover creates generation 2", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
  const claim = f.bind(manager, h);
  f.start(manager);
  f.advance(LEASE.expireMs);
  f.gh.requests = [];
  expect(await claimScope.run([claim], () => manager.update(h, {}))).toBe("lost");
  expectGuard(claim, "lost");
  expect(f.row()?.confirmed?.state).toBe("lost");
  expect(f.gh.calls("update")).toHaveLength(0);
  expect((await f.acquire(manager)).kind).toBe("superseded");
  const successor = held(await f.acquire(manager, true)).handle;
  expect(successor.generation).toBe(2);
  expectGuard(f.bind(manager, successor));
  expectGuard(claim, "lost");
  expect(f.lost).toHaveBeenCalledTimes(1);
});

test("acquire itself loses an expired own generation and buffers its loss", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
  f.advance(LEASE.expireMs);
  expect((await f.acquire(manager)).kind).toBe("superseded");
  expect(f.row()?.confirmed?.state).toBe("lost");
  expect(f.lost).not.toHaveBeenCalled();
  f.start(manager);
  expect(f.lost).toHaveBeenCalledTimes(1);
  expect(f.lost).toHaveBeenCalledWith(h, expect.anything());
});

test("obsolete handles reject update, release and window checks before all requests or writes", async () => {
  const f = fixture();
  const manager = await f.create();
  const h1 = held(await f.acquire(manager)).handle;
  const claim = f.bind(manager, h1);
  const delayed = () => claimScope.run([claim], claimGuard);
  expect(Object.isFrozen(h1)).toBe(true);
  expect(await manager.release(h1, { checkpoint })).toBe("released");
  const h2 = held(await f.acquire(manager)).handle;
  expect(h2.generation).toBe(2);
  await Promise.resolve();
  expect(delayed).toThrow(ClaimWaitError);
  expectGuard(f.bind(manager, h2));
  // Even an intent must remain untouched by the obsolete callback.
  f.store.beginLeaseIntent(repo, ref, want.run, {
    op: "update",
    before: f.row()?.confirmed?.tip ?? "",
    record: f.tip(),
    commit: null,
  });
  const snapshot = f.raw();
  const requests = f.gh.requests.length;
  expect(manager.windowOpen(h2)).toBe(true);
  for (const stale of [h1, { ...h2, member: other }, { ...h2, run: "another-run" }]) {
    expect(await manager.update(stale, { status: "failed" })).toBe("obsolete");
    expect(await manager.release(stale)).toBe("obsolete");
    expect(manager.windowOpen(stale)).toBe(false);
    expect(manager.windowOpen(h2)).toBe(true);
  }
  expect(f.raw()).toEqual(snapshot);
  expect(f.gh.requests).toHaveLength(requests);
});

test("send revalidation after 5s suspend aborts and re-samples before takeover", async () => {
  const f = fixture();
  f.gh.seed({ ...record, holder: other });
  f.advance(LEASE.expireMs);
  const manager = await f.create();
  f.gh.fault = (r) => {
    if (r.step === "commit" && f.gh.calls("commit").length === 1) f.advance(5_000, true);
    if (r.step === "update") expect(f.times).toHaveLength(2);
  };
  expect(held(await f.acquire(manager, true)).handle.generation).toBe(2);
  expect(f.gh.calls("commit")).toHaveLength(2);
  expect(f.gh.calls("update")).toHaveLength(1);
  const update = f.gh.calls("update")[0];
  const latest = [...f.gh.commits.keys()].at(-1);
  if (!update || !latest) throw new Error("Missing takeover");
  expect(f.gh.update(update).afterOid).toBe(latest);
});

test.each(["unchanged", "unconfirmed"] as const)(
  "uncertain %s leaves ownership and anchor unchanged",
  async (mode) => {
    const f = fixture();
    const manager = await f.create();
    const h = held(await f.acquire(manager)).handle;
    const claim = f.bind(manager, h);
    f.start(manager, false);
    f.advance(LEASE.windowMs - 1_000);
    let unreadable = false;
    f.gh.fault = (r) => {
      if (r.step === "commit" && mode === "unchanged") throw new Error("Commit unavailable");
      if (r.step === "update" && mode === "unconfirmed") {
        f.gh.apply(r);
        unreadable = true;
        throw new Error("Lost response");
      }
      if (r.step === "ref" && unreadable) throw new Error("Unreadable");
    };
    const before = f.row()?.confirmed;
    expect(await manager.update(h, { status: "waiting_input" })).toBe("wait");
    expect(f.row()?.confirmed).toEqual(before);
    expect(f.row()?.intent !== null).toBe(mode === "unconfirmed");
    expect(manager.windowOpen(h)).toBe(true);
    expectGuard(claim);
    f.advance(1_000);
    expect(manager.windowOpen(h)).toBe(false);
    expectGuard(claim, "lease");
    expect(f.lost).not.toHaveBeenCalled();
  },
);

test("loop renewal and update serialize and preserve waiting_input", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
  f.start(manager);
  const entered = Promise.withResolvers<void>();
  const unblock = Promise.withResolvers<void>();
  let blocked = false;
  f.gh.fault = async (r) => {
    if (r.step === "commit" && !blocked) {
      blocked = true;
      entered.resolve();
      await unblock.promise;
    }
  };
  const tick = f.tick();
  await entered.promise;
  const update = manager.update(h, { status: "waiting_input" });
  await setImmediate();
  expect(f.gh.calls("commit")).toHaveLength(2);
  unblock.resolve();
  await tick;
  expect(await update).toBe("applied");
  expect(f.tip().status).toBe("waiting_input");
  expect(manager.windowOpen(h)).toBe(true);
});

test("same-holder moved retries without reporting loss; repeated contention waits", async () => {
  for (const repeat of [false, true]) {
    const f = fixture();
    const manager = await f.create();
    const h = held(await f.acquire(manager)).handle;
    const claim = f.bind(manager, h);
    f.start(manager, false);
    let moved = 0;
    f.gh.fault = (r) => {
      if (r.step === "update" && (repeat || moved++ === 0))
        f.gh.seed({ ...f.tip(), status: "waiting_input" });
    };
    expect(await manager.update(h, { checkpoint })).toBe(repeat ? "wait" : "applied");
    expect(f.row()?.confirmed?.state).toBe("held");
    expect(f.lost).not.toHaveBeenCalled();
    expect(claim.lost).toBe(false);
    expectGuard(claim);
    if (repeat) {
      f.advance(LEASE.windowMs);
      expectGuard(claim, "lease");
    }
    if (!repeat) expect(f.tip()).toMatchObject({ status: "waiting_input", checkpoint });
  }
});

test.each(["absent", "released"] as const)(
  "same-holder moved acquisition from a %s tip retries without loss",
  async (start) => {
    const f = fixture();
    if (start === "released") f.confirmed({ ...record, state: "released", status: "succeeded" });
    const manager = await f.create();
    f.start(manager, false);
    let moved = false;
    f.gh.fault = (r) => {
      if (r.step !== "update" || moved) return;
      moved = true;
      const sent = parseRecord(f.gh.commits.get(f.gh.update(r).afterOid)?.message ?? "", ref);
      if (sent === "malformed") throw new Error("Malformed attempt");
      f.gh.seed({ ...sent, status: "waiting_input" });
    };
    const generation = start === "absent" ? 1 : 2;
    expect(held(await f.acquire(manager)).handle.generation).toBe(generation);
    expect(f.gh.calls("update")).toHaveLength(2);
    expect(f.tip()).toMatchObject({ generation, holder: member, run: want.run, status: "waiting_input" });
    expect(f.row()).toMatchObject({
      confirmed: { generation, state: "held", tip: f.gh.refs.get(f.gh.key(repo, ref)) },
      intent: null,
    });
    expect(f.lost).not.toHaveBeenCalled();
  },
);

test("canonical repository shares a row and mutex while the first acquisition waits", async () => {
  const f = fixture();
  const manager = await f.create();
  const entered = Promise.withResolvers<void>();
  const unblock = Promise.withResolvers<void>();
  f.gh.fault = async (r) => {
    if (r.step === "commit" && f.gh.calls("commit").length === 1) {
      entered.resolve();
      await unblock.promise;
    }
  };
  const first = manager.acquire("Owner/Project", ref, want, { takeover: false });
  await entered.promise;
  const requests = f.gh.requests.length;
  const second = f.acquire(manager);
  await setImmediate();
  expect(f.gh.requests).toHaveLength(requests);
  unblock.resolve();
  expect(held(await first).handle.repo).toBe(repo);
  expect(held(await second).handle.generation).toBe(1);
  expect(f.store.leaseRow("Owner/Project", ref)).toEqual(f.row());
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM claim_leases").get()).toEqual({ n: 1 });
});

test("held expired tip never permits cross-run takeover", async () => {
  const f = fixture();
  f.gh.seed(record);
  f.advance(LEASE.expireMs);
  const manager = await f.create();
  expect(await f.acquire(manager, true, { ...want, run: "run-b" })).toMatchObject({
    kind: "refused",
    reason: "live",
  });
  expect(f.row()).toBeNull();
  expect(f.times).toEqual([]);
  expect(f.gh.calls("update")).toHaveLength(0);
});

test("recovery finishes before start and reports superseded confirmed ownership once", async () => {
  const f = fixture();
  const before = f.confirmed();
  f.store.beginLeaseIntent(repo, ref, want.run, { op: "renew", before: before.sha, record, commit: null });
  f.gh.seed({ ...record, holder: other, generation: 2 });
  const expected = f.capture();
  const manager = await f.create();
  const claim = f.bind(manager, expected);
  expectGuard(claim, "lease");
  expect(f.row()).toMatchObject({ confirmed: { generation: 1, state: "lost" }, intent: null });
  expect(f.lost).not.toHaveBeenCalled();
  const stop = f.start(manager);
  expectGuard(claim, "lost");
  expect(f.lost).toHaveBeenCalledTimes(1);
  expect(f.lost).toHaveBeenCalledWith({ repo, ref, run: want.run, member, generation: 1 }, null);
  stop();
  f.start(manager);
  await f.tick();
  expect(f.lost).toHaveBeenCalledTimes(1);
});

test("suspend closes the window and the first tick requires a renewable sample", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
  const stop = f.start(manager);
  expect(manager.windowOpen(h)).toBe(true);
  f.advance(120_000, true);
  expect(manager.windowOpen(h)).toBe(false);
  f.usable(false);
  await f.tick();
  expect(f.gh.calls("update")).toHaveLength(1);
  expect(f.row()?.confirmed?.state).toBe("held");
  f.usable(true);
  await f.tick();
  expect(f.gh.calls("update")).toHaveLength(2);
  expect(manager.windowOpen(h)).toBe(true);
  expect(f.lost).not.toHaveBeenCalled();
  stop();
  await f.tick();
  expect(f.gh.calls("update")).toHaveLength(2);
});

test("manager stays inert: no production module constructs it", async () => {
  const references: string[] = [];
  for await (const path of new Bun.Glob("src/**/*.ts").scan({
    cwd: new URL("..", import.meta.url).pathname,
  })) {
    const text = await Bun.file(new URL(`../${path}`, import.meta.url)).text();
    if (text.includes("createLeaseManager")) references.push(path);
  }
  expect(references).toEqual(["src/integrations/leases.ts"]);
});

test("expiry crossed while committing aborts renewal and calls onLost once", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
  f.start(manager, false);
  f.advance(598_000); // GitHub upper-bound age is now 9:59.
  f.gh.requests = [];
  f.gh.fault = (r) => {
    if (r.step === "commit") f.advance(2_000);
  };
  expect(await manager.update(h, {})).toBe("lost");
  expect(f.times).toHaveLength(2);
  expect(f.gh.calls("commit")).toHaveLength(1);
  expect(f.gh.calls("update")).toHaveLength(0);
  expect(f.row()).toMatchObject({ confirmed: { state: "lost" }, intent: null });
  expect(f.lost).toHaveBeenCalledTimes(1);
});

test("unconfirmed update reconciles on the loop without restart or an anchor refresh", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
  const claim = f.bind(manager, h);
  f.start(manager, false);
  f.advance(100_000);
  let unreadable = false;
  f.gh.fault = (r) => {
    if (r.step === "update") {
      f.gh.apply(r);
      unreadable = true;
      throw new Error("Lost response");
    }
    if (r.step === "ref" && unreadable) throw new Error("Unreadable");
  };
  expect(await manager.update(h, { status: "waiting_input" })).toBe("wait");
  const snapshot = f.raw();
  const requests = f.gh.requests.length;
  expect(await manager.update(h, {})).toBe("wait");
  expect(f.raw()).toEqual(snapshot);
  expect(f.gh.requests.slice(requests).map((r) => r.step)).toEqual(["ref"]);
  await f.tick();
  expect(f.raw()).toEqual(snapshot);
  f.advance(320_000);
  expect(manager.windowOpen(h)).toBe(false);
  expectGuard(claim, "lease");
  f.gh.fault = undefined;
  await f.tick();
  expect(f.row()).toMatchObject({
    confirmed: { state: "held", tip: f.gh.refs.get(f.gh.key(repo, ref)) },
    intent: null,
  });
  expect(manager.windowOpen(h)).toBe(false);
  expectGuard(claim, "lease");
  expect(f.lost).not.toHaveBeenCalled();
  expect(await manager.update(h, {})).toBe("applied");
  expect(f.tip().status).toBe("waiting_input");
});

test("run B can acquire after run A's failed first acquisition", async () => {
  const f = fixture();
  const manager = await f.create();
  f.gh.fault = (r) => {
    if (r.step === "commit") throw new Error("Commit POST failed");
  };
  expect((await f.acquire(manager)).kind).toBe("wait");
  expect(f.row()).toBeNull();
  expect(f.gh.calls("update")).toHaveLength(0);
  f.gh.fault = undefined;
  expect(held(await f.acquire(manager, false, { ...want, run: "run-b" })).handle.generation).toBe(1);
  expect(f.tip()).toMatchObject({ generation: 1, run: "run-b" });
});

test("a sample made unusable before the decision waits without declaring loss", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
  f.start(manager, false);
  f.advance(LEASE.windowMs);
  const sample = f.clock.sample;
  let reads = 0;
  f.clock.sample = () => {
    if (++reads === 4) f.advance(5_000, true);
    return sample();
  };
  const before = f.raw();
  const writes = f.gh.calls("update").length;
  expect(await manager.update(h, {})).toBe("wait");
  expect(f.raw()).toEqual(before);
  expect(f.gh.calls("update")).toHaveLength(writes);
  expect(f.lost).not.toHaveBeenCalled();
});

test("own expired acquisition with takeover advances the generation and inherits", async () => {
  const f = fixture();
  const manager = await f.create();
  const old = held(await f.acquire(manager, false, { ...want, checkpoint })).handle;
  f.start(manager, false);
  f.advance(LEASE.expireMs);
  const result = held(await f.acquire(manager, true));
  expect(result.handle.generation).toBe(2);
  expect(result.tip.record).toMatchObject({ checkpoint });
  expect(manager.windowOpen(old)).toBe(false);
  expect(f.lost).toHaveBeenCalledTimes(1);
});

test("release uses the same expiry guard and preserves checkpoint unless patched", async () => {
  for (const expired of [false, true]) {
    const f = fixture();
    const manager = await f.create();
    const h = held(await f.acquire(manager, false, { ...want, checkpoint })).handle;
    f.start(manager, false);
    if (expired) f.advance(LEASE.expireMs);
    const writes = f.gh.calls("update").length;
    expect(await manager.release(h, { status: "succeeded" })).toBe(expired ? "lost" : "released");
    expect(f.row()?.confirmed?.state).toBe(expired ? "lost" : "released");
    expect(f.gh.calls("update")).toHaveLength(writes + (expired ? 0 : 1));
    if (!expired) expect(f.tip()).toMatchObject({ state: "released", status: "succeeded", checkpoint });
  }
});

test("malformed tips refuse acquisition without a journal or write", async () => {
  const f = fixture();
  f.gh.seed("unrecognized record");
  const manager = await f.create();
  expect(await f.acquire(manager, true)).toMatchObject({ kind: "refused", reason: "malformed" });
  expect(f.row()).toBeNull();
  expect(f.gh.calls("commit")).toHaveLength(0);
});

test("a moved successor loses only confirmed ownership, and each generation is reported once", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
  const claim = f.bind(manager, h);
  f.start(manager, false);
  f.gh.fault = (r) => {
    if (r.step === "update") f.gh.seed({ ...record, holder: other, generation: 2 });
  };
  expect(await manager.update(h, {})).toBe("lost");
  expect(f.row()).toMatchObject({ confirmed: { generation: 1, state: "lost" }, intent: null });
  expect((await f.acquire(manager)).kind).toBe("superseded");
  expect(f.lost).toHaveBeenCalledTimes(1);
  expectGuard(claim, "lost");
  expect(await manager.release(h)).toBe("obsolete");
});

test("record-equivalent applied writes never manufacture an anchor", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
  const claim = f.bind(manager, h);
  expect(manager.windowOpen(h)).toBe(true);
  expectGuard(claim);
  f.gh.fault = (r) => {
    if (r.step === "update") {
      f.gh.seed(f.tip());
      throw new Error("Concurrent equivalent commit");
    }
  };
  expect(await manager.update(h, {})).toBe("applied");
  expect(manager.windowOpen(h)).toBe(false);
  expectGuard(claim, "lease");
});

test("reconciled release makes the old handle obsolete, without marking it lost", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
  const claim = f.bind(manager, h);
  f.start(manager, false);
  let unreadable = false;
  f.gh.fault = (r) => {
    if (r.step === "update") {
      f.gh.apply(r);
      unreadable = true;
      throw new Error("Lost response");
    }
    if (r.step === "ref" && unreadable) throw new Error("Unreadable");
  };
  expect(await manager.release(h)).toBe("wait");
  f.gh.fault = undefined;
  expect(await manager.update(h, {})).toBe("obsolete");
  expect(f.row()).toMatchObject({ confirmed: { state: "released" }, intent: null });
  expect(f.lost).not.toHaveBeenCalled();
  expectGuard(claim, "lease");
});

test.each(["unconfirmed", "unchanged"] as const)(
  "an ambiguous %s release closes the old holder's window before remote work",
  async (mode) => {
    const a = fixture();
    const b = fixture(a.gh, other);
    const ma = await a.create();
    const mb = await b.create();
    const h = held(await a.acquire(ma)).handle;
    const claim = a.bind(ma, h);
    a.start(ma, false);
    const entered = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    let unreadable = false;
    let applyLater: (() => void) | undefined;
    a.gh.fault = async (r) => {
      if (r.step === "update") {
        applyLater = () => a.gh.apply(r);
        entered.resolve();
        await unblock.promise;
        if (mode === "unconfirmed") {
          applyLater();
          unreadable = true;
        }
        throw new Error("Lost release response");
      }
      if (r.step === "ref" && unreadable) throw new Error("Unreadable");
    };
    const releasing = ma.release(h);
    expect(ma.windowOpen(h)).toBe(false);
    expectGuard(claim, "lease");
    await entered.promise;
    expect(ma.windowOpen(h)).toBe(false);
    expectGuard(claim, "lease");
    unblock.resolve();
    expect(await releasing).toBe("wait");
    expect(a.row()?.intent !== null).toBe(mode === "unconfirmed");
    const snapshot = a.raw();
    await a.tick();
    expect(a.raw()).toEqual(snapshot);
    expect(ma.windowOpen(h)).toBe(false);
    expectGuard(claim, "lease");
    a.gh.fault = undefined;
    applyLater?.();
    expect(held(await b.acquire(mb)).handle.generation).toBe(2);
    expect(a.row()?.confirmed?.state).toBe("held");
    expect(ma.windowOpen(h)).toBe(false);
    expectGuard(claim, "lease");
    expect(a.lost).not.toHaveBeenCalled();
  },
);

test("release closes the window while reconciliation is pending; dropping the intent cannot reopen it", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
  const claim = f.bind(manager, h);
  f.start(manager, false);
  let unreadable = false;
  f.gh.fault = (r) => {
    if (r.step === "update") {
      unreadable = true;
      throw new Error("Write not applied");
    }
    if (r.step === "ref" && unreadable) throw new Error("Unreadable");
  };
  expect(await manager.update(h, {})).toBe("wait");
  expect(manager.windowOpen(h)).toBe(true);
  expectGuard(claim);
  const snapshot = f.raw();
  const releasing = manager.release(h);
  expect(manager.windowOpen(h)).toBe(false);
  expectGuard(claim, "lease");
  expect(await releasing).toBe("wait");
  expect(f.raw()).toEqual(snapshot);
  f.gh.fault = undefined;
  await f.tick();
  expect(f.row()).toMatchObject({ confirmed: { state: "held" }, intent: null });
  expect(manager.windowOpen(h)).toBe(false);
  expectGuard(claim, "lease");
  expect(f.lost).not.toHaveBeenCalled();
  expect(held(await f.acquire(manager)).handle).toEqual(h);
  expect(f.times).toHaveLength(1);
  expect(manager.windowOpen(h)).toBe(true);
  expectGuard(claim);
});

test("an earlier in-flight renewal cannot reopen a window closed by release", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
  const claim = f.bind(manager, h);
  const entered = Promise.withResolvers<void>();
  const unblock = Promise.withResolvers<void>();
  const releaseEntered = Promise.withResolvers<void>();
  const releaseUnblock = Promise.withResolvers<void>();
  f.gh.fault = async (r) => {
    if (r.step !== "commit") return;
    if (f.gh.calls("commit").length === 2) {
      entered.resolve();
      await unblock.promise;
    } else {
      releaseEntered.resolve();
      await releaseUnblock.promise;
      throw new Error("Release commit failed");
    }
  };
  const renewal = manager.update(h, {});
  await entered.promise;
  const releasing = manager.release(h);
  expect(manager.windowOpen(h)).toBe(false);
  expectGuard(claim, "lease");
  unblock.resolve();
  expect(await renewal).toBe("applied");
  await releaseEntered.promise;
  expect(manager.windowOpen(h)).toBe(false);
  expectGuard(claim, "lease");
  releaseUnblock.resolve();
  expect(await releasing).toBe("wait");
  expect(manager.windowOpen(h)).toBe(false);
  expectGuard(claim, "lease");
});

test.each(["unchanged", "unconfirmed"] as const)(
  "renewals executing and queued before an ambiguous %s release cannot reopen its window",
  async (mode) => {
    const a = fixture();
    const b = fixture(a.gh, other);
    const ma = await a.create();
    const mb = await b.create();
    const h = held(await a.acquire(ma)).handle;
    const claim = a.bind(ma, h);
    a.start(ma, false);
    const entered = Promise.withResolvers<void>();
    const unblock = Promise.withResolvers<void>();
    let unreadable = false;
    let applyLater: (() => void) | undefined;
    a.gh.fault = async (r) => {
      if (r.step === "commit" && a.gh.calls("commit").length === 2) {
        entered.resolve();
        await unblock.promise;
      }
      if (r.step === "update") {
        const sent = parseRecord(a.gh.commits.get(a.gh.update(r).afterOid)?.message ?? "", ref);
        if (sent === "malformed" || sent.state !== "released") return;
        applyLater = () => a.gh.apply(r);
        if (mode === "unconfirmed") {
          applyLater();
          unreadable = true;
        }
        throw new Error("Lost release response");
      }
      if (r.step === "ref" && unreadable) throw new Error("Unreadable");
    };
    const executing = ma.update(h, {});
    await entered.promise;
    const queued = ma.update(h, { status: "waiting_input" });
    const releasing = ma.release(h);
    expect(ma.windowOpen(h)).toBe(false);
    expectGuard(claim, "lease");
    unblock.resolve();
    expect(await executing).toBe("applied");
    expect(await queued).toBe("applied");
    expect(await releasing).toBe("wait");
    expect(a.row()?.intent !== null).toBe(mode === "unconfirmed");
    expect(ma.windowOpen(h)).toBe(false);
    expectGuard(claim, "lease");
    a.gh.fault = undefined;
    expect(applyLater).toBeDefined();
    applyLater?.();
    expect(held(await b.acquire(mb)).handle.generation).toBe(2);
    expect(a.row()?.confirmed?.state).toBe("held");
    expect(ma.windowOpen(h)).toBe(false);
    expectGuard(claim, "lease");
    expect(a.lost).not.toHaveBeenCalled();
  },
);

test.each(["confirmed", "recovered acquisition", "loop-reconciled acquisition"] as const)(
  "renewal discovers %s without reacquisition or a manufactured anchor",
  async (mode) => {
    const f = fixture();
    const tip = f.gh.seed(record);
    f.store.beginLeaseIntent("Owner/Project", ref, want.run, {
      op: "acquire",
      before: "0".repeat(40),
      record,
      commit: tip.sha,
    });
    if (mode === "confirmed") f.store.confirmLease(repo, ref, { generation: 1, tip: tip.sha, state: "held" });
    if (mode === "loop-reconciled acquisition")
      f.gh.fault = (r) => {
        if (r.step === "ref") throw new Error("Unreadable");
      };
    const expected = f.capture();
    const manager = await f.create();
    const claim = f.bind(manager, expected);
    expectGuard(claim, "lease");
    const h = { repo, ref, run: want.run, member, generation: 1 };
    expect(manager.windowOpen(h)).toBe(false);
    expectGuard(claim, "lease");
    f.start(manager);
    f.advance(LEASE.renewMs);
    f.gh.fault = undefined;
    // Reconciliation and candidate registration must not supply a time anchor.
    f.usable(false);
    await f.tick();
    expect(f.row()).toMatchObject({ confirmed: { generation: 1, state: "held" }, intent: null });
    expect(f.gh.calls("update")).toHaveLength(0);
    expect(manager.windowOpen(h)).toBe(false);
    expectGuard(claim, "lease");
    f.usable(true);
    f.gh.fault = (r) => {
      if (r.step === "commit" && f.gh.calls("commit").length === 1) f.advance(5_000, true);
      if (r.step === "update") expect(f.times).toHaveLength(3);
    };
    await f.tick();
    expect(f.gh.calls("commit")).toHaveLength(2);
    expect(f.gh.calls("update")).toHaveLength(1);
    expect(f.row()).toMatchObject({ confirmed: { generation: 1, state: "held" }, intent: null });
    expect(manager.windowOpen(h)).toBe(true);
    expectGuard(claim);
    expectGuard(f.bind(manager, { ...expected, generation: expected.generation + 1 }), "lease");
  },
);

test.each([false, true])(
  "the first tick renews a recovered acquisition (pending at start: %s)",
  async (pending) => {
    const f = fixture();
    const tip = f.gh.seed(record);
    f.store.beginLeaseIntent(repo, ref, want.run, {
      op: "acquire",
      before: "0".repeat(40),
      record,
      commit: tip.sha,
    });
    if (pending)
      f.gh.fault = (r) => {
        if (r.step === "ref") throw new Error("Unreadable");
      };
    const expected = f.capture();
    const manager = await f.create();
    const claim = f.bind(manager, expected);
    expectGuard(claim, "lease");
    f.start(manager);
    f.advance(LEASE.renewMs);
    f.gh.fault = undefined;
    await f.tick();
    expect(f.row()).toMatchObject({ confirmed: { generation: 1, state: "held" }, intent: null });
    expect(f.gh.calls("update")).toHaveLength(1);
    expectGuard(claim);
  },
);

test("the first renewal tick renews recovered ownership only when active", async () => {
  const f = fixture();
  f.confirmed();
  const manager = await f.create();
  const seen = mock((h: LeaseHandle) => h.ref === ref);
  const stop = manager.start({ active: seen, onLost: f.lost });
  cleanup.push(stop);
  f.advance(LEASE.renewMs);
  await f.tick();
  expect(seen).toHaveBeenCalledWith({ repo, ref, run: want.run, member, generation: 1 });
  expect(f.gh.calls("update")).toHaveLength(1);
  expect(f.tip().generation).toBe(1);
  stop();
  f.start(await f.create(), false);
  f.advance(LEASE.renewMs);
  await f.tick();
  expect(f.gh.calls("update")).toHaveLength(1);
});

test("run B reconciles run A's unapplied pending acquisition before acquiring", async () => {
  const f = fixture();
  const manager = await f.create();
  let unreadable = false;
  f.gh.fault = (r) => {
    if (r.step === "update") {
      unreadable = true;
      throw new Error("Write not applied");
    }
    if (r.step === "ref" && unreadable) throw new Error("Unreadable");
  };
  expect((await f.acquire(manager)).kind).toBe("wait");
  expect(f.row()).toMatchObject({ confirmed: null, intent: { op: "acquire" } });
  const snapshot = f.raw();
  const next = { ...want, run: "run-b" };
  expect((await f.acquire(manager, false, next)).kind).toBe("wait");
  expect(f.raw()).toEqual(snapshot);
  expect(f.lost).not.toHaveBeenCalled();
  f.gh.fault = undefined;
  expect(held(await f.acquire(manager, false, next)).handle.generation).toBe(1);
  expect(f.row()).toMatchObject({ runId: "run-b", confirmed: { state: "held" }, intent: null });
});

test("manager operations and captured ticks independently exit blocked scopes", async () => {
  const sentinel = new AsyncLocalStorage<string>();
  const probe = mock(() => {
    claimGuard();
    expect(sentinel.getStore()).toBe("sentinel");
  });
  const blocked = bindClaim(
    { windowOpen: () => false },
    { repo, ref, run: want.run, member, generation: 0 },
    () => false,
  );
  await sentinel.run("sentinel", () =>
    claimScope.run([blocked], async () => {
      const f = fixture(new GitHub(), member, probe);
      const manager = await f.create();
      const h = held(await f.acquire(manager)).handle;
      expect(f.read).toHaveBeenCalledTimes(1);
      expect(f.write).toHaveBeenCalledTimes(1);
      expectGuard(blocked, "lease");
      expect(await manager.update(h, {})).toBe("applied");
      expect(f.read).toHaveBeenCalledTimes(2);
      expect(f.write).toHaveBeenCalledTimes(2);
      f.start(manager);
      await f.tick(); // Invoked here, rather than in the timer registration's context.
      expect(f.read).toHaveBeenCalledTimes(3);
      expect(f.write).toHaveBeenCalledTimes(3);
      expect(await manager.release(h)).toBe("released");
      expect(f.read).toHaveBeenCalledTimes(4);
      expect(f.write).toHaveBeenCalledTimes(4);
      expect(f.gh.requests.map((r) => r.step)).toEqual([
        "ref",
        "tree",
        "repository",
        "commit",
        "update",
        "ref",
        "commitRead",
        "commit",
        "update",
        "ref",
        "commitRead",
        "commit",
        "update",
        "ref",
        "commitRead",
        "commit",
        "update",
      ]);
      expect(f.times).toHaveLength(1);
      expect(probe).toHaveBeenCalledTimes(19);
      expect(sentinel.getStore()).toBe("sentinel");
      expectGuard(blocked, "lease");
    }),
  );
});

test.each(["release", "superseded", "pending"] as const)(
  "construction recovery exits scope and preserves captured %s identity",
  async (mode) => {
    const sentinel = new AsyncLocalStorage<string>();
    const probe = () => {
      claimGuard();
      expect(sentinel.getStore()).toBe("sentinel");
    };
    const f = fixture(new GitHub(), member, probe);
    const before = f.confirmed();
    const released = { ...record, state: "released" as const };
    f.store.beginLeaseIntent(repo, ref, want.run, {
      op: mode === "release" ? "release" : "update",
      before: before.sha,
      record: mode === "release" ? released : record,
      commit: null,
    });
    if (mode === "superseded") f.gh.seed({ ...record, generation: 2, holder: other });
    if (mode === "pending")
      f.gh.fault = () => {
        throw new Error("Unreadable");
      };
    const expected = f.capture(); // Construction may replace or remove the local records.
    const blocked = bindClaim({ windowOpen: () => false }, expected, () => false);
    await sentinel.run("sentinel", () =>
      claimScope.run([blocked], async () => {
        const manager = await f.create();
        const claim = f.bind(manager, expected);
        expectGuard(claim, "lease");
        expect(f.read).toHaveBeenCalledTimes(1);
        expect(f.write).toHaveBeenCalledTimes(mode === "release" ? 1 : 0);
        expect(f.times).toHaveLength(0);
        expect(f.gh.requests.map((r) => r.step)).toEqual(
          mode === "release"
            ? ["ref", "commitRead", "tree", "repository", "commit", "update"]
            : mode === "superseded"
              ? ["ref", "commitRead"]
              : ["ref"],
        );
        f.start(manager, false);
        expectGuard(claim, mode === "superseded" ? "lost" : "lease");
        expect(f.row()).toMatchObject(
          mode === "pending"
            ? { confirmed: { state: "held" }, intent: { op: "update" } }
            : { confirmed: { state: mode === "release" ? "released" : "lost" }, intent: null },
        );
        expectGuard(blocked, "lease");
        expect(sentinel.getStore()).toBe("sentinel");
      }),
    );
  },
);

test.each(["renewable", "unusable", "expired"] as const)(
  "a closed binding permits maintenance with a %s time sample",
  async (mode) => {
    const f = fixture();
    const manager = await f.create();
    const h = held(await f.acquire(manager)).handle;
    const claim = f.bind(manager, h);
    f.start(manager, false);
    f.advance(mode === "expired" ? LEASE.expireMs : LEASE.windowMs);
    if (mode === "unusable") f.usable(false);
    expectGuard(claim, "lease");
    const writes = f.write.mock.calls.length;
    expect(await claimScope.run([claim], () => manager.update(h, {}))).toBe(
      mode === "renewable" ? "applied" : mode === "unusable" ? "wait" : "lost",
    );
    expect(f.write).toHaveBeenCalledTimes(writes + (mode === "renewable" ? 1 : 0));
    expect(f.gh.calls("update")).toHaveLength(mode === "renewable" ? 2 : 1);
    expect(f.times).toHaveLength(1);
    expectGuard(claim, mode === "renewable" ? undefined : mode === "unusable" ? "lease" : "lost");
    expect(f.lost).toHaveBeenCalledTimes(mode === "expired" ? 1 : 0);
  },
);
