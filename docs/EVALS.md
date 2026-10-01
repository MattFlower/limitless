# Evals and routing calibration (M4 design)

[Reasoning effort](REASONING_EFFORT.md) is part of routing and eval target identity.
For example, `limitless eval run triage --models codex/luna@low,codex/luna@high --k 2 --follow`
compares two efforts independently. Bare IDs resolve to the catalog default at submission;
the saved effort does not change if the catalog default changes. Unsupported efforts and
duplicate resolved targets (such as `codex/luna,codex/luna@medium`) are rejected.

The routing table (`DEFAULT_POLICY` in `src/router/catalog.ts`) was written from vendor claims and
intuition. M4 replaces intuition with evidence: a small, cheap, repeatable eval suite that runs each
candidate model **inside our own harness adapters and prompts**, and a deterministic generator that
turns the results into a routing policy. Background: `docs/research/06-evals-and-routing-calibration.md`.

## Principles
- **Evaluate in our harness.** Scaffolding moves scores by up to ~30 points, so leaderboards don't
  transfer. Eval cases call the same role functions, prompts and schemas that the pipeline uses.
- **Deterministic grading.** Every grader in v1 is code: exact match, location match, test
  execution. No LLM judge until one is calibrated against labels (κ ≥ 0.7).
- **Separate tiers, don't rank neighbours.** 20–40 cases per role reliably separates models 10+
  points apart, and that is all routing needs. Choosing between near-equal models is left to quota
  headroom, which the router already does.
- **Cheap by construction.** Screen on single-shot roles first; run agentic cases only for models
  that clear the floors; stop early when a model's upper bound falls below the floor; local models
  run k=3 for free; cached responses are re-graded without re-running.
- **Uncontaminated data.** Cases come from our own repositories' history and runs, not public
  benchmarks the models have seen.

## Architecture

```
evals/<role>/*.json ──► runner ──► role fn (same prompts/schemas) ──► harness (claude/codex/http)
   (cases + gold)         │                                              │
                          ├── cache (model, adapter, prompt hash, input hash, params)
                          ▼
                     grader (pure) ──► eval_runs / eval_trials (SQLite) ──► stats (CIs, paired tests)
                                                                     │
                                         policy generator (pure) ◄───┘
                                                  │
                           routing/policy.json + routing/EVIDENCE.md ──► PR ──► orchestrator review
```

- **Cases** live in the repo under `evals/` as JSON with gold labels; fixture repos are referenced
  by `repo@sha` (our repos) so no large blobs are committed.
- **Runner** (`src/evals/`) resolves `--models`, respects the provider tracker (reserves, budgets,
  circuit breakers — an eval can never starve real runs), and records every trial in
  `eval_runs` / `eval_trials` (new migration).
- **Graders** are pure functions `(case, output) → {pass, score, details}` tested like any other
  code.
- **Stats**: Wilson intervals for pass and role metrics; seeded paired bootstrap against
  the best selected model in the role.
- **Policy generator** (pure): for each supported role default cell, choose the cheapest model whose
  Wilson 95% lower bound clears the role's quality floor, whose error-rate Wilson 95% upper bounds
  stay under the role's ceilings **and** that is non-inferior to the best model
  within δ = 0.10; the fallback chain lists other eligible models by ascending cost. Complexity-specific
  cells remain unchanged. Output is `routing/policy.json` (loaded over `DEFAULT_POLICY`)
  plus `routing/EVIDENCE.md` with the numbers behind every cell. **Policy changes land as a PR**,
  so the diff is the approval step and git is the version history.
- **Cost of evals** is tracked like any run's: subscription-equivalent and metered dollars per
  trial, with `--max-usd` for metered spend.

## Suite v1

| Role | Cases | Source | Grader | Primary metric (floor) |
|---|---|---|---|---|
| triage | 40 | own run prompts + boundary cases | exact match per field, cost-weighted | pass-rate Wilson lower bound ≥0.60; risk under-call rate ≤0.10 |
| review | 34 | 23 real-defect diffs and 11 clean merged diffs (16 in snapshot mode); 42 required and 14 optional defects | round-1 blocking finding + file/line-window match, one finding per defect; production-derived verdict | blocking-recall Wilson lower bound ≥0.50; clean false-block Wilson upper bound ≤0.50 |
| verify | 20 | labeled (criteria, diff, test output) triples, incl. "tests pass, criterion unmet" | per-criterion match | false-accept rate ≤0.10 |
| holdout | 8 | sandbox tasks with reference solution + 3 mutants | execution | valid-on-reference × mutant kill rate |
| implement | 12 | 8 sandbox replays + 4 small Limitless commits, stratified trivial/small/medium | hidden tests + gates + audit | resolve rate; $ and quota per task; wall time |
| spec, chat | — | deferred (structure lint only) | — | — |

