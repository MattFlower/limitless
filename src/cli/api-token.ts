import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { registerCredential } from "../util/proc.ts";

/** Re-read per request: deploy and lease clients can outlive a daemon restart. */
export function readApiToken(
  home = process.env.LIMITLESS_HOME ?? join(homedir(), ".limitless"),
): string | null {
  try {
    const token = readFileSync(join(home, "api-token"), "utf8").trim();
    if (!token) return null;
    registerCredential("LIMITLESS_API_TOKEN", token);
    return token;
  } catch {
    return null;
  }
}

export function apiTokenHeaders(
  url: string | URL,
  home = process.env.LIMITLESS_HOME ?? join(homedir(), ".limitless"),
  port?: number,
): Record<string, string> {
  const token = readApiToken(home);
  if (!token) return {};
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return {};
    const fallback = (): Record<string, string> => {
      const origin = new URL(`http://127.0.0.1:${port ?? loadConfig({ readOnly: true }).port}`).origin;
      return target.origin === origin ? { authorization: `Bearer ${token}` } : {};
    };
    let record: string;
    try {
      record = readFileSync(join(home, "api-token.origin"), "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return {};
      return fallback();
    }
    const pair = JSON.parse(record) as { origin?: unknown; tokenHash?: unknown } | null;
    if (typeof pair?.origin !== "string" || typeof pair.tokenHash !== "string") return {};
    const origin = new URL(pair.origin).origin;
    if (origin !== pair.origin || !/^https?:\/\//.test(origin)) return {};
    if (pair.tokenHash !== createHash("sha256").update(token).digest("hex")) return fallback();
    return target.origin === origin ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
