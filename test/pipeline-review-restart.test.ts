import { describe, expect, test } from "bun:test";
import type { Factory } from "../src/app.ts";
import type { RunState } from "../src/pipeline/context.ts";
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
  test("review context and follow-ups survive a factory restart", async () => {
    let reviews = 0;
    let implementsCount = 0;
    let slow = true;
    const prompts: string[] = [];
    const handler: Handler = (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        reviews++;
        prompts.push(s.prompt);
        if (reviews > 3) return { structured: approve };
        return {
          structured:
            reviews === 1
              ? {
                  ...approve,
                  findings: [
                    {
                      severity: "major",
                      security: false,
                      ...findingEvidence,
                      file: "farewell.txt",
                      line: 1,
                      title: "Prior bug",
                      detail: "bug",
                      suggestion: "fix",
                    },
                  ],
                }
              : reviews === 2
                ? {
                    ...approve,
                    findings: [
                      {
                        severity: "minor",
                        security: false,
                        ...findingEvidence,
                        label: "regression",
                        prior: "",
                        file: "farewell.txt",
                        line: 1,
                        title: "Regression",
                        detail: "regressed",
                        suggestion: "fix",
                      },
                      {
                        severity: "major",
                        security: false,
                        ...findingEvidence,
                        label: "new",
                        prior: "",
                        file: "farewell.txt",
                        line: 1,
                        title: "Backlog idea",
                        detail: "later",
                        suggestion: "later",
                      },
                    ],
                  }
                : {
                    ...approve,
                    findings: [
                      {
                        severity: "major",
                        security: false,
                        ...findingEvidence,
                        label: "unaddressed",
                        // Cites no previous blocking finding: a relabelled follow-up can't become mandatory.
                        prior: "",
                        file: "farewell.txt",
                        line: 1,
                        title: "Backlog idea",
                        detail: "later",
                        suggestion: "later",
                      },
                    ],
                  },
        };
      }
      implementsCount++;
      return slow && implementsCount === 3
        ? { delayMs: 30_000 }
        : { files: { "farewell.txt": `goodbye ${implementsCount}\n` } };
    };
    const f = start(handler);
    const run = await f.createRun({ repo: repoDir, prompt: "Add a farewell file" });
    const deadline = Date.now() + 10_000;
    while (
      (f.store.getRunState<RunState>(run.id)?.round !== 2 || f.store.getRun(run.id)?.stage !== "implement") &&
      Date.now() < deadline
    )
      await Bun.sleep(10);
    const before = f.store.getRunState<RunState>(run.id);
    expect(before?.reviewedSha).toMatch(/^[a-f0-9]{40}$/);
    expect(before?.lastReview?.findings[0]?.title).toBe("Regression");
    expect(before?.reviewFollowUps?.[0]?.title).toBe("Backlog idea");
    await f.stop();
    f.store.close();
    slow = false;
    const restarted = start(handler);
    expect(await waitFor(restarted, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(prompts[2]).toContain(before?.reviewedSha ?? "missing SHA");
    expect(prompts[2]).toContain("Regression");
    expect(prompts[2]).not.toContain("Backlog idea");
    expect(implementsCount).toBe(4); // Includes the interrupted implementation; the follow-up stays one.
    expect(restarted.store.getArtifact(run.id, "review-2.json")).toContain('"verdict": "approve"');
    expect(restarted.store.getRunState<RunState>(run.id)?.reviewFollowUps).toHaveLength(1);
    expect(restarted.store.getArtifact(run.id, "report.md")).toContain("Backlog idea");
  });

  for (const restartRound of [0, 1]) {
    test(`restart during verify preserves review policy and keeps round ${restartRound} follow-ups`, async () => {
      let implementations = 0;
      let slow = true;
      let verifyStarted = false;
      let resumedVerifies = 0;
      const prompts: string[] = [];
      const finding = (title: string, label = "new") => ({
        severity: "major",
        security: false,
        ...findingEvidence,
        label,
        prior: "",
        file: "farewell.txt",
        line: 1,
        title,
        detail: title,
        suggestion: "Fix",
      });
      const handler: Handler = (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") {
          prompts.push(s.prompt);
          const findings =
            restartRound === 0
              ? prompts.length === 2
                ? [finding("New major on replay")]
                : []
              : prompts.length === 1
                ? [finding("Initial blocker")]
                : [finding("Backlog idea"), ...(slow ? [finding("Obsolete follow-up")] : [])];
          return { structured: { ...approve, findings } };
        }
        if (role === "verify") {
          verifyStarted = true;
          if (slow) return { delayMs: 30_000 };
          resumedVerifies++;
          return {
            structured:
              restartRound === 1 && resumedVerifies === 1
                ? {
                    ...pass,
                    criteria: pass.criteria.map((c) => (c.id === "AC-1" ? { ...c, status: "unmet" } : c)),
                  }
                : pass,
          };
        }
        implementations++;
        return { files: { "farewell.txt": `goodbye ${implementations}\n` } };
      };
      const f = start(handler);
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
      const deadline = Date.now() + 10_000;
      while (!verifyStarted && Date.now() < deadline) await Bun.sleep(10);
      expect(verifyStarted).toBe(true);
      expect(f.store.getRun(run.id)?.stage).toBe("verify");
      const checkpoint = f.store.getRunState<RunState>(run.id);
      expect(checkpoint?.round).toBe(restartRound);
      expect(checkpoint?.reviewHistory?.at(-1)?.round).toBe(restartRound);
      await f.stop();
      f.store.close();
      slow = false;
      const resumed = start(handler);
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      // A restart resumes verification; completed reviews and their findings remain durable.
      expect(prompts).toHaveLength(restartRound === 0 ? 1 : 3);
      const state = resumed.store.getRunState<RunState>(run.id);
      expect(state?.reviewHistory?.slice(0, restartRound + 1)).toEqual(checkpoint?.reviewHistory);
      expect(implementations).toBe(restartRound === 0 ? 1 : 3);
      expect(state?.reviewHistory?.map((entry) => entry.round)).toEqual(restartRound === 0 ? [0] : [0, 1, 2]);
      if (restartRound === 0) {
        expect(resumed.store.getArtifact(run.id, "review-0.json")).toContain('"verdict": "approve"');
        expect(state?.reviewFollowUps).toEqual([]);
      } else {
        // The later round omitted "Obsolete follow-up"; omission is not resolution.
        expect(state?.reviewFollowUps?.map((f) => f.title)).toEqual(["Backlog idea", "Obsolete follow-up"]);
        const followUps = resumed.store.getArtifact(run.id, "report.md")?.split("## Review follow-ups")[1];
        expect(followUps?.match(/^- major: `farewell\.txt:1` Backlog idea/gm)).toHaveLength(1);
        expect(followUps?.match(/^- major: `farewell\.txt:1` Obsolete follow-up/gm)).toHaveLength(1);
      }
    });
  }
});
