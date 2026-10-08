import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { readingTimeout } from "../src/pipeline/engine.ts";
import { LOCAL_FINDER_TIMEOUT_MS } from "../src/pipeline/review.ts";
import { LaterReviewSchema, ReviewSchema, toStrictJsonSchema } from "../src/pipeline/schemas.ts";
import { Router } from "../src/router/router.ts";
import { sh } from "../src/util/proc.ts";
import { reviewOutput } from "./evals-reading-support.ts";
import {
  approve,
  type Handler,
  holdout,
  pass,
  pipelineSetup,
  policy,
  roleOf,
  spec,
  triage,
  waitFor,
} from "./pipeline-support.ts";
import { attributionEvidence, findingEvidence } from "./review-support.ts";

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
  test("replayed review retains one omitted follow-up on the same round and SHA", async () => {
    let reviews = 0;
    const specs: AgentSpec[] = [];
    const finding = (title: string, label?: "new") => ({
      severity: "major" as const,
      security: false,
      ...findingEvidence,
      ...(label ? { label, prior: "" } : {}),
      file: "farewell.txt",
      line: 1,
      title,
      detail: title,
      suggestion: "Fix",
    });
    const handler: Handler = (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        reviews = specs.push(s);
        return { structured: { ...approve, findings: reviews === 1 ? [finding("First blocker")] : [] } };
      }
      return { files: { "farewell.txt": `goodbye ${reviews}\n` } };
    };
    const f = start(handler);
    f.deps.faults = {
      "stage:review:before": {
        action: "kill",
        occurrence: 2,
        onHit: ({ runId }) => {
          const state = f.store.getRunState<RunState>(runId);
          if (!state?.worktreePath) throw new Error("missing replay worktree");
          const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: state.worktreePath })
            .stdout.toString()
            .trim();
          const followUp = finding("Backlog idea", "new");
          // History recorded before finding schema v2 has none of its fields.
          const legacy = state.reviewHistory?.map((entry) => ({
            ...entry,
            blocking: entry.blocking.map(
              ({ failure_scenario, category, confidence, introduced_by_diff, ...f }) => f,
            ),
          }));
          state.reviewHistory = [...(legacy ?? []), { round: 1, sha, blocking: [], followUps: [followUp] }];
          state.reviewFollowUps = [followUp];
          f.store.setRunState(runId, state);
        },
      },
    };
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    const deadline = Date.now() + 10_000;
    while (
      f.store.listStages(run.id).at(-1)?.name !== "review" ||
      f.store.listStages(run.id).at(-1)?.status !== "cancelled"
    ) {
      if (Date.now() > deadline) throw new Error("review interruption timed out");
      await Bun.sleep(10);
    }
    await f.stop();
    f.store.close();
    const resumed = start(handler);
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(reviews).toBe(2);
    expect(resumed.store.getRunState<RunState>(run.id)?.reviewFollowUps?.map((v) => v.title)).toEqual([
      "Backlog idea",
    ]);
    const followUps = resumed.store.getArtifact(run.id, "report.md")?.split("## Review follow-ups")[1];
    expect(followUps?.match(/^- major: `farewell\.txt:1` Backlog idea/gm)).toHaveLength(1);
    const [first, later] = specs;
    expect(first).toMatchObject({ mode: "readonly", timeoutMs: readingTimeout(1) });
    expect([first?.schema, later?.schema]).toEqual([ReviewSchema, LaterReviewSchema]);
    expect(first?.jsonSchema).toEqual(toStrictJsonSchema(ReviewSchema));
    expect(later?.prompt).toContain("First blocker");
    expect(later?.prompt).not.toContain('"confidence"');
    const artifact = JSON.parse(resumed.store.getArtifact(run.id, "review-0.json") ?? "{}");
    expect(artifact).toMatchObject({ verdict: "request_changes", modelVerdict: "approve" });
  });
});

