# Test runtime and coverage review

## macOS process scans and git's locale (2026-10-18)

On the factory's Mac (Apple M5 Max, 18 cores, about 650 processes running as the owner) the
suite took 18–23 minutes while other work ran. Two costs outside the tests made up most of it.

**Every command's shutdown scanned every process twice.** `runProcess` looks for descendants that
escaped the child's process group. On macOS `markedDarwinProcesses` read each of the user's
processes' arguments and environment with `KERN_PROCARGS2`. That read costs about 11 µs per process,
85% of a scan. One scan took about 9 ms at load 10 (3 ms when idle), almost all of it kernel time.
So `sh(["git", "--version"])` took 30 ms against 11 ms for a bare spawn, and the cost grew with the
number of processes on the machine. The whole baseline suite spent 3,420 s of system CPU against
1,410 s of user CPU.

The scan now reads each process's monotonic start time (`proc_pid_rusage`, about 1.7 µs) and skips
the argv read for processes that started before the command was spawned. Such a process can't
descend from the command: orphans reparent to launchd, and the child's new session and process group
admit only its descendants. A process whose start time can't be read is inspected as before. A
filtered scan takes 0.6 ms against 3.2 ms for a full one at the same load.

**git without a locale asks macOS for the preferred language.** Homebrew's git links gettext, which
queries CoreFoundation when `LANG`, `LC_ALL` and `LC_MESSAGES` are all unset. The daemon (started
by launchd) and the desktop app set none of them, so every git process in their test runs, gates
included, cost 4.4 ms of CPU and 6.0 ms of wall time instead of 2.3 ms and 2.8 ms. `test/setup.ts`
now sets CI's `LANG=C.UTF-8` when no locale is set.

| Run on the same Mac | Workers | Wall | User CPU | System CPU | 1-min load (median / max) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `main` at `190fe64` | 4 | 1,237 s | 1,410 s | 3,420 s | spot checks 9–15 |
| with the scan change | 4 | 653 s | 1,054 s | 1,554 s | 8.6 / 10.0 |
| with the scan change and locale | 4 | 486 s | 914 s | 1,220 s | 11.5 / 21.9 |
| with the scan change and locale | 6 | 301 s | 825 s | 1,095 s | 10.2 / 12.4 |
| `bun run check`, default workers | 6 | 294 s | 817 s | 1,068 s | 9.6 / 10.1 |

Each row is one whole-suite run (4,216–4,219 tests, the three added here included) while other work
ran, so load differs between rows. Alternating runs of `pipeline-spec.test.ts` alone at load 4 give
a cleaner comparison: 42.3 s and 42.6 s on `190fe64`, 17.0 s and 17.1 s with both changes (CPU 49 s
against 22 s).

With both changes the suite's per-file durations sum to 1,790 s, against 4,468 s before, so four
workers can't go below about 450 s; `land-pr.test.ts` (189 s) is the longest file. These two
changes removed or skipped no test and weakened no assertion. The gate executor's cancellation test
assumed its second check was already running when it cancelled; faster commands let the cancellation
land while that check's sandbox was still starting, so the test now waits until the check runs.

**Workers follow the machine.** The suite's default worker count was a fixed 4. With each suite now
needing about 1,900 CPU-seconds instead of 4,800, the default is a third of the cores, clamped to
4–8: 6 on this Mac, still 4 on CI's 4-vCPU runner and smaller machines. `LIMITLESS_TEST_WORKERS`
still overrides it.

