# Test runtime and coverage review

## Second pass (#282)

Measured 2026-10-03 on Linux x86_64 (kernel 7.2) with an AMD Ryzen 9 5950X (16 cores, 32 threads), 125 GiB of memory, `/tmp` on tmpfs, and git 2.55.0. The machine was otherwise idle. Before and after use the same base commit (`019c3a0`), without and with this change. The headline numbers use Bun 1.4.0, the version CI pins. On Bun 1.4.2 the suite is about 3% faster in absolute terms, with the same relative change.

| Bun 1.4.0 | Before | After | Change |
| --- | ---: | ---: | ---: |
| Whole-suite wall time | 242.5 s | 205.6 s | −15.2% |
| Whole-suite CPU time (user + system, with children) | 257.6 s | 247.0 s | −4.1% |
| Per-file CPU time, summed | 269.0 s | 260.2 s | −3.3% |
| Per-file wall time spent waiting, summed | 37.8 s | 14.4 s | −61.9% |
| Git processes started | 129,842 | 125,221 | −3.6% |
| Tests (files) | 1,769 (89) | 1,769 (89) |  |

On Bun 1.4.2 (three runs before, one after): wall 235.6 s → 199.7 s (−15.3%), CPU 246.6 s → 238.9 s (−3.1%).

Every run, before and after, had one failure: "the real Codex sandbox enforces the confined reader profile". It fails identically on unmodified `main` on this machine, because the locally installed codex 0.160.0 rejects the reader profile. It skips itself where `codex` is not installed, as on CI.

Wall time falls by about 15% because the suite no longer waits on sleeps that test nothing. CPU time falls by only 3–4%. The 30% CPU target cannot be reached by changing tests alone: half of the suite's process starts happen inside production code (see [Why CPU time does not fall 30%](#why-cpu-time-does-not-fall-30)). No test was removed or skipped, and no assertion was weakened. Changes 4 and 5 change how two tests prove their behavior.

### Method

- **Whole suite.** Each run was `bun test --reporter=junit --reporter-outfile=…` under the shell's `time`:
  - *Wall* is elapsed time.
  - *CPU* is user plus system time for Bun and every child process it waited for (git, `sh`, fake CLIs).
  - All runs used the same idle machine, back to back, and the tables report the median run.
  - Per-file wall times are JUnit `testsuite` durations.
- **Per file.** Each test file ran on its own (`bun test test/<file>`), six at a time, under the same `time`. This gives each file's CPU time including its children. The per-file sum exceeds whole-suite CPU by 11–13 s because each file pays Bun's startup once. *Waiting* is how far each file's wall time exceeds its CPU time, summed over files.
- **Git starts.** Each file ran alone with a logging `git` first on `PATH`. The count covers the commands the suite starts. It excludes processes git starts for itself, such as `upload-pack`, and does not depend on the Bun version.

### Where the time goes

**Four files use 81% of the CPU.** Before this change, run alone on Bun 1.4.0 they took:
- `pipeline.test.ts`: 133 s;
- `failure-injection.test.ts`: 37 s;
- `evals-implement-runner.test.ts`: 25 s;
- `git-integrity.test.ts`: 24 s.

In `pipeline.test.ts` the cost is spread out: about 250 tests take 0.2–1 s each, and almost all of that is one complete factory run per test. The largest parameterized group, `verify-change` with 17 rows, costs 7.7 s. No single matrix dominates.

**Child processes use most of the CPU, not Bun.** On Bun 1.4.2, Bun's own process accounts for about 22% of the CPU time in `failure-injection.test.ts` (8.0 of 35.6 s), `evals-implement-runner.test.ts` (5.6 of 24.2 s) and `git-integrity.test.ts` (4.9 of 22.7 s). The rest is the git and shell processes it starts. System time is higher than user time for the whole suite (156 s against 101 s on Bun 1.4.0), as expected when most of the work is starting processes.

**Most of those processes are git.** One suite run starts 129,842 git processes (counted on Bun 1.4.2):
- `pipeline.test.ts` starts 82,530 of them, about 280 per test.
- A single happy-path factory run starts about 180.

