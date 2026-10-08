import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Factory } from "../src/app.ts";
import { recordWorktree } from "../src/git/command.ts";
import { completeMerge, mergeGit, prepareMerge } from "../src/git/merge.ts";
import type { FakeReply } from "../src/harness/fake.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { sh } from "../src/util/proc.ts";
import { approve, pipelineSetup, roleOf, triage, waitFor } from "./pipeline-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start, githubFixture, registerGithub, advanceBase, fixture } = pipelineSetup({
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
  for (const fault of [
    "missing",
    "single-parent",
    "markers",
    "resolver-error",
    "resolver-timeout",
    "partial",
    "fixture",
    "stray",
    "same-tree",
    "setext",
  ] as const) {
    test(`factory merge resolution: ${fault}`, async () => {
      const bare = await githubFixture();
      let calls = 0;
      let before = "";
      let base = "";
      const f = start(async (s): Promise<FakeReply> => {
        if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        // "fixture" conflicts right after a pre-existing marker line identical to git's own.
        const [file, prefix] = fault === "fixture" ? ["markers.fixture", fixture] : ["greeting.txt", ""];
        if (roleOf(s) === "review") {
          if (!base) base = await advanceBase(bare, file, `${prefix}base intent\n`);
          return { structured: approve };
        }
        calls++;
        if (calls === 1) return { files: { [file]: `${prefix}feature intent\n` } };
        before = (await sh(["git", "rev-parse", "HEAD"], { cwd: s.cwd })).stdout.trim();
        if (fault === "resolver-error" || fault === "resolver-timeout") {
          expect(readFileSync(join(s.cwd, file), "utf8")).toContain("<<<<<<< HEAD");
          // Even a failed resolver can have changed the index before it exits.
          await mergeGit(s.cwd, ["add", file]);
          return { status: fault === "resolver-error" ? "error" : "timeout", error: "resolver failed" };
        }
        if (fault === "fixture") {
          expect(readFileSync(join(s.cwd, file), "utf8")).toBe(
            `${fixture}<<<<<<< HEAD\nfeature intent\n=======\nbase intent\n>>>>>>> ${base}\n`,
          );
          return { files: { [file]: `${fixture}<<<<<<< HEAD\nfeature intent\n=======\nbase intent\n` } };
        }
        if (fault === "missing" || fault === "single-parent") {
          const path = (
            await sh(["git", "rev-parse", "--git-path", "MERGE_HEAD"], { cwd: s.cwd })
          ).stdout.trim();
          rmSync(resolve(s.cwd, path));
          if (fault === "single-parent") {
            writeFileSync(join(s.cwd, "greeting.txt"), "replacement\n");
            await mergeGit(s.cwd, ["add", "-A"]);
            await mergeGit(s.cwd, ["commit", "-qm", "lost merge parent"]);
          }
        }
        if (fault === "stray")
          return {
            files: {
              "greeting.txt": "feature intent\nbase intent\n",
              "README.md": "Project\n=======\n<<<<<<< HEAD\nours\n",
              "new.txt": "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> base\n",
            },
          };
        if (fault === "partial")
          return { files: { "greeting.txt": `feature intent\n=======\nbase intent\n>>>>>>> ${base}\n` } };
        if (fault === "setext")
          return { files: { "greeting.txt": "Greeting\n========\nfeature intent\nbase intent\n" } };
        return fault === "same-tree" ? { files: { "greeting.txt": "feature intent\n" } } : {};
      });
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Change greeting", profile: "quick" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        fault === "same-tree" || fault === "setext" ? "succeeded" : "needs_human",
      );
      expect(calls).toBe(2);
      const result = f.store.getRun(run.id);
      if (fault === "same-tree" || fault === "setext") {
        expect(
          (await sh(["git", "rev-list", "--parents", "-n", "1", result?.headSha ?? ""], { cwd: bare })).stdout
            .trim()
            .split(" ")
            .slice(1),
        ).toEqual([before, base]);
        if (fault === "same-tree")
          expect((await sh(["git", "diff", before, result?.headSha ?? ""], { cwd: bare })).stdout).toBe("");
        else
          expect((await sh(["git", "show", `${result?.headSha}:greeting.txt`], { cwd: bare })).stdout).toBe(
            "Greeting\n========\nfeature intent\nbase intent\n",
          );
      } else {
        expect(result?.error).toContain(
          fault === "markers" ||
            fault === "partial" ||
            fault === "resolver-error" ||
            fault === "resolver-timeout"
            ? "Unresolved conflict markers: greeting.txt"
            : fault === "fixture"
              ? "Unresolved conflict markers: markers.fixture"
              : fault === "stray"
                ? "Unresolved conflict markers: new.txt, README.md"
                : "MERGE_HEAD",
        );
        if (fault === "resolver-error" || fault === "resolver-timeout") {
          const cwd = f.store.getRunState<RunState>(run.id)?.worktreePath ?? "";
          expect((await mergeGit(cwd, ["rev-parse", "HEAD"])).stdout.trim()).toBe(before);
          expect((await mergeGit(cwd, ["rev-parse", "MERGE_HEAD"])).stdout.trim()).toBe(base);
          expect(
            (await mergeGit(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout
              .trim()
              .split(" ")
              .slice(1),
          ).toHaveLength(1);
          expect(f.store.getRunState<RunState>(run.id)?.implementerIssue).toContain(
            fault === "resolver-error" ? "error" : "timeout",
          );
        }
        const verified = f.store.getRunState<RunState>(run.id)?.lastVerifiedSha;
        expect(verified).toHaveLength(40);
        expect(
          (await sh(["git", "ls-remote", bare, `refs/heads/${result?.branch}`], { cwd: repoDir })).stdout,
        ).toContain(verified ?? "missing");
      }
    });
  }

  test("merge helpers isolate configured code in a linked worktree and reject non-conflict errors", async () => {
    const cwd = join(home, "linked");
    await sh(["git", "worktree", "add", "-b", "feature", cwd], { cwd: repoDir });
    await recordWorktree(cwd);
    writeFileSync(join(cwd, "greeting.txt"), "feature\n");
    await mergeGit(cwd, ["add", "-A"]);
    await mergeGit(cwd, ["commit", "-qm", "feature"]);
    const before = (await mergeGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
    writeFileSync(join(repoDir, ".git", "info", "attributes"), "greeting.txt merge=secret-check\n");
    writeFileSync(join(repoDir, "greeting.txt"), "base\n");
    await mergeGit(repoDir, ["add", "-A"]);
    await mergeGit(repoDir, ["commit", "-qm", "base"]);
    const base = (await mergeGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
    const sentinel = join(home, "hook-ran");
    for (const hook of [
      "pre-merge-commit",
      "prepare-commit-msg",
      "commit-msg",
      "post-commit",
      "post-merge",
      "post-index-change",
    ])
      writeFileSync(join(repoDir, ".git", "hooks", hook), `#!/bin/sh\ntouch '${sentinel}'\n`, {
        mode: 0o755,
      });
    await sh(
      [
        "git",
        "config",
        "merge.secret-check.driver",
        `test -z "$LIMITLESS_MERGE_TEST_SECRET" && touch '${join(home, "driver-ran")}' && exit 1`,
      ],
      { cwd },
    );
    process.env.LIMITLESS_MERGE_TEST_SECRET = "must not escape";
    try {
      await expect(prepareMerge(cwd, before, "invalid-target")).rejects.toThrow("Merge preparation failed");
      expect(await prepareMerge(cwd, before, base)).toEqual(["greeting.txt"]);
      expect(existsSync(join(home, "driver-ran"))).toBe(true);
      writeFileSync(join(cwd, "greeting.txt"), "both intents\n");
      await completeMerge(cwd, before, base);
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      delete process.env.LIMITLESS_MERGE_TEST_SECRET;
    }
  });
});
