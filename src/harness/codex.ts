import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfinementProbe, QuotaWindow } from "../core/types.ts";
import { agentEnv, runProcess } from "../util/proc.ts";
import { readConfinement, scratchEnv, validateDenyRead, validateScratch } from "./scratch.ts";
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

type Json = Record<string, unknown>;

const QUOTA_TEXT = /(usage limit|rate[_ ]limit|hit your limit|limit reached|quota|429)/i;

/** Pure parser for `codex exec --json` JSONL output. */
export class CodexStreamParser {
  threadId: string | null = null;
  lastMessage = "";
  usage: Usage = emptyUsage();
  turns = 0;
  failed: string | null = null;
  completed = false;

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
      case "thread.started":
        this.threadId = String(e.thread_id);
        this.emit({ type: "init", sessionId: this.threadId });
        break;
      case "turn.started":
        this.turns++;
        break;
      case "item.started":
      case "item.completed":
        this.item(e.type, (e.item ?? {}) as Json);
        break;
      case "turn.completed": {
        this.completed = true;
        const u = (e.usage ?? {}) as Json;
        const cached = Number(u.cached_input_tokens ?? 0);
        this.usage = {
          input: this.usage.input + Math.max(0, Number(u.input_tokens ?? 0) - cached),
          output: this.usage.output + Number(u.output_tokens ?? 0),
          cacheRead: this.usage.cacheRead + cached,
          cacheWrite: this.usage.cacheWrite + Number(u.cache_write_input_tokens ?? 0),
        };
        break;
      }
      case "turn.failed":
        this.failed = String(((e.error ?? {}) as Json).message ?? "turn failed");
        this.emit({ type: "status", text: `turn failed: ${this.failed}` });
        break;
      case "error":
        this.failed = String(e.message ?? "error");
        this.emit({ type: "status", text: `error: ${this.failed}` });
        break;
      default:
        break;
    }
  }

  private item(phase: string, item: Json): void {
    const id = String(item.id ?? "");
    switch (item.type) {
      case "agent_message":
        if (phase === "item.completed") {
          this.lastMessage = String(item.text ?? "");
          this.emit({ type: "text", text: this.lastMessage });
        }
        break;
      case "reasoning":
        if (phase === "item.completed" && item.text) this.emit({ type: "thinking", text: String(item.text) });
        break;
      case "command_execution":
        if (phase === "item.started") {
          this.emit({ type: "tool_call", id, name: "shell", input: { command: item.command } });
        } else {
          const output = String(item.aggregated_output ?? "");
          this.emit({
            type: "tool_result",
            id,
            output: output.slice(0, 20_000),
            isError: Number(item.exit_code ?? 0) !== 0,
          });
        }
        break;
      case "file_change":
        if (phase === "item.completed") {
          this.emit({ type: "tool_call", id, name: "apply_patch", input: { changes: item.changes } });
          this.emit({
            type: "tool_result",
            id,
            output: String(item.status ?? ""),
            isError: item.status === "failed",
          });
        }
        break;
      case "mcp_tool_call":
        if (phase === "item.started") {
          this.emit({ type: "tool_call", id, name: `${item.server}.${item.tool}`, input: item.arguments });
        } else {
          this.emit({
            type: "tool_result",
            id,
            output: JSON.stringify(item.result ?? item.error ?? "").slice(0, 20_000),
            isError: item.status === "failed",
          });
        }
        break;
      case "web_search":
        if (phase === "item.started")
          this.emit({ type: "tool_call", id, name: "web_search", input: { query: item.query } });
        break;
      case "error":
        this.emit({ type: "status", text: String(item.message ?? "") });
        break;
      default:
        break;
    }
  }
}

function windowName(minutes: number): string {
  if (minutes <= 300) return "five_hour";
  if (minutes >= 10_000) return "seven_day";
  return `${minutes}m`;
}

