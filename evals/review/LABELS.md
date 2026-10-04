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
