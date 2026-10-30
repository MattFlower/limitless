import { expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { EvalTrial } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import type { ReviewCase } from "../src/evals/cases.ts";
import { formatEvalReport } from "../src/evals/format.ts";
import { gradeReview } from "../src/evals/graders/review.ts";
import {
  JUDGE_RULE,
  type Judgment,
  judgmentKey,
  normalizeJudgment,
  scoreJudged,
  selectedJudgingTrials,
} from "../src/evals/judge.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { registerCredential } from "../src/util/proc.ts";
import { reviewCase, reviewOutput } from "./evals-reading-support.ts";
import { deferred, evalFixture, verifierModel } from "./evals-support.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";

setDefaultTimeout(30_000);
const match = (finding: string | null, gold = "G1", confidence = 0.9) => ({
  gold,
  finding,
  confidence,
  reason: "Same mechanism",
});
const judgment = (finding: string | null): Judgment => ({ matches: [match(finding)] });
const judges = ["candidate-a", "verifier-c"];
async function fixture(concurrency = 1) {
  const f = await evalFixture([verifierModel]);
  const cases: ReviewCase[] = ["one", "two"].map((id) => ({ ...structuredClone(reviewCase), id }));
  const save = () => writeFileSync(f.casePath, JSON.stringify({ role: "review", version: 1, cases }));
  save();
  const output = reviewOutput(100); // ±5 misses it; semantic judges can credit it.
  const rows: EvalTrial[] = cases.map((item) => ({
    evalRunId: "",
    caseId: item.id,
    modelId: "candidate-a",
    effort: "default",
    trial: 0,
    cacheKey: "",
    harness: "fake",
    status: "ok",
    output,
    pass: false,
    score: 0,
    details: { grade: gradeReview(item, output), system: "DISTINCTIVE_SYSTEM" },
    costUsd: 0.5,
    costEquivUsd: 0.5,
    tokensIn: 1,
    tokensOut: 1,
    durationMs: 1,
    createdAt: 1,
  }));
  const run = f.factory.store.createEvalRun(
    { role: "review", models: ["candidate-a"], k: 1, maxUsd: 10, concurrency },
    rows,
  );
  f.factory.store.updateEvalRun(run.id, "completed");
  f.respond(() => ({ structured: judgment("F1"), costUsd: 0.1 }));
  return {
    ...f,
    cases,
    save,
    run,
    output,
    async judge(maxUsd?: number) {
      const job = f.factory.evals.judge(run.id, judges, maxUsd);
      await f.factory.evals.waitJudge(run.id);
      return job;
    },
    report: () => {
      const report = f.factory.evals.report(run.id, { resamples: 1 });
      if (!report) throw new Error("missing report");
      return report;
    },
  };
}

test.each([
  ["F1", "F1", 1, 0, 0],
  ["F1", "F2", 1, 0, 0],
  ["F1", null, 0, 1, 0],
  ["F1", "F3", 0, 1, 0],
  ["F3", "F3", 0, 0, 1],
] as const)(
  "consensus %s / %s catches=%s contested=%s underRated=%s",
  (a, b, caught, contested, underRated) => {
    const output = reviewOutput();
    output.findings.push(...reviewOutput(11).findings, ...reviewOutput(12, "minor").findings);
    expect(scoreJudged(reviewCase, output, [judgment(a), judgment(b)])).toMatchObject({
      caught,
      contested,
      underRated,
      total: 1,
    });
  },
);

test("one-to-one keeps highest confidence, then original gold order even if response order differs", () => {
  const item = { ...reviewCase, defects: [...reviewCase.defects, ...reviewCase.defects] };
  for (const confidence of [0.9, 0.6]) {
    const result = normalizeJudgment(
      { matches: [match("F1", "G2", confidence), match("F1", "G1", 0.6)] },
      item,
      reviewOutput(),
    );
    expect(result.matches.map((m) => m.finding)).toEqual(confidence > 0.6 ? [null, "F1"] : ["F1", null]);
  }
});

test.each([
  { matches: [] },
  { matches: [match("F99")] },
  { matches: [match(null, "G9")] },
  { matches: [match("F1"), match(null)] },
  { matches: [{ ...match("F1"), confidence: 2 }] },
  { matches: [{ ...match("F1"), extra: true }] },
])("rejects incomplete or invalid judgment %#", (raw) => {
  expect(() => normalizeJudgment(raw, reviewCase, reviewOutput())).toThrow();
});

test("blind redacted prompts; stored report and regrade retain both scores and invalidate only changed cases", async () => {
  const f = await fixture();
  try {
    const secret = `judge-test-${crypto.randomUUID()}`;
    registerCredential("JUDGE_TEST_SECRET", secret);
    const rows = f.factory.store.listEvalTrials(f.run.id);
    for (const row of rows) {
      const output = reviewOutput(100);
      const finding = output.findings[0];
      if (!finding) throw new Error("missing finding");
      finding.detail = `Failure using ${secret}`;
      f.factory.store.recordEvalTrial({ ...row, output });
    }
    const before = f.report();
    expect(before.summaries[0]?.judged).toBeUndefined();
    expect(formatEvalReport(before)).not.toContain("judged recall");
    expect(await f.judge()).toMatchObject({
      status: "completed",
      judged: 4,
      reused: 0,
      unjudged: 0,
      spend: 0.4,
    });
    for (const spec of f.calls) {
      const text = spec.prompt + (spec.systemAppend ?? "");
      expect(text).toContain(JUDGE_RULE);
      expect(text).toContain('"id":"G1"');
      expect(text).toContain('"lines":[10,20]');
      expect(text).toContain('"id":"F1"');
      expect(text).toContain('"line":100');
      expect(text).toContain('"file":"src/a.ts"');
      expect(text).toContain('"title":"Bug"');
      expect(text).toContain('"detail":"Failure using [redacted]"');
      expect(text).toContain('"summary":"SECRET_DEFECT"');
      for (const hidden of [
        "DISTINCTIVE_SYSTEM",
        "candidate-a",
        "verifier-c",
        "major",
        "security",
        "agreement",
        "verification",
        secret,
        '"verdict"',
        '"severity"',
      ])
        expect(text).not.toContain(hidden);
      expect(spec.noTools).toBe(true);
    }
    const report = f.report();
    expect(report.summaries[0]?.review?.defectRecall).toEqual(before.summaries[0]?.review?.defectRecall);
    expect(report.summaries[0]?.judged).toMatchObject({
      recall: { numerator: 2, denominator: 2, rate: 1 },
      perJudge: [{ recall: { numerator: 2 } }, { recall: { numerator: 2 } }],
      contested: 0,
      underRated: 0,
      unjudged: 0,
      agreement: { numerator: 2, denominator: 2, rate: 1 },
    });
    expect(formatEvalReport(report)).toContain("judged recall 100.0%");
    expect(JSON.parse(JSON.stringify(report)).summaries[0]).toHaveProperty("judged");
    const reopened = new Store(f.cfg.paths.db);
    try {
      expect(reopened.evalJudges(f.run.id)).toEqual([
        { modelId: "candidate-a", effort: null },
        { modelId: "verifier-c", effort: null },
      ]);
    } finally {
      reopened.close();
    }
    expect(await f.judge()).toMatchObject({ judged: 0, reused: 4, spend: 0 });
    f.factory.evals.regrade(f.run.id);
    f.report();
    expect(f.calls).toHaveLength(4);
    const changed = f.cases[0]?.defects[0];
    if (!changed) throw new Error("missing defect");
    changed.summary = "Changed failure mechanism";
    f.save();
    expect(f.report().summaries[0]?.judged).toMatchObject({ unjudged: 1, recall: { denominator: 1 } });
    expect(await f.judge()).toMatchObject({ judged: 2, reused: 2, unjudged: 0 });
    expect(f.calls).toHaveLength(6);
    for (const spec of f.calls.slice(4)) expect(spec.prompt).toContain("Changed failure mechanism");
    // Scoring-only labels do not invalidate a judgment key.
    const item = f.cases[0];
    if (!item) throw new Error("missing case");
    expect(judgmentKey({ modelId: "candidate-a", effort: null }, item, f.output)).toBe(
      judgmentKey(
        { modelId: "candidate-a", effort: null },
        { ...item, defects: item.defects.map((d) => ({ ...d, required: false, severity: "nit" })) },
        f.output,
      ),
    );
  } finally {
    await f.close();
  }
});

test.each([false, true])("invalid output retries once; eventual success=%s", async (succeeds) => {
  const f = await fixture();
  try {
    const counts = new Map<string, number>();
    f.respond((spec) => {
      const count = (counts.get(spec.target.modelId) ?? 0) + 1;
      counts.set(spec.target.modelId, count);
      return spec.target.modelId === "candidate-a" && (!succeeds || count % 2 === 1)
        ? { text: "malformed" }
        : { structured: judgment("F1") };
    });
    await f.judge();
    expect(counts.get("candidate-a")).toBe(4);
    expect(counts.get("verifier-c")).toBe(2);
    expect(f.report().summaries[0]?.judged).toMatchObject({
      unjudged: succeeds ? 0 : 2,
      recall: { numerator: succeeds ? 2 : 0, denominator: succeeds ? 2 : 0 },
    });
  } finally {
    await f.close();
  }
});

test("spend cap stops new requests and keeps eval spend separate", async () => {
  const f = await fixture();
  try {
    const before = f.factory.store.evalSpend(f.run.id);
    expect(await f.judge(0.2)).toMatchObject({ spend: 0.2, unjudged: 1 });
    expect(f.calls).toHaveLength(2);
    expect(f.report().summaries[0]?.judged?.unjudged).toBe(1);
    expect(f.factory.store.evalSpend(f.run.id)).toBe(before);
  } finally {
    await f.close();
  }
});

test("refusals make no calls, including duplicate active jobs and missing eval API 404", async () => {
  const f = await fixture();
  const release = deferred<void>();
  try {
    for (const [refs, reason] of [
      [["candidate-a"], "exactly two"],
      [[...judges, "candidate-b"], "exactly two"],
      [["candidate-a", "candidate-b"], "different vendors"],
      [["missing", "verifier-c"], "unknown model"],
      [["candidate-a@nope", "verifier-c"], "Unsupported effort"],
    ] as const)
      expect(() => f.factory.evals.judge(f.run.id, refs)).toThrow(reason);
    for (const status of ["queued", "running"] as const) {
      f.factory.store.updateEvalRun(f.run.id, status);
      expect(() => f.factory.evals.judge(f.run.id, judges)).toThrow(`still ${status}`);
    }
    const nonReview = f.factory.store.createEvalRun(
      { role: "triage", models: ["candidate-a"], k: 1, maxUsd: 1 },
      [],
    );
    expect(() => f.factory.evals.judge(nonReview.id, judges)).toThrow("only review");
    const route = createHttpRoutes(f.factory)["/api/evals/:id/judge"] as { POST: Route };
    const res = await route.POST(
      requestWithParams(
        "http://localhost/api/evals/missing/judge",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ judges }) },
        { id: "missing" },
      ),
      localServer,
    );
    expect(res.status).toBe(404);
    expect(f.calls).toHaveLength(0);
    f.factory.store.updateEvalRun(f.run.id, "completed");
    f.respond(async () => {
      await release.promise;
      return { structured: judgment("F1") };
    });
    f.factory.evals.judge(f.run.id, judges);
    expect(() => f.factory.evals.judge(f.run.id, judges)).toThrow("already in progress");
  } finally {
    release.resolve();
    await f.close();
  }
});

