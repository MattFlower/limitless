import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { fakeConfinement } from "./confinement.ts";
import { reviewOutput } from "./evals-reading-support.ts";
import {
  approve,
  type Handler,
  holdout,
  models,
  pass,
  pipelineSetup,
  policy,
  providers,
  roleOf,
  spec,
  triage,
  waitFor,
} from "./pipeline-support.ts";

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

test.each([
  ["explicit", "x".repeat(80), "x".repeat(80)],
  ["defaulted", undefined, "Triage title"],
  ["legacy matching", "x".repeat(80), "Triage title"],
  ["legacy differing", "Requester title", "Requester title"],
] as const)("triage respects %s title provenance", async (kind, title, expected) => {
  const f = start(() => ({
    structured: triage({ title: "Triage title", ambiguity: "high", blocking_questions: ["Clarify?"] }),
  }));
  const run = await f.createRun({
    repo: repoDir,
    prompt: `${"x".repeat(kind === "explicit" ? 80 : 100)}\nDetails`,
    title,
    profile: "standard",
  });
  expect(run.title).toBe(title ?? "x".repeat(80));
  if (kind.startsWith("legacy"))
    f.store.db.query("UPDATE runs SET title_provenance = NULL WHERE id = ?").run(run.id);
  expect(await waitFor(f, run.id, ["waiting_input", "failed", "needs_human"])).toBe("waiting_input");
  expect(f.store.getRun(run.id)).toMatchObject({
    title: expected,
    titleProvenance: kind.startsWith("legacy") ? null : kind,
  });
});

