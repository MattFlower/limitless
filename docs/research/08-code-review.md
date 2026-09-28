<!-- Research synthesis produced on 2026-09-28 from three parallel research passes (literature, industry systems, Limitless's own review history), edited by the orchestrator. Many sources are 2026 preprints or vendor posts; the evidence strength is marked on each claim. Numbers are not comparable across benchmarks. -->

# Code review that finds defects — research notes (2026-09-28)

Goal: the most true defects per dollar and per minute in LLM-written changes, at a controlled false-positive rate on what the pipeline *acts on*.

Tags:
- **[PR]** peer-reviewed.
- **[arXiv]** preprint.
- **[IB]** independent benchmark.
- **[VB]** vendor blog or vendor benchmark.
- **[VB-doc]** vendor guidance.
- **[CO]** company describing an internal tool.
- ⚠️ weak evidence (small n, single author, old models, or no ablation).

## 1. Where Limitless stands (own data, 2026-09-28)

**The review stage today:**
- One reviewer: an adversarial prompt with blocker/major/minor/nit severities.
- The pipeline derives its own verdict.
  - Round 1: a blocker or major blocks.
  - Later rounds: only regressions, unaddressed prior blocking findings, new blockers or security issues block.
- The reviewer sees the implementer's own report, labelled "unverified".
- Routing avoids the implementer's vendor. In practice most reviews ran on Sonnet.

**Outcomes** (137 reviews over 58 runs, from the daemon DB):
- 39% of reviews requested changes. Review caused 53% of repeat implement rounds (verify 36%, gates 11%).
- Clearly false blocking verdicts were rare: 9% of blocking verdicts, all from one run, which is fixed.
- **Recall is the problem, not pickiness.** 54 defects passed factory review and were caught later by orchestrator review agents, deploys, verify or production. At least ~40% of reviewed runs shipped at least one defect.

**The 54 escaped defects:**
- By category: logic 20, error handling 7, security 7, spec mismatch 6, test gap 5, data migration 3, resource 3, concurrency 2, other 1.
- By severity: high 9, medium 26, low 19.
- Patterns to design against:
  1. **Detected but under-rated (9/54).** The reviewer named the defect and rated it minor or nit, so it didn't block. Severity calibration is the cheapest recall gain.
  2. **Single-pass approvals of large diffs.** Six large PRs approved in their first review carry 21 of the 54.
  3. **Failures blamed on the sandbox.** Reviewers attributed test failures in their own sandbox to the environment and approved.
  4. **Degenerate approvals accepted.** One review was `{"summary":"test","findings":[]}`.
  5. **The later-round rule lets new majors through.** A newly found major in round 2+ became a follow-up and shipped.
  6. **Blind spots:**
     - compatibility with the running release and rollback;
     - resume and restart semantics;
     - integrity of what the factory reads from the change under test;
     - real CLI or host behaviour that fakes can't show;
     - correctness of eval metrics.
- **Existing review eval (15 cases).** It measures the wrong population: most of its defects are ones factory review had already caught. It grades a minor finding as a hit, so it rewards exactly the under-rating that ships bugs. It has too few clean cases to bound false blocks: 0/3 still gives a Wilson upper bound over the ceiling. Its contamination rule excludes every commit after the eval datasets landed.

## 2. What the evidence says

1. **Find with coverage, filter separately.** Current Claude models take "only report high-severity / be conservative" literally: they find the bug and don't report it. The fix is to report everything with severity and confidence, then filter in a later pass [VB-doc, Anthropic prompting guides]. Every measured verifier trades some recall for precision:
   - a validator after 3 reviewers: false alarms 87.8% → 75.4%, key bugs 31% → 20% [PR ⚠️ n=45];
   - execution-grounded PoC checking: rejects 85% of false reports, proves 68% of true bugs [arXiv, AnyPoC];
   - a path-feasibility filter: 94–98% of false positives removed at 0.75–0.88 recall [arXiv, Tencent].

   Strength: moderate (consistent direction across 5+ sources).
2. **Verification must be grounded.** A verifier that quotes code, names a trigger, or reproduces the bug works. Bare self-scoring doesn't.
   - LLM 1–10 self-rating of comments was "nearly random" [VB ⚠️ 2024].
   - A factual-correctness judge had "minimal impact" [PR, RovoDev].
   - A pre-registered ablation: the model verifier was the only component that suppressed false positives (p=0.004) [arXiv].
   - A falsification-first reflector that sees only the diff: precision 33.9% vs 7.2% on the same model [arXiv ⚠️ authors built the benchmark].
   - The verifier should not inherit the finder's reasoning.
3. **Adversarial framing moves the threshold, not the capability.** Across 8 models, "find violations" versus "verify it follows guidelines" raised recall 11–36 pp. False positives rose in lockstep and precision stayed at 0.49–0.55 [arXiv]. *Author* framing is worse: "this is a safe refactor" cut detection by up to 93 pp on weak models and 5 pp on Opus 4.5. Redacting it restored 70–94% [arXiv]. **So don't give the implementer's self-assessment to the reviewer.**
4. **Diversity plus union beats voting.**
   - A union of 4 tools passed 41.5% of review-derived tests versus 32.1% for the best single tool [arXiv, c-CRAB].
   - Cross-vendor review: +8–10 pp recall on high-severity bugs [VB, Greptile].
   - Same-model aggregation: F1 +44% and recall +119% at n=10 [PR, SWR-Bench].
   - Majority vote beats the best single model in only ~10% of 3-model ensembles, because strong models' errors correlate [PR, ICML'25; arXiv].
   - Use agreement as a confidence signal. Never drop singletons.