test("selection skips seeded, clean, optional-only, missing, errored and malformed trials", async () => {
  const f = await fixture();
  try {
    const [original] = f.factory.store.listEvalTrials(f.run.id);
    if (!original) throw new Error("missing trial");
    const cases: ReviewCase[] = [
      {
        ...reviewCase,
        id: "real",
        defects: [...reviewCase.defects, ...reviewCase.defects.map((d) => ({ ...d, required: false }))],
      },
      { ...reviewCase, id: "seed", kind: "seeded" },
      { ...reviewCase, id: "clean", kind: "clean", defects: [] },
      { ...reviewCase, id: "optional", defects: reviewCase.defects.map((d) => ({ ...d, required: false })) },
    ];
    const rows: EvalTrial[] = ["real", "seed", "clean", "optional", "gone"].map((caseId) => ({
      ...original,
      caseId,
    }));
    rows.push({ ...original, caseId: "real", status: "error" }, { ...original, caseId: "real", output: {} });
    expect(selectedJudgingTrials(rows, cases).map(({ trial }) => trial.caseId)).toEqual(["real"]);
    const real = cases[0];
    if (!real) throw new Error("missing real case");
    const result = normalizeJudgment({ matches: [match(null), match("F1", "G2")] }, real, f.output);
    expect(scoreJudged(real, f.output, [result, result])).toMatchObject({ caught: 0, total: 1 });
  } finally {
    await f.close();
  }
});

