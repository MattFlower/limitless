import { redactCredentials } from "../util/proc.ts";
import { agentTestSlots, gateSlots, type Semaphore } from "./slots.ts";

export type TestLane = "gate" | "small";
export interface TestWait {
  kind: "agent-test";
  phase: "wait" | "acquired";
  command: string;
  lane: TestLane;
  waitMs?: number;
}

const sessions = new Map<string, AgentTestSession>();

/** A capability issued by the daemon, bound to one invocation rather than a caller-supplied run id. */
export class AgentTestSession {
  readonly token = crypto.randomUUID();
  private readonly leases = new Map<string, Semaphore>();
  private closed = false;

  constructor(private readonly event: (data: TestWait) => void) {
    sessions.set(this.token, this);
  }

  async request(body: Record<string, unknown>) {
    if (this.closed || body.token !== this.token) throw new Error("invalid agent-test capability");
    if (body.id !== undefined) {
      if (typeof body.id !== "string" || (body.release !== undefined && typeof body.release !== "boolean"))
        throw new Error("invalid agent-test lease");
      const slots = this.leases.get(body.id);
      if (!slots) throw new Error("lease does not belong to this invocation");
      const acquired = slots.heartbeat(body.id, body.release === true);
      return { id: body.id, acquired: acquired ?? false, expired: acquired === undefined };
    }
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      (body.lane !== "gate" && body.lane !== "small") ||
      (body.running !== undefined && typeof body.running !== "boolean") ||
      (body.immediate !== undefined && typeof body.immediate !== "boolean")
    )
      throw new Error("invalid agent-test command or lane");
    const lane = body.lane;
    const command = redactCredentials(body.name);
    const slots = lane === "small" ? agentTestSlots : gateSlots;
    let waited: number | undefined;
    const id = await slots.lease(
      command,
      body.immediate === true,
      undefined,
      undefined,
      body.running === true,
      {
        onWait: () => {
          waited = Date.now();
          this.event({ kind: "agent-test", phase: "wait", command, lane });
        },
        onAcquired: () => {
          if (waited !== undefined && !this.closed)
            this.event({ kind: "agent-test", phase: "acquired", command, lane, waitMs: Date.now() - waited });
        },
      },
    );
    this.leases.set(id, slots);
    if (this.closed) slots.heartbeat(id, true);
    return { id, acquired: slots.heartbeat(id) ?? false };
  }

  close() {
    this.closed = true;
    sessions.delete(this.token);
    for (const [id, slots] of this.leases) slots.heartbeat(id, true);
    this.leases.clear();
  }
}

export async function agentTestLease(body: Record<string, unknown>) {
  const session = typeof body.token === "string" ? sessions.get(body.token) : undefined;
  if (!session) throw new Error("invalid agent-test capability");
  return session.request(body);
}