/** Codex records account rate limits in its session rollout; read the latest snapshot. */
export function readCodexRateLimits(
  threadId: string,
  codexHome = join(homedir(), ".codex"),
): Record<string, QuotaWindow> | null {
  const root = join(codexHome, "sessions");
  const now = new Date();
  const days = [now, new Date(now.getTime() - 86_400_000)];
  for (const d of days) {
    const dir = join(
      root,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
    if (!existsSync(dir)) continue;
    const file = readdirSync(dir).find((f) => f.includes(threadId) && f.endsWith(".jsonl"));
    if (!file) continue;
    return parseRateLimits(readFileSync(join(dir, file), "utf8"));
  }
  return null;
}

export function parseRateLimits(rollout: string): Record<string, QuotaWindow> | null {
  const lines = rollout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes('"rate_limits"')) continue;
    const m = line.match(/"rate_limits":(\{.*?"plan_type":[^}]*\})/);
    let rl: Json | null = null;
    try {
      rl = m?.[1] ? (JSON.parse(m[1]) as Json) : null;
    } catch {
      rl = null;
    }
    if (!rl) {
      try {
        const obj = JSON.parse(line) as Json;
        rl = findKey(obj, "rate_limits") as Json | null;
      } catch {
        rl = null;
      }
    }
    if (!rl) continue;
    const out: Record<string, QuotaWindow> = {};
    for (const key of ["primary", "secondary"]) {
      const w = rl[key] as Json | null | undefined;
      if (!w) continue;
      out[windowName(Number(w.window_minutes ?? 0))] = {
        utilization: Number(w.used_percent ?? 0) / 100,
        resetsAt: typeof w.resets_at === "number" ? w.resets_at * 1000 : null,
      };
    }
    return out;
  }
  return null;
}

function findKey(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return null;
  if (key in (obj as Json)) return (obj as Json)[key];
  for (const v of Object.values(obj as Json)) {
    const found = findKey(v, key);
    if (found) return found;
  }
  return null;
}

/**
 * Codex filesystem profile entries; the most specific path wins. A confined reader gets no "/"
 * grant: `:minimal` is the platform's system files (enough to run commands), the private roots are
 * denied explicitly (`:minimal` includes /tmp, where other invocations' scratch lives), then cwd
 * and scratch are granted inside them.
 */
function readerFilesystem(spec: AgentSpec, scratch: string): string {
  const entries: [string, string][] = [];
  if (spec.confineReads) {
    const { cwd, scratch: writable, deny } = readConfinement(spec, scratch);
    entries.push([":minimal", "read"]);
    for (const path of deny) entries.push([path, "none"]);
    for (const path of cwd) entries.push([path, "read"]);
    for (const path of writable) entries.push([path, "write"]);
  } else {
    entries.push(["/", "read"]);
    for (const path of validateDenyRead(spec, scratch)) entries.push([path, "none"]);
    entries.push([scratch, "write"]);
  }
  const unique = new Map(entries);
  return [...unique].map(([path, access]) => `${JSON.stringify(path)}="${access}"`).join(",");
}

function readerProfile(spec: AgentSpec, scratch: string): string[] {
  return [
    "-c",
    'default_permissions="limitless-reader"',
    "-c",
    `permissions={limitless-reader={filesystem={${readerFilesystem(spec, scratch)}},network={enabled=false}}}`,
  ];
}

/** A denial names the canary; ENOENT counts because the canary exists outside the sandbox. */
const DENIED = /operation not permitted|permission denied|no such file or directory/i;

/**
 * Older Codex CLIs accept the reader profile but don't enforce it (0.154.0 allowed denied reads),
 * so before the first confined run per CLI path and version, require `codex sandbox` with the same
 * profile to deny a canary outside cwd and scratch. Results, passing or not, last for the process.
 */
export class CodexReaderProbe {
  private readonly results = new Map<string, Promise<ConfinementProbe>>();
  constructor(private readonly which: (cmd: string) => string | null = (cmd) => Bun.which(cmd)) {}

  async verify(spec: AgentSpec, run: typeof runProcess): Promise<ConfinementProbe> {
    const path = this.which("codex");
    if (!path) return { ok: false, path: null, version: null, reason: "codex CLI not found on PATH" };
    let version: string | null = null;
    try {
      const proc = await run({ cmd: [path, "--version"], cwd: spec.cwd, env: agentEnv(), timeoutMs: 30_000 });
      if (proc.exitCode === 0) version = proc.stdout.trim().split("\n")[0]?.trim() || null;
    } catch {
      version = null;
    }
    if (!version) return { ok: false, path, version: null, reason: "codex --version failed" };
    const key = `${path}\0${version}`;
    let result = this.results.get(key);
    if (!result) {
      result = sandboxProbe(spec, path, version, run);
      this.results.set(key, result);
    }
    return result;
  }
}

export const codexReaderProbe = new CodexReaderProbe();

