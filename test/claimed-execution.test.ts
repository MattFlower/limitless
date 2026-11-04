import { afterEach, expect, mock, spyOn } from "bun:test";
import * as subprocess from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import type { Run } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { githubWait } from "../src/git/github-wait.ts";
import * as merges from "../src/git/merge.ts";
import * as repos from "../src/git/repos.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { bindClaim, claimGuard, claimScope } from "../src/integrations/claim-guard.ts";
import { type GhRunner, runGh } from "../src/integrations/github.ts";
import * as identity from "../src/integrations/github-identity.ts";
import { startGitHubNotifier } from "../src/integrations/github-notifier.ts";
import { reconcileIssueLifecycle } from "../src/integrations/issue-lifecycle.ts";
import type { Capabilities } from "../src/integrations/member-capabilities.ts";
import { CAPABILITY_FRESH_MS } from "../src/integrations/member-capabilities.ts";
import { type CapabilityGate, createCapabilityGate } from "../src/integrations/member-eligibility.ts";
import type { AgentCall } from "../src/pipeline/agent-executor.ts";
import {
  CancelledError,
  initialRunState,
  localCheckpointer,
  RunContext,
  type RunState,
} from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { lanAgentExecutor } from "../src/pipeline/lan-agent.ts";
import { bindRunClaim, type RunClaim } from "../src/pipeline/run-claim.ts";
import { windowOpen } from "../src/util/claim-clock.ts";
import * as proc from "../src/util/proc.ts";
import { approve, pipelineSetup, roleOf, triage } from "./pipeline-support.ts";
import { postMergeWorkerFixture } from "./post-merge-worker-support.ts";
import { test } from "./read-policy-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start, registerGithub, githubFixture, advanceBase } = pipelineSetup({
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
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function shared(f: Factory, enabled = true) {
  f.cfg.repos = {
    "test/repo": { shared: enabled, discreet: false, branchPrefix: "change/", landRequiresApproval: false },
  };
}
function authority(run: Run) {
  let open = true;
  const binding = bindClaim(
    { windowOpen: () => open },
    {
      repo: run.repoSlug,
      ref: `refs/limitless/claims/${run.sourceRef?.kind === "issue" ? run.sourceRef.number : `run-${run.id}`}`,
      run: run.id,
      member: "m",
      generation: 1,
    },
    () => false,
  );
  const update = mock<RunClaim["leases"]["update"]>(async () => "applied");
  return {
    binding,
    leases: { update },
    update,
    close: () => {
      open = false;
    },
    open: () => {
      open = true;
    },
  };
}
function passingGate() {
  return {
    admit: mock(async () => []),
    canContinue: mock<CapabilityGate["canContinue"]>(async () => []),
    capableNow: mock(() => true),
    forget: mock<CapabilityGate["forget"]>(() => {}),
  };
}
const signal = () => new AbortController().signal;
async function fixture(publication = false) {
  const bare = publication ? await githubFixture() : "unused";
  const f = start((s) =>
    roleOf(s) === "triage"
      ? { structured: triage({ suggested_profile: "quick" }) }
      : roleOf(s) === "review"
        ? { structured: approve }
        : { files: { "farewell.txt": "goodbye\n" } },
  );
  await f.stop();
  f.deps.capability = passingGate();
  registerGithub(f, bare);
  shared(f);
  const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
  return { f, run, claim: authority(run) };
}
function noSpawn() {
  const spawn = spyOn(subprocess, "spawn").mockImplementation(() => {
    throw new Error("unexpected publication spawn");
  });
  restores.push(() => spawn.mockRestore());
  return spawn;
}
// Real dispatch wrapper: the scope must still guard after inner identity resolution.
async function dispatch(close: () => void) {
  const resolver = spyOn(identity, "githubIdentity").mockImplementation(async () => {
    close();
    return { kind: "owner" };
  });
  try {
    await runGh(["api", "repos/test/repo"]);
  } finally {
    resolver.mockRestore();
  }
}

// Mutations: trust persisted authority or accept applied renewal without a current admission guard.
test.each(["missing", "mismatch", "closed"])("admission queues %s before startup or stages", async (kind) => {
  const { f, run, claim } = await fixture();
  if (kind === "mismatch")
    claim.binding = bindClaim(
      { windowOpen: () => true },
      { ...claim.binding.handle, run: "other" },
      () => false,
    );
  if (kind === "closed") claim.close();
  const writes = spyOn(f.store, "updateRun");
  const spawn = noSpawn();
  expect(
    await executeRun({ ...f.deps, runClaim: kind === "missing" ? undefined : claim }, run.id, signal()),
  ).toBe("queued");
  expect(f.store.getRun(run.id)).toMatchObject({ status: "queued", startedAt: null, finishedAt: null });
  expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe(
    `claim:${kind === "closed" ? "lease" : "unavailable"}`,
  );
  expect(writes.mock.calls.some(([, patch]) => patch.status === "running")).toBe(false);
  expect(f.store.listStages(run.id)).toHaveLength(0);
  expect(f.store.listInvocations(run.id)).toHaveLength(0);
  expect(claim.update).toHaveBeenCalledTimes(kind === "closed" ? 1 : 0);
  expect(spawn).not.toHaveBeenCalled();
  writes.mockRestore();
});

