import { describe, expect, test } from "bun:test";
import type { Factory } from "../src/app.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { sh } from "../src/util/proc.ts";
import { deferred } from "./evals-support.ts";
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
const { start, wait } = pipelineSetup({
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
  test.each(["single", "panel"] as const)(
    "a legacy state without review evidence uses current %s mode",
    async (mode) => {
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review") return { structured: approve };
        return { files: { "farewell.txt": "goodbye\n" } };
      });
      await f.stop();
      f.deps.cfg.reviewMode = "panel";
      f.deps.cfg.reviewRosters.quick = [{ prompt: "standard" }];
      f.deps.faults = { "stage:review:before": { action: "kill" } };
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("running");
      const checkpoint = f.store.getRunState<RunState>(run.id);
      expect(checkpoint?.reviewLenses).toEqual([]);
      expect(checkpoint?.reviewMode).toBeUndefined();
      expect(checkpoint?.lastReview).toBeUndefined();
      expect(checkpoint?.reviewHistory).toBeUndefined();
      f.deps.faults = undefined;
      f.deps.cfg = { ...f.deps.cfg, reviewMode: mode };
      expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("succeeded");
      const state = f.store.getRunState<RunState>(run.id);
      expect(state?.reviewMode).toBe(mode);
      expect(state?.reviewHistory?.[0]?.panelReview).toBe(mode === "panel" ? 1 : undefined);
    },
  );

  test.each([false, true])(
    "panel mode survives reload and a cached R2 restart (legacy state: %s)",
    async (legacy) => {
      const verificationStarted = deferred<void>();
      const releaseVerification = deferred<void>();
      const reviews: string[] = [];
      let implementations = 0;
      let restarting = true;
      const handler: Handler = async (s) => {
        if (s.prompt.startsWith("You are a code-review verifier")) {
          const cited = [
            ...s.prompt.matchAll(/"id": "(C\d+)",\s+"file": "[^"]*",\s+"line": \d+,\s+"title": "([^"]*)"/g),
          ];
          return {
            structured: {
              results: cited.map(([, id, title]) => ({
                id,
                verdict: title === `R${reviews.length} bug` ? "CONFIRMED" : "REFUTED",
                severity: "high",
                category: "correctness",
                evidence: "farewell.txt:1",
                trigger: "wrong farewell",
              })),
            },
          };
        }
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") {
          reviews.push(s.prompt);
          const active = factory?.store.listRuns({ status: ["running"] })[0];
          expect(active && factory?.store.getRunState<RunState>(active.id)?.reviewMode).toBe(
            reviews.length > 3 ? "single" : "panel",
          );
          return {
            structured: {
              ...approve,
              findings:
                reviews.length <= 2
                  ? [
                      {
                        ...findingEvidence,
                        severity: "major",
                        security: false,
                        file: "farewell.txt",
                        line: 1,
                        title: `R${reviews.length} bug`,
                        detail: "wrong farewell",
                        suggestion: "fix",
                        ...(reviews.length === 2 ? { label: "new", prior: "" } : {}),
                      },
                    ]
                  : [],
            },
          };
        }
        if (role === "verify") {
          if (restarting && implementations === 2) {
            verificationStarted.resolve();
            await releaseVerification.promise;
          }
          return { structured: pass };
        }
        implementations++;
        return { files: { "farewell.txt": `goodbye ${implementations}\n` } };
      };
      const f = start(handler);
      await f.stop();
      f.deps.cfg = {
        ...f.deps.cfg,
        reviewMode: "panel",
        reviewRosters: {
          ...f.deps.cfg.reviewRosters,
          standard: [{ prompt: "standard" }],
        },
      };
      f.deps.faults = {
        "stage:implement:before": {
          action: "continue",
          when: ({ round }) => round === 1,
          onHit: () => {
            f.deps.cfg = { ...f.deps.cfg, reviewMode: "single" };
          },
        },
      };
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
      const controller = new AbortController();
      const executing = executeRun(f.deps, run.id, controller.signal);
      try {
        await verificationStarted.promise;
        await wait(
          () =>
            f.store.getRunState<RunState>(run.id)?.completedChecks?.round === 1 &&
            f.store.getRunState<RunState>(run.id)?.completedChecks?.values.review !== undefined,
          { timeoutMs: 5000 },
        );
        controller.abort(new Error("shutdown"));
      } finally {
        releaseVerification.resolve();
      }
      expect(await executing).toBe("queued");
      const checkpoint = f.store.getRunState<RunState>(run.id);
      expect(checkpoint?.reviewMode).toBe("panel");
      expect(checkpoint?.lastReview?.verdict).toBe("request_changes");
      expect(checkpoint?.reviewHistory?.map((entry) => entry.panelReview)).toEqual([1, 2]);
      if (legacy && checkpoint) {
        delete checkpoint.reviewMode;
        if (checkpoint.lastReview) delete checkpoint.lastReview.mode;
        for (const entry of checkpoint.reviewHistory ?? []) delete entry.scope;
        f.store.setRunState(run.id, checkpoint);
      }
      f.store.close();
      restarting = false;
      const resumed = start(handler);
      // The restarted daemon loads single mode; panel history must still control the cached R2.
      expect(resumed.deps.cfg.reviewMode).toBe("single");
      resumed.deps.cfg.reviewRosters.standard = [{ prompt: "standard" }];
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(reviews).toHaveLength(3);
      expect(reviews[1]).toContain("review R2: the fix diff only");
      expect(reviews[2]).toContain("review R3: the fix diff only");
      expect(resumed.store.getRunState<RunState>(run.id)).toMatchObject({ reviewMode: "panel" });
      expect(
        resumed.store.getRunState<RunState>(run.id)?.reviewHistory?.map((entry) => entry.panelReview),
      ).toEqual([1, 2, 3]);
      // New runs use the reloaded single mode, rather than inheriting the older run's mode.
      const next = await resumed.createRun({ repo: repoDir, prompt: "Add farewell again", profile: "quick" });
      expect(await waitFor(resumed, next.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(resumed.store.getRunState<RunState>(next.id)?.reviewMode).toBe("single");
      expect(resumed.store.getRunState<RunState>(next.id)?.lastReview?.mode).not.toBe("panel");
    },
  );

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
          if (slow && implementations === restartRound + 1) {
            verifyStarted = true;
            return { delayMs: 30_000 };
          }
          if (slow) return { structured: pass };
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
      while (
        (!verifyStarted ||
          f.store.getRunState<RunState>(run.id)?.completedChecks?.values.review === undefined) &&
        Date.now() < deadline
      )
        await Bun.sleep(10);
      expect(verifyStarted).toBe(true);
      expect(f.store.getRun(run.id)?.stage).toBe("review");
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

for (const changedHead of [false, true]) {
  for (const recordedVerify of [false, true]) {
    test(`resume joins a cached review with fresh verify: changed HEAD=${changedHead}, recorded verify=${recordedVerify}`, async () => {
      const verificationStarted = deferred<void>();
      const releaseVerification = deferred<void>();
      const reviewed: string[] = [];
      const verified: string[] = [];
      const f = start(async (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review" || role === "verify") {
          const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: s.cwd })).stdout.trim();
          if (role === "review") {
            reviewed.push(sha);
            return { structured: approve };
          }
          verified.push(sha);
          if (verified.length === 1) {
            verificationStarted.resolve();
            await releaseVerification.promise;
          }
          return { structured: pass };
        }
        return { files: { "farewell.txt": "goodbye\n" } };
      });
      await f.stop();
      if (recordedVerify) f.deps.faults = { "stage:verify:after": { action: "kill" } };
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
      const controller = new AbortController();
      const executing = executeRun(f.deps, run.id, controller.signal);
      try {
        await verificationStarted.promise;
        await wait(
          () => f.store.getRunState<RunState>(run.id)?.completedChecks?.values.review !== undefined,
          { timeoutMs: 5000 },
        );
        if (!recordedVerify) controller.abort(new Error("shutdown"));
      } finally {
        releaseVerification.resolve();
      }
      expect(await executing).toBe(recordedVerify ? "running" : "queued");
      const checkpoint = f.store.getRunState<RunState>(run.id);
      expect(checkpoint?.completedChecks?.sha).toBe(reviewed[0]);
      expect(checkpoint?.verifyResults?.length ?? 0).toBe(recordedVerify ? 1 : 0);
      const cwd = checkpoint?.worktreePath;
      if (!cwd) throw new Error("Missing resumed checkout");
      if (changedHead)
        await sh(["git", "commit", "--allow-empty", "-qm", "advance resumed fixture"], { cwd });
      f.deps.faults = undefined;
      expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("succeeded");
      expect(reviewed).toHaveLength(changedHead ? 2 : 1);
      expect(verified).toHaveLength(2);
      if (changedHead) expect(verified[1]).not.toBe(verified[0]);
      else expect(verified[1]).toBe(verified[0]);
      const state = f.store.getRunState<RunState>(run.id);
      expect(state?.reviewedSha).toBe(verified[1]);
      expect(state?.lastVerifiedSha).toBe(verified[1]);
      expect(state?.verifyResults?.at(-1)?.sha).toBe(verified[1]);
      expect(f.store.listStages(run.id).some((stage) => stage.status === "running")).toBe(false);
    });
  }
}
