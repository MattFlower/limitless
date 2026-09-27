# Reasoning effort as a routing dimension

Status: specification for a subsequent implementation. This document does not enable
effort-qualified routing or change model defaults. Implementation tests and live smoke
checks below are acceptance gates for that subsequent change.

## Scope and existing behavior

A routing target will be a resolved `(catalog model ID, effort)` pair. Operators can
select pairs per role and evaluate their measured quality, cost and latency independently.
Existing bare model IDs remain valid. Orchestration remains deterministic.

The current implementation has these boundaries:

- `src/router/catalog.ts` has optional, unvalidated `ModelDef.effort` strings. The four
  configured defaults are `codex/astra=high`, `codex/sol=medium`, `codex/luna=medium`,
  and `codex/sol-5.6=medium`. Preserve them and all existing prices, tiers and ordering.
- `Router.toTarget` copies the default, but routing identity, exclusions and implementer
  preference use only the base model ID. Policy validation only accepts base IDs.
- Claude and Codex already pass target effort to their CLIs. `runLlm` currently omits
  effort from both initial and structured-output repair HTTP requests.
- Eval submission stores string model IDs; execution resolves catalog defaults later.
  Summaries and policy evidence are grouped by base ID. Cache keys omit effort.
- Migration 8 introduced evals; migration 9 is the current last migration. Trial primary
  keys are `(eval_run_id, case_id, model_id, trial)` and cannot store multiple efforts.
- Invocation records and eval trials have no effort fields. Reports and UI cannot
  reconstruct what was selected. Historical values must remain unknown.

## Shared contract and identity

Put shared effort and resolved-selection types in `src/core/types.ts`, without runtime
imports. Narrow executable effort to a string-literal union of backend-supported values;
do not accept arbitrary strings as executable settings. Include `none` as a real value.
Keep `ModelDef.effort` as the optional default and add required `supportedEfforts`, including
`[]` for models without explicit control. Validate catalogs: unique supported values,
known effort literals, and any default present in that model's supported set.

Effort support must be transport-aware. Declare explicit capability metadata for each
model's applicable CLI and HTTP transports, including the allowed efforts and HTTP mapping.
The model-level supported set is the union of verified transport sets; resolving a role
must additionally validate against the transport selected by `selectHarness`. A model
supporting effort through HTTP does not thereby support it through the Claude proxy.
Verify backend/CLI contracts before filling these sets; do not derive support from model
family names, leaderboard claims, arbitrary URLs or another provider's version of a model.
Unverified explicit controls remain unsupported. Catalog validation also ensures that a
configured default works on every enabled transport used by that model.

Add one shared pure module, `src/router/targets.ts`, for reference parsing, catalog
resolution, canonical formatting and identity. Policy, routing, CLI/API eval validation,
reports and UI must use its contracts rather than their own splitting/default rules.

| Value | Meaning |
|---|---|
| `modelId` | Unchanged base catalog ID, for example `codex/luna` |
| `model` | Unchanged backend name, for example `gpt-6-luna` |
| `effort` | Selected literal, or null for an explicitly resolved backend default |
| `targetId` | Canonical executable reference: `modelId@effort`, or bare ID when unset |
| `effortResolved` | True for new resolved selections; false for historical unknown effort |

`ModelTarget` carries the resolved selection plus existing provider/backend metadata.
The harness may represent unset effort with an optional property, but the persistence
boundary uses explicit null. Never modify a shared `ModelDef` to construct a target.
Historical stored effort is nullable text, decoded without coercing an unrecognized value
to the executable union. Reading and displaying history does not require current support.

Parsing rules:

1. Accept exactly `model` or `model@effort`, with nonempty components and no surrounding
   whitespace on the reference or either component. Do not silently trim inputs.
2. Reject multiple `@` separators, unknown model IDs, unknown literals, and efforts absent
   from the model's supported set. Transport validation follows catalog resolution.
3. Resolve a bare ID to its configured default once; if no default exists, resolve to
   unset. Explicit `none` never means unset and never requests a default.
4. Always format a selected non-null effort with `@`, even if it matches today's default.
   A bare ID and its explicit configured default have the same target identity.
5. Report the invalid reference, location (policy role/cell or eval list index), reason,
   and supported alternatives. A no-control model should say to use its bare ID.

