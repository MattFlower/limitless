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
| review | 30 | 12 seeded defects, 8 real defects our gates caught, 10 clean merged diffs | location + category match on the JSON verdict | recall (≥0.6) and false-block rate on clean diffs (≤0.2) |
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
   See [operations](OPERATIONS.md#triage-evaluations) for commands and metric/accounting semantics.
   **Pending:** review and verify graders, other role graders, and the UI "Evals" matrix. Policy
   generation and real-model sweeps remain follow-up work; this does not complete all of step 1.
2. **Agentic evals** (factory run): implement and holdout cases in worktrees; early stopping.
3. **Datasets** (orchestrator-curated, factory-assisted): gold labels are written or checked by the
   orchestrator, never by a candidate model alone.
4. **Sweep + policy**: run the sweep, generate `routing/policy.json`, review the PR, deploy.
5. **Exit demo**: a Dependabot PR on `limitless-sandbox` handled end-to-end on local models for $0.
6. **Afterwards**: production outcomes (gate/review/verify results, merges, reverts) update per-cell
   estimates; a drifting cell triggers a re-eval of that cell only.
