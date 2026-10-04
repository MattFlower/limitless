import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";

export const processScope = new AsyncLocalStorage<{
  signal: AbortSignal;
  killGraceMs: number;
  children: Map<ChildProcess, Promise<void>>;
  scratchDirs: Set<string>;
}>();

export interface ProcOptions {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
  /** Hard wall-clock limit. */
  timeoutMs?: number;
  /** Kill when neither stdout nor stderr produced output for this long. */
  idleTimeoutMs?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Keep at most this many characters of stdout/stderr (the tail). Default 64k. */
  tailLimit?: number;
}

export interface ProcResult {
  exitCode: number | null;
  signal: string | null;
  cancelled: boolean;
  timedOut: boolean;
  idleTimedOut: boolean;
  stdout: string; // tail, bounded by tailLimit
  stderr: string; // tail, bounded by tailLimit
  /** True when output exceeded tailLimit and the head was dropped. */
  truncated: boolean;
  durationMs: number;
}

const DEFAULT_TAIL = 64_000;

function lineSplitter(onLine?: (line: string) => void) {
  let pending = "";
  return {
    push(chunk: string) {
      if (!onLine) return;
      pending += chunk;
      let idx = pending.indexOf("\n");
      while (idx >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (line.length) onLine(line);
        idx = pending.indexOf("\n");
      }
    },
    flush() {
      if (onLine && pending.length) onLine(pending);
      pending = "";
    },
  };
}

/**
 * Run a child process in its own process group so cancellation kills the whole tree
 * (agent CLIs spawn shells, MCP servers and test runners).
 */
