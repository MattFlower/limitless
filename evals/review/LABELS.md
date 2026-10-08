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

All 183 candidates in review-040 to review-107 were adjudicated under the rule and procedure above (codex/sol-6.1, high effort, one job per case at its head). The orchestrator re-checked every quoted line against `git show` at head and base, re-ran every reproduction (commands touching git remotes or signals ran with network denied after their targets were checked), and read every rejected, downgraded or re-rated blocker and major candidate. Clean controls (review-068, 078, 079, 082, 088, 092, 096, 097, 108) had no candidates.

Result: of the 183 candidates, 91 were confirmed at blocker or major (gold), 43 at minor or nit (optional), and 49 were rejected or merged as duplicates; 13 confirmations were downgrades. Twelve cases kept no gold defect and were dropped with their 20 optional defects; no dropped case had a MERGE review. The retained cases hold 91 gold and 23 optional defects. Gold defects by split: dev 47, heldout 44.

**Orchestrator overrides** (the adjudicator's verdict replaced, with the evidence in the case's defect or history):
- review-042 #0, confirmed blocker. The adjudicator couldn't run Seatbelt inside its own sandbox. Unconfined, an inner `sandbox-exec` exits 71 under any outer profile that denies something, and head requires that nested apply before every tool-enabled Codex invocation.
- review-064 #0, confirmed blocker. Unconfined, head's reader network rules make `listen()` on an ephemeral loopback port fail with EPERM; the same probe under an allow-default profile listens and connects.
- review-101 #3, confirmed minor. Two adjudication passes disagreed; the request keeps the raw-text launch scan authoritative, and the reproduction shows normalized output still creating a blocking confinement error.
- review-107 #0, confirmed major. The request says not to raise the flaky test's timeout without understanding it; head doubles the deadline while the git index-lock race that caused the failure remains.

**Rejections the orchestrator checked and kept** include findings whose defect existed at base outside the request's scope (for example #382's extension-list policy, #401's non-push git calls, and redaction of rows stored by an earlier release in #421), deliberate design choices the request allowed, delivery or process concerns, and claims the evidence did not reproduce.

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
| review-049 | #382 | heldout | 2 | 0 | 0 | 0 | kept |
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
