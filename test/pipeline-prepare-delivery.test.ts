import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import * as commands from "../src/git/command.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import { renderDeliveryReport } from "../src/pipeline/engine.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import { approve, pipelineSetup, roleOf, triage, waitFor } from "./pipeline-support.ts";

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
  test("prepare restart retains the reused worktree base after upstream advances", async () => {
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `${readFileSync(join(repoDir, ".limitless.toml"), "utf8")}\n[policy]\nprotected_paths = ["protected.txt"]\n`,
    );
    writeFileSync(join(repoDir, "protected.txt"), "original\n");
    const bare = await githubFixture();
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    registerGithub(f, bare);
    f.deps.faults = { "store:save": { action: "kill", when: (c) => c.stage === "prepare" } };
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    const deadline = Date.now() + 10_000;
    while (
      f.store.listStages(run.id).at(-1)?.status !== "cancelled" ||
      f.store.getRun(run.id)?.status !== "running"
    ) {
      if (Date.now() > deadline) throw new Error("prepare interruption timed out");
      await Bun.sleep(10);
    }
    await f.stop();
    const originalBase = f.store.getRun(run.id)?.baseSha;
    expect(originalBase).toHaveLength(40);
    expect(f.store.getRunState<RunState>(run.id)?.phase).toBe("prepare");
    f.store.close();
    await advanceBase(bare, "protected.txt", "upstream only\n");
    const resumed = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      expect(resumed.store.getRun(run.id)?.baseSha).toBe(originalBase);
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(resumed.store.getArtifact(run.id, "diff.patch")).not.toContain("protected.txt");
    expect(resumed.store.getRunState<RunState>(run.id)?.lastAudit).toEqual([]);
  });

  test.each(["saved URL", "branch lookup", "open PR"])("delivery restart reconciles %s", async (scenario) => {
    const bare = await githubFixture();
    const bin = join(home, "bin", "gh");
    const stateFile = join(home, "pr-state");
    const calls = join(home, "gh-calls");
    const url = "https://github.com/test/repo/pull/1";
    writeFileSync(
      bin,
      `#!/bin/sh
echo "$*" >> '${calls}'
case "$1 $2" in
  'pr view') echo '{"state":"'"$(cat '${stateFile}')"'","url":"${url}","title":"Add farewell","body":"Safe body","headRefOid":"'"$(git rev-parse HEAD)"'"}' ;;
  'pr list') if [ -f '${stateFile}' ]; then
    if [ "$*" = "pr list --repo test/repo --head $6 --state all --json state,url" ]; then
      echo '[{"state":"'"$(cat '${stateFile}')"'","url":"${url}"}]'
    else echo '${url}'; fi
  fi ;;
  'pr create') cat >/dev/null; echo OPEN > '${stateFile}'; echo '${url}' ;;
  'pr merge') echo MERGED > '${stateFile}' ;;
esac
`,
      { mode: 0o755 },
    );
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    f.store.upsertRepo({
      slug: "test/repo",
      kind: "github",
      url: bare,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "auto",
    });
    f.deps.faults = {
      "store:save": {
        action: "kill",
        when: (c) =>
          c.checkpoint === (scenario === "saved URL" ? "delivery-complete" : "delivery-pr-created"),
      },
    };
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    const deadline = Date.now() + 10_000;
    while (
      f.store.listStages(run.id).at(-1)?.name !== "deliver" ||
      f.store.listStages(run.id).at(-1)?.status !== "cancelled"
    ) {
      if (Date.now() > deadline) throw new Error("delivery interruption timed out");
      await Bun.sleep(10);
    }
    await f.stop();
    expect(f.store.getRunState<RunState>(run.id)?.phase).toBe("deliver");
    const branch = f.store.getRun(run.id)?.branch;
    if (!branch) throw new Error("missing delivery branch");
    const saved = f.store.getRunState<RunState>(run.id);
    if (!saved) throw new Error("missing state");
    saved.sizeReport = undefined;
    f.store.setRunState(run.id, saved);
    f.store.close();
    if (scenario === "branch lookup") writeFileSync(stateFile, "MERGED");
    if (scenario === "open PR") writeFileSync(stateFile, "OPEN");
    if (scenario !== "open PR") await sh(["git", "branch", "-D", branch], { cwd: bare });
    const before = readFileSync(calls, "utf8").split("\n").filter(Boolean);
    const resumed = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const after = readFileSync(calls, "utf8").split("\n").filter(Boolean);
    const size = resumed.store.getRunState<RunState>(run.id)?.sizeReport;
    expect(size).toMatchObject({ source: { added: 1, removed: 0 } });
    expect(resumed.store.getArtifact(run.id, "report.md")?.match(/^## Size$/gm)).toHaveLength(1);
    expect(resumed.store.getRun(run.id)?.prUrl).toBe(url);
    expect(resumed.store.getRun(run.id)?.merged).toBe(true);
    expect(after.filter((c) => c.startsWith("pr merge"))).toHaveLength(
      scenario === "open PR" ? 1 : scenario === "saved URL" ? 1 : 0,
    );
    if (scenario !== "open PR")
      expect(after.filter((c) => c.startsWith("pr merge"))).toEqual(
        before.filter((c) => c.startsWith("pr merge")),
      );
    expect(after.some((c) => c.startsWith(scenario === "saved URL" ? "pr view" : "pr list"))).toBe(true);
    if (scenario !== "open PR") {
      const remote = await sh(["git", "show-ref", "--verify", `refs/heads/${branch}`], {
        cwd: bare,
        allowFail: true,
      });
      expect(remote.exitCode).not.toBe(0);
    }
  });

  test("size measurement errors preserve delivery outcomes and stay out of review", async () => {
    const bare = await githubFixture();
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        expect(s.prompt).not.toContain("## Size");
        return { structured: approve };
      }
      return { files: { "farewell.txt": "goodbye\n".repeat(5) } };
    });
    registerGithub(f, bare);
    const git = commands.worktreeGit;
    const secret = `size-${"credential".repeat(12)}`;
    registerCredential("size-test", secret);
    const runOne = async (fail: boolean) => {
      const probe = spyOn(commands, "worktreeGit").mockImplementation((args, opts, retry) => {
        if (fail && args.includes("--numstat") && args.includes("-z") && args.includes("-M"))
          throw new Error(`measurement ${secret}`);
        return git(args, opts, retry);
      });
      try {
        const run = await f.createRun({
          repo: "test/repo",
          prompt: "Add farewell\n\nBudget: 1 line",
          profile: "quick",
        });
        const status = await waitFor(f, run.id, ["succeeded", "failed", "needs_human"]);
        if (status !== "succeeded")
          throw new Error(
            JSON.stringify({
              error: f.store.getRun(run.id)?.error,
              audit: f.store.getRunState<RunState>(run.id)?.lastAudit,
            }),
          );
        const state = f.store.getRunState<RunState>(run.id);
        const report = f.store.getArtifact(run.id, "report.md");
        expect(report).toContain("## Size");
        if (fail) {
          expect(report).toContain("Size unavailable: Error: measurement [redacted]");
          expect(JSON.stringify(state?.sizeReport)).not.toContain(secret);
        } else {
          expect(state?.sizeReport).toMatchObject({ source: { added: 5, removed: 0 }, stated: { lines: 1 } });
          expect(report).toContain("(500%)");
        }
        return {
          round: state?.round,
          audit: state?.lastAudit,
          gates: state?.lastGates?.map((g) => [g.name, g.verdict, g.blocking]),
          review: state?.lastReview,
          pr: f.store.getRun(run.id)?.prUrl,
        };
      } finally {
        probe.mockRestore();
      }
    };
    const control = await runOne(false);
    expect(await runOne(true)).toEqual(control);
  });

  test.each(["worktree", "base"])("missing %s saves unavailable without running git", async (missing) => {
    const f = start(() => {
      throw new Error("no agents");
    });
    const repo = f.store.upsertRepo({
      slug: "test/repo",
      kind: "local",
      localPath: repoDir,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = f.store.createRun(repo, { repo: repo.slug, prompt: "Budget: 1 line" });
    const ctx = new RunContext(f.deps, run, repo, new AbortController().signal);
    ctx.run.baseSha = missing === "base" ? null : "a".repeat(40);
    ctx.state.worktreePath = missing === "worktree" ? undefined : repoDir;
    const git = spyOn(commands, "worktreeGit");
    try {
      const result = await renderDeliveryReport(ctx, true);
      expect(result.report).toContain(`Size unavailable: No ${missing === "base" ? "base SHA" : "worktree"}`);
      expect(f.store.getRunState<RunState>(run.id)?.sizeReport).toEqual(ctx.state.sizeReport);
      expect(git).not.toHaveBeenCalled();
    } finally {
      git.mockRestore();
    }
  });

  test("HEAD lookup failure is recorded with redaction and no diff", async () => {
    const f = start(() => {
      throw new Error("no agents");
    });
    const repo = f.store.upsertRepo({
      slug: "test/repo",
      kind: "local",
      localPath: repoDir,
      url: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const run = f.store.createRun(repo, { repo: repo.slug, prompt: "request" });
    const ctx = new RunContext(f.deps, run, repo, new AbortController().signal);
    ctx.run.baseSha = "a".repeat(40);
    ctx.state.worktreePath = repoDir;
    const secret = `head-${"credential".repeat(10)}`;
    registerCredential("size-head-test", secret);
    const git = spyOn(commands, "worktreeGit").mockRejectedValue(new Error(`HEAD lookup ${secret}`));
    try {
      expect((await renderDeliveryReport(ctx, true)).report).toContain(
        "Size unavailable: Error: HEAD lookup [redacted]",
      );
      expect(ctx.state.sizeReport).toMatchObject({
        head: "HEAD",
        mode: "two-dot",
        error: "Error: HEAD lookup [redacted]",
      });
      expect(git).toHaveBeenCalledTimes(1);
      expect(git.mock.calls[0]?.[0]).toEqual(["git", "rev-parse", "HEAD"]);
    } finally {
      git.mockRestore();
    }
  });

  test("implement summaries include the commit or no changes and warn on empty timeout", async () => {
    let calls = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      calls++;
      return calls === 1
        ? { status: "timeout", files: { "farewell.txt": "goodbye\n" } }
        : { status: "timeout" };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const stages = f.store.listStages(run.id).filter((s) => s.name === "implement");
    expect(stages[0]?.summary).toContain(f.store.getRun(run.id)?.headSha?.slice(0, 8) ?? "missing SHA");
    expect(
      f.store
        .listEvents(run.id)
        .some((e) => e.level === "warn" && e.message === "Implementer ended with timeout"),
    ).toBe(true);
    expect(stages[0]?.summary).not.toContain("timeout: ");
    const empty = await f.createRun({ repo: repoDir, prompt: "Leave files unchanged", profile: "quick" });
    expect(await waitFor(f, empty.id, ["succeeded", "failed", "needs_human"])).toBe("needs_human");
    expect(f.store.listStages(empty.id).find((s) => s.name === "implement")?.summary).toContain("no changes");
  });
});
