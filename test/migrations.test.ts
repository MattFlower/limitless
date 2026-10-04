import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditAllowance, CreateRunRequest, Run } from "../src/core/types.ts";
import { MIGRATION_DIR, migrationNames, runMigrations } from "../src/db/migration-runner.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { Store } from "../src/db/store.ts";

function temporary(testBody: (directory: string, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "limitless-migrations-"));
  try {
    testBody(directory, join(directory, "db.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A database as the pre-file-migration release left it: every legacy migration applied. */
function legacyDatabase(path: string): void {
  const db = new Database(path);
  db.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
    db.query("INSERT INTO schema_migrations VALUES (?, ?, 1)").run(migration.version, migration.name);
  }
  db.exec("INSERT INTO settings VALUES ('sentinel', 'unchanged')");
  db.close();
}

const legacyRows = (db: Database) => db.query("SELECT * FROM schema_migrations ORDER BY version").all();
const fileNames = (db: Database) =>
  (db.query("SELECT name FROM applied_migrations ORDER BY rowid").all() as { name: string }[]).map(
    (r) => r.name,
  );

test("the legacy migration array is frozen", () => {
  expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
});

test("repository migration files are validly named", () => {
  expect(() => migrationNames(MIGRATION_DIR)).not.toThrow();
});

test("fresh Store applies legacy and file migrations and reopens without new records", () => {
  temporary((directory, path) => {
    writeFileSync(join(directory, "20260927T1500-fresh.sql"), "CREATE TABLE from_file (id INTEGER);");
    let store = new Store(path, directory);
    expect(store.db.query("SELECT name FROM sqlite_master WHERE name = 'from_file'").get()).toEqual({
      name: "from_file",
    });
    expect(legacyRows(store.db)).toHaveLength(MIGRATIONS.length);
    expect(fileNames(store.db)).toEqual(["20260927T1500-fresh.sql"]);
    store.close();
    store = new Store(path, directory);
    expect(legacyRows(store.db)).toHaveLength(MIGRATIONS.length);
    expect(fileNames(store.db)).toEqual(["20260927T1500-fresh.sql"]);
    store.close();
  });
});

test("upgrading an existing database applies only new files and leaves legacy tracking untouched", () => {
  temporary((directory, path) => {
    legacyDatabase(path);
    const before = new Database(path);
    const rows = legacyRows(before);
    before.close();
    writeFileSync(join(directory, "20260927T1500-upgrade.sql"), "CREATE TABLE from_file (id INTEGER);");
    const store = new Store(path, directory);
    expect(store.db.query("SELECT value FROM settings WHERE key = 'sentinel'").get()).toEqual({
      value: "unchanged",
    });
    expect(legacyRows(store.db)).toEqual(rows);
    expect(fileNames(store.db)).toEqual(["20260927T1500-upgrade.sql"]);
    store.close();
  });
});

test("a previous release can still open the database (deploy rollback)", () => {
  temporary((directory, path) => {
    writeFileSync(join(directory, "20260927T1500-added.sql"), "CREATE TABLE added (id INTEGER);");
    new Store(path, directory).close();
    // The pre-file-migration Store.migrate(): version-keyed table, legacy array only.
    const db = new Database(path);
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    const applied = new Set(
      (db.query("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
        (r) => r.version,
      ),
    );
    expect(MIGRATIONS.filter((m) => !applied.has(m.version))).toEqual([]);
    db.close();
    // Every shipped file migration, including the additive cache-write column, applies in turn.
    const shipped = new Store(path);
    shipped.close();
    const after = new Database(path);
    after.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    const stillApplied = new Set(
      (after.query("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
        (r) => r.version,
      ),
    );
    expect(MIGRATIONS.filter((m) => !stillApplied.has(m.version))).toEqual([]);
    expect(after.query("SELECT input_tokens, cache_read_tokens FROM invocations LIMIT 0").all()).toEqual([]);
    after.close();
  });
});

test("invocations recorded before cache writes were stored read as zero writes", () => {
  temporary((directory, path) => {
    const before = join(directory, "before");
    cpSync(MIGRATION_DIR, before, {
      recursive: true,
      filter: (src) => !src.endsWith("-invocation-cache-write-tokens.sql"),
    });
    const old = new Store(path, before);
    const repo = old.upsertRepo({
      slug: "local/legacy",
      kind: "local",
      localPath: directory,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = old.createRun(repo, { repo: repo.slug, prompt: "legacy" });
    const invocation = old.createInvocation({
      runId: run.id,
      stageId: null,
      role: "implement",
      harness: "claude",
      provider: "claude",
      model: "m",
      modelId: "claude/m",
    });
    old.updateInvocation(invocation.id, { status: "ok", inputTokens: 10, cacheReadTokens: 20 });
    old.close();

    const store = new Store(path);
    expect(store.listInvocations(run.id)[0]).toMatchObject({
      inputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
    });
    store.close();
  });
});

test("SQL files run in filename order regardless of creation order", () => {
  for (const reverse of [false, true]) {
    temporary((directory, path) => {
      const files = [
        ["20260927T1500-create.sql", "CREATE TABLE ordered (value TEXT);"],
        ["20260927T1501-insert.sql", "INSERT INTO ordered VALUES ('ok');"],
      ] as const;
      for (const [name, sql] of reverse ? [...files].reverse() : files)
        writeFileSync(join(directory, name), sql);
      const db = new Database(path);
      runMigrations(db, directory);
      expect(db.query("SELECT value FROM ordered").get()).toEqual({ value: "ok" });
      expect(fileNames(db)).toEqual(files.map(([name]) => name));
      db.close();
    });
  }
});

test("an older-timestamped file merged after a newer one was applied still runs", () => {
  temporary((directory, path) => {
    writeFileSync(join(directory, "20260927T1600-newer.sql"), "CREATE TABLE newer (id INTEGER);");
    let db = new Database(path);
    runMigrations(db, directory);
    db.close();
    writeFileSync(join(directory, "20260927T1500-older.sql"), "CREATE TABLE older (id INTEGER);");
    db = new Database(path);
    runMigrations(db, directory);
    expect(fileNames(db)).toEqual(["20260927T1600-newer.sql", "20260927T1500-older.sql"]);
    db.close();
  });
});

test("failed SQL rolls back its schema and record and stops later files", () => {
  temporary((directory, path) => {
    writeFileSync(
      join(directory, "20260927T1500-broken.sql"),
      "CREATE TABLE partial (id INTEGER); INSERT INTO missing VALUES (1);",
    );
    writeFileSync(join(directory, "20260927T1501-later.sql"), "CREATE TABLE later (id INTEGER);");
    const db = new Database(path);
    expect(() => runMigrations(db, directory)).toThrow();
    expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('partial', 'later')").all()).toEqual([]);
    expect(fileNames(db)).toEqual([]);
    db.close();
  });
});

test("editing an applied file fails startup", () => {
  temporary((directory, path) => {
    const file = join(directory, "20260927T1500-shipped.sql");
    writeFileSync(file, "CREATE TABLE shipped (id INTEGER);");
    new Store(path, directory).close();
    writeFileSync(file, "CREATE TABLE shipped (id INTEGER, extra TEXT);");
    expect(() => new Store(path, directory)).toThrow("Applied migration changed: 20260927T1500-shipped.sql");
  });
});

test("invalid and duplicate filenames are rejected", () => {
  expect(() => migrationNames("unused", ["2026-09-27-bad.sql"])).toThrow("Invalid migration filename");
  expect(() => migrationNames("unused", ["20260231T1500-no-such-day.sql"])).toThrow(
    "Invalid migration filename",
  );
  expect(() => migrationNames("unused", ["20260927T1500-a.sql", "20260927T1500-a.sql"])).toThrow(
    "Duplicate migration identity",
  );
  expect(migrationNames("unused", ["README.md", "20260927T1500-a.sql"])).toEqual(["20260927T1500-a.sql"]);
});

test("dependency migration upgrades existing runs and round-trips waiting runs", () => {
  temporary((_directory, path) => {
    legacyDatabase(path);
    const db = new Database(path);
    db.exec("INSERT INTO repos (id, slug, kind, created_at) VALUES ('repo', 'local', 'local', 1)");
    db.exec(
      "INSERT INTO runs (id, repo_id, title, prompt, source, status, created_at) VALUES ('old', 'repo', 'old', 'old', 'cli', 'queued', 1)",
    );
    db.close();
    let store = new Store(path);
    expect(store.getRun("old")).toMatchObject({ dependsOn: [], status: "queued", prClosedUnmerged: false });
    const repo = store.getRepo("repo");
    if (!repo) throw new Error("missing repo");
    const run = store.createRun(repo, { repo: "local", prompt: "next", dependsOn: ["old"] });
    store.close();
    store = new Store(path);
    expect(store.getRun(run.id)).toMatchObject({ dependsOn: ["old"], status: "waiting" });
    store.close();
  });
});

test("the resolution migration backfills legacy resolved runs as merged without feed items", () => {
  temporary((directory, path) => {
    const before = join(directory, "before");
    cpSync(MIGRATION_DIR, before, { recursive: true, filter: (src) => !src.endsWith("-run-resolution.sql") });
    const old = new Store(path, before);
    old.db.exec("INSERT INTO repos (id, slug, kind, created_at) VALUES ('repo', 'local', 'local', 1)");
    for (const [id, status, pr, mergedAt, finishedAt] of [
      ["merged", "resolved", "https://github.com/o/r/pull/1", 30, 20],
      ["no-merged-at", "resolved", null, null, 20],
      ["bare", "resolved", null, null, null],
      ["open", "needs_human", "https://github.com/o/r/pull/2", null, 20],
    ] as const)
      old.db
        .query(
          "INSERT INTO runs (id, repo_id, title, prompt, source, status, pr_url, merged_at, finished_at, created_at) VALUES (?, 'repo', 't', 'p', 'cli', ?, ?, ?, ?, 10)",
        )
        .run(id, status, pr, mergedAt, finishedAt);
    old.close();
    for (let open = 0; open < 2; open++) {
      const store = new Store(path);
      const resolution = (id: string) => store.getRun(id)?.resolution;
      const merged = { kind: "merged", note: null, by: "github" } as const;
      expect(resolution("merged")).toEqual({ ...merged, ref: "https://github.com/o/r/pull/1", at: 30 });
      expect(resolution("no-merged-at")).toEqual({ ...merged, ref: null, at: 20 });
      expect(resolution("bare")).toEqual({ ...merged, ref: null, at: 10 });
      expect(resolution("open")).toBeNull();
      const kinds = store.readFeed({ after: 0, limit: 100 }).items.map((i) => i.kind);
      expect(kinds).toEqual(["run.needs_human"]); // the insert-time item, never a run.resolved
      store.close();
    }
  });
});

test("recovery checkpoints upgrade older state JSON without changing its evidence", () => {
  temporary((_directory, path) => {
    legacyDatabase(path);
    const db = new Database(path);
    db.exec("INSERT INTO repos (id, slug, kind, created_at) VALUES ('repo', 'local', 'local', 1)");
    const states = [
      null,
      { phase: "loop", round: 2, implementer: { modelId: "a" } },
      { phase: "deliver", round: 1, deliveryComplete: true, needsHumanReason: "original" },
    ];
    for (const [i, state] of states.entries())
      db.query(
        "INSERT INTO runs (id, repo_id, title, prompt, source, status, error, state_json, created_at) VALUES (?, 'repo', 'old', 'old', 'cli', 'needs_human', 'blocked', ?, 1)",
      ).run(String(i), state === null ? null : JSON.stringify(state));
    db.close();
    const store = new Store(path);
    expect(store.getRunState<unknown>("0")).toBeNull();
    expect(store.getRunState<unknown>("1")).toEqual({
      ...states[1],
      deliveryComplete: false,
      needsHumanReason: "blocked",
    });
    expect(store.getRunState<unknown>("2")).toEqual(states[2]);
    store.close();
    const reopened = new Store(path);
    expect(reopened.getRunState<unknown>("2")).toEqual(states[2]);
    reopened.close();
  });
});

test("the baseline cache ships as one migration with no unused table", () => {
  temporary((_directory, path) => {
    const store = new Store(path, MIGRATION_DIR);
    expect(fileNames(store.db).filter((n) => n.startsWith("20260930T"))).toEqual([
      "20260930T2017-baseline-cache.sql",
    ]);
    const tables = store.db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('baseline_cache', 'passing_baselines')",
      )
      .all();
    expect(tables).toEqual([{ name: "passing_baselines" }]);
    store.close();
  });
});

test("audit allowances persist from requester text and options; legacy runs allow nothing", () => {
  temporary((_directory, path) => {
    let store = new Store(path);
    const repo = store.upsertRepo({
      slug: "local/repo",
      kind: "local",
      url: null,
      localPath: "/tmp/repo",
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const create = (req: Partial<CreateRunRequest>, verified = false) =>
      store.createRun(repo, { repo: repo.slug, prompt: "Do the work", ...req }, verified).allow;
    expect(create({ prompt: "Vendor it.\r\n\tallow:GITATTRIBUTES\t\r\nAllow: submodules" })).toEqual([
      "submodules",
      "gitattributes",
    ]);
    expect(
      create({ prompt: "Do not use git submodules.\nAllow submodules\nAllow: submodules, please" }),
    ).toEqual([]);
    expect(create({ allow: ["gitattributes", "gitattributes"] })).toEqual(["gitattributes"]);
    expect(create({ prompt: "Allow: binary" })).toEqual(["binary"]);
    expect(create({ allow: ["binary", "binary"] })).toEqual(["binary"]);
    for (const source of ["github", "mcp"] as const)
      expect(create({ source, prompt: "Allow: binary" })).toEqual([]);
    expect(create({ prompt: "Allow: binary" }, true)).toEqual([]);
    expect(create({ prompt: "Allow: binary", sourceRef: { proposalId: "confirmed" } })).toEqual([]);
    expect(create({ prompt: "quoted", source: "mcp", allow: ["binary"] })).toEqual(["binary"]);
    const binaryRun = store.createRun(repo, { repo: repo.slug, prompt: "Allow: binary" });
    expect(store.getRun(binaryRun.id)?.allow).toEqual(["binary"]);
    for (const source of ["cli", "ui"] as const)
      expect(create({ source, prompt: "Allow: submodules" })).toEqual(["submodules"]);
    expect(create({ source: "discord", prompt: "Allow: submodules" })).toEqual(["submodules"]);
    expect(create({ prompt: "Allow: submodules", allow: ["gitattributes"] })).toEqual([
      "submodules",
      "gitattributes",
    ]);
    // GitHub prompts quote third-party text; only the parsed allow list from ingestion counts.
    expect(create({ prompt: "Allow: submodules", source: "github" })).toEqual([]);
    expect(create({ prompt: "Allow: submodules" }, true)).toEqual([]);
    expect(create({ prompt: "Allow: submodules", allow: ["gitattributes"] }, true)).toEqual([
      "gitattributes",
    ]);
    expect(() => create({ allow: ["everything"] as unknown as AuditAllowance[] })).toThrow(
      'Invalid allow value "everything"',
    );
    expect(() => create({ allow: "submodules" as unknown as AuditAllowance[] })).not.toThrow();
    const legacy = store.createRun(repo, { repo: repo.slug, prompt: "Allow: submodules" }).id;
    // Simulate a database from before the column existed, then migrate it forward.
    store.db.exec("ALTER TABLE runs DROP COLUMN audit_allow");
    store.db.exec("DELETE FROM applied_migrations WHERE name = '20261002T2340-run-audit-allow.sql'");
    store.close();
    store = new Store(path);
    expect(store.getRun(legacy)?.allow).toEqual([]);
    store.close();
  });
});

test("after the review-round migration the previous release still opens the database and writes runs", () => {
  temporary((directory, path) => {
    const current = new Store(path);
    const repo = current.upsertRepo({
      slug: "o/r",
      kind: "github",
      url: "unused",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const prUrl = "https://github.com/o/r/pull/1";
    const sha = "a".repeat(40);
    const owner = current.createRun(repo, { repo: repo.slug, prompt: "feature" });
    current.updateRun(owner.id, { status: "succeeded", branch: "limitless/feature", prUrl });
    current.createReviewRound(
      repo,
      current.getRun(owner.id) as Run,
      { prUrl, reviewedSha: sha, findings: [], cap: 3 },
      (round) => ({
        repo: repo.slug,
        prompt: "apply findings",
        baseBranch: "limitless/feature",
        deliveryBranch: "limitless/feature",
        sourceRef: { kind: "review-round", runId: owner.id, round, prUrl, reviewedSha: sha },
      }),
    );
    current.recordApproval(owner.id, prUrl, sha, "reviewer");
    current.close();
    // The previous release ships every migration file except this one.
    const before = join(directory, "before");
    cpSync(MIGRATION_DIR, before, { recursive: true, filter: (src) => !src.endsWith("-review-rounds.sql") });
    const previous = new Store(path, before);
    const run = previous.createRun(repo, { repo: repo.slug, prompt: "after a rollback" });
    previous.createInvocation({
      runId: run.id,
      stageId: previous.startStage(run.id, "implement").id,
      role: "implement",
      harness: "fake",
      provider: "a",
      model: "a",
      modelId: "a",
    });
    previous.updateRun(run.id, { status: "succeeded", prUrl: "https://github.com/o/r/pull/2" });
    previous.close();
    const reopened = new Store(path);
    expect(reopened.getRun(run.id)).toMatchObject({ status: "succeeded" });
    expect(reopened.listInvocations(run.id)).toHaveLength(1);
    expect(reopened.reviewRounds(prUrl)).toMatchObject([{ round: 1, reviewedSha: sha }]);
    expect(reopened.approvalFor(prUrl)).toEqual({ sha, stale: false });
    reopened.close();
  });
});
