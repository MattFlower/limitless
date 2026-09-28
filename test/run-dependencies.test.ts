import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateRunRequest } from "../src/core/types.ts";
import { newId, Store } from "../src/db/store.ts";
import { Scheduler } from "../src/scheduler.ts";
import { sh } from "../src/util/proc.ts";
import { fixture } from "./mcp-support.ts";

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
