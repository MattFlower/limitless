import { expect, test } from "bun:test";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_DIR } from "../src/db/migration-runner.ts";
import { Store } from "../src/db/store.ts";
import { allItems, feedStore } from "./feed-support.ts";

const DAY = 86_400_000;

test("upgrading the existing feed preserves items and cursors and allows a later real cancellation", () => {
  const f = feedStore();
  try {
    f.store.close();
    rmSync(f.path);
    const before = join(f.dir, "migrations-before-ordering");
    cpSync(MIGRATION_DIR, before, {
      recursive: true,
      filter: (src) => !src.endsWith("-ordered-feed.sql"),
    });
    f.store = new Store(f.path, before);
    const run = f.run();
    f.store.updateRun(run.id, { status: "cancelled", finishedAt: 1 });
    const original = allItems(f.store);
    f.store.ackFeed("consumer", original[0]?.id ?? -1);
    f.store.updateRun(run.id, { status: "queued", finishedAt: null });
    f.reopen();
    expect(allItems(f.store)).toEqual(original);
    expect(f.store.readFeed({ consumer: "consumer" }).items).toEqual([]);
    f.store.updateRun(run.id, { status: "cancelled", error: "cancelled by test", finishedAt: 2 });
    const later = f.store.readFeed({ consumer: "consumer" });
    expect(later.items).toMatchObject([{ kind: "run.cancelled", data: { reason: "cancelled by test" } }]);
    expect(later.nextAfter).toBeGreaterThan(original[0]?.id ?? 0);
    expect(allItems(f.store)).toHaveLength(2);
  } finally {
    f.close();
  }
});

test("the additive migration keeps inbox rows; items and cursors survive reopening in exclusive id order", () => {
  const f = feedStore();
  try {
    f.store.close();
    rmSync(f.path);
    const before = join(f.dir, "migrations-before");
    mkdirSync(before);
    cpSync(MIGRATION_DIR, before, {
      recursive: true,
      filter: (src) => !src.endsWith("-feed.sql"),
    });
    const old = new Store(f.path, before);
    old.db.query("INSERT INTO inbox VALUES ('d1', 'github', 'push', 1, '{}', 'done', NULL, 'kept')").run();
    expect(old.db.query("SELECT name FROM sqlite_master WHERE name = 'feed'").get()).toBeNull();
    old.close();
    f.store = new Store(f.path);
    expect(f.store.db.query("SELECT id, note FROM inbox").all()).toEqual([{ id: "d1", note: "kept" }]);

    const runs = [f.run("one"), f.run("two"), f.run("three")];
    const long = "x".repeat(2000);
    f.store.updateRun(runs[0]?.id ?? "", { status: "failed", error: long });
    f.store.updateRun(runs[1]?.id ?? "", { status: "succeeded" });
    f.store.updateRun(runs[2]?.id ?? "", { status: "cancelled" });
    const items = allItems(f.store);
    expect(items.map((i) => i.kind)).toEqual(["run.failed", "run.succeeded", "run.cancelled"]);
    expect(items[0]?.summary.length).toBeLessThanOrEqual(500);
    expect(items[0]?.data).toMatchObject({ status: "failed", error: long });
    expect(items[0]).toMatchObject({ runId: runs[0]?.id, repo: "local/feed", evalId: null });

    // Schema constraints hold even for writes that bypass Store.
    const insert = (summary: string, key: string) =>
      f.store.db
        .query("INSERT INTO feed (ts, kind, title, summary, dedupe_key) VALUES (1, 'run.failed', 't', ?, ?)")
        .run(summary, key);
    const key = f.store.db
      .query<{ dedupe_key: string }, [number]>("SELECT dedupe_key FROM feed WHERE id = ?")
      .get(items[0]?.id ?? -1)?.dedupe_key;
    expect(key).toBeDefined();
    expect(() => insert("s", key ?? "")).toThrow(/UNIQUE/);
    expect(() => insert("y".repeat(501), "other")).toThrow(/CHECK/);

    const first = f.store.readFeed({ consumer: "orchestrator", limit: 2 });
    expect<unknown>(first.items.map((i) => i.id)).toEqual([items[0]?.id, items[1]?.id]);
    expect(first.nextAfter).toBe(items[1]?.id ?? -1);
    f.store.ackFeed("orchestrator", first.nextAfter);
    f.reopen();
    const second = f.store.readFeed({ consumer: "orchestrator", limit: 2 });
    expect<unknown>(second).toEqual({ items: [items[2]], nextAfter: items[2]?.id ?? -1, pruned: false });
    expect(f.store.readFeed({ consumer: "orchestrator", after: second.nextAfter })).toEqual({
      items: [],
      nextAfter: second.nextAfter,
      pruned: false,
    });
  } finally {
    f.close();
  }
});

