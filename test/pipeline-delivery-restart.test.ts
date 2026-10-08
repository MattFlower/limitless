import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { RunState } from "../src/pipeline/context.ts";
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
const {
  start,
  githubFixture,
  registerGithub,
  advanceBase,
  assertPublished,
  assertUnpublished,
  resolveBaseConflict,
} = pipelineSetup({
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
  for (const checkpoint of [
    "post-rebase-gates",
    "post-rebase-gates-fail",
    "interrupted-merge",
    "base-moved",
    "base-moved-during-gates",
    "conflict-implement",
    "conflict-committed",
  ] as const) {
    test(`delivery checkpoint ${checkpoint} never publishes unchecked work`, async () => {
      const conflict = checkpoint.startsWith("conflict-");
      const marker = join(home, "checking");
      const release = join(home, "release");
      if (checkpoint !== "conflict-implement") {
        const check = `if test -f base.txt && ! test -f '${release}'; then echo dirty > greeting.txt; touch '${marker}'; while ! test -f '${release}'; do sleep 0.05; done; fi; test -f greeting.txt${checkpoint === "post-rebase-gates-fail" ? " && test ! -f base.txt" : ""}`;
        writeFileSync(
          join(repoDir, ".limitless.toml"),
          `[gates]\nchecks = [{ name = "check", run = "${check}" }]\n`,
        );
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "slow gate"], {
          cwd: repoDir,
        });
      }
      const bare = await githubFixture();
      let baseTip = "";
      let implementsCount = 0;
      let reviews = 0;
      let verifies = 0;
      let restarting = false;
      const handler: Handler = async (s) => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") {
          reviews++;
          if (reviews === 1) {
            writeFileSync(join(repoDir, "base.txt"), "base only\n");
            baseTip = await advanceBase(bare, conflict ? "greeting.txt" : "base.txt", "new base\n");
          }
          return { structured: approve };
        }
        if (role === "verify") {
          verifies++;
          return { structured: pass };
        }
        implementsCount++;
        if (implementsCount > 1) {
          expect(s.prompt).toContain("do not run Git");
          if (checkpoint === "conflict-committed") return resolveBaseConflict(s.cwd, bare);
          if (!restarting) {
            writeFileSync(join(s.cwd, "greeting.txt"), "partially resolved\n");
            writeFileSync(marker, "implementing");
            return { delayMs: 30_000 };
          }
          expect(readFileSync(join(s.cwd, "greeting.txt"), "utf8")).toBe("partially resolved\n");
          expect((await sh(["git", "rev-parse", "MERGE_HEAD"], { cwd: s.cwd })).stdout.trim()).toBe(baseTip);
          return { files: { "greeting.txt": "hello from both intents\nnew base\n" } };
        }
        return {
          files: {
            "farewell.txt": "goodbye\n",
            ...(conflict ? { "greeting.txt": "feature\n" } : {}),
          },
        };
      };
      const f = start(handler);
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Add a farewell", profile: "standard" });
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(marker)).toBe(true);
      if (checkpoint === "base-moved-during-gates") {
        await assertUnpublished(bare);
        await advanceBase(bare, "again.txt", "newer base\n");
        writeFileSync(release, "finish gates");
        // The head that passed the post-rebase gates is published; the newer base is the PR's concern.
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
        const published = f.store.getRun(run.id);
        expect(published?.baseSha).toBe(baseTip);
        expect(f.store.listStages(run.id).filter((s) => s.name === "gates")).toHaveLength(2);
        expect(implementsCount).toBe(1);
        expect(reviews).toBe(1);
        expect(verifies).toBe(1);
        expect(
          (await sh(["git", "show", `${published?.headSha}:greeting.txt`], { cwd: bare })).stdout,
        ).not.toContain("dirty");
        await assertPublished(bare);
        return;
      }
      await f.stop();
      expect(f.store.getRun(run.id)?.status).toBe("queued");
      const state = f.store.getRunState<RunState>(run.id);
      expect(state?.phase).toBe(conflict ? "loop" : "deliver");
      expect(state?.lastVerifiedSha).toHaveLength(40);
      if (conflict) {
        expect(f.store.getRun(run.id)?.baseSha).toBe(baseTip);
        expect(state?.conflictRound).toBe(1);
      } else {
        expect(state?.pendingRebaseSha).toBe(baseTip);
        expect(f.store.getRun(run.id)?.baseSha).not.toBe(baseTip);
      }
      await assertUnpublished(bare);
      if (checkpoint === "interrupted-merge") {
        const cwd = state?.worktreePath;
        if (!cwd || !state?.preRebaseHead) throw new Error("missing delivery checkpoint");
        await sh(["git", "reset", "--hard", state.preRebaseHead], { cwd });
        await sh(
          ["git", "-c", "user.name=t", "-c", "user.email=t@t", "merge", "--no-ff", "--no-commit", baseTip],
          { cwd },
        );
      }
      if (checkpoint === "conflict-committed" && state) {
        // Also exercise the crash window after git commit but before implementedRound is saved.
        state.implementedRound = undefined;
        f.store.updateRun(run.id, {}, state);
      }
      f.store.close();
      restarting = true;
      if (checkpoint === "base-moved" || conflict) await advanceBase(bare, "again.txt", "newer base\n");
      writeFileSync(release, "resume");
      const resumed = start(handler);
      if (checkpoint === "post-rebase-gates-fail") {
        expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
        const finished = resumed.store.getRun(run.id);
        const savedSha = state?.lastVerifiedSha ?? "missing";
        expect(resumed.store.getRunState<RunState>(run.id)?.lastVerifiedSha).toBe(savedSha);
        expect(
          (await sh(["git", "ls-remote", bare, `refs/heads/${finished?.branch}`], { cwd: repoDir })).stdout,
        ).toContain(savedSha);
        expect(finished?.prUrl).toContain("/pull/1");
        return;
      }
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      const finished = resumed.store.getRun(run.id);
      expect(finished?.baseSha).toBe(baseTip);
      expect(resumed.store.getRunState<RunState>(run.id)?.pendingRebaseSha).toBeUndefined();
      expect(implementsCount).toBe(conflict ? (checkpoint === "conflict-implement" ? 3 : 2) : 1);
      expect(reviews).toBe(conflict ? 2 : 1);
      expect(verifies).toBe(conflict ? 2 : 1);
      expect(
        (await sh(["git", "merge-base", "--is-ancestor", baseTip, finished?.headSha ?? ""], { cwd: bare }))
          .exitCode,
      ).toBe(0);
      expect(
        (await sh(["git", "show", `${finished?.headSha}:greeting.txt`], { cwd: bare })).stdout,
      ).not.toContain("dirty");
      expect(
        (
          await sh(["git", "rev-list", "--count", "--merges", finished?.headSha ?? ""], { cwd: bare })
        ).stdout.trim(),
      ).toBe("1");
      expect(
        (await sh(["git", "rev-list", "--parents", "-n", "1", finished?.headSha ?? ""], { cwd: bare })).stdout
          .trim()
          .split(" ")
          .slice(1),
      ).toEqual([state?.preRebaseHead ?? "", baseTip]);
      expect(resumed.store.listStages(run.id).filter((s) => s.name === "gates")).toHaveLength(
        checkpoint === "conflict-implement" ? 2 : 3,
      );
    });
  }

  test.each([
    ["main", null],
    ["main", "not-a-sha"],
    ["main.lock", "b".repeat(40)],
  ])("PR verification rejects invalid base metadata: %s %s", async (baseRef, baseSha) => {
    const f = start(() => {
      throw new Error("No model should run");
    });
    const run = await f.createRun({
      repo: repoDir,
      prompt: "verify",
      sourceRef: { kind: "pull_request", baseRef, baseSha, headSha: "a".repeat(40), number: 1 },
    });
    expect(await waitFor(f, run.id, ["failed", "succeeded"])).toBe("failed");
    expect(f.store.getRun(run.id)?.error).toContain("valid PR baseRef");
    expect(f.store.listInvocations(run.id)).toHaveLength(0);
  });
});