describe("pipeline (fake agents, real git + gates)", () => {
  test.each([undefined, "include", "omit"] as const)(
    "production review system is one routed finder honoring implementer_report=%s",
    async (mode) => {
      const reviews: AgentSpec[] = [];
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") {
          reviews.push(s);
          return { structured: approve };
        }
        return { files: { "farewell.txt": "goodbye\n" }, text: "IMPLEMENTER_SAYS_DONE" };
      });
      if (mode) f.deps.cfg.reviewImplementerReport = mode;
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(reviews.map((s) => s.target.provider)).toEqual(["beta"]);
      const included = mode !== "omit";
      expect(reviews[0]?.prompt.includes("# Implementer's own report")).toBe(included);
      expect(reviews[0]?.prompt.includes("IMPLEMENTER_SAYS_DONE")).toBe(included);
    },
  );

  test.each([false, true])(
    "panel mode: deep roster plus base lenses, local=%s",
    async (configuredLocal) => {
      const lens = (focus: string) => `[review]\nlenses = [{ name = "ops", focus = "${focus}" }]\n`;
      const toml = readFileSync(join(repoDir, ".limitless.toml"), "utf8");
      writeFileSync(join(repoDir, ".limitless.toml"), `${toml}${lens("BASE_FOCUS")}`);
      await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "lens"], {
        cwd: repoDir,
      });
      const reviews: AgentSpec[] = [];
      let verifications = 0;
      let implementations = 0;
      const f = start((s) => {
        if (s.prompt.startsWith("You are a code-review verifier")) {
          // R1's finding is real; R2's recheck finds it fixed.
          const ruling = {
            verdict: verifications++ ? "REFUTED" : "CONFIRMED",
            severity: "high",
            evidence: "a:1",
          };
          const ids = [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => m[1]);
          return {
            structured: {
              results: ids.map((id) => ({ id, ...ruling, category: "correctness", trigger: "x" })),
            },
          };
        }
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "deep" }) };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "verify") return { structured: pass };
        if (role === "review") {
          reviews.push(s);
          const finding = {
            ...findingEvidence,
            severity: "major",
            file: "farewell.txt",
            line: 1,
            title: "Terse",
          };
          const found = s.prompt.startsWith("You are an adversarial") && !s.prompt.includes("review R2");
          const findings = found ? [{ ...finding, detail: "d", suggestion: "s", security: false }] : [];
          return { structured: { ...approve, findings } };
        }
        // The change under review rewrites the lens; every review must keep the base's.
        const farewell = implementations++ ? "goodbye!\n" : "goodbye\n";
        return { files: { "farewell.txt": farewell, ".limitless.toml": `${toml}${lens("HEAD_FOCUS")}` } };
      });
      f.deps.cfg.reviewMode = "panel";
      if (configuredLocal)
        f.deps.cfg.reviewRosters.deep = [
          ...f.deps.cfg.reviewRosters.deep,
          { prompt: "standard", lens: { name: "failure-paths", focus: "Failure paths." }, local: true },
        ];
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "deep" });
      // Two implementation/panel rounds exceeded waitFor's 20 s deadline under git subprocess load.
      // Budget both rounds, with a longer Bun timeout for fixture setup and cancellation/cleanup.
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"], 40_000)).toBe("succeeded");
      expect(f.store.getArtifact(run.id, "diff.patch")).toContain("HEAD_FOCUS");
      const prompts = reviews.map((s) => s.prompt);
      expect(prompts.filter((p) => p.includes("review R2"))).toHaveLength(3);
      expect(prompts.filter((p) => p.includes("BASE_FOCUS"))).toHaveLength(2);
      expect(prompts.some((p) => p.includes("HEAD_FOCUS"))).toBe(false);
      // Adversarial avoids the implementer's vendor, careful takes its family, the lens finder is cross-vendor.
      for (const review of [1, 2])
        expect(
          JSON.parse(f.store.getArtifact(run.id, `review-${review}.json`) ?? "{}").panel.finders,
        ).toEqual([
          { prompt: "adversarial", vendor: "openai" },
          // The careful finder took the implementer's own model, in a fresh session.
          { prompt: "careful", vendor: "anthropic", implementerModel: true },
          ...(configuredLocal
            ? [
                {
                  prompt: "standard",
                  lens: "failure-paths",
                  vendor: null,
                  skipped: expect.stringContaining("No model available for review"),
                },
              ]
            : []),
          { prompt: "standard", lens: "ops", vendor: "openai" },
        ]);
    },
    60_000,
  );

  test("panel mode: one deadline covers a local finder's fallbacks, and its skip says why", async () => {
    const local: number[] = [];
    const f = start(
      (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "verify") return { structured: pass };
        if (role !== "review") return { files: { "farewell.txt": "goodbye\n" } };
        if (!s.prompt.includes("# Lens: failure-paths")) return { structured: approve };
        local.push(s.timeoutMs);
        return { fault: "timeout", delayMs: 50 };
      },
      false,
      true,
    );
    f.deps.cfg.reviewMode = "panel";
    f.deps.cfg.reviewRosters.standard = [
      ...f.deps.cfg.reviewRosters.standard,
      { prompt: "standard", lens: { name: "failure-paths", focus: "Failure paths." }, local: true },
    ];
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    // Both free models were tried, the second with only what was left of the first's time.
    expect(local).toHaveLength(2);
    const [first = 0, second = 0] = local;
    expect(first).toBeLessThanOrEqual(LOCAL_FINDER_TIMEOUT_MS);
    expect(second).toBeLessThanOrEqual(first - 50);
    const finders = JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}").panel.finders;
    expect(finders[2]).toMatchObject({ vendor: null, skipped: expect.stringContaining("harness timeout") });
  });

  test("panel mode on free-first runs: the verifier is independent of the implementer and the finder", async () => {
    const calls: { role: string; model: string; vendor: string }[] = [];
    let implementations = 0;
    const f = start(
      (s) => {
        const verifier = s.prompt.startsWith("You are a code-review verifier");
        const role = verifier ? "verifier" : roleOf(s);
        calls.push({ role, model: s.target.modelId, vendor: s.target.vendor });
        if (verifier) {
          const ids = [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => m[1]);
          const ruling = {
            verdict: "REFUTED",
            severity: "low",
            category: "correctness",
            evidence: "a:1",
            trigger: "x",
          };
          return { structured: { results: ids.map((id) => ({ id, ...ruling })) } };
        }
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") {
          const finding = {
            ...findingEvidence,
            severity: "major",
            file: "farewell.txt",
            line: 1,
            title: "T",
          };
          return {
            structured: {
              ...approve,
              findings: [{ ...finding, detail: "d", suggestion: "s", security: false }],
            },
          };
        }
        return { files: { "farewell.txt": implementations++ ? "goodbye!\n" : "goodbye\n" } };
      },
      false,
      true,
    );
    f.deps.cfg.reviewMode = "panel";
    const run = await f.createRun({
      repo: repoDir,
      prompt: "Add farewell",
      profile: "quick",
      requestedBy: "dependabot[bot]",
    });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const [implementer, finder, verifier] = ["implement", "review", "verifier"].map((role) =>
      calls.find((c) => c.role === role),
    );
    // Free-first picks free models for the implementer and the finder, but not an unindependent verifier.
    expect([implementer?.model, finder?.model]).toEqual(["gamma/m", "delta/m"]);
    expect(verifier?.model).not.toBe(implementer?.model);
    expect(verifier?.vendor).not.toBe(finder?.vendor);
    expect(verifier?.model).toBe("alpha/m");
  });
});

