import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateRunRequest } from "../src/core/types.ts";
import { newId, Store } from "../src/db/store.ts";
import { reconcileMergedRuns } from "../src/integrations/github-notifier.ts";
import { Scheduler } from "../src/scheduler.ts";
import { sh } from "../src/util/proc.ts";
import { fixture } from "./mcp-support.ts";

// These tests drive real git and subprocesses; under CPU load they outlast Bun's 5 s default (#140).
setDefaultTimeout(30_000);

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.close();
});
const create = (dependsOn?: string[]) => f.factory.createRun({ repo: f.repo, prompt: "work", dependsOn });

function unstarted(id: string) {
  expect(f.factory.store.getRun(id)).toMatchObject({
    startedAt: null,
    stage: null,
    baseSha: null,
    branch: null,
  });
  expect(f.factory.store.listStages(id)).toEqual([]);
  expect(f.factory.store.listInvocations(id)).toEqual([]);
  expect(existsSync(join(f.factory.cfg.paths.work, id))).toBe(false);
}

test("shared validation rejects malformed, unknown, self and cyclic graphs without publications", async () => {
  const first = await create();
  const repo = f.factory.store.getRepo(first.repoId);
  if (!repo) throw new Error("missing repo");
  let publications = 0;
  const off = f.factory.store.subscribe(() => publications++);
  const reject = (dependsOn: unknown, message: string | RegExp) => {
    const before = f.factory.store.listRuns().length;
    const published = publications;
    expect(() =>
      f.factory.store.createRun(repo, { repo: f.repo, prompt: "bad", dependsOn } as CreateRunRequest),
    ).toThrow(message);
    expect(f.factory.store.listRuns()).toHaveLength(before);
    expect(publications).toBe(published);
  };
  for (const input of [null, "id", {}, [1], [null], [" "], [first.id, ""]]) reject(input, /depend/i);
  reject(["absent"], "absent");
  const time = spyOn(Date, "now").mockReturnValue(123456);
  const random = spyOn(Math, "random").mockReturnValue(0.5);
  try {
    reject([newId()], "self-dependency");
  } finally {
    time.mockRestore();
    random.mockRestore();
  }
  const second = await create([first.id]);
  f.factory.store.db
    .query("UPDATE runs SET depends_on = ? WHERE id = ?")
    .run(JSON.stringify([second.id]), first.id);
  reject([second.id], "cycle");
  f.factory.store.db.query("UPDATE runs SET depends_on = '[]' WHERE id = ?").run(first.id);
  expect((await create([` ${first.id} `, first.id])).dependsOn).toEqual([first.id]);
  off();
});

test("waiting consumes no slot; all prerequisites must merge, then execution starts once on current base", async () => {
  const { store, deps } = f.factory;
  const first = await create();
  const second = await create();
  for (const run of [first, second]) store.updateRun(run.id, { status: "succeeded" });
  const dependent = await create([first.id, second.id]);
  const unrelated = await create();
  let scheduler = new Scheduler(deps, 1);
  scheduler.tick();
  expect(scheduler.activeRunIds).toEqual([unrelated.id]);
  unstarted(dependent.id);
  scheduler.cancel(unrelated.id);
  await scheduler.stop();
  scheduler = new Scheduler(deps, 1);
  try {
    scheduler.start();
    expect(store.getRun(dependent.id)?.status).toBe("waiting");
    store.updateRun(first.id, { merged: true });
    scheduler.tick();
    unstarted(dependent.id);
    expect(scheduler.activeRunIds).toEqual([]);
    writeFileSync(join(f.repo, "advance.txt"), "new base\n");
    await sh(["git", "add", "."], { cwd: f.repo });
    await sh(
      ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "advance"],
      { cwd: f.repo },
    );
    const { stdout: sha } = await sh(["git", "rev-parse", "HEAD"], { cwd: f.repo });
    store.updateRun(second.id, { merged: true });
    scheduler.tick();
    scheduler.tick();
    expect(scheduler.activeRunIds).toEqual([dependent.id]);
    for (let i = 0; i < 300 && !store.getRun(dependent.id)?.baseSha; i++) await Bun.sleep(10);
    expect(store.getRun(dependent.id)?.baseSha).toBe(sha.trim());
    expect(store.listStages(dependent.id).filter((stage) => stage.name === "prepare")).toHaveLength(1);
    expect((await create([first.id, second.id])).status).toBe("queued");
  } finally {
    await scheduler.stop();
  }
});

