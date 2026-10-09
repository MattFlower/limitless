# Issue #425: reproduction remains unresolved

Recorded 2026-10-09 UTC, with Bun 1.4.2 and Git 2.54.0. The target is
`environment verification retry: passes` in `test/pipeline-verification.test.ts`.
The reported `Expected: succeeded / Received: failed` assertion was not reproduced.
No factory behavior fix was selected without the requested failing-stage evidence.

The four-file selection was verification, audit, review, and routing, using
`bun test --parallel=4` and this test-name filter:

```text
environment verification retry: passes$|factory gates use injected confinement|happy path: triage|schema-invalid structured output
```

The factory worker inherited `GIT_OPTIONAL_LOCKS=0`. Initial repetitions therefore
masked optional index refreshes. With `GIT_OPTIONAL_LOCKS=1`, Git traces showed
plain `status` calls writing the index. That demonstrates a possible mechanism,
but does not establish the cause of the reported failure.

The corrected 30-iteration batch had 29 target passes and one 30-second setup-hook
timeout. Its Git trace showed one seed's `git init` exiting successfully in
15 ms, with no subsequent `git add`; the other three seeds completed. No factory
run existed for the timed-out target. The unresolved setup/subprocess promise is
a different symptom from the reported failed stage. Original deadlines and retry
behavior were retained throughout. A final 30-iteration batch using the factory's
provided private scratch directory passed all 120 selected tests (30 target
passes), with optional locks enabled and no synthetic load. Each iteration took
1.7–2.0 seconds. Earlier batches used a temporary directory inside the checkout;
the setup-timeout mechanism and the effect of scratch location remain unproven.

The complete `GIT_OPTIONAL_LOCKS=1 bun test --parallel=4 test/pipeline-*.test.ts`
run completed with 352 passes, 23 failures, and one reported error across 25 files
(765 seconds). The target passed in 6.8 seconds; no administration-safety error
was observed. Twenty-one failures were initialization-hook timeouts in delivery
restart and merge-integrity tests. The other two were a shadow test's 30-second
test deadline and `verify-change: persistent` exceeding its 20-second run wait.
These timeout causes were not established as factory-code defects.

The earlier traced diagnostic run also exposed delivery checkpoint marker waits
expiring at 10 seconds and panel run waits expiring at 20 seconds while work was
still active. Its baseline-concurrency assertion saw `start,end,start` rather
than three starts: that test relies on preparations finishing within a one-second
sleep, which does not establish concurrency under contention. It failed again
alone in 9.6 seconds, so this is not evidence of a parallel-only flake.

The three selected delivery checkpoint cases passed alone (24 seconds). Eleven
existing Git administration/hook/provenance safety cases passed (2.4 seconds),
including all nine private-administration attacks. `verify-change: persistent`
also passed alone (16.3 seconds), compared with its 20-second wait expiry in
the parallel run.

Final `bun run lint`, `bunx tsc --noEmit`, and changed-file Biome checks passed.
Three invalid-metadata cases passed with diagnostics enabled; their dumps retained
the failed prepare stage and store events before cleanup. The degenerate-review
case also passed. No deadlines, test retries, or administration checks changed.
The previous scratch repositories/databases, runner scripts, and production debug
logger were removed.

Raw output and Git traces are retained as ignored `repro-425-*.log` and
`trace-425-*.log` files in the diagnostic checkout. `LIMITLESS_DIAGNOSTICS_425=1`
retains credential-redacted run records, stage results, and events in ignored
`diagnostic-425-<run-id>.log` files. Hook failures before run creation have only
raw output/traces. Expected failed/cancelled test runs also produce dumps.

Synthetic load initially used four owned processes, each capped at 115 seconds.
Two additional processes were mistakenly started after those stopped, then
stopped promptly through their owned handle (65-second cap). This exceeded the
literal four-process count; maximum simultaneous load processes remained four.
All owned load processes stopped; no further synthetic load was added.

AC-1 and the post-fix, 30-consecutive-pass requirement remain unmet: no confirmed
factory-code cause, corresponding fix, or regression test is available. This
report must not be treated as resolving #425.
