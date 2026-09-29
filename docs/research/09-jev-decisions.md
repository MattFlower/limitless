<!-- Research note produced by a research subagent on 2026-09-28 and checked against the primary docs by the author. -->

# Jev decisions API: direct TypeSafe access (2026-09-28)

Context: issue #32. Jev (TypeSafe AI, Inc.) is a *decision* model: it answers typed questions about a
`state` with probability distributions instead of generating text. We call TypeSafe's own API
directly; OpenRouter also resells it (last section).

## API

| | |
|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` [1][2] |
| Auth | `Authorization: Bearer <key>` (OpenAPI scheme `HTTPBearer`) [1][6]. The SDKs read `TYPESAFE_API_KEY`; we load the key from `secrets.env` [3]. |
| Other paths | `GET /v1/models` (lists aliases only) [5]; `GET /openapi.json` (spec v0.2.0) [6]. No balance/usage endpoint is documented. |

**Request** [1][6]: exactly `state` (string, object or array; ≤ 32K tokens together with the longest
question), `model`, and `questions`, a map from our own id to a question. The id is never shown to the
model, so the full question goes in `instructions` [1][9].

| Type | `criteria` | Answer |
|---|---|---|
| `choice` | required map option → description (≤ 255 options) | `{choice, probabilities, confidence}`; `choice` is the argmax [1] |
| `score` | required ordered array of level descriptions (2–10 levels; index = level) | `{score, legend, probabilities, confidence}`; `score` is the probability-weighted *expectation*, may be fractional; "round it to the nearest level when your code needs one outcome" [1][11] |
| `noul` | optional `{true, false}` descriptions | `{noul}` = P(true) in [0,1]. **No confidence** [1][10] |

**Response** [1][6]: `{model, answers, usage}`. `model` is the versioned id that answered
(e.g. `jev-1.13.0`); `answers` is keyed by our ids with a `type` discriminator; `usage` is
`{input_tokens, output_tokens}`. There is **no cost field**: cost = input tokens × price.

**Confidence** is "a statistic computed from the probability distribution" of choice/score answers.
Thresholds should depend on the cost of a wrong action; the docs' example treats < 0.5 as genuine
uncertainty and asks for ≥ 0.9 on high-stakes actions. Noul and choice thresholds are not
interchangeable, and P(q) + P(¬q) ≠ 1 for nouls [10][12].

**Errors** [1][7]: 401 missing/invalid key (a missing key actually returned 403 with
`detail.error_type = "authentication_error"` in a probe), 422 FastAPI validation errors
(`{"detail":[{loc,msg,type}]}`), 429 rate limit, 529 overloaded; the SDKs also map 400/403/404/5xx.
**402/out-of-credit is not documented**; we treat 402 as "provider out of credit" defensively.
`retry-after` (and `retry-after-ms`) is honoured "when the response carries one"; the SDK default is
2 retries on 408/429/5xx, 0.5 s → 5 s backoff, 10 s per attempt [5][7].

**Limits and price** [5]: 1,200 requests/min and 250K tokens/s, "adjusting dynamically".
$0.042 per million *input* tokens; output is free. A triage call (request + top-level tree + five
questions, ~1–3K tokens) costs roughly $0.00004–0.00013, so the owner's $25 credit covers ~200K calls.

**Models** [5]: `jev-1.13.0` is the only version; `jev-latest` and `jev-preview` both alias it.
"If you have tuned confidence thresholds against a specific version, pin that version's ID" — the
catalog pins `jev-1.13.0` as `typesafe/jev-1.13`. No deprecation policy or model changelog is published.

**Company and origin** [13][14][15]: TypeSafe AI, Inc., San Francisco; services hosted in the United
States; launched 2026-09-15. The base model is **not disclosed** ("a new model architecture", trained
on synthetic data); press reports speculate it builds on an unnamed open-weight LLM. The catalog
records `origin: "US"` and `baseOrigin: "unknown"`, which is accurate, and leaves the work-machine
eligibility call to the owner.

## Using it well

- Put every question in one call: the state is billed once and questions are answered independently
  and in parallel (a 13-question cookbook was 12× cheaper and 10× faster than separate calls) [16][17].
- Ask atomic "snap judgments" and combine them in code; describe *situations* for score levels, not
  degrees; offer complete option lists [9][11][18].
- Known weaknesses of 1.13 [12]: literal reading of questions, poor counting/arithmetic/date
  comparison, degradation with indirection or large irrelevant state, and susceptibility to
  adversarial content in the state. Request text is untrusted, so the worst a crafted request can do
  must be a mis-classification that the pipeline tolerates; low-confidence and needs-questions answers
  fall through to the LLM triage (the confidence cascade in #32).

## Triage mapping (design for #32)

One call, five questions over a state of repository, top-level entries and the quoted request:
`task_class` (choice over the eight classes), `complexity` / `risk` / `ambiguity` (scores reusing the
triage prompt's guidance, risk with the blast-radius text), `needs_questions` (noul). Code derives
`suggested_profile` (today's rule: large or high-risk → deep, trivial → quick, else standard), the
title from the request's first line, and `blocking_questions: []`. If any choice/score confidence is
below `[triage] decision_confidence`, P(needs_questions) ≥ 0.5, or ambiguity is high (only an LLM
can write the blocking questions), the invocation is **declined** and routing falls through to the
next triage model; with none left, the declined answer is used with a warning.

### Calibration (2026-09-28, k=1 on the 40-case `evals/triage` gold set)

One live call per case: ~970 input tokens, **$0.00004 per call**, p50 154 ms (max 304 ms).
Jev alone passes 72.5% (task_class 100%, complexity 92%, risk 87%, ambiguity 92.5%,
needs_questions 90%; one risk under-call). Declining on low confidence trades escalation for accuracy:

| `decision_confidence` | escalated | accepted pass |
|---|---|---|
| 0.5 | 42.5% | 87% (20/23) |
| **0.6** (default) | 57.5% | 94% (16/17) |
| 0.7 | 75% | 100% (10/10) |

The three gold "needs questions" cases scored P = 0.65–0.83 and all others ≤ 0.52. An earlier
wording, with a middle ambiguity level of "some details are unspecified", scored ambiguity 70%;
the levels now follow the triage prompt ("prefer a reasonable assumption"). Because the wording was
checked on this set, eval results on it are not fully held out; confirm at k=3 against the
current triage default before routing production triage to Jev.

## Ideas for epics: deciding when and how to split a request

Jev cannot write sub-tasks, but it can gate and check the split cheaply around an LLM planner:

1. **Whether to split** (before planning). A noul such as "A competent engineer would deliver this as
   more than one independently reviewable pull request", plus a size score whose levels describe
   situations (one focused change; one component with tests; several components that each need their
   own tests; cross-cutting work across the pipeline, storage and UI). Avoid "how many parts"
   questions — counting is a documented weakness. Low confidence escalates to the LLM planner, as in
   triage.
2. **Along which axis** (choice): vertical slices by user-visible capability; component or layer
   (storage → engine → API → UI); expand/contract (additive schema first, then behaviour, then
   cleanup); isolate the risky part (auth, money, deletion) from routine work; spike then build;
   "do not split". The chosen axis goes into the planner's prompt.
3. **Checking the planner's proposal** (fan-out, one call per sub-task, state = the sub-task plus its
   siblings with backticked ids): "independently shippable and testable" (noul); "depends on
   `sub[k]`" (choice over sibling ids, which code turns into an `--after` DAG); size score against
   the existing issue-sizing rule (one component, explicit out-of-scope list, < ~800 changed lines);
   "touches the engine or routing core" (noul, so conflicting children are chained, not parallel).
4. **Coverage** (noul per original requirement): "at least one sub-task delivers this requirement".
   Any uncovered requirement or failed check sends the plan back to the planner with the failing
   question, which is deterministic control flow with an LLM only inside the planning stage.
5. **Calibration**: a gold set from past issues that did and did not converge as single runs (e.g.
   #125, split into #134–#136, #126–#128) and their eventual line counts.

## OpenRouter

Still offered as `POST https://openrouter.ai/api/alpha/decisions` (alpha) and a TypeSafe-compatible
`/api/v1/systemone` [19][20]. Same question/answer shapes, but namespaced model ids
(`typesafe/jev-1.13`), extra request fields (`provider`, `session_id`, `trace`, `user`), an
`id` and `usage.cost` in the response, and 402 for insufficient credits. A fallback would need a
per-model harness override on the OpenRouter provider; not built, since the direct API is primary.

