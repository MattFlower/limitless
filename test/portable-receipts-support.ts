import { createHash } from "node:crypto";
import type { OfflineTransferMaterial } from "../src/db/portable-receipts.ts";
import { formatManifest, type PortableManifest } from "../src/pipeline/portable.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import { portableProjectionFixture } from "./portable-projection-support.ts";

export function receiptFixture(payload = portableProjectionFixture()): OfflineTransferMaterial {
  payload.state.answers ??= [];
  const blobs = new Map<string, Uint8Array>();
  const ref = (key: string, bytes: Uint8Array) => {
    blobs.set(key, bytes);
    return { key, digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  };
  const manifest: PortableManifest = {
    schema: 2,
    runId: payload.run.id,
    key: payload.header.claim,
    generation: 1,
    sequence: 0,
    previous: null,
    baseSha: payload.run.baseSha,
    headSha: payload.run.headSha,
    phase: payload.state.phase,
    round: payload.state.round,
    createdBy: "offline-test",
    blobs: {
      state: ref("1".repeat(32), encodeTransferJson(payload)),
      artifacts: [ref("2".repeat(32), new TextEncoder().encode("original artifact\n"))],
      objects: [ref("3".repeat(32), new Uint8Array([0, 1, 254, 255]))],
    },
    effects: [],
  };
  return { manifest: formatManifest(manifest), payload, blobs };
}
