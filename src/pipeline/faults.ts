import type { Role, StageName } from "../core/types.ts";

export type FaultPoint =
  | `stage:${StageName}:${"before" | "after"}`
  | "harness:invoke"
  | "harness:stream"
  | "store:save";
export interface FaultContext {
  runId: string;
  stage?: StageName;
  round: number;
  role?: Role;
  modelId?: string;
  invocationId?: number;
  checkpoint?: string;
}
export type StreamFault = { parser: "claude" | "codex"; lines: string[] };
export interface Fault {
  action: "throw" | "hang" | "kill" | StreamFault;
  occurrence?: number;
  when?: (context: FaultContext) => boolean;
  onHit?: (context: FaultContext) => void;
}
/**
 * Test-only script; each entry fires once per RunContext, counting only matching occurrences.
 * Stage before/after bracket the callback, inside the attempt row but before its final status.
 * Harness points follow slot acquisition and invocation creation, before calling the adapter.
 * Stream actions feed synthetic input through CLI parsers instead of invoking an adapter.
 * Store save fires immediately before setRunState; throwing leaves the durable checkpoint intact.
 * Kill unwinds active resources and leaves the run running for a fresh scheduler to recover.
 */
export type FaultPlan = Partial<Record<FaultPoint, Fault | Fault[]>>;
export class SimulatedTermination extends Error {}

export function untilAborted(signal: AbortSignal, ms?: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    if (ms !== undefined) timer = setTimeout(done, ms);
    if (signal.aborted) done();
  });
}

export class FaultInjector {
  private counts = new Map<FaultPoint, Map<Fault, number>>();
  constructor(private readonly plan?: FaultPlan) {}
  async hit(point: FaultPoint, context: FaultContext, signal: AbortSignal): Promise<StreamFault | undefined> {
    const configured = this.plan?.[point];
    if (!configured) return undefined;
    let counts = this.counts.get(point);
    if (!counts) {
      counts = new Map();
      this.counts.set(point, counts);
    }
    for (const fault of configured ? (Array.isArray(configured) ? configured : [configured]) : []) {
      if (fault.when && !fault.when(context)) continue;
      const count = (counts.get(fault) ?? 0) + 1;
      counts.set(fault, count);
      if (count !== (fault.occurrence ?? 1)) continue;
      fault.onHit?.(context);
      if (fault.action === "hang") await untilAborted(signal);
      else if (fault.action === "kill") throw new SimulatedTermination(`terminated at ${point}`);
      else if (fault.action === "throw") throw new Error(`injected failure at ${point}`);
      else return fault.action;
    }
    return undefined;
  }
}
