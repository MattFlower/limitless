import type { Factory } from "../app.ts";
import { mountIntegrations } from "../integrations/index.ts";
import { createApiToken } from "../server/api-token.ts";
import { startHttp } from "../server/http.ts";

/** Register the token deny before integrations resume the land queue or start any agents. */
export async function startDaemon(
  factory: Factory,
  ui: Record<string, Blob>,
  mount = mountIntegrations,
  serve = Bun.serve<undefined>,
) {
  const credential = createApiToken(factory.cfg.paths.home);
  let integrations: Awaited<ReturnType<typeof mount>> | undefined;
  let server: ReturnType<typeof startHttp> | undefined;
  const stop = async (force?: boolean) => {
    const results = await Promise.allSettled([
      Promise.resolve().then(() => integrations?.stop()),
      Promise.resolve().then(() => server?.stop(force)),
    ]);
    credential.release();
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  try {
    integrations = await mount(factory);
    server = startHttp(factory, { ui, routes: integrations.routes }, serve, credential);
    factory.start();
    return { integrations, server: { ...server, stop } };
  } catch (error) {
    await stop(true).catch(() => {});
    throw error;
  }
}
