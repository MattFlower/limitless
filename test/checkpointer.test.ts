import { expect, spyOn } from "bun:test";
import type { Factory } from "../src/app.ts";
import type { Run } from "../src/core/types.ts";
import type { RunPatch, Store } from "../src/db/store.ts";
import * as repos from "../src/git/repos.ts";
import { GitHubUnavailableError } from "../src/git/repos.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { finalizeRecordedCancellation } from "../src/pipeline/cancellation.ts";
import {
  type Checkpointer,
  localCheckpointer,
  NeedsHumanError,
  RunContext,
  type RunState,
} from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { untilAborted } from "../src/pipeline/faults.ts";
import { Scheduler } from "../src/scheduler.ts";
import { sh } from "../src/util/proc.ts";
import { approve, pipelineSetup, roleOf, triage } from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";

const fixture = { home: "", repoDir: "", factory: null as Factory | null };
const { start } = pipelineSetup(fixture);
const snapshot = (state: RunState): RunState => JSON.parse(JSON.stringify(state));

function recordingCheckpointer(store: Store) {
  const local = localCheckpointer(store);
  const log: {
    op: "writeState" | "writeRun";
    runId: string;
    patchKeys: string[];
    statePresent: boolean;
    patch?: RunPatch;
  }[] = [];
  const outside: string[] = [];
  let recording = false;
  let durable: RunState | undefined;
  let live: RunState | undefined;
  const setRunState = store.setRunState.bind(store);
  const updateRun = store.updateRun.bind(store);
  const stateSpy = spyOn(store, "setRunState").mockImplementation((...args) => {
    if (!recording) outside.push("setRunState");
    return setRunState(...args);
  });
  const runSpy = spyOn(store, "updateRun").mockImplementation((...args) => {
    if (!recording) outside.push("updateRun");
    return updateRun(...args);
  });
  function record<T>(
    op: "writeState" | "writeRun",
    id: string,
    patch: RunPatch | undefined,
    state: RunState | undefined,
    write: () => T,
  ): T {
    log.push({
      op,
      runId: id,
      patchKeys: Object.keys(patch ?? {}),
      statePresent: state !== undefined,
      patch,
    });
    if (state) {
      durable = snapshot(state);
      live = state;
    }
    recording = true;
    try {
      return write();
    } finally {
      recording = false;
    }
  }
  const checkpointer: Checkpointer = {
    writeState: (id, state) => record("writeState", id, undefined, state, () => local.writeState(id, state)),
    writeRun: (id, patch, state) =>
      record("writeRun", id, patch, state, () => local.writeRun(id, patch, state)),
    checkpoint: local.checkpoint,
  };
  return {
    checkpointer,
    log,
    outside,
    get durable() {
      return durable;
    },
    get live() {
      return live;
    },
    restore() {
      stateSpy.mockRestore();
      runSpy.mockRestore();
    },
  };
}

async function setup() {
  const f = start((spec) => {
    if (roleOf(spec) === "triage") return { structured: triage() };
    if (roleOf(spec) === "review") return { structured: approve };
    return { files: { "farewell.txt": "goodbye\n" } };
  });
  await f.stop();
  const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell", profile: "quick" });
  const repo = f.store.getRepo(run.repoId);
  if (!repo) throw new Error("Missing fixture repo");
  const ctx = new RunContext(f.deps, run, repo, new AbortController().signal);
  return { f, run, repo, ctx };
}

function resumed(state: RunState): RunState {
  return {
    ...state,
    phase: "triage",
    worktreePath: fixture.repoDir,
    previewConfig: null,
    slottedCommands: [],
    agentFullSuite: "slot",
  };
}

function finalFields(run: Run | null) {
  if (!run) throw new Error("Missing finished run");
  const { status, stage, baseSha, headSha, prUrl, merged } = run;
  return { status, stage, baseSha, headSha, prUrl, merged };
}

