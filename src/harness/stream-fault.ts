import type { StreamFault } from "../pipeline/faults.ts";
import { ClaudeStreamParser } from "./claude.ts";
import { CodexStreamParser } from "./codex.ts";
import { type AgentEvent, type AgentResult, extractJson } from "./types.ts";

/** Synthetic bytes go through the same parsers and completion markers as the CLI adapters. */
export function parseFakeStream(stream: StreamFault, emit: (event: AgentEvent) => void): AgentResult {
  const parser = stream.parser === "claude" ? new ClaudeStreamParser(emit) : new CodexStreamParser(emit);
  for (const line of stream.lines) parser.feed(line);
  const complete =
    parser instanceof ClaudeStreamParser
      ? parser.gotResult && !parser.isError
      : parser.completed && !parser.failed;
  return {
    status: complete ? "ok" : "error",
    error: complete ? null : "malformed or truncated harness stream: missing successful completion",
    finalText: parser instanceof ClaudeStreamParser ? parser.finalText : parser.lastMessage,
    structured: parser instanceof ClaudeStreamParser ? parser.structured : extractJson(parser.lastMessage),
    usage: parser.usage,
    sessionId: "fake-session",
    numTurns: 0,
    costUsd: 0,
    costEquivUsd: 0,
    quota: null,
  };
}
