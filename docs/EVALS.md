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
- **Stats**: Wilson intervals for pass rates; paired bootstrap (or McNemar mid-p for k=1) against
  the best model in the cell.
- **Policy generator** (pure): for each (role × complexity) cell, choose the cheapest model whose
  lower 95% bound clears the role's absolute floor **and** that is non-inferior to the best model
  within δ = 0.10; the fallback chain lists other passing models by ascending cost; high-risk work
  keeps the top tier regardless. Output is `routing/policy.json` (loaded over `DEFAULT_POLICY`)
  plus `routing/EVIDENCE.md` with the numbers behind every cell. **Policy changes land as a PR**,
  so the diff is the approval step and git is the version history.
- **Cost of evals** is tracked like any run's: subscription-equivalent and metered dollars per
  trial, with `--max-usd` for metered spend.

## Suite v1

| Role | Cases | Source | Grader | Primary metric (floor) |
|---|---|---|---|---|
| triage | 40 | own run prompts + boundary cases | exact match per field, cost-weighted | weighted accuracy; risk under-call rate (≤5%) |
| review | 30 | 12 seeded defects, 8 real defects our gates caught, 10 clean merged diffs | file + line-window match on the JSON verdict | recall (≥0.6) and false-block rate on clean diffs (≤0.2) |
| verify | 20 | labeled (criteria, diff, test output) triples, incl. "tests pass, criterion unmet" | per-criterion match | false-accept rate (≤0.1) |
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
   **Pending:** other role graders and the UI "Evals" matrix. Policy
   generation and real-model sweeps remain follow-up work; this does not complete all of step 1.
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

The candidate receives the pipeline prompt, FACTORY_PREAMBLE, role schema, read-only agent
harness, and normal inputs only: labels, source/foundBy annotations and patch files are never
copied into the worktree or prompt. Review recomputes diff statistics and audit findings using
repository gate configuration, null task class and no historical commands. Blocking gates or
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
restriction or routing-policy change is implemented.

```sh
limitless eval run review --models openrouter/gpt-6-luna --follow
# After curating the real verify dataset:
limitless eval run verify --models openrouter/gpt-6-luna --k 2 --max-usd 1 --follow
```