5. **Acting on bad findings damages good code.**
   - A weaker reviewer lowered a stronger author's pass rate by 8.6 pp. Claude reviewing Codex raised it by 18 pp [arXiv ⚠️ competitive programming].
   - Asking a judge to explain and fix more than doubled false rejection of correct code [PR ⚠️ older models].
   - In multi-round review, 32.5% of false positives re-flag defects already fixed [PR, MCR-Bench].
   - Most repair-loop gains arrive in rounds 1–3 [arXiv].
   - A tightening round schedule is directionally supported, and Anthropic's own guidance recommends the same shape [VB-doc]. No study compares specific round thresholds.
6. **Specialist reviewers:** there is no controlled evidence that separate security, concurrency, error-handling or type reviewers beat one strong generalist at equal budget on frontier models.
   - One weak study found a 4-agent system scored below its own best single agent [arXiv ⚠️⚠️].
   - A general multi-agent study found coordination returns turn negative once the single-agent baseline passes ~45% [arXiv, Google].
   - The best-supported structure is a narrow finder plus an independent verifier. Lenses organised by *mechanism* are more promising than topic lenses. Mechanism examples: removed-behaviour auditor, caller/callee tracer, gap sweep.

   This is the biggest evidence gap, so decide it with our own eval.
7. **Context helps when it is targeted or agent-pulled.**
   - Data-flow slices raised key-bug inclusion from 24% to 37–39% [PR ⚠️ n=45].
   - Dumping more text into a single-shot prompt lowers recall; agents that fetch their own context reverse that [arXiv, AACR-Bench].
   - Intent (the spec) helps more than surrounding code [arXiv].
   - Recall collapses on large, multi-issue diffs: 38% with one issue per PR, 9% with five or more [PR].
8. **Execution evidence is the strongest false-positive filter, but partial.** A proof test must fail on the defective head. 46% of passing agent-written validation tests also pass on buggy code [arXiv]. About a third of real bugs can't be proven within budget [arXiv]. It roughly doubles cost per finding. Use it on high and critical findings.
9. **Model dependence.**
   - Frontier models need less *behavioural* scaffolding: no severity self-filtering, emphatic wording, in-prompt self-verification or forced subagents [VB-doc].
   - They still gain from *structural* scaffolding: bounded tools, deterministic dispatch, an independent verifier.
   - Claude Code's built-in `/code-review` runs Opus 5 as a single careful pass at medium and high effort. It keeps finder fan-out plus a CONFIRMED/PLAUSIBLE/REFUTED verifier for weaker models and maximum effort [inspected in the local binary].
   - Small or local models gain more from decomposition, aggregation and checklists, and are far more framing-susceptible [arXiv].
   - Effort mostly buys recall at flat precision: Opus 5 low → high moved recall 57% → 77% [VB]. The effect is model-specific and flattens at the top [VB ⚠️].