## Sources
1. https://docs.typesafe.ai/api.md
2. https://docs.typesafe.ai/introduction/quickstart.md
3. https://docs.typesafe.ai/sdk/python/api/constants.md
4. https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md
5. https://docs.typesafe.ai/models.md
6. https://api.typesafe.ai/openapi.json
7. https://github.com/typesafe-ai/typesafe-sdk-js (v0.6.0 `src/client.ts`, `src/errors.ts`); https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy.md
8. https://docs.typesafe.ai/llms.txt (docs index)
9. https://docs.typesafe.ai/primitives.md and https://docs.typesafe.ai/primitives/choice.md
10. https://docs.typesafe.ai/confidence.md
11. https://docs.typesafe.ai/primitives/score.md
12. https://docs.typesafe.ai/model-jaggedness/jev-1.13.md
13. https://typesafe.ai/legal/privacy-policy
14. https://typesafe.ai/blog/introducing-system-one-models-and-jev
15. https://techcrunch.com/2026/09/18/a-new-kind-of-ai-model-from-a-chatgpt-inventor-is-thrilling-developers/
16. https://docs.typesafe.ai/patterns/fan-out.md
17. https://docs.typesafe.ai/cookbooks/parallel_questions.md
18. https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md
19. https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request.md
20. https://openrouter.ai/docs/guides/community/typesafe-sdk.md
