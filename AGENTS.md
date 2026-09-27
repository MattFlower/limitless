# Working on Limitless

Limitless is a personal software factory: a Bun + TypeScript daemon with a SQLite store, a
deterministic run pipeline, harness adapters for the `claude` and `codex` CLIs, and a SolidJS UI.
Read `docs/ARCHITECTURE.md` before changing anything structural.

## Layout
- `src/core/types.ts` — domain types shared by daemon, CLI and UI (no runtime imports here).
- `src/db/` — `Store` (all persistence + pub/sub); schema changes are timestamped SQL files in `src/db/migrations/` (never edit a shipped one; see its README).
- `src/pipeline/` — `engine.ts` (stage state machine), `context.ts` (invoke/routing/fallback), `prompts.ts`, `schemas.ts` (zod → strict JSON schema), `report.ts`.
- `src/harness/` — CLI adapters. Parsers are pure classes tested against captured fixtures in `test/fixtures/`.
- `src/router/` — model catalog + policy, provider quota/health tracking, routing.
- `src/gates/` — gate detection/running and the deterministic diff audit.
- `src/git/` — bare repo cache, per-run worktrees, push/PR/merge via `gh`.
- `src/server/http.ts` — REST + SSE API. `src/cli/main.ts` — CLI and `serve`.
- `ui/` — SolidJS SPA, bundled by Bun via `scripts/solid-plugin.ts`.

## Rules
- Run `bun run check` (biome lint, `tsc --noEmit`, `bun test`) before finishing. All three must pass.
- The pipeline is deterministic code; LLMs only work *inside* stages. Don't add LLM-decided control flow.
- Anything that talks to a paid model must be testable with the fake harness (`src/harness/fake.ts`).
  Tests must never call real LLMs, the network, or `gh`.
- Keep types strict: no `any`, no non-null assertions where a check is cheap.
- New persisted fields need a new `src/db/migrations/YYYYMMDDTHHMM-slug.sql` (UTC), additive so the previous release still runs.
- Match the surrounding style: small focused modules, comments only where the *why* isn't obvious.
- Never commit secrets. Configuration lives in `~/.config/limitless/{config.toml,secrets.env}`.
