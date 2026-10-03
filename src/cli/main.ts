#!/usr/bin/env bun
import { join } from "node:path";
import { parseArgs } from "node:util";
import { formatCost } from "../core/cost-format.ts";
import { observationAge, utilizationPercent } from "../core/quota-format.ts";
import type { Profile, Run, RunDetail, RunEvent } from "../core/types.ts";
import { parseMaxWait } from "./deploy-wait.ts";

const USAGE = `limitless — personal software factory

Usage:
  limitless serve                         Start the daemon (API, UI, scheduler)
  limitless run "<prompt>" --repo <repo>  Queue a run (repo: owner/name or a local path)
        [--profile auto|quick|standard|deep] [--title <t>] [--after <run-id>[,<run-id>]] [-f|--follow]
        [--no-baseline-cache]  Always execute the baseline gates; a passing one refreshes the cache
  limitless eval run <role> --models codex/luna@low,claude/opus@high [--k N] [--cases id,id] [--max-usd X] [--concurrency N] [--no-cache] [--follow]
        implement only: [--rounds N] [--strategy retry|effort|switch]
        review only: --systems <file.json> [--replay-finders <evalId>] instead of --models
  limitless eval report <eval-id> [--json]
  limitless eval resume <eval-id>         Continue an interrupted or failed eval; unchanged finished trials carry over
  limitless eval cancel <eval-id>         Stop scheduling an eval's trials; it ends interrupted
  limitless eval regrade <eval-id>        Recompute a review eval's grades from stored outputs (no model calls)
  limitless eval policy [--evals id,id] [--write]
  limitless ls [--status s1,s2] [-n 20]   List runs
  limitless show <run>                    Run details
  limitless logs <run> [-f]               Print (and follow) the run's event log
  limitless cancel <run>                  Cancel a run
  limitless answer <run> "<text>"         Answer a run's open question(s)
  limitless feed [--consumer <name>] [--after <id>] [--wait <seconds>] [--json]
        Items to act on after the consumer's cursor; --wait long-polls until one arrives
  limitless feed ack <id> --consumer <name>  Acknowledge items through id once handled
  limitless providers                     Provider health and quota
  limitless providers enable|disable <id>  Change runtime provider availability
  limitless providers fast on|off <id>     Toggle native provider fast mode
  limitless gc [--dry-run]                Clean up expired worktrees, logs, debug events and baseline cache
  limitless gates clear-cache [--repo owner/name]  Drop cached passing baselines (all repos by default)
  limitless mcp                           MCP stdio proxy (daemon must be running)
  limitless integrations install [--write] Print setup; --write installs the Codex skill
  limitless service install [--tunnel] [--mtplx]   launchd agents: daemon (+ mtplx, tunnel)
  limitless service uninstall|status
  limitless local up|down|status          Report oMLX health; manage twilight
  limitless deploy [ref] [--smoke] [--max-wait <seconds>] [--now]
        Deploy origin/main by default; drain for up to 2700s (45m). --now skips waiting.

Environment: LIMITLESS_URL (default http://127.0.0.1:7400)`;

const BASE = process.env.LIMITLESS_URL ?? `http://127.0.0.1:${process.env.LIMITLESS_PORT ?? 7400}`;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error(`Cannot reach the Limitless daemon at ${BASE}. Start it with \`limitless serve\`.`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error: string }).error;
    } catch {
      // not json
    }
    throw new Error(`${res.status}: ${msg}`);
  }
  return JSON.parse(text) as T;
}

const color = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function statusColor(s: string): string {
  const status = s.trim();
  if (status === "succeeded") return color.green(s);
  if (status === "resolved") return color.cyan(s);
  if (status === "failed" || status === "needs_human") return color.red(s);
  if (status === "running") return color.cyan(s);
  if (status === "waiting_input" || status === "waiting") return color.yellow(s);
  return color.dim(s);
}

function formatEvent(e: RunEvent): string {
  const t = new Date(e.ts).toLocaleTimeString();
  const tag = e.type.padEnd(11);
  const msg = e.message.replace(/\s+/g, " ").slice(0, 220);
  const line = `${color.dim(t)} ${tag} ${msg}`;
  if (e.level === "error") return color.red(line);
  if (e.level === "warn") return color.yellow(line);
  if (e.level === "debug") return color.dim(line);
  return line;
}

