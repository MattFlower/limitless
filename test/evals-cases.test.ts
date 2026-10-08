import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignReviewSplits, pendingReviewText, REVIEW_SPLIT_SEED } from "../scripts/review-pending.ts";
import {
  CaseFileSchema,
  EvalRequestSchema,
  GateComparisonSchema,
  ImplementCaseFileSchema,
  loadCases,
  loadRoleCases,
  ReviewCaseFileSchema,
  ReviewCaseSchema,
  VerifyCaseFileSchema,
  validateRequest,
} from "../src/evals/cases.ts";
import { checkPrivateText, loadPrivateStrings } from "../src/gates/private.ts";
import type { ModelDef } from "../src/router/catalog.ts";
import { evalFixture } from "./evals-support.ts";

test("committed 90 cases load (60 development + 30 held out), including notes and gold alternatives", () => {
  const file = loadCases();
  expect(file.cases).toHaveLength(90);
  // Held-out cases decide routing; wording is tuned only on the other 60, 20 of them long requests.
  expect(file.cases.filter((c) => c.tags.includes("holdout"))).toHaveLength(30);
  expect(file.cases.filter((c) => c.tags.includes("long") && !c.tags.includes("holdout"))).toHaveLength(20);
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
    expect(await new Response(child.stdout).text()).toBe("90\n");
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
    // Gate runs that were killed for exceeding their timeout carry `timedOut` on the result.
    const timedOut = {
      name: "test",
      verdict: "regressed",
      blocking: true,
      result: {
        name: "test",
        command: "bun test",
        ok: false,
        exitCode: null,
        durationMs: 1,
        output: "",
        timedOut: true,
      },
    };
    expect(
      schema.safeParse({ ...file, cases: [{ ...item, input: { ...item.input, gates: [timedOut] } }] })
        .success,
    ).toBe(true);
    const withFailures = { ...timedOut.result, failures: "error: assertion\n(fail) named test" };
    const comparison = { ...timedOut, result: withFailures, firstAttempt: withFailures };
    const withGates = (gate: unknown) => ({
      ...file,
      cases: [{ ...item, input: { ...item.input, gates: [gate] } }],
    });
    expect(schema.safeParse(withGates(comparison)).success).toBe(true);
    for (const field of ["result", "firstAttempt"]) {
      expect(
        schema.safeParse(withGates({ ...comparison, [field]: { ...withFailures, unknown: true } })).success,
      ).toBe(false);
    }
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
        {
          role: "triage",
          models: ["unknown@low", "codex/astra@high", "candidate-a@max", "candidate-a", "candidate-a@low"],
        },
        f.dataset,
        f.factory.router,
      ),
    ).toThrow(
      /Invalid eval models: "unknown@low": unknown model ID "unknown"; "codex\/astra@high": unknown model ID "codex\/astra": GPT-6 Astra was removed from routing on 2026-10-04 \(owner decision\); "candidate-a@max": Unsupported effort "max" for candidate-a.*; duplicate resolved model target candidate-a@low/,
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

test("every role accepts an optional boolean snapshot flag and defaults to plain mode", () => {
  const triage = loadCases();
  const verify = loadRoleCases("verify", new URL("./data/evals-verify.json", import.meta.url).pathname);
  const item = triage.cases[0];
  const verifyItem = verify.cases[0];
  if (!item || !verifyItem) throw new Error("missing case");
  const pins = { repo: "fixture/repo", base: "a".repeat(40), head: "b".repeat(40) };
  const review = { ...pins, id: "r", kind: "clean", source: "s", defects: [] };
  const reviewInput = { prompt: "p", spec: null, implementerReport: "", gates: [] };
  const implement = {
    ...pins,
    id: "i",
    complexity: "small",
    prompt: "p",
    spec: null,
    hidden: { files: [], command: "true" },
    source: "s",
    tags: [],
  };
  const files = [
    [CaseFileSchema, (snapshot?: unknown) => ({ ...triage, cases: [{ ...item, snapshot }] })],
    [
      ReviewCaseFileSchema,
      (snapshot?: unknown) => ({
        role: "review",
        version: 1,
        cases: [{ ...review, input: reviewInput, snapshot }],
      }),
    ],
    [VerifyCaseFileSchema, (snapshot?: unknown) => ({ ...verify, cases: [{ ...verifyItem, snapshot }] })],
    [
      ImplementCaseFileSchema,
      (snapshot?: unknown) => ({ role: "implement", version: 1, cases: [{ ...implement, snapshot }] }),
    ],
  ] as const;
  for (const [schema, file] of files) {
    expect(schema.parse(file(true)).cases[0]?.snapshot).toBe(true);
    expect(schema.parse(file(false)).cases[0]?.snapshot).toBe(false);
    expect(schema.parse(file(undefined)).cases[0]?.snapshot).toBeUndefined();
    for (const bad of ["true", 1, null]) expect(schema.safeParse(file(bad)).success).toBe(false);
  }
});

test("snapshot review cases reject gold defects under the stripped evals/ directory", () => {
  const defect = {
    lines: [1, 2],
    severity: "major",
    category: "bug",
    summary: "s",
    required: true,
    foundBy: "f",
  };
  const file = (snapshot: boolean | undefined, path: string) =>
    ReviewCaseFileSchema.safeParse({
      role: "review",
      version: 1,
      cases: [
        {
          id: "r",
          repo: "fixture/repo",
          base: "a".repeat(40),
          head: "b".repeat(40),
          kind: "real",
          source: "s",
          input: { prompt: "p", spec: null, implementerReport: "", gates: [] },
          defects: [{ ...defect, file: path }],
          snapshot,
        },
      ],
    });
  for (const path of ["evals/review/cases.json", "./evals/x.ts", "evals"]) {
    const result = file(true, path);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(
      "snapshot mode removes evals/, so a gold defect cannot lie under it",
    );
    expect(file(false, path).success).toBe(true);
    expect(file(undefined, path).success).toBe(true);
  }
  for (const path of ["src/evals/x.ts", "evals.ts", "Evals/x.ts"])
    expect(file(true, path).success).toBe(true);
});

test("concurrency defaults to 2 and rejects non-positive, fractional and unsafe values", async () => {
  const request = { role: "triage", models: ["candidate-a"] };
  expect(EvalRequestSchema.parse(request).concurrency).toBe(2);
  expect(EvalRequestSchema.parse({ ...request, concurrency: 5 }).concurrency).toBe(5);
  expect(EvalRequestSchema.parse({ ...request, concurrency: Number.MAX_SAFE_INTEGER }).concurrency).toBe(
    Number.MAX_SAFE_INTEGER,
  );
  const f = await evalFixture();
  try {
    for (const concurrency of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "2"])
      expect(() => f.factory.evals.submit({ ...request, concurrency })).toThrow();
    expect(f.factory.store.listEvalRuns()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("review label history preserves legacy cases and rejects empty, inconsistent and broken chains", async () => {
  const { reviewCase } = await import("./evals-reading-support.ts");
  const entry = {
    from: "clean",
    to: "real",
    on: "2026-10-03",
    rule: "evals/review/LABELS.md",
    by: "independent adjudicator",
    evidence: "reproduction confirmed",
  };
  expect(ReviewCaseSchema.safeParse(reviewCase).success).toBe(true);
  expect(ReviewCaseSchema.safeParse({ ...reviewCase, labelHistory: [entry] }).success).toBe(true);
  expect(
    ReviewCaseSchema.safeParse({
      ...reviewCase,
      labelHistory: [entry, { ...entry, from: "real", to: "seeded" }],
      kind: "seeded",
    }).success,
  ).toBe(true);
  for (const over of [
    { labelHistory: [] },
    { kind: "clean", labelHistory: [entry] },
    { labelHistory: [entry, entry] },
    { labelHistory: [{ ...entry, from: "unknown" }] },
    { labelHistory: [{ ...entry, on: "2026-02-30" }] },
    { labelHistory: [{ ...entry, evidence: " " }] },
  ])
    expect(ReviewCaseSchema.safeParse({ ...reviewCase, ...over }).success).toBe(false);
});

test("adjudicated review cases have required major defects at their pinned heads; other audited labels stay clean", () => {
  const file = ReviewCaseFileSchema.parse(loadRoleCases("review"));
  const expected = [
    ["review-033", "ui/components/InvocationsTable.tsx", [51, 52], "onPointerLeave", "accessibility"],
    ["review-036", "src/pipeline/verification.ts", [17, 18], "publicIds.has", "privacy"],
    [
      "review-037",
      "src/integrations/github-notifier.ts",
      [28, 37],
      "limit: Number.MAX_SAFE_INTEGER",
      "performance",
    ],
    ["review-039", "src/pipeline/engine.ts", [999, 999], "pushBranch", "delivery"],
    ["review-039", "src/git/repos.ts", [332, 338], '"--body-file"', "delivery"],
    ["review-039", "src/pipeline/engine.ts", [964, 968], "recordVerified", "delivery"],
  ] as const;
  for (const [id, path, range, snippet, category] of expected) {
    const item = file.cases.find((c) => c.id === id);
    if (!item) throw new Error(`missing ${id}`);
    expect(item.kind).toBe("real");
    expect(item.labelHistory).toHaveLength(1);
    expect(item.labelHistory?.[0]).toMatchObject({
      from: "clean",
      to: "real",
      on: "2026-10-03",
      rule: "evals/review/LABELS.md",
      by: "adjudication 2026-10-03 (codex/sol-6.1 high), reproduction confirmed by the orchestrator",
    });
    expect(item.defects).toContainEqual(
      expect.objectContaining({ file: path, lines: [...range], severity: "major", required: true, category }),
    );
    expect(item.labelHistory?.[0]?.evidence).toContain("Base");
    // Pinned heads are PR commits that squash merges leave outside main, so CI's checkout lacks them.
    if (spawnSync("git", ["cat-file", "-e", `${item.head}^{commit}`]).status !== 0) continue;
    const source = execFileSync("git", ["show", `${item.head}:${path}`], { encoding: "utf8" }).split("\n");
    expect(range[0]).toBeGreaterThan(0);
    expect(range[1]).toBeLessThan(source.length);
    expect(source.slice(range[0] - 1, range[1]).join("\n")).toContain(snippet);
  }
  for (const id of ["review-010", "review-034", "review-038"]) {
    expect(file.cases.find((c) => c.id === id)).toMatchObject({ kind: "clean", defects: [] });
    expect(file.cases.find((c) => c.id === id)?.labelHistory).toBeUndefined();
  }
  expect(file.cases.find((c) => c.id === "review-039")?.defects).toHaveLength(3);
});

test("recorded gate comparisons accept a confinement verdict and keep rejecting unknown fields", () => {
  const result = { name: "test", command: "bun test", ok: false, exitCode: 1, durationMs: 5, output: "" };
  const confined = {
    name: "test",
    verdict: "confinement_error" as const,
    blocking: true,
    result: { ...result, confinementError: true },
  };
  expect(GateComparisonSchema.parse(confined)).toEqual(confined);
  expect(() => GateComparisonSchema.parse({ ...confined, result: { ...result, unknown: true } })).toThrow();
});

test("review split and adjudication fields are optional, enumerated and strict", () => {
  const file = ReviewCaseFileSchema.parse(loadRoleCases("review"));
  const original = file.cases.find((item) => item.kind === "real");
  const defect = original?.defects[0];
  if (!original || !defect) throw new Error("missing real case");
  const item = { ...original, split: "dev", defects: [{ ...defect, adjudication: "pending" }] };
  expect(ReviewCaseSchema.parse(item)).toMatchObject(item);
  expect(ReviewCaseFileSchema.parse({ ...file, cases: [item] }).cases).toHaveLength(1);
  expect(
    ReviewCaseSchema.parse({
      ...item,
      split: "heldout",
      defects: [{ ...defect, adjudication: "confirmed" }],
    }),
  ).toMatchObject({ split: "heldout", defects: [{ adjudication: "confirmed" }] });
  for (const bad of [
    { ...item, split: "train" },
    { ...item, defects: [{ ...defect, adjudication: "maybe" }] },
    { ...item, unexpected: true },
    { ...item, defects: [{ ...defect, unexpected: true }] },
  ]) {
    expect(ReviewCaseSchema.safeParse(bad).success).toBe(false);
    expect(ReviewCaseFileSchema.safeParse({ ...file, cases: [bad] }).success).toBe(false);
  }
});

test("M5.2 candidates preserve previous cases and load with pins, pending labels and private text checks", () => {
  const file = ReviewCaseFileSchema.parse(loadRoleCases("review"));
  // Fingerprints of the pre-M5.2 parsed cases and notes keep this check meaningful after delivery.
  const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
  expect(fingerprint(JSON.stringify(file.cases.slice(0, 53)))).toBe(
    "3eb00b51b95a621bf9876fca831e55c697a2f9e28c89155a8bce289d1b3a4787",
  );
  expect(fingerprint(file.notes?.split(" M5.2 (")[0] ?? "")).toBe(
    "1918b7714b81731b47bfeac3b0c48571bb028da4915454d4edade4807b14f9b1",
  );
  const added = file.cases.slice(53);
  expect(added).toHaveLength(69);
  expect(added.map((item) => item.id)).toEqual(
    Array.from({ length: 69 }, (_, index) => `review-${String(index + 40).padStart(3, "0")}`),
  );
  const categories = new Set([
    "correctness",
    "logic",
    "security",
    "privacy",
    "concurrency",
    "error-handling",
    "test-gap",
    "completeness",
    "spec-mismatch",
    "resource",
    "performance",
    "data-migration",
    "delivery",
    "accessibility",
    "other",
  ]);
  const privateStrings = loadPrivateStrings();
  const heads = new Set<string>();
  let lastPr = 0;
  for (const item of added) {
    const source = /^pr #(\d+) review \S+ @ ([0-9a-f]{7})$/.exec(item.source);
    if (!source) throw new Error(`invalid source: ${item.id}`);
    const pr = Number(source[1]);
    expect(pr).toBeGreaterThanOrEqual(lastPr);
    lastPr = pr;
    expect(source[2]).toBe(item.head.slice(0, 7));
    expect(item.base).toMatch(/^[0-9a-f]{40}$/);
    expect(item.head).toMatch(/^[0-9a-f]{40}$/);
    expect(item.repo).toBe("MattFlower/limitless");
    if (!item.split) throw new Error(`missing split: ${item.id}`);
    expect(["dev", "heldout"]).toContain(item.split);
    const identity = `${pr}:${item.head}`;
    expect(heads.has(identity)).toBe(false);
    heads.add(identity);
    expect(item.input).toMatchObject({ spec: null, implementerReport: "", gates: [] });
    expect(item.labelHistory).toBeUndefined();
    if (item.kind === "clean") expect(item.defects).toEqual([]);
    else {
      expect(item.kind).toBe("real");
      expect(item.defects.length).toBeGreaterThan(0);
    }
    for (const defect of item.defects) {
      expect(defect.adjudication).toBe("pending");
      expect(categories.has(defect.category)).toBe(true);
      expect(defect.required).toBe(["blocker", "major"].includes(defect.severity));
      expect(defect.lines[0]).toBeGreaterThanOrEqual(0);
      expect(defect.lines[1]).toBeGreaterThanOrEqual(defect.lines[0]);
      expect(defect.file).not.toMatch(/^(?:\/|\.\.\/|.*\\)/);
      expect(defect.summary).toMatch(/^[^.!?]+[.!?]$/);
      if (item.snapshot) expect(defect.file).not.toMatch(/^(\.\/)*evals(\/|$)/);
    }
    const text = JSON.stringify(item);
    expect(text).not.toMatch(
      /\/Users\/|\/home\/|~\/|\.limitless\/|\/private\/|\/var\/folders|[\w.+-]+@[\w-]+\.[\w.]+|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/,
    );
    expect(() => checkPrivateText(text, item.id, privateStrings)).not.toThrow();
  }
});

test("all new review ids validate without scheduling model calls", () => {
  const model: ModelDef = {
    id: "candidate-a",
    provider: "fixture",
    model: "fake",
    vendor: "openai",
    tier: 1,
    origin: "unknown",
    baseOrigin: "unknown",
    supportedEfforts: [],
    price: { input: 0, output: 0 },
  };
  const router: Parameters<typeof validateRequest>[2] = {
    resolve: () => ({ model, effort: undefined, targetId: model.id }),
    resolveFor: () => ({ model, effort: undefined, targetId: model.id }),
    toTarget: () => ({
      modelId: model.id,
      provider: model.provider,
      model: model.model,
      vendor: model.vendor,
      tier: model.tier,
      harness: "fake",
      billing: "free",
    }),
    checkpointIdentity: (id) => id,
    excludeOrigins: undefined,
  };
  const file = ReviewCaseFileSchema.parse(loadRoleCases("review"));
  const caseIds = file.cases.slice(53).map((item) => item.id);
  const result = validateRequest({ role: "review", models: [model.id], caseIds, maxUsd: 0 }, file, router);
  expect(result.cases.map((item) => item.id)).toEqual(caseIds);
});

test("fixed-seed review split groups whole PRs and reproduces the pre-registered assignment", () => {
  const file = ReviewCaseFileSchema.parse(loadRoleCases("review"));
  const recorded = new Map<number, "dev" | "heldout">();
  for (const item of file.cases.slice(53)) {
    const pr = Number(/^pr #(\d+)/.exec(item.source)?.[1]);
    if (!item.split || !pr) throw new Error(`missing split or PR: ${item.id}`);
    const previous = recorded.get(pr);
    if (previous !== undefined) expect(item.split).toBe(previous);
    recorded.set(pr, item.split);
  }
  const prs = [...recorded.keys()];
  expect(assignReviewSplits(prs, REVIEW_SPLIT_SEED)).toEqual(recorded);
  expect(assignReviewSplits([...prs].reverse().concat(prs), REVIEW_SPLIT_SEED)).toEqual(recorded);
  expect(assignReviewSplits(prs, REVIEW_SPLIT_SEED + 1)).not.toEqual(recorded);
  const heldout = [...recorded.values()].filter((split) => split === "heldout").length;
  expect(heldout).toBe(Math.round(prs.length / 3));
  expect(heldout).toBeGreaterThan(0);
  expect(heldout).toBeLessThan(prs.length);
  const labels = readFileSync(new URL("../evals/review/LABELS.md", import.meta.url), "utf8");
  expect(labels).toContain(String(REVIEW_SPLIT_SEED));
  for (const [pr, split] of recorded) expect(labels).toContain(`| #${pr} | ${split} |`);
  // Independent small-vector check protects the algorithm, not just its current dataset output.
  expect([...assignReviewSplits([3, 1, 2], 1)]).toEqual([
    [1, "dev"],
    [2, "heldout"],
    [3, "dev"],
  ]);
});

test("pending review helper prints selected defects and CLI errors without network or model calls", () => {
  const file = ReviewCaseFileSchema.parse(loadRoleCases("review"));
  const item = file.cases.find((c) => c.id === "review-040");
  if (!item) throw new Error("missing candidate");
  const output = pendingReviewText([item.id]);
  const records = output.split("\n\n").map((text) => JSON.parse(text));
  expect(records).toEqual(
    item.defects.map((defect) => ({
      caseId: item.id,
      split: item.split,
      source: item.source,
      base: item.base,
      head: item.head,
      file: defect.file,
      lines: defect.lines,
      severity: defect.severity,
      category: defect.category,
      summary: defect.summary,
    })),
  );
  expect(pendingReviewText().split("\n\n")).toHaveLength(
    file.cases.reduce((count, c) => count + c.defects.filter((d) => d.adjudication === "pending").length, 0),
  );
  const script = new URL("../scripts/review-pending.ts", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [script, item.id], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(output);
  expect(result.stderr).toBe("");
  const unknown = spawnSync(process.execPath, [script, item.id, "missing-case"], { encoding: "utf8" });
  expect(unknown.status).not.toBe(0);
  expect(unknown.stdout).toBe("");
  expect(unknown.stderr).toContain("Unknown case ID: missing-case");
  const clean = spawnSync(process.execPath, [script, "review-108"], { encoding: "utf8" });
  expect(clean.status).toBe(0);
  expect(clean.stdout.trim()).toBe("No pending defects.");

  const home = mkdtempSync(join(tmpdir(), "pending-review-"));
  const casePath = join(home, "cases.json");
  try {
    const confirmed = { ...item, defects: item.defects.map((d) => ({ ...d, adjudication: "confirmed" })) };
    writeFileSync(casePath, JSON.stringify({ ...file, cases: [confirmed] }));
    expect(pendingReviewText([], casePath)).toBe("No pending defects.");
    expect(() => pendingReviewText(["missing-case"], casePath)).toThrow("Unknown case ID");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
