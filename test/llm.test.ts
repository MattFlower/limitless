import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { runLlm } from "../src/harness/llm.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { triagePrompt } from "../src/pipeline/prompts.ts";
import { type Policy, PROVIDERS, type ProviderDef } from "../src/router/catalog.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { Router } from "../src/router/router.ts";

const schema = z.object({ answer: z.string() });
const jsonSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
let dir: string;
let server: ReturnType<typeof Bun.serve>;
let requests: Record<string, unknown>[];
let authorizations: (string | null)[];
let reply: (body: Record<string, unknown>, n: number) => Response | Promise<Response>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-llm-"));
  requests = [];
  authorizations = [];
  reply = () => Response.json({ choices: [{ message: { content: '{"answer":"ok"}' } }] });
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      requests.push(body);
      authorizations.push(req.headers.get("authorization"));
      return reply(body, requests.length);
    },
  });
});
afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

function spec(signal = new AbortController().signal, timeoutMs = 1000): AgentSpec {
  return {
    cwd: dir,
    prompt: "private question",
    systemAppend: "private system",
    mode: "readonly",
    target: {
      modelId: "mtplx/m",
      provider: "mtplx",
      harness: "claude",
      model: "selected-model",
      vendor: "qwen",
      tier: 2,
      billing: "free",
      price: { input: 1, output: 1 },
      openai: { baseUrl: `http://127.0.0.1:${server.port}/v1`, authToken: "local-token" },
    },
    jsonSchema,
    schema,
    timeoutMs,
    idleTimeoutMs: timeoutMs,
    maxToolCalls: 0,
    signal,
    logPath: join(dir, "log"),
    onEvent: () => {},
  };
}

