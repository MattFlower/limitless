import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveServerPort } from "../config.ts";

export function isClientPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535;
}

/** Client routing must not depend on validation of the daemon's other settings. */
export function resolveClientPort(forToken = false): number {
  let server: unknown;
  try {
    const dir = process.env.LIMITLESS_CONFIG_DIR ?? join(homedir(), ".config", "limitless");
    const raw = Bun.TOML.parse(readFileSync(join(dir, "config.toml"), "utf8")) as Record<string, unknown>;
    server = raw.server;
  } catch (error) {
    // Unreadable files and parser diagnostics stay out of client errors and logs.
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
      server = { port: Number.NaN };
  }
  return resolveServerPort(process.env.LIMITLESS_PORT, server, forToken ? Number.NaN : 7400);
}
