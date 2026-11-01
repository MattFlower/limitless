import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Store as CurrentStore } from "../src/db/store.ts";
import { executeRun as currentExecuteRun } from "../src/pipeline/engine.ts";

// Current exports only guard provenance; all executed operations use the archived modules.
const [rootArg, home, mode, originalId] = process.argv.slice(2);
if (!rootArg || !home || !mode) throw new Error("Missing baseline driver arguments");
const root = realpathSync(rootArg);
assert.notEqual(root, realpathSync(resolve(import.meta.dir, "..")));
function moduleUrl(name: string) {
  const path = realpathSync(join(root, "src", name));
  assert(path.startsWith(`${root}${sep}`), "Module escaped the extracted baseline");
  return pathToFileURL(path).href;
}
const { Store } = (await import(moduleUrl("db/store.ts"))) as typeof import("../src/db/store.ts");
const { Factory } = (await import(moduleUrl("app.ts"))) as typeof import("../src/app.ts");
const { loadConfig } = (await import(moduleUrl("config.ts"))) as typeof import("../src/config.ts");
const { RunContext } = (await import(
  moduleUrl("pipeline/context.ts")
)) as typeof import("../src/pipeline/context.ts");
const { executeRun } = (await import(
  moduleUrl("pipeline/engine.ts")
)) as typeof import("../src/pipeline/engine.ts");
assert.notEqual(Store, CurrentStore, "Rollback must execute the archived Store");
assert.notEqual(executeRun, currentExecuteRun, "Resume must execute the archived engine");
const { fakeHarness } = (await import(
  moduleUrl("harness/fake.ts")
)) as typeof import("../src/harness/fake.ts");
const { recordWorktree } = (await import(
  moduleUrl("git/command.ts")
)) as typeof import("../src/git/command.ts");
const { sh, processBootInspection } = (await import(
  moduleUrl("util/proc.ts")
)) as typeof import("../src/util/proc.ts");
processBootInspection.enterWith(() => "test-boot");
const { gitConfinement } = (await import(
  moduleUrl("git/confinement.ts")
)) as typeof import("../src/git/confinement.ts");
gitConfinement.enterWith({ wrap: async (cmd) => cmd });
const cfg = loadConfig({ home: join(home, "data"), configDir: join(home, "cfg") });
const store = new Store(cfg.paths.db);
let calls = 0;
const factory = new Factory(cfg, {
  store,
  providers: [
    { id: "offline", label: "Offline", harness: "fake", billing: "subscription", maxConcurrent: 1 },
  ],
  models: [
    {
      id: "offline/m",
      provider: "offline",
      model: "fake",
      vendor: "anthropic",
      origin: "unknown",
      baseOrigin: "unknown",
      supportedEfforts: [],
      tier: 4,
      price: { input: 0, output: 0 },
    },
  ],
  policy: Object.fromEntries(
    [
      "triage",
      "spec",
      "plan",
      "plan_review",
      "holdout",
      "implement",
      "review",
      "verify",
      "summarize",
      "chat",
    ].map((role) => [role, { default: ["offline/m"] }]),
  ) as import("../src/router/catalog.ts").Policy,
  harnesses: {
    fake: fakeHarness(() => {
      calls++;
      return {
        structured: {
          title: "Resumed baseline",
          task_class: "feature",
          complexity: "small",
          risk: "low",
          ambiguity: "high",
          blocking_questions: ["Choose behavior"],
          summary: "Offline resume",
          suggested_profile: "standard",
        },
      };
    }),
  },
});
try {
  const repoDir = join(home, "repo");
  if (mode === "create") {
    const seed = join(home, "seed");
    mkdirSync(seed);
    writeFileSync(join(seed, "example.txt"), "baseline\n");
    await sh(["git", "init", "-q", "-b", "main", seed], { cwd: seed });
    await sh(["git", "-C", seed, "add", "."], { cwd: seed });
    await sh(
      [
        "git",
        "-C",
        seed,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "baseline",
      ],
      { cwd: seed },
    );
    await sh(["git", "worktree", "add", "-qb", "checkpoint", repoDir], { cwd: seed });
    await recordWorktree(repoDir);
  }
  const repo = store.upsertRepo({
    slug: "example/baseline",
    kind: "local",
    url: null,
    localPath: repoDir,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const newRun = store.createRun(repo, {
    repo: repo.slug,
    prompt: "Ordinary baseline run",
    profile: "standard",
  });
  const runId = mode === "create" ? newRun.id : originalId;
  assert(runId);
  if (mode === "create") {
    const ctx = new RunContext(factory.deps, newRun, repo, new AbortController().signal);
    await ctx.stage("prepare", async () => {
      Object.assign(ctx.state, {
        phase: "triage",
        worktreePath: repoDir,
        previewConfig: null,
        slottedCommands: [],
        agentFullSuite: "gate",
      });
      await ctx.save("baseline-checkpoint");
      return { summary: "Persisted baseline checkpoint", value: undefined };
    });
  } else {
    // Drain at the next stage after triage: no waiting for people, gates, network or provider calls.
    const status = await executeRun(
      factory.deps,
      runId,
      new AbortController().signal,
      () => store.getRunState<{ phase: string }>(runId)?.phase === "clarify",
    );
    assert.equal(status, "queued", store.getRun(runId)?.error ?? "Baseline resume failed");
    assert.equal(calls, 1);
  }
  console.log(
    JSON.stringify({
      origin: dirname(moduleUrl("db/store.ts")),
      runId,
      newRunId: newRun.id,
      state: store.getRunState(runId),
      stages: store.listStages(runId),
      run: store.getRun(runId),
      calls,
    }),
  );
} finally {
  await factory.stop();
  store.close();
}
