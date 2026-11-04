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
    expect(store.confirmCheckpoint("run", "absent")).toBe(false);
    store.journalCheckpoint("run", entry);
    const pending = store.checkpointRecord("run");
    expect(pending).toMatchObject({
      committed: null,
      pending: { ...entry, commits: ["a", "b"] },
      indexed: false,
      terminal: null,
      updatedAt: expect.any(Number),
    });
    expect(store.confirmCheckpoint("run", "wrong")).toBe(false);
    expect(() => store.journalCheckpoint("run", { ...entry, pointer: "second" })).toThrow("pending");
    expect(store.checkpointRecord("run")).toEqual(pending);
    expect(store.confirmCheckpoint("run", entry.pointer)).toBe(true);
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
    store.dropPendingCheckpoint("run");
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
