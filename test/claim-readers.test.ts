import { expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { Stage, StageName } from "../src/core/types.ts";
import type { GateComparison } from "../src/gates/run.ts";
import * as repos from "../src/git/repos.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { bindClaim, claimScope } from "../src/integrations/claim-guard.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { buildLoop } from "../src/pipeline/engine.ts";
import * as gateExecution from "../src/pipeline/gate-execution.ts";
import * as previews from "../src/pipeline/preview.ts";
import * as snapshots from "../src/pipeline/snapshots.ts";
import * as proc from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { holdout, models, pipelineSetup, policy, providers, spec } from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
pipelineSetup({
  get home() {
    return home;
  },
  set home(v) {
    home = v;
  },
  get repoDir() {
    return repoDir;
  },
  set repoDir(v) {
    repoDir = v;
  },
  get factory() {
    return factory;
  },
  set factory(v) {
    factory = v;
  },
});

async function context() {
  factory = new Factory(loadConfig({ home: join(home, "data"), configDir: join(home, "cfg") }), {
    providers,
    models,
    policy,
    confinement: fakeConfinement,
    harnesses: {},
  });
  const repo = factory.store.upsertRepo({
    slug: "fixture/repo",
    kind: "local",
    localPath: repoDir,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = factory.store.createRun(repo, { repo: repo.slug, prompt: "reader arbitration" });
  const sha = await repos.headSha(repoDir);
  const ctx = new RunContext(factory.deps, { ...run, baseSha: sha }, repo, new AbortController().signal);
  Object.assign(ctx.state, {
    phase: "loop",
    worktreePath: repoDir,
    gatesConfig: { setup: [], checks: [] },
    spec,
    holdout,
    holdoutStatus: "complete",
    previewConfig: null,
    slottedCommands: [],
    implementedRound: 0,
  });
  return ctx;
}
const failure = (kind: string) =>
  kind === "loss"
    ? new ClaimLostError()
    : kind === "wait"
      ? new ClaimWaitError("lease")
      : new Error("ordinary failure");
const pairs = ["ordinary+wait", "ordinary+loss", "wait+loss"].flatMap((pair) => [
  pair,
  pair.split("+").reverse().join("+"),
]);

test.each(["wait", "loss"])("gate worker preserves original %s through failed cleanup", async (kind) => {
  const ctx = await context();
  const error = failure(kind);
  let closed = false;
  let refusals = 0;
  const claim = bindClaim(
    {
      windowOpen: () => {
        if (closed) throw refusals++ === 0 ? error : failure(kind);
        return true;
      },
    },
    { repo: ctx.repo.slug, ref: "refs/limitless/claims/1", run: ctx.run.id, member: "m", generation: 1 },
    () => false,
  );
  const gates = spyOn(gateExecution, "runGateExecution").mockImplementation(async () => {
    closed = true;
    return { setupOk: true, setup: [], checks: [], sha: ctx.run.baseSha ?? undefined, trackedClean: true };
  });
  const cleanup = spyOn(repos, "discardChanges").mockRejectedValue(new Error("gate cleanup refused"));
  const delivery = spyOn(ctx, "setPhase");
  try {
    expect(await claimScope.run([claim], () => buildLoop(ctx)).catch((e) => e)).toBe(error);
    expect(gates).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(ctx.store.listStages(ctx.run.id).find((s) => s.name === "gates")?.status).toBe("cancelled");
    expect(ctx.store.listEvents(ctx.run.id).some((e) => e.message.includes("gate cleanup refused"))).toBe(
      true,
    );
    expect(ctx.state).toMatchObject({ phase: "loop", round: 0, roundsOnImplementer: 0 });
    expect(delivery).not.toHaveBeenCalled();
  } finally {
    gates.mockRestore();
    cleanup.mockRestore();
    delivery.mockRestore();
  }
});

// Replace only stage workers, retaining the real loop, allSettled, cleanup and head-check paths.
function workers(ctx: RunContext, run: (name: StageName) => Promise<unknown>) {
  const original = ctx.stage.bind(ctx);
  return spyOn(ctx, "stage").mockImplementation(
    async <T>(
      name: StageName,
      fn: (stage: Stage) => Promise<{ summary: string; value: T }>,
      ...rest: [number?, boolean?, boolean?, ((value: T, row: Stage, sha?: string) => void)?]
    ) => {
      if (["gates", "audit", "review", "verify", "holdout"].includes(name)) return (await run(name)) as T;
      return original(name, fn, ...rest);
    },
  );
}

test.each(pairs)("concurrent readers settle before selecting claim control and cleanup: %s", async (pair) => {
  const ctx = await context();
  ctx.state.previewConfig = { paths: ["ui/"], build: "true", serve: "unused", ready: "/", env: {} };
  const needed = spyOn(previews, "needsPreview").mockReturnValue(true);
  const stop = async () => {
    throw new Error("preview cleanup failed");
  };
  const preview = spyOn(previews, "startPreview").mockResolvedValue({
    url: "http://127.0.0.1:0",
    scratch: home,
    stop,
  });
  const errors = pair.split("+").map(failure);
  const expected =
    errors.find((e) => e instanceof ClaimLostError) ?? errors.find((e) => e instanceof ClaimWaitError);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let calls = 0;
  let settled = false;
  const stage = workers(ctx, async (name) => {
    if (name === "gates" || name === "audit") return [];
    if (++calls === 2) entered.resolve();
    await resume.promise;
    settled = true;
    throw errors[name === "review" ? 0 : 1];
  });
  const cleanup = spyOn(repos, "discardChanges").mockRejectedValue(new Error("cleanup failed"));
  const head = repos.headSha;
  const heads = spyOn(repos, "headSha").mockImplementation(async (...args) =>
    settled ? "f".repeat(40) : head(...args),
  );
  const work = buildLoop(ctx).catch((e) => e);
  try {
    await entered.promise;
    resume.resolve();
    expect(await work).toBe(expected);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(ctx.store.listEvents(ctx.run.id).some((e) => e.message.includes("preview cleanup failed"))).toBe(
      true,
    );
    expect(ctx.store.listEvents(ctx.run.id).some((e) => e.message.includes("cleanup failed"))).toBe(true);
    expect(ctx.state).toMatchObject({ phase: "loop", round: 0, roundsOnImplementer: 0 });
  } finally {
    resume.resolve();
    await work;
    stage.mockRestore();
    cleanup.mockRestore();
    heads.mockRestore();
    needed.mockRestore();
    preview.mockRestore();
  }
});

test.each(["failed+wait", "failed+loss", "ordinary+wait", "ordinary+loss", "wait+loss", "passed+loss"])(
  "foreground/holdout arbitration precedes round accounting and delivery: %s",
  async (pair) => {
    const ctx = await context();
    ctx.state.holdoutStatus = undefined;
    const [foreground, background = "loss"] = pair.split("+");
    const fgError = failure(foreground ?? "ordinary");
    const bgError = failure(background);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const foregroundDone = Promise.withResolvers<void>();
    const stage = workers(ctx, async (name) => {
      if (name === "holdout") {
        entered.resolve();
        await resume.promise;
        throw bgError;
      }
      if (name === "audit") return [];
      if (name === "gates") {
        await entered.promise;
        foregroundDone.resolve();
        if (foreground === "ordinary" || foreground === "wait") throw fgError;
        return foreground === "failed"
          ? [
              {
                name: "check",
                blocking: true,
                verdict: "regressed",
                result: {
                  name: "check",
                  ok: false,
                  command: "false",
                  output: "check failed",
                  durationMs: 0,
                  exitCode: 1,
                },
              } satisfies GateComparison,
            ]
          : [];
      }
      if (name === "review") return { verdict: "approve", summary: "ok", findings: [] };
      return { overall: "pass", criteria: [], notes: "" };
    });
    const delivery = spyOn(ctx, "setPhase");
    const work = buildLoop(ctx).catch((e) => e);
    try {
      await foregroundDone.promise;
      // Let the foreground reach its return/throw while the background is still pending.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ctx.state).toMatchObject({ phase: "loop", round: 0, roundsOnImplementer: 0 });
      resume.resolve();
      expect(await work).toBe(bgError);
      if (foreground === "failed") expect(ctx.state.feedback).toContain("Check `check` now FAILS");
      expect(ctx.state).toMatchObject({ phase: "loop", round: 0, roundsOnImplementer: 0 });
      expect(delivery).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await work;
      stage.mockRestore();
      delivery.mockRestore();
    }
  },
);

test("holdout interruption survives failure of snapshot cleanup", async () => {
  const ctx = await context();
  ctx.state.holdoutStatus = undefined;
  const error = new ClaimLostError();
  const entered = Promise.withResolvers<void>();
  let interrupted = false;
  const snapshot = mkdtempSync(join(tmpdir(), "claim-snapshot-"));
  const parent = spyOn(snapshots, "createSnapshotParent").mockReturnValue(snapshot);
  ctx.deps.harnesses.fake = fakeHarness(() => {
    throw new Error("unexpected harness dispatch");
  });
  ctx.deps.agentExecutor = {
    kind: "fake",
    run: async () => {
      interrupted = true;
      entered.resolve();
      throw error;
    },
  };
  const stopped = proc.assertProcessesStopped;
  const cleanup = spyOn(proc, "assertProcessesStopped").mockImplementation(() => {
    if (interrupted) throw new Error("snapshot cleanup refused");
    stopped();
  });
  const original = ctx.stage.bind(ctx);
  const stage = spyOn(ctx, "stage").mockImplementation(
    async <T>(
      name: StageName,
      fn: (row: Stage) => Promise<{ summary: string; value: T }>,
      ...rest: [number?, boolean?, boolean?, ((value: T, row: Stage, sha?: string) => void)?]
    ) => {
      if (name === "gates") {
        await entered.promise;
        throw new Error("foreground failed");
      }
      return original(name, fn, ...rest);
    },
  );
  try {
    expect(await buildLoop(ctx).catch((e) => e)).toBe(error);
    expect(ctx.store.listEvents(ctx.run.id).some((e) => e.message.includes("snapshot cleanup refused"))).toBe(
      true,
    );
    expect(ctx.state).toMatchObject({ phase: "loop", round: 0, roundsOnImplementer: 0 });
  } finally {
    stage.mockRestore();
    cleanup.mockRestore();
    parent.mockRestore();
    rmSync(snapshot, { recursive: true, force: true });
  }
});
