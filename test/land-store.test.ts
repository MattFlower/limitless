import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";

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
