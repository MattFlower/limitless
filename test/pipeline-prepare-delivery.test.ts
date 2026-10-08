import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { sh } from "../src/util/proc.ts";
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
  'pr create') cat >/dev/null; echo '${url}' ;;
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
