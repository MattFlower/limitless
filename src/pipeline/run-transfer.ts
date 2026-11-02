import {
  commitOfflineTransfer,
  type OfflineTransferMaterial,
  retainedOfflineExport,
} from "../db/portable-receipts.ts";
import type { Store } from "../db/store.ts";
import { registeredCredentials } from "../util/proc.ts";
import { type BlobRef, formatManifest, type PortableManifest, parseManifest } from "./portable.ts";
import type { RunObjectExportInput, RunObjectIO } from "./run-object-contract.ts";
import { inspectRunObjectCredentials } from "./run-object-privacy.ts";
import { decodeRunArtifacts, encodeRunArtifacts } from "./run-transfer-artifacts.ts";
import { RunTransferError, rethrowRunTransfer } from "./run-transfer-errors.ts";
import {
  receiptDescriptors,
  receiptManifest,
  transferHash,
  verifyReceiptPayload,
} from "./run-transfer-integrity.ts";
import { encodeTransferJson } from "./run-transfer-json.ts";
import { serializeTransfer, transferDatabaseIdentity } from "./run-transfer-queue.ts";
import { decodeRunPayload, type RunPayloadV1 } from "./run-transfer-schema.ts";
import { captureRunTransferSnapshot } from "./run-transfer-snapshot.ts";

export interface RunTransferInput {
  manifest: string;
  blobs: ReadonlyMap<string, Uint8Array>;
}
export interface RunTransferCandidate extends OfflineTransferMaterial {
  digest: string;
}
export interface RunTransferDependencies {
  source: Store;
  offline: { store: Store; ownership: "exclusive-offline" };
  manifestContext: Parameters<typeof captureRunTransferSnapshot>[2];
  key: () => string;
  objects: RunObjectIO;
}

