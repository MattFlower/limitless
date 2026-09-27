import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaseFileSchema, loadCases, validateRequest } from "../src/evals/cases.ts";
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
