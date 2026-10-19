import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import type { DarwinInvocationLeader } from "./processes-darwin.ts";

/** Only the innermost invocation's scratch is an ownership root. */
export const invocationScratch = new AsyncLocalStorage<string>();

export const processScope = new AsyncLocalStorage<{
  signal: AbortSignal;
  killGraceMs: number;
  children: Map<ChildProcess, Promise<void>>;
  scratchDirs: Set<string>;
  terminationError?: ProcessTerminationError;
  runId?: string;
  checkout?: () => string | undefined;
  cleanups?: ProcessCleanupStore;
}>();

export interface ProcessCleanup {
  runId: string | null;
  invocation: string;
  directory: string;
  pid: number;
  birth: string;
  boot: string;
  createdAt: number;
}
export interface ProcessCleanupStore {
  recordProcessCleanup(record: ProcessCleanup): void;
  listProcessCleanups(runId?: string, directory?: string): ProcessCleanup[];
  deleteProcessCleanup(invocation: string, pid: number): void;
  deleteInvocationCleanups(invocation: string): void;
}
export const processCleanupStore = new AsyncLocalStorage<ProcessCleanupStore>();

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
export const linuxAncestryInspection = new AsyncLocalStorage<(pid: number) => string>();
const inspectionPlatform = process.platform;
const darwin = inspectionPlatform === "darwin" ? await import("./processes-darwin.ts") : undefined;

export const processBootInspection = new AsyncLocalStorage<() => string>();

export function bootIdentity(): string {
  const boot =
    processBootInspection.getStore()?.() ??
    darwin?.darwinBootIdentity() ??
    readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!boot) throw new Error("Boot identity is empty");
  return boot;
}

export function recoveryProcessStopped(pid: number): boolean {
  if (darwin) return darwin.darwinProcessStopped(pid);
  try {
    const row = readFileSync(`/proc/${pid}/stat`, "utf8");
    return row.slice(row.lastIndexOf(")") + 2).startsWith("Z");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return true;
    throw error;
  }
}

export const processRecoveryInspection = new AsyncLocalStorage<{
  stopped: typeof recoveryProcessStopped;
  timeoutMs: number;
}>();

export async function recoverProcessCleanups(
  store: ProcessCleanupStore,
  records = store.listProcessCleanups(),
  stopped = processRecoveryInspection.getStore()?.stopped ?? recoveryProcessStopped,
  timeoutMs = processRecoveryInspection.getStore()?.timeoutMs ?? 10_000,
): Promise<void> {
  if (!records.length) return;
  try {
    const boot = bootIdentity();
    const pending: ProcessCleanup[] = [];
    const retire = (row: ProcessCleanup) => store.deleteProcessCleanup(row.invocation, row.pid);
    for (const row of records) {
      if (row.boot !== boot || stopped(row.pid) || (await processBirth(row.pid)) !== row.birth) {
        retire(row);
        continue;
      }
      try {
        process.kill(row.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        retire(row);
        continue;
      }
      pending.push(row);
    }
    const deadline = performance.now() + timeoutMs;
    while (pending.length) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const row = pending[i];
        if (row && stopped(row.pid)) {
          retire(row);
          pending.splice(i, 1);
        }
      }
      if (!pending.length) return;
      if (performance.now() >= deadline)
        throw new Error(`Recorded processes still alive: ${pending.map((row) => row.pid).join(", ")}`);
      await Bun.sleep(10);
    }
  } catch (error) {
    throw new ProcessTerminationError(
      `${ProcessTerminationError.prefix}: ${redactCredentials((error as Error).message)}`,
      { cause: error },
    );
  }
}

