import { join } from "node:path";
import type { Server } from "bun";
import type { Paths } from "../config.ts";
import { PairingLimitError, type WorkerStore } from "../db/workers.ts";
import { Claim, Heartbeat, Pair } from "../workers/protocol.ts";
import { certificate } from "../workers/tls.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
export async function startWorkerListener(
  workers: WorkerStore,
  paths: Paths,
  listen?: string,
  log: (text: string) => void = console.log,
) {
  if (!listen) return undefined;
  const tls = await certificate(join(paths.home, "worker-tls"));
  workers.pairingKey = tls.key;
  const limits = new Map<string, { at: number; count: number }>();
  const fetch = async (req: Request, server: Server<undefined>): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/worker/")) return new Response(null, { status: 404 });
    try {
      if (path === "/worker/pair" && req.method === "POST") {
        const ip = server.requestIP(req)?.address ?? "unknown",
          now = workers.now();
        for (const [key, limit] of limits) if (now - limit.at >= 60_000) limits.delete(key);
        if (!limits.has(ip) && limits.size >= 1024)
          return json({ error: "Pairing rate limit exceeded" }, 429);
        const limit = limits.get(ip) ?? { at: now, count: 0 };
        limits.set(ip, limit);
        if (++limit.count >= 5) return json({ error: "Pairing rate limit exceeded" }, 429);
        const p = Pair.parse(await req.json());
        const pending = workers.pair(p.name, p.fingerprint);
        log(`Worker pairing code: ${pending.code}`);
        return json(pending);
      }
      if (path === "/worker/pair/claim" && req.method === "POST")
        return json(workers.claim(Claim.parse(await req.json()).secret));
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get("authorization") ?? "")?.[1];
      const worker = token ? workers.authenticate(token) : null;
      if (!worker) return json({ error: "Worker authentication required" }, 401);
      if (path === "/worker/heartbeat" && req.method === "POST") {
        const capabilities = Heartbeat.parse(await req.json());
        const current = workers.authenticate(token ?? "");
        if (!current) return json({ error: "Worker revoked" }, 401);
        return json(workers.heartbeat(current, capabilities));
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      return json({ error: "Invalid worker request" }, error instanceof PairingLimitError ? 429 : 400);
    }
  };
  const split = listen.lastIndexOf(":"),
    hostname = listen.slice(0, split).replace(/^\[|\]$/g, "");
  try {
    const server = Bun.serve({
      hostname,
      port: Number(listen.slice(split + 1)),
      tls: { key: tls.key, cert: tls.cert },
      maxRequestBodySize: 2 * 1024 * 1024,
      idleTimeout: 60,
      fetch,
    });
    return {
      url: server.url,
      tls,
      async stop() {
        await server.stop(true);
        tls.release();
      },
    };
  } catch (error) {
    tls.release();
    throw error;
  }
}
