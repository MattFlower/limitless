import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as subprocess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { bindClaim, claimScope, hasClaimScope } from "../src/integrations/claim-guard.ts";
import {
  ClaimObserverSuppressed,
  type ObserverAuthority,
  observerClaimGuard,
} from "../src/integrations/claim-projection.ts";
import { createClaimClient } from "../src/integrations/claim-ref.ts";
import { type GhRunner, runGh } from "../src/integrations/github.ts";
import * as identity from "../src/integrations/github-identity.ts";
import { startGitHubNotifier } from "../src/integrations/github-notifier.ts";
import {
  type GitHubClient,
  ghClient,
  guardGitHubClient,
  startGitHubPoller,
} from "../src/integrations/github-poller.ts";
import * as token from "../src/integrations/github-token.ts";
import { mountIntegrations } from "../src/integrations/index.ts";
import { type IssueLifecycleOptions, reconcileIssueLifecycle } from "../src/integrations/issue-lifecycle.ts";
import { createLeaseManager } from "../src/integrations/leases.ts";
import { mapClaimInterruption } from "../src/pipeline/claim-interruption.ts";
import { claimKey, claimRef } from "../src/pipeline/portable.ts";
import { GitHub } from "./claim-github-fake.ts";
import { prNode } from "./github-poller-support.ts";
import { waitClock } from "./wait-clock.ts";