/** Undefined when nothing is recorded, so runProcess still registers its child synchronously. */
export function recoverScopedProcesses(): Promise<void> | undefined {
  const scope = processScope.getStore();
  const store = scope?.cleanups ?? processCleanupStore.getStore();
  if (!store || !scope?.runId) return;
  const refuse = (error: unknown) => {
    scope.terminationError =
      error instanceof ProcessTerminationError
        ? error
        : new ProcessTerminationError(
            `${ProcessTerminationError.prefix}: ${redactCredentials((error as Error).message)}`,
            { cause: error },
          );
    return Promise.reject(scope.terminationError);
  };
  let checkout: string | undefined;
  try {
    const path = scope.checkout?.();
    if (path) checkout = realpathSync(path);
  } catch {}
  try {
    const records = store.listProcessCleanups(scope.runId, checkout);
    return records.length ? recoverProcessCleanups(store, records).catch(refuse) : undefined;
  } catch (error) {
    return refuse(error);
  }
}

function callerAncestors(): Set<number> {
  const readStat = linuxAncestryInspection.getStore();
  if (readStat) return linuxCallerAncestors(readStat);
  if (darwin) return darwin.darwinCallerAncestors();
  if (inspectionPlatform !== "linux") throw new Error("Process ancestry inspection is unsupported");
  return linuxCallerAncestors();
}

export function linuxCallerAncestors(
  readStat: (pid: number) => string = (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
): Set<number> {
  const protectedPids = new Set([1, process.pid, process.ppid]);
  let pid = process.ppid;
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    protectedPids.add(pid);
    let row: string;
    try {
      row = readStat(pid);
    } catch (error) {
      throw new Error(`Process ancestry could not be confirmed for ${pid}`, { cause: error });
    }
    const parent = Number(row.slice(row.lastIndexOf(")") + 2).split(/\s+/)[1]);
    if (!Number.isInteger(parent) || parent < 0) throw new Error(`Invalid process parent for ${pid}`);
    pid = parent;
  }
  if (pid > 1) throw new Error(`Process ancestry could not be confirmed for ${pid}: cycle`);
  return protectedPids;
}

async function markedProcesses(
  marker: string,
  group: number,
  started: number,
  directories: readonly string[],
  leader: DarwinInvocationLeader | null,
  protectedPids: ReadonlySet<number>,
  spawnedAt: bigint,
  attempt = 0,
): Promise<number[]> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Process ownership cannot be determined");
  // macOS ps is setuid and cannot launch inside a worker sandbox. Read the same kernel
  // process/environment data directly, without needing elevated privileges.
  const nativeProcesses = async () => {
    if (!darwin) throw new Error("Native process inspection is unavailable");
    try {
      return darwin.markedDarwinProcesses(
        uid,
        marker,
        group,
        started,
        directories,
        leader,
        protectedPids,
        spawnedAt,
      );
    } catch (error) {
      // Unreadable argv uses hidden membership rules. Retry only inspection failures
      // that still prevent proving ownership or confirming a claimed process's identity.
      if (attempt >= 10) throw error;
      await Bun.sleep(10);
      return markedProcesses(
        marker,
        group,
        started,
        directories,
        leader,
        protectedPids,
        spawnedAt,
        attempt + 1,
      );
    }
  };
  if (inspectionPlatform === "darwin" && !processInspection.getStore()) return nativeProcesses();
  const tokens = [`LIMITLESS_INVOCATION=${marker}`, `LIMITLESS_INVOCATION_${marker.replaceAll("-", "_")}=1`];
  const carriesMarker = (entries: string[]) => tokens.some((token) => entries.includes(token));
  if (inspectionPlatform === "linux" && !processInspection.getStore())
    return linuxMarkedProcesses(uid, carriesMarker, protectedPids);
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
  const candidates = environments.filter(
    (row) =>
      row &&
      !protectedPids.has(Number(row[1])) &&
      Number(row[2]) === uid &&
      !row[3]?.startsWith("Z") &&
      carriesMarker((row[4] ?? "").split(/\s+/)),
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
  if (!changed) return pids;
  // A shell may exec between snapshots; never signal it based on mismatched argv.
  if (attempt < 3)
    return markedProcesses(
      marker,
      group,
      started,
      directories,
      leader,
      protectedPids,
      spawnedAt,
      attempt + 1,
    );
  throw new Error("Process arguments changed during inspection");
}

