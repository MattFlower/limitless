# Agent test command slotting (#474)

Probe attempted 2026-10-10 (UTC, from `date -u`).

| Agent sandbox | Loopback lease POST | Scratch Unix socket | Own / other capability read | Result in this checkout |
| --- | --- | --- | --- | --- |
| Codex editor profile | Unobserved | Unobserved | Unobserved | Skipped: nested Seatbelt unavailable |
| Claude reader sandbox runtime | Unobserved | Unobserved | Unobserved | Skipped: nested Seatbelt unavailable |
| Claude editor outer Seatbelt | Unobserved | Unobserved | Unobserved | Skipped: nested Seatbelt unavailable |

`bun test test/agent-test-probe.test.ts` reported three skips, zero failures. The startup
probe could not apply nested Seatbelt in this factory sandbox. No sandbox policy was
changed to obtain a result. The portable wrapper integration test independently verified
scratch-socket coordination with real wrappers and a local fake daemon.

On an unconfined macOS host the probes launch commands directly, without paid model calls,
through the production Codex editor profile, the Claude reader filesystem settings using
Anthropic's sandbox runtime, and the production outer Seatbelt profile. They print both
observations and check the expected policies: editors allow both transports, while the
reader runtime allows neither by default. These expectations are not measured results
from this checkout. The standalone reader runtime is pinned in the lockfile; it is not
an end-to-end Claude CLI tool invocation.

Transport selection attempts loopback HTTP first, then the invocation's scratch socket
on transport failure. Rejected leases remain failures. If confinement denies both, the
wrapper warns and runs the command under the existing gate-slot fail-open semantics.
Only a daemon-issued invocation capability can associate waits with a run.

The live database and historical command logs are unavailable to this worker; the database
is explicitly denied by the permission profile. The lane decision therefore uses the
request's supplied three-day aggregate: 486 agent commands, approximately 4.9 hours,
medians of 2–10 seconds, and full-suite tails of 10–21 minutes. Those observations support
a separate small lane rather than queue priority: priority cannot preempt a running suite.
Full suites share `gateSlots`; targeted file/path or name-filter runs use a fixed limit of
two. The worker did not independently recompute the aggregate or measure a new distribution.

Factory-owned wrapper scripts and their bundled client/config live in one per-invocation
directory under a private factory root in the system temporary directory, outside the writable
roots. Its `config.json` holds the bearer capability for the invocation's leases, so every agent
and gate profile denies reads under that root and grants only the invocation's own directory:
the Seatbelt profile denies `file-read-data` (contents and listings), Codex profiles mark the
root `none` and the own directory `read`, and Claude denies native `Read` there and adds the root
to the reader sandbox's `denyRead` with the own directory in `allowRead`. The capability is
never placed in the environment; nested commands are recognized by a separate nonce. The
probe tests also check, per sandbox, that the own capability is readable and another
invocation's is not. Private holdout authors have stronger read confinement
that denies that location, so receive no wrapper. Implement, verify and review invocations
receive it. Gate/baseline/land/deploy processes retain their existing command environments.
