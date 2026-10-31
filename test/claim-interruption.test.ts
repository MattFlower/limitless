import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TERMINAL_STATUSES } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { githubWait } from "../src/git/github-wait.ts";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { mapClaimInterruption } from "../src/pipeline/claim-interruption.ts";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claim-interruption-"));
  store = new Store(join(dir, "store.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
function fixture(phase = "prepare") {
  const repo = store.upsertRepo({
    slug: "owner/repo",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "work" });
  const state = {
    phase,
    round: 3,
    lastVerifiedSha: "evidence",
    publishedSha: "published",
    verdictCommentPosted: true,
    postMergeRejection: { reason: "rejected", sha: "merge", base: "base", head: "head", round: 2 },
    githubWait: { since: 1, nextAttemptAt: 2, reason: "previous" },
  };
  store.updateRun(run.id, { status: "running", stage: "implement", error: "old", finishedAt: 10 }, state);
  return { run, state };
}

test.each(["prepare", "loop", "deliver"])(
  "wait preserves %s evidence and persisted retry eligibility without expiry",
  (phase) => {
    const { run, state } = fixture(phase);
    for (const reason of ["lease", "unavailable", "cancelled"] as const) {
      const now = githubWait.maxMs * 2;
      mapClaimInterruption(store, run.id, new ClaimWaitError(reason), now);
      expect(store.getRun(run.id)).toMatchObject({
        status: "queued",
        stage: null,
        error: null,
        finishedAt: null,
      });
      expect(store.getRunState<Record<string, unknown>>(run.id)).toEqual({
        ...state,
        githubWait: { since: 1, nextAttemptAt: now + githubWait.intervalMs, reason: `claim:${reason}` },
      });
      store.close();
      store = new Store(join(dir, "store.db"));
      expect(store.nextQueuedRuns(10, now + githubWait.intervalMs - 1)).toHaveLength(0);
      expect(store.nextQueuedRuns(10, now + githubWait.intervalMs).map((r) => r.id)).toEqual([run.id]);
    }
  },
);

test.each([false, true])("local interruption closes only running invocations, loss=%s", (loss) => {
  const { run, state } = fixture();
  const invocation = () =>
    store.createInvocation({
      runId: run.id,
      stageId: null,
      role: "implement",
      harness: "fake",
      provider: "fake",
      model: "fake",
      modelId: "fake",
    });
  const running = invocation();
  const finished = invocation();
  store.updateInvocation(running.id, { costUsd: 1, inputTokens: 17 });
  store.updateInvocation(finished.id, {
    status: "ok",
    finishedAt: 7,
    costUsd: 2,
    outputTokens: 23,
    numTurns: 4,
  });
  const before = store.getInvocation(finished.id);
  const costs = store.getRun(run.id);
  mapClaimInterruption(store, run.id, loss ? new ClaimLostError() : new ClaimWaitError("lease"), 99);
  expect(store.getInvocation(running.id)).toMatchObject({
    status: "cancelled",
    error: loss ? "interrupted: claim lost" : "interrupted: claim wait",
    finishedAt: 99,
    costUsd: 1,
    inputTokens: 17,
    outputTokens: 0,
  });
  expect(store.getInvocation(finished.id)).toEqual(before);
  expect(store.getRun(run.id)?.costUsd).toBe(costs?.costUsd);
  if (loss) {
    expect(store.getRun(run.id)).toMatchObject({
      status: "cancelled",
      stage: null,
      error: "superseded: claim lost",
      finishedAt: 99,
    });
    const { githubWait: _wait, ...durable } = state;
    expect(store.getRunState<Record<string, unknown>>(run.id)).toEqual(durable);
    expect(store.nextQueuedRuns(10, Number.MAX_SAFE_INTEGER)).toHaveLength(0);
  }
});

test.each([...TERMINAL_STATUSES])("independent %s decisions win over both stale callbacks", (status) => {
  const { run } = fixture();
  store.updateRun(run.id, { status, error: "independent decision", finishedAt: 73 });
  const before = store.getRun(run.id);
  const state = store.getRunState<Record<string, unknown>>(run.id);
  mapClaimInterruption(store, run.id, new ClaimLostError(), 100);
  mapClaimInterruption(store, run.id, new ClaimWaitError("lease"), 101);
  expect(store.getRun(run.id)).toEqual(before);
  expect(store.getRunState<Record<string, unknown>>(run.id)).toEqual(state);
});

test("recorded user cancellation finalizes locally and preserves its evidence", () => {
  const { run, state } = fixture();
  store.updateRun(run.id, { error: "cancelled by owner", finishedAt: 55 });
  mapClaimInterruption(store, run.id, new ClaimLostError(), 100);
  expect(store.getRun(run.id)).toMatchObject({
    status: "cancelled",
    error: "cancelled by owner",
    finishedAt: 55,
  });
  const { githubWait: _wait, ...durable } = state;
  expect(store.getRunState<Record<string, unknown>>(run.id)).toEqual(durable);
  const before = store.getRun(run.id);
  mapClaimInterruption(store, run.id, new ClaimWaitError("cancelled"), 101);
  expect(store.getRun(run.id)).toEqual(before);
});

test("a fresh wait starts its own durable clock", () => {
  const { run } = fixture();
  store.setRunState(run.id, { phase: "prepare" });
  mapClaimInterruption(store, run.id, new ClaimWaitError("lease"), 77);
  expect(store.getRunState<Record<string, unknown>>(run.id)).toEqual({
    phase: "prepare",
    githubWait: { since: 77, nextAttemptAt: 77 + githubWait.intervalMs, reason: "claim:lease" },
  });
});
