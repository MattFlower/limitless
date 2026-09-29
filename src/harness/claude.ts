import { appendFileSync, realpathSync } from "node:fs";
import type { QuotaWindow } from "../core/types.ts";
import { agentEnv, runProcess } from "../util/proc.ts";
import { readConfinement, scratchEnv, scratchParent, validateDenyRead, validateScratch } from "./scratch.ts";
import {
  type AgentEvent,
  type AgentResult,
  type AgentSpec,
  emptyUsage,
  extractJson,
  LoopDetector,
  priceOf,
  redactJsonLine,
  type Usage,
} from "./types.ts";

export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

const QUOTA_TEXT =
  /(hit your (session|weekly|opus|sonnet|fable|usage) limit|usage limit reached|rate limit.*reset|out of (extra )?usage)/i;

type Json = Record<string, unknown>;

function blocks(msg: unknown): Json[] {
  const content = (msg as { content?: unknown })?.content;
  return Array.isArray(content) ? (content as Json[]) : [];
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "object" && c && "text" in c ? String((c as Json).text) : JSON.stringify(c)))
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

/** Pure parser for `claude -p --output-format stream-json --verbose` output. */
export class ClaudeStreamParser {
  sessionId: string | null = null;
  finalText = "";
  lastAssistantText = "";
  structured: unknown = null;
  usage: Usage = emptyUsage();
  numTurns = 0;
  reportedCostUsd = 0;
  isError = false;
  subtype: string | null = null;
  gotResult = false;
  windows: Record<string, QuotaWindow> = {};
  quotaRejectedUntil: number | null = null;
  quotaText = false;

  constructor(private readonly emit: (e: AgentEvent) => void) {}

  feed(line: string): void {
    let e: Json;
    try {
      e = JSON.parse(line) as Json;
    } catch {
      this.emit({ type: "status", text: line.slice(0, 500) });
      return;
    }
    switch (e.type) {
      case "system": {
        if (e.subtype === "init") {
          this.sessionId = (e.session_id as string) ?? this.sessionId;
          this.emit({ type: "init", sessionId: this.sessionId ?? "", model: e.model as string });
        }
        break;
      }
      case "assistant": {
        for (const b of blocks(e.message)) {
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            this.lastAssistantText = b.text;
            if (QUOTA_TEXT.test(b.text)) this.quotaText = true;
            this.emit({ type: "text", text: b.text });
          } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
            this.emit({ type: "thinking", text: b.thinking });
          } else if (b.type === "tool_use") {
            this.emit({ type: "tool_call", id: String(b.id), name: String(b.name), input: b.input });
          }
        }
        break;
      }
      case "user": {
        for (const b of blocks(e.message)) {
          if (b.type === "tool_result") {
            this.emit({
              type: "tool_result",
              id: String(b.tool_use_id),
              output: toolResultText(b.content).slice(0, 20_000),
              isError: Boolean(b.is_error),
            });
          }
        }
        break;
      }
      case "rate_limit_event": {
        const info = (e.rate_limit_info ?? {}) as Json;
        const unified = (info.unifiedWindows ?? {}) as Record<string, Json>;
        for (const [name, w] of Object.entries(unified)) {
          this.windows[name] = {
            utilization: Number(w.utilization ?? 0),
            resetsAt: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null,
          };
        }
        const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt * 1000 : null;
        if (info.status === "rejected") this.quotaRejectedUntil = resetsAt ?? Date.now() + 60 * 60 * 1000;
        this.emit({
          type: "rate_limit",
          status: String(info.status ?? "unknown"),
          windows: this.windows,
          resetsAt,
        });
        break;
      }
      case "result": {
        this.gotResult = true;
        this.subtype = (e.subtype as string) ?? null;
        this.isError = Boolean(e.is_error);
        this.sessionId = (e.session_id as string) ?? this.sessionId;
        this.numTurns = Number(e.num_turns ?? 0);
        this.reportedCostUsd = Number(e.total_cost_usd ?? 0);
        const u = (e.usage ?? {}) as Json;
        this.usage = {
          input: Number(u.input_tokens ?? 0),
          output: Number(u.output_tokens ?? 0),
          cacheRead: Number(u.cache_read_input_tokens ?? 0),
          cacheWrite: Number(u.cache_creation_input_tokens ?? 0),
        };
        this.structured = e.structured_output ?? null;
        this.finalText = typeof e.result === "string" ? e.result : this.lastAssistantText;
        if (typeof e.result === "string" && QUOTA_TEXT.test(e.result)) this.quotaText = true;
        break;
      }
      default:
        break;
    }
  }
}

