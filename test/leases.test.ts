import { afterEach, expect, mock, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { Store } from "../src/db/store.ts";
import { type ClaimRecord, createClaimClient, parseRecord } from "../src/integrations/claim-ref.ts";
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
function fixture(gh = new GitHub(), identity = member) {
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
    expect(args).toEqual(["api", "--include", "rate_limit"]);
    expect(target).toBe(repo);
    times.push(server);
    return usable ? `HTTP/2 200 OK\r\nDate: ${new Date(server).toUTCString()}\r\n\r\n{}` : "";
  });
  const timer = {
    set: ((fn: () => void, ms: number) => {
      expect(ms).toBe(LEASE.renewMs);
      callback = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clear: (() => {
      callback = undefined;
    }) as typeof clearInterval,
  };
  const client = createClaimClient({ gh: gh.gh, sample: clock.sample });
  const lost = mock((_h: LeaseHandle, _tip: unknown) => {});
  return {
    gh,
    store,
    clock,
    times,
    timeGh,
    lost,
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
  expect(winners).toHaveLength(unconditional ? 2 : 1);
  for (const winner of winners) expect(held(winner).handle.generation).toBe(takeover ? 2 : 1);
  if (!unconditional)
    expect(results.find((r) => r.kind !== "held")).toMatchObject({ kind: "refused", reason: "live" });
}
test.each(["CAS", "unconditional-ref-write mutant"])("concurrent create: %s", (mode) =>
  race(mode !== "CAS", false),
);
test.each(["CAS", "unconditional-ref-write mutant"])("concurrent takeover: %s", (mode) =>
  race(mode !== "CAS", true),
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

test("fresh lineage refuses an old run still confirmed held or pending, byte-identically", async () => {
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
    expect(await f.acquire(manager, true, { ...want, run: "run-b" })).toEqual({
      kind: "refused",
      reason: "live",
    });
    expect(f.raw()).toEqual(snapshot);
    expect(f.gh.requests).toHaveLength(requests);
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
  f.start(manager);
  f.advance(LEASE.expireMs);
  f.gh.requests = [];
  expect(await manager.update(h, {})).toBe("lost");
  expect(f.row()?.confirmed?.state).toBe("lost");
  expect(f.gh.calls("update")).toHaveLength(0);
  expect((await f.acquire(manager)).kind).toBe("superseded");
  expect(held(await f.acquire(manager, true)).handle.generation).toBe(2);
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
  expect(Object.isFrozen(h1)).toBe(true);
  expect(await manager.release(h1, { checkpoint })).toBe("released");
  const h2 = held(await f.acquire(manager)).handle;
  expect(h2.generation).toBe(2);
  // Even an intent must remain untouched by the obsolete callback.
  f.store.beginLeaseIntent(repo, ref, want.run, {
    op: "update",
    before: f.row()?.confirmed?.tip ?? "",
    record: f.tip(),
    commit: null,
  });
  const snapshot = f.raw();
  const requests = f.gh.requests.length;
  for (const stale of [h1, { ...h2, member: other }, { ...h2, run: "another-run" }]) {
    expect(await manager.update(stale, { status: "failed" })).toBe("obsolete");
    expect(await manager.release(stale)).toBe("obsolete");
    expect(manager.windowOpen(stale)).toBe(false);
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
    f.advance(1_000);
    expect(manager.windowOpen(h)).toBe(false);
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
});

test("same-holder moved retries without reporting loss; repeated contention waits", async () => {
  for (const repeat of [false, true]) {
    const f = fixture();
    const manager = await f.create();
    const h = held(await f.acquire(manager)).handle;
    f.start(manager, false);
    let moved = 0;
    f.gh.fault = (r) => {
      if (r.step === "update" && (repeat || moved++ === 0))
        f.gh.seed({ ...f.tip(), status: "waiting_input" });
    };
    expect(await manager.update(h, { checkpoint })).toBe(repeat ? "wait" : "applied");
    expect(f.row()?.confirmed?.state).toBe("held");
    expect(f.lost).not.toHaveBeenCalled();
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
  const manager = await f.create();
  expect(f.row()).toMatchObject({ confirmed: { generation: 1, state: "lost" }, intent: null });
  expect(f.lost).not.toHaveBeenCalled();
  const stop = f.start(manager);
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
  f.gh.fault = undefined;
  await f.tick();
  expect(f.row()).toMatchObject({
    confirmed: { state: "held", tip: f.gh.refs.get(f.gh.key(repo, ref)) },
    intent: null,
  });
  expect(manager.windowOpen(h)).toBe(false);
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
  f.start(manager, false);
  f.gh.fault = (r) => {
    if (r.step === "update") f.gh.seed({ ...record, holder: other, generation: 2 });
  };
  expect(await manager.update(h, {})).toBe("lost");
  expect(f.row()).toMatchObject({ confirmed: { generation: 1, state: "lost" }, intent: null });
  expect((await f.acquire(manager)).kind).toBe("superseded");
  expect(f.lost).toHaveBeenCalledTimes(1);
  expect(await manager.release(h)).toBe("obsolete");
});

test("record-equivalent applied writes never manufacture an anchor", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
  expect(manager.windowOpen(h)).toBe(true);
  f.gh.fault = (r) => {
    if (r.step === "update") {
      f.gh.seed(f.tip());
      throw new Error("Concurrent equivalent commit");
    }
  };
  expect(await manager.update(h, {})).toBe("applied");
  expect(manager.windowOpen(h)).toBe(false);
});

test("reconciled release makes the old handle obsolete, without marking it lost", async () => {
  const f = fixture();
  const manager = await f.create();
  const h = held(await f.acquire(manager)).handle;
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
});
