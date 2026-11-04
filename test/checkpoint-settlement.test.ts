import { expect, mock, spyOn, test } from "bun:test";
import type { CheckpointEntry, CheckpointRecord } from "../src/db/shared-checkpoints.ts";
import { Store } from "../src/db/store.ts";
import type { ClaimRecord } from "../src/integrations/claim-ref.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import { createLeaseManager, type LeaseHandle } from "../src/integrations/leases.ts";
import {
  classify,
  formatPointer,
  parsePointer,
  settleCheckpoint,
} from "../src/pipeline/checkpoint-settlement.ts";
import { GitHub } from "./claim-github-fake.ts";

const pointer = (n: number) =>
  formatPointer(n.toString(16).padStart(32, "0"), n.toString(16).padStart(64, "0"));
const a = pointer(1),
  b = pointer(2),
  c = pointer(3);
const entry = (pointer: string, sequence = 0): CheckpointEntry => ({
  generation: 1,
  sequence,
  pointer,
  manifest: "opaque",
  commits: [],
});
const ledger = (committed: string | null, pending: string | null): CheckpointRecord => ({
  runId: "run",
  committed: committed ? entry(committed) : null,
  pending: pending ? entry(pending, 1) : null,
  terminal: null,
  indexed: false,
  updatedAt: 1,
});
test.each([
  [null, null, "current"],
  [null, ledger(null, b), "drop-pending"],
  [a, ledger(a, null), "current"],
  [a, ledger(a, b), "drop-pending"],
  [b, ledger(a, b), "promote"],
  [a, null, "blocked"],
  [c, ledger(a, b), "blocked"],
  [pointer(4), ledger(a, b), "blocked"],
  [null, ledger(a, b), "blocked"],
  ["unknown", ledger("unknown", b), "blocked"],
] as const)("classify %s against %j gives %s", (remote, row, expected) => {
  expect(classify(remote, row)).toBe(expected);
});
test("pointers round-trip and reject noncanonical or malformed components", () => {
  expect(parsePointer(a)).toEqual({ key: `${"0".repeat(31)}1`, digest: `${"0".repeat(63)}1` });
  for (const invalid of ["", `${a}\n`, a.toUpperCase(), a.slice(1), `${a}x`, `ckpt2:${a.slice(6)}`])
    expect(parsePointer(invalid)).toBeNull();
  expect(() => formatPointer("g".repeat(32), "b".repeat(64))).toThrow();
  expect(() => formatPointer("a".repeat(32), "b".repeat(63))).toThrow();
});

