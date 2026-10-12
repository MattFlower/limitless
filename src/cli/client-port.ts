import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function isClientPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535;
}

/** Client routing must not depend on validation of the daemon's other settings. */
export function resolveClientPort(): number {
  const explicit = process.env.LIMITLESS_PORT?.trim();
  const port = Number(explicit);
  if (explicit && /^\d+$/.test(explicit) && isClientPort(port)) return port;
  try {
    const dir = process.env.LIMITLESS_CONFIG_DIR ?? join(homedir(), ".config", "limitless");
    const raw = Bun.TOML.parse(readFileSync(join(dir, "config.toml"), "utf8")) as Record<string, unknown>;
    const server = raw.server;
    const configured = server && typeof server === "object" && "port" in server ? server.port : undefined;
    if (isClientPort(configured)) return configured;
  } catch {
    // Unreadable files and parser diagnostics stay out of client errors and logs.
  }
  return 7400;
}
