import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRoleCases, type ReviewCase, VerifyCaseFileSchema } from "../src/evals/cases.ts";
import { formatEvalReport } from "../src/evals/format.ts";
import { gatesAt } from "../src/evals/prepare.ts";
import { auditDiff } from "../src/gates/audit.ts";
import { gateScriptNames, pickScripts } from "../src/gates/detect.ts";
import { createEvalWorktree, diffSince, readFileAt } from "../src/git/repos.ts";
import { readingTimeout } from "../src/pipeline/engine.ts";
import { FACTORY_PREAMBLE, reviewPrompt, verifyPrompt } from "../src/pipeline/prompts.ts";
import * as review from "../src/pipeline/review.ts";
import { ReviewSchema, toStrictJsonSchema, VerifySchema } from "../src/pipeline/schemas.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { sh } from "../src/util/proc.ts";
import { reviewCase, reviewOutput } from "./evals-reading-support.ts";
import { deferred, evalFixture } from "./evals-support.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";

async function fixture(role: "review" | "verify" = "review") {
  const f = await evalFixture();
  const head = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
  const item: ReviewCase = structuredClone({ ...reviewCase, base: f.sha, head });
  const verify = VerifyCaseFileSchema.parse(
    loadRoleCases("verify", new URL("./data/evals-verify.json", import.meta.url).pathname),
  ).cases[2];
  if (!verify) throw new Error("fixture");
  const verifyItem = { ...verify, base: f.sha, head };
  const save = () =>
    writeFileSync(
      f.casePath,
      JSON.stringify({ role, version: 1, cases: [role === "review" ? item : verifyItem] }),
    );
  save();
  const run = (over: Record<string, unknown> = {}) => f.run({ role, models: ["candidate-a"], k: 1, ...over });
  const clean = async () => {
    expect(f.calls.every((s) => !existsSync(s.cwd))).toBe(true);
    expect(
      (await sh(["git", "worktree", "list", "--porcelain"], { cwd: f.cache })).stdout.match(/^worktree /gm),
    ).toHaveLength(1);
    expect(readdirSync(f.cfg.paths.runs).filter((p) => p.startsWith("eval-"))).toEqual([]);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
  };
  return { ...f, item, verifyItem, save, run, clean };
}

