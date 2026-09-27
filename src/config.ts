import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { evalSettings } from "./evals/settings.ts";

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
  publicUrl: string | null; // e.g. https://limitless.mattflower.cc (webhooks only)
  uiUrl: string; // where the UI is reachable locally, used in PR bodies
  maxConcurrentRuns: number;
  maxRounds: number; // implement ⇄ feedback rounds before escalation
  openrouterBudgetUsd: number;
  reserves: Reserves;
  /** Providers to try first among interchangeable models (e.g. use up a subscription). */
  preferProviders: string[];
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
  const secrets = { ...parseEnvFile(join(configDir, "secrets.env")) };
  // Environment variables win over the secrets file (useful for tests and CI).
  for (const key of [
    "OPENROUTER_API_KEY",
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
  const retention = (raw.retention ?? {}) as Record<string, unknown>;
  const port = overrides.port ?? num(Number(process.env.LIMITLESS_PORT) || server.port, 7400);
  const host = str(server.host, "127.0.0.1") as string;

  return {
    paths,
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
    githubOwner: str(owners.github, "MattFlower"),
    discordOwnerId: str(owners.discord, null),
    discordChannelId: str(discord.channel_id, null),
    discordNotifyAll: discord.notify_all === true,
    secrets,
    raw,
  };
}
