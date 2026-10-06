import { z } from "zod";

export const statusDetailSchema = z.object({
  run: z.object({
    id: z.string(),
    status: z.string(),
    prUrl: z.string().nullable(),
    resolution: z.object({ kind: z.string() }).nullable().optional(),
  }),
  questions: z.array(z.object({ answer: z.string().nullable() })),
  prSnapshot: z
    .object({
      state: z.string().optional(),
      headRefOid: z.string().optional(),
      isDraft: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  review: z
    .object({
      approval: z.object({ sha: z.string(), stale: z.boolean() }).nullable(),
      rounds: z.array(z.object({ runId: z.string(), status: z.string() })),
    })
    .optional(),
});
export const statusLandsSchema = z.array(
  z.object({
    id: z.number(),
    runId: z.string(),
    prUrl: z.string(),
    state: z.enum(["queued", "checking", "waiting_ci", "merging", "landed", "blocked", "cancelled"]),
    reason: z.string().nullable(),
  }),
);

export function explainStatus(
  detail: z.output<typeof statusDetailSchema>,
  lands: z.output<typeof statusLandsSchema>,
) {
  const { run, prSnapshot: pr, review, questions } = detail;
  const land = lands
    .filter((entry) => entry.runId === run.id || (run.prUrl && entry.prUrl === run.prUrl))
    .sort((a, b) => b.id - a.id)[0];
  const result = (state: string, nextAction: string) => ({
    run: run.id,
    state,
    nextAction,
    land: land ?? null,
  });
  if (pr?.state === "MERGED" || run.resolution?.kind === "merged" || land?.state === "landed")
    return result("Landed", "No action needed; the PR has merged.");
  if (land?.state === "blocked")
    return result(
      "Landing blocked",
      "Inspect the land reason, resolve the blocker, then request limitless_land again.",
    );
  if (land && ["queued", "checking", "waiting_ci", "merging"].includes(land.state))
    return result(
      `Landing in progress (${land.state})`,
      "Wait for the land queue; check limitless_status for progress.",
    );
  if (run.status === "cancelled")
    return result("Cancelled", "No further work will run; submit a new run if still needed.");
  if (run.status === "failed")
    return result(
      "Failed",
      "Inspect limitless_get_run for the error; resolve the run or submit a corrected task.",
    );
  if (run.status === "resolved")
    return result("Resolved", "No action needed; the run was dealt with outside the factory.");
  if (questions.some((q) => q.answer === null) || run.status === "waiting_input")
    return result(
      "Input needed",
      "Read the open questions with limitless_get_run, then use limitless_answer_question.",
    );
  if (run.status === "needs_human")
    return result(
      "Input needed",
      "Inspect limitless_get_run and address the stopping error or resolve the run.",
    );
  const round = review?.rounds.at(-1);
  if (round && ["waiting_input", "needs_human"].includes(round.status))
    return result(
      "Input needed",
      `Inspect review round ${round.runId} with limitless_status and address its input or error.`,
    );
  if (round && ["failed", "cancelled"].includes(round.status))
    return result(
      `Review changes ${round.status}`,
      `Inspect review round ${round.runId} with limitless_get_run before submitting another verdict.`,
    );
  if (round && ["queued", "waiting", "running"].includes(round.status))
    return result("Review changes in progress", `Inspect review round ${round.runId} with limitless_status.`);
  if (["queued", "waiting", "running"].includes(run.status))
    return result("Work pending", "Wait for the factory; check limitless_status or the inbox for updates.");
  if (!run.prUrl)
    return result("Completed", "No PR recorded; inspect limitless_get_run for delivery results.");
  if (pr?.state === "CLOSED")
    return result("PR closed", "Inspect the closed PR and resolve the run if appropriate.");
  if (pr?.state !== "OPEN")
    return result(
      "PR state unknown",
      "Inspect the PR and await a saved observation before reviewing or landing.",
    );
  if (pr.isDraft)
    return result(
      "Draft PR needs attention",
      "Inspect the draft and its delivery evidence before reviewing.",
    );
  const approval = review?.approval;
  if (approval && !approval.stale && !pr.headRefOid)
    return result("PR head unknown", "Inspect the current PR head before requesting limitless_land.");
  if (!approval || approval.stale || (pr.headRefOid && pr.headRefOid !== approval.sha))
    return result(
      "Review needed",
      "Review the current PR head; submit limitless_review with its full SHA and findings.",
    );
  return result(
    "Approved; landing not queued",
    "Use limitless_land when authorized; the queue will validate the approved head and checks.",
  );
}
