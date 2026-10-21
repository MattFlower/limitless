# M5.2 Variant E: requirement and entry-point trace

Registered in research/14 Appendix B A2 (#552); implementation recorded 2026-10-20.
This is eval-only, with no verifier or production adoption. Both independent finders use
`codex/sol-6.1@medium`, identical inputs and the included implementer report. The main finder
uses production's standard prompt; the second searches universal clauses and unguarded paths.

`trace-experiment.json` pins the original 35 dev IDs and k=2. The dev split has since grown;
do not substitute all current dev cases. `trace-systems.json` defines E. Compare with stored
E1 standard-medium trials from `eval-mv7igcxy1tl7bg203warej`, never the adversarial baseline.
The registered estimate is about $14 plus trace input tokens, not a guaranteed cost. This
implementation reruns the main finder as part of E; it does not replay E1's main calls.

Later paid operation (not part of implementation verification), from the repository root:

```bash
ids=$(bun -e 'import r from "./evals/review/trace-experiment.json"; console.log(r.caseIds.join(","))')
limitless eval run review --systems evals/review/trace-systems.json --cases "$ids" --k 2 --max-usd 30 --no-cache --follow
```

The $30 ceiling is a stop limit, separate from the estimate. An incomplete run cannot pass.
Export reports to scratch, then compare offline without database access or model calls:

```bash
limitless eval report eval-mv7igcxy1tl7bg203warej --json > "$TMPDIR/e1.json"
limitless eval report <variant-e-run-id> --json > "$TMPDIR/e.json"
bun scripts/review-trace.ts "$TMPDIR/e1.json" "$TMPDIR/e.json"
```

Both arms are regraded against the current checked-in gold labels. The JSON report contains
existing measures (blocking recall, clean blocks, severity, under-rating, finding counts,
latency, prompt/output tokens and metered/API-equivalent costs), category recall and trace
attribution. Arms are ordered baseline, E. `pooled` counts defect-trials over k=2;
`repetitionUnion` counts distinct required defects caught in either repetition over defects.
Every rate includes its denominator; zero denominators yield null. At the registered labels,
these are 98 defect-trials, 8 clean trials, and 49 distinct required defects.

Trace `added` counts merged candidates raised by trace without a main report; `addedOnGold`
uses the existing one-claim/one-defect matcher against all gold defects, including optional ones.
A shared merged claim is not added. `cleanBlocked` counts clean trials where the independent
trace report blocks; `newlyBlocked` excludes trials already blocked by E's independent main
report. These are distinct from E's additional clean blocks relative to stored E1.

The decision requires at least an eight-percentage-point pooled blocking recall gain and at
most one additional clean blocked trial. Missing, failed, duplicate or unattributed matching
case/trial evidence prevents a passing decision; the report lists missing pairs. Union recall
is diagnostic and never used for this rule. Held-out runs occur once only if adopted and
only after #542's fresh clean set exists; no held-out execution is included here.

The source budget exceeds roughly 150 lines because paired, same-label offline reporting,
complete-evidence checks and persisted independent reports are required in addition to finder
execution. The existing merge, grader matching, accounting and summary measures are reused.