export function runProcess(opts: ProcOptions): Promise<ProcResult> {
  const scope = processScope.getStore();
  if (scope)
    opts = { ...opts, signal: AbortSignal.any([scope.signal, ...(opts.signal ? [opts.signal] : [])]) };
  if (scope) opts.signal?.throwIfAborted();
  const started = Date.now();
  return new Promise((resolve) => {
    const [bin, ...args] = opts.cmd;
    if (!bin) throw new Error("runProcess: empty command");
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    scope?.children.set(
      child,
      new Promise<void>((resolve) =>
        child.once("close", () => {
          scope.children.delete(child);
          resolve();
        }),
      ),
    );

    const limit = opts.tailLimit ?? DEFAULT_TAIL;
    let truncated = false;
    const appendTail = (buf: string, chunk: string): string => {
      const next = buf + chunk;
      if (next.length <= limit) return next;
      truncated = true;
      return next.slice(next.length - limit);
    };
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let timedOut = false;
    let idleTimedOut = false;
    let settled = false;
    let lastActivity = Date.now();
    const out = lineSplitter(opts.onStdoutLine);
    const err = lineSplitter(opts.onStderrLine);

    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (graceMs = 5_000) => {
      if (killTimer) return;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), graceMs);
      killTimer.unref?.();
    };

    const onAbort = () => {
      cancelled = true;
      if (scope) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      terminate(scope?.killGraceMs);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    if (opts.timeoutMs) {
      timers.push(
        setTimeout(() => {
          timedOut = true;
          terminate();
        }, opts.timeoutMs),
      );
    }
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    if (opts.idleTimeoutMs) {
      const limit = opts.idleTimeoutMs;
      idleTimer = setInterval(
        () => {
          if (Date.now() - lastActivity > limit) {
            idleTimedOut = true;
            terminate();
          }
        },
        Math.min(limit, 5_000),
      );
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      lastActivity = Date.now();
      stdout = appendTail(stdout, chunk);
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      lastActivity = Date.now();
      stderr = appendTail(stderr, chunk);
      err.push(chunk);
    });

    child.on("error", (e) => {
      stderr = appendTail(stderr, `\n[spawn error] ${e.message}`);
    });

    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      out.flush();
      err.flush();
      for (const t of timers) clearTimeout(t);
      if (idleTimer) clearInterval(idleTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      // No descendants may keep writing after callers begin scratch/worktree cleanup.
      killTree("SIGKILL");
      resolve({
        exitCode: code,
        signal: sig,
        cancelled,
        timedOut,
        idleTimedOut,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - started,
      });
    });

    // A child that exits before reading its input raises EPIPE on stdin; that must not crash us.
    child.stdin.on("error", (e) => {
      stderr = appendTail(stderr, `\n[stdin error] ${e.message}`);
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

const SH_OUTPUT_LIMIT = 50_000_000;

/** A failed `sh` command, with its exit status kept structured for callers that classify failures. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(message);
  }
}

/** Convenience wrapper for short commands (git, gh). Throws on non-zero exit. */
export async function sh(
  cmd: string[],
  opts: {
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    allowFail?: boolean;
    stdin?: string;
    signal?: AbortSignal;
  },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  opts.signal?.throwIfAborted();
  const res = await runProcess({
    cmd,
    cwd: opts.cwd,
    signal: opts.signal,
    env: opts.env ?? (process.env as Record<string, string>),
    timeoutMs: opts.timeoutMs ?? 120_000,
    // Callers parse this output (diffs, JSON); never silently hand them a truncated tail.
    tailLimit: SH_OUTPUT_LIMIT,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  });
  // Cancellation must stop command sequences even when a nonzero exit is allowed.
  opts.signal?.throwIfAborted();
  if (res.truncated) {
    throw new Error(`Output of \`${cmd.join(" ")}\` exceeded ${SH_OUTPUT_LIMIT} characters`);
  }
  if (res.exitCode !== 0 && !opts.allowFail) {
    throw new CommandError(
      `Command failed (${res.exitCode ?? res.signal}): ${cmd.join(" ")}\n${res.stderr.trim() || res.stdout.trim()}`.slice(
        0,
        4000,
      ),
      res.exitCode,
      res.stdout,
      res.stderr,
      res.timedOut,
    );
  }
  return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
}

// Retain registrations across config reloads while older invocations may still be running.
const credentialNames = new Set<string>();
const credentialValues = new Set<string>();
export function registerCredential(name: string, value?: string): void {
  credentialNames.add(name);
  for (const secret of [value, process.env[name]])
    if (typeof secret === "string" && secret) credentialValues.add(secret);
}
export function redactCredentials(text: string): string {
  // Substring matches require at least 8 characters to avoid redacting common short strings.
  for (const secret of [...credentialValues].sort((a, b) => b.length - a.length))
    if (secret.length >= 8 || text === secret) text = text.split(secret).join("[redacted]");
  return text;
}
export const redactCredentialData = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === "string" ? redactCredentials(v) : v)),
    (_key, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [redactCredentials(k), x]))
        : v,
  );
const isCredential = ([k, v]: [string, string]) =>
  credentialNames.has(k) ||
  credentialValues.has(v) ||
  [...credentialValues].some((secret) => secret.length >= 8 && v.includes(secret));

/** Environment for agent child processes: inherit PATH etc. but never leak factory secrets. */
export function agentEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || isCredential([k, v])) continue;
    if (/^(OPENROUTER_|DISCORD_|GITHUB_WEBHOOK_|LIMITLESS_)/.test(k)) continue;
    // Don't let a parent Claude Code session's markers change the child's behavior.
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PLUGIN_DATA") continue;
    if (k.startsWith("ANTHROPIC_")) continue;
    if (k === "GITHUB_TOKEN" || k === "GH_TOKEN") continue;
    env[k] = v;
  }
  delete env.SSH_AUTH_SOCK;
  return {
    ...env,
    // Agents (and the repo code they write, which gates execute) must not act on GitHub or push:
    // the factory does delivery. An invalid token makes `gh` fail fast instead of using the
    // operator's keyring login; git over ssh fails; https credential helpers are disabled.
    GH_TOKEN: "limitless-agents-have-no-github-access",
    GIT_SSH_COMMAND: "sh -c 'echo \"limitless: agents cannot use git over ssh\" >&2; exit 1'",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    // Overrides cannot reintroduce a configured credential under its own or any other name.
    ...Object.fromEntries(Object.entries(extra).filter((entry) => !isCredential(entry))),
  };
}
