# Review label adjudication

Pre-registered rule, recorded 2026-10-03 (date checked with `date`): a `clean`
case becomes `real` only when all three conditions hold:

1. An adjudicator independent of the review system being measured confirms a
   defect of medium severity or higher, introduced or newly exposed by the
   change. Before/after evidence must be a reproduction, or quoted code at the
   pinned case head with the base revision for contrast.
2. The orchestrator re-runs the reproduction or checks the quoted code, and the
   evidence holds.
3. The correction is recorded in the case's `labelHistory`, including its
   original kind, date, rule, adjudicator and evidence.

Low-severity issues never relabel a case. Apply the rule equally to every
measured system; the production panel's round-1 blocking rule is unchanged.

The independent adjudication on 2026-10-03 used codex/sol-6.1 at high effort;
its evidence was then confirmed by the orchestrator. It corrected review-033,
review-036, review-037 and review-039. review-010 and review-034 remain clean
because their issues were low severity; review-038's finding was not a defect.
The case records quote the checked head code and identify the base contrast.

Reports retain the existing metrics for current labels and add
`review.originalLabels` when any evaluated case has a history. The original
kind is the first history entry's `from`; cases without a history use their
current kind. Originally clean cases contribute to original clean false-block
counts, with no required defects in original recall. Required defects added by
these corrections contribute only to current-label recall. Both views use
stored output and the same production blocking rule; reporting does not modify
stored grades, and `eval regrade` updates current grades without model calls.

## M5.2 candidate rule — 2026-10-08

Pre-registered on 2026-10-08 (checked with `date`), before adjudication or
variant measurement. The independent adjudicator is codex/sol-6.1 at high
effort, independent of the systems being measured. A finding is gold only
when it is medium severity or higher, exists at the pinned case head, and
was introduced or newly exposed by the change. Evidence must be a
reproduction or quoted code at head against base; the orchestrator then
checks the evidence. Low findings remain optional candidates and cannot
become gold under this rule.

Pending defects are not gold. No measurement may use a case with any
`adjudication: "pending"` defects. This change supplies candidates only;
the orchestrator runs adjudication on the PR branch and records outcomes
in a follow-up commit. Run `bun scripts/review-pending.ts [caseId...]` to
print the pending candidates and their pins without network or model calls.

Record every rejected or downgraded finding in `labelHistory` with its
reason and checked evidence. Remove rejected findings from `defects`;
retain downgraded findings at their lower severity. Confirmed defects use
`adjudication: "confirmed"`. History may contain real→real entries.
A case left with no gold defects is dropped unless its review returned
MERGE, in which case it is relabelled clean with a real→clean history entry.
An initial clean control requires MERGE and no findings; a MERGE review
with findings starts as a real candidate. Existing cases are unchanged.