for (const cause of ["failed", "cancelled", "closed", "needs_human"] as const) {
  test(`${cause} ancestor blocks the whole chain in one pass with the original reason`, async () => {
    const { store, scheduler } = f.factory;
    const ancestor = await create();
    store.updateRun(ancestor.id, { status: cause === "cancelled" ? "running" : "succeeded" });
    const dependent = await create([ancestor.id]);
    const descendant = await create([dependent.id]);
    // Reconciliation visits the descendant first, before its parent is marked blocked.
    for (const [index, run] of [ancestor, dependent, descendant].entries())
      store.db.query("UPDATE runs SET created_at = ? WHERE id = ?").run(index, run.id);
    expect(store.listRuns({ status: ["waiting"] }).map((run) => run.id)).toEqual([
      descendant.id,
      dependent.id,
    ]);
    if (cause === "cancelled") expect(f.factory.cancelRun(ancestor.id)).toBe(true);
    else
      store.updateRun(
        ancestor.id,
        cause === "closed" ? { prClosedUnmerged: true } : { status: cause, error: "original problem" },
      );
    const reason = `Dependency ${ancestor.id}: ${
      cause === "closed"
        ? "PR was closed unmerged"
        : cause === "needs_human"
          ? "run needs_human without PR: original problem"
          : `run ${cause}`
    }`;
    const reopened = cause === "closed" ? new Store(f.factory.cfg.paths.db) : null;
    try {
      const reconciler = reopened ?? store;
      reconciler.reconcileWaitingRuns();
      for (const run of [dependent, descendant]) {
        expect(store.getRun(run.id)).toMatchObject({
          status: "needs_human",
          error: reason,
          finishedAt: expect.any(Number),
        });
        expect(store.listEvents(run.id).filter((event) => event.type === "status")).toMatchObject([
          { message: reason, data: { from: "waiting", to: "needs_human" } },
        ]);
        unstarted(run.id);
      }
      const later = await create([dependent.id]);
      expect(later).toMatchObject({ status: "needs_human", error: reason });
      const blocked = [dependent, descendant, later].map((run) => store.getRun(run.id));
      reconciler.reconcileWaitingRuns();
      scheduler.tick();
      expect(scheduler.activeRunIds).toEqual([]);
      expect([dependent, descendant, later].map((run) => store.getRun(run.id))).toEqual(blocked);
      store.updateRun(ancestor.id, { merged: true });
      reconciler.reconcileWaitingRuns();
      expect([dependent, descendant, later].map((run) => store.getRun(run.id))).toEqual(blocked);
      expect(await create([dependent.id])).toMatchObject({ status: "needs_human", error: reason });
    } finally {
      reopened?.close();
    }
  });
}

test("creation inspects a blocked ancestor before its waiting parent is reconciled", async () => {
  const { store } = f.factory;
  const ancestor = await create();
  const dependent = await create([ancestor.id]);
  store.updateRun(ancestor.id, { status: "failed" });
  expect(await create([dependent.id])).toMatchObject({
    status: "needs_human",
    error: `Dependency ${ancestor.id}: run failed`,
  });
  expect(store.getRun(dependent.id)?.status).toBe("waiting");
});

test("needs-human with an open PR remains waitable and confirmed merges release the chain", async () => {
  const { store } = f.factory;
  const ancestor = await create();
  const prUrl = "https://github.com/example/repo/pull/1";
  store.updateRun(ancestor.id, { status: "needs_human", prUrl, error: "review required" });
  const dependent = await create([ancestor.id]);
  const descendant = await create([dependent.id]);
  await reconcileMergedRuns(store, async (url) => ({
    url,
    state: "OPEN",
    mergedAt: null,
    mergedBy: null,
  }));
  for (const run of [dependent, descendant]) {
    expect(store.getRun(run.id)?.status).toBe("waiting");
    unstarted(run.id);
  }
  const merged = async (url: string) => ({
    url,
    state: "MERGED",
    mergedAt: new Date(123456).toISOString(),
    mergedBy: null,
  });
  await reconcileMergedRuns(store, merged);
  expect(store.getRun(ancestor.id)).toMatchObject({ status: "resolved", merged: true });
  expect(store.getRun(dependent.id)?.status).toBe("queued");
  expect(store.getRun(descendant.id)?.status).toBe("waiting");
  store.updateRun(dependent.id, {
    status: "succeeded",
    prUrl: "https://github.com/example/repo/pull/2",
  });
  await reconcileMergedRuns(store, merged);
  expect(store.getRun(descendant.id)?.status).toBe("queued");
  for (const run of [dependent, descendant]) unstarted(run.id);
});

