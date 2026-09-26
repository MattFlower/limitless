import { spawn } from "node:child_process";

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
}

export interface ProcResult {
  exitCode: number | null;
  signal: string | null;
  cancelled: boolean;
  timedOut: boolean;
  idleTimedOut: boolean;
  stdout: string; // tail, bounded
  stderr: string; // tail, bounded
  durationMs: number;
}

const TAIL_LIMIT = 64_000;

function appendTail(buf: string, chunk: string): string {
  const next = buf + chunk;
  return next.length > TAIL_LIMIT ? next.slice(next.length - TAIL_LIMIT) : next;
}

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
    const terminate = () => {
      killTree("SIGTERM");
      setTimeout(() => killTree("SIGKILL"), 5_000).unref?.();
    };

    const onAbort = () => {
      cancelled = true;
      terminate();
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
      out.flush();
      err.flush();
      for (const t of timers) clearTimeout(t);
      if (idleTimer) clearInterval(idleTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code,
        signal: sig,
        cancelled,
        timedOut,
        idleTimedOut,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });

    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
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
  },
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const res = await runProcess({
    cmd,
    cwd: opts.cwd,
    env: opts.env ?? (process.env as Record<string, string>),
    timeoutMs: opts.timeoutMs ?? 120_000,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  });
  if (res.exitCode !== 0 && !opts.allowFail) {
    throw new Error(
      `Command failed (${res.exitCode ?? res.signal}): ${cmd.join(" ")}\n${res.stderr.trim() || res.stdout.trim()}`.slice(
        0,
        4000,
      ),
    );
  }
  return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
}

/** Environment for agent child processes: inherit PATH etc. but never leak factory secrets. */
export function agentEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(OPENROUTER_|DISCORD_|GITHUB_WEBHOOK_|LIMITLESS_)/.test(k)) continue;
    // Don't let a parent Claude Code session's markers change the child's behavior.
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PLUGIN_DATA") continue;
    if (k.startsWith("ANTHROPIC_")) continue;
    if (k === "GITHUB_TOKEN" || k === "GH_TOKEN") continue;
    env[k] = v;
  }
  // Agents must not act on GitHub themselves (push, merge, comment); the factory does delivery.
  // An invalid token makes `gh` fail fast instead of falling back to the operator's keyring login.
  return { ...env, GH_TOKEN: "limitless-agents-have-no-github-access", ...extra };
}