test("panel review: a refuted blocker doesn't block, a CONFIRMED low does, and verifiers avoid the finder's vendor", async () => {
  const candidate = (title: string, severity: string) => ({
    severity,
    security: false,
    ...findingEvidence,
    file: "farewell.txt",
    line: 1,
    title,
    detail: `SECRET_DETAIL ${title}`,
    suggestion: "Fix it",
  });
  const rulings: Record<string, [string, string]> = {
    C1: ["REFUTED", "critical"],
    C2: ["CONFIRMED", "low"],
    C3: ["PLAUSIBLE", "medium"],
  };
  const verifiers: AgentSpec[] = [];
  const implementPrompts: string[] = [];
  const f = start((s) => {
    if (s.prompt.startsWith("You are a code-review verifier")) {
      verifiers.push(s);
      const ids = [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => m[1] ?? "");
      return {
        structured: {
          results: ids.map((id) => ({
            id,
            verdict: rulings[id]?.[0],
            severity: rulings[id]?.[1],
            category: "correctness",
            evidence: `farewell.txt:1 \`bye\` (${id})`,
            trigger: `reading the file -> wrong farewell (${id})`,
          })),
        },
      };
    }
    const role = roleOf(s);
    if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
    if (role === "review")
      return {
        structured: s.prompt.includes("# Previous review")
          ? { verdict: "approve", summary: "P1 fixed; no regressions found.", findings: [] }
          : {
              verdict: "request_changes",
              summary: "Found problems in the farewell text.",
              findings: [
                candidate("Refuted blocker", "blocker"),
                candidate("Confirmed low", "minor"),
                candidate("Plausible medium", "major"),
              ],
            },
      };
    implementPrompts.push(s.prompt);
    return { files: { "farewell.txt": `goodbye ${implementPrompts.length}\n` } };
  });
  f.deps.reviewSystem = {
    name: "panel",
    mode: "panel",
    finders: [{ prompt: "standard" }],
    verifier: {},
    implementerReport: "include",
  };
  const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  // Implementer alpha (anthropic) -> finder beta (openai) -> verifier routed away from openai.
  expect(
    f.store
      .listInvocations(run.id)
      .filter((i) => i.role === "review")
      .map((i) => i.modelId),
  ).toEqual(["beta/m", "alpha/m", "beta/m", "beta/m"]);
  // R2's finder repeated nothing, so the verifier rechecks P1 itself (as C1, refuted: fixed). No
  // finder raised that candidate, so there is no finder vendor to route away from.
  expect(verifiers.map((s) => [s.target.vendor, s.mode])).toEqual([
    ["anthropic", "readonly"],
    ["openai", "readonly"],
  ]);
  expect(verifiers[1]?.prompt).toContain('"status": "not repeated by any finder; recheck it as C1"');
  expect(verifiers[1]?.prompt).toMatch(/"title": "Confirmed low",[\s\S]*"prior": "P1"/);
  for (const s of verifiers) expect(s.prompt).not.toContain("SECRET_DETAIL");
  expect(implementPrompts).toHaveLength(2);
  const feedback = implementPrompts[1] ?? "";
  expect(feedback).toContain("**low** farewell.txt:1 — Confirmed low");
  expect(feedback).toContain("farewell.txt:1 `bye` (C2)");
  expect(feedback).toContain("Trigger: reading the file -> wrong farewell (C2)");
  for (const dropped of ["Refuted blocker", "Plausible medium"]) expect(feedback).not.toContain(dropped);
  expect(f.store.getArtifact(run.id, "review-0.json")).toBeNull();
  const artifact = JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}");
  expect(artifact).toMatchObject({
    mode: "panel",
    verdict: "request_changes",
    round: 0,
    panelReview: 1,
    panel: { refuted: ["C1"], capped: [] },
  });
  expect(JSON.parse(f.store.getArtifact(run.id, "review-2.json") ?? "{}")).toMatchObject({
    verdict: "approve",
    round: 1,
    panelReview: 2,
    panel: { refuted: ["C1"], candidates: [{ id: "C1", title: "Confirmed low", finder: null, prior: "P1" }] },
  });
  expect(artifact.blocking.map((b: { title: string }) => b.title)).toEqual(["Confirmed low"]);
  expect(artifact.panel.candidates.map((c: { id: string; title: string }) => [c.id, c.title])).toEqual([
    ["C1", "Refuted blocker"],
    ["C2", "Confirmed low"],
    ["C3", "Plausible medium"],
  ]);
  expect(artifact.panel.verdicts.map((v: { id: string; verdict: string }) => [v.id, v.verdict])).toEqual([
    ["C1", "REFUTED"],
    ["C2", "CONFIRMED"],
    ["C3", "PLAUSIBLE"],
  ]);
  const state = f.store.getRunState<RunState>(run.id);
  expect(state?.reviewFollowUps?.map((x) => x.title)).toEqual(["Plausible medium"]);
  const report = f.store.getArtifact(run.id, "report.md") ?? "";
  expect(report).toContain("- medium: `farewell.txt:1` Plausible medium");
  expect(report).not.toContain("Refuted blocker");
});

