import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { EvalRun, EvalTrial } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { formatEvalReport } from "../src/evals/format.ts";
import { summarize } from "../src/evals/stats.ts";
import type { DecisionAnswer } from "../src/harness/decisions.ts";
import { runDecisions } from "../src/harness/decisions.ts";
import type { AgentResult } from "../src/harness/types.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { TaskClassEnum, TriageSchema, toStrictJsonSchema } from "../src/pipeline/schemas.ts";
import { suggestedProfile, triageDecisions } from "../src/pipeline/triage-decisions.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { Router } from "../src/router/router.ts";
import { answer, evalFixture } from "./evals-support.ts";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let calls = 0;
let confidence = 0.95;
let httpStatus = 200;

const input = {
  repoSlug: "o/r",
  prompt: "# Fix the login crash\n\nLogin throws on empty passwords.\n\nMore.",
  tree: "src",
};
const answers = (conf: number, questions = 0.1): Record<string, DecisionAnswer> => ({
  task_class: { type: "choice", choice: "bugfix", confidence: 0.99 },
  complexity: { type: "score", score: 1, level: 1, confidence: conf },
  risk: { type: "score", score: 0, level: 0, confidence: 0.9 },
  ambiguity: { type: "score", score: 0, level: 0, confidence: 0.9 },
  needs_questions: { type: "noul", noul: questions },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-triage-decisions-"));
  calls = 0;
  confidence = 0.95;
  httpStatus = 200;
  server = Bun.serve({
    port: 0,
    fetch() {
      calls++;
      if (httpStatus !== 200)
        return new Response("", { status: httpStatus, headers: { "retry-after": "5" } });
      const raw = Object.fromEntries(
        Object.entries(answers(confidence)).map(([id, a]) => [
          id,
          a.type === "score" ? { ...a, level: undefined } : a,
        ]),
      );
      return Response.json({
        model: "jev-1.13.0",
        answers: raw,
        usage: { input_tokens: 900, output_tokens: 50 },
      });
    },
  });
});
afterEach(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test("triage questions cover the schema and answers map to a valid triage", () => {
  const task = triageDecisions(input, 0.6);
  expect(task.state).toEqual({ repository: "o/r", top_level_entries: "src", request: input.prompt });
  const q = task.questions;
  expect(q.task_class?.type === "choice" && Object.keys(q.task_class.criteria)).toEqual(
    TaskClassEnum.options,
  );
  expect(
    [q.complexity, q.risk, q.ambiguity].map((s) => (s?.type === "score" ? s.criteria.length : 0)),
  ).toEqual([4, 3, 3]);
  expect(q.risk?.instructions).toContain("blast radius");
  expect(q.needs_questions?.type).toBe("noul");
  const triage = TriageSchema.parse(task.interpret(answers(0.9)));
  expect(triage).toEqual({
    title: "Fix the login crash",
    task_class: "bugfix",
    complexity: "small",
    risk: "low",
    ambiguity: "low",
    blocking_questions: [],
    summary: "Fix the login crash Login throws on empty passwords. More.",
    suggested_profile: "standard",
  });
  expect(
    [
      ["large", "low"],
      ["small", "high"],
      ["trivial", "low"],
      ["trivial", "medium"],
      ["medium", "medium"],
    ].map(([complexity, risk]) =>
      suggestedProfile({ complexity, risk } as Parameters<typeof suggestedProfile>[0]),
    ),
  ).toEqual(["deep", "deep", "quick", "quick", "standard"]);
});

test("declines on any low choice or score confidence, or when questions are likely", () => {
  const task = triageDecisions(input, 0.6);
  expect(task.decline?.(answers(0.6))).toBeNull();
  expect(task.decline?.(answers(0.59))).toBe("confidence below 0.6 (complexity 0.59)");
  expect(task.decline?.(answers(0.9, 0.5))).toBe("blocking questions likely (P=0.50)");
  expect(task.decline?.(answers(0.3, 0.8))).toBe(
    "confidence below 0.6 (complexity 0.30); blocking questions likely (P=0.80)",
  );
  // Only an LLM can write the blocking questions a confidently ambiguous request needs.
  const unclear = {
    ...answers(0.9),
    ambiguity: { type: "score", score: 2, level: 2, confidence: 0.9 },
  } as const;
  expect(task.decline?.(unclear)).toBe("ambiguity high");
});

test("a declined decision falls through to the LLM triage without counting as a provider failure", async () => {
  const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg") });
  const store = new Store(join(dir, "db.sqlite"));
  try {
    const providers: ProviderDef[] = [
      {
        id: "typesafe",
        label: "decisions",
        harness: "decisions",
        billing: "metered",
        maxConcurrent: 1,
        decisionsBaseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "k",
      },
      { id: "fallback", label: "fallback", harness: "fake", billing: "free", maxConcurrent: 1 },
    ];
    const model = (id: string, provider: string): ModelDef => ({
      id,
      provider,
      model: id,
      vendor: "other",
      origin: "US",
      baseOrigin: "US",
      supportedEfforts: [],
      tier: 1,
      price: { input: 0.042, output: 0 },
    });
    const tracker = new ProviderTracker(providers, store, cfg.reserves, {});
    const policy = { triage: { default: ["typesafe/jev", "fallback/m"] } } as Policy;
    const router = new Router(tracker, policy, [
      model("typesafe/jev", "typesafe"),
      model("fallback/m", "fallback"),
    ]);
    const llm = async (): Promise<AgentResult> => ({
      status: "ok",
      finalText: "",
      structured: answer,
      sessionId: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      numTurns: 1,
      costUsd: 0,
      costEquivUsd: 0,
      error: null,
      quota: null,
    });
    const repo = store.upsertRepo({
      slug: "local/test",
      kind: "local",
      localPath: dir,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = store.createRun(repo, { repo: repo.slug, prompt: input.prompt });
    const context = new RunContext(
      { cfg, store, tracker, router, harnesses: { decisions: runDecisions, fake: llm } },
      run,
      repo,
      new AbortController().signal,
    );
    const triage = () =>
      context.invoke({
        role: "triage",
        stage: store.startStage(run.id, "triage"),
        prompt: "unused by the decision model",
        mode: "readonly",
        complexity: "small",
        decisionTask: triageDecisions(input, cfg.triageDecisionConfidence),
        jsonSchema: toStrictJsonSchema(TriageSchema),
        schema: TriageSchema,
        requireStructured: true,
      });

    const confident = await triage();
    expect(confident.target.provider).toBe("typesafe");
    expect(confident.result.structured).toMatchObject({ title: "Fix the login crash", task_class: "bugfix" });
    expect(confident.invocation).toMatchObject({ harness: "decisions", status: "ok", inputTokens: 900 });

    confidence = 0.3;
    for (let i = 0; i < 3; i++) expect((await triage()).target.provider).toBe("fallback");
    const invocations = store.listInvocations(run.id);
    expect(invocations.map((i) => [i.harness, i.status])).toEqual([
      ["decisions", "ok"],
      ...Array(3)
        .fill([
          ["decisions", "declined"],
          ["fake", "ok"],
        ])
        .flat(),
    ]);
    expect(invocations[1]).toMatchObject({ error: "confidence below 0.6 (complexity 0.30)" });
    expect(invocations[1]?.costUsd).toBeGreaterThan(0);
    expect(store.listEvents(run.id).map((e) => e.message)).toContain(
      "typesafe/jev declined: confidence below 0.6 (complexity 0.30); trying the next model",
    );
    // Three declines in a row leave the provider healthy: no circuit breaker, no degraded state.
    expect(tracker.unavailableReason("typesafe")).toBeNull();
    expect(tracker.status("typesafe")?.state).toBe("ok");
    expect(calls).toBe(4);

    // A decline after a provider failure clears the failure count, like any answered call.
    httpStatus = 503;
    expect((await triage()).target.provider).toBe("fallback");
    expect(tracker.status("typesafe")?.state).toBe("degraded");
    httpStatus = 200;
    expect((await triage()).target.provider).toBe("fallback");
    expect(tracker.status("typesafe")?.state).toBe("ok");

    // With nothing to fall through to, the declined answer is used rather than failing the stage.
    const alone = await context.invoke({
      role: "triage",
      stage: store.startStage(run.id, "triage"),
      prompt: "unused",
      mode: "readonly",
      complexity: "small",
      constraints: { exclude: ["fallback/m"] },
      decisionTask: triageDecisions(input, cfg.triageDecisionConfidence),
      schema: TriageSchema,
      requireStructured: true,
    });
    expect(alone).toMatchObject({ target: { modelId: "typesafe/jev" }, result: { status: "declined" } });
    expect(TriageSchema.parse(alone.result.structured).task_class).toBe("bugfix");
    expect(store.listEvents(run.id).map((e) => e.message)).toContain(
      "No other model for triage; using the declined answer from typesafe/jev",
    );

    // A 429 cools down only the model; the provider stays routable.
    httpStatus = 429;
    expect((await triage()).target.provider).toBe("fallback");
    expect(tracker.unavailableReason("typesafe")).toBeNull();
    expect(tracker.modelUnavailableReason("typesafe/jev")).toBe(
      "model cooling down: model rate-limited (HTTP 429)",
    );
  } finally {
    store.close();
  }
});

test("triage decision confidence defaults to 0.6 and accepts only a number from 0 to 1", () => {
  const configDir = join(dir, "config");
  mkdirSync(configDir);
  const config = () => loadConfig({ home: join(dir, "data"), configDir });
  expect(config().triageDecisionConfidence).toBe(0.6);
  writeFileSync(join(configDir, "config.toml"), "[triage]\ndecision_confidence = 0.75\n");
  expect(config().triageDecisionConfidence).toBe(0.75);
  for (const value of ["1.5", "-0.1", '"high"'] as const) {
    writeFileSync(join(configDir, "config.toml"), `[triage]\ndecision_confidence = ${value}\n`);
    expect(config).toThrow("triage.decision_confidence must be a number from 0 to 1");
  }
  writeFileSync(join(configDir, "config.toml"), "[triage]\nconfidence = 0.5\n");
  expect(config).toThrow("triage.confidence: unknown key (allowed: decision_confidence)");
});

test("triage evals grade declined decisions, skip the cache for them and report the cascade", async () => {
  const f = await evalFixture(
    [
      {
        id: "typesafe/jev",
        provider: "typesafe",
        model: "jev",
        tier: 1,
        vendor: "typesafe",
        origin: "US",
        baseOrigin: "unknown",
        supportedEfforts: [],
        price: { input: 0.042, output: 0 },
      },
    ],
    [
      {
        id: "typesafe",
        label: "T",
        harness: "decisions",
        billing: "metered",
        maxConcurrent: 1,
        decisionsBaseUrl: "http://unused.invalid",
      },
    ],
  );
  try {
    const wrong = { ...answer, risk: "high" as const };
    f.respond((spec) => {
      const id = spec.prompt.match(/> Fix (\w)/)?.[1];
      if (spec.target.modelId === "candidate-b") return { structured: id === "a" ? wrong : answer };
      expect(spec.decisionTask?.questions.task_class?.type).toBe("choice");
      // Jev: "a" is right but declined, "b" right, "c" wrong.
      if (id === "a") return { status: "declined", structured: answer, error: "confidence below 0.6" };
      return { structured: id === "c" ? wrong : answer };
    });
    const report = await f.run({ models: ["typesafe/jev", "candidate-b"], k: 1 });
    const jev = report.summaries.find((m) => m.modelId === "typesafe/jev");
    expect(jev).toMatchObject({ passes: 2, evaluatedTrials: 3, declined: 1 });
    expect(jev?.cascade).toEqual({
      fallbackModel: "candidate-b",
      passes: 1,
      trials: 3,
      missing: 0,
      passRate: 1 / 3,
    });
    expect(report.summaries.find((m) => m.modelId === "candidate-b")).toMatchObject({
      declined: 0,
      cascade: null,
    });
    expect(formatEvalReport(report)).toContain(
      "  declined (escalated to the next model): 1/3 (33.3%); cascade via candidate-b: pass 33.3% (1/3)",
    );
    const before = f.harnessNames.filter((n) => n === "decisions").length;
    await f.run({ models: ["typesafe/jev"], k: 1 });
    expect(f.harnessNames.filter((n) => n === "decisions").length).toBe(before + 3);
  } finally {
    await f.close();
  }
});

test("the cascade falls back on every non-ok decision trial, to the model covering them", () => {
  const trial = (
    modelId: string,
    caseId: string,
    pass: boolean,
    over: Partial<EvalTrial> = {},
  ): EvalTrial => ({
    effort: "default",
    evalRunId: "e",
    caseId,
    modelId,
    trial: 0,
    cacheKey: "",
    harness: modelId === "jev" ? "decisions" : "llm",
    status: "ok",
    output: null,
    pass,
    score: pass ? 1 : 0,
    details: { invocationStatus: "ok" },
    costUsd: 0,
    costEquivUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 1,
    createdAt: 0,
    ...over,
  });
  const jev = [
    trial("jev", "a", true, { details: { invocationStatus: "declined" } }),
    trial("jev", "b", true),
    trial("jev", "c", false, { status: "error", details: { invocationStatus: "unavailable" } }),
    trial("jev", "d", false),
  ];
  // llm-a has the best pass rate but ran only case "a"; llm-b covers every fall-through.
  const llmA = [trial("llm-a", "a", true)];
  const llmB = [
    trial("llm-b", "a", false),
    trial("llm-b", "b", true),
    trial("llm-b", "c", true),
    trial("llm-b", "d", true),
  ];
  const run = { id: "e", role: "triage", k: 1, models: [] } as unknown as EvalRun;
  const cascadeOf = (trials: EvalTrial[]) => summarize(run, trials).find((m) => m.modelId === "jev")?.cascade;
  expect(cascadeOf([...jev, ...llmA, ...llmB])).toEqual({
    fallbackModel: "llm-b",
    passes: 2,
    trials: 4,
    missing: 0,
    passRate: 0.5,
  });
  expect(cascadeOf([...jev, ...llmA])).toEqual({
    fallbackModel: "llm-a",
    passes: 2,
    trials: 4,
    missing: 1,
    passRate: 0.5,
  });
  expect(summarize(run, llmB)[0]?.cascade).toBeNull();
});
