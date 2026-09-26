import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db/store.ts";
import { startGitHubNotifier } from "../src/integrations/github-notifier.ts";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "github-notifier-"));
  store = new Store(join(dir, "store.db"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("comments once at creation and terminal status with cost and PR link", async () => {
  const calls: string[][] = [];
  const stop = startGitHubNotifier(store, async (args) => {
    calls.push(args);
  });
  const repo = store.upsertRepo({
    slug: "MattFlower/limitless",
    kind: "github",
    url: "unused",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, {
    repo: repo.slug,
    prompt: "fix",
    source: "github",
    sourceRef: { kind: "pull_request", repo: repo.slug, number: 12 },
  });
  store.updateRun(run.id, { stage: "prepare" });
  store.updateRun(run.id, { status: "running" });
  store.updateRun(run.id, { prUrl: "https://github.com/MattFlower/limitless/pull/12" });
  store.db.query("UPDATE runs SET cost_usd = 1.25, cost_equiv_usd = 2.5 WHERE id = ?").run(run.id);
  store.updateRun(run.id, { status: "succeeded" });
  store.updateRun(run.id, { stage: null });
  const other = store.createRun(repo, { repo: repo.slug, prompt: "other" });
  store.updateRun(other.id, { status: "failed" });
  await Bun.sleep(0);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual([
    "pr",
    "comment",
    "12",
    "--repo",
    repo.slug,
    "--body",
    `Limitless run created: ${run.id}`,
  ]);
  expect(calls[1]?.at(-1)).toContain("succeeded");
  expect(calls[1]?.at(-1)).toContain("https://github.com/MattFlower/limitless/pull/12");
  expect(calls[1]?.at(-1)).toContain("$1.25");
  stop();
});
