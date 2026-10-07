import { randomUUID } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfinementFailure, ConfinementProbe, QuotaWindow } from "../core/types.ts";
import { agentEnv, type ProcResult, redactCredentials, runProcess } from "../util/proc.ts";
import {
  createScratch,
  readConfinement,
  scratchEnv,
  scratchParent,
  spellings,
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
  private readonly commands = new Set<string>();

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
        if (!this.commands.has(id)) {
          this.commands.add(id);
          this.emit({ type: "tool_call", id, name: "shell", input: { command: item.command } });
        }
        if (phase !== "item.started") {
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

/** Everything readable; only the write roots writable, `.git` read-only inside them; network as before. */
function editorProfile(spec: AgentSpec): string[] {
  const { write, protect } = writeRoots(spec.cwd, validateScratch(spec));
  const entries = [["/", "read"], ...write.map((p) => [p, "write"]), ...protect.map((p) => [p, "read"])];
  const filesystem = entries.map(([path, access]) => `${JSON.stringify(path)}="${access}"`).join(",");
  return [
    "-c",
    'default_permissions="limitless-editor"',
    "-c",
    `permissions={limitless-editor={filesystem={${filesystem}},network={enabled=true}}}`,
  ];
}

/** ENOENT is never a denial: every canary exists. */
const MISSING = /no such file|\bENOENT\b/i;
/** `codex --version` prints one line such as `codex-cli 0.157.1`. */
const CODEX_VERSION = /^codex(?:-cli)?\s+v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const NOT_ENFORCED: ConfinementFailure = "reader profile not enforced";
const WRITE_NOT_ENFORCED: ConfinementFailure = "write profile not enforced";
const INCONCLUSIVE: ConfinementFailure = "probe inconclusive";
const TIMED_OUT: ConfinementFailure = "probe timed out";
const START_FAILED: ConfinementFailure = "codex sandbox failed to start";

/** The private-root classes every probe must cover. */
export interface CanaryClasses {
  tmp: string;
  tmpdir: string;
  home: string;
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where to put a canary for each distinct root in `deny` (the production profile's private roots):
 * only aliases of one directory are merged. A root holding another (TMPDIR under /tmp) still needs
 * its own canary, since denying the inner one says nothing about sibling scratch directories.
 * /tmp, the system TMPDIR and home are mandatory: home's canary goes in the factory's directory
 * (home itself may be read-only yet full of secrets), and a class with no writable location or
 * missing from `deny` throws, so the probe is inconclusive rather than silently narrower. Other
 * roots we cannot write to (e.g. /Volumes) cannot hold a canary and are skipped.
 */
export function canaryRoots(
  deny: string[],
  classes: CanaryClasses = { tmp: "/tmp", tmpdir: tmpdir(), home: homedir() },
): string[] {
  const home = realpathSync(classes.home);
  const required = new Map<string, string[]>();
  for (const root of [classes.tmp, classes.tmpdir].map((path) => realpathSync(path)))
    required.set(root, [root]);
  required.set(home, [join(home, ".limitless"), home]);
  const roots = [...new Set(deny.filter((path) => existsSync(path)).map((path) => realpathSync(path)))];
  for (const root of required.keys())
    if (!roots.includes(root)) throw new Error("mandatory private root not denied");
  return roots.flatMap((root) => {
    // A symlinked factory directory must not substitute another root for the home control.
    const location = (required.get(root) ?? [root])
      .filter(writable)
      .map((path) => realpathSync(path))
      .find((path) => path === root || path.startsWith(`${root}/`));
    if (location) return [location];
    if (required.has(root)) throw new Error("mandatory private root has no writable canary location");
    return [];
  });
}

/** The permission error ending a `cat: <file>: <error>` diagnostic; only the wording is case-free. */
const PERMISSION_ERROR = /:\s*(?:operation not permitted|permission denied|EACCES|EPERM)\b[^:]*$/i;
/**
 * `stderr` reports a permission denial for exactly `file`: the diagnostic's whole filename field,
 * after an optional `cat:` prefix and quotes, must equal it byte for byte. A field naming another
 * path, even one containing `file`, or a differently cased spelling is not an answer.
 */
function deniedRead(stderr: string, file: string): boolean {
  if (MISSING.test(stderr)) return false;
  return stderr.split("\n").some((line) => {
    const error = PERMISSION_ERROR.exec(line);
    if (!error) return false;
    const field = line
      .slice(0, error.index)
      .trim()
      .replace(/^\S*cat:\s*/, "")
      .replace(/^(['"])(.*)\1$/, "$2");
    return field === file;
  });
}

export interface ReaderProbeOptions {
  /** Where the negative canaries go, given the profile's denied roots; each needs a denied read. */
  canaryRoots?: (deny: string[]) => string[];
  /** Wait after an inconclusive probe before the next attempt. */
  backoffMs?: number;
  now?: () => number;
  /** Resolves after `ms`, or early once `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Removes a probe-owned directory once the probe settles. */
  remove?: (dir: string) => void;
}

interface Flight {
  result: Promise<ConfinementProbe | null>;
  abort: AbortController;
  waiters: number;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

/** `promise`, or undefined as soon as `signal` aborts. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const onAbort = () => resolve(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    });
  });
}

/**
 * Older Codex CLIs accept the reader profile but don't fully enforce it (0.154.0 denies home and TMPDIR
 * yet allows /tmp), so before confined runs on a CLI path and version, `codex sandbox` with
 * the production profile must read a canary in its cwd and be denied one in every private root.
 * Only definitive verdicts are cached; anything else fails closed and is retried after a backoff.
 */
export class CodexReaderProbe {
  private readonly verdicts = new Map<string, ConfinementProbe>();
  private readonly flights = new Map<string, Flight>();
  private readonly retryAt = new Map<string, number>();
  private readonly roots: (deny: string[]) => string[];
  private readonly backoffMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly remove: (dir: string) => void;

  constructor(
    private readonly which: (cmd: string) => string | null = (cmd) => Bun.which(cmd),
    options: ReaderProbeOptions = {},
  ) {
    this.roots = options.canaryRoots ?? canaryRoots;
    this.backoffMs = options.backoffMs ?? 250;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
    this.remove = options.remove ?? ((dir) => rmSync(dir, { recursive: true, force: true }));
  }

  /**
   * `deny` is the caller's denyRead as the profile will deny it, resolved once: the probe checks it
   * too, so a verdict only covers those effective paths, and a symlink retargeted between lookups
   * would otherwise pair one verdict with another profile.
   */
  async verify(
    spec: AgentSpec,
    run: typeof runProcess,
    deny: string[] = spellings(spec.denyRead ?? []),
  ): Promise<ConfinementProbe> {
    const path = this.which("codex");
    if (!path) return { ok: false, path: null, version: null, reason: START_FAILED, exitCode: null };
    const lookup = await codexVersion(path, spec, run);
    const unverified = { ok: false, path, version: lookup.version, reason: INCONCLUSIVE, exitCode: null };
    if (spec.signal.aborted) return unverified;
    if (!lookup.version) return { ...unverified, reason: lookup.reason, exitCode: lookup.exitCode };
    // The list is encoded separately so a denied path can never stand in for the CLI path or version.
    const key = `${spec.mode}\0${path}\0${lookup.version}\0${JSON.stringify([...deny].sort())}`;
    for (;;) {
      const verdict = this.verdicts.get(key);
      if (verdict) return verdict;
      let flight = this.flights.get(key);
      const wait = (this.retryAt.get(key) ?? 0) - this.now();
      if (!flight && wait > 0) {
        await this.sleep(wait, spec.signal);
        if (spec.signal.aborted) return unverified;
        continue;
      }
      flight ??= this.start(key, { ...spec, denyRead: deny }, path, lookup.version, run);
      flight.waiters++;
      const result = await unlessAborted(flight.result, spec.signal);
      flight.waiters--;
      if (spec.signal.aborted) {
        // Stop a probe nobody waits for; a cancelled probe says nothing about the CLI.
        if (flight.waiters === 0 && this.flights.get(key) === flight) {
          this.flights.delete(key);
          flight.abort.abort();
        }
        return unverified;
      }
      if (result) return result;
    }
  }

  private start(key: string, spec: AgentSpec, path: string, version: string, run: typeof runProcess): Flight {
    const abort = new AbortController();
    const owned: string[] = [];
    const unsettled = (): ConfinementProbe | null =>
      abort.signal.aborted ? null : { ok: false, path, version, reason: INCONCLUSIVE, exitCode: null };
    const result = sandboxProbe(spec, path, version, run, abort.signal, this.roots, owned)
      .catch(unsettled)
      .then((settled) => {
        // Leftover canaries mean the probe didn't finish cleanly: fail closed and retry later.
        const cleaned = owned.filter((dir) => !this.cleanup(dir)).length === 0;
        if (this.flights.get(key) === flight) this.flights.delete(key);
        if (!settled) return null;
        const probe = cleaned ? settled : { ...settled, ok: false, reason: INCONCLUSIVE, exitCode: null };
        if (probe.ok || probe.reason === NOT_ENFORCED || probe.reason === WRITE_NOT_ENFORCED)
          this.verdicts.set(key, probe);
        else this.retryAt.set(key, this.now() + this.backoffMs);
        return probe;
      });
    const flight: Flight = { result, abort, waiters: 0 };
    this.flights.set(key, flight);
    return flight;
  }

  /** Best-effort; logs only the error code, never the path. */
  private cleanup(dir: string): boolean {
    try {
      this.remove(dir);
      return true;
    } catch (error) {
      console.warn(
        `[codex] probe cleanup failed: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`,
      );
      return false;
    }
  }
}

export const codexReaderProbe = new CodexReaderProbe();

/** Only a clean, completed lookup with recognisable output identifies the CLI. */
async function codexVersion(
  path: string,
  spec: AgentSpec,
  run: typeof runProcess,
): Promise<{ version: string | null; reason: ConfinementFailure; exitCode: number | null }> {
  try {
    const proc = await run({
      cmd: [path, "--version"],
      cwd: spec.cwd,
      env: agentEnv(),
      timeoutMs: 30_000,
      signal: spec.signal,
    });
    if (proc.timedOut || proc.idleTimedOut)
      return { version: null, reason: TIMED_OUT, exitCode: proc.exitCode };
    const line = proc.stdout.trim().split("\n")[0]?.trim() ?? "";
    const clean = proc.exitCode === 0 && !proc.signal && !proc.cancelled && CODEX_VERSION.test(line);
    return { version: clean ? line : null, reason: INCONCLUSIVE, exitCode: proc.exitCode };
  } catch {
    return { version: null, reason: START_FAILED, exitCode: null };
  }
}

/** Null when `signal` aborted it. Never keeps the CLI's output: it can echo config and tokens. */
async function sandboxProbe(
  template: AgentSpec,
  path: string,
  version: string,
  run: typeof runProcess,
  signal: AbortSignal,
  roots: (deny: string[]) => string[],
  /** Directories the probe created; the caller removes them once it settles. */
  owned: string[],
): Promise<ConfinementProbe | null> {
  const result = (reason: ConfinementFailure | null, exitCode: number | null): ConfinementProbe | null =>
    signal.aborted ? null : { ok: reason === null, path, version, reason, exitCode };
  const temp = (root: string, prefix: string) => {
    const dir = mkdtempSync(join(root, prefix));
    owned.push(dir);
    return realpathSync(dir);
  };
  const canary = (dir: string) => {
    const file = { path: join(dir, "canary.txt"), token: `canary-${randomUUID()}` };
    writeFileSync(file.path, file.token);
    return file;
  };
  // An editor must write its cwd and scratch, and be denied every private root and its own `.git`.
  const editing = template.mode === "edit";
  let spec: AgentSpec;
  let profile: string[];
  let codexHome: string;
  let positives: { path: string; token: string }[];
  let negatives: { path: string; token: string }[];
  try {
    const tmp = realpathSync(tmpdir());
    // The probe owns its cwd and scratch, so no caller's files move; the scratch comes from a real
    // reader's createScratch and the caller's denyRead applies, so it checks the profile that runs.
    const probeCwd = temp(tmp, "limitless-probe-");
    const scratchDir = createScratch(probeCwd);
    owned.push(scratchParent(scratchDir));
    spec = editing
      ? { ...template, cwd: probeCwd, scratchDir, denyRead: [], confineReads: false }
      : { ...template, cwd: probeCwd, scratchDir, confineReads: true };
    const scratch = validateScratch(spec);
    // An empty CODEX_HOME: `codex sandbox` has no --ignore-user-config, and exec ignores it.
    codexHome = temp(tmp, "limitless-probe-home-");
    const { cwd, scratch: writable, deny } = readConfinement(spec, scratch);
    negatives = roots(deny).map((root) => canary(temp(root, "limitless-canary-")));
    const granted = (file: string) => [...cwd, ...writable].some((root) => file.startsWith(`${root}/`));
    if (!negatives.length || negatives.some((file) => granted(file.path))) return result(INCONCLUSIVE, null);
    if (editing) {
      const common = temp(tmp, "limitless-probe-common-");
      const admin = join(common, "worktrees", "probe");
      mkdirSync(admin, { recursive: true });
      writeFileSync(join(admin, "commondir"), "../..");
      writeFileSync(join(admin, "gitdir"), join(probeCwd, ".git"));
      const pointer = `gitdir: ${admin}\n`;
      writeFileSync(join(probeCwd, ".git"), pointer);
      negatives.push(canary(common), canary(admin), { path: join(probeCwd, ".git"), token: pointer });
      positives = [probeCwd, scratch].map((dir) => ({
        path: join(dir, `written-${randomUUID()}`),
        token: "",
      }));
      profile = editorProfile(spec);
    } else {
      positives = [canary(spec.cwd)];
      profile = readerProfile(spec, scratch);
    }
  } catch {
    return result(INCONCLUSIVE, null);
  }
  const attempt = async (file: string, token: string) =>
    run({
      cmd: [
        path,
        "sandbox",
        ...profile,
        "--",
        ...(editing ? ["/bin/sh", "-c", 'printf %s "$1" > "$2"', "sh", token, file] : ["/bin/cat", file]),
      ],
      cwd: spec.cwd,
      env: agentEnv({ ...scratchEnv(spec), CODEX_HOME: codexHome }),
      timeoutMs: 60_000,
      signal,
    });
  let last: number | null = null;
  for (const file of [...negatives, ...positives]) {
    let proc: ProcResult;
    const token = `written-${randomUUID()}`;
    try {
      proc = await attempt(file.path, token);
    } catch {
      return result(START_FAILED, null);
    }
    if (signal.aborted || proc.cancelled) return result(INCONCLUSIVE, proc.exitCode);
    // Only a completed exit is an answer, and only an answer may be cached.
    if (proc.timedOut || proc.idleTimedOut) return result(TIMED_OUT, proc.exitCode);
    if (proc.signal || proc.exitCode === null) return result(INCONCLUSIVE, proc.exitCode);
    last = proc.exitCode;
    if (editing) {
      // The file itself is the evidence, never the CLI's report: any change to a canary is a write.
      const content = existsSync(file.path) ? readFileSync(file.path, "utf8") : null;
      if (positives.includes(file)) {
        if (proc.exitCode !== 0 || content !== token) return result(INCONCLUSIVE, proc.exitCode);
      } else if (content !== file.token) return result(WRITE_NOT_ENFORCED, proc.exitCode);
      else if (proc.exitCode === 0) return result(INCONCLUSIVE, proc.exitCode);
      continue;
    }
    if (positives.includes(file)) {
      const ok = proc.exitCode === 0 && proc.stdout.trim() === file.token;
      return result(ok ? null : INCONCLUSIVE, proc.exitCode);
    }
    if (proc.stdout.includes(file.token)) return result(NOT_ENFORCED, proc.exitCode);
    if (proc.exitCode === 0 || !deniedRead(proc.stderr, file.path))
      return result(INCONCLUSIVE, proc.exitCode);
  }
  return editing ? result(null, last) : result(INCONCLUSIVE, null);
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
  if (spec.fast && t.provider === "codex") args.push("-c", 'service_tier="fast"');
  if (t.effort) args.push("-c", `model_reasoning_effort="${t.effort}"`);
  if (spec.privateSession) args.push("--ephemeral");
  // User config could add MCP servers, rules or permission profiles that widen what tools may write.
  args.push("--ignore-user-config");
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
  if (!spec.noTools) {
    // Named filesystem profiles (verified live on codex-cli 0.157.1 and 0.160.0). Legacy read-only
    // mode ignores sandbox_workspace_write roots, and workspace-write grants cwd and TMPDIR implicitly.
    args.push(
      "--strict-config",
      "--ignore-rules",
      ...(spec.mode === "readonly" ? readerProfile(spec, validateScratch(spec)) : editorProfile(spec)),
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
    );
    if (spec.mode === "readonly") args.push("-c", 'web_search="disabled"');
  } else args.push("-s", "read-only");
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
  spec = protectCredentials(spec);
  const t = spec.target;
  const editing = spec.mode === "edit" && !spec.noTools;
  const confined = editing || (spec.confineReads && spec.mode === "readonly" && !spec.noTools);
  // One snapshot of the denied paths keys the verdict, drives the probe and builds the exec
  // profile; resolving it again is a no-op unless a symlink was retargeted meanwhile.
  const deny = confined && !editing ? spellings(spec.denyRead ?? []) : [];
  const args = buildCodexArgs(confined ? { ...spec, denyRead: deny } : spec);
  let confinement: ConfinementProbe | undefined;
  if (confined) {
    confinement = await readerProbe.verify(spec, processRunner, deny);
    if (spec.signal.aborted)
      return {
        status: "cancelled",
        finalText: "",
        structured: null,
        sessionId: null,
        usage: emptyUsage(),
        numTurns: 0,
        costUsd: 0,
        costEquivUsd: 0,
        error: "cancelled",
        quota: null,
      };
    // The profile would now deny paths the verdict never covered: fail closed, nothing is cached.
    const moved = spellings(deny).length !== deny.length;
    if (moved) confinement = { ...confinement, ok: false, reason: INCONCLUSIVE, exitCode: null };
    if (!confinement.ok || !confinement.path) {
      const exit = confinement.exitCode === null ? "" : `, exit ${confinement.exitCode}`;
      const cli = `${confinement.path ?? "codex"}${confinement.version ? ` (${confinement.version})` : ""}`;
      const detail = moved
        ? "denied paths changed during the probe"
        : `${confinement.reason}${exit}; confined ${editing ? "editors" : "readers"} will not run on this CLI`;
      return {
        status: "unavailable",
        finalText: "",
        structured: null,
        sessionId: null,
        usage: emptyUsage(),
        numTurns: 0,
        costUsd: 0,
        costEquivUsd: 0,
        error: `Codex ${editing ? "write" : "read"} confinement not verified for ${cli}: ${detail}`,
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

  appendFileSync(spec.logPath, redactCredentials(`# codex ${t.model} ${new Date().toISOString()}\n`));
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
      parser.feed(redactJsonLine(line, redactCredentials));
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
    failure =
      redactCredentials(proc.stderr).trim().slice(-2000) ||
      `codex exited with ${proc.exitCode ?? proc.signal}`;
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