test("review uses the pipeline prompt, recomputed audit, detached seeded HEAD and agent harness", async () => {
  const f = await fixture();
  try {
    f.item.seedPatch = "seed.patch";
    f.item.kind = "seeded";
    f.item.input.gates = [
      {
        name: "test",
        verdict: "regressed",
        blocking: true,
        result: { name: "test", command: "test", ok: false, exitCode: 1, durationMs: 1, output: "failed" },
      },
    ];
    writeFileSync(
      join(f.home, "seed.patch"),
      "diff --git a/example.test.ts b/example.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/example.test.ts\n@@ -0,0 +1 @@\n+test.skip('case', () => {});\n",
    );
    f.save();
    f.respond(async (s) => {
      expect(s.mode).toBe("readonly");
      expect(s.noTools).toBe(false);
      expect(s.systemAppend).toBe(FACTORY_PREAMBLE);
      expect(s.schema).toBe(ReviewSchema);
      expect(s.jsonSchema).toEqual(toStrictJsonSchema(ReviewSchema));
      expect(s.idleTimeoutMs).toBe(600_000);
      expect(s.maxToolCalls).toBe(150);
      expect(readFileSync(join(s.cwd, "example.test.ts"), "utf8")).toContain("test.skip");
      expect(existsSync(join(s.cwd, "seed.patch"))).toBe(false);
      expect((await sh(["git", "rev-parse", "HEAD^"], { cwd: s.cwd })).stdout.trim()).toBe(f.item.head);
      expect(
        (await sh(["git", "symbolic-ref", "-q", "HEAD"], { cwd: s.cwd, allowFail: true })).exitCode,
      ).not.toBe(0);
      const diff = await diffSince(s.cwd, f.sha);
      const gates = await gatesAt(s.cwd, f.sha, s.signal);
      const names = gateScriptNames(gates);
      const audit = auditDiff(diff, {
        taskClass: null,
        protectedPaths: gates.protectedPaths,
        toolCommands: [],
        gateScripts: {
          before: pickScripts(await readFileAt(s.cwd, f.sha, "package.json"), names),
          after: pickScripts(await readFileAt(s.cwd, "HEAD", "package.json"), names),
        },
      });
      expect(audit.length).toBeGreaterThan(0);
      expect(s.prompt).toBe(reviewPrompt({ ...f.item.input, baseSha: f.sha, stat: diff.stat, audit }));
      expect(s.timeoutMs).toBe(readingTimeout(diff.added + diff.removed));
      for (const secret of ["SECRET_SOURCE", "SECRET_DEFECT", "SECRET_AUTHOR", "seed.patch"])
        expect(s.prompt).not.toContain(secret);
      return { structured: reviewOutput(), costUsd: 0.1 };
    });
    const first = await f.run();
    expect(first.trials[0]?.status).toBe("ok");
    expect(f.harnessNames).toEqual(["fake"]);
    await f.clean();
    const firstGrade = first.trials[0]?.details.grade;
    f.item.defects[0] = {
      ...reviewCase.defects[0],
      file: "wrong.ts",
      lines: [10, 20],
      severity: "major",
      category: "correctness",
      summary: "changed labels",
      required: true,
      foundBy: "changed",
    };
    f.save();
    const cached = await f.run();
    expect(cached.summaries[0]).toMatchObject({ cached: 1, costUsd: 0, costEquivUsd: 0 });
    expect(cached.trials[0]?.pass).toBe(false);
    expect(f.factory.evals.report(first.run.id)?.trials[0]?.details.grade).toEqual(firstGrade);
    expect(f.calls).toHaveLength(1);
    // Identical patch content at another path reuses cache; changed content with identical stat does not.
    f.item.seedPatch = "other.patch";
    writeFileSync(join(f.home, "other.patch"), readFileSync(join(f.home, "seed.patch"), "utf8"));
    f.save();
    expect((await f.run()).summaries[0]?.cached).toBe(1);
    writeFileSync(
      join(f.home, "other.patch"),
      readFileSync(join(f.home, "seed.patch"), "utf8").replace("'case'", "'else'"),
    );
    expect((await f.run()).summaries[0]?.cached).toBe(0);
    expect(f.calls).toHaveLength(2);
    // Each system's implementerReport reaches its prompt, independent of the daemon's [review]
    // setting, and include and omit run side by side on one target with separate cache entries.
    f.item.input.implementerReport = "IMPLEMENTER_REPORT_TEXT";
    f.save();
    const prompts: string[] = [];
    f.respond(async (s) => {
      prompts.push(s.prompt);
      return { structured: reviewOutput(), costUsd: 0.1 };
    });
    f.cfg.reviewImplementerReport = "omit";
    const system = (name: string, implementerReport: string) => ({
      name,
      mode: "single",
      finders: [{ target: "candidate-a", prompt: "standard" }],
      implementerReport,
    });
    const systems = [system("with-report", "include"), system("without-report", "omit")];
    const sideBySide = await f.run({ models: undefined, systems });
    expect(
      sideBySide.summaries.map((s) => [s.candidate, s.modelId, s.system?.implementerReport, s.cached]),
    ).toEqual([
      ["with-report", "candidate-a", "include", 0],
      ["without-report", "candidate-a", "omit", 0],
    ]);
    expect(sideBySide.trials.map((t) => t.details.system)).toEqual(["with-report", "without-report"]);
    expect(new Set(sideBySide.trials.map((t) => t.cacheKey)).size).toBe(2);
    const text = formatEvalReport(sideBySide);
    expect(text).toContain("with-report [candidate-a, implementer report: include]");
    expect(text).toContain("without-report [candidate-a, implementer report: omit]");
    // Renamed systems with reordered keys are the same configuration, so both hit the cache.
    const renamed = await f.run({
      models: undefined,
      systems: [
        {
          implementerReport: "omit",
          finders: [{ prompt: "standard", target: "candidate-a" }],
          mode: "single",
          name: "b",
        },
        { ...system("a", "include") },
      ],
    });
    expect(renamed.summaries.map((s) => [s.candidate, s.cached])).toEqual([
      ["b", 1],
      ["a", 1],
    ]);
    // --models means an include-report system, so it reuses the include entry.
    expect((await f.run()).summaries[0]?.cached).toBe(1);
    expect(f.calls).toHaveLength(4);
    const [included, omitted] = prompts;
    expect(prompts).toHaveLength(2);
    expect(included).toContain("# Implementer's own report");
    expect(included).toContain("IMPLEMENTER_REPORT_TEXT");
    expect(omitted).not.toContain("Implementer's own report");
    expect(omitted).not.toContain("IMPLEMENTER_REPORT_TEXT");
    for (const kept of ["# Original request", "Fix the bug", "# Specification", `git diff ${f.sha}..HEAD`])
      expect(omitted).toContain(kept);
    expect(omitted).toContain("# Automated check results");
    expect(omitted).toContain("- test `test`: FAIL, regressed (BLOCKING)");
    await f.clean();
  } finally {
    await f.close();
  }
});