test("causal panel feedback includes exactly the decision's blockers", async () => {
  const implementPrompts: string[] = [];
  const f = start((s) => {
    if (s.prompt.startsWith("You are a code-review verifier")) {
      const fix = s.prompt.includes("the fix diff only");
      return {
        structured: {
          results: [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => ({
            id: m[1],
            verdict: fix ? "REFUTED" : "CONFIRMED",
            severity: "high",
            category: "correctness",
            evidence: "farewell.txt:1 wrong text",
            trigger: "read -> wrong result",
            attribution: m[1] === "C2" ? "preexisting_unchanged" : "introduced",
            attributionEvidence,
          })),
        },
      };
    }
    const role = roleOf(s);
    if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
    if (role === "review")
      return {
        structured: {
          verdict: "request_changes",
          summary: "Inspected the farewell text and its input handling.",
          findings: s.prompt.includes("# Previous review")
            ? []
            : ["Introduced defect", "Old defect"].map((title, i) => ({
                severity: "major",
                security: false,
                ...findingEvidence,
                file: "farewell.txt",
                line: i + 1,
                title,
                detail: title,
                suggestion: "Fix it",
              })),
        },
      };
    implementPrompts.push(s.prompt);
    return { files: { "farewell.txt": `goodbye ${implementPrompts.length}\n` } };
  });
  f.deps.reviewSystem = {
    name: "causal",
    mode: "panel",
    causalAttribution: true,
    finders: [{ prompt: "standard" }],
    verifier: {},
    implementerReport: "include",
  };
  const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  const artifact = JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}");
  expect(artifact.verdict).toBe("request_changes");
  expect(artifact.blocking.map((b: { title: string }) => b.title)).toEqual(["Introduced defect"]);
  expect(implementPrompts).toHaveLength(2);
  expect(implementPrompts[1]).toContain("Introduced defect");
  expect(implementPrompts[1]).not.toContain("Old defect");
  expect(f.store.getRunState<RunState>(run.id)?.reviewFollowUps?.map((f) => f.title)).toEqual(["Old defect"]);
});

