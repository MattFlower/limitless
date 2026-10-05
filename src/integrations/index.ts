import type { Server } from "bun";
import type { Factory } from "../app.ts";
import { mountDiscord } from "./discord.ts";
import { type GhRunner, githubWebhook, runGh } from "./github.ts";
import { type GitHubPrClient, getGitHubPr, startGitHubNotifier } from "./github-notifier.ts";
import { type GitHubClient, observedPrs, startGitHubPoller } from "./github-poller.ts";
import { mountMcp } from "./mcp-http.ts";

export interface Integrations {
  routes: Record<string, (req: Request, server: Server<undefined>) => Response | Promise<Response>>;
  /** Lines printed at startup describing what is enabled. */
  notes: string[];
  stop: () => Promise<void>;
}

export interface IntegrationDeps {
  toolVersions?: () => Promise<string[]>;
  gh?: GhRunner;
  prClient?: GitHubPrClient;
  github?: GitHubClient;
}

/** Wire trigger integrations (GitHub webhooks, Discord, MCP) into the daemon. */
export async function mountIntegrations(factory: Factory, deps: IntegrationDeps = {}): Promise<Integrations> {
  const mcp = mountMcp(factory);
  const discord = mountDiscord(factory);
  const prClient = deps.prClient ?? getGitHubPr;
  const stopNotifier = startGitHubNotifier(
    factory.store,
    deps.gh ?? runGh,
    console.warn,
    // While polling, merge reconciliation reads the poller's observations for the PRs it tracks.
    factory.cfg.githubPoll ? observedPrs(factory.store, prClient) : prClient,
    factory.cfg.paths.configDir,
    [factory.cfg.paths.repos, factory.cfg.paths.work],
  );
  const seconds = factory.cfg.githubPollSeconds;
  const stopPoller = factory.cfg.githubPoll
    ? startGitHubPoller(factory.store, { client: deps.github, seconds })
    : () => {};
  // The land queue resumes whatever the last daemon left in flight, and waits for new requests.
  factory.land.start();
  const queued = factory.land.list().filter((entry) => entry.state !== "landed");
  return {
    routes: {
      "/mcp": (req, server) => {
        server.timeout(req, 90);
        return mcp.handle(req, server.requestIP(req)?.address ?? null);
      },
      "/webhooks/github": githubWebhook(factory),
    },
    notes: [
      ...(await (deps.toolVersions ?? toolVersions)()),
      "MCP: /mcp (loopback only)",
      discord.note,
      factory.cfg.secrets.GITHUB_WEBHOOK_SECRET
        ? "GitHub webhooks enabled"
        : "GitHub webhooks disabled (GITHUB_WEBHOOK_SECRET is not configured)",
      factory.cfg.githubPoll ? `GitHub PR polling every ${seconds}s` : "GitHub PR polling disabled",
      `Land queue: ${queued.length ? `${queued.length} pending` : "idle"}`,
    ],
    stop: async () => {
      stopNotifier();
      stopPoller();
      await Promise.all([factory.land.stop(), mcp.stop(), discord.stop()]);
    },
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
    const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const version = stdout.trim().split("\n")[0] ?? "";
    notes.push(`${bin}: ${version} (${path})`);
  }
  return notes;
}
