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

export function apiTokenHeaders(home?: string): Record<string, string> {
  const token = readApiToken(home);
  return token ? { authorization: `Bearer ${token}` } : {};
}
