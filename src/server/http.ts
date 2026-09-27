import { BlockList, isIP } from "node:net";
import type { Server } from "bun";
import type { Factory } from "../app.ts";
import { ChatRequestSchema } from "../concierge.ts";
import type { CreateRunRequest, HealthResponse, RunStatus, StreamMessage } from "../core/types.ts";
import { computeProviderWorkload, computeStats } from "../db/stats.ts";

export interface HttpExtras {
  /** Extra routes contributed by integrations (webhooks, MCP). */
  routes?: Record<string, (req: Request, server: Server<undefined>) => Response | Promise<Response>>;
  /** HTML entry for the SPA (Bun HTML import). */
  ui?: unknown;
}

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const error = (message: string, status = 400) => json({ error: message }, status);

function sse(
  req: Request,
  server: Server<undefined>,
  subscribe: (send: (msg: unknown) => void) => () => void,
  backlog?: unknown[],
  eventId?: (msg: unknown) => number,
): Response {
  server.timeout(req, 0);
  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (msg: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`${eventId ? `id: ${eventId(msg)}\n` : ""}data: ${JSON.stringify(msg)}\n\n`),
          );
        } catch {
          cleanup?.();
        }
      };
      // Flush headers right away so EventSource fires `open` before the first real message.
      controller.enqueue(encoder.encode(": connected\n\n"));
      for (const m of backlog ?? []) send(m);
      const unsubscribe = subscribe(send);
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup?.();
        }
      }, 15_000);
      cleanup = () => {
        unsubscribe();
        clearInterval(keepAlive);
      };
      const abort = () => {
        cleanup?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", abort, { once: true });
      if (req.signal.aborted) abort();
    },
    cancel() {
      cleanup?.();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new Error("invalid JSON body");
  }
}

