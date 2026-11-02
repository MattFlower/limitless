import type { Database } from "bun:sqlite";
import {
  payloadFingerprint,
  receiptDescriptors,
  receiptManifest,
  transferConflict,
  transferHash,
  verifyProjectionIntegrity,
  verifyReceiptPayload,
} from "../pipeline/run-transfer-integrity.ts";
import { policyCanonical } from "../pipeline/run-transfer-policy-schema.ts";
import type { RunPayloadV1 } from "../pipeline/run-transfer-schema.ts";
import { readProjectionIds, writeOfflineProjection } from "./portable-projection.ts";

export interface OfflineTransferMaterial {
  manifest: string;
  payload: RunPayloadV1;
  blobs: ReadonlyMap<string, Uint8Array>;
}
type Receipt = { manifest: string; digest: string; fingerprint: string };
type BlobRow = { slot: number; blob_key: string; digest: string; size: number; plaintext: Uint8Array };
// Persistence only: neither these receipts nor the caller's material establish bundle validation
// or authority. These primitives require exclusive ownership of an offline database.
function retained(db: Database, runId: string): OfflineTransferMaterial {
  try {
    const receipt = db
      .query<Receipt, [string]>(
        "SELECT manifest, digest, fingerprint FROM run_transfer_receipts WHERE run_id = ?",
      )
      .get(runId);
    if (!receipt) return transferConflict();
    const m = receiptManifest(receipt.manifest, receipt.digest, runId);
    const refs = receiptDescriptors(m);
    const rows = db
      .query<BlobRow, [string]>(
        "SELECT slot, blob_key, digest, size, plaintext FROM run_transfer_blobs WHERE run_id = ? ORDER BY slot",
      )
      .all(runId);
    if (rows.length !== refs.length) return transferConflict();
    const blobs = new Map<string, Uint8Array>();
    for (const [i, row] of rows.entries()) {
      const ref = refs[i];
      if (
        !ref ||
        row.slot !== i ||
        row.blob_key !== ref.key ||
        row.digest !== ref.digest ||
        row.size !== ref.size
      )
        return transferConflict();
      const previous = blobs.get(row.blob_key);
      if (previous && !Buffer.from(previous).equals(row.plaintext)) return transferConflict();
      blobs.set(row.blob_key, row.plaintext);
    }
    const payload = verifyReceiptPayload(m, blobs);
    if (payload.run.id !== runId || payloadFingerprint(payload) !== receipt.fingerprint)
      return transferConflict();
    verifyProjectionIntegrity(db, payload);
    return { manifest: receipt.manifest, payload, blobs };
  } catch {
    return transferConflict();
  }
}
export function retainedOfflineExport(db: Database, runId: string): OfflineTransferMaterial {
  return db.transaction(() => retained(db, runId))();
}
export function verifyOfflineReceipt(db: Database, runId: string): void {
  retainedOfflineExport(db, runId);
}
export function commitOfflineTransfer(db: Database, input: OfflineTransferMaterial) {
  if (db.inTransaction) throw new Error("Offline receipt commit requires its own transaction");
  return db
    .transaction(() => {
      const id = input.payload.run.id;
      const digest = transferHash(new TextEncoder().encode(input.manifest));
      const m = receiptManifest(input.manifest, digest, id);
      if (policyCanonical(verifyReceiptPayload(m, input.blobs)) !== policyCanonical(input.payload))
        return transferConflict();
      if (
        db.query("SELECT id FROM runs WHERE id = ?").get(id) ||
        db.query("SELECT run_id FROM run_transfer_receipts WHERE run_id = ?").get(id)
      ) {
        const saved = retained(db, id);
        if (saved.manifest !== input.manifest) return transferConflict();
        return readProjectionIds(db, id);
      }
      const ids = writeOfflineProjection(db, input.payload);
      db.query(
        "INSERT INTO run_transfer_receipts (run_id, manifest, digest, fingerprint) VALUES (?, ?, ?, ?)",
      ).run(id, input.manifest, digest, payloadFingerprint(input.payload));
      const insert = db.query(
        "INSERT INTO run_transfer_blobs (run_id, slot, blob_key, digest, size, plaintext) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const [i, ref] of receiptDescriptors(m).entries()) {
        const bytes = input.blobs.get(ref.key);
        if (!bytes) return transferConflict();
        insert.run(id, i, ref.key, ref.digest, ref.size, bytes);
      }
      retained(db, id);
      return ids;
    })
    .immediate();
}