test("panel review: a verifier that omits candidates is retried once, then they stay unverified follow-ups", async () => {
  const candidate = (title: string) => ({
    severity: "blocker",
    security: false,
    ...findingEvidence,
    file: "farewell.txt",
    line: 1,
    title,
    detail: `Detail ${title}`,
    suggestion: "Fix it",
  });
  const verifierIds: string[][] = [];
  const f = start((s) => {
    if (s.prompt.startsWith("You are a code-review verifier")) {
      const ids = [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => m[1] ?? "");
      verifierIds.push(ids);
      // Rules on C1 only; C2 is never answered.
      return {
        structured: {
          results: ids
            .filter((id) => id === "C1")
            .map((id) => ({
              id,
              verdict: "PLAUSIBLE",
              severity: "medium",
              category: "correctness",
              evidence: "farewell.txt:1 `bye`",
              trigger: "reading the file -> wrong farewell",
            })),
        },
      };
    }
    const role = roleOf(s);
    if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
    if (role === "review")
      return {
        structured: {
          verdict: "request_changes",
          summary: "Found problems in the farewell text.",
          findings: [candidate("Answered"), candidate("Omitted")],
        },
      };
    return { files: { "farewell.txt": "goodbye\n" } };
  });
  f.deps.reviewSystem = {
    name: "panel",
    mode: "panel",
    finders: [{ prompt: "standard" }],
    verifier: {},
    implementerReport: "include",
  };
  const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(verifierIds).toEqual([["C1", "C2"], ["C2"]]);
  const artifact = JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}");
  expect(artifact).toMatchObject({ verdict: "approve", blocking: [], panel: { omitted: ["C2"] } });
  const state = f.store.getRunState<RunState>(run.id);
  expect(state?.reviewFollowUps?.map((x) => [x.title, x.verification?.verdict])).toEqual([
    ["Answered", "PLAUSIBLE"],
    ["Omitted", undefined],
  ]);
  const warnings = f.store
    .listEvents(run.id)
    .filter((e) => e.level === "warn")
    .map((e) => e.message);
  expect(warnings).toContainEqual(expect.stringContaining("Verifier gave no ruling for C2"));
});

