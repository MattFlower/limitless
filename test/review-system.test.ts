import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalCommand } from "../src/cli/eval.ts";
import type { EvalTrial, ReviewSystem } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { reviewSystemHash } from "../src/evals/cache.ts";
import { validateRequest } from "../src/evals/cases.ts";
import { pickVerifier } from "../src/pipeline/review.ts";
import {
  checkRosterTargets,
  configuredReviewSystem,
  DEFAULT_ROSTERS,
  type EvalReviewSystem,
  parseEvalReviewSystems,
  productionReviewSystem,
  readReviewLenses,
} from "../src/pipeline/review-system.ts";
import { MODELS, type ModelDef, PROVIDERS } from "../src/router/catalog.ts";
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
  [file(panel({ verifier: { target: "verifier-c", targets: ["verifier-c"] } })), '"targets", not both'],
  [file(panel({ verifier: { targets: [] } })), "verifier targets must not be empty"],
  [file(panel({ verifier: { targets: ["verifier-c", "x@"] } })), "expected model or model@effort"],
  [
    file(system({ finders: [{ target: "candidate-a", prompt: "strict" }] })),
    'finder prompt must be "standard", "adversarial" or "careful"',
  ],
  [
    file(system({ finders: [{ target: "candidate-a", prompt: "careful" }] })),
    'mode "single" uses the "standard" prompt',
  ],
  [file(system({ finders: [] })), "exactly one finder"],
  [file(system({ finders: [system().finders[0], system().finders[0]] })), "exactly one finder"],
  [file(system(), system()), 'duplicate review system name "with-report"'],
  [file(system({ name: "" })), "system name must not be empty"],
  [file(system({ implementerReport: "maybe" })), 'implementerReport must be "include" or "omit"'],
  [
    file(panel({ finders: [{ target: "candidate-a", prompt: "careful", lens: { name: "a", focus: "b" } }] })),
    'a lens finder uses the "standard" prompt',
  ],
  [
    file(system({ finders: [{ target: "candidate-a", prompt: "standard", local: true }] })),
    'mode "single" uses the "standard" prompt, with no lens, family or local finder',
  ],
  [
    file(panel({ finders: [{ target: "candidate-a", prompt: "standard", local: true }] })),
    'mode "panel" needs at least one finder that is not local',
  ],
];

test("eval review systems reject unsupported shapes with clear errors", () => {
  for (const [text, message] of invalid)
    expect(() => parseEvalReviewSystems(text, "s.json")).toThrow(message);
  expect(
    parseEvalReviewSystems(file(system(), system({ name: "b", implementerReport: "omit" })), "s.json"),
  ).toEqual([system(), system({ name: "b", implementerReport: "omit" })] as ReviewSystem[]);
  const finders = (["standard", "adversarial", "careful"] as const).map((prompt) => ({
    target: "candidate-a",
    prompt,
  }));
  expect(parseEvalReviewSystems(file(panel({ finders })), "s.json")[0]).toMatchObject({ finders });
});

test("a batch's verifier is the first listed target independent of it, else the first other model", () => {
  const t = (modelId: string, vendor: string) => ({ modelId, vendor });
  const list = [t("a1", "a"), t("o1", "o"), t("a2", "a")];
  expect(pickVerifier(list, ["o"], ["o2"]).modelId).toBe("a1");
  expect(pickVerifier(list, ["a"], ["a1"]).modelId).toBe("o1");
  expect(pickVerifier(list, ["a"], ["a3"]).modelId).toBe("o1");
  expect(pickVerifier(list, ["a", "o"], ["a1", "o1"]).modelId).toBe("a2");
  expect(() => pickVerifier(list, ["a"], ["a1", "a2", "o1"])).toThrow("raised a candidate it would check");
});

