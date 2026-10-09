# Issue #425 validation

The historical target failure has **not been reproduced**. The existing disappearing-lock
candidate remains unchanged; these results establish its focused behavior, not the cause of
that historical failure. The diagnosis requirement remains unresolved.

## Pre-fix reproduction

Restored `src/git/command.ts` from `9fc2db51966b4c6d99f32181c5a8e46a5175e2fc`, retaining
its original `lstatSync` and safety assertions. Temporary assertion details identified the
path and link count if an unsafe entry was observed. The pipeline fixture captured failed
runs' stage results, events and state before disposal.

- Ten complete invocations of `bun test --parallel=4 test/pipeline-verification.test.ts
  test/pipeline-holdout-lifecycle.test.ts test/pipeline-panel.test.ts test/pipeline-gates.test.ts`
  passed: 580 tests, including ten target executions. Invocation 11 was deliberately interrupted
  through its own process handle and excluded; its exit status was 130.
- After six clean invocations, synthetic load used four owned processes: two for 120 seconds
  and two for 180 seconds, with at most four concurrent. All exited normally. The combined
  CPU-worker lifetime budgets were ten minutes. The sandbox
  denied lowering priority. No further synthetic load was started.
- Another 100 target-only invocations (`bun test --parallel=4 test/pipeline-verification.test.ts
  -t '^environment verification retry: passes$'`) passed alongside a repeating
  `bun test --parallel=3` of the same three other files. These are additional reproduction
  attempts, not substitutes for the requested 30 full-file invocations.
- No pre-fix target failure, failing stage or corresponding error event was observed.

## Candidate validation

With the candidate removed, `bun test test/worktree-git-locks.test.ts` failed with `ENOENT`
while inspecting a deliberately released `HEAD.lock`. With the existing candidate restored,
`bun test test/worktree-git-locks.test.ts test/git-integrity.test.ts -t 'a lock file|trusted git
refuses private admin attack|recorded directories override'` passed all 11 selected tests.
Config files, symlinks, hard links and invalid/missing trusted paths still reject.

The validation loop now requires a zero invocation exit status and the exact target pass line.
Simulated runner initialization failure, successful exit without the target, and a target pass
line followed by a nonzero exit each returned nonzero and counted zero passes. Complete
output is retained. `PIPELINE_DIAGNOSTICS` enables credential-redacted snapshots of non-successful
runs (including unfinished ones) before fixture cleanup, in ignored `*.json.log` files.

Thirty full-file invocations, full pipeline results, lint and typecheck: pending completion.

The filename assumption follows the specification: the target is in
`test/pipeline-verification.test.ts`. Deadlines, test retries and production code are unchanged
from the existing candidate. Raw outputs remain under `.scratch-mv01/` as ignored log files.