export function buildClaudeArgs(spec: AgentSpec, sessionId: string): string[] {
  const t = spec.target;
  if (spec.mode === "readonly" && spec.addDirs?.length)
    throw new Error("Reading invocations cannot grant additional directories");
  const args = [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    t.model,
    // Readers must not inherit hooks, sandbox exclusions or permissions from project settings.
    "--setting-sources",
    spec.mode === "readonly" ? "" : "project,local",
    "--permission-mode",
    "dontAsk",
  ];
  const denied = ["Bash(git push:*)", "Bash(gh pr merge:*)", "Bash(gh repo delete:*)", "Bash(rm -rf /*)"];
  let readTools = ["Read", "Grep", "Glob"];
  if (spec.mode === "readonly" && !spec.noTools) {
    const scratch = validateScratch(spec);
    scratchParent(scratch);
    const explicit = validateDenyRead(spec, scratch);
    const confined = spec.confineReads ? readConfinement(spec, scratch) : null;
    const denyRead = confined?.deny ?? explicit;
    // The sandbox confines Bash; Read rules also cover Grep and Glob. "//" marks an absolute path.
    denied.push(...explicit.map((p) => `Read(/${p}/**)`));
    // Deny rules beat allow rules and the private roots contain cwd and scratch, so a confined
    // reader is allowed Read (which also governs Grep and Glob) only there; a bare Grep or Glob
    // allow would search anywhere. dontAsk refuses every other path.
    const readable = confined ? [...confined.cwd, ...confined.scratch] : [];
    if (confined) readTools = readable.map((p) => `Read(/${p}/**)`);
    args.push(
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--settings",
      JSON.stringify({
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          excludedCommands: [],
          filesystem: {
            allowWrite: [scratch],
            denyWrite: [realpathSync(spec.cwd)],
            ...(denyRead.length ? { denyRead } : {}),
            // Takes precedence over denyRead, so the private roots may contain cwd and scratch.
            ...(confined ? { allowRead: readable } : {}),
            disabled: false,
          },
        },
        disableAllHooks: true,
      }),
    );
  }
  if (spec.privateSession) args.push("--no-session-persistence");
  if (spec.noTools) {
    args.push("--tools", "");
  } else if (spec.mode === "readonly") {
    args.push("--tools", "Read,Grep,Glob,Bash");
    args.push("--allowedTools", ...readTools, "Bash");
    denied.push("Bash(git commit:*)", "Bash(git reset:*)", "Bash(git checkout:*)");
  } else {
    args.push(
      "--allowedTools",
      "Bash",
      "Read",
      "Edit",
      "Write",
      "MultiEdit",
      "NotebookEdit",
      "Glob",
      "Grep",
      "TodoWrite",
      "WebFetch",
      "WebSearch",
    );
  }
  args.push("--disallowedTools", ...denied);
  // Which values a model accepts is the catalog's business (supportedEfforts); the harness only
  // transmits the resolved selection. Non-Anthropic backends behind the CLI cannot receive one.
  if (t.effort !== undefined) {
    if (t.backend)
      throw new Error(
        `Claude CLI cannot set effort for the ${t.provider} backend; use ${t.modelId} without @effort`,
      );
    args.push("--effort", t.effort);
  }
  if (spec.systemAppend) args.push("--append-system-prompt", spec.systemAppend);
  if (spec.jsonSchema) args.push("--json-schema", JSON.stringify(spec.jsonSchema));
  for (const dir of spec.addDirs ?? []) args.push("--add-dir", dir);
  if (spec.resumeSessionId) args.push("--resume", spec.resumeSessionId);
  else args.push("--session-id", sessionId);
  return args;
}

