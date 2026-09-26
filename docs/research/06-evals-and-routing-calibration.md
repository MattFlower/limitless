<!-- Research report produced by a research subagent on 2026-09-26, edited by the orchestrator. Many sources are 2026 preprints read as abstracts; treat exact numbers as indicative. -->

# Evals for routing calibration — research notes (2026-09-26)

## 1. Router calibration, and what fits a single user
- RouteLLM learns from preference data; Not Diamond trains custom routers on your own eval scores
  (≥15 samples, 25+ recommended). OpenRouter's Auto Router (Aug 2026) dropped Not Diamond for a
  ~30-category prompt classifier ranked by 7-day community spend share — a category lookup plus a
  crowd prior.
- A well-tuned kNN router matches or beats learned routers (arXiv 2505.12601).
- A decision-theoretic analysis found pre-generation routing beats the best cascade on 4/5 datasets:
  cascades always pay for the cheap attempt.
- **Implication:** a static (role × task class) table filled from evals. Cascade only where a
  deterministic verifier exists and the cheap attempt is free (implement: local first, escalate on
  gate/holdout failure). Once hundreds of runs exist, per-cell estimates from production outcomes,
  then kNN over past prompts.

## 2. How small can a coding eval be?
- SWE-bench Verified is contaminated/saturated (OpenAI stopped reporting it; models reproduce gold
  patches from the task id). Paired McNemar could not separate any of 29 adjacent top-30 pairs on
  its 500 tasks.
- The harness moves scores by up to ~30 points — evaluate models inside *our* adapters.
- terminal-bench-mini: 14 discriminating tasks reproduce 85% of full pairwise ordering (89% at 22,
  91% at 30, 95% at 60); 97% agreement when agents differ by >10 points, 65% when <2.
- Needed fractions vary from 15% to >90% of a benchmark; no universal number.
- **Takeaway:** 20–30 tasks separate tiers ≥10 points apart — enough for "good enough" routing, not
  for fine ranking. Sources: own-repo history replays (uncontaminated, representative),
  SWE-rebench (fresh monthly), terminal-bench-mini. Skip non-agentic sets.

## 3. Deterministic code-review evals
- Seeded defects give deterministic recall: match (file, ±3 lines, category).
- Synthetic bugs overstate ability badly (F1 0.847 injected vs 0.066 real PRs). Diff size dominates
  (F1 0.66 under 10 lines vs 0.04 over 150). Cheap reviewers can be competitive.
- Gold sets are incomplete, so unmatched findings on seeded diffs are not false positives; measure
  false positives on clean diffs instead.
- Real bugs are cheap to mine: the change that introduced a later-fixed defect (SZZ).

## 4. Triage and spec
- Triage: exact match per field, cost-weighted confusion (under-calling risk costs more), flip rate
  across k=3.
- Holdout: executable (SWT-bench style) — scenarios must pass on the reference solution and fail on
  the pre-change code or seeded mutants.
- Spec: structure checks + a binary checklist judge (CheckEval-style); validate a judge against ~50
  human labels (κ ≥ 0.7) before trusting it.

## 5. Harness and statistics
- Claude Code against llama-server `/v1/messages`: point the small/fast model at the local model
  (we do), expect `count_tokens` 404s, serialize on single-slot servers.
- Cache single-shot responses by (model, adapter version, prompt-template hash, input hash, params)
  so graders can change without re-running models.
- Paired designs on identical tasks. McNemar mid-p for single binary runs; paired bootstrap when
  scores average k runs. Non-inferiority: accept the cheaper model if the lower one-sided 95% bound
  of (cheap − best) > −δ. With 40 tasks and 20% discordance, SE ≈ 7 points, so realistic δ is
  10–12 points (≈9 with 50+ tasks).
- Temperature-0 reruns flip 1–3% of outcomes, but paraphrasing prompts adds 11–58× more variance —
  rotate paraphrases across trials.

## Sources
arxiv.org/abs/2603.04445 · arxiv.org/abs/2605.06350 · arxiv.org/abs/2505.12601 ·
openrouter.ai/docs/guides/routing/routers/auto-router · docs.notdiamond.ai/docs/router-training-quickstart ·
openai.com/index/why-we-no-longer-evaluate-swe-bench-verified · arxiv.org/abs/2609.17394 ·
huggingface.co/datasets/LocalLLaMA/terminal-bench-mini · arxiv.org/html/2606.12344v1 ·
arxiv.org/abs/2607.12338 · swe-rebench.com · arxiv.org/abs/2606.15689 ·
withmartian.com/post/code-review-bench-v0 · arxiv.org/html/2509.01494v2 · swtbench.com ·
aclanthology.org/2025.emnlp-main.796 · arxiv.org/abs/2411.00640 · arxiv.org/abs/2608.22331 ·
anthropic.com/engineering/demystifying-evals-for-ai-agents · github.com/harbor-framework/harbor ·
huggingface.co/blog/ggml-org/anthropic-messages-api-in-llamacpp
