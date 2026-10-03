import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedProfile, ReviewSystem } from "../core/types.ts";
import { addDetachedWorktree } from "../git/repos.ts";
import { sh } from "../util/proc.ts";
import { type InvokeOutcome, NoCapacityError, type RunContext, type ShadowInvoke } from "./context.ts";
import { type ReviewDeps, type ReviewInput, runReview } from "./review.ts";
import { configuredReviewSystem } from "./review-system.ts";
import { parseArtifact } from "./shadow-report.ts";
import { createSnapshotParent } from "./snapshots.ts";

const SHADOW_MIN_HEADROOM = 0.1;
export type ShadowDeps = (system: ReviewSystem, shadow?: ShadowInvoke) => ReviewDeps<InvokeOutcome>;

/**
 * Starts the shadow panel beside the single review. Call the result once the single review settles:
 * it waits at most `graceMs` for the shadow, then aborts it and records a timeout with what finished.
 */
export function startShadow(
  ctx: RunContext,
  opts: { round: number; baseSha: string; reviewedSha: string; profile: ResolvedProfile; input: ReviewInput },
  deps: ShadowDeps,
): (graceMs: number) => Promise<void> {
  const { round, baseSha, reviewedSha, profile, input } = opts;
  const range = `${baseSha}${ctx.state.flow === "verify-change" ? "..." : ".."}${reviewedSha}`;
  const name = `review-${round}.shadow.json`;
  const prior = parseArtifact(ctx.store.getArtifact(ctx.run.id, name));
  if (prior?.status === "completed" && prior.range === range) return async () => {};
  const { tracker, router, store, cfg } = ctx.deps;
  // Checked before starting and after acquiring each provider slot.
  const stop = (id: string) =>
    tracker.def(id)?.billing === "metered"
      ? `${id} is metered`
      : tracker.def(id)?.billing === "subscription" && tracker.headroom(id) <= SHADOW_MIN_HEADROOM
        ? `${id} quota headroom is at or below ${SHADOW_MIN_HEADROOM}`
        : undefined;
  const unknown = (id: string) => !Object.keys(tracker.status(id)?.windows ?? {}).length;
  const abort = new AbortController();
  const shadow: ShadowInvoke = { signal: AbortSignal.any([ctx.signal, abort.signal]), stop, ids: [] };
  // Every finder and verifier call that completed, in order: what a timeout or error still records.
  const finished: Record<string, unknown>[] = [];
  let system: ReviewSystem | undefined;
  let written = false;
  const write = (record: Record<string, unknown>) => {
    // A cancelled run records nothing; a resume runs the shadow again.
    if (written || ctx.signal.aborted) return;
    written = true;
    if (record.status !== "completed") ctx.log(`Shadow panel ${record.status}: ${record.reason}`, "warn");
    const spent = shadow.ids.flatMap((id) => store.getInvocation(id) ?? []);
    const cost = (key: "costUsd" | "costEquivUsd") => spent.reduce((total, i) => total + i[key], 0);
    const usage = { invocations: spent.length, costUsd: cost("costUsd"), costEquivUsd: cost("costEquivUsd") };
    const artifact = { round, system: system?.name, baseSha, reviewedSha, range, ...record, usage };
    store.putArtifact(ctx.run.id, name, "review-shadow", JSON.stringify(artifact, null, 2));
  };
  let parent: string | undefined;
  const work = (async () => {
    try {
      const lenses = ctx.state.shadowLenses;
      if (!lenses) throw new NoCapacityError("run prepared without base review lenses");
      if ("error" in lenses) throw new NoCapacityError(lenses.error);
      const built = configuredReviewSystem({ ...cfg, reviewMode: "panel" }, profile, lenses);
      system = built;
      // Every quota-limited provider the roster, a fallback or the verifier could route to.
      const { finders, verifier } = built;
      const pinned = [...finders.map((f) => f.target), verifier?.target, ...(verifier?.targets ?? [])];
      const policy = router.policyTargets("review", profile === "deep" ? "large" : ctx.complexity);
      const providers = [...policy.map((t) => t.modelId), ...pinned.flatMap((t) => t ?? [])]
        .map((t) => router.resolve(t).model.provider)
        .filter((id) => tracker.def(id)?.billing === "subscription" && tracker.isEnabled(id));
      const low = providers.find((id) => unknown(id) || stop(id));
      if (low) throw new NoCapacityError(unknown(low) ? `${low} quota headroom is unknown` : stop(low));
      const worktree = ctx.state.worktreePath;
      if (!worktree) throw new NoCapacityError("run has no worktree");
      parent = createSnapshotParent();
      shadow.cwd = join(parent, "shadow");
      await addDetachedWorktree(worktree, reviewedSha, shadow.cwd, shadow.signal);
      const { previous: _previous, fixReview: _fix, ...prompt } = input.prompt;
      const request = { ...input, prompt, system: built, replayedFollowUps: undefined };
      const panelDeps = deps(built, shadow);
      const invoke: typeof panelDeps.invoke = async (req, finder) => {
        const invoked = await panelDeps.invoke(req, finder);
        finished.push({ finder, status: invoked.result.status, review: invoked.result.structured });
        return invoked;
      };
      const { verify: baseVerify } = panelDeps;
      const verify: typeof baseVerify =
        baseVerify &&
        (async (req, vendors, models, candidates) => {
          const invoked = await baseVerify(req, vendors, models, candidates);
          finished.push({
            verifier: candidates,
            status: invoked.result.status,
            result: invoked.result.structured,
          });
          return invoked;
        });
      const { output, decision, panel } = await runReview({ ...panelDeps, invoke, verify }, request);
      if (!decision) throw output.error;
      write({ status: "completed", ...decision, panel });
    } catch (error) {
      const reason = String((error as Error | undefined)?.message).slice(0, 500);
      // Nothing ran (no slot, quota or configuration): skipped.
      const skipped = error instanceof NoCapacityError || !shadow.ids.length;
      const status = abort.signal.aborted ? "timeout" : skipped ? "skipped" : "error";
      write({ status, reason, finished });
    } finally {
      // Only now, after its last call ends, possibly after the run moved on.
      if (parent) rmSync(parent, { recursive: true, force: true });
      const { worktreePath: cwd } = ctx.state;
      if (parent && cwd) await sh(["git", "worktree", "prune"], { cwd, allowFail: true });
    }
  })().catch(() => {}); // A failed artifact write must not fail the production review.
  const settle = async (ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
  };
  return async (graceMs) => {
    await settle(graceMs);
    if (written) return;
    abort.abort();
    // Calls still ending work in the shadow's own checkout, so the run need not wait for them.
    write({ status: "timeout", reason: `running ${graceMs / 1000}s after the single review`, finished });
  };
}
