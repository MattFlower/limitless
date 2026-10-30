import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { EvalTrial } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import type { ReviewCase } from "../src/evals/cases.ts";
import { formatEvalReport } from "../src/evals/format.ts";
import { gradeReview } from "../src/evals/graders/review.ts";
import { JUDGE_RULE, normalizeJudgment } from "../src/evals/judge.ts";
import { EvalRunner } from "../src/evals/runner.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import { runLlm } from "../src/harness/llm.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { StoredReviewSchema } from "../src/pipeline/schemas.ts";
import { registerCredential } from "../src/util/proc.ts";
import { reviewCase, reviewOutput } from "./evals-reading-support.ts";

const pair = ["judge-a", "judge-b"];
const match = (finding: string | null = "F1", gold = "G1", confidence = 1) => ({
  gold,
  finding,
  confidence,
  reason: "same failure",
});
function fixture(
  items = [structuredClone(reviewCase)],
  concurrency = 1,
  maxConcurrent = 2,
  persistent = false,
  legacy = false,
) {
  const home = mkdtempSync(join(tmpdir(), "eval-judging-test-"));
  const cfg = loadConfig({ home, configDir: join(home, "config") });
  cfg.secrets = {};
  const casePath = join(home, "cases.json");
  const save = () => writeFileSync(casePath, JSON.stringify({ role: "review", version: 1, cases: items }));
  save();
  const calls: AgentSpec[] = [];
  let reply: (spec: AgentSpec) => FakeReply | Promise<FakeReply> = () => ({
    structured: { matches: [match()] },
  });
  const harness = fakeHarness((spec) => {
    calls.push(spec);
    return reply(spec);
  });
  const factory = new Factory(cfg, {
    store: new Store(persistent ? join(home, "db.sqlite") : ":memory:"),
    evalCasePath: casePath,
    harnesses: { fake: harness, llm: runLlm },
    providers: pair.map((id) => ({ id, label: id, harness: "fake", billing: "metered", maxConcurrent })),
    models: pair.map((id, i) => ({
      id,
      model: id,
      provider: id,
      tier: 1,
      vendor: i ? "qwen" : "other",
      origin: "unknown",
      baseOrigin: "unknown",
      supportedEfforts: ["low", "high"],
      price: { input: 1, output: 1 },
    })),
  });
  const run = factory.store.createEvalRun(
    { role: "review", models: ["private-eval-model"], k: 1, maxUsd: 10, concurrency },
    [],
  );
  const rows: EvalTrial[] = items.map((item, i) => {
    const output = reviewOutput();
    output.findings.push(
      ...(["major", "minor", "nit", "blocker"].map((severity) => ({
        ...output.findings[0],
        severity,
        title: `Finding ${severity.length}`,
      })) as typeof output.findings),
    );
    const grade = gradeReview(item, output);
    return {
      evalRunId: run.id,
      caseId: item.id,
      modelId: "private-eval-model",
      effort: legacy ? null : "default",
      trial: 0,
      cacheKey: `trial-${i}`,
      harness: "fake",
      status: "ok",
      output,
      pass: grade.pass,
      score: grade.score,
      details: { grade, ...(legacy ? {} : { system: "SECRET_SYSTEM" }) },
      costUsd: 2,
      costEquivUsd: 2,
      tokensIn: 10,
      tokensOut: 10,
      durationMs: 10,
      createdAt: 1,
    };
  });
  for (const row of rows) factory.store.recordEvalTrial(row);
  factory.store.updateEvalRun(run.id, "completed");
  const report = () => {
    const report = factory.evals.report(run.id, { resamples: 1 });
    if (!report) throw new Error("missing report");
    return report;
  };
  return {
    factory,
    home,
    run,
    calls,
    items,
    rows,
    save,
    report,
    respond(fn: typeof reply) {
      reply = fn;
    },
    async judge(maxUsd?: number) {
      factory.evals.judge(run.id, { judges: pair, maxUsd });
      await factory.evals.wait(run.id);
      const job = factory.evals.judgeStatus(run.id);
      expect(job?.status).toBe("completed");
      if (!job?.result) throw new Error(job?.error ?? "missing result");
      return job.result;
    },
    async close() {
      await factory.stop();
      factory.store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test.each([
  ["F1", "F1", 1, 0, 0],
  ["F1", "F2", 1, 0, 0],
  ["F1", null, 0, 1, 0],
  ["F1", "F3", 0, 1, 0],
  ["F3", "F4", 0, 0, 1],
] as const)(
  "consensus %s / %s is scored separately from location",
  async (a, b, caught, contested, underRated) => {
    const f = fixture();
    try {
      const before = f.report();
      const oldText = formatEvalReport(before);
      expect(before.summaries[0]?.review).not.toHaveProperty("judged");
      f.respond((s) => ({ structured: { matches: [match(s.target.modelId === pair[0] ? a : b)] } }));
      const result = await f.judge();
      const report = f.report();
      const review = report.summaries[0]?.review;
      expect(review?.defectRecall).toEqual(before.summaries[0]?.review?.defectRecall);
      expect(review?.judged).toMatchObject({
        recall: { numerator: caught, denominator: 1 },
        contested,
        underRated,
        unjudged: 0,
        agreement: { rate: 1 - contested },
        judges: pair,
      });
      expect(review?.judged?.perJudge.map((j) => j.numerator)).toEqual([
        Number(a === "F1"),
        Number(b === "F1" || b === "F2"),
      ]);
      expect(result).toMatchObject({ modelCalls: 2, trialsJudged: 1, contested });
      expect(JSON.parse(JSON.stringify(report)).summaries[0].review).toHaveProperty("judged");
      const text = formatEvalReport(report);
      expect(text).toContain("judged recall");
      expect(text.indexOf("judged recall")).toBeGreaterThan(text.indexOf("blocking recall"));
      expect(
        text
          .split("\n")
          .filter((line) => !line.includes("judge"))
          .join("\n"),
      ).toBe(oldText);
    } finally {
      await f.close();
    }
  },
);

test.each([false, true])("one-to-one prioritizes confidence then case order (tie=%s)", async (tie) => {
  const item = structuredClone(reviewCase);
  item.defects.push({ ...item.defects[0], summary: "second defect" } as ReviewCase["defects"][number]);
  const f = fixture([item]);
  try {
    const duplicate = { matches: [match("F1", "G2", tie ? 0.4 : 0.9), match("F1", "G1", 0.4)] };
    const output = StoredReviewSchema.parse(f.rows[0]?.output);
    expect(normalizeJudgment(duplicate, item, output).map((m) => m.finding)).toEqual(
      tie ? ["F1", null] : [null, "F1"],
    );
    f.respond((s) => ({
      structured: s.target.modelId === pair[0] ? duplicate : { matches: [match("F1"), match(null, "G2")] },
    }));
    await f.judge();
    expect(f.report().summaries[0]?.review?.judged).toMatchObject({
      recall: { numerator: Number(tie), denominator: 2 },
      perJudge: [{ numerator: 1 }, { numerator: 1 }],
      contested: tie ? 0 : 2,
    });
  } finally {
    await f.close();
  }
});

test("prompts are blind, include optional golds and redact each item before JSON encoding", async () => {
  const item = structuredClone(reviewCase);
  item.defects.push({
    ...item.defects[0],
    required: false,
    summary: "optional defect",
  } as ReviewCase["defects"][number]);
  const token = `token-${crypto.randomUUID()}-"\\secret`;
  registerCredential("JUDGE_TEST_TOKEN", token);
  item.defects[0] = {
    ...item.defects[0],
    file: `file-${token}`,
    summary: `gold ${token}`,
  } as ReviewCase["defects"][number];
  const f = fixture([item]);
  try {
    const row = f.rows[0];
    if (!row) throw new Error("missing row");
    const output = StoredReviewSchema.parse(row.output);
    for (const finding of output.findings) finding.detail = `failure ${token}`;
    f.factory.store.recordEvalTrial({ ...row, output, details: { ...row.details, system: "SECRET_SYSTEM" } });
    f.respond(() => ({ structured: { matches: [match(), match(null, "G2")] } }));
    await f.judge();
    for (const call of f.calls) {
      expect(call.noTools).toBe(true);
      expect(call.prompt).toContain(JUDGE_RULE);
      expect(call.prompt).toContain("optional defect");
      for (const hidden of [
        token,
        "SECRET_SYSTEM",
        "private-eval-model",
        ...pair,
        "qwen",
        '"other"',
        '"severity"',
        "foundBy",
        "SECRET_AUTHOR",
      ])
        expect(call.prompt).not.toContain(hidden);
      const payload = JSON.parse(call.prompt.slice(call.prompt.indexOf('{"gold":')));
      expect(payload.gold).toHaveLength(2);
      expect(payload.gold[0]).toEqual({
        id: "G1",
        file: "file-[redacted]",
        lines: [10, 20],
        summary: "gold [redacted]",
      });
      expect(payload.findings[0]).toEqual({
        id: "F1",
        file: "src/a.ts",
        line: 10,
        title: "Bug",
        detail: "failure [redacted]",
      });
      expect(payload.findings).toHaveLength(5);
      expect(existsSync(call.cwd)).toBe(false);
    }
  } finally {
    await f.close();
  }
});

test.each([false, true])("malformed judgments retry once (recovery=%s)", async (recover) => {
  const f = fixture();
  try {
    let attempts = 0;
    f.respond((s) => ({
      structured:
        s.target.modelId === pair[0] && (!recover || ++attempts === 1)
          ? { matches: [] }
          : { matches: [match()] },
    }));
    const result = await f.judge();
    expect(f.calls.filter((s) => s.target.modelId === pair[0])).toHaveLength(2);
    expect(result).toMatchObject({ modelCalls: 3, trialsJudged: Number(recover) });
    expect(result.unjudged).toEqual(
      recover
        ? []
        : [{ caseId: reviewCase.id, modelId: "private-eval-model", trial: 0, reason: "malformed" }],
    );
    expect(f.report().summaries[0]?.review?.judged).toMatchObject({
      unjudged: Number(!recover),
      recall: { numerator: Number(recover), denominator: Number(recover) },
    });
  } finally {
    await f.close();
  }
});

test("judgments persist across regrade/report and invalidate only edited cases", async () => {
  const f = fixture([structuredClone(reviewCase), { ...structuredClone(reviewCase), id: "second" }]);
  try {
    expect((await f.judge()).modelCalls).toBe(4);
    const before = f.report();
    f.calls.length = 0;
    expect(await f.judge()).toMatchObject({ reused: 4, modelCalls: 0, trialsJudged: 2 });
    f.factory.evals.regrade(f.run.id);
    expect(f.report()).toEqual(before);
    expect(f.calls).toHaveLength(0);
    const defect = f.items[0]?.defects[0];
    if (!defect) throw new Error("fixture");
    defect.summary = "changed label";
    f.save();
    expect(f.report().summaries[0]?.review?.judged?.unjudged).toBe(1);
    expect(await f.judge()).toMatchObject({ reused: 2, modelCalls: 2, trialsJudged: 2 });
    expect(f.calls.every((c) => c.prompt.includes("changed label"))).toBe(true);
  } finally {
    await f.close();
  }
});

test("legacy unknown-effort trials keep judged and unjudged metrics under their evidence identity", async () => {
  const f = fixture(undefined, 1, 2, false, true);
  try {
    f.respond(() => ({ structured: { matches: [] } }));
    expect((await f.judge()).unjudged).toHaveLength(1);
    expect(f.report().summaries[0]).toMatchObject({
      candidate: "private-eval-model (unknown effort)",
      review: { judged: { unjudged: 1, recall: { numerator: 0, denominator: 0 } } },
    });
    f.respond(() => ({ structured: { matches: [match()] } }));
    expect(await f.judge()).toMatchObject({ trialsJudged: 1, modelCalls: 2 });
    expect(f.report().summaries[0]?.review?.judged).toMatchObject({
      unjudged: 0,
      recall: { numerator: 1, denominator: 1 },
      perJudge: [{ numerator: 1 }, { numerator: 1 }],
    });
  } finally {
    await f.close();
  }
});

test.each(["invalid JSON", "invalid schema", "missing gold", "recovery", "format rejection", "budget"])(
  "HTTP judges share the two-request budget with the adapter: %s",
  async (mode) => {
    const f = fixture();
    const bodies: Record<string, unknown>[] = [];
    const attempts = new Map<string, number>();
    const transport = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const model = String(body.model);
      const attempt = (attempts.get(model) ?? 0) + 1;
      attempts.set(model, attempt);
      if (mode === "format rejection" && attempt === 1) return new Response(null, { status: 400 });
      const content =
        (mode === "recovery" || mode === "format rejection") && attempt === 2
          ? JSON.stringify({ matches: [match()] })
          : mode === "invalid schema"
            ? '{"wrong":true}'
            : mode === "missing gold"
              ? '{"matches":[]}'
              : "invalid JSON";
      return Response.json({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1_000_000 },
      });
    }) as typeof fetch);
    try {
      for (const judge of pair) {
        const provider = f.factory.tracker.def(judge);
        if (!provider) throw new Error("fixture");
        provider.openaiBaseUrl = "https://example.com/v1";
      }
      const result = await f.judge(mode === "budget" ? 0.5 : undefined);
      const recovered = mode === "recovery" || mode === "format rejection";
      expect([...attempts.values()]).toEqual(mode === "budget" ? [1, 1] : [2, 2]);
      expect(result).toMatchObject({
        modelCalls: mode === "budget" ? 2 : 4,
        trialsJudged: Number(recovered),
        spendUsd: mode === "format rejection" || mode === "budget" ? 2 : 4,
        unjudged: recovered
          ? []
          : [
              {
                caseId: reviewCase.id,
                modelId: "private-eval-model",
                trial: 0,
                reason: mode === "budget" ? "budget" : "malformed",
              },
            ],
      });
      for (const judge of pair) {
        const requests = bodies.filter((body) => body.model === judge);
        expect(requests[0]?.response_format).toBeDefined();
        expect(requests[1]?.response_format).toBeUndefined();
      }
      expect(f.report().summaries[0]?.review?.judged).toMatchObject({
        unjudged: Number(!recovered),
        recall: { numerator: Number(recovered), denominator: Number(recovered) },
      });
    } finally {
      transport.mockRestore();
      await f.close();
    }
  },
);