Implement cases run in throwaway worktrees at the case's base commit with hidden tests copied in
only for grading (the same isolation as the holdout stage).

## Delivery plan
1. **Framework** (partially delivered): triage case validation, daemon runner with shared tracker and
   harness selection, pinned bare-repo inputs, persistent trials/cache, deterministic triage grader,
   Wilson intervals and seeded paired bootstrap, migration 6, HTTP API and
   `limitless eval run|report` are implemented and covered with fake harness/local repo tests.
   See [operations](OPERATIONS.md#evaluations) for commands and metric/accounting semantics.
   Review and verify runners and graders are also implemented (contracts below).
   The deterministic policy generator, validated startup overlays, and UI Evals list, matrix
   and run details are implemented. Other role graders and real-model sweeps remain pending.
2. **Agentic evals** (factory run): implement and holdout cases in worktrees; early stopping.
3. **Datasets** (orchestrator-curated, factory-assisted): gold labels are written or checked by the
   orchestrator, never by a candidate model alone.
4. **Sweep + policy**: run the sweep, generate `routing/policy.json`, review the PR, deploy.
5. **Exit demo**: a Dependabot PR on `limitless-sandbox` handled end-to-end on local models for $0.
6. **Afterwards**: production outcomes (gate/review/verify results, merges, reverts) update per-cell
   estimates; a drifting cell triggers a re-eval of that cell only.

## Implemented repository-reading evaluations

The repository-reading roles are `triage`, `review`, and `verify`. Review reads the committed
`evals/review/cases.json` unchanged. The real `evals/verify/cases.json` is separately curated;
there is no production fallback to the three-case test fixture. Missing datasets fail before scheduling.

Review and verify use version-1 envelopes `{ role, version, notes?, cases }`, with unique,
nonempty case IDs, `repo` as `owner/name`, and full 40-character `base` and `head` commit SHAs.
Review cases have `kind` (`real`, `seeded`, or `clean`), `source`, `input` (prompt, nullable
pipeline Spec, implementerReport, GateComparison array), and `defects`. Every defect retains
file, inclusive `[start,end]` line range, severity, category, summary, required, and foundBy.
An optional `seedPatch` is relative to the dataset directory; traversal, absolute paths and
symlinks escaping that directory are rejected.

Verify inputs contain prompt, non-null pipeline Spec, gates, and optional pipeline Holdout.
Gold is a nonempty map of criterion ID to `met` or `unmet`. Criterion IDs must be unique across
spec and holdout; gold may label a subset but cannot introduce unknown IDs. Gates are validated
and retained, but the shared verify prompt does not accept them. Omitted holdout means no scenarios.

Each invocation reads a disposable checkout detached at the exact head, prepared from the shared
bare cache under the repository lock. Missing pins trigger a fetch of branch heads and
`+refs/pull/*/head:refs/pull/*/head`; unavailable pins fail without substituting another commit.
The checkout is a standalone repository (not a linked worktree) that receives only the objects
reachable from base and head, with no refs, remotes or reflog: later commits in the cache (such as
the fix for a real defect, or the committed labels themselves) stay invisible to the candidate.
Seed patch content is applied from stdin and committed only in that checkout. The resulting HEAD
is the diff endpoint; the original base remains unchanged. Checkouts are removed on success,
preparation failure, invalid output, harness failure, and cancellation. No delivery operations run.
Pins whose reachable history itself contains labels are rejected as a preparation error: any
commit touching `evals/triage`, `evals/review` or `evals/verify`, or any blob identical to the
dataset file or one of its seed patches. Deleting such files from the checkout would not help,
since `git show` would still read them; pick pins from before the datasets were committed, or
use snapshot mode.

### Snapshot mode

Any case in any role may set `"snapshot": true` (omitted or `false` keeps the plain mode above).
The candidate then gets a fresh standalone repository instead of the pinned history. It holds
two commits: `Snapshot base`, which is `base^{tree}` without the top-level `evals` directory, and
`Snapshot head`, which is `head^{tree}` without it, parented on the first even when the two
trees are identical. The commits are built in a throwaway staging repository that borrows the
cache's objects, so only objects reachable from the snapshot are copied; trees are filtered
through Git's index, so filename bytes (including non-UTF-8 names) are preserved exactly. Original commits, refs, remotes and messages are unreachable. All
other paths, contents and modes are unchanged, so `git diff base..head` equals the original
diff outside `evals/**`, and graders see the same repository-relative paths. Author, committer
and dates are fixed, so the same pins always give the same tree and commit hashes. Missing pins
are fetched by exact SHA, as for plain triage, so a pin reachable only from a tag still works.
A snapshot or pin failure fails only that case's preparation; the rest of the run continues.

That snapshot base replaces `base` in prompts, diff statistics, base gate detection, the audit
and implement retry feedback. The original pins stay in the case as provenance and in the cache
identity, which also records `snapshot` so plain and snapshot trials never share a cache entry.
Seed patches are still committed on top of the snapshot head. The contamination check still
runs, now against the snapshot: label paths cannot appear, but any exact dataset, seed-patch or
hidden-file blob kept outside `evals/` still fails preparation before the candidate is invoked.

Removing `evals/` is not invisible to code that reads it. A repository whose own checks read
`evals/` (Limitless's test suite does) can't use snapshot mode for implement: a check already
failing at the snapshot base is `still_failing` and never blocks, so gates would stop grading.
Implement preparation therefore fails when any baseline check fails on a snapshot, naming the
check. Likewise a snapshot review case whose gold defect lies under `evals/` is rejected when
the cases load, since the candidate could never see that file.

Role differences: implement snapshots build both commits from `base` (its `head` is provenance
only, so the reference solution never enters the checkout and `Snapshot head` adds no changes),
and hidden files are injected at grading as usual. Triage has one repository pin, which
supplies both trees; triage candidates still get no checkout, and the top-level listing in
their prompt is read from the snapshot with `ls-tree`, without checking it out.

The candidate receives the pipeline prompt, FACTORY_PREAMBLE, role schema, read-only agent
harness, and normal inputs only: labels, source/foundBy annotations and patch files are never
copied into the worktree or prompt. Review recomputes diff statistics and audit findings using
the gate configuration (protected paths, gate script names) detected at base, as the pipeline
does before implementation, compared against the scripts at the effective HEAD; null task class and no historical commands. Blocking gates or
audit flags do not bypass the eval invocation. Review and verify retain the pipeline's scaled
20/25-minute reading timeouts, 10-minute idle timeout, 150-tool limit and verify private sessions.

### Grading and reporting

- Review grades what production would block in round 1, using the engine's own
  `blockingReviewFindings`/`reviewVerdict` (`src/pipeline/review.ts`). A finding lands on a defect
  when it names the same file (leading `./` normalized) with a positive line in `[start-5,end+5]`,
  inclusive. Line 0 lands by file only for completeness defects, even when a numeric window
  includes zero. Severity equality, category equality and text similarity are not required.
  A required defect is **caught** only when a blocking (blocker/major) finding lands on it.
  Assignment is one-to-one (maximum bipartite matching): a finding credits at most one defect, so
  a single finding in two overlapping windows catches one of them, not both. Ties go to the more
  severe defect, and a finding repeated verbatim (same file, line and title) is one finding. A
  required defect that isn't caught but is matched, in the same one-to-one way, by a non-blocking
  (minor/nit) finding is **under-rated** — diagnostic only, never recall.
- Real and seeded cases pass when every required defect is caught and the production-derived
  verdict is `request_changes`; the model's own verdict is ignored. A clean case false-blocks
  exactly when the derived verdict is `request_changes`, and its grade records the number of
  blocking findings. Optional defects never create misses or separate false positives.
- Review reports pooled blocking recall (caught/required) with a Wilson 95% interval as the
  headline, blocking recall by gold severity (blocker → high, major → medium, minor/nit → low),
  under-rated required defects, false blocks/clean predictions with blocking findings per clean
  case and trial, and correct derived verdicts/valid predictions. Zero required defects gives null
  recall. Grades stored before this rule (no severity breakdown) are excluded from pass rate,
  mean score, recall and paired comparisons, and a policy candidate with any of them is
  insufficient evidence. `limitless eval regrade <eval-id>` rewrites a finished review eval's
  grades from each trial's stored output against the current labels: no model calls, cache
  lookups or spend. Stored outputs from older schemas regrade because grading reads only each
  finding's severity, file and line (a missing `security` counts as false, and a missing model
  verdict is irrelevant); a degenerate review still fails. Panel outputs also regrade under the
  current panel rules, which read each finding's security flag and verifier ruling. Since panel
  policy 2, an unverified security finding blocks (fail closed), so a panel output stored under
  policy 1, which left security findings in cleanup or over the cap unverified, can regrade as a
  false block. Re-run such evals instead: the panel cache identity includes the policy version,
  so a re-run makes fresh calls. Trials whose case has left the dataset
  or whose output doesn't parse keep their stored grade and stay excluded.
- Verify scores only gold IDs. A single binary status must match exactly; missing, unclear and
  duplicate entries are inconclusive and match neither label. False accepts are gold unmet with
  predicted met, divided by gold-unmet observations. False rejects are gold met without an
  unambiguous met, divided by gold-met observations. Per-criterion accuracy is matches/labels;
  pass requires every label to match, independently of overall. Stored details explain each ID.
- Metrics pool labels across repetitions instead of averaging case recalls. Failed/invalid calls
  count as pass failures but have no prediction-dependent observations. Reports disclose valid
  prediction coverage, explicit numerators/denominators, null (`n/a`) for empty denominators,
  skips, errors, cache hits, costs and invocation latency. Grades are persisted in existing trial
  JSON so label edits cannot rewrite historical reports; `eval regrade` is the explicit exception.
- A daemon restart or `limitless eval cancel <eval-id>` stops an eval as `interrupted`: no new
  trials start, in-flight trials abort, and unfinished trials stay unscored. Interrupted evals
  never feed `eval policy`. Nothing resumes automatically; `limitless eval resume <eval-id>`
  resubmits an interrupted or failed eval's stored request unchanged as a new run (linked both
  ways in reports), so the cache supplies completed trials and at most the eval's concurrency of
  in-flight trials repeat. Resume refuses legacy evals without a stored request, `--no-cache`
  evals, and requests that no longer validate against the current dataset, models or systems.

