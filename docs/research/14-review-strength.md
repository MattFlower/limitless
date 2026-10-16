<!-- Research note written on 2026-10-14 (date checked with `date`) from stored eval data (no model calls), the M5.2 dataset at PR #535's labels, and a literature pass. Evidence strength is marked on each claim. -->

# Making the in-run review stronger (2026-10-14)

M5.2's goal is that the factory's own review catches what the orchestrator's adversarial reviews
catch, so the orchestrator no longer has to review every PR. Three variants have been measured on
the dev split (#508 effort, #522 vendor, #531 adversarial prompt) and none was adopted as
registered. This note asks, from the stored trials, *what kind of finding* the production reviewer
misses, what the literature says about each lever, and which levers to pre-register next.

Tags, as in [research/08](08-code-review.md): **[PR]** peer-reviewed, **[arXiv]** preprint, **[IB]**
independent benchmark, **[VB]** vendor post, **[CO]** company tool, **[own]** this repository's
stored data, ⚠️ weak evidence.

## 0. Summary

- **The audit changes two registered results.** Regraded against PR #535's labels (review-088 and
  review-096 become real), the dev split has 49 required defects and 4 clean cases. Replaying the
  grader over the stored trials: production (`codex/sol-6.1@medium`, standard prompt) is at 33.7%
  pooled recall with 2 of 8 clean blocks; `@high` is at 42.9% with 3 of 8; the **adversarial
  prompt is at 45.9% with 2 of 8**. Under the registered rule (+8 points, at most +1 clean block)
  both `@high` and the adversarial prompt now pass; the adversarial prompt does so at +7% tokens
  and +6% time. #535 landed on 2026-10-15; these numbers stay provisional until
  `limitless eval regrade` rewrites the stored grades of E1, E2 and E3, the regraded table is
  posted on #531, and the held-out confirmation that the rule requires has run.
- **Production misses 30 of the 49 dev defects in both trials.** Primary need: 13 required reading
  files the diff did not touch (callers, other entry points, persisted state), 9 required running
  code with an adversarial input (encodings, chunk boundaries, real tool output, a crafted
  repository), 7 were visible in the diff, and 1 needed a project trust convention. Security
  defects are 0 of 12 trials, spec-mismatch 0 of 6. 18 of the 30 were found by none of the four
  stored systems; 12 were found by another system at least once.
- **Sol does not under-rate; it stops early.** Production reports 1.1 findings per trial, almost
  all blocking, against 1.6 gold defects per real case, and uses about 2 of its 20 minutes.
  No production miss was reported at minor severity (0 under-rated, versus many for `claude/opus`).
  The gain from the adversarial prompt is mostly more findings per trial (1.7), not better
  calibration.
- **The eval under-measures production.** 68 of 70 production trial summaries report checks they
  could not run (dependencies absent in the eval worktree). PR #536 adds `setup: true` and a
  `probe` prompt; its baseline arm is the first measurement of the reviewer production actually
  runs.
- **Prompt diversity on one model adds little; sampling the same prompt adds some.** The union of
  the standard and adversarial systems over all four trials catches 27 of 49 defects, the same as
  two samples of the adversarial prompt alone. Two samples of any one system add 4 to 5 defects
  (8 to 10 points) over one sample.
- **Ranked proposals** (§4): (1) union of two adversarial samples, measurable first from stored
  data at no cost; (2) a requirement-and-entry-point trace pass as a second finder; (3) a
  per-item sweep of the repository's recurring-defect list inside the adversarial prompt;
  then the in-flight probe-with-dependencies arm (#530), a wider clean denominator, `@high`, and
  omitting the implementer report. Retrieval of past defects and spec-derived test generation are
  deferred with reasons.

## 1. Where the dev split stands (stored trials, post-audit labels) [own]

Method: the per-defect replay in Appendix A applies `gradeReview`'s rules (file match, line within
±5, one-to-one assignment, blocker/major only) to each stored trial's `output_json` against the
labels on PR #535's branch. Pooled recall is caught defect-trials over 49 × 2. Clean blocks are
trials on the 4 remaining clean cases (review-078, 079, 082, 097) whose derived verdict is
`request_changes`.

| System | Eval | Pooled recall | Union of 2 trials | Clean blocks | Findings / trial | Blocking / trial | Mean time | API-equiv / trial |
|---|---|---|---|---|---|---|---|---|
| E1 `codex/sol-6.1@medium`, standard (production) | eval-mv7igcxy1tl7bg203warej | **33.7%** (33/98) | 38.8% (19/49) | 2/8 | 1.11 | 1.06 | 125 s | $0.18 |
| E1 `codex/sol-6.1@high` | same | 42.9% (42/98) | 46.9% | 3/8 | 1.57 | 1.50 | 239 s | $0.31 |
| E2 `claude/opus` | eval-mv7rznhb0nugf7t09om5i6 | 14.3% (14/98) | 22.4% | 1/8 | 2.69 | 0.69 | 332 s | $0.63 |
| E3 `codex/sol-6.1@medium`, adversarial | eval-mv8gnw6f03ggcas1ml9ate | **45.9%** (45/98) | 55.1% (27/49) | 2/8 | 1.70 | 1.60 | 133 s | $0.19 |

As registered (pre-audit, 47 defects, 6 clean cases): E1 medium 35.1% and 2/12, E1 high 42.6% and
5/12, E2 12.8%, E3 44.7% and 5/12. The audit removed the two clean cases that produced all of
E3's extra blocks and two of E1 high's three.

Other observations from the same data:

