import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InvocationStatus } from "../core/types.ts";
import { HARNESS_KILLED, type StreamFault, untilAborted } from "../pipeline/faults.ts";
import { parseFakeStream } from "./stream-fault.ts";
import type { AgentEvent, AgentResult, AgentSpec, Harness } from "./types.ts";

export interface FakeReply {
  fault?: "exit" | "kill" | "timeout" | "throw" | "block";
  events?: AgentEvent[];
  stream?: StreamFault;
  status?: InvocationStatus;
  sessionId?: string | null;
  costUsd?: number;
  costEquivUsd?: number;
  usage?: AgentResult["usage"];
  quota?: AgentResult["quota"];
  text?: string;
  structured?: unknown;
  /** Files to write (relative to the spec cwd) — simulates an implementing agent. */
  files?: Record<string, string>;
  error?: string;
  delayMs?: number;
}

/** Deterministic harness for tests: the handler decides what the "agent" does. */
export function fakeHarness(handler: (spec: AgentSpec) => FakeReply | Promise<FakeReply>): Harness {
  return async (spec: AgentSpec): Promise<AgentResult> => {
    spec.onEvent({ type: "init", sessionId: "fake-session" });
    const reply = await handler(spec);
    if (spec.signal.aborted) return baseResult({ status: "cancelled", error: "cancelled" });
    for (const event of reply.events ?? []) spec.onEvent(event);
    for (const [path, content] of Object.entries(reply.files ?? {})) {
      const abs = join(spec.cwd, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      spec.onEvent({ type: "tool_call", id: path, name: "Write", input: { path } });
    }
    if (reply.text) spec.onEvent({ type: "text", text: reply.text });
    if (reply.fault === "throw") throw new Error(reply.error ?? "injected invocation error");
    if (reply.delayMs || reply.fault === "block")
      await untilAborted(spec.signal, reply.fault === "block" ? undefined : reply.delayMs);
    if (spec.signal.aborted) {
      return baseResult({
        status: "cancelled",
        error: "cancelled",
        usage: reply.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: reply.costUsd ?? 0,
        costEquivUsd: reply.costEquivUsd ?? 0,
      });
    }
    if (reply.stream) return parseFakeStream(reply.stream, spec.onEvent);
    if (reply.fault)
      return baseResult({
        usage: reply.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: reply.costUsd ?? 0,
        costEquivUsd: reply.costEquivUsd ?? 0,
        status: reply.fault === "timeout" ? "timeout" : "error",
        error: reply.error ?? (reply.fault === "kill" ? HARNESS_KILLED : `harness ${reply.fault}`),
      });
    // A reply the "agent" returned itself accounts its usage; a fault or cancellation above never does.
    return baseResult({
      status: reply.status ?? "ok",
      numTurns: 1,
      sessionId: reply.sessionId === undefined ? "fake-session" : reply.sessionId,
      finalText: reply.text ?? "",
      structured: reply.structured ?? null,
      error: reply.error ?? null,
      costUsd: reply.costUsd ?? 0,
      costEquivUsd: reply.costEquivUsd ?? 0.001,
      usage: reply.usage ?? { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      quota: reply.quota ?? null,
      usageFinal: true,
    });
  };
}

function baseResult(over: Partial<AgentResult>): AgentResult {
  return {
    status: "ok",
    finalText: "",
    structured: null,
    sessionId: "fake-session",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    numTurns: 0,
    costUsd: 0,
    costEquivUsd: 0,
    error: null,
    quota: null,
    ...over,
  };
}
