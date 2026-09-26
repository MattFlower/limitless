import type { Server } from "bun";
import type { Factory } from "../app.ts";
import type { CreateRunRequest, RunStatus, StreamMessage } from "../core/types.ts";
import { computeStats } from "../db/stats.ts";
import { DEFAULT_POLICY, MODELS } from "../router/catalog.ts";

export interface HttpExtras {
  /** Extra routes contributed by integrations (webhooks, MCP). */
  routes?: Record<string, (req: Request, server: Server<undefined>) => Response | Promise<Response>>;
  /** HTML entry for the SPA (Bun HTML import). */
  ui?: unknown;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const error = (message: string, status = 400) => json({ error: message }, status);

function sse(
  req: Request,
  server: Server<undefined>,
  subscribe: (send: (msg: unknown) => void) => () => void,
  backlog?: unknown[],
): Response {
  server.timeout(req, 0);
  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (msg: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
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
      req.signal.addEventListener("abort", () => {
        cleanup?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
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
        if (!type.toLowerCase().startsWith("application/json")) {
          return error("mutations require content-type: application/json", 415);
        }
      }
      try {
        return await fn(req, server);
      } catch (e) {
        return error((e as Error).message, 400);
      }
    };

  const routes: Record<string, unknown> = {
    "/api/health": handle(() =>
      json({ ok: true, uptimeMs: Date.now() - factory.startedAt, active: factory.scheduler.activeRunIds }),
    ),
    "/api/gc": {
      POST: handle(async (req) => {
        const input = await body<{ dryRun?: boolean }>(req);
        return json(await factory.gc(input.dryRun === true));
      }),
    },
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
          if (msg.kind !== "event") send(msg);
        }),
      ),
    ),
    "/api/repos": {
      GET: handle(() => json(store.listRepos())),
    },
    "/api/providers": handle(() => json(factory.tracker.all())),
    "/api/alerts": handle(() => {
      factory.tracker.refreshAlerts();
      return json(store.listAlerts(factory.tracker.now()));
    }),
    "/api/models": handle(() => json({ models: MODELS, policy: DEFAULT_POLICY })),
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