test("verify uses pipeline schema, prompt, private session and head content, retaining per-criterion grades", async () => {
  const f = await fixture("verify");
  try {
    f.respond(async (s) => {
      expect(s.privateSession).toBe(true);
      expect(s.mode).toBe("readonly");
      expect(s.noTools).toBe(false);
      expect(s.schema).toBe(VerifySchema);
      expect(s.jsonSchema).toEqual(toStrictJsonSchema(VerifySchema));
      expect(s.systemAppend).toBe(FACTORY_PREAMBLE);
      expect(s.prompt).toBe(
        verifyPrompt({
          ...f.verifyItem.input,
          holdout: f.verifyItem.input.holdout ?? { scenarios: [] },
          baseSha: f.sha,
        }),
      );
      const diff = await diffSince(s.cwd, f.sha);
      expect(s.timeoutMs).toBe(readingTimeout(diff.added + diff.removed, 25));
      expect((await sh(["git", "rev-parse", "HEAD"], { cwd: s.cwd })).stdout.trim()).toBe(f.verifyItem.head);
      expect(existsSync(join(s.cwd, "CURRENT.txt"))).toBe(true);
      expect(existsSync(join(s.cwd, "PINNED.txt"))).toBe(false);
      return {
        structured: {
          overall: "fail",
          notes: "",
          criteria: Object.entries(f.verifyItem.gold).map(([id, status]) => ({
            id,
            status,
            evidence: "observed",
            publicSummary: "",
          })),
        },
      };
    });
    expect((await f.run()).trials[0]?.pass).toBe(true);
    expect(f.harnessNames).toEqual(["fake"]);
    await f.clean();
    delete f.verifyItem.input.holdout;
    f.verifyItem.gold = { "AC-1": "met" };
    f.save();
    expect((await f.run()).trials[0]?.pass).toBe(true);
    await f.clean();
  } finally {
    await f.close();
  }
});

