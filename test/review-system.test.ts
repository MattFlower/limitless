import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalCommand } from "../src/cli/eval.ts";
import type { EvalTrial, ReviewSystem } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { reviewSystemHash } from "../src/evals/cache.ts";
import { validateRequest } from "../src/evals/cases.ts";
import { parseEvalReviewSystems, productionReviewSystem } from "../src/pipeline/review-system.ts";
import { enableEfforts, evalFixture, verifierModel } from "./evals-support.ts";

const system = (over: Record<string, unknown> = {}) => ({
  name: "with-report",
  mode: "single",
  finders: [{ target: "candidate-a", prompt: "standard" }],
  implementerReport: "include",
  ...over,
});
const file = (...systems: unknown[]) => JSON.stringify({ systems });
const panel = (over: Record<string, unknown> = {}) =>
  system({
    name: "panel",
    mode: "panel",
    finders: [
      { target: "candidate-a", prompt: "standard" },
      { target: "candidate-b", prompt: "standard" },
    ],
    verifier: { target: "verifier-c" },
    ...over,
  });

const invalid: [string, string][] = [
  ["{not json", "malformed JSON"],
  [JSON.stringify([system()]), "expected object"],
  [file(), "at least one review system"],
  [file(system({ finders: [{ prompt: "standard" }] })), "needs an explicit finder target"],
  [file(system({ finders: [{ target: "", prompt: "standard" }] })), "empty model ID"],
  [file(system({ finders: [{ target: " ", prompt: "standard" }] })), "without surrounding whitespace"],
  [
    file(system({ finders: [{ target: " candidate-a", prompt: "standard" }] })),
    "without surrounding whitespace",
  ],
  [
    file(system({ finders: [{ target: "candidate-a@", prompt: "standard" }] })),
    "expected model or model@effort",
  ],
  [file(system({ mode: "panel" })), 'mode "panel" needs a verifier'],
  [file(system({ mode: "triad" })), 'use "single" or "panel"'],
  [file(system({ verifier: { target: "candidate-b" } })), 'mode "single" takes no verifier'],
  [file(system({ mode: "panel", finders: [], verifier: { target: "candidate-b" } })), "at least one finder"],
  [file(system({ mode: "panel", verifier: {} })), "needs an explicit verifier target"],
  [
    file(system({ finders: [{ target: "candidate-a", prompt: "strict" }] })),
    'only "standard" is implemented',
  ],
  [file(system({ finders: [] })), "exactly one finder"],
  [file(system({ finders: [system().finders[0], system().finders[0]] })), "exactly one finder"],
  [file(system(), system()), 'duplicate review system name "with-report"'],
  [file(system({ name: "" })), "system name must not be empty"],
  [file(system({ implementerReport: "maybe" })), 'implementerReport must be "include" or "omit"'],
];

test("eval review systems reject unsupported shapes with clear errors", () => {
  for (const [text, message] of invalid)
    expect(() => parseEvalReviewSystems(text, "s.json")).toThrow(message);
  expect(
    parseEvalReviewSystems(file(system(), system({ name: "b", implementerReport: "omit" })), "s.json"),
  ).toEqual([system(), system({ name: "b", implementerReport: "omit" })] as ReviewSystem[]);
});

test("production derives one routed standard finder from [review] implementer_report", () => {
  for (const mode of ["include", "omit"] as const)
    expect(productionReviewSystem({ reviewImplementerReport: mode })).toEqual({
      name: "production",
      mode: "single",
      finders: [{ prompt: "standard" }],
      implementerReport: mode,
    });
});

test("system hash ignores key order and name but not behaviour", () => {
  const base = system() as ReviewSystem;
  const reordered = JSON.parse(
    '{"implementerReport":"include","finders":[{"prompt":"standard","target":"candidate-a"}],"mode":"single","name":"x"}',
  ) as ReviewSystem;
  expect(reviewSystemHash(reordered)).toBe(reviewSystemHash(base));
  expect(reviewSystemHash({ ...base, implementerReport: "omit" })).not.toBe(reviewSystemHash(base));
  expect(reviewSystemHash({ ...base, finders: [{ target: "candidate-b", prompt: "standard" }] })).not.toBe(
    reviewSystemHash(base),
  );
});