| Git command | Starts | Share |
| --- | ---: | ---: |
| `config --null --name-only --get-regexp ^hook\.` | 51,117 | 39.4% |
| `hash-object -t tree --stdin` (the empty tree) | 16,062 | 12.4% |
| `diff` | 14,356 | 11.1% |
| `rev-parse HEAD` | 6,752 | 5.2% |
| `status --porcelain` | 5,384 | 4.1% |
| everything else | 36,171 | 27.9% |

The first two rows come from `worktreeGit` in `src/git/command.ts`, the hardened wrapper for every factory git command in an agent-controlled worktree:
- **Hook lookup.** Before each command it runs the `config` lookup, so it can blank every config-defined hook that git would otherwise run.
- **Empty-tree hash.** Before each `diff` or `log` it hashes the empty tree, to use as `--attr-source`.

Together these are 51% of all git starts. Setting up fixtures (`git init`, `add` and `commit` in hooks and helpers) accounts for only about 3%.

**Sleeps and real timeouts held up 37 s of wall time.** In that time the file under test was mostly waiting, not computing. `bun test` runs files one after another in one process, so each of these files held up the whole suite while the CPU sat idle:
- `smoke.test.ts`, 22.4 s: real CLI timeouts and the 5 s kill grace period, run one scenario at a time.
- The GitHub poller harness, 6.9 s: five 1 ms timer sleeps after every simulated tick, across thousands of ticks.
- `feed-cli.test.ts`, 2.9 s: the real 1 s + 2 s retry backoff.
- `hardening.test.ts`, 1.7 s.
- `decisions.test.ts`, 1.3 s.
- `preview.test.ts`, 1.1 s.

**Sandbox probes and port binding cost almost nothing.** The only real sandbox probe, the Codex test in `scratch.test.ts`, takes about 0.08 s, and it is skipped where `codex` is not installed. HTTP tests bind port 0 and finish in under 0.5 s per file.

### What changed

1. **Repositories are seeded once per process and copied for each test.** `test/seeded.ts` builds a directory once, then copies it into each test's temporary directory with `cpSync`. `relocate` rewrites a copied bare clone's origin URL. The setup git commands saved per test:

   | Fixture | Before | After |
   | --- | ---: | ---: |
   | `evalFixture` | 10 | 0 |
   | `git-integrity.test.ts` setup | 7 | 1 (`worktree add`) |
   | `failure-injection.test.ts` setup | 5 | 0 |
   | `pipeline.test.ts` `makeRepo` | 3 | 0 |

   Seeded repositories now share commit SHAs across tests. That already happened before whenever two tests committed within the same second.

   A copied index carries stale file metadata (stat data), so git refreshes it when it next reads the index. The tests that snapshot `.git/index` to prove the source repository is untouched still pass. They are stricter now, because a stray refresh by the factory would now rewrite the index and fail them.
2. **The GitHub poller harness settles without timers.** The poller's clock is injected, so `advance()` only has to let promise chains finish. It now takes five `setImmediate` turns instead of five `Bun.sleep(1)` calls. `github-poller.test.ts` went from 7.7 s to 0.6 s and passed 900 reruns.
3. **The smoke timeout scenarios overlap.** The `timeout`, `budget`, `escaped-timeout`, `cli-timeout` and `idle-timeout` cleanup scenarios now run with `test.concurrentIf`. Each scenario has its own directory, child processes and environment, so no global state is shared. They still use real timers and still check the 5 s grace before SIGKILL. `smoke.test.ts` went from 23.9 s to 11.0 s. It also passed on four pinned CPUs while two heavy test files ran on the same CPUs.
4. **The reaping test waits on a heartbeat instead of a sleep.** Before, it waited 2.5 s for a `sleep 2; touch` job that should never get to run. Now:
   - The leftover job touches a marker every 50 ms.
   - The child exits only once that job is running.
   - After the child returns, the test removes the marker and checks it does not come back within 300 ms.

   With the process-group SIGKILL removed from `runProcess`, the new test fails. `hardening.test.ts` went from 4.4 s to 2.3 s.
