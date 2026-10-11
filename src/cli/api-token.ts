import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
): Record<string, string> {
  const token = readApiToken(home);
  if (!token) return {};
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return {};
    let record: string;
    try {
      record = readFileSync(join(home, "api-token.origin"), "utf8");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return {};
      const origin = new URL(`http://127.0.0.1:${Number(process.env.LIMITLESS_PORT ?? 7400)}`).origin;
      return target.origin === origin ? { authorization: `Bearer ${token}` } : {};
    }
    const pair = JSON.parse(record) as { origin?: unknown; tokenHash?: unknown } | null;
    if (pair?.tokenHash !== createHash("sha256").update(token).digest("hex")) return {};
    if (typeof pair.origin !== "string") return {};
    const origin = new URL(pair.origin).origin;
    if (origin !== pair.origin || !/^https?:\/\//.test(origin)) return {};
    return target.origin === origin ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}
