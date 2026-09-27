import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMigrationCopy } from "../scripts/check-migration-copy.ts";
import { MIGRATION_DIR, migrationNames, runMigrations, verifyShipped } from "../src/db/migration-runner.ts";
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

function legacyDatabase(path: string, tracked: boolean): void {
  const db = new Database(path);
  if (tracked)
    db.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql);
    if (tracked)
      db.query("INSERT INTO schema_migrations VALUES (?, ?, 1)").run(migration.version, migration.name);
  }
  db.exec("INSERT INTO settings VALUES ('sentinel', 'unchanged')");
  if (!tracked) db.exec("PRAGMA user_version = 12");
  db.close();
}

test("fresh Store applies legacy and file migrations and reopens without new records", () => {
  temporary((directory, path) => {
    const filename = "20260927T1500-fresh.sql";
    writeFileSync(join(directory, filename), "CREATE TABLE from_file (id INTEGER);");
    let store = new Store(path, directory);
    expect(store.db.query("SELECT name FROM sqlite_master WHERE name = 'eval_trials'").get()).toEqual({
      name: "eval_trials",
    });
    const names = store.db.query("SELECT name FROM schema_migrations ORDER BY name").all() as {
      name: string;
    }[];
    expect(store.db.query("SELECT name FROM sqlite_master WHERE name = 'from_file'").get()).toEqual({
      name: "from_file",
    });
    expect(names).toHaveLength(MIGRATIONS.length + 1);
    expect(names.map((row) => row.name)).toContain("legacy-0001-initial");
    expect(names.map((row) => row.name)).toContain(filename);
    store.close();
    store = new Store(path, directory);
    expect(store.db.query("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({
      count: names.length,
    });
    store.close();
  });
});

for (const tracked of [true, false]) {
  test(`upgrades legacy database with ${tracked ? "version rows" : "user_version fallback"}`, () => {
    temporary((directory, path) => {
      legacyDatabase(path, tracked);
      const filename = "20260927T1500-upgrade.sql";
      writeFileSync(join(directory, filename), "CREATE TABLE from_file (id INTEGER);");
      const store = new Store(path, directory);
      expect(store.db.query("SELECT value FROM settings WHERE key = 'sentinel'").get()).toEqual({
        value: "unchanged",
      });
      expect(store.db.query("SELECT count(*) AS count FROM schema_migrations").get()).toEqual({
        count: MIGRATIONS.length + 1,
      });
      expect(store.db.query("SELECT name FROM schema_migrations WHERE name = ?").get(filename)).toEqual({
        name: filename,
      });
      expect(store.db.query("PRAGMA table_info(schema_migrations)").all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "name", pk: 1 })]),
      );
      store.close();
    });
  });
}

test("upgrading a current database without new files leaves application schema and data unchanged", () => {
  temporary((directory, path) => {
    legacyDatabase(path, true);
    const before = new Database(path);
    const schema = before
      .query(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> 'schema_migrations' ORDER BY type, name",
      )
      .all();
    const settings = before.query("SELECT * FROM settings ORDER BY key").all();
    before.close();
    const store = new Store(path, directory);
    expect(
      store.db
        .query(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> 'schema_migrations' ORDER BY type, name",
        )
        .all(),
    ).toEqual(schema);
    expect(store.db.query("SELECT * FROM settings ORDER BY key").all()).toEqual(settings);
    store.close();
  });
});

test("deployment check uses a production database copy and leaves the source untouched", () => {
  temporary((directory, path) => {
    legacyDatabase(path, true);
    const before = new Database(path);
    const original = before.query("SELECT * FROM schema_migrations ORDER BY version").all();
    before.close();
    checkMigrationCopy(path, directory);
    const after = new Database(path);
    expect(after.query("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(original);
    expect(after.query("SELECT value FROM settings WHERE key = 'sentinel'").get()).toEqual({
      value: "unchanged",
    });
    after.close();
  });
});

test("deployment check applies pending SQL only to its copy", () => {
  temporary((directory, path) => {
    legacyDatabase(path, true);
    writeFileSync(join(directory, "20260927T1500-deploy.sql"), "CREATE TABLE deployed (id INTEGER);");
    checkMigrationCopy(path, directory);
    const source = new Database(path);
    expect(source.query("SELECT name FROM sqlite_master WHERE name = 'deployed'").get()).toBeNull();
    source.close();
  });
});

test("deployment check rejects unexpected application changes without pending files", () => {
  temporary((directory, path) => {
    const db = new Database(path);
    db.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    for (const migration of MIGRATIONS.slice(0, -1)) {
      db.exec(migration.sql);
      db.query("INSERT INTO schema_migrations VALUES (?, ?, 1)").run(migration.version, migration.name);
    }
    db.close();
    expect(() => checkMigrationCopy(path, directory)).toThrow(
      "migration copy changed application schema or data",
    );
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
      expect(
        (
          db.query("SELECT name FROM schema_migrations WHERE name LIKE '2026%' ORDER BY rowid").all() as {
            name: string;
          }[]
        ).map((r) => r.name),
      ).toEqual(files.map(([name]) => name));
      db.close();
    });
  }
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
    expect(db.query("SELECT name FROM schema_migrations WHERE name LIKE '2026%'").all()).toEqual([]);
    db.close();
  });
});

test("SHIPPED detects changed and missing files and duplicate identities", () => {
  temporary((directory) => {
    const name = "20260927T1500-shipped.sql";
    const path = join(directory, name);
    const sql = "CREATE TABLE shipped (id INTEGER);";
    writeFileSync(path, sql);
    const entry = `${createHash("sha256").update(sql).digest("hex")}  ${name}\n`;
    writeFileSync(join(directory, "SHIPPED"), entry);
    expect(() => verifyShipped(directory)).not.toThrow();
    writeFileSync(join(directory, "SHIPPED"), entry + entry);
    expect(() => verifyShipped(directory)).toThrow("Duplicate migration identity");
    writeFileSync(join(directory, "SHIPPED"), entry);
    writeFileSync(path, `${sql} `);
    expect(() => verifyShipped(directory)).toThrow("Shipped migration changed");
    unlinkSync(path);
    expect(() => verifyShipped(directory)).toThrow();
    expect(() => migrationNames(directory, [name, name])).toThrow("Duplicate migration identity");
  });
});

test("repository SHIPPED list matches its SQL files", () => {
  expect(() => verifyShipped(MIGRATION_DIR)).not.toThrow();
});
