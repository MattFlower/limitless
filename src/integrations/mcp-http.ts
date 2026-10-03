import { isIP } from "node:net";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Factory } from "../app.ts";
import { createMcpServer, factoryBackend } from "./mcp.ts";

function loopback(address: string): boolean {
  if (address === "::1") return true;
  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return isIP(ipv4) === 4 && ipv4.startsWith("127.");
}

/** Stateless request/response MCP: no client disconnect can affect daemon-owned runs. */
export function mountMcp(factory: Factory) {
  const allowedOrigins = new Set([
    `http://127.0.0.1:${factory.cfg.port}`,
    `http://localhost:${factory.cfg.port}`,
    new URL(factory.cfg.uiUrl).origin,
  ]);
  const active = new Set<ReturnType<typeof createMcpServer>>();
  let stopped = false;
  return {
    async handle(req: Request, address: string | null): Promise<Response> {
      const origin = req.headers.get("origin");
      const host = new URL(req.url).hostname;
      if (
        req.headers.has("cf-connecting-ip") ||
        !address ||
        !loopback(address) ||
        (origin !== null && !allowedOrigins.has(origin)) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(host)
      ) {
        return new Response("forbidden", { status: 403 });
      }
      if (stopped) return new Response("MCP is stopping", { status: 503 });
      // This surface provides no subscriptions or sessions, so there is no GET stream or DELETE session.
      if (req.method !== "POST") {
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed" } },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      const backend = factoryBackend(factory);
      // The SDK's JSON-response transport never aborts a tool when the HTTP client disconnects,
      // so a feed long poll would otherwise keep its listener until the wait ends.
      const server = createMcpServer({
        ...backend,
        feed: (query, signal) => backend.feed(query, AbortSignal.any([signal, req.signal])),
      });
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      active.add(server);
      try {
        await server.connect(transport);
        return await transport.handleRequest(req);
      } finally {
        active.delete(server);
        await server.close();
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      await Promise.all([...active].map((server) => server.close()));
      active.clear();
    },
  };
}