test("Store publication inside an outer transaction never publishes rolled-back feed items", () => {
  const f = feedStore();
  try {
    const run = f.run();
    const seen = f.published();
    expect(() =>
      f.store.db.transaction(() => {
        f.store.updateRun(run.id, { status: "failed", error: "uncommitted" });
        expect(allItems(f.store)).toHaveLength(1);
        expect(seen.items).toEqual([]);
        throw new Error("rollback");
      })(),
    ).toThrow("rollback");
    expect(allItems(f.store)).toEqual([]);
    expect(seen.items).toEqual([]);
    f.store.updateRun(run.id, { status: "failed", error: "committed" });
    expect(seen.items).toEqual(allItems(f.store));
    expect(seen.items).toMatchObject([{ kind: "run.failed", data: { error: "committed" } }]);
  } finally {
    f.close();
  }
});

test("a status change and its item roll back together and publish nothing; a retry commits and publishes once", () => {
  const f = feedStore();
  try {
    const run = f.run();
    const seen = f.published();
    const statuses: string[] = [];
    f.store.subscribe((msg) => {
      if (msg.kind === "feed") statuses.push(f.store.getRun(run.id)?.status ?? "missing");
    });
    f.store.db.exec(
      "CREATE TEMP TRIGGER fault BEFORE INSERT ON feed BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() => f.store.updateRun(run.id, { status: "failed", error: "boom" })).toThrow("injected");
    expect(f.store.getRun(run.id)?.status).toBe("queued");
    expect(allItems(f.store)).toEqual([]);
    expect(seen.items).toEqual([]);
    f.store.db.exec("DROP TRIGGER fault");
    f.store.updateRun(run.id, { status: "failed", error: "boom" });
    expect(allItems(f.store)).toEqual(seen.items);
    expect(seen.items.map((i) => i.kind)).toEqual(["run.failed"]);
    // Subscribers observe committed state.
    expect(statuses).toEqual(["failed"]);
  } finally {
    f.close();
  }
});

test("a subscriber mutating the store during a multi-item publication sees every item exactly once, in order", () => {
  const f = feedStore();
  try {
    const run = f.run("merged");
    const other = f.run("other");
    const seen = f.published();
    let reacted = false;
    f.store.subscribe((msg) => {
      if (msg.kind !== "feed" || reacted) return;
      reacted = true;
      f.store.updateRun(other.id, { status: "failed", error: "reaction" });
    });
    // One commit, two items: the subscriber's reaction adds a third while the first is being delivered.
    f.store.updateRun(run.id, { prUrl: "https://example.test/pr/1", merged: true });
    const persisted = allItems(f.store);
    expect(persisted.map((i) => i.kind).sort()).toEqual(["run.failed", "run.merged", "run.pr_opened"]);
    expect(persisted.map((i) => i.id)).toHaveLength(3);
    expect(seen.items.map((i) => i.id)).toEqual(persisted.map((i) => i.id));
  } finally {
    f.close();
  }
});

test("a failure after a producer insert in an enclosing eval transaction rolls everything back", () => {
  const f = feedStore();
  try {
    const input = { role: "triage" as const, models: ["m"], k: 1, maxUsd: 1 };
    const predecessor = f.store.createEvalRun(input, [], { request: {} });
    const seen = f.published();
    const trial = {
      evalRunId: "",
      caseId: "c",
      modelId: "m",
      effort: null,
      trial: 0,
      cacheKey: "k",
      harness: "fake",
      status: "queued" as const,
      output: null,
      pass: null,
      score: null,
      details: {},
      costUsd: 0,
      costEquivUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
      createdAt: 1,
    };
    f.store.db.exec(
      "CREATE TEMP TRIGGER fault BEFORE INSERT ON eval_trials BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(() => f.store.createEvalRun(input, [trial], { request: {} }, predecessor.id)).toThrow("injected");
    expect(f.store.getEvalRun(predecessor.id)?.status).toBe("queued");
    expect(f.store.listEvalRuns()).toHaveLength(1);
    expect(allItems(f.store)).toEqual([]);
    expect(seen.items).toEqual([]);
    f.store.db.exec("DROP TRIGGER fault");
    f.store.createEvalRun(input, [trial], { request: {} }, predecessor.id);
    expect(seen.items).toEqual(allItems(f.store));
    expect(seen.items.map((i) => [i.kind, i.evalId, i.data.status])).toEqual([
      ["eval.finished", predecessor.id, "interrupted"],
    ]);
  } finally {
    f.close();
  }
});

test("retention reports pruned items to stale cursors only, durably and without moving acknowledgements", () => {
  const f = feedStore();
  try {
    const runs = Array.from({ length: 4 }, (_, i) => f.run(`r${i}`));
    for (const run of runs) f.store.updateRun(run.id, { status: "failed" });
    const ids = allItems(f.store).map((i) => i.id);
    const now = 2_000_000_000_000;
    const cutoff = now - 30 * DAY;
    const age = (id: number | undefined, ts: number) =>
      f.store.db.query("UPDATE feed SET ts = ? WHERE id = ?").run(ts, id ?? -1);
    age(ids[0], cutoff - 2);
    age(ids[1], cutoff - 1);
    age(ids[2], cutoff);
    age(ids[3], now);
    f.store.ackFeed("stale", ids[0] ?? -1);
    f.store.ackFeed("current", ids[1] ?? -1);

    expect(f.store.pruneFeed(cutoff, true)).toBe(2);
    expect(allItems(f.store)).toHaveLength(4);
    expect(f.store.pruneFeed(cutoff)).toBe(2);
    expect(allItems(f.store).map((i) => i.id)).toEqual(ids.slice(2));
    f.reopen();
    expect(f.store.readFeed({ consumer: "stale" })).toMatchObject({ pruned: true, nextAfter: ids[3] });
    expect(f.store.readFeed({ consumer: "stale" }).items.map((i) => i.id)).toEqual(ids.slice(2));
    expect(f.store.readFeed({ consumer: "current" }).pruned).toBe(false);
    expect(f.store.readFeed({}).pruned).toBe(true);
    expect(f.store.feedCursor("stale")).toBe(ids[0] ?? -1);

    // Repeating an unchanged transition does not regenerate a pruned item.
    f.store.updateRun(runs[0]?.id ?? "", { status: "failed" });
    expect(allItems(f.store)).toHaveLength(2);

    // An AUTOINCREMENT gap is not pruning.
    f.store.db.query("UPDATE sqlite_sequence SET seq = seq + 5 WHERE name = 'feed'").run();
    f.store.ackFeed("gap", ids[3] ?? -1);
    f.store.updateRun(f.run("after gap").id, { status: "failed" });
    expect(f.store.readFeed({ consumer: "gap" })).toMatchObject({ pruned: false });
    expect(f.store.readFeed({ consumer: "gap" }).items[0]?.id).toBe((ids[3] ?? 0) + 6);

    // Complete pruning still tells stale consumers, after a restart, with an empty page.
    f.store.pruneFeed(now + DAY);
    f.reopen();
    expect(f.store.readFeed({ consumer: "stale" })).toEqual({
      items: [],
      nextAfter: ids[0] ?? -1,
      pruned: true,
    });
    expect(f.store.readFeed({ after: (ids[3] ?? 0) + 6 }).pruned).toBe(false);
  } finally {
    f.close();
  }
});

test("acknowledgements are monotonic, per consumer and limited to issued ids", () => {
  const f = feedStore();
  try {
    expect(() => f.store.ackFeed("a", 1)).toThrow("has not been issued");
    expect(f.store.ackFeed("a", 0)).toEqual({ consumer: "a", id: 0 });
    for (const title of ["one", "two", "three"]) f.store.updateRun(f.run(title).id, { status: "failed" });
    const [first, second] = allItems(f.store).map((i) => i.id);
    expect<unknown>(f.store.ackFeed("a", second ?? -1)).toEqual({ consumer: "a", id: second });
    expect<unknown>(f.store.ackFeed("a", first ?? -1)).toEqual({ consumer: "a", id: second });
    expect(f.store.feedCursor("b")).toBe(0);
    f.store.readFeed({ consumer: "b" });
    expect(f.store.feedCursor("b")).toBe(0);
  } finally {
    f.close();
  }
});
