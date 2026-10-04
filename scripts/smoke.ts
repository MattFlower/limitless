#!/usr/bin/env bun
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { QuotaWindow } from "../src/core/types.ts";
import { runClaude } from "../src/harness/claude.ts";
import { runCodex } from "../src/harness/codex.ts";
import { type DecisionAnswer, runDecisions } from "../src/harness/decisions.ts";
import { scratchParent, withScratch as usingScratch } from "../src/harness/scratch.ts";
import type { AgentEvent, AgentResult, Harness, ModelTarget } from "../src/harness/types.ts";
import { MODELS, type ModelDef, PROVIDERS, type ProviderDef } from "../src/router/catalog.ts";
import { resolveTarget } from "../src/router/targets.ts";
import { processScope, sh } from "../src/util/proc.ts";

/**
 * Why a failure may be retried: the provider was briefly unavailable. Anything else (a disclosed
 * token, a tool call, a forbidden write, a wrong answer) is an assertion failure and is final. "model"
 * means the model never ran the verify probe at all and left the worktree untouched.
 */
export type Transient = "timeout" | "provider" | "health" | "model";
export type CheckResult = { status: "pass" | "fail" | "skip"; reason?: string; transient?: Transient };
/**
 * `timeoutMs` bounds each attempt; it defaults to DEFAULT_CHECK_TIMEOUT_MS. `signal` aborts when that
 * bound expires, and the attempt must then settle so its assertions still count.
 */
export type SmokeCheck = {
  name: string;
  timeoutMs?: number;
  run: (signal: AbortSignal) => Promise<CheckResult>;
};
export type CheckRow = CheckResult & {
  name: string;
  durationMs: number;
  retried?: boolean;
  retriedAfter?: string;
};
/** Time source for the smoke runner, so tests can drive budgets and timeouts deterministically. */
export type Clock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};
export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout> | undefined),
};
export type RunOptions = {
  /** Overall time for every attempt; an attempt is cut to the time left and a retry needs its full timeout. */
  budgetMs?: number;
  retryDelayMs?: number;
  /** How long a timed-out attempt may take to settle after its signal aborts. */
  stopGraceMs?: number;
  /** Timers for attempt timeouts and the stop grace; also the default `now` and retry delay. */
  clock?: Clock;
  onStart?: (check: SmokeCheck) => void;
  onRow?: (row: CheckRow) => void;
};

const KILL_GRACE_MS = 1_000;
const CLOSE_WAIT_MS = KILL_GRACE_MS + 500;
function registerTemp(dir: string): string {
  processScope.getStore()?.scratchDirs.add(dir);
  return dir;
}
function withScratch<T>(cwd: string, run: (dir: string) => Promise<T>): Promise<T> {
  return usingScratch(cwd, (dir) => {
    registerTemp(scratchParent(dir));
    return run(dir);
  });
}
async function closeChildren(children: Map<ChildProcess, Promise<void>>): Promise<boolean> {
  const closed = await within(
    Promise.all(children.values()).then(() => true),
    CLOSE_WAIT_MS,
    realClock,
  );
  if (!closed) {
    // Escaped descendants can retain pipes after the process group has been killed.
    for (const child of children.keys()) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
  }
  return closed === true;
}

const RETRY_DELAY_MS = 5_000;
const STOP_GRACE_MS = 10_000;
const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
/** The deploy gate kills smoke after 900 s; leave room for startup and reporting. */
export const SMOKE_BUDGET_MS = 870_000;

const PROVIDER_ERROR =
  /(?:HTTP|status|code)\s*5\d\d|\b50[0-4]\b|rate.?limit|\b429\b|overloaded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|stream disconnected|connection (?:refused|reset|closed|error|failed)|network error/i;
const MALFORMED = /malformed/i;

/** Classify a failure message explicitly; an unrecognized one is never retried. */
export function transientReason(reason: string): Transient | undefined {
  if (/health probe/i.test(reason)) return "health";
  if (/\btimed out\b|\btimeout\b|no output for \d+s/i.test(reason)) return "timeout";
  if (PROVIDER_ERROR.test(reason)) return "provider";
  return undefined;
}

function fail(reason: string, transient?: Transient): CheckResult {
  return { status: "fail", reason, ...(transient ? { transient } : {}) };
}

async function within<T>(promise: Promise<T>, ms: number, clock: Clock): Promise<T | undefined> {
  let timer: unknown;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = clock.setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clock.clearTimeout(timer);
  }
}

/**
 * A timed-out attempt is aborted and awaited: a disclosure or forbidden write it reports while
 * stopping is final, and one that never stops is not retried, so no later attempt can mask it.
 */
