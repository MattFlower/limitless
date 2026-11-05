import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Paths } from "../config.ts";
import type { Run } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { cachePath } from "../git/repos.ts";
import { ClaimWaitError, rethrowClaimControl } from "../integrations/claim-errors.ts";
import type { LeaseHandle } from "../integrations/leases.ts";
import type { SharedStore } from "../integrations/shared-store.ts";
import { formatPointer, parsePointer } from "./checkpoint-settlement.ts";
import type { RunState } from "./context.ts";
import { type BlobRef, claimKey, formatManifest, type PortableManifest, parseManifest } from "./portable.ts";
import type { createRunTransfer } from "./run-transfer.ts";
import { decodeRunArtifacts } from "./run-transfer-artifacts.ts";
import { RunTransferError, type RunTransferErrorCode } from "./run-transfer-errors.ts";
import { transferHash, verifyReceiptPayload } from "./run-transfer-integrity.ts";
import { decodeRunPayload } from "./run-transfer-schema.ts";

export type Candidate = { pointer: string; manifest: string; sequence: number; commits: string[] };
export class CandidateRefused extends Error {
  constructor(readonly code: Exclude<RunTransferErrorCode, "unavailable" | "aborted">) {
    super(code);
    this.name = "CandidateRefused";
  }
}
export type CandidateDeps = {
  store: Store;
  paths: Paths;
  member: string;
  transfer: Pick<ReturnType<typeof createRunTransfer>, "exportRun">;
  blobs: Pick<SharedStore, "newKey" | "put" | "get">;
};
const readManifest = (text: string) => {
  const m = parseManifest(text);
  if (m === "malformed") throw new CandidateRefused("corrupt");
  if ("unsupported" in m) throw new CandidateRefused("unsupported");
  return m;
};
const artifacts = (m: PortableManifest) =>
  m.blobs.artifacts.map((ref) => ({ ref, role: "role" in ref ? ref.role : "artifact" }));