test("audit uses gate configuration from base, so a change cannot disable its own findings", async () => {
  const f = await fixture();
  try {
    const commit = async (files: Record<string, string | null>) => {
      for (const [name, content] of Object.entries(files))
        if (content === null) rmSync(join(f.source, name));
        else writeFileSync(join(f.source, name), content);
      await sh(["git", "add", "-A"], { cwd: f.source });
      await sh(["git", "commit", "-qm", "step"], { cwd: f.source });
      return (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
    };
    const scriptBase = await commit({
      "package.json": JSON.stringify({ scripts: { test: "bun test" } }),
      "bun.lock": "",
    });
    const scriptHead = await commit({ "package.json": JSON.stringify({ scripts: {} }) });
    const tomlBase = await commit({
      ".limitless.toml": '[policy]\nprotected_paths = ["guard.txt"]\n',
      "guard.txt": "keep",
    });
    const tomlHead = await commit({ ".limitless.toml": "", "guard.txt": "tampered" });
    writeFileSync(
      f.casePath,
      JSON.stringify({
        role: "review",
        version: 1,
        cases: [
          { ...f.item, id: "script", base: scriptBase, head: scriptHead },
          { ...f.item, id: "protected", base: tomlBase, head: tomlHead },
        ],
      }),
    );
    f.respond(() => ({ structured: reviewOutput() }));
    const report = await f.run();
    expect(report.trials.map((t) => t.status)).toEqual(["ok", "ok"]);
    expect(f.calls[0]?.prompt).toContain('Removed the "test" script');
    expect(f.calls[1]?.prompt).toContain("Edited a protected path.");
    await f.clean();
  } finally {
    await f.close();
  }
});

test("cached review outputs graded under the legacy rule regrade to blocking recall without a model call", async () => {
  const f = await fixture();
  try {
    f.respond(() => ({ structured: reviewOutput(10, "minor"), costUsd: 0.1 }));
    const first = await f.run();
    const stored = first.trials[0];
    if (!stored?.details.grade?.review) throw new Error("expected graded trial");
    expect(stored.details.grade).toMatchObject({
      pass: false,
      review: { requiredMatched: 0, underRated: 1 },
    });
    // Simulate a trial stored before blocking recall: minor matches counted and the case passed.
    // Its output lacks the model verdict, which the derived verdict makes irrelevant to regrading.
    const { underRated, blockingFindings, bySeverity, ...legacy } = stored.details.grade.review;
    const { verdict, ...outputWithoutVerdict } = ReviewSchema.parse(stored.output);
    expect(verdict).toBe("request_changes");
    f.factory.store.recordEvalTrial({
      ...stored,
      output: outputWithoutVerdict,
      pass: true,
      score: 1,
      details: {
        ...stored.details,
        grade: {
          ...stored.details.grade,
          pass: true,
          score: 1,
          review: { ...legacy, requiredMatched: 1, recall: 1 },
        },
      },
    });
    const regraded = await f.run();
    expect(f.calls).toHaveLength(1);
    expect(regraded.summaries[0]).toMatchObject({ cached: 1, costUsd: 0, costEquivUsd: 0, passes: 0 });
    expect(regraded.trials[0]?.details.grade).toMatchObject({
      pass: false,
      score: 0,
      review: { requiredMatched: 0, underRated: 1, blockingFindings: 0, requestChanges: false },
    });
    expect(regraded.trials[0]?.output).toEqual(outputWithoutVerdict);
    expect(regraded.summaries[0]?.review?.defectRecall).toMatchObject({ numerator: 0, denominator: 1 });
    await f.clean();
  } finally {
    await f.close();
  }
});

test("review trials need v2 fields and keep the model's verdict, and pre-v2 stored output regrades", async () => {
  const f = await fixture();
  try {
    const [finding] = reviewOutput().findings;
    if (!finding) throw new Error("fixture");
    const { confidence, ...incomplete } = finding;
    f.respond(() => ({ structured: { ...reviewOutput(), findings: [incomplete] } }));
    expect((await f.run()).trials[0]?.details.reason).toContain("Invalid review output");
    const conflicting = { ...reviewOutput(), verdict: "approve", findings: [{ ...finding, confidence: 3 }] };
    f.respond(() => ({ structured: conflicting }));
    const stored = (await f.run({ k: 1, cache: false })).trials[0];
    expect(stored?.output).toMatchObject({ verdict: "approve", findings: [{ confidence: 1 }] });
    expect(stored?.details.grade).toMatchObject({ pass: true, review: { requestChanges: true } });
    if (!stored?.details.grade) throw new Error("expected graded trial");
    const { failure_scenario, category, introduced_by_diff, ...legacy } = incomplete;
    f.factory.store.recordEvalTrial({ ...stored, output: { ...reviewOutput(), findings: [legacy] } });
    const calls = f.calls.length;
    const regraded = await f.run();
    expect(f.calls).toHaveLength(calls);
    expect(regraded.summaries[0]).toMatchObject({ cached: 1 });
    expect(regraded.trials[0]?.details.grade).toMatchObject({ pass: stored.details.grade.pass });
    await f.clean();
  } finally {
    await f.close();
  }
});

test("panel systems run finders and a pinned verifier end to end, grading what the panel blocks", async () => {
  const f = await fixture();
  try {
    const verdict = { current: "CONFIRMED" };
    f.respond((s) => {
      if (!s.prompt.includes("code-review verifier")) return { structured: reviewOutput(), costUsd: 0.1 };
      const ids = [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => m[1]);
      const results = ids.map((id) => ({
        id,
        verdict: verdict.current,
        severity: "low",
        category: "correctness",
        evidence: "src/a.ts:10 `bug()`",
        trigger: "any input -> wrong result",
      }));
      return { structured: { results }, costUsd: 0.1 };
    });
    const systems = [
      {
        name: "panel",
        mode: "panel",
        finders: [
          { target: "candidate-a", prompt: "standard" },
          { target: "candidate-b", prompt: "standard" },
        ],
        verifier: { target: "candidate-b" },
        implementerReport: "include",
      },
      {
        name: "single",
        mode: "single",
        finders: [{ target: "candidate-a", prompt: "standard" }],
        implementerReport: "include",
      },
    ];
    const report = await f.run({ models: undefined, systems, cache: false });
    expect(report.trials.map((t) => [t.details.system, t.status, t.pass])).toEqual([
      ["panel", "ok", true],
      ["single", "ok", true],
    ]);
    // Two finders, one verifier batch (same file and vendor) holding both candidates, then the single system.
    expect(f.calls.map((s) => [s.target.modelId, s.prompt.includes("code-review verifier"), s.mode])).toEqual(
      [
        ["candidate-a", false, "readonly"],
        ["candidate-b", false, "readonly"],
        ["candidate-b", true, "readonly"],
        ["candidate-a", false, "readonly"],
      ],
    );
    expect(f.calls[2]?.prompt).toContain('"id": "C2"');
    const panel = report.trials[0];
    expect(panel?.output).toMatchObject({
      mode: "panel",
      findings: [{ verification: { verdict: "CONFIRMED" } }, {}],
    });
    expect(panel?.costUsd).toBeCloseTo(0.3);
    // A refuted defect does not block, so the panel misses it.
    verdict.current = "REFUTED";
    const refuted = await f.run({ models: undefined, systems: [systems[0]], cache: false });
    expect(refuted.trials.map((t) => [t.status, t.pass, t.details.grade?.review?.requestChanges])).toEqual([
      ["ok", false, false],
    ]);
    await f.clean();
  } finally {
    await f.close();
  }
});

test("first-round review trials go through the pipeline's runReview", async () => {
  const f = await fixture();
  const run = spyOn(review, "runReview");
  try {
    f.respond(() => ({ structured: reviewOutput() }));
    expect((await f.run({ cache: false })).trials[0]?.status).toBe("ok");
    expect(run).toHaveBeenCalledTimes(1);
    const [, input] = run.mock.calls[0] ?? [];
    if (!input) throw new Error("runReview was not called with an input");
    expect(f.calls.map((s) => s.prompt)).toEqual([review.reviewRequest(input).prompt]);
    await f.clean();
  } finally {
    run.mockRestore();
    await f.close();
  }
});

test("eval regrade rewrites legacy-shaped stored grades from stored output with no model call or cache hit", async () => {
  const f = await fixture();
  try {
    f.respond(() => ({ structured: reviewOutput(10, "minor"), costUsd: 0.1 }));
    const first = await f.run();
    const stored = first.trials[0];
    const review = stored?.details.grade?.review;
    if (!stored?.details.grade || !review) throw new Error("expected graded trial");
    // Stored before `security` existed and before blocking recall, under a cache key nothing matches now.
    const legacyOutput = {
      verdict: "request_changes",
      summary: "Found an off-by-one in the loop bound.",
      findings: [
        { severity: "minor", file: "src/a.ts", line: 10, title: "Off by one", detail: "", suggestion: "" },
      ],
    };
    const { underRated, blockingFindings, bySeverity, ...legacyReview } = review;
    f.factory.store.recordEvalTrial({
      ...stored,
      cacheKey: "legacy-prompt-and-schema",
      output: legacyOutput,
      pass: true,
      score: 1,
      details: {
        ...stored.details,
        grade: {
          ...stored.details.grade,
          pass: true,
          score: 1,
          review: { ...legacyReview, requiredMatched: 1, recall: 1 },
        },
      },
    });
    const id = first.run.id;
    const before = f.factory.evals.report(id)?.summaries[0];
    expect(before).toMatchObject({ evaluatedTrials: 0, passes: 0, review: { legacyGrades: 1 } });
    const routes = createHttpRoutes(f.factory);
    const regrade = (routes["/api/evals/:id/regrade"] as { POST: Route }).POST;
    const post = async (evalId: string) => {
      const response = await regrade(
        requestWithParams(
          `http://localhost:7400/api/evals/${evalId}/regrade`,
          { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
          { id: evalId },
        ),
        localServer,
      );
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    expect(await post(id)).toEqual({ status: 200, body: { regraded: 1, changed: 1, skipped: [] } });
    expect(f.calls).toHaveLength(1);
    expect(f.factory.store.listEvalRuns()).toHaveLength(1);
    const after = f.factory.evals.report(id);
    expect(after?.trials[0]).toMatchObject({ output: legacyOutput, pass: false, score: 0 });
    expect(after?.summaries[0]).toMatchObject({
      evaluatedTrials: 1,
      passes: 0,
      review: {
        legacyGrades: 0,
        defectRecall: { numerator: 0, denominator: 1 },
        underRated: { numerator: 1, denominator: 1 },
      },
    });
    // Idempotent; unfinished evals are refused; a case that left the dataset keeps its stored grade.
    expect((await post(id)).body).toEqual({ regraded: 1, changed: 0, skipped: [] });
    f.factory.store.updateEvalRun(id, "running");
    expect(await post(id)).toEqual({
      status: 400,
      body: { error: `eval ${id} is still running; regrade it once it finishes` },
    });
    f.factory.store.updateEvalRun(id, "completed");
    f.item.id = "review-renamed";
    f.save();
    expect((await post(id)).body).toMatchObject({
      regraded: 0,
      skipped: [{ caseId: "review-one", trial: 0, reason: "case is no longer in the dataset" }],
    });
    expect(await post("eval-missing")).toEqual({ status: 404, body: { error: "eval not found" } });
    expect(f.calls).toHaveLength(1);
    await f.clean();
  } finally {
    await f.close();
  }
});

test("rejects pins whose reachable history exposes eval labels or seed patches", async () => {
  for (const leak of ["dataset", "seed"] as const) {
    const f = await fixture();
    try {
      const patch =
        "diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+n\n";
      writeFileSync(join(f.home, "seed.patch"), patch);
      f.item.seedPatch = "seed.patch";
      f.save();
      mkdirSync(join(f.source, leak === "dataset" ? "evals/review" : "notes"), { recursive: true });
      if (leak === "dataset") writeFileSync(join(f.source, "evals/review/cases.json"), "{}");
      else writeFileSync(join(f.source, "notes/copy.patch"), patch);
      await sh(["git", "add", "-A"], { cwd: f.source });
      await sh(["git", "commit", "-qm", "labels"], { cwd: f.source });
      // Labels committed before the head and deleted again stay readable through history.
      await sh(["git", "rm", "-rq", leak === "dataset" ? "evals" : "notes"], { cwd: f.source });
      await sh(["git", "commit", "-qm", "later"], { cwd: f.source });
      f.item.head = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
      f.save();
      const report = await f.run();
      expect(report.trials[0]).toMatchObject({ status: "error", pass: false });
      expect(String(report.trials[0]?.details.reason)).toContain(
        leak === "dataset" ? "eval labels" : "seed patch",
      );
      expect(f.calls).toHaveLength(0);
      await f.clean();
    } finally {
      await f.close();
    }
  }
});

test("batched label checks handle absent, blank, text and binary contents", async () => {
  const f = await evalFixture();
  const cwd = join(f.home, "label-check");
  const absent = ["", " \n", "missing label", new Uint8Array([0, 255, 10])];
  const checkout = (contents: (string | Uint8Array)[]) =>
    createEvalWorktree(
      f.cfg.paths,
      f.factory.store,
      "fixture/repo",
      f.sha,
      f.sha,
      cwd,
      new AbortController().signal,
      { paths: [], contents },
    );
  try {
    for (const contents of [[], absent]) {
      const cleanup = await checkout(contents);
      expect(readFileSync(join(cwd, "PINNED.txt"), "utf8")).toBe("old");
      await cleanup();
    }
    for (const label of ["old", new TextEncoder().encode("old")]) {
      await expect(checkout([...absent, label, "another missing label"])).rejects.toThrow(
        "pinned history contains an eval dataset or seed patch",
      );
      expect(existsSync(cwd)).toBe(false);
    }
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("rejects a historical dataset on a merge parent whose merge kept the label-free tree", async () => {
  const f = await fixture();
  try {
    const git = (...args: string[]) => sh(["git", ...args], { cwd: f.source });
    const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
    await git("checkout", "-q", "-b", "side");
    mkdirSync(join(f.source, "evals/review"), { recursive: true });
    const historical = JSON.stringify({ role: "review", version: 0, notes: "old labels", cases: [] });
    expect(historical).not.toBe(readFileSync(f.casePath, "utf8"));
    writeFileSync(join(f.source, "evals/review/cases.json"), historical);
    await git("add", "-A");
    await git("commit", "-qm", "historical labels");
    const side = (await git("rev-parse", "HEAD")).stdout.trim();
    await git("checkout", "-q", branch);
    await git("merge", "-q", "-s", "ours", "--no-ff", "-m", "merge side", "side");
    f.item.head = (await git("rev-parse", "HEAD")).stdout.trim();
    expect((await git("rev-parse", "HEAD^2")).stdout.trim()).toBe(side);
    expect((await git("ls-tree", "HEAD", "evals")).stdout).toBe("");
    // Default simplification follows only the TREESAME first parent and misses the labels.
    expect((await git("rev-list", "-1", "HEAD", "--", "evals/review")).stdout).toBe("");
    expect((await git("rev-list", "--full-history", "HEAD", "--", "evals/review")).stdout).toContain(side);
    f.save();
    const report = await f.run();
    expect(report.trials[0]).toMatchObject({ status: "error", pass: false });
    expect(String(report.trials[0]?.details.reason)).toContain("eval labels");
    expect(f.calls).toHaveLength(0);
    await f.clean();
  } finally {
    await f.close();
  }
});

test("fetches missing branch and PR-only pins and invalidates same-stat repository changes", async () => {
  const f = await fixture();
  try {
    const hidden: string[] = [];
    f.respond(async (s) => {
      // The candidate sees only history reachable from the pins: no refs, remotes or later commits.
      const git = (...args: string[]) => sh(["git", ...args], { cwd: s.cwd, allowFail: true });
      expect((await git("for-each-ref")).stdout).toBe("");
      expect((await git("remote")).stdout).toBe("");
      expect((await git("log", "--all", "--reflog", "--format=%H")).stdout).toBe(
        (await git("rev-list", "HEAD")).stdout,
      );
      expect((await git("worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)).toHaveLength(1);
      for (const sha of hidden) expect((await git("cat-file", "-e", `${sha}^{commit}`)).exitCode).not.toBe(0);
      return { structured: reviewOutput(), finalText: readFileSync(join(s.cwd, "CURRENT.txt"), "utf8") };
    });
    await f.run();
    const original = f.item.head;
    for (const pr of [false, true]) {
      if (pr) await sh(["git", "checkout", "--detach", original], { cwd: f.source });
      writeFileSync(join(f.source, "CURRENT.txt"), pr ? "pr!" : "alt");
      await sh(["git", "add", "."], { cwd: f.source });
      await sh(["git", "commit", "-qm", "next"], { cwd: f.source });
      f.item.head = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
      if (pr) {
        await sh(["git", "update-ref", "refs/pull/1/head", f.item.head], { cwd: f.source });
        await sh(["git", "checkout", "--detach", original], { cwd: f.source });
      }
      f.save();
      const report = await f.run();
      expect(report.trials[0]?.status).toBe("ok");
      expect(report.summaries[0]?.cached).toBe(0);
      expect(f.calls.at(-1)?.prompt).toBe(f.calls[0]?.prompt);
      expect(
        (await sh(["git", "cat-file", "-e", `${f.item.head}^{commit}`], { cwd: f.cache })).exitCode,
      ).toBe(0);
      await f.clean();
      hidden.push(f.item.head);
    }
    expect(f.calls).toHaveLength(3);
    // Later commits now sit in the shared cache but stay invisible to an earlier pin.
    f.item.head = original;
    f.item.input.prompt = "rerun without cache";
    f.save();
    expect((await f.run()).trials[0]?.status).toBe("ok");
    expect(f.calls).toHaveLength(4);
    await f.clean();
  } finally {
    await f.close();
  }
});

test("preparation, patch, harness and output failures remove worktrees and release slots", async () => {
  for (const failure of ["missing", "patch", "throw", "invalid"] as const) {
    const f = await fixture();
    try {
      if (failure === "missing") f.item.head = "0".repeat(40);
      if (failure === "patch") {
        f.item.seedPatch = "bad.patch";
        writeFileSync(join(f.home, "bad.patch"), "bad patch");
      }
      f.save();
      f.respond(() => {
        if (failure === "throw") throw new Error("injected");
        return { structured: { invalid: true } };
      });
      const report = await f.run();
      expect(report.trials[0]).toMatchObject({ status: "error", pass: false });
      expect(report.summaries[0]).toMatchObject({ predictionTrials: 0, errors: 1 });
      if (failure === "missing" || failure === "patch")
        expect(report.summaries[0]?.latencyDenominator).toBe(0);
      await f.clean();
    } finally {
      await f.close();
    }
  }
});

test("shutdown removes active and capacity-waiting worktrees", async () => {
  const f = await fixture();
  try {
    const entered = deferred<void>();
    f.respond(async (s) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        s.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { status: "cancelled" };
    });
    const first = f.factory.evals.submit({ role: "review", models: ["candidate-a"] });
    await entered.promise;
    const waiting = deferred<void>();
    const acquire = f.factory.tracker.acquire.bind(f.factory.tracker);
    const spy = spyOn(f.factory.tracker, "acquire").mockImplementation((id, signal) => {
      waiting.resolve();
      return acquire(id, signal);
    });
    const second = f.factory.evals.submit({ role: "review", models: ["candidate-a"] });
    await waiting.promise;
    spy.mockRestore();
    await f.factory.evals.stop();
    for (const id of [first.id, second.id]) expect(f.factory.evals.report(id)?.run.status).toBe("failed");
    const report = f.factory.evals.report(second.id);
    expect(report?.trials[0]).toMatchObject({
      status: "skipped",
      pass: null,
      score: null,
      details: { reason: "daemon shutdown" },
    });
    expect(report?.trials[0]?.details.preparationFailed).toBeUndefined();
    expect(report?.summaries[0]).toMatchObject({
      evaluatedTrials: 0,
      errors: 0,
      skipped: 1,
      passRate: null,
      predictionTrials: 0,
      latencyDenominator: 0,
    });
    expect(f.calls).toHaveLength(1);
    await f.clean();
  } finally {
    await f.close();
  }
});
