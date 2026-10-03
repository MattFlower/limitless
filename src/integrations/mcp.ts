import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Factory } from "../app.ts";
import type { CreateRunRequest, FeedAck, RunStatus } from "../core/types.ts";
import { FeedAckSchema, FeedQuerySchema, waitForFeed } from "../feed.ts";

const nonblank = z.string().trim().min(1);
const status = z.enum([
  "queued",
  "waiting",
  "running",
  "waiting_input",
  "succeeded",
  "failed",
  "cancelled",
  "needs_human",
  "resolved",
]);
const profile = z.enum(["auto", "quick", "standard", "deep"]);
const runSchema = z
  .object({
    id: nonblank,
    repoSlug: nonblank,
    title: z.string(),
    status,
    dependsOn: z.array(nonblank).default([]),
    profile,
    stage: z.string().nullable(),
    prUrl: z.string().nullable(),
    costUsd: z.number(),
    costEquivUsd: z.number(),
    error: z.string().nullable(),
  })
  .passthrough();
const questionSchema = z.object({
  id: z.number().int(),
  runId: nonblank,
  question: z.string(),
  answer: z.string().nullable(),
  askedAt: z.number(),
  answeredAt: z.number().nullable(),
  answeredBy: z.string().nullable(),
});
const eventSchema = z.object({
  id: z.number().int(),
  runId: nonblank,
  invocationId: z.number().nullable(),
  ts: z.number(),
  type: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  data: z.unknown(),
});
const feedPageSchema = z.object({
  items: z.array(z.object({ id: z.number().int(), kind: z.string(), title: z.string() }).passthrough()),
  nextAfter: z.number().int(),
  pruned: z.boolean(),
});
const feedArgsSchema = FeedQuerySchema.omit({ limit: true }).extend({
  wait: z.number().min(0).max(45).default(0),
});
const detailSchema = z.object({ run: runSchema, questions: z.array(questionSchema) });
const providersSchema = z.array(
  z.object({
    id: nonblank,
    label: z.string(),
    billing: z.enum(["subscription", "metered", "free"]),
    enabled: z.boolean(),
    state: z.enum(["ok", "degraded", "down", "exhausted", "disabled"]),
    reason: z.string().nullable(),
    until: z.number().nullable(),
    windows: z.record(
      z.string(),
      z.object({
        utilization: z.number(),
        resetsAt: z.number().nullable(),
        observedAt: z.number().nullable().optional(),
      }),
    ),
    spendUsd: z.number().nullable(),
    budgetUsd: z.number().nullable(),
    inFlight: z.number(),
    maxConcurrent: z.number(),
    updatedAt: z.number(),
  }),
);

export interface McpBackend {
  create(input: CreateRunRequest): Promise<unknown>;
  detail(id: string): Promise<unknown>;
  events(id: string): Promise<unknown>;
  list(status: RunStatus | undefined, limit: number): Promise<unknown>;
  cancel(id: string): Promise<unknown>;
  answer(id: string, answer: string): Promise<unknown>;
  providers(): Promise<unknown>;
  feed(query: z.output<typeof feedArgsSchema>, signal: AbortSignal): Promise<unknown>;
  feedAck(ack: FeedAck): Promise<unknown>;
}

