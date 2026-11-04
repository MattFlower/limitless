import { createHash } from "node:crypto";
import { addAbortListener } from "node:events";
import type { Config } from "../config.ts";
import type { CreateRunRequest, Repo, Run } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { cacheGit } from "../git/command.ts";
import { cachePath, ensureCache } from "../git/repos.ts";
import { ClaimLostError, ClaimWaitError, rethrowClaimControl } from "../integrations/claim-errors.ts";
import { bindClaim, claimGuard, claimScope } from "../integrations/claim-guard.ts";
import type { ClaimClient } from "../integrations/claim-ref.ts";
import type { ControlNamer } from "../integrations/control-identity.ts";
import { canonicalJson } from "../integrations/control-json.ts";
import { type ControlValue, controlKey } from "../integrations/control-record.ts";
import type { ControlStore } from "../integrations/control-store.ts";
import type { LeaseHandle, LeaseManager } from "../integrations/leases.ts";
import type { CapabilityGate } from "../integrations/member-eligibility.ts";
import type { SharedStore } from "../integrations/shared-store.ts";
import { settleCheckpoint } from "./checkpoint-settlement.ts";
import { type Checkpointer, NeedsHumanError, type RunState } from "./context.ts";
import { claimKey, claimRef } from "./portable.ts";
import { sharedRepository } from "./run-claim.ts";
import { ensureAdmissionPin } from "./run-policy-pins.ts";
import type { createCheckpointCommitter } from "./shared-checkpointer.ts";

export type SharedRuntime = Readonly<{
  member: string;
  leases: LeaseManager;
  claims: Pick<ClaimClient, "read">;
  blobs: SharedStore;
  // The control store's actor callback must identify this member.
  control: Pick<ControlStore, "mutate">;
  namer: ControlNamer;
  committer: ReturnType<typeof createCheckpointCommitter>;
  checkpointer: Checkpointer;
  gate: CapabilityGate;
  clock: { now(): number; timer: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void } };
  refreshCache?(repo: Repo, signal: AbortSignal): Promise<void>;
  admissionDeadlineMs?: number;
}>;

export function refuseSharedRequest(store: Store, cfg: Config, repo: Repo, req: CreateRunRequest): void {
  if (!sharedRepository(cfg, repo, repo.slug)) return;
  const request = { ...req, source: req.source ?? "cli", sourceRef: req.sourceRef ?? null };
  const key = claimKey({ ...request, id: "unsaved", repoSlug: repo.slug }, store);
  if ("none" in key && key.none === "several-issues")
    throw new Error("Shared runs cannot close several issues");
  if (!("none" in key) && key.kind === "issue" && req.sourceRef?.kind !== "issue")
    throw new Error("Shared issue runs require an issue source reference");
  if (req.dependsOn?.length) throw new Error("Shared runs cannot have dependencies");
}

const admissions = new Map<string, Promise<LeaseHandle>>();

