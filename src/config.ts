import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ResolvedProfile, ReviewFinder, Role } from "./core/types.ts";
import { evalSettings } from "./evals/settings.ts";
import { defaultGateSlots } from "./gates/slots.ts";
import { parseReviewRosters } from "./pipeline/review-system.ts";
import { type EffectiveCatalog, resolveCatalog } from "./router/config-catalog.ts";
import { validatePrefer } from "./router/prefer.ts";
import { isLanAddress, isLoopback, publicOrigin } from "./server/access.ts";
import { registerCredential } from "./util/proc.ts";

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
  /** `[server] auth`: "required" makes non-loopback UI/API access sign in; "proxy" leaves it to the proxy. */
  auth: "required" | "proxy";
  /** `[auth]` `idle_days` / `absolute_days`: when a sign-in session expires unused, and at the latest. */
  sessionIdleDays: number;
  sessionAbsoluteDays: number;
  publicUrl: string | null; // e.g. https://limitless.example.com (webhooks only)
  uiUrl: string; // where the UI is reachable locally, used in PR bodies
  maxConcurrentRuns: number;
  providerMaxConcurrent: Record<string, number>;
  catalog?: EffectiveCatalog;
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
  /** `panel`: single reviews still decide, and the profile's panel also runs and records `review-N.shadow.json`. */
  reviewShadow: "off" | "panel";
  /** How long a shadow panel may outlast its single review before it is aborted as a timeout. */
  reviewShadowGraceSeconds: number;
  /** Besides the repository owner, logins whose PR comments count as shadow-report evidence. */
  reviewTrustedReviewers: string[];
  /** Panel finders per profile, before repo lenses. */
  reviewRosters: Record<ResolvedProfile, ReviewFinder[]>;
  /** Decision-model triage declines (falls through to the next model) below this answer confidence. */
  triageDecisionConfidence: number;
  githubOwner: string | null; // allowlisted GitHub login for triggers
  githubMerge?: "auto" | "pr" | "none";
  githubPoll: boolean; // [github] poll: observe factory PRs; off restores the notifier's per-run PR checks
  githubPollSeconds: number; // [github] poll_seconds: the normal polling interval, at least 15
  discordOwnerId: string | null;
  discordChannelId: string | null;
  discordNotifyAll: boolean;
  secrets: Record<string, string>;
  /** Raw config.toml overrides (routing policy, providers) consumed by their modules. */
  raw: Record<string, unknown>;
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return Object.create(null);
  const out: Record<string, string> = Object.create(null);
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
const REVIEW_KEYS: readonly string[] = [
  "implementer_report",
  "mode",
  "rosters",
  "shadow",
  "shadow_grace_seconds",
  "trusted_reviewers",
];
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

