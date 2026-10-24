import { expect } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Factory } from "../src/app.ts";
import { type GateExecutor, gateExecutorFor } from "../src/gates/executor.ts";
import { runInplaceExecutor } from "../src/gates/inplace.ts";
import { runLocalGates } from "../src/gates/run.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import {
  approve,
  holdout,
  pass,
  pipelineSetup,
  providers,
  roleOf,
  spec,
  triage,
  waitFor,
} from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";
import {
  captureSetupEnv,
  dependencyPackage,
  expectPrivateSetup,
  expectReaderDependency,
  expectReaderPermissions,
  importReaderDependency,
  readerDependencyFixture,
} from "./reader-dependencies-support.ts";

const fixture = { home: "", repoDir: "", factory: null as Factory | null };
const { start } = pipelineSetup(fixture);

// Gates really execute setup and checks, but their ignored files never reach the coordinator.
const remoteGates: GateExecutor = {
  kind: "lan",
  async start() {
    return { kind: "lan", id: crypto.randomUUID(), startedAt: Date.now() };
  },
  attach(handle, signal, req) {
    if (!req) throw new Error("Missing request");
    const cwd = join(fixture.home, `gate-${handle.id}`);
    cpSync(req.cwd, cwd, {
      recursive: true,
      filter: (path) => ![".git", "node_modules"].includes(basename(path)),
    });
    writeFileSync(join(cwd, "remote-only"), "gate checkout");
    return {
      events: { async *[Symbol.asyncIterator]() {} },
      result: runLocalGates(cwd, req.gates, signal).then((result) => ({ ...result, sha: req.headSha })),
      async cancel() {},
    };
  },
};

for (const [harness, layout] of [
  ["claude", "local"],
  ["codex", "local"],
  ["codex", "inplace"],
  ["claude", "lan"],
  ["codex", "changed-lockfile"],
  ["codex", "resumed"],
  ["codex", "shadow"],
  ["codex", "failure"],
] as const) {
  test(`reader dependencies: ${harness} ${layout}`, async () => {
    const { home, repoDir } = fixture;
    const install = await readerDependencyFixture(repoDir);
    const updatedFiles: Record<string, string> = {};
    if (layout === "changed-lockfile") {
      const next = join(home, "next");
      mkdirSync(next);
      await readerDependencyFixture(next, "4.1.0");
      for (const file of [
        "package.json",
        "bun.lock",
        "vendor/zod-4.1.0/package.json",
        "vendor/zod-4.1.0/index.js",
      ])
        updatedFiles[file] = readFileSync(join(next, file), "utf8");
    }
    dependencyPackage(join(home, "node_modules/zod"), "3.0.0");
    const ancestor = join(home, "node_modules/zod/index.js");
    const before = readFileSync(ancestor, "utf8");
    expect(await importReaderDependency(repoDir)).toMatchObject({ version: "3.0.0", prefault: "undefined" });
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\nsetup = [${JSON.stringify(layout === "failure" ? `test -f remote-only && ${install}` : install)}, ${JSON.stringify(captureSetupEnv)}]\nchecks = [{ name = "dependency", run = ${JSON.stringify(`${JSON.stringify(process.execPath)} dependency-probe.ts`)} }]\n`,
    );
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "commit", "-qm", "offline reader dependencies"], { cwd: repoDir });
    const readers: string[] = [];
    const handler = async (s: AgentSpec) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review" || role === "verify") {
        readers.push(basename(s.cwd) === "shadow" ? "shadow" : role);
        expect(s.target.harness).toBe(harness);
        await expectReaderDependency(s.cwd, layout === "changed-lockfile" ? "4.1.0" : "4.0.0");
        expectPrivateSetup(s.cwd);
        expectReaderPermissions(s);
        return { structured: role === "review" ? approve : pass };
      }
      return { files: { ...updatedFiles, "farewell.txt": "goodbye\n" } };
    };
    const f = start(handler, false, false, {
      providers: providers.map((p) => ({ ...p, harness })),
      harnesses: { [harness]: fakeHarness(handler) },
      ...(["local", "inplace"].includes(layout) ? {} : { gateExecutor: remoteGates }),
      ...(layout === "resumed" ? { faults: { "stage:audit:after": { action: "kill" as const } } } : {}),
    });
    const controller = new AbortController();
    let executor: Promise<void> | undefined;
    if (layout === "shadow") {
      f.cfg.reviewShadow = "panel";
      for (const { id } of providers)
        f.tracker.observeWindows(id, { five_hour: { utilization: 0, resetsAt: null } });
    }
    if (layout === "inplace") {
      f.deps.gateExecutor = gateExecutorFor("local", f.workers, [], true);
      f.store.setSetting("executor.daemonRelease", "test-build");
      executor = confinementScope.run(fakeConfinement, () =>
        runInplaceExecutor(f.cfg, "test-build", controller.signal),
      );
    }
    try {
      if (layout === "resumed") await f.stop();
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "standard" });
      if (layout === "resumed") {
        expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("running");
        const state = f.store.getRunState<RunState>(run.id);
        if (!state?.worktreePath) throw new Error("Missing checkout");
        dependencyPackage(join(state.worktreePath, "node_modules/zod"), "3.0.0");
        f.deps.faults = undefined;
        expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("succeeded");
      } else {
        expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
          layout === "failure" ? "failed" : "succeeded",
        );
      }
      if (layout === "failure") {
        expect(readers).toEqual([]);
        expect(f.store.getRun(run.id)?.error).toContain("Reader setup failed");
      } else if (layout === "shadow") {
        expect(readers.filter((role) => role !== "shadow").sort()).toEqual(["review", "verify"]);
        expect(readers).toContain("shadow");
        expect(JSON.parse(f.store.getArtifact(run.id, "review-0.shadow.json") ?? "null")).toMatchObject({
          status: "completed",
        });
      } else expect(readers.sort()).toEqual(["review", "verify"]);
      expect(readFileSync(ancestor, "utf8")).toBe(before);
    } finally {
      controller.abort();
      await executor;
    }
  });
}
