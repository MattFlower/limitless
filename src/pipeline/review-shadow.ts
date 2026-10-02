import type { ResolvedProfile, ReviewSystem } from "../core/types.ts";
import type { AgentResult } from "../harness/types.ts";
import { CancelledError, type InvokeOutcome, NoCapacityError, type RunContext } from "./context.ts";
import { type ReviewDeps, type ReviewInput, runReview } from "./review.ts";
import { configuredReviewSystem } from "./review-system.ts";
import { parseArtifact } from "./shadow-report.ts";

/** At or below this headroom a subscription provider has no room for shadow work. */
export const SHADOW_MIN_HEADROOM = 0.1;
class ShadowStopped extends Error {}
/** Checked before every shadow member call; `spent` collects what the calls cost. */
export type ShadowGuard = { check: () => void; spent: AgentResult[] };

/**
 * Runs the profile's panel on exactly what the round's single review saw, as a first review of the
 * complete diff, and records it in `review-N.shadow.json`. Nothing reads it back: only cancellation escapes.
 */
export async function shadowReview(
  ctx: RunContext,
  opts: { round: number; baseSha: string; reviewedSha: string; profile: ResolvedProfile; input: ReviewInput },
  deps: (system: ReviewSystem, guard: ShadowGuard) => ReviewDeps<InvokeOutcome>,
): Promise<void> {
  const { round, baseSha, reviewedSha } = opts;
  const range = `${baseSha}${ctx.state.flow === "verify-change" ? "..." : ".."}${reviewedSha}`;
  const name = `review-${round}.shadow.json`;
  const prior = parseArtifact(ctx.store.getArtifact(ctx.run.id, name));
  // The range names both reviewed revisions and the diff scope; a malformed record is replaced.
  if (prior?.status === "completed" && prior.range === range) return;
  const { tracker } = ctx.deps;
  const guard: ShadowGuard = {
    spent: [],
    check: () => {
      for (const p of tracker.all())
        if (p.enabled && p.billing === "subscription" && tracker.headroom(p.id) <= SHADOW_MIN_HEADROOM)
          throw new ShadowStopped(`${p.id} quota headroom is at or below ${SHADOW_MIN_HEADROOM}`);
    },
  };
  const system = configuredReviewSystem(
    { ...ctx.deps.cfg, reviewMode: "panel" },
    opts.profile,
    ctx.state.reviewLenses,
  );
  let record: Record<string, unknown>;
  try {
    if (system.mode !== "panel") throw new ShadowStopped("run prepared without base review lenses");
    guard.check();
    const { previous: _previous, fixReview: _fix, ...prompt } = opts.input.prompt;
    const input = { ...opts.input, prompt, system, replayedFollowUps: undefined };
    const { output, decision, panel } = await runReview(deps(system, guard), input);
    record = decision
      ? { status: "completed", ...decision, panel }
      : { status: "error", reason: output.error?.message.slice(0, 500) };
  } catch (error) {
    if (ctx.signal.aborted || error instanceof CancelledError) throw error;
    const skipped = error instanceof ShadowStopped || error instanceof NoCapacityError;
    const reason = String((error as Error).message).slice(0, 500);
    record = { status: skipped ? "skipped" : "error", reason };
  }
  if (record.status !== "completed") ctx.log(`Shadow panel ${record.status}: ${record.reason}`, "warn");
  const cost = (key: "costUsd" | "costEquivUsd") => guard.spent.reduce((total, r) => total + r[key], 0);
  const usage = {
    invocations: guard.spent.length,
    costUsd: cost("costUsd"),
    costEquivUsd: cost("costEquivUsd"),
  };
  const artifact = { round, system: system.name, baseSha, reviewedSha, range, ...record, usage };
  ctx.store.putArtifact(ctx.run.id, name, "review-shadow", JSON.stringify(artifact, null, 2));
}