Repository-reading cache identity additionally includes role, repository identity, pinned base
and head, normal input and seed content. Same-stat code or patch changes invalidate it; temporary
paths and seed commit timestamps do not. Gold-only changes regrade cached valid outputs with no
new usage, cost or quota updates.

All catalog IDs are eligible for `--models`, including candidates absent from DEFAULT_POLICY.
The catalog and Models page expose `origin` (checkpoint organization ISO alpha-2 country) and
`baseOrigin` (root base-model organization, or `unknown` for uncertain ancestry). Hosting and
quantization location do not determine origin. Candidate tiers remain provisional; no origin
restriction is applied to runtime escalation; generated candidates respect the exclusions below.

```sh
limitless eval run review --models openrouter/gpt-6-luna --follow
# After curating the real verify dataset:
limitless eval run verify --models openrouter/gpt-6-luna --k 2 --max-usd 1 --follow
```


## Implement evals

Run `limitless eval run implement --models <model> --k 2 --follow` with a version-1
`evals/implement/cases.json` envelope `{ role: "implement", version: 1, cases: [...] }`.
Each case has a unique `id`, `repo` (`owner/name`), full 40-character `base` and `head` SHAs,
`prompt`, nullable pipeline `spec`, `complexity` (`trivial`, `small`, or `medium`), `source`,
`tags`, optional `notes`, and `hidden: { files, command, timeoutSec? }` (default: 900 seconds).
`head` is provenance only; candidates edit a disposable checkout at `base`, using the pipeline
implement prompt and a 400-tool-call budget. Base history containing `evals/implement`, the
dataset bytes, or hidden-file bytes is rejected; other roles' label paths are allowed.

