# Verification reliability implementation report

Implemented on 2026-09-27 (date checked with `date -u`). Round 3 re-ran live validation on the factory host outside a nested sandbox: both native verify smoke rows **PASS** (AC-7).

## Changes

- `src/harness/{scratch,types,claude,codex}.ts`: a typed scratch root, canonical paths outside the checkout, matching child-only TMPDIR/TMP/TEMP, cleanup in finally, native sandbox arguments, and injected-process testing. Reading calls reject additional writable directories. Existing secret filtering and backend environment settings remain in place.
- `src/pipeline/context.ts` and `src/evals/runner.ts`: allocate scratch per tool-enabled reading attempt, including provider fallback; reset review/verify worktrees on exceptional exits. `src/util/proc.ts` kills remaining process-group descendants before returning so they cannot outlive scratch cleanup.
- `src/pipeline/{schemas,verification,prompts,engine}.ts`, `src/core/types.ts`, `src/router/router.ts`, and migration 11: explicit blocked criteria, deterministic normalization backed by failed shell execution evidence, complete required-criterion coverage, one persisted environment retry per implemented round, model-wide exclusion across effort variants, and no implementation rounds for blocked-only results. Both attempts and their model identities survive in state and separate artifacts. Mixed failures request fixes only for actionable criteria. Holdout evidence remains redacted until delivery.
- `src/pipeline/report.ts`, `ui/components/ArtifactsPanel.tsx`, and `ui/styles.css`: blocked acceptance and holdout outcomes display as 🚧 blocked with evidence. Reports include the environment terminal reason; run details already display the persisted run error.
- `scripts/smoke.ts`: native verify probes execute a fixed command that creates/reads/deletes a scratch file and attempts a denied worktree write. A successful paired tool result and unchanged worktree are required before cleanup. Prose claims, echoed commands, partial evidence, failed temp operations and successful worktree writes fail the check.
- Tests cover lifecycle/error/fallback/concurrency paths, injected native environments and permissions, normalization, retry routing and persistence, mixed feedback, report/UI rendering, probe rejection paths and descendant cleanup.

## CLI configuration inspected

Installed versions: **codex-cli 0.157.1**, **Claude Code 2.1.281**. Version output, `codex --help`, and `codex exec --help` are retained in [verification-cli.txt](verification-cli.txt).

Codex reading calls use `--ignore-user-config --strict-config --ignore-rules` and this named filesystem profile (the actual scratch path is canonical and unique):

```toml
default_permissions = "limitless-reader"
[permissions.limitless-reader.filesystem]
"/" = "read"
"<scratch canonical path>" = "write"
[permissions.limitless-reader.network]
enabled = false
```

They do not combine this with `-s workspace-write`, `sandbox_workspace_write`, or `--add-dir`. Alternate MCP/app/plugin/code-mode paths are disabled. No-tools calls retain their existing read-only mode and disabled tools.

The [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents `default_permissions` and named filesystem grants, and prohibits combining them with the legacy sandbox settings. `codex exec` on 0.157.1 accepts this profile under `--strict-config`; the live `codex verify` smoke row shows scratch writes succeed and worktree writes are denied.

Claude reading calls use explicit sandbox settings: enabled, failIfUnavailable, allowUnsandboxedCommands=false, no excluded commands, scratch allowWrite, canonical worktree denyWrite, no project/local settings or hooks, and no MCP discovery. These settings follow the [official Claude Bash sandbox documentation](https://code.claude.com/docs/en/sandboxing). The native child receives the same scratch environment as Codex.

Claude Code's sandbox overrides TMPDIR for Bash commands with `$CLAUDE_CODE_TMPDIR/claude-<uid>`, or with a shared `/tmp/claude-<uid>` if that is unset or too long for AF_UNIX sockets. The earlier `claude verify` failure came from this: TMPDIR in Bash differed from TMP/TEMP. Scratch is therefore allocated as `<short base>/lr-XXXXXX/claude-<uid>` (with `/tmp` preferred for length), and `CLAUDE_CODE_TMPDIR` points at its private parent. TMPDIR, TMP and TEMP are then identical in the Claude process and its sandboxed commands. Cleanup removes the parent. A misnamed scratch is rejected, so this cannot silently diverge.

## Validation

- `bun run check`: **PASS**: Biome, `tsc --noEmit`, and **392 tests passed, 0 failed**. [Full output](verification-check.txt).
- `bun run build:ui`: **PASS**. [Full output](verification-build-ui.txt).
- `bun run smoke`: **PASS**, exit 0, all 13 rows pass and none are skipped. [Full output](verification-smoke.txt).

```text
$ bun scripts/smoke.ts
Check                  Status  Time     Detail
---------------------  ------  -------  ------
claude structured      PASS     2620ms  
claude noTools         PASS     3671ms  
claude edit            PASS     4843ms  
claude quota           PASS     1728ms  
claude verify          PASS     5986ms  claude-haiku-4-5: observed temp create/read/delete and denied worktree write
codex structured       PASS     7385ms  model gpt-5.6-sol (gpt-6-luna, gpt-6-sol unsupported)
codex noTools          PASS     7981ms  
codex edit             PASS    16060ms  
codex quota            PASS     4790ms  
codex verify           PASS     8472ms  gpt-5.6-sol: observed temp create/read/delete and denied worktree write
mtplx structured       PASS    12738ms  
twilight structured    PASS     3892ms  
openrouter structured  PASS     7164ms
```

## Assumptions and remaining work

The implementation requirements are the active task; the supplied specification-only exclusions were treated as planning-stage text. No push, PR, commit, merge, or history rewrite was performed by this worker.

Permission-error derivation is conservative: a criterion must describe an attempted environmental failure and correlate with a failed command result. Explicit blocked results require nonempty evidence. Assertion failures, expected denials, quoted/source diagnostics and omitted criteria do not become successful checks.

A restart after reserving an environment retry cannot grant another retry, including if the process stops during that retry. Reading roles other than review/verify also receive scratch when tool-enabled so the strengthened native contract does not break spec/plan/evaluation callers. No-tools holdout authoring retains its isolation.

Normalization only reclassifies `unmet`/`unclear` criteria as blocked. A `met` criterion whose evidence mentions an EPERM it later worked around stays met.
