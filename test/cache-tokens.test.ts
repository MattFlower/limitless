import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";
import type { Invocation } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import type { Harness } from "../src/harness/types.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { renderReport } from "../src/pipeline/report.ts";
import type { ModelDef, Policy, ProviderDef } from "../src/router/catalog.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { Router } from "../src/router/router.ts";

const schema = z.object({ answer: z.string() });
const jsonSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
const provider: ProviderDef = { id: "p", label: "p", harness: "fake", billing: "metered", maxConcurrent: 1 };
const model: ModelDef = {
  id: "p/m",
  provider: "p",
  model: "m",
  vendor: "other",
  origin: "unknown",
  baseOrigin: "unknown",
  tier: 4,
  price: { input: 1, output: 1 },
  supportedEfforts: [],
};

const invocation = (over: Partial<Invocation> = {}): Invocation => ({
  waitMs: 0,
  fast: false,
  fastModeState: null,
  fastModeDisabledReason: null,
  id: 1,
  runId: "r",
  stageId: 1,
  role: "implement",
  harness: "claude",
  provider: "claude",
  model: "m",
  effort: null,
  modelId: "claude/m",
  status: "ok",
  costUsd: 0,
  costEquivUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  numTurns: 1,
  sessionId: null,
  error: null,
  startedAt: 0,
  finishedAt: 1000,
  ...over,
});

const report = (invocations: Invocation[]) =>
  renderReport({
    success: true,
    runId: "r",
    prompt: "x",
    state: {},
    invocations,
    totals: { costUsd: 0, costEquivUsd: 0 },
    runUrl: "u",
  });

test("an invocation keeps cache writes beside cached reads, and the run total counts them as input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limitless-cache-tokens-"));
  const cfg = loadConfig({ home: join(dir, "home"), configDir: join(dir, "cfg") });
  const store = new Store(":memory:");
  try {
    const harness: Harness = async () => ({
      status: "ok",
      finalText: "",
      structured: { answer: "ok" },
      sessionId: null,
      usage: { input: 120, output: 30, cacheRead: 800, cacheWrite: 450 },
      numTurns: 1,
      costUsd: 0,
      costEquivUsd: 0,
      error: null,
      quota: null,
    });
    const tracker = new ProviderTracker([provider], store, cfg.reserves, {});
    const router = new Router(tracker, { triage: { default: ["p/m"] } } as Policy, [model]);
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
      { cfg, store, tracker, router, harnesses: { fake: harness } },
      run,
      repo,
      new AbortController().signal,
    );
    await context.invoke({
      role: "triage",
      stage,
      prompt: "question",
      mode: "readonly",
      complexity: "small",
      jsonSchema,
      schema,
      requireStructured: true,
    });
    const stored = store.listInvocations(run.id)[0] as Invocation;
    // Uncached input alone; the rest of the prompt is cached or written.
    expect([stored.inputTokens, stored.cacheReadTokens, stored.cacheWriteTokens]).toEqual([120, 800, 450]);
    store.refreshRunTotals(run.id);
    expect(store.getRun(run.id)?.tokensIn).toBe(120 + 800 + 450);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the work log shows the cache split and a per-run hit rate", () => {
  const md = report([
    invocation({ id: 1, inputTokens: 1000, cacheReadTokens: 3000, cacheWriteTokens: 500, outputTokens: 200 }),
    invocation({ id: 2, inputTokens: 500, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 100 }),
  ]);
  expect(md).toContain("| Cached | Cache write |");
  expect(md).toContain("| 4,500 / 200 | 3,000 | 500 |");
  expect(md).toContain(
    "**Cache:** 63.6% of prompt tokens read from cache (3,500 cached, 500 written, 1,500 uncached).",
  );
});

test("an invocation recorded before cache writes were stored renders with none", () => {
  const md = report([invocation({ inputTokens: 1000, cacheReadTokens: 3000, outputTokens: 200 })]);
  expect(md).toContain("| 4,000 / 200 | 3,000 | 0 |");
  expect(md).toContain(
    "**Cache:** 75.0% of prompt tokens read from cache (3,000 cached, 0 written, 1,000 uncached).",
  );
});
