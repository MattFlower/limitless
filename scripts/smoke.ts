#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { QuotaWindow } from "../src/core/types.ts";
import { runClaude } from "../src/harness/claude.ts";
import { runCodex } from "../src/harness/codex.ts";
import { type DecisionAnswer, runDecisions } from "../src/harness/decisions.ts";
import { withScratch } from "../src/harness/scratch.ts";
import type { AgentEvent, AgentResult, Harness, ModelTarget } from "../src/harness/types.ts";
import { MODELS, type ModelDef, PROVIDERS, type ProviderDef } from "../src/router/catalog.ts";
import { resolveTarget } from "../src/router/targets.ts";
import { sh } from "../src/util/proc.ts";

/**
 * Why a failure may be retried: the provider was briefly unavailable. Anything else (a disclosed
 * token, a tool call, a forbidden write, a wrong answer) is an assertion failure and is final.
 */
export type Transient = "timeout" | "provider" | "health";
export type CheckResult = { status: "pass" | "fail" | "skip"; reason?: string; transient?: Transient };
/** `timeoutMs` bounds each attempt; it defaults to DEFAULT_CHECK_TIMEOUT_MS. */
export type SmokeCheck = { name: string; timeoutMs?: number; run: () => Promise<CheckResult> };
export type CheckRow = CheckResult & {
  name: string;
  durationMs: number;
  retried?: boolean;
  retriedAfter?: string;
};
export type RunOptions = {
  /** Overall time for every attempt; a retry that cannot finish inside it is not started. */
  budgetMs?: number;
  retryDelayMs?: number;
  onStart?: (check: SmokeCheck) => void;
  onRow?: (row: CheckRow) => void;
};

const RETRY_DELAY_MS = 5_000;
const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
/** The deploy gate kills smoke after 900 s; leave room for startup and reporting. */
export const SMOKE_BUDGET_MS = 870_000;

const PROVIDER_ERROR =
  /(?:HTTP|status|code)\s*5\d\d|\b50[0-4]\b|rate.?limit|\b429\b|overloaded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|stream disconnected|connection (?:refused|reset|closed|error|failed)|network error/i;

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