type LoadOptions = Partial<Paths> & { port?: number; readOnly?: boolean; raw?: Record<string, unknown> };
export function loadConfig(overrides: LoadOptions = {}): Config {
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
  if (!overrides.readOnly)
    for (const dir of [paths.home, paths.repos, paths.work, paths.runs]) mkdirSync(dir, { recursive: true });

  const tomlPath = join(configDir, "config.toml");
  let raw: Record<string, unknown>;
  try {
    raw =
      overrides.raw ??
      (existsSync(tomlPath)
        ? (Bun.TOML.parse(readFileSync(tomlPath, "utf8")) as Record<string, unknown>)
        : {});
  } catch {
    // Parser diagnostics can include the source line, including credentials.
    throw new Error("Invalid config.toml; fix TOML syntax in the configuration file");
  }
  evalSettings(raw);
  const catalog = resolveCatalog(raw.providers);
  const { providerMaxConcurrent } = catalog;
  const fileSecrets = parseEnvFile(join(configDir, "secrets.env"));
  const secrets: Record<string, string> = Object.assign(Object.create(null), fileSecrets);
  // Environment variables win over the secrets file (useful for tests and CI).
  for (const key of ["DISCORD_BOT_TOKEN", "DISCORD_APP_ID", "DISCORD_GUILD_ID", "GITHUB_WEBHOOK_SECRET"]) {
    const v = process.env[key];
    if (v) secrets[key] = v;
  }

  for (const p of catalog.providers) {
    const key = p.apiKeySecret;
    if (key) secrets[key] = fileSecrets[key] || (Object.hasOwn(process.env, key) && process.env[key]) || "";
    if (key) registerCredential(key, secrets[key]);
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
  const prefer = validatePrefer(
    routing.prefer === undefined ? [] : routing.prefer,
    catalog.models,
    catalog.providers,
  );
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
  if (review.shadow !== undefined && review.shadow !== "off" && review.shadow !== "panel")
    throw new Error('review.shadow must be "off" or "panel"');
  if (review.shadow === "panel" && review.mode === "panel")
    throw new Error('review.shadow = "panel" needs review.mode = "single"; a panel cannot shadow itself');
  const grace = review.shadow_grace_seconds ?? 300;
  if (typeof grace !== "number" || !Number.isFinite(grace) || grace < 0)
    throw new Error("review.shadow_grace_seconds must be a nonnegative number");
  const trusted = review.trusted_reviewers ?? [];
  if (!Array.isArray(trusted) || !trusted.every((login) => typeof login === "string" && login))
    throw new Error("review.trusted_reviewers must be a list of GitHub logins");
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
  const github = (raw.github ?? {}) as Record<string, unknown>;
  const repos = github.repos;
  const valid = Array.isArray(repos) && repos.every((r) => typeof r === "string" && repoName.test(r));
  if (repos !== undefined && !valid) throw new Error("github.repos must be an array of owner/name strings");
  if (github.merge !== undefined && !["auto", "pr", "none"].includes(github.merge as string))
    throw new Error("github.merge must be auto, pr or none");
  if (github.poll !== undefined && typeof github.poll !== "boolean")
    throw new Error("github.poll must be true or false");
  if (github.poll_seconds !== undefined && !Number.isFinite(github.poll_seconds))
    throw new Error("github.poll_seconds must be a number of seconds");
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
  if (server.auth !== undefined && server.auth !== "required" && server.auth !== "proxy")
    throw new Error('server.auth must be "required" or "proxy"');
  if (server.auth !== "proxy" && origins.some((o) => publicOrigin(o).startsWith("http:")))
    throw new Error('server.auth = "required" needs https public_origins (the session cookie is Secure)');
  const auth = (raw.auth ?? {}) as Record<string, unknown>;
  const lifetime = (key: string, fallback: number) => {
    const value = auth[key] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      throw new Error(`auth.${key} must be a positive number of days`);
    return value;
  };

  return {
    paths,
    listenLan,
    trustedProxies,
    publicOrigins: origins.map(publicOrigin),
    auth: server.auth === "proxy" ? "proxy" : "required",
    sessionIdleDays: lifetime("idle_days", 30),
    sessionAbsoluteDays: lifetime("absolute_days", 180),
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
    catalog,
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
    preferProviders: prefer,
    waitBudgetS,
    dependabotRouting: routing.dependabot === "policy" ? "policy" : "free_first",
    reviewImplementerReport: review.implementer_report === "omit" ? "omit" : "include",
    reviewMode: review.mode === "panel" ? "panel" : "single",
    reviewShadow: review.shadow === "panel" ? "panel" : "off",
    reviewShadowGraceSeconds: grace,
    reviewTrustedReviewers: trusted,
    reviewRosters: parseReviewRosters(review.rosters),
    triageDecisionConfidence: confidence,
    githubOwner: str(owners.github, "MattFlower"),
    githubMerge: github.merge as Config["githubMerge"],
    githubPoll: github.poll !== false,
    githubPollSeconds: Math.max(15, num(github.poll_seconds, 45)),
    discordOwnerId: str(owners.discord, null),
    discordChannelId: str(discord.channel_id, null),
    discordNotifyAll: discord.notify_all === true,
    secrets,
    raw,
  };
}
export const repoName = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
