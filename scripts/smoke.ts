#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { QuotaWindow } from "../src/core/types.ts";
import { runClaude } from "../src/harness/claude.ts";
import { runCodex } from "../src/harness/codex.ts";
import type { AgentEvent, AgentResult, Harness, ModelTarget } from "../src/harness/types.ts";
import { MODELS, type ModelDef, PROVIDERS, type ProviderDef } from "../src/router/catalog.ts";
import { resolveTarget } from "../src/router/targets.ts";
import { sh } from "../src/util/proc.ts";

export type CheckResult = { status: "pass" | "fail" | "skip"; reason?: string };
export type SmokeCheck = { name: string; run: () => Promise<CheckResult> };
export type CheckRow = CheckResult & { name: string; durationMs: number };

export async function runChecks(checks: SmokeCheck[], now = () => performance.now()): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  for (const check of checks) {
    const start = now();
    try {
      rows.push({ name: check.name, ...(await check.run()), durationMs: Math.round(now() - start) });
    } catch (error) {
      rows.push({
        name: check.name,
        status: "fail",
        reason: String(error),
        durationMs: Math.round(now() - start),
      });
    }
  }
  return rows;
}

export function formatReport(rows: CheckRow[]): string {
  const width = Math.max(5, ...rows.map((row) => row.name.length));
  const lines = [
    `${"Check".padEnd(width)}  Status  Time     Detail`,
    `${"-".repeat(width)}  ------  -------  ------`,
  ];
  for (const row of rows) {
    const detail = (row.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    lines.push(
      `${row.name.padEnd(width)}  ${row.status.toUpperCase().padEnd(6)}  ${`${row.durationMs}ms`.padStart(7)}  ${detail}`,
    );
  }
  return lines.join("\n");
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
  return result.status === "ok"
    ? { status: "pass" }
    : { status: "fail", reason: result.error ?? result.status };
}

export async function liveCheck(
  harness: Harness,
  target: ModelTarget,
  kind: "structured" | "noTools" | "edit" | "quota",
): Promise<CheckResult> {
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
    const result = await harness({
      cwd,
      prompt: prompts[kind],
      target,
      mode: kind === "edit" ? "edit" : "readonly",
      ...(kind === "structured" ? { jsonSchema: schema } : {}),
      ...(kind === "noTools" ? { noTools: true } : {}),
      timeoutMs: 60_000,
      idleTimeoutMs: 25_000,
      maxToolCalls: 8,
      signal: new AbortController().signal,
      logPath: join(cwd, "stream.log"),
      onEvent: (event) => events.push(event),
    });
    if (kind === "noTools" && readFileSync(join(cwd, "stream.log"), "utf8").includes(token)) {
      return { status: "fail", reason: "local file token appeared in raw stream" };
    }
    const outcome = status(result);
    if (outcome.status === "fail") return outcome;
    if (kind === "structured") {
      return JSON.stringify(result.structured) === JSON.stringify({ smoke: "ready" })
        ? { status: "pass" }
        : { status: "fail", reason: "structured response did not match expected object" };
    }
    if (kind === "noTools") {
      if (events.some((event) => event.type === "tool_call"))
        return { status: "fail", reason: "tool call observed" };
      if (
        JSON.stringify({ events, finalText: result.finalText, structured: result.structured }).includes(token)
      ) {
        return { status: "fail", reason: "local file token appeared in output" };
      }
      return { status: "pass" };
    }
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

async function providerAvailability(
  provider: ProviderDef,
  secrets: Record<string, string>,
): Promise<string | null> {
  if (provider.apiKeySecret && !secrets[provider.apiKeySecret]) return `missing ${provider.apiKeySecret}`;
  if (!provider.healthUrl) return null;
  try {
    const token = provider.apiKeySecret ? secrets[provider.apiKeySecret] : provider.apiKey;
    const response = await fetch(provider.healthUrl, {
      signal: AbortSignal.timeout(3000),
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    return response.ok ? null : `health probe returned HTTP ${response.status}`;
  } catch {
    return "health probe failed";
  }
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
        run: () => liveCheck(provider.id === "claude" ? runClaude : runCodex, target, "structured"),
      };
    });
    const rows = await runChecks(checks);
    console.log(formatReport(rows));
    return exitCode(rows);
  }
  const { secrets } = loadConfig();
  const checks: SmokeCheck[] = [];
  for (const id of ["claude", "codex"]) {
    const provider = PROVIDERS.find((p) => p.id === id);
    if (!provider) throw new Error(`missing provider ${id}`);
    let target = targetFor(provider, cheapestModel(id));
    const harness = id === "claude" ? runClaude : runCodex;
    for (const kind of ["structured", "noTools", "edit", "quota"] as const) {
      checks.push({
        name: `${id} ${kind}`,
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
  for (const id of ["mtplx", "twilight", "openrouter"]) {
    const provider = PROVIDERS.find((p) => p.id === id);
    if (!provider) throw new Error(`missing provider ${id}`);
    checks.push({
      name: `${id} structured`,
      run: async () => {
        const reason = await providerAvailability(provider, secrets);
        if (reason) return { status: "skip", reason };
        return liveCheck(
          runClaude,
          targetFor(
            provider,
            cheapestModel(id),
            provider.apiKeySecret ? secrets[provider.apiKeySecret] : provider.apiKey,
          ),
          "structured",
        );
      },
    });
  }
  const rows = await runChecks(checks);
  console.log(formatReport(rows));
  return exitCode(rows);
}

if (import.meta.main) process.exitCode = await main();