test("CLI validates --systems before submitting and keeps --models as one system per model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-systems-"));
  const bodies: unknown[] = [];
  const io = {
    async api<T>(_path: string, init?: RequestInit): Promise<T> {
      bodies.push(JSON.parse(String(init?.body)));
      return { id: "eval-1" } as T;
    },
    print: () => {},
    wait: async () => {},
  };
  try {
    const path = join(dir, "systems.json");
    for (const [text, message] of invalid) {
      writeFileSync(path, text);
      await expect(evalCommand(["run", "review"], { systems: path }, io)).rejects.toThrow(message);
    }
    await expect(evalCommand(["run", "review"], { systems: join(dir, "missing.json") }, io)).rejects.toThrow(
      "cannot read --systems file",
    );
    writeFileSync(path, file(system()));
    await expect(
      evalCommand(["run", "review"], { systems: path, models: "candidate-a" }, io),
    ).rejects.toThrow("mutually exclusive");
    await expect(evalCommand(["run", "triage"], { systems: path }, io)).rejects.toThrow(
      "only supported for review",
    );
    expect(bodies).toEqual([]);
    await evalCommand(["run", "review"], { systems: path, k: "2" }, io);
    await evalCommand(["run", "review"], { models: "candidate-a,candidate-b" }, io);
    expect(bodies).toEqual([
      { role: "review", systems: [system()], k: 2, cache: true },
      { role: "review", models: ["candidate-a", "candidate-b"], cache: true },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("request validation resolves systems, expands --models, and rejects bad systems before scheduling", async () => {
  const f = await evalFixture([verifierModel]);
  try {
    const review = { ...f.dataset, role: "review" } as unknown as Parameters<typeof validateRequest>[1];
    const models = validateRequest(
      { role: "review", models: ["candidate-a", "candidate-b"] },
      review,
      f.factory.router,
    );
    expect(models.request.systems).toEqual(
      ["candidate-a", "candidate-b"].map((target) => ({
        name: target,
        mode: "single",
        finders: [{ target, prompt: "standard" }],
        implementerReport: "include",
      })),
    );
    // Two systems may share a target; their names keep them apart.
    const shared = validateRequest(
      { role: "review", systems: [system(), system({ name: "without", implementerReport: "omit" })] },
      review,
      f.factory.router,
    );
    expect(shared.request.models).toEqual(["candidate-a"]);
    expect(shared.request.systems?.map((s) => [s.name, s.implementerReport])).toEqual([
      ["with-report", "include"],
      ["without", "omit"],
    ]);
    expect(() =>
      validateRequest(
        { role: "review", systems: [system({ finders: [{ target: "nope", prompt: "standard" }] })] },
        review,
        f.factory.router,
      ),
    ).toThrow("Invalid eval models");
    // Targets follow the --models reference rules on both paths; neither trims.
    const padded = " candidate-a";
    expect(() => validateRequest({ role: "review", models: [padded] }, review, f.factory.router)).toThrow(
      "without surrounding whitespace",
    );
    expect(() =>
      validateRequest(
        { role: "review", systems: [system({ finders: [{ target: padded, prompt: "standard" }] })] },
        review,
        f.factory.router,
      ),
    ).toThrow("without surrounding whitespace");
    // Panels resolve every finder and the verifier; the first finder names the candidate model.
    const panels = validateRequest({ role: "review", systems: [panel()] }, review, f.factory.router);
    expect(panels.request.systems).toEqual([panel()] as ReviewSystem[]);
    expect(panels.request.models).toEqual(["candidate-a"]);
    expect(parseEvalReviewSystems(file(panel()), "s.json")).toEqual([panel()] as ReviewSystem[]);
    // Configurations are compared after resolution, ignoring names.
    enableEfforts(f);
    const renamed = [
      system({ name: "x" }),
      system({ name: "y", finders: [{ target: "candidate-a@low", prompt: "standard" }] }),
    ];
    expect(() => validateRequest({ role: "review", systems: renamed }, review, f.factory.router)).toThrow(
      'Invalid review systems: "y" has the same configuration as "x" (names aside)',
    );
    for (const bad of [
      { role: "review", systems: [system({ finders: [{ prompt: "standard" }] })] },
      { role: "review", systems: [system({ mode: "panel" })] },
      { role: "review", systems: [panel({ verifier: { target: "nope" } })] },
      // A verifier sharing a finder's vendor could not check that finder's candidates cross-vendor.
      { role: "review", systems: [panel({ verifier: { target: "candidate-b" } })] },
      { role: "review", systems: [system(), system()] },
      { role: "review", systems: [system(), system({ name: "copy" })] },
      { role: "review", systems: [system()], models: ["candidate-a"] },
      { role: "review" },
      { role: "triage", systems: [system()] },
    ])
      expect(() => f.factory.evals.submit(bad)).toThrow();
    expect(f.factory.store.listEvalRuns()).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("candidates sharing a target stay distinct after a store reload", () => {
  const home = mkdtempSync(join(tmpdir(), "review-systems-store-"));
  const path = join(home, "db.sqlite");
  const systems = [system(), system({ name: "without", implementerReport: "omit" })] as ReviewSystem[];
  const trial = (name: string): EvalTrial => ({
    effort: "default",
    evalRunId: "",
    caseId: "a",
    modelId: "candidate-a",
    trial: 0,
    cacheKey: name,
    harness: "",
    status: "queued",
    output: null,
    pass: null,
    score: null,
    details: { system: name },
    costUsd: 0,
    costEquivUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: 0,
    createdAt: 1,
  });
  try {
    let store = new Store(path);
    const run = store.createEvalRun(
      { role: "review", models: ["candidate-a"], k: 1, maxUsd: 1, systems },
      systems.map((s) => trial(s.name)),
    );
    store.recordEvalTrial({ ...trial("without"), evalRunId: run.id, status: "ok", pass: true });
    store.close();
    store = new Store(path);
    expect(store.getEvalRun(run.id)?.systems).toEqual(systems);
    expect(store.listEvalRuns()[0]?.systems).toEqual(systems);
    expect(store.listEvalTrials(run.id).map((t) => [t.details.system, t.status])).toEqual([
      ["with-report", "queued"],
      ["without", "ok"],
    ]);
    store.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("eval policy counts only systems matching the daemon's [review] implementer_report", async () => {
  const f = await evalFixture();
  try {
    const systems = [system(), system({ name: "without", implementerReport: "omit" })] as ReviewSystem[];
    const trial = (name: string): EvalTrial => ({
      effort: "default",
      evalRunId: "",
      caseId: "a",
      modelId: "candidate-a",
      trial: 0,
      cacheKey: name,
      harness: "fake",
      status: "ok",
      output: {},
      pass: name === "with-report",
      score: name === "with-report" ? 1 : 0,
      details: { system: name },
      costUsd: 0,
      costEquivUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 1,
      createdAt: 1,
    });
    const run = f.factory.store.createEvalRun(
      { role: "review", models: ["candidate-a"], k: 1, maxUsd: 1, systems },
      systems.map((s) => trial(s.name)),
    );
    f.factory.store.updateEvalRun(run.id, "completed");
    const counted = () =>
      f.factory
        .evalPolicy([run.id])
        .evaluation.roles.find((r) => r.role === "review")
        ?.candidates.map((c) => [c.modelId, c.summary.candidate, c.summary.passRate]);
    expect(counted()).toEqual([["candidate-a", "with-report", 1]]);
    f.cfg.reviewImplementerReport = "omit";
    expect(counted()).toEqual([["candidate-a", "without", 0]]);
  } finally {
    await f.close();
  }
});
