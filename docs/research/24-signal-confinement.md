# Signal confinement (#293)

Research began 2026-10-04; revised 2026-10-07 (UTC, checked with `date -u`).
The real-host evidence below was reported in PR #368's review, rather than
re-run by this sandboxed factory worker. Host: unsandboxed macOS 27.0.1
(26A434), codex-cli 0.160.0, Claude CLI 2.1.290.

## Evidence and choice

On the reported host, `bun scripts/probe-signal-targets.ts` returned exit 0 for
all four non-nested targets (`self`, `pgrp`, `children`, `same-sandbox`) and
exit 71 for every nested case (`sandbox-exec: sandbox_apply: Operation not
permitted`). A nested sandbox_apply succeeds only when the outer profile is
exactly `(version 1)(allow default)`. Adding `(deny file-write*)`, `(deny signal)`
or an allow-signal rule makes the inner application fail with exit 71.
The earlier eight exit-71 results came from the factory worker's enclosing
sandbox; they did not establish host support or effective signal enforcement.

| Target | Scope | Decision |
| --- | --- | --- |
| self | Current process | Allow for runtime self-signaling. |
| pgrp | Sender's process group | Do not grant: group membership is not an isolation boundary. |
| children | Sender's children | Do not rely on it for descendants or sibling tools. |
| same-sandbox | Processes inheriting one sandbox instance | Use as the invocation boundary, with effective canaries. |

The outer policy denies signals except self and same-sandbox. Every launch
proves denial to an outside test-owned PID and an independently confined sibling
with identical profile bytes, and termination of an owned descendant. Missing,
ineffective, interrupted or inconclusive probes fail closed. On the reported
host the non-nested signal canary passes for Claude editors and gates. The
offline substitute smoke also exercised their OS enforcement: a marker-name
signal killed the owned marker while outside and sibling markers survived;
a direct signal to the outside PID was denied with EPERM.

`runProcess` starts a detached process group and cleans that group on timeout
or cancellation. Keep that supervision. A process group/session alone cannot
prevent signaling another same-user PID; a kernel policy provides that boundary.

## CLI composition

Claude editors and gates run inside the factory's outer Seatbelt profile.
#233 disables Claude editors' internal Bash sandbox to avoid nesting, while
retaining the mandatory outer write boundary covering native tools as well.
Editors keep session persistence disabled and cannot resume. Claude readers
retain their CLI sandbox and session behavior. Codex in every mode retains its
CLI sandbox, named filesystem profiles and existing capability probes. Neither
Codex nor Claude readers receives the outer wrapper or its Seatbelt preflight.
Combining those CLI sandboxes into one outer profile is follow-up #369.

Codex 0.160.0 already embeds a deny-default base policy with
`(allow signal (target same-sandbox))`. The review reported a live offline check
with no model call, using the equivalent of:

```sh
codex sandbox \
  -c 'default_permissions="limitless-editor"' \
  -c 'permissions={limitless-editor={filesystem={"/"="read","<dir>"="write"},network={enabled=true}}}' \
  -- /bin/sh -c '<pkill test-owned marker; kill -TERM test-owned outside-pid>'
```

The marker-name attempt returned `pkill: Cannot get process list`; the direct
kill returned EPERM and the outside marker survived. Start that outside marker
detached in its own process group: `codex sandbox` signals its own process group
on exit. All targets and cleanup handles in such a check must be test-owned.

Claude CLI 2.1.290's reader sandbox embeds the same
`(allow signal (target same-sandbox))` under deny default, according to the
review's binary profile strings. This reader policy was not live-tested.

The four 2026-10-03 incidents were all Claude calls. The 09:56:02 and 11:47:16
EDT calls that killed the deploy gate and land-pr check came from claude/opus
implement (edit) invocations, which this PR confines. The 11:16:58 and 11:21:26
calls came from a claude/sonnet verify reader inside the CLI's own sandbox.
The incident evidence therefore does not establish a Codex signal escape, nor
prove the installed reader sandbox's effective isolation at that earlier time.

Claude arguments retain deny patterns for pkill, killall and kill -9 -1 as
bypassable backstops. Codex rules use discovered `.rules` files, disabled by this
adapter's `--ignore-rules`; no verified invocation-local equivalent preserving
that setting was found. Do not modify machine-wide requirements or enable
project rules. Every factory role receives the shared-machine process rule,
and implement/repair prompts retain their existing guidance.

## Reproduction and validation

`bun test test/signal-confinement.test.ts` exercises Claude edit and gate
adapters with offline substitutes. All processes are test-owned, use random
markers, readiness handshakes, bounded waits and retained handles/PIDs for
cleanup. Where Seatbelt is available outside a confined gate, startup refusal
fails the smoke: successful startup and owned-marker termination are required.
Gate timeout/cancel tests likewise require enforcement and owned-descendant
cleanup. Unsupported or already-confined environments can verify explicit
refusal before payload startup, without claiming OS enforcement.

The non-nested canary verifies the policy on each production launch. Probe
errors propagate as ConfinementError; ordinary agent output mentioning sandbox
initialization is not evidence that the enclosing boundary failed. Gates retain
the existing exact startup diagnostic `sandbox_apply: Operation not permitted`
as a blocking operational error even when it appears before output truncation.

Fixtures cover executable shell/JavaScript inputs, sanitized captured CLI
shapes, denied and completion-only calls, duplicate records, comments, heredocs,
assistant prose, file edits, tool output and printed/searched literals. Direct
unit cases cover adjacent shell quoting, common wrappers and non-signaling
`kill -0` polls. Private invocations keep a fixed warning message with invocation
linkage. Each flagged call remains an event and contributes to the report count;
the unshipped additive trigger produces one feed item per invocation, independent
of redacted tool ids.

No paid model call or authenticated live smoke was performed by this worker.
The Codex check and real-host outer-policy results above are reported review
evidence; reader policy evidence comes only from binary strings.
