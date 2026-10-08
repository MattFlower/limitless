import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { readingTimeout } from "../src/pipeline/engine.ts";
import { sh } from "../src/util/proc.ts";
import {
  approve,
  type Handler,
  holdout,
  pass,
  pipelineSetup,
  roleOf,
  spec,
  triage,
  waitFor,
} from "./pipeline-support.ts";
import { findingEvidence } from "./review-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start, githubFixture, registerGithub, advanceBase, resolveBaseConflict } = pipelineSetup({
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
  test("panel reviews R1-R3: fix-diff scope, tightening blocks, restart, then needs_human with a draft", async () => {
    const bare = await githubFixture();
    const finding = (title: string, label = "new", prior = "") => ({
      severity: "major",
      security: false,
      ...findingEvidence,
      ...(label === "r1" ? {} : { label, prior }),
      ...(title.endsWith("cleanup") ? { category: "cleanup" } : {}),
      file: "farewell.txt",
      line: 1,
      title,
      detail: `detail ${title}`,
      suggestion: "fix",
    });
    // Finder output per panel review; the verifier rules on each candidate by its title.
    const found = [
      [finding("R1 low", "r1"), finding("R1 cleanup", "r1")],
      // No R2 finder repeats P1, so the verifier rechecks it on its own.
      [finding("R2 medium"), finding("R2 high")],
      [finding("R3 high"), finding("R3 critical")],
    ];
    const severity: Record<string, string> = {
      "R1 low": "low",
      "R2 medium": "medium",
      "R2 high": "high",
      "R3 high": "high",
      "R3 critical": "critical",
    };
    const finders: string[] = [];
    // Verifier prompts per review; a re-review's recheck of the prior blocker is its own batch.
    const verifiers: string[][] = [[], [], []];
    let implementations = 0;
    let slow = true;
    const handler: Handler = (s) => {
      if (s.prompt.startsWith("You are a code-review verifier")) {
        verifiers[finders.length - 1]?.push(s.prompt);
        const cited = [
          ...s.prompt.matchAll(/"id": "(C\d+)",\s+"file": "[^"]*",\s+"line": \d+,\s+"title": "([^"]*)"/g),
        ];
        return {
          structured: {
            results: cited.map(([, id, title]) => ({
              id,
              verdict: "CONFIRMED",
              // Each re-review's recheck finds the previous review's blocker fixed after all.
              ...(title?.startsWith(`R${finders.length - 1} `)
                ? { verdict: "REFUTED", severity: "low" }
                : { severity: severity[title ?? ""] }),
              category: "correctness",
              evidence: "farewell.txt:1 `bye`",
              trigger: "reading the file -> wrong farewell",
            })),
          },
        };
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        finders.push(s.prompt);
        return { structured: { ...approve, findings: found[finders.length - 1] ?? [] } };
      }
      implementations++;
      // The second implementation fails the gates, so that round never reaches a review.
      if (implementations === 2) return { files: { "farewell.txt": "BAD\n" } };
      if (slow && implementations === 4) return { delayMs: 30_000 };
      return { files: { "farewell.txt": `goodbye ${implementations}\n` } };
    };
    const panel = {
      name: "panel",
      mode: "panel" as const,
      finders: [{ prompt: "standard" as const }],
      verifier: {},
      implementerReport: "include" as const,
    };
    const f = start(handler);
    f.deps.reviewSystem = panel;
    registerGithub(f, bare);
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    // Stop the factory between R2 and R3, while the fourth implementation runs.
    const deadline = Date.now() + 15_000;
    while (
      (f.store.getRunState<RunState>(run.id)?.round !== 3 || f.store.getRun(run.id)?.stage !== "implement") &&
      Date.now() < deadline
    )
      await Bun.sleep(10);
    const before = f.store.getRunState<RunState>(run.id);
    expect(before?.reviewHistory?.map((e) => [e.round, e.panelReview])).toEqual([
      [0, 1],
      [2, 2],
    ]);
    await f.stop();
    f.store.close();
    slow = false;
    const restarted = start(handler);
    restarted.deps.reviewSystem = panel;
    expect(await waitFor(restarted, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");

    // Exactly three panel reviews, never a fourth; the gate-failed round 1 did not count. Artifacts
    // are numbered by review, not by implementation round.
    expect(finders).toHaveLength(3);
    expect(implementations).toBe(5); // Includes the implementation interrupted by the stop.
    expect(restarted.store.getArtifact(run.id, "review-0.json")).toBeNull();
    expect(restarted.store.getArtifact(run.id, "review-4.json")).toBeNull();
    const [r1, r2, r3] = [1, 2, 3].map((n) =>
      JSON.parse(restarted.store.getArtifact(run.id, `review-${n}.json`) ?? "{}"),
    );
    const baseSha = restarted.store.getRun(run.id)?.baseSha ?? "missing";
    expect(r1).toMatchObject({
      round: 0,
      panelReview: 1,
      scope: { kind: "full", range: `${baseSha}..${r1.reviewedSha}` },
    });
    expect(r2).toMatchObject({
      round: 2,
      panelReview: 2,
      scope: { kind: "fix", range: `${r1.reviewedSha}..${r2.reviewedSha}` },
    });
    expect(r3).toMatchObject({
      round: 3,
      panelReview: 3,
      scope: { kind: "fix", range: `${r2.reviewedSha}..${r3.reviewedSha}` },
    });
    // R1: a verified low blocks, cleanup is a follow-up. R2: new high blocks, new medium is a follow-up.
    // R3: new high is a follow-up, critical blocks.
    const titles = (r: { blocking: { title: string }[] }) => r.blocking.map((b) => b.title);
    expect([titles(r1), titles(r2), titles(r3)]).toEqual([["R1 low"], ["R2 high"], ["R3 critical"]]);
    const state = restarted.store.getRunState<RunState>(run.id);
    expect(state?.reviewFollowUps?.map((x) => x.title).sort()).toEqual([
      "R1 cleanup",
      "R2 medium",
      "R3 high",
    ]);

    // R1 reviews the full change; R2 and R3 finders and verifiers see only the fix diff and P-ids.
    expect(finders[0]).toContain(`git diff ${baseSha}..HEAD`);
    for (const [i, prompt] of finders.slice(1).entries()) {
      const range = `${[r1, r2][i].reviewedSha}..${[r2, r3][i].reviewedSha}`;
      expect(prompt).toContain(`review R${i + 2}: the fix diff only`);
      expect(prompt).toContain(`git diff ${range}`);
      expect(prompt).toContain('"id": "P1"');
      expect(prompt).toContain('"status": "unresolved at the previous review');
      expect(prompt).not.toContain(`git diff ${baseSha}..`);
      expect(prompt).not.toContain("full base-to-HEAD");
      expect(verifiers[i + 1]).toHaveLength(2);
      for (const verifier of verifiers[i + 1] ?? []) {
        expect(verifier).toContain(`git diff ${range}`);
        expect(verifier).not.toContain(`git diff ${baseSha}..`);
        expect(verifier).toContain('"id": "P1"');
        expect(verifier).toContain('"status": "not repeated by any finder; recheck it as C3"');
      }
    }
    expect(verifiers[0]).toHaveLength(1);
    expect(finders[1]).toContain("R1 low");
    // Each re-review's verifier rechecked P1 as a candidate of its own (after the finders' C1 and C2)
    // and refuted it: fixed.
    expect(verifiers[1]?.[1]).toMatch(/"id": "C3",[\s\S]*"title": "R1 low",[\s\S]*"prior": "P1"/);
    expect(r2.panel.refuted).toEqual(["C3"]);
    expect(verifiers[2]?.[1]).toMatch(/"id": "C3",[\s\S]*"title": "R2 high",[\s\S]*"prior": "P1"/);
    expect(r3.panel.refuted).toEqual(["C3"]);
    // R1's only blocker was refuted by R2's recheck, so R3 is told it is resolved.
    expect(finders[2]).toMatch(/"title": "R1 low",[\s\S]*"status": "resolved"/);
    expect(verifiers[2]?.[0]).toMatch(/"title": "R1 low",[\s\S]*"status": "resolved at an earlier review"/);

    expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("--draft");
    const report = restarted.store.getArtifact(run.id, "report.md") ?? "";
    expect(report).toContain(`Panel review R3 — fix diff \`${r2.reviewedSha}..${r3.reviewedSha}\``);
  });

  // R1 and R2 block, R3 approves; the delivery merge then conflicts with a base that also added an
  // upstream-only file. The resolution review is outside R1-R3 and sees the change against the new base.
  for (const outcome of ["approves", "blocks"] as const)
    test(`panel conflict-resolution review after R3 ${outcome}`, async () => {
      const bare = await githubFixture();
      const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n");
      const finding = (title: string, label?: "new" | "regression") => ({
        severity: "major",
        security: false,
        ...findingEvidence,
        ...(label ? { label, prior: "" } : {}),
        file: "farewell.txt",
        line: 1,
        title,
        detail: `detail ${title}`,
        suggestion: "fix",
      });
      // The resolution finder raises a regression the verifier rates medium: R2's rules block it.
      const found = [
        [finding("R1 bug")],
        [finding("R2 bug", "new")],
        [],
        outcome === "blocks" ? [finding("R4 bug", "regression")] : [],
      ];
      const finders: AgentSpec[] = [];
      const verifiers: AgentSpec[][] = [[], [], [], []];
      let implementations = 0;
      let baseTip = "";
      const handler: Handler = async (s) => {
        if (s.prompt.startsWith("You are a code-review verifier")) {
          verifiers[finders.length - 1]?.push(s);
          const cited = [
            ...s.prompt.matchAll(/"id": "(C\d+)",\s+"file": "[^"]*",\s+"line": \d+,\s+"title": "([^"]*)"/g),
          ];
          return {
            structured: {
              results: cited.map(([, id, title]) => ({
                id,
                // Only the current review's own finding is real; rechecks of earlier ones are fixed.
                verdict: title === `R${finders.length} bug` ? "CONFIRMED" : "REFUTED",
                severity: title === "R4 bug" ? "medium" : "high",
                category: "correctness",
                evidence: "farewell.txt:1 `bye`",
                trigger: "reading the file -> wrong farewell",
              })),
            },
          };
        }
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") {
          finders.push(s);
          if (finders.length === 3) {
            await advanceBase(bare, "upstream-only.txt", `${lines(300, "upstream")}\n`);
            baseTip = await advanceBase(bare, "greeting.txt", "new base\n");
          }
          return { structured: { ...approve, findings: found[finders.length - 1] ?? [] } };
        }
        implementations++;
        if (implementations === 4) return resolveBaseConflict(s.cwd, bare);
        return {
          files: {
            "farewell.txt": `goodbye ${implementations}\n`,
            ...(implementations === 1
              ? { "greeting.txt": "feature\n", "first-only.txt": `${lines(500, "first")}\n` }
              : {}),
          },
        };
      };
      const f = start(handler);
      f.deps.reviewSystem = {
        name: "panel",
        mode: "panel",
        finders: [{ prompt: "standard" }],
        verifier: {},
        implementerReport: "include",
      };
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        outcome === "approves" ? "succeeded" : "needs_human",
      );
      expect(implementations).toBe(4);
      expect(finders).toHaveLength(4);
      const state = f.store.getRunState<RunState>(run.id);
      expect(state?.conflictRound).toBe(3);
      expect(state?.reviewHistory?.map((e) => [e.round, e.panelReview, e.scope?.kind])).toEqual([
        [0, 1, "full"],
        [1, 2, "fix"],
        [2, 3, "fix"],
        [3, undefined, "resolution"],
      ]);
      expect(f.store.getArtifact(run.id, "review-4.json")).toBeNull();
      const [r1, r2, r3] = [1, 2, 3].map((n) =>
        JSON.parse(f.store.getArtifact(run.id, `review-${n}.json`) ?? "{}"),
      );
      expect([r1.panelReview, r2.panelReview, r3.panelReview]).toEqual([1, 2, 3]);
      expect(r3.verdict).toBe("approve");
      const resolution = JSON.parse(f.store.getArtifact(run.id, "review-resolution.json") ?? "{}");
      expect(resolution).toMatchObject({
        round: 3,
        scope: { kind: "resolution", range: `${baseTip}..${resolution.reviewedSha}` },
      });
      expect(resolution).not.toHaveProperty("panelReview");

      // The resolution review: the change against the new base, never the upstream-only file.
      const resolutionPrompt = finders[3]?.prompt ?? "";
      expect(resolutionPrompt).toContain(`inspect \`git diff ${baseTip}..HEAD\` against the pinned new base`);
      expect(resolutionPrompt).not.toContain("the fix diff only");
      for (const file of ["first-only.txt", "farewell.txt", "greeting.txt"])
        expect(resolutionPrompt).toContain(file);
      expect(resolutionPrompt).not.toContain("upstream-only.txt");
      // R2 sees only its fix diff: never the file only R1's change touched.
      expect(finders[1]?.prompt).toContain("farewell.txt");
      expect(finders[1]?.prompt).not.toContain("first-only.txt");
      // Timeouts follow the diff each reviewer got: 503 changed lines for R1, 2 for R2, and 502
      // against the new base for the resolution review (the upstream file's 300 would make it 802).
      expect(finders.map((s) => s.timeoutMs)).toEqual([503, 2, 2, 502].map((n) => readingTimeout(n)));
      for (const v of verifiers[1] ?? []) expect(v.timeoutMs).toBe(readingTimeout(2));

      if (outcome === "approves") {
        expect(f.store.getArtifact(run.id, "report.md")).toContain(
          `- Conflict-resolution review — change against the new base \`${baseTip}..${resolution.reviewedSha}\``,
        );
      } else {
        expect(resolution.verdict).toBe("request_changes");
        expect(resolution.blocking.map((b: { title: string }) => b.title)).toEqual(["R4 bug"]);
        // The resolution review's feedback follows R2's rules too, so the finding reaches the human.
        expect(f.store.getRun(run.id)?.error).toContain("R4 bug");
        for (const v of verifiers[3] ?? []) {
          expect(v.timeoutMs).toBe(readingTimeout(502));
          expect(v.prompt).toContain(`git diff ${baseTip}..${resolution.reviewedSha}`);
          expect(v.prompt).not.toContain("upstream-only.txt");
        }
        // No further repair round: the verified R3 head goes out as a draft.
        expect(f.store.getRun(run.id)?.prUrl).toContain("/pull/1");
        expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("--draft");
      }
    });

  test("panel: a verify failure after R3 approves goes to a human before a fourth implementation", async () => {
    const bare = await githubFixture();
    const blocker = (title: string, label?: "new") => ({
      severity: "major",
      security: false,
      ...findingEvidence,
      ...(label ? { label, prior: "" } : {}),
      file: "farewell.txt",
      line: 1,
      title,
      detail: `detail ${title}`,
      suggestion: "fix",
    });
    const found = [[blocker("R1 bug")], [blocker("R2 bug", "new")], []];
    let finders = 0;
    let implementations = 0;
    let verifies = 0;
    const f = start((s) => {
      if (s.prompt.startsWith("You are a code-review verifier")) {
        const cited = [
          ...s.prompt.matchAll(/"id": "(C\d+)",\s+"file": "[^"]*",\s+"line": \d+,\s+"title": "([^"]*)"/g),
        ];
        return {
          structured: {
            results: cited.map(([, id, title]) => ({
              id,
              verdict: title === `R${finders} bug` ? "CONFIRMED" : "REFUTED",
              severity: "high",
              category: "correctness",
              evidence: "farewell.txt:1 `bye`",
              trigger: "reading the file -> wrong farewell",
            })),
          },
        };
      }
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: { ...approve, findings: found[finders++] ?? [] } };
      if (role === "verify") {
        verifies++;
        return {
          structured: {
            ...pass,
            overall: "fail",
            criteria: pass.criteria.map((c) => ({ ...c, status: "unmet" })),
          },
        };
      }
      implementations++;
      return { files: { "farewell.txt": `goodbye ${implementations}\n` } };
    });
    f.deps.reviewSystem = {
      name: "panel",
      mode: "panel",
      finders: [{ prompt: "standard" }],
      verifier: {},
      implementerReport: "include",
    };
    registerGithub(f, bare);
    const run = await f.createRun({ repo: "test/repo", prompt: "Add a farewell", profile: "standard" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    expect(implementations).toBe(3);
    expect(finders).toBe(3);
    expect(verifies).toBe(1);
    expect(f.store.listStages(run.id).filter((stage) => stage.name === "implement")).toHaveLength(3);
    expect(f.store.getArtifact(run.id, "implement-3.md")).toBeNull();
    const state = f.store.getRunState<RunState>(run.id);
    expect(state?.reviewHistory?.map((e) => e.panelReview)).toEqual([1, 2, 3]);
    expect(state?.needsHumanReason).toContain("Panel review limit reached (R3)");
    // The draft is the head R3 reviewed.
    const r3 = JSON.parse(f.store.getArtifact(run.id, "review-3.json") ?? "{}");
    const finished = f.store.getRun(run.id);
    expect(finished?.headSha).toBe(r3.reviewedSha);
    expect(
      (await sh(["git", "ls-remote", bare, `refs/heads/${finished?.branch}`], { cwd: repoDir })).stdout,
    ).toContain(r3.reviewedSha);
    expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("--draft");
  });
});
