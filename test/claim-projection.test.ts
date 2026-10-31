import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as subprocess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { ClaimLostError } from "../src/integrations/claim-errors.ts";
import {
  ClaimObserverSuppressed,
  isClaimLossProjection,
  observerDispatchGuard,
} from "../src/integrations/claim-projection.ts";
import { type GhRunner, runGh } from "../src/integrations/github.ts";
import * as identity from "../src/integrations/github-identity.ts";
import { startGitHubNotifier } from "../src/integrations/github-notifier.ts";
import { reconcileIssueLifecycle } from "../src/integrations/issue-lifecycle.ts";
import { mapClaimInterruption } from "../src/pipeline/claim-interruption.ts";
import { processBootInspection, processRecoveryInspection, processScope } from "../src/util/proc.ts";

let dir: string;
let store: Store;
let cfg: ReturnType<typeof loadConfig>;
let calls: string[][];
const restores: (() => void)[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claim-projection-"));
  store = new Store(join(dir, "store.db"));
  cfg = loadConfig({
    home: join(dir, "data"),
    configDir: join(dir, "config"),
    raw: { owners: { github: "owner" }, github: { queue: { repos: ["owner/repo"], trusted: ["owner"] } } },
  });
  calls = [];
});
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
function fixture(kind = "issue", slug = "owner/repo") {
  const repo = store.upsertRepo({
    slug,
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, {
    repo: repo.slug,
    prompt: "work",
    source: "github",
    sourceRef: { kind, repo: repo.slug, number: 7 },
  });
  store.updateRun(run.id, { status: "running" });
  return run.id;
}
const gh: GhRunner = async (args, _signal, _stdin, _repo, guard) => {
  guard?.();
  calls.push(args);
  return args[1] === "user" ? '{"login":"owner"}' : args.includes("POST") ? '{"id":71}' : "[]";
};
const app = async (): Promise<identity.GitHubIdentity> => ({
  kind: "app",
  token: "fake",
  botLogin: "factory[bot]",
});
const poll = (runner = gh, resolver = app, maxCalls?: number) =>
  reconcileIssueLifecycle(store, cfg, runner, new AbortController().signal, () => {}, {
    identity: resolver,
    maxCalls,
  });
const effects = (id: string) => store.issueLifecycleEffects(id, "owner/repo", 7);
const lose = (id: string) => mapClaimInterruption(store, id, new ClaimLostError(), 99);
function settle(id: string, task: "comment" | "labels" = "comment") {
  store.setIssueLifecycleEffect(
    id,
    "owner/repo",
    7,
    task === "comment" ? "labels" : "comment:started",
    task === "comment" ? "limitless:in-progress" : "done",
  );
}
function notifier(runner = gh, managed = false) {
  const stop = startGitHubNotifier(
    store,
    runner,
    () => {},
    async () => null,
    cfg.paths.configDir,
    [],
    managed ? cfg : {},
  );
  restores.push(() => {
    void stop();
  });
  return stop;
}

test("the predicate is exact and the observer guard composes caller authorization first", () => {
  expect(isClaimLossProjection({ status: "cancelled", error: "superseded: claim lost" })).toBe(true);
  for (const error of ["cancelled by owner", "superseded: other", "superseded: claim lost ", null])
    expect(isClaimLossProjection({ status: "cancelled", error })).toBe(false);
  expect(isClaimLossProjection({ status: "failed", error: "superseded: claim lost" })).toBe(false);
  const id = fixture();
  const error = new Error("caller refused");
  const guard = observerDispatchGuard(store, id, () => {
    throw error;
  });
  lose(id);
  expect(guard).toThrow(error);
  expect(observerDispatchGuard(store, id)).toThrow(ClaimObserverSuppressed);
});

test.each(["managed", "unmanaged", "PR"])(
  "loss suppresses live and reopened %s observers and pending effects",
  async (kind) => {
    const id = fixture(
      kind === "PR" ? "pull_request" : "issue",
      kind === "unmanaged" ? "owner/other" : "owner/repo",
    );
    store.setIssueLifecycleEffect(id, "owner/repo", 7, "comment:questions:1", "recovering", {
      page: 1,
      login: "owner",
      body: "old",
    });
    const before = effects(id);
    const stop = notifier(gh, kind === "managed");
    lose(id);
    await poll();
    await stop();
    expect(calls).toEqual([]);
    expect(effects(id)).toEqual(before);
    store.close();
    store = new Store(join(dir, "store.db"));
    const reopenedStop = notifier(gh, kind === "managed");
    store.updateRun(id, { stage: null });
    await poll();
    await reopenedStop();
    expect(calls).toEqual([]);
    expect(effects(id)).toEqual(before);
  },
);

test.each(["identity", "user", "labels", "failure", "recovery"])(
  "pending observer work stops after deferred %s resolves",
  async (step) => {
    const id = fixture();
    settle(id, step === "labels" || step === "failure" ? "labels" : "comment");
    if (step === "failure") store.updateRun(id, { status: "failed" });
    if (step === "recovery")
      store.setIssueLifecycleEffect(id, "owner/repo", 7, "comment:started", "pending", {
        page: 1,
        login: "owner",
      });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let delayed = false;
    const runner: GhRunner = async (...args) => {
      args[4]?.();
      const path = args[0][1] ?? "";
      if (
        !delayed &&
        ((step === "user" && path === "user") ||
          (step === "labels" && path.includes("/labels?")) ||
          (step === "failure" && path === "graphql") ||
          (step === "recovery" && path.includes("/comments?")))
      ) {
        delayed = true;
        entered.resolve();
        await resume.promise;
        return step === "user"
          ? '{"login":"owner"}'
          : step === "failure"
            ? '{"data":{"repository":{"issue":{"timelineItems":{"totalCount":1}}}}}'
            : "[]";
      }
      return String(await gh(...args));
    };
    const resolver = async () => {
      if (step === "identity") {
        entered.resolve();
        await resume.promise;
      }
      return { kind: "owner" } as const;
    };
    await poll(gh, app, 0); // Leave work pending from an earlier poll.
    const work = poll(runner, resolver);
    await entered.promise;
    // A terminal decision must be recorded independently; the mapper preserves recorded failures.
    store.updateRun(id, { status: "cancelled", error: "superseded: claim lost" });
    const before = effects(id);
    resume.resolve();
    await work;
    expect(calls).toEqual([]);
    expect(effects(id)).toEqual(before);
    await poll();
    expect(calls).toEqual([]);
  },
);

for (const boundary of ["identity", "recovery"] as const) {
  test.each([
    ["notifier", true],
    ["notifier", false],
    ["comment", true],
    ["labels", true],
    ["user", true],
    ["search", true],
    ["failure", true],
  ] as const)(
    `real runGh checks %s (claim lost: %j) at inner ${boundary} without claim scope or signal abort`,
    async (observer, claimLost) => {
      const id = fixture();
      settle(id, observer === "labels" || observer === "failure" ? "labels" : "comment");
      if (observer === "search")
        store.setIssueLifecycleEffect(id, "owner/repo", 7, "comment:started", "pending", {
          page: 1,
          login: "owner",
        });
      if (observer === "failure") store.updateRun(id, { status: "failed" });
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const resolver = spyOn(identity, "githubIdentity").mockImplementation(async () => {
        if (boundary === "identity") {
          entered.resolve();
          await resume.promise;
        }
        return { kind: "owner" };
      });
      const spawn = spyOn(subprocess, "spawn").mockImplementation(() => {
        throw new Error("unexpected subprocess");
      });
      restores.push(
        () => resolver.mockRestore(),
        () => spawn.mockRestore(),
      );
      const signal = new AbortController().signal;
      let request: ReturnType<GhRunner> | undefined;
      let requestSignal: AbortSignal | undefined;
      let stop: (() => Promise<void>) | undefined;
      const start = async () => {
        if (observer === "notifier") {
          stop = notifier((...args) => {
            requestSignal = args[1];
            request = runGh(...args);
            return request;
          });
          store.updateRun(id, { status: "queued" });
        } else
          await reconcileIssueLifecycle(store, cfg, runGh, signal, () => {}, {
            identity: observer === "user" ? async () => ({ kind: "owner" }) : app,
          });
      };
      let work: Promise<void>;
      if (boundary === "recovery") {
        store.recordProcessDiscovery({
          runId: id,
          invocation: "prior",
          directory: process.cwd(),
          boot: "test",
          createdAt: 0,
          discovery: { group: 0, started: 0, directories: [], leader: null, spawnedAt: "0" },
        });
        const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined);
        restores.push(() => sleep.mockRestore());
        work = processBootInspection.run(
          () => "test",
          () =>
            processRecoveryInspection.run(
              {
                stopped: () => true,
                timeoutMs: 10000,
                discover: async () => {
                  entered.resolve();
                  await resume.promise;
                  return [];
                },
              },
              () =>
                processScope.run(
                  {
                    signal,
                    killGraceMs: 10,
                    children: new Map(),
                    scratchDirs: new Set(),
                    runId: id,
                    cleanups: store,
                  },
                  start,
                ),
            ),
        );
      } else work = start();
      await entered.promise;
      if (claimLost) store.updateRun(id, { status: "cancelled", error: "superseded: claim lost" });
      const before = effects(id);
      resume.resolve();
      await work;
      if (stop) {
        // The notifier starts background work; wait for dispatch before stop aborts its signal.
        expect(request).toBeDefined();
        await request?.catch(() => {});
        expect(requestSignal?.aborted).toBe(false);
      }
      expect(signal.aborted).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(claimLost ? 0 : 1);
      expect(effects(id)).toEqual(before);
      if (stop) await stop();
    },
  );
}

