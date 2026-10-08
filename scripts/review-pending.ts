import { loadRoleCases, ReviewCaseFileSchema } from "../src/evals/cases.ts";

export const REVIEW_SPLIT_SEED = 427202610;

/** Sorted PRs, xorshift32 Fisher–Yates shuffle; the first round(n/3) are held out. */
export function assignReviewSplits(prs: readonly number[], seed = REVIEW_SPLIT_SEED) {
  const shuffled = [...new Set(prs)].sort((a, b) => a - b);
  let state = seed >>> 0;
  for (let i = shuffled.length - 1; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = Math.floor(((state >>> 0) / 4294967296) * (i + 1));
    const left = shuffled[i];
    const right = shuffled[j];
    if (left === undefined || right === undefined) throw new Error("Invalid shuffle index");
    shuffled[i] = right;
    shuffled[j] = left;
  }
  const heldout = new Set(shuffled.slice(0, Math.round(shuffled.length / 3)));
  return new Map(
    [...shuffled].sort((a, b) => a - b).map((pr) => [pr, heldout.has(pr) ? "heldout" : "dev"] as const),
  );
}

export function pendingReviewText(caseIds: readonly string[] = [], casePath?: string): string {
  const file = ReviewCaseFileSchema.parse(loadRoleCases("review", casePath));
  for (const id of caseIds)
    if (!file.cases.some((item) => item.id === id)) throw new Error(`Unknown case ID: ${id}`);
  const records = file.cases.flatMap((item) =>
    caseIds.length > 0 && !caseIds.includes(item.id)
      ? []
      : item.defects
          .filter((defect) => defect.adjudication === "pending")
          .map((defect) =>
            JSON.stringify(
              {
                caseId: item.id,
                split: item.split,
                source: item.source,
                base: item.base,
                head: item.head,
                file: defect.file,
                lines: defect.lines,
                severity: defect.severity,
                category: defect.category,
                summary: defect.summary,
              },
              null,
              2,
            ),
          ),
  );
  return records.length > 0 ? records.join("\n\n") : "No pending defects.";
}

if (import.meta.main) {
  try {
    console.log(pendingReviewText(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
