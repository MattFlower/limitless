import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../app.ts";
import { liveAgentTestCapability } from "../gates/agent-tests.ts";
import { mountIntegrations } from "../integrations/index.ts";
import { createApiToken } from "../server/api-token.ts";
import { startHttp } from "../server/http.ts";
import { startWorkerListener } from "../server/workers.ts";
import { protectPrivateFile } from "../util/private-reads.ts";
import { recoverProcessCleanups, redactCredentials } from "../util/proc.ts";

/** Protect retained credentials before integrations resume the land queue or start agents. */
export async function startDaemon(
  factory: Factory,
  ui: Record<string, Blob>,
  mount = mountIntegrations,
  serve = Bun.serve<undefined>,
) {
  const credential = createApiToken(factory.cfg.paths.home);
  const privateFiles: (() => void)[] = [];
  let integrations: Awaited<ReturnType<typeof mount>> | undefined;
  let server: Awaited<ReturnType<typeof startHttp>> | undefined;
  let workers: Awaited<ReturnType<typeof startWorkerListener>>;
  const stop = async (force?: boolean) => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => integrations?.stop()),
      Promise.resolve().then(() => server?.stop(force)),
      Promise.resolve().then(() => workers?.stop()),
    ]);
    credential.release();
    for (const release of privateFiles) release();
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  try {
    for (const [dir, files] of [
      ["worker-tls", ["key.pem"]],
      ["worker", ["token", "key.pem", "coordinator-fingerprint"]],
    ] as const) {
      const home = join(factory.cfg.paths.home, dir);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      for (const file of files) privateFiles.push(protectPrivateFile(join(home, file)));
    }
    workers = await startWorkerListener(factory.workers, factory.cfg.paths, factory.cfg.workers.listen);
    integrations = await mount(factory);
    server = await startHttp(
      factory,
      {
        ui,
        routes: integrations.routes,
        gateSlotCapability: (req) => liveAgentTestCapability(req.headers.get("authorization")),
      },
      serve,
      credential,
    );
    // Health is available while recovery runs; per-run barriers still guard every command.
    void (async () => {
      for (const runId of new Set(factory.store.pendingProcessCleanups().map((r) => r.runId))) {
        await recoverProcessCleanups(factory.store, runId).catch((error: unknown) => {
          const message = redactCredentials((error as Error).message);
          console.error(`[cleanup] ${message}`);
          factory.store.addEvent({ runId, type: "error", level: "error", message });
        });
      }
    })();
    factory.start();
    return { integrations, server: { ...server, stop } };
  } catch (error) {
    await stop(true).catch(() => {});
    throw error;
  }
}
