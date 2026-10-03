# Test runtime and coverage review

Measured 2026-10-03 on macOS arm64 with Bun 1.4.0.

The complete test suite took **596.22s before** and **535.20s after**, an observed reduction of **61.02s (10.2%)**. The changes remove avoidable waits and duplicated checks while retaining the expensive security, isolation, restart, and delivery coverage.

## Measurement

| Measurement | Before | After |
| --- | ---: | ---: |
| Bun test elapsed time | 596.22s | 535.20s |
| Passing tests | 1636 | 1631 |
| Test files | 85 | 87 |
| Failing tests | 0 | 0 |

The complete after-change `bun run check` took 535.92s including lint and TypeScript checking; all three steps passed. Both versions were measured from the task checkout based on `8c99eaf530e95ce016861ea3e947e616100bd7ea`, with dependencies installed from the unchanged lockfile. No runner settings, concurrency flags, skips, or production code changed.

The before command was `bun test --reporter=junit --reporter-outfile=/tmp/limitless-test-analysis/run-1.xml`. The after command was `bun run check`, whose test step is the ordinary `bun test`. The suite totals above use Bun's reported test duration, so the after number excludes lint/typecheck. File and group durations sum individual test durations, including their setup; they are not separate file-process timings. The baseline uses JUnit precision and the after run uses the console's millisecond precision.

These are one complete before run and one complete after run, executed sequentially with local socket access for fixture servers. They are observations, not a statistical benchmark; differences in unchanged tests remain visible in the file table. An earlier 18.06s attempt was excluded because this worktree lacked installed dependencies and the sandbox denied loopback sockets.

## Changes and useful coverage

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

## What should stay

The three largest baseline files consume about 80% of total test time: pipeline, failure injection, and implementation-eval runners. They exercise different state transitions, crash checkpoints, retry/exhaustion outcomes, hidden-test isolation, and delivery side effects. Deleting these wholesale would remove coverage at the boundaries where unit tests cannot prove the full behavior.

The five-second shadow-abort settlement case and real CLI timeout/process-group cases remain: their elapsed time exercises actual timer and OS cleanup behavior. Replacing every such case with an instantly resolving fake would lose that contract. Future work can make timers injectable and keep representative real-process cases, but that needs a separate implementation and verification pass.

In the baseline, 682 tests took less than 10ms each and consumed only 1.950s together. Deleting fast formatting, schema, or routing tests merely to reduce the test count would have little effect on suite runtime.

The patterns above are recorded in `test/AGENTS.md`: avoid source-spelling checks, incidental documentation keyword lists, duplicate integration matrices, and expensive fixtures for pure tests. Preserve tests for distinct security and lifecycle failures.

## File timings

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

## Slowest individual baseline tests

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
