<!-- Research synthesis produced on 2026-09-29 from three research passes (literature, industry practice, Limitless's own run data), edited by the orchestrator. Many sources are 2026 preprints or vendor documentation; the evidence strength is marked on each claim. Numbers are not comparable across benchmarks. Status: research record; the proposal is not yet decided (see Status below). -->

# Underspecified requests: when the factory should ask, assume or proceed (2026-09-29)

**Goal:** catch the few decisions that belong to the requester, at the cheapest point in a run, without making the factory chatty. Everything else is either resolved from the code or recorded as an assumption. No stage enforces an assumption as a hidden requirement. Limitless stays primarily autonomous.

**Evidence tags:**
- **[S]** strong: peer-reviewed work, a large benchmark with clear numbers, or official product documentation.
- **[M]** moderate: a solid preprint with experiments, or a vendor post with specifics.
- **[W]** weak: a small study, an inference, or a single-rater judgement on our data.

## Status (2026-10-02)

Merged as a research record. The proposal below is **not adopted yet**: the spec-time decision ledger, deterministic disposition, and "Decisions to confirm" at the top of PRs await an owner decision. Basis tags for acceptance criteria (11-spec-stage.md §3.1 item 3) depend on it. The factory's behaviour is unchanged: the clarify stage still asks only when the spec model raises blocking questions.

## 0. Bottom line

1. **The factory has never asked a question, but only a small share of its bad requirements come from genuinely ambiguous requests.**
   - The `questions` table has 0 rows across 96 runs.
   - All 82 triage results rated ambiguity `low`.
   - None of the 69 specs raised a blocking question.
   - Gaps are filled silently instead: specs recorded 287 assumptions, and holdout expectations are recorded nowhere.
   - Of the 46 bad requirements in the rework analysis, only **3 (7%, in 2 runs)** trace to genuine ambiguity in the request. The other 43 are stage-local:
     - 20 are details the stage didn't need to decide;
     - 16 are facts the stage should have looked up in the code;
     - 7 misread explicit text. [W: one rater]
   - Even a perfect clarify step would have saved at most 1–3 of the 27 rework rounds caused by bad requirements.
2. **`clarify` doesn't fire because the requests are pre-clarified briefs, not because detection is broken.**
   - The median request is 1,780 characters. Most are bulleted, name files, mention tests and give a size budget.
   - On the triage eval's deliberately vague cases, the production triage model asks on 83% of trials. It falsely asks on 0.9% of clear ones. [M: 7 vague cases]
   - The clarifying questions happen upstream, in the interactive session where each brief is drafted.
3. **Requester-owned decisions still occur in about 10% of runs**, usually one per run. They sit buried in the spec's assumption list and become visible only after the code has been read.
   - All 7 found merged with the assumption listed in the PR.
   - At least 3 of the 7 were reversed later.
   - A flat assumptions list at the end of a long PR does not get noticed. [W: n=7, hindsight]
4. **Recommendation: a decision ledger written at spec time, with dispositions decided by deterministic code.**
   - Block only for decisions that are requester-owned and hard to reverse, or when a request has no concrete outcome.
   - Everything else proceeds on a stated default, listed under "Decisions to confirm" at the top of the PR.
   - Holdout, review and verify must cite the request, the spec or a ledger entry. They cannot silently contradict or extend the ledger.

## 1. Where Limitless stands (own data)

### 1.1 Current mechanism

- **Triage** outputs `ambiguity` (low/medium/high) and `blocking_questions`.
  - When ambiguity is `high` and the profile isn't quick, the run enters `clarify`: it asks the owner and waits for answers.
  - Medium-ambiguity questions are dropped.
  - The Jev decision path returns no questions by construction.
- **Spec** can also emit `blocking_questions`.
- **Every stage is told to assume.** The factory preamble says "nobody can answer questions … state the assumption". Triage is told to rate high "only if a sensible implementation is impossible", and spec is told to ask "only if the task truly cannot proceed sensibly".
- **Holdouts** have no field for questions or assumptions.
- **Triage cannot read the repository.** Conflicts with the code are the largest class of bad requirements.

### 1.2 Bad requirements: request ambiguity or invention?

The 46 `requirement_problem` items from the rework analysis come from three stages: 37 holdout, 6 spec, 3 review.

| Category | Items | Would a question have helped? |
|---|---|---|
| The request was explicit, and the stage contradicted or misassigned it | 7 (15%) | No: the answer was in the request |
| The request was silent, and the **codebase** settles it | 16 (35%) | No: look it up and preserve existing behaviour |
| The request was silent, and silence meant "not required" (added hardening, tests, wording or mechanism) | 20 (43%) | No: asking would have been an unnecessary question |
| Genuine intent ambiguity, owned by the requester | **3 (7%)** | Partly |

**The genuine cases** do not come from one stage guessing wrong. They come from **stages picking different defaults**.
- *Conflict-marker scan:* the request said "the factory then verifies no markers remain". The review argued for scanning only the listed files; the holdout demanded every changed file. The owner kept the wider scan.
- *Failure taxonomy:* the request left the boundary between two failure classes undefined. The implementer's rule matched what the owner later documented. The holdout imposed a different rule, and rounds flip-flopped between the two until the run needed a human.

**Invention where the request or code was clear:**
- A holdout fixture broke the request's own statistical ceiling. The rework then weakened the rule, and the owner reverted it.
- A holdout assumed a configuration model the code doesn't have. The rework added a new config surface.
- A holdout demanded resuming work that the code deliberately refuses to resume. The rework added about 200 lines, a migration and a crash bug.
- The spec turned an orchestrator's manual browser check into a factory acceptance criterion. Five review rounds then blocked on a browser the sandbox doesn't have.

### 1.3 Spec assumptions that were the requester's to decide

All 287 spec assumptions were labelled against their original requests [W: one rater]:

| Label | Share |
|---|---|
| Technical defaults | 60% |
| Codebase facts | 17% |
| Requester decisions | 13% |
| Scope narrowing | 8% |
| Scope widening | 1% |

**7 (2.4%) were worth asking about.** Each was requester-owned, medium or high stakes, and not inferable from the request or the code. They fell in 7 of 69 runs (10%). Examples:
- auto-deleting `needs_human` worktrees after 7 days;
- converting a migrations table in place despite a "no-op except new table" instruction;
- a security flag that didn't block unverified findings (later changed in #169);
- a review eval grading the raw verdict (later reversed).

### 1.4 Verdict

Ambiguity does show up as silent invention. In this factory, though, the invention mostly isn't *resolving the requester's ambiguity*; it is *reading silence as licence to specify*. So the fix is mostly structural: record assumptions, cite sources, don't enforce what nobody asked for. Asking is a narrow complement.

#159 already stops uncited holdout failures from blocking, but only at verify, after the rework has been paid for, and not for spec criteria or review findings.

## 2. Literature

**Agents assume by default, and prompting them to ask is unreliable [S].**
- Unprompted, models "almost never interact, even for severely underspecified inputs" [2].
- Telling them to ask swings between extremes: one model never asked, another asked indiscriminately [2].
- In one study, more than 60% of code-model responses to incomplete problems wrote code instead of asking [5]. Models recognise ambiguity internally but rarely ask [21].
- Preference training rewards presumptive answers [20].

**Real issues are often underspecified, but most have a sensible interpretation [S].**
- SWE-bench Verified's triple-annotated screen of 1,699 issues [1]:
  - 23% well specified;
  - 38% with blanks but a sensible interpretation;
  - 38% vague or nearly impossible.
- Many removals of information turn out benign or merely divergent when tested [7].
- That means three outcomes, not two: proceed; proceed and record; ask.

**Asking pays off when the gap is outcome-critical [S].**
- Interaction recovers 54–89% of fully specified performance on underspecified SWE-bench Verified [2].
- A separate detector agent reached 69.4% resolved, against 70.8% fully specified and 54.8% with no interaction. A single agent told to ask reached 70.4%, but by asking almost every time [3].
- Requirement clarification added 7–10 points of Pass@1 [6].

**Over-asking costs [S].**
- Unneeded questions reduced accuracy on clear problems [5] and user satisfaction [11].
- In a developer study, the main criticism was "excessive or generic questioning" [10].
- Question precision should be scored alongside recall [4].

**Explore before asking [M].**
- Blocker recall was 63% with environment access and 11% from the spec alone [4].
- Stronger agents explored first and asked only what the code couldn't answer [2].
- So triage, which is blind to the code, is the wrong place for most questions. The spec stage, which has read the code, is the right one.

**Timing: before execution, never late [M].**
- Goal clarification loses almost all its value after about 10% of execution.
- Clarification after the midpoint is worse than never asking [8].
- Committing early to an assumption roughly halves multi-turn scores. Restating everything in one consolidated turn recovers most of it [9]. The factory's fresh spec and implement sessions already consolidate this way.

**Question form [W–M].**
- Specific, task-level questions work best [2][10]. Yes/no questions, examples and proposed tests lower user effort [12][13].
- No head-to-head study of multiple-choice versus open versus proposed-default questions for coding agents was found. The industry convergence rests on practice.

**Stating assumptions versus asking [M/W].**
- Explicit assumption layers can be extracted reliably and make revisions targeted [14].
- Ambiguous specs can often be repaired without a human, using execution signals [15].
- No study measures whether reviewers catch surfaced assumptions [16]. Our §1.3 data points the same way.

**Value of information [M].**
- Choosing questions by expected value of information, minus a per-question cost, gives equal or better coverage with 1.5–2.7× fewer questions [17][18].

**LLM ambiguity checkers are advisory [M].**
- The best models found a median 47% of expert-identified requirement issues, with 11% false flags [19].
- So don't let a model's self-rated stakes drive blocking; use deterministic categories.

## 3. Industry practice

| Product | Blocking | Non-blocking | Assumptions shown | Unattended mode |
|---|---|---|---|---|
| Claude Code | `AskUserQuestion` (1–4 multiple-choice questions, with a recommended option) waits; plan approval | Question timeout → proceed on judgement | In the plan, or in the spec in an "interview me" workflow [22][23] | Headless modes remove the question tool |
| Devin | Plan approval when confidence is low [26] | Auto-proceed; unanswered questions are skipped and marked [27] | Plan, confidence rating, PR | Can be disabled |
| Copilot coding agent | None documented [29] | Default | PR, logs | Gates at PR review; Workspace sunset [30] |
| Spec Kit | ≤3 clarification markers; `/clarify` asks ≤5, ranked by impact × uncertainty, with recommended options [31][32] | Informed guesses logged | Dated Clarifications section | Human reviews each phase |
| Cursor | Plan-mode questions | Keeps working while a question is pending [33] | Editable plan | Cloud agents autonomous [34] |
| Codex | Plan mode, only for decisions not discoverable in the repo | Unanswered → use the recommended option and record it as an assumption [35][36] | Assumptions section | Cloud runs to a result |
| Kiro / Amazon Q | Gates between requirements, design and tasks [37][39] | Autonomous mode: "needs attention" [38] | Spec files | Gates skippable |
| OpenHands | Confirmation for risky actions | Headless always approves [40] | PR | No plan gate |
| Factory | Spec-mode questions, then approval [41] | Non-interactive mode fails fast | Spec | Approval can raise autonomy |
| Jules | Plan approval if required | Auto-approve timer plus an automated plan critic [42] | Plan | Default auto-approve |

**Where products converge [S]:**
1. Explore before asking, and never ask what the repository can answer.
2. Cap the number of questions and prioritise them by impact × uncertainty.
3. Offer multiple choice with a recommended default and a free-text escape.
4. Treat silence as "use the default, and record it".
5. Put one gate before execution, with a way to skip it.
6. Scale the asking threshold with reversibility, not just uncertainty [24].

**The main divergence** is whether pending questions block. Model vendors' defaults also point in opposite directions ("bias to action" versus "plan, then ask"), so the harness should own the policy.

## 4. How the orchestrating agent decides

The orchestrating agent (Claude, running Limitless's own development) faces the same question in almost every task. Its working rules match the evidence above:
1. **Look before asking.** Most apparent ambiguity is answerable from the code, the history or project notes, and asking those questions wastes the requester's attention.
2. **Ask only when the decision is the requester's.** That covers preference or product intent, and actions that are irreversible or outward-facing: publishing, deleting, merging, spending money. It also covers options that diverge materially with nothing in the context to settle them. Design choices inside the agent's delegated scope are made and recorded, not asked.
3. **Otherwise, proceed on the most sensible default and say so.** A stated assumption costs the requester seconds to correct; a silent one costs a rework round.
4. **Make questions cheap to answer.** Batch them, give concrete options and a recommended default, say what happens meanwhile, and ask early, before expensive work.

## 5. Recommendation: a decision ledger with deterministic disposition

### 5.1 The ledger (spec stage)

Replace the spec's free-text `assumptions` and `blocking_questions` with `decisions[]`. Each entry has these fields:

| Field | Values |
|---|---|
| `id` | D-n |
| `topic` | — |
| `chosen` | the default |
| `alternatives` | — |
| `owner` | `requester` or `engineer` |
| `basis` | `request`, `codebase`, `convention` or `none`, plus a `citation` |
| `reversibility` | `easy`, `rework` or `hard` |
| `scope_effect` | `none`, `narrows` or `widens` |
| `question` | multiple-choice wording, recommended option first |

`hard` uses the triage risk rubric's high list, plus irreversible migrations: authorisation, secrets, public exposure, merge/deploy/review policy, deleting data or rewriting history, and spending money.

Code validates citations deterministically:
- a request quote goes through the existing citation check from #159;
- a codebase citation must name a path at the base commit that contains the quoted text.

An entry whose citation fails is downgraded to `basis: none`.

### 5.2 Disposition (engine code, not the model)

| Entry | Disposition | Blocks? |
|---|---|---|
| `engineer`, or `codebase`/`convention` with a valid citation | Recorded, and collapsed in the PR | No |
| `scope_effect: widens` | Can't become a requirement or acceptance criterion; moved to out-of-scope or follow-ups (#137) | No |
| Request conflicts with the code | Default to existing behaviour, recorded as a decision and never as a criterion (#137) | No, unless `hard` |
| `requester`, reversibility `easy` or `rework` | Proceed on the default; listed under "Decisions to confirm" at the top of the PR | No |
| `requester` and `hard`, or triage risk `high` | Ask **after spec and before holdout/implement**: at most 3 batched multiple-choice questions, each with a recommended default | **Yes** |
| Triage finds no concrete outcome | Today's clarify path | Yes |
| More than 3 blocking-class entries | Stop and propose a split (#137, #141) | Yes |

- Parking right after spec is cheap: only triage and spec have run.
- Answers re-run the spec with those answers in a fresh session.
- Anything after implement starts is handled at PR review, which avoids the late-clarification penalty [8].

### 5.3 Downstream stages bound to the ledger

- **Holdout.** Each scenario gains a `basis`: a request quote, a spec criterion or a D-n ledger entry.
  - Scenarios without a valid basis are follow-up-only by construction, which moves #159 upstream.
  - A holdout author who disagrees with a default files a non-blocking *dispute* instead of encoding a contradicting expectation. This targets the "stages pick different defaults" pattern behind both genuine cases.
- **Review and verify.** A finding that contradicts a ledger default is a dispute, not a defect. Exceptions: security findings (#169) and a clear break of the request.

### 5.4 Learning

- A `decisions` table (additive migration) records every entry and its outcome: confirmed, overridden at review, answered, or reversed later.
- Stable overrides become per-repo conventions. They land through a reviewed PR and are read from the base commit, like the review lenses in #136. The spec stage cites them as `basis: convention`, so a repeated question becomes a recorded fact.

### 5.5 Deliberately not included

- No LLM-decided control flow.
- No mid-implement questions.
- No blocking on reversible preferences.

Cheap interim steps: move the assumptions list to the top of the PR, and surface medium-ambiguity triage questions instead of dropping them, without blocking.

## 6. Measurement plan

1. **Backtest first.** Re-run the ledger-enabled spec and holdout at the base commits of the 39 rework-corpus runs, and count how many of the 46 bad requirements are neutralised. Each one could be:
   - blocked by the no-widen rule;
   - recorded as a cited conflict;
   - surfaced as a requester decision;
   - left without a basis, making it follow-up-only.

   Also count the blocking questions produced. Success means most of the 46 are neutralised and at most about 10% of runs block.
2. **Eval set `evals/clarify`**, about 60 cases, gold-labelled by the owner with 20% double-labelled:
   - 20 production briefs as-is, to measure unnecessary questions;
   - 20 briefs with one load-bearing sentence deleted, with the ideal question as gold [2][7];
   - 10 traps: scope-creep bait and conflicts with the code;
   - 10 vague requests.
3. **Metrics and initial targets:**

| Metric | Target |
|---|---|
| Missed-decision rate | ≤10%, and 0 for `hard` |
| Unnecessary-question rate | ≤25% of questions asked |
| Share of production runs blocked | ≤10% |
| Questions per parked run | ≤3 |
| Override rate of "Decisions to confirm" | Under 3% over 50 decisions: demote the category. Over 30%: promote it to asking |
| Requirement-caused avoidable rounds | Halve the baseline of ~41 per 100 runs |
| Spec overhead | ≤25% of spec cost |

4. **Detectors to compare:**
   - (a) the spec-stage ledger, which sees the code;
   - (b) the triage model;
   - (c) a Jev typed question as a cheap pre-filter;
   - (d) a separate cheap ledger auditor [3];
   - (e) divergence sampling: two spec drafts, asking where they differ [6][17].
5. **Threshold.** Ask only when P(disagree) × cost(wrong) > cost(ask). Measured costs:
   - a wrong default caught at verify costs a repeat round, about $2.73 equivalent and 16 minutes;
   - caught after merge, it costs a follow-up run, about $8.74 and 48 minutes;
   - an irreversible one is unbounded.

   The owner sets cost(ask) once. For reversible decisions P × ~$9 rarely beats it, so they are surfaced, not asked. `hard` decisions are always asked. That is why the rule keys on reversibility, not on a model's probability estimate [17][24].

## 7. Caveats

- **Small corpus.** One owner, mostly one repository, and 96 runs over four days.
- **Selection effect.** Today's briefs are pre-clarified in an interactive session. As the factory takes GitHub issues and casual chat requests, ambiguity will approach SWE-bench levels [1], and the triage detector will matter more.
- **Single rater.** The categories in §1.2–1.3 are one rater's judgement, with hindsight.
- **Optimistic literature numbers.** Much of the literature uses simulated users who know the full answer.

## References

1. OpenAI, "Introducing SWE-bench Verified". https://openai.com/index/introducing-swe-bench-verified/ (2024-08-13) [S]
2. "Ambig-SWE: Interactive Agents to Overcome Underspecificity in Software Engineering", ICLR 2026. https://arxiv.org/abs/2502.13069 [S]
3. "Ask or Assume? Uncertainty-Aware Clarification-Seeking in Coding Agents". https://arxiv.org/abs/2603.26233 [S/M]
4. "HiL-Bench: Do Agents Know When to Ask for Help?" https://arxiv.org/abs/2604.09408 [M]
5. "HumanEvalComm: Benchmarking the Communication Competence of Code Generation", ACM TOSEM. https://arxiv.org/abs/2406.00215 [S]
6. "ClarifyGPT: Enhancing LLM-Based Code Generation via Requirements Clarification", FSE 2024. https://arxiv.org/abs/2310.10996 [S]
7. "LHAW: Controllable Underspecification for Long-Horizon Tasks". https://arxiv.org/abs/2602.10525 [M]
8. "Ask Early, Ask Late, Ask Right: When Does Clarification Timing Matter for Long-Horizon Agents?" https://arxiv.org/abs/2605.07937 [M]
9. "LLMs Get Lost In Multi-Turn Conversation", ICLR 2026. https://arxiv.org/abs/2505.06120 [S]
10. "Training Proactive and Personalized LLM Agents". https://arxiv.org/abs/2511.02208 [M]
11. "Asking Clarifying Questions: To benefit or to disturb users in Web search?", Information Processing & Management. https://doi.org/10.1016/j.ipm.2022.103176 [S]
12. "Eliciting Human Preferences with Language Models", ICLR 2025. https://arxiv.org/abs/2310.11589 [S]
13. "LLM-Based Test-Driven Interactive Code Generation", IEEE TSE. https://arxiv.org/abs/2404.10100 [S]
14. "AssumptionMiner: Extracting, Tracing, and Revising Implicit Assumptions in LLM Code Generation". https://arxiv.org/abs/2607.22898 [M]
15. "Automated Repair of Ambiguous Problem Descriptions for LLM-Based Code Generation". https://arxiv.org/abs/2505.07270 [M]
16. "Spec-Driven Development for Agentic Software Engineering". https://arxiv.org/abs/2609.00252 [W]
17. "Structured Uncertainty guided Clarification for LLM Agents", Findings of ACL 2026. https://arxiv.org/abs/2511.08798 [S]
18. "Clarify When Necessary: Resolving Ambiguity Through Interaction with LMs", Findings of NAACL 2025. https://arxiv.org/abs/2311.09469 [S]
19. "Two Truths and A Lie? Benchmarking Off-the-Shelf LLMs for Requirements Quality Assessment". https://arxiv.org/abs/2609.03230 [M]
20. "Grounding Gaps in Language Model Generations", NAACL 2024. https://arxiv.org/abs/2311.09144 [S]
21. "Knowing but Not Showing: LLMs Recognize Ambiguity but Rarely Ask Clarifying Questions". https://arxiv.org/abs/2605.25284 [M]
22. Claude Code docs, "Best practices". https://code.claude.com/docs/en/best-practices (accessed 2026-09-29) [S]
23. Claude Code docs, "Tools reference" and "Permission modes". https://code.claude.com/docs/en/tools-reference (accessed 2026-09-29) [S]
24. Claude platform docs, "Prompting best practices". https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices (accessed 2026-09-29) [S]
25. Anthropic, "Measuring AI agent autonomy in practice". https://www.anthropic.com/research/measuring-agent-autonomy (2026-02-18) [M]
26. Cognition, "Devin 2.1". https://cognition.com/blog/devin-2-1 (2025-05-15) [M]
27. Devin docs, release notes. https://docs.devin.ai/release-notes (accessed 2026-09-29) [S]
28. Cognition, "Devin's 2025 Performance Review". https://cognition.com/blog/devin-annual-performance-review-2025 (2025-11-14) [M]
29. GitHub Docs, "About Copilot coding agent". https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent (accessed 2026-09-29) [S]
30. GitHub Next, "Copilot Workspace". https://githubnext.com/projects/copilot-workspace/ (accessed 2026-09-29) [S]
31. GitHub Spec Kit, `/clarify` template. https://github.com/github/spec-kit/blob/main/templates/commands/clarify.md [S]
32. GitHub Spec Kit, `/specify` template. https://github.com/github/spec-kit/blob/main/templates/commands/specify.md [S]
33. Cursor changelog 2.4. https://cursor.com/changelog/2-4 (2026-01-22) [S]
34. Cursor, "What we've learned building cloud agents". https://cursor.com/blog/cloud-agent-lessons (2026-06-02) [M]
35. OpenAI Cookbook, "Codex Prompting Guide". https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide (accessed 2026-09-29) [S]
36. openai/codex, Plan Mode collaboration template. https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/plan.md [S]
37. Kiro docs, "Feature Specs". https://kiro.dev/docs/specs/feature-specs (accessed 2026-09-29) [S]
38. Kiro docs, "Quick Spec" and "Autonomous mode". https://kiro.dev/docs/specs/quick-spec (accessed 2026-09-29) [S]
39. AWS DevOps blog, "Building with AI-DLC using Amazon Q Developer". https://aws.amazon.com/blogs/devops/building-with-ai-dlc-using-amazon-q-developer/ (2025-11-29) [M]
40. OpenHands docs, "Headless Mode". https://docs.openhands.dev/openhands/usage/cli/headless (accessed 2026-09-29) [S]
41. Factory docs, "Interaction Modes" and "Droid Exec". https://docs.factory.com/autonomy-and-safety/specification-mode (accessed 2026-09-29) [S]
42. Jules changelog, "Planning Critic for Auto-Approved Plans". https://jules.google/docs/changelog/2026-01-26-1/ (2026-01-26) [S]