let dir: string;
let store: Store;
let cfg: ReturnType<typeof loadConfig>;
let calls: string[][];
let currentLabels: string[];
let logs: string[];
let time: number;
let remote: GitHub;
const cleanup: (() => void | Promise<void>)[] = [];
const app = { kind: "app", token: "fake", botLogin: "factory[bot]" } as const;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "observer-claim-"));
  store = new Store(join(dir, "store.db"));
  cfg = loadConfig({
    home: join(dir, "data"),
    configDir: join(dir, "config"),
    raw: {
      repos: { "owner/repo": { shared: true } },
      github: { poll: false, queue: { repos: ["owner/repo", "owner/local"], trusted: ["owner"] } },
    },
  });
  calls = [];
  currentLabels = [];
  logs = [];
  time = 1_000;
  remote = new GitHub();
});
afterEach(async () => {
  for (const restore of cleanup.splice(0).reverse()) await restore();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
function fixture(slug = "owner/repo", number = 7, source: "github" | "cli" = "github") {
  const repo = store.upsertRepo({
    slug,
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, {
    repo: slug,
    prompt: source === "cli" ? "Closes #7\nCloses #8" : "work",
    source,
    sourceRef: source === "cli" ? undefined : { kind: "issue", repo: slug, number },
  });
  store.updateRun(run.id, { status: "running" });
  return run;
}
const effects = (run: ReturnType<typeof fixture>) => store.issueLifecycleEffects(run.id, run.repoSlug, 7);
const effect = (run: ReturnType<typeof fixture>, name = "comment:started") =>
  effects(run).find((e) => e.effect === name);
function settled(run: ReturnType<typeof fixture>, task = "comment") {
  store.setIssueLifecycleEffect(
    run.id,
    run.repoSlug,
    7,
    task === "comment" ? "labels" : "comment:started",
    task === "comment" ? "limitless:in-progress" : "done",
  );
}
const gh: GhRunner = async (args, _signal, _stdin, _repo, guard) => {
  guard?.();
  calls.push(args);
  if (args[1] === "--include")
    return `HTTP/2 200 OK\r\nDate: ${new Date(remote.clock).toUTCString()}\r\n\r\n{}`;
  if (args[1]?.includes("/labels?")) return JSON.stringify(currentLabels.map((name) => ({ name })));
  return args.includes("POST") ? '{"id":71}' : "[]";
};
const poll = (authority?: ObserverAuthority, opts: IssueLifecycleOptions = {}, runner = gh) =>
  reconcileIssueLifecycle(store, cfg, runner, new AbortController().signal, (s) => logs.push(s), {
    identity: async () => app,
    authority,
    ...opts,
  });
async function manager(db = store, member = "m-0123456789abcdef") {
  let tick: (() => unknown) | undefined;
  const leases = await createLeaseManager({
    store: db,
    member,
    client: createClaimClient({ gh: remote.gh, sample: () => ({ inclusive: time, exclusive: time }) }),
    clock: { sample: () => ({ inclusive: time, exclusive: time }) },
    gh: async () => `HTTP/2 200 OK\r\nDate: ${new Date(remote.clock).toUTCString()}\r\n\r\n{}`,
    timer: {
      set: ((fn: () => unknown) => {
        tick = fn;
        return 1;
      }) as unknown as typeof setInterval,
      clear: () => {},
    },
  });
  return {
    leases,
    tick: async () => {
      await tick?.();
    },
  };
}
async function held(run: ReturnType<typeof fixture>, cancelled = () => false) {
  const m = await manager();
  const key = claimKey(run, store);
  if ("none" in key || key.kind !== "issue") throw new Error("Expected issue key");
  const result = await m.leases.acquire(
    run.repoSlug,
    claimRef(key),
    {
      kind: "issue",
      number: key.number,
      run: run.id,
      status: "running",
    },
    { takeover: false },
  );
  if (result.kind !== "held") throw new Error(`Expected held: ${result.kind}`);
  const binding = bindClaim(m.leases, result.handle, cancelled);
  const authority: ObserverAuthority = (k) =>
    claimRef(k) === result.handle.ref ? { binding, leases: m.leases } : undefined;
  return { ...m, binding, handle: result.handle, authority };
}
function advance(ms: number) {
  time += ms;
  remote.clock += ms;
}

test("pre-check refuses without budget, markers or logs; renewal delivers once without searching", async () => {
  const run = fixture();
  const a = await held(run);
  const local = fixture("owner/local");
  settled(local);
  advance(420_000);
  await poll(a.authority, { maxCalls: 1 });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[1]).toContain("owner/local");
  expect(effect(local)).toMatchObject({ state: "done", commentId: 71 });
  expect(effect(run)).toMatchObject({ state: "pending", page: 0, login: app.botLogin, commentId: null });
  expect(effect(run)?.body).toBe(
    `<!-- limitless-lifecycle:${run.id}:started -->\nLimitless run ${run.id} started: see ${cfg.uiUrl}/runs/${run.id}.`,
  );
  expect(effects(run).filter((e) => e.effect.startsWith("label:") && e.state === "done")).toEqual([]);
  expect(logs).toEqual([]);
  expect(await a.leases.update(a.handle, {})).toBe("applied");
  calls = [];
  await poll(a.authority);
  expect(calls.filter((c) => c[1]?.includes("/comments?")).length).toBe(0);
  expect(calls.filter((c) => c[1]?.endsWith("/comments") && c.includes("POST"))).toHaveLength(1);
  expect(calls.filter((c) => c.includes("labels[]=limitless:in-progress"))).toHaveLength(1);
  expect(effect(run)).toMatchObject({ state: "done", commentId: 71 });
});

test.each(["comment", "labels", "failure"])(
  "final dispatch refuses %s and recovers its checkpoint",
  async (task) => {
    const run = fixture();
    settled(run, task);
    const a = await held(run);
    if (task === "failure") {
      currentLabels = ["limitless:failed"];
      store.updateRun(run.id, { status: "failed" });
      store.setIssueLifecycleEffect(run.id, run.repoSlug, 7, "comment:failed", "done");
      store.setIssueLifecycleEffect(run.id, run.repoSlug, 7, "failure", "removing", { body: "1" });
    }
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const resolver = spyOn(identity, "githubIdentity").mockImplementation(async () => {
      entered.resolve();
      await resume.promise;
      return { kind: "owner" };
    });
    const spawn = spyOn(subprocess, "spawn").mockImplementation(() => {
      throw new Error("Unexpected spawn");
    });
    cleanup.push(
      () => resolver.mockRestore(),
      () => spawn.mockRestore(),
    );
    const runner: GhRunner = (...args) =>
      args[0].includes("POST") || args[0].includes("DELETE") ? runGh(...args) : gh(...args);
    const work = poll(a.authority, {}, runner);
    await entered.promise;
    advance(420_000);
    resume.resolve();
    await work;
    expect(spawn).toHaveBeenCalledTimes(0);
    expect(logs).toEqual([]);
    expect(
      effect(
        run,
        task === "comment"
          ? "comment:started"
          : task === "labels"
            ? "label:limitless:in-progress:true"
            : "failure",
      ),
    ).toMatchObject(
      task === "comment"
        ? { state: "pending", page: 1, commentId: null, login: app.botLogin }
        : { state: task === "failure" ? "removing" : "pending" },
    );
    expect(await a.leases.update(a.handle, {})).toBe("applied");
    calls = [];
    await poll(a.authority);
    if (task === "comment") {
      expect(calls.map((c) => c[1])).toEqual([
        "repos/owner/repo/issues/7/comments?per_page=100&page=1",
        "repos/owner/repo/issues/7/comments",
      ]);
      expect(effect(run)).toMatchObject({ state: "done", commentId: 71 });
    } else if (task === "labels") {
      expect(calls[0]?.[1]).toContain("/labels?");
      expect(calls.filter((c) => c.includes("POST"))).toHaveLength(1);
    } else {
      expect(calls.filter((c) => c.includes("DELETE"))).toHaveLength(1);
      expect(effect(run, "failure")?.state).toBe("done");
    }
  },
);

test("latched generation loss and restart preserve pending effects without receipts", async () => {
  const run = fixture();
  settled(run);
  const a = await held(run);
  await poll(a.authority, { maxCalls: 0 });
  store.setIssueLifecycleEffect(run.id, run.repoSlug, 7, "comment:started", "pending", {
    login: app.botLogin,
  });
  const before = effects(run);
  const other = new Store(":memory:");
  cleanup.push(() => other.close());
  advance(602_000);
  const b = await manager(other, "m-fedcba9876543210");
  const acquired = await b.leases.acquire(
    run.repoSlug,
    a.handle.ref,
    { kind: "issue", number: 7, run: run.id, status: "running" },
    { takeover: true },
  );
  expect(acquired.kind).toBe("held");
  cleanup.push(a.leases.start({ active: () => true, onLost: a.binding.onLost }));
  await a.tick();
  expect(a.binding.lost).toBe(true);
  await poll(a.authority);
  expect(calls).toEqual([]);
  expect(effects(run)).toEqual(before);
  mapClaimInterruption(store, run.id, new ClaimLostError());
  store.close();
  store = new Store(join(dir, "store.db"));
  await manager();
  await poll(() => undefined);
  expect(calls).toEqual([]);
  expect(effects(run)).toEqual(before);
  // Also fail closed for an older, unprojected run after restarting with no binding.
  store.updateRun(run.id, { status: "running", error: null });
  await poll(() => undefined);
  expect(calls).toEqual([]);
  expect(effects(run)).toEqual(before);
});

test.each(["missing", "run", "ref", "resolver", "store"])(
  "shared %s authority failures are quiet and contained",
  async (mode) => {
    const run = fixture();
    settled(run);
    const a = await held(run);
    const local = fixture("owner/local");
    settled(local);
    await poll(a.authority, { maxCalls: 0 });
    store.setIssueLifecycleEffect(run.id, run.repoSlug, 7, "comment:started", "pending", {
      login: app.botLogin,
    });
    const before = effects(run);
    let authority: ObserverAuthority = a.authority;
    if (mode === "missing") authority = () => undefined;
    if (mode === "resolver")
      authority = () => {
        throw new Error("resolver failed");
      };
    if (mode === "run" || mode === "ref")
      authority = () => ({
        leases: a.leases,
        binding: { ...a.binding, handle: { ...a.handle, [mode]: "wrong" } },
      });
    if (mode === "store") {
      const read = store.getRun.bind(store);
      const runner: GhRunner = (...args) => {
        const spy = spyOn(store, "getRun").mockImplementation((id) => {
          if (id === run.id) {
            spy.mockRestore();
            throw new Error("store failed");
          }
          return read(id);
        });
        cleanup.push(() => spy.mockRestore());
        return gh(...args);
      };
      await poll(authority, {}, runner);
    }
    if (mode !== "store") await poll(authority);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toContain("owner/local");
    expect(effects(run)).toEqual(
      before.map((e) => (mode === "store" && e.effect === "comment:started" ? { ...e, page: 1 } : e)),
    );
    expect(logs).toEqual([]);
  },
);

test("shared guard normalizes read failures; local path keeps original errors and reads", () => {
  const run = fixture();
  const local = fixture("owner/local");
  const error = new Error("read failed");
  const resolver = mock(() => {
    throw new Error("must not resolve");
  });
  const read = spyOn(store, "getRun").mockImplementation(() => {
    throw error;
  });
  const repo = spyOn(store, "getRepoBySlug");
  cleanup.push(
    () => read.mockRestore(),
    () => repo.mockRestore(),
  );
  expect(observerClaimGuard(store, cfg, run, resolver)).toThrow(new ClaimWaitError("unavailable"));
  repo.mockClear();
  read.mockClear();
  expect(observerClaimGuard(store, cfg, local, resolver)).toThrow(error);
  expect(read).toHaveBeenCalledTimes(1);
  expect(repo).not.toHaveBeenCalled();
  expect(resolver).not.toHaveBeenCalled();
});

test.each(["missing run", "missing repo", "repo read", "key derivation", "several issues"])(
  "shared guard fails closed for %s",
  (mode) => {
    const run = fixture("owner/repo", 7, mode === "several issues" ? "cli" : "github");
    const read =
      mode === "missing run"
        ? spyOn(store, "getRun").mockReturnValue(null)
        : mode === "missing repo"
          ? spyOn(store, "getRepoBySlug").mockReturnValue(null)
          : mode === "repo read"
            ? spyOn(store, "getRepoBySlug").mockImplementation(() => {
                throw new Error("read failed");
              })
            : mode === "key derivation"
              ? spyOn(store, "reviewRound").mockImplementation(() => {
                  throw new Error("key failed");
                })
              : null;
    if (read) cleanup.push(() => read.mockRestore());
    const resolver = mock(() => undefined);
    expect(observerClaimGuard(store, cfg, run, resolver)).toThrow(new ClaimWaitError("unavailable"));
    expect(resolver).not.toHaveBeenCalled();
  },
);

test("shared projection suppression precedes authority; configured local-kind repos use projection only", () => {
  const run = fixture();
  const resolver = mock(() => undefined);
  mapClaimInterruption(store, run.id, new ClaimLostError());
  expect(observerClaimGuard(store, cfg, run, resolver)).toThrow(ClaimObserverSuppressed);
  expect(resolver).not.toHaveBeenCalled();
  store.upsertRepo({
    slug: run.repoSlug,
    kind: "local",
    url: null,
    localPath: dir,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  store.updateRun(run.id, { status: "running", error: null });
  observerClaimGuard(store, cfg, run, resolver)();
  expect(resolver).not.toHaveBeenCalled();
});

test("local lifecycle read errors retain publication log and pending checkpoint", async () => {
  const run = fixture("owner/local");
  settled(run);
  const read = store.getRun.bind(store);
  const runner: GhRunner = (...args) => {
    const spy = spyOn(store, "getRun").mockImplementation((id) => {
      if (id === run.id) {
        spy.mockRestore();
        throw new Error("read failed");
      }
      return read(id);
    });
    cleanup.push(() => spy.mockRestore());
    return gh(...args);
  };
  const resolver = mock(() => undefined);
  await poll(resolver, {}, runner);
  expect(calls).toEqual([]);
  expect(logs).toEqual(["Issue lifecycle: publication-failed"]);
  expect(effect(run)).toMatchObject({ state: "pending", page: 1, commentId: null });
  expect(resolver).not.toHaveBeenCalled();
});

test("terminal reporting ignores the binding cancellation probe and removes labels", async () => {
  const run = fixture();
  const cancelled = mock(() => true);
  const a = await held(run, cancelled);
  store.updateRun(run.id, { status: "cancelled", error: "cancelled by owner" });
  currentLabels = ["limitless:in-progress"];
  await poll(a.authority);
  expect(calls.filter((c) => c.includes("DELETE"))).toHaveLength(1);
  expect(calls.some((c) => c.at(-1)?.includes("was cancelled"))).toBe(true);
  expect(effect(run, "comment:cancelled")).toMatchObject({ state: "done", commentId: 71 });
  expect(cancelled).not.toHaveBeenCalled();
});

test("subscribers and their microtasks and timers exit closed writer scopes", async () => {
  const run = fixture();
  const a = await held(run);
  advance(420_000);
  const seen: boolean[] = [];
  const timer = Promise.withResolvers<void>();
  cleanup.push(
    store.subscribe((msg) => {
      if (msg.kind !== "run") return;
      seen.push(hasClaimScope());
      queueMicrotask(() => seen.push(hasClaimScope()));
      setTimeout(() => {
        seen.push(hasClaimScope());
        timer.resolve();
      }, 0);
    }),
  );
  claimScope.run([a.binding], () => store.updateRun(run.id, { status: "cancelled" }));
  await timer.promise;
  expect(seen).toEqual([false, false, false]);
});

test("subscriber poller timers and terminal notifier dispatch outside the previous run's scope", async () => {
  const run = fixture("owner/local");
  const a = await held(fixture());
  advance(420_000);
  const clock = waitClock();
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ data: { nodes: [prNode(run.repoSlug, 9)] } }),
  );
  const identitySpy = spyOn(identity, "githubIdentity").mockResolvedValue(app);
  const spawn = spyOn(subprocess, "spawn").mockImplementation(() => {
    throw new Error("spied spawn");
  });
  cleanup.push(
    () => fetchSpy.mockRestore(),
    () => identitySpy.mockRestore(),
    () => spawn.mockRestore(),
  );
  cleanup.push(
    startGitHubPoller(store, {
      client: ghClient,
      ciReruns: false,
      log: () => {},
      gh,
      clock: {
        now: clock.now,
        set: clock.timer.set as unknown as typeof setTimeout,
        clear: clock.timer.clear,
      },
    }),
  );
  cleanup.push(
    startGitHubNotifier(
      store,
      runGh,
      () => {},
      async () => null,
      cfg.paths.configDir,
      [],
      {},
    ),
  );
  claimScope.run([a.binding], () =>
    store.updateRun(run.id, {
      status: "succeeded",
      prUrl: `https://github.com/${run.repoSlug}/pull/9`,
    }),
  );
  await clock.advance(0);
  await setImmediate();
  expect(fetchSpy).toHaveBeenCalled();
  expect(spawn).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
  "shared notifier sends no created or terminal comments (authority held: %s)",
  async (authorized) => {
    const run = fixture();
    if (authorized) await held(run);
    const local = fixture("owner/local");
    cleanup.push(
      startGitHubNotifier(
        store,
        gh,
        () => {},
        async () => null,
        cfg.paths.configDir,
        [],
        { repos: cfg.repos },
      ),
    );
    for (const status of ["queued", "cancelled"] as const) {
      store.updateRun(run.id, { status });
      store.updateRun(local.id, { status });
    }
    await setImmediate();
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.includes("owner/local"))).toBe(true);
  },
);

