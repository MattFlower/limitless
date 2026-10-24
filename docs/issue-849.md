# Issue #849 investigation

Reproduction command (Bun 1.4.3):
```sh
bun test --parallel=4 test/agent-full-suite-gate.test.ts test/pipeline-slotted.test.ts test/pipeline-gates.test.ts test/pipeline-baseline-cache.test.ts
```
Temporarily removed the previous attempt's cancellation and finish-request filter, adding diagnostics for handler entries, worktrees, execution counts, gate-record ownership, stages and requests. The third diagnostic invocation reproduced `implement snapshot and round gate reuse: run`: 113 passed, 1 failed; the case took 2208.37 ms. Exact failing assertion: `expect(existsSync(snapshotDir)).toBe(false)`, expected `false`, received `true`.

Observed sequence, naming the primary run A and secondary runs B–E: A's wrapper correctly rejected B's record and recorded its own fresh execution (expected count 2, actual 2). A then reassigned that record to C, and its gates stage requested both lint and test. Meanwhile B and D entered the shared implement handler, overwriting `worktree`, starting additional wrappers, growing the execution count to 4 and deleting/reassigning gate rows. At the failed cleanup assertion, A had succeeded, D was still implementing, and the latest start request belonged to D. That request had overwritten the shared `snapshotDir` with D's still-active snapshot. This is fixture interference, not cross-run gate reuse.

The fix cancels each identity-only foreign run synchronously before yielding to the scheduler, and scopes finish-request assertions to A. Foreign run identities and all wrapper/gates-stage rejection assertions remain; `same` and `repeat` still exercise valid reuse. Production behavior, timeouts and retry policy are unchanged. The test comment now names the observed shared-state race.

Raw reproduction logs and the temporary diagnostic source are in `$TMPDIR/issue-849.menO12/` (`prefix-diagnostic-3.log`, `prefix-diagnostic.ts`); diagnostics are absent from the final test.

Consecutive validation command (each invocation's output retained separately in scratch):
```sh
for iteration in $(seq 1 50); do bun test --parallel=4 test/agent-full-suite-gate.test.ts test/pipeline-slotted.test.ts test/pipeline-gates.test.ts test/pipeline-baseline-cache.test.ts || exit 1; done
```
Validation is in progress; final counts and checks will be recorded after completion.