Source assembly combines overlapping findings at the same PR and reviewed
commit, preserving review order from the public PR commit history. Database
round names use `round-1`, `round-2`, etc in `source` to satisfy the required
single-token source-name format; `foundBy` retains the readable round name.
Original stored requests and archive specs supply prompts; direct jobs
without an issue spec (#395, #397, #399 and #403) use their public PR
descriptions. Private paths, email addresses, configured private strings
and internal run identifiers in prompts are replaced with placeholders.
Unranked documentation corrections are provisional minor candidates;
P1/P2 map to major/minor as in the archive's round exports, and moderate
maps to major. The archive index records rev419c as MERGE with a residual
finding, so review-100 starts real and is eligible for the MERGE exception.

Whole PRs are split before any variant is measured. The fixed seed is
`427202610`; `assignReviewSplits` in `scripts/review-pending.ts` sorts and
deduplicates the PR numbers, uses xorshift32 with shifts 13, 17 and 5 to
drive a Fisher–Yates shuffle, and assigns the first round(n/3) PRs to
heldout. The remaining PRs are dev. Recompute using this full PR list;
individual findings and review rounds never cross splits. Routing and
prompt decisions may use dev only; heldout is reported once per decision.

| PR | Split |
|---|---|
| #367 | heldout |
| #368 | heldout |
| #378 | dev |
| #379 | dev |
| #380 | dev |
| #382 | heldout |
| #384 | dev |
| #385 | dev |
| #386 | heldout |
| #387 | dev |
| #389 | dev |
| #391 | dev |
| #392 | heldout |
| #393 | heldout |
| #394 | dev |
| #395 | dev |
| #396 | dev |
| #397 | dev |
| #399 | dev |
| #400 | heldout |
| #401 | heldout |
| #403 | dev |
| #405 | dev |
| #406 | heldout |
| #408 | dev |
| #415 | dev |
| #418 | dev |
| #419 | dev |
| #421 | dev |
| #424 | heldout |

## M5.2 adjudication procedure — 2026-10-08

Recorded on 2026-10-08 (checked with `date`) before any candidate was
adjudicated. It applies the candidate rule above to every pending defect.

- **Every pending defect is adjudicated, minor and nit included.** Only
  blocker and major defects can be gold (`required: true`). A confirmed minor
  or nit stays as an optional defect (`required: false`), so a review that
  reports it is matched instead of counted as an unexpected finding. A
  confirmed blocker or major whose real severity is lower is downgraded and
  kept at the lower severity; downgraded to minor, it becomes optional. A
  rejected candidate is removed and recorded in `labelHistory`.
- **The defect must be in the change.** It must exist at the case head and be
  introduced or newly exposed by `base..head`. Findings about delivery or
  process rather than code at head (merge conflicts, branch state, the PR
  description) are rejected. Two candidates in one case that describe the
  same defect are merged into one.
- **Evidence or rejection.** The adjudicator quotes the code at head with the
  base contrast, or gives a reproduction. A candidate without evidence is
  rejected. Behaviour that needs real Seatbelt can't be reproduced inside the
  adjudicator's own sandbox (macOS can't nest Seatbelt profiles), so for those
  quoted code is the evidence, or the orchestrator reproduces it unconfined.
- **Location.** The adjudicator gives the file and line range at head where
  the defect is expressed. The grader credits a finding in the same file
  within five lines of that range, so the range covers the lines a reviewer
  would cite, and it replaces the candidate's approximate range.
- **Independence.** The adjudicator (codex/sol-6.1, high effort) is the same
  model as production's in-run reviewer, and many candidates came from
  orchestrator reviews run on that model. Its verdict alone is therefore not
  evidence. The orchestrator re-quotes every cited range at head and base,
  re-runs every reproduction, and checks rejections as well as
  confirmations. Report results for Sol 6.1-based systems on these cases with
  this caveat.
- **Amendment, 2026-10-08, after a three-case pilot.** A requirement stated
  in the case's request that the change does not meet at head is a defect of
  the change (category `completeness` or `spec-mismatch`), even when the code
  involved is unchanged from base: the change was asked to fix it. The
  evidence quotes the requirement from the request and the code at head. A
  defect present at base that the request didn't ask the change to address
  is still rejected. The pilot (review-087, review-101 and review-106) showed
  the adjudicator rejecting three unmet requirements as pre-existing; those
  cases are re-adjudicated under this text, and no other outcome was seen
  before it was written.

## M5.2 adjudication outcomes — 2026-10-08

All 183 candidates in review-040 to review-107 were adjudicated under the rule and procedure above (codex/sol-6.1, high effort, one job per case at its head). The orchestrator:

- re-checked every quoted line against `git show` at head and base, and every quoted requirement against the case's request;
- re-ran every reproduction (commands that touch git remotes or signals ran with network denied, after their targets were checked);
- read the reasons for every rejected, downgraded or re-rated blocker and major candidate, and for every confirmed gold defect in both splits.

Clean controls (review-068, 078, 079, 082, 088, 092, 096, 097, 108) had no candidates.

