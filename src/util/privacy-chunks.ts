import type { consumeBoundaryText } from "./privacy-boundary.ts";
import { currentPrivacyGeneration, privacyRegistry } from "./privacy-boundary.ts";

declare const chunksBrand: unique symbol;
export type BoundaryChunks = { readonly [chunksBrand]: true };
type Metadata = Omit<ReturnType<typeof consumeBoundaryText>, "text">;
type Generation = ReturnType<typeof currentPrivacyGeneration>;
type Evidence = {
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
): BoundaryChunks {
  const state: Evidence = {
    parts: parts ?? [marker.buffer],
    metadata: { truncated, checkedComplete, withheld, policyDigest, reason },
    generation,
    registry,
  };
  if (!current(state)) {
    if (parts) parts.length = 0;
    state.parts = undefined;
    state.metadata = refuse(state.metadata, "stale-generation");
  }
  const receipt = Object.freeze({}) as BoundaryChunks;
  receipts.set(receipt, state);
  return receipt;
}
export function consumeBoundaryChunk(
  receipt: unknown,
  index: number,
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
  if (!state) return { ...forged, bytes: marker.slice(), done: true };
  if (!current(state)) {
    if (state.parts) state.parts.length = 0;
    state.parts = undefined;
    state.metadata = refuse(state.metadata, "stale-generation");
    return { ...state.metadata, bytes: marker.slice(), done: true };
  }
  const { parts, metadata } = state;
  if (!Number.isSafeInteger(index) || index < 0 || index > (parts?.length ?? 0))
    return { ...forged, bytes: marker.slice(), done: true };
  if (!parts) return { ...metadata, bytes: marker.slice(), done: true };
  const part = parts[index];
  return { ...metadata, bytes: part ? new Uint8Array(part).slice() : new Uint8Array(), done: !part };
}