test.each(["promote", "drop-pending"] as const)(
  "lease intent settles before checkpoint %s",
  async (outcome) => {
    const store = new Store(":memory:"),
      gh = new GitHub();
    const handle: LeaseHandle = {
      repo: "owner/project",
      ref: "refs/limitless/claims/12",
      run: "run",
      member: "m-0123456789abcdef",
      generation: 1,
    };
    const record: ClaimRecord = {
      kind: "issue",
      number: 12,
      run: handle.run,
      holder: handle.member,
      generation: 1,
      state: "held",
      status: "running",
      checkpoint: a,
    };
    try {
      const sample = () => ({ inclusive: 1000, exclusive: 1000 }),
        claims = gh.client(sample());
      const leases = await createLeaseManager({
        store,
        client: claims,
        member: handle.member,
        clock: {
          sample,
        },
        gh: async () => `HTTP/2 200 OK\r\nDate: ${new Date(gh.clock).toUTCString()}\r\n\r\n{}`,
      });
      const tip = gh.seed(record);
      store.beginLeaseIntent(handle.repo, handle.ref, handle.run, {
        op: "acquire",
        before: "0".repeat(40),
        record,
        commit: tip.sha,
      });
      store.confirmLease(handle.repo, handle.ref, { generation: 1, state: "held", tip: tip.sha });
      store.journalCheckpoint(handle.run, entry(a));
      store.confirmCheckpoint(handle.run, a, store.checkpointRecord(handle.run));
      store.journalCheckpoint(handle.run, entry(b, 1));
      const after = { ...record, checkpoint: b };
      store.beginLeaseIntent(handle.repo, handle.ref, handle.run, {
        op: "update",
        before: tip.sha,
        record: after,
        commit: null,
      });
      if (outcome === "promote") gh.seed(after);
      const before = store.checkpointRecord(handle.run),
        read = mock(claims.read);
      gh.requests = [];
      gh.fault = (r) => {
        if (r.step === "ref") throw new Error("Unreadable");
      };
      const deps = { leases, claims: { read }, store };
      expect(await settleCheckpoint(deps, handle)).toEqual({ settlement: "wait", tip: null });
      expect(read).not.toHaveBeenCalled();
      expect(store.checkpointRecord(handle.run)).toEqual(before);
      gh.fault = undefined;
      expect((await settleCheckpoint(deps, handle)).settlement).toBe(outcome);
      expect(store.checkpointRecord(handle.run)).toMatchObject({
        committed: entry(outcome === "promote" ? b : a, outcome === "promote" ? 1 : 0),
        pending: null,
      });
      expect(gh.calls("commit")).toHaveLength(0);
      expect(gh.calls("update")).toHaveLength(0);
      store.journalCheckpoint(handle.run, entry(c, 2));
      const saved = store.checkpointRecord(handle.run);
      for (const changed of [{ generation: 2 }, { holder: "m-fedcba9876543210" }, { run: "another" }]) {
        gh.seed({ ...after, ...changed });
        expect((await settleCheckpoint(deps, handle)).settlement).toBe("blocked");
        expect(store.checkpointRecord(handle.run)).toEqual(saved);
      }
      gh.seed("malformed");
      expect((await settleCheckpoint(deps, handle)).settlement).toBe("blocked");
      gh.refs.clear();
      expect((await settleCheckpoint(deps, handle)).settlement).toBe("blocked");
      gh.fault = (r) => {
        if (r.step === "ref") throw new Error("Unreadable");
      };
      expect((await settleCheckpoint(deps, handle)).settlement).toBe("wait");
      expect(store.checkpointRecord(handle.run)).toEqual(saved);
    } finally {
      store.close();
    }
  },
);

async function fixture() {
  const store = new Store(":memory:"),
    gh = new GitHub(),
    sample = () => ({ inclusive: 1000, exclusive: 1000 }),
    claims = gh.client(sample());
  const timeGh: GhRunner = async (args, _signal, _stdin, target) => {
    await Promise.resolve();
    expect(args).toEqual(["api", "--include", "rate_limit"]);
    expect(target).toBe("owner/project");
    return `HTTP/2 200 OK\r\nDate: ${new Date(gh.clock).toUTCString()}\r\n\r\n{}`;
  };
  const leases = await createLeaseManager({
    store,
    client: claims,
    member: "m-0123456789abcdef",
    clock: { sample },
    gh: timeGh,
  });
  const acquired = await leases.acquire(
    "owner/project",
    "refs/limitless/claims/12",
    { kind: "issue", number: 12, run: "run", status: "running", checkpoint: a },
    { takeover: false },
  );
  if (acquired.kind !== "held") throw new Error(`Expected held, got ${acquired.kind}`);
  store.journalCheckpoint("run", entry(a));
  store.confirmCheckpoint("run", a, store.checkpointRecord("run"));
  return { store, gh, claims, leases, handle: acquired.handle };
}

