import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InvocationStatus } from "../core/types.ts";
import { type StreamFault, untilAborted } from "../pipeline/faults.ts";
import { ClaudeStreamParser } from "./claude.ts";
import { CodexStreamParser } from "./codex.ts";
import { type AgentEvent, type AgentResult, type AgentSpec, extractJson, type Harness } from "./types.ts";

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
    for (const event of reply.events ?? []) spec.onEvent(event);
    if (reply.fault === "throw") throw new Error(reply.error ?? "injected invocation error");
    if (reply.delayMs || reply.fault === "block")
      await untilAborted(spec.signal, reply.fault === "block" ? undefined : reply.delayMs);
    if (spec.signal.aborted) {
      return baseResult({ status: "cancelled", error: "cancelled" });
    }
    if (reply.stream) return parseFakeStream(reply.stream, spec.onEvent);
    if (reply.fault)
      return baseResult({
        status: reply.fault === "timeout" ? "timeout" : "error",
        error: reply.error ?? `harness ${reply.fault}`,
      });
    for (const [path, content] of Object.entries(reply.files ?? {})) {
      const abs = join(spec.cwd, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      spec.onEvent({ type: "tool_call", id: path, name: "Write", input: { path } });
    }
    if (reply.text) spec.onEvent({ type: "text", text: reply.text });
    return baseResult({
      status: reply.status ?? "ok",
      sessionId: reply.sessionId === undefined ? "fake-session" : reply.sessionId,
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

/** Synthetic bytes go through the same parsers and completion markers as the CLI adapters. */
export function parseFakeStream(stream: StreamFault, emit: (event: AgentEvent) => void): AgentResult {
  const parser = stream.parser === "claude" ? new ClaudeStreamParser(emit) : new CodexStreamParser(emit);
  for (const line of stream.lines) parser.feed(line);
  const complete =
    parser instanceof ClaudeStreamParser
      ? parser.gotResult && !parser.isError
      : parser.completed && !parser.failed;
  return baseResult({
    status: complete ? "ok" : "error",
    error: complete ? null : "malformed or truncated harness stream: missing successful completion",
    finalText: parser instanceof ClaudeStreamParser ? parser.finalText : parser.lastMessage,
    structured: parser instanceof ClaudeStreamParser ? parser.structured : extractJson(parser.lastMessage),
    usage: parser.usage,
  });
}