5. **The feed CLI binary test retries one 5xx instead of two.** The backoff schedule (1 s, then 2 s) is already tested against `pollFeed` with an injected sleep. One real 503 is enough to prove the binary's error mapping and retry. `feed-cli.test.ts` went from 3.1 s to 1.1 s.
6. **`waitFor` in `pipeline.test.ts` wakes on run updates.** It subscribes to the store's run messages and re-checks one macrotask after each one; the 25 ms poll stays as a fallback. The macrotask matters: a run leaves `scheduler.activeRunIds` a few promise steps after its status changes, and the drain tests depend on that. Together with changes 1 and 9, `pipeline.test.ts` went from 111.3 s to 103.8 s.
7. **Correctness fix: a cross-file leak.** `evalFixture` now copies the models it is given.
   - `evals-reading-runner.test.ts` edits the shared `verifierModel` through the router.
   - When `review-system.test.ts` runs later in the same process, two of its tests then fail. That happens with alphabetical file order, which is the order on this machine.
   - CI's directory order runs `review-system` first, which hid the bug.
8. **Git in tests sees CI's global config.** This comes from #315. `test/setup.ts`, preloaded through `bunfig.toml`, points `GIT_CONFIG_GLOBAL` at a file holding only an identity, so a developer's commit signing, hooks and templates no longer reach fixture or factory commands. Tests that need other global settings already set `GIT_CONFIG_GLOBAL` themselves.

   #315 also turned off automatic maintenance; this version leaves it on. With `maintenance.auto=false`, removing the factory's `-c receive.autogc=false` from delivery still passed "delivery push runs no maintenance or gc in the source repository". Without it, the test fails as it should.

   Neither this machine nor the maintainer's Mac signs commits, so the preload makes no measurable difference here. It is there for portability.
9. **The shadow-failure kinds share one control run.** This also comes from #315. The five "shadow … failures leave provider health … as with the shadow off" cases each ran the same shadow-off control, which injects no failure; they now share one, saving four complete factory runs.

### Why CPU time does not fall 30%

The test-only changes remove 4,621 git starts (3.6%) and 4% of CPU time. The remaining cost is in the production code paths the tests exist to exercise. The wrapper's two per-command lookups described above are half of all git starts.

A throwaway prototype, not part of this PR, measured what removing them would buy, on Bun 1.4.2. It cached both lookups by working directory and git prefix:

| Change | CPU | Wall |
| --- | ---: | ---: |
| Cache both lookups (unsafe) | 247 s → 176 s (−28%) | 236 s → 197 s (−16%) |
| Cache only the empty-tree id per repository | −6% on `failure-injection.test.ts` | |

The full cache failed two security tests in `git-integrity.test.ts`. Both show why the lookup runs before every command:

- *"Shared cache hooks from an earlier run cannot execute during fetch, worktree lifecycle or GC"* failed. An agent writes `hook.*` entries into the shared cache's config between two factory commands. A lookup cached before that write left the planted hooks enabled, so they ran during the next `fetch` and `worktree add`.
- *"Hook discovery fails closed on invalid config and honors cancellation even with allowFail"* failed. The lookup depends on the environment, for example `GIT_CONFIG_GLOBAL`. The cache was keyed by directory, so a lookup that failed under an invalid global config was replayed for later commands with a valid one. The opposite case is worse: a successful lookup would be reused for an environment that defines extra hooks, and those hooks would not be blanked.

Reaching 30% therefore needs one of two things:
- **A security-reviewed change to `worktreeGit`.** For example, it could share one lookup across commands that already start together, such as the five `diff`s in `diffSince`. Or it could blank config hooks some other way than discovering them before every command.
- **Fewer complete factory runs per behavior.** That means cutting integration coverage, which this pass does not do.

Production factory runs pay the same cost, so the wrapper change is tracked separately in #319 rather than folded into this test-only PR.

### Effect on a 6-core laptop

