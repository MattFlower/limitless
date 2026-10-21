import { loadRoleCases, ReviewCaseFileSchema } from "../src/evals/cases.ts";
import type { EvalReport } from "../src/evals/stats.ts";
import { traceExperimentReport } from "../src/evals/trace.ts";

// Offline exports only: no daemon/database access or model calls.
const [baselinePath, variantPath] = process.argv.slice(2);
if (!baselinePath || !variantPath)
  throw new Error("usage: bun scripts/review-trace.ts <E1-report.json> <E-report.json>");
const baseline: EvalReport = await Bun.file(baselinePath).json();
const variant: EvalReport = await Bun.file(variantPath).json();
const cases = ReviewCaseFileSchema.parse(loadRoleCases("review")).cases;
console.log(JSON.stringify(traceExperimentReport(baseline, variant, cases), null, 2));