test("local forwards arguments and return identity, preserves omitted state, and emits only run writes", async () => {
  const { f, run, repo, ctx } = await setup();
  const other = f.store.createRun(repo, { repo: repo.slug, prompt: run.prompt, profile: "quick" });
  const local = localCheckpointer(f.store);
  const messages: string[] = [];
  const unsubscribe = f.store.subscribe((msg) => messages.push(msg.kind));
  const patch = { status: "running" as const, startedAt: 123 };
  const update = spyOn(f.store, "updateRun");
  try {
    local.writeState(run.id, ctx.state);
    expect(messages).toEqual([]);
    expect(local.checkpoint(run.id, "local")).toBeUndefined();
    const result = local.writeRun(run.id, patch, ctx.state);
    expect(update.mock.calls[0]).toEqual([run.id, patch, ctx.state]);
    expect(update.mock.calls[0]?.[1]).toBe(patch);
    expect(update.mock.calls[0]?.[2]).toBe(ctx.state);
    expect<unknown>(result).toBe(update.mock.results[0]?.value);
    const direct = f.store.updateRun(other.id, patch, ctx.state);
    expect({ ...result, id: other.id, createdAt: direct.createdAt }).toEqual(direct);
    const before = f.store.getRunState<RunState>(run.id);
    local.writeRun(run.id, { status: "queued" });
    expect(update.mock.calls.at(-1)).toEqual([run.id, { status: "queued" }, undefined]);
    expect(f.store.getRunState<RunState>(run.id)).toEqual(before);
    expect(messages).toEqual(["run", "run", "run"]);
  } finally {
    update.mockRestore();
    unsubscribe();
  }
});

test("save is visible synchronously and settles before a second microtask", async () => {
  const { f, run, ctx } = await setup();
  ctx.state.feedback = "new state";
  const p = ctx.save("visible");
  expect(f.store.getRunState<RunState>(run.id)).toEqual(snapshot(ctx.state));
  let done = false;
  p.then(() => {
    done = true;
  });
  await null;
  expect(done).toBe(true);
});

test("foreground stage refreshes ctx.run with the writeRun result", async () => {
  const { f, run, ctx } = await setup();
  expect(ctx.run).toMatchObject({ status: "queued", stage: null, title: "Add farewell" });
  const updated = f.store.updateRun(run.id, {
    status: "running",
    title: "Refreshed title",
    startedAt: 123,
  });
  await ctx.stage("triage", async () => {
    expect(ctx.run).toEqual({ ...updated, stage: "triage" });
    return { summary: "observed refreshed run", value: undefined };
  });
});

test("save awaits a shared boundary after the write and passes its label", async () => {
  const { f, run, repo } = await setup();
  const boundary = Promise.withResolvers<void>();
  const calls: unknown[][] = [];
  const ctx = new RunContext(
    {
      ...f.deps,
      checkpointer: {
        ...localCheckpointer(f.store),
        checkpoint: (...args) => {
          calls.push(args);
          return boundary.promise;
        },
      },
    },
    run,
    repo,
    new AbortController().signal,
  );
  const p = ctx.save("shared");
  let done = false;
  p.then(() => {
    done = true;
  });
  await null;
  expect(done).toBe(false);
  expect(f.store.getRunState<RunState>(run.id)).toEqual(snapshot(ctx.state));
  expect(calls).toEqual([[run.id, "shared"]]);
  boundary.resolve();
  await p;
});

test("save clears GitHub wait and hits the fault hook before writing", async () => {
  const { f, run, repo, ctx: initial } = await setup();
  f.store.setRunState(run.id, initial.state);
  const seen: unknown[] = [];
  const ctx = new RunContext(
    {
      ...f.deps,
      faults: {
        "store:save": {
          action: "continue",
          onHit: () => seen.push(f.store.getRunState<RunState>(run.id)),
        },
      },
    },
    run,
    repo,
    new AbortController().signal,
  );
  ctx.state.feedback = "after fault";
  ctx.state.githubWait = { since: 1, nextAttemptAt: 2, reason: "outage" };
  await ctx.save();
  expect(seen).toEqual([snapshot(initial.state)]);
  expect(f.store.getRunState<RunState>(run.id)?.feedback).toBe("after fault");
  expect(ctx.state.githubWait).toBeUndefined();
});

