import type { LandEntry } from "../core/types.ts";

/** Keep the state vocabulary understood by older HTTP and MCP clients. */
export function landWire(entry: LandEntry): LandEntry {
  return entry.state === "waiting_approval" ? { ...entry, state: "queued", waitingApproval: true } : entry;
}

export function landState(entry: Pick<LandEntry, "state" | "waitingApproval">): LandEntry["state"] {
  return entry.waitingApproval ? "waiting_approval" : entry.state;
}