test.each(["comment", "labels", "search"] as const)(
  "a dispatched %s keeps its known receipt after loss and starts no further effect",
  async (task) => {
    const id = fixture();
    settle(id, task === "labels" ? "labels" : "comment");
    if (task === "search")
      store.setIssueLifecycleEffect(id, "owner/repo", 7, "comment:started", "pending", {
        page: 1,
        login: "owner",
      });
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const runner: GhRunner = async (...args) => {
      const path = args[0][1] ?? "";
      if (args[0].includes("POST") || (task === "search" && path.includes("/comments?"))) {
        args[4]?.();
        calls.push(args[0]);
        entered.resolve();
        await resume.promise;
        return task === "search"
          ? JSON.stringify([
              { id: 71, user: { login: "owner" }, body: `<!-- limitless-lifecycle:${id}:started -->` },
            ])
          : '{"id":71}';
      }
      return String(await gh(...args));
    };
    const work = poll(runner);
    await entered.promise;
    lose(id);
    resume.resolve();
    await work;
    const receipt = effects(id).find(
      (e) => e.effect === (task === "labels" ? "label:limitless:in-progress:true" : "comment:started"),
    );
    expect(receipt).toMatchObject({ state: "done", ...(task === "labels" ? {} : { commentId: 71 }) });
    const before = effects(id);
    const count = calls.length;
    await poll(runner);
    expect(calls).toHaveLength(count);
    expect(effects(id)).toEqual(before);
  },
);

test("ordinary user cancellation still publishes notifier and lifecycle effects", async () => {
  const id = fixture();
  const stop = notifier();
  store.updateRun(id, { status: "cancelled", error: "cancelled by owner" });
  await stop();
  expect(calls.some((args) => args[0] === "issue" && args.at(-1)?.includes("**cancelled**"))).toBe(true);
  calls = [];
  const runner: GhRunner = async (...args) =>
    args[0][1]?.includes("/labels?") ? '[{"name":"limitless:in-progress"}]' : String(await gh(...args));
  await poll(runner);
  expect(calls.some((args) => args.includes("DELETE") && args[1]?.includes("/labels/"))).toBe(true);
  expect(calls.some((args) => args.includes("POST") && args.at(-1)?.includes("was cancelled"))).toBe(true);
  expect(effects(id).find((e) => e.effect === "comment:cancelled")).toMatchObject({
    state: "done",
    commentId: 71,
  });
});
