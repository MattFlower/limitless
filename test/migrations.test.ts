import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { AuditAllowance, CreateRunRequest, Run } from "../src/core/types.ts";
import { MIGRATION_DIR, migrationNames, runMigrations } from "../src/db/migration-runner.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { ownerDiagnostics } from "../src/db/owner-diagnostics.ts";
import { Store } from "../src/db/store.ts";
import { mountDefectWindow } from "../src/integrations/defect-land-detector.ts";
import { createDefectReporter } from "../src/integrations/defect-reporter.ts";
import { mountIntegrations } from "../src/integrations/index.ts";
import { customModel } from "./provider-config-support.ts";
import { waitClock } from "./wait-clock.ts";

const childKeyMigration = "20261016T091806-foreign-key-child-indexes.sql";

function uncoveredForeignKeys(db: Database): string[] {
  const uncovered: string[] = [];
  for (const { name: table } of db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()) {
    const keys = new Map<number, string[]>();
    for (const fk of db
      .query<{ id: number; from: string }, [string]>(
        'SELECT id, "from" FROM pragma_foreign_key_list(?) ORDER BY id, seq',
      )
      .all(table)) {
      const columns = keys.get(fk.id) ?? [];
      columns.push(fk.from);
      keys.set(fk.id, columns);
    }
    const indexes = db
      .query<{ name: string }, [string]>("SELECT name FROM pragma_index_list(?) WHERE partial = 0")
      .all(table)
      .map(({ name }) =>
        db
          .query<{ name: string | null }, [string]>("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
          .all(name)
          .map((column) => column.name),
      );
    indexes.push(
      db
        .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk")
        .all(table)
        .map((column) => column.name),
    );
    for (const columns of keys.values()) {
      if (!indexes.some((index) => columns.every((column, i) => index[i] === column)))
        uncovered.push(`${table}(${columns.join(", ")})`);
    }
  }
  return uncovered.sort();
}

test("every foreign key has a nonpartial index with its child columns first", () => {
  const store = new Store(":memory:");
  try {
    expect(uncoveredForeignKeys(store.db)).toEqual([]);
    for (const column of ["event", "invocation"])
      expect(
        store.db
          .query("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
          .all(`owner_diagnostics_${column}`),
      ).toEqual([{ name: `${column}_id` }]);
  } finally {
    store.close();
  }
});

test("defect outbox tables survive rollback while the previous release continues writing", () => {
  temporary((directory, path) => {
    const before = join(directory, "before");
    cpSync(MIGRATION_DIR, before, {
      recursive: true,
      filter: (src) => !src.endsWith("-defect-outbox.sql"),
    });
    const old = new Store(path, before);
    old.setSetting("existing", "preserved");
    old.close();
    const current = new Store(path);
    current.db
      .query("INSERT INTO defect_outbox (source_ref,source_key,state) VALUES (?,?,?)")
      .run("source", "event", "blocked");
    current.close();
    const rolledBack = new Store(path, before);
    expect(rolledBack.getSetting("existing", "")).toBe("preserved");
    rolledBack.setSetting("rollback", "written");
    rolledBack.close();
    const upgraded = new Store(path);
    try {
      expect(upgraded.getSetting("rollback", "")).toBe("written");
      expect(upgraded.db.query("SELECT source_key,state FROM defect_outbox").all()).toEqual([
        { source_key: "event", state: "blocked" },
      ]);
    } finally {
      upgraded.close();
    }
  });
});

test("land detector migration permits prior writes and recovers a pending send after re-upgrade", async () => {
  const directory = mkdtempSync(join(tmpdir(), "defect-upgrade-"));
  const path = join(directory, "store.db");
  const before = join(directory, "before");
  cpSync(MIGRATION_DIR, before, {
    recursive: true,
    filter: (src) => !src.endsWith("-defect-land-detection.sql"),
  });
  let store = new Store(path, before);
  const app = { kind: "app", botLogin: "factory[bot]", token: "fake" } as const;
  const source = store.upsertRepo({
    id: "source",
    slug: "example/product",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  let posts = 0;
  let lists = 0;
  let body = "";
  const deps = {
    repos: [source],
    factory: "example/factory",
    coordinator: () => ({ enabled: true }),
    now: () => 100,
    identity: async () => app,
    policy: () => ({ discreet: false }),
    loadPrivateStrings: () => [],
    registeredCredentials: () => [],
    github: {
      list: async () => {
        lists++;
        return [
          {
            number: 7,
            body,
            author: { login: app.botLogin, type: "Bot" },
            createdAt: "2026-10-31T18:00:00Z",
            lastEditedAt: null,
            includesCreatedEdit: false,
            labels: [{ name: "defect" }],
          },
        ];
      },
      issue: async () => null,
      label: async () => true,
      post: async () => {
        posts++;
        throw new Error("unexpected replacement POST");
      },
    },
  };
  try {
    const commit = await createDefectReporter(store, deps).prepareSubmission("old-send", {
      sourceId: source.id,
      detector: "land-check",
      class: "setup",
      phase: "setup",
      checkIdentity: "lint",
    });
    body = commit()?.body ?? "";
    expect(body).not.toBe("");
    store.db.exec("UPDATE defect_outbox SET state='sending',operation='issue'");
    store.close();
    store = new Store(path);
    mountDefectWindow(store, true, 100);
    store.close();
    store = new Store(path, before);
    const run = store.createRun(source, { repo: source.slug, prompt: "rollback" });
    const land = store.createLandEntry({
      runId: run.id,
      repo: source.slug,
      prUrl: "https://github.com/example/product/pull/9",
      baseBranch: "main",
      headBranch: "change/rollback",
      approvedSha: "a".repeat(40),
    });
    store.db.exec(`INSERT INTO failure_observations (run_id,repo,stage_id,round,sha,handle_kind,handle_id,
      phase,name,command,observed_at,timed_out,confinement,duration_ms,failed_files,output_tail,signature,setup_eligible)
      VALUES ('prior','example/product',0,0,'head','land','1:1','setup','check','',100,0,0,1,'[]','','signature',0)`);
    store.observations.finalize("prior");
    store.db.exec(
      "INSERT INTO defect_outbox (source_ref,source_key,state) VALUES ('source','rollback','no-report')",
    );
    store.updateLandEntry(land.id, { state: "blocked" });
    store.close();
    store = new Store(path);
    const reporter = createDefectReporter(store, deps);
    const cfg = loadConfig({
      home: directory,
      configDir: directory,
      readOnly: true,
      raw: { github: { poll: false } },
    });
    cfg.githubDefects = { enabled: true, factoryRepo: "example/factory", dailyCap: 10 };
    cfg.secrets.DISCORD_BOT_TOKEN = "";
    const clock = waitClock();
    const mounted = await mountIntegrations(
      {
        cfg,
        store,
        land: {
          start: () => {},
          stop: async () => {},
          list: () => [],
        },
      } as unknown as Factory,
      {
        defectGitHub: deps.github,
        identity: deps.identity,
        toolVersions: async () => [],
        prClient: async () => null,
        gh: async () => {
          throw new Error("unexpected gh");
        },
        issueClock: { now: clock.now, set: clock.timer.set as typeof setTimeout, clear: clock.timer.clear },
      },
    );
    try {
      await clock.advance(0);
      await new Promise<void>((r) => setImmediate(r));
      expect(posts).toBe(0);
      expect(lists).toBeGreaterThan(0);
      expect(reporter.read(source.id, "old-send")).toMatchObject({ state: "delivered", object_id: 7 });
      expect(reporter.read(source.id, "rollback")?.state).toBe("no-report");
      expect(store.getLandEntry(land.id)?.state).toBe("blocked");
      expect(store.failureObservations()).toHaveLength(1);
      expect(store.db.query("SELECT start,end FROM defect_enablement_windows").all()).toEqual([
        { start: 100, end: null },
      ]);
      await clock.advance(60_000);
      await new Promise<void>((r) => setImmediate(r));
      expect(posts).toBe(0);
    } finally {
      await mounted.stop();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("child-key indexes upgrade populated databases once and permit previous-release writes", () => {
  temporary((directory, path) => {
    const before = join(directory, "before");
    cpSync(MIGRATION_DIR, before, {
      recursive: true,
      filter: (src) => !src.endsWith(childKeyMigration),
    });
    let store = new Store(path, before);
    const repo = store.upsertRepo({
      slug: "local/index-upgrade",
      kind: "local",
      localPath: directory,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const populate = () => {
      const run = store.createRun(repo, { repo: repo.slug, prompt: "index upgrade" });
      const invocation = store.createInvocation({
        runId: run.id,
        stageId: store.startStage(run.id, "implement").id,
        role: "implement",
        harness: "fake",
        provider: "fake",
        model: "fake",
        modelId: "fake/m",
      });
      const event = store.addEvent({
        runId: run.id,
        invocationId: invocation.id,
        type: "log",
        message: "public",
      });
      store.recordOwnerDiagnostic(
        { runId: run.id, invocationId: invocation.id, eventId: event.id, kind: "event", text: "owner" },
        "public",
      );
      return run.id;
    };
    const runId = populate();
    const tables = ["repos", "runs", "stages", "invocations", "events", "owner_diagnostics"];
    const snapshot = () => tables.map((table) => store.db.query(`SELECT * FROM ${table}`).all());
    const rows = snapshot();
    const applied = fileNames(store.db);
    expect(uncoveredForeignKeys(store.db)).toEqual([
      "ci_fix_triggers(run_id)",
      "conflict_triggers(land_entry_id)",
      "conflict_triggers(run_id)",
      "eval_run_requests(resumed_by)",
      "eval_run_requests(resumed_from)",
      "invocations(stage_id)",
      "owner_diagnostics(event_id)",
      "owner_diagnostics(invocation_id)",
      "review_approvals(run_id)",
      "runs(repo_id)",
    ]);
    store.close();
    store = new Store(path);
    expect(snapshot()).toEqual(rows);
    expect(uncoveredForeignKeys(store.db)).toEqual([]);
    expect(fileNames(store.db)).toEqual([...applied, childKeyMigration]);
    const records = store.db.query("SELECT * FROM applied_migrations ORDER BY name").all();
    store.close();
    store = new Store(path);
    expect(store.db.query("SELECT * FROM applied_migrations ORDER BY name").all()).toEqual(records);
    store.close();
    store = new Store(path, before);
    expect(store.getRun(runId)?.prompt).toBe("index upgrade");
    const rollbackRunId = populate();
    store.close();
    store = new Store(path);
    try {
      expect(store.listInvocations(rollbackRunId)).toHaveLength(1);
      expect(ownerDiagnostics(store.db, rollbackRunId)).toMatchObject([{ text: "owner" }]);
      expect(uncoveredForeignKeys(store.db)).toEqual([]);
      expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
    }
  });
});

test("runtime catalog and discovery upgrade legacy databases and restore before operator policy", () => {
  temporary((directory, path) => {
    legacyDatabase(path);
    const cfg = loadConfig({ home: directory, configDir: directory });
    let store = new Store(path);
    const factory = new Factory(cfg, { store });
    factory.catalog.add({ ...customModel, provider: "codex", id: "experiment" });
    factory.routing.setCell("triage", "default", ["codex/experiment@high"]);
    store.writeDiscovery("omlx", ["first", "second"], 100);
    store.writeDiscovery("omlx", ["second"], 200);
    store.close();
    const previous = new Database(path);
    expect(previous.query("SELECT value FROM settings WHERE key = 'sentinel'").get()).toEqual({
      value: "unchanged",
    });
    previous.exec("INSERT INTO settings VALUES ('rollback', 'works')");
    previous.close();
    store = new Store(path);
    try {
      const restored = new Factory(cfg, { store });
      expect(restored.router.route("triage", "small").candidates[0]?.targetId).toBe("codex/experiment@high");
      expect(restored.catalog.snapshot().models.find((m) => m.id === "codex/experiment")?.source).toBe(
        "runtime",
      );
      expect(store.discovery("omlx")).toEqual({
        served: ["second"],
        observedAt: 200,
        observations: [
          { model: "first", firstSeen: 100, lastSeen: 100 },
          { model: "second", firstSeen: 100, lastSeen: 200 },
        ],
      });
      expect(restored.tracker.status("omlx")?.discovery?.served).toBeNull();
      expect(store.db.query("SELECT value FROM settings WHERE key = 'rollback'").get()).toEqual({
        value: "works",
      });
    } finally {
      store.close();
    }
  });
});

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

test("pre-diagnostics runs open and previous-release writes survive the additive migration", () => {
  temporary((directory, path) => {
    const before = join(directory, "before");
    cpSync(MIGRATION_DIR, before, {
      recursive: true,
      filter: (src) => !src.endsWith("-owner-diagnostics.sql") && !src.endsWith(childKeyMigration),
    });
    let store = new Store(path, before);
    const repo = store.upsertRepo({
      slug: "local/old",
      kind: "local",
      localPath: directory,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "old run" });
    expect(ownerDiagnostics(store.db, run.id)).toEqual([]);
    store.close();
    store = new Store(path);
    expect(store.getRunDetail(run.id)?.run.prompt).toBe("old run");
    expect(ownerDiagnostics(store.db, run.id)).toEqual([]);
    store.recordOwnerDiagnostic({ runId: run.id, kind: "run-error", text: "owner" }, "public");
    store.close();
    store = new Store(path, before);
    expect(store.createRun(repo, { repo: repo.slug, prompt: "rollback write" }).prompt).toBe(
      "rollback write",
    );
    expect(ownerDiagnostics(store.db, run.id)[0]?.text).toBe("owner");
    store.close();
  });
});

test("model chains and title provenance persist across upgrades, reopening and prior-release writes", () => {
  temporary((_directory, path) => {
    legacyDatabase(path);
    const legacy = new Database(path);
    legacy.exec("INSERT INTO repos (id, slug, kind, created_at) VALUES ('repo', 'local', 'local', 1)");
    legacy.exec(
      "INSERT INTO runs (id, repo_id, title, prompt, source, status, created_at) VALUES ('old', 'repo', 'old', 'old', 'cli', 'queued', 1)",
    );
    legacy.close();
    let store = new Store(path);
    expect(store.getRun("old")?.models).toEqual({});
    const repo = store.getRepo("repo");
    if (!repo) throw new Error("missing repo");
    const models = { implement: ["codex/sol@high", "claude/opus"], review: ["claude/opus|codex/sol"] };
    const run = store.createRun(repo, { repo: repo.slug, prompt: "experiment", title: "Explicit", models });
    const defaulted = store.createRun(repo, { repo: repo.slug, prompt: "Defaulted" });
    expect(defaulted.title).toBe("Defaulted");
    store.close();
    // Prior-release SQL names only its known columns, so the default handles its inserts.
    const previous = new Database(path);
    expect(previous.query("SELECT title, prompt FROM runs WHERE id = ?").get(run.id)).toEqual({
      title: "Explicit",
      prompt: "experiment",
    });
    previous
      .query(
        `INSERT INTO runs (id, repo_id, title, prompt, source, source_ref, requested_by, profile, status, priority, base_branch, delivery_branch, github_webhook_verified, created_at, depends_on, error, finished_at, no_baseline_cache, audit_allow, pr_url, models_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "rollback",
        "repo",
        "rollback",
        "rollback",
        "cli",
        null,
        null,
        "auto",
        "queued",
        0,
        null,
        null,
        0,
        2,
        "[]",
        null,
        null,
        0,
        "[]",
        null,
        "{}",
      );
    previous.close();
    store = new Store(path);
    expect(store.getRun(run.id)?.models).toEqual(models);
    expect(store.getRun("rollback")?.models).toEqual({});
    expect(store.getRun("old")).toMatchObject({ title: "old", titleProvenance: null });
    expect(store.getRun(run.id)).toMatchObject({ title: "Explicit", titleProvenance: "explicit" });
    expect(store.getRun(defaulted.id)).toMatchObject({ title: "Defaulted", titleProvenance: "defaulted" });
    expect(store.getRun("rollback")).toMatchObject({ title: "rollback", titleProvenance: null });
    store.close();
  });
});

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

test("operator routing migration upgrades an existing DB and permits previous-release reopen", () => {
  temporary((directory, path) => {
    const before = join(directory, "before");
    cpSync(MIGRATION_DIR, before, {
      recursive: true,
      filter: (src) => !src.endsWith("-operator-routing.sql"),
    });
    let previous = new Store(path, before);
    previous.setSetting("sentinel", "unchanged");
    const legacy = legacyRows(previous.db);
    previous.close();
    const current = new Store(path);
    current.writeRouting("triage.default", ["codex/sol"], "live", "tester");
    current.writeRouting("prefer", ["codex"], null, "tester");
    expect(legacyRows(current.db)).toEqual(legacy);
    current.close();
    previous = new Store(path, before);
    expect(previous.getSetting("sentinel", "")).toBe("unchanged");
    previous.setSetting("rollback", "works");
    previous.close();
    const reopened = new Store(path);
    expect(reopened.getSetting("rollback", "")).toBe("works");
    expect(reopened.routingCells()).toMatchObject([
      { role: "triage", cell: "default", groups: ["codex/sol"] },
    ]);
    expect(reopened.routingPrefer()).toEqual(["codex"]);
    expect(reopened.routingHistory()).toHaveLength(2);
    reopened.close();
  });
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
    const before = join(directory, "before");
    cpSync(MIGRATION_DIR, before, {
      recursive: true,
      filter: (src) => !src.endsWith("-github-closed-expiry.sql"),
    });
    const old = new Store(path, before);
    const url = "https://github.com/o/r/pull/1";
    old.db
      .query("INSERT OR REPLACE INTO github_prs VALUES (?, ?, ?, ?)")
      .run(url, "node", JSON.stringify({ state: "CLOSED" }), 1);
    old.close();
    new Store(path).close();
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
    expect(() =>
      db
        .query("INSERT OR REPLACE INTO github_prs VALUES (?, ?, ?, ?)")
        .run(url, "node", JSON.stringify({ state: "OPEN" }), 0),
    ).not.toThrow();
    expect(db.query("SELECT closed_at, reopened_at FROM github_pr_expiry WHERE url = ?").get(url)).toEqual({
      closed_at: expect.any(Number),
      reopened_at: null,
    });
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

test("process discovery migration preserves pre-change data and rollback writes leave evidence intact", () => {
  temporary((directory, path) => {
    const before = join(directory, "before");
    cpSync(MIGRATION_DIR, before, {
      recursive: true,
      filter: (src) =>
        !src.endsWith("-process-discoveries.sql") && !src.endsWith("-process-discovery-owner.sql"),
    });
    const old = new Store(path, before);
    old.setSetting("sentinel", "unchanged");
    const repo = old.upsertRepo({
      slug: "local/legacy",
      kind: "local",
      localPath: directory,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const original = old.createRun(repo, { repo: repo.slug, prompt: "existing" });
    old.close();
    const current = new Store(path);
    const evidence = {
      invocation: "persisted",
      runId: original.id,
      directory,
      boot: "old-boot",
      createdAt: 1,
      discovery: { group: 42, started: 1, directories: [directory], leader: null, spawnedAt: "0" },
      ownerId: null,
      ownerPid: null,
      ownerBirth: null,
    };
    current.recordProcessDiscovery(evidence);
    expect(current.getRun(original.id)?.prompt).toBe("existing");
    current.close();
    const previous = new Store(path, before);
    const run = previous.createRun(repo, { repo: repo.slug, prompt: "rollback work" });
    previous.createInvocation({
      runId: run.id,
      stageId: null,
      role: "implement",
      harness: "fake",
      provider: "fake",
      model: "fake",
      modelId: "fake/model",
    });
    previous.db
      .query("INSERT INTO process_cleanups VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(run.id, "legacy", directory, 42, "birth", "old-boot", 1, null);
    previous.setSetting("rollback", "works");
    previous.close();
    const reopened = new Store(path);
    try {
      expect(reopened.getSetting("sentinel", "")).toBe("unchanged");
      expect(reopened.getSetting("rollback", "")).toBe("works");
      expect(reopened.listInvocations(run.id)).toHaveLength(1);
      expect(reopened.listProcessCleanups()).toMatchObject([{ invocation: "legacy", discovery: null }]);
      expect(reopened.listProcessDiscoveries()).toEqual([evidence]);
    } finally {
      reopened.close();
    }
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

test("CI claim timestamps upgrade existing rows and preserve previous-release inserts", () => {
  temporary((directory, path) => {
    const before = join(directory, "before");
    cpSync(MIGRATION_DIR, before, {
      recursive: true,
      filter: (src) => !src.endsWith("-ci-rerun-claimed-at.sql"),
    });
    const failure = {
      prUrl: "https://github.com/o/r/pull/1",
      sha: "a".repeat(40),
      signature: "legacy failure",
      check: "test",
      line: "timeout",
      image: null,
      outcome: "failed" as const,
      rerunMarker: null,
    };
    const job = { id: 21, runId: 1, attempt: 1, name: "test" };
    const old = new Store(path, before);
    old.recordCiFailure(failure);
    old.db
      .query(`UPDATE ci_failures SET rerun_claimed = 1, outcome = 'rerun_requested',
      rerun_marker = 'legacy', rerun_job = ?`)
      .run(JSON.stringify(job));
    old.close();

    const store = new Store(path);
    expect(store.ciFailures(failure.prUrl, failure.sha)).toEqual([
      {
        ...failure,
        outcome: "rerun_requested",
        rerunMarker: "legacy",
        rerunJob: job,
        rerunClaimedAt: null,
        rerunRetryAt: null,
        rerunRetryUsed: 0,
      },
    ]);
    store.close();

    // The previous release's explicit-column insert still works after migration.
    const previous = new Store(path, before);
    previous.recordCiFailure({ ...failure, signature: "rollback failure" });
    previous.close();
    const reopened = new Store(path);
    expect(reopened.ciFailures(failure.prUrl, failure.sha)).toHaveLength(2);
    expect(reopened.ciFailures(failure.prUrl, failure.sha).every((f) => f.rerunClaimedAt === null)).toBe(
      true,
    );
    reopened.close();
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

test("the previous release opens the migrated database and can still write runs and invocations", () => {
  temporary((directory, path) => {
    const before = join(directory, "before");
    // The shipped migrations minus the land queue: exactly what the last release knows.
    cpSync(MIGRATION_DIR, before, {
      recursive: true,
      filter: (src) => !src.endsWith("-land-queue.sql"),
    });
    new Store(path).close(); // the new release applies every file, including the land queue
    const store = new Store(path, before);
    const repo = store.upsertRepo({
      slug: "owner/name",
      kind: "github",
      url: "git@github.com:owner/name.git",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "old release work" });
    const invocation = store.createInvocation({
      runId: run.id,
      stageId: null,
      role: "implement",
      harness: "claude-cli",
      provider: "claude",
      model: "claude-opus-5",
      modelId: "claude/opus",
    });
    store.updateInvocation(invocation.id, { status: "ok", finishedAt: Date.now() });
    store.updateRun(run.id, { status: "succeeded", prUrl: "https://github.com/owner/name/pull/1" });
    store.close();
    const tables = (db: Database) =>
      (
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'land_entries'")
          .all() as unknown[]
      ).length;
    const reopened = new Database(path);
    expect(tables(reopened)).toBe(1); // the land queue's table is additive: the old release ignores it
    reopened.close();
    const again = new Store(path, before);
    expect(again.getRun(run.id)?.status).toBe("succeeded");
    expect(again.listInvocations(run.id)[0]).toMatchObject({ status: "ok", role: "implement" });
    again.close();
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
