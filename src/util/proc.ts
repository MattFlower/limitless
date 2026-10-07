import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export const processScope = new AsyncLocalStorage<{
  signal: AbortSignal;
  killGraceMs: number;
  children: Map<ChildProcess, Promise<void>>;
  scratchDirs: Set<string>;
  terminationError?: ProcessTerminationError;
}>();

export class ProcessTerminationError extends Error {
  static readonly prefix = "Invocation termination could not be confirmed";
}

/** A failed shutdown blocks subsequent commands, including worktree cleanup. */
export function assertProcessesStopped(): void {
  const error = processScope.getStore()?.terminationError;
  if (error) throw error;
}

/** Scoped inspection backend for deterministic shutdown tests. */
export const processInspection = new AsyncLocalStorage<
  (withEnvironment: boolean, marker: string, pids?: number[]) => Promise<string>
>();
const inspectionPlatform = process.platform;

async function markedProcesses(
  marker: string,
  group: number,
  known: Set<number>,
  started: number,
  attempt = 0,
): Promise<number[]> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Process ownership cannot be determined");
  // macOS ps is setuid and cannot launch inside a worker sandbox. Read the same kernel
  // process/environment data directly, without needing elevated privileges.
  const nativeProcesses = async () => {
    const { markedDarwinProcesses } = await import("./processes-darwin.ts");
    try {
      return markedDarwinProcesses(uid, marker, group, known, started);
    } catch (error) {
      // Exec races and short-lived hidden orphans can make membership temporarily
      // unprovable. Keep cleanup blocked while allowing a bounded window to settle.
      if (attempt >= 200) throw error;
      await Bun.sleep(10);
      return markedProcesses(marker, group, known, started, attempt + 1);
    }
  };
  if (inspectionPlatform === "darwin" && !processInspection.getStore()) return nativeProcesses();
  const env = { ...process.env };
  delete env.LIMITLESS_INVOCATION;
  env.LIMITLESS_PROCESS_SCAN = marker;
  let inspectionPid: number | undefined;
  const inspect = (withEnvironment: boolean, pids?: number[]) => {
    const injected = processInspection.getStore();
    if (injected) return injected(withEnvironment, marker, pids);
    return new Promise<string>((resolve, reject) => {
      const scanner = execFile(
        "/bin/ps",
        [
          ...(withEnvironment ? [inspectionPlatform === "darwin" ? "-E" : "eww"] : []),
          "-ww",
          ...(pids ? ["-p", pids.join(",")] : ["-U", String(uid)]),
          "-o",
          "pid=,uid=,stat=,command=",
        ],
        { env, timeout: 2000, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout) =>
          error && !(pids && error.code === 1 && !stdout.trim())
            ? reject(new Error("Process environment inspection failed", { cause: error }))
            : resolve(stdout),
      );
      inspectionPid = scanner.pid;
    });
  };
  const rows = (output: string) =>
    output
      .trim()
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/));
  const output = await inspect(true);
  const environments = rows(output);
  if (
    !environments.some(
      (row) =>
        row &&
        // macOS ps is setuid; its effective uid need not be ours. Verify the scanner
        // we launched, while the candidate filtering below always requires our uid.
        (inspectionPid === undefined ? Number(row[2]) === uid : Number(row[1]) === inspectionPid) &&
        row[4]?.split(/\s+/).includes(`LIMITLESS_PROCESS_SCAN=${marker}`),
    )
  )
    throw new Error("Process environment inspection could not be confirmed");
  const tokens = [`LIMITLESS_INVOCATION=${marker}`, `LIMITLESS_INVOCATION_${marker.replaceAll("-", "_")}=1`];
  const carriesMarker = (entries: string[]) => tokens.some((token) => entries.includes(token));
  const candidates = environments.filter(
    (row) =>
      row && Number(row[2]) === uid && !row[3]?.startsWith("Z") && carriesMarker((row[4] ?? "").split(/\s+/)),
  );
  if (!candidates.length) return [];
  const commands = rows(
    await inspect(
      false,
      candidates.map((row) => Number(row?.[1])),
    ),
  );
  let changed = false;
  const pids = candidates.flatMap((row) => {
    const command = commands.find((cmd) => cmd?.[1] === row?.[1] && Number(cmd?.[2]) === uid);
    if (!command || command[3]?.startsWith("Z")) return [];
    const args = command[4] ?? "";
    const full = row?.[4] ?? "";
    // ps appends the environment to argv. A marker appearing only in argv is unmarked.
    if (!args || !full.startsWith(args)) {
      changed = true;
      return [];
    }
    return carriesMarker(full.slice(args.length).split(/\s+/)) ? [Number(row?.[1])] : [];
  });
  if (!changed) {
    // ps flattens environment entries with spaces. Verify their NUL-delimited
    // boundaries so a marker-looking value cannot select an unmarked process.
    if (inspectionPlatform === "linux" && !processInspection.getStore()) {
      const marked: number[] = [];
      for (const pid of pids) {
        try {
          if ((await stat(`/proc/${pid}`)).uid !== uid) continue;
          const environment = await readFile(`/proc/${pid}/environ`, "utf8");
          if (carriesMarker(environment.split("\0"))) marked.push(pid);
        } catch (error) {
          if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
      return marked;
    }
    return pids;
  }
  // A shell may exec between snapshots; never signal it based on mismatched argv.
  if (attempt < 3) return markedProcesses(marker, group, known, started, attempt + 1);
  throw new Error("Process arguments changed during inspection");
}

async function stopMarkedProcesses(
  marker: string,
  child: ChildProcess,
  graceMs: number,
  invokedAt: number,
): Promise<void> {
  const group = child.pid;
  if (group === undefined) return;
  const started = performance.now();
  const termed = new Set<number>();
  const known = new Set([group]);
  let empty = false;
  for (;;) {
    const pids = await markedProcesses(marker, group, known, invokedAt);
    // Recheck after a disappearing parent: it may have forked between the two ps snapshots.
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (!pids.length && empty && exited) return;
    empty = !pids.length && exited;
    if (performance.now() - started >= graceMs + 10_000)
      throw new Error(
        `Marked processes still alive: ${[...new Set([...pids, ...(!exited ? [group] : [])])].join(", ")}`,
      );
    for (const pid of pids) {
      known.add(pid);
      const signal = termed.has(pid) && performance.now() - started >= graceMs ? "SIGKILL" : "SIGTERM";
      if (signal === "SIGTERM" && termed.has(pid)) continue;
      try {
        process.kill(pid, signal);
        termed.add(pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    // Yield even for empty snapshots: spawn/exit notifications and a racing fork
    // must have an opportunity to arrive before we confirm shutdown.
    if (pids.length || !exited) await Bun.sleep(10);
    else await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export interface ProcOptions {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  encoding?: BufferEncoding;
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
 * Mark a child and its descendants so shutdown also finds detached, reparented processes.
 */
export function runProcess(opts: ProcOptions): Promise<ProcResult> {
  assertProcessesStopped();
  const scope = processScope.getStore();
  if (scope)
    opts = { ...opts, signal: AbortSignal.any([scope.signal, ...(opts.signal ? [opts.signal] : [])]) };
  if (scope) opts.signal?.throwIfAborted();
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const [bin, ...args] = opts.cmd;
    if (!bin) throw new Error("runProcess: empty command");
    const marker = randomUUID();
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      // Retain ancestor tags when candidate code itself invokes runProcess (e.g. its test suite).
      env: {
        ...opts.env,
        LIMITLESS_INVOCATION: marker,
        [`LIMITLESS_INVOCATION_${marker.replaceAll("-", "_")}`]: "1",
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let resolveStopped: (() => void) | undefined;
    scope?.children.set(
      child,
      new Promise<void>((resolve) => {
        resolveStopped = resolve;
      }),
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

    let shutdown: Promise<void> | undefined;
    let terminationError: ProcessTerminationError | undefined;
    const terminate = () => {
      shutdown ??= (async () => {
        try {
          if (child.pid !== undefined)
            await stopMarkedProcesses(
              marker,
              child,
              timedOut || idleTimedOut ? 5_000 : (scope?.killGraceMs ?? 100),
              started,
            );
        } catch (error) {
          terminationError = new ProcessTerminationError(
            `${ProcessTerminationError.prefix}: ${(error as Error).message}`,
            { cause: error },
          );
          if (scope) scope.terminationError = terminationError;
          // The directly spawned child is ours even if process discovery is unavailable.
          child.kill("SIGKILL");
          settled = true;
          finishTimers();
          reject(terminationError);
        } finally {
          child.stdin.destroy();
          // Confirmed shutdown closes inherited pipes naturally. Let their buffered output
          // drain before close; only a failed shutdown must bypass still-open descendants.
          if (terminationError) {
            child.stdout.destroy();
            child.stderr.destroy();
          }
        }
      })();
      return shutdown;
    };
    child.once("exit", terminate);

    const onAbort = () => {
      cancelled = true;
      void terminate();
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

    const finishTimers = () => {
      for (const t of timers) clearTimeout(t);
      if (idleTimer) clearInterval(idleTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.setEncoding(opts.encoding ?? "utf8");
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

    child.on("close", async (code, sig) => {
      if (settled) return;
      settled = true;
      out.flush();
      err.flush();
      finishTimers();
      await terminate();
      if (terminationError) {
        reject(terminationError);
        return;
      }
      scope?.children.delete(child);
      resolveStopped?.();
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
    encoding?: BufferEncoding;
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
    encoding: opts.encoding,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  });
  // Cancellation must stop command sequences even when a nonzero exit is allowed.
  opts.signal?.throwIfAborted();
  if (res.truncated) {
    throw new Error(`Output of \`${cmd.join(" ")}\` exceeded ${SH_OUTPUT_LIMIT} characters`);
  }
  if ((res.exitCode !== 0 || res.timedOut) && !opts.allowFail) {
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
    if (
      /^(OPENROUTER_|DISCORD_|GITHUB_WEBHOOK_|LIMITLESS_)/.test(k) &&
      !(/^LIMITLESS_INVOCATION_[0-9a-f_]{36}$/.test(k) && v === "1")
    )
      continue;
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
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "diff.autoRefreshIndex",
    GIT_CONFIG_VALUE_1: "false",
    // Overrides cannot reintroduce a configured credential under its own or any other name.
    ...Object.fromEntries(Object.entries(extra).filter((entry) => !isCredential(entry))),
    GIT_OPTIONAL_LOCKS: "0",
  };
}
