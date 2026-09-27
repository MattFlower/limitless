# Reasoning effort as a routing dimension

Routing targets are resolved `(catalog model ID, effort)` pairs. Catalog IDs and backend
model names remain unchanged; qualified references identify a particular selection.
Orchestration remains deterministic.

## Selecting targets

Use bare IDs or `model@effort` in every routing policy cell and in eval `--models`:

```json
{
  "triage": { "default": ["codex/luna@low|claude/opus@high", "mtplx/qwen-27b@none"] },
  "review": { "large": ["codex/astra@high", "claude/opus@high"] }
}
```

```sh
limitless eval run triage --models codex/luna@low,codex/luna@high --k 2 --follow
limitless eval policy
limitless eval policy --write
bun run smoke --models claude/sonnet@high,codex/luna@low
```

`POST /api/evals` accepts the same references in `models`. The shared resolver rejects
unknown models, unsupported efforts, empty components, multiple `@` separators, and
surrounding whitespace. Pipe groups remain interchangeable candidates ordered by
provider preference and quota headroom. Overlay merging and cell order are unchanged.

The Models page lists `supportedEfforts` and the optional `effort` default. An empty set
means explicit control is unavailable; it does not mean the backend performs no reasoning.
Catalog defaults must belong to the supported set. The existing four Codex defaults
remain Astra high, Sol medium, Luna medium and Sol 5.6 medium. Models without a configured
default leave the backend setting unset.

A bare ID and its explicit catalog default are the same target. Routing deduplicates
them; eval submissions reject duplicate resolved targets before scheduling.
Explicit `none` is distinct from unset effort. No automatic effort sweep is performed.

## Execution and fallback

The router copies the selected effort into a fresh `ModelTarget`; it never edits catalog
defaults. Exclusions, preference, implementer state and fallback diagnostics retain the
pair. Quota, health, concurrency, model blocking, vendor and tier checks still apply to
the underlying provider/model. Tier escalation adds remaining catalog defaults.

Native Claude uses `--effort VALUE`; Codex uses `-c model_reasoning_effort="VALUE"`.
Direct HTTP chooses exactly one mapping:

| Transport | Request field |
|---|---|
| OpenRouter | `reasoning: { effort: VALUE }` |
| Other compatible OpenAI HTTP endpoint | `reasoning_effort: VALUE` |
| Local Qwen | `chat_template_kwargs: { enable_thinking: BOOLEAN }` |

For local Qwen, `none` disables thinking; any other declared effort enables it.
These values do not represent separate numeric thinking budgets. HTTP structured-output
repair requests retain the same mapping. Unset effort omits all effort fields.

Explicit effort on Claude's third-party Anthropic-compatible transport is rejected:
its CLI flag is not a substitute for an HTTP thinking field. Use a supported native
CLI target or direct HTTP tool-free roles for those selections. HTTP requests with
selected effort but no explicit mapping are rejected before transport.

## Stored evidence and displays

Migration 10 appends nullable invocation effort and rebuilds eval-trial uniqueness as
`(run, case, base model, repetition, effort)`, including one null-effort row per tuple.
It preserves legacy rows with null effort. Creation, updates, API responses and invocation
SSE events retain the recorded value, including failures and cancellations.

Eval submission resolves defaults immediately and persists them in both run references
and trial effort. Execution uses the saved trial value, including a saved unset value.
Skipped trials and cache hits retain it. A removed supported setting is skipped explicitly.
Cache identity includes effort alongside model, harness, prompt, system prompt, schema,
repetition and repository inputs. New cache keys cannot hit old unknown-effort entries.

Statistics and policy generation group evidence by role and recorded pair. Newest
completed evidence is chosen independently for each pair. Existing statistical floors,
paired comparisons, origin exclusions, billing weights and cost/latency ordering still
apply. Generated references include every explicitly recorded effort and validate as
normal routing policy. Historical unknown effort cannot qualify an explicit effort
candidate; unsupported historical values are ineligible.

Run details, pipeline report rows, Models, eval reports, trial details and eligibility
matrices show effort. Null records display `unknown / unset`, never today's default.
Separate effort candidates have separate metrics and links to their selected evidence.

Automated tests use fake harnesses and mocked/local HTTP responses. The explicit smoke
command exercises real native CLIs and spends quota; unavailable CLI checks are failures
or skips, not proof of effort delivery.
