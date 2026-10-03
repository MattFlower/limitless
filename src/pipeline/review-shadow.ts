import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedProfile, ReviewSystem } from "../core/types.ts";
import { addDetachedWorktree } from "../git/repos.ts";
import { sh } from "../util/proc.ts";
import { type InvokeOutcome, invokeGuard, NoCapacityError, type RunContext } from "./context.ts";
import { type ReviewDeps, type ReviewInput, runReview } from "./review.ts";
import { configuredReviewSystem } from "./review-system.ts";
import { parseArtifact } from "./shadow-report.ts";
import { createSnapshotParent } from "./snapshots.ts";

const SHADOW_MIN_HEADROOM = 0.1;
/** How long aborted calls get to record their spend before the artifact is written without it. */
const SETTLE_MS = 5_000;
export type ShadowDeps = (system: ReviewSystem) => ReviewDeps<InvokeOutcome>;

export async function shadowReview(
  ctx: RunContext,
  opts: { round: number; baseSha: string; reviewedSha: string; profile: ResolvedProfile; input: ReviewInput },
  deps: ShadowDeps,
  production: Promise<unknown>,
): Promise<void> {
  const { round, baseSha, reviewedSha, profile, input } = opts;
  const range = `${baseSha}${ctx.state.flow === "verify-change" ? "..." : ".."}${reviewedSha}`;
  const name = `review-${round}.shadow.json`;
  const prior = parseArtifact(ctx.store.getArtifact(ctx.run.id, name));
  if (prior?.status === "completed" && prior.range === range) return;
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
  const guard = { signal: AbortSignal.any([ctx.signal, abort.signal]), stop, ids: [] as number[], cwd: "" };
  const finished: Record<string, unknown>[] = [];
  let system: ReviewSystem | undefined;
  let parent: string | undefined;
  const work = invokeGuard
    .run(guard, async () => {
      try {
        const lenses = ctx.state.shadowLenses;
        if (!lenses) throw new NoCapacityError("run prepared without base review lenses");
        if ("error" in lenses) throw new NoCapacityError(lenses.error);
        system = configuredReviewSystem({ ...cfg, reviewMode: "panel" }, profile, lenses);
        // Every quota-limited provider the roster, a fallback or the verifier could route to.
        const { finders, verifier } = system;
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
        guard.cwd = join(parent, "shadow");
        await addDetachedWorktree(worktree, reviewedSha, guard.cwd, guard.signal);
        const { previous: _previous, fixReview: _fix, ...prompt } = input.prompt;
        const request = { ...input, prompt, system, replayedFollowUps: undefined };
        const { output, decision, panel } = await runReview({ ...deps(system), finished }, request);
        if (!decision) throw output.error;
        return { status: "completed", ...decision, panel, finished };
      } catch (error) {
        const reason = String((error as Error | undefined)?.message).slice(0, 500);
        const skipped = error instanceof NoCapacityError || !guard.ids.length;
        return { status: skipped ? "skipped" : "error", reason, finished };
      } finally {
        // Only now, after its last call ends, possibly after the run moved on.
        if (parent) rmSync(parent, { recursive: true, force: true });
        const { worktreePath: cwd } = ctx.state;
        if (parent && cwd) await sh(["git", "worktree", "prune"], { cwd, allowFail: true });
      }
    })
    .catch((error) => ({ status: "error", reason: String(error), finished }));
  // The deadline starts at production completion; only this caller writes the final artifact.
  const grace = await production.then(
    () => cfg.reviewShadowGraceSeconds * 1000,
    () => 0,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Record<string, unknown>>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({ status: "timeout", reason: `running ${grace / 1000}s after the single review`, finished }),
      grace,
    );
  });
  const record = await Promise.race([work, timeout]);
  clearTimeout(timer);
  abort.abort();
  if (ctx.signal.aborted) return;
  await Promise.race([work, new Promise((resolve) => setTimeout(resolve, SETTLE_MS).unref())]);
  if (record.status !== "completed") ctx.log(`Shadow panel ${record.status}: ${record.reason}`, "warn");
  const spent = guard.ids.flatMap((id) => store.getInvocation(id) ?? []);
  const cost = (key: "costUsd" | "costEquivUsd") => spent.reduce((total, i) => total + i[key], 0);
  const usage = { invocations: spent.length, costUsd: cost("costUsd"), costEquivUsd: cost("costEquivUsd") };
  // A call still running past the settle wait may yet add spend the artifact never sees.
  if (spent.some((i) => i.status === "running")) Object.assign(usage, { partial: true });
  const artifact = { round, system: system?.name, baseSha, reviewedSha, range, ...record, usage };
  ctx.store.putArtifact(ctx.run.id, name, "review-shadow", JSON.stringify(artifact, null, 2));
}
