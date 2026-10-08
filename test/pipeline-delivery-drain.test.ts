import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "solid-js/web";
import type { Factory } from "../src/app.ts";
import { githubRetry } from "../src/git/repos.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { sh } from "../src/util/proc.ts";
import { buildNeedsYouUi } from "./needs-you-ui-support.ts";
import { approve, pipelineSetup, roleOf, triage, waitFor } from "./pipeline-support.ts";
import { findingEvidence } from "./review-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start, githubFixture, registerGithub, advanceBase } = pipelineSetup({
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
  test("drain during deliver completes its nested post-merge gates", async () => {
    const bare = await githubFixture();
    const f = start(async (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        await advanceBase(bare, "base.txt", "new base\n");
        return { structured: approve };
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    registerGithub(f, bare);
    const startStage = f.store.startStage.bind(f.store);
    f.store.startStage = (...args) => {
      const stage = startStage(...args);
      if (args[1] === "deliver") f.scheduler.drain();
      return stage;
    };
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(f.store.listStages(run.id).filter((stage) => stage.name === "gates")).toHaveLength(2);
    expect(f.store.listStages(run.id).find((stage) => stage.name === "deliver")?.status).toBe("succeeded");
    expect(f.store.getRunState<RunState>(run.id)?.pendingRebaseSha).toBeUndefined();
    expect(f.scheduler.parkedRunIds).toEqual([]);
  });

  test("post-merge gates slower than the GitHub retry budget still deliver", async () => {
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      '[gates]\nchecks = [{ name = "slow", run = "test ! -f base.txt || sleep 2" }]\n',
    );
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "slow gate"], {
      cwd: repoDir,
    });
    const bare = await githubFixture();
    const f = start(async (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        await advanceBase(bare, "base.txt", "new base\n");
        return { structured: approve };
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    registerGithub(f, bare);
    const budgetMs = githubRetry.budgetMs;
    githubRetry.budgetMs = 1_500;
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    try {
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    } finally {
      githubRetry.budgetMs = budgetMs;
    }
    expect(f.store.getRun(run.id)?.prUrl).toBe("https://github.com/test/repo/pull/1");
    expect(f.store.listStages(run.id).filter((stage) => stage.name === "gates")).toHaveLength(2);
    expect(readFileSync(join(home, "gh-calls"), "utf8").match(/^pr create/gm)).toHaveLength(1);
  });
});

describe("pipeline (fake agents, real git + gates)", () => {
  test("needs-human draft delivery continues during drain", async () => {
    const bare = await githubFixture();
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review")
        return {
          structured: {
            verdict: "request_changes",
            summary: "Needs work",
            findings: [
              {
                label: "unaddressed",
                prior: "P1",
                severity: "blocker",
                security: false,
                ...findingEvidence,
                file: "farewell.txt",
                line: 1,
                title: "Incorrect output",
                detail: "Needs work",
                suggestion: "Fix it",
              },
            ],
          },
        };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    f.cfg.maxRounds = 1;
    registerGithub(f, bare);
    const addEvent = f.store.addEvent.bind(f.store);
    f.store.addEvent = (event) => {
      if (event.message?.startsWith("Run needs a human")) f.scheduler.drain();
      return addEvent(event);
    };
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["needs_human", "failed", "succeeded"])).toBe("needs_human");
    expect(f.store.getRun(run.id)?.prUrl).toContain("/pull/1");
    expect(f.store.listStages(run.id).find((stage) => stage.name === "deliver")?.status).toBe("succeeded");
    expect(f.store.getRunState<RunState>(run.id)?.parked).toBe(false);
  });

  test.each(["succeeded", "failed"] as const)(
    "review remains the stopping stage when needs-human draft delivery %s during drain",
    async (deliveryStatus) => {
      const bare = await githubFixture();
      if (deliveryStatus === "failed") {
        writeFileSync(
          join(home, "bin", "gh"),
          `#!/bin/sh\nif [ "$2" = create ]; then echo 'Draft PR rejected' >&2; exit 1; fi\n`,
        );
      }
      const f = start((s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (role === "review")
          return {
            structured: {
              verdict: "request_changes",
              summary: "Needs work",
              findings: [
                {
                  label: "unaddressed",
                  prior: "P1",
                  severity: "blocker",
                  security: false,
                  ...findingEvidence,
                  file: "farewell.txt",
                  line: 1,
                  title: "Incorrect output",
                  detail: "Needs work",
                  suggestion: "Fix it",
                },
              ],
            },
          };
        return { files: { "farewell.txt": "goodbye\n" } };
      });
      f.cfg.maxRounds = 1;
      registerGithub(f, bare);
      const addEvent = f.store.addEvent.bind(f.store);
      f.store.addEvent = (event) => {
        if (event.message?.startsWith("Run needs a human")) f.scheduler.drain();
        return addEvent(event);
      };
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, run.id, ["needs_human", "failed", "succeeded"])).toBe("needs_human");
      if (deliveryStatus === "succeeded") expect(f.store.getRun(run.id)?.prUrl).toContain("/pull/1");
      else {
        expect(f.store.getRun(run.id)?.prUrl).toBeNull();
        expect(f.store.listEvents(run.id).some((e) => e.message?.startsWith("Could not open draft PR"))).toBe(
          true,
        );
      }
      expect(f.store.listStages(run.id).find((stage) => stage.name === "deliver")?.status).toBe(
        deliveryStatus,
      );
      expect(f.store.getRunState<RunState>(run.id)?.parked).toBe(false);
      const detail = f.store.getRunDetail(run.id);
      if (!detail) throw new Error("missing draft detail");
      expect(detail.run.stage).toBe("deliver");
      expect(detail.stoppingStage).toBe("review");
      const ui = await buildNeedsYouUi(join(home, "needs-you-ui"));
      try {
        ui.mount(detail);
        const html = renderToString(() => ui.render());
        expect(html).toContain('aria-label="Needs you"');
        expect(html).toContain("review · Still failing after");
        expect(html).not.toContain("deliver · Still failing after");
      } finally {
        ui.dispose();
      }
    },
  );
});