- **Review-082 is every system's false block.** It is the only clean case any Sol system blocks
  (both trials, every Sol system). Its finding ("restrict the mode condition to media paths as
  requested") contradicts the adjudicated label, and #508 queued it for audit. With 4 clean cases,
  the false-block denominator is 8 trials; the Wilson 95% upper bound on 2/8 is 0.60, so the
  measure cannot separate variants that differ by one block from noise.
- **Union across systems:** E1 medium ∪ E3 catches 27/49 over all trials (first trials only
  23/49); E1 high ∪ E3 29/49; all four systems 31/49 (63%). 18 defects were caught by nothing.
- **Trial-to-trial variance:** E1 medium catches 14 defects in both trials and 5 in one; E3 18 in
  both and 9 in one. A second sample of the same system adds 8 to 10 points of recall at double
  cost, with no extra clean block in the stored data (the only block, review-082, already fails in
  every trial).
- **Diff size is not the driver** (E1 medium: 25% on diffs under 300 lines, 38% on 300–999, 34%
  on 1000+). **Round is:** 39% on round-1 cases (7 cases) against 31% on later-round cases
  (24 cases), where the orchestrator's finding is the n-th encoding or ordering bypass of a
  guard a previous round added.
- **Reviewers find real defects the labels lack.** In review-087, four of eight Sol trials
  report the submodule-status escape at line 98 as a blocker; it is not gold there (the
  orchestrator's round 1 missed it) but is the gold defect of review-088 after the round moved it
  to line 116. Recall here is recall *relative to the orchestrator's rounds*, as designed, and a
  finding the orchestrator missed earns nothing. On real cases it costs nothing either.
- **Codex already reads AGENTS.md.** The Codex CLI loads the checkout's `AGENTS.md` as project
  instructions and nothing in the harness disables it, so the reviewer has seen "Defects reviews
  keep finding". Nothing in the review prompt asks it to apply that list to the diff.
- **The single-mode prompt does not say "report everything".** The panel finder framings
  (standard and adversarial) end with "Report every issue you believe is real ... a separate step
  verifies each finding"; the single-mode reviewer framing ("Approve only if you would be
  comfortable merging") does not. Part of E3's gain may be that sentence rather than the
  adversarial framing. §4 proposes separating the two.

## 2. Error analysis: the 30 production misses

A miss is a required dev defect that E1 medium caught in neither trial. The table gives the
primary need (what a reviewer would have had to do), the recurring-defect pattern from AGENTS.md
it matches, and which other stored system caught it at least once. The code at each location and
the findings every system reported in the same file were read for this classification (Appendix A
has the replay).

Needs: **diff** = visible in the changed hunks; **files** = required reading code the diff did not
touch (callers, sibling entry points, persisted state, the function a changed call invokes);
**run** = required executing the code with an adversarial input or a real tool's output;
**convention** = required a project rule (trust boundary, compatibility with the running release)
that the code alone does not state.

| Defect | Sev | Category | Need | AGENTS.md pattern | Caught by |
|---|---|---|---|---|---|
| review-046#0 pinned slot deadline exits without recording the chain-exhaustion question | major | error-handling | diff (+ sibling exits in the same function) | one guard, every path | none |
| review-050#0 legacy adoption trusts Git paths chosen by an agent-controlled checkout | blocker | security | convention (trust boundary) | trust boundaries | high, opus, adv |
| review-050#1 draft delivery and interrupted prepare reuse a legacy worktree before registration | major | completeness | files (resume paths before the guard) | one guard, every path; resume | none |
| review-052#0 `timed out after` on arbitrary assertion text classifies a failure as transient | major | logic | diff | parse, don't substring-match (#385 is this case) | none |
| review-052#1 retry eligibility checks security only on the selected error line | major | security | diff | canonicalize, then check | adv |
| review-053#1 passing security-test output blocks a transient rerun | major | logic | diff | parse, don't substring-match | opus |
| review-054#1 ANSI-coloured Bun and pytest security failures miss the retry exclusion | major | security | run (real Bun output under colour) | canonicalize, then check | high, adv |
| review-056#0 catalog mutation invalidates a shadowed retained policy; daemon cannot restart | blocker | data-migration | files (policy layers) + restart | leave the previous release working | adv |
| review-058#0 retrying an unchanged run turns inherited chains into explicit overrides | major | logic | diff (+ request semantics) | — | opus, adv |
| review-058#1 routing previews stay stale after quota or cooldown expiry without an event | major | correctness | files (which events exist) | derive current state | opus |
| review-070#0 short registered secrets stay visible in digest fields | major | privacy | run (short secret) | redact at every boundary | none |
| review-072#0 layered URL and Unicode encodings bypass the single-pass decoder | major | privacy | run (layered encoding) | decode before you redact | none |
| review-073#0 digest title truncation before filtering discloses private prefixes | major | privacy | diff (order of two calls) | redact before you truncate | none |
| review-076#0 smoke invocations ignore model-origin exclusions | blocker | spec-mismatch | files (an entry point outside the diff) | one guard, every path | none |
| review-077#0 queued chat dispatch uses a target excluded after selection | blocker | spec-mismatch | files + check-then-act | check-then-act across an await | none |
| review-077#1 queued eval dispatch does not revalidate origin after catalog changes | blocker | spec-mismatch | files + check-then-act | check-then-act across an await | none |
| review-080#0 NUL-free opaque executable content bypasses the allowance | major | security | run (crafted content) | classify by validated structure | none |
| review-087#0 post-check private-string scan runs git against mutable clone config | major | security | files (what `check_private` runs) + request tracing | one guard, every path | none |
| review-088#0 isolated status still inspects populated submodules with their own git dirs | major | security | run (populated submodule probe) | trust boundaries | high, opus, adv |
| review-093#0 forced-colour Bun result markers are not recognised | major | correctness | run (real Bun output) | canonicalize, then check | adv |
| review-096#0 provider export writes the built-in model into config; next startup throws | major | logic | files + restart reasoning | runs created before the change still resume | opus, adv |
| review-098#0 removing a built-in model leaves persisted routing overrides unloadable | major | data-migration | files (persisted overrides) | leave the previous release working | high |
| review-098#1 a runtime model on a retired provider prevents factory construction | major | data-migration | files (runtime models table) | leave the previous release working | none |
| review-098#2 historical run references block unrelated catalog mutations | major | logic | files (history validation) | derive current state | high |
| review-099#0 unavailable-target diagnostics expose credentials in the routing API | major | privacy | files + convention | redact at every boundary | none |
| review-100#0 retired identifiers and history can publish credentials | major | privacy | files + convention | redact at every boundary | none |
| review-103#0 JSON escaping lets credentials evade literal redaction | major | privacy | run (escaped secret) | decode before you redact | none |
| review-105#1 ANSI stripping after framing and tail cuts leaves fragments | major | privacy | diff (order of operations) | redact before you truncate | none |
| review-106#0 an incomplete terminal escape consumes part of a credential | major | privacy | run (chunk boundary) | canonicalize, then check | none |
| review-106#1 terminal-control stripping changes with chunk boundaries | major | privacy | run (chunk boundary) | canonicalize, then check | none |

### 2.1 By primary need

| Need | Misses | Caught by another system |
|---|---|---|
| files the diff did not touch | 13 | 6 |
| running code with an adversarial input | 9 | 3 |
| visible in the diff | 7 | 3 |
| a project convention alone | 1 | 1 |

Conventions are the *secondary* need for 12 more: the AGENTS.md ordering rules (decode before
redact, redact before truncate), the compatibility rules (persisted state, previous release) and
the trust-boundary rule each name the exact defect class.

### 2.2 By gold category (E1 medium, pooled over 2 trials)

| Category | Gold | Caught | Recall |
|---|---|---|---|
| privacy | 15 | 9/30 | 30% |
| logic | 10 | 10/20 | 50% |
| security | 6 | 0/12 | **0%** |
| data-migration | 5 | 3/10 | 30% |
| error-handling | 4 | 5/8 | 63% |
| correctness | 3 | 2/6 | 33% |
| spec-mismatch | 3 | 0/6 | **0%** |
| completeness | 2 | 2/4 | 50% |
| resource | 1 | 2/2 | 100% |

Security and spec-mismatch are where the orchestrator's reviews differ most in method: they
construct an adversarial input or repository and run it, and they re-read the request's "every"
and "never" clauses against every entry point.

### 2.3 By AGENTS.md's recurring-defect pattern

| Pattern | Misses |
|---|---|
| Canonicalize, then check; parse instead of substring-matching | 8 |
| Redaction order (decode before redact, redact before truncate, every boundary) | 7 |
| One guard, every path | 5 |
| Compatibility with the running release and persisted state | 4 |
| Trust boundaries | 2 |
| Check-then-act across an await | 2 |
| Derive current state; don't replay history | 2 |

22 of the 30 misses match a listed pattern. The reviewer has read the list (§1) but is not asked
to apply it item by item.

### 2.4 Found by nobody

The 18 defects no stored system caught cluster in three groups:

1. **Encoding and chunk-boundary bypasses of redaction** (070#0, 072#0, 073#0, 099#0, 100#0,
   103#0, 105#1, 106#0, 106#1): the orchestrator's rounds on #394, #419 and #421 each found the
   next bypass of the previous round's fix. A reviewer finds these by writing the input that
   splits, escapes or re-encodes a secret and running the function. No stored trial did; most
   reported "targeted suites could not load" instead.
2. **Entry points outside the diff** (050#1, 076#0, 077#0, 077#1, 087#0, 098#1): the request said
   "every route", "never after the checks", "resume"; the change guarded the paths it touched.
   Finding them means enumerating callers and siblings (`rg` for the guard's name and for the
   function the guard protects), which is cheap and deterministic to ask for.
3. **Visible logic misses** (046#0, 052#0, 080#0): the reviewer found a different defect in the
   same file and stopped. 052#0 is the regex the AGENTS.md list cites by number.

## 3. Literature and practice scan

What is new since [research/08](08-code-review.md) (2026-09-28), organised by lever. Evidence is
separated from claims; numbers are not comparable across benchmarks.

### 3.1 Reproduction-first review and execution-grounded verification

- **Evidence.** AnyPoC [arXiv 2604.11950] generates proof-of-concept tests for LLM bug reports;
  against Claude Code and Codex as validators it produced 37% more valid PoCs for true reports
  and rejected 9.7× more false reports, confirmed by developers on 12 large systems (108 of 121 new
  bugs confirmed). "Verify Before You Fix" [arXiv 2604.10800] gates repair on execution-grounded
  validation; removing it raised unnecessary repairs by 132%. Refute-or-Promote [arXiv 2604.19049,
  single author ⚠️] reports a 79% kill rate on 171 candidates from adversarial "refute" agents with a
  mandatory empirical gate, and one case where ten reviewers endorsed a non-existent padding
  oracle that a single test killed. research/08 §2.8: 46% of passing agent-written validation
  tests also pass on buggy code; about a third of real bugs can't be proven within budget.
- **Claims.** OpenAI's deployed reviewer has repo-wide tools and code execution and "accepts
  modestly reduced recall" for precision; verification is cheaper than generation in their
  budget sweep [VB]. Anthropic's Code Review checks findings to remove false positives but
  does not say it runs code [VB].
- **Reading for Limitless.** Execution is the strongest *precision* lever and the only lever
  that reaches group 1 of §2.4, but a probe mandate can cut recall where probes can't run (nested
  Seatbelt, loopback servers). #530's design keeps severity when the probe is blocked, which is
  right; it must be measured against a `setup: true` baseline, since 68 of 70 production trials
  report blocked checks.

### 3.2 Test generation as review

- **Evidence.** The misguidance effect [PR, ISSTA 2026, arXiv 2607.22883]: tests generated from
  buggy code tend to assert the bug; generating from a specification docstring instead reduced
  misguided tests and increased bug-finding ones (magnitudes not in the abstract). ChaCo [PR,
  ICSE 2026] reached full patch coverage on 30% of 145 PRs and found previously unknown bugs.
  "Coding Agents as Test-Suite Auditors" [arXiv 2608.01715] had agents write adversarial suites
  that exposed 589 verified accepted-but-buggy submissions out of 20,375 on AtCoder, within 1.7
  points of official-suite coverage on the bugs those suites catch. research/08 §2.8: a proof test
  must fail on the defective head.
- **Reading.** Limitless already has this in the verify stage: a blind holdout author writes
  scenarios from the request and spec, which is exactly the misguidance mitigation. The review
  stage should not duplicate it. What review lacks is *regression* probes against the diff
  (a test the reviewer writes from the request that fails at head), which #530's probe prompt
  covers for the findings it raises. The spec-mismatch misses (0 of 6) would be caught by
  requirement tracing (§3.3) before by test generation.

### 3.3 Specification and requirement tracing

- **Evidence.** "Systematic Overcorrection in Requirement Conformance Judgement" [PR, Automated
  Software Engineering 2026; arXiv 2603.00539]: LLMs frequently misclassify correct code as
  non-compliant, and prompts that demand explanations and fixes make it worse; the proposed
  fix-guided filter checks the model's own proposed fix against tests. Requirement-coverage
  analysis [arXiv 2506.14627 ⚠️ GPT-3.5] reached 99.7% recall on *missing* coverage when a
  requirement was removed. SWE-PRBench [arXiv 2603.26130, IB]: eight frontier models detect 15 to
  31% of human-flagged issues diff-only, and recall *fell* monotonically as more file and repository
  context was stuffed into the prompt (attention dilution), which repeats research/08 §2.7: context
  helps when agent-pulled, hurts when dumped.
- **Claims.** "The Specification as Quality Gate" [arXiv 2603.25773] is a position paper: AI review
  is circular without executable specifications, and homogeneous pipelines echo errors; its
  experiments are small and planted.
- **Reading.** Tracing is good at *absence* (an unmet "every path" clause) and prone to false
  rejection of compliant code. A trace pass should report only an unguarded path it can name by
  file and line, never "the requirement seems unmet", and the false-block count decides it.

### 3.4 Checklists from a project's recurring defects

- **Evidence.** BitsAI-CR [PR, FSE 2025]: a defect taxonomy raised precision from about 17% to 57%
  at some recall cost; raw LLM output did not meet production precision. iCodeReviewer's
  mixture-of-prompts ablation [arXiv 2510.12186, security only]: removing specialised prompt
  experts cut issue-identification recall from 62.7 to 43.3 (the baseline is a single yes/no
  question, not a generalist review ⚠️). research/08 §2.9: frontier models gain less from
  behavioural scaffolding; small models gain more. Prompt additions are not monotonic across
  tasks [arXiv 2601.22025].
- **Practice.** G-Research's tool validates every finding against a rules index built from a
  standards document, maps severity deterministically from MUST/SHOULD, runs a recall pass then a
  precision pass with false-positive examples, and gates model adoption on 100% recall for MUST
  rules and above 85% precision [CO, no achieved numbers]. Greptile's learned rules moved its
  address rate from 19% to 55% [VB, research/08]. No controlled before/after on learned project
  rules was found.
- **Reading.** The repository already has the list and the reviewer has read it (§1). The lever
  is *forced application*: per item, name where in the diff it applies and what was checked. On
  frontier models expect a modest gain concentrated in the 22 pattern-matching misses, with a
  precision risk from pattern-shaped findings on clean changes.

### 3.5 Multi-pass and diverse-prompt ensembles, self-consistency

- **Evidence.** SWR-Bench [PR]: same-model aggregation at n=10 raised recall 119% and F1 44%
  (plateau around n=5 to 10). c-CRAB [arXiv 2603.23448, IB]: four tools individually pass 20 to
  32% of review-derived tests, their union 41.5%. Four commercial reviewers on 146 PRs overlapped
  on 6.6% of 617 flagged locations [practitioner ⚠️]. Correlated errors [PR, ICML 2025]: majority
  vote beats the best single model in about 10% of 3-model ensembles. A 2026 comparison
  [arXiv 2606.15689] reports union *lowering* recall (0.29 to 0.22), which the matching procedure
  cannot produce as described, so it is unreliable. Own data (§1): two samples of one Sol prompt add
  4 to 5 of 49 defects; adding the standard prompt to the adversarial one adds none.
- **Claims.** Vendors dropped majority-vote filtering (Bugbot v2) because it loses rare real
  bugs [VB, research/08]. Multi-agent coordination returns turn negative once a single agent passes
  about 45% [arXiv, research/08].
- **Reading.** Union, never vote. Diversity should come from *mechanism* (what the pass does:
  probe, trace, checklist) rather than from prompt wording on the same model, which the stored
  data shows is redundant. Union of two samples is the cheapest measurable gain and can be checked
  on stored data today.

### 3.6 Retrieval of similar past defects

- **Evidence.** RARe [arXiv 2511.05302]: one retrieved past review helps; more hurt (redundancy and
  conflicting cues). LAURA [arXiv 2512.01356]: retrieval over 298k past reviews gives 42% fully
  correct comments. Few-shot bug references improved MPI defect detection recall [arXiv 2604.02398,
  one domain]. KITE [arXiv 2607.11573] injects historical bug mechanisms into test generation. No
  controlled study of same-repository past defects as review context was found; research/08 §2.7
  says dumped context lowers recall.
- **Reading.** Limitless's natural corpus is `evals/review/cases.json` and `labelHistory`, which is
  also the measurement set: any retrieval variant must be evaluated leave-one-PR-out or it is
  contaminated. The 7 redaction misses are near-duplicates of each other, which is the case for
  retrieval, and also the case for a one-line convention. Defer until a clean corpus exists outside
  the dataset (the review-outcome ledger research/08 §5 proposed).

### 3.7 Benchmarks and what "strong" means elsewhere

Recall of human-flagged issues sits at 15 to 31% diff-only (SWE-PRBench), 20 to 32% per tool on
test-graded review (c-CRAB), and about 0.5 precision at 0.5 recall for the best commercial tools on
Martian's benchmark [IB]. Production's 34% against the orchestrator's findings is in that range;
the adversarial prompt's 46% is above it. No published system reaches the parity M5.2 asks for,
so the target is set by the orchestrator's method (reproduce, trace every entry point, apply the
list), not by a benchmark.

## 4. Ranked proposals

Rules respected: LLMs work only inside the review stage and the merge of their outputs is
deterministic (union by file and ±5 lines, as `panel-merge` already does); nothing reduces
reviewer effort, coverage or model quality; every arm is pre-registered on the 35 dev cases at
k=2 with the standing rule (pooled dev recall +8 points over the then-current production system;
clean false blocks up by at most 1 on the same clean trials), with held-out run once per adopted
change. Costs are per review from the stored trials ($0.18 and 125 s for production).

**Already in flight, ordered first because they are free or paid for:**

- **A0. Adopt the adversarial prompt after the audit.** #535 landed on 2026-10-15; next,
  `eval regrade` E1, E2 and E3, post the regraded table on #531, and run the held-out
  confirmation that is being pre-registered.
  Expected: +12 points on dev (provisional), +0 clean blocks, +7% tokens. Build: none (the
  production schema today refuses a non-standard single prompt; adoption is a small schema and
  config change). Risk: the clean denominator is 8 trials; see A4.
- **A0b. Probe with dependencies (#530, PR #536).** Its `setup: true` baseline is the first
  honest measurement of production. Run the probe arm with the adversarial framing as well as the
  standard one, since the adversarial prompt is the likely production base by then. Expected: the
  9 run-needed misses are its target; the literature says execution buys precision first and
  recall second.

**New proposals:**

### A1. Union of two adversarial samples (self-consistency, n=2)

- **What.** Single mode gains `samples: 2`: the reviewer runs twice on the same prompt in parallel
  (fresh sessions), findings are unioned by `reviewFindingKey` and merged within ±5 lines, the
  verdict is derived as today. No vote, no verifier.
- **Expected gain.** Stored data: E3's union of two trials catches 27/49 (55.1%) against a
  single-sample mean of 45.9%, +9 points; E1 medium +5 points. Expect regression toward +5 to +8
  on fresh samples. Clean blocks: the OR of two samples; in stored data the only clean block
  (review-082) already fails in every trial, so +0 there, but on held-out expect some increase.
- **Pre-check on stored data (2026-10-15, free).** A replay that unions the two stored E3 trials
  per case with the panel merge rules (dedupe by file, line and title; merge within ±5 lines,
  keeping the more severe finding and the other line as an alias) and grades the union with
  `blockingReviewFindings` and the grader's one-to-one matching, cross-checked against
  `gradeReview` on every grading:

  | | single sample, pooled ×2 | union of 2 |
  |---|---|---|
  | E3 adversarial @medium | 45/98 (45.9%) | **27/49 (55.1%)**, Wilson 41–68%, +9.2 points |
  | clean blocks | 2/8 | 1/4 |
  | E1 standard @medium | 33/98 (33.7%) | 19/49 (38.8%), +5.1 |
  | E1 standard @high | 42/98 (42.9%) | 23/49 (46.9%), +4.1 |

  The gain is spread across categories (privacy 9/30 → 6/15, logic 13/20 → 7/10, security
  6/12 → 4/6); spec-mismatch stays 0 in every variant, since a second sample does not look where
  the first never looked. Resampling the 31 real cases, the gain's 95% interval is +3.7 to +15.7
  and the probability of at least +8 is 64%, with only 8 of 31 cases improving. The baseline
  prompt's samples are less diverse (its interval cannot reach +8). Merging within ±5 lines costs
  one defect against exact dedupe (27 against 28), so the registered design must name the merge.
  This settles nothing under the rule: the stored pair is the data the proposal came from, and
  the registered baseline is four fresh samples.
- **Cost.** 2× reviewer tokens (+$0.19 per review) and no added wall time when parallel (two
  provider slots for about 2 minutes).
- **Build.** About 80 lines: a `samples` field on single systems (eval and production schema), a
  parallel invocation in `runReview`, union through the existing merge, cache identity includes
  `samples`. One restart test (both samples recorded as invocations; a resume does not re-run a
  recorded sample).
- **Measure.** Step 1, free: a replay script forms the union of E3's two stored trials per case
  (one union trial per case) and reports recall and clean blocks; this is a pre-check, not the
  decision. Step 2, paid: run the adversarial reviewer at k=4 on the 35 dev cases (about $27,
  2 hours at eval concurrency); form two union trials per case (t0∪t1, t2∪t3) and compare against
  the single-sample pooled recall of the same four samples, so the baseline is paid once.
  Held-out once if adopted.

### A2. A requirement-and-entry-point trace pass (second finder, union)

- **What.** A second finder in single mode with a `trace` prompt whose only job is absence:
  (1) list the request's universal clauses ("every", "all", "never", "only", "after the
  checks", "on resume"); (2) for each guard the diff adds or changes, enumerate the sibling call
  sites and entry points with `rg` (the guard's name, the protected function's name, the
  configuration key) and the persisted state that outlives a restart; (3) report only an
  unguarded path it can cite by file and line, with the clause it violates. It never re-reviews
  the diff for logic defects. Findings are unioned with the main reviewer's.
- **Expected gain.** Targets 13 "files" misses and the 0/6 spec-mismatch class: 076#0, 077#0,
  077#1, 087#0, 050#1, 098#1, 099#0, 100#0, 056#0, 096#0. If it catches half, +10 points. The
  overcorrection literature (§3.3) says the risk is false rejection of compliant code, so the
  prompt forbids findings without a cited path, and the clean false-block count decides.
- **Cost.** One more reviewer invocation per review (+$0.19, +2 minutes in parallel; the trace
  pass reads more files than the main reviewer, so expect +50% input tokens on large diffs).
- **Build.** About 150 lines: a `trace` finder prompt in `prompts.ts`, single-mode systems with
  two finders and no verifier (today single mode takes exactly one finder; a `union` mode or a
  second-finder slot), union through `panel-merge` with the agreement count recorded, cache
  identity. Production schema keeps refusing it until adopted.
- **Measure.** Dev at k=2 against the then-current production system; report recall by category
  so the spec-mismatch and security rows are visible, and the trace pass's own findings
  separately (how many it added, how many of those landed on gold, how many blocked a clean case).

### A3. A per-item sweep of the recurring-defect list inside the adversarial prompt

- **What.** The adversarial prompt gains a fenced checklist built at base from AGENTS.md's
  "Defects reviews keep finding" (and the redaction ordering rules), and a structured field in the
  review output: for each item, `applies` (which changed hunks), `checked` (what it did:
  a command, a traced path, an input it tried) and `finding` (id or none). The grader ignores the
  field; only findings count. The list is read from the base commit's AGENTS.md, never the PR's
  (trust boundary), and is capped in length.
- **Expected gain.** 22 of 30 misses match a listed item; frontier models gain less from
  behavioural scaffolding (research/08 §2.9), and Codex has already read the list, so expect +3 to
  +8 points, concentrated in the canonicalize and redaction-order rows. False-block risk is
  moderate: pattern-shaped findings on clean changes; the structured `checked` field is there so a
  review can be audited for pattern matching without evidence.
- **Cost.** +10 to 20% tokens, no added time.
- **Build.** About 60 lines: prompt assembly from base AGENTS.md (the lens machinery already reads
  base `.limitless.toml`), schema field, eval-only prompt variant `adversarial-checklist`.
- **Measure.** Dev at k=2 against the adversarial baseline (E3's stored trials). Secondary: count
  findings whose `checked` names an input or command versus a bare pattern match, to see whether
  the list drives probes.

**Supporting proposals, lower in rank:**

- **A4. Widen the clean denominator.** Add the 13 clean cases outside the M5.2 splits
  (review-068 onward and the held-out-v3 clean set, all merged PRs with no later finding) to every
  dev arm's false-block measure at k=2: 26 more trials, about $5 per system. With 8 trials a
  single block is a 12.5-point swing and the Wilson upper bound sits at 0.6; with 34 the measure
  can tell variants apart. Pre-register the rule as "clean blocks up by at most 1 in 34".
- **A5. "Report everything" without adversarial framing.** A `standard-full` single prompt that
  adds only the "Report every issue you believe is real" sentence, to separate the two parts of
  E3's gain. Free to build; one paid arm ($13).
- **A6. `@high`.** Passes the rule post-audit (+9 points, +1 block) at +70% cost and +90% time.
  Hold it as the fallback if the adversarial prompt fails held-out, or stack it later on whatever
  is adopted; the union E1 high ∪ E3 at 29/49 says the two gains overlap only partly.
- **A7. Omit the implementer report** (`[review] implementer_report = "omit"`, already
  supported). research/08 §2.3: author framing cut detection by 5 points on Opus 4.5 and far more
  on weaker models. Free to build; one paid arm.
- **A8. Round-2 blocking rule.** 24 of 31 dev real cases are later-round reviews, where the
  orchestrator's finding was a new major; in production a new major in round 2 is a follow-up
  unless it is a regression or security. The eval grades the round-1 rule, so adopting any variant
  does not by itself close this gap. Measure it separately: grade later-round cases' stored
  outputs under the later-round rule with the case's prior findings, and decide whether a verified
  new major should block in round 2 (research/08 §5 "let a newly found verified high block").

**Deferred, with reasons:** retrieval of past defects (no clean corpus outside the measurement
set; leave-one-PR-out needed; §3.6); spec-derived test generation (verify already does it blind;
§3.2); a cross-vendor finder (E2 at 14% with calibration problems; a union with it adds 2 of 49);
a causal-attribution verifier (null result, #235).

### Suggested order

1. A0 and A4 now (regrade, held-out for the adversarial prompt, wider clean denominator), so the
   next decisions rest on a denominator that can move.
2. A1's free replay this week; its paid arm with A0b's probe arm in one eval run (shared baseline).
3. A2, then A3, each on the then-current production system.

## Appendix A. Replay method

The per-defect replay (`scripts`-free, run from a scratch directory against the daemon's database
opened read-only) imports `blockingReviewFindings` from `src/pipeline/review.ts`, reads each
trial's `output_json` for the four systems above, and applies `gradeReview`'s matching (file
normalisation, ±5 lines, line 0 for completeness, one-to-one assignment most-severe-first) with
one change: it returns the matched defect per finding instead of counts. Labels came from
`evals/review/cases.json` on PR #535's branch (merged to main on 2026-10-15, unchanged). Pooled
recall per system matched the registered
reports when run against the pre-audit labels (33/94, 40/94, 12/94, 42/94), which checks the
replay against the grader.

Per-defect catches (dev split; `k/2` is trials caught, `u` under-rated):

| Defect | Sev | E1 medium | E1 high | E2 opus | E3 adv |
|---|---|---|---|---|---|
| review-044#0 historical policy edit keeps invalidating later selections | major | 2/2 | 2/2 | 1/2 | 2/2 |
| review-045#0 unlimited quota still applies reserves to free and metered providers | major | 2/2 | 2/2 | 1/2 u | 2/2 |
| review-046#0 pinned slot deadline exits without recording the question | major | 0/2 | 0/2 | 0/2 | 0/2 |
| review-050#0 legacy adoption trusts agent-chosen Git paths | blocker | 0/2 | 1/2 | 1/2 | 2/2 |
| review-050#1 draft delivery reuses a legacy worktree before registration | major | 0/2 | 0/2 | 0/2 | 0/2 |
| review-051#0 fixed cutoff excludes earlier worktrees | major | 2/2 | 2/2 | 2/2 | 2/2 |
| review-052#0 `timed out after` on arbitrary text is transient | major | 0/2 | 0/2 | 0/2 | 0/2 |
| review-052#1 security check only on the selected error line | major | 0/2 | 0/2 | 0/2 | 1/2 |
| review-052#2 paused PR not re-inspected when main recovers | major | 2/2 | 2/2 | 2/2 | 2/2 |
| review-052#3 accepted rerun with a lost response never reconciled | major | 1/2 | 2/2 | 0/2 | 2/2 |
| review-053#0 refused rerun stays pending | major | 2/2 | 2/2 | 1/2 | 2/2 |
| review-053#1 passing security output blocks a transient rerun | major | 0/2 | 0/2 | 1/2 | 0/2 |
| review-054#0 rate-limit refusals leave claims unresolved | major | 2/2 | 1/2 | 0/2 | 1/2 |
| review-054#1 ANSI-coloured and pytest security failures missed | major | 0/2 | 2/2 | 0/2 | 1/2 |
| review-056#0 catalog mutation invalidates a shadowed policy | blocker | 0/2 | 0/2 | 0/2 u | 2/2 |
| review-057#0 effort removal ignores cells hidden by overrides | blocker | 1/2 | 1/2 | 0/2 | 1/2 |
| review-058#0 retry converts inherited chains into overrides | major | 0/2 | 0/2 | 1/2 u | 2/2 |
| review-058#1 previews stale after quota expiry | major | 0/2 | 0/2 | 2/2 | 0/2 |
| review-058#2 clearing a default effort omits the field from PATCH | major | 2/2 | 2/2 | 0/2 | 2/2 |
| review-058#3 catalog history disappears on reload | major | 2/2 | 0/2 | 0/2 u | 2/2 |
| review-069#0 digest actions from stale records | major | 2/2 | 2/2 | 0/2 u | 2/2 |
| review-069#1 historical failed review hides a later approval | major | 2/2 | 2/2 | 0/2 | 2/2 |
| review-070#0 short secrets visible in digest fields | major | 0/2 | 0/2 | 0/2 u | 0/2 |
| review-070#1 MCP status returns private land reasons | blocker | 2/2 | 2/2 | 0/2 | 2/2 |
| review-071#0 Unicode and URL encodings evade privacy filter | major | 1/2 | 2/2 | 0/2 | 1/2 |
| review-072#0 layered encodings bypass the single-pass decoder | major | 0/2 | 0/2 | 0/2 | 0/2 |
| review-073#0 truncation before filtering discloses prefixes | major | 0/2 | 0/2 | 0/2 u | 0/2 |
| review-076#0 smoke ignores origin exclusions | blocker | 0/2 | 0/2 | 0/2 | 0/2 |
| review-077#0 queued chat dispatch uses an excluded target | blocker | 0/2 | 0/2 | 0/2 | 0/2 |
| review-077#1 queued eval dispatch does not revalidate origin | blocker | 0/2 | 0/2 | 0/2 | 0/2 |
| review-080#0 NUL-free opaque executable bypasses the allowance | major | 0/2 | 0/2 | 0/2 | 0/2 |
| review-087#0 post-check scan runs git against clone config | major | 0/2 | 0/2 | 0/2 | 0/2 |
| review-088#0 isolated status inspects populated submodules | major | 0/2 | 2/2 | 1/2 u | 2/2 |
| review-093#0 forced-colour Bun markers not recognised | major | 0/2 | 0/2 | 0/2 u | 1/2 |
| review-096#0 provider export makes the runtime row fatal | major | 0/2 | 0/2 | 1/2 u | 1/2 |
| review-098#0 removed model leaves overrides unloadable | major | 0/2 | 2/2 | 0/2 | 0/2 |
| review-098#1 runtime model on a retired provider | major | 0/2 | 0/2 | 0/2 | 0/2 |
| review-098#2 historical run references block mutations | major | 0/2 | 2/2 | 0/2 | 0/2 |
| review-099#0 diagnostics expose credentials | major | 0/2 | 0/2 | 0/2 | 0/2 |
| review-100#0 retired identifiers publish credentials | major | 0/2 | 0/2 | 0/2 | 0/2 |
| review-101#0 output cut before redaction | major | 2/2 | 2/2 | 0/2 | 2/2 |
| review-103#0 JSON escaping evades redaction | major | 0/2 | 0/2 | 0/2 u | 0/2 |
| review-103#1 line callbacks store credential pieces | major | 1/2 | 1/2 | 0/2 | 1/2 |
| review-104#0 lossy excerpt framing prevents matching | major | 1/2 | 2/2 | 0/2 | 1/2 |
| review-104#1 excerpt collection retains unbounded bytes | major | 2/2 | 2/2 | 0/2 u | 2/2 |
| review-105#0 early carry redaction emits suffixes | major | 2/2 | 2/2 | 0/2 | 2/2 |
| review-105#1 ANSI stripping after cuts leaves fragments | major | 0/2 | 0/2 | 0/2 | 0/2 |
| review-106#0 incomplete escape consumes part of a credential | major | 0/2 | 0/2 | 0/2 | 0/2 |
| review-106#1 stripping changes with chunk boundaries | major | 0/2 | 0/2 | 0/2 | 0/2 |

Clean cases: review-082 blocks in every Sol trial and one Opus trial; review-078 blocks in one
`@high` trial; review-079 and review-097 never block.

## Appendix B. Draft issues (not filed; for approval)

### B1. M5.2: union of two adversarial reviewer samples (pre-registered)

M5.2 Review parity, next variant after #531. Design recorded before the run.

**Question.** Does the union of two independent samples of the adversarial reviewer catch more of
the orchestrator's findings than one sample, without more false blocks on clean changes?

**Why.** In the stored dev trials, two samples of one system catch 4 to 5 more of the 49 required
defects than one (research/14 §1); SWR-Bench reports same-model aggregation raising recall at
n up to 10. Union, never vote: majority filtering loses rare real bugs.

**Systems.** Baseline: `codex/sol-6.1@medium` with the adversarial prompt, one sample (E3's stored
trials plus the two new samples below). Variant D: the same reviewer sampled twice in parallel,
findings unioned by file and ±5 lines, verdict derived as today.

**Build (eval first).** `samples: 2` on single systems in the eval schema; parallel invocation in
`runReview`; union through the existing merge with the agreement count recorded; `samples` in the
cache identity. Production schema refuses it until adopted. About 80 lines plus tests, including a
restart test (a recorded sample is not re-run on resume).

**Cases and run.** The 35 dev ids, adversarial prompt, k=4 samples per case; two union trials per
case are formed from (t0, t1) and (t2, t3), and the single-sample baseline pools all four. One
eval run, about $27 and 2 hours.

**Measures.** Pooled blocking recall with Wilson 95% (overall and by severity and category), clean
false blocks (with the wider clean set if #A4 has landed), verdict accuracy, tokens and time.

**Decision rule.** Adopt only if dev recall rises by at least 8 points over the single-sample
baseline and clean false blocks rise by at most 1. Held-out once if adopted.

**Pre-check, already run on stored data (not the measurement).** Unioning the two stored
adversarial trials per dev case gives 27/49 (55.1%) against 45/98 single-sample, +9.2 points
with a resampled 95% interval of +3.7 to +15.7 (P(≥ +8) = 64%), and 1/4 clean blocks against
2/8. The same union on the standard prompt gains +5.1 at medium and +4.1 at high. Exact dedupe
gives 28/49; the ±5-line merge 27/49, so the merge rule is fixed here: panel merge, with the
merged line kept as an alias. The stored pair is the data the proposal came from, so this
decides nothing; it shows the direction and that dev clean blocks do not move.

**Out of scope.** More than two samples; a verifier; any production change before held-out.

### B2. M5.2: a requirement-and-entry-point trace pass as a second finder (pre-registered)

**Question.** Does a second finder that only looks for unguarded paths raise recall on the
orchestrator's spec-mismatch and every-path findings without more false blocks?

**Why.** Production catches 0 of 6 spec-mismatch defect-trials and misses 13 defects that required
reading files the diff did not touch (research/14 §2). The orchestrator finds these by re-reading
the request's "every", "never" and "on resume" clauses against each entry point.

**What.** A `trace` finder prompt: list the request's universal clauses; for each guard the diff
adds or changes, enumerate sibling call sites and entry points with `rg` and the persisted state
that outlives a restart; report only an unguarded path cited by file and line with the clause it
violates. No logic review. Single mode accepts a second finder with this prompt; findings are
unioned with the main reviewer's by the existing merge; no verifier. Eval-only until adopted.

**Systems.** Baseline: the then-current production reviewer (adversarial if adopted). Variant E:
baseline plus the trace finder.

**Cases and run.** The 35 dev ids, k=2. One eval run, about $27 plus the trace pass's input tokens.

**Measures.** As #531, plus recall by category and the trace finder's findings reported
separately: added, landed on gold, blocked a clean case.

**Decision rule.** As #531 (+8 points, at most +1 clean block). Held-out once if adopted.

**Budget and scope.** About 150 source lines plus tests. Out of scope: a verifier, the probe
prompt, production adoption.

### B3. M5.2: per-item recurring-defect sweep in the adversarial prompt (pre-registered)

**Question.** Does asking the reviewer to apply the repository's recurring-defect list item by item
raise recall without more false blocks?

**Why.** 22 of production's 30 dev misses match an item in AGENTS.md's "Defects reviews keep
finding" or the redaction ordering rules. The Codex reviewer has read the file; nothing asks it to
apply the list to the diff. BitsAI-CR's taxonomy raised precision; G-Research gates rules on
recall per severity; frontier models gain less from behavioural scaffolding, so the gain is
uncertain and must be measured.

**What.** An `adversarial-checklist` eval prompt: the adversarial prompt plus a fenced checklist
read from the base commit's AGENTS.md (never the PR's), capped in length, and a structured
`checklist[]` output field per item: `applies` (changed hunks), `checked` (command, traced path or
input tried), `finding` (id or none). Grading ignores the field.

**Systems.** Baseline: E3's stored adversarial trials. Variant F: the checklist prompt.

**Cases and run.** The 35 dev ids, k=2, about $15.

**Measures.** As #531, plus how many findings cite a command or input in `checked` versus a bare
pattern match.

**Decision rule.** As #531. Held-out once if adopted.

**Budget and scope.** About 60 source lines plus tests. Out of scope: lenses, the probe prompt,
production adoption.

## References (new in this note; others in research/08)

- AnyPoC, arXiv 2604.11950 [arXiv]
- Verify Before You Fix, arXiv 2604.10800 [arXiv]
- Refute-or-Promote, arXiv 2604.19049 [arXiv ⚠️ single author]
- Misguidance effect in LLM unit tests, ISSTA 2026, arXiv 2607.22883 [PR]
- Coding Agents as Test-Suite Auditors, arXiv 2608.01715 [arXiv]
- ChaCo, ICSE 2026, doi 10.1145/3744916.3787768 [PR]
- Systematic Overcorrection in Requirement Conformance Judgement, arXiv 2603.00539 [PR]
- SWE-PRBench, arXiv 2603.26130 [arXiv][IB]
- The Specification as Quality Gate, arXiv 2603.25773 [arXiv, position]
- iCodeReviewer, arXiv 2510.12186 [arXiv]
- BitsAI-CR, FSE 2025, arXiv 2501.15134 [PR]
- When Generic Prompt Improvements Hurt, arXiv 2601.22025 [arXiv]
- G-Research, "Building a code review tool: the LLM patterns that actually work" [CO]
- c-CRAB, arXiv 2603.23448 [arXiv][IB]
- Bigger Isn't Always Better, arXiv 2606.15689 [arXiv ⚠️ union result inconsistent]
- RARe, "When More Retrieval Hurts", arXiv 2511.05302 [arXiv]
- LAURA, arXiv 2512.01356 [arXiv]
- MPI error detection with bug references, arXiv 2604.02398 [arXiv]
- KITE, arXiv 2607.11573 [arXiv]
- OpenAI, "A Practical Approach to Verifying Code at Scale" [VB]
- Anthropic, Code Review for Claude Code, claude.com/blog/code-review [VB]