test("full fake run records prepare and stages with identical events and final run fields", async () => {
  const { f, run, repo } = await setup();
  // Normalize only commit identity metadata so two distinct runs produce comparable SHAs.
  const commitAll = repos.commitAll;
  const commit = spyOn(repos, "commitAll").mockImplementation((cwd, message, options) =>
    commitAll(cwd, message.replace(/Run: .+/, "Run: comparison"), options),
  );
  const authorDate = process.env.GIT_AUTHOR_DATE;
  const committerDate = process.env.GIT_COMMITTER_DATE;
  process.env.GIT_AUTHOR_DATE = "2026-01-01T00:00:00Z";
  process.env.GIT_COMMITTER_DATE = "2026-01-01T00:00:00Z";
  const events: Run[] = [];
  const unsubscribe = f.store.subscribe((msg) => {
    if (msg.kind === "run")
      events.push({
        ...msg.run,
        id: "comparison",
        branch: msg.run.branch?.replace(msg.run.id, "comparison") ?? null,
        createdAt: 0,
        startedAt: msg.run.startedAt === null ? null : 0,
        finishedAt: msg.run.finishedAt === null ? null : 0,
      });
  });
  let recorder: ReturnType<typeof recordingCheckpointer> | undefined;
  try {
    // Reproduce the pre-adapter Store writes independently of localCheckpointer.
    const direct: Checkpointer = {
      writeState: (id, state) => f.store.setRunState(id, state),
      writeRun: (id, patch, state) => f.store.updateRun(id, patch, state),
      checkpoint: () => {},
    };
    await executeRun({ ...f.deps, checkpointer: direct }, run.id, new AbortController().signal);
    expect(f.store.getRun(run.id)).toMatchObject({ status: "succeeded", error: null });
    const baseline = events.splice(0);
    const other = f.store.createRun(repo, { repo: repo.slug, prompt: run.prompt, profile: "quick" });
    // Exclude run creation from both event sequences.
    events.length = 0;
    recorder = recordingCheckpointer(f.store);
    expect(
      await executeRun(
        { ...f.deps, checkpointer: recorder.checkpointer },
        other.id,
        new AbortController().signal,
      ),
    ).toBe("succeeded");
    expect(recorder.outside).toEqual([]);
    expect(recorder.log.some((entry) => entry.patch?.stage === "prepare")).toBe(true);
    expect(recorder.log.some((entry) => entry.patch?.stage === "implement")).toBe(true);
    expect(events).toEqual(baseline);
    expect(finalFields(f.store.getRun(other.id))).toEqual(finalFields(f.store.getRun(run.id)));
  } finally {
    recorder?.restore();
    commit.mockRestore();
    unsubscribe();
    if (authorDate === undefined) delete process.env.GIT_AUTHOR_DATE;
    else process.env.GIT_AUTHOR_DATE = authorDate;
    if (committerDate === undefined) delete process.env.GIT_COMMITTER_DATE;
    else process.env.GIT_COMMITTER_DATE = committerDate;
  }
});

test.each(["github-wait", "needs-human", "post-merge-rejection"] as const)(
  "real engine routes %s writes",
  async (path) => {
    const { f, run, repo, ctx } = await setup();
    const state = resumed(ctx.state);
    const deps = { ...f.deps };
    if (path === "post-merge-rejection") {
      const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: fixture.repoDir })).stdout.trim();
      state.postMergeRejection = {
        reason: "post-merge gates regressed",
        sha,
        base: sha,
        head: sha,
        round: 1,
      };
    } else if (path === "github-wait") {
      state.phase = "deliver";
      state.lastVerifiedSha = "a".repeat(40);
      f.store.upsertRepo({
        ...repo,
        kind: "github",
        url: "https://example.com/test/repo.git",
        localPath: null,
      });
      // The normal stage boundary reports an unavailable service before any GitHub operation.
      deps.faults = {
        "stage:deliver:before": {
          action: "continue",
          onHit: () => {
            throw new GitHubUnavailableError("offline");
          },
        },
      };
    } else {
      deps.faults = {
        "stage:triage:before": {
          action: "continue",
          onHit: () => {
            throw new NeedsHumanError("human decision required");
          },
        },
      };
    }
    f.store.setRunState(run.id, state);
    const recorder = recordingCheckpointer(f.store);
    try {
      const expected = path === "github-wait" ? "queued" : "needs_human";
      expect(
        await executeRun(
          { ...deps, checkpointer: recorder.checkpointer },
          run.id,
          new AbortController().signal,
        ),
      ).toBe(expected);
      expect(recorder.outside).toEqual([]);
      expect(recorder.log.some((entry) => entry.patch?.status === expected)).toBe(true);
      if (path === "github-wait")
        expect(f.store.getRunState<RunState>(run.id)?.githubWait?.reason).toContain("offline");
      if (path === "post-merge-rejection")
        expect(recorder.log.some((entry) => entry.patchKeys.includes("headSha") && entry.statePresent)).toBe(
          true,
        );
    } finally {
      recorder.restore();
    }
  },
);

