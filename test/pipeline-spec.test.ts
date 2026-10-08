import { describe, expect, test } from "bun:test";
import type { Factory } from "../src/app.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { renderSpec, SpecSchema } from "../src/pipeline/schemas.ts";
import { approve, holdout, pass, pipelineSetup, roleOf, spec, triage, waitFor } from "./pipeline-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start } = pipelineSetup({
  get home() {
    return home;
  },
  set home(value) {
    home = value;
  },
  get repoDir() {
    return repoDir;
  },
  set repoDir(value) {
    repoDir = value;
  },
  get factory() {
    return factory;
  },
  set factory(value) {
    factory = value;
  },
});

describe("pipeline (fake agents, real git + gates)", () => {
  test.each([
    ["small", 7, 3],
    ["small", 7, 7],
    ["trivial", 2, 2],
    ["small", 3, 3],
    ["medium", 5, 5],
    ["large", 8, 8],
  ] as const)("spec size retry: %s %i → %i", async (complexity, initialCount, finalCount) => {
    const oversized = initialCount === 7;
    const prompts: string[] = [];
    const expected = {
      ...spec,
      summary: oversized ? "Retried farewell specification" : spec.summary,
      acceptance_criteria: Array.from({ length: finalCount }, (_, i) => ({
        id: `AC-${i + 1}`,
        criterion: `Farewell behavior ${i + 1}`,
        how_to_verify: "cat farewell.txt",
      })),
    };
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ complexity }) };
      if (role === "spec") {
        prompts.push(s.prompt);
        return {
          structured:
            prompts.length === 1 && oversized
              ? {
                  ...expected,
                  summary: "Initial farewell specification",
                  acceptance_criteria: Array.from({ length: initialCount }, (_, i) => ({
                    ...expected.acceptance_criteria[0],
                    id: `AC-${i + 1}`,
                  })),
                }
              : expected,
        };
      }
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify")
        return {
          structured: {
            ...pass,
            criteria: [
              ...expected.acceptance_criteria.map((a) => ({
                id: a.id,
                status: "met",
                evidence: "observed",
                publicSummary: "",
              })),
              ...pass.criteria.filter((c) => !c.id.startsWith("AC-")),
            ],
          },
        };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(prompts).toHaveLength(oversized ? 2 : 1);
    if (oversized) expect(prompts[1]).toContain("For small complexity, use at most 3 criteria");
    expect(f.store.getRunState<RunState>(run.id)?.spec).toEqual(expected);
    expect(f.store.getArtifact(run.id, "spec.md")).toContain(renderSpec(expected));
    const warnings = f.store.listEvents(run.id).filter((e) => e.message?.startsWith("Kept oversized spec"));
    expect(warnings).toHaveLength(oversized && finalCount === 7 ? 1 : 0);
    if (warnings.length) expect(warnings[0]).toMatchObject({ level: "warn" });
  });

  test.each(["clean", "persistent", "empty", "invalid scope", "scope retry", "new dependency"])(
    "out-of-run criteria retry: %s",
    async (scenario) => {
      const external = {
        id: "AC-2",
        criterion: "the page shows the farewell",
        how_to_verify: "The owner opens the page in a browser",
      };
      const other = { id: "AC-3", criterion: "Page works", how_to_verify: "manual check" };
      const initial = { ...spec, acceptance_criteria: [...spec.acceptance_criteria, external, other] };
      if (scenario === "scope retry" || scenario === "new dependency") initial.summary = "No code changes.";
      if (scenario === "new dependency") initial.acceptance_criteria = spec.acceptance_criteria;
      const retry =
        scenario === "clean"
          ? { ...spec, summary: "Locally verifiable farewell" }
          : scenario === "empty"
            ? { ...spec, acceptance_criteria: [external, { ...other, id: "AC-4" }] }
            : scenario === "invalid scope"
              ? { ...spec, summary: "No code changes." }
              : {
                  ...spec,
                  acceptance_criteria: [...spec.acceptance_criteria, external, { ...other, id: "AC-4" }],
                };
      // Flagged criteria that survive the retry are kept and logged, never dropped.
      const expected = retry;
      const prompts: string[] = [];
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") {
          prompts.push(s.prompt);
          return { structured: prompts.length === 1 ? initial : retry };
        }
        if (role === "holdout") return { structured: holdout };
        if (role === "review") return { structured: approve };
        if (role === "verify") {
          // Every criterion in the stored spec, kept out-of-run ones included, is met.
          const ids = (f.store.getRunState<RunState>(run.id)?.spec?.acceptance_criteria ?? []).map(
            (a) => a.id,
          );
          const met = ids.map((id) => ({ id, status: "met", evidence: "observed", publicSummary: "" }));
          return {
            structured: {
              ...pass,
              criteria: [...met, ...pass.criteria.filter((c) => !c.id.startsWith("AC-"))],
            },
          };
        }
        return { files: { "farewell.txt": "goodbye\n" } };
      });
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        scenario === "invalid scope" ? "failed" : "succeeded",
      );
      expect(prompts).toHaveLength(scenario === "invalid scope" || scenario === "new dependency" ? 3 : 2);
      expect(prompts[scenario === "new dependency" ? 2 : 1]).toContain(
        scenario === "new dependency" ? "AC-2, AC-4" : "AC-2, AC-3",
      );
      if (scenario === "scope retry") expect(prompts[1]).toContain("Invalid specification:");
      if (scenario === "invalid scope") {
        expect(f.store.getArtifact(run.id, "spec.md")).toBeNull();
        expect(f.store.getRun(run.id)?.error).toContain("invalid spec scope");
        return;
      }
      expect(f.store.getRunState<RunState>(run.id)?.spec).toEqual(expected);
      const artifact = f.store.getArtifact(run.id, "spec.md");
      expect(artifact).toContain(expected.summary);
      if (scenario !== "clean") expect(artifact).toContain(other.how_to_verify);
      if (scenario !== "empty") expect(artifact).toContain("farewell.txt says goodbye");
      const kept = f.store
        .listEvents(run.id)
        .filter((e) => e.message?.startsWith("Kept acceptance criteria that may depend"));
      expect(kept.map((e) => e.message)).toEqual(
        scenario === "clean"
          ? []
          : ["Kept acceptance criteria that may depend on something outside the run: AC-2, AC-4"],
      );
    },
  );

  test.each(["summary", "requirement", "criterion", "exhausted", "documentation"])(
    "spec scope validation: %s",
    async (scenario) => {
      const sentence = "This is a specification-only task; do not modify code";
      const invalid = { ...spec };
      if (scenario === "requirement") invalid.requirements = [sentence];
      else if (scenario === "criterion")
        invalid.acceptance_criteria = [{ id: "AC-1", criterion: sentence, how_to_verify: "Inspect" }];
      else invalid.summary = scenario === "documentation" ? "Documentation-only task" : sentence;
      const prompts: string[] = [];
      let implementCalls = 0;
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") {
          prompts.push(s.prompt);
          return { structured: prompts.length === 1 || scenario === "exhausted" ? invalid : spec };
        }
        if (role === "holdout") return { structured: holdout };
        if (role === "review") return { structured: approve };
        if (role === "verify") return { structured: pass };
        implementCalls++;
        return { files: { "farewell.txt": "goodbye\n" } };
      });
      const run = await f.createRun({
        repo: repoDir,
        prompt: scenario === "documentation" ? "Documentation only: add farewell" : "Add farewell",
      });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        scenario === "exhausted" ? "failed" : "succeeded",
      );
      expect(prompts).toHaveLength(scenario === "documentation" ? 1 : 2);
      if (scenario !== "documentation") expect(prompts[1]).toContain(JSON.stringify(sentence));
      expect(implementCalls).toBe(scenario === "exhausted" ? 0 : 1);
      if (scenario === "exhausted") {
        expect(f.store.getArtifact(run.id, "spec.md")).toBeNull();
        expect(f.store.getRunState<RunState>(run.id)?.spec).toBeUndefined();
        expect(f.store.getRun(run.id)?.error).toContain("structured output failed validation");
      } else
        expect(f.store.getArtifact(run.id, "spec.md")).toContain(
          scenario === "documentation" ? invalid.summary : spec.summary,
        );
    },
  );

  test.each([false, true])("spec criterion id feedback retry (exhausted=%s)", async (exhausted) => {
    const invalid = {
      ...spec,
      summary: 42,
      assumptions: [42, 42, 42],
      requirements: [42, 42, 42],
      acceptance_criteria: [{ ...spec.acceptance_criteria[0], id: "H-1" }],
    };
    const parsed = SpecSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message.indexOf("Invalid id H-1")).toBeGreaterThan(500);
    const prompts: string[] = [];
    let implementations = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") {
        prompts.push(s.prompt);
        return { structured: prompts.length === 1 || exhausted ? invalid : spec };
      }
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      implementations++;
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
      exhausted ? "needs_human" : "succeeded",
    );
    expect(prompts).toHaveLength(exhausted ? 4 : 2);
    expect(prompts[1]).toContain("Invalid spec");
    expect(prompts[1]).toContain("Invalid id H-1: use AC-n");
    expect(implementations).toBe(exhausted ? 0 : 1);
    if (exhausted) {
      expect(f.store.getArtifact(run.id, "spec.md")).toBeNull();
      expect(f.store.getRunState<RunState>(run.id)?.spec).toBeUndefined();
    } else expect(f.store.getArtifact(run.id, "spec.md")).toContain("AC-1");
  });

  test.each([false, true])("pinned spec criterion id fallback (exhausted=%s)", async (exhausted) => {
    const calls: AgentSpec[] = [];
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") {
        calls.push(s);
        return {
          structured:
            s.target.modelId === "alpha/m"
              ? { ...spec, acceptance_criteria: [{ ...spec.acceptance_criteria[0], id: "H-1" }] }
              : spec,
        };
      }
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const chain = exhausted ? ["alpha/m"] : ["alpha/m", "beta/m"];
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", models: { spec: chain } });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
      exhausted ? "needs_human" : "succeeded",
    );
    expect(calls.map((s) => s.target.modelId)).toEqual(
      exhausted ? ["alpha/m", "alpha/m"] : ["alpha/m", "alpha/m", "beta/m"],
    );
    expect(calls[1]?.prompt).toContain("Invalid id H-1: use AC-n");
    if (exhausted) {
      const question = f.store.listQuestions(run.id).at(-1)?.question;
      expect(question).toContain("spec; pinned chain: alpha/m");
      expect(question).toContain("alpha/m (validation failed: Invalid id H-1: use AC-n");
      expect(f.store.getArtifact(run.id, "spec.md")).toBeNull();
    } else expect(f.store.getArtifact(run.id, "spec.md")).toContain("AC-1");
  });

  test.each([false, true])(
    "spec criterion id retry preserves unrelated schema fallback (idRetry=%s)",
    async (idRetry) => {
      const prompts: string[] = [];
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") {
          prompts.push(s.prompt);
          if (s.target.provider === "alpha")
            return {
              structured:
                idRetry && prompts.length === 1
                  ? { ...spec, acceptance_criteria: [{ ...spec.acceptance_criteria[0], id: "H-1" }] }
                  : { ...spec, summary: 42 },
            };
          return { structured: spec };
        }
        if (role === "holdout") return { structured: holdout };
        if (role === "review") return { structured: approve };
        if (role === "verify") return { structured: pass };
        return { files: { "farewell.txt": "goodbye\n" } };
      });
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const invocations = f.store.listInvocations(run.id).filter((i) => i.role === "spec");
      expect(invocations.map((i) => [i.provider, i.status])).toEqual([
        ["alpha", "error"],
        ...(idRetry ? [["alpha", "error"]] : []),
        ["beta", "ok"],
      ]);
      if (idRetry) expect(prompts[1]).toContain("Invalid id H-1");
      else expect(prompts[1]).not.toContain("Invalid spec");
      expect(f.store.getArtifact(run.id, "spec.md")).toContain("AC-1");
    },
  );
});
