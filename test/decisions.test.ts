import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import { type DecisionTask, runDecisions } from "../src/harness/decisions.ts";
import type { AgentEvent, AgentSpec } from "../src/harness/types.ts";
import { MODELS, type Policy, PROVIDERS } from "../src/router/catalog.ts";
import { validatePolicy } from "../src/router/policy.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { Router } from "../src/router/router.ts";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let requests: { path: string; auth: string | null; body: Record<string, unknown> }[];
let reply: (n: number) => Response | Promise<Response>;

const ok = (answers: Record<string, unknown>, inputTokens = 1_000_000) =>
  Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: inputTokens, output_tokens: 40 } });
const answers = {
  kind: { type: "choice", choice: "bug", confidence: 0.91, probabilities: { bug: 0.95, feature: 0.05 } },
  size: { type: "score", score: 2.6, confidence: 0.7, legend: {}, probabilities: {} },
  urgent: { type: "noul", noul: 0.2 },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-decisions-"));
  requests = [];
  reply = () => ok(answers);
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push({
        path: new URL(req.url).pathname,
        auth: req.headers.get("authorization"),
        body: (await req.json()) as Record<string, unknown>,
      });
      return reply(requests.length);
    },
  });
});
afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const task: DecisionTask = {
  state: "Ticket: login returns HTTP 500 for everyone.",
  questions: {
    kind: {
      type: "choice",
      instructions: "What kind of ticket?",
      criteria: { bug: "Broken", feature: "New" },
    },
    size: { type: "score", instructions: "How big?", criteria: ["tiny", "small", "large"] },
    urgent: { type: "noul", instructions: "Is it urgent?" },
  },
  interpret: (a) => ({ mapped: a }),
};

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    cwd: dir,
    prompt: "",
    mode: "readonly",
    target: {
      modelId: "typesafe/jev-1.13",
      provider: "typesafe",
      harness: "decisions",
      model: "jev-1.13.0",
      vendor: "typesafe",
      tier: 1,
      billing: "metered",
      price: { input: 0.042, output: 0 },
      decisions: { baseUrl: `http://127.0.0.1:${server.port}/`, authToken: "secret-key" },
    },
    decisionTask: task,
    timeoutMs: 5_000,
    idleTimeoutMs: 5_000,
    maxToolCalls: 0,
    signal: new AbortController().signal,
    logPath: join(dir, "log"),
    onEvent: () => {},
    ...over,
  };
}

test("sends typed questions with a bearer key, maps answers, and records usage and cost", async () => {
  const events: AgentEvent[] = [];
  const result = await runDecisions(spec({ onEvent: (e) => events.push(e) }));
  expect(requests).toEqual([
    {
      path: "/v1/systemone",
      auth: "Bearer secret-key",
      body: { model: "jev-1.13.0", state: task.state, questions: JSON.parse(JSON.stringify(task.questions)) },
    },
  ]);
  expect(result.status).toBe("ok");
  expect(result.structured).toEqual({
    mapped: {
      kind: { type: "choice", choice: "bug", confidence: 0.91 },
      // The expectation 2.6 rounds to level 3, clamped to the top level (2).
      size: { type: "score", score: 2.6, level: 2, confidence: 0.7 },
      urgent: { type: "noul", noul: 0.2 },
    },
  });
  expect(result.usage).toMatchObject({ input: 1_000_000, output: 40 });
  expect(result.costUsd).toBeCloseTo(0.042, 9);
  expect(result.costEquivUsd).toBeCloseTo(0.042, 9);
  expect(result.usageFinal).toBe(true);
  expect(events).toContainEqual({
    type: "status",
    text: "jev-1.13.0: kind=bug (0.91), size=2 (0.70), urgent P=0.20",
  });
  expect(readFileSync(join(dir, "log"), "utf8")).not.toContain("secret-key");
  // A lazy state is built when the call is made.
  await runDecisions(spec({ decisionTask: { ...task, state: () => ({ ticket: "built late" }) } }));
  expect(requests[1]?.body.state).toEqual({ ticket: "built late" });
});

