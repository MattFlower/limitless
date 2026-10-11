import { redactCredentials, registerCredential } from "../util/proc.ts";
import { agentTestSlots, gateSlots, type Semaphore } from "./slots.ts";

export type TestLane = "gate" | "small";
export const AGENT_TEST_CAP_MS = { gate: 45 * 60_000, small: 15 * 60_000 } as const;
export interface TestWait {
  kind: "agent-test";
  phase: "wait" | "acquired" | "capped";
  command: string;
  lane: TestLane;
  waitMs?: number;
  capMs?: number;
}

interface SessionOptions {
  now?: () => number;
  timer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear?: typeof clearTimeout;
  slots?: Record<TestLane, Semaphore>;
  caps?: Record<TestLane, number>;
}
interface Lease {
  id?: string;
  lane: TestLane;
  command: string;
  started?: number;
  status: "queued" | "acquired" | "heartbeat" | "released" | "capped" | "recovered";
  capTimer?: ReturnType<typeof setTimeout>;
  waiter?: string;
}
const sessions = new Map<string, AgentTestSession>();

/** A capability issued by the daemon, bound to one invocation rather than a caller-supplied run id. */
export class AgentTestSession {
  readonly token = crypto.randomUUID();
  private readonly leases = new Map<string, Lease>();
  private readonly lanes = new Map<TestLane, Lease>();
  private readonly waits = new Map<string, number>();
  private closed = false;
  private readonly now;
  private readonly timer: NonNullable<SessionOptions["timer"]>;
  private readonly clear;
  private readonly slots;
  private readonly caps;

  constructor(
    private readonly event: (data: TestWait) => void,
    options: SessionOptions = {},
  ) {
    registerCredential("LIMITLESS_AGENT_TEST_CAPABILITY", this.token);
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? setTimeout;
    this.clear = options.clear ?? clearTimeout;
    this.slots = options.slots ?? { gate: gateSlots, small: agentTestSlots };
    this.caps = options.caps ?? AGENT_TEST_CAP_MS;
    sessions.set(this.token, this);
  }

  private end(lease: Lease, status: "heartbeat" | "released" | "capped") {
    if (lease.status !== "queued" && lease.status !== "acquired" && lease.status !== "heartbeat") return;
    lease.status = status;
    if (lease.waiter) this.waits.delete(lease.waiter);
    if (status !== "heartbeat" && lease.capTimer !== undefined) this.clear(lease.capTimer);
    if (lease.id) this.slots[lease.lane].heartbeat(lease.id, true);
    if (this.lanes.get(lease.lane) === lease) this.lanes.delete(lease.lane);
    if (status === "capped" && !this.closed)
      this.event({
        kind: "agent-test",
        phase: "capped",
        command: lease.command,
        lane: lease.lane,
        capMs: this.caps[lease.lane],
      });
  }

  private checkCap(lease: Lease) {
    if (lease.started !== undefined && this.now() - lease.started >= this.caps[lease.lane])
      this.end(lease, "capped");
  }