async function follow(runId: string, after = 0): Promise<void> {
  const res = await fetch(`${BASE}/api/runs/${runId}/stream?after=${after}`);
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let idx = buf.indexOf("\n\n");
    while (idx >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      idx = buf.indexOf("\n\n");
      if (!chunk.startsWith("data: ")) continue;
      const msg = JSON.parse(chunk.slice(6)) as { kind: string; event?: RunEvent; run?: Run };
      if (msg.kind === "event" && msg.event && msg.event.level !== "debug")
        console.log(formatEvent(msg.event));
      if (
        msg.kind === "run" &&
        msg.run &&
        ["succeeded", "failed", "cancelled", "needs_human", "resolved"].includes(msg.run.status)
      ) {
        console.log(
          `\n${color.bold("Run")} ${runId}: ${statusColor(msg.run.status)}${msg.run.prUrl ? ` — ${msg.run.prUrl}` : ""}`,
        );
        if (msg.run.error) console.log(color.red(msg.run.error));
        return;
      }
    }
  }
}

async function serve(): Promise<void> {
  const { resolveBootSha } = await import("./boot-sha.ts");
  const { loadConfig } = await import("../config.ts");
  const { Factory } = await import("../app.ts");
  const { startHttp } = await import("../server/http.ts");
  const { mountIntegrations } = await import("../integrations/index.ts");
  const { sweepOrphanedSnapshots } = await import("../pipeline/snapshots.ts");
  const cfg = loadConfig();
  const orphans = sweepOrphanedSnapshots();
  if (orphans.length) console.log(`Removed ${orphans.length} holdout snapshot(s) left by a stopped daemon`);
  const bootSha = await resolveBootSha(join(import.meta.dir, "../.."));
  const factory = new Factory(cfg, {
    bootSha,
    policyPath: join(import.meta.dir, "../../routing/policy.json"),
  });
  const ui = await (await import("../server/ui.ts")).buildUi();
  const integrations = await mountIntegrations(factory);
  const server = startHttp(factory, { ui, routes: integrations.routes });
  factory.start();
  console.log(`Limitless listening on http://${cfg.host}:${server.port}  (data: ${cfg.paths.home})`);
  if (cfg.listenLan) console.log(`LAN proxy listener: http://${cfg.listenLan}:${cfg.port}`);
  for (const line of integrations.notes) console.log(`  ${line}`);
  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n${sig}: stopping (active runs will resume on restart)...`);
    await integrations.stop();
    await factory.stop();
    await server.stop(true);
    factory.store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      evals: { type: "string" },
      models: { type: "string" },
      systems: { type: "string" },
      "replay-finders": { type: "string" },
      k: { type: "string" },
      rounds: { type: "string" },
      strategy: { type: "string" },
      cases: { type: "string" },
      "max-usd": { type: "string" },
      concurrency: { type: "string" },
      "no-cache": { type: "boolean" },
      "no-baseline-cache": { type: "boolean" },
      json: { type: "boolean" },
      after: { type: "string" },
      consumer: { type: "string" },
      wait: { type: "string" },
      repo: { type: "string", short: "r" },
      profile: { type: "string", short: "p" },
      title: { type: "string", short: "t" },
      follow: { type: "boolean", short: "f" },
      status: { type: "string", short: "s" },
      n: { type: "string", short: "n" },
      help: { type: "boolean", short: "h" },
      tunnel: { type: "boolean" },
      write: { type: "boolean" },
      "dry-run": { type: "boolean" },
      mtplx: { type: "boolean" },
      smoke: { type: "boolean" },
      "max-wait": { type: "string" },
      now: { type: "boolean" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) {
    console.log(USAGE);
    return;
  }
  switch (cmd) {
    case "eval": {
      const { evalCommand } = await import("./eval.ts");
      return evalCommand(rest, values, { api, print: console.log, wait: (ms) => Bun.sleep(ms) });
    }
    case "feed": {
      const { feedCommand } = await import("./feed.ts");
      return feedCommand(rest, values, { api, print: console.log });
    }
    case "serve":
      return serve();
    case "mcp": {
      const { startStdio } = await import("../integrations/mcp.ts");
      return startStdio(BASE);
    }
    case "integrations": {
      if (rest[0] !== "install") throw new Error("usage: limitless integrations install [--write]");
      const { installIntegrations } = await import("../integrations/install.ts");
      return installIntegrations({ write: values.write === true });
    }
    case "local": {
      const action = rest[0];
      if (rest.length !== 1 || (action !== "up" && action !== "down" && action !== "status"))
        throw new Error("usage: limitless local up|down|status");
      const { loadConfig } = await import("../config.ts");
      const { manageLocal } = await import("./local.ts");
      const cfg = loadConfig();
      const local = (cfg.raw.local ?? {}) as Record<string, unknown>;
      const report = await manageLocal(action, {
        modelPath: typeof local.twilight_model_path === "string" ? local.twilight_model_path : "",
        twilightHost: typeof local.twilight_host === "string" ? local.twilight_host : undefined,
        llamaBinary:
          typeof local.twilight_llama_binary === "string" ? local.twilight_llama_binary : undefined,
        secrets: cfg.secrets,
        setEnabled: async (id, enabled) => {
          await api(`/api/providers/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, {
            method: "POST",
          });
        },
      });
      for (const [name, state] of Object.entries(report))
        console.log(`${name}: service ${state.service}; endpoint ${state.endpoint}`);
      if (
        Object.values(report).some(
          (state) => state.service.includes("failed") || state.service === "unreachable",
        )
      )
        process.exitCode = 1;
      return;
    }
    case "run": {
      const prompt = rest.join(" ").trim() || (await Bun.stdin.text()).trim();
      if (!prompt || !values.repo) throw new Error('usage: limitless run "<prompt>" --repo <repo>');
      const run = await api<Run>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          repo: values.repo,
          prompt,
          ...(values.after !== undefined ? { dependsOn: values.after.split(",") } : {}),
          profile: (values.profile as Profile | undefined) ?? "auto",
          ...(values.title ? { title: values.title } : {}),
          ...(values["no-baseline-cache"] ? { noBaselineCache: true } : {}),
          source: "cli",
          requestedBy: process.env.USER,
        }),
      });
      console.log(`Created run ${color.bold(run.id)} on ${run.repoSlug}: ${run.status}`);
      if (values.follow) await follow(run.id);
      return;
    }
    case "ls": {
      const qs = new URLSearchParams({ limit: values.n ?? "20" });
      if (values.status) qs.set("status", values.status);
      const runs = await api<Run[]>(`/api/runs?${qs}`);
      for (const r of runs) {
        const formatted = formatCost(r.costUsd, r.costEquivUsd);
        const cost = `${formatted.primary}${formatted.paid ? ` ${formatted.paid}` : ""}`;
        console.log(
          `${r.id}  ${statusColor(r.status.padEnd(13))} ${(r.stage ?? "").padEnd(9)} ${cost.padEnd(8)} ${r.repoSlug.padEnd(28)} ${r.title.slice(0, 60)}`,
        );
      }
      return;
    }
    case "show": {
      const d = await api<RunDetail>(`/api/runs/${rest[0]}`);
      const r = d.run;
      console.log(`${color.bold(r.title)}  (${r.id})`);
      console.log(
        `repo ${r.repoSlug}  status ${statusColor(r.status)}  profile ${r.resolvedProfile ?? r.profile}`,
      );
      if (r.prUrl) console.log(`PR ${r.prUrl}`);
      if (r.error) console.log(color.red(r.error));
      const cost = formatCost(r.costUsd, r.costEquivUsd);
      console.log(`cost ${cost.primary}${cost.paid ? ` ${cost.paid} paid` : ""} (${cost.title})`);
      console.log(color.bold("\nStages"));
      for (const s of d.stages)
        console.log(`  ${s.name.padEnd(10)} ${statusColor(s.status).padEnd(18)} ${s.summary ?? ""}`);
      console.log(color.bold("\nInvocations"));
      for (const i of d.invocations) {
        console.log(
          `  #${i.id} ${i.role.padEnd(10)} ${i.modelId.padEnd(28)} ${statusColor(i.status)} ${i.error ?? ""}`,
        );
      }
      const open = d.questions.filter((q) => !q.answer);
      if (open.length) {
        console.log(color.yellow("\nOpen questions"));
        for (const q of open) console.log(`  - ${q.question}`);
      }
      return;
    }
    case "logs": {
      const id = rest[0] as string;
      const events = await api<RunEvent[]>(`/api/runs/${id}/events?limit=5000`);
      for (const e of events) if (e.level !== "debug") console.log(formatEvent(e));
      if (values.follow) await follow(id, events.at(-1)?.id ?? 0);
      return;
    }
    case "cancel": {
      const res = await api<{ cancelled: boolean }>(`/api/runs/${rest[0]}/cancel`, { method: "POST" });
      console.log(res.cancelled ? "Cancelled" : "Run already finished");
      return;
    }
    case "answer": {
      const [id, ...text] = rest;
      await api(`/api/runs/${id}/answer`, {
        method: "POST",
        body: JSON.stringify({ answer: text.join(" "), by: process.env.USER ?? "cli" }),
      });
      console.log("Answered");
      return;
    }
    case "service": {
      const svc = await import("./service.ts");
      const port = Number(process.env.LIMITLESS_PORT ?? 7400);
      if (rest[0] === "install") {
        return svc.install(port, { tunnel: values.tunnel === true, mtplx: values.mtplx === true });
      }
      if (rest[0] === "uninstall") return svc.uninstall();
      return svc.status(port);
    }
    case "deploy": {
      const maxWaitMs = parseMaxWait(values["max-wait"]);
      const svc = await import("./service.ts");
      if (rest.length > 1)
        throw new Error("usage: limitless deploy [ref] [--smoke] [--max-wait <seconds>] [--now]");
      return svc.deploy(Number(process.env.LIMITLESS_PORT ?? 7400), rest[0], values.smoke === true, {
        maxWaitMs,
        now: values.now === true,
      });
    }
    case "providers": {
      if (rest[0] === "fast") {
        const [, value, id] = rest;
        if (rest.length !== 3 || (value !== "on" && value !== "off") || !id)
          throw new Error("usage: limitless providers fast on|off <id>");
        const provider = await api<import("../core/types.ts").ProviderStatus>(
          `/api/providers/${encodeURIComponent(id)}/fast`,
          { method: "POST", body: JSON.stringify({ on: value === "on" }) },
        );
        console.log(`${provider.id}: fast ${provider.fast ? "on" : "off"}`);
        return;
      }
      if (rest.length) {
        const [action, id] = rest;
        if (rest.length !== 2 || (action !== "enable" && action !== "disable") || !id)
          throw new Error("usage: limitless providers enable|disable <id>");
        const provider = await api<import("../core/types.ts").ProviderStatus>(
          `/api/providers/${encodeURIComponent(id)}/${action}`,
          { method: "POST" },
        );
        console.log(`${provider.id}: ${provider.state}${provider.reason ? ` (${provider.reason})` : ""}`);
        return;
      }
      const ps =
        await api<
          {
            id: string;
            state: string;
            reason: string | null;
            maxConcurrent: number;
            windows: Record<string, { utilization: number; observedAt?: number | null }>;
          }[]
        >("/api/providers");
      for (const p of ps) {
        const w = Object.entries(p.windows)
          .map(([k, v]) => `${k} ${utilizationPercent(v.utilization)} (${observationAge(v.observedAt)})`)
          .join(", ");
        console.log(
          `${p.id.padEnd(11)} ${p.state.padEnd(9)} maxConcurrent ${p.maxConcurrent} ${w} ${p.reason ? color.dim(p.reason) : ""}`,
        );
      }
      return;
    }
    case "gc": {
      if (rest.length) throw new Error("usage: limitless gc [--dry-run]");
      const result = await api<import("../gc.ts").GcResult>("/api/gc", {
        method: "POST",
        body: JSON.stringify({ dryRun: values["dry-run"] === true }),
      });
      console.log(
        `${result.dryRun ? "Would clean" : "Cleaned"}: ${result.worktrees.length} worktrees, ${result.logs.length} logs, ${result.metadata.length} metadata entries, ${result.debugEvents} debug events, ${result.baselineCache} cached baselines, ${result.feedItems} feed items`,
      );
      for (const path of result.worktrees) console.log(`  worktree ${path}`);
      for (const path of result.logs) console.log(`  log ${path}`);
      for (const entry of result.metadata) console.log(`  metadata ${entry}`);
      for (const error of result.errors) console.error(color.red(`  error ${error}`));
      if (result.errors.length) process.exitCode = 1;
      return;
    }
    case "gates": {
      if (rest.length !== 1 || rest[0] !== "clear-cache")
        throw new Error("usage: limitless gates clear-cache [--repo owner/name]");
      const { cleared } = await api<{ cleared: number }>("/api/gates/clear-cache", {
        method: "POST",
        body: JSON.stringify(values.repo === undefined ? {} : { repo: values.repo }),
      });
      console.log(`Cleared ${cleared} cached baselines`);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(color.red((e as Error).message));
  process.exit(1);
});
