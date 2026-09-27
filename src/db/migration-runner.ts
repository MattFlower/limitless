import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "./migrations.ts";

export const MIGRATION_DIR = join(import.meta.dir, "migrations");
const FILE_NAME = /^\d{8}T\d{4}(?:\d{2})?-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/;
const TRACKING_TABLE = "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)";

export function migrationNames(directory: string, entries = readdirSync(directory)): string[] {
  const names = entries.filter((entry) => entry.endsWith(".sql"));
  const seen = new Set<string>();
  for (const name of names) {
    if (!FILE_NAME.test(name) || !validTimestamp(name))
      throw new Error(`Invalid migration filename: ${name}`);
    if (seen.has(name)) throw new Error(`Duplicate migration identity: ${name}`);
    seen.add(name);
  }
  return names.sort();
}

function validTimestamp(name: string): boolean {
  const stamp = name.slice(0, name.indexOf("-"));
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  const hour = Number(stamp.slice(9, 11));
  const minute = Number(stamp.slice(11, 13));
  const second = stamp.length === 15 ? Number(stamp.slice(13, 15)) : 0;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

export function verifyShipped(directory: string, manifest = join(directory, "SHIPPED")): void {
  const seen = new Set<string>();
  for (const line of readFileSync(manifest, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64}) {2}(.+\.sql)$/.exec(line);
    if (!match) throw new Error(`Invalid SHIPPED entry: ${line}`);
    const [, hash, name] = match;
    if (!hash || !name) throw new Error(`Invalid SHIPPED entry: ${line}`);
    if (seen.has(name)) throw new Error(`Duplicate migration identity: ${name}`);
    seen.add(name);
    migrationNames(directory, [name]);
    const actual = createHash("sha256")
      .update(readFileSync(join(directory, name)))
      .digest("hex");
    if (actual !== hash) throw new Error(`Shipped migration changed: ${name}`);
  }
  migrationNames(directory);
}

function legacyName(version: number): string {
  const migration = MIGRATIONS.find((m) => m.version === version);
  if (!migration) throw new Error(`Unknown legacy migration version: ${version}`);
  return `legacy-${String(version).padStart(4, "0")}-${migration.name}`;
}

function prepareTracking(db: Database): void {
  const exists = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!exists) {
    db.exec(TRACKING_TABLE);
    const level = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let version = 1; version <= level; version++) {
      db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        legacyName(version),
        Date.now(),
      );
    }
    return;
  }

  const columns = db.query("PRAGMA table_info(schema_migrations)").all() as { name: string }[];
  if (columns.some((column) => column.name === "version")) {
    const rows = db.query("SELECT version, name, applied_at FROM schema_migrations").all() as {
      version: number;
      name: string;
      applied_at: number;
    }[];
    const versions = rows.length
      ? rows.map((row) => {
          const migration = MIGRATIONS.find((m) => m.version === row.version);
          if (!migration || migration.name !== row.name)
            throw new Error(`Unknown legacy migration: ${row.version} ${row.name}`);
          return { name: legacyName(row.version), appliedAt: row.applied_at };
        })
      : Array.from(
          { length: (db.query("PRAGMA user_version").get() as { user_version: number }).user_version },
          (_, index) => ({ name: legacyName(index + 1), appliedAt: Date.now() }),
        );
    db.exec(TRACKING_TABLE.replace("schema_migrations", "schema_migrations_new"));
    for (const row of versions)
      db.query("INSERT INTO schema_migrations_new (name, applied_at) VALUES (?, ?)").run(
        row.name,
        row.appliedAt,
      );
    db.exec("DROP TABLE schema_migrations; ALTER TABLE schema_migrations_new RENAME TO schema_migrations");
  } else if (!columns.some((column) => column.name === "name")) {
    throw new Error("Unrecognized schema_migrations table");
  }
}

export function runMigrations(db: Database, directory = MIGRATION_DIR): void {
  const files = migrationNames(directory);
  db.transaction(() => prepareTracking(db))();
  const applied = new Set(
    (db.query("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name),
  );
  for (const migration of MIGRATIONS) {
    const name = legacyName(migration.version);
    if (applied.has(name)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
    })();
  }
  for (const name of files) {
    if (applied.has(name)) continue;
    db.transaction(() => {
      db.exec(readFileSync(join(directory, name), "utf8"));
      db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
    })();
  }
}
