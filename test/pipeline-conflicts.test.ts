import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { FakeReply } from "../src/harness/fake.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { sh } from "../src/util/proc.ts";
import { approve, holdout, pass, pipelineSetup, roleOf, spec, triage, waitFor } from "./pipeline-support.ts";
import { findingEvidence } from "./review-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start, githubFixture, registerGithub, advanceBase, assertPublished, resolveBaseConflict } =
  pipelineSetup({
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
  for (const kind of [
    "unchanged",
    "clean",
    "clean-scripts",
    "regressed",
    "setup-regressed",
    "fixed-regressed",
    "conflict",
    "conflict-scripts",
    "rewritten",
  ] as const) {
    test(`GitHub delivery handles ${kind} base`, async () => {
      const conflict = kind === "conflict" || kind === "conflict-scripts";
      const changedScripts = kind === "clean-scripts" || kind === "conflict-scripts";
      if (kind === "setup-regressed" || kind === "fixed-regressed") {
        writeFileSync(
          join(repoDir, ".limitless.toml"),
          kind === "setup-regressed"
            ? '[gates]\nsetup = ["test ! -f base.txt"]\nchecks = [{ name = "check", run = "true" }]\n'
            : '[gates]\nchecks = [{ name = "check", run = "test -f farewell.txt && test ! -f base.txt" }]\n',
        );
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "gate fixture"], {
          cwd: repoDir,
        });
      }
      if (changedScripts) {
        writeFileSync(
          join(repoDir, "package.json"),
          JSON.stringify({ scripts: { check: "test -s greeting.txt" } }),
        );
        writeFileSync(
          join(repoDir, ".limitless.toml"),
          '[gates]\nchecks = [{ name = "check", run = "bun run check" }]\n',
        );
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "script gate"], {
          cwd: repoDir,
        });
      }
      if (kind === "clean" || kind === "unchanged") {
        const configPath = join(repoDir, ".limitless.toml");
        writeFileSync(
          configPath,
          readFileSync(configPath, "utf8").replace(
            "[gates]\n",
            `[gates]\nsetup = ["echo setup >> '${join(home, "setup-calls")}'"]\n`,
          ),
        );
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "setup fixture"], {
          cwd: repoDir,
        });
      }
      const bare = await githubFixture();
      let baseTip = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
      const originalBase = baseTip;
      let implementCalls = 0;
      let reviews = 0;
      let verifies = 0;
      let mergePrompt = "";
      let checkedHead = "";
      let preMergeHead = "";
      const f = start(async (s): Promise<FakeReply> => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage({ suggested_profile: "standard" }) };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") {
          reviews++;
          if (reviews === 1 && kind !== "unchanged") {
            if (changedScripts) {
              writeFileSync(
                join(repoDir, "package.json"),
                JSON.stringify({ scripts: { check: "test -s greeting.txt && test -f package.json" } }),
              );
            }
            if (conflict) writeFileSync(join(repoDir, "base.txt"), "base only\n");
            baseTip = await advanceBase(
              bare,
              conflict ? "greeting.txt" : "base.txt",
              kind === "regressed" ? "BAD base\n" : "new base\n",
            );
            if (kind === "rewritten") {
              // Replace the initial commit so the fetched base no longer descends from it.
              baseTip = (
                await sh(["git", "commit-tree", "HEAD^{tree}", "-m", "rewritten base"], {
                  cwd: repoDir,
                  env: {
                    GIT_AUTHOR_NAME: "t",
                    GIT_AUTHOR_EMAIL: "t@t",
                    GIT_COMMITTER_NAME: "t",
                    GIT_COMMITTER_EMAIL: "t@t",
                  },
                })
              ).stdout.trim();
              await sh(["git", "push", "--force", bare, `${baseTip}:refs/heads/main`], { cwd: repoDir });
            }
          }
          if (reviews === 2) {
            expect(s.prompt).toContain(baseTip);
            expect(s.prompt).not.toContain(`git diff ${preMergeHead}..`);
            expect(s.prompt).not.toContain("base.txt");
            expect(s.prompt).not.toContain("package.json");
          }
          return { structured: approve };
        }
        if (role === "verify") {
          verifies++;
          if (verifies === 2) expect(s.prompt).toContain(baseTip);
          checkedHead = (await sh(["git", "rev-parse", "HEAD"], { cwd: s.cwd })).stdout.trim();
          if (verifies === 1) preMergeHead = checkedHead;
          return { structured: pass };
        }
        implementCalls++;
        if (conflict && implementCalls === 2) {
          mergePrompt = s.prompt;
          return resolveBaseConflict(s.cwd, bare);
        }
        const files: Record<string, string> = { "farewell.txt": "goodbye\n" };
        if (conflict) files["greeting.txt"] = "hello from feature\n";
        return { files };
      });
      registerGithub(f, bare);
      const run = await f.createRun({
        repo: "test/repo",
        prompt: "Add a farewell file",
        profile: "standard",
      });
      const status = await waitFor(f, run.id, ["succeeded", "failed", "needs_human"]);
      const fallback = kind.endsWith("regressed") || kind === "rewritten";
      expect(status).toBe(kind.endsWith("regressed") ? "needs_human" : "succeeded");
      const finished = f.store.getRun(run.id);
      const stages = f.store.listStages(run.id).map((s) => s.name);
      const gates = stages.filter((s) => s === "gates").length;
      expect(gates).toBe(kind === "unchanged" || kind === "rewritten" ? 1 : 2);
      if (kind === "clean" || kind === "unchanged")
        expect(readFileSync(join(home, "setup-calls"), "utf8").trim().split("\n")).toHaveLength(
          kind === "clean" ? 3 : 2,
        );
      expect(stages.filter((s) => s === "audit")).toHaveLength(conflict ? 2 : 1);
      expect(implementCalls).toBe(conflict ? 2 : 1);
      expect(reviews).toBe(conflict ? 2 : 1);
      expect(verifies).toBe(conflict ? 2 : 1);
      if (conflict) {
        expect(mergePrompt).toContain("do not run Git");
        expect(mergePrompt).toContain("- greeting.txt");
        expect(mergePrompt).not.toContain("git diff");
        expect(mergePrompt).not.toContain("Committing is optional");
        expect(stages.slice(-6)).toEqual(["implement", "gates", "audit", "review", "verify", "deliver"]);
        expect(f.store.getArtifact(run.id, "diff.patch")).not.toContain("+new base");
      }
      if (fallback) {
        expect(finished?.baseSha).toBe(originalBase);
        const state = f.store.getRunState<RunState>(run.id);
        if (kind === "rewritten")
          expect(f.store.getArtifact(run.id, "report.md")).toContain(state?.rebaseNote ?? "missing note");
        else {
          expect(state?.lastVerifiedSha).toBe(preMergeHead);
          expect(finished?.prUrl).toContain("/pull/1");
          expect(f.store.getArtifact(run.id, "report.md")).toContain("post-merge gates");
          expect(f.store.getArtifact(run.id, "report.md")).toContain(preMergeHead);
          expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("--draft");
        }
        expect(
          (
            await sh(["git", "merge-base", "--is-ancestor", baseTip, finished?.headSha ?? ""], {
              cwd: bare,
              allowFail: true,
            })
          ).exitCode,
        ).not.toBe(0);
        if (kind.endsWith("regressed")) {
          expect(f.store.getArtifact(run.id, "gates-rebase-0.json")).toContain("regressed");
          expect(state?.lastGates?.some((g) => g.blocking)).toBe(false);
          expect(
            f.store
              .listStages(run.id)
              .filter((s) => s.name === "gates")
              .at(-1)?.status,
          ).toBe("failed");
        } else expect(state?.rebaseNote).toContain("no longer descends from the recorded base");
      } else {
        expect(finished?.baseSha).toBe(baseTip);
        expect(
          (
            await sh(["git", "merge-base", "--is-ancestor", baseTip, finished?.headSha ?? ""], {
              cwd: bare,
              allowFail: true,
            })
          ).exitCode,
        ).toBe(0);
        expect(
          (await sh(["git", "ls-remote", bare, `refs/heads/${finished?.branch}`], { cwd: repoDir })).stdout,
        ).toContain(finished?.headSha ?? "missing");
        if (kind === "unchanged") expect(finished?.headSha).toBe(checkedHead);
        else {
          expect(
            (
              await sh(["git", "rev-list", "--parents", "-n", "1", finished?.headSha ?? ""], { cwd: bare })
            ).stdout
              .trim()
              .split(" ")
              .slice(1),
          ).toEqual([preMergeHead, baseTip]);
          const diff = (await sh(["git", "diff", `${baseTip}...${finished?.headSha}`], { cwd: bare })).stdout;
          expect(diff).not.toContain("base.txt");
          expect(diff).not.toContain("package.json");
          expect(diff).toContain("farewell.txt");
        }
      }
      if (changedScripts) {
        const state = f.store.getRunState<RunState>(run.id);
        expect(state?.baselineScripts).toEqual({ check: "test -s greeting.txt && test -f package.json" });
        expect(state?.lastAudit?.some((finding) => finding.rule === "gate-script-changed")).toBe(false);
        expect(f.store.getArtifact(run.id, "diff.patch")).not.toContain("package.json");
      }
      await assertPublished(bare);
    });
  }

  for (const outcome of ["exhausted", "gates", "audit", "review", "verify", "base-moved"] as const) {
    test(`conflict resolution gets one checked round: ${outcome}`, async () => {
      if (outcome === "audit") {
        writeFileSync(
          join(repoDir, ".limitless.toml"),
          `${readFileSync(join(repoDir, ".limitless.toml"), "utf8")}\n[policy]\nprotected_paths = [".limitless.toml"]\n`,
        );
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "protect gates"], {
          cwd: repoDir,
        });
      }
      const bare = await githubFixture();
      let implementsCount = 0;
      let reviews = 0;
      let verifies = 0;
      let baseTip = "";
      const normalRounds = outcome === "exhausted" ? 3 : 1;
      const f = start(async (s): Promise<FakeReply> => {
        const role = roleOf(s);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") {
          reviews++;
          if (reviews < normalRounds || (outcome === "review" && reviews > normalRounds))
            return {
              structured: {
                verdict: "request_changes",
                summary: "Fix the feature",
                findings: [
                  {
                    severity: "blocker",
                    security: false,
                    ...findingEvidence,
                    ...(reviews > 1
                      ? reviews > normalRounds
                        ? { label: "regression", prior: "" }
                        : { label: "unaddressed", prior: "P1" }
                      : {}),
                    file: "farewell.txt",
                    line: 1,
                    title: "Fix the feature",
                    detail: "Incorrect output",
                    suggestion: "Fix it",
                  },
                ],
              },
            };
          if (reviews === normalRounds) baseTip = await advanceBase(bare, "greeting.txt", "new base\n");
          expect(s.prompt).toContain(reviews > normalRounds ? baseTip : "Add a farewell");
          return { structured: approve };
        }
        if (role === "verify") {
          verifies++;
          if (verifies === 2) {
            expect(s.prompt).toContain(baseTip);
            if (outcome === "base-moved") await advanceBase(bare, "again.txt", "another advance\n");
          }
          return {
            structured:
              outcome === "verify" && verifies === 2
                ? { ...pass, criteria: pass.criteria.map((c) => ({ ...c, status: "unmet" })) }
                : pass,
          };
        }
        implementsCount++;
        if (implementsCount > normalRounds) {
          expect(s.prompt).toContain("do not run Git");
          expect(s.prompt).toContain("preserving both intents");
          const reply = await resolveBaseConflict(s.cwd, bare);
          if (outcome === "gates") return { files: { ...reply.files, "bad.txt": "BAD\n" } };
          if (outcome === "audit")
            return { files: { ...reply.files, ".limitless.toml": "# removed gates\n" } };
          return reply;
        }
        return { files: { "greeting.txt": "feature\n", "farewell.txt": "goodbye\n" } };
      });
      f.cfg.maxRounds = 1;
      registerGithub(f, bare);
      const run = await f.createRun({ repo: "test/repo", prompt: "Add a farewell", profile: "standard" });
      const status = await waitFor(f, run.id, ["succeeded", "failed", "needs_human"]);
      expect(status).toBe(outcome === "exhausted" || outcome === "base-moved" ? "succeeded" : "needs_human");
      expect(implementsCount).toBe(normalRounds + 1);
      expect(f.store.getRun(run.id)?.baseSha).toBe(baseTip);
      expect(f.store.getRunState<RunState>(run.id)?.conflictRound).toBe(normalRounds);
      if (outcome === "exhausted") {
        expect(reviews).toBe(4);
        expect(verifies).toBe(2);
        expect(
          f.store
            .listStages(run.id)
            .slice(-6)
            .map((s) => s.name),
        ).toEqual(["implement", "gates", "audit", "review", "verify", "deliver"]);
        const head = f.store.getRun(run.id)?.headSha ?? "";
        expect(
          (await sh(["git", "merge-base", "--is-ancestor", baseTip, head], { cwd: bare })).exitCode,
        ).toBe(0);
      } else if (outcome === "base-moved") {
        expect(f.store.getRunState<RunState>(run.id)?.rebaseNote).toContain("advanced again");
        await assertPublished(bare);
      } else {
        const state = f.store.getRunState<RunState>(run.id);
        const finished = f.store.getRun(run.id);
        const sha = state?.lastVerifiedSha ?? "missing";
        expect(sha).toHaveLength(40);
        expect(finished?.prUrl).toContain("/pull/1");
        expect(
          (await sh(["git", "ls-remote", bare, `refs/heads/${finished?.branch}`], { cwd: repoDir })).stdout,
        ).toContain(sha);
        // Single mode saves main's evidence: follow-ups and review history stay live, not snapshotted.
        const evidence = state?.lastVerifiedEvidence;
        expect(evidence?.lastReview?.verdict).toBe("approve");
        expect(evidence).not.toHaveProperty("reviewFollowUps");
        expect(evidence).not.toHaveProperty("reviewHistory");
        const report = f.store.getArtifact(run.id, "report.md") ?? "";
        expect(report).toContain(`Verified at \`${sha}\``);
        expect(report).toContain("conflict resolution");
        expect(report).toContain("The PR may conflict with `main`");
        expect(report).toContain("Acceptance criteria");
        expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("--title [needs human]");
        expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("--draft");
        expect(readFileSync(join(home, "gh-body"), "utf8")).toBe(report);
      }
    });
  }

  test("quick approval is the verified fallback when post-merge gates fail", async () => {
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      '[gates]\nchecks = [{ name = "check", run = "test ! -f base.txt" }]\n',
    );
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "quick gate"], {
      cwd: repoDir,
    });
    const bare = await githubFixture();
    let approvedSha = "";
    const f = start(async (s): Promise<FakeReply> => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        approvedSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: s.cwd })).stdout.trim();
        await advanceBase(bare, "base.txt", "new base\n");
        return { structured: approve };
      }
      if (role === "verify" || role === "spec" || role === "holdout") throw new Error(`unexpected ${role}`);
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    registerGithub(f, bare);
    const run = await f.createRun({ repo: "test/repo", prompt: "Add a farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    const finished = f.store.getRun(run.id);
    expect(f.store.getRunState<RunState>(run.id)?.lastVerifiedSha).toBe(approvedSha);
    expect(
      (await sh(["git", "ls-remote", bare, `refs/heads/${finished?.branch}`], { cwd: repoDir })).stdout,
    ).toContain(approvedSha);
    expect(f.store.getArtifact(run.id, "report.md")).toContain("post-merge gates");
  });
});