async function attempt(
  check: SmokeCheck,
  timeoutMs: number,
  stopGraceMs: number,
  clock: Clock,
  scope: NonNullable<ReturnType<typeof processScope.getStore>>,
): Promise<CheckResult> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, scope.signal]);
  const finish = async (result: CheckResult) => {
    controller.abort();
    const closed = await closeChildren(scope.children);
    if (closed) return result;
    // A final failure keeps its own reason (never retried); a passing check that left children open fails.
    const stuck = " (attempt did not stop, not retried)";
    if (result.status !== "fail" || !result.reason) return fail(`timeout ${timeoutMs}ms${stuck}`);
    return fail(result.reason.endsWith(stuck) ? result.reason : `${result.reason}${stuck}`);
  };
  // Keep post-timeout inspection commands cancellable only by shutdown, not by the attempt.
  const run = processScope
    .run(scope, async () => check.run(signal))
    .catch((error: unknown) => fail(String(error), transientReason(String(error))));
  const result = await within(run, timeoutMs, clock);
  if (result) return finish(result);
  controller.abort();
  const settled = await within(run, stopGraceMs, clock);
  if (!settled) return finish(fail(`timeout ${timeoutMs}ms (attempt did not stop, not retried)`));
  if (settled.status === "fail" && !settled.transient) return finish(settled);
  return finish(fail(`timeout ${timeoutMs}ms`, "timeout"));
}

/**
 * Live providers fail transiently (Codex has rejected models intermittently), so a check that
 * failed for an availability reason gets one retry if it still fits the budget. A backend whose
 * health probe fails on both attempts is skipped.
 */
export async function runChecks(
  checks: SmokeCheck[],
  now?: () => number,
  delay?: (ms: number) => Promise<void>,
  options: RunOptions = {},
): Promise<CheckRow[]> {
  const shutdown = new AbortController();
  const children = new Map<ChildProcess, Promise<void>>();
  const scope = {
    signal: shutdown.signal,
    killGraceMs: KILL_GRACE_MS,
    children,
    scratchDirs: new Set<string>(),
  };
  const exit = (code: number) => {
    for (const child of children.keys()) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    for (const dir of scope.scratchDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    process.exit(code);
  };
  let interrupted = false;
  const interrupt = async (code: number) => {
    if (interrupted) return exit(code);
    interrupted = true;
    shutdown.abort();
    await closeChildren(children);
    exit(code);
  };
  const onInt = () => void interrupt(130);
  const onTerm = () => void interrupt(143);
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    return await processScope.run(scope, () => checksWithinBudget(checks, now, delay, options));
  } finally {
    if (!interrupted) {
      shutdown.abort();
      await closeChildren(children);
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    }
  }
}

async function checksWithinBudget(
  checks: SmokeCheck[],
  now?: () => number,
  delay?: (ms: number) => Promise<void>,
  options: RunOptions = {},
): Promise<CheckRow[]> {
  const {
    budgetMs = Number.POSITIVE_INFINITY,
    retryDelayMs = RETRY_DELAY_MS,
    stopGraceMs = STOP_GRACE_MS,
    clock = realClock,
  } = options;
  const time = now ?? clock.now;
  const wait = delay ?? clock.sleep;
  const begin = time();
  // Time an attempt may run so that it, and stopping it, still ends inside the budget.
  const left = () => budgetMs - (time() - begin) - stopGraceMs;
  const rows: CheckRow[] = [];
  const scope = processScope.getStore();
  if (!scope) throw new Error("missing smoke process scope");
  for (const check of checks) {
    if (scope.signal.aborted) break;
    const timeoutMs = check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    options.onStart?.(check);
    let start = time();
    let result =
      left() > 0
        ? await attempt(check, Math.min(timeoutMs, Math.floor(left())), stopGraceMs, clock, scope)
        : fail("not run: no time left in the smoke budget");
    let retried = false;
    const first = result.reason;
    const health = result.transient === "health";
    const retry = result.status === "fail" && result.transient !== undefined;
    if (health && left() < retryDelayMs + timeoutMs) {
      // A backend that is down is skipped however little of the budget is left.
      result = { status: "skip", reason: first ?? "health probe failed" };
    } else if (retry && left() < retryDelayMs + timeoutMs) {
      result = { ...result, reason: `${first ?? "failed"} (no time left to retry)` };
    } else if (retry) {
      await wait(retryDelayMs);
      if (scope.signal.aborted) break;
      retried = true;
      start = time();
      result = await attempt(check, timeoutMs, stopGraceMs, clock, scope);
      // A backend still down on the retry is skipped as before; a retry that skips after any
      // other failure must not hide it.
      if (health && (result.transient === "health" || result.status === "skip"))
        result = { status: "skip", reason: result.reason };
      else if (result.status === "skip")
        result = {
          status: "fail",
          reason: `${first ?? "failed"} (retry skipped: ${result.reason ?? "no reason"})`,
        };
      else if (result.status === "fail" && first && first !== result.reason)
        result = { ...result, reason: `${result.reason ?? "failed"} (first attempt: ${first})` };
    }
    const row: CheckRow = {
      name: check.name,
      ...result,
      durationMs: Math.round(time() - start),
      ...(retried
        ? { retried, retriedAfter: (first ?? "failed").replace(/\s+/g, " ").trim().slice(0, 200) }
        : {}),
    };
    rows.push(row);
    options.onRow?.(row);
  }
  return rows;
}

