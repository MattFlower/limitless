import { afterEach, beforeEach, expect, test } from "bun:test";
import { Store } from "../src/db/store.ts";

let store: Store;
let runId: string;
const cutoff = 1_000_000;

beforeEach(() => {
  store = new Store(":memory:");
  const repo = store.upsertRepo({
    slug: "local/debug-gc",
    kind: "local",
    localPath: null,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  runId = store.createRun(repo, { repo: repo.slug, prompt: "debug GC" }).id;
  expect(store.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
});

afterEach(() => store.close());

test("debug-event GC stays fast with 20,000 events and owner diagnostics", () => {
  const count = 20_000;
  const event = store.db.query(
    "INSERT INTO events (run_id, ts, type, level, message) VALUES (?, ?, 'log', 'debug', 'expired')",
  );
  const diagnostic = store.db.query(
    "INSERT INTO owner_diagnostics (run_id, event_id, kind, text) VALUES (?, ?, 'event', 'owner')",
  );
  store.db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const { lastInsertRowid } = event.run(runId, cutoff - 1);
      diagnostic.run(runId, lastInsertRowid);
    }
  })();

  const start = performance.now();
  const deleted = store.deleteOldDebugEvents(cutoff);
  const elapsed = performance.now() - start;
  expect(deleted).toBe(count); // SQLite's changes excludes the cascaded diagnostics.
  expect(store.db.query("SELECT count(*) AS n FROM owner_diagnostics").get()).toEqual({ n: 0 });
  // One second allows ample headroom for Linux CI and shared macOS hosts: locally,
  // deletion took 24 ms indexed versus 9,870 ms after dropping only owner_diagnostics_event.
  expect(elapsed).toBeLessThan(1_000);
});

test("GC preserves cutoff, non-debug and unrelated diagnostics; invocation deletion still cascades", () => {
  const invocationId = store.createInvocation({
    runId,
    stageId: null,
    role: "implement",
    harness: "fake",
    provider: "fake",
    model: "fake",
    modelId: "fake/m",
  }).id;
  const addEvent = (ts: number, level: string) =>
    Number(
      store.db
        .query("INSERT INTO events (run_id, ts, type, level, message) VALUES (?, ?, 'log', ?, 'public')")
        .run(runId, ts, level).lastInsertRowid,
    );
  const expired = addEvent(cutoff - 1, "debug");
  const retained = [addEvent(cutoff, "debug"), addEvent(cutoff + 1, "debug"), addEvent(cutoff - 1, "info")];
  const diagnostic = store.db.query(
    "INSERT INTO owner_diagnostics (run_id, event_id, invocation_id, kind, text) VALUES (?, ?, ?, 'event', ?)",
  );
  diagnostic.run(runId, expired, null, "expired event only");
  diagnostic.run(runId, expired, invocationId, "expired event and invocation");
  for (const id of retained) diagnostic.run(runId, id, null, `retained ${id}`);
  diagnostic.run(runId, null, null, "run only");
  diagnostic.run(runId, null, invocationId, "invocation only");
  diagnostic.run(runId, retained[0] ?? null, invocationId, "retained event and invocation");
  const texts = () =>
    store.db
      .query<{ text: string }, []>("SELECT text FROM owner_diagnostics ORDER BY id")
      .all()
      .map((row) => row.text);

  expect(store.deleteOldDebugEvents(cutoff)).toBe(1);
  expect(store.db.query("SELECT id FROM events ORDER BY id").all()).toEqual(retained.map((id) => ({ id })));
  expect(texts()).toEqual([
    ...retained.map((id) => `retained ${id}`),
    "run only",
    "invocation only",
    "retained event and invocation",
  ]);
  expect(store.deleteOldDebugEvents(cutoff)).toBe(0);
  store.db.query("DELETE FROM invocations WHERE id = ?").run(invocationId);
  expect(texts()).toEqual([...retained.map((id) => `retained ${id}`), "run only"]);
  expect(store.db.query("SELECT id FROM events ORDER BY id").all()).toEqual(retained.map((id) => ({ id })));
  expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