10. **Cost.**
   - Multi-agent review is typically 3–15× the tokens of a single pass.
   - Unstructured agentic review can be both the costliest and the least precise option: 15× tokens for half the F1 [arXiv].
   - Managed multi-agent review costs $15–25 per review [VB]. Single-model reviews cost $0.75–7.87 [VB].
   - Our current reviews average about $1.20 API-equivalent.

## 3. Industry patterns

| Pattern | Used by | Verdict |
|---|---|---|
| Independent verification of each candidate | Anthropic Code Review/ultrareview, Bugbot v1 validator, Uber grader, BitsAI filter, Qodo judge, Ellipsis | **Strong when grounded** |
| Agentic repo exploration within bounds | Bugbot v2, Greptile v3, Copilot (2026), OpenAI, Augment | Strong; bound the tools (CodeRabbit, OpenCodeReview) |
| Cross-vendor roles | Uber (Claude generator + OpenAI grader was their best F1), multi-tool unions | Good for recall and verification; harmful as an unverified fix trigger |
| Severity caps / high-priority-only defaults | Codex GitHub (P0/P1 only), Anthropic caps, Copilot (29% silent) | Strong: precision collapses above ~5 comments per PR (Martian) |
| Learning from dismissals | Greptile (address rate 19% → 55%), Bugbot learned rules, Uber category suppression | Strong and cheap |
| Effort scaled by diff size and risk | Anthropic (finders ≈ lines/150), Bugbot high effort (+36% bugs) | Good |
| Majority-vote filtering | Bugbot v1 only (dropped in v2) | Don't: it loses the rare real bugs |
| Random diff order across samples | Bugbot v1 | Plausible, unmeasured |

On Martian's independent benchmark, the best tools converge at about 3 comments per PR with precision ≈ recall ≈ 0.6. No tool is close to complete (offline F1 0.13–0.64; online F1 0.40–0.65). The GitHub bots from Claude, Codex, Cursor and Copilot sit at online F1 0.46–0.51.

**A strong practitioner configuration** combines three kinds of reviewer: several pr-review-toolkit agents, an infrastructure-focused reviewer and a Codex adversarial review. It de-dupes findings, classifies them critical/high/medium/low, and tightens the schedule each round: fix all, then high+, then critical only. It finds far more than the built-in `/code-review` or `codex review`, but is picky. The sources explain both:
- More diverse finders mean more recall.
- The toolkit's silent-failure hunter is told to report every instance. Most other toolkit agents emit suggestions or ratings rather than defects.
- The adversarial prompt relaxes Codex's native precision rules ("introduced by this change", "name the provably affected code").
- Nothing tries to *refute* a finding before it is fixed.

## 4. Unknown or unmeasured
- Specialist lenses versus one generalist at equal budget.
- Validity of LLM severity labels for review findings.
- Dedup accuracy, especially over-merging two bugs into one.
- Round-threshold schedules compared head to head.
- The effect of diff-order randomisation.
- Whether giving the reviewer the tests helps.
- Long-run effects on accumulated defects.

Our own eval has to answer the first three for Limitless.

## 5. Direction for M4.5 (#109)
- **Eval first.**
  - Escaped defects become cases: base + approved head, with required defects labelled by severity.
  - Clean controls come from merged PRs with no later fixes.
  - A sanitized two-commit snapshot mode lets post-dataset commits be used.
  - Grade "would it have blocked under the production rule", not "was it mentioned".
  - Score whole review *systems* (finders, verifier, schedule), k≥3.
