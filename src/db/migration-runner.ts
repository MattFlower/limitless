import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "./migrations.ts";

export const MIGRATION_DIR = join(import.meta.dir, "migrations");
const FILE_NAME = /^\d{8}T\d{4}(?:\d{2})?-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/;

export function migrationNames(directory: string, entries = readdirSync(directory)): string[] {
  const names = entries.filter((entry) => entry.endsWith(".sql"));
  const seen = new Set<string>();
  for (const name of names) {
    if (!FILE_NAME.test(name) || !validTimestamp(name))
      throw new Error(`Invalid migration filename: ${name} (expected YYYYMMDDTHHMM[SS]-kebab-slug.sql, UTC)`);
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

const sha256 = (sql: string) => createHash("sha256").update(sql).digest("hex");

/**
 * Legacy migrations keep the version-keyed `schema_migrations` table exactly as older releases
 * expect it, so a deploy can always roll back. Timestamped files are tracked by name in
 * `applied_migrations`: branches that add files never conflict, and a file edited after it was
 * applied fails startup instead of silently diverging.
 */
export function runMigrations(db: Database, directory = MIGRATION_DIR): void {
  const files = migrationNames(directory);
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const versions = new Set(
    (db.query("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (versions.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        Date.now(),
      );
    })();
  }

  db.exec(
    "CREATE TABLE IF NOT EXISTS applied_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const applied = new Map(
    (db.query("SELECT name, sha256 FROM applied_migrations").all() as { name: string; sha256: string }[]).map(
      (r) => [r.name, r.sha256],
    ),
  );
  for (const name of files) {
    const sql = readFileSync(join(directory, name), "utf8");
    const hash = sha256(sql);
    const recorded = applied.get(name);
    if (recorded !== undefined) {
      if (recorded !== hash) throw new Error(`Applied migration changed: ${name}. Add a new file instead.`);
      continue;
    }
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO applied_migrations (name, sha256, applied_at) VALUES (?, ?, ?)").run(
        name,
        hash,
        Date.now(),
      );
    })();
  }
}
