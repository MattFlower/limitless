import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
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

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start, previewFixture } = pipelineSetup({
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
  test.each(["pass", "unmet", "error", "legacy"] as const)(
    "base preview survives config edits and cleans up after verify %s",
    async (outcome) => {
      await previewFixture();
      let runId = "";
      const previews: { url: string; scratch: string }[] = [];
      const assertStopped = async () => {
        for (const { url, scratch } of previews) {
          expect(existsSync(scratch)).toBe(false);
          await expect(fetch(`${url}/health`)).rejects.toThrow();
        }
      };
      const handler: Handler = async (agent) => {
        const role = roleOf(agent);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") return { structured: approve };
        if (role === "verify") {
          const stage = factory?.store
            .getRunDetail(runId)
            ?.stages.filter((entry) => entry.name === "preview")
            .at(-1);
          expect(stage?.status).toBe("succeeded");
          const url = stage?.summary?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
          const response = await fetch(`${url}/health`);
          expect(await response.text()).toBe("seeded\n");
          const scratch = response.headers.get("x-scratch") ?? "";
          expect(existsSync(scratch)).toBe(true);
          previews.push({ url, scratch });
          if (outcome === "error") throw new Error("injected verifier failure");
          if (outcome === "unmet" && previews.length === 1)
            return {
              structured: {
                ...pass,
                overall: "fail",
                criteria: pass.criteria.map((c) => (c.id === "AC-1" ? { ...c, status: "unmet" } : c)),
              },
            };
          return { structured: pass };
        }
        await assertStopped();
        return {
          files: {
            "ui/change.txt": `visible ${previews.length}\n`,
            // Removing the table must not disable the trusted base preview.
            ".limitless.toml":
              readFileSync(join(repoDir, ".limitless.toml"), "utf8").split("[preview]")[0] ?? "",
          },
        };
      };
      const f = start(handler);
      const run = await f.createRun({ repo: repoDir, prompt: "Change the UI" });
      runId = run.id;
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        outcome === "error" ? "needs_human" : "succeeded",
      );
      expect(previews.length).toBeGreaterThan(0);
      await assertStopped();
      const state = f.store.getRunState<RunState>(run.id);
      expect(state?.previewConfig?.paths).toEqual(["ui/"]);
      if (outcome === "unmet") expect(previews).toHaveLength(2);
      if ((outcome !== "pass" && outcome !== "legacy") || !state) return;
      // Replay the persisted round after its verdict was saved, before phase advancement.
      const steps = readFileSync(join(home, "preview-steps"), "utf8");
      expect(steps).toBe("build\nseed\nserve\n");
      await f.stop();
      // Simulate an older run: restore the enabled config from base despite its removal in HEAD.
      if (outcome === "legacy") delete state.previewConfig;
      f.store.setRunState(run.id, { ...state, phase: "loop" });
      f.store.updateRun(run.id, { status: "queued", finishedAt: null });
      f.store.close();
      factory = null;
      const resumed = start(handler);
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(resumed.store.getRunState<RunState>(run.id)?.previewConfig?.paths).toEqual(["ui/"]);
      expect(previews).toHaveLength(1);
      expect(readFileSync(join(home, "preview-steps"), "utf8")).toBe(steps);
      expect(
        resumed.store.getRunDetail(run.id)?.stages.filter((entry) => entry.name === "preview"),
      ).toHaveLength(1);
    },
  );

  test.each([
    "paths = []",
    'paths = ["ui/"]\nbuild="true"\nserve="true"\nready="/health"\nenv={HOME="{scratch}/../escape"}',
    'paths = ["ui/"]\nbuild="true"\nserve="true"\nready=\'/\\evil.example/x\'\nenv={}',
  ])("invalid base preview fails prepare without model spend: %s", async (invalid) => {
    writeFileSync(join(repoDir, ".limitless.toml"), `[preview]\n${invalid}\n`);
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "invalid preview"], {
      cwd: repoDir,
    });
    let calls = 0;
    const f = start(() => {
      calls++;
      return {};
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Change the UI" });
    expect(await waitFor(f, run.id, ["failed", "succeeded", "needs_human"])).toBe("failed");
    expect(calls).toBe(0);
    expect(f.store.listInvocations(run.id)).toHaveLength(0);
    expect(f.store.getRun(run.id)?.error).toContain("Invalid [preview]");
    expect(f.store.getRunDetail(run.id)?.stages.map((stage) => [stage.name, stage.status])).toEqual([
      ["prepare", "failed"],
    ]);
  });

  test.each(["missing base SHA", "missing worktree", "invalid base preview"])(
    "legacy preview backfill fails before model calls: %s",
    async (problem) => {
      if (problem === "invalid base preview") {
        writeFileSync(join(repoDir, ".limitless.toml"), "[preview]\npaths=[]\n");
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "invalid preview"], {
          cwd: repoDir,
        });
        // A repaired worktree must not hide an invalid trusted base.
        writeFileSync(join(repoDir, ".limitless.toml"), "");
      }
      let calls = 0;
      const f = start(() => {
        calls++;
        return {};
      });
      await f.stop();
      const run = await f.createRun({ repo: repoDir, prompt: "Resume an older run" });
      const baseSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
      if (problem !== "missing base SHA") f.store.updateRun(run.id, { baseSha });
      const state: RunState = {
        phase: "triage",
        worktreePath: problem === "missing worktree" ? undefined : repoDir,
        answers: [],
        round: 0,
        roundsOnImplementer: 0,
        triedImplementers: [],
        feedback: null,
        toolCommands: [],
      };
      f.store.setRunState(run.id, state);
      expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("failed");
      expect(calls).toBe(0);
      expect(f.store.listInvocations(run.id)).toHaveLength(0);
      expect(f.store.getRun(run.id)?.error).toContain(
        problem === "invalid base preview" ? "Invalid [preview]" : "missing base SHA or worktree",
      );
      expect(f.store.getRunState<RunState>(run.id)?.previewConfig).toBeUndefined();
    },
  );

  test.each(["gates only", "no config file"])("legacy resume backfills absent preview: %s", async (base) => {
    const baseConfig = base === "gates only" ? readFileSync(join(repoDir, ".limitless.toml"), "utf8") : "";
    if (base === "no config file") {
      await sh(["git", "rm", ".limitless.toml"], { cwd: repoDir });
      await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "remove config"], {
        cwd: repoDir,
      });
    }
    const calls: string[] = [];
    let resumedRunId: string | undefined;
    const handler: Handler = (agent) => {
      if (resumedRunId) expect(factory?.store.getRunState<RunState>(resumedRunId)?.previewConfig).toBeNull();
      const role = roleOf(agent);
      calls.push(role);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return {
        files: {
          "ui/change.txt": "visible\n",
          ".limitless.toml": `${baseConfig}\n[preview]\npaths=[]\n`,
        },
      };
    };
    const f = start(handler);
    const run = await f.createRun({ repo: repoDir, prompt: "Change the UI" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const state = f.store.getRunState<RunState>(run.id);
    expect(state?.previewConfig).toBeNull();
    expect(f.store.getRunDetail(run.id)?.stages.some((stage) => stage.name === "preview")).toBe(false);
    if (!state) throw new Error("Missing state");
    await f.stop();
    delete state.previewConfig;
    state.phase = "loop";
    f.store.setRunState(run.id, state);
    f.store.updateRun(run.id, { status: "queued", finishedAt: null });
    f.store.close();
    factory = null;
    const before = calls.length;
    resumedRunId = run.id;
    const resumed = start(handler);
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(calls.slice(before)).toEqual(["review"]);
    expect(resumed.store.getRunState<RunState>(run.id)?.previewConfig).toBeNull();
    expect(resumed.store.getRunDetail(run.id)?.stages.some((stage) => stage.name === "preview")).toBe(false);
  });
});
