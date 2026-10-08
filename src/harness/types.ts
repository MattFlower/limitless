import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import type { Billing, ConfinementProbe, Effort, InvocationStatus, QuotaWindow } from "../core/types.ts";
import { redactCredentialData, redactCredentials } from "../util/proc.ts";
import type { DecisionDecline, DecisionTask } from "./decisions.ts";

/** A concrete model on a concrete provider, as chosen by the router. */
export interface ModelTarget {
  modelId: string; // catalog id, e.g. "claude/opus"
  provider: string; // "claude" | "codex" | "openrouter" | "mtplx" | "typesafe"
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
  | { type: "status"; text: string }
  | { type: "warning"; id: string; text: string };

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
  /** The subset of `cacheWrite` priced at the 1-hour cache rate; absent when the stream has no breakdown. */
  cacheWrite1h?: number;
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
  // A 1-hour write costs twice the input rate; without the breakdown every write is a 5-minute one.
  const write1h = Math.min(usage.cacheWrite1h ?? 0, usage.cacheWrite);
  const cacheWrite = (usage.cacheWrite - write1h) * price.input * 1.25 + write1h * price.input * 2;
  return (
    (usage.input * price.input + cacheWrite + usage.cacheRead * cacheRead + usage.output * price.output) /
    1_000_000
  );
}

interface LoopCall {
  key: string;
  name: string;
  id?: string;
  hash?: string;
  previous?: string;
}

/**
 * Detects an agent stuck repeating the same tool call, or blowing through its tool budget.
 * Returns a reason string when the run should be stopped.
 */
export class LoopDetector {
  private recent: LoopCall[] = [];
  private pending = new Map<string, LoopCall>();
  private results = new Map<string, string>();
  private total = 0;
  constructor(
    private readonly maxToolCalls: number,
    private readonly maxIdenticalInWindow = 6,
    private readonly window = 12,
  ) {}

  observe(name: string, input: unknown, id?: string): string | null {
    this.total++;
    if (this.total > this.maxToolCalls) return `exceeded tool-call budget (${this.maxToolCalls})`;
    // A threshold call may show progress until the next call, but cannot defer a stop forever.
    const reason = this.reconcile(true);
    if (reason) return reason;
    const key = `${name}:${JSON.stringify(input)}`;
    const entry = { key, name, id, previous: this.results.get(key) };
    if (id !== undefined) this.pending.set(id, entry);
    this.recent.push(entry);
    if (this.recent.length > this.window) {
      const evicted = this.recent.shift();
      if (evicted?.id !== undefined) this.pending.delete(evicted.id);
      if (evicted && !this.recent.some((entry) => entry.key === evicted.key))
        this.results.delete(evicted.key);
    }
    return this.reconcile();
  }

  observeResult(id: string, output: string): string | null {
    const entry = this.pending.get(id);
    if (!entry) return null;
    this.pending.delete(id);
    entry.hash = createHash("sha256").update(output).digest("hex");
    return this.reconcile();
  }

  /** Invocation completion ends the threshold call's opportunity to show progress. */
  finish(): string | null {
    return this.reconcile(true);
  }

  private reconcile(finished = false): string | null {
    // Replay the bounded window so late results compare in call order. Each entry remembers
    // its preceding baseline, including when that baseline's call has left the window.
    const baselines = new Map<string, string | undefined>();
    const counts = new Map<string, { same: number; last: LoopCall }>();
    for (const entry of this.recent) {
      const previous = baselines.has(entry.key) ? baselines.get(entry.key) : entry.previous;
      entry.previous = previous;
      let same = (counts.get(entry.key)?.same ?? 0) + 1;
      if (entry.hash !== undefined) {
        if (previous !== undefined && previous !== entry.hash) {
          // Any changed output is progress, even timestamps: varying-output loops stop only at
          // the tool-call budget or invocation timeout. Repeated failing commands with identical
          // output, the stuck behavior seen in practice, remain detectable.
          same = 0;
        }
      }
      const baseline = entry.hash ?? previous;
      baselines.set(entry.key, baseline);
      if (baseline !== undefined) this.results.set(entry.key, baseline);
      counts.set(entry.key, { same, last: entry });
    }
    for (const { same, last } of counts.values()) {
      if (same < this.maxIdenticalInWindow) continue;
      if (
        !finished &&
        this.recent.some(
          (entry) => entry.key === last.key && entry.id !== undefined && entry.hash === undefined,
        )
      )
        continue;
      return `repeated the same ${last.name} call ${this.maxIdenticalInWindow} times`;
    }
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