`bun test` runs files one at a time in one process. A suite uses about 1.06 cores on average before this change and 1.20 after, so the laptop's core count matters only when several suites or factory runs share it.

**Time for one suite run.** On its own, a suite's wall time is roughly this machine's active time multiplied by the laptop's per-core slowdown *k*, plus the waiting time, which does not scale:

> laptop time ≈ k × (wall − waiting) + waiting

Before this change that was 205 s active and 38 s waiting; after, 191 s and 14 s. The issue reports 8–15 minutes for this suite on the laptop, which puts *k* at 2.2–4.2. With the same *k*:

| k | Before | After | Saved |
| ---: | ---: | ---: | ---: |
| 2.2 | 8.0 min | 7.1 min | 52 s (−11%) |
| 4.2 | 15.0 min | 13.7 min | 80 s (−9%) |

The waiting time that was removed is the same on every machine, so the laptop saves less in relative terms than this machine does. Process creation costs more on macOS than on Linux, so the git-heavy files probably slow down by more than *k*. That means the 4,600 fewer git starts are worth somewhat more on the laptop than this model shows.

**Throughput when the 6 cores are shared.** With `max_concurrent_gates = 2` suites plus factory runs on 6 cores, CPU time sets the throughput, not wall time. Each suite costs about *k* × 247 core-seconds, and this change saves 4.1% of that.

**File-level parallelism (not adopted).** This PR does not use `bun test --parallel=6`, because that changes how gates run. With it, the floor would be the longest file rather than the sum. `pipeline.test.ts` takes about 104 s × *k*, while total CPU divided by 6 is about 43 s × *k*. Going below that floor would need `pipeline.test.ts` split into several files.

### Per-file timings (Bun 1.4.0)

Files that took at least 1 s before or after; the rest are summed. Wall times are the median of two whole-suite runs. CPU times come from each file run alone. `evals-policy.test.ts` is unchanged and bimodal: repeated runs of the base commit took 1.0 s or 1.8 s of CPU.

| File | Tests | Wall before | Wall after | CPU before | CPU after |
| --- | ---: | ---: | ---: | ---: | ---: |
| `test/pipeline.test.ts` | 295 | 111.32s | 103.75s | 133.33s | 128.64s |
| `test/failure-injection.test.ts` | 105 | 31.45s | 30.79s | 37.09s | 36.19s |
| `test/evals-implement-runner.test.ts` | 75 | 17.90s | 16.56s | 25.06s | 23.61s |
| `test/git-integrity.test.ts` | 95 | 13.53s | 12.85s | 23.63s | 22.58s |
| `test/evals-reading-runner.test.ts` | 27 | 6.51s | 5.97s | 7.53s | 7.01s |
| `test/evals-runner.test.ts` | 35 | 3.59s | 2.94s | 4.93s | 4.28s |
| `test/hardening.test.ts` | 20 | 4.44s | 2.26s | 2.94s | 2.98s |
| `test/merge-markers.test.ts` | 16 | 2.17s | 2.15s | 2.50s | 2.50s |
| `test/evals-cli.test.ts` | 29 | 0.88s | 0.85s | 2.44s | 1.84s |
| `test/evals-snapshot.test.ts` | 11 | 1.66s | 1.43s | 2.35s | 2.17s |
| `test/proxy-http.test.ts` | 4 | 0.43s | 0.42s | 1.79s | 1.77s |
| `test/gc.test.ts` | 13 | 1.16s | 1.14s | 1.55s | 1.57s |
| `test/smoke.test.ts` | 50 | 23.94s | 11.01s | 1.45s | 1.48s |
| `test/evals-policy.test.ts` | 43 | 0.50s | 0.58s | 1.12s | 2.00s |
| `test/github-poller.test.ts` | 45 | 7.76s | 0.59s | 1.04s | 0.84s |
| `test/preview.test.ts` | 18 | 1.29s | 1.30s | 0.19s | 0.20s |
| `test/feed-cli.test.ts` | 9 | 3.09s | 1.08s | 0.19s | 0.19s |
| `test/decisions.test.ts` | 7 | 1.34s | 1.34s | 0.11s | 0.12s |
| 71 other files | | 9.89s | 9.54s | 19.72s | 20.24s |
| **Total** | 1769 | 242.87s | 206.56s | 268.97s | 260.22s |

