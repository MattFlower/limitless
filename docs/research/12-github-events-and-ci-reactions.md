<!-- Research synthesis produced on 2026-10-03 from two research passes: (1) GitHub API documentation plus read-only measurements against a public repository, together with a survey of agent tools that react to CI failures, merge conflicts and review comments; (2) Limitless's own CI, merge and review history from 2026-09-26 to 2026-10-03 (456 Actions runs, 159 PRs, 150 daemon runs). Dates are UTC. Edited by the orchestrator. Evidence tags as in 11-spec-stage.md. Status: input to M5.5 (docs/PLAN.md). -->

# Reacting to GitHub without webhooks: events, CI failures and conflicts (2026-10-03)

**Goal.** Limitless should notice what happens to its own PRs and react sensibly:
- CI finishing or failing;
- a PR becoming unmergeable;
- reviews and comments;
- base-branch drift.

It must do this in environments where the user can neither create webhooks nor install GitHub Apps, using only the `gh` CLI's OAuth token.

**Evidence tags:**
- **[S] strong:** official documentation, a large benchmark, or our own complete data.
- **[M] moderate:** a vendor post, a solid preprint, or a single measurement.
- **[W] weak:** inferred or unverified.

## 0. Bottom line

1. **Poll state with GraphQL, not per-PR REST.** One query per repository returns every open PR's mergeability, merge state and CI rollup, and costs 1 point for 50 PRs. At a 30–60 s cadence that is 60–120 of the 5,000 points per hour [M: measured `rateLimit(dryRun:true)`]. REST conditional requests (`If-None-Match` → 304) are free, but a PR payload embeds both repository objects, so its ETag will likely change on unrelated pushes and stars [W]. Fetch comment bodies and logs by REST only when the GraphQL state shows a change.
2. **The notifications endpoint cannot be the catch-all.** A user's own actions never notify them, and Limitless acts as the user. `ci_activity` covers only Actions runs the user triggered, and those are opt-in [S] ([notifications](https://docs.github.com/en/rest/activity/notifications), [Actions notifications](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)). The owner's last 50 notifications had no `ci_activity` at all, although the factory pushed constantly [M]. It remains a cheap signal for other people's reviews and comments.
3. **"CI red → send it back to implement" is the wrong default.** Of our 16 failed factory CI runs, only 3 were fixable inside the PR's own code [S: our data]. The rest were:
   - 7 environment or version differences;
   - 2 caused by main moving;
   - 2 flaky;
   - 2 infra.

   Several automatic "fixes" would have done harm: weakening a security test, loosening a timing assertion, or editing a docs-only PR.
4. **Classify failures deterministically before any model runs.**
   1. Is main red on the same check?
   2. For a timeout, does a rerun at the same SHA pass?
   3. Is the fix mechanical (formatter)?
   4. Does the failure reproduce locally on the head, only on the merge with main, or not at all (environment)?

   Only what remains goes to a capped fix round.
5. **PR latency is mostly waiting.** 78% of the time a factory PR was open was idle, mostly waiting for the orchestrator [M: our data, estimated]. A landing queue and feed-driven review save more time than faster models do.

## 1. Reading GitHub state without webhooks

### 1.1 Measured REST behaviour [M]

All measurements are read-only GETs with a `gh` OAuth token, made 2026-10-03.

- **Every endpoint below returned an ETag:**
  - single PR, check runs and check suites for a ref;
  - combined status;
  - workflow runs by `head_sha`;
  - reviews, review comments and issue comments;
  - notifications.
- **10 conditional requests each returned 304** without changing `x-ratelimit-used`. This matches the docs: "Making a conditional request does not count against your primary rate limit if a `304` response is returned and the request was made while correctly authorized" ([best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)).
- **ETags are per token** (`Vary: Authorization`), and responses carry `Cache-Control: private, max-age=60`.
- **Only notifications and repository events send `X-Poll-Interval`** (60 s).

