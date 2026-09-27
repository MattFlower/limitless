import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CaseFileSchema,
  EvalRequestSchema,
  loadCases,
  loadRoleCases,
  validateRequest,
} from "../src/evals/cases.ts";
import { evalFixture } from "./evals-support.ts";

test("committed 40 cases load unchanged, including notes and gold alternatives", () => {
  const file = loadCases();
  expect(file.cases).toHaveLength(40);
  expect(file.notes).toContain("orchestrator");
  expect(file.cases.some((c) => Array.isArray(c.gold.complexity))).toBe(true);
});

test("dataset diagnostics reject malformed JSON and invalid fields", () => {
  const file = loadCases();
  const item = file.cases[0];
  if (!item) throw new Error("missing case");
  const invalid = [
    { ...file, role: "review" },
    { ...file, version: 2 },
    { ...file, cases: [] },
    { ...file, cases: [item, item] },
    { ...file, repos: {} },
    { ...file, repos: { "bad/repo": "main" } },
    { ...file, repos: { invalid: "a".repeat(40) } },
    ...["task_class", "complexity", "risk", "ambiguity", "needs_questions"].flatMap((key) => [
      { ...file, cases: [{ ...item, gold: { ...item.gold, [key]: "invalid" } }] },
      { ...file, cases: [{ ...item, gold: { ...item.gold, [key]: [] } }] },
    ]),
    { ...file, cases: [{ ...item, prompt: " " }] },
    { ...file, cases: [{ ...item, tags: [4] }] },
  ];
  for (const input of invalid) expect(CaseFileSchema.safeParse(input).success).toBe(false);
  expect(
    CaseFileSchema.parse({
      ...file,
      cases: [{ ...item, notes: "allowed", gold: { ...item.gold, needs_questions: [true, false] } }],
    }).cases,
  ).toHaveLength(1);
  const home = mkdtempSync(join(tmpdir(), "eval-validation-"));
  try {
    const path = join(home, "bad.json");
    writeFileSync(path, "{");
    expect(() => loadCases(path)).toThrow(path);
    writeFileSync(path, JSON.stringify({ ...file, version: 99 }));
    expect(() => loadCases(path)).toThrow("version");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("invalid requests do not schedule or invoke; selections retain dataset order", async () => {
  const f = await evalFixture();
  try {
    const base = { role: "triage", models: ["candidate-a"] };
    for (const over of [
      { role: "review" },
      { role: "holdout" },
      { models: [] },
      { models: ["candidate-a", "candidate-a"] },
      { models: ["unknown"] },
      { k: 0 },
      { k: 1.5 },
      { k: "2" },
      { maxUsd: -1 },
      { maxUsd: Infinity },
      { maxUsd: NaN },
      { cache: "false" },
      { caseIds: [] },
      { caseIds: ["missing"] },
      { caseIds: ["a", "a"] },
    ])
      expect(() => f.factory.evals.submit({ ...base, ...over })).toThrow();
    expect(f.calls).toHaveLength(0);
    expect(f.factory.store.listEvalRuns()).toHaveLength(0);
    const parsed = validateRequest({ ...base, caseIds: ["c", "a"] }, f.dataset, f.factory.router);
    expect(parsed.cases.map((c) => c.id)).toEqual(["a", "c"]);
    expect(parsed.request).toMatchObject({ k: 1, maxUsd: 1, cache: true });
  } finally {
    await f.close();
  }
});

test("default dataset resolves from the application checkout, independently of caller cwd", async () => {
  const home = mkdtempSync(join(tmpdir(), "eval-cwd-"));
  try {
    const module = new URL("../src/evals/cases.ts", import.meta.url).pathname;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {loadCases} from ${JSON.stringify(module)}; console.log(loadCases().cases.length)`,
      ],
      { cwd: home, stdout: "pipe", stderr: "pipe" },
    );
    expect(await new Response(child.stdout).text()).toBe("40\n");
    expect(await child.exited).toBe(0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("review and verify datasets validate pins, nested inputs, labels and unique IDs", async () => {
  const { ReviewCaseFileSchema, VerifyCaseFileSchema, loadRoleCases } = await import("../src/evals/cases.ts");
  const review = ReviewCaseFileSchema.parse(loadRoleCases("review"));
  const verify = VerifyCaseFileSchema.parse(
    loadRoleCases("verify", new URL("./data/evals-verify.json", import.meta.url).pathname),
  );
  expect(review.cases.length).toBeGreaterThan(0);
  expect(verify.cases).toHaveLength(3);
  for (const [file, schema] of [
    [review, ReviewCaseFileSchema],
    [verify, VerifyCaseFileSchema],
  ] as const) {
    const item = file.cases[0];
    if (!item) throw new Error("missing");
    for (const over of [
      { id: " " },
      { base: "main" },
      { head: "abc" },
      { repo: "../oops" },
      { input: { ...item.input, spec: {} } },
      { input: { ...item.input, gates: [{ name: "test" }] } },
    ])
      expect(schema.safeParse({ ...file, cases: [{ ...item, ...over }] }).success).toBe(false);
    expect(schema.safeParse({ ...file, cases: [item, item] }).success).toBe(false);
  }
  const r = review.cases[0];
  const v = verify.cases[0];
  if (!r || !v) throw new Error("missing");
  for (const seedPatch of ["../x", "/tmp/x", "x/../../y", "x\\y", "x\0y"])
    expect(ReviewCaseFileSchema.safeParse({ ...review, cases: [{ ...r, seedPatch }] }).success).toBe(false);
  for (const lines of [[9, 1], [-1, 1], [1.5, 2], [1]])
    expect(
      ReviewCaseFileSchema.safeParse({ ...review, cases: [{ ...r, defects: [{ ...r.defects[0], lines }] }] })
        .success,
    ).toBe(false);
  for (const over of [
    { gold: {} },
    { gold: { unknown: "met" } },
    { gold: { "AC-1": "unclear" } },
    { input: { ...v.input, spec: null } },
    { input: { ...v.input, holdout: { scenarios: [] } } },
    {
      input: {
        ...v.input,
        spec: {
          ...v.input.spec,
          acceptance_criteria: [...v.input.spec.acceptance_criteria, ...v.input.spec.acceptance_criteria],
        },
      },
    },
  ])
    expect(VerifyCaseFileSchema.safeParse({ ...verify, cases: [{ ...v, ...over }] }).success).toBe(false);
});

test("seed symlinks escaping the dataset fail before scheduling", async () => {
  const { reviewCase } = await import("./evals-reading-support.ts");
  const f = await evalFixture();
  try {
    symlinkSync(
      new URL("./evals-reading-support.ts", import.meta.url).pathname,
      join(f.home, "escape.patch"),
    );
    writeFileSync(
      f.casePath,
      JSON.stringify({ role: "review", version: 1, cases: [{ ...reviewCase, seedPatch: "escape.patch" }] }),
    );
    expect(() => f.factory.evals.submit({ role: "review", models: ["candidate-a"] })).toThrow("escapes");
    expect(f.factory.store.listEvalRuns()).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("eval validation resolves defaults, explicit none and rejects malformed or duplicate targets", async () => {
  const { enableEfforts, invalidTargets } = await import("./evals-support.ts");
  const f = await evalFixture();
  try {
    enableEfforts(f);
    for (const models of invalidTargets)
      expect(() => validateRequest({ role: "triage", models }, f.dataset, f.factory.router)).toThrow();
    // Every problem is reported in one pass, not just the first one encountered.
    expect(() =>
      validateRequest(
        { role: "triage", models: ["unknown@low", "candidate-a@max", "candidate-a", "candidate-a@low"] },
        f.dataset,
        f.factory.router,
      ),
    ).toThrow(
      /Invalid eval models: "unknown@low": unknown model ID "unknown"; "candidate-a@max": Unsupported effort "max" for candidate-a.*; duplicate resolved model target candidate-a@low/,
    );
    const { request } = validateRequest(
      { role: "triage", models: ["candidate-a", "candidate-a@high", "candidate-a@none"] },
      f.dataset,
      f.factory.router,
    );
    expect(request.models).toEqual(["candidate-a@low", "candidate-a@high", "candidate-a@none"]);
    expect(f.factory.store.listEvalRuns()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("eval validation rejects efforts the role's harness cannot deliver", async () => {
  const { enableEfforts } = await import("./evals-support.ts");
  const f = await evalFixture();
  try {
    enableEfforts(f);
    // Model candidate-a's provider as a Claude-CLI backend (like OpenRouter or mtplx).
    const provider = f.factory.tracker.def("openrouter");
    if (!provider) throw new Error("missing provider");
    provider.harness = "claude";
    provider.baseUrl = "http://unused.invalid";
    const review = { ...f.dataset, role: "review" } as unknown as Parameters<typeof validateRequest>[1];
    expect(() =>
      validateRequest({ role: "review", models: ["candidate-a@high"] }, review, f.factory.router),
    ).toThrow("cannot carry effort in the review role");
    // Triage is tool-less and reaches the provider over HTTP, which carries effort.
    expect(
      validateRequest({ role: "triage", models: ["candidate-a@high"] }, f.dataset, f.factory.router).request
        .models,
    ).toEqual(["candidate-a@high"]);
  } finally {
    await f.close();
  }
});

test("implement dataset validates pins, spec, paths, duplicate IDs, commands and hidden files before scheduling", () => {
  const home = mkdtempSync(join(tmpdir(), "implement-cases-"));
  const hiddenDir = join(home, "hidden", "one");
  const casePath = join(home, "cases.json");
  mkdirSync(hiddenDir, { recursive: true });
  writeFileSync(join(hiddenDir, "overwrite"), "hidden bytes");
  const original = {
    id: "one",
    repo: "fixture/repo",
    base: "a".repeat(40),
    head: "b".repeat(40),
    prompt: "Implement",
    complexity: "small",
    spec: null,
    source: "fixture",
    tags: [],
    hidden: { files: ["overwrite"], command: "true", timeoutSec: 1 },
  };
  const save = (cases: unknown[] = [original]) =>
    writeFileSync(casePath, JSON.stringify({ role: "implement", version: 1, cases }));
  save();
  try {
    expect(loadRoleCases("implement", casePath).role).toBe("implement");
    for (const over of [
      { id: "../one" },
      { id: "/one" },
      { base: "abc" },
      { head: "z".repeat(40) },
      { repo: "repo" },
      { complexity: "large" },
      { spec: {} },
      { prompt: "  " },
      ...["../escape", "/absolute", "nul\0", "a/../b", ".git/config", "missing"].map((path) => ({
        hidden: { ...original.hidden, files: [path] },
      })),
      { hidden: { ...original.hidden, command: " " } },
      { hidden: { ...original.hidden, timeoutSec: 0 } },
    ]) {
      writeFileSync(
        casePath,
        JSON.stringify({ role: "implement", version: 1, cases: [{ ...original, ...over }] }),
      );
      expect(() => loadRoleCases("implement", casePath)).toThrow();
    }
    writeFileSync(casePath, JSON.stringify({ role: "implement", version: 1, cases: [original, original] }));
    expect(() => loadRoleCases("implement", casePath)).toThrow("duplicate");
    save();
    rmSync(join(hiddenDir, "overwrite"));
    mkdirSync(join(hiddenDir, "overwrite"));
    expect(() => loadRoleCases("implement", casePath)).toThrow("hidden file");
    rmSync(join(hiddenDir, "overwrite"), { recursive: true });
    symlinkSync("/etc/hosts", join(hiddenDir, "overwrite"));
    expect(() => loadRoleCases("implement", casePath)).toThrow("hidden file");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("round control validates before dataset access and preserves independent k", async () => {
  const request = { role: "implement", models: ["candidate-a"], k: 4 };
  expect(EvalRequestSchema.parse(request)).toMatchObject({ rounds: 1, strategy: "retry", k: 4 });
  for (const strategy of ["retry", "effort", "switch"])
    expect(EvalRequestSchema.parse({ ...request, rounds: 3, strategy })).toMatchObject({
      rounds: 3,
      strategy,
      k: 4,
    });
  const f = await evalFixture();
  try {
    for (const rounds of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => f.factory.evals.submit({ ...request, rounds })).toThrow();
    expect(() => f.factory.evals.submit({ ...request, strategy: "unknown" })).toThrow();
    for (const role of ["triage", "review", "verify"])
      for (const options of [{ rounds: 1 }, { strategy: "retry" }])
        expect(() => f.factory.evals.submit({ ...request, role, ...options })).toThrow("implement-only");
    expect(f.calls).toHaveLength(0);
    expect(f.factory.store.listEvalRuns()).toHaveLength(0);
  } finally {
    await f.close();
  }
});