## First pass (#289)

Measured 2026-10-03 on macOS arm64 with Bun 1.4.0.

The complete test suite took **596.22s before** and **535.20s after**, an observed reduction of **61.02s (10.2%)**. The changes remove avoidable waits and duplicated checks while retaining the expensive security, isolation, restart, and delivery coverage.

### Measurement

| Measurement | Before | After |
| --- | ---: | ---: |
| Bun test elapsed time | 596.22s | 535.20s |
| Passing tests | 1636 | 1631 |
| Test files | 85 | 87 |
| Failing tests | 0 | 0 |

The complete after-change `bun run check` took 535.92s including lint and TypeScript checking; all three steps passed. Both versions were measured from the task checkout based on `8c99eaf530e95ce016861ea3e947e616100bd7ea`, with dependencies installed from the unchanged lockfile. No runner settings, concurrency flags, skips, or production code changed.

The before command was `bun test --reporter=junit --reporter-outfile=/tmp/limitless-test-analysis/run-1.xml`. The after command was `bun run check`, whose test step is the ordinary `bun test`. The suite totals above use Bun's reported test duration, so the after number excludes lint/typecheck. File and group durations sum individual test durations, including their setup; they are not separate file-process timings. The baseline uses JUnit precision and the after run uses the console's millisecond precision.

These are one complete before run and one complete after run, executed sequentially with local socket access for fixture servers. They are observations, not a statistical benchmark; differences in unchanged tests remain visible in the file table. An earlier 18.06s attempt was excluded because this worktree lacked installed dependencies and the sandbox denied loopback sockets.

### Changes and useful coverage

1. **Remove a circular test wait.** The shadow-slot test used two five-second polls for an artifact that `shadowReview` writes only after the production review completes. Production was itself waiting for that artifact. A deferred promise now releases each production review when the real `tryAcquire` rejects its shadow slot attempt. That wait is bounded at five seconds and recorded, so a shadow that skips or queues for its slot fails the test instead of hanging it. The real acquisition method still runs, and the assertions about both rounds, no shadow calls, no queued shadow acquisitions, and skipped artifacts remain.
2. **Delay only the stage being tested.** The post-merge timeout test retains the two-second gate and 1.5-second GitHub budget, but waits only after the upstream `base.txt` arrives. Its baseline and pre-merge gates no longer sleep needlessly. The baseline single-flight test retains its one-second overlap window only on the base revision; finished implementations no longer sleep.
3. **Move 29 pure tests out of the Git fixture.** Four parameterized test definitions moved unchanged into `test/spec-prompts.test.ts` and `test/spec-criteria.test.ts`. Their semantic ASTs, including inputs and assertions, were compared with the original definitions. They no longer initialize and commit a repository before inspecting a prompt or running a pure predicate.
4. **Delete five redundant integration rows.** The citation matrix retains a valid request, an ungrounded heading, and a valid spec citation, including feedback and persisted verdict checks. The removed rows were the second heading, second request line, bullet variant, short fragment, and one-word request. Detailed input coverage remains in `test/verification.test.ts`; explicit one-word, short-fragment, second-request-line and blank-line-heading assertions were added there.
5. **Delete source-spelling and incidental prose assertions.** Three checks for `{m.origin}`, `{m.baseOrigin}`, and `colspan={13}` were removed from the catalog/API test. The existing rendered Models test still checks row alignment and origins, and now explicitly distinguishes Jev's US checkpoint origin from its unknown base origin. The installer test drops an eleven-word prose checklist and checks only the skill description's trigger phrases, which agents match to invoke the skill; executable TOML examples, metadata, matching installed skills, launch arguments, and tool references remain checked.

The suite loses exactly five test cases. The 29 moved cases account for two new files, so the file count increases by two. Removing the source/prose checks is a maintenance improvement with negligible direct runtime benefit.

