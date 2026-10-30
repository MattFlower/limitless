import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import { type ClaimRecord, type ClaimTip, parseRecord } from "../src/integrations/claim-ref.ts";
import {
  canonicalRepo,
  type Intent,
  reconcileLeaseIntent,
  recoverLeases,
} from "../src/integrations/lease-store.ts";
import { sh } from "../src/util/proc.ts";
import { GitHub } from "./claim-github-fake.ts";

const repo = "owner/project";
const ref = "refs/limitless/claims/12";
const zeros = "0".repeat(40);
const held: ClaimRecord = {
  kind: "issue",
  number: 12,
  state: "held",
  generation: 1,
  holder: "m-0123456789abcdef",
  run: "run-a",
  status: "running",
};
const release: ClaimRecord = {
  ...held,
  state: "released",
  status: "succeeded",
  checkpoint: `ckpt1:${"a".repeat(32)}:${"b".repeat(64)}`,
};
const successor: ClaimRecord = { ...held, generation: 2, holder: "m-fedcba9876543210", run: "run-b" };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(durable = false, unconditional = false) {
  const directory = durable ? mkdtempSync(join(tmpdir(), "lease-store-")) : null;
  const path = directory ? join(directory, "store.db") : ":memory:";
  let store = new Store(path);
  cleanups.push(() => {
    store.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const gh = new GitHub(unconditional);
  const client = gh.client();
  return {
    get store() {
      return store;
    },
    gh,
    client,
    reopen() {
      store.close();
      store = new Store(path);
    },
    recover: () => recoverLeases({ store, client }),
    reconcile: () => reconcileLeaseIntent({ store, client }, "Owner/Project", ref),
    journal(op: Intent["op"], before: ClaimTip | null, record = op === "release" ? release : held) {
      store.beginLeaseIntent("Owner/Project", ref, held.run, {
        op,
        before: before?.sha ?? zeros,
        record,
        commit: null,
      });
    },
    confirmed(record = held) {
      const tip = gh.seed(record);
      store.beginLeaseIntent(repo, ref, held.run, { op: "acquire", before: zeros, record, commit: tip.sha });
      store.confirmLease(repo, ref, { generation: record.generation, tip: tip.sha, state: record.state });
      return tip;
    },
  };
}
function raw(store: Store) {
  return store.db.query("SELECT * FROM claim_leases").all();
}
function tipRecord(gh: GitHub) {
  const sha = gh.refs.get(gh.key(repo, ref));
  const commit = sha && gh.commits.get(sha);
  if (!commit) throw new Error("Missing fake tip");
  return parseRecord(commit.message, ref);
}

test("store canonicalizes keys and preserves ownership until explicitly forgotten", () => {
  const f = fixture();
  const before = f.confirmed();
  expect(f.store.heldLeaseRows()).toEqual([
    {
      repo,
      ref,
      runId: held.run,
      confirmed: { generation: 1, tip: before.sha, state: "held" },
      intent: null,
    },
  ]);
  expect(f.store.leaseRow("Owner/Project", ref)).toEqual(f.store.leaseRow(repo, ref));
  expect(f.store.db.query("SELECT repo FROM claim_leases").get()).toEqual({ repo });
  expect(() => f.store.forgetLease(repo, ref)).toThrow();
  const intent: Intent = { op: "acquire", before: zeros, record: { ...held, run: "run-b" }, commit: null };
  expect(() => f.store.beginLeaseIntent(repo, ref, "run-b", intent)).toThrow();
  f.journal("renew", before);
  expect(() => f.journal("renew", before)).toThrow();
  expect(() => f.store.beginLeaseIntent(repo, ref, "run-b", intent)).toThrow();
  expect(() => f.store.forgetLease(repo, ref)).toThrow();
  f.store.confirmLease("Owner/Project", ref, { generation: 1, tip: before.sha, state: "released" }, false);
  expect(f.store.heldLeaseRows()).toEqual([]);
  expect(f.store.leaseRow(repo, ref)?.intent).not.toBeNull();
  expect(() => f.store.forgetLease(repo, ref)).toThrow();
  f.store.dropLeaseIntent("Owner/Project", ref);
  expect(f.store.leaseRow(repo, ref)?.confirmed).toEqual({
    generation: 1,
    tip: before.sha,
    state: "released",
  });
  expect(() => f.store.beginLeaseIntent(repo, ref, "run-b", intent)).toThrow();
  f.store.forgetLease("Owner/Project", ref);
  f.store.beginLeaseIntent(repo, ref, "run-b", intent);
  expect(f.store.heldLeaseRows()).toEqual([]);
  expect(f.store.leaseRow(repo, ref)).toMatchObject({ runId: "run-b", confirmed: null, intent });
  expect(() => f.store.forgetLease(repo, ref)).toThrow();
  f.store.dropLeaseIntent(repo, ref);
  f.store.forgetLease(repo, ref);
  expect(f.store.leaseRow(repo, ref)).toBeNull();
  expect(() => f.store.forgetLease(repo, ref)).toThrow();
  expect(() => f.store.setLeaseIntentCommit(repo, ref, before.sha)).toThrow();
});

test.each(["owner", "a/b/c", " owner/repo", "a/repo\n", "../repo", "owner/", "/repo"])(
  "invalid repository %j cannot address storage",
  (slug) => {
    const f = fixture();
    expect(() => canonicalRepo(slug)).toThrow();
    expect(() => f.store.leaseRow(slug, ref)).toThrow();
  },
);
test("invalid before or record/ref pairing rolls back the entire intent", () => {
  const f = fixture();
  for (const [before, record] of [
    ["A".repeat(40), held],
    [zeros, { ...held, number: 13 }],
  ] as const) {
    expect(() =>
      f.store.beginLeaseIntent(repo, ref, held.run, { op: "acquire", before, record, commit: null }),
    ).toThrow();
    expect(raw(f.store)).toEqual([]);
  }
});

test("restart replays only the exact final release and journals its commit before updateRefs", async () => {
  const f = fixture(true);
  const before = f.confirmed();
  f.journal("release", before);
  f.reopen();
  f.gh.fault = (r) => {
    if (r.step !== "update") return;
    expect(f.store.leaseRow(repo, ref)?.intent).toEqual({
      op: "release",
      before: before.sha,
      record: release,
      commit: f.gh.update(r).afterOid,
    });
    expect(f.store.leaseRow(repo, ref)?.confirmed).toEqual({ generation: 1, tip: before.sha, state: "held" });
  };
  expect(await f.recover()).toEqual({
    applied: [],
    replayed: [ref],
    dropped: [],
    superseded: [],
    pending: [],
  });
  expect(tipRecord(f.gh)).toEqual(release);
  const sha = f.gh.refs.get(f.gh.key(repo, ref));
  expect(f.store.leaseRow(repo, ref)).toMatchObject({
    confirmed: { generation: 1, tip: sha, state: "released" },
    intent: null,
  });
  expect(f.gh.calls("update")).toHaveLength(1);
  const update = f.gh.calls("update")[0];
  if (!update) throw new Error("Missing update");
  expect(f.gh.update(update).beforeOid).toBe(before.sha);
  expect(f.gh.requests.every((r) => r.repo === repo)).toBe(true);
  expect(await f.reconcile()).toBe("none");
});

test.each(["acquire", "renew", "update"] as const)(
  "restart drops unapplied %s without rewriting confirmed history",
  async (op) => {
    const f = fixture(true);
    const before = op === "acquire" ? null : f.confirmed();
    const history = f.store.leaseRow(repo, ref)?.confirmed ?? null;
    f.journal(op, before, { ...held, status: "waiting", checkpoint: release.checkpoint });
    f.reopen();
    expect((await f.recover()).dropped).toEqual([ref]);
    expect(f.store.leaseRow(repo, ref)).toMatchObject({ confirmed: history, intent: null });
    expect(f.gh.calls("update")).toHaveLength(0);
  },
);

test.each([false, true])(
  "restart recognizes an applied write after lost response; equal fields on another commit: %s",
  async (equalCommit) => {
    const f = fixture(true);
    const before = f.confirmed();
    f.journal("release", before);
    f.gh.fault = (r) => {
      if (r.step === "update") {
        f.gh.apply(r);
        throw new Error("Lost response");
      }
      if (r.step === "ref") throw new Error("Read unavailable");
    };
    expect(
      (
        await f.client.write(repo, ref, before, release, {
          onCommit: (sha) => f.store.setLeaseIntentCommit(repo, ref, sha),
        })
      ).kind,
    ).toBe("unconfirmed");
    const originalCommit = f.store.leaseRow(repo, ref)?.intent?.commit;
    if (equalCommit) expect(f.gh.seed(release).sha).not.toBe(originalCommit);
    f.gh.fault = undefined;
    f.reopen();
    expect((await f.recover()).applied).toEqual([ref]);
    expect(f.store.leaseRow(repo, ref)).toMatchObject({
      confirmed: { generation: 1, tip: f.gh.refs.get(f.gh.key(repo, ref)), state: "released" },
      intent: null,
    });
  },
);

test("restart drops an identical-record renewal that was never sent", async () => {
  const f = fixture(true);
  const before = f.confirmed();
  f.journal("renew", before, held);
  f.reopen();
  expect(await f.reconcile()).toBe("dropped");
  expect(f.store.leaseRow(repo, ref)).toMatchObject({
    confirmed: { generation: 1, tip: before.sha, state: "held" },
    intent: null,
  });
  expect(f.gh.calls("update")).toHaveLength(0);
});

test("failed acquisition commit POST leaves no ownership history and can be explicitly forgotten", async () => {
  const f = fixture(true);
  f.journal("acquire", null);
  f.gh.fault = (r) => {
    if (r.step === "commit") throw new Error("Commit failed");
  };
  expect((await f.client.write(repo, ref, null, held)).kind).toBe("unchanged");
  f.gh.fault = undefined;
  f.reopen();
  expect((await f.recover()).dropped).toEqual([ref]);
  expect(f.store.leaseRow(repo, ref)).toMatchObject({ confirmed: null, intent: null });
  f.store.forgetLease(repo, ref);
  f.store.beginLeaseIntent(repo, ref, "run-b", {
    op: "acquire",
    before: zeros,
    record: { ...held, run: "run-b" },
    commit: null,
  });
  expect(f.store.leaseRow(repo, ref)?.runId).toBe("run-b");
  expect(f.gh.calls("update")).toHaveLength(0);
});

test("recovery groups every pending ref across repositories and confirms an acquisition's generation", async () => {
  const f = fixture();
  f.journal("release", f.confirmed());
  for (const number of [13, 14, 15, 16]) {
    const repository = number === 16 ? "other/project" : repo;
    const name = `refs/limitless/claims/${number}`;
    const record = { ...held, number, generation: 3 };
    f.store.beginLeaseIntent(repository, name, held.run, {
      op: "acquire",
      before: zeros,
      record,
      commit: null,
    });
    if (number === 14) f.gh.seed(record, name);
    if (number === 16) f.gh.seed({ ...successor, generation: 4, number }, name, repository);
  }
  expect(f.store.leaseRowsWithIntent()).toHaveLength(5);
  f.gh.fault = (r) => {
    if (r.step === "ref" && r.args[1]?.endsWith("/15")) throw new Error("Offline");
  };
  expect(await f.recover()).toEqual({
    applied: ["refs/limitless/claims/14"],
    replayed: [ref],
    dropped: ["refs/limitless/claims/13"],
    superseded: ["refs/limitless/claims/16"],
    pending: ["refs/limitless/claims/15"],
  });
  expect(f.store.leaseRow(repo, "refs/limitless/claims/14")).toMatchObject({
    confirmed: { generation: 3, state: "held" },
    intent: null,
  });
  expect(f.store.leaseRowsWithIntent().map((r) => r.ref)).toEqual(["refs/limitless/claims/15"]);
  expect(f.gh.calls("ref")).toHaveLength(5);
});

test("a release from a tip other than the confirmed tip is dropped without replay", async () => {
  const f = fixture();
  const before = f.confirmed();
  f.journal("release", f.gh.seed(held));
  expect(await f.reconcile()).toBe("dropped");
  expect(f.store.leaseRow(repo, ref)).toMatchObject({
    confirmed: { generation: 1, tip: before.sha, state: "held" },
    intent: null,
  });
  expect(f.gh.calls("update")).toHaveLength(0);
});

test.each(["release", "renew"] as const)(
  "restart retains lost generation after a successor overtakes pending %s",
  async (op) => {
    const f = fixture(true);
    const before = f.confirmed();
    f.journal(op, before);
    if (op === "renew") f.store.setLeaseIntentCommit(repo, ref, "f".repeat(40));
    f.reopen();
    f.gh.seed({ ...successor, state: op === "renew" ? "released" : "held" });
    expect((await f.recover()).superseded).toEqual([ref]);
    expect(f.store.leaseRow(repo, ref)).toMatchObject({
      confirmed: { generation: 1, tip: before.sha, state: "lost" },
      intent: null,
    });
    expect(f.gh.calls("update")).toHaveLength(0);
    f.store.forgetLease(repo, ref);
    expect(f.store.leaseRow(repo, ref)).toBeNull();
  },
);

test.each(["holder", "run", "never confirmed"])(
  "superseded %s clears intent without inventing ownership",
  async (mode) => {
    const f = fixture();
    const before = mode === "never confirmed" ? null : f.confirmed();
    f.journal(before ? "renew" : "acquire", before);
    f.gh.seed(
      mode === "holder"
        ? { ...held, holder: successor.holder }
        : mode === "run"
          ? { ...held, run: successor.run }
          : successor,
    );
    expect(await f.reconcile()).toBe("superseded");
    expect(f.store.leaseRow(repo, ref)).toMatchObject({
      confirmed: before ? { generation: 1, tip: before.sha, state: "lost" } : null,
      intent: null,
    });
  },
);

test("unreadable writes reconcile while running and pending reads leave every column byte-identical", async () => {
  const f = fixture();
  const before = f.confirmed();
  f.journal("update", before, { ...held, checkpoint: release.checkpoint });
  f.gh.fault = (r) => {
    if (r.step === "update") {
      f.gh.apply(r);
      throw new Error("Lost response");
    }
    if (r.step === "ref") throw new Error("Offline");
  };
  expect(
    (
      await f.client.write(
        repo,
        ref,
        before,
        { ...held, checkpoint: release.checkpoint },
        { onCommit: (sha) => f.store.setLeaseIntentCommit(repo, ref, sha) },
      )
    ).kind,
  ).toBe("unconfirmed");
  const snapshot = raw(f.store);
  for (let i = 0; i < 2; i++) {
    expect((await f.recover()).pending).toEqual([ref]);
    expect(raw(f.store)).toEqual(snapshot);
  }
  expect(await f.reconcile()).toBe("pending");
  expect(raw(f.store)).toEqual(snapshot);
  f.gh.fault = undefined;
  expect(await f.reconcile()).toBe("applied");
  expect(f.store.leaseRow(repo, ref)).toMatchObject({
    confirmed: { generation: 1, state: "held", tip: f.gh.refs.get(f.gh.key(repo, ref)) },
    intent: null,
  });
  expect(await f.reconcile()).toBe("none");
});

test.each(["malformed", "absent", "older", "different checkpoint", "different status"])(
  "unclassifiable %s tip retains intent and confirmed history",
  async (mode) => {
    const f = fixture();
    const before = f.confirmed();
    f.journal("release", before);
    if (mode === "malformed") f.gh.seed("invalid record");
    else if (mode === "absent") f.gh.refs.clear();
    else
      f.gh.seed(
        mode === "older"
          ? { ...held, generation: 0 }
          : mode === "different status"
            ? { ...release, status: "failed" }
            : { ...release, checkpoint: undefined },
      );
    const snapshot = raw(f.store);
    expect(await f.reconcile()).toBe("pending");
    expect(raw(f.store)).toEqual(snapshot);
    expect(f.gh.calls("update")).toHaveLength(0);
  },
);

test.each(["commit", "update", "unreadable"])(
  "uncertain release replay at %s preserves confirmed ownership",
  async (step) => {
    const f = fixture();
    const before = f.confirmed();
    f.journal("release", before);
    f.gh.fault = (r) => {
      if (r.step === "commit" && step === "commit") throw new Error("Commit failed");
      if (r.step === "update") throw new Error("Update failed");
      if (r.step === "ref" && step === "unreadable" && f.gh.calls("update").length)
        throw new Error("Unreadable");
    };
    expect(await f.reconcile()).toBe("pending");
    expect(f.store.leaseRow(repo, ref)).toMatchObject({
      confirmed: { generation: 1, tip: before.sha, state: "held" },
      intent: { op: "release", record: release, before: before.sha },
    });
    expect(f.store.leaseRow(repo, ref)?.intent?.commit === null).toBe(step === "commit");
  },
);

test.each(["same owner", "malformed"])(
  "a replay moved to %s retains the final release and confirmed history",
  async (mode) => {
    const f = fixture();
    const before = f.confirmed();
    f.journal("release", before);
    const interveningRecord: ClaimRecord | string =
      mode === "malformed" ? "invalid record" : { ...held, status: "waiting_input" };
    let intervening: ClaimTip | undefined;
    f.gh.fault = (r) => {
      if (r.step === "update") intervening = f.gh.seed(interveningRecord);
    };
    expect(await f.reconcile()).toBe("pending");
    const update = f.gh.calls("update")[0];
    if (!update || !intervening) throw new Error("Replay race was not exercised");
    expect(f.gh.update(update).beforeOid).toBe(before.sha);
    expect(f.store.leaseRow(repo, ref)).toMatchObject({
      confirmed: { generation: 1, tip: before.sha, state: "held" },
      intent: {
        op: "release",
        before: before.sha,
        record: release,
        commit: f.gh.update(update).afterOid,
      },
    });
    expect(f.gh.refs.get(f.gh.key(repo, ref))).toBe(intervening.sha);
    expect(tipRecord(f.gh)).toEqual(typeof interveningRecord === "string" ? "malformed" : interveningRecord);
  },
);

async function replayRace(unconditional: boolean, record = successor) {
  const f = fixture(false, unconditional);
  const before = f.confirmed();
  f.journal("release", before);
  const successors: ClaimTip[] = [];
  f.gh.fault = (r) => {
    if (r.step === "update") successors.push(f.gh.seed(record));
  };
  const result = await f.reconcile();
  const update = f.gh.calls("update")[0];
  const successorTip = successors[0];
  if (!update || !successorTip) throw new Error("Replay race was not exercised");
  expect(f.gh.update(update).beforeOid).toBe(before.sha);
  return { f, result, successorTip, before };
}
test.each([
  ["successor", successor],
  ["same-generation holder", { ...held, holder: successor.holder }],
  ["same-generation run", { ...held, run: successor.run }],
] as const)("replayed release loses the CAS race and cannot overwrite a %s", async (_mode, record) => {
  const { f, result, successorTip, before } = await replayRace(false, record);
  expect(f.gh.refs.get(f.gh.key(repo, ref))).toBe(successorTip.sha);
  expect(tipRecord(f.gh)).toEqual(record);
  expect(result).toBe("superseded");
  expect(f.store.leaseRow(repo, ref)).toMatchObject({
    confirmed: { generation: 1, tip: before.sha, state: "lost" },
    intent: null,
  });
});
test("unconditional-ref-write mutant overwrites the successor in the same replay race", async () => {
  const { f, result, successorTip } = await replayRace(true);
  expect(f.gh.refs.get(f.gh.key(repo, ref))).not.toBe(successorTip.sha);
  expect(tipRecord(f.gh)).toEqual(release);
  expect(result).toBe("replayed");
});

test("missing intent does no GitHub work; aborted recovery preserves the journal", async () => {
  const f = fixture();
  expect(await f.reconcile()).toBe("none");
  expect(f.gh.requests).toEqual([]);
  f.journal("acquire", null);
  const snapshot = raw(f.store);
  const controller = new AbortController();
  const error = new DOMException("Cancelled", "AbortError");
  f.gh.fault = (r) => {
    if (r.step === "ref") controller.abort(error);
  };
  await expect(recoverLeases({ store: f.store, client: f.client, signal: controller.signal })).rejects.toBe(
    error,
  );
  expect(raw(f.store)).toEqual(snapshot);
});

const migrations = new URL("../src/db/migrations", import.meta.url).pathname;
const leaseColumns = [
  "repo",
  "ref",
  "run_id",
  "confirmed_generation",
  "confirmed_tip",
  "confirmed_state",
  "intent_op",
  "intent_before",
  "intent_record",
  "intent_commit",
  "updated_at",
];
test("additive migration upgrades a previous schema and allows the previous release to reopen it", () => {
  const directory = mkdtempSync(join(tmpdir(), "lease-migration-"));
  const old = join(directory, "old");
  mkdirSync(old);
  const path = join(directory, "store.db");
  try {
    for (const name of readdirSync(migrations)) {
      if (name.endsWith(".sql") && !name.endsWith("-claim-leases.sql"))
        copyFileSync(join(migrations, name), join(old, name));
    }
    new Store(path, old).close();
    const store = new Store(path);
    try {
      expect(
        store.db
          .query<{ name: string }, []>("PRAGMA table_info(claim_leases)")
          .all()
          .map((c) => c.name),
      ).toEqual(leaseColumns);
      expect(() =>
        store.db
          .query(
            "INSERT INTO claim_leases (repo,ref,run_id,updated_at) VALUES ('Owner/Repo','refs/limitless/claims/1','r',0)",
          )
          .run(),
      ).toThrow();
      store.beginLeaseIntent(repo, ref, held.run, {
        op: "acquire",
        before: zeros,
        record: held,
        commit: null,
      });
    } finally {
      store.close();
    }
    const previous = new Store(path, old);
    try {
      expect(previous.db.query("SELECT repo FROM claim_leases").get()).toEqual({ repo });
    } finally {
      previous.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
const sqlite = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
].find(existsSync);
test.skipIf(!sqlite)("claim lease migration with Homebrew SQLite (when installed)", async () => {
  const source = `import { Database } from "bun:sqlite";
    Database.setCustomSQLite(${JSON.stringify(sqlite)});
    const { Store } = await import(${JSON.stringify(new URL("../src/db/store.ts", import.meta.url).pathname)});
    const store = new Store(":memory:");
    store.db.query("INSERT INTO claim_leases (repo,ref,run_id,updated_at) VALUES ('owner/repo','refs/limitless/claims/1','r',0)").run();
    console.log(JSON.stringify(store.db.query("PRAGMA table_info(claim_leases)").all().map(c => c.name)));
    store.close();`;
  const result = await sh(["bun", "-e", source], { cwd: process.cwd() });
  expect(JSON.parse(result.stdout)).toEqual(leaseColumns);
});