test.each(["cancel", "shutdown"] as const)(
  "Scheduler %s routes every write and preserves the durable checkpoint",
  async (path) => {
    const { f, run, ctx } = await setup();
    f.store.setRunState(run.id, resumed(ctx.state));
    const recorder = recordingCheckpointer(f.store);
    const entered = Promise.withResolvers<void>();
    const scheduler = new Scheduler(
      {
        ...f.deps,
        checkpointer: recorder.checkpointer,
        harnesses: {
          fake: fakeHarness(async (spec) => {
            if (!recorder.live) throw new Error("Missing live state");
            recorder.live.feedback = "only in memory";
            entered.resolve();
            await untilAborted(spec.signal);
            return { status: "cancelled" };
          }),
        },
      },
      1,
      { loadSource: () => 0 },
    );
    try {
      scheduler.tick();
      await entered.promise;
      expect(recorder.live?.feedback).toBe("only in memory");
      if (path === "cancel") expect(scheduler.cancel(run.id)).toBe(true);
      await scheduler.stop();
      expect(recorder.outside).toEqual([]);
      expect(f.store.getRun(run.id)?.status).toBe(path === "shutdown" ? "queued" : "cancelled");
      expect(recorder.log.at(-1)).toMatchObject({
        op: "writeRun",
        runId: run.id,
        patchKeys: ["status", "finishedAt"],
        statePresent: path === "cancel",
      });
      expect(f.store.getRunState<RunState>(run.id)).toEqual(recorder.durable ?? null);
      expect(f.store.getRunState<RunState>(run.id)?.feedback).not.toBe("only in memory");
    } finally {
      await scheduler.stop();
      recorder.restore();
    }
  },
);

test("cancellation finalization uses supplied and default checkpointers", async () => {
  const { f, run, repo, ctx } = await setup();
  const other = f.store.createRun(repo, { repo: repo.slug, prompt: "cancel" });
  const state = { ...ctx.state, githubWait: { since: 1, nextAttemptAt: 2, reason: "outage" } };
  for (const id of [run.id, other.id])
    f.store.updateRun(id, { status: "running", error: "cancelled by user" }, state);
  const recorder = recordingCheckpointer(f.store);
  try {
    expect(finalizeRecordedCancellation(f.store, run.id, recorder.checkpointer)).toBe(true);
    expect(recorder.log).toHaveLength(1);
    expect(recorder.log[0]).toMatchObject({ op: "writeRun", statePresent: true });
    expect(recorder.outside).toEqual([]);
  } finally {
    recorder.restore();
  }
  expect(finalizeRecordedCancellation(f.store, other.id)).toBe(true);
  for (const id of [run.id, other.id]) {
    expect(f.store.getRun(id)?.status).toBe("cancelled");
    expect(f.store.getRunState<RunState>(id)?.githubWait).toBeUndefined();
  }
});

test.each([false, true])(
  "scheduler startup recovers state through the seam (injected=%s)",
  async (injected) => {
    const { f, run, repo, ctx } = await setup();
    const cancelled = f.store.createRun(repo, { repo: repo.slug, prompt: "cancelled" });
    const marked = f.store.createRun(repo, { repo: repo.slug, prompt: "marked" });
    const state = { ...ctx.state, githubWait: { since: 1, nextAttemptAt: 2, reason: "outage" } };
    f.store.updateRun(run.id, { status: "running" }, state);
    f.store.updateRun(cancelled.id, { status: "cancelled" }, state);
    f.store.updateRun(marked.id, { error: "cancelled by user" }, state);
    const recorder = injected ? recordingCheckpointer(f.store) : undefined;
    const scheduler = new Scheduler({ ...f.deps, checkpointer: recorder?.checkpointer }, 0);
    try {
      scheduler.start();
      await scheduler.stop();
      expect(f.store.getRun(run.id)?.status).toBe("queued");
      for (const id of [cancelled.id, marked.id]) {
        expect(f.store.getRun(id)?.status).toBe("cancelled");
        expect(f.store.getRunState<RunState>(id)?.githubWait).toBeUndefined();
      }
      if (recorder) {
        expect(recorder.outside).toEqual([]);
        expect(recorder.log).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              runId: run.id,
              patchKeys: ["status", "finishedAt"],
              statePresent: false,
            }),
            expect.objectContaining({ runId: cancelled.id, patchKeys: [], statePresent: true }),
            expect.objectContaining({ runId: marked.id, statePresent: true }),
          ]),
        );
      }
    } finally {
      await scheduler.stop();
      recorder?.restore();
    }
  },
);
