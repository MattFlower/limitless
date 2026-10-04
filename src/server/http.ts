import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Server } from "bun";
import type { Factory } from "../app.ts";
import { ChatRequestSchema } from "../concierge.ts";
import type { CreateRunRequest, HealthResponse, RunStatus, StreamMessage } from "../core/types.ts";
import { computeProviderWorkload, computeStats } from "../db/stats.ts";
import { FeedAckSchema, parseFeedParams, waitForFeed } from "../feed.ts";
import { gateSlots } from "../gates/slots.ts";
import { runGh } from "../integrations/github.ts";
import { ResolveRunSchema, resolveConflict } from "../integrations/mcp.ts";
import { ReviewRefused, submitReview } from "../pipeline/review-round.ts";
import { ghPrHistory, shadowReport } from "../pipeline/shadow-report.ts";
import { classifyRequest, publicHost } from "./access.ts";
import { Auth, CLEAR_SESSION, enrollPage, localPath, loginPage } from "./auth.ts";
import { Passkeys } from "./passkeys.ts";

export interface HttpExtras {
  /** Extra routes contributed by integrations (webhooks, MCP). */
  routes?: Record<string, (req: Request, server: Server<undefined>) => Response | Promise<Response>>;
  /** Bundled SPA files, served through the same authorization as the API. */
  ui?: Record<string, Blob>;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const error = (message: string, status = 400) => json({ error: message }, status);

function sse(
  req: Request,
  server: Server<undefined>,
  subscribe: (send: (msg: unknown) => void) => () => void,
  {
    backlog = [],
    eventId,
    alive = () => true,
  }: { backlog?: unknown[]; eventId?: (msg: unknown) => number; alive?: () => boolean } = {},
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
      for (const m of backlog) send(m);
      // A stream outlives the request that opened it, so it ends when its sign-in does.
      const unsubscribe = subscribe((msg) => (alive() ? send(msg) : abort()));
      const keepAlive = setInterval(() => {
        if (!alive()) return abort();
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
  const auth = new Auth(store, factory.cfg);
  /** Requests admitted by a session cookie; their streams end with the session. */
  const signedIn = new WeakSet<Request>();
  const live = (req: Request) => () => !signedIn.has(req) || auth.session(req.headers) !== null;
  const passkeys = new Passkeys(store, factory.cfg);
  /** Reachable without a session: signing in, and enrolling with a one-time link. */
  const signInPath = (path: string) =>
    path === "/login" || path === "/enroll" || path.startsWith("/api/auth/passkey/");
  const handle =
    (
      fn: (
        req: Request & { params: Record<string, string> },
        server: Server<undefined>,
      ) => Response | Promise<Response>,
      localOnly = false,
    ) =>
    async (req: Request & { params: Record<string, string> }, server: Server<undefined>) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const access = classifyRequest(
        server.requestIP(req)?.address ?? null,
        req.headers,
        factory.cfg.trustedProxies,
      );
      if (
        access === "denied" ||
        (localOnly && access !== "loopback") ||
        (access === "tunnel" && !path.startsWith("/webhooks/")) ||
        (access !== "loopback" &&
          (path === "/mcp" || path === "/api/admin" || path.startsWith("/api/admin/"))) ||
        (access === "proxy" && !publicHost(req.headers.get("host"), factory.cfg.publicOrigins))
      )
        return error("forbidden", 403);
      if (
        access === "proxy" &&
        factory.cfg.auth === "required" &&
        !signInPath(path) &&
        !path.startsWith("/webhooks/")
      ) {
        if (auth.session(req.headers)) signedIn.add(req);
        else if (path.startsWith("/api/")) return error("sign-in required", 401);
        else {
          const next = encodeURIComponent(path + url.search);
          return new Response(null, { status: 303, headers: { location: `/login?next=${next}` } });
        }
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
        if (
          access === "proxy"
            ? !origin || !factory.cfg.publicOrigins.includes(origin)
            : origin && !allowedOrigins.has(origin)
        )
          return error("cross-origin request refused", 403);
        const type = req.headers.get("content-type") ?? "";
        // The sign-in form is a plain HTML form so password managers can fill it; Origin still applies.
        if (path !== "/login" && type.split(";")[0]?.trim().toLowerCase() !== "application/json") {
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
    parked: factory.scheduler.parkedRunIds,
  });
  const admin = (action: "drain" | "resume") => ({
    POST: handle(() => {
      factory.scheduler[action]();
      return json(drainState());
    }, true),
  });

  const signOut = (req: Request, everywhere: boolean) => {
    const id = auth.session(req.headers)?.id;
    const revoked = everywhere ? store.revokeAuthSessions() : id ? store.revokeAuthSessions(id) : 0;
    const headers = { "content-type": "application/json", "set-cookie": CLEAR_SESSION };
    return new Response(JSON.stringify({ revoked }), { headers });
  };

  const passkeySession = (req: Request) => {
    const cookie = auth.signIn("passkey", req.headers.get("user-agent") ?? "");
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json", "set-cookie": cookie },
    });
  };

  const conversation = (req: Request & { params: Record<string, string> }) => {
    const id = req.params.conversationId ?? "";
    // Discord conversations are a separate transport namespace.
    if (!/^[\w-]{1,128}$/.test(id)) throw new Error("Invalid conversation ID");
    return id;
  };
  const routes: Record<string, unknown> = {
    "/api/admin/gate-slot": {
      POST: handle(async (req) => {
        if (req.headers.has("forwarded")) return error("forbidden", 403);
        const { name, id, release, immediate, running } = await body<Record<string, unknown>>(req);
        if (id !== undefined) {
          if (typeof id !== "string" || (release !== undefined && typeof release !== "boolean"))
            return error("invalid lease");
          const acquired = gateSlots.heartbeat(id, release === true);
          return json({ id, acquired: acquired ?? false, expired: acquired === undefined });
        }
        if (typeof name !== "string" || !name.trim()) return error("invalid holder name");
        if (running !== undefined && typeof running !== "boolean") return error("invalid running flag");
        req.signal.throwIfAborted();
        const lease = await gateSlots.lease(name, immediate === true, undefined, undefined, running === true);
        if (req.signal.aborted) gateSlots.heartbeat(lease, true);
        req.signal.throwIfAborted();
        return json({ id: lease, acquired: gateSlots.heartbeat(lease) ?? false });
      }, true),
    },
    "/api/admin/drain": admin("drain"),
    "/api/admin/resume": admin("resume"),
    "/api/admin/auth/password": {
      POST: handle(async (req) => {
        await auth.setPassword((await body<{ password?: unknown }>(req)).password);
        return json({ ok: true });
      }, true),
    },
    "/api/admin/auth/sessions": { GET: handle(() => json(auth.sessions()), true) },
    "/api/admin/auth/sessions/revoke": {
      POST: handle(async (req) => {
        const { id, all } = await body<{ id?: unknown; all?: unknown }>(req);
        if (all === true) return json({ revoked: store.revokeAuthSessions() });
        if (typeof id !== "string") throw new Error("pass a session id or all: true");
        return json({ revoked: store.revokeAuthSessions(id) });
      }, true),
    },
    "/login": {
      GET: handle((req) => loginPage(localPath(new URL(req.url).searchParams.get("next")))),
      POST: handle((req, server) => auth.passwordSignIn(req, server.requestIP(req)?.address ?? "")),
    },
    "/api/admin/auth/enroll": { POST: handle(() => json({ url: passkeys.enrollLink() }), true) },
    "/api/admin/auth/passkeys": { GET: handle(() => json(store.listPasskeys()), true) },
    "/api/admin/auth/passkeys/remove": {
      POST: handle(async (req) => {
        const { id } = await body<{ id?: unknown }>(req);
        if (typeof id !== "string") throw new Error("pass a passkey id");
        return json({ removed: store.removePasskey(id) });
      }, true),
    },
    "/enroll": handle(() => enrollPage()),
    "/api/auth/passkey/register/options": {
      POST: handle(async (req) =>
        json(await passkeys.registrationOptions((await body<{ token?: unknown }>(req)).token)),
      ),
    },
    "/api/auth/passkey/register": {
      POST: handle(async (req) => {
        const { token, response } = await body<{ token?: unknown; response: RegistrationResponseJSON }>(req);
        await passkeys.register(token, response, req.headers.get("user-agent") ?? "");
        return passkeySession(req);
      }),
    },
    "/api/auth/passkey/login/options": {
      POST: handle(async () => json(await passkeys.authenticationOptions())),
    },
    "/api/auth/passkey/login": {
      POST: handle(async (req) =>
        (await passkeys.authenticate(await body<AuthenticationResponseJSON>(req)))
          ? passkeySession(req)
          : error("passkey sign-in failed", 401),
      ),
    },
    "/api/auth/session": handle((req) => json({ session: auth.session(req.headers) })),
    "/api/auth/logout": { POST: handle((req) => signOut(req, false)) },
    "/api/auth/logout-all": { POST: handle((req) => signOut(req, true)) },
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
        {
          backlog: store.listChatMessages(id, after).map((message) => ({ kind: "chat", message })),
          eventId: (msg) => (msg as import("../core/types.ts").ChatStreamMessage).message.id,
          alive: live(req),
        },
      );
    }),
    "/api/health": handle(() =>
      json({
        ok: true,
        uptimeMs: Date.now() - factory.startedAt,
        sha: factory.bootSha,
        gateSlots: gateSlots.snapshot(),
        ...drainState(),
      } satisfies HealthResponse),
    ),
    "/api/gc": {
      POST: handle(async (req) => {
        const input = await body<{ dryRun?: boolean }>(req);
        return json(await factory.gc(input.dryRun === true));
      }),
    },
    "/api/review/shadow-report": handle(async (req) => {
      const since = Number(new URL(req.url).searchParams.get("since") ?? 0);
      if (!Number.isFinite(since)) return error("since must be epoch milliseconds", 400);
      const trusted = factory.cfg.reviewTrustedReviewers;
      return json(await shadowReport(store, ghPrHistory(runGh), { since, trusted }));
    }),
    "/api/gates/clear-cache": {
      POST: handle(async (req) => {
        const input = await body<{ repo?: string }>(req);
        if (input.repo === undefined) return json({ cleared: store.clearBaselineCache() });
        const repo = store.getRepoBySlug(input.repo);
        return repo ? json({ cleared: store.clearBaselineCache(repo.id) }) : error("repo not found", 404);
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
    "/api/evals/:id/regrade": {
      POST: handle((req) => {
        const result = factory.evals.regrade(req.params.id ?? "");
        return result ? json(result) : error("eval not found", 404);
      }),
    },
    "/api/evals/:id/resume": {
      POST: handle((req) => {
        const run = factory.evals.resume(req.params.id ?? "");
        return run ? json({ id: run.id, resumedFrom: run.resumedFrom }, 202) : error("eval not found", 404);
      }),
    },
    "/api/evals/:id/cancel": {
      POST: handle(async (req) => {
        const run = await factory.evals.cancel(req.params.id ?? "");
        return run ? json({ id: run.id, status: run.status }) : error("eval not found", 404);
      }),
    },
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
    "/api/feed": {
      GET: handle(async (req, server) => {
        const query = parseFeedParams(new URL(req.url).searchParams);
        // Bun's default idle timeout would cut a long poll short.
        server.timeout(req, Math.ceil(query.wait) + 30);
        return json(await waitForFeed(store, query, req.signal));
      }),
    },
    "/api/feed/ack": {
      POST: handle(async (req) => {
        const { consumer, id } = FeedAckSchema.parse(await body<unknown>(req));
        return json(store.ackFeed(consumer, id));
      }),
    },
    "/api/runs/:id": handle((req) => {
      const detail = store.getRunDetail(req.params.id as string);
      if (!detail) return error("not found", 404);
      const path = join(factory.cfg.paths.work, detail.run.id);
      return json({ ...detail, worktreePath: detail.run.branch && existsSync(path) ? path : null });
    }),
    "/api/runs/:id/cancel": {
      POST: handle((req) => json({ cancelled: factory.cancelRun(req.params.id as string, "ui") })),
    },
    "/api/runs/:id/retry": {
      POST: handle(async (req) => json(await factory.retryRun(req.params.id as string), 201)),
    },
    "/api/runs/:id/resolve": {
      POST: handle(async (req) => {
        const input = ResolveRunSchema.safeParse(await body<unknown>(req));
        if (!input.success) return error(`invalid resolution: ${input.error.issues[0]?.message ?? ""}`);
        const id = req.params.id as string;
        if (!store.getRun(id)) return error("run not found", 404);
        const run = store.resolveRun(id, { ...input.data, by: "human" });
        return run ? json(run) : error(resolveConflict(store.getRun(id)?.status ?? "resolved"), 409);
      }, true),
    },
    "/api/runs/:id/review": {
      POST: handle(async (req) => {
        try {
          const result = await submitReview(factory, req.params.id as string, await body<unknown>(req));
          return json(result, "round" in result ? 201 : 200);
        } catch (e) {
          if (e instanceof ReviewRefused) return error(e.message, e.status);
          throw e;
        }
      }, true),
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
                        : msg.kind === "feed"
                          ? msg.item.runId
                          : null;
            if (id === runId) send(msg);
          }),
        { backlog, alive: live(req) },
      );
    }),
    "/api/stream": handle((req, server) =>
      sse(
        req,
        server,
        (send) =>
          store.subscribe((msg) => {
            if (msg.kind !== "event" && msg.kind !== "chat") send(msg);
          }),
        { alive: live(req) },
      ),
    ),
    "/api/github/access": handle(() => json(store.githubAccessProblems())),
    "/api/repos": {
      GET: handle(() => json(store.listRepos())),
    },
    "/api/providers": handle(() => json(factory.tracker.all())),
    "/api/stats/providers": handle(() => json(computeProviderWorkload(store))),
    "/api/providers/:id/fast": {
      POST: handle(async (req) => {
        const data = await body<{ on?: unknown } | null>(req);
        if (typeof data?.on !== "boolean") throw new Error("on must be a boolean");
        return json(factory.tracker.setFast(req.params.id ?? "", data.on));
      }),
    },
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

  for (const [path, fn] of Object.entries(extras.routes ?? {})) routes[path] = handle(fn, path === "/mcp");
  if (extras.ui) {
    for (const [path, file] of Object.entries(extras.ui)) routes[path] = handle(() => new Response(file));
    const index = extras.ui["/index.html"];
    if (index)
      for (const path of ["/", "/runs/*", "/new", "/models", "/providers", "/chat", "/evals", "/evals/*"])
        routes[path] = handle(() => new Response(index));
  }
  routes["/*"] = handle((req) =>
    new URL(req.url).pathname.startsWith("/api/")
      ? error("not found", 404)
      : new Response("Not found", { status: 404 }),
  );
  return routes;
}

export function startHttp(factory: Factory, extras: HttpExtras = {}, serve = Bun.serve<undefined>) {
  const routes = createHttpRoutes(factory, extras);
  const bind = (hostname: string) =>
    serve({
      hostname,
      port: factory.cfg.port,
      development: process.env.NODE_ENV !== "production" && process.env.LIMITLESS_DEV === "1",
      routes: routes as never,
      fetch: routes["/*"] as (req: Request, server: Server<undefined>) => Promise<Response>,
    });
  const local = bind(factory.cfg.host);
  let lan: Server<undefined> | undefined;
  try {
    if (factory.cfg.listenLan) lan = bind(factory.cfg.listenLan);
  } catch (error) {
    void local.stop(true);
    throw error;
  }
  return {
    port: local.port,
    url: local.url,
    stop: async (force?: boolean) => {
      await Promise.all([local.stop(force), lan?.stop(force)]);
    },
  };
}