test("verifier lists require distinct base models and a model outside all finders", async () => {
  const model = (id: string): ModelDef => ({
    ...verifierModel,
    id,
    supportedEfforts: ["medium", "high"],
    effort: undefined,
  });
  const f = await evalFixture([
    model("claude/opus"),
    model("codex/sol-6.1"),
    model("codex/sol"),
    ...MODELS.filter((m) => m.checkpoint).map((m) => ({ ...m, provider: "provider-b" })),
  ]);
  try {
    const review = { ...f.dataset, role: "review" } as unknown as Parameters<typeof validateRequest>[1];
    const validate = (targets: string[]) =>
      validateRequest(
        {
          role: "review",
          systems: [
            panel({
              finders: ["codex/sol-6.1", "claude/opus"].map((target) => ({ target, prompt: "standard" })),
              verifier: { targets },
            }),
          ],
        },
        review,
        f.factory.router,
      );
    expect(() => validate(["claude/opus", "codex/sol-6.1@high"])).toThrow("not any finder's");
    expect(() => validate(["claude/opus", "claude/opus"])).toThrow("unique by base model id");
    expect(() => validate(["codex/sol@medium", "codex/sol@high"])).toThrow("unique by base model id");
    expect(
      validate(["claude/opus", "codex/sol-6.1@medium", "codex/sol@medium"]).request.systems,
    ).toHaveLength(1);
    const alias = { modelId: "mtplx/qwen-27b", vendor: "qwen" };
    const eligible = { modelId: "codex/sol", vendor: "qwen" };
    const pick = (targets: (typeof alias)[]) =>
      pickVerifier(targets, ["qwen"], ["omlx/qwen-27b"], f.factory.router.checkpointIdentity);
    expect(() => pick([alias])).toThrow("raised a candidate it would check");
    expect(pick([alias, eligible])).toBe(eligible);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
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
  // A panel's roster and lens text are part of what eval caches key on.
  const lensed = (focus: string) =>
    reviewSystemHash({ ...base, finders: [{ prompt: "standard", lens: { name: "ops", focus } }] });
  expect(lensed("Rollback.")).not.toBe(lensed("Restart."));
  expect(reviewSystemHash({ ...base, finders: [{ target: "candidate-b", prompt: "standard" }] })).not.toBe(
    reviewSystemHash(base),
  );
  // A lone verifier target keeps its hash; a list keys on its targets and their order.
  const verified = (verifier: ReviewSystem["verifier"]) =>
    reviewSystemHash({ ...base, mode: "panel", verifier });
  expect(verified({ target: "verifier-c" })).toBe(
    "9abea7c5ba7833dba2740b930f32b26b1aa2476852acf94916d829f964700c35",
  );
  const listed = verified({ targets: ["verifier-c", "candidate-b"] });
  expect(listed).not.toBe(verified({ target: "verifier-c" }));
  expect(listed).not.toBe(verified({ targets: ["candidate-b", "verifier-c"] }));
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
      { role: "review", systems: [panel({ verifier: { targets: ["verifier-c", "nope"] } })] },
      { role: "review", systems: [panel({ verifier: { targets: ["candidate-b"] } })] },
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

test("single mode keeps the production review; a panel takes the profile's roster and its base lenses", () => {
  const lenses = readReviewLenses(
    '[review]\nlenses = [\n  { name = "ops", focus = "Rollback." },\n  { name = "api", focus = "Callers.", profiles = ["standard", "deep"] },\n]\n',
    () => {},
  );
  expect(lenses).toEqual([
    { name: "ops", focus: "Rollback.", profiles: ["deep"] },
    { name: "api", focus: "Callers.", profiles: ["standard", "deep"] },
  ]);
  const cfg = {
    reviewImplementerReport: "omit",
    reviewMode: "single",
    reviewRosters: DEFAULT_ROSTERS,
  } as const;
  for (const profile of ["quick", "standard", "deep"] as const) {
    expect(configuredReviewSystem(cfg, profile, lenses)).toEqual(productionReviewSystem(cfg));
    // A run prepared in single mode read no lenses and stays single.
    const panelMode = { ...cfg, reviewMode: "panel" } as const;
    expect(configuredReviewSystem(panelMode, profile, undefined)).toEqual(productionReviewSystem(cfg));
  }
  const finders = (profile: "quick" | "standard" | "deep") =>
    configuredReviewSystem({ ...cfg, reviewMode: "panel" }, profile, lenses).finders.map(
      ({ prompt, lens, family, local }) => [prompt, lens?.name ?? null, family ?? null, local ?? false],
    );
  const standard = [
    ["adversarial", null, null, false],
    ["careful", null, "implementer", false],
  ];
  expect(finders("quick")).toEqual([["standard", null, null, false]]);
  expect(finders("standard")).toEqual([...standard, ["standard", "api", null, false]]);
  expect(finders("deep")).toEqual([
    ...standard,
    ["standard", "ops", null, false],
    ["standard", "api", null, false],
  ]);
  expect(configuredReviewSystem({ ...cfg, reviewMode: "panel" }, "deep", [])).toMatchObject({
    name: "panel-deep",
    mode: "panel",
    verifier: {},
    implementerReport: "omit",
  });
});

test("a shadow panel's bad roster pin turns the shadow off with a warning; a blocking panel's fails", () => {
  const reviewRosters = {
    ...DEFAULT_ROSTERS,
    standard: [{ prompt: "adversarial" as const, target: "claude/opsu" }],
  };
  const warn = mock((_message: string) => {});
  const check = (reviewShadow: "off" | "panel", reviewMode: "single" | "panel" = "single") =>
    checkRosterTargets({ reviewMode, reviewShadow, reviewRosters }, MODELS, PROVIDERS, warn);
  expect(() => check("off", "panel")).toThrow(
    "review.rosters.standard[0].target claude/opsu: unknown model ID",
  );
  expect(warn).not.toHaveBeenCalled();
  expect(check("panel")).toBe(false);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("claude/opsu: unknown model ID"));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("shadow review disabled until fixed"));
  expect(check("off")).toBe(true);
  expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("(ignored: [review] mode is single)"));
  expect(
    checkRosterTargets(
      { reviewMode: "single", reviewShadow: "panel", reviewRosters: DEFAULT_ROSTERS },
      MODELS,
      PROVIDERS,
      warn,
    ),
  ).toBe(true);
});