for (const cause of ["failed", "cancelled", "closed"] as const) {
  test(`${cause} dependencies fail durably and only explicit retry reevaluates`, async () => {
    const { store, scheduler } = f.factory;
    const prerequisite = await create();
    store.updateRun(prerequisite.id, { status: "succeeded" });
    const dependent = await create([prerequisite.id]);
    store.updateRun(prerequisite.id, cause === "closed" ? { prClosedUnmerged: true } : { status: cause });
    scheduler.tick();
    expect(store.getRun(dependent.id)).toMatchObject({
      status: "needs_human",
      error: expect.stringContaining(prerequisite.id),
      finishedAt: expect.any(Number),
    });
    expect(store.getRun(dependent.id)?.error).toContain(cause);
    unstarted(dependent.id);
    const reopened = new Store(f.factory.cfg.paths.db);
    try {
      reopened.reconcileWaitingRuns();
      const repo = reopened.getRepo(prerequisite.repoId);
      if (!repo) throw new Error("missing repo");
      expect(
        reopened.createRun(repo, { repo: f.repo, prompt: "later", dependsOn: [prerequisite.id] }).status,
      ).toBe("needs_human");
    } finally {
      reopened.close();
    }
    expect((await f.factory.retryRun(dependent.id)).status).toBe("needs_human");
    store.updateRun(prerequisite.id, { merged: true });
    store.reconcileWaitingRuns();
    expect(store.getRun(dependent.id)?.status).toBe("needs_human");
    const retry = await f.factory.retryRun(dependent.id);
    expect(retry).toMatchObject({ status: "queued", dependsOn: [prerequisite.id] });
  });
}

test("cancellation is permanent and retry preserves waiting dependencies across restart", async () => {
  const prerequisite = await create();
  f.factory.store.updateRun(prerequisite.id, { status: "succeeded" });
  const run = await create([prerequisite.id]);
  expect(f.factory.cancelRun(run.id)).toBe(true);
  const retry = await f.factory.retryRun(run.id);
  expect(retry).toMatchObject({ status: "waiting", dependsOn: [prerequisite.id] });
  const store = new Store(f.factory.cfg.paths.db);
  try {
    store.reconcileWaitingRuns();
    expect(store.getRun(retry.id)?.status).toBe("waiting");
    store.updateRun(prerequisite.id, { merged: true });
    store.reconcileWaitingRuns();
    store.reconcileWaitingRuns();
    expect(store.getRun(run.id)?.status).toBe("cancelled");
    expect(store.getRun(retry.id)?.status).toBe("queued");
    expect(store.listEvents(retry.id).filter((event) => event.type === "status")).toHaveLength(1);
  } finally {
    store.close();
  }
});

test("CLI --after sends multiple prerequisite IDs and prints the waiting status", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(import.meta.dir, "fixtures/dependencies-cli-preload.ts"),
      join(import.meta.dir, "../src/cli/main.ts"),
      "run",
      "next",
      "--repo",
      "local/repo",
      "--after",
      "one,two",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(0);
  expect(error).toBe("");
  const request = output.split("\n").find((line) => line.startsWith("REQUEST "));
  expect(JSON.parse(request?.slice(8) ?? "{}")).toMatchObject({
    dependsOn: ["one", "two"],
    repo: "local/repo",
  });
  expect(output).toContain("waiting");
});

test("CLI --allow is repeatable, validated, and sent as the allow option", async () => {
  const cli = async (...args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(import.meta.dir, "fixtures/dependencies-cli-preload.ts"),
        join(import.meta.dir, "../src/cli/main.ts"),
        "run",
        "vendor it",
        "--repo",
        "local/repo",
        ...args,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const request = output.split("\n").find((line) => line.startsWith("REQUEST "));
    return { exit, error, request: request ? JSON.parse(request.slice(8)) : null };
  };
  const both = await cli("--allow", "gitattributes", "--allow", "submodules", "--allow", "submodules");
  expect(both.exit).toBe(0);
  expect(both.request.allow).toEqual(["submodules", "gitattributes"]);
  expect((await cli()).request.allow).toBeUndefined();
  const invalid = await cli("--allow", "everything");
  expect(invalid.exit).not.toBe(0);
  expect(invalid.request).toBeNull();
  expect(invalid.error).toContain('Invalid allow value "everything"');
});
