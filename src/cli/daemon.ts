import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../app.ts";
import { liveAgentTestCapability } from "../gates/agent-tests.ts";
import { attachSlotPools } from "../gates/slots.ts";
import { mountIntegrations } from "../integrations/index.ts";
import { createApiToken } from "../server/api-token.ts";
import { startHttp } from "../server/http.ts";
import { startWorkerListener } from "../server/workers.ts";
import { protectPrivateFile } from "../util/private-reads.ts";
import { processCleanupStore, recoverProcessCleanups, redactCredentials } from "../util/proc.ts";

/** Protect retained credentials before integrations resume the land queue or start agents. */
export async function startDaemon(
  factory: Factory,
  ui: Record<string, Blob>,
  mount = mountIntegrations,
  serve = Bun.serve<undefined>,
  recover = recoverProcessCleanups,
) {
  return processCleanupStore.run(factory.store, () => startScopedDaemon(factory, ui, mount, serve, recover));
}

async function startScopedDaemon(
  factory: Factory,
  ui: Record<string, Blob>,
  mount: typeof mountIntegrations,
  serve: typeof Bun.serve<undefined>,
  recover: typeof recoverProcessCleanups,
) {
  const credential = createApiToken(factory.cfg.paths.home);
  const privateFiles: (() => void)[] = [];
  const protectAppKey = (cfg: Factory["cfg"]) => {
    if (cfg.githubApp) privateFiles.push(protectPrivateFile(cfg.githubApp.privateKeyPath));
  };
  let integrations: Awaited<ReturnType<typeof mount>> | undefined;
  let server: Awaited<ReturnType<typeof startHttp>> | undefined;
  let workers: Awaited<ReturnType<typeof startWorkerListener>>;
  let detachSlots = () => {};
  let detachReload = () => {};
  const stop = async (force?: boolean) => {
    detachReload();
    const results = await Promise.allSettled([
      Promise.resolve().then(() => integrations?.stop()),
      Promise.resolve().then(() => server?.stop(force)),
      Promise.resolve().then(() => workers?.stop()),
    ]);
    credential.release();
    detachSlots();
    for (const release of privateFiles) release();
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  try {
    detachSlots = await attachSlotPools(factory.store.db, factory.cfg.maxConcurrentGates);
    for (const [dir, files] of [
      ["worker-tls", ["key.pem"]],
      ["worker", ["token", "key.pem", "coordinator-fingerprint"]],
    ] as const) {
      const home = join(factory.cfg.paths.home, dir);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      for (const file of files) privateFiles.push(protectPrivateFile(join(home, file)));
    }
    protectAppKey(factory.cfg);
    detachReload = factory.onConfigValidated(protectAppKey);
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
    factory.start();
    void Promise.resolve()
      .then(() => recover(factory.store))
      .catch((error) => console.error(redactCredentials(`[process cleanup] ${(error as Error).message}`)));
    return { integrations, server: { ...server, stop } };
  } catch (error) {
    await stop(true).catch(() => {});
    throw error;
  }
}