/** Dormant transfer only: the caller exclusively owns the disconnected projection database. */
export function createRunTransfer(deps: RunTransferDependencies) {
  const guarded = async <T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> => {
    try {
      signal.throwIfAborted();
      return await action();
    } catch (error) {
      rethrowRunTransfer(
        error,
        signal.aborted ? "aborted" : error instanceof RunTransferError ? error.code : "invalid",
      );
    }
  };
  const manifest = (text: string): PortableManifest => {
    const m = parseManifest(text);
    if (m === "malformed") throw new RunTransferError("invalid");
    if ("unsupported" in m) throw new RunTransferError("unsupported");
    if (m.schema !== 3 && m.blobs.artifacts.length) throw new RunTransferError("unsupported");
    if (m.blobs.objects.length > 1) throw new RunTransferError("invalid");
    return m;
  };
  const payload = (m: PortableManifest, blobs: ReadonlyMap<string, Uint8Array>) => {
    const p = verifyReceiptPayload(m, blobs);
    decodeRunPayload(p, { id: "offline", kind: "github", slug: m.key.repo }, m);
    // Validate semantics without replacing the representation retained in the state blob.
    return p;
  };
  const objectInput = (p: RunPayloadV1, m: PortableManifest, bytes: Uint8Array) => {
    const objectFormat = p.commits[0]?.length === 64 ? ("sha256" as const) : ("sha1" as const);
    if (p.commits.some((oid) => oid.length !== (objectFormat === "sha1" ? 40 : 64)))
      throw new RunTransferError("unsupported");
    return {
      bytes,
      objectFormat,
      requiredCommits: [...p.commits],
      refs: p.commits.map((oid) => ({ name: `refs/limitless-run-objects/${m.runId}/${oid}`, oid })),
    };
  };
  const validateObjects = async (
    p: RunPayloadV1,
    m: PortableManifest,
    blobs: ReadonlyMap<string, Uint8Array>,
    signal: AbortSignal,
  ) => {
    const ref = m.blobs.objects[0];
    if (!!p.commits.length !== !!ref) throw new RunTransferError("incomplete");
    if (!ref) return;
    const bytes = blobs.get(ref.key);
    if (!bytes) throw new RunTransferError("incomplete");
    let inspection: Promise<void> | undefined;
    try {
      await deps.objects.validate(
        objectInput(p, m, bytes),
        (reader) => {
          inspection = inspectRunObjectCredentials(reader, registeredCredentials(), signal);
          return inspection;
        },
        signal,
      );
    } finally {
      await inspection;
    }
    signal.throwIfAborted();
    if (!inspection) throw new RunTransferError("incomplete");
  };
  const candidate = (material: OfflineTransferMaterial): RunTransferCandidate => ({
    ...material,
    digest: transferHash(new TextEncoder().encode(material.manifest)),
  });
  return {
    exportRun(runId: string, repository: RunObjectExportInput["repository"], signal: AbortSignal) {
      return guarded(signal, () =>
        serializeTransfer(transferDatabaseIdentity(deps.source.db), runId, signal, async () => {
          if (deps.source.db.query("SELECT run_id FROM run_projections WHERE run_id = ?").get(runId)) {
            const saved = retainedOfflineExport(deps.source.db, runId),
              m = manifest(saved.manifest);
            const p = payload(m, saved.blobs);
            await validateObjects(p, m, saved.blobs, signal);
            signal.throwIfAborted();
            retainedOfflineExport(deps.source.db, runId);
            return candidate(saved);
          }
          const captured = captureRunTransferSnapshot(deps.source, runId, (source) => {
            const context = deps.manifestContext(source);
            return {
              ...context,
              manifest: {
                ...context.manifest,
                schema: 3,
                blobs: { ...context.manifest.blobs, artifacts: [] },
              },
            };
          });
          const p = captured.payload,
            m = captured.context.manifest;
          const blobs = new Map<string, Uint8Array>();
          const blob = (bytes: Uint8Array): BlobRef => {
            const key = deps.key();
            if (!/^[a-f0-9]{32}$/i.test(key) || blobs.has(key)) throw new RunTransferError("invalid");
            blobs.set(key, new Uint8Array(bytes));
            return { key, digest: transferHash(bytes), size: bytes.byteLength };
          };
          const state = blob(encodeTransferJson(p));
          const artifacts = encodeRunArtifacts(captured.artifacts, runId, captured.ordinals.invocations).map(
            ({ role, bytes }) => ({ ...blob(bytes), role }),
          );
          const expected = objectInput(p, m, new Uint8Array());
          const bundle = await deps.objects.export(
            {
              repository: { ...repository },
              runScope: m.runId,
              commits: expected.requiredCommits,
              objectFormat: expected.objectFormat,
            },
            signal,
          );
          if (!!bundle !== !!p.commits.length) throw new RunTransferError("incomplete");
          const objects = bundle ? [blob(bundle.bytes)] : [];
          const final = { ...m, schema: 3 as const, blobs: { state, objects, artifacts } };
          const text = formatManifest(final);
          const validated = payload(final, blobs);
          await validateObjects(validated, final, blobs, signal);
          signal.throwIfAborted();
          return candidate({ manifest: text, payload: validated, blobs });
        }),
      );
    },
    importRun(input: RunTransferInput, signal: AbortSignal) {
      return guarded(signal, async () => {
        const text = input.manifest;
        const blobs = new Map(
          [...input.blobs].map(([key, bytes]) => {
            if (!(bytes instanceof Uint8Array)) throw new RunTransferError("invalid");
            return [key, new Uint8Array(bytes)] as const;
          }),
        );
        const m = manifest(text);
        const refs = receiptDescriptors(m);
        if (new Set(refs.map((r) => r.key)).size !== refs.length) throw new RunTransferError("invalid");
        const p = payload(m, blobs);
        decodeRunArtifacts(m, blobs, p);
        receiptManifest(text, transferHash(new TextEncoder().encode(text)), p.run.id);
        const source = transferDatabaseIdentity(deps.source.db),
          target = transferDatabaseIdentity(deps.offline.store.db);
        if (deps.offline.ownership !== "exclusive-offline" || source === target)
          throw new RunTransferError("conflict");
        return serializeTransfer(target, m.runId, signal, async () => {
          await validateObjects(p, m, blobs, signal);
          signal.throwIfAborted();
          return commitOfflineTransfer(deps.offline.store.db, { manifest: text, payload: p, blobs });
        });
      });
    },
  };
}