test("repo lenses: none when absent; unknown keys ignored with a warning; known keys strict", () => {
  const warnings: string[] = [];
  const read = (toml: string | null) => readReviewLenses(toml, (message) => warnings.push(message));
  expect(read(null)).toEqual([]);
  expect(read('[gates]\nsetup = ["true"]\n')).toEqual([]);
  expect(warnings).toEqual([]);
  // A later release's keys must not fail this release's runs.
  expect(
    read('[review]\nsuppress = ["x"]\nlenses = [{ name = "ops", focus = "Rollback.", paths = ["src/"] }]'),
  ).toEqual([{ name: "ops", focus: "Rollback.", profiles: ["deep"] }]);
  expect(warnings).toEqual([
    "Ignoring unknown .limitless.toml keys: review.suppress, review.lenses[0].paths",
  ]);
  for (const [toml, message] of [
    ['[review]\nlenses = [{ name = "ops" }]', "lenses[0].focus"],
    ['[review]\nlenses = [{ name = "ops", focus = "x", profiles = ["fast"] }]', "lenses[0].profiles[0]"],
    ['[review]\nlenses = [{ name = "ops\\n\\n# Output", focus = "x" }]', "lowercase slug"],
    [`[review]\nlenses = [{ name = "ops", focus = "${"x".repeat(2001)}" }]`, "at most 2000"],
    ['[review]\nlenses = [{ name = "a", focus = "x" }, { name = "a", focus = "y" }]', "unique"],
  ] as const)
    expect(() => read(toml)).toThrow(message);
});

test("an eval system can name a configured roster; it expands to exactly the production finders", async () => {
  const local = { ...verifierModel, id: "local-q", provider: "local", vendor: "meta" as const };
  const f = await evalFixture(
    [verifierModel, local],
    [{ id: "local", label: "Local", harness: "fake", billing: "free", maxConcurrent: 1 }],
  );
  try {
    const review = { ...f.dataset, role: "review" } as unknown as Parameters<typeof validateRequest>[1];
    const reference = {
      name: "standard-roster",
      roster: "standard",
      targets: ["candidate-a", "candidate-b"],
      verifier: { target: "verifier-c" },
      implementerReport: "include",
    };
    expect(parseEvalReviewSystems(file(reference), "s.json")).toEqual([reference] as EvalReviewSystem[]);
    const expanded = validateRequest({ role: "review", systems: [reference] }, review, f.factory.router);
    expect(expanded.request.systems).toEqual([
      {
        name: "standard-roster",
        mode: "panel",
        finders: DEFAULT_ROSTERS.standard.map((finder, i) => ({ ...finder, target: reference.targets[i] })),
        verifier: { target: "verifier-c" },
        implementerReport: "include",
      },
    ]);
    // The daemon's configured roster, plus inline lenses as a base `.limitless.toml` would add them.
    const rosters = { ...DEFAULT_ROSTERS, quick: [{ prompt: "careful" as const }] };
    const lens = { name: "ops", focus: "Rollback." };
    const quick = { ...reference, roster: "quick", targets: ["candidate-a", "candidate-b"], lenses: [lens] };
    expect(
      validateRequest({ role: "review", systems: [quick] }, review, f.factory.router, rosters).request
        .systems?.[0]?.finders,
    ).toEqual([
      { prompt: "careful", target: "candidate-a" },
      { prompt: "standard", lens, target: "candidate-b" },
    ]);
    expect(() =>
      validateRequest(
        { role: "review", systems: [{ ...quick, lenses: [] }] },
        review,
        f.factory.router,
        rosters,
      ),
    ).toThrow("roster quick has 1 finders with its lenses; give 1 targets, not 2");
    // A local finder pins a free model, as production routes it.
    const localRosters = {
      ...DEFAULT_ROSTERS,
      standard: [...DEFAULT_ROSTERS.standard, { prompt: "standard" as const, local: true }],
    };
    const free = { ...reference, targets: ["candidate-a", "candidate-b", "local-q"] };
    expect(
      validateRequest({ role: "review", systems: [free] }, review, f.factory.router, localRosters).request
        .systems?.[0]?.finders[2],
    ).toEqual({ prompt: "standard", local: true, target: "local-q" });
    const paid = { ...free, targets: ["candidate-a", "candidate-b", "candidate-a"] };
    expect(() =>
      validateRequest({ role: "review", systems: [paid] }, review, f.factory.router, localRosters),
    ).toThrow('review system "standard-roster": local finder candidate-a is not a free model');
  } finally {
    await f.close();
  }
});
