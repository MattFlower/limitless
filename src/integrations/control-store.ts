import { addAbortListener } from "node:events";
import type { ManifestV1 } from "../pipeline/portable.ts";
import type { ClaimClient } from "./claim-ref.ts";
import type { ControlNamer } from "./control-identity.ts";
import { canonicalJson, commandDigest, type JsonValue, snapshotJson } from "./control-json.ts";
import { createReceiptCheckpoint } from "./control-receipt.ts";
import {
  type ControlActor,
  type ControlTip,
  type ControlValue,
  checkedControlInput,
  controlActorSchema,
  controlKey,
  controlKeySchema,
  controlMutationIdSchema,
  decodeControlManifest,
  encodeControlManifest,
  type InputReceipt,
  validateControlReplacement,
} from "./control-record.ts";
import type { ControlKey, ControlRefClient, ControlRefTip } from "./control-ref.ts";
import { type SharedStore, SharedStoreError } from "./shared-store.ts";

export type ControlMutationResult =
  | { kind: "applied"; tip: ControlTip; replayed: boolean }
  | { kind: "unchanged"; tip: ControlTip | null; reason: "precondition" | "send" }
  | { kind: "moved"; tip: ControlTip }
  | { kind: "unconfirmed" };
/**
 * Mutation success acknowledges durable history, never execution permission. Consumers must
 * still satisfy C03f's captured binding and fresh selection/guard revalidation before effects.
 */
export interface ControlStore {
  read(key: ControlKey, signal?: AbortSignal): Promise<ControlTip | null>;
  mutate(
    key: ControlKey,
    mutation: { id: string; command: JsonValue },
    reduce: (current: ControlValue | null) => ControlValue | undefined,
    signal?: AbortSignal,
  ): Promise<ControlMutationResult>;
  receiptCheckpoint(receipt: InputReceipt, signal?: AbortSignal): Promise<ManifestV1 | null>;
}

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new SharedStoreError("aborted");
}
function freeze(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createControlStore(deps: {
  refs: ControlRefClient;
  blobs: SharedStore;
  claims: ClaimClient;
  namer: ControlNamer;
  actor: () => ControlActor;
}): ControlStore {
  const { refs, namer } = deps;
  const receiptCheckpoint = createReceiptCheckpoint(deps);
  const queues = new Map<string, Promise<unknown>>();
  const captureKey = (key: ControlKey) =>
    checkedControlInput(() => controlKeySchema.parse(snapshotJson(key)), "invalid");
  const decode = (key: ControlKey, tip: ControlRefTip): ControlTip => ({
    sha: tip.sha,
    manifest: decodeControlManifest(namer, key, tip.bytes),
  });
  async function read(key: ControlKey, signal?: AbortSignal): Promise<ControlTip | null> {
    const captured = captureKey(key);
    aborted(signal);
    const result = await refs.read(captured, signal);
    aborted(signal);
    if (result.kind === "unconfirmed") throw new SharedStoreError("unavailable");
    return result.kind === "absent" ? null : decode(captured, result.tip);
  }
  function exclusive<T>(key: ControlKey, signal: AbortSignal | undefined, task: () => Promise<T>) {
    const name = `${key.kind}/${key.id}`;
    const previous = queues.get(name) ?? Promise.resolve();
    const waiting = async () => {
      aborted(signal);
      const cancelled = Promise.withResolvers<never>();
      const listener = signal
        ? addAbortListener(signal, () => cancelled.reject(new SharedStoreError("aborted")))
        : undefined;
      try {
        await Promise.race([previous, cancelled.promise]);
        aborted(signal);
      } finally {
        listener?.[Symbol.dispose]();
      }
    };
    const run = waiting().then(task);
    // Cancellation settles the waiter early, but cannot let its successors overtake the owner.
    const tail = Promise.allSettled([previous, run]);
    queues.set(name, tail);
    void tail.then(() => queues.get(name) === tail && queues.delete(name));
    return run;
  }
  return {
    read,
    receiptCheckpoint,
    async mutate(key, mutation, reduce, signal) {
      const captured = checkedControlInput(() => {
        const k = captureKey(key);
        const input = snapshotJson(mutation) as { id: string; command: JsonValue };
        const id = controlMutationIdSchema.parse(input.id);
        const digest = commandDigest(input.command);
        const actor = controlActorSchema.parse(snapshotJson(deps.actor()));
        return { key: k, entry: { id, actor, commandDigest: digest } };
      }, "invalid");
      const k = captured.key;
      const entry = captured.entry;
      function replay(tip: ControlTip | null): ControlMutationResult | undefined {
        const found = tip?.manifest.mutations.find((m) => m.id === entry.id);
        if (!found || !tip) return undefined;
        if (
          canonicalJson(found.actor) !== canonicalJson(entry.actor) ||
          found.commandDigest !== entry.commandDigest
        )
          throw new SharedStoreError("conflict");
        return { kind: "applied", tip, replayed: true };
      }
      return exclusive(k, signal, async (): Promise<ControlMutationResult> => {
        for (let attempt = 0; ; attempt++) {
          aborted(signal);
          const tip = await read(k, signal);
          const prior = replay(tip);
          if (prior) return prior;
          const next = checkedControlInput(() => {
            const snapshot = freeze(snapshotJson(tip?.manifest.value ?? null));
            const result = reduce(snapshot as ControlValue | null);
            if (
              result !== null &&
              (typeof result === "object" || typeof result === "function") &&
              "then" in result &&
              typeof result.then === "function"
            ) {
              void Promise.resolve(result).catch(() => undefined);
              throw new SharedStoreError("invalid");
            }
            if (result === undefined) return undefined;
            const value = validateControlReplacement(namer, tip?.manifest.value ?? null, result);
            if (canonicalJson(controlKey(namer, value)) !== canonicalJson(k))
              throw new SharedStoreError("invalid");
            return value;
          }, "invalid");
          if (next === undefined) return { kind: "unchanged", tip, reason: "precondition" };
          if (
            next.kind === "receipt" &&
            next.state === "committed" &&
            !(await receiptCheckpoint(next, signal))
          )
            return { kind: "unchanged", tip, reason: "precondition" };
          const bytes = encodeControlManifest(namer, {
            schema: 1,
            key: k,
            version: (tip?.manifest.version ?? 0) + 1,
            value: next,
            mutations: [...(tip?.manifest.mutations ?? []), entry],
          });
          aborted(signal);
          const result = await refs.write(k, tip?.sha ?? null, bytes, signal);
          if (result.kind === "applied")
            return { kind: "applied", tip: decode(k, result.tip), replayed: false };
          if (result.kind === "unconfirmed") return result;
          if (result.kind === "unchanged") return { kind: "unchanged", tip, reason: "send" };
          if (attempt === 1) {
            const moved = decode(k, result.tip);
            return replay(moved) ?? { kind: "moved", tip: moved };
          }
        }
      });
    },
  };
}