export async function runClaude(spec: AgentSpec, processRunner = runProcess): Promise<AgentResult> {
  const sessionId = crypto.randomUUID();
  const t = spec.target;
  const args = buildClaudeArgs(spec, sessionId);
  appendFileSync(spec.logPath, `# claude ${t.model} ${new Date().toISOString()}\n`);
  const envExtra: Record<string, string> = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  if (t.backend) {
    envExtra.ANTHROPIC_BASE_URL = t.backend.baseUrl;
    envExtra.ANTHROPIC_AUTH_TOKEN = t.backend.authToken;
    envExtra.ANTHROPIC_API_KEY = "";
    // Background/fast tasks inside Claude Code must hit the same backend model.
    envExtra.ANTHROPIC_SMALL_FAST_MODEL = t.model;
    envExtra.ANTHROPIC_DEFAULT_HAIKU_MODEL = t.model;
  }

  const loop = new LoopDetector(spec.maxToolCalls);
  const stuckController = new AbortController();
  let stuckReason: string | null = null;
  const signal = AbortSignal.any([spec.signal, stuckController.signal]);

  // Byte-level inactivity isn't enough: a degraded stream can trickle `thinking_tokens` counters
  // for many minutes without any real progress. Only text, tool calls and tool results count.
  let lastProgress = Date.now();
  const progressWatch = setInterval(
    () => {
      if (stuckReason || Date.now() - lastProgress <= spec.idleTimeoutMs) return;
      stuckReason = `no progress (text or tool activity) for ${Math.round(spec.idleTimeoutMs / 1000)}s`;
      spec.onEvent({ type: "status", text: `stopping agent: ${stuckReason}` });
      stuckController.abort();
    },
    Math.min(spec.idleTimeoutMs, 10_000),
  );

  const parser = new ClaudeStreamParser((ev) => {
    if (ev.type === "text" || ev.type === "tool_call" || ev.type === "tool_result" || ev.type === "init") {
      lastProgress = Date.now();
    }
    // StructuredOutput is how Claude Code returns the final --json-schema answer, not agent work;
    // counting it would trip a zero tool budget exactly when a no-tools call succeeds.
    if (ev.type === "tool_call" && ev.name !== STRUCTURED_OUTPUT_TOOL && !stuckReason) {
      const reason = loop.observe(ev.name, ev.input);
      if (reason) {
        stuckReason = reason;
        spec.onEvent({ type: "status", text: `stopping agent: ${reason}` });
        stuckController.abort();
      }
    }
    spec.onEvent(ev);
  });

  const proc = await processRunner({
    cmd: args,
    cwd: spec.cwd,
    env: agentEnv({
      ...envExtra,
      ...scratchEnv(spec),
      // Sandboxed Bash gets TMPDIR=$CLAUDE_CODE_TMPDIR/claude-<uid>, which is the scratch itself.
      ...(spec.scratchDir ? { CLAUDE_CODE_TMPDIR: scratchParent(spec.scratchDir) } : {}),
    }),
    stdin: spec.prompt,
    signal,
    timeoutMs: spec.timeoutMs,
    idleTimeoutMs: spec.idleTimeoutMs,
    onStdoutLine: (line) => {
      appendFileSync(spec.logPath, `${redactJsonLine(line, spec.redactOutput)}\n`);
      parser.feed(line);
    },
    onStderrLine: (line) => {
      appendFileSync(spec.logPath, `[stderr] ${spec.redactOutput?.(line) ?? line}\n`);
      spec.onEvent({ type: "stderr", text: line });
    },
  }).finally(() => clearInterval(progressWatch));

  const cost = priceOf(parser.usage, t.price);
  const metered = t.billing === "metered";
  const base: Omit<AgentResult, "status" | "error"> = {
    finalText: parser.finalText || parser.lastAssistantText,
    structured: parser.structured,
    sessionId: parser.sessionId ?? (spec.resumeSessionId || sessionId),
    usage: parser.usage,
    numTurns: parser.numTurns,
    costUsd: metered ? cost : 0,
    costEquivUsd: t.billing === "subscription" ? parser.reportedCostUsd || cost : cost,
    quota:
      Object.keys(parser.windows).length || parser.quotaRejectedUntil
        ? { windows: parser.windows, exhaustedUntil: parser.quotaRejectedUntil }
        : null,
  };

  if (proc.cancelled && stuckReason) return { ...base, status: "stuck", error: stuckReason };
  if (proc.cancelled) return { ...base, status: "cancelled", error: "cancelled" };
  if (proc.timedOut) return { ...base, status: "timeout", error: `timed out after ${spec.timeoutMs}ms` };
  if (proc.idleTimedOut)
    return { ...base, status: "stuck", error: `no output for ${Math.round(spec.idleTimeoutMs / 1000)}s` };
  if (parser.quotaRejectedUntil || (parser.isError && parser.quotaText)) {
    return {
      ...base,
      status: "quota",
      error: parser.finalText || "subscription limit reached",
      quota: {
        windows: parser.windows,
        exhaustedUntil: parser.quotaRejectedUntil ?? Date.now() + 60 * 60 * 1000,
      },
    };
  }
  if (!parser.gotResult) {
    const stderr = proc.stderr.trim().slice(-2000);
    const unavailable = /ECONNREFUSED|ENOTFOUND|fetch failed|overloaded|529|502|503|Could not connect/i.test(
      stderr,
    );
    return {
      ...base,
      status: unavailable ? "unavailable" : "error",
      error: stderr || `claude exited with ${proc.exitCode ?? proc.signal} and no result`,
    };
  }
  if (parser.isError) {
    const text = parser.finalText || parser.subtype || "error";
    const unavailable = /overloaded|API Error: (5\d\d|429)|Connection error|ECONNREFUSED/i.test(text);
    return { ...base, status: unavailable ? "unavailable" : "error", error: text.slice(0, 2000) };
  }
  if (spec.jsonSchema && parser.structured === null) {
    const recovered = extractJson(parser.finalText || parser.lastAssistantText);
    if (recovered === null) {
      return { ...base, status: "error", error: "agent did not return the required structured output" };
    }
    return { ...base, structured: recovered, status: "ok", error: null };
  }
  return { ...base, status: "ok", error: null };
}