  async request(body: Record<string, unknown>) {
    if (this.closed || body.token !== this.token) throw new Error("invalid agent-test capability");
    if (body.reuse !== undefined) {
      if (typeof body.reuse !== "string" || (body.lane !== "small" && body.lane !== "gate"))
        throw new Error("invalid nested agent-test lease");
      const lease = this.leases.get(body.reuse);
      if (lease) this.checkCap(lease);
      const reused =
        !!lease &&
        lease.status === "acquired" &&
        (lease.lane === "gate" || body.lane === "small") &&
        this.slots[lease.lane].heartbeat(body.reuse) === true;
      return { id: body.reuse, acquired: reused, reused };
    }
    if (body.id !== undefined) {
      if (typeof body.id !== "string" || (body.release !== undefined && typeof body.release !== "boolean"))
        throw new Error("invalid agent-test lease");
      const lease = this.leases.get(body.id);
      if (!lease) throw new Error("lease does not belong to this invocation");
      this.checkCap(lease);
      if (body.release === true) this.end(lease, "released");
      const acquired =
        lease.status === "queued" || lease.status === "acquired"
          ? this.slots[lease.lane].heartbeat(body.id)
          : undefined;
      return {
        id: body.id,
        acquired: acquired ?? false,
        expired: acquired === undefined,
        capped: lease.status === "capped",
        capMs: this.caps[lease.lane],
        holder: this.slots[lease.lane].snapshot().holders.join(", "),
      };
    }
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      (body.lane !== "gate" && body.lane !== "small") ||
      (body.running !== undefined && typeof body.running !== "boolean") ||
      (body.immediate !== undefined && typeof body.immediate !== "boolean") ||
      (body.waiter !== undefined && typeof body.waiter !== "string")
    )
      throw new Error("invalid agent-test command or lane");
    const lane = body.lane;
    let previous: Lease | undefined;
    if (body.running === true) {
      previous = typeof body.recover === "string" ? this.leases.get(body.recover) : undefined;
      if (previous?.status === "capped")
        throw new Error(
          `agent-test ${previous.command} reached its ${this.caps[previous.lane]}ms duration cap`,
        );
      if (
        !previous ||
        previous.lane !== lane ||
        previous.status !== "heartbeat" ||
        previous.started === undefined
      )
        throw new Error("running recovery requires an earlier heartbeat-expired lease of this invocation");
      if (this.now() - previous.started >= this.caps[lane]) {
        this.end(previous, "capped");
        throw new Error(`agent-test ${previous.command} reached its ${this.caps[lane]}ms duration cap`);
      }
    }
    const waiter = typeof body.waiter === "string" ? body.waiter : undefined;
    const command = previous?.command ?? redactCredentials(body.name);
    const onWait = () => {
      if (waiter && this.waits.has(waiter)) return;
      if (waiter) this.waits.set(waiter, this.now());
      this.event({ kind: "agent-test", phase: "wait", command, lane });
    };
    const occupied = this.lanes.get(lane);
    if (occupied) {
      this.checkCap(occupied);
      if (this.lanes.has(lane)) {
        onWait();
        return { id: "", acquired: false, busy: true, holder: occupied.command };
      }
    }
    const lease: Lease = { lane, command, status: "queued", started: previous?.started, waiter };
    // Reserve before the await: simultaneous registrations cannot create a second lease.
    this.lanes.set(lane, lease);
    if (previous) {
      previous.status = "recovered";
      if (previous.capTimer !== undefined) this.clear(previous.capTimer);
    }
    let waited = waiter ? this.waits.get(waiter) : undefined;
    const id = await this.slots[lane].lease(
      command,
      body.immediate === true,
      (fn, ms) =>
        this.timer(() => {
          fn();
          this.end(lease, "heartbeat");
        }, ms),
      this.clear,
      body.running === true,
      {
        onWait: () => {
          waited ??= this.now();
          onWait();
        },
        onAcquired: () => {
          if (this.closed || lease.status !== "queued") return;
          lease.status = "acquired";
          lease.started ??= this.now();
          lease.capTimer = this.timer(
            () => this.end(lease, "capped"),
            Math.max(0, this.caps[lane] - (this.now() - lease.started)),
          );
          if (waiter) this.waits.delete(waiter);
          if (waited !== undefined)
            this.event({ kind: "agent-test", phase: "acquired", command, lane, waitMs: this.now() - waited });
        },
      },
    );
    lease.id = id;
    this.leases.set(id, lease);
    if (this.closed || (lease.status !== "queued" && lease.status !== "acquired")) {
      this.slots[lane].heartbeat(id, true);
      if (this.closed) throw new Error("invalid agent-test capability");
    }
    const acquired = this.slots[lane].heartbeat(id);
    if (acquired === undefined) this.end(lease, "released");
    return { id, acquired: acquired ?? false, holder: this.slots[lane].snapshot().holders.join(", ") };
  }

  close() {
    this.closed = true;
    sessions.delete(this.token);
    for (const lease of new Set([...this.lanes.values(), ...this.leases.values()])) {
      this.end(lease, "released");
      if (lease.capTimer !== undefined) this.clear(lease.capTimer);
    }
    this.leases.clear();
    this.waits.clear();
  }
}

export async function agentTestLease(body: Record<string, unknown>) {
  const session = typeof body.token === "string" ? sessions.get(body.token) : undefined;
  if (!session) throw new Error("invalid agent-test capability");
  return session.request(body);
}
