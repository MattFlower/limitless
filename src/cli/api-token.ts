import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerCredential } from "../util/proc.ts";
import { isClientPort, resolveClientPort } from "./client-port.ts";

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
  withheld?: (origin: string) => void,
): Record<string, string> {
  const token = readApiToken(home);
  if (!token) return {};
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") return {};
    const forOrigin = (origin: string): Record<string, string> => {
      if (target.origin === origin) return { authorization: `Bearer ${token}` };
      withheld?.(origin);
      return {};
    };
    const fallback = (): Record<string, string> => {
      const selected = port ?? resolveClientPort(true);
      if (!isClientPort(selected)) return {};
      const origin = new URL(`http://127.0.0.1:${selected}`).origin;
      return forOrigin(origin);
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
    return forOrigin(origin);
  } catch {
    return {};
  }
}
