import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { CiFailure } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { ClaimLostError } from "../src/integrations/claim-errors.ts";
import { bindClaim } from "../src/integrations/claim-guard.ts";
import type { ObserverAuthority } from "../src/integrations/claim-projection.ts";
import { createClaimClient } from "../src/integrations/claim-ref.ts";
import {
  type GitHubClient,
  type PollerOptions,
  startGitHubPoller,
} from "../src/integrations/github-poller.ts";
import { mountIntegrations } from "../src/integrations/index.ts";
import { createLeaseManager } from "../src/integrations/leases.ts";
import { mapClaimInterruption } from "../src/pipeline/claim-interruption.ts";
import { claimRef } from "../src/pipeline/portable.ts";
import { validateRunClaim } from "../src/pipeline/run-claim.ts";
import { GitHub } from "./claim-github-fake.ts";
import { pollerHarness, respond, SHA, url } from "./github-poller-support.ts";

let h: ReturnType<typeof pollerHarness>;
let cfg: ReturnType<typeof loadConfig>;
let remote: GitHub;
let time: number;
const cleanup: (() => void | Promise<void>)[] = [];
const main = "b".repeat(40);
const checks = (sha: string) => `repos/o/r/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`;
const job = {
  id: 21,
  run_id: 1,
  run_attempt: 1,
  name: "test",
  status: "completed",
  conclusion: "timed_out",
  head_sha: SHA,
  check_run_url: "https://api.github.com/repos/o/r/check-runs/11",
  steps: [],
  started_at: null,
};
beforeEach(() => {
  h = pollerHarness();
  time = 1000;
  remote = new GitHub();
  cfg = loadConfig({
    home: join(h.dir, "home"),
    configDir: join(h.dir, "config"),
    raw: { repos: { "o/r": { shared: true } } },
  });
  cfg.secrets.DISCORD_BOT_TOKEN = "";
  h.factoryPr("o/r", 1);
  h.factoryPr("o/r", 2);
  const head = h.node("o/r", 1).commits.nodes[0];
  if (!head) throw new Error("Missing head");
  head.commit.statusCheckRollup = {
    state: "FAILURE",
    contexts: { nodes: [{ name: "test", status: "COMPLETED", conclusion: "TIMED_OUT" }] },
  };
  const check = {
    id: 11,
    name: "test",
    status: "completed",
    conclusion: "timed_out",
    head_sha: SHA,
    app: { slug: "github-actions" },
    details_url: "https://github.com/o/r/actions/runs/1/job/21",
  };
  h.gh.responses.set(checks(SHA), () => respond(200, { total_count: 1, check_runs: [check] }));
  h.gh.responses.set(checks(main), () =>
    respond(200, {
      total_count: 1,
      check_runs: [{ ...check, id: 12, name: "base-check", head_sha: main, conclusion: "failure" }],
    }),
  );
  h.gh.responses.set("repos/o/r/check-runs/11/annotations?per_page=100&page=1", () => respond(200, []));
  h.gh.responses.set("repos/o/r/actions/jobs/21", () => respond(200, job));
  h.gh.responses.set("repos/o/r/actions/runs/1/attempts/1/jobs?per_page=100&page=1", () =>
    respond(200, { total_count: 1, jobs: [job] }),
  );
  h.gh.responses.set("repos/o/r/actions/jobs/21/rerun", () => respond(201, {}));
});
afterEach(async () => {
  for (const restore of cleanup.splice(0).reverse()) await restore();
  h.close();
});
const row = (prUrl = url("o/r", 1)) => h.store.ciFailures(prUrl, SHA)[0];
const posts = () => h.gh.rest().filter((c) => c.path.endsWith("/rerun"));
const fixes = () => h.store.readFeed({ limit: 1000 }).items.filter((i) => i.kind === "ci.needs_fix");
const unclaimed = (prUrl = url("o/r", 1)) => {
  expect(row(prUrl)).toMatchObject({
    outcome: "failed",
    rerunMarker: null,
    rerunJob: null,
    rerunClaimedAt: null,
  });
  expect(h.store.db.query("SELECT rerun_claimed FROM ci_failures").get()).toEqual({ rerun_claimed: 0 });
  expect(posts()).toHaveLength(0);
  expect(fixes()).toHaveLength(0);
  expect(h.store.failureObservations({ class: "flaky" })).toHaveLength(0);
  expect(JSON.parse(h.store.githubPrData(prUrl) ?? "{}").ciPending).toBe(true);
  expect(h.store.githubPrData(url("o/r", 2))).not.toBeNull();
  expect(h.logs).toEqual([]);
};
const client: GitHubClient = async (path, body, signal, repo, guard) => {
  guard?.();
  return h.gh.client(path, body, signal, repo);
};
function start(authority?: ObserverAuthority, transport = client) {
  const options: PollerOptions = {
    cfg,
    authority,
    client: transport,
    seconds: 15,
    log: (s) => h.logs.push(s),
    clock: {
      now: h.clock.now,
      set: h.clock.timer.set as unknown as typeof setTimeout,
      clear: h.clock.timer.clear as unknown as typeof clearTimeout,
    },
  };
  const stop = startGitHubPoller(h.store, options);
  cleanup.push(stop);
  return stop;
}
async function manager(db = h.store, member = "m-0123456789abcdef") {
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
async function held(kind: "pr" | "issue" = "pr", repo = "o/r", number = 1) {
  const holder = h.store.createRun(h.repo(repo), {
    repo,
    prompt: "holder",
    source: "github",
    sourceRef: { kind: kind === "pr" ? "pull_request" : "issue", repo, number },
  });
  h.store.updateRun(holder.id, { status: "running" });
  const m = await manager();
  const result = await m.leases.acquire(
    repo,
    claimRef({ kind, repo, number }),
    { kind, number, run: holder.id, status: "running" },
    { takeover: false },
  );
  if (result.kind !== "held") throw new Error(`Not held: ${result.kind}`);
  const binding = bindClaim(m.leases, result.handle, () => false);
  const authority: ObserverAuthority = (key) =>
    claimRef(key) === result.handle.ref ? { binding, leases: m.leases } : undefined;
  return { ...m, binding, handle: result.handle, authority, holder };
}
function trackHolder(runId: string) {
  const prUrl = url("o/r", 1);
  const tracked = h.store.githubTracked().find((pr) => pr.url === prUrl);
  if (!tracked?.runId) throw new Error("Missing tracked run");
  h.store.db.query("UPDATE runs SET pr_url = NULL WHERE id = ?").run(tracked.runId);
  h.store.updateRun(runId, { prUrl });
  expect(h.store.githubTracked().find((pr) => pr.url === prUrl)?.runId).toBe(runId);
}
function advanceLease(ms: number) {
  time += ms;
  remote.clock += ms;
}

test("closed PR window keeps reads, main episodes and other PRs; renewal reruns once", async () => {
  const a = await held();
  const reserve = spyOn(h.store, "claimCiRerun");
  cleanup.push(() => reserve.mockRestore());
  advanceLease(420_000);
  start(a.authority);
  await h.advance(0);
  unclaimed();
  expect(reserve).not.toHaveBeenCalled();
  expect(h.gh.rest().map((c) => c.path)).toEqual(
    expect.arrayContaining([
      "repos/o/r/commits/main",
      checks(main),
      checks(SHA),
      "repos/o/r/actions/jobs/21",
      "repos/o/r/pulls/1",
      "repos/o/r/pulls/2",
    ]),
  );
  expect(h.store.getSetting("ci.main:o/r", {})).toEqual({ "base-check": { red: true, episode: 1 } });
  expect(await a.leases.update(a.handle, {})).toBe("applied");
  await h.advance(15_000);
  expect(posts()).toHaveLength(1);
  expect(row()?.outcome).toBe("rerunning");
});

test("dispatch refusal releases synchronously before propagating and cannot age into a fix", async () => {
  const a = await held();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let captured: CiFailure | undefined;
  let claimed: unknown;
  start(a.authority, async (path, body, signal, repo, guard) => {
    if (path.endsWith("/rerun")) {
      entered.resolve();
      await resume.promise;
      try {
        guard?.();
      } catch (error) {
        captured = row();
        claimed = h.store.db.query("SELECT rerun_claimed FROM ci_failures").get();
        throw error;
      }
    } else guard?.();
    return h.gh.client(path, body, signal, repo);
  });
  await h.advance(0);
  await entered.promise;
  expect(row()?.outcome).toBe("rerun_requested");
  advanceLease(420_000);
  resume.resolve();
  await h.advance(0);
  expect(captured).toMatchObject({
    outcome: "failed",
    rerunMarker: null,
    rerunJob: null,
    rerunClaimedAt: null,
  });
  expect(claimed).toEqual({ rerun_claimed: 0 });
  unclaimed();
  await h.advance(601_000);
  unclaimed();
  expect(await a.leases.update(a.handle, {})).toBe("applied");
  await h.advance(15_000);
  expect(posts()).toHaveLength(1);
  expect(row()?.outcome).toBe("rerunning");
});

test("a refused rerun still classifies the remaining failures", async () => {
  const original = h.gh.responses.get(checks(SHA));
  if (!original) throw new Error("Missing checks response");
  h.gh.responses.set(checks(SHA), async () => {
    const body = (await original()).body as { check_runs: unknown[] };
    return respond(200, {
      total_count: 2,
      check_runs: [
        ...body.check_runs,
        { id: 13, name: "lint", head_sha: SHA, status: "completed", conclusion: "failure" },
      ],
    });
  });
  start();
  await h.advance(0);
  expect(posts()).toHaveLength(0);
  expect(fixes()).toHaveLength(1);
  expect(row()?.outcome).toBe("failed");
  expect(JSON.parse(h.store.githubPrData(url("o/r", 1)) ?? "{}").ciPending).toBe(true);
  expect(h.logs).toEqual([]);
});

test.each([
  { kind: "issue", repo: "o/r", number: 1 },
  { kind: "pr", repo: "o/r", number: 3 },
  { kind: "pr", repo: "o/other", number: 1 },
] as const)("PR authority refuses a valid binding for $kind $repo#$number", async (key) => {
  const a = await held(key.kind, key.repo, key.number);
  if (key.kind === "issue") trackHolder(a.holder.id);
  const holder = h.store.getRun(a.holder.id);
  if (!holder) throw new Error("Missing holder");
  const authority = mock(() => ({ binding: a.binding, leases: a.leases }));
  validateRunClaim(holder, h.store, a);
  expect(holder.status).toBe("running");
  expect(holder.error).toBeNull();
  expect(a.binding.cancelled()).toBe(false);
  expect(a.binding.lost).toBe(false);
  expect(a.binding.windowOpen()).toBe(true);
  start(authority);
  await h.advance(0);
  expect(authority).toHaveBeenCalledWith({ kind: "pr", repo: "o/r", number: 1 });
  unclaimed();
});

test.each(["issue only", "cancelled", "terminal"])("PR authority refuses %s", async (mode) => {
  const a = await held(mode === "issue only" ? "issue" : "pr");
  if (mode === "issue only") trackHolder(a.holder.id);
  if (mode === "cancelled") h.store.updateRun(a.holder.id, { error: "cancelled by operator" });
  if (mode === "terminal") h.store.updateRun(a.holder.id, { status: "succeeded" });
  start(a.authority);
  await h.advance(0);
  unclaimed();
});

test.each(["latched binding", "cold start"])(
  "lost PR generation and projected loss survive store reopen: %s",
  async (mode) => {
    const a = await held();
    const other = new Store(":memory:");
    cleanup.push(() => other.close());
    advanceLease(602_000);
    const b = await manager(other, "m-fedcba9876543210");
    expect(
      (
        await b.leases.acquire(
          "o/r",
          a.handle.ref,
          { kind: "pr", number: 1, run: a.holder.id, status: "running" },
          { takeover: true },
        )
      ).kind,
    ).toBe("held");
    cleanup.push(a.leases.start({ active: () => true, onLost: a.binding.onLost }));
    await a.tick();
    expect(a.binding.lost).toBe(true);
    const stop = start(a.authority);
    await h.advance(0);
    unclaimed();
    mapClaimInterruption(h.store, a.holder.id, new ClaimLostError());
    stop();
    h.reopen();
    start(mode === "cold start" ? () => undefined : a.authority);
    await h.advance(0);
    unclaimed();
  },
);

test.each(["resolver", "malformed", "store"])("%s failure pauses only reruns", async (mode) => {
  const a = await held();
  let authority = a.authority;
  if (mode === "resolver")
    authority = () => {
      throw new Error("resolver failed");
    };
  if (mode === "store") {
    const read = h.store.getRun.bind(h.store);
    const spy = spyOn(h.store, "getRun").mockImplementation((id) => {
      if (id === a.holder.id) throw new Error("store failed");
      return read(id);
    });
    cleanup.push(() => spy.mockRestore());
  }
  if (mode === "malformed") {
    // The store filters malformed URLs; inject a tracked row to exercise the poller's boundary.
    const pr = h.store.githubTracked().find((p) => p.url === url("o/r", 1));
    if (!pr) throw new Error("Missing tracked PR");
    h.store.saveGithubPr({ ...pr, nodeId: h.node("o/r", 1).id });
    const tracked = h.store.githubTracked.bind(h.store);
    const spy = spyOn(h.store, "githubTracked").mockImplementation((...args) =>
      tracked(...args).map((p) => (p.url === pr.url ? { ...p, url: `${p.url}bad` } : p)),
    );
    cleanup.push(() => spy.mockRestore());
    h.gh.responses.set("repos/o/r/pulls/1bad", () => respond(200, { head: { sha: SHA }, state: "open" }));
  }
  start(authority);
  await h.advance(0);
  unclaimed(mode === "malformed" ? `${url("o/r", 1)}bad` : undefined);
});

test.each([true, false])("mount wires shared poller authority (supplied: %s)", async (supplied) => {
  const a = await held();
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(
    h.clock.timer.set as unknown as typeof setTimeout,
  );
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(
    h.clock.timer.clear as unknown as typeof clearTimeout,
  );
  cleanup.push(
    () => timers.mockRestore(),
    () => clear.mockRestore(),
  );
  const mounted = await mountIntegrations(new Factory(cfg, { store: h.store }), {
    github: client,
    authority: supplied ? a.authority : undefined,
    gh: async () => "[]",
    prClient: async () => null,
    toolVersions: async () => [],
  });
  cleanup.push(mounted.stop);
  await h.advance(0);
  expect(posts()).toHaveLength(supplied ? 1 : 0);
  expect(row()?.outcome).toBe(supplied ? "rerunning" : "failed");
});

test("local poller reruns without authority", async () => {
  cfg.repos = {};
  start();
  await h.advance(0);
  expect(posts()).toHaveLength(1);
  expect(row()?.outcome).toBe("rerunning");
});

test.each(["rerunning", "rerun_rejected"] as const)(
  "release is conditional, idempotent and preserves %s",
  async (outcome) => {
    start();
    await h.advance(0);
    const failure = row();
    if (!failure) throw new Error("Missing failure");
    const reservation = { ...failure, rerunMarker: "marker" };
    const origin = { id: 21, runId: 1, attempt: 1, name: "test" };
    const evidence = {
      tests: [{ file: "a.test.ts", identity: "a" }],
      main: { sha: main, run: 2, attempt: 1, job: 22 },
      artifacts: [1],
      mainArtifacts: [2],
    };
    const reserve = () => {
      expect(h.store.claimCiRerun(failure, "marker", origin)).toBe(true);
      h.store.observations.ciFlaky("o/r", null, failure, job, evidence, "failure");
    };
    reserve();
    const requested = row();
    expect(h.store.releaseCiRerun({ ...reservation, rerunMarker: "wrong" })).toBe(false);
    expect(row()).toEqual(requested);
    expect(h.store.releaseCiRerun(reservation)).toBe(true);
    expect(row()).toMatchObject({
      outcome: "failed",
      rerunMarker: null,
      rerunJob: null,
      rerunClaimedAt: null,
    });
    expect(h.store.db.query("SELECT rerun_claimed FROM ci_failures").get()).toEqual({ rerun_claimed: 0 });
    expect(h.store.releaseCiRerun(reservation)).toBe(false);
    reserve();
    expect(h.store.failureObservations({ class: "flaky" })).toHaveLength(1);
    expect(h.store.transitionCiRerun(reservation, outcome)).toBe(true);
    const before = row();
    expect(h.store.releaseCiRerun(reservation)).toBe(false);
    expect(row()).toEqual(before);
  },
);
