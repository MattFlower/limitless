import { sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Config } from "../config.ts";
import { redactCredentials, registerCredential, sh } from "../util/proc.ts";

export type GitHubIdentity = { kind: "owner" } | { kind: "app"; token: string; botLogin: string };
export class GitHubIdentityError extends Error {}

type App = Config["githubApp"];
type IdentityDeps = { fetch?: (url: string, init?: RequestInit) => Promise<Response>; now?: () => number };

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
        jwt = `${payload}.${sign("RSA-SHA256", Buffer.from(payload), readFileSync(app.privateKeyPath)).toString("base64url")}`;
      } catch {
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

/** Only structured repository arguments select an identity; GraphQL callers pass the repo explicitly. */
export function githubRepo(args: string[]): string | undefined {
  const flag = args.findIndex((a) => a === "--repo" || a === "-R");
  if (flag >= 0) return args[flag + 1];
  if (args[0] === "repo" && args[1] === "view") return args[2];
  for (const arg of args) {
    const match = /^(?:https:\/\/github\.com\/|\/?repos\/)([^/]+\/[^/?#]+)(?:[/?#]|$)/.exec(arg);
    if (match) return match[1];
  }
  return undefined;
}

export async function githubSh(
  cmd: string[],
  opts: Parameters<typeof sh>[1],
  repo = githubRepo(cmd.slice(1)),
) {
  const identity = await githubIdentity(repo);
  return sh(
    cmd,
    identity.kind === "app"
      ? { ...opts, env: { ...process.env, ...opts.env, GH_TOKEN: identity.token } }
      : opts,
  );
}
