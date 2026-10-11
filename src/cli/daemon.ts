import type { Factory } from "../app.ts";
import { mountIntegrations } from "../integrations/index.ts";
import { createApiToken } from "../server/api-token.ts";
import { startHttp } from "../server/http.ts";

/** Register the token deny before integrations resume the land queue or start any agents. */
export async function startDaemon(factory: Factory, ui: Record<string, Blob>, mount = mountIntegrations) {
  const credential = createApiToken(factory.cfg.paths.home);
  let integrations: Awaited<ReturnType<typeof mount>> | undefined;
  let server: ReturnType<typeof startHttp> | undefined;
  try {
    integrations = await mount(factory);
    server = startHttp(factory, { ui, routes: integrations.routes }, undefined, credential);
    factory.start();
    return { integrations, server };
  } catch (error) {
    try {
      await Promise.all([integrations?.stop(), server?.stop(true)]);
    } finally {
      credential.release();
    }
    throw error;
  }
}