export function factoryBackend(factory: Factory): McpBackend {
  const requireRun = (id: string) => {
    const detail = factory.store.getRunDetail(id);
    if (!detail) throw new Error(`run ${id} not found`);
    return detail;
  };
  return {
    create: async (input) => factory.createRun({ ...input, source: "mcp" }),
    detail: async (id) => requireRun(id),
    events: async (id) => factory.store.listEvents(id, { tail: true, excludeDebug: true, limit: 20 }),
    list: async (status, limit) => factory.store.listRuns({ status: status ? [status] : undefined, limit }),
    cancel: async (id) => {
      requireRun(id);
      return { cancelled: factory.cancelRun(id, "mcp") };
    },
    answer: async (id, answer) => {
      requireRun(id);
      return factory.answer(id, answer, "mcp");
    },
    providers: async () => factory.tracker.all(),
    feed: (query, signal) => waitForFeed(factory.store, { ...query, limit: 100 }, signal),
    feedAck: async ({ consumer, id }) => factory.store.ackFeed(consumer, id),
  };
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function httpBackend(base: string, fetcher: Fetch = fetch): McpBackend {
  const api = async (path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(`${base.replace(/\/$/, "")}${path}`, {
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
        signal: signal ?? AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(
        `Cannot reach the Limitless daemon at ${base}: ${String(e)}. Start limitless serve. Mutation outcomes may be unknown; inspect runs before retrying.`,
      );
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`Daemon HTTP ${response.status}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Malformed JSON response from daemon (${path})`);
    }
  };
  const path = (id: string) => `/api/runs/${encodeURIComponent(id)}`;
  return {
    create: (input) => api("/api/runs", { ...input, source: "mcp" }),
    detail: (id) => api(path(id)),
    events: (id) =>
      api(`${path(id)}/events?${new URLSearchParams({ tail: "true", excludeDebug: "true", limit: "20" })}`),
    list: (status, limit) =>
      api(`/api/runs?${new URLSearchParams({ limit: String(limit), ...(status ? { status } : {}) })}`),
    cancel: async (id) => {
      // The existing cancel endpoint returns false for unknown ids. Preserve MCP's not-found semantics.
      detailSchema.parse(await api(path(id)));
      return api(`${path(id)}/cancel`, {});
    },
    answer: async (id, answer) => {
      detailSchema.parse(await api(path(id)));
      return api(`${path(id)}/answer`, { answer, by: "mcp" });
    },
    providers: () => api("/api/providers"),
    feed: (query, signal) => {
      const params = Object.entries(query).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]]));
      // The daemon holds a long poll for up to `wait` seconds; cancellation still ends it early.
      const timeout = AbortSignal.timeout((query.wait + 30) * 1000);
      return api(`/api/feed?${new URLSearchParams(params)}`, undefined, AbortSignal.any([timeout, signal]));
    },
    feedAck: (ack) => api("/api/feed/ack", ack),
  };
}