**Unreliable signals:**
- **Combined status** reports `state: pending, total_count: 0` on an Actions-only repository whose 25 check runs all passed [M]. It only covers the legacy Status API.
- **Check suites** can include phantom suites that stay `queued` with `latest_check_runs_count: 0` (left by installed apps), so "all suites completed" never becomes true [M]. Use check runs, or GraphQL `statusCheckRollup`, which reported `SUCCESS` for the same commit.
- **`mergeable` is computed lazily.** A `null` value means "GitHub has started a background job" ([pulls](https://docs.github.com/en/rest/pulls/pulls)). The PR list endpoint omits it. GitHub emits no webhook when the base branch advances into a conflict ([Claude Code docs](https://code.claude.com/docs/en/claude-code-on-the-web)), so webhook users must also re-check mergeability, for example on base `push` events.
- **The Events API** is "not built to serve real-time use cases… latency can be anywhere from 30s to 6h" ([events](https://docs.github.com/en/rest/activity/events)).

### 1.2 GraphQL [M]

- **No conditional requests**, and it has its own rate-limit bucket.
- **Cost** is the sum of requests per connection divided by 100, minimum 1 ([limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)).
- **Measured costs:**
  - 1 point: 50 open PRs with `mergeable`, `mergeStateStatus`, `headRefOid` and the head commit's `statusCheckRollup { state contexts(first:100) }`;
  - 11 points: 20 PRs with review threads;
  - 2 points: a search for the user's own PRs.
- **Useful fields:**
  - `mergeable` is `MERGEABLE`, `CONFLICTING` or `UNKNOWN` ("still being calculated").
  - `mergeStateStatus` is `BEHIND`, `BLOCKED`, `CLEAN`, `DIRTY`, `HAS_HOOKS`, `UNKNOWN` or `UNSTABLE`.
- **Errors:** secondary-limit errors can arrive as HTTP 200 with an error body, so parse the body. Whether a GraphQL read starts the mergeability computation is unverified [W]. When `UNKNOWN` persists, a single-PR REST GET does start it.

### 1.3 Limits and etiquette [S]

From the REST rate-limit docs ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)):
- **Primary limit:** 5,000 requests per hour per user, shared by all of the user's tokens.
- **Secondary limits:**
  - at most 100 concurrent requests;
  - at most 900 points per minute for REST API endpoints and 2,000 for GraphQL (a GET costs 1 point, a write 5);
  - 80 content-creating requests per minute and 500 per hour;
  - "subject to change without notice".
- **On 403 or 429:** honour `retry-after`. Otherwise wait at least a minute and back off exponentially.
- **Request pattern:** make requests serially and on a fixed schedule, and keep query parameters stable to maximise 304s ([best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)).
- **Our own usage:** the daemon already uses GraphQL points through `gh pr view` (369 in the measured hour).

### 1.4 Organizations, SSO and the `gh` token [S]

- **OAuth app restrictions don't block `gh`.** GitHub CLI is a privileged OAuth app that users can authorize even when an organization restricts OAuth apps ([privileged apps](https://docs.github.com/en/apps/oauth-apps/using-oauth-apps/privileged-oauth-apps)).
- **With SAML SSO:**
  - Authorization needs an active SSO session, so sign in to the identity provider, then run `gh auth login --web` or `gh auth refresh`.
  - A missing authorization shows up as **403 with an `X-GitHub-SSO` header**, or as a 404. This is documented for classic personal access tokens ([REST authentication](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api)); for the `gh` OAuth token the same responses are likely but unverified [W].
  - So a 404 must not be read as "PR deleted" without first ruling out SSO.
- **Network restrictions:** IP allow lists and conditional-access policies can reject a token when the laptop is off VPN ([IP allow lists](https://docs.github.com/en/enterprise-cloud@latest/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/managing-allowed-ip-addresses-for-your-organization)).

### 1.5 How local tools poll [M]

| Tool | Interval | Method |
|---|---|---|
| `gh pr checks --watch` | 10 s | Re-fetches GraphQL `statusCheckRollup` |
| `gh run watch` | 3 s | 2–3 REST calls per tick, no conditional requests (2,400 or more requests per hour) |
| gh-dash | 30 min | Refresh |
| Gitify | 60 s | Notifications, honouring `X-Poll-Interval` |

Sources: [checks.go](https://raw.githubusercontent.com/cli/cli/trunk/pkg/cmd/pr/checks/checks.go), [watch.go](https://raw.githubusercontent.com/cli/cli/trunk/pkg/cmd/run/watch/watch.go).

## 2. Our history (2026-09-26 to 10-03) [S, some numbers estimated]

### 2.1 CI on factory branches

16 of 201 runs failed (8.0%), on 13 of 120 PRs. The local gates had passed in 15 of the 16.

| Class | Runs | Example |
|---|---|---|
| Real defect in the change | 3 | A test mutated a shared fixture; a formatter error |
| Real, but caused by main moving | 2 | A conflict resolution renumbered migrations; a textually clean merge broke a frozen-array test |
| Environment or version | 7 | Runner git 2.55 rejects a hook name that git 2.54 accepts; a runner-wide git-lfs filter config; a wall-clock budget test on a slow runner (4 runs) |
| Flaky | 2 | 5 s per-test timeouts; the same webhook test also failed on a docs-only PR |
| Infra | 2 | Workflow `startup_failure` after the repository went public, fixed by pinning actions to SHAs |

- **Reruns:** no factory-branch run was ever rerun. On orchestrator branches, 3 of 3 reruns passed: a 15-minute hang, an ordering flake later fixed, and the webhook-test timeout on #264.
- **Hangs:** the 4 timed-out jobs left no logs, only an annotation.
- **CI is getting slower:** median CI time rose from 23 s to about 200 s in a week.
- **A runner image change is due.** `ubuntu-latest` moves to Ubuntu 26 gradually from 2026-10-19 to 11-19 ([runner-images#14748](https://github.com/actions/runner-images/issues/14748)). For about a month, jobs will land on either image, so image-dependent failures will look flaky. The runner image version belongs in the failure signature, or the workflow can pin `ubuntu-24.04`.

### 2.2 Merging main and conflicts

- **Merging main:** 77% of merged factory PRs merged main at least once. This is a lower bound, because rebases left no trace.
- **Conflicts:** 19% of PRs conflicted. 15 of those 17 conflicted while waiting after the PR opened, and the orchestrator resolved 16 of them by hand at landing.
- **Trend:** conflicts are falling (11 of 43, then 5 of 20, then 1 of 28), since migrations became conflict-free.
- **Delivery-time base sync:** roughly 44 of 127 deliveries found that main had moved.
  - 38 synced cleanly and 2 regressed the gates.
  - 4 needed a resolution round, which took 10–33 min. In 2 of the 4, main moved again during the round.

### 2.3 Latency and review rounds

- **Opened to merged:** median 0.29 h, p90 6.6 h, with 78% of open time idle.
- **Review-driven fix rounds:** 21% of PRs had at least one. Each round took a median 1.07 h (p90 7.7 h) from request to merged into the PR.
- **No GitHub review comments exist.** Findings reached the factory as new runs on the PR branch.

## 3. What other tools do

| Tool | Reacts to | Guardrails |
|---|---|---|
| GitHub Copilot cloud agent | CI failure (one-click from the log), `@copilot` requests on a PR, conflicts (mobile, VS Code preview) | Only users with write access trigger it; comments from others never reach the agent; hidden characters filtered; pushes only to its own branch; workflows wait for human approval, which can now be skipped ([risks](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations), [changelog](https://github.blog/changelog/2026-03-13-optionally-skip-approval-for-copilot-coding-agent-actions-workflows/)) |
| Claude Code (cloud auto-fix) | CI failures and review comments through the Claude GitHub App (webhooks) | Pushes clear fixes; asks when a change is ambiguous or architectural; cannot react to merge conflicts (no webhook for base drift) ([docs](https://code.claude.com/docs/en/claude-code-on-the-web)) |
| `claude-code-action` examples | `workflow_run` failures | Same-repo PRs only; skips its own fix branches to avoid loops; restricted tools; the actor needs write access ([examples](https://github.com/anthropics/claude-code-action/tree/main/examples), [security](https://github.com/anthropics/claude-code-action/blob/main/docs/security.md)) |
| Cursor cloud agents | CI failures on PRs they created | Stop after 10 CI follow-ups; skip after a human commit or message; skip when the same check fails on the base commit; per-PR off switch ([capabilities](https://cursor.com/docs/cloud-agent/capabilities)) |
| Nx Self-Healing CI | Failed tasks | Applies a fix only when confident and verified by re-running the failed task; allow lists and never-fix lists ([docs](https://nx.dev/docs/features/ci-features/self-healing-ci)) |
| Devin, Codex | PR comments; CI failures through an Actions recipe | Write access and a linked account for commands ([Devin](https://docs.devin.ai/integrations/gh), [Codex](https://developers.openai.com/cookbook/examples/codex/autofix-github-actions)) |

**Published repair rates vary widely by failure type** [M]:

| Study | Result |
|---|---|
| Build-script repair (HireBuild) | 45% of reproducible build failures |
| Google's DeepDelta | 50% of missing-symbol compile errors |
| Long Code Arena | 4–17% of real GitHub Actions failures |
| Android build agents | 81% pass@1 on a curated benchmark |
| Google | 7.5% of reviewer comments resolved by ML edits at 50% precision |
| AIDev study | 46% of agent fixes rejected |

**Flaky tests** [S]:
- Same input but a different outcome means flaky. GitHub's tree-hash comparison plus retries cut flaky-red commits from 9% to 0.5% ([GitHub](https://github.blog/engineering/engineering-principles/reducing-flaky-builds-by-18x/)).
- Retry once, as Meta does.
- Quarantine tests whose flakiness rate is too high, as Google does.
- Reruns cannot prove a test clean: about 170 are needed for 95% confidence ([Gruber et al.](https://arxiv.org/abs/2101.09077)).
- One example action classifies flakiness with a model. Limitless keeps that decision in deterministic code.

## 4. Design for Limitless

### 4.1 Poller → the feed (#265)

- **One GraphQL query per configured repository** (`nodes(ids:)` over the tracked PRs' node ids, so busy repositories don't push them out of a first-N page) covers the open PRs the factory opened, identified from its own run records, never from branch names, so discreet mode leaves no marks. It returns `headRefOid`, `mergeable`, `mergeStateStatus`, `statusCheckRollup` (state and contexts), `reviewDecision`, `updatedAt` and review and comment counts.
- **Cadence:**
  - every 30–60 s while any tracked PR is open;
  - every 15 s while a landing waits on CI;
  - nothing for repositories without tracked PRs.
- **Requests are serial, and the poller backs off on secondary limits.**
- **Diff against the stored snapshot, and write feed items for each change:**
  - `pr.ci_passed` and `pr.ci_failed` (with the failing contexts);
  - `pr.conflicting` and `pr.behind`;
  - `pr.review` (approved or changes requested);
  - `pr.comment`;
  - `pr.merged` and `pr.closed`.

  Because the poller compares state, a missed poll is caught on the next one.
- **Only on a change**, fetch details by REST with `If-None-Match`: comment bodies (filtered to authors with write access, tracked by id and `updatedAt` rather than counts), and failed-job logs keyed on `(fail)`, `error: script`, `× Formatter would have printed` and `error TS`.
- **When `mergeable` stays `UNKNOWN`** for more than two polls, send one single-PR REST GET to start the computation.
- **Optionally poll `/notifications`** with `If-Modified-Since`, honouring `X-Poll-Interval`, as a hint for other people's activity.
- **It replaces today's per-run `gh pr view` merge checks**, which already use GraphQL points.
- **`doctor` detects SSO and network problems:** an `X-GitHub-SSO` header, a 404 on a known PR, or IP-restriction errors. It shows the fix rather than treating the PR as gone.

### 4.2 Classifying a CI failure (deterministic)

The failure signature is the check name, the failing test or error lines, and the runner image version from the job log. Each step either handles the failure or passes it to the next one.

1. **Is the main branch's latest run red on the same check?** If so, pause per-PR reactions and report one main failure. This covers infrastructure and workflow breakage, such as the `startup_failure` episode.
2. **Is it a timeout, a start failure or a cancellation?** That means the job timed out, failed to start or was cancelled, or a test hit its per-test timeout ("timed out after"). If so, rerun once at the same SHA.
   - **The rerun passes:** the same SHA has both passed and failed, which is evidence of nondeterminism. Record the signature in the flake ledger.
   - **The rerun fails the same way:** continue.
3. **Is it a formatter or lint autofix failure?** If so, run the repository's configured fix command (for this repository, `biome check --write`). No model is needed.
4. **Reproduce locally.** Run the failing check on the PR head, and on the head merged with the base SHA that CI tested.
   - **It fails on the merge only:** it is a merge-with-main problem; go to 4.3.
   - **It passes on both, but CI fails:** it is an environment or version difference (CI's git, runner config, a slower runner). Report it, with the signature and the runner image, and do not attempt a fix. This was the largest class in our history.
   - **It fails on both:** continue.
5. **Start a fix round** on the same PR, with the failing excerpt passed as quoted data. Cap it at 2 attempts per PR and failure signature.
   - Skip the round when a human has pushed to the branch since the failure.
   - A docs-only PR never gets a code fix.
   - After the round, the deterministic diff audit enforces two rules: the round may not weaken or delete a failing test, a gate or a security check, and it may not touch paths outside the PR's existing diff unless the failure names them. A violation ends the round as `needs_human`.

**The flake ledger** records signatures with evidence of nondeterminism only, meaning the same SHA or tree both passed and failed ([GitHub](https://github.blog/engineering/engineering-principles/reducing-flaky-builds-by-18x/)). A signature that recurs across PRs is not evidence by itself: environment failures also recur, such as the git 2.55 hook-name failure on two PRs 11 minutes apart. The ledger feeds a "recurring flake" report and an issue. It never quarantines a test automatically, and it never touches security tests.

**Backtest on our 16 failures** (by inspection [W]; step 4 was not re-run at those SHAs):

| Step | Failures it would have caught |
|---|---|
| 1 | The 2 infra runs (main's latest run was the same `startup_failure`) |
| 2 | The 2 per-test timeouts, likely passing on rerun |
| 3 | The formatter defect (1 run) |
| 4, merge-only | The 2 caused by main moving |
| 4, environment | The 7 environment runs: the git version difference, the runner's git-lfs config and the 4-run wall-clock budget test. The local gates had passed |
| 5 | The shared-fixture defect (2 runs on one PR). Because it is order-dependent, step 4 might report it as an environment difference instead, which is safe |

The model would have run at most for the one defect in the PR's own code.

### 4.3 Conflicts and drift

- **`pr.conflicting` or `pr.behind` on a PR waiting to land** starts the existing conflict-resolution round. The round needs full gates and CI on the merged result.
- **If main moves during the round**, restart from the new base once, then hand the PR to a person.
- **If the conflict is too large** (more than a set number of files or hunks), skip resolving and offer a redo from main instead.

### 4.4 Review comments

- **Only from authors with write access** (and any configured trusted logins).
- **Batched per PR,** debounced for several minutes.
- **Handled in one review round on the same PR.** A comment never starts a run on its own.

## 5. Proposed issues (M5.5)

1. **The GitHub poller** (§4.1), writing to the feed (#265), plus SSO and network detection in `doctor`.
2. **The failure classifier and its reactions** (§4.2): rerun, mechanical fix and the flake ledger first. Model-driven fix rounds come after #233 (the sandbox).
3. **The landing queue,** driven by `pr.ci_passed`, `pr.review` and `pr.conflicting`, with conflict rounds (§4.3); this absorbs #46.
4. **Review-comment rounds** (§4.4).