test("budget stops new requests and never changes trial spend", async () => {
  const f = fixture([structuredClone(reviewCase), { ...structuredClone(reviewCase), id: "second" }]);
  try {
    const before = f.factory.store.listEvalTrials(f.run.id);
    const spend = f.factory.store.evalSpend(f.run.id);
    f.respond(() => ({ costUsd: 1, structured: { matches: [match()] } }));
    const result = await f.judge(0.5);
    // Both vendors can already be in flight when the first cost becomes known.
    expect(result.modelCalls).toBe(2);
    expect(result.spendUsd).toBe(2);
    expect(result.unjudged).toEqual([
      { caseId: "second", modelId: "private-eval-model", trial: 0, reason: "budget" },
    ]);
    expect(f.factory.store.listEvalTrials(f.run.id)).toEqual(before);
    expect(f.factory.store.evalSpend(f.run.id)).toBe(spend);
    f.calls.length = 0;
    expect((await f.judge(0)).unjudged[0]?.reason).toBe("budget");
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("input refusals and duplicate jobs call no judges", async () => {
  const f = fixture();
  try {
    for (const [judges, message] of [
      [["judge-a"], "exactly two"],
      [[...pair, "judge-a"], "exactly two"],
      [["judge-a", "judge-a@low"], "different vendors"],
      [["judge-a", "unknown"], "unknown model"],
      [["judge-a", "judge-b@"], "Invalid model reference"],
    ] as const)
      expect(() => f.factory.evals.judge(f.run.id, { judges })).toThrow(message);
    for (const state of ["queued", "running"] as const) {
      f.factory.store.updateEvalRun(f.run.id, state);
      expect(() => f.factory.evals.judge(f.run.id, { judges: pair })).toThrow(`still ${state}`);
    }
    const other = f.factory.store.createEvalRun({ role: "triage", models: [], k: 1, maxUsd: 1 }, []);
    f.factory.store.updateEvalRun(other.id, "completed");
    expect(() => f.factory.evals.judge(other.id, { judges: pair })).toThrow("only review");
    expect(f.calls).toHaveLength(0);
    f.factory.store.updateEvalRun(f.run.id, "completed");
    f.factory.evals.judge(f.run.id, { judges: pair });
    expect(() => f.factory.evals.judge(f.run.id, { judges: pair })).toThrow("already running");
    expect(f.calls).toHaveLength(0);
    await f.factory.evals.wait(f.run.id);
  } finally {
    await f.close();
  }
});

test("non-real and unfinished or invalid trials are never judged", async () => {
  const f = fixture([
    structuredClone(reviewCase),
    { ...structuredClone(reviewCase), id: "clean", kind: "clean", defects: [] },
    { ...structuredClone(reviewCase), id: "seeded", kind: "seeded", seedPatch: "inline.patch" },
  ]);
  try {
    const row = f.rows[0];
    if (!row) throw new Error("fixture");
    f.factory.store.recordEvalTrial({ ...row, output: {} });
    expect(await f.judge()).toMatchObject({ modelCalls: 0, trialsJudged: 0, unjudged: [] });
    f.factory.store.recordEvalTrial({ ...row, status: "error" });
    expect((await f.judge()).modelCalls).toBe(0);
  } finally {
    await f.close();
  }
});

test("semantic catches can be reported in another file", async () => {
  const f = fixture();
  try {
    const row = f.rows[0];
    if (!row) throw new Error("fixture");
    const output = reviewOutput(200, "major", "caller.ts");
    const grade = gradeReview(reviewCase, output);
    f.factory.store.recordEvalTrial({
      ...row,
      output,
      details: { ...row.details, grade },
      pass: grade.pass,
      score: grade.score,
    });
    await f.judge();
    const review = f.report().summaries[0]?.review;
    expect(review?.defectRecall.numerator).toBe(0);
    expect(review?.judged?.recall.numerator).toBe(1);
  } finally {
    await f.close();
  }
});

test.each([0, 1])(
  "malformed ids and failures leave only affected trials unjudged (mode=%s)",
  async (mode) => {
    const f = fixture([
      structuredClone(reviewCase),
      {
        ...structuredClone(reviewCase),
        id: "valid",
        defects: [{ ...reviewCase.defects[0], summary: "valid gold" } as ReviewCase["defects"][number]],
      },
    ]);
    try {
      f.respond((s) =>
        s.target.modelId === pair[0] && !s.prompt.includes("valid gold")
          ? mode === 0
            ? { structured: { matches: [match("F99")] } }
            : { fault: "throw" }
          : { structured: { matches: [match()] } },
      );
      const result = await f.judge();
      expect(result).toMatchObject({
        modelCalls: 5,
        trialsJudged: 1,
        unjudged: [{ caseId: reviewCase.id, reason: mode ? "error" : "malformed" }],
      });
      expect(f.report().summaries[0]?.review?.judged).toMatchObject({
        recall: { numerator: 1, denominator: 1 },
        unjudged: 1,
      });
    } finally {
      await f.close();
    }
  },
);

test("provider caps and tracker slots apply when both judges share a provider", async () => {
  const items = Array.from({ length: 4 }, (_, i) => ({ ...structuredClone(reviewCase), id: `case-${i}` }));
  const f = fixture(items, 2, 4);
  const started = Promise.withResolvers<void>();
  const unblock = Promise.withResolvers<void>();
  try {
    const second = f.factory.router.model("judge-b");
    if (!second) throw new Error("fixture");
    second.provider = "judge-a";
    let active = 0,
      peak = 0;
    f.respond(async () => {
      active++;
      peak = Math.max(peak, active);
      if (active === 2) started.resolve();
      await unblock.promise;
      active--;
      return { structured: { matches: [match()] } };
    });
    f.factory.evals.judge(f.run.id, { judges: pair });
    await started.promise;
    expect(f.calls).toHaveLength(2);
    expect(f.factory.tracker.status("judge-a")?.inFlight).toBe(2);
    unblock.resolve();
    await f.factory.evals.wait(f.run.id);
    expect(peak).toBe(2);
    expect(f.calls).toHaveLength(8);
    expect(f.factory.tracker.status("judge-a")?.inFlight).toBe(0);
  } finally {
    unblock.resolve();
    await f.close();
  }
});

test("judge effort is part of persisted identity and restart leaves cached judgments readable", async () => {
  const f = fixture(undefined, 1, 2, true);
  try {
    await f.judge();
    f.factory.evals.judge(f.run.id, { judges: ["judge-a@low", "judge-b"] });
    await f.factory.evals.wait(f.run.id);
    expect(f.factory.evals.judgeStatus(f.run.id)?.result).toMatchObject({ modelCalls: 1, reused: 1 });
    expect(f.calls.at(-1)?.target.effort).toBe("low");
    const job = f.factory.store.evalJudges(f.run.id);
    if (!job) throw new Error("fixture");
    f.factory.store.saveEvalJudges(f.run.id, { ...job, status: "running" });
    expect(f.factory.evals.judgeStatus(f.run.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("restart"),
    });
    expect(f.report().summaries[0]?.review?.judged?.recall.numerator).toBe(1);
    const reopened = new Store(join(f.home, "db.sqlite"));
    try {
      const runner = new EvalRunner(
        {
          cfg: f.factory.cfg,
          store: reopened,
          router: f.factory.router,
          tracker: f.factory.tracker,
          harnesses: {
            fake: fakeHarness(() => {
              throw new Error("must use persisted judgments");
            }),
          },
        },
        join(f.home, "cases.json"),
      );
      expect(runner.judgeStatus(f.run.id)?.status).toBe("failed");
      expect(runner.report(f.run.id)?.summaries[0]?.review?.judged).toEqual(
        f.report().summaries[0]?.review?.judged,
      );
      expect(runner.regrade(f.run.id)?.regraded).toBe(1);
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});

test("strict judgment validation rejects duplicate, unknown and missing golds", () => {
  const output = StoredReviewSchema.parse(reviewOutput());
  for (const value of [
    "not json",
    { matches: [] },
    { matches: [match(), match()] },
    { matches: [match("F1", "G2")] },
    { matches: [match("F2")] },
    { matches: [{ ...match(), confidence: Number.NaN }] },
    { matches: [{ ...match(), extra: true }] },
    { matches: [match()], extra: true },
  ])
    expect(() => normalizeJudgment(value, reviewCase, output)).toThrow();
  expect(normalizeJudgment({ matches: [match(null)] }, reviewCase, output)[0]?.finding).toBeNull();
});

test("system causal attribution controls blocking for judged panel findings", async () => {
  const f = fixture();
  try {
    const output = reviewOutput();
    output.mode = "panel";
    const first = output.findings[0];
    if (!first) throw new Error("fixture");
    first.verification = {
      verdict: "CONFIRMED",
      severity: "high",
      category: "correctness",
      evidence: "observed",
      trigger: "input",
      attribution: "preexisting_unchanged",
    };
    for (const causalAttribution of [false, true]) {
      const run = f.factory.store.createEvalRun(
        {
          role: "review",
          models: [],
          k: 1,
          maxUsd: 1,
          systems: [
            {
              name: "SECRET_SYSTEM",
              mode: "panel",
              finders: [{ target: "judge-a", prompt: "standard" }],
              implementerReport: "include",
              ...(causalAttribution ? { causalAttribution: true } : {}),
            },
          ],
        },
        [],
      );
      const row = f.rows[0];
      if (!row) throw new Error("fixture");
      f.factory.store.recordEvalTrial({ ...row, evalRunId: run.id, output });
      f.factory.store.updateEvalRun(run.id, "completed");
      f.factory.evals.judge(run.id, { judges: pair });
      await f.factory.evals.wait(run.id);
      expect(f.factory.evals.report(run.id)?.summaries[0]?.review?.judged).toMatchObject({
        recall: { numerator: Number(!causalAttribution), denominator: 1 },
        underRated: Number(causalAttribution),
      });
    }
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});