// Mutations: renew after startup writes, or skip renewal on restart.
test("deferred renewal blocks startup and a restart renews again", async () => {
  const { f, run, claim } = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<"applied">();
  claim.update.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  const deps = {
    ...f.deps,
    runClaim: claim,
    faults: { "stage:prepare:before": { action: "kill" as const } },
  };
  const work = executeRun(deps, run.id, signal());
  await entered.promise;
  expect(f.store.getRun(run.id)).toMatchObject({ status: "queued", startedAt: null });
  expect(f.store.listStages(run.id)).toHaveLength(0);
  release.resolve("applied");
  expect(await work).toBe("running");
  const reopened = new Store(f.cfg.paths.db);
  try {
    claim.close();
    expect(await executeRun({ ...deps, store: reopened }, run.id, signal())).toBe("queued");
    expect(claim.update).toHaveBeenCalledTimes(2);
    expect(reopened.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:lease");
  } finally {
    reopened.close();
  }
});

// Mutation: install the caller binding instead of the engine-owned durable cancellation probe.
test.each(["identity", "recovery"])(
  "durable cancellation during %s wins with an open claim",
  async (boundary) => {
    const { f, run, claim } = await fixture();
    const cancel = () =>
      f.store.updateRun(run.id, { status: "cancelled", error: "cancelled by owner", finishedAt: 73 });
    const spawn = noSpawn();
    if (boundary === "identity") {
      const prepare = spyOn(repos, "ensureCache").mockImplementation(async () => {
        await dispatch(cancel);
        return "unused";
      });
      restores.push(() => prepare.mockRestore());
    } else {
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const recover = spyOn(proc, "recoverScopedProcesses").mockImplementation(async () => {
        entered.resolve();
        await resume.promise;
      });
      restores.push(() => recover.mockRestore());
      const work = executeRun({ ...f.deps, runClaim: claim }, run.id, signal());
      await entered.promise;
      cancel();
      resume.resolve();
      expect(await work).toBe("cancelled");
    }
    if (boundary === "identity")
      expect(await executeRun({ ...f.deps, runClaim: claim }, run.id, signal())).toBe("cancelled");
    const before = f.store.getRun(run.id);
    expect(before).toMatchObject({ status: "cancelled", error: "cancelled by owner", finishedAt: 73 });
    expect(await executeRun({ ...f.deps, runClaim: claim }, run.id, signal())).toBe("cancelled");
    expect(f.store.getRun(run.id)).toEqual(before);
    expect(spawn).not.toHaveBeenCalled();
  },
);

// Mutations: map only delivery waits, clear them in save, or apply the ordinary outage deadline.
test.each(["prepare", "triage", "deliver"] as const)(
  "%s dispatch wait preserves durable work beyond outage budget",
  async (phase) => {
    const { f, run, claim } = await fixture(true);
    let interrupt = true;
    const hook = async () => {
      if (interrupt) {
        interrupt = false;
        await dispatch(claim.close);
      }
    };
    const reposCache = repos.ensureCache;
    const createPr = repos.createPullRequest;
    const transport =
      phase === "triage"
        ? undefined
        : phase === "prepare"
          ? spyOn(repos, "ensureCache").mockImplementation(async (...args) => {
              await hook();
              return reposCache(...args);
            })
          : spyOn(repos, "createPullRequest").mockImplementation(async (...args) => {
              await hook();
              return createPr(...args);
            });
    if (transport) restores.push(() => transport.mockRestore());
    if (phase === "triage") f.deps.faults = { "harness:invoke": { action: "continue", onHit: claim.close } };
    // For invocation interruption, the harness's own guard is the dispatch hook.
    const deps = { ...f.deps, runClaim: claim };
    expect(await executeRun(deps, run.id, signal())).toBe("queued");
    const state = f.store.getRunState<RunState>(run.id);
    expect(state?.phase).toBe(phase);
    expect(state?.githubWait?.reason).toBe("claim:lease");
    expect(f.store.listEvents(run.id).some((e) => /^Run (failed|needs a human):/.test(e.message))).toBe(
      false,
    );
    const attempts = f.store.listInvocations(run.id);
    if (phase === "triage")
      expect(attempts).toMatchObject([
        { status: "cancelled", error: "interrupted: claim wait", outputTokens: 0 },
      ]);
    if (!state?.githubWait) throw new Error("Missing durable claim wait");
    const repo = f.store.getRepo(run.repoId);
    if (!repo) throw new Error("Missing repo");
    const ctx = new RunContext(deps, f.store.getRun(run.id) ?? run, repo, signal());
    await ctx.save();
    expect(f.store.getRunState<RunState>(run.id)?.githubWait).toEqual(state.githubWait);
    const now = state.githubWait.since + githubWait.maxMs + githubWait.intervalMs * 2;
    state.githubWait = { ...state.githubWait, nextAttemptAt: now };
    f.store.setRunState(run.id, state);
    const reopened = new Store(f.cfg.paths.db);
    try {
      expect(reopened.nextQueuedRuns(10, now - 1)).toHaveLength(0);
      expect(reopened.nextQueuedRuns(10, now).map((r) => r.id)).toEqual([run.id]);
      const clock = spyOn(Date, "now").mockReturnValue(now);
      try {
        expect(await executeRun({ ...deps, store: reopened }, run.id, signal())).toBe("queued");
        expect(reopened.getRunState<RunState>(run.id)).toEqual({
          ...state,
          githubWait: { ...state.githubWait, nextAttemptAt: now + githubWait.intervalMs },
        });
        expect(reopened.listInvocations(run.id)).toEqual(attempts);
        clock.mockReturnValue(now + githubWait.intervalMs);
        claim.open();
        expect(await executeRun({ ...deps, store: reopened, faults: undefined }, run.id, signal())).toBe(
          "succeeded",
        );
      } finally {
        clock.mockRestore();
      }
      expect(reopened.getRunState<RunState>(run.id)?.githubWait).toBeUndefined();
      expect(claim.update).toHaveBeenCalledTimes(3);
      expect(reopened.listInvocations(run.id).slice(0, attempts.length)).toEqual(attempts);
      if (phase === "deliver")
        expect(reopened.getRunState<RunState>(run.id)?.gateEvidence).toEqual(state.gateEvidence);
    } finally {
      reopened.close();
    }
  },
);

test.each([false, true])(
  "auto delivery captures shared=%s and preserves older local resume",
  async (claimed) => {
    const { f, run, claim } = await fixture(true);
    shared(f, claimed);
    const repo = f.store.getRepo(run.repoId);
    if (!repo) throw new Error("Missing repo");
    f.store.upsertRepo({ ...repo, mergePolicy: "auto" });
    const merge = spyOn(repos, "mergePullRequest").mockResolvedValue("merged");
    restores.push(() => merge.mockRestore());
    const deps = { ...f.deps, faults: { "stage:deliver:before": { action: "kill" as const } } };
    expect(await executeRun(claimed ? { ...deps, runClaim: claim } : deps, run.id, signal())).toBe("running");
    const checkpoints: (string | undefined)[] = [];
    const checkpointer = {
      ...localCheckpointer(f.store),
      checkpoint: (_id: string, label?: string) => {
        checkpoints.push(label);
      },
    };
    claim.update.mockImplementation(async () => {
      shared(f, false);
      return "applied";
    });
    const resume = { ...f.deps, faults: undefined, checkpointer };
    if (!claimed)
      Object.defineProperty(resume, "runClaim", {
        get() {
          throw new Error("local authority must not be read");
        },
      });
    expect(await executeRun(claimed ? { ...resume, runClaim: claim } : resume, run.id, signal())).toBe(
      "succeeded",
    );
    expect(merge).toHaveBeenCalledTimes(claimed ? 0 : 1);
    expect(f.store.getRun(run.id)).toMatchObject({
      prUrl: expect.stringContaining("/pull/1"),
      merged: !claimed,
    });
    expect(f.store.getRunState<RunState>(run.id)?.deliveryComplete).toBe(true);
    expect(checkpoints).toEqual(
      expect.arrayContaining(["delivery-pushed", "delivery-pr-created", "delivery-complete"]),
    );
    if (claimed) expect(f.store.listStages(run.id).at(-1)?.summary).toContain("left open");
  },
);

// Mutations: restore either original nested draft catch.
test.each(
  [false, true].flatMap((verified) =>
    ["wait", "lost", "cancelled", "cancelled-wait"].map((kind) => ({ verified, kind })),
  ),
)("nested draft maps interruption %o", async ({ verified, kind }) => {
  const lost = kind === "lost";
  const cancelled = kind.startsWith("cancelled");
  const controller = new AbortController();
  const { f, run, claim } = await fixture(true);
  const first = {
    ...f.deps,
    runClaim: claim,
    faults: { "stage:deliver:before": { action: "kill" as const } },
  };
  expect(await executeRun(first, run.id, signal())).toBe("running");
  const state = f.store.getRunState<RunState>(run.id);
  if (!state) throw new Error("Missing delivery state");
  if (!verified) {
    state.lastVerifiedSha = undefined;
    state.phase = "loop";
  }
  state.needsHumanReason = "report unfinished work";
  f.store.setRunState(run.id, state);
  const create = spyOn(repos, "createPullRequest").mockImplementation(async () => {
    if (cancelled) {
      claim.close();
      controller.abort();
      throw kind === "cancelled-wait" ? new ClaimWaitError("capability") : new CancelledError();
    }
    // A running record from an interrupted sibling must be closed without a model result.
    f.store.createInvocation({
      runId: run.id,
      stageId: null,
      role: "implement",
      harness: "fake",
      provider: "alpha",
      model: "m",
      modelId: "alpha/m",
    });
    if (lost) {
      claim.binding.onLost(claim.binding.handle, null);
      throw new ClaimLostError();
    }
    throw new ClaimWaitError("lease");
  });
  restores.push(() => create.mockRestore());
  expect(await executeRun({ ...f.deps, runClaim: claim }, run.id, controller.signal)).toBe(
    kind === "wait" ? "queued" : "cancelled",
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(f.store.listEvents(run.id).some((e) => /^Could not open .*draft PR:/.test(e.message))).toBe(false);
  expect(f.store.getRun(run.id)).toMatchObject({ error: lost ? "superseded: claim lost" : null });
  expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe(
    kind === "wait" ? "claim:lease" : undefined,
  );
  if (cancelled) {
    expect(f.store.getRun(run.id)).toMatchObject({ status: "cancelled", finishedAt: expect.any(Number) });
    return;
  }
  expect(f.store.listInvocations(run.id).at(-1)).toMatchObject({
    status: "cancelled",
    error: `interrupted: claim ${lost ? "lost" : "wait"}`,
    outputTokens: 0,
  });
});

// Mutations: write provisional terminal rejection, allow stale writes after a terminal decision,
// finalize failed cleanup, or leave failed or shut-down cleanup running after the execution exits.
test.each(
  ["rollback", "report"].flatMap((boundary) =>
    ([undefined, "shutdown", "error", "needs_human", "cancelled", "resolved"] as const).map((decision) => ({
      boundary,
      decision,
    })),
  ),
)("claimed rejected merge resumes or preserves independent decision %o", async ({ boundary, decision }) => {
  const bare = await githubFixture();
  const f = start(async (s) => {
    if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
    if (roleOf(s) === "review") {
      await advanceBase(bare, "base.txt", "new base\n");
      return { structured: approve };
    }
    return { files: { "farewell.txt": "goodbye\n" } };
  });
  await f.stop();
  f.deps.capability = passingGate();
  registerGithub(f, bare);
  shared(f);
  const workers = postMergeWorkerFixture(f, "fail");
  restores.push(() => workers.processSpy.mockRestore());
  const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
  const claim = authority(run);
  const controller = new AbortController();
  let recorded: Run | null = null;
  let recordedState: RunState | null = null;
  const interrupted = async () => {
    expect(f.store.getRun(run.id)).toMatchObject({ status: "running", finishedAt: null });
    if (decision === "needs_human" || decision === "cancelled" || decision === "resolved") {
      // Yield while another actor durably records a terminal decision and its own evidence.
      await Promise.resolve();
      recordedState = {
        ...(f.store.getRunState<RunState>(run.id) ?? initialRunState(run)),
        feedback: "independent evidence",
      };
      recorded = f.store.updateRun(
        run.id,
        { status: decision, error: "independent decision", finishedAt: 73 },
        recordedState,
      );
    }
    if (!decision) throw new ClaimWaitError("lease");
    if (decision === "shutdown") controller.abort(new Error("shutdown"));
    if (decision === "shutdown" || decision === "error") throw new Error("cleanup failed");
  };
  const reset = merges.mergeGit;
  const rollback = spyOn(merges, "mergeGit").mockImplementation(async (...args) => {
    const state = f.store.getRunState<RunState>(run.id);
    if (boundary === "rollback" && args[1][0] === "reset" && state?.postMergeRejection) {
      await interrupted();
    }
    return reset(...args);
  });
  const create = repos.createPullRequest;
  const report = spyOn(repos, "createPullRequest").mockImplementation(async (...args) => {
    if (boundary === "report") {
      await interrupted();
      return "https://github.com/test/repo/pull/1";
    }
    return create(...args);
  });
  restores.push(
    () => rollback.mockRestore(),
    () => report.mockRestore(),
  );
  const pending = !decision || decision === "shutdown" || decision === "error";
  const before = Date.now();
  expect(await executeRun({ ...f.deps, runClaim: claim }, run.id, controller.signal)).toBe(
    pending ? "queued" : decision,
  );
  const state = f.store.getRunState<RunState>(run.id);
  expect(state?.postMergeRejection?.reason).toContain("post-merge gates regressed");
  if (pending) {
    // Failed cleanup stays owed, with a delayed retry instead of a terminal or stranded run.
    expect(state?.githubWait?.reason).toBe(
      { shutdown: undefined, error: "rejected merge cleanup pending" }[decision ?? "shutdown"] ??
        (decision ? undefined : "claim:lease"),
    );
    if (state?.githubWait) expect(state.githubWait.nextAttemptAt).toBeGreaterThan(before);
    expect(f.store.getRun(run.id)).toMatchObject({ status: "queued", stage: null, finishedAt: null });
    expect(state?.needsHumanReason).toBe(state?.postMergeRejection?.reason);
  } else {
    expect(f.store.getRun(run.id)).toEqual(recorded);
    expect(state).toEqual(recordedState);
  }
  rollback.mockRestore();
  report.mockRestore();
  const reopened = new Store(f.cfg.paths.db);
  // Resumed cleanup is visibly running rather than still queued.
  const resumed: (string | undefined)[] = [];
  const observe = spyOn(merges, "mergeGit").mockImplementation(async (...args) => {
    if (args[1][0] === "reset") resumed.push(reopened.getRun(run.id)?.status);
    return reset(...args);
  });
  restores.push(() => observe.mockRestore());
  try {
    expect(await executeRun({ ...f.deps, store: reopened, runClaim: claim }, run.id, signal())).toBe(
      pending ? "needs_human" : decision,
    );
    expect(resumed[0]).toBe(pending ? "running" : undefined);
    if (!pending) {
      expect(reopened.getRun(run.id)).toEqual(recorded);
      expect(reopened.getRunState<RunState>(run.id)).toEqual(recordedState);
      return;
    }
    expect(claim.update).toHaveBeenCalledTimes(2);
    expect(reopened.getRunState<RunState>(run.id)?.postMergeRejection).toEqual(state?.postMergeRejection);
    expect(reopened.getRun(run.id)?.error).toBe(state?.postMergeRejection?.reason.slice(0, 2000));
    expect(reopened.getRunState<RunState>(run.id)?.deliveryComplete).toBe(true);
    expect(reopened.getRunState<RunState>(run.id)?.githubWait).toBeUndefined();
  } finally {
    reopened.close();
  }
});

// Mutation: omit the pre-invocation slot disposer.
test("interruption after provider preflight restores capacity without creating an invocation", async () => {
  const { f, run, claim } = await fixture();
  f.store.setRunState(run.id, {
    ...initialRunState(run),
    phase: "triage",
    previewConfig: null,
    slottedCommands: [],
    agentFullSuite: "slot",
  });
  const preflight = spyOn(f.tracker, "preflight").mockImplementation(async () => {
    claim.close();
    return true;
  });
  restores.push(() => preflight.mockRestore());
  expect(await executeRun({ ...f.deps, runClaim: claim }, run.id, signal())).toBe("queued");
  expect(preflight).toHaveBeenCalledTimes(1);
  expect(f.store.listInvocations(run.id)).toHaveLength(0);
  const release = f.tracker.tryAcquire("alpha", () => {});
  expect(release).toBeFunction();
  release?.();
});

// Mutations: bypass loss projection, remove consumer exclusions, or omit the final observer guard.
test("engine loss suppresses attached and reopened consumers, including inner identity dispatch", async () => {
  const { f } = await fixture();
  f.cfg.githubQueue = { repos: ["test/repo"], trusted: ["owner"], maxIssueRuns: 1, pollSeconds: 60 };
  const repo = f.store.getRepoBySlug("test/repo");
  if (!repo) throw new Error("Missing repo");
  const run = f.store.createRun(repo, {
    repo: repo.slug,
    prompt: "work",
    source: "github",
    sourceRef: { kind: "issue", repo: repo.slug, number: 7 },
  });
  const claim = authority(run);
  claim.update.mockResolvedValue("lost");
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const resolver = spyOn(identity, "githubIdentity").mockImplementation(async () => {
    entered.resolve();
    await resume.promise;
    return { kind: "owner" };
  });
  restores.push(() => resolver.mockRestore());
  const spawn = noSpawn();
  let request: ReturnType<GhRunner> | undefined;
  let notifications = 0;
  const stop = startGitHubNotifier(
    f.store,
    (...args) => {
      notifications++;
      request = runGh(...args);
      return request;
    },
    () => {},
    async () => null,
    f.cfg.paths.configDir,
    [],
    {},
  );
  f.store.updateRun(run.id, { status: "queued" });
  await entered.promise;
  try {
    expect(await executeRun({ ...f.deps, runClaim: claim }, run.id, signal())).toBe("cancelled");
    expect(f.store.getRun(run.id)).toMatchObject({ status: "cancelled", error: "superseded: claim lost" });
    expect(notifications).toBe(1);
    const receipts = f.store.issueLifecycleEffects(run.id, repo.slug, 7);
    resume.resolve();
    await request?.catch(() => {});
    await stop();
    const reopened = new Store(f.cfg.paths.db);
    try {
      const calls: string[][] = [];
      const gh: GhRunner = async (args, _signal, _stdin, _repo, guard) => {
        guard?.();
        calls.push(args);
        return "[]";
      };
      await reconcileIssueLifecycle(reopened, f.cfg, gh, signal(), () => {}, {
        identity: async () => ({ kind: "app", token: "fake", botLogin: "factory[bot]" }),
      });
      expect(calls).toEqual([]);
      expect(reopened.nextQueuedRuns(10, Number.MAX_SAFE_INTEGER).some((r) => r.id === run.id)).toBe(false);
      expect(reopened.issueLifecycleEffects(run.id, repo.slug, 7)).toEqual(receipts);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      reopened.close();
    }
  } finally {
    resume.resolve();
    await stop();
  }
});

// Mutation: turn claim control into a model failure, leaving resources or a fallback invocation.
test.each([false, true])(
  "dispatched invocation interruption cleans up without usage, loss=%s",
  async (lost) => {
    const { f, run, claim } = await fixture();
    f.store.setRunState(run.id, {
      ...initialRunState(run),
      phase: "triage",
      previewConfig: null,
      slottedCommands: [],
      agentFullSuite: "slot",
    });
    let cleanup = 0;
    const harness = fakeHarness(async () => {
      try {
        if (lost) {
          claim.binding.onLost(claim.binding.handle, null);
          throw new ClaimLostError();
        }
        claim.close();
        throw new ClaimWaitError("lease");
      } finally {
        cleanup++;
      }
    });
    expect(
      await executeRun({ ...f.deps, runClaim: claim, harnesses: { fake: harness } }, run.id, signal()),
    ).toBe(lost ? "cancelled" : "queued");
    expect(cleanup).toBe(1);
    expect(f.store.listInvocations(run.id)).toMatchObject([
      {
        status: "cancelled",
        error: `interrupted: claim ${lost ? "lost" : "wait"}`,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        numTurns: 0,
      },
    ]);
    expect(f.store.getRun(run.id)).toMatchObject({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
    const release = f.tracker.tryAcquire("alpha", () => {});
    expect(release).toBeFunction();
    release?.();
  },
);

// Mutation: return for a recorded terminal decision before closing running invocations.
test.each(["cancelled", "needs_human"] as const)(
  "invocation interruption preserves recorded %s and closes its invocation",
  async (status) => {
    const { f, run, claim } = await fixture();
    f.store.setRunState(run.id, {
      ...initialRunState(run),
      phase: "triage",
      previewConfig: null,
      slottedCommands: [],
      agentFullSuite: "slot",
      lastVerifiedSha: "durable evidence",
    });
    let recorded: Run | null = null;
    let evidence: RunState | null = null;
    const harness = fakeHarness(async () => {
      recorded = f.store.updateRun(run.id, {
        status,
        error: status === "cancelled" ? "cancelled by owner" : "independent decision",
        finishedAt: 73,
      });
      evidence = f.store.getRunState<RunState>(run.id);
      claimGuard();
      throw new Error("claim guard admitted a terminal run");
    });
    expect(
      await executeRun({ ...f.deps, runClaim: claim, harnesses: { fake: harness } }, run.id, signal()),
    ).toBe(status);
    expect(recorded).not.toBeNull();
    expect(f.store.getRun(run.id)).toEqual(recorded);
    expect(f.store.getRunState<RunState>(run.id)).toEqual(evidence);
    expect(f.store.listInvocations(run.id)).toMatchObject([
      {
        status: "cancelled",
        error: "interrupted: claim wait",
        finishedAt: expect.any(Number),
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        numTurns: 0,
      },
    ]);
  },
);

// Mutation: move local startup back into the main failure handler.
test.each([false, true])("local startup write failure propagates, aborted=%s", async (aborted) => {
  const { f, run } = await fixture();
  shared(f, false);
  const controller = new AbortController();
  if (aborted) controller.abort();
  const failure = new Error("startup write failed");
  const checkpointer = localCheckpointer(f.store);
  const write = spyOn(checkpointer, "writeRun").mockImplementationOnce(() => {
    throw failure;
  });
  const recovery = spyOn(proc, "recoverScopedProcesses").mockImplementation(() => {});
  restores.push(() => recovery.mockRestore());
  await expect(executeRun({ ...f.deps, checkpointer }, run.id, controller.signal)).rejects.toBe(failure);
  expect(write).toHaveBeenCalledTimes(1);
  expect(f.store.getRun(run.id)).toEqual(run);
  expect(recovery).not.toHaveBeenCalled();
  expect(f.store.listStages(run.id)).toHaveLength(0);
  expect(f.store.listInvocations(run.id)).toHaveLength(0);
});

// Mutation: let claim control from a failure-handling write escape executeRun.
test("claim change during failure handling returns through the final boundary", async () => {
  const { f, run, claim } = await fixture();
  f.store.setRunState(run.id, {
    ...initialRunState(run),
    phase: "triage",
    previewConfig: null,
    slottedCommands: [],
    agentFullSuite: "slot",
  });
  const add = f.store.addEvent.bind(f.store);
  const events = spyOn(f.store, "addEvent").mockImplementation((event) => {
    if (event.message.startsWith("Run failed:")) claim.close();
    return add(event);
  });
  restores.push(() => events.mockRestore());
  expect(
    await executeRun(
      {
        ...f.deps,
        runClaim: claim,
        faults: {
          "stage:triage:before": {
            action: "continue",
            onHit: () => {
              throw new Error("stage failure");
            },
          },
        },
      },
      run.id,
      signal(),
    ),
  ).toBe("queued");
  expect(f.store.getRun(run.id)?.error).toBeNull();
  expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:lease");
});

// Mutation: move local startup bookkeeping after process recovery.
test("local execution retains startup ordering before owned-process recovery", async () => {
  const { f, run } = await fixture();
  shared(f, false);
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const recovery = spyOn(proc, "recoverScopedProcesses").mockImplementation(async () => {
    entered.resolve();
    await resume.promise;
  });
  restores.push(() => recovery.mockRestore());
  const work = executeRun(
    { ...f.deps, faults: { "stage:prepare:before": { action: "kill" } } },
    run.id,
    signal(),
  );
  await entered.promise;
  try {
    expect(f.store.getRun(run.id)).toMatchObject({ status: "running", startedAt: expect.any(Number) });
  } finally {
    resume.resolve();
  }
  expect(await work).toBe("running");
});

test.each(["resume", "prepare", "missing", "throw"])("capability refuses %s before any stage", async (at) => {
  const { f, run, claim } = await fixture();
  const gate = passingGate();
  let calls = 0;
  gate.canContinue.mockImplementation(async () => {
    if (at === "prepare" && calls++ === 0) return [];
    if (at === "throw") throw new Error("private probe detail");
    return ["login"];
  });
  expect(
    await executeRun(
      { ...f.deps, runClaim: claim, capability: at === "missing" ? undefined : gate },
      run.id,
      signal(),
    ),
  ).toBe("queued");
  expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:capability");
  expect(f.store.listStages(run.id)).toHaveLength(0);
  expect(f.store.listInvocations(run.id)).toHaveLength(0);
  expect(claim.update).toHaveBeenCalledTimes(at === "prepare" ? 1 : 0);
  if (at !== "missing") expect(gate.forget.mock.calls).toEqual([[run.id]]);
  expect(JSON.stringify(f.store.listEvents(run.id))).not.toContain("private probe detail");
});

// Mutation: forget only after a claim binds, leaking admission memos on early exits.
test.each(["cancelled", "unbound", "invalid"])("shared %s exit forgets the capability memo", async (exit) => {
  const { f, run, claim } = await fixture();
  if (exit === "cancelled")
    f.store.updateRun(run.id, { status: "cancelled", error: "cancelled by user", finishedAt: 1 });
  if (exit === "invalid")
    claim.binding = bindClaim(
      { windowOpen: () => true },
      { ...claim.binding.handle, run: "other" },
      () => false,
    );
  const gate = passingGate();
  const runClaim = exit === "unbound" ? undefined : claim;
  const status = await executeRun({ ...f.deps, runClaim, capability: gate }, run.id, signal());
  expect(status).toBe(exit === "cancelled" ? "cancelled" : "queued");
  expect(gate.forget.mock.calls).toEqual([[run.id]]);
});

test("restarted capability wait checks before renewing a closed window", async () => {
  const { f, run, claim } = await fixture(true);
  const { gate } = continuationGate(f);
  const check = spyOn(gate, "canContinue").mockResolvedValueOnce(["login"]);
  const forget = spyOn(gate, "forget");
  restores.push(
    () => check.mockRestore(),
    () => forget.mockRestore(),
  );
  claim.close();
  const deps = { ...f.deps, runClaim: claim, capability: gate };
  expect(await executeRun(deps, run.id, signal())).toBe("queued");
  expect(claim.update).not.toHaveBeenCalled();
  const reopened = new Store(f.cfg.paths.db);
  try {
    claim.update.mockImplementation(async () => {
      claim.open();
      return "applied";
    });
    const status = await executeRun({ ...deps, store: reopened }, run.id, signal());
    expect(reopened.getRun(run.id)?.error).toBeNull();
    expect(status).toBe("succeeded");
    expect(claim.update).toHaveBeenCalledTimes(1);
    expect(reopened.listStages(run.id).some((s) => s.name === "implement")).toBe(true);
    expect(forget).toHaveBeenCalledTimes(2);
  } finally {
    reopened.close();
  }
});

test("capability refusal precedes implement bookkeeping and invocation", async () => {
  const { f, run, claim } = await fixture(true);
  const gate = passingGate();
  gate.canContinue.mockImplementation(async (task) => (task.phase === "loop" ? ["os"] : []));
  expect(await executeRun({ ...f.deps, runClaim: claim, capability: gate }, run.id, signal())).toBe("queued");
  expect(f.store.listStages(run.id).map((s) => s.name)).toEqual(["prepare", "triage"]);
  expect(f.store.listInvocations(run.id).map((i) => i.role)).toEqual(["triage"]);
  expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:capability");
});

test("capability loss leaves checkpoint and cancellation probes available", async () => {
  const { f, run, claim } = await fixture();
  const gate = passingGate();
  gate.capableNow.mockReturnValue(false);
  const repo = f.store.getRepo(run.repoId);
  if (!repo) throw new Error("missing repo");
  const bound = bindRunClaim(run, f.store, claim, gate);
  const ctx = new RunContext({ ...f.deps, capability: gate }, run, repo, signal(), undefined, undefined, {
    shared: true,
    claim: bound,
  });
  ctx.state.githubWait = { reason: "claim:capability", since: 1, nextAttemptAt: 2 };
  await claimScope.run([bound.binding], async () => {
    ctx.checkCancelled();
    ctx.checkpointer.writeRun(run.id, { status: "queued" });
    await ctx.save();
  });
  expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:capability");
  expect(gate.capableNow).not.toHaveBeenCalled();
});

test.each([true, false])(
  "cancellation during an awaited capability refusal wins, lease open=%s",
  async (open) => {
    const { f, run, claim } = await fixture();
    if (!open) claim.close();
    f.store.setRunState(run.id, {
      ...initialRunState(run),
      githubWait: { reason: "claim:capability", since: 1, nextAttemptAt: 2 },
    });
    const gate = passingGate();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Awaited<ReturnType<CapabilityGate["canContinue"]>>>();
    gate.canContinue.mockImplementation(() => {
      entered.resolve();
      return release.promise;
    });
    const controller = new AbortController();
    const work = executeRun({ ...f.deps, runClaim: claim, capability: gate }, run.id, controller.signal);
    await entered.promise;
    controller.abort();
    release.resolve(["os"]);
    expect(await work).toBe("cancelled");
    expect(f.store.getRun(run.id)).toMatchObject({ status: "cancelled", finishedAt: expect.any(Number) });
    expect(f.store.getRunState<RunState>(run.id)?.githubWait).toBeUndefined();
    expect(claim.update).not.toHaveBeenCalled();
  },
);

test("capability claim-control errors keep their identity", async () => {
  const { f, run, claim } = await fixture();
  const repo = f.store.getRepo(run.repoId);
  if (!repo) throw new Error("missing repo");
  const gate = passingGate();
  const ctx = new RunContext({ ...f.deps, capability: gate }, run, repo, signal(), undefined, undefined, {
    shared: true,
    claim,
  });
  for (const error of [new ClaimLostError(), new ClaimWaitError("lease")]) {
    gate.canContinue.mockRejectedValue(error);
    expect(await ctx.requireCapability("prepare").catch((e: unknown) => e)).toBe(error);
  }
});

test.each([false, true].flatMap((recorded) => [false, true].map((settled) => ({ recorded, settled }))))(
  "post-renewal cancellation persists after lease closure: %o",
  async ({ recorded, settled }) => {
    const { f, run, claim } = await fixture(true);
    const gate = passingGate();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Awaited<ReturnType<CapabilityGate["canContinue"]>>>();
    const controller = new AbortController();
    gate.canContinue.mockImplementation((task) => {
      if (task.phase !== "loop") return Promise.resolve([]);
      entered.resolve();
      return release.promise.then((refused) => {
        // Cancel after requireCapability throws its refusal, before the consuming catch runs.
        if (settled)
          queueMicrotask(() =>
            queueMicrotask(() => {
              claim.close();
              controller.abort();
            }),
          );
        return refused;
      });
    });
    const local = localCheckpointer(f.store);
    const checkpointer = {
      ...local,
      writeRun: (...args: Parameters<typeof local.writeRun>) => {
        claimGuard();
        return local.writeRun(...args);
      },
      writeState: (...args: Parameters<typeof local.writeState>) => {
        claimGuard();
        local.writeState(...args);
      },
    };
    const work = executeRun(
      { ...f.deps, runClaim: claim, capability: gate, checkpointer },
      run.id,
      controller.signal,
    );
    await entered.promise;
    expect(claim.update).toHaveBeenCalledTimes(1);
    const stages = f.store.listStages(run.id);
    const invocations = f.store.listInvocations(run.id);
    const state = f.store.getRunState<RunState>(run.id);
    if (!state) throw new Error("missing state");
    state.githubWait = { reason: "claim:capability", since: 1, nextAttemptAt: 2 };
    f.store.updateRun(run.id, recorded ? { error: "cancelled by owner" } : {}, state);
    if (!settled) {
      claim.close();
      controller.abort();
    }
    release.resolve(["os"]);
    expect(await work).toBe("cancelled");
    const reopened = new Store(f.cfg.paths.db);
    try {
      expect(reopened.getRun(run.id)).toMatchObject({
        status: "cancelled",
        error: recorded ? "cancelled by owner" : null,
        finishedAt: expect.any(Number),
      });
      expect(reopened.getRunState<RunState>(run.id)?.githubWait).toBeUndefined();
      expect(reopened.listStages(run.id)).toEqual(stages);
      expect(reopened.listInvocations(run.id)).toEqual(invocations);
      expect(stages.map((stage) => stage.name)).toEqual(["prepare", "triage"]);
    } finally {
      reopened.close();
    }
  },
);

test.each(
  ["resume", "stage"].flatMap((boundary) =>
    ["replacement", "expiry"].map((change) => ({ boundary, change })),
  ),
)("capability consumption revalidates the real gate: %o", async ({ boundary, change }) => {
  const { f, run, claim } = await fixture();
  const probes = continuationGate(f);
  let checks = 0;
  const targeted = () => ++checks === (boundary === "resume" ? 1 : 2);
  if (boundary === "resume") {
    claim.close();
    claim.update.mockImplementation(async () => {
      claim.open();
      return "applied";
    });
  }
  if (change === "replacement") {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    probes.monitor.access.mockImplementation(async () => {
      if (targeted()) {
        entered.resolve();
        await release.promise;
      }
      return { at: { ...probes.now }, value: true };
    });
    const work = executeRun({ ...f.deps, runClaim: claim, capability: probes.gate }, run.id, signal());
    await entered.promise;
    probes.mismatch();
    release.resolve();
    expect(await work).toBe("queued");
  } else {
    const require = RunContext.prototype.requireCapability;
    const settle = spyOn(RunContext.prototype, "requireCapability").mockImplementation(async function (
      this: RunContext,
      phase,
    ) {
      await require.call(this, phase);
      if (targeted()) queueMicrotask(probes.expire);
    });
    restores.push(() => settle.mockRestore());
    expect(await executeRun({ ...f.deps, runClaim: claim, capability: probes.gate }, run.id, signal())).toBe(
      "queued",
    );
  }
  expect(claim.update).toHaveBeenCalledTimes(boundary === "resume" ? 0 : 1);
  expect(f.store.listStages(run.id)).toHaveLength(0);
  expect(f.store.listInvocations(run.id)).toHaveLength(0);
  expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:capability");
});

test.each(["clone", "fetch"])(
  "prepare capability loss refuses remote cache %s at dispatch",
  async (command) => {
    const { f, run, claim } = await fixture(true);
    const repo = f.store.getRepo(run.repoId);
    if (!repo) throw new Error("missing repo");
    if (command === "fetch") await repos.ensureCache(f.cfg.paths, repo);
    const gate = passingGate();
    let capable = true;
    gate.capableNow.mockImplementation(() => capable);
    const remote: string[] = [];
    const spawnReal = subprocess.spawn;
    const recorder = spyOn(subprocess, "spawn").mockImplementation(((
      bin: string,
      args: readonly string[],
      opts: subprocess.SpawnOptions,
    ) => {
      for (const op of ["clone", "fetch"]) if (args.includes(op)) remote.push(op);
      return spawnReal(bin, args, opts);
    }) as typeof subprocess.spawn);
    const process = proc.runProcess;
    const boundary = spyOn(proc, "runProcess").mockImplementation(async (opts) => {
      if (opts.cmd.includes(command)) capable = false;
      return process(opts);
    });
    restores.push(
      () => recorder.mockRestore(),
      () => boundary.mockRestore(),
    );
    expect(await executeRun({ ...f.deps, runClaim: claim, capability: gate }, run.id, signal())).toBe(
      "queued",
    );
    expect(remote).toEqual([]);
    expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:capability");
  },
);

test("local completion never calls an injected refusing capability gate", async () => {
  const { f, run } = await fixture(true);
  shared(f, false);
  const gate = passingGate();
  gate.canContinue.mockResolvedValue(["os"]);
  gate.capableNow.mockReturnValue(false);
  expect(await executeRun({ ...f.deps, capability: gate }, run.id, signal())).toBe("succeeded");
  for (const method of Object.values(gate)) expect(method).not.toHaveBeenCalled();
});

const writeFamily = (cmd: readonly string[]) =>
  cmd.includes("push")
    ? "push"
    : cmd.includes("--disable-auto")
      ? "disable"
      : cmd.includes("pr") && cmd.includes("create")
        ? "create"
        : cmd.includes("pr") && cmd.includes("edit")
          ? "edit"
          : cmd.includes("pr") && cmd.includes("comment")
            ? "comment"
            : undefined;

test.each(["push", "create", "edit", "disable", "comment"])(
  "capability loss refuses the individual %s dispatch",
  async (family) => {
    const { f, run, claim } = await fixture(true);
    let capable = true;
    const gate = passingGate();
    gate.capableNow.mockImplementation(() => capable);
    const writes: string[] = [];
    const spawnReal = subprocess.spawn;
    const recorder = spyOn(subprocess, "spawn").mockImplementation(((
      bin: string,
      args: readonly string[],
      opts: subprocess.SpawnOptions,
    ) => {
      const write = writeFamily(args);
      if (write) writes.push(write);
      return spawnReal(bin, args, opts);
    }) as typeof subprocess.spawn);
    restores.push(() => recorder.mockRestore());
    if (family === "edit")
      writeFileSync(
        join(home, "bin", "gh"),
        `#!/bin/sh
case "$1:$2" in
pr:list) echo 'https://github.com/test/repo/pull/1';;
esac
`,
        { mode: 0o755 },
      );
    const process = proc.runProcess;
    const boundary = spyOn(proc, "runProcess").mockImplementation(async (opts) => {
      if (writeFamily(opts.cmd) === family) capable = false;
      return process(opts);
    });
    restores.push(() => boundary.mockRestore());
    const create = repos.createPullRequest;
    const extra = spyOn(repos, "createPullRequest").mockImplementation(async (...args) => {
      const url = await create(...args);
      if (family === "disable" || family === "comment") {
        await runGh(["pr", "merge", url, "--disable-auto"]);
        await runGh(["pr", "comment", url, "--body", "review"]);
      }
      return url;
    });
    restores.push(() => extra.mockRestore());
    const status = await executeRun({ ...f.deps, runClaim: claim, capability: gate }, run.id, signal());
    expect(f.store.getRun(run.id)?.error).toBeNull();
    expect(status).toBe("queued");
    expect(writes).toEqual(
      family === "push"
        ? []
        : family === "comment"
          ? ["push", "create", "disable"]
          : family === "disable"
            ? ["push", "create"]
            : ["push"],
    );
    expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:capability");
    expect(gate.forget.mock.calls).toEqual([[run.id]]);
  },
);

test("shared implement keeps LAN publication local and pushes only in deliver", async () => {
  const { f, run, claim } = await fixture(true);
  f.cfg.workers.agents = ["implement"];
  f.cfg.workers.repos = ["test/repo"];
  const lan = lanAgentExecutor(f.workers, f.cfg);
  const calls: AgentCall[] = [];
  f.deps.agentExecutor = {
    kind: "lan",
    run: (call, local) => {
      if (call.role === "implement") {
        calls.push(call);
        expect(call.publication).toBeUndefined();
        // Use a worker-eligible harness identity; the local callback still uses the fake harness.
        call.spec.target.harness = "claude";
      }
      return lan.run(call, local);
    },
  };
  const pushes: string[] = [];
  const push = repos.pushBranch;
  const recorder = spyOn(repos, "pushBranch").mockImplementation(async (...args) => {
    pushes.push(f.store.getRunState<RunState>(run.id)?.phase ?? "missing");
    return push(...args);
  });
  restores.push(() => recorder.mockRestore());
  expect(await executeRun({ ...f.deps, runClaim: claim }, run.id, signal())).toBe("succeeded");
  expect(calls).toHaveLength(1);
  expect(f.store.db.query("SELECT count(*) AS n FROM agent_jobs").get()).toEqual({ n: 0 });
  expect(pushes).toEqual(["deliver"]);
});

function continuationGate(f: Factory, os: Capabilities["os"] = "darwin") {
  const now = { inclusive: 181_000, exclusive: 181_000 };
  const caps: Capabilities = {
    protocol: 1,
    release: null,
    checkpoints: [1, 2],
    os,
    arch: "arm64",
    confinement: {
      backend: "seatbelt",
      verified: true,
      codex: { edit: true, read: true, confinedRead: true },
    },
    agents: { claude: { version: "1.0.0", loggedIn: true }, codex: { version: "1.0.0", loggedIn: true } },
    privateStrings: { parity: "match", policy: null },
    freeSlots: 1,
    power: "ac",
    draining: false,
  };
  let snapshot = { at: { ...now }, value: caps };
  const advertAt = { inclusive: 1_000, exclusive: 1_000 };
  const advertiser = { fresh: mock((time: typeof now) => windowOpen(advertAt, time, 180_000)) };
  const monitor = {
    current: () => (windowOpen(snapshot.at, now, CAPABILITY_FRESH_MS) ? snapshot : null),
    refresh: async () => snapshot,
    access: mock(async () => ({ at: { ...now }, value: true })),
    start: () => () => {},
  };
  const gate = createCapabilityGate({
    monitor,
    advertiser,
    router: f.deps.router,
    tracker: f.deps.tracker,
    cfg: f.cfg,
    clock: { sample: () => now },
    freeSlots: () => 1,
    draining: () => false,
  });
  return {
    gate,
    now,
    monitor,
    advertiser,
    mismatch: () => {
      snapshot = { at: { ...now }, value: { ...caps, privateStrings: { parity: "differs", policy: null } } };
    },
    expire: () => {
      now.inclusive += CAPABILITY_FRESH_MS + 1;
      now.exclusive += CAPABILITY_FRESH_MS + 1;
    },
  };
}

test.each(["darwin", "linux"] as const)("real continuation gate with expired advert on %s", async (os) => {
  const { f, run, claim } = await fixture(true);
  const { gate, advertiser } = continuationGate(f, os);
  expect(await executeRun({ ...f.deps, runClaim: claim, capability: gate }, run.id, signal())).toBe(
    os === "darwin" ? "succeeded" : "queued",
  );
  expect(advertiser.fresh).not.toHaveBeenCalled();
  if (os === "linux") {
    expect(f.store.listStages(run.id)).toHaveLength(0);
    expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toBe("claim:capability");
  } else expect(f.store.listStages(run.id).some((s) => s.name === "implement")).toBe(true);
});