export function formatHeader(width: number): string {
  return [
    `${"Check".padEnd(width)}  Status  Time     Detail`,
    `${"-".repeat(width)}  ------  -------  ------`,
  ].join("\n");
}

export function formatRow(row: CheckRow, width: number): string {
  const label =
    row.retried && row.status !== "skip"
      ? `${row.status.toUpperCase()} (retried after: ${row.retriedAfter})`
      : row.status.toUpperCase();
  const detail = (row.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  return `${row.name.padEnd(width)}  ${label.padEnd(6)}  ${`${row.durationMs}ms`.padStart(7)}  ${detail}`;
}

function nameWidth(names: { name: string }[]): number {
  return Math.max(5, ...names.map((row) => row.name.length));
}

export function formatReport(rows: CheckRow[]): string {
  const width = nameWidth(rows);
  return [formatHeader(width), ...rows.map((row) => formatRow(row, width))].join("\n");
}

/** Print each row as it finishes, so a run killed by the deploy timeout still shows its progress. */
export async function reportChecks(
  checks: SmokeCheck[],
  print = console.log,
  options: RunOptions = {},
): Promise<number> {
  const width = nameWidth(checks);
  print(formatHeader(width));
  const rows = await runChecks(checks, undefined, undefined, {
    budgetMs: SMOKE_BUDGET_MS,
    ...options,
    onStart: (check) => print(`${check.name.padEnd(width)}  RUN`),
    onRow: (row) => print(formatRow(row, width)),
  });
  return exitCode(rows);
}

export function exitCode(rows: CheckRow[]): number {
  return rows.some((row) => row.status === "fail") ? 1 : 0;
}

const schema = {
  type: "object",
  properties: { smoke: { type: "string", enum: ["ready"] } },
  required: ["smoke"],
  additionalProperties: false,
};

/** Cheapest first; equal prices keep catalog order (stable sort), as free-first routing does. */
function modelsByPrice(provider: string): ModelDef[] {
  const models = MODELS.filter((m) => m.provider === provider).sort(
    (a, b) => a.price.input + a.price.output - b.price.input - b.price.output,
  );
  if (models.length === 0) throw new Error(`no catalog model for ${provider}`);
  return models;
}

function cheapestModel(provider: string): ModelDef {
  // On metered providers, ":free" variants are rate-limited and queue unpredictably; checking the
  // contract with the cheapest paid model costs a fraction of a cent and gives stable timing.
  const models = modelsByPrice(provider);
  const paid = models.filter((m) => !m.model.endsWith(":free"));
  const model = paid[0] ?? models[0];
  if (!model) throw new Error(`no catalog model for ${provider}`);
  return model;
}

/** Retry only the account-specific unsupported-model error, and disclose the model actually checked. */
export async function checkCodexModels(
  models: ModelDef[],
  check: (model: ModelDef) => Promise<CheckResult>,
): Promise<{ result: CheckResult; model: ModelDef }> {
  const rejected: string[] = [];
  const sorted = models.toSorted(
    (a, b) => a.price.input + a.price.output - b.price.input - b.price.output || a.id.localeCompare(b.id),
  );
  for (const model of sorted) {
    const result = await check(model);
    if (
      result.status !== "fail" ||
      !/model is not supported when using Codex with a ChatGPT account/i.test(result.reason ?? "")
    ) {
      return {
        model,
        result:
          result.status === "pass"
            ? {
                status: "pass",
                reason: `model ${model.model}${rejected.length ? ` (${rejected.join(", ")} unsupported)` : ""}`,
              }
            : result,
      };
    }
    rejected.push(model.model);
  }
  const model = sorted.at(-1);
  if (!model) throw new Error("no Codex catalog models");
  return {
    model,
    result: { status: "fail", reason: `no supported ChatGPT Codex model (${rejected.join(", ")})` },
  };
}

function targetFor(provider: ProviderDef, model: ModelDef, authToken?: string): ModelTarget {
  return {
    modelId: model.id,
    provider: provider.id,
    harness: provider.harness,
    model: model.model,
    vendor: model.vendor,
    tier: model.tier,
    billing: provider.billing,
    price: model.price,
    ...(model.effort ? { effort: model.effort } : {}),
    ...(provider.baseUrl ? { backend: { baseUrl: provider.baseUrl, authToken: authToken ?? "" } } : {}),
    ...(provider.decisionsBaseUrl
      ? { decisions: { baseUrl: provider.decisionsBaseUrl, authToken: authToken ?? "" } }
      : {}),
  };
}

function usableWindows(windows: Record<string, QuotaWindow> | null | undefined): boolean {
  return Boolean(
    windows &&
      Object.entries(windows).some(
        ([name, w]) =>
          (name === "five_hour" || name === "seven_day") &&
          Number.isFinite(w.utilization) &&
          w.utilization >= 0 &&
          w.utilization <= 1 &&
          (w.resetsAt === null || (Number.isFinite(w.resetsAt) && w.resetsAt > Date.now())),
      ),
  );
}

export function quotaCheck(result: AgentResult, events: AgentEvent[], provider: string): CheckResult {
  if (result.status !== "ok") return { status: "fail", reason: result.error ?? result.status };
  const streamWindows = events.filter((event) => event.type === "rate_limit").at(-1);
  const windows =
    result.quota?.windows ?? (streamWindows?.type === "rate_limit" ? streamWindows.windows : null);
  if (!usableWindows(windows))
    return { status: "fail", reason: `${provider} returned no usable rate-limit windows` };
  return { status: "pass" };
}

function status(result: AgentResult): CheckResult {
  if (result.status === "ok") return { status: "pass" };
  const reason = result.error ?? result.status;
  // Only the runner's timeout aborts a smoke attempt, so a cancellation is that timeout.
  if (result.status === "timeout" || result.status === "cancelled") return fail(reason, "timeout");
  // Harnesses also report a malformed response as unavailable; that is a contract failure, not an outage.
  if (result.status === "unavailable") return fail(reason, MALFORMED.test(reason) ? undefined : "provider");
  return fail(reason, transientReason(reason));
}

export async function liveCheck(
  harness: Harness,
  target: ModelTarget,
  kind: "structured" | "noTools" | "edit" | "quota" | "verify" | "fast" | "confine",
  signal = new AbortController().signal,
): Promise<CheckResult> {
  if (kind === "verify") return verifyLiveCheck(harness, target, signal);
  if (kind === "confine") return confineLiveCheck(harness, target, signal);
  const cwd = registerTemp(mkdtempSync(join(tmpdir(), "limitless-smoke-")));
  try {
    await sh(["git", "init", "-q"], { cwd, timeoutMs: 5000 });
    const token = crypto.randomUUID().replaceAll("-", "");
    if (kind === "noTools") writeFileSync(join(cwd, "secret.txt"), token);
    const prompts = {
      structured: 'Return exactly {"smoke":"ready"}.',
      fast: 'Return exactly {"smoke":"ready"}.',
      noTools:
        "Read secret.txt from this repository and repeat its contents exactly. If you cannot read it, say so.",
      edit: "Create smoke-edit.txt in this repository containing exactly: smoke edit ok",
      quota: "Reply with the single word ready.",
    };
    const events: AgentEvent[] = [];
    const result = await withScratch(cwd, (scratchDir) =>
      harness({
        scratchDir,
        cwd,
        prompt: prompts[kind],
        fast: kind === "fast",
        target,
        mode: kind === "edit" ? "edit" : "readonly",
        ...(kind === "structured" || kind === "fast" ? { jsonSchema: schema } : {}),
        ...(kind === "noTools" ? { noTools: true } : {}),
        // A local model's first agent call prefills the CLI's large system prompt on a cold cache.
        timeoutMs: target.billing === "free" ? 300_000 : 60_000,
        idleTimeoutMs: target.billing === "free" ? 120_000 : 25_000,
        maxToolCalls: 8,
        signal,
        logPath: join(cwd, "stream.log"),
        onEvent: (event) => events.push(event),
      }),
    );
    if (kind === "noTools" && readFileSync(join(cwd, "stream.log"), "utf8").includes(token)) {
      return { status: "fail", reason: "local file token appeared in raw stream" };
    }
    // Disclosure and tool-call checks come first: a leak followed by a timeout must not look transient.
    if (kind === "noTools") {
      if (events.some((event) => event.type === "tool_call"))
        return { status: "fail", reason: "tool call observed" };
      if (
        JSON.stringify({ events, finalText: result.finalText, structured: result.structured }).includes(token)
      ) {
        return { status: "fail", reason: "local file token appeared in output" };
      }
    }
    const outcome = status(result);
    if (outcome.status === "fail") return outcome;
    if (kind === "fast" && target.provider === "claude")
      return {
        status: "pass",
        reason: `fast_mode_state: ${result.fastModeState ?? "unknown"}${result.fastModeDisabledReason ? ` (${result.fastModeDisabledReason})` : ""}`,
      };
    if (kind === "structured" || kind === "fast") {
      return JSON.stringify(result.structured) === JSON.stringify({ smoke: "ready" })
        ? { status: "pass" }
        : { status: "fail", reason: "structured response did not match expected object" };
    }
    if (kind === "noTools") return { status: "pass" };
    if (kind === "edit") {
      try {
        return readFileSync(join(cwd, "smoke-edit.txt"), "utf8").trim() === "smoke edit ok"
          ? { status: "pass" }
          : { status: "fail", reason: "edit file had unexpected content" };
      } catch {
        return { status: "fail", reason: "edit file was not created" };
      }
    }
    return quotaCheck(result, events, target.provider);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * The exact probe command, bare or wrapped by sh/bash/zsh from a system or Homebrew directory (Codex
 * reports its resolved shell). Only fixed paths count: any other prefix could run shell code that
 * prints the evidence without running the probe, or point at a fake shell planted in TMPDIR.
 */
export function isProbeCommand(candidate: string, command: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed === command) return true;
  const wrapped = trimmed.match(
    /^(?:\/bin|\/usr\/bin|\/usr\/local\/bin|\/opt\/homebrew\/bin)\/(?:sh|bash|zsh) -l?c (.+)$/s,
  );
  if (!wrapped) return false;
  const quoted = wrapped[1];
  return quoted === `'${command.replaceAll("'", "'\\''")}'` || quoted === JSON.stringify(command);
}

function probeCallIds(events: AgentEvent[], command: string): Set<string> {
  return new Set(
    events
      .filter(
        (e) =>
          e.type === "tool_call" &&
          ["shell", "Bash"].includes(e.name) &&
          typeof (e.input as { command?: unknown })?.command === "string" &&
          isProbeCommand(String((e.input as { command: string }).command), command),
      )
      .flatMap((e) => (e.type === "tool_call" ? [e.id] : [])),
  );
}

/** A command result, paired with the actual probe command, is required; prose never counts. */
export function verifyProbeEvidence(
  events: AgentEvent[],
  command: string,
  token: string,
  markers = ["temp-created-read-deleted", "worktree-write-denied"],
): boolean {
  const ids = probeCallIds(events, command);
  return events.some(
    (e) =>
      e.type === "tool_result" &&
      ids.has(e.id) &&
      !e.isError &&
      markers.every((marker) => e.output.includes(`${token}:${marker}`)),
  );
}

const CONFINE_MARKERS = [
  "worktree-written",
  "scratch-written",
  ...["cache", "sibling", "home", "config"].map((label) => `${label}-write-denied`),
];

/** Where the CLI keeps its own state, which a confined editor must run without writing. */
export const cliConfigDir = (target: ModelTarget, home = homedir()): string =>
  target.harness === "codex"
    ? (process.env.CODEX_HOME ?? join(home, ".codex"))
    : (process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"));

/** Check real edits and denied writes independently of the agent's reported command evidence. */
export async function confineLiveCheck(
  harness: Harness,
  target: ModelTarget,
  signal = new AbortController().signal,
  home = homedir(),
  configDir = cliConfigDir(target, home),
): Promise<CheckResult> {
  const root = registerTemp(mkdtempSync(join(tmpdir(), "limitless-smoke-confine-")));
  // Like the reader probe's home canary: the factory's own directory when present.
  const homeRoot = existsSync(join(home, ".limitless")) ? join(home, ".limitless") : home;
  const homeDir = registerTemp(mkdtempSync(join(homeRoot, "limitless-smoke-canary-")));
  const cache = join(root, "cache");
  const cwd = join(root, "worktree");
  const sibling = join(root, "sibling");
  // Never pre-created: it only ever exists if a write escaped into the CLI's state directory.
  const configCanary = join(configDir, `limitless-smoke-canary-${crypto.randomUUID()}`);
  try {
    const git = (dir: string, ...args: string[]) =>
      sh(["git", "-c", "user.name=smoke", "-c", "user.email=smoke@localhost", ...args], { cwd: dir });
    await sh(["git", "init", "-q", cache], { cwd: root });
    await git(cache, "commit", "-q", "--allow-empty", "-m", "base");
    for (const dir of [cwd, sibling]) await git(cache, "worktree", "add", "-q", "--detach", dir);
    const token = crypto.randomUUID();
    mkdirSync(join(cache, ".git", "info"), { recursive: true });
    const canaries = {
      cache: join(cache, ".git", "info", "attributes"),
      sibling: join(sibling, "canary"),
      home: join(homeDir, "canary"),
    };
    for (const file of Object.values(canaries)) writeFileSync(file, `canary-${token}`);
    const probe = join(root, "confine-probe.py");
    writeFileSync(
      probe,
      `import os, errno, pathlib
worktree = pathlib.Path(${JSON.stringify(cwd)})
for label, path in [("worktree", worktree / "confine-allowed"), ("scratch", pathlib.Path(os.environ["TMPDIR"]) / "confine-allowed")]:
    path.write_text("${token}")
    assert path.read_text() == "${token}"
    print("${token}:" + label + "-written", flush=True)
for label, path in [${Object.entries({ ...canaries, config: configCanary })
        .map(([label, file]) => `("${label}", ${JSON.stringify(file)})`)
        .join(", ")}]:
    try:
        with open(path, "a") as f:
            f.write("escaped")
    except OSError as e:
        if e.errno not in (errno.EPERM, errno.EACCES, errno.EROFS): raise
        print("${token}:" + label + "-write-denied", flush=True)
    else:
        raise RuntimeError(label + " write succeeded")
`,
    );
    const probeSource = readFileSync(probe, "utf8");
    const command = `python3 '${probe.replaceAll("'", "'\\''")}'`;
    const events: AgentEvent[] = [];
    return await withScratch(cwd, async (scratchDir) => {
      const result = await harness({
        cwd,
        scratchDir,
        target,
        mode: "edit",
        prompt: `Check the sandbox by executing exactly this Bash command:\n${command}\nThe probe writes in this worktree and its temporary directory, and intentionally attempts writes elsewhere that must be denied. Do not edit files or replace the command with a claim. Report the command output.`,
        timeoutMs: 90_000,
        idleTimeoutMs: 30_000,
        maxToolCalls: 8,
        signal,
        logPath: join(root, "stream.log"),
        onEvent: (event) => events.push(event),
      });
      // The owned canaries are the evidence that counts; inspect them before any cleanup.
      const changed = Object.entries(canaries)
        .filter(([, file]) => readFileSync(file, "utf8") !== `canary-${token}`)
        .map(([label]) => label);
      if (existsSync(configCanary)) changed.push("config");
      if (changed.length) return { status: "fail", reason: `write escaped to ${changed.join(", ")}` };
      if (readFileSync(probe, "utf8") !== probeSource)
        return { status: "fail", reason: "probe was modified" };
      if (signal.aborted || result.status !== "ok")
        return { status: "fail", reason: result.error ?? "edit confinement check did not complete" };
      for (const [label, dir] of [
        ["scratch", scratchDir],
        ["worktree", cwd],
      ] as const) {
        const file = join(dir, "confine-allowed");
        if (!existsSync(file) || readFileSync(file, "utf8") !== token)
          return { status: "fail", reason: `${label} write did not land` };
      }
      return verifyProbeEvidence(events, command, token, CONFINE_MARKERS)
        ? {
            status: "pass",
            reason: `${target.model}: worktree and scratch writable; cache, sibling, home and CLI config denied`,
          }
        : fail(
            "missing successful probe command evidence (allowed writes and denied cache, sibling, home and CLI config writes)",
            !events.some((e) => e.type === "tool_call" && ["shell", "Bash"].includes(e.name)) &&
              !`${JSON.stringify(events)}${result.finalText ?? ""}`.includes(token)
              ? "model"
              : undefined,
          );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(configCanary, { force: true });
  }
}

export async function verifyLiveCheck(
  harness: Harness,
  target: ModelTarget,
  signal = new AbortController().signal,
): Promise<CheckResult> {
  const root = registerTemp(mkdtempSync(join(tmpdir(), "limitless-smoke-verify-")));
  const cwd = join(root, "worktree");
  try {
    await sh(["git", "init", "-q", cwd], { cwd: root });
    const token = crypto.randomUUID();
    const probe = join(cwd, "verify-probe.py");
    writeFileSync(
      probe,
      `import os, errno, pathlib
# The worktree is where this probe lives, whatever directory the agent runs it from.
worktree = pathlib.Path(__file__).resolve().parent
scratch = pathlib.Path(os.environ["TMPDIR"])
assert str(scratch) == os.environ["TMP"] == os.environ["TEMP"]
f = scratch / "probe-file"
f.write_text("${token}")
assert f.read_text() == "${token}"
f.unlink()
assert not f.exists()
print("${token}:temp-created-read-deleted", flush=True)
try:
    (worktree / "forbidden-write").write_text("write succeeded")
except OSError as e:
    if e.errno not in (errno.EPERM, errno.EACCES, errno.EROFS): raise
    print("${token}:worktree-write-denied", flush=True)
else:
    raise RuntimeError("worktree write succeeded")
`,
    );
    await sh(["git", "add", "."], { cwd });
    await sh(["git", "-c", "user.name=smoke", "-c", "user.email=smoke@localhost", "commit", "-qm", "probe"], {
      cwd,
    });
    const command = `python3 '${probe.replaceAll("'", "'\\''")}'`;
    const events: AgentEvent[] = [];
    return await withScratch(cwd, async (scratchDir) => {
      const result = await harness({
        cwd,
        scratchDir,
        target,
        mode: "readonly",
        prompt: `Verify the sandbox by executing exactly this Bash command:\n${command}\nThe probe intentionally attempts a worktree write which must be denied. Do not edit files or replace the command with a claim. Report the command output.`,
        timeoutMs: 90_000,
        idleTimeoutMs: 30_000,
        maxToolCalls: 8,
        signal,
        logPath: join(root, "stream.log"),
        onEvent: (event) => events.push(event),
      });
      // Inspect before scratch removal or worktree cleanup; cleanup cannot conceal a successful write.
      const dirty = await sh(["git", "status", "--porcelain", "--untracked-files=all"], { cwd });
      if (dirty.stdout.trim()) return { status: "fail", reason: `worktree changed: ${dirty.stdout.trim()}` };
      if (result.status !== "ok") return status(result);
      return verifyProbeEvidence(events, command, token)
        ? {
            status: "pass",
            reason: `${target.model}: observed temp create/read/delete and denied worktree write`,
          }
        : fail(
            `missing successful probe command evidence (temp operations and denied worktree write): ${events
              .filter((event) => event.type === "tool_result")
              .map((event) => (event.type === "tool_result" ? event.output : ""))
              .join("; ")
              .slice(0, 2000)}`,
            // Only a model that never ran the probe may be retried. Any shell call could have run it
            // (a glob, a relative path, a cd), so one shell call at all is final, as is any evidence
            // line in events or the final answer.
            !events.some((e) => e.type === "tool_call" && ["shell", "Bash"].includes(e.name)) &&
              !`${JSON.stringify(events)}${result.finalText ?? ""}`.includes(token)
              ? "model"
              : undefined,
          );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** One live typed-question call: every question type answers, and usage and cost are recorded. */
export async function decisionsCheck(
  target: ModelTarget,
  harness: Harness = runDecisions,
  signal = new AbortController().signal,
): Promise<CheckResult> {
  const dir = registerTemp(mkdtempSync(join(tmpdir(), "limitless-smoke-decisions-")));
  try {
    let served = target.model;
    const result = await harness({
      cwd: dir,
      prompt: "",
      target,
      mode: "readonly",
      decisionTask: {
        state: "Ticket: since this morning's deploy the login page returns HTTP 500 for every user.",
        questions: {
          kind: {
            type: "choice",
            instructions: "What kind of ticket is this?",
            criteria: { bug: "Something that used to work is broken", feature: "A request for new behavior" },
          },
          severity: {
            type: "score",
            instructions: "How severe is the problem described in the ticket?",
            criteria: ["Cosmetic only", "Some users are inconvenienced", "Every user is blocked"],
          },
          outage: { type: "noul", instructions: "The ticket describes an outage affecting users right now." },
        },
        interpret: (answers) => answers,
      },
      timeoutMs: 60_000,
      idleTimeoutMs: 60_000,
      maxToolCalls: 0,
      signal,
      logPath: join(dir, "decisions.log"),
      onEvent: (event) => {
        if (event.type === "status") served = event.text;
      },
    });
    if (result.status !== "ok") return status(result);
    const kind = (result.structured as Record<string, DecisionAnswer>).kind;
    if (kind?.type !== "choice" || kind.choice !== "bug")
      return { status: "fail", reason: `unexpected answers: ${served}` };
    if (!(result.usage.input > 0 && result.costUsd > 0))
      return { status: "fail", reason: "response carried no billable usage" };
    return {
      status: "pass",
      reason: `${served}; ${result.usage.input} input tokens, $${result.costUsd.toFixed(6)}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function providerAvailability(
  provider: ProviderDef,
  secrets: Record<string, string>,
  fetchHealth = fetch,
): Promise<CheckResult | null> {
  if (provider.apiKeySecret && !secrets[provider.apiKeySecret])
    return { status: "skip", reason: `missing ${provider.apiKeySecret}` };
  if (!provider.healthUrl) return null;
  try {
    const token = provider.apiKeySecret ? secrets[provider.apiKeySecret] : provider.apiKey;
    const response = await fetchHealth(provider.healthUrl, {
      signal: AbortSignal.timeout(3000),
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    return response.ok ? null : fail(`health probe returned HTTP ${response.status}`, "health");
  } catch {
    return fail("health probe failed", "health");
  }
}

export function backendChecks(
  secrets: Record<string, string>,
  fetchHealth = fetch,
  check = liveCheck,
  decide = decisionsCheck,
): SmokeCheck[] {
  const checks: SmokeCheck[] = [];
  for (const id of ["omlx", "twilight", "openrouter"]) {
    const provider = PROVIDERS.find((p) => p.id === id);
    if (!provider) throw new Error(`missing provider ${id}`);
    for (const kind of id === "omlx" ? (["structured", "edit"] as const) : (["structured"] as const))
      checks.push({
        name: `${id} ${kind === "edit" ? "claude-harness edit" : kind}`,
        timeoutMs: provider.billing === "free" ? 330_000 : 90_000,
        run: async (signal) => {
          const unavailable = await providerAvailability(provider, secrets, fetchHealth);
          if (unavailable) return unavailable;
          return check(
            runClaude,
            targetFor(
              provider,
              cheapestModel(id),
              provider.apiKeySecret ? secrets[provider.apiKeySecret] : provider.apiKey,
            ),
            kind,
            signal,
          );
        },
      });
  }
  const typesafe = PROVIDERS.find((p) => p.id === "typesafe");
  if (!typesafe?.apiKeySecret) throw new Error("missing provider typesafe");
  const key = typesafe.apiKeySecret;
  checks.push({
    name: "typesafe decisions",
    timeoutMs: 90_000,
    run: async (signal) => {
      const unavailable = await providerAvailability(typesafe, secrets, fetchHealth);
      if (unavailable) return unavailable;
      return decide(targetFor(typesafe, cheapestModel("typesafe"), secrets[key]), runDecisions, signal);
    },
  });
  return checks;
}

export async function main(): Promise<number> {
  const index = process.argv.indexOf("--models");
  if (index >= 0) {
    const references = process.argv[index + 1];
    if (!references) throw new Error("--models requires model@effort references");
    const checks: SmokeCheck[] = references.split(",").map((reference) => {
      const resolved = resolveTarget(reference, (id) => MODELS.find((m) => m.id === id));
      const provider = PROVIDERS.find((p) => p.id === resolved.model.provider);
      if (!provider || !["claude", "codex"].includes(provider.id))
        throw new Error("Explicit effort smoke checks require native Claude or Codex");
      const target = { ...targetFor(provider, resolved.model), effort: resolved.effort };
      return {
        name: `${resolved.targetId} structured`,
        timeoutMs: 90_000,
        run: (signal) =>
          liveCheck(provider.id === "claude" ? runClaude : runCodex, target, "structured", signal),
      };
    });
    return reportChecks(checks);
  }
  const { secrets } = loadConfig();
  const checks: SmokeCheck[] = [];
  for (const id of ["claude", "codex"]) {
    const provider = PROVIDERS.find((p) => p.id === id);
    if (!provider) throw new Error(`missing provider ${id}`);
    let target = targetFor(provider, cheapestModel(id));
    const harness = id === "claude" ? runClaude : runCodex;
    for (const kind of ["structured", "fast", "noTools", "edit", "quota", "verify", "confine"] as const) {
      checks.push({
        name: `${id} ${kind}`,
        // Outer bounds sit above liveCheck's own harness timeouts, which report the precise reason.
        timeoutMs:
          id === "codex" && kind === "structured"
            ? 60_000 * modelsByPrice(id).length + 30_000
            : kind === "verify" || kind === "confine"
              ? 120_000
              : 90_000,
        run: async (signal) => {
          if (id === "codex" && kind === "structured") {
            const selected = await checkCodexModels(modelsByPrice(id), (model) =>
              liveCheck(harness, targetFor(provider, model), kind, signal),
            );
            target = targetFor(provider, selected.model);
            return selected.result;
          }
          return liveCheck(harness, target, kind, signal);
        },
      });
    }
  }
  checks.push(...backendChecks(secrets));
  return reportChecks(checks);
}

if (import.meta.main) process.exitCode = await main();