export async function admitRun(
  rt: SharedRuntime,
  store: Store,
  cfg: Config,
  run: Run,
  caller: AbortSignal,
): Promise<LeaseHandle> {
  const deadline = rt.clock.now() + (rt.admissionDeadlineMs ?? 600_000);
  const timeout = new AbortController();
  const signal = AbortSignal.any([caller, timeout.signal]);
  const expired = () => timeout.abort(new ClaimWaitError("unavailable"));
  const timer = rt.clock.timer.set(expired, Math.max(0, deadline - rt.clock.now()));
  const check = () => {
    if (rt.clock.now() >= deadline) expired();
    signal.throwIfAborted();
  };
  const step = async <T>(fn: () => Promise<T>): Promise<T> => {
    check();
    const result = await fn();
    check();
    return result;
  };
  const aborted = Promise.withResolvers<never>();
  const listener = addAbortListener(signal, () => aborted.reject(new ClaimWaitError("unavailable")));
  try {
    let work = admissions.get(run.id);
    if (!work) {
      work = Promise.resolve().then(async () => {
        check();
        const current = store.getRun(run.id),
          repo = store.getRepo(run.repoId);
        if (!current || !repo || !ensureAdmissionPin(store, cfg, current, repo))
          throw new ClaimWaitError("unavailable");
        const phase = store.getRunState<RunState>(run.id)?.phase ?? "prepare";
        const refused = await step(() =>
          rt.gate.admit({ runId: run.id, phase, models: current.models, repo }, signal),
        );
        if (refused.length) throw new ClaimWaitError("capability");
        if (current.sourceRef?.kind === "pull_request") {
          await step(() =>
            rt.refreshCache
              ? rt.refreshCache(repo, signal)
              : ensureCache(cfg.paths, repo, signal).then(() => {}),
          );
          const commits = new Set([
            current.baseSha,
            current.headSha,
            current.sourceRef.baseSha,
            current.sourceRef.headSha,
          ]);
          for (const sha of commits) {
            if (sha == null) continue;
            if (typeof sha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha))
              throw new ClaimWaitError("unavailable");
            const result = await step(() =>
              cacheGit(["git", "cat-file", "-t", sha], {
                cwd: cachePath(cfg.paths, repo),
                signal,
                timeoutMs: 60_000,
                env: { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_ALLOW_PROTOCOL: "" },
              }),
            );
            if (result.stdout.trim() !== "commit") throw new ClaimWaitError("unavailable");
          }
        }
        const key = claimKey(current, store);
        if ("none" in key) throw new ClaimWaitError("unavailable");
        const ref = claimRef(key),
          row = store.leaseRow(repo.slug, ref);
        let handle: LeaseHandle = {
          repo: repo.slug,
          ref,
          run: run.id,
          member: rt.member,
          generation: row?.confirmed?.generation ?? 0,
        };
        if (row?.runId !== run.id || row.confirmed?.state !== "held" || !rt.leases.windowOpen(handle)) {
          const acquired = await step(() =>
            rt.leases.acquire(
              repo.slug,
              ref,
              {
                kind: key.kind,
                ...("number" in key ? { number: key.number } : {}),
                run: run.id,
                status: current.status,
              },
              { takeover: false },
              signal,
            ),
          );
          if (acquired.kind === "superseded") throw new ClaimLostError();
          if (acquired.kind !== "held")
            throw new ClaimWaitError(
              acquired.kind === "refused" && acquired.reason === "terminal" ? "checkpoint" : "lease",
            );
          handle = acquired.handle;
        }
        const { settlement } = await step(() => settleCheckpoint({ ...rt, store }, handle));
        if (settlement === "wait") throw new ClaimWaitError("lease");
        if (settlement === "blocked") throw new ClaimWaitError("checkpoint");
        if (!store.checkpointRecord(run.id)?.committed) {
          const binding = bindClaim(rt.leases, handle, () => false);
          await step(() =>
            rt.committer.commit(
              run.id,
              {
                handle,
                onLost: binding.onLost,
                guard: () => {
                  check();
                  claimScope.run([binding], claimGuard);
                },
              },
              signal,
            ),
          );
        }
        if (!store.checkpointRecord(run.id)?.indexed) {
          const value: ControlValue = { kind: "run-index", runId: run.id, claim: key };
          const equal = (other: ControlValue | null) => canonicalJson(other) === canonicalJson(value);
          const id = createHash("sha256").update(`run-index${run.id}`).digest("hex").slice(0, 32);
          const result = await step(() =>
            rt.control.mutate(
              controlKey(rt.namer, value),
              { id, command: value },
              (old) => {
                if (old === null) return value;
                if (equal(old)) return undefined;
                throw new Error("Shared run index conflict");
              },
              signal,
            ),
          );
          if (
            result.kind !== "applied" &&
            !(
              result.kind === "unchanged" &&
              result.reason === "precondition" &&
              equal(result.tip?.manifest.value ?? null)
            )
          )
            throw new ClaimWaitError("unavailable");
          store.markRunIndexed(run.id);
        }
        return handle;
      });
      admissions.set(run.id, work);
      // Keep the lock until aborted IO drains, even if the deadline already returned to the picker.
      const clear = () => {
        if (admissions.get(run.id) === work) admissions.delete(run.id);
      };
      void work.then(clear, clear);
    }
    const result = await Promise.race([work, aborted.promise]);
    check();
    return result;
  } catch (error) {
    if (signal.aborted) throw new ClaimWaitError("unavailable");
    if (error instanceof NeedsHumanError) throw error;
    rethrowClaimControl(error);
    throw new ClaimWaitError("unavailable");
  } finally {
    listener[Symbol.dispose]();
    rt.clock.timer.clear(timer);
  }
}
