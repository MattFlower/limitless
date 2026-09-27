# Verification reliability implementation report

Implemented on 2026-09-27 (date checked with `date -u`). Native sandbox validation remains blocked in this worker; AC-7 is **not satisfied** by this run.

## Changes

- `src/harness/{scratch,types,claude,codex}.ts`: a typed scratch root, canonical paths outside the checkout, matching child-only TMPDIR/TMP/TEMP, cleanup in finally, native sandbox arguments, and injected-process testing. Reading calls reject additional writable directories. Existing secret filtering and backend environment settings remain in place.
- `src/pipeline/context.ts` and `src/evals/runner.ts`: allocate scratch per tool-enabled reading attempt, including provider fallback; reset review/verify worktrees on exceptional exits. `src/util/proc.ts` kills remaining process-group descendants before returning so they cannot outlive scratch cleanup.
- `src/pipeline/{schemas,verification,prompts,engine}.ts`, `src/core/types.ts`, `src/router/router.ts`, and migration 11: explicit blocked criteria, deterministic normalization backed by failed shell execution evidence, complete required-criterion coverage, one persisted environment retry per implemented round, model-wide exclusion across effort variants, and no implementation rounds for blocked-only results. Both attempts and their model identities survive in state and separate artifacts. Mixed failures request fixes only for actionable criteria. Holdout evidence remains redacted until delivery.
- `src/pipeline/report.ts`, `ui/components/ArtifactsPanel.tsx`, and `ui/styles.css`: blocked acceptance and holdout outcomes display as 🚧 blocked with evidence. Reports include the environment terminal reason; run details already display the persisted run error.
- `scripts/smoke.ts`: native verify probes execute a fixed command that creates/reads/deletes a scratch file and attempts a denied worktree write. A successful paired tool result and unchanged worktree are required before cleanup. Prose claims, echoed commands, partial evidence, failed temp operations and successful worktree writes fail the check.
- Tests cover lifecycle/error/fallback/concurrency paths, injected native environments and permissions, normalization, retry routing and persistence, mixed feedback, report/UI rendering, probe rejection paths and descendant cleanup.

## CLI configuration inspected

Installed versions: **codex-cli 0.154.0**, **Claude Code 2.1.281**. Version output, `codex --help`, and `codex exec --help` are retained in [verification-cli.txt](verification-cli.txt).

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

The [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents `default_permissions` and named filesystem grants, and prohibits combining them with the legacy sandbox settings. A direct `codex sandbox -P limitless-reader` configuration probe reached sandbox application but failed with `sandbox_apply: Operation not permitted`. Adding `--strict-config` to that *sandbox subcommand* is explicitly unsupported; production uses it on `exec`, where the installed help lists it. Both diagnostics are retained in [codex-profile-probe.txt](codex-profile-probe.txt). This is not proof of effective native isolation.

Claude reading calls use explicit sandbox settings: enabled, failIfUnavailable, allowUnsandboxedCommands=false, no excluded commands, scratch allowWrite, canonical worktree denyWrite, no project/local settings or hooks, and no MCP discovery. These settings follow the [official Claude Bash sandbox documentation](https://code.claude.com/docs/en/sandboxing). The native child receives the same scratch environment as Codex.

## Validation

- `bun install --frozen-lockfile`: **PASS**, no dependency changes. [Full output](verification-install.txt).
- `bun run check`: **PASS** — Biome, `tsc --noEmit`, and **391 tests passed, 0 failed**, including one snapshot. Existing lint warnings remain (an optional-chain suggestion, two CSS specificity warnings, and the Biome configuration deprecation notice). [Full output](verification-check.txt).
- `bun run build:ui`: **PASS**, built three files. [Full output](verification-build-ui.txt).
- `git diff --check`: **PASS**.
- `bun run smoke`: **FAIL**, exit 1, no skipped rows. Both native verify rows fail; the native sandbox contract is **not validated**. [Full output](verification-smoke.txt).

The worker cannot start the nested Claude sandbox (`sandbox-exec: sandbox_apply: Operation not permitted`), and Codex cannot initialize its in-process app-server client (`Operation not permitted`). A separate Claude trace shows the command failure followed by an incorrect agent success claim; the probe correctly rejects it. [Diagnostic trace](verification-native-probe.txt). The implementation does not weaken isolation to work around these restrictions.

```text
$ bun scripts/smoke.ts
Check                  Status  Time     Detail
---------------------  ------  -------  ------
claude structured      PASS     2312ms  
claude noTools         PASS     4053ms  
claude edit            PASS     5898ms  
claude quota           PASS     1355ms  
claude verify          FAIL     7499ms  missing successful probe command evidence (temp operations and denied worktree write): Exit code 71 sandbox-exec: sandbox_apply: Operation not permitted
codex structured       FAIL      140ms  WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1) Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)
codex noTools          FAIL      125ms  WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1) Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)
codex edit             FAIL      127ms  WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1) Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)
codex quota            FAIL      141ms  WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1) Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)
codex verify           FAIL      151ms  WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1) Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)
mtplx structured       PASS     7744ms  
twilight structured    PASS    14770ms  
openrouter structured  PASS     5514ms  
error: script "smoke" exited with code 1
```

## Assumptions and remaining work

The implementation requirements are the active task; the supplied specification-only exclusions were treated as planning-stage text. No push, PR, commit, merge, or history rewrite was performed by this worker.

Permission-error derivation is conservative: a criterion must describe an attempted environmental failure and correlate with a failed command result. Explicit blocked results require nonempty evidence. Assertion failures, expected denials, quoted/source diagnostics and omitted criteria do not become successful checks.

A restart after reserving an environment retry cannot grant another retry, including if the process stops during that retry. Reading roles other than review/verify also receive scratch when tool-enabled so the strengthened native contract does not break spec/plan/evaluation callers. No-tools holdout authoring retains its isolation.

**Remaining:** run `bun run smoke` on the factory host where both native CLIs can initialize their sandboxes. Both native verify rows must report PASS before claiming AC-7 or the complete sandbox contract is validated. Current evidence is insufficient to make that claim.
