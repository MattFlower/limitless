# Signal confinement (#293)

Research recorded 2026-10-04 (UTC, checked with `date -u`) before enforcement changes.
Host: macOS 27.0.1 / 26A434, Bun 1.4.2, codex-cli 0.159.2,
Claude Code 2.1.288. This worker itself is sandboxed.

## Evidence and choice

Run `bun scripts/probe-signal-targets.ts` offline. It starts only `true` under each
profile, then attempts a second sandbox. On this host all eight cases exit 71:
`sandbox-exec: sandbox_apply: Operation not permitted`. No payload started. Even
`codex sandbox macos --help` reaches that error here. These are **nesting-denied**
results, not evidence that a signal filter worked. No authenticated CLI was run.

Seatbelt's target selectors have different purposes:

| Target | Intended scope | Decision |
| --- | --- | --- |
| self | Current process | Allow (self-signaling is needed by runtimes). |
| pgrp | Members of the sender's process group | Do not grant: group membership is not an isolation boundary. |
| children | Sender's children | Do not rely on it for descendants that fork/exec/reparent or sibling tools. |
| same-sandbox | Processes inheriting the same sandbox instance | Candidate run boundary; verify independent instances are separated, even with identical profile bytes. |

The installed `/System/Library/Sandbox/Profiles/bsd.sb` uses `target self`;
`cryptex-session-base.sb` uses `target children`. Acceptance of all four spellings
before sandbox_apply is observed; their runtime behavior here is **unverified**.
The chosen outer policy denies `signal` except self and same-sandbox. Forked tools
and interpreters must inherit it. Every launch must prove actual denial to an
outside owned process and an independently confined sibling, and termination of
an owned descendant. A missing, ineffective or inconclusive probe fails closed.
This is an invocation boundary, which is stricter than a run boundary.

`runProcess` already starts a detached process group and cleans that group on
cancellation/timeouts. Keep that supervision. `setsid`/process groups alone do
not stop `kill(other_same_user_pid, SIGTERM)`; only the kernel policy can do so.

## CLI composition

[Claude's sandbox documentation](https://code.claude.com/docs/en/sandboxing) says
macOS uses Seatbelt and distinguishes Bash sandboxing from native tools. #233
already disables the internal sandbox for editors and wraps the entire CLI;
retain that configuration and its write roots. Readers keep their internal
read/write restrictions, including denyRead and confineReads. Do not disable them
to make nesting work. Add an outer boundary for **every tool-enabled reader**,
including readers without confineReads, and require a nested sandbox preflight.
Codex retains its existing named filesystem profiles and capability probes, plus
the outer boundary and nesting preflight. The nesting preflight repeats the
signal canaries with a maximally permissive inner profile on the attacking process:
even that profile must not widen the outer signal policy. Starting a nested `echo`
alone would not establish composition. Actual CLI startup failures remain failures,
with no unsandboxed retry. On this host both
reader composition and Codex composition are refused before agent execution.
No claim of effective CLI signal isolation is made from that refusal.

Claude edit arguments add deny patterns for pkill, killall, and kill -9 -1.
These are bypassable convenience rules; interpreters remain inside Seatbelt.
[Codex rules](https://developers.openai.com/codex/rules) support forbidden prefixes
in discovered `.rules` files, which this adapter deliberately disables with
`--ignore-rules`. The [configuration reference](https://developers.openai.com/codex/config-reference)
places `rules.prefix_rules` in administrator requirements, not ordinary invocation
config. No verified invocation-local rule mechanism preserving `--ignore-rules`
was found for the installed CLI. Do not re-enable user/project rules or modify
machine-wide requirements. The prompt and kernel boundary are its backstops.

## Reproduction and release validation

`bun test test/signal-confinement.test.ts` exercises production adapters with
local substitutes and gate commands; `bun scripts/probe-signal-targets.ts` records
platform support. All processes are test-owned, use random markers, readiness
handshakes, bounded waits, and retained handles/PIDs for cleanup. Unsupported or
nested-denied checks must report refusal, never a successful OS isolation claim.
Never run a broadcast signal such as `kill -9 -1` on this machine.

Optional authenticated validation, separately for Claude and Codex: on an
unrestricted macOS host, use the same fixture/markers as the offline test and
replace only the substitute executable with the installed harness. Keep the
production adapter, scratch, profile and probes. Ask the agent to run the fixture's
marker attempt and direct-PID attempt, then start and terminate its own marked
child. Observe outside/sibling liveness and owned-child termination from the
supervisor. Use a 60-second invocation timeout and the fixture's handle cleanup.
If a deny rule rejects pkill, record that as a backstop result and use the fixture's
direct-PID interpreter case for kernel evidence. Do not weaken permissions to
get a successful run. Record CLI/OS versions and distinguish refused startup,
denied tool call, and observed effective confinement. This paid check is optional
and was not performed by the worker.

## Worker acceptance notes

For the pre-existing integration tests inside a restricted worker, use
`LIMITLESS_CONFINED=1 bun run check`, the same marker production gates already set.
That marker skips existing tests which require an unrestricted host; the new
signal smoke does **not** skip. It calls the real backend and checks refusal before
its substitute payload can start. Portable lifecycle tests inject the existing
recording backend so their descendant cleanup assertions still execute.

Expected refusal output from a passing smoke deliberately omits the raw
`sandbox_apply` diagnostic: the enclosing gate must distinguish an expected test
outcome from a real startup failure. The standalone target probe above retains
that diagnostic for research. A gate integration test runs the smoke as a child
and checks that it remains a successful gate. Actual startup diagnostics remain
blocking, including diagnostics followed by enough output to truncate the tail.

Warning fixtures cover executable shell and JavaScript inputs, denied and
completion-only calls, duplicate records, comments, heredocs, assistant prose,
file edits, tool output, and printed/searched literals. Private invocations retain
only an opaque tool-call identifier and a fixed warning message. Warnings are
persisted with invocation linkage; the additive feed trigger deduplicates by
invocation/tool id, and reports contain a command-free warning count. Implement
and repair already share `implementPrompt`; both retain the shared-machine rule.

The production delta stays below 250 added plus deleted lines, including the new detector
and additive SQL migration, excluding this document, tests, fixtures and probes.
Count tracked changes with `git diff --numstat HEAD -- src ui`; before staging,
also count lines in new files from `git ls-files --others --exclude-standard src ui`.
No authenticated live-model smoke was run. Effective OS enforcement and CLI
compatibility still need the optional unrestricted-host validation described above.
