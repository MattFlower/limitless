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
