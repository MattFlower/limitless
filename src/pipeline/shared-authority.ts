import type { Config } from "../config.ts";
import { type Run, TERMINAL_STATUSES } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { githubWait } from "../git/github-wait.ts";
import { ClaimLostError, ClaimWaitError } from "../integrations/claim-errors.ts";
import { bindClaim, claimGuard, claimScope, type ScopedClaim } from "../integrations/claim-guard.ts";
import type { ClaimTip } from "../integrations/claim-ref.ts";
import type { LeaseHandle } from "../integrations/leases.ts";
import { settleCheckpoint } from "./checkpoint-settlement.ts";
import { mapClaimInterruption } from "./claim-interruption.ts";
import { initialRunState, localCheckpointer, type RunState } from "./context.ts";
import { claimKey, claimRef } from "./portable.ts";
import { bindRunClaim, type RunClaim } from "./run-claim.ts";
import { admitRun, type SharedRuntime } from "./shared-admission.ts";

// Loss routes to the execution binding (keyed by run id) and to an in-flight publication binding.
const routes = new WeakMap<SharedRuntime, Map<string, ScopedClaim>>();
const tails = new WeakMap<SharedRuntime, Map<string, Promise<unknown>>>();
const of = <V>(m: WeakMap<SharedRuntime, Map<string, V>>, rt: SharedRuntime) =>
  m.get(rt) ?? (m.set(rt, new Map()).get(rt) as Map<string, V>);
type Terminal = Pick<Run, "status" | "error" | "finishedAt">;
function lease(rt: SharedRuntime, store: Store, run: Run) {
  const key = claimKey(run, store);
  if ("none" in key) throw new ClaimWaitError("unavailable");
  const ref = claimRef(key),
    row = store.leaseRow(run.repoSlug, ref),
    mine = row?.runId === run.id ? row.confirmed : null;
  const handle: LeaseHandle | undefined =
    mine?.state === "held"
      ? { repo: run.repoSlug, ref, run: run.id, member: rt.member, generation: mine.generation }
      : undefined;
  return { ref, handle, lost: mine?.state === "lost" };
}
const remoteTerminal = (run: Run, tip: ClaimTip | null | undefined) => {
  const r = tip?.record;
  return r && r !== "malformed" && r.run === run.id && TERMINAL_STATUSES.includes(r.status) ? r.status : null;
};
// Finish only while the published intent is current, or (from the tip) while the run is not yet terminal.
function finish(store: Store, runId: string, patch: Terminal, published?: string): boolean {
  return store.transaction(() => {
    const run = store.getRun(runId),
      json = store.checkpointRecord(runId)?.terminal;
    if (!run || (published === undefined ? TERMINAL_STATUSES.includes(run.status) : json !== published))
      return false;
    const state = store.getRunState<RunState>(runId) ?? initialRunState(run);
    state.githubWait = undefined;
    localCheckpointer(store).writeRun(runId, { ...patch, stage: null }, state);
    store.clearTerminalIntent(runId);
    return true;
  });
}
function wait(rt: SharedRuntime, store: Store, runId: string, reason: string): "done" | "wait" {
  return store.transaction(() => {
    const run = store.getRun(runId);
    if (!run || TERMINAL_STATUSES.includes(run.status) || !store.checkpointRecord(runId)?.terminal)
      return "done";
    const state = store.getRunState<RunState>(runId) ?? initialRunState(run),
      now = rt.clock.now(),
      since = state.githubWait?.since ?? now;
    // A failed publication attempt retries after the wait interval, never in a tight loop.
    state.githubWait = { reason: `claim:${reason}`, since, nextAttemptAt: now + githubWait.intervalMs };
    store.updateRun(runId, { status: "queued", stage: null, finishedAt: null }, state);
    return "wait";
  });
}
function lose(rt: SharedRuntime, store: Store, runId: string): "done" {
  store.transaction(() => {
    mapClaimInterruption(store, runId, new ClaimLostError(), rt.clock.now());
    store.clearTerminalIntent(runId);
  });
  return "done";
}

