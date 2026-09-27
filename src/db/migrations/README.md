# Migrations

Add schema changes as new SQL files here: `YYYYMMDDTHHMM[SS]-kebab-slug.sql`, timestamp in UTC,
e.g. `20260927T1500-run-dependencies.sql`. Files apply once, in filename order, each in its own
transaction, and are tracked by name and SHA-256 in `applied_migrations`.

- Never edit a file after it has shipped: startup fails if an applied file's content changes. Add a new file.
- Keep changes additive (new tables, nullable or defaulted columns) so the previous release can still
  open the database if a deploy rolls back.
- `src/db/migrations.ts` holds the frozen legacy migrations 1–12; don't add to it.
