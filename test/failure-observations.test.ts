import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FailureObservation } from "../src/db/failure-observations.ts";
import { Store } from "../src/db/store.ts";
import { sh } from "../src/util/proc.ts";

const day = 86400000;
function row(
  id: string,
  location: string | null,
  at: number,
): Omit<FailureObservation, "id" | "class" | "history" | "finalized_at" | "interim"> {
  return {
    run_id: id,
    repo: "test/repo",
    stage_id: 1,
    round: 0,
    sha: "head",
    handle_kind: "lan",
    handle_id: id,
    phase: "setup",
    name: "setup:0",
    command: "missing-tool",
    location,
    os: null,
    load_per_core: null,
    observed_at: at,
    exit_code: 127,
    timed_out: 0,
    confinement: 0,
    duration_ms: 1,
    failed_files: "[]",
    output_tail: "command not found",
    signature: "same failure",
    setup_eligible: 1,
  };
}
const finalize = (store: Store, id: string) =>
  store.transaction(
    () =>
      store.observations.finalize(id, {
        round: 0,
        sha: "head",
        stageId: 1,
        comparisons: [],
      }),
    true,
  );
const insert = (store: Store, r: ReturnType<typeof row>) =>
  store.transaction(() => store.observations.insert(r), true);

test.each([
  "finalized first",
  "unfinalized first",
  "two connections",
  "eight days",
  "null",
  "same location",
  "different repo",
  "different signature",
])("setup promotion: %s", async (order) => {
  const dir = mkdtempSync(join(tmpdir(), "failure-observations-"));
  const path = join(dir, "store.db");
  const a = new Store(path);
  const b = order === "two connections" ? new Store(path) : a;
  try {
    insert(a, row("a", "worker-a", 10 * day));
    if (order === "finalized first") finalize(a, "a");
    const next = row(
      "b",
      order === "null" ? null : order === "same location" ? "worker-a" : "worker-b",
      (order === "eight days" ? 18 : 12) * day,
    );
    if (order === "different repo") next.repo = "other/repo";
    if (order === "different signature") next.signature = "other failure";
    insert(b, next);
    if (order === "finalized first")
      expect(a.failureObservations({ finalized: true })[0]?.class).toBe("undeclared_requirement");
    if (order === "two connections") {
      const source = `const { Store } = await import(${JSON.stringify(new URL("../src/db/store.ts", import.meta.url).pathname)});
        const store = new Store(process.argv[1]);
        store.transaction(() => store.observations.finalize(process.argv[2], { round: 0, sha: "head", stageId: 1, comparisons: [] }), true);
        store.close();`;
      await Promise.all(["a", "b"].map((id) => sh(["bun", "-e", source, path, id], { cwd: process.cwd() })));
    } else {
      finalize(b, "b");
      finalize(a, "a");
    }
    const expected = ["finalized first", "unfinalized first", "two connections"].includes(order)
      ? "undeclared_requirement"
      : "setup";
    expect(a.failureObservations({}).map((r) => r.class)).toEqual([expected, expected]);
    const before = a.failureObservations({});
    insert(a, row("a", "replacement", 100 * day));
    finalize(a, "a");
    expect(a.failureObservations({})).toEqual(before);
    expect(a.failureObservations({ repo: "unknown" })).toEqual([]);
    expect(a.failureObservations({ since: 100 * day })).toEqual([]);
    expect(a.failureObservations({ finalized: false })).toEqual([]);
    expect(a.failureObservations({ class: "confinement" })).toEqual([]);
  } finally {
    if (b !== a) b.close();
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal finalization is interim and completion can replace it", () => {
  const store = new Store(":memory:");
  try {
    const repo = store.upsertRepo({
      slug: "test/repo",
      kind: "local",
      localPath: ".",
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "test" });
    insert(store, { ...row(run.id, "coordinator", 0), setup_eligible: 0, phase: "check" });
    store.updateRun(run.id, { status: "cancelled" });
    expect(store.failureObservations({})[0]).toMatchObject({
      class: "unclassified",
      history: "interrupted",
      interim: 1,
    });
    finalize(store, run.id);
    expect(store.failureObservations({})[0]).toMatchObject({ history: "no_retry", interim: 0 });
  } finally {
    store.close();
  }
});

test("terminal persistence hooks see committed status and observations together", () => {
  const dir = mkdtempSync(join(tmpdir(), "failure-terminal-"));
  const store = new Store(join(dir, "store.db"));
  const reader = new Store(join(dir, "store.db"));
  const repo = store.upsertRepo({
    slug: "test/repo",
    kind: "local",
    localPath: ".",
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "test" });
  insert(store, row(run.id, "coordinator", 0));
  const snapshots: { status: string | undefined; history: string | null | undefined }[] = [];
  const update = store.updateRun.bind(store);
  const persist = spyOn(store, "updateRun").mockImplementation((...args) => {
    const result = update(...args);
    snapshots.push({
      status: reader.getRun(run.id)?.status,
      history: reader.failureObservations({})[0]?.history,
    });
    return result;
  });
  try {
    store.updateRun(run.id, { status: "cancelled" });
    expect(snapshots).toEqual([{ status: "cancelled", history: "interrupted" }]);
  } finally {
    persist.mockRestore();
    reader.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function legacyInsert() {
  const store = new Store(":memory:");
  try {
    store.db
      .query(
        "INSERT INTO gate_jobs (id,run_id,request,state,created_at,updated_at,in_place) VALUES ('legacy',NULL,'{}','queued',0,0,0)",
      )
      .run();
    expect(store.db.query("SELECT worker_os FROM gate_jobs WHERE id='legacy'").get()).toEqual({
      worker_os: null,
    });
    expect(store.failureObservations({})).toEqual([]);
  } finally {
    store.close();
  }
}
test("migration retains previous-release gate inserts", legacyInsert);
const sqlite = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
].find(existsSync);
test.skipIf(!sqlite)("migration with Homebrew SQLite (when installed)", async () => {
  const source = `import { Database } from "bun:sqlite";
    Database.setCustomSQLite(${JSON.stringify(sqlite)});
    const { Store } = await import(${JSON.stringify(new URL("../src/db/store.ts", import.meta.url).pathname)});
    const store = new Store(":memory:");
    store.db.query("INSERT INTO gate_jobs (id,run_id,request,state,created_at,updated_at,in_place) VALUES ('legacy',NULL,'{}','queued',0,0,0)").run();
    console.log(JSON.stringify(store.db.query("SELECT worker_os FROM gate_jobs").all()));
    store.close();`;
  const result = await sh(["bun", "-e", source], { cwd: process.cwd() });
  expect(JSON.parse(result.stdout)).toEqual([{ worker_os: null }]);
});