test("retries one transient failure, then reports the provider unavailable", async () => {
  reply = (n) => (n === 1 ? new Response("overloaded", { status: 529 }) : ok(answers, 10));
  expect((await runDecisions(spec())).status).toBe("ok");
  expect(requests).toHaveLength(2);

  requests = [];
  reply = () => Response.json({ detail: "boom for secret-key" }, { status: 503 });
  const failed = await runDecisions(spec());
  expect(requests).toHaveLength(2);
  expect(failed).toMatchObject({
    status: "unavailable",
    error: "decision service unavailable (HTTP 503): boom for [redacted]",
    // A server failure may have spent before it failed; nothing accounted it.
    usageFinal: false,
  });

  // A body that stalls past the deadline is a timeout, not a malformed response.
  reply = () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('{"model":'));
          await Bun.sleep(1_000);
          controller.close();
        },
      }),
    );
  expect(await runDecisions(spec({ timeoutMs: 200 }))).toMatchObject({
    status: "timeout",
    error: "decision call timed out",
    usageFinal: false,
  });
});

test("classifies credit, key, rate-limit and request errors", async () => {
  const cases: [Response, string, string, number | undefined][] = [
    [new Response("", { status: 402 }), "quota", "provider out of credit (HTTP 402)", undefined],
    [
      Response.json(
        { detail: { error_type: "authentication_error", message: "Must supply an API key!" } },
        { status: 403 },
      ),
      "quota",
      "API key rejected (HTTP 403)",
      undefined,
    ],
    [
      Response.json({ detail: "slow down" }, { status: 429, headers: { "retry-after": "12" } }),
      "quota",
      "model rate-limited (HTTP 429): slow down",
      12_000,
    ],
    [
      new Response("", { status: 429, headers: { "retry-after-ms": "250" } }),
      "quota",
      "model rate-limited (HTTP 429)",
      1_000,
    ],
    [new Response("", { status: 429 }), "quota", "model rate-limited (HTTP 429)", 30_000],
    [
      Response.json({ detail: [{ loc: ["body", "state"], msg: "Field required" }] }, { status: 422 }),
      "error",
      "decision request rejected (HTTP 422): body.state: Field required",
      undefined,
    ],
  ];
  for (const [response, status, error, cooldown] of cases) {
    requests = [];
    reply = () => response;
    const result = await runDecisions(spec());
    expect(requests).toHaveLength(1);
    // A refused request did no work, so its zero spend is final.
    expect(result).toMatchObject({ status, error, costUsd: 0, usageFinal: true });
    expect(result.modelCooldownMs).toBe(cooldown);
  }
});

test("malformed answers, missing tasks, mapping errors, cancellation and timeouts", async () => {
  // Usage is final once a response was parsed (mapping failures included) or the call was never sent.
  const outcomes: [() => Response, Partial<AgentSpec>, string, string, boolean][] = [
    [
      () => ok({ ...answers, kind: { ...answers.kind, choice: "other" } }),
      {},
      "unavailable",
      "unknown option for kind",
      true,
    ],
    [() => ok({ kind: answers.kind, size: answers.size }), {}, "unavailable", "answer for urgent", true],
    [() => new Response("not json"), {}, "unavailable", "malformed decisions response", false],
    [() => ok(answers), { decisionTask: undefined }, "error", "requires a decisions endpoint and task", true],
    [
      () => ok(answers),
      {
        decisionTask: {
          ...task,
          interpret: () => {
            throw new Error("bad level");
          },
        },
      },
      "error",
      "decision mapping failed: bad level",
      true,
    ],
    [() => ok(answers), { signal: AbortSignal.abort() }, "cancelled", "cancelled", false],
  ];
  for (const [response, over, status, error, usageFinal] of outcomes) {
    reply = response;
    const result = await runDecisions(spec(over));
    expect(result.status).toBe(status as typeof result.status);
    expect(result.error).toContain(error);
    expect(result.usageFinal).toBe(usageFinal);
  }
  reply = async () => {
    await Bun.sleep(1_000);
    return ok(answers);
  };
  expect(await runDecisions(spec({ timeoutMs: 100 }))).toMatchObject({
    status: "timeout",
    error: "decision call timed out",
    usageFinal: false,
  });
});

