import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