Result: of the 183 candidates, 90 were confirmed at blocker or major (gold), 43 at minor or nit (optional), and 50 were rejected or merged as duplicates; 13 confirmations were downgrades. 12 cases kept no gold defect and were dropped with their 20 optional defects; no dropped case had a MERGE review. The retained cases hold 90 gold and 23 optional defects. Gold defects by split: dev 47, heldout 43.

**Orchestrator overrides.** Each replaced verdict has a `labelHistory` entry by `orchestrator, overriding codex/sol-6.1 high` with its evidence.

- review-042 #0, confirmed blocker. The adjudicator couldn't run Seatbelt inside its own sandbox. Evidence is a platform probe plus head code: unconfined, an inner `sandbox-exec` exits 71 under any outer profile that denies something, and head's nested signal probe applies one under the factory's restrictive profile before every tool-enabled Codex invocation.
- review-064 #0, confirmed blocker. Unconfined, head's reader network rules make `listen()` on an ephemeral loopback port fail with EPERM; the same probe under an allow-default profile listens and connects.
- review-101 #3, confirmed minor. Two adjudication passes disagreed. The request keeps the raw-text launch scan authoritative, and the reproduction shows normalized output still creating a blocking confinement error.
- review-107 #0, confirmed major. The request says not to raise the flaky test's timeout without understanding it; head doubles the deadline while the git index-lock race that caused the failure remains.
- review-049 #0, rejected (was a confirmed blocker). For consistency with review-047: the request defines inert media by extension and asks for no content validation, so an archive carried inside a WebP is the same polyglot class.

**Rejections kept after reading** include defects that existed at base outside the request's scope (for example #382's extension-list policy, #401's non-push git calls, and #421's rows stored by an earlier release), design choices the request allowed, delivery or process concerns, and claims the evidence did not reproduce.

**Held-out exposure.** The orchestrator read the held-out cases in detail while labelling, including two of the overrides above. Variant and routing choices for the review stage must be justified from dev cases; held-out results are reported once per decision, as pre-registered.