async function attempt(check: SmokeCheck, timeoutMs: number): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      check.run(),
      new Promise<CheckResult>((resolve) => {
        timer = setTimeout(() => resolve(fail(`timeout ${timeoutMs}ms`, "timeout")), timeoutMs);
      }),
    ]);
  } catch (error) {
    return fail(String(error), transientReason(String(error)));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Live providers fail transiently (Codex has rejected models intermittently), so a check that
 * failed for an availability reason gets one retry if it still fits the budget.
 */
export async function runChecks(
  checks: SmokeCheck[],
  now = () => performance.now(),
  delay = (ms: number) => Bun.sleep(ms),
  options: RunOptions = {},
): Promise<CheckRow[]> {
  const { budgetMs = Number.POSITIVE_INFINITY, retryDelayMs = RETRY_DELAY_MS } = options;
  const begin = now();
  const rows: CheckRow[] = [];
  for (const check of checks) {
    const timeoutMs = check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    options.onStart?.(check);
    let start = now();
    let result = await attempt(check, timeoutMs);
    let retried = false;
    const first = result.reason;
    const retry = result.status === "fail" && result.transient !== undefined;
    if (retry && budgetMs - (now() - begin) < retryDelayMs + timeoutMs) {
      result = { ...result, reason: `${first ?? "failed"} (no time left to retry)` };
    } else if (retry) {
      await delay(retryDelayMs);
      retried = true;
      start = now();
      result = await attempt(check, timeoutMs);
      // A retry that skips (e.g. its health probe now fails) must not hide the first failure.
      if (result.status === "skip")
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
      durationMs: Math.round(now() - start),
      ...(retried ? { retried, retriedAfter: first ?? "failed" } : {}),
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
    row.retried && row.status === "pass"
      ? `PASS (retried after: ${row.retriedAfter})`
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

function modelsByPrice(provider: string): ModelDef[] {
  const models = MODELS.filter((m) => m.provider === provider).sort(
    (a, b) => a.price.input + a.price.output - b.price.input - b.price.output || a.id.localeCompare(b.id),
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
  if (result.status === "timeout") return fail(reason, "timeout");
  if (result.status === "unavailable") return fail(reason, "provider");
  return fail(reason, transientReason(reason));
}

export async function liveCheck(
  harness: Harness,
  target: ModelTarget,
  kind: "structured" | "noTools" | "edit" | "quota" | "verify",
): Promise<CheckResult> {
  if (kind === "verify") return verifyLiveCheck(harness, target);
  const cwd = mkdtempSync(join(tmpdir(), "limitless-smoke-"));
  try {
    await sh(["git", "init", "-q"], { cwd, timeoutMs: 5000 });
    const token = crypto.randomUUID().replaceAll("-", "");
    if (kind === "noTools") writeFileSync(join(cwd, "secret.txt"), token);
    const prompts = {
      structured: 'Return exactly {"smoke":"ready"}.',
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
        target,
        mode: kind === "edit" ? "edit" : "readonly",
        ...(kind === "structured" ? { jsonSchema: schema } : {}),
        ...(kind === "noTools" ? { noTools: true } : {}),
        // A local model's first agent call prefills the CLI's large system prompt on a cold cache.
        timeoutMs: target.billing === "free" ? 300_000 : 60_000,
        idleTimeoutMs: target.billing === "free" ? 120_000 : 25_000,
        maxToolCalls: 8,
        signal: new AbortController().signal,
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
    if (kind === "structured") {
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

/** A command result, paired with the actual probe command, is required; prose never counts. */
export function verifyProbeEvidence(events: AgentEvent[], command: string, token: string): boolean {
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const commands = [
    command,
    ...["/bin/zsh", "/bin/bash", "/bin/sh"].flatMap((shell) =>
      ["-lc", "-c"].flatMap((flag) => [
        `${shell} ${flag} ${quote(command)}`,
        `${shell} ${flag} ${JSON.stringify(command)}`,
      ]),
    ),
  ];
  const ids = new Set(
    events
      .filter(
        (e) =>
          e.type === "tool_call" &&
          ["shell", "Bash"].includes(e.name) &&
          typeof (e.input as { command?: unknown })?.command === "string" &&
          commands.includes(String((e.input as { command: string }).command).trim()),
      )
      .flatMap((e) => (e.type === "tool_call" ? [e.id] : [])),
  );
  return events.some(
    (e) =>
      e.type === "tool_result" &&
      ids.has(e.id) &&
      !e.isError &&
      e.output.includes(`${token}:temp-created-read-deleted`) &&
      e.output.includes(`${token}:worktree-write-denied`),
  );
}

export async function verifyLiveCheck(harness: Harness, target: ModelTarget): Promise<CheckResult> {
  const root = mkdtempSync(join(tmpdir(), "limitless-smoke-verify-"));
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
        signal: new AbortController().signal,
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
        : {
            status: "fail",
            reason: `missing successful probe command evidence (temp operations and denied worktree write): ${events
              .filter((event) => event.type === "tool_result")
              .map((event) => (event.type === "tool_result" ? event.output : ""))
              .join("; ")
              .slice(0, 2000)}`,
          };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** One live typed-question call: every question type answers, and usage and cost are recorded. */
export async function decisionsCheck(
  target: ModelTarget,
  harness: Harness = runDecisions,
): Promise<CheckResult> {
  const dir = mkdtempSync(join(tmpdir(), "limitless-smoke-decisions-"));
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
      signal: new AbortController().signal,
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
): Promise<string | null> {
  if (provider.apiKeySecret && !secrets[provider.apiKeySecret]) return `missing ${provider.apiKeySecret}`;
  if (!provider.healthUrl) return null;
  try {
    const token = provider.apiKeySecret ? secrets[provider.apiKeySecret] : provider.apiKey;
    const response = await fetchHealth(provider.healthUrl, {
      signal: AbortSignal.timeout(3000),
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    return response.ok ? null : `health probe returned HTTP ${response.status}`;
  } catch {
    return "health probe failed";
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
        run: async () => {
          const reason = await providerAvailability(provider, secrets, fetchHealth);
          if (reason) return { status: "skip", reason };
          return check(
            runClaude,
            targetFor(
              provider,
              cheapestModel(id),
              provider.apiKeySecret ? secrets[provider.apiKeySecret] : provider.apiKey,
            ),
            kind,
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
    run: async () => {
      const reason = await providerAvailability(typesafe, secrets, fetchHealth);
      if (reason) return { status: "skip", reason };
      return decide(targetFor(typesafe, cheapestModel("typesafe"), secrets[key]));
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
        run: () => liveCheck(provider.id === "claude" ? runClaude : runCodex, target, "structured"),
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
    for (const kind of ["structured", "noTools", "edit", "quota", "verify"] as const) {
      checks.push({
        name: `${id} ${kind}`,
        // Outer bounds sit above liveCheck's own harness timeouts, which report the precise reason.
        timeoutMs:
          id === "codex" && kind === "structured"
            ? 60_000 * modelsByPrice(id).length + 30_000
            : kind === "verify"
              ? 120_000
              : 90_000,
        run: async () => {
          if (id === "codex" && kind === "structured") {
            const selected = await checkCodexModels(modelsByPrice(id), (model) =>
              liveCheck(harness, targetFor(provider, model), kind),
            );
            target = targetFor(provider, selected.model);
            return selected.result;
          }
          return liveCheck(harness, target, kind);
        },
      });
    }
  }
  checks.push(...backendChecks(secrets));
  return reportChecks(checks);
}

if (import.meta.main) process.exitCode = await main();
