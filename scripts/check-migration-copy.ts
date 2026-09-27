import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATION_DIR, migrationNames } from "../src/db/migration-runner.ts";
import { Store } from "../src/db/store.ts";

function applicationSnapshot(db: Database): string {
  const schema = db
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> 'schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string }[];
  const data = schema
    .filter((entry) => entry.type === "table")
    .map(({ name }) => {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const rows = db
        .query(`SELECT * FROM ${quoted}`)
        .all()
        .map((row) => JSON.stringify(row));
      return [name, rows.sort()];
    });
  return JSON.stringify({ schema, data });
}

/** Verify a release against a consistent production snapshot before the daemon restarts. */
export function checkMigrationCopy(dbPath: string, migrationDir = MIGRATION_DIR): void {
  if (!existsSync(dbPath)) return;
  const directory = mkdtempSync(join(tmpdir(), "limitless-migration-check-"));
  const copyPath = join(directory, "production.db");
  try {
    const source = new Database(dbPath);
    try {
      source.query("VACUUM INTO ?").run(copyPath);
    } finally {
      source.close();
    }
    const copy = new Database(copyPath);
    let before: string;
    let pending: string[];
    try {
      before = applicationSnapshot(copy);
      const tracked = copy
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get();
      const columns = tracked
        ? (copy.query("PRAGMA table_info(schema_migrations)").all() as { name: string }[])
        : [];
      const applied = columns.some(
        (column) => column.name === "name" && !columns.some((c) => c.name === "version"),
      )
        ? new Set(
            (copy.query("SELECT name FROM schema_migrations").all() as { name: string }[]).map(
              (row) => row.name,
            ),
          )
        : new Set<string>();
      pending = migrationNames(migrationDir).filter((name) => !applied.has(name));
    } finally {
      copy.close();
    }
    const store = new Store(copyPath, migrationDir);
    try {
      if (pending.length === 0 && applicationSnapshot(store.db) !== before)
        throw new Error("migration copy changed application schema or data without pending SQL files");
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  checkMigrationCopy(
    process.env.LIMITLESS_HOME
      ? join(process.env.LIMITLESS_HOME, "limitless.db")
      : join(homedir(), ".limitless", "limitless.db"),
  );
}