Examples with the preserved Luna default: `codex/luna` and `codex/luna@medium` are the
same target; `codex/luna@low` is different when low is supported. Reject `codex/luna@`,
`@low`, `codex/luna@low@high`, ` codex/luna`, `codex/luna@ low`, and unknown IDs.

Use a deterministic internal key encoding `[modelId, effortResolved, effort]` for persisted
and historical identity. The provenance bit separates legacy unknown from newly resolved
unset; neither collides with explicit `none`. Historical labels such as “unknown” are
display text, never executable `@unknown` references.

## Routing and pipeline state

`src/router/policy.ts` validates every pipe-separated member with the shared resolver.
Keep strict role/cell validation, overlay merging and array ordering. For example:

```json
{"review":{"default":["codex/luna@low|claude/opus@high","codex/sol"]}}
```

Resolve references before deduplication. Preserve first-occurrence ordering across groups
and existing headroom/provider preference within interchangeable groups. Distinct efforts
survive deduplication; bare/default aliases collapse. Catalog candidates added for tier
escalation resolve their default once rather than enumerating all supported efforts.

Separate target eligibility from model eligibility:

- Attempt exclusions, retry state, preferred implementer and fallback diagnostics carry
  exact target identity. Failing low does not itself exclude high for the same model.
- Provider health, quotas, reserves, budget and concurrency still use the provider ID.
  Model blocking uses base catalog ID and blocks every effort variant. Existing vendor
  avoidance and tier rules remain in force before a preference can move a candidate.
- Transport incompatibility is an explicit skipped-candidate reason. Never retry a target
  without its effort just to make it executable. Preserve effort across bounded retries.
- Fallback logs identify attempted/skipped pairs as well as the eligible providers.

Update `src/pipeline/context.ts` and `engine.ts` to persist the implementer's base model,
resolved effort/provenance and tried target identities in run state. Reloading a newly
saved preference reconstructs that exact selection, including unset, without resolving
today's default again. If support disappears, explain the rejection and route normally.
Read older `{modelId,tier,vendor}` state and bare tried-model arrays compatibly: treat the
old preferred ID as a bare reference for the next selection and conservatively preserve
old tried-model exclusions across all its efforts. Do not backfill historical invocations.

## Harness transport contract

Select the mapping explicitly from validated transport metadata. Build effort parameters
once and use the same parameters on every request, including HTTP repair attempts.

| Transport | Explicit selected effort | Unset |
|---|---|---|
| Claude CLI | `--effort <value>` | Omit flag |
| Codex CLI | `-c model_reasoning_effort="<value>"` | Omit override |
| OpenRouter HTTP | `reasoning: { effort: value }` | Omit reasoning field |
| Compatible generic HTTP | `reasoning_effort: value` | Omit field |
| Verified local Qwen HTTP | `chat_template_kwargs: { enable_thinking: value !== "none" }` | Omit thinking override |

Each supported explicit `none` is sent literally for the first four mappings. For local
Qwen, none disables thinking and all other supported values enable thinking; the labels
do not promise distinct thinking budgets. Even when two labels map to true, their selected
identities remain separate. Never send conflicting effort fields. Validate before spawning
or fetching; unsupported combinations produce a useful error with no paid call.

Keep current role-based harness selection. In particular, triage/chat/summarize may use
direct HTTP, while review/verify use an agent CLI. Do not add an HTTP agent or infer that
local Qwen's HTTP thinking control works through an Anthropic-compatible CLI proxy.

## Persistence, submission and cache

Append migration 10 (or the next version if migrations advance before implementation).
Do not edit migrations 1–9. Apply the following atomically:

- Add nullable `effort` and `effort_resolved INTEGER NOT NULL DEFAULT 0` to invocations.
  New invocations explicitly write the selected value and true before harness execution.
- Add nullable `targets_json` to eval runs containing an ordered, versioned snapshot of
  resolved selections. Null denotes legacy runs. Retain `models` for compatible API
  display as canonical references; execution uses snapshots and trial selections.
- Rebuild `eval_trials` with nullable effort, the same provenance flag and a non-null
  `target_key`. Use primary key `(eval_run_id, case_id, target_key, trial)`. A nullable
  effort column alone is not a safe uniqueness key because SQLite permits duplicate nulls.