| Case | PR | Split | Gold | Optional | Downgraded | Rejected | Outcome |
|---|---|---|---|---|---|---|---|
| review-040 | #367 | heldout | 5 | 2 | 2 | 0 | kept |
| review-041 | #367 | heldout | 0 | 1 | 1 | 2 | dropped (no gold defect) |
| review-042 | #368 | heldout | 4 | 4 | 0 | 7 | kept |
| review-043 | #368 | heldout | 0 | 1 | 0 | 2 | dropped (no gold defect) |
| review-044 | #378 | dev | 1 | 1 | 0 | 0 | kept |
| review-045 | #379 | dev | 1 | 1 | 0 | 0 | kept |
| review-046 | #380 | dev | 1 | 0 | 0 | 1 | kept |
| review-047 | #382 | heldout | 2 | 0 | 1 | 3 | kept |
| review-048 | #382 | heldout | 3 | 1 | 1 | 3 | kept |
| review-049 | #382 | heldout | 1 | 0 | 0 | 1 | kept |
| review-050 | #384 | dev | 2 | 0 | 0 | 1 | kept |
| review-051 | #384 | dev | 1 | 1 | 0 | 0 | kept |
| review-052 | #385 | dev | 4 | 0 | 0 | 0 | kept |
| review-053 | #385 | dev | 2 | 0 | 0 | 0 | kept |
| review-054 | #385 | dev | 2 | 0 | 0 | 0 | kept |
| review-055 | #386 | heldout | 0 | 0 | 0 | 1 | dropped (no gold defect) |
| review-056 | #387 | dev | 1 | 0 | 0 | 1 | kept |
| review-057 | #387 | dev | 1 | 0 | 0 | 0 | kept |
| review-058 | #389 | dev | 4 | 0 | 0 | 0 | kept |
| review-059 | #391 | dev | 0 | 1 | 0 | 0 | dropped (no gold defect) |
| review-060 | #392 | heldout | 3 | 0 | 0 | 0 | kept |
| review-061 | #392 | heldout | 4 | 0 | 1 | 2 | kept |
| review-062 | #392 | heldout | 2 | 0 | 1 | 0 | kept |
| review-063 | #392 | heldout | 1 | 0 | 0 | 0 | kept |
| review-064 | #393 | heldout | 2 | 0 | 0 | 0 | kept |
| review-065 | #393 | heldout | 1 | 0 | 0 | 2 | kept |
| review-066 | #393 | heldout | 1 | 0 | 1 | 2 | kept |
| review-067 | #393 | heldout | 2 | 0 | 0 | 2 | kept |
| review-069 | #394 | dev | 2 | 0 | 0 | 1 | kept |
| review-070 | #394 | dev | 2 | 0 | 1 | 0 | kept |
| review-071 | #394 | dev | 1 | 0 | 0 | 1 | kept |
| review-072 | #394 | dev | 1 | 0 | 0 | 0 | kept |
| review-073 | #394 | dev | 1 | 0 | 0 | 0 | kept |
| review-074 | #395 | dev | 0 | 9 | 2 | 3 | dropped (no gold defect) |
| review-075 | #395 | dev | 0 | 1 | 0 | 0 | dropped (no gold defect) |
| review-076 | #396 | dev | 1 | 2 | 1 | 0 | kept |
| review-077 | #396 | dev | 2 | 0 | 0 | 1 | kept |
| review-080 | #399 | dev | 1 | 0 | 0 | 1 | kept |
| review-081 | #399 | dev | 0 | 0 | 0 | 1 | dropped (no gold defect) |
| review-083 | #400 | heldout | 4 | 0 | 0 | 0 | kept |
| review-084 | #401 | heldout | 3 | 1 | 0 | 1 | kept |
| review-085 | #401 | heldout | 0 | 0 | 0 | 5 | dropped (no gold defect) |
| review-086 | #403 | dev | 0 | 2 | 0 | 0 | dropped (no gold defect) |
| review-087 | #405 | dev | 1 | 1 | 0 | 0 | kept |
| review-089 | #406 | heldout | 1 | 2 | 0 | 1 | kept |
| review-090 | #406 | heldout | 1 | 0 | 0 | 0 | kept |
| review-091 | #406 | heldout | 1 | 0 | 0 | 0 | kept |
| review-093 | #408 | dev | 1 | 3 | 0 | 0 | kept |
| review-094 | #408 | dev | 0 | 1 | 0 | 0 | dropped (no gold defect) |
| review-095 | #408 | dev | 0 | 1 | 0 | 0 | dropped (no gold defect) |
| review-098 | #419 | dev | 3 | 0 | 0 | 0 | kept |
| review-099 | #419 | dev | 1 | 0 | 0 | 1 | kept |
| review-100 | #419 | dev | 1 | 0 | 0 | 0 | kept |
| review-101 | #421 | dev | 1 | 1 | 0 | 2 | kept |
| review-102 | #421 | dev | 0 | 3 | 0 | 2 | dropped (no gold defect) |
| review-103 | #421 | dev | 2 | 0 | 0 | 0 | kept |
| review-104 | #421 | dev | 2 | 1 | 1 | 0 | kept |
| review-105 | #421 | dev | 2 | 0 | 0 | 0 | kept |
| review-106 | #421 | dev | 2 | 2 | 0 | 0 | kept |
| review-107 | #424 | heldout | 2 | 0 | 0 | 0 | kept |

## M5.2 clean-case audit — 2026-10-14