Store each hidden file at `evals/implement/hidden/<case-id>/<repository-relative-path>` and
list that relative path in `hidden.files`. Files are injected only after candidate gates and
audit, preserving permission bits so executable commands such as `./run.sh` work. The command
runs from the checkout root. Hidden contents and modes participate in cache identity.

Baseline gates run once per case/base within an eval run, shared across repetitions and models.
A failed baseline setup or timed-out baseline check produces a preparation `error`, invokes no
candidate, and is not cached. Ordinary baseline check failures remain eligible for comparison.
A trial passes when hidden tests exit zero, gates have no blocking regression against baseline,
and the deterministic audit has no blocks; audit warnings are retained without failing the trial.
Failure reasons are `hidden_tests` (nonzero hidden command), `gates` (blocking gate comparison),
`audit` (blocking findings), `timeout` (candidate or grading timeout), and `error` (preparation,
harness, or grading failure). Errors and timeouts are not cached; completed grades are reusable.

Implementation evals accept `--rounds N` (default 1, including the initial attempt) and
`--strategy retry|effort|switch` (default retry). Each repetition is one independent trial;
rounds retain candidate edits and stop at a pass, round limit, budget/cancellation, operational
failure, or exhausted strategy. `retry` keeps the target; `effort` starts at an explicit
`model@effort`, otherwise the catalog default or lowest supported level, then advances through
all supported levels (including xhigh/max). Submission rejects effort targets without a higher
level. `switch` freezes the case complexity's implement policy at submission, choosing the first
policy entry at each successively higher tier, independent of health/headroom. Its resolved
chain is part of the multi-round cache key. An unavailable next target stops recovery; it never
skips a tier. Retry/effort resume the session when possible; a failed resume gets one fresh
attempt with identical feedback, recorded as `resumeFailed: true`, with both calls charged.
Each round records its harness; the trial harness follows the last invocation.