/** Both transports share schemas, caller guidance, and JSON result formatting. */
export function createMcpServer(backend: McpBackend): Server {
  function tool<S extends z.ZodType>(
    name: string,
    description: string,
    schema: S,
    execute: (input: z.output<S>, signal: AbortSignal) => Promise<unknown>,
  ) {
    return {
      name,
      description,
      inputSchema: z.toJSONSchema(schema, { io: "input" }),
      execute: async (input: unknown, signal: AbortSignal) => {
        const args = schema.parse(input);
        try {
          return await execute(args, signal);
        } catch (e) {
          if (e instanceof z.ZodError) throw new Error(`Malformed backend response: ${e.message}`);
          throw e;
        }
      },
    };
  }
  const idSchema = z.object({ id: nonblank }).strict();
  const tools = [
    tool(
      "limitless_create_run",
      "Delegate asynchronous repository work to the factory. Use for long-running or background tasks. Supply repo (owner/name or absolute path on the daemon machine), a self-contained prompt, optional title and profile (auto by default), and dependsOn run IDs to wait for their PRs to merge. Returns the created run with id and current status immediately; completion and a PR are not guaranteed. Repository delivery policy applies.",
      z
        .object({
          repo: nonblank,
          prompt: nonblank,
          title: nonblank.optional(),
          dependsOn: z.array(nonblank).optional(),
          profile: profile.default("auto"),
        })
        .strict(),
      async (input) => runSchema.parse(await backend.create({ ...input, source: "mcp" })),
    ),
    tool(
      "limitless_get_run",
      "Inspect progress or follow up on a delegated run by id. Returns id, repository, title, status, nullable stage and prUrl, separate actual costUsd and subscription-equivalent costEquivUsd, error, open questions, and the latest 20 non-debug events in ascending event-id order. Unknown ids are errors.",
      idSchema,
      async ({ id }) => {
        const { run, questions } = detailSchema.parse(await backend.detail(id));
        const events = z.array(eventSchema).parse(await backend.events(id));
        return {
          id: run.id,
          repository: run.repoSlug,
          title: run.title,
          status: run.status,
          dependsOn: run.dependsOn,
          stage: run.stage,
          prUrl: run.prUrl,
          costUsd: run.costUsd,
          costEquivUsd: run.costEquivUsd,
          error: run.error,
          questions: questions.filter((q) => q.answer === null),
          events,
        };
      },
    ),
    tool(
      "limitless_list_runs",
      "Find delegated work or check the queue before creating duplicate work. Accepts optional status (one run status) and integer limit (default 20, range 1–100). Returns runs newest-first, with ids, status and cost fields; without status returns all statuses.",
      z.object({ status: status.optional(), limit: z.number().int().min(1).max(100).default(20) }).strict(),
      async ({ status, limit }) => z.array(runSchema).parse(await backend.list(status, limit)),
    ),
    tool(
      "limitless_cancel_run",
      "Request cancellation when work is no longer wanted. Supply id. Returns {cancelled:true} when requested, not confirmation that an active worker has stopped; inspect the run again. Returns {cancelled:false} for a terminal run. Unknown ids are errors.",
      idSchema,
      async ({ id }) => z.object({ cancelled: z.boolean() }).parse(await backend.cancel(id)),
    ),
    tool(
      "limitless_answer_question",
      "Unblock a run after inspecting its open questions. Supply id and a nonblank answer that addresses every open question. Returns the questions answered, with answer and attribution. Applies to all currently open questions; unknown ids or no open questions are errors.",
      z.object({ id: nonblank, answer: nonblank }).strict(),
      async ({ id, answer }) =>
        z
          .array(questionSchema)
          .min(1)
          .parse(await backend.answer(id, answer)),
    ),
    tool(
      "limitless_providers",
      "Check capacity or diagnose delayed work before delegating. Takes no arguments. Returns each provider's enabled/state/reason, quota windows and reset times, spend/budget and concurrency as tracked by the daemon. Missing telemetry stays null or empty; no credentials are returned.",
      z.object({}).strict(),
      async () => providersSchema.parse(await backend.providers()),
    ),
    tool(
      "limitless_feed",
      "Catch up on what needs action (PRs opened, questions, failures, needs_human, merges, finished evals, daemon restarts) across all runs. Supply consumer (your stable name) to read after its acknowledged cursor, or after for an explicit cursor; wait (0–45 seconds, within client timeouts) long-polls until a new item arrives. Returns {items, nextAfter, pruned} in ascending id order; pruned means retention removed items you never acknowledged. Reading never acknowledges: call limitless_feed_ack with nextAfter only after you have handled the items.",
      feedArgsSchema,
      async (input, signal) => feedPageSchema.parse(await backend.feed(input, signal)),
    ),
    tool(
      "limitless_feed_ack",
      "Acknowledge feed items through id for consumer. Call only after you have handled those items, since acknowledged items are no longer returned by default. The cursor never moves backwards. Returns {consumer, id} with the effective acknowledged id.",
      FeedAckSchema,
      async (input) => FeedAckSchema.parse(await backend.feedAck(input)),
    ),
  ];
  const server = new Server({ name: "limitless", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    try {
      const tool = tools.find((tool) => tool.name === params.name);
      if (!tool) throw new Error(`Unknown tool: ${params.name}`);
      const result = await tool.execute(params.arguments ?? {}, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
    }
  });
  return server;
}

export async function startStdio(base: string): Promise<void> {
  const server = createMcpServer(httpBackend(base));
  const transport = new StdioServerTransport();
  server.onerror = (error) => console.error(`Limitless MCP: ${error.message}`);
  const close = async () => {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    process.stdin.off("end", close);
    await server.close();
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  process.stdin.once("end", close);
  await server.connect(transport);
}
