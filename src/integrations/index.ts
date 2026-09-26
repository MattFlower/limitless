import type { Server } from "bun";
import type { Factory } from "../app.ts";
import { mountMcp } from "./mcp-http.ts";

export interface Integrations {
  routes: Record<string, (req: Request, server: Server<undefined>) => Response | Promise<Response>>;
  /** Lines printed at startup describing what is enabled. */
  notes: string[];
  stop: () => Promise<void>;
}

/** Wire trigger integrations (GitHub webhooks, Discord, MCP) into the daemon. */
export async function mountIntegrations(factory: Factory): Promise<Integrations> {
  const mcp = mountMcp(factory);
  return {
    routes: { "/mcp": (req, server) => mcp.handle(req, server.requestIP(req)?.address ?? null) },
    notes: [...(await toolVersions()), "MCP: /mcp (loopback only)"],
    stop: mcp.stop,
  };
}

/** Which agent CLIs the daemon will actually run (PATH mix-ups have bitten us before). */
async function toolVersions(): Promise<string[]> {
  const notes: string[] = [];
  for (const bin of ["claude", "codex", "gh", "git"]) {
    const path = Bun.which(bin);
    if (!path) {
      notes.push(`${bin}: NOT FOUND on PATH`);
      continue;
    }
    const proc = Bun.spawnSync([path, "--version"], { stdout: "pipe", stderr: "pipe" });
    const version = proc.stdout.toString().trim().split("\n")[0] ?? "";
    notes.push(`${bin}: ${version} (${path})`);
  }
  return notes;
}
