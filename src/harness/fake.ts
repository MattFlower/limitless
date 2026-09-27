import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InvocationStatus } from "../core/types.ts";
import type { AgentResult, AgentSpec, Harness } from "./types.ts";

export interface FakeReply {
  status?: InvocationStatus;
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
    if (reply.delayMs) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, reply.delayMs);
        spec.signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (spec.signal.aborted) {
      return baseResult({ status: "cancelled", error: "cancelled" });
    }
    for (const [path, content] of Object.entries(reply.files ?? {})) {
      const abs = join(spec.cwd, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      spec.onEvent({ type: "tool_call", id: path, name: "Write", input: { path } });
    }
    if (reply.text) spec.onEvent({ type: "text", text: reply.text });
    return baseResult({
      status: reply.status ?? "ok",
      finalText: reply.text ?? "",
      structured: reply.structured ?? null,
      error: reply.error ?? null,
      costUsd: reply.costUsd ?? 0,
      costEquivUsd: reply.costEquivUsd ?? 0.001,
      usage: reply.usage ?? { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      quota: reply.quota ?? null,
    });
  };
}

function baseResult(over: Partial<AgentResult>): AgentResult {
  return {
    status: "ok",
    finalText: "",
    structured: null,
    sessionId: "fake-session",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    numTurns: 1,
    costUsd: 0,
    costEquivUsd: 0.001,
    error: null,
    quota: null,
    ...over,
  };
}