test("a decision model is routable only for roles with a decisions mapping", () => {
  const store = new Store(join(dir, "db.sqlite"));
  try {
    const reserves = { claudeFiveHour: 0.8, claudeSevenDay: 0.85, codexWeekly: 0.9, codexFiveHour: 0.9 };
    const jev = "typesafe/jev-1.13";
    const cells = { default: [jev, "claude/haiku"] };
    const policy = { triage: cells, chat: cells, review: cells } as unknown as Policy;
    const offline = new Router(new ProviderTracker(PROVIDERS, store, reserves, {}), policy, MODELS);
    expect(offline.route("triage", "small").skipped).toContainEqual({
      modelId: jev,
      reason: "typesafe: missing TYPESAFE_API_KEY",
    });

    const tracker = new ProviderTracker(PROVIDERS, store, reserves, { TYPESAFE_API_KEY: "k" });
    const router = new Router(tracker, policy, MODELS);
    const triage = router.route("triage", "small").candidates[0];
    expect(triage).toMatchObject({
      modelId: jev,
      harness: "decisions",
      decisions: { baseUrl: "https://api.typesafe.ai", authToken: "k" },
    });
    for (const role of ["chat", "review"] as const) {
      const decision = router.route(role, "small");
      expect(decision.candidates.map((c) => c.modelId)).not.toContain(jev);
      expect(decision.skipped).toContainEqual({
        modelId: jev,
        reason: `${jev} is a decision model; the ${role} role has no decisions mapping`,
      });
      expect(() => router.resolveFor(role, jev)).toThrow("has no decisions mapping");
    }
    // Escalation beyond the policy list never reaches a decision model either.
    expect(router.route("implement", "small", { minTier: 1 }).candidates.map((c) => c.modelId)).not.toContain(
      jev,
    );
    expect(() => validatePolicy({ triage: { default: [jev] } }, MODELS)).not.toThrow();
    expect(() => validatePolicy({ summarize: { default: [jev] } }, MODELS)).toThrow(
      "has no decisions mapping",
    );
  } finally {
    store.close();
  }
});

test("a per-model rate limit cools down only that model, then it is routable again", () => {
  const store = new Store(join(dir, "db.sqlite"));
  try {
    let now = 1_000_000;
    const reserves = { claudeFiveHour: 0.8, claudeSevenDay: 0.85, codexWeekly: 0.9, codexFiveHour: 0.9 };
    const tracker = new ProviderTracker(PROVIDERS, store, reserves, { TYPESAFE_API_KEY: "k" }, {}, () => now);
    tracker.record("typesafe", "quota", {
      error: "model rate-limited (HTTP 429)",
      modelCooldown: { modelId: "typesafe/jev-1.13", ms: 12_000 },
    });
    expect(tracker.unavailableReason("typesafe")).toBeNull();
    expect(tracker.modelUnavailableReason("typesafe/jev-1.13")).toBe(
      "model cooling down: model rate-limited (HTTP 429)",
    );
    now += 12_001;
    expect(tracker.modelUnavailableReason("typesafe/jev-1.13")).toBeNull();

    tracker.record("typesafe", "quota", { error: "provider out of credit (HTTP 402)" });
    expect(tracker.unavailableReason("typesafe")).toBe("provider out of credit (HTTP 402)");
  } finally {
    store.close();
  }
});

test("a decline keeps the mapped output and the cost, with the reason as the error", async () => {
  const result = await runDecisions(
    spec({
      decisionTask: { ...task, decline: (a) => (a.urgent ? { reason: "unsure", lastResort: true } : null) },
    }),
  );
  expect(result).toMatchObject({
    status: "declined",
    error: "unsure",
    decline: { reason: "unsure", lastResort: true },
    costUsd: 0.042,
  });
  expect(result.structured).toMatchObject({ mapped: { kind: { choice: "bug" } } });
  expect(JSON.parse(result.finalText)).toMatchObject({ urgent: { noul: 0.2 } });
});