| Changed test group | Before | After | Observed reduction |
| --- | ---: | ---: | ---: |
| Shadow finder with no free slot | 10.881s | 0.782s | 10.099s |
| Post-merge gates exceeding the GitHub retry budget | 7.329s | 3.166s | 4.163s |
| Concurrent baseline single flight | 2.737s | 1.642s | 1.096s |
| Pure spec tests moved out of Git setup (29 cases) | 0.950s | <0.001s | 0.949s |
| Citation grounding integration matrix (8 to 3 cases) | 7.503s | 2.498s | 5.005s |

The changed groups account for 21.31s of the observed reduction. The other 39.71s came from tests outside these groups, including unchanged files, so the full 61.02s difference cannot be attributed confidently to these edits. The removed ten-second circular wait and five seconds of unnecessary gate sleeps are directly explained by the code changes.

### What should stay

The three largest baseline files consume about 80% of total test time: pipeline, failure injection, and implementation-eval runners. They exercise different state transitions, crash checkpoints, retry/exhaustion outcomes, hidden-test isolation, and delivery side effects. Deleting these wholesale would remove coverage at the boundaries where unit tests cannot prove the full behavior.

The five-second shadow-abort settlement case and real CLI timeout/process-group cases remain: their elapsed time exercises actual timer and OS cleanup behavior. Replacing every such case with an instantly resolving fake would lose that contract. Future work can make timers injectable and keep representative real-process cases, but that needs a separate implementation and verification pass.

In the baseline, 682 tests took less than 10ms each and consumed only 1.950s together. Deleting fast formatting, schema, or routing tests merely to reduce the test count would have little effect on suite runtime.

The patterns above are recorded in `test/AGENTS.md`: avoid source-spelling checks, incidental documentation keyword lists, duplicate integration matrices, and expensive fixtures for pure tests. Preserve tests for distinct security and lifecycle failures.

### File timings

Sorted by baseline cost. Values are sums of individual test durations; rounding and runner/module overhead explain the small difference from the complete-suite elapsed time.

