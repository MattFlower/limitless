import type { Server } from "bun";
import type { Factory } from "../app.ts";

export interface Integrations {
  routes: Record<string, (req: Request, server: Server<undefined>) => Response | Promise<Response>>;
  /** Lines printed at startup describing what is enabled. */
  notes: string[];
  stop: () => Promise<void>;
}

/** Wire trigger integrations (GitHub webhooks, Discord, MCP) into the daemon. */
export async function mountIntegrations(_factory: Factory): Promise<Integrations> {
  return { routes: {}, notes: [], stop: async () => {} };
}