- Copy every old trial with null effort, false provenance and its legacy identity key;
  preserve data, row ordering used by cache tie-breaking, foreign keys and cache index.
  Preserve old run selections without deriving defaults from the catalog.

Use explicit SQL insert columns in Store. Update trial upsert conflict targets, all readers,
invocation insert/update paths and exported types. Effort is immutable selection metadata;
status updates, cancellation, failures, preparation errors, skips and cache replays retain
it. Invocation API responses and Store invocation SSE messages include effort/provenance
on initial and terminal events. No event should require guessing from today's catalog.

For `eval --models` and `POST /api/evals`, resolve the complete list through the shared
resolver and reject semantic duplicates before creating a run or scheduling any work.
Comma splitting in the CLI must not trim away invalid whitespace or discard empty entries.
The daemon is authoritative for catalog and transport support. Store the run snapshot and
queued trials in the existing single creation transaction, including effort on skipped trials.

Execution looks up metadata using the trial's base `modelId`, then applies its saved effort.
Keep scheduling streams grouped by provider and preserve shared capacity accounting.
Do not execute each effort's trials once per occurrence of the same base model in the list.
New snapshots survive later catalog default changes, including unset becoming configured.
Reject a saved selection that is no longer supported rather than silently substituting one.
Legacy interrupted evals retain existing recovery behavior; do not automatically rerun them.

Version the cache payload and include resolved selection identity and effort mapping alongside
all existing model, harness, prompt, system prompt, schema, repetition and repository inputs.
Canonical bare/default references share a key; low/high/none/unset do not. Never fall back to
legacy effort-free hashes. Historical unknown cache entries remain readable but cannot serve
new selections. Keep existing gold-only regrading, cost provenance and actual-spend accounting.

## Evidence and policy generation

Update `stats.ts`, `format.ts`, `policy.ts` and `evidence.ts` to group by role and recorded
target identity. Filter trials, complete-case pairing and comparisons by that identity.
Two efforts in one run have separate counts, errors, costs, latency, coverage and summaries.
Use base IDs only for catalog/provider/origin metadata lookup.

Select the newest completed run independently for each role/pair, using the existing
finishedAt, createdAt and run-ID tie-breakers. A newer high run must not replace older low
evidence. Preserve explicit eval-ID validation, statistical floors/ceilings, paired bootstrap,
delta, origin exclusions, cost weighting and missing-evidence behavior. The executable
statistical rules in `src/evals/policy.ts` are the baseline; this task does not resolve
pre-existing differences between narrative docs and the implemented ceiling calculation.

Eligible pairs retain cost-per-attempt, then p50 latency ordering, with canonical target ID
as the final deterministic tie-break. Reference selection likewise breaks equal pass rates
by target ID. Emit qualified references for every recorded non-null effort, including defaults
and none. Validate generated overlays with normal `validatePolicy` and the role's transport
capabilities before writing; retain unrelated and complexity-specific cells as today.

Historical unknown or unsupported effort remains visible with its source and exclusion
reason, but cannot become a reference or eligible generated candidate. It must not be merged
with a current default. Newly resolved unset evidence can generate a bare reference only
while that model still has no configured default; otherwise bare syntax would select a
different effort. Mark such evidence ineligible with “backend default selection cannot be
represented by current policy” rather than relabeling it. Removed models remain readable.

## Operator surfaces and documentation

- `InvocationsTable`, run details and pipeline report invocation rows show recorded effort:
  `low`, `high`, `none`, `backend default (unset)`, or `unknown (historical)`. Adjust table
  headers/empty-state colspan if adding a column. Never fill historical null from catalog.
- Models shows each model's supported efforts, transport restrictions and configured default
  or “backend default”; an empty set says explicit effort is unsupported. Qualified policy
  entries remain visibly distinct while metadata lookup uses their base IDs.
- Eval lists, reports, trial rows, evidence markdown and the eligibility matrix use separate
  targets and metrics. Build matrix columns from selected evidence plus default catalog
  targets, without pretending every supported effort was evaluated. Distinguish no result,
  unknown and unsupported history, and keep each pair's link to its actual evidence run.