export function createHttpRoutes(factory: Factory, extras: HttpExtras = {}): Record<string, unknown> {
  const { store } = factory;
  const port = factory.cfg.port;
  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    new URL(factory.cfg.uiUrl).origin,
  ]);
  const handle =
    (
      fn: (
        req: Request & { params: Record<string, string> },
        server: Server<undefined>,
      ) => Response | Promise<Response>,
    ) =>
    async (req: Request & { params: Record<string, string> }, server: Server<undefined>) => {
      const path = new URL(req.url).pathname;
      // Anything arriving through the Cloudflare tunnel may only reach /webhooks/*.
      if (req.headers.has("cf-connecting-ip") && !path.startsWith("/webhooks/")) {
        return error("forbidden", 403);
      }
      // Runs execute code, so a web page in the operator's browser must not be able to create or
      // control them (CSRF against localhost): mutations need a local Origin (or none, as from the
      // CLI) and a JSON body type, which cross-origin pages can't send without a CORS preflight.
      // MCP enforces origins for every method and lets the SDK validate protocol bodies.
      if (
        path !== "/mcp" &&
        req.method !== "GET" &&
        req.method !== "HEAD" &&
        !path.startsWith("/webhooks/")
      ) {
        const origin = req.headers.get("origin");
        if (origin && !allowedOrigins.has(origin)) return error("cross-origin request refused", 403);
        const type = req.headers.get("content-type") ?? "";
        if (type.split(";")[0]?.trim().toLowerCase() !== "application/json") {
          return error("mutations require content-type: application/json", 415);
        }
      }
      try {
        return await fn(req, server);
      } catch (e) {
        return error((e as Error).message, 400);
      }
    };

  const drainState = () => ({
    draining: factory.scheduler.draining,
    active: factory.scheduler.activeRunIds,
  });
  const admin = (action: "drain" | "resume") => ({
    POST: handle((req, server) => {
      const peer = server.requestIP(req)?.address;
      if (!peer || !isIP(peer) || !loopback.check(peer, isIP(peer) === 6 ? "ipv6" : "ipv4")) {
        return error("admin endpoints require a loopback peer", 403);
      }
      factory.scheduler[action]();
      return json(drainState());
    }),
  });

  const conversation = (req: Request & { params: Record<string, string> }) => {
    const id = req.params.conversationId ?? "";
    // Discord conversations are a separate transport namespace.
    if (!/^[\w-]{1,128}$/.test(id)) throw new Error("Invalid conversation ID");
    return id;
  };
  const routes: Record<string, unknown> = {
    "/api/admin/drain": admin("drain"),
    "/api/admin/resume": admin("resume"),
    "/api/chat/:conversationId": {
      GET: handle((req) => json(factory.concierge.history(conversation(req)))),
    },
    "/api/chat/:conversationId/messages": {
      POST: handle(async (req) =>
        json(
          await factory.concierge.submit(
            conversation(req),
            ChatRequestSchema.parse(await body<unknown>(req)),
          ),
        ),
      ),
    },
    "/api/chat/:conversationId/stream": handle((req, server) => {
      const id = conversation(req);
      const url = new URL(req.url);
      const after = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid chat cursor");
      return sse(
        req,
        server,
        (send) =>
          store.subscribe((msg) => {
            if (msg.kind === "chat" && msg.message.conversationId === id && msg.message.id > after) send(msg);
          }),
        store.listChatMessages(id, after).map((message) => ({ kind: "chat", message })),
        (msg) => (msg as import("../core/types.ts").ChatStreamMessage).message.id,
      );
    }),
    "/api/health": handle(() =>
      json({
        ok: true,
        uptimeMs: Date.now() - factory.startedAt,
        sha: factory.bootSha,
        ...drainState(),
      } satisfies HealthResponse),
    ),
    "/api/gc": {
      POST: handle(async (req) => {
        const input = await body<{ dryRun?: boolean }>(req);
        return json(await factory.gc(input.dryRun === true));
      }),
    },
    "/api/evals": {
      POST: handle(async (req) => json({ id: factory.evals.submit(await body<unknown>(req)).id }, 202)),
      GET: handle(() => json(store.listEvalRuns())),
    },
    "/api/evals/policy": handle((req) => {
      const ids = new URL(req.url).searchParams.get("evals");
      return json(factory.evalPolicy(ids === null ? undefined : ids.split(",")));
    }),
    "/api/evals/:id": handle((req) => {
      const report = factory.evals.report(req.params.id ?? "", { delta: factory.evalSettings.delta });
      return report ? json(report) : error("eval not found", 404);
    }),
    "/api/runs": {
      GET: handle((req) => {
        const url = new URL(req.url);
        const status = url.searchParams.get("status")?.split(",").filter(Boolean) as RunStatus[] | undefined;
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return json(store.listRuns({ ...(status ? { status } : {}), limit }));
      }),
      POST: handle(async (req) => {
        const input = await body<CreateRunRequest>(req);
        const run = await factory.createRun({ ...input, source: input.source ?? "ui" });
        return json(run, 201);
      }),
    },
    "/api/runs/:id": handle((req) => {
      const detail = store.getRunDetail(req.params.id as string);
      return detail ? json(detail) : error("not found", 404);
    }),
    "/api/runs/:id/cancel": {
      POST: handle((req) => json({ cancelled: factory.cancelRun(req.params.id as string, "ui") })),
    },
    "/api/runs/:id/retry": {
      POST: handle(async (req) => json(await factory.retryRun(req.params.id as string), 201)),
    },
    "/api/runs/:id/answer": {
      POST: handle(async (req) => {
        const input = await body<{ answer: string; questionId?: number; by?: string }>(req);
        if (!input.answer?.trim()) return error("answer is required");
        return json(
          factory.answer(req.params.id as string, input.answer, input.by ?? "ui", input.questionId),
        );
      }),
    },
    "/api/runs/:id/events": handle((req) => {
      const url = new URL(req.url);
      const inv = url.searchParams.get("invocation");
      return json(
        store.listEvents(req.params.id as string, {
          after: Number(url.searchParams.get("after") ?? 0),
          tail: url.searchParams.get("tail") === "true",
          excludeDebug: url.searchParams.get("excludeDebug") === "true",
          limit: Math.min(5000, Number(url.searchParams.get("limit") ?? 1000)),
          ...(inv ? { invocationId: Number(inv) } : {}),
        }),
      );
    }),
    "/api/runs/:id/artifacts/:name": handle((req) => {
      const content = store.getArtifact(req.params.id as string, req.params.name as string);
      return content === null
        ? error("not found", 404)
        : new Response(content, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }),
    "/api/runs/:id/stream": handle((req, server) => {
      const runId = req.params.id as string;
      const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
      const backlog: StreamMessage[] = [];
      for (let cursor = after; ; ) {
        const page = store.listEvents(runId, { after: cursor, limit: 2000 });
        for (const event of page) backlog.push({ kind: "event", event });
        const last = page.at(-1);
        if (!last || page.length < 2000) break;
        cursor = last.id;
      }
      return sse(
        req,
        server,
        (send) =>
          store.subscribe((msg: StreamMessage) => {
            const id =
              msg.kind === "run"
                ? msg.run.id
                : msg.kind === "stage"
                  ? msg.stage.runId
                  : msg.kind === "invocation"
                    ? msg.invocation.runId
                    : msg.kind === "event"
                      ? msg.event.runId
                      : msg.kind === "question"
                        ? msg.question.runId
                        : null;
            if (id === runId) send(msg);
          }),
        backlog,
      );
    }),
    "/api/stream": handle((req, server) =>
      sse(req, server, (send) =>
        store.subscribe((msg) => {
          if (msg.kind !== "event" && msg.kind !== "chat") send(msg);
        }),
      ),
    ),
    "/api/repos": {
      GET: handle(() => json(store.listRepos())),
    },
    "/api/providers": handle(() => json(factory.tracker.all())),
    "/api/stats/providers": handle(() => json(computeProviderWorkload(store))),
    "/api/providers/:id/enable": {
      POST: handle((req) => json(factory.tracker.setEnabled(req.params.id ?? "", true))),
    },
    "/api/providers/:id/disable": {
      POST: handle((req) => json(factory.tracker.setEnabled(req.params.id ?? "", false))),
    },
    "/api/alerts": handle(() => {
      factory.tracker.refreshAlerts();
      return json(store.listAlerts(factory.tracker.now()));
    }),
    "/api/models": handle(() => json({ models: factory.models, policy: factory.policy })),
    "/api/stats": handle((req) => {
      const days = Number(new URL(req.url).searchParams.get("days") ?? 14);
      return json(computeStats(store, days));
    }),
  };

  for (const [path, fn] of Object.entries(extras.routes ?? {})) routes[path] = handle(fn);
  if (extras.ui) {
    routes["/"] = extras.ui;
    routes["/runs/*"] = extras.ui;
    routes["/new"] = extras.ui;
    routes["/models"] = extras.ui;
    routes["/chat"] = extras.ui;
  }

  return routes;
}

export function startHttp(factory: Factory, extras: HttpExtras = {}): Server<undefined> {
  return Bun.serve({
    hostname: factory.cfg.host,
    port: factory.cfg.port,
    development: process.env.NODE_ENV !== "production" && process.env.LIMITLESS_DEV === "1",
    routes: createHttpRoutes(factory, extras) as never,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/api/")) return error("not found", 404);
      return new Response("Not found", { status: 404 });
    },
  });
}
