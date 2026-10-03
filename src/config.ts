import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ResolvedProfile, ReviewFinder, Role } from "./core/types.ts";
import { evalSettings } from "./evals/settings.ts";
import { defaultGateSlots } from "./gates/slots.ts";
import { parseReviewRosters } from "./pipeline/review-system.ts";
import { PROVIDERS } from "./router/catalog.ts";
import { isLanAddress, isLoopback, publicOrigin } from "./server/access.ts";

export interface Paths {
  home: string; // ~/.limitless
  db: string;
  repos: string; // bare repo cache
  work: string; // worktrees
  runs: string; // per-run artifacts & logs
  configDir: string; // ~/.config/limitless
}

export interface Reserves {
  /** Stop using Claude when the 5-hour window utilization reaches this fraction. */
  claudeFiveHour: number;
  claudeSevenDay: number;
  /** Stop using Codex at this used fraction (user asked to keep 10% free). */
  codexWeekly: number;
  codexFiveHour: number;
  /** Optional reserve fractions for additional provider quota windows. */
  windows?: Record<string, Record<string, number>>;
}

export interface Config {
  paths: Paths;
  retention: { worktreeDays: number; failedWorktreeDays: number; logDays: number; debugEventDays: number };
  port: number;
  host: string;
  listenLan: string | null;
  trustedProxies: string[];
  publicOrigins: string[];
  publicUrl: string | null; // e.g. https://limitless.example.com (webhooks only)
  uiUrl: string; // where the UI is reachable locally, used in PR bodies
  maxConcurrentRuns: number;
  providerMaxConcurrent: Record<string, number>;
  /** Gate suites (setup + checks) allowed to run at once across the whole process. */
  maxConcurrentGates: number;
  /** `[gates] baseline_cache`: reuse passing baselines per base commit. Off, every baseline runs (and refreshes). */
  baselineCache: boolean;
  /** `[gates] baseline_env`: extra variable names whose values (hashed) key the baseline cache. */
  baselineEnv: string[];
  maxRounds: number; // implement ⇄ feedback rounds before escalation
  openrouterBudgetUsd: number;
  reserves: Reserves;
  /** Providers to try first among interchangeable models (e.g. use up a subscription). */
  preferProviders: string[];
  waitBudgetS: Partial<Record<Role, number>>;
  dependabotRouting: "free_first" | "policy";
  /** Whether review prompts (production and eval) carry the implementer's self-report. */
  reviewImplementerReport: "include" | "omit";
  /** `single` (production today) or a verified finder panel with the profile's roster. */
  reviewMode: "single" | "panel";
  /** Panel finders per profile, before repo lenses. */
  reviewRosters: Record<ResolvedProfile, ReviewFinder[]>;
  /** Decision-model triage declines (falls through to the next model) below this answer confidence. */
  triageDecisionConfidence: number;
  githubOwner: string | null; // allowlisted GitHub login for triggers
  discordOwnerId: string | null;
  discordChannelId: string | null;
  discordNotifyAll: boolean;
  secrets: Record<string, string>;
  /** Raw config.toml overrides (routing policy, providers) consumed by their modules. */
  raw: Record<string, unknown>;
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** `[review]` is validated strictly: a misspelt key would otherwise silently keep the default. */
const REVIEW_KEYS = ["implementer_report", "mode", "rosters"];
const TRIAGE_KEYS = ["decision_confidence"];
/** Provisional until calibrated on evals/triage (docs/research/09-jev-decisions.md). */
export const DEFAULT_DECISION_CONFIDENCE = 0.6;

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function days(v: unknown, fallback: number): number {
  const value = num(v, fallback);
  return value >= 0 ? value : fallback;
}

function str(v: unknown, fallback: string | null): string | null {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

export function loadConfig(
  overrides: Partial<{ home: string; configDir: string; port: number }> = {},
): Config {
  const home = overrides.home ?? process.env.LIMITLESS_HOME ?? join(homedir(), ".limitless");
  const configDir =
    overrides.configDir ?? process.env.LIMITLESS_CONFIG_DIR ?? join(homedir(), ".config", "limitless");
  const paths: Paths = {
    home,
    db: join(home, "limitless.db"),
    repos: join(home, "repos"),
    work: join(home, "work"),
    runs: join(home, "runs"),
    configDir,
  };
  for (const dir of [paths.home, paths.repos, paths.work, paths.runs]) mkdirSync(dir, { recursive: true });

  const tomlPath = join(configDir, "config.toml");
  const raw: Record<string, unknown> = existsSync(tomlPath)
    ? (Bun.TOML.parse(readFileSync(tomlPath, "utf8")) as Record<string, unknown>)
    : {};
  evalSettings(raw);
  const providerMaxConcurrent: Record<string, number> = {};
  const configuredProviders = raw.providers === undefined ? {} : raw.providers;
  if (
    typeof configuredProviders !== "object" ||
    configuredProviders === null ||
    Array.isArray(configuredProviders)
  )
    throw new Error("providers must be a table");
  for (const [id, value] of Object.entries(configuredProviders)) {
    if (!PROVIDERS.some((provider) => provider.id === id))
      throw new Error(`providers.${id}: unknown provider`);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Error(`providers.${id} must be a table`);
    const limit = (value as Record<string, unknown>).max_concurrent;
    if (limit !== undefined) {
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0)
        throw new Error(`providers.${id}.max_concurrent must be a positive safe integer`);
      providerMaxConcurrent[id] = limit;
    }
  }
  const secrets = { ...parseEnvFile(join(configDir, "secrets.env")) };
  // Environment variables win over the secrets file (useful for tests and CI).
  for (const key of [
    "OPENROUTER_API_KEY",
    "OMLX_API_KEY",
    "DISCORD_BOT_TOKEN",
    "DISCORD_APP_ID",
    "DISCORD_GUILD_ID",
    "GITHUB_WEBHOOK_SECRET",
  ]) {
    const v = process.env[key];
    if (v) secrets[key] = v;
  }

  const server = (raw.server ?? {}) as Record<string, unknown>;
  const limits = (raw.limits ?? {}) as Record<string, unknown>;
  const reserves = (raw.reserves ?? {}) as Record<string, unknown>;
  const owners = (raw.owners ?? {}) as Record<string, unknown>;
  const discord = (raw.discord ?? {}) as Record<string, unknown>;
  const routing = (raw.routing ?? {}) as Record<string, unknown>;
  if (
    routing.dependabot !== undefined &&
    routing.dependabot !== "free_first" &&
    routing.dependabot !== "policy"
  )
    throw new Error('routing.dependabot must be "free_first" or "policy"');
  const waitBudgetS: Partial<Record<Role, number>> = {
    triage: 20,
    summarize: 20,
    chat: 20,
  };
  const waits = routing.wait_budget_s ?? {};
  if (typeof waits !== "object" || waits === null || Array.isArray(waits))
    throw new Error("routing.wait_budget_s must be a table");
  const roles = [
    ...Object.keys(waitBudgetS),
    "review",
    "verify",
    "spec",
    "holdout",
    "implement",
    "plan",
    "plan_review",
  ];
  for (const [role, seconds] of Object.entries(waits)) {
    if (!roles.includes(role)) throw new Error(`routing.wait_budget_s.${role}: unknown role`);
    if (seconds === "unbounded") {
      delete waitBudgetS[role as Role];
      continue;
    }
    if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 0)
      throw new Error(`routing.wait_budget_s.${role} must be nonnegative integer seconds`);
    waitBudgetS[role as Role] = seconds;
  }
  const rawReview = raw.review ?? {};
  if (typeof rawReview !== "object" || rawReview === null || Array.isArray(rawReview))
    throw new Error("review must be a table");
  const review = rawReview as Record<string, unknown>;
  for (const key of Object.keys(review))
    if (!REVIEW_KEYS.includes(key))
      throw new Error(`review.${key}: unknown key (allowed: ${REVIEW_KEYS.join(", ")})`);
  if (
    review.implementer_report !== undefined &&
    review.implementer_report !== "include" &&
    review.implementer_report !== "omit"
  )
    throw new Error('review.implementer_report must be "include" or "omit"');
  if (review.mode !== undefined && review.mode !== "single" && review.mode !== "panel")
    throw new Error('review.mode must be "single" or "panel"');
  const rawTriage = raw.triage ?? {};
  if (typeof rawTriage !== "object" || rawTriage === null || Array.isArray(rawTriage))
    throw new Error("triage must be a table");
  const triage = rawTriage as Record<string, unknown>;
  for (const key of Object.keys(triage))
    if (!TRIAGE_KEYS.includes(key))
      throw new Error(`triage.${key}: unknown key (allowed: ${TRIAGE_KEYS.join(", ")})`);
  const confidence = triage.decision_confidence ?? DEFAULT_DECISION_CONFIDENCE;
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1))
    throw new Error("triage.decision_confidence must be a number from 0 to 1");
  const retention = (raw.retention ?? {}) as Record<string, unknown>;
  const gates = (raw.gates ?? {}) as Record<string, unknown>;
  if (gates.baseline_cache !== undefined && typeof gates.baseline_cache !== "boolean")
    throw new Error("gates.baseline_cache must be true or false");
  const baselineEnv = gates.baseline_env ?? [];
  if (!Array.isArray(baselineEnv) || !baselineEnv.every((v) => typeof v === "string"))
    throw new Error("gates.baseline_env must be an array of environment variable names");
  const port = overrides.port ?? num(Number(process.env.LIMITLESS_PORT) || server.port, 7400);
  const host = str(server.host, "127.0.0.1") as string;

  const listenLan = server.listen_lan ?? null;
  if (listenLan !== null && (typeof listenLan !== "string" || !isLanAddress(listenLan)))
    throw new Error("server.listen_lan must be a concrete non-loopback unicast IP (never 0.0.0.0 or ::)");
  if (listenLan && !isLoopback(host))
    throw new Error("server.host must be a loopback IP when server.listen_lan is enabled");
  const trustedProxies = server.trusted_proxies ?? [];
  if (!Array.isArray(trustedProxies))
    throw new Error("server.trusted_proxies must be an array of individual IP addresses");
  for (const ip of trustedProxies)
    if (typeof ip !== "string" || !isIP(ip) || ip.includes("%"))
      throw new Error(
        `server.trusted_proxies: ${JSON.stringify(ip)} must be an individual IP address (no CIDRs or hostnames)`,
      );
  const origins = server.public_origins ?? [];
  if (!Array.isArray(origins)) throw new Error("server.public_origins must be an array of HTTP(S) origins");

  return {
    paths,
    listenLan,
    trustedProxies,
    publicOrigins: origins.map(publicOrigin),
    retention: {
      worktreeDays: days(retention.worktree_days, 3),
      failedWorktreeDays: days(retention.failed_worktree_days, 7),
      logDays: days(retention.log_days, 30),
      debugEventDays: days(retention.debug_event_days, 14),
    },
    port,
    host,
    publicUrl: str(server.public_url, null),
    uiUrl: str(server.ui_url, `http://localhost:${port}`) as string,
    maxConcurrentRuns: num(limits.max_concurrent_runs, 3),
    providerMaxConcurrent,
    maxConcurrentGates: Math.max(1, Math.floor(num(limits.max_concurrent_gates, defaultGateSlots()))),
    baselineCache: gates.baseline_cache !== false,
    baselineEnv,
    maxRounds: num(limits.max_rounds, 3),
    openrouterBudgetUsd: num(limits.openrouter_budget_usd, 50),
    reserves: {
      claudeFiveHour: num(reserves.claude_five_hour, 0.8),
      claudeSevenDay: num(reserves.claude_seven_day, 0.85),
      codexWeekly: num(reserves.codex_weekly, 0.9),
      codexFiveHour: num(reserves.codex_five_hour, 0.9),
      windows: Object.fromEntries(
        Object.entries((reserves.windows ?? {}) as Record<string, unknown>).map(([provider, value]) => [
          provider,
          Object.fromEntries(
            Object.entries(value && typeof value === "object" ? value : {}).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0,
            ),
          ),
        ]),
      ),
    },
    preferProviders: Array.isArray(routing.prefer)
      ? routing.prefer.filter((p): p is string => typeof p === "string")
      : [],
    waitBudgetS,
    dependabotRouting: routing.dependabot === "policy" ? "policy" : "free_first",
    reviewImplementerReport: review.implementer_report === "omit" ? "omit" : "include",
    reviewMode: review.mode === "panel" ? "panel" : "single",
    reviewRosters: parseReviewRosters(review.rosters),
    triageDecisionConfidence: confidence,
    githubOwner: str(owners.github, "MattFlower"),
    discordOwnerId: str(owners.discord, null),
    discordChannelId: str(discord.channel_id, null),
    discordNotifyAll: discord.notify_all === true,
    secrets,
    raw,
  };
}