Reports show pass@1 (initial passes), and for multi-round trials pass@R (passes by the final
allowed round), recovery (later passes / initially failed trials with a graded recovery), and
recovery **not attempted** separately. Budget/cancel stops and operational failures before any
recovery grade preserve the initial grade and do not count as failed recoveries.
Candidate and grading timeouts during recovery count as attempted, failed recoveries and retain
their timeout evidence. Incremental cost per recovery divides post-initial-round spend across
attempted recoveries by successful recoveries, excluding cached trials; empty denominators are
n/a. Cached grades still contribute
to pass/recovery rates. Single-round reports omit strategy, pass@R and recovery lines.

Hidden commands run with a disposable per-grade HOME/TMPDIR, deleted on every exit. Grading
keeps a private Git checkpoint only when another round is possible, avoiding full worktree
copies. After a failed grade it rebuilds candidate files and modes from that checkpoint, removing
untracked hidden files, commits and artifacts while preserving ignored dependencies and build
outputs. Passing and final rounds need no restoration. Hidden output is never included in
recovery feedback.

## Policy generation and review

`limitless eval policy` reads persisted evidence and effective settings through the daemon API;
it never runs or regrades models. By default it selects the latest **completed** run independently
for each triage/review/verify model, ordered by finishedAt, createdAt, then run ID (descending).
Queued, running, failed and budget-exhausted runs are ignored. `--evals id,id` restricts the pool
before the same selection; empty, unknown or non-completed IDs fail before any files are written.

Configure the daemon in `~/.config/limitless/config.toml`:

```toml
[evals]
delta = 0.10
subscription_weight = 0.25

[evals.floors]
triage_pass_rate = 0.60
implement_pass_rate = 0.60   # per complexity cell (trivial/small/medium); needs roughly k>=3 on 12 cases to clear
triage_risk_under_call_rate = 0.10
review_defect_recall = 0.50
review_clean_false_block_rate = 0.50
verify_false_accept_rate = 0.25

[routing]
exclude_origins = ["CN"] # Optional; omit to apply no origin filter
```

These are the implemented defaults, replacing earlier proposed suite floors. Floors and delta
must be finite numbers in [0,1]; subscription_weight must be finite and nonnegative. Malformed
supplied values fail validation. Floors on quality metrics use the Wilson 95% **lower** bound:
triage requires the pass-rate lower bound at least 0.60 and review requires the defect-recall
lower bound at least 0.50. Ceilings on error metrics use the Wilson 95% **upper**
bound: triage risk under-call at most 0.10, review clean false-block at most 0.50, verify
false-accept at most 0.25. When even zero errors in the available observations could not clear a
ceiling (clearing 0.10 needs 35+ zero-error observations), the candidate is insufficient evidence
rather than ineligible. All comparisons are inclusive. Missing denominators are insufficient
evidence, never zero error. Role metrics retain pooled persisted labels across repetitions and
disclose prediction coverage; failed/invalid calls contribute pass failures without prediction
observations.