test("direct completion sends model, schema, system and bearer token; captures usage", async () => {
  reply = () =>
    Response.json({
      choices: [{ message: { content: '{"answer":"ok"}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    });
  const result = await runLlm(spec());
  expect(result.status).toBe("ok");
  expect(result.structured).toEqual({ answer: "ok" });
  expect(result.usage.input).toBe(12);
  expect(result.usageFinal).toBe(true);
  expect(requests[0]?.model).toBe("selected-model");
  expect(authorizations[0]).toBe("Bearer local-token");
  expect(requests[0]?.response_format).toEqual({
    type: "json_schema",
    json_schema: { name: "completion", strict: true, schema: jsonSchema },
  });
  expect(requests[0]?.messages).toEqual([
    { role: "system", content: "private system" },
    { role: "user", content: "private question" },
  ]);
  const log = readFileSync(join(dir, "log"), "utf8");
  expect(log).toContain('"model":"selected-model"');
  expect(log).toContain('"httpStatus":200');
  expect(log).toContain('"inputTokens":12');
  expect(log).not.toContain("private question");
  expect(log).not.toContain("private system");
  expect(log).not.toContain("local-token");
});

test("triage prompt uses only supplied repository context", () => {
  const prompt = triagePrompt({ repoSlug: "local/test", prompt: "Change a file", tree: "src  test" });
  expect(prompt).toContain("top-level entries provided below");
  expect(prompt).toContain("src  test");
  expect(prompt).toContain("cannot read repository files");
  expect(prompt).not.toContain("a few file reads");
});

test("format rejection and fenced JSON use one repair request", async () => {
  reply = (_body, n) =>
    n === 1
      ? new Response("unsupported", { status: 400 })
      : Response.json({ choices: [{ message: { content: '```json\n{"answer":"repaired"}\n```' } }] });
  expect((await runLlm(spec())).structured).toEqual({ answer: "repaired" });
  expect(requests).toHaveLength(2);
  expect(requests[1]?.response_format).toBeUndefined();
});

test("invalid response is retried once and never accepted", async () => {
  reply = () =>
    Response.json({
      choices: [{ message: { content: '{"wrong":1}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });
  const result = await runLlm(spec());
  expect(result.status).toBe("error");
  expect(result.structured).toBeNull();
  expect(requests).toHaveLength(2);
  // Both answers were parsed with usage, so what they reported is the whole spend.
  expect(result.usage).toMatchObject({ input: 6, output: 2 });
  expect(result.usageFinal).toBe(true);
});

test("a response without usage is a valid answer but never final accounting", async () => {
  // A metered endpoint that omits usage may still bill: zero recorded is not zero spent.
  const metered = () => {
    const input = spec();
    input.target.billing = "metered";
    return input;
  };
  reply = () => Response.json({ choices: [{ message: { content: '{"answer":"ok"}' } }] });
  let result = await runLlm(metered());
  expect(result).toMatchObject({ status: "ok", structured: { answer: "ok" }, costUsd: 0, usageFinal: false });

  // Usage on the repair request does not account for the first response that lacked it.
  requests.length = 0;
  reply = (_body, n) =>
    n === 1
      ? Response.json({ choices: [{ message: { content: "{}" } }] })
      : Response.json({
          choices: [{ message: { content: '{"answer":"ok"}' } }],
          usage: { prompt_tokens: 7, completion_tokens: 2 },
        });
  result = await runLlm(metered());
  expect(requests).toHaveLength(2);
  expect(result).toMatchObject({ status: "ok", usage: { input: 7, output: 2 }, usageFinal: false });

  // Nor does a later refusal, which spent nothing itself, resolve the earlier unaccounted request.
  requests.length = 0;
  reply = (_body, n) =>
    n === 1
      ? Response.json({ choices: [{ message: { content: "{}" } }] })
      : new Response("limited", { status: 429 });
  result = await runLlm(metered());
  expect(requests).toHaveLength(2);
  expect(result).toMatchObject({ status: "quota", usageFinal: false });

  // Malformed usage counts as missing rather than as zero.
  requests.length = 0;
  reply = () =>
    Response.json({
      choices: [{ message: { content: '{"answer":"ok"}' } }],
      usage: { prompt_tokens: "12", completion_tokens: null },
    });
  result = await runLlm(metered());
  expect(result).toMatchObject({ status: "ok", usage: { input: 0, output: 0 }, usageFinal: false });
});

test("cancel, timeout, transport and provider errors are classified", async () => {
  reply = async () => {
    await Bun.sleep(100);
    return Response.json({ choices: [{ message: { content: "{}" } }] });
  };
  // Only a refusal (no work done) is accounted; a cut-off, failed or unreachable server is not.
  expect(await runLlm(spec(undefined, 10))).toMatchObject({ status: "timeout", usageFinal: false });
  const controller = new AbortController();
  controller.abort();
  expect(await runLlm(spec(controller.signal))).toMatchObject({ status: "cancelled", usageFinal: false });
  reply = () => new Response("busy", { status: 503 });
  expect(await runLlm(spec())).toMatchObject({ status: "unavailable", usageFinal: false });
  reply = () => new Response("limited", { status: 429 });
  expect(await runLlm(spec())).toMatchObject({ status: "quota", usageFinal: true });
  const bad = spec();
  bad.target.openai = { baseUrl: "http://127.0.0.1:1/v1", authToken: "" };
  expect(await runLlm(bad)).toMatchObject({ status: "unavailable", usageFinal: false });
});

test("normal invocation records failed HTTP candidate and falls back", async () => {
  reply = () =>
    Response.json({
      choices: [{ message: { content: '{"answer":"local"}' } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
  const cfg = loadConfig({ home: join(dir, "home"), configDir: join(dir, "cfg") });
  const store = new Store(cfg.paths.db);
  try {
    const providers: ProviderDef[] = [
      {
        id: "mtplx",
        label: "local",
        harness: "claude",
        billing: "free",
        maxConcurrent: 1,
        openaiBaseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
      { id: "fallback", label: "fallback", harness: "fake", billing: "free", maxConcurrent: 1 },
    ];
    const tracker = new ProviderTracker(providers, store, cfg.reserves, {});
    const router = new Router(tracker, { triage: { default: ["mtplx/m", "fallback/m"] } } as Policy, [
      {
        id: "mtplx/m",
        provider: "mtplx",
        model: "selected-model",
        vendor: "qwen",
        origin: "CN",
        baseOrigin: "CN",
        supportedEfforts: [],
        tier: 2,
        price: { input: 0, output: 0 },
      },
      {
        id: "fallback/m",
        provider: "fallback",
        model: "backup",
        vendor: "other",
        origin: "unknown",
        baseOrigin: "unknown",
        supportedEfforts: [],
        tier: 2,
        price: { input: 0, output: 0 },
      },
    ]);
    const repo = store.upsertRepo({
      slug: "local/test",
      kind: "local",
      localPath: dir,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: "question" });
    const stage = store.startStage(run.id, "triage");
    const context = new RunContext(
      {
        cfg,
        store,
        tracker,
        router,
        harnesses: {
          llm: runLlm,
          fake: async () => ({
            status: "ok",
            finalText: "",
            structured: { answer: "backup" },
            sessionId: null,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            numTurns: 1,
            costUsd: 0,
            costEquivUsd: 0,
            error: null,
            quota: null,
          }),
        },
      },
      run,
      repo,
      new AbortController().signal,
    );
    const options = {
      role: "triage",
      stage,
      prompt: "question",
      mode: "readonly",
      complexity: "small",
      jsonSchema,
      schema,
      requireStructured: true,
    } as const;
    const local = await context.invoke(options);
    expect(local.target.provider).toBe("mtplx");
    expect(local.invocation.harness).toBe("llm");
    expect(local.invocation.inputTokens).toBe(5);
    reply = () => new Response("down", { status: 503 });
    const result = await context.invoke(options);
    expect(result.target.provider).toBe("fallback");
    expect(store.listInvocations(run.id).map((i) => [i.harness, i.status])).toEqual([
      ["llm", "ok"],
      ["llm", "unavailable"],
      ["fake", "ok"],
    ]);
  } finally {
    store.close();
  }
});

test("HTTP effort mappings are exclusive and survive structured-output repair", async () => {
  for (const mapping of ["openrouter", "generic", "qwen"] as const)
    for (const effort of ["none", "high", undefined] as const) {
      requests.length = 0;
      reply = (_body, n) =>
        n === 1
          ? new Response("retry", { status: 400 })
          : Response.json({ choices: [{ message: { content: '{"answer":"ok"}' } }] });
      const input = spec();
      input.target.effortMapping = mapping;
      input.target.effort = effort;
      expect((await runLlm(input)).status).toBe("ok");
      expect(requests).toHaveLength(2);
      for (const body of requests) {
        expect(body.reasoning).toEqual(effort && mapping === "openrouter" ? { effort } : undefined);
        expect(body.reasoning_effort).toBe(mapping === "generic" ? effort : undefined);
        expect(body.chat_template_kwargs).toEqual(
          effort && mapping === "qwen" ? { enable_thinking: effort !== "none" } : undefined,
        );
      }
    }
});

test("HTTP rejects selected effort without a compatible explicit mapping before fetching", async () => {
  const input = spec();
  input.target.effort = "high";
  expect((await runLlm(input)).error).toContain("Unsupported effort transport");
  input.target.effortMapping = "qwen";
  input.target.vendor = "other";
  expect((await runLlm(input)).error).toContain("local Qwen");
  expect(requests).toHaveLength(0);
});

test("catalog oMLX thinking and authentication survive HTTP repair", async () => {
  const store = new Store(join(dir, "omlx.db"));
  const router = new Router(
    new ProviderTracker(
      PROVIDERS,
      store,
      { claudeFiveHour: 0.8, claudeSevenDay: 0.85, codexWeekly: 0.9, codexFiveHour: 0.9 },
      { OMLX_API_KEY: "key" },
    ),
  );
  const bodies: Record<string, unknown>[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (url, init) => {
    expect(String(url)).toBe("http://127.0.0.1:8989/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer key");
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      choices: [{ message: { content: bodies.length === 1 ? "{}" : '{"answer":"ok"}' } }],
    });
  }) as typeof fetch);
  try {
    for (const effort of [undefined, "none", "high"] as const) {
      bodies.length = 0;
      const resolved = router.resolve(`omlx/qwen-27b${effort ? `@${effort}` : ""}`);
      expect(
        (await runLlm({ ...spec(), target: router.toTarget(resolved.model, resolved.effort) })).status,
      ).toBe("ok");
      expect(bodies).toHaveLength(2);
      for (const body of bodies) {
        expect(body.model).toBe("Swift-1.5-Qwen3.8-27b-oQ8e-mtp");
        expect(body.chat_template_kwargs).toEqual(
          effort ? { enable_thinking: effort === "high" } : undefined,
        );
      }
    }
  } finally {
    mock.mockRestore();
    store.close();
  }
});
