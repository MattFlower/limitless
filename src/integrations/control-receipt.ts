import { claimRef, type ManifestV1, manifestDigest, parseManifest } from "../pipeline/portable.ts";
import { rethrowClaimControl } from "./claim-errors.ts";
import { claimGuard } from "./claim-guard.ts";
import { type ClaimClient, type ClaimRecord, formatRecord, parseRecord } from "./claim-ref.ts";
import { snapshotJson } from "./control-json.ts";
import { type InputReceipt, validateControlValue } from "./control-record.ts";
import { type SharedStore, SharedStoreError, type SharedStoreErrorCode } from "./shared-store.ts";

function fail(code: SharedStoreErrorCode): never {
  throw new SharedStoreError(code);
}

/**
 * Returns evidence, never execution permission. Before effects, consumers must establish a
 * captured live binding matching the canonical repository, ref, run and selection generation,
 * then freshly revalidate selection and guard immediately before dispatch. This helper checks
 * only existing ambient scopes; it neither establishes nor verifies that consumer binding.
 * Claim and control refs are not transactional: selection may change after validation, and an
 * old receipt may remain historical evidence without granting cached permission.
 */
export function createReceiptCheckpoint(deps: { blobs: SharedStore; claims: ClaimClient }) {
  return async (receipt: InputReceipt, signal?: AbortSignal): Promise<ManifestV1 | null> => {
    const snapshot = validateControlValue(receipt);
    if (snapshot.kind !== "receipt") fail("invalid");
    if (snapshot.state !== "committed") return null;
    const [, key = "", digest = ""] = snapshot.checkpoint.split(":");
    const ref = claimRef(snapshot.claim);
    try {
      if (signal?.aborted) fail("aborted");
      const bytes = await deps.blobs.get(snapshot.runId, "manifest", { key, digest }, signal);
      if (signal?.aborted) fail("aborted");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch (error) {
        rethrowClaimControl(error);
        if (error instanceof SharedStoreError) throw error;
        return fail("corrupt");
      }
      const manifest = parseManifest(text);
      if (manifest === "malformed") fail("corrupt");
      if ("unsupported" in manifest || manifest.schema !== 1) fail("unsupported");
      if (manifestDigest(manifest) !== digest) fail("corrupt");
      const claim = snapshot.claim;
      const origin = manifest.key;
      if (
        manifest.runId !== snapshot.runId ||
        origin.repo.toLowerCase() !== claim.repo ||
        origin.kind !== claim.kind ||
        (origin.kind === "run"
          ? claim.kind !== "run" || origin.runId !== claim.runId
          : claim.kind === "run" || origin.number !== claim.number) ||
        manifest.generation > snapshot.generation
      )
        return null;
      const selection = await deps.claims.read(snapshot.repo, ref, signal);
      if (signal?.aborted) fail("aborted");
      if (selection.kind === "unconfirmed") fail("unavailable");
      if (selection.kind === "absent" || selection.tip.record === "malformed") return null;
      let record: ClaimRecord | "malformed";
      try {
        // Reuse the wire validator, including its ref/identity check, for runtime client values.
        record = parseRecord(
          formatRecord(snapshotJson(selection.tip.record) as typeof selection.tip.record),
          ref,
        );
      } catch (error) {
        rethrowClaimControl(error);
        if (error instanceof SharedStoreError) throw error;
        return null;
      }
      if (
        record === "malformed" ||
        record.run !== snapshot.runId ||
        record.generation !== snapshot.generation ||
        record.checkpoint !== snapshot.checkpoint
      )
        return null;
      claimGuard();
      return manifest;
    } catch (error) {
      rethrowClaimControl(error);
      if (error instanceof SharedStoreError) throw error;
      return fail(signal?.aborted ? "aborted" : "unavailable");
    }
  };
}
