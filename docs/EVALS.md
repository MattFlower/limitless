# Evals and routing calibration (M4 design)

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
  required Wilson 95% bounds clear the role's floors **and** that is non-inferior to the best model
  within δ = 0.10; the fallback chain lists other eligible models by ascending cost. Complexity-specific
  cells remain unchanged. Output is `routing/policy.json` (loaded over `DEFAULT_POLICY`)
  plus `routing/EVIDENCE.md` with the numbers behind every cell. **Policy changes land as a PR**,
  so the diff is the approval step and git is the version history.
- **Cost of evals** is tracked like any run's: subscription-equivalent and metered dollars per
  trial, with `--max-usd` for metered spend.

## Suite v1

| Role | Cases | Source | Grader | Primary metric (floor) |
|---|---|---|---|---|
| triage | 40 | own run prompts + boundary cases | exact match per field, cost-weighted | pass-rate lower bound ≥0.60; risk under-call upper bound ≤0.10 |
| review | 30 | 12 seeded defects, 8 real defects our gates caught, 10 clean merged diffs | file + line-window match on the JSON verdict | defect-recall lower bound ≥0.50; clean false-block upper bound ≤0.34 |
| verify | 20 | labeled (criteria, diff, test output) triples, incl. "tests pass, criterion unmet" | per-criterion match | false-accept upper bound ≤0.10 |
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

The supported roles are `triage`, `review`, and `verify`. Review reads the committed
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
since `git show` would still read them; pick pins from before the datasets were committed.

The candidate receives the pipeline prompt, FACTORY_PREAMBLE, role schema, read-only agent
harness, and normal inputs only: labels, source/foundBy annotations and patch files are never
copied into the worktree or prompt. Review recomputes diff statistics and audit findings using
the gate configuration (protected paths, gate script names) detected at base, as the pipeline
does before implementation, compared against the scripts at the effective HEAD; null task class and no historical commands. Blocking gates or
audit flags do not bypass the eval invocation. Review and verify retain the pipeline's scaled
20/25-minute reading timeouts, 10-minute idle timeout, 150-tool limit and verify private sessions.

### Grading and reporting

- Review matches only blocker/major/minor findings on the same file (leading `./` normalized)
  with positive lines in `[start-5,end+5]`, inclusive. Line 0 matches by file only for completeness
  defects, even when a numeric window includes zero. Severity equality, category equality and
  text similarity are not required. Duplicate findings count a required defect only once.
- Real and seeded cases pass when every required defect matches and the returned verdict is
  `request_changes`. Clean cases pass when the verdict is `approve` and there are no blocker or
  major findings. Optional defects never create misses or separate false positives; the clean
  false-block rule still applies. The production verdict override is deliberately not applied.
- Review reports pooled matched/required defects with a Wilson 95% interval, false blocks/clean
  predictions, and correct verdicts/valid predictions. Zero required defects gives null recall.
- Verify scores only gold IDs. A single binary status must match exactly; missing, unclear and
  duplicate entries are inconclusive and match neither label. False accepts are gold unmet with
  predicted met, divided by gold-unmet observations. False rejects are gold met without an
  unambiguous met, divided by gold-met observations. Per-criterion accuracy is matches/labels;
  pass requires every label to match, independently of overall. Stored details explain each ID.
- Metrics pool labels across repetitions instead of averaging case recalls. Failed/invalid calls
  count as pass failures but have no prediction-dependent observations. Reports disclose valid
  prediction coverage, explicit numerators/denominators, null (`n/a`) for empty denominators,
  skips, errors, cache hits, costs and invocation latency. Grades are persisted in existing trial
  JSON so label edits cannot rewrite historical reports.

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
triage_risk_under_call_rate = 0.10
review_defect_recall = 0.50
review_clean_false_block_rate = 0.34
verify_false_accept_rate = 0.10

[routing]
exclude_origins = ["CN"] # Optional; omit to apply no origin filter
```

These are the implemented defaults, replacing earlier proposed suite floors. Floors and delta
must be finite numbers in [0,1]; subscription_weight must be finite and nonnegative. Malformed
supplied values fail validation. Triage requires the pass-rate **lower** Wilson 95% bound at least
0.60 and risk-under-call **upper** bound at most 0.10. Review requires defect-recall lower bound at
least 0.50 and clean false-block upper bound at most 0.34. Verify requires false-accept upper bound
at most 0.10. Floor comparisons are inclusive. Missing denominators are insufficient evidence,
never zero error. Role metrics retain pooled persisted labels across repetitions and disclose
prediction coverage; failed/invalid calls contribute pass failures without prediction observations.

Comparisons are recomputed across the selected evidence. The reference has the highest observed
pass rate among models with known catalog/provider metadata that are not origin-excluded (model-ID
ascending tie-break), before floors and cost ordering. Matching role and case ID identify pairs;
each model must have all k scored ok/error observations for a case, though models can have different
k. The existing paired bootstrap uses per-case mean pass differences, seed 20260926 and 10,000
resamples. Non-inferiority requires the one-sided 95% lower bound **strictly greater than -delta**;
no complete paired cases is insufficient evidence. Reusing a case ID after substantive dataset
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
A role with no eligible candidate is left unchanged with an explanation. Only supported **default**
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