async function publish(rt: SharedRuntime, store: Store, runId: string): Promise<"done" | "wait"> {
  const signal = new AbortController().signal,
    routed = of(routes, rt);
  for (;;) {
    const run = store.getRun(runId),
      json = store.checkpointRecord(runId)?.terminal;
    if (!run || !json) return "done";
    const patch: Terminal = JSON.parse(json),
      { handle, lost } = lease(rt, store, run);
    if (lost) return lose(rt, store, runId);
    if (!handle) return wait(rt, store, runId, "terminal");
    const binding = bindClaim(rt.leases, handle, () => false);
    routed.set(`terminal:${runId}`, binding);
    try {
      const { settlement, tip } = await settleCheckpoint({ ...rt, store }, handle, signal);
      if (settlement === "wait" || settlement === "blocked")
        throw new ClaimWaitError(settlement === "wait" ? "lease" : "checkpoint");
      if (remoteTerminal(run, tip) !== patch.status) {
        const guard = () => claimScope.run([binding], claimGuard);
        await rt.committer.commit(runId, { handle, guard, onLost: claimHooks(rt, store).onLost }, signal, {
          status: patch.status,
        });
      }
    } catch (error) {
      if (error instanceof ClaimLostError || binding.lost || lease(rt, store, run).lost)
        return lose(rt, store, runId);
      if (!(error instanceof ClaimWaitError)) throw error;
      return wait(rt, store, runId, error.reason === "checkpoint" ? "checkpoint" : "terminal");
    } finally {
      if (routed.get(`terminal:${runId}`) === binding) routed.delete(`terminal:${runId}`);
    }
    // A terminal decision replaced during publication is published next, as a successor status.
    if (!finish(store, runId, patch, json)) continue;
    await rt.leases.release(handle, {});
    return "done";
  }
}

// Terminal publication and authority's terminal completion run one at a time per run.
function serial<T>(rt: SharedRuntime, runId: string, fn: () => Promise<T>): Promise<T> {
  const queue = of(tails, rt);
  const work: Promise<T> = (queue.get(runId) ?? Promise.resolve())
    .catch(() => {})
    .then(fn)
    .finally(() => queue.get(runId) === work && queue.delete(runId));
  queue.set(runId, work);
  return work;
}

/** Publish a deferred terminal status on the claim, then finish locally and release. */
export function publishTerminal(rt: SharedRuntime, store: Store, runId: string): Promise<"done" | "wait"> {
  return serial(rt, runId, () => publish(rt, store, runId));
}

export async function authorityFor(
  rt: SharedRuntime,
  store: Store,
  cfg: Config,
  run: Run,
  signal: AbortSignal,
): Promise<RunClaim | "finished"> {
  const { ref, handle: held, lost } = lease(rt, store, run);
  if (lost) throw new ClaimLostError();
  // D2/D8: serialize behind publication, then finish from a terminal tip without reacquiring.
  const finishRemote = (tip: () => Promise<ClaimTip | null>) =>
    serial(rt, run.id, async () => {
      const status = remoteTerminal(run, await tip()),
        json = store.checkpointRecord(run.id)?.terminal;
      let patch: Terminal | null = json ? JSON.parse(json) : null;
      if (!status) return null;
      if (patch?.status !== status)
        patch = { status, error: "finished before restart", finishedAt: rt.clock.now() };
      const { handle } = lease(rt, store, run);
      if (finish(store, run.id, patch) && handle) await rt.leases.release(handle, {});
      return "finished" as const;
    });
  const read = async () => {
    const r = await rt.claims.read(run.repoSlug, ref, signal);
    if (r.kind === "unconfirmed") throw new ClaimWaitError("unavailable");
    return r.kind === "tip" ? r.tip : null;
  };
  if (await finishRemote(read)) return "finished";
  let handle = held;
  const checkpoint = store.checkpointRecord(run.id);
  if (!handle || (!checkpoint?.indexed && !checkpoint?.terminal))
    handle = await admitRun(rt, store, cfg, run, signal);
  else {
    const { settlement } = await settleCheckpoint({ ...rt, store }, handle, signal);
    if (settlement === "wait") throw new ClaimWaitError("lease");
    if (settlement === "blocked") throw new ClaimWaitError("checkpoint");
    if (await finishRemote(read)) return "finished";
  }
  // A deferred terminal decision is published before any execution authority is granted.
  if (store.checkpointRecord(run.id)?.terminal) {
    if ((await publishTerminal(rt, store, run.id)) === "done") return "finished";
    throw new ClaimWaitError("terminal");
  }
  const binding = bindClaim(rt.leases, handle, () => false);
  of(routes, rt).set(run.id, binding);
  return bindRunClaim(run, store, { binding, leases: rt.leases });
}

export function claimHooks(
  rt: SharedRuntime,
  store: Store,
): { active(h: LeaseHandle): boolean; onLost(h: LeaseHandle, tip: ClaimTip | null): void } {
  return {
    active(h) {
      const run = store.getRun(h.run);
      if (!run || TERMINAL_STATUSES.includes(run.status)) return false;
      const reason = store.getRunState<RunState>(h.run)?.githubWait?.reason;
      return reason !== "claim:checkpoint" && reason !== "claim:policy";
    },
    onLost(h, tip) {
      for (const id of [h.run, `terminal:${h.run}`]) routes.get(rt)?.get(id)?.onLost(h, tip);
    },
  };
}