| File | Before cases | Before seconds | After cases | After seconds |
| --- | ---: | ---: | ---: | ---: |
| `test/pipeline.test.ts` | 328 | 320.875 | 294 | 275.628 |
| `test/failure-injection.test.ts` | 105 | 91.251 | 105 | 86.642 |
| `test/evals-implement-runner.test.ts` | 75 | 64.246 | 75 | 57.240 |
| `test/smoke.test.ts` | 50 | 24.772 | 50 | 24.624 |
| `test/git-integrity.test.ts` | 40 | 22.831 | 40 | 20.402 |
| `test/evals-reading-runner.test.ts` | 27 | 16.173 | 27 | 16.563 |
| `test/merge-markers.test.ts` | 16 | 8.063 | 16 | 8.569 |
| `test/evals-runner.test.ts` | 34 | 6.964 | 34 | 6.204 |
| `test/hardening.test.ts` | 20 | 6.823 | 20 | 6.498 |
| `test/evals-snapshot.test.ts` | 11 | 6.079 | 11 | 6.039 |
| `test/gc.test.ts` | 13 | 3.804 | 13 | 3.959 |
| `test/feed-cli.test.ts` | 9 | 3.074 | 9 | 3.068 |
| `test/evals-cli.test.ts` | 29 | 2.115 | 29 | 1.865 |
| `test/preview.test.ts` | 18 | 1.371 | 18 | 1.354 |
| `test/decisions.test.ts` | 7 | 1.349 | 7 | 1.347 |
| `test/triage-cascade-engine.test.ts` | 4 | 1.259 | 4 | 1.125 |
| `test/scratch.test.ts` | 72 | 1.152 | 72 | 1.120 |
| `test/evals-http.test.ts` | 5 | 1.138 | 5 | 1.017 |
| `test/gates.test.ts` | 33 | 0.957 | 33 | 0.942 |
| `test/run-dependencies.test.ts` | 14 | 0.877 | 14 | 0.929 |
| `test/mcp.test.ts` | 10 | 0.865 | 10 | 0.807 |
| `test/feed-producers.test.ts` | 10 | 0.820 | 10 | 0.736 |
| `test/triage-decisions.test.ts` | 9 | 0.747 | 9 | 0.748 |
| `test/evals-cases.test.ts` | 13 | 0.655 | 13 | 0.566 |
| `test/router.test.ts` | 63 | 0.532 | 63 | 0.439 |
| `test/review-shadow-cli.test.ts` | 15 | 0.506 | 15 | 0.492 |
| `test/providers-cli.test.ts` | 3 | 0.506 | 3 | 0.423 |
| `test/review-system.test.ts` | 13 | 0.417 | 13 | 0.363 |
| `test/feed-http.test.ts` | 7 | 0.406 | 7 | 0.452 |
| `test/mcp-proxy.test.ts` | 6 | 0.366 | 6 | 0.299 |
| `test/proxy-http.test.ts` | 4 | 0.363 | 4 | 0.321 |
| `test/mcp-http.test.ts` | 6 | 0.316 | 6 | 0.331 |
| `test/review-shadow-report.test.ts` | 20 | 0.314 | 20 | 0.215 |
| `test/drain-http.test.ts` | 2 | 0.295 | 2 | 0.277 |
| `test/evals-policy.test.ts` | 43 | 0.268 | 43 | 0.269 |
| `test/concierge.test.ts` | 21 | 0.260 | 21 | 0.235 |
| `test/github-delivery.test.ts` | 1 | 0.256 | 1 | 0.230 |
| `test/github-webhook.test.ts` | 28 | 0.249 | 28 | 0.191 |
| `test/evals-selection.test.ts` | 2 | 0.202 | 2 | 0.191 |
| `test/deploy.test.ts` | 39 | 0.197 | 39 | 0.249 |
| `test/evals-store.test.ts` | 9 | 0.191 | 9 | 0.180 |
| `test/quota-alerts.test.ts` | 17 | 0.147 | 17 | 0.173 |
| `test/discord.test.ts` | 13 | 0.143 | 13 | 0.109 |
| `test/routing-policy.test.ts` | 8 | 0.137 | 8 | 0.140 |
| `test/evals-catalog.test.ts` | 2 | 0.135 | 2 | 0.121 |
| `test/migrations.test.ts` | 14 | 0.124 | 14 | 0.104 |
| `test/feed-store.test.ts` | 8 | 0.107 | 8 | 0.082 |
| `test/resolved-surfaces.test.ts` | 2 | 0.103 | 2 | 0.097 |
| `test/providers-page.test.ts` | 1 | 0.101 | 1 | 0.093 |
| `test/github-notifier.test.ts` | 9 | 0.089 | 9 | 0.083 |
| `test/providers-http.test.ts` | 3 | 0.085 | 3 | 0.086 |
| `test/export-commit.test.ts` | 1 | 0.064 | 1 | 0.059 |
| `test/service.test.ts` | 2 | 0.061 | 2 | 0.056 |
| `test/review.test.ts` | 134 | 0.054 | 134 | 0.056 |
| `test/config-routing.test.ts` | 11 | 0.053 | 11 | 0.047 |
| `test/llm.test.ts` | 9 | 0.047 | 9 | 0.045 |
| `test/github-authorization.test.ts` | 5 | 0.045 | 5 | 0.045 |
| `test/integrations-install.test.ts` | 5 | 0.037 | 5 | 0.037 |
| `test/evals-page.test.ts` | 1 | 0.037 | 1 | 0.043 |
| `test/chat-http.test.ts` | 4 | 0.034 | 4 | 0.038 |
| `test/provider-workload.test.ts` | 7 | 0.029 | 7 | 0.028 |
| `test/models-page.test.ts` | 1 | 0.028 | 1 | 0.028 |
| `test/harness.test.ts` | 19 | 0.024 | 19 | 0.044 |
| `test/cost-cli.test.ts` | 1 | 0.023 | 1 | 0.024 |
| `test/provider-card.test.ts` | 3 | 0.022 | 3 | 0.021 |
| `test/artifacts-panel.test.ts` | 1 | 0.020 | 1 | 0.017 |
| `test/openrouter.test.ts` | 2 | 0.016 | 2 | 0.016 |
| `test/evals-stats.test.ts` | 11 | 0.009 | 11 | 0.009 |
| `test/verification.test.ts` | 32 | 0.008 | 32 | 0.008 |
| `test/cost-chart.test.ts` | 1 | 0.008 | 1 | 0.008 |
| `test/original-prompt.test.ts` | 1 | 0.007 | 1 | 0.007 |
| `test/cost-cell.test.ts` | 1 | 0.006 | 1 | 0.007 |
| `test/snapshots.test.ts` | 1 | 0.005 | 1 | 0.005 |
| `test/report.test.ts` | 11 | 0.005 | 11 | 0.004 |
| `test/evals-reading-grader.test.ts` | 27 | 0.002 | 27 | 0.002 |
| `test/local.test.ts` | 7 | 0.001 | 7 | 0.001 |
| `test/panel-merge.test.ts` | 6 | 0.001 | 6 | 0.000 |
| `test/cidr.test.ts` | 3 | 0.000 | 3 | 0.000 |
| `test/drain-ui.test.ts` | 1 | 0.000 | 1 | 0.000 |
| `test/holdout-schema.test.ts` | 3 | 0.000 | 3 | 0.000 |
| `test/invocation-display.test.ts` | 4 | 0.000 | 4 | 0.000 |
| `test/quota-format.test.ts` | 2 | 0.000 | 2 | 0.000 |
| `test/evals-grader.test.ts` | 2 | 0.000 | 2 | 0.000 |
| `test/implement-prompt.test.ts` | 4 | 0.000 | 4 | 0.000 |
| `test/cost-format.test.ts` | 2 | 0.000 | 2 | 0.000 |
| `test/spec-criteria.test.ts` | 0 | 0.000 | 23 | 0.000 |
| `test/spec-prompts.test.ts` | 0 | 0.000 | 6 | 0.000 |

