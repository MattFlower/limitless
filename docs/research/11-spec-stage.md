<!-- Research synthesis produced on 2026-09-30 from two research passes (literature and industry practice; Limitless's own spec and run data), edited by the orchestrator. Many sources are 2026 preprints or vendor documentation; evidence strength is marked on each claim. Status: accepted by the owner as the basis for M4.6 (#193), 2026-10-01; see Status below. -->

# The spec stage: how much specification, for which implementer (2026-09-30)

**Goal.** Specs should help the implementer converge on what was asked, without inventing scope, dictating procedure a strong model doesn't need, or turning unreviewed model-written criteria into hard gates.

**Evidence tags:**
- **[S] strong:** peer-reviewed work, a large benchmark, or official vendor documentation.
- **[M] moderate:** a solid preprint or a specific vendor post.
- **[W] weak:** a small study, a single rater, or a confounded comparison in our own data.

## Status (2026-10-02)

Owner-approved no-regret changes from §3.1 that have shipped:
- **Item 1, the read-only leak** (#212 → PR #221). The spec prompt confines the read-only rule to the spec agent's own investigation. A spec that declares the task specification- or documentation-only gets one retry, then fails as invalid output, unless the request says so. The phrase match is anchored to clause ends.
- **Item 2, the contradiction** (#213 → PR #218). The implement prompt no longer says "beyond only the listed criteria". It says to stay within the request and spec, still meet the acceptance criteria, and name spec parts that look unnecessary. Reviewers may flag spec-mandated code the request does not need, at minor or nit.
- **Item 4, no out-of-run criteria** (#214 → PR #224). The prompt forbids them. A word-list match on `how_to_verify` asks for one rewrite, and a flagged criterion is kept and logged, never dropped. The words overlap this repository's own vocabulary (deploy, owner, orchestrator), so a wrongly dropped criterion would silently weaken verify.
- **Item 5, criteria sized to the task** (#215 → PR #226). Trivial 1–2, small 1–3, medium 3–5, large 5–8 (2–8 when the complexity is unknown). An oversized spec gets one retry and is then kept and logged. Tests are required only where behaviour is new or at risk.

Open:
- **Item 3, basis tags,** depends on the decision ledger proposed in 10-underspecified-requests.md, which is not yet decided.
- **Item 6, size estimate and split,** is #137.
- **Item 7** shipped as part of #218.
- **The §4 experiment** has not been run.
- **The Sol 6.1 implement field trial** (2026-10-01 to 10-05) now produces data on spec author versus implementer tier, because Sol 6.1 (tier 4) implements trivial, small and medium tasks.

## 0. Bottom line

1. **Separate intent from procedure; don't simply make specs lighter.**
   - Both frontier vendors now tell developers to strip prescriptive procedure for their top models, because guidance written for weaker models over-constrains stronger ones [S: 4–7, 9].
   - The same vendors want the *complete* intent up front: what, why, a definition of done and explicit scope limits. Their top models otherwise widen scope on their own [S: 5, 7, 9].
   - So a frontier implementer needs full intent and little procedure. A weaker implementer benefits from both.
2. **A plan is only as good as its author.**
   - Plans from a stronger model lift a weaker executor. Plans from a weaker model can push a stronger executor below its no-plan baseline [M: 31].
   - A subpar plan hurt more than no plan, and models trained for agentic coding barely noticed a plan being removed [M: 30].
   - Limitless has the risky pairing: a tier-4 model (Sol) writes the spec for a tier-5 implementer (Opus 5.5), and three stages then enforce it.
3. **The harm comes from wrong or invented criteria, not from how many there are.**
   - 7–8 criteria is far below the densities where instruction-following degrades [M: 27].
   - The measured harm is in content: over-narrow or over-broad tests rejected correct solutions in at least 59% of an audited failing subset of SWE-bench Verified [M: 45].
   - Spec tools have inflated a small bug fix into 16 acceptance criteria [W: 24].
   - A reviewer asked to find gaps "will usually report some" [S: 8].
4. **No product surveyed lets unreviewed, model-written criteria act as hard gates.** Criteria become gates only when a human approved them, when the implementer negotiated them [M: 1], or when the request itself asked for the behaviour. Limitless gates on all of them.
5. **In our data, specs widen scope in 45% of runs, criteria counts follow the prompt rather than the task, and nobody sizes the work** (§1).
6. **Recommendation.** Make the no-regret prompt and contract fixes now (§3.1). Then run a phased spec-depth × implementer-tier experiment (§4) to decide the per-tier rendering. Keep one stored spec, rendered for the implementer's tier by code.

## 1. Where Limitless stands (own data)

**Source.** All 512 acceptance criteria across 76 spec runs were labelled blind against the request alone. Agreement on the 113 double-labelled criteria was κ 0.74 across five labels and κ 0.85 for in-scope versus out-of-scope. Conflicts with the code are invisible to a request-only reading, so widening rates are lower bounds. [M]

### 1.1 What the prompt forces

- **The spec prompt:**
  - asks for "2–8 observable, independently testable criteria", each with a concrete `how_to_verify` ("a command to run, a test to add, a behavior to observe");
  - tells the spec agent to "DO NOT modify anything".
- **The implement prompt says both:**
  - "Implement the request's intent robustly, beyond only the listed criteria";
  - "Make the smallest complete change that satisfies the request and every acceptance criterion".

  These pull in opposite directions.
- **Downstream,** holdouts are written against the request and spec, the reviewer treats the spec as binding, and verify rules on each criterion.

### 1.2 Scope

| AC label | Share of 512 |
|---|---|
| Restates the request | 64% |
| Implied detail | 20% |
| **Widens the request** | **9.4%** |
| Process only | 6% |
| Contradicts the request | 0.4% |

- **34 of 76 specs (45%) contain at least one widening criterion.**
- Widening criteria almost never fail verify (1 of 42). They get built silently.
- Of the 48 widening criteria, 17 add durability ("survives a restart") and 23 add validation or idempotence rules. Silence is read as "harden it".
- **Process and human steps become factory criteria.** Examples: "the orchestrator checks …", a browser check. These fail verify at 23%, against 2–4% for other criteria. Generic-check criteria fell from 25 to 0 after verify started citing gate results, but human and orchestrator steps still slip through.

### 1.3 Size

- **Criteria counts don't scale with the task.** Within medium tasks, the correlation between criteria count and diff size is 0.02. 17 of 20 large specs sit at the cap of 8.
- **35 of 43 runs with a stated line budget ended over budget.**
  - The overrun is set in the first implement round: 20 of the 26 runs over 1.25× were already over after round 0.
  - It is mostly tests. Source plus docs alone was within budget in 34 of 43 runs.
  - 86% of criteria mandate a test.
- The spec never estimates size against the budget.
- Widening criteria do not predict overrun (p = 0.59). Overrun comes from covering every criterion with tests, and from implementers knowingly exceeding the budget to do so.

### 1.4 Spec models and implementers

These comparisons are confounded [W].
- **Astra versus Sol.** Astra writes only large-task specs. Its specs are twice as long and widen twice as often (14.7% of criteria against 7.0%).
- **A prompt bug.** In 6 of 20 Astra specs, the spec agent's own "DO NOT modify anything" became a "specification-only task" line in the spec. 0 of 55 Sol specs did this. Two implementers obeyed it, and each lost a round.
- **Opus versus Sol as implementer.** Opus's first round was larger than Sol's on the same kind of Sol-written spec: 428 against 319 lines, p = 0.035, confounded by period. Opus also overran on runs with no spec at all.
- **Reviewers treat the spec as binding.** 44 of 157 blocking review findings cite it, and none called spec-mandated code unnecessary. Only the orchestrator's out-of-band reviews did.
- **Reversed criteria are rare but expensive.** About 6 were removed or overridden later, each costing 3–5 rounds or a stall.

## 2. Literature and industry

- **Vendor guidance [S].**
  - Anthropic's Opus 5 and 5.5 and Fable 5 guides, and OpenAI's GPT-6 guidance, all say to cut prescriptive instructions for their top models [4–7, 9–10]. OpenAI: "Guidance that helps Sol or Luna may overconstrain GPT-6 Astra" [9].
  - The same sources ask for the complete task, a definition of done and scope limits, because top models can widen scope on their own [5, 7, 9].
- **Plans and executors [M].**
  - Strong-to-weak plans help; weak-to-strong plans can hurt [31, 32].
  - A subpar plan is worse than none, and extra phases that don't match the model's own workflow degrade performance [30].
  - Anthropic dropped sprint decomposition for Opus 4.6-class models [1].
- **Specificity [M].**
  - Under-specification sometimes *improves* code correctness [37].
  - Specificity effects are task-dependent [36].
  - Task specifications drive token spend [35].
  - Repository context files often don't help [26].
- **Criteria as gates [M–S].**
  - Criteria become hard gates only when a human approved them, the implementer negotiated them ("sprint contracts" [1]), or the user asked for the behaviour.
  - Kiro lets the user choose whether to fix the code, the spec or the test [14, 15].
  - LLM-generated test oracles often encode actual rather than expected behaviour [49].
- **Tools scale the mode, not the spec [S].**
  - Spec-driven tools skip the spec for small, clear diffs ("if you could describe the diff in one sentence, skip the plan" [8]).
  - Kiro, Spec Kit and Factory use gated phases [14, 16, 23].
  - Only Codex plan mode scales detail inside the plan ("minimum detail needed for implementation safety") [13].
  - Critiques warn of reinvented waterfall and inflated artefacts [24, 25].
- **Tests as spec [S].** Executable criteria beat prose: interactive test-driven clarification added about 46 points of pass@1 [42, 43]. But what fixes invented criteria is *tracing* them to the request, not making them executable.
- **Size and splitting [S/M].** Difficulty tracks file count and change size [51, 52]. Strong models need less decomposition [1, 54].
- **Missing evidence.** No controlled study links spec density to rounds or defects in an autonomous pipeline. That is what §4 measures.

## 3. Recommendation

### 3.1 No-regret changes, now

These follow from the evidence and our data without needing the experiment.

1. **Fix the "DO NOT modify anything" leak.** Move the spec agent's tool restriction out of the task framing, so it can't be copied into the spec. Add a deterministic check that rejects a spec saying the task is "specification-only" or asks for no changes, unless the request does.
2. **Remove the contradiction.** Drop "robustly, beyond only the listed criteria" from the implement prompt. Keep "smallest complete change", and tell the implementer to stay within the request and spec.
3. **Tag every criterion and requirement with a basis:** a request quote, a recorded decision (the #175 ledger), or preserved existing behaviour.
   - Validate citations deterministically.
   - Only cited items can block at review and verify; the rest are guidance.
   - This moves #159 upstream.
4. **No process or human-step criteria.** Reject, deterministically, criteria whose verification depends on the orchestrator, a human, a browser the sandbox lacks, or anything outside the run.
5. **Size the criteria to the task.** For example small 1–3, medium 3–5, large 5–8, keyed to triage complexity. Don't require a test for every criterion by default: ask for tests where behaviour is new or at risk.
6. **The spec estimates size.** It reports expected files and lines against the request's budget. When the estimate exceeds the budget, code proposes a split (#137) instead of the implementer overrunning.
7. **Review prompts say plainly** that spec-mandated code can be flagged as unnecessary when the request doesn't require it.

### 3.2 Decided by the experiment

- **Rendering by tier.** Store one spec. At implement time, code renders it for the implementer's tier:
  - **tier 5** (Opus, Fable, Astra): intent, constraints, out-of-scope, decisions and done checks;
  - **tier 4 and below:** also implementation notes (files, patterns, order);
  - **tier 3 and below:** also a file-level checklist written by a tier-4+ model.

  Rendering at implement time also handles an Opus → Sol fallback.
- **Spec author versus implementer tier.** For a tier-5 implementer, either route the spec to a tier-5 author or keep a tier-4 author's spec to intent only.

## 4. Experiment design (summary)

- **Arms:** spec depth D0 (request only), D1 (light: goal, cited constraints, out-of-scope, decision ledger, size estimate) and D2 (today's), crossed with Opus, Sol and Luna as implementer.
  - Specs are written by Sol, generated once per case and frozen, so every implementer sees identical text.
- **Dataset** (#111, moved into M4.6): 48 real cases plus 8 traps, stratified by what actually happened:
  - routine;
  - real-defect rework;
  - defects that escaped the factory (from orchestrator reviews and pre-merge fixes);
  - underspecified (a load-bearing sentence deleted from a real brief);
  - #137-style scope and conflict traps.

  Hidden tests come from the landed PRs plus a reproduction test for each escaped defect.
- **Prerequisite:** eval trials must persist diff statistics. Today none of the 384 implement-trial commits survive.
- **Outcomes:**
  - rounds to converge;
  - overrun: total, source only, and unrequested hunks;
  - escaped defects: hidden tests plus a fixed external review panel that never sees the arm's spec;
  - cost per converged, defect-free task.
- **Power:** paired designs need about 26 case-trials to detect ±25% in size, about 53 for 0.5 rounds, and 55–90 for 15–20-point changes in escaped-defect rate. Only a large depth × tier interaction is detectable.
- **Phases:**
  - **Phase 1** isolates the implement stage and can run now: 864 trials, or a minimal version of about 290.
  - **Phase 2** runs the full pipeline on the informative cells (about 192 runs). It waits until the M4.5 panel is the production review, because the panel changes convergence and review cost.
- **Cost:** about $3.2–3.7k API-equivalent for the full design, or about $1.1k for the minimal version, mostly subscription quota. For scale, all production runs so far have cost about $738 API-equivalent.

## 5. Caveats

- **One corpus.** One owner, mostly one repository, over about four days of runs.
- **Pre-clarified briefs.** Most requests were detailed briefs written in an interactive session.
- **Confounded comparisons.** The Opus-versus-Sol and Sol-versus-Astra comparisons are confounded by period and task size.
- **Hindsight in the labels.** The criteria labels are reliable (κ 0.74–0.85) but read the request only.

## References

1. Anthropic Engineering, "Harness design for long-running application development". https://www.anthropic.com/engineering/harness-design-long-running-apps (2026-03-24) [M]
2. Anthropic Engineering, "Effective harnesses for long-running agents". https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents (2025-11-26) [M]
3. Anthropic Engineering, "Effective context engineering for AI agents". https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents (2025-09-29) [M]
4. Claude platform docs, "Prompting best practices". https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices (accessed 2026-09-30) [S]
5. Claude platform docs, "Prompting Claude Opus 5". https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5 (accessed 2026-09-30) [S]
6. Claude platform docs, "Prompting Claude Opus 5.5". https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5 (accessed 2026-09-30) [S]
7. Claude platform docs, "Prompting Claude Fable 5". https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5 (accessed 2026-09-30) [S]
8. Claude Code docs, "Best practices". https://code.claude.com/docs/en/best-practices (accessed 2026-09-30) [S]
9. OpenAI Developers, "Rethinking skills and prompts for GPT-6 Astra". https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra (2026-09) [S]
10. OpenAI API docs, "Using GPT-6". https://developers.openai.com/api/docs/guides/latest-model (accessed 2026-09-30) [S]
11. OpenAI Cookbook, "GPT-5 prompting guide". https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide [S]
12. OpenAI Cookbook, "Codex Prompting Guide". https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide [S]
13. openai/codex, Plan Mode collaboration template. https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/plan.md [S]
14. Kiro docs, "Specs", "Feature Specs", "Bugfix Specs", "Quick Spec", "Best Practices". https://kiro.dev/docs/specs/ (updated 2026-08-04) [S]
15. Kiro blog, "Does your code match your spec?". https://kiro.dev/blog/property-based-testing/ (2025-11-17) [M]
16. GitHub Spec Kit templates and `spec-driven.md`. https://github.com/github/spec-kit [S]
17. GitHub Next, Copilot Workspace user manual. https://github.com/githubnext/copilot-workspace-user-manual/blob/main/overview.md [S]
18. Cursor, "Introducing Plan Mode". https://cursor.com/blog/plan-mode (2025-10-07) [M]
19. Cursor docs, "Agent modes". https://cursor.com/docs/agent/modes [S]
20. Cursor, "Scaling long-running autonomous coding". https://cursor.com/blog/scaling-agents (2026-01-14) [M]
21. Devin docs, "Instructing Devin effectively" and "When to use Devin". https://docs.devin.ai/essential-guidelines/instructing-devin-effectively [S]
22. Cognition, "Devin 2.0". https://cognition.com/blog/devin-2 (2025-04) [M]
23. Factory docs, "Specification Mode". https://docs.factory.com/cli/user-guides/specification-mode [S]
24. martinfowler.com, "Understanding Spec-Driven-Development: Kiro, spec-kit, and Tessl". https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html (2025-10-15) [W]
25. Scott Logic, "Putting Spec Kit Through Its Paces". https://blog.scottlogic.com/2025/11/26/putting-spec-kit-through-its-paces-radical-idea-or-reinvented-waterfall.html (2025-11-26) [W]
26. "Evaluating AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?". https://arxiv.org/abs/2602.11988 [M]
27. "How Many Instructions Can LLMs Follow at Once?". https://arxiv.org/abs/2507.11538 [M]
28. "Prompting Science Report 2: The Decreasing Value of Chain of Thought in Prompting". https://arxiv.org/abs/2506.07142 [M]
29. "Aging of Prompt Engineering Techniques Across LLM Versions". https://arxiv.org/abs/2608.24641 [M]
30. "From Plan to Action: How Well Do Agents Follow the Plan?", ASE 2026. https://arxiv.org/abs/2604.12147 [M]
31. "Efficient LLM Collaboration via Planning" (COPE). https://arxiv.org/abs/2506.11578 [M]
32. "An Empirical Study on Strong-Weak Model Collaboration for Repo-level Code Generation". https://arxiv.org/abs/2505.20182 [M]
33. "Self-planning Code Generation with Large Language Models", ACM TOSEM. https://arxiv.org/abs/2303.06689 [S]
34. "Constraint Decay: The Fragility of LLM Agents in Backend Code Generation". https://arxiv.org/abs/2605.06445 [M]
35. "Can your AI agent be cheaper? Investigating the effects of task specifications on token spend in agentic coding tasks". https://arxiv.org/abs/2608.25399 [M]
36. "More Than a Score: Probing the Impact of Prompt Specificity on LLM Code Generation". https://arxiv.org/abs/2508.03678 [M]
37. "When Prompt Under-Specification Improves Code Correctness". https://arxiv.org/abs/2604.24712 [M]
38. "Exploring LLMs Impact on Student-Created User Stories and Acceptance Testing in Software Development". https://arxiv.org/abs/2502.02675 [W]
39. "Does Spec-Driven Development Reduce Defects? An Empirical Test of Industry Claims Across 119 Open-Source Repositories", SSRN. https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6515898 [W]
40. Uvik Software, "Spec-Driven Development Benchmark 2026". https://uvik.net/spec-driven-development-benchmark/ [W]
41. "Spec Kit Agents: Context-Grounded Agentic Workflows". https://arxiv.org/abs/2604.05278 [M]
42. "LLM-Based Test-Driven Interactive Code Generation" (TiCoder), IEEE TSE. https://arxiv.org/abs/2404.10100 [S]
43. "Test-Driven Development and LLM-based Code Generation", ASE 2024. https://www.computer.org/csdl/proceedings-article/ase/2024/124800b583/22gEBI6t8Uo [S]
44. "Tests as Prompt: A Test-Driven-Development Benchmark for LLM Code Generation". https://arxiv.org/abs/2505.09027 [M]
45. OpenAI, "Why SWE-bench Verified no longer measures frontier coding capabilities". https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/ (2026-04) [M]
46. StrongDM, "Software Factory". https://factory.strongdm.ai/ (2026-02-06) [M]
47. "Agent-as-a-Judge: Evaluate Agents with Agents". https://arxiv.org/abs/2410.10934 [M]
48. "CodeJudgeBench: Benchmarking LLM-as-a-Judge for Coding Tasks", ACL 2026. https://aclanthology.org/2026.acl-long.888/ [M]
49. "Do LLMs generate test oracles that capture the actual or the expected program behaviour?". https://arxiv.org/abs/2410.21136 [M]
50. "Grounding AI Agents in Contracts: An Empirical Evaluation of Spec-Driven Test Generation", SpecOps 2026. https://arxiv.org/abs/2608.17177 [M]
51. "SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks?". https://arxiv.org/abs/2509.16941 [S]
52. "What Makes Software Issue Resolution Tasks Difficult for Agents?". https://arxiv.org/abs/2608.18280 [M]
53. "Do AI Agents Know When a Task Is Simple? Toward Complexity-Aware Reasoning and Execution". https://arxiv.org/abs/2607.13034 [W]
54. METR, "Measuring AI Ability to Complete Long Software Tasks". https://arxiv.org/abs/2503.14499 [M]
55. "Towards a Science of Scaling Agent Systems". https://arxiv.org/abs/2512.08296 [M]
