import { hkdfSync } from "node:crypto";
import { loadPrivateStrings, privateStringsDigest } from "../gates/private.ts";
import { rethrowClaimControl } from "./claim-errors.ts";
import type { ControlNamer } from "./control-identity.ts";
import { decodeControlManifest } from "./control-record.ts";
import type { ControlRefReader, ControlRefTip } from "./control-ref.ts";
import { type ControlStore, createControlStore } from "./control-store.ts";
import { SharedStoreError } from "./shared-store.ts";

export const parityKey = (dataKey: Uint8Array): Buffer =>
  Buffer.from(hkdfSync("sha256", dataKey, "limitless-private-strings-parity", "v1", 32));
// key is the companion data key; naming and parity derive separate subkeys.
type PolicyInput = { namer: ControlNamer; key: Uint8Array; configDir: string };
export function publishPrivateStringsPolicy(
  deps: PolicyInput & Omit<Parameters<typeof createControlStore>[0], "actor"> & { owner: string },
  mutation: Parameters<ControlStore["mutate"]>[1],
  signal?: AbortSignal,
) {
  const value = {
    kind: "policy" as const,
    name: "private-strings" as const,
    digest: privateStringsDigest(loadPrivateStrings(deps.configDir), parityKey(deps.key)),
  };
  const store = createControlStore({ ...deps, actor: () => ({ kind: "owner", id: deps.owner }) });
  return store.mutate(deps.namer.derive("policy", [value.name]), mutation, () => value, signal);
}
const caches = new WeakMap<ControlRefReader, Map<string, { tip: ControlRefTip; digest: string }>>();
export async function checkParity(
  deps: PolicyInput & { refs: ControlRefReader },
  signal?: AbortSignal,
): Promise<"match" | "differs" | "unknown"> {
  try {
    signal?.throwIfAborted();
    const key = deps.namer.derive("policy", ["private-strings"]);
    const cache = caches.get(deps.refs) ?? new Map<string, { tip: ControlRefTip; digest: string }>();
    caches.set(deps.refs, cache);
    let prior = cache.get(key.id);
    const result = await deps.refs.read(key, signal, prior?.tip);
    signal?.throwIfAborted();
    if (result.kind !== "tip") return "unknown";
    if (result.tip.sha !== prior?.tip.sha) {
      const { value } = decodeControlManifest(deps.namer, key, result.tip.bytes);
      if (value.kind !== "policy") return "unknown";
      prior = { tip: result.tip, digest: value.digest };
      cache.set(key.id, prior);
    }
    return prior?.digest === privateStringsDigest(loadPrivateStrings(deps.configDir), parityKey(deps.key))
      ? "match"
      : "differs";
  } catch (error) {
    rethrowClaimControl(error);
    signal?.throwIfAborted();
    if (error instanceof SharedStoreError && error.code === "aborted") throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    return "unknown";
  }
}