- **Hygiene** that needs no model change:
  - reject degenerate reviews;
  - keep the implementer's self-assessment away from reviewers;
  - make the factory's gate results authoritative so reviewers can't wave away failures;
  - let a newly found *verified* high block in later rounds.
- **Structure:**
  - Coverage-first finders from different vendors, scaled by profile, risk and diff size.
  - Deterministic merge with an agreement count.
  - A cross-vendor, context-asymmetric verifier (CONFIRMED / PLAUSIBLE / REFUTED, quoting code, trigger → failure). It assigns severity against a consequence rubric, so the finder's severity is only an input.
  - Execution proofs for high/critical findings where cheap.
- **Convergence.** The round schedule from the practitioner configuration, applied to *verified* findings:
  - round 1: fix all verified findings except style/cleanup, which go to the follow-up ledger;
  - round 2: verified high and critical, scoped to the fix diff and the prior findings;
  - round 3: verified critical only, with execution evidence where possible;
  - then a draft PR for a human.
- **Learning.** Record each finding's outcome (fixed, refuted, dismissed, escaped) to tune lenses and suppression rules per repository, through PRs like routing policy.

## References (selected; full lists in the research passes)
- SWR-Bench, arXiv 2509.01494; Proc. ACM Softw. Eng. 2026 [PR][IB]
- c-CRAB, arXiv 2603.23448 (2026) [arXiv][IB]
- MCR-Bench, arXiv 2608.27442; ISSTA 2026 [PR][IB]
- AACR-Bench, arXiv 2601.19494 (2026) [arXiv]
- Martian Code Review Bench: https://github.com/withmartian/code-review-benchmark; online leaderboard fetched 2026-09-28 [IB]
- MacroscopeBench, Sep 2026: https://macroscope.com/content/ai-code-review-benchmark-best-models [VB]
- Lu et al., "Towards Practical Defect-Focused Automated Code Review", ICML 2025, arXiv 2505.17928 [PR]
- Shahriar et al., "Words Speak Louder Than Code", arXiv 2606.30587 (2026) [arXiv]
- Mitropoulos, Spinellis et al., "Contextual Bias in LLM-Assisted Security Code Review", arXiv 2603.18740 (2026) [arXiv]
- Xiang et al., "Cross-Model LLM Code Review", arXiv 2607.21656 (2026) [arXiv]
- Kim, Garg et al., "Correlated Errors in Large Language Models", ICML 2025 [PR]
- Kim et al. (Google), "Towards a Science of Scaling Agent Systems", arXiv 2512.08296 (2025) [arXiv]
- Zhao et al., AnyPoC, arXiv 2604.11950 (2026) [arXiv]
- Xu & Wu, "Validation Evidence in LLM Repair Agents", arXiv 2607.28871 (2026) [arXiv]
- Li et al., OpenCodeReview, arXiv 2608.09290 (2026) [arXiv]
- Verifier ablation, arXiv 2609.15887 (2026) [arXiv]
- Kiecker et al., "Is Three the Magic Number?", arXiv 2607.05197 (2026) [arXiv]
- Jin & Chen, "Systematic Overcorrection", Automated Software Engineering 2026 [PR]
- Tantithamthavorn et al., RovoDev, ICSE-SEIP 2026 [PR]
- Sun et al., BitsAI-CR, FSE 2025 [PR]
- Sadowski et al., Tricorder, ICSE 2015 [PR]
- Anthropic: Code Review https://claude.com/blog/code-review; prompting guides (Opus 5, Sonnet 5) https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices [VB][VB-doc]
- OpenAI: "A Practical Approach to Verifying Code at Scale" https://alignment.openai.com/scaling-code-verification/ [VB]
- Cursor: "Building a better Bugbot" https://cursor.com/blog/building-bugbot [VB]
- Greptile: "Make LLMs shut up" https://www.greptile.com/blog/make-llms-shut-up; "Models are worse at reviewing their own code" https://www.greptile.com/blog/model-inversion [VB]
- Uber: uReview https://www.uber.com/us/en/blog/ureview/ [CO]