- Update `docs/OPERATIONS.md`, `docs/EVALS.md`, relevant architecture text and CLI help in
  the implementation change. Describe default snapshotting, supported-effort validation,
  transport restrictions, historical labels and local Qwen thinking semantics.

Proposed examples for that documentation (not enabled by this specification):

```sh
limitless eval run triage --models codex/luna@low,codex/luna@high --k 2 --follow
limitless eval run review --models claude/opus@high,codex/sol@medium --follow
limitless eval run triage --models mtplx/qwen-27b@none --follow
```

Examples require those efforts to be verified and declared for the selected transport.
Submitting `codex/luna,codex/luna@medium` is an error with the preserved medium default.

## Acceptance and implementation sequence

Implement the shared contract first, followed by migration/Store and saved selections,
routing/harness propagation, eval statistics/policy, then presentation and operator docs.
Each step must retain bare-ID compatibility. Add focused regression tests rather than
changing existing expectations solely to accommodate broken behavior.

| Gate | Required regression coverage |
|---|---|
| AC-1 | Table-driven policy, cases, CLI and HTTP tests: bare/default equivalence, supported explicit effort and none, no-control model, unknown model, empty components, extra separators, whitespace and semantic duplicate rejection before scheduling. |
| AC-2 | Router and fake pipeline tests: same model at two efforts; group order, deduplication, pair exclusions, exact preference after Store/state reload, retries, eligibility controls across both variants, immutable catalog defaults and escalation defaults. |
| AC-3 | Captured Claude/Codex spawn arguments and mocked HTTP bodies: selected/none/unset, all three HTTP mappings, no conflicting fields, both repair paths, and unsupported transport errors before I/O. |
| AC-4 | Build a database with migrations 1–9 and real legacy invocation/trial rows, apply the new migration, reopen, compare old data and ordering, persist two efforts at the same case/repetition, upsert only one, check null uniqueness, API and initial/terminal SSE values. |
| AC-5 | Fake eval harness records target effort: both variants execute once per case/repetition with independent summaries; cache hit for bare/default aliases, misses across efforts and legacy unknown, stable saved defaults/unset after catalog changes, retained values on skips/errors/cancellation/cache hits. |
| AC-6 | Selection/policy tests across different completed runs: latest evidence independently per pair, independent quality/cost/latency, unchanged comparisons and deterministic ordering, qualified validated overlays, excluded unknown/unsupported/unrepresentable unset history. |
| AC-7 | Render report, Models, Evals and focused invocation-table fixtures containing low/high/none/null: visible support/defaults, honest historical labels, separate matrix cells and correct source links. |
| AC-8 | Repository checks and UI build pass; live Claude/Codex selected-effort checks run if their delivery paths change, with unavailable/skipped checks disclosed separately. |

Run focused tests during implementation:

```sh
bun test test/routing-policy.test.ts test/evals-cases.test.ts test/evals-cli.test.ts test/evals-http.test.ts
bun test test/router.test.ts test/pipeline.test.ts test/harness.test.ts test/llm.test.ts
bun test test/evals-store.test.ts test/evals-runner.test.ts test/evals-stats.test.ts
bun test test/evals-selection.test.ts test/evals-policy.test.ts
bun test test/report.test.ts test/models-page.test.ts test/evals-page.test.ts
bun run check
bun run build:ui
```

Also run new focused migration/invocation rendering/API/SSE tests with the complete suite.
Unit/integration tests use fake harnesses, captured spawns and mocked fetches: no real models,
network or `gh`. For the subsequent implementation, extend `scripts/smoke.ts` as needed to
exercise explicit supported selections through the production resolver and real Claude/Codex
adapters, then run `bun run smoke`. Report the exact selected pair, installed CLI and outcome;
a successful bare-model check or skipped CLI is not evidence of explicit-effort delivery.

## Non-goals

No new eval roles/graders, statistical algorithms, automatic effort sweeps, dynamic per-call
effort adaptation, HTTP agent harness, provider proxy or local server configuration system.
No effort-based prices, assumed quality-driven tier/order changes, dashboard redesign,
historical backfill or automatic reevaluation. Implementation and quota-spending validation
are deliberately left to the subsequent task.