async function sandboxProbe(
  spec: AgentSpec,
  path: string,
  version: string,
  run: typeof runProcess,
): Promise<ConfinementProbe> {
  const fail = (reason: string): ConfinementProbe => ({ ok: false, path, version, reason });
  let dir: string | null = null;
  try {
    const scratch = validateScratch(spec);
    // The temporary directory is a private root: denied to the reader, and outside cwd and scratch.
    dir = mkdtempSync(join(realpathSync(tmpdir()), "limitless-canary-"));
    const canary = join(dir, "canary.txt");
    const token = `canary-${randomUUID()}`;
    writeFileSync(canary, token);
    const { cwd, scratch: own } = readConfinement(spec, scratch);
    if ([...cwd, ...own].some((root) => canary.startsWith(`${root}/`)))
      return fail("no canary location outside the reader's cwd and scratch");
    const proc = await run({
      cmd: [path, "sandbox", ...readerProfile(spec, scratch), "--", "/bin/cat", canary],
      cwd: spec.cwd,
      env: agentEnv(scratchEnv(spec)),
      timeoutMs: 60_000,
    });
    if (proc.exitCode === 0 || proc.stdout.includes(token))
      return fail("sandbox allowed reading a canary outside the reader's cwd");
    if (proc.cancelled || proc.timedOut || proc.idleTimedOut) return fail("sandbox probe did not finish");
    const denied = proc.stderr.split("\n").some((line) => line.includes(canary) && DENIED.test(line));
    if (!denied)
      return fail(
        `sandbox did not report a denied read (exit ${proc.exitCode ?? proc.signal}): ${proc.stderr.trim().slice(-300)}`,
      );
    return { ok: true, path, version, reason: null };
  } catch (e) {
    return fail(`sandbox probe failed to start: ${(e as Error).message}`);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export function buildCodexArgs(spec: AgentSpec): string[] {
  const t = spec.target;
  if (spec.mode === "readonly" && spec.addDirs?.length)
    throw new Error("Reading invocations cannot grant additional directories");
  const args = [
    "codex",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-C",
    spec.cwd,
    "-m",
    t.model,
    "-c",
    'approval_policy="never"',
  ];
  if (t.effort) args.push("-c", `model_reasoning_effort="${t.effort}"`);
  if (spec.privateSession) args.push("--ephemeral");
  if (spec.privateSession || spec.noTools || spec.mode === "readonly") args.push("--ignore-user-config");
  if (spec.noTools) {
    // A read-only sandbox still permits reads, including through MCP tools such as node_repl.
    // Disable MCP discovery as well as built-in file access; retain rollouts unless privateSession
    // was requested so subscription quota telemetry remains available.
    args.push(
      "--strict-config",
      "--disable",
      "shell_tool",
      "--disable",
      "multi_agent",
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "code_mode",
      "--disable",
      "view_image",
      "-c",
      "orchestrator.mcp.enabled=false",
      "-c",
      'web_search="disabled"',
    );
  }
  if (spec.mode === "readonly" && !spec.noTools) {
    // Named filesystem profiles (verified live on codex-cli 0.157.1). Legacy read-only mode
    // ignores sandbox_workspace_write roots, and workspace-write grants cwd implicitly.
    args.push(
      "--strict-config",
      "--ignore-rules",
      ...readerProfile(spec, validateScratch(spec)),
      "-c",
      "orchestrator.mcp.enabled=false",
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "multi_agent",
      "--disable",
      "code_mode",
      "-c",
      'web_search="disabled"',
    );
  } else if (spec.mode === "readonly") {
    args.push("-s", "read-only");
  } else {
    args.push("-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true");
  }
  for (const dir of spec.addDirs ?? []) args.push("--add-dir", dir);
  if (spec.jsonSchema) {
    const schemaPath = `${spec.logPath}.schema.json`;
    writeFileSync(schemaPath, JSON.stringify(spec.jsonSchema));
    args.push("--output-schema", schemaPath);
  }
  if (spec.resumeSessionId) args.push("resume", spec.resumeSessionId, "-");
  else args.push("-");

  return args;
}

export async function runCodex(
  spec: AgentSpec,
  processRunner = runProcess,
  readerProbe = codexReaderProbe,
): Promise<AgentResult> {
  const t = spec.target;
  const args = buildCodexArgs(spec);
  let confinement: ConfinementProbe | undefined;
  if (spec.confineReads && spec.mode === "readonly" && !spec.noTools) {
    confinement = await readerProbe.verify(spec, processRunner);
    if (!confinement.ok || !confinement.path) {
      const cli = `${confinement.path ?? "codex"}${confinement.version ? ` (${confinement.version})` : ""}`;
      return {
        status: "unavailable",
        finalText: "",
        structured: null,
        sessionId: null,
        usage: emptyUsage(),
        numTurns: 0,
        costUsd: 0,
        costEquivUsd: 0,
        error: `Codex read confinement not verified for ${cli}: ${confinement.reason}; confined readers will not run on this CLI`,
        quota: null,
        confinement,
      };
    }
    args[0] = confinement.path;
  }
  const prompt = spec.systemAppend ? `${spec.systemAppend}\n\n---\n\n${spec.prompt}` : spec.prompt;

  const loop = new LoopDetector(spec.maxToolCalls);
  const stuckController = new AbortController();
  let stuckReason: string | null = null;
  const signal = AbortSignal.any([spec.signal, stuckController.signal]);
  const parser = new CodexStreamParser((ev) => {
    if (ev.type === "tool_call" && !stuckReason) {
      const reason = loop.observe(ev.name, ev.input);
      if (reason) {
        stuckReason = reason;
        spec.onEvent({ type: "status", text: `stopping agent: ${reason}` });
        stuckController.abort();
      }
    }
    spec.onEvent(ev);
  });

  appendFileSync(spec.logPath, `# codex ${t.model} ${new Date().toISOString()}\n`);
  const proc = await processRunner({
    cmd: args,
    cwd: spec.cwd,
    env: agentEnv(scratchEnv(spec)),
    stdin: prompt,
    signal,
    timeoutMs: spec.timeoutMs,
    idleTimeoutMs: spec.idleTimeoutMs,
    onStdoutLine: (line) => {
      appendFileSync(spec.logPath, `${redactJsonLine(line, spec.redactOutput)}\n`);
      parser.feed(line);
    },
    onStderrLine: (line) => {
      appendFileSync(spec.logPath, `[stderr] ${spec.redactOutput?.(line) ?? line}\n`);
      if (!line.startsWith("Reading additional input")) spec.onEvent({ type: "stderr", text: line });
    },
  });

  const windows = parser.threadId ? readCodexRateLimits(parser.threadId) : null;
  if (windows && Object.keys(windows).length) {
    spec.onEvent({ type: "rate_limit", status: "observed", windows, resetsAt: null });
  }
  let structured: unknown = null;
  if (spec.jsonSchema && parser.lastMessage) {
    try {
      structured = JSON.parse(parser.lastMessage);
    } catch {
      structured = extractJson(parser.lastMessage);
    }
  }
  const equiv = priceOf(parser.usage, t.price);
  const base: Omit<AgentResult, "status" | "error"> = {
    finalText: parser.lastMessage,
    structured,
    sessionId: parser.threadId,
    usage: parser.usage,
    numTurns: parser.turns,
    costUsd: t.billing === "metered" ? equiv : 0,
    costEquivUsd: equiv,
    quota: windows ? { windows, exhaustedUntil: null } : null,
    ...(confinement ? { confinement } : {}),
  };

  if (proc.cancelled && stuckReason) return { ...base, status: "stuck", error: stuckReason };
  if (proc.cancelled) return { ...base, status: "cancelled", error: "cancelled" };
  if (proc.timedOut) return { ...base, status: "timeout", error: `timed out after ${spec.timeoutMs}ms` };
  if (proc.idleTimedOut)
    return { ...base, status: "stuck", error: `no output for ${Math.round(spec.idleTimeoutMs / 1000)}s` };
  // Success requires a clean exit AND a completed turn; anything else is a failure with a reason.
  let failure: string | null = parser.failed;
  if (!failure && proc.exitCode !== 0) {
    failure = proc.stderr.trim().slice(-2000) || `codex exited with ${proc.exitCode ?? proc.signal}`;
  }
  if (!failure && !parser.completed) failure = "codex exited without completing its turn";
  if (failure) {
    if (QUOTA_TEXT.test(failure)) {
      const exhaustedUntil = Math.max(
        Date.now() + 30 * 60 * 1000,
        ...Object.values(windows ?? {})
          .filter((w) => w.utilization >= 0.99 && w.resetsAt)
          .map((w) => w.resetsAt as number),
      );
      return { ...base, status: "quota", error: failure, quota: { windows: windows ?? {}, exhaustedUntil } };
    }
    const unavailable = /stream disconnected|connection|timed out|503|502|500|overloaded/i.test(failure);
    return { ...base, status: unavailable ? "unavailable" : "error", error: failure };
  }
  if (spec.jsonSchema && structured === null) {
    return { ...base, status: "error", error: "agent did not return valid structured output" };
  }
  return { ...base, status: "ok", error: null };
}
