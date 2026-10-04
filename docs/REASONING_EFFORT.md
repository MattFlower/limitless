# Reasoning effort as a routing dimension

Routing targets are resolved `(catalog model ID, effort)` pairs. Catalog IDs and backend
model names remain unchanged; qualified references identify a particular selection.
Orchestration remains deterministic.

## Selecting targets

Use bare IDs or `model@effort` in every routing policy cell and in eval `--models`:

```json
{
  "triage": { "default": ["codex/luna@low|claude/opus@high", "mtplx/qwen-27b@none"] },
  "review": { "large": ["codex/sol-6.1@high", "claude/opus@high"] }
}
```

```sh
limitless eval run triage --models codex/luna@low,codex/luna@high --k 2 --follow
limitless eval policy
limitless eval policy --write
bun run smoke --models claude/sonnet-5.5@high,codex/luna@low
```

`POST /api/evals` accepts the same references in `models`. The shared resolver rejects
unknown models, unsupported efforts, empty components, multiple `@` separators, and
surrounding whitespace. Pipe groups remain interchangeable candidates ordered by
provider preference and quota headroom. Overlay merging and cell order are unchanged.

The Models page lists `supportedEfforts` and the optional `effort` default. An empty set
means explicit control is unavailable; it does not mean the backend performs no reasoning.
Catalog defaults must belong to the supported set. The Codex defaults are Sol 6.1, Sol,
Luna and Sol 5.6, all at medium. Models without a configured default leave the backend
setting unset.

A bare ID and its explicit catalog default are the same target. Routing deduplicates
them; eval submissions reject duplicate resolved targets before scheduling, and report
every invalid reference in the list in a single error rather than only the first.
Explicit `none` is distinct from unset effort. No automatic effort sweep is performed.

## Execution and fallback

The router copies the selected effort into a fresh `ModelTarget`; it never edits catalog
defaults. Exclusions, preference, implementer state and fallback diagnostics retain the
pair. Quota, health, concurrency, model blocking, vendor and tier checks still apply to
the underlying provider/model. Tier escalation adds remaining catalog defaults.

Native Claude uses `--effort VALUE`; Codex uses `-c model_reasoning_effort="VALUE"`. Both
CLI harnesses transmit the resolved value verbatim (including `none`); which values a model
accepts is decided solely by its catalog `supportedEfforts`. Direct HTTP chooses exactly one
mapping:

| Transport | Request field |
|---|---|
| OpenRouter | `reasoning: { effort: VALUE }` |
| Other compatible OpenAI HTTP endpoint | `reasoning_effort: VALUE` |
| Local Qwen | `chat_template_kwargs: { enable_thinking: BOOLEAN }` |

For local Qwen, `none` disables thinking; any other declared effort enables it.
These values do not represent separate numeric thinking budgets. HTTP structured-output
repair requests retain the same mapping. Unset effort omits all effort fields.

Effort support therefore depends on the role as well as the model. Providers reached
through the Claude CLI's Anthropic-compatible backend (OpenRouter, mtplx, twilight) only
carry effort in the tool-free roles (triage, chat, summarize), which run over direct HTTP.
In every other role an effort-qualified reference for them (e.g. `review:
openrouter/gpt-6-luna@low`, `implement: mtplx/qwen-27b@none`) is rejected up front:
`validatePolicy` fails, eval submission fails, the router skips it with a diagnostic, and
policy generation marks such evidence ineligible. Bare IDs remain valid there. HTTP
requests with selected effort but no explicit mapping are rejected before transport.

## Stored evidence and displays

Migration 10 appends nullable invocation effort and rebuilds eval-trial uniqueness as
`(run, case, base model, repetition, effort)`, including one null-effort row per tuple.
It preserves legacy rows with null effort, which means "unknown". New rows always record
the resolved value; a deliberately unset effort is stored as `default` (the backend
default), so it never collides with legacy rows. Creation, updates, API responses and invocation
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
normal routing policy. Evidence recorded as `default` qualifies the bare ID, unless the
catalog has since gained a default effort (the bare ID would now mean something else).
Legacy evidence with unknown (null) effort never qualifies; unsupported historical values
and efforts the role's transport cannot deliver are ineligible.

Run details, pipeline report rows, Models, eval reports, trial details and eligibility
matrices show effort. `default` records display `backend default`; legacy null records
display `unknown (legacy)`, never today's default.
Separate effort candidates have separate metrics and links to their selected evidence.

Automated tests use fake harnesses and mocked/local HTTP responses. The explicit smoke
command exercises real native CLIs and spends quota; unavailable CLI checks are failures
or skips, not proof of effort delivery.
