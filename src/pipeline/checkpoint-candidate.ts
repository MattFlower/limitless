import { existsSync } from "node:fs";
import type { Paths } from "../config.ts";
import type { Run } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { cachePath } from "../git/repos.ts";
import { ClaimWaitError, rethrowClaimControl } from "../integrations/claim-errors.ts";
import type { LeaseHandle } from "../integrations/leases.ts";
import { type SharedStore, SharedStoreError } from "../integrations/shared-store.ts";
import { formatPointer, parsePointer } from "./checkpoint-settlement.ts";
import type { RunState } from "./context.ts";
import { type BlobRef, claimKey, formatManifest, type ManifestV3, parseManifest } from "./portable.ts";
import type { createRunTransfer } from "./run-transfer.ts";
import { decodeRunArtifacts } from "./run-transfer-artifacts.ts";
import { RunTransferError, type RunTransferErrorCode } from "./run-transfer-errors.ts";
import { transferHash, verifyReceiptPayload } from "./run-transfer-integrity.ts";

export type Candidate = { pointer: string; manifest: string; sequence: number; commits: string[] };
export class CandidateRefused extends Error {
  constructor(readonly code: RunTransferErrorCode) {
    super(code);
    this.name = "CandidateRefused";
  }
}
type Dependencies = {
  store: Store;
  paths: Paths;
  member: string;
  transfer: Pick<ReturnType<typeof createRunTransfer>, "exportRun">;
  blobs: Pick<SharedStore, "newKey" | "put" | "get">;
};
function manifest3(text: string): ManifestV3 {
  const m = parseManifest(text);
  if (m === "malformed") throw new RunTransferError("invalid");
  if ("unsupported" in m || m.schema !== 3) throw new RunTransferError("unsupported");
  return m;
}
function slots(m: ManifestV3): { ref: BlobRef; role: string }[] {
  return [
    { ref: m.blobs.state, role: "state" },
    ...m.blobs.objects.map((ref) => ({ ref, role: "objects" })),
    ...m.blobs.artifacts.map((ref) => ({ ref, role: ref.role })),
  ];
}

/** Builds verified material only; the caller owns ledger settlement and claim publication. */
export async function buildCandidate(
  deps: Dependencies,
  run: Run,
  handle: LeaseHandle,
  guard: () => void,
  signal: AbortSignal,
): Promise<Candidate> {
  const { store, paths, member, transfer, blobs } = deps;
  const check = () => {
    guard();
    if (signal.aborted) throw new RunTransferError("aborted");
  };
  const awaited = async <T>(work: () => Promise<T>): Promise<T> => {
    let result: T;
    try {
      result = await work();
    } finally {
      guard();
    }
    check();
    return result;
  };
  try {
    check();
    const ledger = store.checkpointRecord(run.id);
    if (ledger?.pending) throw new RunTransferError("conflict");
    const committed = ledger?.committed,
      prior = committed ? manifest3(committed.manifest) : null,
      pointer = committed ? parsePointer(committed.pointer) : null;
    if (committed && !pointer) throw new RunTransferError("invalid");
    const key = claimKey(run, store);
    if ("none" in key) throw new RunTransferError("invalid");
    const state = store.getRunState<RunState>(run.id),
      repo = store.getRepo(run.repoId);
    if (!state || !repo) throw new RunTransferError("incomplete");
    const lockPath = cachePath(paths, repo),
      worktree = state.worktreePath && existsSync(state.worktreePath);
    const read = (role: string, ref: BlobRef) => awaited(() => blobs.get(run.id, role, ref, signal));
    const objects = prior?.blobs.objects[0];
    const reuse =
      objects && committed
        ? { commits: committed.commits, objects, bytes: await read("objects", objects) }
        : undefined;
    const exported = await awaited(() =>
      transfer.exportRun(
        run.id,
        {
          path: worktree && state.worktreePath ? state.worktreePath : lockPath,
          lockPath,
          trust: worktree ? "agent-controlled" : "factory-owned",
        },
        signal,
        reuse,
      ),
    );
    const m = manifest3(exported.manifest);
    const retained = new Set<string>();
    const dedupe = <T extends BlobRef>(ref: T, old: T | undefined): T => {
      if (!old || ref.digest !== old.digest || ref.size !== old.size) return ref;
      retained.add(old.key);
      return { ...ref, key: old.key };
    };
    m.blobs = {
      state: dedupe(m.blobs.state, prior?.blobs.state),
      objects: m.blobs.objects.map((r, i) => dedupe(r, prior?.blobs.objects[i])),
      artifacts: m.blobs.artifacts.map((r, i) => {
        const old = prior?.blobs.artifacts[i];
        return dedupe(r, old?.role === r.role ? old : undefined);
      }),
    };
    Object.assign(m, {
      schema: 3,
      runId: run.id,
      key,
      generation: handle.generation,
      sequence: (committed?.sequence ?? 0) + 1,
      previous: pointer?.digest ?? null,
      baseSha: run.baseSha,
      headSha: run.headSha,
      phase: state.phase,
      round: state.round,
      createdBy: member,
      effects: [],
    });
    const manifest = formatManifest(m);
    const put = async (role: string, key: string, bytes: Uint8Array) => {
      check();
      const result = await awaited(() => blobs.put(run.id, role, key, bytes, signal));
      if (result.kind !== "applied") throw new ClaimWaitError("unavailable");
    };
    const payloads = new Map<string, Uint8Array>();
    for (const { role, ref } of slots(m)) {
      if (!retained.has(ref.key)) {
        const bytes = exported.blobs.get(ref.key);
        if (!bytes) throw new RunTransferError("incomplete");
        await put(role, ref.key, bytes);
      }
      payloads.set(ref.key, reuse?.objects.key === ref.key ? reuse.bytes : await read(role, ref));
    }
    try {
      decodeRunArtifacts(m, payloads, verifyReceiptPayload(m, payloads));
    } catch (error) {
      rethrowClaimControl(error);
      throw new ClaimWaitError("unavailable");
    }
    const bytes = new TextEncoder().encode(manifest),
      digest = transferHash(bytes),
      manifestKey = blobs.newKey();
    await put("manifest", manifestKey, bytes);
    const back = await read("manifest", { key: manifestKey, digest, size: bytes.length });
    if (!Buffer.from(bytes).equals(back)) throw new ClaimWaitError("unavailable");
    check();
    return {
      pointer: formatPointer(manifestKey, digest),
      manifest,
      sequence: m.sequence,
      commits: [...exported.payload.commits],
    };
  } catch (error) {
    rethrowClaimControl(error);
    if (error instanceof RunTransferError) {
      if (error.code === "aborted") throw error;
      if (error.code !== "unavailable") throw new CandidateRefused(error.code);
    } else if (!(error instanceof SharedStoreError)) {
      throw new CandidateRefused("invalid");
    }
    throw new ClaimWaitError("unavailable");
  }
}
