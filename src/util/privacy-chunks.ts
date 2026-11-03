import { createHash } from "node:crypto";
import type { consumeBoundaryText } from "./privacy-boundary.ts";
import { currentPrivacyGeneration, privacyRegistry } from "./privacy-boundary.ts";

declare const chunksBrand: unique symbol;
export type BoundaryChunks = { readonly [chunksBrand]: true };
type Metadata = Omit<ReturnType<typeof consumeBoundaryText>, "text">;
type Generation = ReturnType<typeof currentPrivacyGeneration>;
type Evidence = {
  inputDigest?: string;
  parts: ArrayBuffer[] | undefined;
  metadata: Metadata;
  generation: Generation | undefined;
  registry: typeof privacyRegistry;
};
const receipts = new WeakMap<BoundaryChunks, Evidence>();
const marker = new TextEncoder().encode("[withheld: private text]");
function current(state: Evidence) {
  try {
    const g = currentPrivacyGeneration(state.registry),
      s = state.generation;
    return (
      !!s &&
      s.identity === g.identity &&
      s.policy === g.policy &&
      s.credentials === g.credentials &&
      s.checker === g.checker
    );
  } catch {
    return false;
  }
}
function refuse(metadata: Metadata, reason: Metadata["reason"]) {
  return { ...metadata, withheld: true, reason };
}
/** Internal bridge: only completely validated transport may transfer its private parts array here. */
export function issuePrivacyWorkerChunks(
  parts: ArrayBuffer[] | undefined,
  { truncated, checkedComplete, withheld, policyDigest, reason }: Metadata,
  generation: Generation | undefined,
  registry = privacyRegistry,
  text?: string,
): BoundaryChunks {
  const state: Evidence = {
    inputDigest: text === undefined ? undefined : createHash("sha256").update(text).digest("hex"),
    parts: parts ?? [marker.buffer],
    metadata: { truncated, checkedComplete, withheld, policyDigest, reason },
    generation,
    registry,
  };
  if (!registry.ready || !current(state)) {
    if (parts) parts.length = 0;
    state.parts = undefined;
    state.metadata = refuse(state.metadata, registry.ready ? "stale-generation" : "unreadable-policy");
  }
  const receipt = Object.freeze({}) as BoundaryChunks;
  receipts.set(receipt, state);
  return receipt;
}
export function consumeBoundaryChunk(
  receipt: unknown,
  index: number,
  registry?: typeof privacyRegistry,
  text?: string,
): Metadata & { bytes: Uint8Array; done: boolean } {
  const state =
    typeof receipt === "object" && receipt !== null ? receipts.get(receipt as BoundaryChunks) : undefined;
  const forged: Metadata = {
    truncated: undefined,
    checkedComplete: false,
    withheld: true,
    policyDigest: "privacy/unavailable",
    reason: "forged",
  };
  if (
    !state ||
    (registry && state.registry !== registry) ||
    (text !== undefined && state.inputDigest !== createHash("sha256").update(text).digest("hex"))
  )
    return { ...forged, bytes: marker.slice(), done: true };
  if (!state.registry.ready || !current(state)) {
    if (state.parts) state.parts.length = 0;
    state.parts = undefined;
    state.metadata = refuse(state.metadata, state.registry.ready ? "stale-generation" : "unreadable-policy");
    return { ...state.metadata, bytes: marker.slice(), done: true };
  }
  const { parts, metadata } = state;
  if (!Number.isSafeInteger(index) || index < 0 || index > (parts?.length ?? 0))
    return { ...forged, bytes: marker.slice(), done: true };
  if (!parts) return { ...metadata, bytes: marker.slice(), done: true };
  const part = parts[index];
  return { ...metadata, bytes: part ? new Uint8Array(part).slice() : new Uint8Array(), done: !part };
}
