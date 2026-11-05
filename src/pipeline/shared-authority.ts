import type { Config } from "../config.ts";
import { type Run, TERMINAL_STATUSES } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { ClaimLostError, ClaimWaitError } from "../integrations/claim-errors.ts";
import { bindClaim, claimGuard, claimScope } from "../integrations/claim-guard.ts";
import type { ClaimTip } from "../integrations/claim-ref.ts";
import type { LeaseHandle } from "../integrations/leases.ts";
import { settleCheckpoint } from "./checkpoint-settlement.ts";
import { mapClaimInterruption } from "./claim-interruption.ts";
import { initialRunState, localCheckpointer, type RunState } from "./context.ts";
import { claimKey, claimRef } from "./portable.ts";
import { bindRunClaim, type RunClaim } from "./run-claim.ts";
import { admitRun, type SharedRuntime } from "./shared-admission.ts";

const bindings = new WeakMap<SharedRuntime, Map<string, RunClaim>>();
type Terminal = Pick<Run, "status" | "error" | "finishedAt">;
const intent = (store: Store, id: string): Terminal | null => {
  const json = store.checkpointRecord(id)?.terminal;
  return json ? JSON.parse(json) : null;
};
function handleFor(rt: SharedRuntime, store: Store, run: Run): LeaseHandle | undefined {
  const key = claimKey(run, store);
  if ("none" in key) throw new ClaimWaitError("unavailable");
  const ref = claimRef(key),
    row = store.leaseRow(run.repoSlug, ref);
  if (row?.runId !== run.id || row.confirmed?.state !== "held") return;
  return { repo: run.repoSlug, ref, run: run.id, member: rt.member, generation: row.confirmed.generation };
}
function finish(store: Store, run: Run, patch: Terminal): void {
  store.transaction(() => {
    const state = store.getRunState<RunState>(run.id) ?? initialRunState(run);
    state.githubWait = undefined;
    localCheckpointer(store).writeRun(run.id, { ...patch, stage: null }, state);
    store.clearTerminalIntent(run.id);
  });
}
function wait(rt: SharedRuntime, store: Store, run: Run, reason: "terminal" | "checkpoint"): "wait" {
  const state = store.getRunState<RunState>(run.id) ?? initialRunState(run),
    now = rt.clock.now();
  state.githubWait = { reason: `claim:${reason}`, since: state.githubWait?.since ?? now, nextAttemptAt: now };
  store.updateRun(run.id, { status: "queued", stage: null, finishedAt: null }, state);
  return "wait";
}

export async function publishTerminal(
  rt: SharedRuntime,
  store: Store,
  runId: string,
): Promise<"done" | "wait"> {
  const run = store.getRun(runId),
    patch = intent(store, runId);
  if (!run || !patch) return "done";
  const handle = handleFor(rt, store, run);
  if (!handle) return "wait";
  const signal = new AbortController().signal;
  const binding = bindClaim(rt.leases, handle, () => false);
  try {
    const { settlement, tip } = await settleCheckpoint({ ...rt, store }, handle, signal);
    if (settlement === "wait") return wait(rt, store, run, "terminal");
    if (settlement === "blocked") return wait(rt, store, run, "checkpoint");
    if (tip?.record === "malformed" || tip?.record.status !== patch.status)
      await rt.committer.commit(
        runId,
        {
          handle,
          guard: () => claimScope.run([binding], claimGuard),
          onLost: claimHooks(rt, store).onLost,
        },
        signal,
        { status: patch.status },
      );
  } catch (error) {
    if (error instanceof ClaimLostError) {
      mapClaimInterruption(store, runId, error, rt.clock.now());
      store.clearTerminalIntent(runId);
      return "done";
    }
    if (!(error instanceof ClaimWaitError)) throw error;
    return wait(rt, store, run, error.reason === "checkpoint" ? "checkpoint" : "terminal");
  }
  finish(store, run, patch);
  await rt.leases.release(handle, {});
  return "done";
}

export async function authorityFor(
  rt: SharedRuntime,
  store: Store,
  cfg: Config,
  run: Run,
  signal: AbortSignal,
): Promise<RunClaim | "finished"> {
  const key = claimKey(run, store);
  if ("none" in key) throw new ClaimWaitError("unavailable");
  const ref = claimRef(key),
    row = store.leaseRow(run.repoSlug, ref);
  if (row?.runId === run.id && row.confirmed?.state === "lost") throw new ClaimLostError();
  const read = await rt.claims.read(run.repoSlug, ref, signal);
  if (read.kind === "unconfirmed") throw new ClaimWaitError("unavailable");
  const remote = read.kind === "tip" ? read.tip.record : null;
  const finishRemote = (status: Run["status"]) => {
    let patch = intent(store, run.id);
    if (patch?.status !== status)
      patch = { status, error: "finished before restart", finishedAt: rt.clock.now() };
    finish(store, run, patch);
  };
  if (
    remote &&
    remote !== "malformed" &&
    remote.run === run.id &&
    TERMINAL_STATUSES.includes(remote.status)
  ) {
    finishRemote(remote.status);
    return "finished";
  }
  let handle = handleFor(rt, store, run);
  if (!handle || !store.checkpointRecord(run.id)?.indexed)
    handle = await admitRun(rt, store, cfg, run, signal);
  else {
    const { settlement, tip } = await settleCheckpoint({ ...rt, store }, handle, signal);
    if (settlement === "wait") throw new ClaimWaitError("lease");
    if (settlement === "blocked") throw new ClaimWaitError("checkpoint");
    if (intent(store, run.id)) {
      if ((await publishTerminal(rt, store, run.id)) === "done") return "finished";
      throw new ClaimWaitError("terminal");
    }
    if (tip?.record && tip.record !== "malformed" && TERMINAL_STATUSES.includes(tip.record.status)) {
      finishRemote(tip.record.status);
      await rt.leases.release(handle, {});
      return "finished";
    }
  }
  const authority = bindRunClaim(run, store, {
    binding: bindClaim(rt.leases, handle, () => false),
    leases: rt.leases,
  });
  const registered = bindings.get(rt) ?? new Map<string, RunClaim>();
  bindings.set(rt, registered);
  registered.set(run.id, authority);
  return authority;
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
      return run.status !== "queued" || (reason !== "claim:checkpoint" && reason !== "claim:policy");
    },
    onLost: (h, tip) => bindings.get(rt)?.get(h.run)?.binding.onLost(h, tip),
  };
}
