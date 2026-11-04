import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";

const entry = {
  generation: 3,
  sequence: 0,
  pointer: "first",
  manifest: "opaque manifest",
  commits: ["b", "a"],
};
test("checkpoint transactions fence confirmation, preserve pending and persist all metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "checkpoints-")),
    path = join(dir, "store.db");
  let store = new Store(path);
  try {
    expect(store.checkpointRecord("run")).toBeNull();
    expect(store.confirmCheckpoint("run", "absent", null)).toBe(false);
    store.journalCheckpoint("run", entry);
    const pending = store.checkpointRecord("run");
    expect(structuredClone(pending)).toMatchObject({
      committed: null,
      pending: { ...entry, commits: ["a", "b"] },
      indexed: false,
      terminal: null,
      updatedAt: expect.any(Number),
    });
    expect(store.confirmCheckpoint("run", "wrong", pending)).toBe(false);
    expect(() => store.journalCheckpoint("run", { ...entry, pointer: "second" })).toThrow("pending");
    expect(store.checkpointRecord("run")).toEqual(pending);
    expect(store.confirmCheckpoint("run", entry.pointer, pending)).toBe(true);
    const second = {
      ...entry,
      generation: 4,
      sequence: 1,
      pointer: "second",
      manifest: "next",
      commits: ["c"],
    };
    store.journalCheckpoint("run", second);
    store.markRunIndexed("run");
    store.setTerminalIntent("run", '{"status":"failed"}');
    const both = store.checkpointRecord("run");
    store.close();
    store = new Store(path);
    expect(store.checkpointRecord("run")).toEqual(both);
    expect(both).toMatchObject({
      committed: { ...entry, commits: ["a", "b"] },
      pending: second,
      indexed: true,
      terminal: '{"status":"failed"}',
    });
    store.dropPendingCheckpoint("run", both);
    expect(store.checkpointRecord("run")).toMatchObject({
      ...both,
      pending: null,
      updatedAt: expect.any(Number),
    });
    store.clearTerminalIntent("run");
    expect(store.checkpointRecord("run")?.terminal).toBeNull();
    store.markRunIndexed("indexed");
    store.setTerminalIntent("terminal", "opaque");
    expect(store.checkpointRecord("indexed")?.indexed).toBe(true);
    expect(store.checkpointRecord("terminal")?.terminal).toBe("opaque");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["confirm", "drop"] as const)("%s compares the complete checkpoint snapshot atomically", (op) => {
  const store = new Store(":memory:");
  const transition = (expected: ReturnType<Store["checkpointRecord"]>) =>
    op === "confirm"
      ? store.confirmCheckpoint("run", "second", expected)
      : store.dropPendingCheckpoint("run", expected);
  try {
    store.journalCheckpoint("run", entry);
    store.confirmCheckpoint("run", entry.pointer, store.checkpointRecord("run"));
    const second = { ...entry, pointer: "second", sequence: 1 };
    store.journalCheckpoint("run", second);
    const original = store.checkpointRecord("run");
    for (const replacement of [
      { ...second, pointer: "third" },
      { ...second, generation: second.generation + 1 },
      { ...second, sequence: 2 },
      { ...second, manifest: "replacement" },
      { ...second, commits: ["c"] },
    ]) {
      store.dropPendingCheckpoint("run", store.checkpointRecord("run"));
      store.journalCheckpoint("run", replacement);
      const before = store.checkpointRecord("run");
      expect(transition(original)).toBe(false);
      expect(store.checkpointRecord("run")).toEqual(before);
    }
    store.dropPendingCheckpoint("run", store.checkpointRecord("run"));
    store.journalCheckpoint("run", second);
    const beforeCommitChange = store.checkpointRecord("run");
    // Simulate another writer advancing the committed state while leaving pending intact.
    store.db.query("UPDATE shared_checkpoints SET committed_generation=4 WHERE run_id=?").run("run");
    const afterCommitChange = store.checkpointRecord("run");
    expect(transition(beforeCommitChange)).toBe(false);
    expect(store.checkpointRecord("run")).toEqual(afterCommitChange);
    store.markRunIndexed("run");
    store.setTerminalIntent("run", "terminal metadata");
    const matching = store.checkpointRecord("run");
    expect(transition(matching)).toBe(true);
    expect(store.checkpointRecord("run")).toMatchObject({
      committed: op === "confirm" ? { ...second, commits: ["a", "b"] } : afterCommitChange?.committed,
      pending: null,
      indexed: true,
      terminal: "terminal metadata",
    });
    const done = store.checkpointRecord("run");
    expect(transition(matching)).toBe(false);
    expect(store.checkpointRecord("run")).toEqual(done);
  } finally {
    store.close();
  }
});
