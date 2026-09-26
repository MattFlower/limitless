import type { Server } from "bun";
import type { Factory } from "../app.ts";
import { githubWebhook, runGh } from "./github.ts";
import { startGitHubNotifier } from "./github-notifier.ts";

export interface Integrations {
  routes: Record<string, (req: Request, server: Server<undefined>) => Response | Promise<Response>>;
  /** Lines printed at startup describing what is enabled. */
  notes: string[];
  stop: () => Promise<void>;
}

/** Wire trigger integrations (GitHub webhooks, Discord, MCP) into the daemon. */
export async function mountIntegrations(factory: Factory): Promise<Integrations> {
  const stopNotifier = startGitHubNotifier(factory.store, runGh);
  return {
    routes: { "/webhooks/github": githubWebhook(factory) },
    notes: [
      factory.cfg.secrets.GITHUB_WEBHOOK_SECRET
        ? "GitHub webhooks enabled"
        : "GitHub webhooks disabled (GITHUB_WEBHOOK_SECRET is not configured)",
    ],
    stop: async () => {
      stopNotifier();
    },
  };
}