**Overlapping tests.** A read-only review of the costliest files found about 220 s of the 1,790 s
(12%) in rows that repeat another row's guard and outcome, or input variants that the responsible
function's unit tests already cover. The largest single case was `land-pr.test.ts`'s 28 planted-key
rows (seven keys at four points). The fake git sends every permitted push to a local path, so the
transport keys they planted were never read. With the push repository made to include the clone's
config, all 28 still passed, and the pre-push rows had planted into the push repository itself,
because the fake `gh` inherited the script's `GIT_DIR` and `GIT_COMMON_DIR`. The fake git now lists
the config each push reads, the test fails if a planted key appears there, and one row per plant
point plants all seven keys into the clone. Under the same mutation all four rows fail. The file
went from 122 tests to 98. The other candidates are handled in
[Overlapping tests](#overlapping-tests-2026-10-18).

## Overlapping tests (2026-10-18)

The overlap review's remaining candidates were each checked by mutation before anything was removed.
The guard on the removed row's path was edited in a copy of the source, the kept rows were run, and
the source was restored. A row was removed only if a kept row, or a new unit test, failed under that
edit. Where every proposed mutation also passed the kept rows, the candidate stayed: for example
`clean-scripts`, `setup-regressed`, `draft-body`, `head-lookup-malformed`, the verify-change
`terminated` row and all four eval cancellation rows.

| File | Tests before | After | What went |
| --- | ---: | ---: | --- |
| `failure-injection.test.ts` | 140 | 117 | Recovery and exhaustion rows that share one fallback, cancellation stages awaited like triage, stream points sharing the invoke catch, delivery calls sharing one subprocess path; one test merged into another |
| `pipeline-delivery-privacy.test.ts` | 31 | 24 | Inputs that git-integrity and gates unit-test against the same publication checks |
| `pipeline-verification.test.ts` | 25 | 17 | Refusal reasons and retry inputs; two moved to `gate-evidence.test.ts` |
| `pipeline-merge-integrity.test.ts` | 11 | 5 | Three moved to `completeMerge` rows in `merge-markers.test.ts` |
| `git-integrity.test.ts` | 228 | 215 | Clean LFS formats, inert file names; unmatched media rules moved to a pure `auditDiff` test |
| `evals-implement-runner.test.ts` | 79 | 72 | Identical replies, cleanup rows covered by a stronger test, redundant cache-key combinations |
| `pipeline-audit.test.ts` | 11 | 8 | Allowance spellings unit-tested in `gates.test.ts` |
| `pipeline-gates.test.ts` | 17 | 14 | Restart rows covered by `gate-executor.test.ts` |
| `pipeline-shadow.test.ts` | 37 | 35 | A failure kind sharing the timeout branch, a headroom value sharing one comparison; two runs fewer and one round each in the quota-reach test |
| `pipeline-conflicts.test.ts` | 17 | 15 | Base states covered by stronger rows |
| `pipeline-verify-change.test.ts` | 19 | 17 | A subset of `restart-repair`; one moved to an `auditDiff` row |
| Unit files receiving moved cases (`gates`, `gate-evidence`, `merge-markers`, `hardening`, `gate-executor`) | 334 | 349 | |
| **Changed files** | **949** | **888** | |

Some removals needed a stronger kept test first. "PR creation window reconciles a stateful fake" now
asserts a single `gh pr create`, which fails if the lookup before create is skipped; the test it
absorbed slept 2.5 s and couldn't observe its own guarantee. The 3,200-file pathspec case still
crosses Linux's 2 MiB argv limit with 720-byte paths, and now also bounds the number of git commands.
The shadow review's 5 s settle wait is `shadowSettle.ms`, which one test shortens. The blocked
verify-change rows run with `maxRounds = 1`.

The mutations also found gaps that this change doesn't close:
- Nothing in `failure-injection.test.ts` guards the claude stream completion check: `requireStructured`
  masks a loosened check, and the invoke catch masks a parser that throws.
- No mutation specific to auto-merge fails its cancellation row; it only exercises the shared merge path.
- With `requireMerge` disabled, the factory merge rows still passed because `git merge-base HEAD
  MERGE_HEAD` fails closed; the new single-parent unit test is the only one that fails.

## Git wrapper caching (#319)

The second pass found that half of all git processes came from `worktreeGit` in `src/git/command.ts`: a hook-config lookup before every command, and an empty-tree `hash-object` before every diff or log. #319 caches both without trusting a stale result.

Measured 2026-10-04 on the same machine as the second pass:
- Bun 1.4.0, with `codex` off `PATH` as on CI.
- *Before* is `main` at `8a73535`; *after* adds this change.
- Two whole-suite runs before and three after, the first four alternating; git starts counted per file as in the second pass.

| Bun 1.4.0 | Before | After | Change |
| --- | ---: | ---: | ---: |
| Whole-suite wall time | 215.9 s | 183.6 s | −15.0% |
| Whole-suite CPU time (user + system, with children) | 261.3 s | 203.2 s | −22.2% |
| Git processes started | 128,054 | 80,582 | −37.1% |
| Hook lookups (`config --get-regexp ^hook\.`) | 51,903 | 363 | |
| Fingerprinted listings (`config --list`, each with one `rev-parse`) | 0 | 10,001 | |
| Empty-tree `hash-object` | 16,239 | 39 | |
| `git var` (config file locations, once per environment) | 0 | 248 | |
| Tests | 1,921 | 1,924 | three new |

Lookups and listings together fall from 51,903 to 10,364 (−80.0%). The remaining `--get-regexp` lookups are delivery's check of the source repository's receive hooks, plus fallbacks. The remaining `hash-object` calls are tests that run it themselves, and the deliberately unhardened scope.

Each *before* run had one failure, "tracked text and triage recovery examples use neutral service labels". It reads tracked files, and the *before* copy was an archive with no `.git`. The *after* runs, in the git worktree, had none.

**Per command on this machine:**

| | Wall time |
| --- | ---: |
| Today: hook lookup process | 0.92 ms |
| Today: `hash-object` process, per diff or log | 1.05 ms |
| Cache hit: fingerprint check, no process | 0.04 ms |
| Cache miss: `rev-parse` and `config --list` in parallel | about 1.8 ms |

How the cache stays safe is described in `src/git/hardening.ts` and in the pull request.

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

## Load-sensitive tests (#556)

Measured 2026-10-17 on the factory's Mac while other work ran. *Alone* runs the test's file by itself. *Loaded* runs it with `bun test --parallel=4` paired with one other heavy file, the bounded load from #556. *After loaded* is the worst of the paired runs. A dash marks a loaded run that wasn't measured after the change; those tests are tracked in #556.

| File | Test | Before alone | Before loaded | After alone | After loaded (worst) |
| --- | --- | ---: | ---: | ---: | ---: |
| `mcp-proxy` | change pages expose 2-line PR prose but protect its holdout quotation in reports | 3.42 s | 4.21 s | 2.98 s | 1.92 s |
| `mcp-proxy` | change pages expose 3-line PR prose but protect its holdout quotation in reports | 3.36 s | 4.08 s | 2.82 s | 1.98 s |
| `mcp-proxy` | change pages reuse the catalogue and refresh diagnostics, holdouts and privacy inputs | 3.77 s | 4.97 s | 4.42 s | 3.25 s |
| `mcp-proxy` | change view preserves PR text and withholds private paths, patch lines, reports and errors on both backends | 3.04 s | 3.69 s | 3.00 s | 2.63 s |
| `pipeline-baseline-cache` | a second run on the same base reuses a passing baseline | 4.79 s | 6.33 s | 4.75 s | 3.34 s |
| `pipeline-baseline-cache` | a flaky base that failed twice is not cached, so the next run blocks the regression | 11.32 s | 13.85 s | 8.59 s | 6.56 s |
| `pipeline-baseline-cache` | concurrent runs on one base execute the baseline once | 5.90 s | 5.89 s | 1.58 s | 1.32 s |
| `pipeline-baseline-cache` | with the kill switch, same-base runs execute their baselines concurrently | 6.62 s | 7.50 s | 2.51 s | 1.90 s |
| `pipeline-baseline-cache` | a failing flight releases its waiters to run concurrently | 6.89 s | 8.10 s | 2.59 s | 2.10 s |
| `pipeline-baseline-cache` | an unknown build SHA neither reads nor writes the cache | 5.78 s | 6.45 s | 5.18 s | 4.25 s |
| `pipeline-baseline-cache` | a changed gate config or base commit misses | 8.96 s | 9.65 s | 6.07 s | 6.28 s |
| `pipeline-baseline-cache` | a changed gate environment misses | 16.80 s | 20.59 s | 3.44 s | 3.72 s |
| `pipeline-baseline-cache` | a changed nonsecret setting with a secret-looking name misses | 16.89 s | 18.05 s | 3.00 s | 3.31 s |
| `pipeline-baseline-cache` | a timed-out or cancelled baseline is not cached | 9.59 s | 10.94 s | 7.01 s | 8.62 s |
| `pipeline-baseline-cache` | a bypass run refreshes a passing entry and evicts it when the base fails | 14.47 s | 16.45 s | 9.33 s | 13.62 s |
| `pipeline-baseline-cache` | post-rebase gates execute when prepare reused the cached baseline | 7.79 s | 7.33 s | 4.11 s | 6.91 s |
| `evals-runner` | control and causal replay share candidates and a pinned verifier but grade and cache independently | 20.88 s | 22.48 s | 10.45 s | — |
| `failure-injection` | factory merge survives interruption at resolution-start without losing parents or replaying completed work | 9.62 s | 8.80 s | 4.85 s | — |
| `failure-injection` | factory merge survives interruption at implementation-committed without losing parents or replaying completed work | 8.99 s | 9.87 s | 5.69 s | — |
| `failure-injection` | delivery with 3 PR-create 502s falls back as GitHub unavailable | 4.82 s | 5.10 s | 2.99 s | — |
| `evals-http` | review and verify API reports preserve role grades and text/JSON metrics | 3.23 s | 2.06 s | 2.05 s | — |
| `evals-implement-runner` | baseline gates are shared across repetitions and providers per case within each run | 23.47 s | 10.41 s | 10.71 s | — |
| `pipeline-delivery-restart` | delivery checkpoint conflict-committed never publishes unchecked work | 8.38 s | 8.84 s | 3.84 s | — |
| `evals-reading-runner` | review uses the pipeline prompt, recomputed audit, detached seeded HEAD and agent harness | 11.85 s | 12.00 s | 5.98 s | — |

Each test's remedy is noted in the comment beside it: for example, cancellable event waits instead of polling, trimmed page requests and fixtures, or watching the gate marker instead of sleeping.
