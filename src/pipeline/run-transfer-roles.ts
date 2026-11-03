import type { Database } from "bun:sqlite";
import { retainedOfflineExport } from "../db/portable-receipts.ts";
import type { RunState } from "./context.ts";

// Delivery roles are independent of the transfer's private storage classifications.
export const runDeliveryFields = {
  implementer: [
    "spec",
    "feedback",
    "lastAudit",
    "round",
    "reviewResolution",
    "verification",
    "flow",
    "gatesConfig",
    "baseline",
  ],
  "holdout-author": [
    "holdout",
    "holdoutStatus",
    "holdoutModelId",
    "holdoutSameVendor",
    "spec",
    "specAuthorVendor",
  ],
  verifier: ["holdout", "holdoutStatus", "holdoutModelId", "holdoutSameVendor", "spec", "gateEvidence"],
} as const satisfies Record<string, readonly (keyof RunState)[]>;
export type RunDeliveryRole = keyof typeof runDeliveryFields;

function pick<T extends object, K extends PropertyKey>(state: T, fields: readonly K[]) {
  return Object.fromEntries(
    fields.filter((key) => Object.hasOwn(state, key)).map((key) => [key, Reflect.get(state, key)]),
  ) as Pick<T, Extract<K, keyof T>>;
}

export function implementerView(state: RunState) {
  return pick(state, runDeliveryFields.implementer);
}

/** Dormant delivery: the caller exclusively owns the offline projection database. */
export function deliverImportedRun<R extends RunDeliveryRole>(db: Database, runId: string, role: R) {
  const { payload } = retainedOfflineExport(db, runId);
  return structuredClone({
    prompt: payload.run.prompt,
    ...(role === "implementer" && payload.followUp ? { ownerPrompt: payload.followUp.owner.prompt } : {}),
    state: pick(payload.state, runDeliveryFields[role]),
  });
}