test("POST returns a background job promptly; polling observes completion", async () => {
  const f = await fixture();
  const release = deferred<void>();
  try {
    f.respond(async () => {
      await release.promise;
      return { structured: judgment("F1") };
    });
    const route = createHttpRoutes(f.factory)["/api/evals/:id/judge"] as { POST: Route; GET: Route };
    const request = (method: string) =>
      requestWithParams(
        `http://localhost/api/evals/${f.run.id}/judge`,
        {
          method,
          ...(method === "POST"
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ judges }) }
            : {}),
        },
        { id: f.run.id },
      );
    const started = await route.POST(request("POST"), localServer);
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ status: "running" });
    expect(await (await route.GET(request("GET"), localServer)).json()).toMatchObject({ status: "running" });
    release.resolve();
    await f.factory.evals.waitJudge(f.run.id);
    expect(await (await route.GET(request("GET"), localServer)).json()).toMatchObject({
      status: "completed",
      judged: 4,
      unjudged: 0,
    });
  } finally {
    release.resolve();
    await f.close();
  }
});

test("shutdown aborts in-flight judges and releases provider slots", async () => {
  const f = await fixture(2);
  const started = deferred<void>();
  try {
    f.respond(() => {
      if (f.calls.length === 2) started.resolve();
      return { fault: "block" };
    });
    f.factory.evals.judge(f.run.id, judges);
    await started.promise;
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(1);
    expect(f.factory.tracker.status("provider-b")?.inFlight).toBe(1);
    await f.factory.evals.stop();
    expect(f.calls).toHaveLength(2);
    expect(f.report().summaries[0]?.judged?.unjudged).toBe(2);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
    expect(f.factory.tracker.status("provider-b")?.inFlight).toBe(0);
  } finally {
    await f.close();
  }
});

test("invocation errors leave absent judgments that a later judge run retries", async () => {
  const f = await fixture();
  try {
    f.respond((spec) =>
      spec.target.modelId === "candidate-a" ? { fault: "throw" } : { structured: judgment("F1") },
    );
    await f.judge();
    expect(f.calls).toHaveLength(4);
    expect(f.report().summaries[0]?.judged).toMatchObject({ unjudged: 2, recall: { denominator: 0 } });
    f.respond(() => ({ structured: judgment("F1") }));
    expect(await f.judge()).toMatchObject({ judged: 2, reused: 2, unjudged: 0 });
    expect(f.calls).toHaveLength(6);
  } finally {
    await f.close();
  }
});

test("an incomplete judge pair contributes no scored golds", () => {
  for (const pair of [[], [judgment("F1")]])
    expect(scoreJudged(reviewCase, reviewOutput(), pair)).toMatchObject({
      caught: 0,
      total: 0,
      contested: 0,
      underRated: 0,
    });
});