test("panel review: a verifier left on the finder's vendor is another model, with a recorded warning", async () => {
  const verifiers: string[] = [];
  const f = start(
    (s) => {
      if (s.prompt.startsWith("You are a code-review verifier")) {
        verifiers.push(s.target.modelId);
        const ids = [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => m[1] ?? "");
        return {
          structured: {
            results: ids.map((id) => ({
              id,
              verdict: "PLAUSIBLE",
              severity: "low",
              category: "correctness",
              evidence: "farewell.txt:1 `bye`",
              trigger: "reading the file -> wrong farewell",
            })),
          },
        };
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review")
        return {
          structured: {
            verdict: "approve",
            summary: "One small note on the farewell text.",
            findings: [
              {
                severity: "minor",
                security: false,
                ...findingEvidence,
                file: "farewell.txt",
                line: 1,
                title: "Note",
                detail: "d",
                suggestion: "s",
              },
            ],
          },
        };
      return { files: { "farewell.txt": "goodbye\n" } };
    },
    false,
    true,
  );
  // Only one vendor is routable, so the verifier cannot avoid the finder's; it may not reuse its model.
  f.tracker.record("beta", "quota", { exhaustedUntil: Date.now() + 3_600_000 });
  f.deps.reviewSystem = {
    name: "panel",
    mode: "panel",
    finders: [{ prompt: "standard" }],
    verifier: { target: "gamma/m" },
    implementerReport: "include",
  };
  const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(verifiers).toEqual(["gamma/m"]);
  const warning =
    "Verifier gamma/m shares vendor anthropic with a finder it checks (C1); no other vendor was available";
  expect(JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}").panel.warnings).toEqual([warning]);
  expect(f.store.listEvents(run.id).map((e) => e.message)).toContain(warning);
  // With nothing but the finder's own model, there is no verifier: the run goes to a human.
  f.tracker.setEnabled("gamma", false);
  const alone = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, alone.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
  expect(verifiers).toEqual(["gamma/m"]);
  expect(f.store.getRun(alone.id)?.error).toContain("alpha/m (raised a candidate it would verify)");
  // A listed verifier is picked per batch, past the finder's own model, to one routing would not offer.
  Object.assign(f.deps.reviewSystem ?? {}, { verifier: { targets: ["alpha/m", "delta/m"] } });
  const listed = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, listed.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(verifiers).toEqual(["gamma/m", "delta/m"]);
  // The picked target alone is offered: with it down, routing never falls back to an unlisted model.
  f.tracker.setEnabled("gamma", true);
  f.tracker.setEnabled("delta", false);
  const down = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, down.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
  expect(verifiers).toEqual(["gamma/m", "delta/m"]);
  expect(f.store.getRun(down.id)?.error).toContain("delta/m (disabled)");
  Object.assign(f.deps.reviewSystem ?? {}, { verifier: { targets: ["alpha/m"] } });
  const noVerifier = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, noVerifier.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
  expect(verifiers).toEqual(["gamma/m", "delta/m"]);
  expect(f.store.getRun(noVerifier.id)?.error).toContain("raised a candidate it would check");
});

test("panel review: listed verifiers filter origins before independence selection and fail when all are excluded", async () => {
  const verifiers: string[] = [];
  const f = start(
    (s) => {
      if (s.prompt.startsWith("You are a code-review verifier")) {
        verifiers.push(s.target.modelId);
        return {
          structured: {
            results: [
              {
                id: "C1",
                verdict: "REFUTED",
                severity: "low",
                category: "correctness",
                evidence: "Checked the farewell text",
                trigger: "none",
              },
            ],
          },
        };
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: reviewOutput(1, "minor", "farewell.txt") };
      return { files: { "farewell.txt": "goodbye\n" } };
    },
    false,
    true,
  );
  const catalog = ["alpha/m", "beta/m", "gamma/m", "delta/m"].map((id) => {
    const model = f.router.model(id);
    if (!model) throw new Error(`missing ${id} model`);
    const origin = id === "delta/m" ? "CN" : "US";
    return { ...model, origin, baseOrigin: origin };
  });
  f.deps.router = new Router(f.tracker, policy, catalog, [], ["CN"]);
  f.deps.reviewSystem = {
    name: "panel",
    mode: "panel",
    implementerReport: "include",
    finders: [{ target: "alpha/m", prompt: "standard" }],
    verifier: { targets: ["delta/m", "gamma/m", "beta/m"] },
  };
  const allowed = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, allowed.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(verifiers).toEqual(["beta/m"]);
  // With independent vendors removed from the roster, the allowed same-vendor model still verifies.
  f.deps.reviewSystem.verifier = { targets: ["delta/m", "gamma/m"] };
  const sameVendor = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, sameVendor.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(verifiers).toEqual(["beta/m", "gamma/m"]);
  f.deps.reviewSystem.verifier = { targets: ["delta/m"] };
  const blocked = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, blocked.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
  expect(f.store.getRun(blocked.id)?.error).toContain("origin excluded (CN; baseOrigin=CN)");
  expect(verifiers).toEqual(["beta/m", "gamma/m"]);
});

test("panel review: batches from different vendors go to different listed verifiers", async () => {
  const verifiers: [string, string[]][] = [];
  const f = start(
    (s) => {
      if (s.prompt.startsWith("You are a code-review verifier")) {
        const ids = [...s.prompt.matchAll(/"id": "(C\d+)"/g)].map((m) => m[1] ?? "");
        verifiers.push([s.target.modelId, ids]);
        return {
          structured: {
            results: ids.map((id) => ({
              id,
              verdict: "REFUTED",
              severity: "low",
              category: "correctness",
              evidence: "Checked the farewell text",
              trigger: "none",
            })),
          },
        };
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: reviewOutput(1, "minor", `${s.target.vendor}.txt`) };
      return { files: { "farewell.txt": "goodbye\n" } };
    },
    false,
    true,
  );
  f.deps.reviewSystem = {
    name: "panel",
    mode: "panel",
    implementerReport: "include",
    finders: ["alpha/m", "beta/m"].map((target) => ({ target, prompt: "standard" })),
    verifier: { targets: ["gamma/m", "delta/m"] },
  };
  const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(verifiers).toEqual([
    ["delta/m", ["C1"]],
    ["gamma/m", ["C2"]],
  ]);
  expect(
    JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "{}").panel.candidates.map(
      (c: { vendor: string }) => c.vendor,
    ),
  ).toEqual(["anthropic", "openai"]);
});
