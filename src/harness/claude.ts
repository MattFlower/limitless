import { appendFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { QuotaWindow } from "../core/types.ts";
import { agentEnv, idleWatchdog, type ProcResult, redactCredentials, runProcess } from "../util/proc.ts";
import { BROWSER_TOOLS, type BrowserMcpServer, browserMcp } from "./browser-mcp.ts";
import { homeReadPolicy } from "./read-policy.ts";
import { ConfinementError, runSandboxed } from "./sandbox.ts";
import {
  agentShellEnv,
  invocationCommands,
  readConfinement,
  scratchParent,
  validateDenyRead,
  validateScratch,
  writeRoots,
} from "./scratch.ts";
import { signalWarnings } from "./signals.ts";
import {
  type AgentEvent,
  type AgentResult,
  type AgentSpec,
  emptyUsage,
  extractJson,
  LoopDetector,
  priceOf,
  protectCredentials,
  redactJsonLine,
  type Usage,
} from "./types.ts";

export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

const QUOTA_TEXT =
  /(hit your (session|weekly|opus|sonnet|fable|usage) limit|usage limit reached|rate limit.*reset|out of (extra )?usage)/i;

type Json = Record<string, unknown>;

const subscriptionToken = (spec: AgentSpec) =>
  spec.target.billing === "subscription" && !spec.target.backend ? spec.claudeSubscriptionToken : undefined;

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
  fastModeState: string | null = null;
  fastModeDisabledReason: string | null = null;
  windows: Record<string, QuotaWindow> = {};
  quotaRejectedUntil: number | null = null;
  quotaText = false;
  authenticationFailed = false;

  private readonly emit: (e: AgentEvent) => void;
  constructor(emit: (e: AgentEvent) => void) {
    this.emit = signalWarnings(emit);
  }

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
        if (e.error === "authentication_failed") this.authenticationFailed = true;
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
        this.fastModeState = typeof e.fast_mode_state === "string" ? e.fast_mode_state : null;
        this.fastModeDisabledReason =
          typeof e.fast_mode_disabled_reason === "string" ? e.fast_mode_disabled_reason : null;
        this.subtype = (e.subtype as string) ?? null;
        this.isError = Boolean(e.is_error);
        this.authenticationFailed = this.isError && (this.authenticationFailed || e.api_error_status === 401);
        this.sessionId = (e.session_id as string) ?? this.sessionId;
        this.numTurns = Number(e.num_turns ?? 0);
        this.reportedCostUsd = Number(e.total_cost_usd ?? 0);
        const u = (e.usage ?? {}) as Json;
        const creation = (u.cache_creation ?? {}) as Json;
        this.usage = {
          input: Number(u.input_tokens ?? 0),
          output: Number(u.output_tokens ?? 0),
          cacheRead: Number(u.cache_read_input_tokens ?? 0),
          cacheWrite: Number(u.cache_creation_input_tokens ?? 0),
          ...(creation.ephemeral_1h_input_tokens === undefined
            ? {}
            : { cacheWrite1h: Number(creation.ephemeral_1h_input_tokens) }),
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

export const claudeMcpConfig = (browser?: BrowserMcpServer) =>
  JSON.stringify({ mcpServers: browser ? { playwright: { type: "stdio", ...browser } } : {} });

export function buildClaudeArgs(spec: AgentSpec, sessionId: string, keyFile?: string): string[] {
  const browser = browserMcp(spec, "claude");
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
    // Tools must not inherit hooks, sandbox exclusions, permissions or MCP servers from project
    // settings: arrays such as excludedCommands and permission rules merge across sources.
    "--setting-sources",
    subscriptionToken(spec) || spec.mode === "readonly" || !spec.noTools ? "" : "project,local",
    "--permission-mode",
    "dontAsk",
  ];
  // The CLI reads backend credentials itself, so they never enter the agent's or its tools' environment.
  const fastSettings = {
    ...(spec.fast && t.provider === "claude" ? { fastMode: true } : {}),
    ...(keyFile ? { apiKeyHelper: `cat ${JSON.stringify(keyFile)}` } : {}),
  };
  const denied = ["Bash(git push:*)", "Bash(gh pr merge:*)", "Bash(gh repo delete:*)", "Bash(rm -rf /*)"];
  denied.push("Bash(pkill:*)", "Bash(killall:*)", "Bash(kill -9 -1:*)");
  let readTools = ["Read", "Grep", "Glob"];
  let editTools: string[] = [];
  if (!spec.noTools) {
    const scratch = validateScratch(spec);
    scratchParent(scratch);
    let filesystem: Record<string, unknown>;
    if (spec.mode === "edit") {
      // The outer Seatbelt profile covers Bash and native tools. These permission rules also
      // refuse native edits outside the roots before they reach the filesystem.
      const { write, protect, denyRead = [], commands } = writeRoots(spec.cwd, scratch, false, spec.denyRead);
      // Bash reads its own wrappers through the outer profile; native tools need none of them.
      denied.push(
        ...[...denyRead, ...(commands?.root ?? [])].flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]),
      );
      editTools = write.map((p) => `Edit(/${p}/**)`);
      const denyWrite = [...protect, ...(commands?.root ?? [])];
      denied.push(...denyWrite.flatMap((p) => [`Edit(/${p})`, `Edit(/${p}/**)`]));
      filesystem = { allowWrite: write, denyWrite, denyRead, disabled: false };
    } else {
      const explicit = validateDenyRead(spec, scratch);
      const confined = spec.confineReads ? readConfinement(spec, scratch) : null;
      const commands = invocationCommands(scratch, spec.cwd);
      const credentials = homeReadPolicy([spec.cwd, scratch], false, explicit).denyRead;
      const denyRead = [...(confined?.deny ?? explicit), ...credentials, ...commands.root];
      // The sandbox confines Bash; Read rules also cover Grep and Glob. "//" marks an absolute path.
      denied.push(...[...credentials, ...commands.root].flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]));
      // Deny rules beat allow rules and the private roots contain cwd and scratch, so a confined
      // reader is allowed Read (which also governs Grep and Glob) only there; a bare Grep or Glob
      // allow would search anywhere. dontAsk refuses every other path.
      const readable = confined ? [...confined.cwd, ...confined.scratch] : [];
      if (confined) readTools = readable.map((p) => `Read(/${p}/**)`);
      filesystem = {
        allowWrite: [scratch],
        denyWrite: [realpathSync(spec.cwd), ...commands.root],
        ...(denyRead.length ? { denyRead } : {}),
        // Takes precedence over denyRead, so the private roots may contain cwd and scratch. Only an
        // unconfined reader receives command wrappers, so only it may read its own.
        ...(confined ? { allowRead: readable } : commands.own.length ? { allowRead: commands.own } : {}),
        disabled: false,
      };
    }
    args.push(
      "--strict-mcp-config",
      "--mcp-config",
      claudeMcpConfig(browser),
      "--settings",
      JSON.stringify({
        ...fastSettings,
        permissions: { deny: denied },
        sandbox: {
          // macOS cannot nest Seatbelt: editors already run entirely inside runSandboxed.
          enabled: spec.mode !== "edit",
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: spec.mode === "edit",
          excludedCommands: [],
          ...(spec.mode === "readonly" && spec.allowLocalBinding
            ? { network: { allowLocalBinding: true } }
            : {}),
          filesystem,
        },
        disableAllHooks: true,
      }),
    );
  }
  if (Object.keys(fastSettings).length && spec.noTools) args.push("--settings", JSON.stringify(fastSettings));
  // The outer profile keeps CLAUDE_CONFIG_DIR read-only, so a confined editor cannot store a
  // transcript: it runs ephemerally rather than failing on persistence, and cannot be resumed.
  const ephemeral = spec.mode === "edit" && !spec.noTools;
  if (ephemeral && spec.resumeSessionId)
    throw new Error("Confined Claude editors do not persist sessions and cannot resume one");
  if (spec.privateSession || ephemeral) args.push("--no-session-persistence");
  if (spec.noTools) {
    args.push("--tools", "");
  } else if (spec.mode === "readonly") {
    args.push("--tools", "Read,Grep,Glob,Bash");
    args.push(
      "--allowedTools",
      ...readTools,
      "Bash",
      ...(browser ? BROWSER_TOOLS.map((name) => `mcp__playwright__${name}`) : []),
    );
    denied.push("Bash(git commit:*)", "Bash(git reset:*)", "Bash(git checkout:*)");
  } else {
    args.push(
      "--allowedTools",
      "Bash",
      "Read",
      ...editTools,
      "Glob",
      "Grep",
      "TodoWrite",
      "WebFetch",
      "WebSearch",
    );
  }
  if (browser) {
    denied.push(
      "mcp__playwright__browser_run_code_unsafe",
      "mcp__playwright__browser_network_request",
      "mcp__playwright__browser_route",
      "mcp__playwright__browser_resume",
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

function claudeEditorRoots(spec: AgentSpec, scratch: string) {
  const roots = writeRoots(spec.cwd, scratch, false, spec.denyRead);
  if (subscriptionToken(spec)) return roots;
  // Without locally configured subscription auth, the CLI still needs its Keychain login.
  // Native tools keep the full list; overlapping credential denies win here.
  const keychains = new Set(roots.keychainOnlyReadPaths);
  return { ...roots, denyRead: roots.denyRead?.filter((path) => !keychains.has(path)) };
}

export async function runClaude(
  spec: AgentSpec,
  processRunner = runProcess,
  progressTimer = { set: setInterval, clear: clearInterval },
): Promise<AgentResult> {
  spec = protectCredentials(spec);
  const sessionId = crypto.randomUUID();
  const t = spec.target;
  const token = subscriptionToken(spec);
  const keyFile = t.backend && `${tmpdir()}/limitless-${sessionId}.key`;
  const args = buildClaudeArgs(spec, sessionId, keyFile);
  const editing = spec.mode === "edit" && !spec.noTools;
  const roots = editing ? claudeEditorRoots(spec, validateScratch(spec)) : null;
  const shellEnv = agentShellEnv(spec);
  // Preserve HOME and CLAUDE_CONFIG_DIR: they identify the persistent login/Keychain service.
  // Copying OAuth state to scratch loses refreshed tokens when scratch is removed.
  // runSandboxed returns a launch cancelled before startup, and rethrows the abort that stopped its
  // probe, only because our cancel stopped it. When the no-progress watchdog aborted first, not the
  // caller, the sandbox hung: keep that a confinement error.
  const runner: typeof runProcess = async (opts) => {
    if (!roots) return processRunner(opts);
    let started = false;
    const hung = () =>
      new ConfinementError(`Write confinement payload did not start: ${stuckReason ?? "stopped"}`);
    let result: ProcResult;
    try {
      result = await runSandboxed(
        {
          ...opts,
          onStarted: () => {
            started = true;
          },
        },
        roots,
        processRunner,
      );
    } catch (error) {
      if (firstAbort !== "caller" && opts.signal?.aborted && error === opts.signal.reason) throw hung();
      throw error;
    }
    if (!started && result.cancelled && firstAbort !== "caller") throw hung();
    return result;
  };
  appendFileSync(spec.logPath, redactCredentials(`# claude ${t.model} ${new Date().toISOString()}\n`));
  const envExtra: Record<string, string> = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  // Agent tool read isolation for this key file is tracked in #335.
  if (keyFile) writeFileSync(keyFile, t.backend?.authToken ?? "", { flag: "wx", mode: 0o600 });
  if (t.backend) {
    envExtra.ANTHROPIC_BASE_URL = t.backend.baseUrl;
    envExtra.ANTHROPIC_API_KEY = "";
    // Background/fast tasks inside Claude Code must hit the same backend model.
    envExtra.ANTHROPIC_SMALL_FAST_MODEL = t.model;
    envExtra.ANTHROPIC_DEFAULT_HAIKU_MODEL = t.model;
  }

  const loop = new LoopDetector(spec.maxToolCalls);
  const stuckController = new AbortController();
  let stuckReason: string | null = null;
  const signal = AbortSignal.any([spec.signal, stuckController.signal]);
  // The first abort decides who stopped the agent; the other may follow during cleanup.
  let firstAbort: "caller" | "watchdog" | null = spec.signal.aborted ? "caller" : null;
  const callerAborted = () => {
    firstAbort ??= "caller";
  };
  const watchdogAborted = () => {
    firstAbort ??= "watchdog";
  };
  spec.signal.addEventListener("abort", callerAborted, { once: true });
  stuckController.signal.addEventListener("abort", watchdogAborted, { once: true });

  // Byte-level inactivity isn't enough: a degraded stream can trickle `thinking_tokens` counters
  // for many minutes without any real progress. Only text, tool calls and tool results count.
  const progress = idleWatchdog(spec.idleTimeoutMs, spec.idleNow);
  const progressWatch = progressTimer.set(
    () => {
      if (stuckReason || !progress.expired()) return;
      stuckReason = `no progress (text or tool activity) for ${Math.round(spec.idleTimeoutMs / 1000)}s`;
      // Abort before reporting, so the watchdog's stop is recorded ahead of anything the event triggers.
      stuckController.abort();
      spec.onEvent({ type: "status", text: `stopping agent: ${stuckReason}` });
    },
    Math.min(spec.idleTimeoutMs, 10_000),
  );

  const parser = new ClaudeStreamParser((ev) => {
    if (ev.type === "text" || ev.type === "tool_call" || ev.type === "tool_result" || ev.type === "init") {
      progress.reset();
    }
    // StructuredOutput is how Claude Code returns the final --json-schema answer, not agent work;
    // counting it would trip a zero tool budget exactly when a no-tools call succeeds.
    if (!stuckReason) {
      const reason =
        ev.type === "tool_call" && ev.name !== STRUCTURED_OUTPUT_TOOL
          ? loop.observe(ev.name, ev.input, ev.id)
          : ev.type === "tool_result"
            ? loop.observeResult(ev.id, ev.output)
            : null;
      if (reason) {
        stuckReason = reason;
        stuckController.abort();
        spec.onEvent({ type: "status", text: `stopping agent: ${reason}` });
      }
    }
    spec.onEvent(ev);
  });

  const proc = await runner({
    cmd: args,
    cwd: spec.cwd,
    env: {
      ...agentEnv({
        ...envExtra,
        ...shellEnv,
        // Sandboxed Bash gets TMPDIR=$CLAUDE_CODE_TMPDIR/claude-<uid>, which is the scratch itself.
        // A confined editor runs without the CLI sandbox, so the CLI's own files there (the Bash
        // cwd record) must land in the scratch directly: its parent is outside the boundary.
        ...(spec.scratchDir
          ? { CLAUDE_CODE_TMPDIR: editing ? spec.scratchDir : scratchParent(spec.scratchDir) }
          : {}),
      }),
      // This credential belongs only to subscription Claude. Generic children still strip it,
      // including explicit overrides; add it only after agentEnv has removed API credentials.
      ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
    },
    stdin: spec.prompt,
    signal,
    timeoutMs: spec.timeoutMs,
    idleTimeoutMs: spec.idleTimeoutMs,
    idleNow: spec.idleNow,
    onStdoutLine: (line) => {
      appendFileSync(spec.logPath, `${redactJsonLine(line, spec.redactOutput)}\n`);
      parser.feed(redactJsonLine(line, redactCredentials));
    },
    onStderrLine: (line) => {
      appendFileSync(spec.logPath, `[stderr] ${spec.redactOutput?.(line) ?? line}\n`);
      spec.onEvent({ type: "stderr", text: line });
    },
  }).finally(() => {
    progressTimer.clear(progressWatch);
    spec.signal.removeEventListener("abort", callerAborted);
    if (keyFile) rmSync(keyFile, { force: true });
  });

  const cost = priceOf(parser.usage, t.price);
  const metered = t.billing === "metered";
  const base: Omit<AgentResult, "status" | "error"> = {
    fastModeState: parser.fastModeState,
    fastModeDisabledReason: parser.fastModeDisabledReason,
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

  if (proc.cancelled && firstAbort === "caller") return { ...base, status: "cancelled", error: "cancelled" };
  if (stuckReason) return { ...base, status: "stuck", error: stuckReason };
  if (proc.cancelled) return { ...base, status: "cancelled", error: "cancelled" };
  const repeatReason = loop.finish();
  if (repeatReason) return { ...base, status: "stuck", error: repeatReason };
  if (proc.timedOut) return { ...base, status: "timeout", error: `timed out after ${spec.timeoutMs}ms` };
  if (proc.idleTimedOut)
    return { ...base, status: "stuck", error: `no output for ${Math.round(spec.idleTimeoutMs / 1000)}s` };
  if (parser.authenticationFailed)
    return {
      ...base,
      status: "unavailable",
      failureClass: "authentication",
      error: parser.finalText || parser.lastAssistantText || "Claude authentication failed",
    };
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
    const stderr = redactCredentials(proc.stderr).trim().slice(-2000);
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