Comparisons are recomputed across the selected evidence. The reference has the highest observed
pass rate among models with known catalog/provider metadata that are not origin-excluded (model-ID
ascending tie-break), before floors and cost ordering. Matching role and case ID identify pairs;
each model must have all k scored ok/error observations for a case, though models can have different
k. The existing paired bootstrap uses per-case mean pass differences, seed 20260926 and 10,000
resamples. Non-inferiority requires the one-sided 95% lower bound **strictly greater than -delta**;
no complete paired cases is insufficient evidence. A candidate with any hard rejection (failed floor
or ceiling, failed non-inferiority, origin exclusion, missing catalog/provider metadata or an invalid
recorded cost) is **ineligible**; it is labelled insufficient evidence only when every reason is
missing evidence. A candidate is barred from being the reference by missing catalog/provider
metadata, a recorded provider that differs from the catalog, an origin exclusion, a recorded-effort
problem (unknown, unsupported, or no longer the model's default), review grades from before
blocking recall, or having no valid prediction at all (every trial errored, was skipped or is
unscored); a candidate that fails a floor, ceiling or cost check can still be the reference. When
every candidate is barred there is no reference, and candidates are not additionally flagged for
missing paired cases. Reusing a case ID after substantive dataset
changes can invalidate historical comparisons; dataset fingerprints are not backfilled.

Routing cost per case is averaged over **case attempts**, including attempted failures, excluding
unattempted skips and preparation failures. Repetitions count as separate attempts, not one
production invocation costing k times as much. Provider definitions determine billing: free/local
costs zero, metered uses recorded dollars, subscription uses recorded API-equivalent dollars times
subscription_weight. Cache replays use retained original cost provenance for this estimate only;
actual recorded eval spend is unchanged. Missing applicable estimates make a candidate ineligible.
p50 invocation latency retains the existing exclusion of cache replays, interrupted calls and
preparation failures; unavailable latency sorts after known latency at equal cost.

When exclude_origins is configured (even an empty array), a candidate is excluded if its origin or
baseOrigin is listed, or baseOrigin is `unknown`. The evidence still lists it with its rejection
reason. Hosting location does not determine origin. This filter affects generation and the matrix;
it does not change existing runtime escalation or unrelated routing cells.

Eligible models clear every required floor, establish non-inferiority, and have catalog/provider
metadata and applicable cost estimates. They sort by routing cost/case, then p50 latency, then model
ID. Each becomes a singleton preference group: the first is preferred and later entries are fallbacks.
A role with no eligible candidate is left unchanged with an explanation that lists each
candidate's rejection reasons (e.g. `risk under-call upper bound 0.2611 exceeds ceiling 0.1` for 5
under-calls in 40 observations, or `pass rate lower bound 0.5981 is below floor 0.6` for 30 passes
in 40 trials). Only supported **default**
cells are generated: current evidence does not justify replacing review.large, verify.large or other
complexity-specific cells.

Without `--write`, the CLI prints a deterministic diff against the daemon's current effective policy.
With `--write`, it creates/updates `routing/policy.json` and `routing/EVIDENCE.md` in the current checkout.
Existing unrelated overrides and roles without eligible evidence survive regeneration; the preview
uses exactly the proposed document. `policy.json` is a partial Policy-shaped object (no evidence
metadata or expanded defaults). `EVIDENCE.md` records all candidates, source IDs/stored dates,
metrics/intervals/denominators, paired coverage, settings, costs, latency and rejection reasons.

At startup the daemon reads `routing/policy.json` relative to its application checkout, overlays only
present cells on DEFAULT_POLICY, and exposes that exact policy through `/api/models`. Missing files
retain defaults. Strict validation rejects malformed JSON, unknown roles/cells/models, empty groups
and invalid pipe syntax, reporting the path and diagnostics. Existing `model-a|model-b` interchangeable
groups are supported. A changed file does not hot-reload the daemon. Policy changes land through
reviewed PRs: **the diff is the approval**, and deployment/restart activates the overlay.

The UI **Evals** page lists all runs with separate metered/API-equivalent totals and links to model
metrics and per-case/per-repetition trials. Its matrix uses the same generator under current daemon
settings, including catalog models absent from DEFAULT_POLICY. It labels eligible, ineligible,
insufficient evidence and no result, exposes reasons, and links results to source runs. Run detail
comparisons are within that run; matrix comparisons use selected evidence across runs.
