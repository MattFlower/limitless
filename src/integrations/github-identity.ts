import { sign } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Config } from "../config.ts";
import { redactCredentials, registerCredential, sh } from "../util/proc.ts";
import { claimGuard } from "./claim-guard.ts";

export type GitHubIdentity = { kind: "owner" } | { kind: "app"; token: string; botLogin: string };
export class GitHubIdentityError extends Error {}

type App = Config["githubApp"];
type IdentityDeps = { fetch?: (url: string, init?: RequestInit) => Promise<Response>; now?: () => number };

function signingKey(path: string): Buffer {
  let fd: number;
  try {
    // A replacement FIFO must reach the regular-file check without blocking the daemon.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ELOOP" ? "symlink refused" : "cannot open file";
    throw new GitHubIdentityError(`GitHub App private key ${path}: ${reason}`);
  }
  try {
    const stat = fstatSync(fd);
    const reason = !stat.isFile()
      ? "not a regular file"
      : stat.uid !== process.getuid?.()
        ? "wrong owner"
        : stat.mode & 0o077
          ? `mode 0${(stat.mode & 0o777).toString(8)} permits group or other access`
          : undefined;
    if (reason) throw new GitHubIdentityError(`GitHub App private key ${path}: ${reason}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Each configured provider owns its cache; concurrent requests share the exchange. */
export function createGitHubIdentity(app: App, deps: IdentityDeps = {}) {
  let cached: { identity: GitHubIdentity; expires: number } | undefined;
  let flight: Promise<GitHubIdentity> | undefined;
  let botLogin: string | undefined;
  const now = deps.now ?? Date.now;
  const repos = new Set(app?.repos.map((repo) => repo.toLowerCase()));
  const request = async (path: string, token: string, method = "GET") => {
    let status = "unavailable";
    try {
      const res = await (deps.fetch ?? fetch)(`https://api.github.com/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(30_000),
      });
      status = String(res.status);
      const raw: unknown = await res.json().catch(() => {
        throw new Error("invalid JSON response");
      });
      if (raw && typeof raw === "object" && "token" in raw && typeof raw.token === "string")
        registerCredential("GH_TOKEN", raw.token);
      const body = z
        .object({
          token: z.string().optional(),
          expires_at: z.string().optional(),
          slug: z.string().optional(),
          message: z.string().optional(),
        })
        .safeParse(raw);
      if (!body.success) throw new Error("invalid response");
      const data = body.data;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "invalid response");
      return { ...data, status: res.status };
    } catch (error) {
      throw new GitHubIdentityError(
        redactCredentials(
          `GitHub App token exchange failed: HTTP ${status}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  };
  const identity = async (repo?: string): Promise<GitHubIdentity> => {
    if (!app || !repo || !repos.has(repo.toLowerCase())) return { kind: "owner" };
    if (cached && now() < cached.expires - 300_000) return cached.identity;
    if (flight) return flight;
    flight = (async () => {
      const seconds = Math.floor(now() / 1000);
      const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
      const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: app.appId, iat: seconds - 30, exp: seconds + 540 })}`;
      let jwt: string;
      try {
        jwt = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), signingKey(app.privateKeyPath)).toString("base64url")}`;
      } catch (error) {
        if (error instanceof GitHubIdentityError) throw error;
        throw new GitHubIdentityError(
          "GitHub App token exchange failed: HTTP unavailable: cannot read or sign with private key",
        );
      }
      registerCredential("GITHUB_APP_JWT", jwt);
      const body = await request(`app/installations/${app.installationId}/access_tokens`, jwt, "POST");
      const expires = Date.parse(body.expires_at ?? "");
      if (typeof body?.token !== "string" || !body.token || !Number.isFinite(expires) || expires <= now())
        throw new GitHubIdentityError(
          `GitHub App token exchange failed: HTTP ${body.status}: invalid token response`,
        );
      if (!botLogin) {
        const info = await request("app", jwt);
        if (typeof info?.slug !== "string" || !info.slug)
          throw new GitHubIdentityError(
            `GitHub App token exchange failed: HTTP ${info.status}: missing App slug`,
          );
        botLogin = `${info.slug}[bot]`;
      }
      const result: GitHubIdentity = { kind: "app", token: body.token, botLogin };
      cached = { identity: result, expires };
      return result;
    })();
    try {
      return await flight;
    } finally {
      flight = undefined;
    }
  };
  return identity;
}

let provider = createGitHubIdentity(null);
export function configureGitHubIdentity(app: App, deps: IdentityDeps = {}) {
  provider = createGitHubIdentity(app, deps);
}
export const githubIdentity = (repo?: string) => provider(repo);

/** Parse a single repository/PR URL, never arbitrary command text. */
export const githubUrlRepo = (url: string): string | undefined =>
  /^https:\/\/github\.com\/([^/]+\/[^/?#]+)(?:[/?#]|$)/i.exec(url)?.[1];

const valueFlags = new Set(
  `--body -b --body-file --subject --title -t -f -F --field --raw-field --jq -q --json --template
   --match-head-commit --head -H --header --base -B --state --method -X --input --limit -L
   --label -l --search --commit --hostname --author --assignee --milestone --project`.split(/\s+/),
);

function githubRepos(args: string[]): string[] {
  const flags: string[] = [];
  const positional: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && arg.startsWith("-")) {
      const [flag = "", value] = arg.split(/=(.*)/s);
      if (flag === "--repo" || flag === "-R") {
        const repo = value ?? args[++i];
        if (repo) flags.push(repo);
      } else if (value === undefined && valueFlags.has(flag)) i++;
      continue;
    }
    const repo = githubUrlRepo(arg) ?? /^\/?repos\/([^/]+\/[^/?#]+)(?:[/?#]|$)/.exec(arg)?.[1];
    if (repo) positional.push(repo);
    else if (args[0] === "repo" && args[1] === "view" && i >= 2 && /^[\w.-]+\/[\w.-]+$/.test(arg))
      positional.push(arg);
  }
  return [...flags, ...positional];
}

/** Only structured repository arguments select an identity; GraphQL callers pass the repo explicitly. */
export const githubRepo = (args: string[]): string | undefined => githubRepos(args)[0];

export async function githubSh(cmd: string[], opts: Parameters<typeof sh>[1], repo?: string) {
  const references = githubRepos(cmd.slice(1));
  if (repo && references.some((ref) => ref.toLowerCase() !== repo.toLowerCase()))
    throw new GitHubIdentityError(`GitHub repository arguments disagree with explicit repository ${repo}`);
  const suppliedGuard = opts.dispatchGuard;
  opts = {
    ...opts,
    dispatchGuard: () => {
      suppliedGuard?.();
      claimGuard();
    },
  };
  const identity = await githubIdentity(repo ?? references[0]);
  return sh(
    cmd,
    identity.kind === "app"
      ? { ...opts, env: { ...process.env, ...opts.env, GH_TOKEN: identity.token } }
      : opts,
  );
}
