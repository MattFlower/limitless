import { isDeepStrictEqual } from "node:util";
import type { CheckpointRecord } from "../db/shared-checkpoints.ts";
import type { Store } from "../db/store.ts";
import type { ClaimClient, ClaimTip } from "../integrations/claim-ref.ts";
import type { LeaseHandle, LeaseManager } from "../integrations/leases.ts";
export function parsePointer(p: string): { key: string; digest: string } | null {
  const match = /^ckpt1:([0-9a-f]{32}):([0-9a-f]{64})$/.exec(p);
  return match?.[0] === p && match[1] && match[2] ? { key: match[1], digest: match[2] } : null;
}
export function formatPointer(key: string, digest: string): string {
  const pointer = `ckpt1:${key}:${digest}`;
  if (!parsePointer(pointer)) throw new Error("Invalid checkpoint pointer");
  return pointer;
}
export type Settlement = "current" | "promote" | "drop-pending" | "blocked" | "wait";
export function classify(
  remote: string | null,
  ledger: CheckpointRecord | null,
): Exclude<Settlement, "wait"> {
  if (remote !== null && !parsePointer(remote)) return "blocked";
  if (remote === (ledger?.committed?.pointer ?? null)) return ledger?.pending ? "drop-pending" : "current";
  return remote !== null && remote === ledger?.pending?.pointer ? "promote" : "blocked";
}
export async function settleCheckpoint(
  deps: { leases: Pick<LeaseManager, "settle">; claims: Pick<ClaimClient, "read">; store: Store },
  handle: LeaseHandle,
): Promise<{ settlement: Settlement; tip: ClaimTip | null }> {
  const { leases, claims, store } = deps;
  return store.coordinateCheckpoint(handle.run, async () => {
    for (;;) {
      if ((await leases.settle(handle.repo, handle.ref)) === "pending")
        return { settlement: "wait", tip: null };
      const row = store.checkpointRecord(handle.run);
      const read = await claims.read(handle.repo, handle.ref);
      if (read.kind === "unconfirmed") return { settlement: "wait", tip: null };
      if (!isDeepStrictEqual(row, store.checkpointRecord(handle.run))) continue;
      const tip = read.kind === "tip" ? read.tip : null,
        r = tip?.record;
      if (!r || r === "malformed") return { settlement: "blocked", tip };
      if (r.holder !== handle.member || r.run !== handle.run || r.generation !== handle.generation)
        return { settlement: "blocked", tip };
      const settlement = classify(r.checkpoint ?? null, row);
      if (settlement === "promote" && !store.confirmCheckpoint(handle.run, r.checkpoint ?? "", row)) continue;
      if (settlement === "drop-pending" && !store.dropPendingCheckpoint(handle.run, row)) continue;
      return { settlement, tip };
    }
  });
}
