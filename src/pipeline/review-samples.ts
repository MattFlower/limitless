import { z } from "zod";
import { extractJson } from "../harness/types.ts";
import type { InvokeOutcome, RunContext } from "./context.ts";
import type { ReviewRequest } from "./review.ts";
import { parseArtifact } from "./shadow-report.ts";

/**
 * A finished sample of a two-sample review is kept as an artifact, keyed by its exact prompt, so a
 * restart reruns only the unfinished sample: a completed sample's findings are never re-rolled away.
 */
const name = (round: number, sample: number) => `review-${round}.sample-${sample}.json`;
const promptKey = (request: ReviewRequest) =>
  new Bun.CryptoHasher("sha256").update(request.prompt).digest("hex");
const usable = (request: ReviewRequest, result: InvokeOutcome["result"]) =>
  result.status === "ok" &&
  request.schema.safeParse(result.structured ?? extractJson(result.finalText)).success;

const SavedSchema = z.object({
  prompt: z.string(),
  targetId: z.string(),
  invocationId: z.number().int(),
  result: z.custom<InvokeOutcome["result"]>(
    (v) => z.looseObject({ status: z.string(), finalText: z.string() }).safeParse(v).success,
  ),
});

export function saveReviewSample(
  ctx: RunContext,
  round: number,
  sample: number,
  request: ReviewRequest,
  invoked: InvokeOutcome,
): void {
  if (!usable(request, invoked.result)) return;
  ctx.artifact(
    name(round, sample),
    "review-sample",
    JSON.stringify({
      prompt: promptKey(request),
      targetId: invoked.target.targetId ?? invoked.target.modelId,
      invocationId: invoked.invocation.id,
      result: invoked.result,
    }),
  );
}

/** The sample saved for this exact request, or undefined when it must run (again). */
export function savedReviewSample(
  ctx: RunContext,
  round: number,
  sample: number,
  request: ReviewRequest,
): InvokeOutcome | undefined {
  const saved = SavedSchema.safeParse(parseArtifact(ctx.store.getArtifact(ctx.run.id, name(round, sample))));
  if (!saved.success || saved.data.prompt !== promptKey(request) || !usable(request, saved.data.result))
    return undefined;
  const invocation = ctx.store.getInvocation(saved.data.invocationId);
  if (invocation?.runId !== ctx.run.id || invocation.status !== "ok") return undefined;
  try {
    const { router } = ctx.deps;
    const { model, effort } = router.resolve(saved.data.targetId);
    return { result: saved.data.result, target: router.toTarget(model, effort), invocation };
  } catch {
    // The model left the catalog or this release refuses it: review that sample again.
    return undefined;
  }
}