/**
 * Linux reads /proc directly: spawning ps twice for every command made each invocation's
 * shutdown cost tens of milliseconds. Entries are NUL-delimited, so a marker-looking value
 * cannot select an unmarked process. An environment we may not read (a non-dumpable process)
 * is skipped, as ps showed none for it.
 */
function linuxMarkedProcesses(
  uid: number,
  carriesMarker: (entries: string[]) => boolean,
  protectedPids: ReadonlySet<number>,
): number[] {
  const marked: number[] = [];
  // procfs is in memory: synchronous reads take microseconds, while hundreds of awaited ones
  // per scan (twice per command) dominated short commands.
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || protectedPids.has(Number(name))) continue;
    try {
      if (statSync(`/proc/${name}`).uid !== uid) continue;
      const status = readFileSync(`/proc/${name}/stat`, "utf8");
      if (status.slice(status.lastIndexOf(")") + 2).startsWith("Z")) continue;
      const environment = readFileSync(`/proc/${name}/environ`, "utf8");
      if (carriesMarker(environment.split("\0"))) marked.push(Number(name));
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
  return marked;
}

/** Confirm identity and disappearance without relying on marker membership. */
export async function processBirth(pid: number, name?: (value: string) => void): Promise<string | null> {
  if (inspectionPlatform === "darwin") {
    if (!darwin) throw new Error("Native process inspection is unavailable");
    return darwin.darwinProcessBirth(pid, name);
  }
  if (inspectionPlatform === "linux") {
    try {
      const row = await readFile(`/proc/${pid}/stat`, "utf8");
      name?.(row.slice(row.indexOf("(") + 1, row.lastIndexOf(")")));
      const fields = row
        .slice(row.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      if (!fields[19]) throw new Error(`Invalid process birth time for ${pid}`);
      return fields[19];
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    }
  }
  throw new Error("Process birth time inspection is unsupported on this platform");
}

/** Scoped identity and matching birth-clock backend for shutdown tests; the clock defaults to the real one. */
export const processBirthInspection = new AsyncLocalStorage<{
  read: typeof processBirth;
  now?: () => number;
}>();

function birthTime(birth: string): number {
  return birth.split(":").reduce((time, field) => time * 1_000_000 + Number(field), 0);
}

export function linuxBirthClock(uptime: string, hz: bigint): number {
  const [seconds, fraction = ""] = uptime.trim().split(/\s+/)[0]?.split(".") ?? [];
  return Number((BigInt(`${seconds}${fraction}`) * hz) / 10n ** BigInt(fraction.length));
}

function birthClock(): number {
  if (inspectionPlatform === "darwin") return Date.now() * 1000;
  // Linux starttime uses boot-relative USER_HZ ticks. AT_CLKTCK supplies their rate.
  const auxv = readFileSync("/proc/self/auxv");
  for (let offset = 0; offset + 16 <= auxv.length; offset += 16)
    if (auxv.readBigUInt64LE(offset) === 17n)
      return linuxBirthClock(readFileSync("/proc/uptime", "utf8"), auxv.readBigUInt64LE(offset + 8));
  throw new Error("Process birth clock could not be confirmed");
}

async function stopMarkedProcesses(
  marker: string,
  child: ChildProcess,
  graceMs: number,
  invokedAt: number,
  directories: readonly string[],
  leader: DarwinInvocationLeader | null,
  spawnedAt: bigint,
  directory: string,
): Promise<boolean> {
  const group = child.pid;
  if (group === undefined) return false;
  // Whether this shutdown's own SIGKILL reached the direct child while it still ran.
  let childKillSent = false;
  let killedRunningChild = false;
  const protectedPids = callerAncestors();
  const started = performance.now();
  const readBirth = processBirthInspection.getStore()?.read ?? processBirth;
  let bornAt: number | null | undefined;
  const claimed = new Map<number, { birth: string; stopped: boolean; frozen: boolean }>();
  let growing = false;
  let empty = false;
  const scope = processScope.getStore();
  const recorder = scope?.cleanups ?? processCleanupStore.getStore();
  try {
    for (;;) {
      const pids = await markedProcesses(
        marker,
        group,
        invokedAt,
        directories,
        leader,
        protectedPids,
        spawnedAt,
      );
      for (const pid of pids) {
        if (protectedPids.has(pid) || claimed.has(pid)) continue;
        const birth = await readBirth(pid);
        if (birth !== null) {
          if (bornAt === undefined) {
            try {
              bornAt = (processBirthInspection.getStore()?.now ?? birthClock)();
            } catch {
              bornAt = null; // Growth is diagnostic only; ownership still comes from identity checks.
            }
          }
          // Allow one clock quantum: milliseconds for macOS births, USER_HZ ticks for Linux.
          growing ||= bornAt !== null && birthTime(birth) > bornAt + (birth.includes(":") ? 1000 : 1);
          recorder?.recordProcessCleanup({
            runId: scope?.runId ?? null,
            invocation: marker,
            directory,
            pid,
            birth,
            boot: bootIdentity(),
            createdAt: Date.now(),
          });
          claimed.set(pid, { birth, stopped: false, frozen: false });
        }
      }
      // An already-claimed descendant stays ours after reparenting or an environment
      // change. A reused PID is no longer that process and must never be signalled.
      const deadline = performance.now() - started >= graceMs + 10_000;
      const names: string[] = [];
      // Freeze every newly discovered member, then rescan before killing the frozen set.
      const freezing = [...claimed.values()].some((identity) => !identity.stopped);
      for (const [pid, identity] of claimed) {
        let name = "unknown";
        const birth = deadline
          ? await readBirth(pid, (value) => {
              name = value;
            })
          : await readBirth(pid);
        if (birth !== identity.birth) claimed.delete(pid);
        else if (deadline) names.push(`${pid} (${redactCredentials(name)})`);
        else if (!freezing || !identity.stopped) {
          // Decided by our SIGKILL, not the freeze or the start of shutdown: a frozen child can still
          // be killed by something else during the checks in between. A stopped child counts as
          // running; unreaped (exitCode null), its pid can't have been reused. Residual: an external
          // SIGKILL landing between this check and process.kill leaves a zombie that kill accepts,
          // which userspace can't rule out; it only labels a launch already being cancelled as cancelled.
          const signal = freezing ? "SIGSTOP" : "SIGKILL";
          const killingChild = pid === group && signal === "SIGKILL" && !childKillSent;
          const running =
            killingChild && child.exitCode === null && child.signalCode === null && stillRunning(pid);
          if (killingChild) childKillSent = true;
          try {
            process.kill(pid, signal);
            identity.stopped = true;
            identity.frozen = freezing;
            if (running) killedRunningChild = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            identity.frozen = false;
          }
        }
      }
      // Recheck after a disappearing parent: it may have forked between the two ps snapshots.
      const exited = child.exitCode !== null || child.signalCode !== null;
      if (!claimed.size && empty && exited) {
        recorder?.deleteInvocationCleanups(marker);
        return killedRunningChild;
      }
      empty = !claimed.size && exited;
      if (deadline && claimed.size)
        throw new Error(
          `Marked processes still alive: ${names.length}: ${names.join(", ")}; set ${growing ? "kept growing" : bornAt === null ? "growth unknown" : "remained stable"}`,
        );
      if (deadline && !exited) throw new Error(`Child process exit could not be confirmed: ${group}`);
      // Yield even for empty snapshots: spawn/exit notifications and a racing fork
      // must have an opportunity to arrive before we confirm shutdown.
      if (!freezing && (claimed.size || !exited)) await Bun.sleep(10);
      else await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch (error) {
    const failures = [error];
    for (const [pid, identity] of claimed) {
      if (protectedPids.has(pid)) continue;
      let birth: string | null | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          birth = await readBirth(pid);
          break;
        } catch (inspectionError) {
          if (attempt === 0) failures.push(inspectionError);
          if (performance.now() - started >= graceMs + 10_000) break;
        }
      }
      // Only a successfully frozen member cannot exit and have its PID reused while
      // inspection is unavailable. A delivered KILL ends that exception as well.
      if (birth !== identity.birth && !(birth === undefined && identity.frozen)) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch (signalError) {
        failures.push(signalError);
      }
    }
    // Messages only: String(error) would prefix "Error: " to the first failure.
    throw new Error(
      redactCredentials(failures.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")),
    );
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
  /** Strip terminal controls and redact decoded streams before line framing and tail cuts. */
  redactOutput?: boolean;
  /** Raw decoded chunks for internal checks only; never retain or forward them. */
  onRawChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Emit an oversized line's bounded prefix with a truncation suffix, then discard until newline. */
  maxLineLength?: number;
  /** Keep at most this many characters of stdout/stderr (the tail). Default 64k. */
  tailLimit?: number;
}

export interface ProcResult {
  exitCode: number | null;
  signal: string | null;
  cancelled: boolean;
  /** The overall timeout began the shutdown, not an exit or a cancel before it. */
  timedOut: boolean;
  /** The idle timeout began the shutdown, as for timedOut. */
  idleTimedOut: boolean;
  stdout: string; // tail, bounded by tailLimit
  stderr: string; // tail, bounded by tailLimit
  /** True when output exceeded tailLimit and the head was dropped. */
  truncated: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  durationMs: number;
  /**
   * The cancel started this invocation's shutdown, and the shutdown's own SIGKILL reached the child
   * while it still ran (not exited, not a zombie). False whenever that can't be shown.
   */
  cancelKilled?: boolean;
}

const DEFAULT_TAIL = 64_000;
const VT_ESCAPE = "\u001b";
const MAX_PENDING_VT = 4_096;
const INCOMPLETE_VT = new RegExp(
  String.raw`(?:${VT_ESCAPE}(?:\][^${"\u0007\u001b\u009c"}]*(?:${VT_ESCAPE})?|\[[0-?]*[ -/]*|[ -/]*)|${"\u009b"}[0-?]*[ -/]*)$`,
);

function lineSplitter(onLine?: (line: string) => void, limit = Infinity) {
  let pending = "";
  let discarding = false;
  return {
    push(chunk: string) {
      if (!onLine) return;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf("\n", start);
        const end = newline < 0 ? chunk.length : newline;
        if (!discarding) {
          const remaining = limit - pending.length;
          if (end - start > remaining) {
            // Never present a truncated suffix as a complete line (notably the startup marker).
            onLine(`${pending}${chunk.slice(start, start + remaining)} [truncated]`);
            pending = "";
            discarding = true;
          } else pending += chunk.slice(start, end);
        }
        if (newline < 0) break;
        if (pending.length) onLine(pending);
        pending = "";
        discarding = false;
        start = newline + 1;
      }
    },
    flush() {
      if (onLine && pending.length) onLine(pending);
      pending = "";
      discarding = false;
    },
  };
}

/** Whether `pid` is still running (not exited, not a zombie); false when that can't be shown. */
function stillRunning(pid: number): boolean {
  try {
    if (darwin) return darwin.captureDarwinInvocationLeader(pid) !== null;
    if (inspectionPlatform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
    }
  } catch {}
  return false;
}

/**
 * Mark a child and its descendants so shutdown also finds detached, reparented processes.
 */
export function runProcess(opts: ProcOptions): Promise<ProcResult> {
  assertProcessesStopped();
  const recovering = recoverScopedProcesses();
  return recovering ? recovering.then(() => startProcess(opts)) : startProcess(opts);
}

function startProcess(opts: ProcOptions): Promise<ProcResult> {
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
    let directory = opts.cwd;
    try {
      directory = realpathSync(directory);
    } catch {}
    const scratch = invocationScratch.getStore();
    // Capture canonical roots before spawning: cleanup may later remove scratch paths.
    const directories =
      inspectionPlatform === "darwin"
        ? [opts.cwd, ...(scratch ? [scratch] : [])].map((directory) => realpathSync(directory))
        : [];
    const spawnedAt = darwin?.darwinClock() ?? 0n;
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
    let leader: DarwinInvocationLeader | null = null;
    let leaderInspectionError: unknown;
    try {
      if (darwin && child.pid !== undefined) leader = darwin.captureDarwinInvocationLeader(child.pid);
    } catch (error) {
      leaderInspectionError = error;
    }
    let resolveStopped: (() => void) | undefined;
    scope?.children.set(
      child,
      new Promise<void>((resolve) => {
        resolveStopped = resolve;
      }),
    );

    const limit = opts.tailLimit ?? DEFAULT_TAIL;
    const truncated = { stdout: false, stderr: false };
    const appendTail = (buf: string, chunk: string, stream: "stdout" | "stderr"): string => {
      const next = buf + chunk;
      if (next.length <= limit) return next;
      truncated[stream] = true;
      return next.slice(next.length - limit);
    };
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let cancelStarted = false;
    let cancelKilled = false;
    let timedOut = false;
    let idleTimedOut = false;
    let settled = false;
    let lastActivity = Date.now();
    const out = lineSplitter(opts.onStdoutLine, opts.maxLineLength);
    const err = lineSplitter(opts.onStderrLine, opts.maxLineLength);

    let shutdown: Promise<void> | undefined;
    let terminationError: ProcessTerminationError | undefined;
    const terminate = () => {
      shutdown ??= (async () => {
        try {
          if (leaderInspectionError) throw leaderInspectionError;
          if (child.pid !== undefined) {
            const killedRunningChild = await stopMarkedProcesses(
              marker,
              child,
              timedOut || idleTimedOut ? 5_000 : (scope?.killGraceMs ?? 100),
              started,
              directories,
              leader,
              spawnedAt,
              directory,
            );
            cancelKilled = cancelStarted && killedRunningChild;
          }
        } catch (error) {
          let message = (error as Error).message;
          // The live ChildProcess handle proves ownership even when inspection or recording failed.
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          } catch (signalError) {
            message += `; ${(signalError as Error).message}`;
          }
          terminationError = new ProcessTerminationError(
            `${ProcessTerminationError.prefix}: ${redactCredentials(message)}`,
            { cause: error },
          );
          if (scope) scope.terminationError = terminationError;
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

    const timers: ReturnType<typeof setTimeout>[] = [];
    if (opts.timeoutMs) {
      timers.push(
        setTimeout(() => {
          // A timer firing after an exit or a cancel began the shutdown didn't stop the child.
          if (shutdown !== undefined) return;
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
          if (shutdown === undefined && Date.now() - lastActivity > limit) {
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

    const onAbort = () => {
      cancelled = true;
      // An exit or timeout that already began the shutdown, not this cancel, ends the child.
      if (shutdown === undefined) cancelStarted = true;
      void terminate();
    };
    // After finishTimers exists: a pre-aborted signal can fail termination synchronously.
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding(opts.encoding ?? "utf8");
    child.stderr.setEncoding("utf8");
    const streamOutput = (stream: "stdout" | "stderr", lines: ReturnType<typeof lineSplitter>) => {
      let pending = "";
      let terminalPending = "";
      const emit = (text: string) => {
        if (stream === "stdout") stdout = appendTail(stdout, text, stream);
        else stderr = appendTail(stderr, text, stream);
        lines.push(text);
      };
      return {
        push(chunk: string) {
          lastActivity = Date.now();
          opts.onRawChunk?.(chunk, stream);
          if (!opts.redactOutput) return emit(chunk);
          const decoded = terminalPending + chunk;
          // Hold incomplete CSI, OSC and ESC sequences until stripping can see them whole.
          const incomplete = decoded.match(INCOMPLETE_VT);
          // An unterminated sequence (a stray ESC ] in binary output) must not hold the stream forever.
          const held = incomplete?.index !== undefined && decoded.length - incomplete.index <= MAX_PENDING_VT;
          const terminalCut = held ? (incomplete?.index ?? decoded.length) : decoded.length;
          terminalPending = decoded.slice(terminalCut);
          pending += stripVTControlCharacters(decoded.slice(0, terminalCut));
          // Retain possible credential prefixes, including JSON-escaped forms, across chunks.
          const overlap = Math.max(0, (sortedCredentialVariants[0]?.[0].length ?? 0) - 1);
          let cut = Math.max(0, pending.length - overlap);
          // A complete match crossing the cut must also stay raw: replacing a shorter
          // prefix in the carry would destroy a longer credential arriving next.
          let previousCut: number;
          do {
            previousCut = cut;
            for (const [secret] of sortedCredentialVariants) {
              const start = pending.indexOf(secret, Math.max(0, cut - secret.length + 1));
              if (start >= 0 && start < cut && start + secret.length > cut) cut = start;
            }
          } while (cut !== previousCut);
          emit(redactCredentials(pending.slice(0, cut)));
          pending = pending.slice(cut);
        },
        flush() {
          emit(redactCredentials(pending + stripVTControlCharacters(terminalPending)));
          pending = "";
          terminalPending = "";
        },
      };
    };
    const stdoutOutput = streamOutput("stdout", out);
    const stderrOutput = streamOutput("stderr", err);
    child.stdout.on("data", stdoutOutput.push);
    child.stderr.on("data", stderrOutput.push);
    child.stdout.on("end", stdoutOutput.flush);
    child.stderr.on("end", stderrOutput.flush);

    child.on("error", (e) => {
      const text = `\n[spawn error] ${e.message}`;
      if (opts.redactOutput) stderrOutput.push(text);
      else stderr = appendTail(stderr, text, "stderr");
    });

    child.on("close", async (code, sig) => {
      if (settled) return;
      settled = true;
      stdoutOutput.flush();
      stderrOutput.flush();
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
        cancelKilled,
        timedOut,
        idleTimedOut,
        stdout,
        stderr,
        truncated: truncated.stdout || truncated.stderr,
        stdoutTruncated: truncated.stdout,
        stderrTruncated: truncated.stderr,
        durationMs: Date.now() - started,
      });
    });

    // A child that exits before reading its input raises EPIPE on stdin; that must not crash us.
    child.stdin.on("error", (e) => {
      const text = `\n[stdin error] ${e.message}`;
      if (opts.redactOutput) stderrOutput.push(text);
      else stderr = appendTail(stderr, text, "stderr");
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
    redactOutput?: boolean;
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
    redactOutput: opts.redactOutput,
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
const credentialVariants = new Map<string, boolean>();
let sortedCredentialVariants: [string, boolean][] = [];
export const registeredCredentials = (): readonly string[] => [...credentialValues];
export function registerCredential(name: string, value?: string): void {
  credentialNames.add(name);
  for (const secret of [value, process.env[name]])
    if (typeof secret === "string" && secret && !credentialValues.has(secret)) {
      credentialValues.add(secret);
      for (const variant of new Set([secret, JSON.stringify(secret).slice(1, -1)]))
        credentialVariants.set(variant, credentialVariants.get(variant) || secret.length >= 8);
      sortedCredentialVariants = [...credentialVariants].sort(([a], [b]) => b.length - a.length);
    }
}
export function redactCredentials(text: string): string {
  // Substring matches require at least 8 characters to avoid redacting common short strings.
  for (const [secret, substring] of sortedCredentialVariants)
    if (substring || text === secret) text = text.split(secret).join("[redacted]");
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
