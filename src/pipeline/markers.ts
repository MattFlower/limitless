import { createHash } from "node:crypto";

/** Delivery idempotency accepts both modes, including after an operator changes the setting. */
export function deliveryMarker(kind: string, runId: string, discreet = false) {
  const label = kind === "verification" ? kind : `${kind}-round`;
  const legacy = `<!-- limitless-${label}:${runId} -->`;
  const opaque = `<!-- ${label}:${createHash("sha256").update(runId).digest("hex").slice(0, 12)} -->`;
  return {
    marker: discreet ? opaque : legacy,
    includes: (text?: string) => !!text && (text.includes(legacy) || text.includes(opaque)),
  };
}