### Slowest individual baseline tests

| File | Test | Before seconds | After seconds |
| --- | --- | ---: | ---: |
| `test/pipeline.test.ts` | a shadow finder without a free provider slot is skipped at once and never queues | 10.881 | 0.782 |
| `test/pipeline.test.ts` | post-merge gates slower than the GitHub retry budget still deliver | 7.329 | 3.166 |
| `test/pipeline.test.ts` | a shadow call still running after its abort never holds the run past the grace period or touches its worktree | 5.662 | 5.602 |
| `test/smoke.test.ts` | smoke cleans CLI groups: cli-timeout | 5.296 | 5.292 |
| `test/smoke.test.ts` | smoke cleans CLI groups: idle-timeout | 5.294 | 5.292 |
| `test/pipeline.test.ts` | a failing flight releases its waiters to run concurrently | 4.754 | 4.693 |
| `test/failure-injection.test.ts` | a delivery resumed after a crash and downtime starts a fresh GitHub budget | 4.254 | 4.165 |
| `test/pipeline.test.ts` | a changed gate environment misses | 3.916 | 3.553 |
| `test/smoke.test.ts` | smoke cleans CLI groups: escaped-timeout | 3.799 | 3.793 |
| `test/pipeline.test.ts` | quota headroom is checked only for providers the shadow roster can reach, and unknown headroom skips it | 3.411 | 3.225 |
| `test/failure-injection.test.ts` | factory merge survives interruption at implementation-committed without losing parents or replaying completed work | 3.359 | 2.970 |
| `test/pipeline.test.ts` | a changed nonsecret setting with a secret-looking name misses | 3.195 | 3.041 |
| `test/failure-injection.test.ts` | factory merge survives interruption at resolution-start without losing parents or replaying completed work | 3.079 | 2.967 |
| `test/feed-cli.test.ts` | the CLI binary retries two 5xx responses and then prints items | 3.028 | 3.025 |
| `test/evals-implement-runner.test.ts` | baseline gates are shared across repetitions and providers per case within each run | 3.000 | 2.717 |