test.each(["native", "injected"])("%s client guards after deferred token resolution", async (kind) => {
  const run = fixture();
  const a = await held(run);
  const identitySpy = spyOn(identity, "githubIdentity").mockResolvedValue({ kind: "owner" });
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  cleanup.push(
    () => identitySpy.mockRestore(),
    () => fetchSpy.mockRestore(),
  );
  for (const mode of ["scope", "supplied"] as const) {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<string>();
    const tokenSpy = spyOn(token, "githubToken").mockImplementation(() => {
      entered.resolve();
      return resume.promise;
    });
    let sent = 0;
    let allowed = true;
    const injected: GitHubClient = async (_path, _body, _signal, _repo, guard) => {
      await token.githubToken();
      guard?.();
      sent++;
      return { status: 200, headers: new Headers(), body: {} };
    };
    const client = kind === "native" ? ghClient : guardGitHubClient(injected);
    const request = claimScope.run(mode === "scope" ? [a.binding] : [], () =>
      client("repos/owner/repo/pulls/7", undefined, undefined, run.repoSlug, () => {
        if (!allowed) throw new ClaimWaitError("unavailable");
      }),
    );
    const outcome = request.then(
      () => null,
      (error) => error,
    );
    await entered.promise;
    if (mode === "scope") advance(420_000);
    else allowed = false;
    resume.resolve("fake");
    expect(await outcome).toBeInstanceOf(ClaimWaitError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sent).toBe(0);
    tokenSpy.mockRestore();
    expect(await a.leases.update(a.handle, {})).toBe("applied");
  }
});

test.each([false, true])("mounted lifecycle forwards authority (window open: %s)", async (open) => {
  const run = fixture();
  settled(run);
  const a = await held(run);
  if (!open) advance(420_000);
  cfg.secrets.DISCORD_BOT_TOKEN = "";
  const factory = new Factory(cfg, { store });
  const clock = waitClock();
  const identitySpy = spyOn(identity, "githubIdentity").mockResolvedValue(app);
  cleanup.push(() => identitySpy.mockRestore());
  const integrations = await mountIntegrations(factory, {
    gh,
    prClient: async () => null,
    toolVersions: async () => [],
    authority: a.authority,
    issueClock: {
      now: clock.now,
      set: clock.timer.set as unknown as typeof setTimeout,
      clear: clock.timer.clear,
    },
  });
  cleanup.push(integrations.stop);
  await clock.advance(0);
  await setImmediate();
  expect(calls.filter((c) => c.includes("POST") && c[1]?.endsWith("/comments"))).toHaveLength(open ? 1 : 0);
  if (open) expect(effect(run)).toMatchObject({ state: "done", commentId: 71 });
});