test("settlement serializes a paused remote A observation against journal/publish of B", async () => {
  const f = await fixture();
  const observed = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  try {
    const read = async () => {
      const result = await f.claims.read(f.handle.repo, f.handle.ref);
      observed.resolve();
      await resume.promise;
      return result;
    };
    const settling = settleCheckpoint({ ...f, claims: { read } }, f.handle);
    await observed.promise;
    let publishing = false;
    const published = f.store.coordinateCheckpoint("run", async () => {
      publishing = true;
      f.store.journalCheckpoint("run", entry(b, 1));
      return f.leases.update(f.handle, { checkpoint: b }, { expect: { checkpoint: a } });
    });
    expect(await f.store.coordinateCheckpoint("another-run", async () => "independent")).toBe("independent");
    const overlapped = publishing;
    resume.resolve();
    const result = await settling;
    expect(await published).toBe("applied");
    expect(overlapped).toBe(false);
    expect(result.settlement).toBe("current");
    expect(await f.claims.read(f.handle.repo, f.handle.ref)).toMatchObject({
      kind: "tip",
      tip: { record: { checkpoint: b } },
    });
    expect(f.store.checkpointRecord("run")).toMatchObject({ committed: entry(a), pending: entry(b, 1) });
    expect((await settleCheckpoint(f, f.handle)).settlement).toBe("promote");
    expect(f.store.checkpointRecord("run")).toMatchObject({ committed: entry(b, 1), pending: null });
  } finally {
    resume.resolve();
    f.store.close();
  }
});

test.each(["during-read", "before-transition"] as const)(
  "settlement reobserves after ledger changes %s",
  async (when) => {
    const f = await fixture();
    try {
      f.store.journalCheckpoint("run", entry(b, 1));
      if (when === "before-transition")
        expect(await f.leases.update(f.handle, { checkpoint: b })).toBe("applied");
      const replacePending = () => {
        f.store.dropPendingCheckpoint("run", f.store.checkpointRecord("run"));
        f.store.journalCheckpoint("run", { ...entry(b, 1), generation: 2 });
      };
      if (when === "before-transition") {
        const confirm = f.store.confirmCheckpoint;
        spyOn(f.store, "confirmCheckpoint").mockImplementationOnce((...args) => {
          replacePending();
          return confirm(...args);
        });
      }
      let reads = 0;
      const read = mock(async () => {
        const result = await f.claims.read(f.handle.repo, f.handle.ref);
        if (++reads === 1 && when === "during-read") {
          replacePending();
          expect(await f.leases.update(f.handle, { checkpoint: b })).toBe("applied");
        }
        return result;
      });
      expect((await settleCheckpoint({ ...f, claims: { read } }, f.handle)).settlement).toBe("promote");
      expect(read).toHaveBeenCalledTimes(2);
      expect(f.store.checkpointRecord("run")).toMatchObject({
        committed: { ...entry(b, 1), generation: 2 },
        pending: null,
      });
    } finally {
      f.store.close();
    }
  },
);

test("checkpoint coordination releases a rejected scope and supports journal/publish/confirm", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  try {
    const failing = f.store.coordinateCheckpoint("run", async () => {
      entered.resolve();
      await resume.promise;
      throw new Error("Publication interrupted");
    });
    const rejected = failing.catch((error: unknown) => error);
    await entered.promise;
    let following = false;
    const queued = f.store.coordinateCheckpoint("run", async () => {
      following = true;
      f.store.journalCheckpoint("run", entry(b, 1));
      const expected = f.store.checkpointRecord("run");
      expect(await f.leases.settle(f.handle.repo, f.handle.ref)).toBe("settled");
      expect(await f.leases.update(f.handle, { checkpoint: b }, { expect: { checkpoint: a } })).toBe(
        "applied",
      );
      return f.store.confirmCheckpoint("run", b, expected);
    });
    await f.store.coordinateCheckpoint("another-run", async () => {});
    const overlapped = following;
    resume.resolve();
    expect(await rejected).toEqual(new Error("Publication interrupted"));
    expect(await queued).toBe(true);
    expect(overlapped).toBe(false);
    expect((await settleCheckpoint(f, f.handle)).settlement).toBe("current");
  } finally {
    resume.resolve();
    f.store.close();
  }
});