describe("per-run model chains", () => {
  const reply: Handler = (s) => {
    const role = roleOf(s);
    if (role === "triage") return { structured: triage() };
    if (role === "spec") return { structured: spec };
    if (role === "holdout") return { structured: holdout };
    if (role === "review") return { structured: approve };
    if (role === "verify") return { structured: pass };
    return { files: { "farewell.txt": "goodbye\n" } };
  };
  test("retry inherits or replaces the chain used by the next run", async () => {
    const f = start(reply);
    const original = await f.createRun({
      repo: repoDir,
      prompt: "Add farewell",
      profile: "quick",
      models: { implement: ["beta/m"] },
    });
    const check = async (run: { id: string }, modelId: string) => {
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(
        f.store
          .listInvocations(run.id)
          .filter((i) => i.role === "implement")
          .map((i) => i.modelId),
      ).toEqual([modelId]);
    };
    await check(original, "beta/m");
    await check(await f.retryRun(original.id), "beta/m");
    await check(await f.retryRun(original.id, { implement: ["alpha/m"] }), "alpha/m");
  });
  test("failed stage summaries retain pinned-chain provenance", async () => {
    const f = start((s) =>
      roleOf(s) === "spec"
        ? {
            structured: {
              ...spec,
              acceptance_criteria: [
                { id: "H-1", criterion: "farewell exists", how_to_verify: "cat farewell.txt" },
              ],
            },
          }
        : reply(s),
    );
    const run = await f.createRun({
      repo: repoDir,
      prompt: "Add farewell",
      profile: "standard",
      models: { spec: ["beta/m"] },
    });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    expect(f.store.listStages(run.id).find((s) => s.name === "spec")?.summary).toContain(
      "pinned chain: beta/m",
    );
  });
  test("escalation remembers pinned implementers that failed during capacity fallback", async () => {
    const f = start((s) => {
      if (roleOf(s) !== "implement") return reply(s);
      return s.target.modelId === "alpha/m"
        ? {
            status: "quota",
            error: "transient quota",
            quota: { windows: {}, exhaustedUntil: Date.now() - 1 },
          }
        : { files: { "farewell.txt": "BAD\n" } };
    });
    const run = await f.createRun({
      repo: repoDir,
      prompt: "Add farewell",
      profile: "quick",
      models: { implement: ["alpha/m", "beta/m"] },
    });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    expect(
      f.store
        .listInvocations(run.id)
        .filter((i) => i.role === "implement")
        .map((i) => i.modelId),
    ).toEqual(["alpha/m", "beta/m", "beta/m"]);
    expect(f.store.listQuestions(run.id).at(-1)?.question).toContain("alpha/m (already tried)");
  });
  test("unpinned fallback history prevents escalation from returning to either dispatched model", async () => {
    const alpha = models[0];
    if (!alpha) throw new Error("missing fixture model");
    let quota = true;
    const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "cfg") });
    factory = new Factory(cfg, {
      confinement: fakeConfinement,
      providers,
      models: [...models, { ...alpha, id: "alpha/next", model: "alpha-next" }],
      policy: { ...policy, implement: { default: ["alpha/m", "beta/m", "alpha/next"] } },
      harnesses: {
        fake: fakeHarness((s) => {
          if (roleOf(s) !== "implement") return reply(s);
          if (s.target.modelId === "alpha/m" && quota) {
            quota = false;
            return {
              status: "quota",
              error: "transient quota",
              quota: { windows: {}, exhaustedUntil: Date.now() - 1 },
            };
          }
          return { files: { "farewell.txt": s.target.modelId === "beta/m" ? "BAD\n" : "goodbye\n" } };
        }),
      },
      bootSha: "test-build",
    });
    const f = factory;
    f.start();
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(
      f.store
        .listInvocations(run.id)
        .filter((i) => i.role === "implement")
        .map((i) => i.modelId),
    ).toEqual(["alpha/m", "beta/m", "beta/m", "alpha/next"]);
    expect(f.store.getRunState<RunState>(run.id)?.triedImplementers).toEqual([
      { modelId: "alpha/m", effort: null },
      { modelId: "beta/m", effort: null },
      { modelId: "alpha/next", effort: null },
    ]);
  });
  test.each(["trivial", "large"] as const)(
    "implement override wins at %s complexity; other roles use policy",
    async (complexity) => {
      const f = start((s) => (roleOf(s) === "triage" ? { structured: triage({ complexity }) } : reply(s)));
      const run = await f.createRun({
        repo: repoDir,
        prompt: "Add farewell",
        profile: "standard",
        models: { implement: ["beta/m"] },
      });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const inv = f.store.listInvocations(run.id);
      expect(inv.filter((i) => i.role === "implement").map((i) => i.modelId)).toEqual(["beta/m"]);
      expect(inv.find((i) => i.role === "triage")?.modelId).toBe("alpha/m");
      expect(f.store.listStages(run.id).find((s) => s.name === "implement")?.summary).toContain(
        "pinned chain: beta/m",
      );
      expect(f.store.getArtifact(run.id, "report.md")).toContain("Routing — model experiment");
    },
  );
  test("explicit review, holdout and verify chains override independence and warn", async () => {
    const f = start((s) => {
      expect(s.allowLocalBinding).toBe(roleOf(s) === "verify" ? true : undefined);
      return reply(s);
    });
    const models = { implement: ["alpha/m"], review: ["alpha/m"], holdout: ["alpha/m"], verify: ["alpha/m"] };
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard", models });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    for (const role of ["review", "holdout", "verify"] as const) {
      expect(
        f.store
          .listInvocations(run.id)
          .filter((i) => i.role === role)
          .map((i) => i.modelId),
      ).toEqual(["alpha/m"]);
      expect(
        f.store
          .listEvents(run.id)
          .some(
            (e) =>
              e.level === "warn" &&
              e.message.startsWith(role) &&
              e.message.includes("because this run pinned it"),
          ),
      ).toBe(true);
    }
  });
  test.each([
    ["alpha/m", "beta/m", "unavailable"],
    ["beta/m", "alpha/m", "unavailable"],
    ["beta/m", "alpha/m", "blocked"],
  ] as const)("verify binding and prompt follow chain %s/%s after %s", async (first, second, failure) => {
    const seen: string[] = [];
    const handler: Handler = (s) => {
      if (roleOf(s) !== "verify") {
        expect(s.allowLocalBinding).toBeUndefined();
        return reply(s);
      }
      seen.push(s.target.modelId);
      expect(s.allowLocalBinding).toBe(true);
      expect(s.mode).toBe("readonly");
      expect(s.noTools).toBe(false);
      expect(s.prompt.includes("loopback servers")).toBe(s.target.harness === "codex");
      if (seen.length > 1) return { structured: pass };
      return failure === "unavailable"
        ? { status: "unavailable" }
        : {
            structured: {
              ...pass,
              criteria: pass.criteria.map((c) => ({
                ...c,
                status: "blocked",
                blockedReason: "sandbox",
                evidence: "command denied",
              })),
            },
          };
    };
    const f = start(handler, false, false, {
      providers: providers.map((p) => ({ ...p, harness: p.id === "alpha" ? "claude" : "codex" })),
      harnesses: { claude: fakeHarness(handler), codex: fakeHarness(handler) },
    });
    const run = await f.createRun({
      repo: repoDir,
      prompt: "Add farewell",
      profile: "standard",
      models: { verify: [first, second] },
    });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    // A pinned chain deliberately overrides exclusions, including the environment retry's.
    expect(seen).toEqual([first, failure === "blocked" ? first : second]);
  });
  test("a review chain replaces configured finder preferences and listed panel verifiers", async () => {
    const f = start((s) => {
      if (s.prompt.startsWith("You are a code-review verifier"))
        return {
          structured: {
            results: [
              {
                id: "C1",
                verdict: "REFUTED",
                severity: "low",
                category: "correctness",
                evidence: "Checked farewell text",
                trigger: "none",
              },
            ],
          },
        };
      return roleOf(s) === "review" ? { structured: reviewOutput(1, "minor", "farewell.txt") } : reply(s);
    });
    f.deps.reviewSystem = {
      name: "panel",
      mode: "panel",
      implementerReport: "include",
      finders: [{ target: "beta/m", prompt: "standard" }],
      verifier: { targets: ["alpha/m"] },
    };
    const run = await f.createRun({
      repo: repoDir,
      prompt: "Add farewell",
      profile: "quick",
      models: { review: ["alpha/m", "beta/m"] },
    });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(
      f.store
        .listInvocations(run.id)
        .filter((i) => i.role === "review")
        .map((i) => i.modelId),
    ).toEqual(["alpha/m", "beta/m"]);
  });
  test.each([false, true])(
    "escalation stays inside its two-entry chain (exhausted: %s)",
    async (exhausted) => {
      const implemented: string[] = [];
      const f = start(
        (s) => {
          if (roleOf(s) !== "implement") return reply(s);
          implemented.push(s.target.modelId);
          return {
            files: { "farewell.txt": exhausted || s.target.modelId === "alpha/m" ? "BAD\n" : "goodbye\n" },
          };
        },
        false,
        true,
      );
      f.cfg.maxRounds = 5;
      const run = await f.createRun({
        repo: repoDir,
        prompt: "Add farewell",
        profile: "standard",
        models: { implement: ["alpha/m", "beta/m"] },
      });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        exhausted ? "needs_human" : "succeeded",
      );
      expect(implemented).toEqual(
        exhausted ? ["alpha/m", "alpha/m", "beta/m", "beta/m"] : ["alpha/m", "alpha/m", "beta/m"],
      );
      if (exhausted) {
        const question = f.store.listQuestions(run.id).at(-1)?.question;
        expect(question).toContain("implement; pinned chain: alpha/m, beta/m");
        expect(question).toContain("alpha/m (already tried)");
        expect(question).toContain("beta/m (already tried)");
      }
    },
  );
});
