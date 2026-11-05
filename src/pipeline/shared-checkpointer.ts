import { isDeepStrictEqual } from "node:util";
import type { RunStatus } from "../core/types.ts";
import { ClaimLostError, ClaimWaitError } from "../integrations/claim-errors.ts";
import type { ScopedClaim } from "../integrations/claim-guard.ts";
import type { ClaimClient } from "../integrations/claim-ref.ts";
import type { LeaseManager } from "../integrations/leases.ts";
import {
  buildCandidate,
  type Candidate,
  type CandidateDeps,
  CandidateRefused,
} from "./checkpoint-candidate.ts";
import { settleCheckpoint } from "./checkpoint-settlement.ts";
import { type Checkpointer, NeedsHumanError } from "./context.ts";

type CommitClaim = Pick<ScopedClaim, "handle" | "onLost"> & { guard(): void };
type Patch = { status: RunStatus };
type Result = "committed" | "unchanged";
// Execution supplies a guard bound to its claim scope; checkpointing never creates authority.
export type ClaimContext = { binding: CommitClaim; signal: AbortSignal };
const blocked = () =>
  Object.assign(new ClaimWaitError("checkpoint"), {
    cause: new Error("Shared checkpoint does not match the local ledger"),
  });

export function createCheckpointCommitter(
  deps: CandidateDeps & {
    leases: Pick<LeaseManager, "update" | "settle">;
    claims: Pick<ClaimClient, "read">;
  },
) {
  const { store, leases } = deps;
  type Queued = { claim: CommitClaim; signal: AbortSignal; status?: RunStatus; work: Promise<Result> };
  const tails = new Map<string, Promise<Result>>(),
    queued = new Map<string, Queued>();
  async function publish(
    runId: string,
    claim: CommitClaim,
    signal: AbortSignal,
    patch?: Patch,
  ): Promise<Result> {
    const { handle, guard, onLost } = claim;
    if (handle.run !== runId) throw new ClaimWaitError("unavailable");
    for (;;) {
      signal.throwIfAborted();
      // Settlement takes the same non-reentrant lock as publication.
      const { settlement } = await settleCheckpoint(deps, handle, signal);
      if (settlement === "wait") throw new ClaimWaitError("lease");
      if (settlement === "blocked") throw blocked();
      const base = store.checkpointRecord(runId);
      // Another publication journaled after settlement released the lock: settle it first.
      if (base?.pending) continue;
      let candidate: Candidate | undefined;
      try {
        const run = store.getRun(runId);
        if (!run) throw new CandidateRefused("missing");
        candidate = await buildCandidate(deps, run, handle, guard, signal);
      } catch (error) {
        const raced =
          error instanceof CandidateRefused ||
          (error instanceof ClaimWaitError && error.reason === "unavailable");
        if (raced && !isDeepStrictEqual(base, store.checkpointRecord(runId))) continue;
        if (!(error instanceof CandidateRefused)) throw error;
        if (!patch) throw new NeedsHumanError(`Shared checkpoint refused: ${error.code}`);
      }
      const result = await store.coordinateCheckpoint(runId, async () => {
        const row = store.checkpointRecord(runId);
        if (row?.pending || !isDeepStrictEqual(row?.committed ?? null, base?.committed ?? null)) return;
        const pointer = base?.committed?.pointer ?? null;
        if (candidate) store.journalCheckpoint(runId, { ...candidate, generation: handle.generation });
        const expected = store.checkpointRecord(runId);
        const status = patch?.status ?? store.getRun(runId)?.status;
        if (!status) throw new CandidateRefused("missing");
        signal.throwIfAborted();
        guard();
        const outcome = await leases.update(
          handle,
          { ...(candidate ? { checkpoint: candidate.pointer } : {}), status },
          { expect: { checkpoint: pointer } },
        );
        if (outcome === "wait") throw new ClaimWaitError("lease");
        if (outcome === "mismatch") throw blocked();
        if (outcome === "lost" || outcome === "obsolete") {
          onLost(handle, null);
          throw new ClaimLostError();
        }
        if (!candidate) return "unchanged" as const;
        if (store.confirmCheckpoint(runId, candidate.pointer, expected)) return "committed" as const;
      });
      if (result) return result;
    }
  }
  return {
    commit(runId: string, claim: CommitClaim, signal: AbortSignal, patch?: Patch): Promise<Result> {
      const status = patch?.status;
      const waiting = queued.get(runId);
      if (
        waiting?.claim.handle === claim.handle &&
        waiting.claim.guard === claim.guard &&
        waiting.claim.onLost === claim.onLost &&
        waiting.signal === signal &&
        waiting.status === status
      )
        return waiting.work;
      const work = (tails.get(runId) ?? Promise.resolve())
        .catch(() => {})
        .then(() => {
          if (queued.get(runId)?.work === work) queued.delete(runId);
          return publish(runId, claim, signal, status === undefined ? undefined : { status });
        })
        .finally(() => {
          if (tails.get(runId) === work) tails.delete(runId);
        });
      tails.set(runId, work);
      queued.set(runId, { claim, signal, status, work });
      return work;
    },
  };
}

export function sharedCheckpointer(
  local: Checkpointer,
  committer: Pick<ReturnType<typeof createCheckpointCommitter>, "commit">,
  claims: (runId: string) => ClaimContext | undefined,
): Checkpointer {
  return {
    writeState: (...args) => local.writeState(...args),
    writeRun: (...args) => local.writeRun(...args),
    checkpoint(runId, label) {
      if (label === undefined) return;
      const claim = claims(runId);
      if (!claim) return;
      return committer.commit(runId, claim.binding, claim.signal).then(() => {});
    },
  };
}
