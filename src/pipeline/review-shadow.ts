import type { ResolvedProfile, ReviewSystem } from "../core/types.ts";
import { type InvokeOutcome, invokeGuard, NoCapacityError, type RunContext } from "./context.ts";
import { type ReviewDeps, type ReviewInput, runReview } from "./review.ts";
import { configuredReviewSystem } from "./review-system.ts";
import { parseArtifact } from "./shadow-report.ts";

const SHADOW_MIN_HEADROOM = 0.1; // at or below it a subscription provider has no room for shadow work

/** The engine's review dependencies, with the finders of the given system. */
export type ShadowDeps = (system: ReviewSystem) => ReviewDeps<InvokeOutcome>;

/** Runs the profile's panel as a first review of what the single review saw; never affects the run. */
export async function shadowReview(
  ctx: RunContext,
  opts: { round: number; baseSha: string; reviewedSha: string; profile: ResolvedProfile; input: ReviewInput },
  deps: ShadowDeps,
): Promise<void> {
  const { round, baseSha, reviewedSha, profile, input } = opts;
  const range = `${baseSha}${ctx.state.flow === "verify-change" ? "..." : ".."}${reviewedSha}`;
  const name = `review-${round}.shadow.json`;
  const prior = parseArtifact(ctx.store.getArtifact(ctx.run.id, name));
  // The range names both reviewed revisions and the diff scope; a malformed record is replaced.
  if (prior?.status === "completed" && prior.range === range) return;
  const { tracker, store, cfg } = ctx.deps;
  // Checked before starting and by ctx.invoke for each attempt's target once its slot is held and
  // telemetry refreshed. Metered models never stand in for exhausted subscriptions.
  const stop = (id: string) =>
    tracker.def(id)?.billing === "metered"
      ? `${id} is metered`
      : tracker.def(id)?.billing === "subscription" && tracker.headroom(id) <= SHADOW_MIN_HEADROOM
        ? `${id} quota headroom is at or below ${SHADOW_MIN_HEADROOM}`
        : undefined;
  const guard = { stop, ids: [] as number[] };
  const system = configuredReviewSystem({ ...cfg, reviewMode: "panel" }, profile, ctx.state.reviewLenses);
  let record: Record<string, unknown>;
  try {
    if (system.mode !== "panel") throw new NoCapacityError("run prepared without base review lenses");
    const low = tracker.all().find((p) => p.enabled && p.billing === "subscription" && stop(p.id));
    if (low) throw new NoCapacityError(stop(low.id));
    const { previous: _previous, fixReview: _fix, ...prompt } = input.prompt;
    const request = { ...input, prompt, system, replayedFollowUps: undefined };
    const { output, decision, panel } = await invokeGuard.run(guard, () => runReview(deps(system), request));
    if (!decision) throw output.error;
    record = { status: "completed", ...decision, panel };
  } catch (error) {
    ctx.checkCancelled();
    const reason = String((error as Error | undefined)?.message).slice(0, 500);
    record = { status: error instanceof NoCapacityError ? "skipped" : "error", reason };
  }
  if (record.status !== "completed") ctx.log(`Shadow panel ${record.status}: ${record.reason}`, "warn");
  // Every attempt, failed or retried, from the persisted invocation rows that already count in run totals.
  const spent = guard.ids.flatMap((id) => store.getInvocation(id) ?? []);
  const cost = (key: "costUsd" | "costEquivUsd") => spent.reduce((total, i) => total + i[key], 0);
  const usage = { invocations: spent.length, costUsd: cost("costUsd"), costEquivUsd: cost("costEquivUsd") };
  const artifact = { round, system: system.name, baseSha, reviewedSha, range, ...record, usage };
  ctx.store.putArtifact(ctx.run.id, name, "review-shadow", JSON.stringify(artifact, null, 2));
}
