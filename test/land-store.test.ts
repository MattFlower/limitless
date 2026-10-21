import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVE_LAND_STATES } from "../src/core/types.ts";
import { MIGRATION_DIR } from "../src/db/migration-runner.ts";
import { Store } from "../src/db/store.ts";

function seedLandEntries(store: Store) {
  store.db.transaction(() => {
    for (let i = 1; i <= 120; i++) {
      const entry = store.createLandEntry({
        runId: `run-${i}`,
        repo: "test/repo",
        prUrl: `https://github.com/test/repo/pull/${i}`,
        baseBranch: "main",
        headBranch: `pr-${i}`,
        approvedSha: "a".repeat(40),
      });
      if (i < 120) store.updateLandEntry(entry.id, { state: "landed" });
    }
  })();
}

test("land list returns the newest 100 entries in ascending order, including the newest active entry", () => {
  const store = new Store(":memory:");
  try {
    seedLandEntries(store);
    const expected = Array.from({ length: 100 }, (_, i) => i + 21);
    expect(store.listLandEntries().map((entry) => entry.id)).toEqual(expected);
    expect(store.listLandEntries({ limit: 100 }).map((entry) => entry.id)).toEqual(expected);
  } finally {
    store.close();
  }
});

test.each([...ACTIVE_LAND_STATES])("land list includes an older %s entry beyond the limit", (state) => {
  const store = new Store(":memory:");
  try {
    seedLandEntries(store);
    store.updateLandEntry(1, { state });
    const expected = [1, ...Array.from({ length: 100 }, (_, i) => i + 21)];
    expect(store.listLandEntries({ repo: "test/repo", limit: 100 }).map((entry) => entry.id)).toEqual(
      expected,
    );
    expect(store.listLandEntries({ repo: "other/repo" })).toEqual([]);
    expect(store.listLandEntries({ active: true, limit: 1 }).map((entry) => entry.id)).toEqual([1, 120]);
  } finally {
    store.close();
  }
});

test("land logPath reads back from get, list and a reopened store", () => {
  const dir = mkdtempSync(join(tmpdir(), "land-store-"));
  const db = join(dir, "store.db");
  let store = new Store(db);
  try {
    const entry = store.createLandEntry({
      runId: "run",
      repo: "test/repo",
      prUrl: "https://github.com/test/repo/pull/1",
      baseBranch: "main",
      headBranch: "pr-1",
      approvedSha: "a".repeat(40),
    });
    const logPath = join(dir, "land.log");
    store.updateLandEntry(entry.id, { logPath });
    expect(store.getLandEntry(entry.id)?.logPath).toBe(logPath);
    expect(store.listLandEntries()[0]?.logPath).toBe(logPath);
    store.close();
    store = new Store(db);
    expect(store.getLandEntry(entry.id)?.logPath).toBe(logPath);
    expect(store.listLandEntries()[0]?.logPath).toBe(logPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("land entries preserve previous inserts and persist unowned PRs without a nullable run_id", () => {
  const store = new Store(":memory:");
  try {
    const old = store.db
      .query(`INSERT INTO land_entries
      (run_id, repo, pr_url, base_branch, head_branch, approved_sha, state, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`)
      .run("run", "test/repo", "https://github.com/test/repo/pull/1", "main", "pr-1", "a".repeat(40), 1, 1);
    expect(store.getLandEntry(Number(old.lastInsertRowid))).toMatchObject({ runId: "run", title: null });
    const entry = store.createLandEntry({
      runId: null,
      title: "T",
      repo: "test/repo",
      prUrl: "https://github.com/test/repo/pull/2",
      baseBranch: "main",
      headBranch: "pr-2",
      approvedSha: "b".repeat(40),
    });
    expect(store.db.query("SELECT run_id FROM land_entries WHERE id = ?").get(entry.id)).toEqual({
      run_id: "",
    });
    expect(store.getLandEntry(entry.id)).toMatchObject({ runId: null, title: "T" });
    expect(store.listLandEntries().find((e) => e.id === entry.id)).toMatchObject({ runId: null, title: "T" });
  } finally {
    store.close();
  }
});

test("approval waiting migrates old rows, survives reopening, and retains claims and uniqueness", () => {
  const dir = mkdtempSync(join(tmpdir(), "land-migration-"));
  const migrations = join(dir, "migrations");
  mkdirSync(migrations);
  for (const file of readdirSync(MIGRATION_DIR))
    if (file.endsWith(".sql") && file !== "20261021T021253-land-approval-wait.sql")
      copyFileSync(join(MIGRATION_DIR, file), join(migrations, file));
  const path = join(dir, "db");
  let store = new Store(path, migrations);
  try {
    const input = {
      runId: "run",
      repo: "test/repo",
      prUrl: "https://github.com/test/repo/pull/1",
      baseBranch: "main",
      headBranch: "one",
      approvedSha: "a".repeat(40),
    };
    const inserted = store.db
      .query(`INSERT INTO land_entries
      (run_id, repo, pr_url, base_branch, head_branch, approved_sha, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, 1)`)
      .run(input.runId, input.repo, input.prUrl, input.baseBranch, input.headBranch, input.approvedSha);
    const entry = { id: Number(inserted.lastInsertRowid) };
    store.close();
    store = new Store(path);
    expect(store.getLandEntry(entry.id)?.state).toBe("queued");
    expect(store.claimLandEntry(input.repo, 30000, "first", 1000)?.id).toBe(entry.id);
    store.updateLandEntry(entry.id, {
      state: "waiting_approval",
      reason: "Another GitHub account must approve",
    });
    store.close();
    store = new Store(path);
    expect(store.getLandEntry(entry.id)).toMatchObject({
      state: "waiting_approval",
      finishedAt: null,
      reason: "Another GitHub account must approve",
    });
    expect(store.heartbeatLandClaim(entry.id, "first", 2000)).toBe(true);
    expect(() => store.createLandEntry(input)).toThrow("already in the land queue");
    const next = store.createLandEntry({ ...input, prUrl: input.prUrl.replace("/1", "/2") });
    expect(store.claimLandEntry(input.repo, 30000, "second", 2500)).toBeNull();
    expect(store.claimLandEntry(input.repo, 30000, "second", 32001)).toMatchObject({
      id: entry.id,
      state: "waiting_approval",
    });
    expect(store.heartbeatLandClaim(entry.id, "first", 32002)).toBe(false);
    store.updateLandEntry(entry.id, { state: "cancelled" });
    expect(store.claimLandEntry(input.repo, 30000, "second", 32003)?.id).toBe(next.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
