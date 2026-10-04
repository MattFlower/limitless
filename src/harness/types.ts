import type { ZodType } from "zod";
import type { Billing, ConfinementProbe, Effort, InvocationStatus, QuotaWindow } from "../core/types.ts";
import { redactCredentialData, redactCredentials } from "../util/proc.ts";
import type { DecisionDecline, DecisionTask } from "./decisions.ts";

/** A concrete model on a concrete provider, as chosen by the router. */
export interface ModelTarget {
  modelId: string; // catalog id, e.g. "claude/sonnet"
  provider: string; // "claude" | "codex" | "openrouter" | "mtplx" | "twilight" | "typesafe"
  harness: "claude" | "codex" | "decisions" | "fake";
  model: string; // backend model name passed to the CLI / API
  vendor: string;
  tier: number;
  billing: Billing;
  effort?: Effort;
  targetId?: string;
  effortMapping?: "openrouter" | "generic" | "qwen";
  /** For the claude harness pointed at a non-Anthropic backend (OpenRouter, mtplx, llama.cpp). */
  backend?: { baseUrl: string; authToken: string };
  openai?: { baseUrl: string; authToken: string };
  /** Typed-question API for decision models (harness/decisions.ts). */
  decisions?: { baseUrl: string; authToken: string };
  /** $ per million tokens; used for metered cost and subscription cost-equivalence. */
  price?: { input: number; output: number; cacheRead?: number };
}

export type AgentEvent =
  | { type: "init"; sessionId: string; model?: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      id: string;
      output: string;
      isError: boolean;
    }
  | { type: "rate_limit"; status: string; windows: Record<string, QuotaWindow>; resetsAt: number | null }
  | { type: "stderr"; text: string }
  | { type: "status"; text: string };

export interface AgentSpec {
  fast?: boolean;
  cwd: string;
  /** Disposable write root owned by the invocation lifecycle, outside cwd. */
  scratchDir?: string;
  prompt: string;
  systemAppend?: string;
  target: ModelTarget;
  /** "readonly" agents get no edit tools; the pipeline also resets the tree after them. */
  mode: "edit" | "readonly";
  jsonSchema?: Record<string, unknown>;
  /** Runtime validation for HTTP structured completions. */
  schema?: ZodType;
  /** Typed questions for the decisions harness; only roles with a decisions mapping pass one. */
  decisionTask?: DecisionTask;
  resumeSessionId?: string;
  addDirs?: string[];
  /** Paths a tool-enabled reader must not read, e.g. a worktree being edited in parallel. */
  denyRead?: string[];
  /**
   * A tool-enabled reader may read only its cwd and scratch (plus system files commands need):
   * not home directories, other temporary directories or `denyRead`.
   */
  confineReads?: boolean;
  timeoutMs: number;
  idleTimeoutMs: number;
  maxToolCalls: number;
  /** Structured authoring call; disallow tool access where the CLI supports it. */
  noTools?: boolean;
  /** Do not retain CLI session transcripts for private structured calls. */
  privateSession?: boolean;
  /** Redact private prompt content before writing the CLI transcript. */
  redactOutput?: (text: string) => string;
  signal: AbortSignal;
  /** Raw stream is appended here for post-mortem debugging. */
  logPath: string;
  onEvent: (e: AgentEvent) => void;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AgentResult {
  fastModeState?: string | null;
  fastModeDisabledReason?: string | null;
  status: InvocationStatus;
  finalText: string;
  structured: unknown;
  sessionId: string | null;
  usage: Usage;
  numTurns: number;
  costUsd: number; // real money spent
  costEquivUsd: number; // API list-price equivalent
  error: string | null;
  /** Quota telemetry observed during the run (Claude rate_limit_event / Codex rollout). */
  quota: { windows: Record<string, QuotaWindow>; exhaustedUntil: number | null } | null;
  /** With status "quota": only this model is rate-limited, so cool it down instead of its provider. */
  modelCooldownMs?: number;
  /** With status "declined": why, and whether the answer may still serve as a last resort. */
  decline?: DecisionDecline;
  /** A confined reader's sandbox probe; when not ok, the agent never started. */
  confinement?: ConfinementProbe;
}

export type Harness = (spec: AgentSpec) => Promise<AgentResult>;

/** Redact string values before persisting a structured CLI event. */
export function redactJsonLine(line: string, redact?: (text: string) => string): string {
  redact ??= redactCredentials;
  try {
    return JSON.stringify(redactCredentialData(JSON.parse(line)), (_key, value: unknown) =>
      typeof value === "string" ? redact(value) : value,
    );
  } catch {
    return redact(line);
  }
}

export const protectCredentials = (spec: AgentSpec): AgentSpec => ({
  ...spec,
  onEvent: (event) => spec.onEvent(redactCredentialData(event)),
  redactOutput: (text) => redactCredentials(spec.redactOutput?.(text) ?? text),
});

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function priceOf(usage: Usage, price: ModelTarget["price"]): number {
  if (!price) return 0;
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  return (
    (usage.input * price.input +
      usage.cacheWrite * price.input * 1.25 +
      usage.cacheRead * cacheRead +
      usage.output * price.output) /
    1_000_000
  );
}

/**
 * Detects an agent stuck repeating the same tool call, or blowing through its tool budget.
 * Returns a reason string when the run should be stopped.
 */
export class LoopDetector {
  private recent: string[] = [];
  private total = 0;
  constructor(
    private readonly maxToolCalls: number,
    private readonly maxIdenticalInWindow = 6,
    private readonly window = 12,
  ) {}

  observe(name: string, input: unknown): string | null {
    this.total++;
    if (this.total > this.maxToolCalls) return `exceeded tool-call budget (${this.maxToolCalls})`;
    const key = `${name}:${JSON.stringify(input)}`;
    this.recent.push(key);
    if (this.recent.length > this.window) this.recent.shift();
    const same = this.recent.filter((k) => k === key).length;
    if (same >= this.maxIdenticalInWindow) return `repeated the same ${name} call ${same} times`;
    return null;
  }
}

/**
 * Pull a JSON object out of free text: a fenced ```json block if present, otherwise the last
 * balanced {...} that parses. Weaker models often answer with JSON in prose instead of calling a
 * structured-output tool.
 */
export function extractJson(text: string): unknown {
  if (!text) return null;
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  for (const block of fenced.reverse()) {
    try {
      return JSON.parse(block);
    } catch {
      // try the next candidate
    }
  }
  for (let end = text.lastIndexOf("}"); end > 0; end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      const ch = text[i];
      if (ch === "}") depth++;
      else if (ch === "{" && --depth === 0) {
        try {
          return JSON.parse(text.slice(i, end + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}
