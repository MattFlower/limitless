import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import { startGitHubNotifier } from "../src/integrations/github-notifier.ts";
import { startGitHubPoller } from "../src/integrations/github-poller.ts";
import { reconcileIssueLifecycle } from "../src/integrations/issue-lifecycle.ts";

const dir = mkdtempSync(join(tmpdir(), "observer-benchmark-"));
const store = new Store(join(dir, "store.db"));
const cfg = loadConfig({
  home: dir,
  configDir: dir,
  raw: { github: { queue: { repos: ["owner/repo"], trusted: ["owner"] } } },
});
const gh: GhRunner = async (args, _signal, _stdin, _repo, guard) => {
  guard?.();
  return args.includes("POST") ? '{"id":71}' : "[]";
};
const repo = store.upsertRepo({
  slug: "owner/repo",
  kind: "github",
  url: null,
  localPath: null,
  defaultBranch: "main",
  mergePolicy: "pr",
});
try {
  for (let number = 1; number <= 50; number++) {
    const run = store.createRun(repo, {
      repo: repo.slug,
      prompt: "work",
      source: "github",
      sourceRef: { kind: "issue", repo: repo.slug, number },
    });
    store.updateRun(run.id, { status: "running" });
    store.setIssueLifecycleEffect(run.id, repo.slug, number, "labels", "limitless:in-progress");
  }
  const signal = new AbortController().signal;
  const options = {
    identity: async () => ({ kind: "app", token: "fake", botLogin: "factory[bot]" }) as const,
  };
  await reconcileIssueLifecycle(store, cfg, gh, signal, () => {}, { ...options, maxCalls: 0 });
  const start = performance.now();
  await reconcileIssueLifecycle(store, cfg, gh, signal, () => {}, options);
  console.log(`Lifecycle reconcile (50 pending comments): ${(performance.now() - start).toFixed(3)} ms`);
  const factory = new Factory(cfg, { store });
  factory.scheduler.admissionHeld = true;
  factory.tracker.probe = async () => {};
  factory.scheduler.start();
  const notifier = startGitHubNotifier(store, gh, undefined, async () => null, dir, [], cfg);
  const poller = startGitHubPoller(store, {
    client: async (_path, _body, _signal, _repo, guard) => {
      guard?.();
      return { status: 200, headers: new Headers(), body: {} };
    },
  });
  try {
    const run = store.listRuns({ limit: 1 })[0];
    if (!run) throw new Error("Missing benchmark run");
    const start = performance.now();
    for (let i = 0; i < 1_000; i++) store.updateRun(run.id, { stage: null });
    console.log(`Store.publish (1000 run updates): ${(performance.now() - start).toFixed(3)} ms`);
  } finally {
    poller();
    await notifier();
    await factory.scheduler.stop();
  }
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
