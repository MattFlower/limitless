import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVE_LAND_STATES } from "../src/core/types.ts";
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