/** Inert local export: publication and ledger changes belong to the caller. */
export async function buildCandidate(
  deps: CandidateDeps,
  run: Run,
  handle: LeaseHandle,
  guard: () => void,
  signal: AbortSignal,
): Promise<Candidate> {
  const { store, blobs } = deps;
  const check = () => {
    guard();
    if (signal.aborted) throw new RunTransferError("aborted");
  };
  const unavailable = (error: unknown): never => {
    rethrowClaimControl(error);
    throw new ClaimWaitError("unavailable");
  };
  const storage = async <T>(action: () => Promise<T>): Promise<T> => {
    let result: T;
    try {
      result = await action();
    } catch (error) {
      rethrowClaimControl(error);
      check();
      return unavailable(error);
    }
    check();
    return result;
  };
  const put = async (role: string, key: string, bytes: Uint8Array) => {
    check();
    const result = await storage(() => blobs.put(run.id, role, key, bytes, signal));
    if (result.kind !== "applied") throw new ClaimWaitError("unavailable");
  };
  try {
    check();
    const ledger = store.checkpointRecord(run.id);
    if (ledger?.pending) throw new CandidateRefused("conflict");
    const committed = ledger?.committed;
    const prior = committed ? readManifest(committed.manifest) : null;
    const previous = committed ? parsePointer(committed.pointer) : null;
    if (committed && !previous) throw new CandidateRefused("corrupt");
    const current = store.getRun(run.id),
      state = store.getRunState<RunState>(run.id);
    if (!current) throw new CandidateRefused("missing");
    if (!state) throw new CandidateRefused("incomplete");
    const key = claimKey(current, store),
      repo = store.getRepo(current.repoId);
    if ("none" in key) throw new CandidateRefused("invalid");
    if (!repo) throw new CandidateRefused("missing");
    const lockPath = cachePath(deps.paths, repo);
    const worktree = state.worktreePath && existsSync(state.worktreePath) ? state.worktreePath : undefined;
    const repository = {
      path: worktree ?? lockPath,
      lockPath,
      trust: worktree ? ("agent-controlled" as const) : ("factory-owned" as const),
    };
    const objects = prior?.blobs.objects[0];
    const reuse =
      objects && committed
        ? {
            commits: committed.commits,
            objects,
            bytes: await storage(() => blobs.get(run.id, "objects", objects, signal)),
          }
        : undefined;
    const exported = await deps.transfer.exportRun(run.id, repository, signal, reuse);
    check();
    const m = readManifest(exported.manifest);
    if (m.schema !== 3) throw new CandidateRefused("unsupported");
    const selected: { ref: BlobRef; role: string; bytes: Uint8Array; reused: boolean }[] = [];
    const select = <T extends BlobRef>(ref: T, role: string, old?: { ref: BlobRef; role: string }): T => {
      const bytes = exported.blobs.get(ref.key);
      if (!bytes) throw new CandidateRefused("incomplete");
      const reused = !!old && old.role === role && old.ref.digest === ref.digest && old.ref.size === ref.size;
      const chosen = reused ? { ...ref, key: old.ref.key } : ref;
      selected.push({ ref: chosen, role, bytes, reused });
      return chosen;
    };
    const oldArtifacts = prior ? artifacts(prior) : [];
    const manifest = formatManifest({
      ...m,
      schema: 3,
      runId: run.id,
      key,
      generation: handle.generation,
      sequence: (committed?.sequence ?? 0) + 1,
      previous: previous?.digest ?? null,
      // Snapshot-dependent fields come from export, which may capture after the reuse read.
      createdBy: deps.member,
      effects: [],
      blobs: {
        state: select(m.blobs.state, "state", prior ? { ref: prior.blobs.state, role: "state" } : undefined),
        objects: m.blobs.objects.map((ref, i) =>
          select(
            ref,
            "objects",
            prior?.blobs.objects[i] ? { ref: prior.blobs.objects[i], role: "objects" } : undefined,
          ),
        ),
        artifacts: m.blobs.artifacts.map((ref, i) => select(ref, ref.role, oldArtifacts[i])),
      },
    });
    for (const s of selected) if (!s.reused) await put(s.role, s.ref.key, s.bytes);
    const readBack = new Map<string, Uint8Array>();
    for (const s of selected) {
      const bytes =
        reuse &&
        s.role === "objects" &&
        s.ref.key === reuse.objects.key &&
        s.ref.digest === reuse.objects.digest &&
        s.ref.size === reuse.objects.size
          ? reuse.bytes
          : await storage(() => blobs.get(run.id, s.role, s.ref, signal));
      readBack.set(s.ref.key, bytes);
    }
    const final = readManifest(manifest);
    try {
      const payload = verifyReceiptPayload(final, readBack);
      decodeRunPayload(payload, repo, final);
      decodeRunArtifacts(final, readBack, payload);
    } catch (error) {
      unavailable(error);
    }
    const bytes = new TextEncoder().encode(manifest),
      manifestKey = blobs.newKey();
    const digest = transferHash(bytes);
    await put("manifest", manifestKey, bytes);
    const retained = await storage(() =>
      blobs.get(run.id, "manifest", { key: manifestKey, digest, size: bytes.length }, signal),
    );
    if (!Buffer.from(retained).equals(bytes)) throw new ClaimWaitError("unavailable");
    check();
    if (!isDeepStrictEqual(ledger, store.checkpointRecord(run.id))) throw new ClaimWaitError("unavailable");
    return {
      pointer: formatPointer(manifestKey, digest),
      manifest,
      sequence: final.sequence,
      commits: [...exported.payload.commits],
    };
  } catch (error) {
    rethrowClaimControl(error);
    if (error instanceof CandidateRefused) throw error;
    if (error instanceof RunTransferError) {
      if (error.code === "aborted") throw error;
      if (error.code !== "unavailable") throw new CandidateRefused(error.code);
    }
    throw new ClaimWaitError("unavailable");
  }
}