Recorded 2026-10-14 (checked with `date`), under the rule above: an independent adjudication by
codex/sol-6.1 at high effort, then the orchestrator re-running the evidence, recorded in
`labelHistory`. The audit covers every blocking finding on a dev clean case by every stored dev
system, not only the variant being decided: E1 (`codex/sol-6.1@medium` and `@high`, #508), E2
(`claude/opus`, #522) and E3 (`codex/sol-6.1@medium` with the adversarial prompt, #531). Only
review-082 was queued for audit in advance (#508). The other cases were examined after E3's result
was known, so reports give every result both as registered and after the audit, and any decision
that changes stays provisional until its held-out confirmation. Each adjudication used the same
instructions; only the case and the claims differed.

| Case | PR | Split | Gold | Optional | Downgraded | Rejected | Outcome |
|---|---|---|---|---|---|---|---|
| review-078 | #396 | dev | 0 | 0 | 1 | 0 | stays clean |
| review-082 | #399 | dev | 0 | 0 | 0 | 1 | stays clean |
| review-088 | #405 | dev | 1 | 0 | 0 | 0 | relabelled real |
| review-096 | #415 | dev | 1 | 0 | 1 | 0 | relabelled real |

- **review-078** (blocked by E1 `@high` once): when origin exclusion leaves only a self-verifying
  verifier, the error drops the exclusion reason. Newly exposed but low severity: the run still
  stops before verification.
- **review-082** (blocked by every system): two claims.
  - Claim 1 is rejected because it isn't new: non-UTF-8 executable scripts still need
    `Allow: binary`, but base required it for every executable path.
  - Claim 2 was confirmed major: an edited Latin-1 script whose mode changes from 100755 to
    100644 newly needs the allowance.
  - The case still stays clean, because clean cases are merged heads with no later fix. This
    behaviour was never fixed; it was adopted as the rule in AGENTS.md ("an executable or
    mode-changed file needs Allow: binary unless its content is reviewable text"). A gold defect
    here would count a reviewer that follows AGENTS.md as having missed it.
  - An earlier adjudication of the same claims rated claim 2 low. Its instructions included that
    AGENTS.md text as context, unlike the others, so it isn't used.
  - No E1, E2 or E3 verdict depends on this case.
- **review-088** (blocked by E1 `@high` and E3 on both trials, and by E2 once): the isolated
  post-check `status` runs a clean filter from the land clone's configuration through a populated
  submodule whose `.git` points at the clone's admin directory. Base emptied the clone's filter keys
  and did not run it. The same gap in today's factory git calls is #533.
- **review-096** (blocked by E3 once and E2 once): after `limitless providers export --write`, the
  retained runtime `claude/haiku-5.5` row makes startup throw `catalog collision`, reproduced in an
  isolated home. A second claim, that the row can't be removed, is low. Still open on main as #534.

After the audit, the dev clean set is four cases (eight trials at k=2) instead of six. A rule of
"at most one more clean false block" is therefore looser on dev than it was, so held-out carries
more of the weight for decisions measured after this audit.

## M5.2 fresh clean set — procedure, 2026-10-15

Recorded on 2026-10-15 (checked with `date`), for #542, before any candidate was selected or
adjudicated.

**Why.** The clean set no longer discriminates. Dev has 4 clean cases after the 2026-10-14
audit. Production's reviewer and the adversarial variant blocked the 3 held-out clean cases in
5 and 6 of 6 trials (#541).

- **Candidates.** Merged pull requests in MattFlower/limitless and MattFlower/limitless-sandbox,
  merged from 2026-10-08 up to two days before selection. Excluded:
  - hand-built pull requests (branches under `hand/`);
  - pull requests already used for a case;
  - any pull request with a later fix: a later commit, pull request or issue that corrects a
    defect in its change, found by a line-level survey of later history.
- **Pins.** The case base is the merged pull request's base on main, and the case head is the
  head that merged. Cases whose `base..head` history contains `evals/*` carry `snapshot: true`.
  The request is the pull request's original issue or description, with private strings,
  paths and internal identifiers replaced by placeholders.
- **Blind vetting by two vendors.** Before any measured system runs on a candidate, two
  adjudicators each review it once, with the same instructions: codex/sol-6.1 at high effort,
  and claude/opus. Each reports every defect of medium or higher severity introduced or newly
  exposed by `base..head`, with a reproduction or quoted code at head against base. Two vendors,
  because a clean set filtered by one model family would favour reviewers of that family.
- **Verification.** The orchestrator re-runs or re-quotes every claim, rejections included.
  - A confirmed defect of medium or higher severity makes the candidate a real case. It is
    labelled under the 2026-10-08 rule and leaves the clean set.
  - Claims that don't hold are recorded here, and the candidate stays clean.
  - Low-severity findings never change the label.
- **Split and size.** Candidates take the fixed-seed pull-request split (`assignReviewSplits`
  in `scripts/review-pending.ts`). Selection continues until each split has at least 12 clean
  cases or candidates run out, and the counts are reported either way.
- **Use.** The new clean cases join their splits. Decisions measured before this set existed
  keep their recorded verdicts. Results for systems built on either adjudicator's model carry
  the usual independence caveat.

## M5.2 fresh clean set — results, 2026-10-16
Recorded on 2026-10-16 (checked with `date`). This follows the 2026-10-15 procedure above, for #542. The selection manifest was frozen at 2026-10-15 20:22 EDT and posted on #542 before any adjudicator ran.

- **Population and exclusions.** 61 pull requests merged in MattFlower/limitless and MattFlower/limitless-sandbox on 2026-10-08 through 2026-10-13, by America/New_York merge date. Excluded:
  - 8 `hand/` branches;
  - 6 pull requests already used for cases;
  - 13 with a later fix: #433, #436, #443, #449, #458, #460, #469, #479, #483, #485, #489, #492, #499.

  The later-fix survey ran `git log -L` over each squash commit's added hunks up to current main, plus later issues and pull requests that reference the candidate. Every pairing was classified by hand; the manifest on #542 gives each fix reference.
- **Eligible: 34.** Splits come from `assignReviewSplits` (seed 427202610) over the 34 eligible numbers: 11 held out and 23 development. Sandbox pull requests are written `sb#N` below; their numbers don't collide with this repository's.
- **Order and stop.** Every held-out candidate was vetted. Development candidates were vetted in ascending merge time until 12 were confirmed clean. The 9 later development candidates were not vetted and stay out.
- **Adjudication.** codex/sol-6.1 at high effort and claude/opus each reviewed every vetted candidate once, against the same input: the scrubbed request and `base..head`, but not the pull request body. They agreed on 23 of 25 candidates. The orchestrator re-ran or re-quoted every claim.
- **Method correction.** The first request builder preferred a pull request's closing issue over the factory's own `## Request` section, which is the text the change was written for. All 34 requests were compared afterwards. Two differed materially:
  - #471 had not been vetted, and its request was replaced first.
  - #446 had been vetted once against the older issue text. That pass is kept only as a record. Both vendors re-ran on the factory request, and only the re-run decides its label.

| Candidate | Split | Outcome |
|---|---|---|
| #431 | heldout | clean (review-112) |
| #438 | heldout | clean (review-114) |
| #445 | heldout | clean (review-118) |
| #455 | heldout | clean (review-123) |
| #456 | heldout | clean (review-124) |
| #466 | heldout | clean (review-126) |
| #478 | heldout | real (review-129) |
| #490 | heldout | clean (review-130) |
| sb#8 | heldout | clean (review-131) |
| sb#10 | heldout | clean (review-132) |
| sb#14 | heldout | clean (review-133) |
| #414 | dev | clean (review-109) |
| #428 | dev | clean (review-110) |
| #430 | dev | clean (review-111) |
| #437 | dev | clean (review-113) |
| #444 | dev | clean (review-117) |
| #439 | dev | clean (review-115) |
| #447 | dev | clean (review-120) |
| #442 | dev | clean (review-116) |
| #454 | dev | clean (review-122) |
| #446 | dev | real (review-119) |
| #451 | dev | clean (review-121) |
| #463 | dev | clean (review-125) |
| #467 | dev | real (review-127) |
| #468 | dev | clean (review-128) |
| #471 | dev | not vetted (dev stop) |
| sb#9 | dev | not vetted (dev stop) |
| sb#11 | dev | not vetted (dev stop) |
| #497 | dev | not vetted (dev stop) |
| #481 | dev | not vetted (dev stop) |
| #503 | dev | not vetted (dev stop) |
| #504 | dev | not vetted (dev stop) |
| sb#12 | dev | not vetted (dev stop) |
| sb#13 | dev | not vetted (dev stop) |

**Counts.**
- **Held out:** 10 clean and 1 real. Only 11 candidates were eligible, so the registered 12 couldn't be reached, as the procedure allows.
- **Development:** 12 clean and 2 real.
- **Docs-only clean cases:** 3 (review-109, review-112, review-118). These don't separate reviewers.
- **Cost:** about $16 API-equivalent on the Claude subscription for the Opus adjudications, plus the Codex adjudications on the ChatGPT subscription.

**Claims, verified by the orchestrator.**
- **#478 (both vendors), confirmed major, real.** The head MCP proxy sends `repo` to `/api/runs` (`src/integrations/mcp.ts:235`) and returns `runs.slice(0, limit)` without checking that the filter was applied. A base-release daemon reads only `status`, `ids` and `limit`, so against an older daemon `limitless_list_runs {repo}` returns other repositories' runs as matches. Codex reproduced this against the base route code. AGENTS.md requires a newer client to keep working against an older daemon.
- **#446 (claude/opus on the re-run; codex/sol-6.1 found it clean), confirmed major, real.** `owner_diagnostics` declares `event_id` and `invocation_id` with `ON DELETE CASCADE` but indexes only `(run_id, id)`. With `PRAGMA foreign_keys = ON`, the daemon's synchronous bulk `DELETE FROM events WHERE level = 'debug' …` scans the table once per deleted event. Measured with the real Store: deleting 20,000 events took 13 ms with no owner rows and 5,318 ms with 20,000 owner rows. Production has the same schema; #558 tracks the fix.
- **#467 (both vendors), confirmed major, real.** Delivery stops after a clean factory merge is persisted and before the push. On resume after the base moves again, the second merge's first parent is the earlier merge, but `assertDeliveryHead` calls `validateMerge(worktree, reviewedSha, base)`, which requires `[reviewedSha, base]`. The run ends needs_human. Both vendors reproduced it at head, and it succeeded at base. Main has the same check; #559 tracks it.
- **sb#14 (codex/sol-6.1 only), confirmed but minor, stays clean.** `dedupe --ignore-case` keeps `ΟΣ`/`Οσ` and `Straße`/`STRASSE` as distinct lines. The request doesn't ask for Unicode case folding, and per-line `toLowerCase()` is the conventional implementation.
- **#446, first pass against the older request (record only).** The claims matched the closed #429 design: write-time redaction removed, UI access, raw invocation logs. The factory request explicitly kept write-time redaction and made the UI optional, so these weren't labels.

**Use.** The 22 new clean cases join their splits. Decisions measured before this set existed keep their recorded verdicts. Results for systems built on Sol 6.1 or Opus carry the usual independence caveat, because both adjudicators are those models.

## Escape-case rule — 2026-10-23

Pre-registered before any escape-case results: `scripts/review-escape-cases.ts` draws
candidates from `review_rounds` of kind `review`, using the reviewed head, the source
run's exact request, and the merge base with the default branch as of the round.
Conflict and CI rounds are excluded. The generator makes heuristic proposals only;
the original `blocker` severity is not a gold label. Proposals remain outside the
public repository, next to the database by default.

An independent adjudicator may propose labels. The orchestrator checks the reproduction
and delivered fix, then confirms each finding in a JSON object keyed by
`<owner>/<repo>#<pr>/round-<round>/<zero-based finding index>`. Each value has
`classification` (`defect`, `merge-main`, `docs-process`, `decision`, or `other`),
`severity` (`blocker`, `major`, `minor`, or `nit`), `category`, and `confirmedBy`.
Only confirmed code defects of medium severity or higher (`major` or `blocker`) are
written by `--write --confirm <file>`; they are required defects. Merge-main requests,
docs/process asks and answers to implementer questions do not become gold defects.
A case with no eligible defect is omitted.

Each case records a real→real `labelHistory` entry naming the confirmer and date,
the reproduction in the orchestrator's review, the factory's delivered fix SHA,
and the original findings text. This is the evidence for the existing adjudication
rule, not a claim inferred from the incoming severity. Invalid pins, missing files,
fixes that touch no defect file, snapshot-stripped `evals/` defects and private text
are excluded with reasons. No model calls or eval runs are part of generation.

Split assignment is fixed by PR-number parity: even PRs go to **escapes-dev**;
odd PRs go to **escapes-heldout**. All rounds of a PR share its split. Existing
cases never move into or out of a split. These splits form a new family, independent
of the existing `dev`/`heldout` assignment and seed.

## Held-out clean-case audit — 2026-10-30

Every M5.2 held-out system blocked review-068, review-092 and review-108, so held-out clean blocks were
saturated. Each blocking claim from the stored held-out evals was adjudicated blind (system identity
withheld) by codex/sol-6.1 at high effort and by claude/opus, under the 2026-10-08 rule. The orchestrator
then re-ran the evidence in a checkout of each case's head. Claims the two adjudicators rated differently
were settled by consequence: medium needs a realistic input in normal operation.

| Case | PR | Split | Gold | Optional | Downgraded | Rejected | Outcome |
|---|---|---|---|---|---|---|---|
| review-068 | #393 | heldout | 2 | 0 | 1 | 0 | relabelled real |
| review-092 | #406 | heldout | 1 | 0 | 2 | 1 | relabelled real |
| review-108 | #424 | heldout | 1 | 0 | 1 | 1 | relabelled real |

Downgraded claims stay as optional (minor) defects, as in the M5.2 procedure.

- **review-068.**
  - *Major:* any skipped file in a candidate gate disables gate substitution. The repository's confined
    suite intentionally skips real-Seatbelt tests, so the loopback failure the request targets remains.
    #647 later fixed this on main; its issue reports about 20 of 49 needs_human runs caused by it.
  - *Blocker:* the coverage parser takes a test-printed `test/missing.test.ts:` line as a file header.
    Output from the change under test can therefore mark a file that never ran as passed, and that
    becomes factory evidence. Reproduced with a real `bun test`.
  - *Minor, not gold:* a crash between the gate checkpoint and stage completion rejects cached gates on
    resume. This needs a hard kill between two synchronous writes, and the run ends needs_human as
    before the change.
- **review-092.**
  - *Major:* a changed result resets the loop count but keeps earlier same-key entries, which the
    request says must be dropped. Twelve identical failing commands between progressing polls are never
    stopped.
  - *Minor, not gold:* forgetting an evicted baseline stops a genuine repeat loop at most one call
    early. A poll that never returns defers the stop.
  - *Not gold:* pending identical calls finalised by an unrelated call. Base behaves the same.
- **review-108.**
  - *Major:* the change's gate command `bun test --parallel=$(bun scripts/test-workers.ts)` is
    rejected by gate-evidence's command recogniser. Gate evidence can then no longer satisfy
    sandbox-blocked criteria on this repository.
  - *Minor, not gold:* the worker count is missing from the baseline cache key. The only effect is on
    flake classification.
  - *Process, not gold:* measurements missing from the PR description.

After the audit, the held-out clean set is the ten clean cases from the 2026-10-16 fresh set.
review-114 is the only held-out case blocked by both production and D, and both of its claims were
rejected. review-133's Unicode claim was already confirmed minor (sandbox PR #14 above). Decisions
measured before this audit keep their recorded verdicts. #551 (D) recorded 10/26 clean blocks against
7/26. On true clean cases it is 4/20 against 2/20.
