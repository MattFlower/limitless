import { expect, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { GateComparison } from "../src/gates/run.ts";
import type { RunState } from "../src/pipeline/context.ts";
import * as proc from "../src/util/proc.ts";
import { sh } from "../src/util/proc.ts";
import { approve, pipelineSetup, roleOf, triage, waitFor } from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";

const fixture: { home: string; repoDir: string; factory: Factory | null } = {
  home: "",
  repoDir: "",
  factory: null,
};
const { start, githubFixture, registerGithub, advanceBase } = pipelineSetup(fixture);

test.each([
  "targeted",
  "retry",
  "timeout",
  "skipped",
  "mixed",
  "unconfigured",
  "untrusted",
  "invalid",
  "post-merge",
  "post-merge skip",
  "post-merge failure",
])("docs gates pipeline: %s", async (scenario) => {
  const cwd = fixture.repoDir;
  mkdirSync(join(cwd, "docs"));
  mkdirSync(join(cwd, "test"));
  writeFileSync(join(cwd, "docs/guide.md"), "base\n");
  const initiallySkipped = ["skipped", "post-merge failure"].includes(scenario);
  writeFileSync(join(cwd, "test/a.test.ts"), initiallySkipped ? "unrelated" : "guide.md");
  writeFileSync(join(cwd, "test/b.test.ts"), "unrelated");
  const config = `[gates]
${["untrusted", "unconfigured"].includes(scenario) ? "" : scenario === "invalid" ? 'docs = "docs/**"' : 'docs = ["docs/**"]'}
retry_files = "fake-targeted {files}"
setup = ["fake-setup"]
checks = [{name="lint",run="fake-lint"}, {name="typecheck",run="fake-types"}, {name="test",run="fake-full $LIMITLESS_GATE_REPORT"}]
`;
  writeFileSync(join(cwd, ".limitless.toml"), config);
  await sh(["git", "add", "."], { cwd });
  await sh(["git", "commit", "-qm", "docs gate fixture"], { cwd });
  const postMerge = scenario.startsWith("post-merge");
  const bare = postMerge ? await githubFixture() : undefined;
  let reviews = 0;
  const f = start(async (s) => {
    const role = roleOf(s);
    if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
    if (role === "review") {
      reviews++;
      if (bare)
        await advanceBase(
          bare,
          scenario === "post-merge failure" || scenario === "post-merge skip" ? "test/a.test.ts" : "base.txt",
          scenario === "post-merge failure" ? "guide.md" : "new base\n",
        );
      return { structured: approve };
    }
    return {
      files: {
        "docs/guide.md": "updated\n",
        ...(scenario === "mixed" ? { "source.ts": "export {};\n" } : {}),
        ...(scenario === "untrusted"
          ? { ".limitless.toml": config.replace("[gates]", '[gates]\ndocs = ["**"]') }
          : {}),
      },
    };
  });
  if (bare) registerGithub(f, bare);
  const commands: string[] = [];
  let targetedAttempts = 0;
  const realProcess = proc.runProcess;
  const processSpy = spyOn(proc, "runProcess").mockImplementation(async (opts) => {
    if (opts.cmd[0] !== "/bin/sh") return realProcess(opts);
    opts.onStdoutLine?.(opts.cmd[4] ?? "");
    commands.push(opts.cmd.at(-1) ?? "");
    const targeted = opts.cmd.at(-1)?.startsWith("fake-targeted") ?? false;
    if (targeted) targetedAttempts++;
    const firstFailure = targeted && targetedAttempts === 1 && ["retry", "timeout"].includes(scenario);
    const failed = firstFailure || (targeted && scenario === "post-merge failure");
    return {
      exitCode: failed ? (scenario === "timeout" ? null : 1) : 0,
      signal: null,
      cancelled: false,
      timedOut: firstFailure && scenario === "timeout",
      idleTimedOut: false,
      truncated: false,
      stdout: "passed",
      stderr: "",
      durationMs: 1,
    };
  });
  try {
    const run = await f.createRun({
      repo: bare ? "test/repo" : cwd,
      prompt: "Update the guide",
      profile: "quick",
    });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
      scenario === "post-merge failure" ? "needs_human" : "succeeded",
    );
    expect(reviews).toBe(1);
    const mode = ["mixed", "unconfigured", "untrusted", "invalid"].includes(scenario)
      ? "full"
      : initiallySkipped
        ? "skipped"
        : "targeted";
    // The first four commands are the unchanged prepare baseline.
    expect(commands.slice(0, 4)).toEqual([
      "fake-setup",
      "fake-lint",
      "fake-types",
      "fake-full $LIMITLESS_GATE_REPORT",
    ]);
    expect(commands.slice(4, 7)).toEqual(["fake-setup", "fake-lint", "fake-types"]);
    const expectedTest =
      mode === "targeted"
        ? ["fake-targeted './test/a.test.ts'"]
        : mode === "full"
          ? ["fake-full $LIMITLESS_GATE_REPORT"]
          : [];
    expect(commands.slice(7, postMerge ? 7 + expectedTest.length : undefined)).toEqual([
      ...expectedTest,
      ...(scenario === "retry"
        ? expectedTest
        : scenario === "timeout"
          ? ["fake-setup", "fake-lint", "fake-types", ...expectedTest]
          : []),
    ]);
    const artifact = JSON.parse(f.store.getArtifact(run.id, "gates-0.json") ?? "[]") as GateComparison[];
    const testCheck = artifact.find((c) => c.name === "test");
    if (scenario === "retry") expect(testCheck?.verdict).toBe("flaky");
    if (scenario === "timeout") expect(testCheck?.firstAttempt?.timedOut).toBe(true);
    if (mode !== "full") {
      expect(testCheck?.result.docsOnly).toMatchObject({
        mode,
        changedPaths: ["docs/guide.md"],
        files: mode === "targeted" ? ["test/a.test.ts"] : [],
      });
      expect(
        f.store
          .listEvents(run.id)
          .some(
            (e) =>
              e.type === "gate" &&
              e.message.includes(`"mode":"${mode}"`) &&
              e.message.includes("docs/guide.md"),
          ),
      ).toBe(true);
    }
    if (mode === "skipped") {
      expect(testCheck).toMatchObject({
        verdict: "not_run",
        blocking: false,
        result: { output: "docs-only change; no test reads the changed files" },
      });
      if (!postMerge) expect(f.store.getArtifact(run.id, "report.md")).toContain("⚠️ not run");
    }
    const state = f.store.getRunState<RunState>(run.id);
    if (postMerge) {
      const rebase = JSON.parse(
        f.store.getArtifact(run.id, "gates-rebase-0.json") ?? "[]",
      ) as GateComparison[];
      const mergedMode = scenario === "post-merge skip" ? "skipped" : "targeted";
      expect(rebase.find((c) => c.name === "test")?.result.docsOnly?.mode).toBe(mergedMode);
      expect(commands.slice(7 + expectedTest.length)).toEqual([
        "fake-setup",
        "fake-lint",
        "fake-types",
        ...(mergedMode === "targeted" ? ["fake-targeted './test/a.test.ts'"] : []),
      ]);
      if (scenario === "post-merge failure") {
        expect(rebase.find((c) => c.name === "test")).toMatchObject({
          verdict: "new_failure",
          blocking: true,
          result: { ok: false },
        });
        expect(f.store.getRun(run.id)?.error).toContain("post-merge gates regressed");
      }
    } else
      expect(state?.lastGates?.map((c) => [c.name, c.verdict, c.blocking, c.result.docsOnly])).toEqual(
        artifact.map((c) => [c.name, c.verdict, c.blocking, c.result.docsOnly]),
      );
    if (scenario === "invalid")
      expect(f.store.listEvents(run.id).some((e) => e.message.includes("Invalid [gates].docs"))).toBe(true);
  } finally {
    await f.stop();
    processSpy.mockRestore();
  }
});
