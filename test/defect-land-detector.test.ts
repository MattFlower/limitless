import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import { loadConfig, repoSettings } from "../src/config.ts";
import type { FailureObservation } from "../src/db/failure-observations.ts";
import { Store } from "../src/db/store.ts";
import { detectLandDefects, mountDefectWindow } from "../src/integrations/defect-land-detector.ts";
import { createDefectReporter, type DefectGitHub } from "../src/integrations/defect-reporter.ts";
import { type IntegrationDeps, mountIntegrations } from "../src/integrations/index.ts";
import { registerCredential } from "../src/util/proc.ts";
import { waitClock } from "./wait-clock.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const app = { kind: "app", botLogin: "factory[bot]", token: "fake-token" } as const;
type Class = NonNullable<FailureObservation["class"]>;

function harness(kind: "local" | "github" = "github") {
  const dir = mkdtempSync(join(tmpdir(), "defect-land-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "store.sqlite");
  let store = new Store(path);
  cleanups.push(() => store.close());
  const cfg = loadConfig({ home: dir, configDir: dir, readOnly: true, raw: {} });
  const source = store.upsertRepo({
    id: "source",
    slug: "example/product",
    kind,
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(source, { repo: source.slug, prompt: "context" });
  const entry = store.createLandEntry({
    repo: source.slug,
    runId: run.id,
    prUrl: `https://github.com/${source.slug}/pull/7`,
    baseBranch: "main",
    headBranch: "change/test",
    approvedSha: "a".repeat(40),
  });
  store.db.query("UPDATE land_entries SET attempts=1 WHERE id=?").run(entry.id);
  const posts: Parameters<DefectGitHub["post"]>[] = [];
  const objects: unknown[] = [];
  const github: DefectGitHub = {
    list: async () => objects,
    issue: async () => objects[0],
    label: async () => true,
    post: async (...args) => {
      posts.push(args);
      const object = {
        number: posts.length,
        body: args[2].body,
        createdAt: "2026-10-31T18:00:00Z",
        author: { login: app.botLogin, type: "Bot" },
        lastEditedAt: null,
        includesCreatedEdit: false,
        labels: [{ name: "defect" }],
      };
      objects.push(object);
      return object;
    },
  };
  let active = true;
  let now = 100;
  const diagnostics: string[] = [];
  const deps = () => ({
    repos: store.listRepos(),
    factory: "example/factory",
    github,
    identity: async () => app,
    policy: (repo: string | typeof source) => repoSettings(cfg, typeof repo === "string" ? repo : repo.slug),
    loadPrivateStrings: () => [],
    coordinator: () => ({ enabled: active }),
    now: () => now,
  });
  const reporter = () => createDefectReporter(store, deps());
  let seq = 0;
  const seed = (cls: Class | null = "setup", at = now, extra: Partial<FailureObservation> = {}) => {
    const name = `check-${++seq}`;
    store.observations.insert({
      run_id: `land:${entry.id}`,
      repo: source.slug,
      stage_id: 0,
      round: 1,
      sha: "a".repeat(40),
      handle_kind: "land",
      handle_id: `${entry.id}:1`,
      phase: "setup",
      name,
      command: "private-command",
      location: "private-location",
      os: "darwin",
      load_per_core: 1,
      observed_at: 1,
      exit_code: 127,
      timed_out: 0,
      confinement: 0,
      duration_ms: 1,
      failed_files: "[]",
      output_tail: "private-output",
      signature: "same",
      setup_eligible: 0,
      purpose: "land",
      ...extra,
    });
    const id = store.db
      .query<{ id: number }, [string]>("SELECT id FROM failure_observations WHERE name=?")
      .get(extra.name ?? name)?.id;
    if (id === undefined) throw new Error("missing fixture");
    if (cls)
      store.db
        .query(`UPDATE failure_observations SET class=?,history=?,finalized_at=?,interim=? WHERE id=?`)
        .run(cls, extra.history ?? "no_retry", at, extra.interim ?? 0, id);
    return id;
  };
  return {
    get store() {
      return store;
    },
    cfg,
    source,
    entry,
    posts,
    github,
    diagnostics,
    seed,
    reporter,
    enable: (enabled: boolean, at: number) => {
      now = at;
      active = enabled;
      mountDefectWindow(store, enabled, now);
    },
    reopen: () => {
      store.close();
      store = new Store(path);
    },
    scan: () =>
      detectLandDefects(
        store,
        reporter(),
        () => active,
        (d) => diagnostics.push(d),
      ),
    consumed: () =>
      store.db
        .query<{ observation_id: number; status: string }, []>(
          "SELECT observation_id,status FROM defect_observation_consumption ORDER BY observation_id",
        )
        .all(),
    outbox: () =>
      store.db
        .query("SELECT source_key,state,body FROM defect_outbox ORDER BY CAST(source_key AS INTEGER)")
        .all(),
  };
}

test("selects only finalized, in-window, non-interim land rows; consumes ordinary failures without reporting", async () => {
  const h = harness();
  h.enable(true, 100);
  h.seed("setup", 100, { purpose: "initial" });
  h.seed("setup", 100, { purpose: "rebase" });
  h.seed(null);
  h.seed("setup", 100, { interim: 1 });
  h.seed("setup", 99);
  const final = h.seed("setup");
  const recovered = h.seed("flaky", 100, { history: "retry_passed" });
  const regression = h.seed("regression");
  const base = h.seed("base_failure");
  await h.scan();
  expect(h.consumed()).toEqual([
    { observation_id: final, status: "submitted" },
    { observation_id: recovered, status: "submitted" },
    { observation_id: regression, status: "no-report" },
    { observation_id: base, status: "no-report" },
  ]);
  expect(h.reporter().read(h.source.id, String(recovered))?.body).toContain('"history":["retry_passed"]');
  h.store.db.query("UPDATE failure_observations SET class='undeclared_requirement' WHERE id=?").run(final);
  await h.scan();
  expect(h.outbox()).toHaveLength(4);
});

test("late finalization is observed and a checkpoint crash rolls back outbox and consumption together", async () => {
  const h = harness();
  h.enable(true, 100);
  const id = h.seed(null);
  await h.scan();
  expect(h.consumed()).toEqual([]);
  h.store.observations.finalize(`land:${h.entry.id}`, {
    stageId: 0,
    round: 1,
    sha: "a".repeat(40),
    purpose: "land",
    comparisons: [],
  });
  h.store.db.exec(`CREATE TRIGGER crash BEFORE INSERT ON defect_observation_consumption
    BEGIN SELECT RAISE(ABORT, 'checkpoint crash'); END`);
  await expect(h.scan()).rejects.toThrow("checkpoint crash");
  expect(h.outbox()).toEqual([]);
  expect(h.consumed()).toEqual([]);
  h.store.db.exec("DROP TRIGGER crash");
  h.reopen();
  await h.scan();
  await h.scan();
  expect(h.outbox()).toHaveLength(1);
  expect(h.consumed()).toEqual([{ observation_id: id, status: "submitted" }]);
});

test("outbox insert crash leaves the observation pending across restart", async () => {
  const h = harness();
  h.enable(true, 100);
  const id = h.seed();
  h.store.db.exec(`CREATE TRIGGER crash BEFORE INSERT ON defect_outbox
    BEGIN SELECT RAISE(ABORT, 'outbox crash'); END`);
  await expect(h.scan()).rejects.toThrow("outbox crash");
  expect(h.outbox()).toEqual([]);
  expect(h.consumed()).toEqual([]);
  h.store.db.exec("DROP TRIGGER crash");
  h.reopen();
  await h.scan();
  await h.scan();
  expect(h.outbox()).toHaveLength(1);
  expect(h.consumed()).toEqual([{ observation_id: id, status: "submitted" }]);
});

test.each(["round", "foreign run", "missing run", "foreign PR", "malformed PR"])(
  "identity conflict: %s is terminally unresolved before preparation",
  async (conflict) => {
    const h = harness();
    h.enable(true, 100);
    if (conflict === "foreign run") {
      const foreign = h.store.upsertRepo({ ...h.source, id: "foreign", slug: "example/other" });
      const run = h.store.createRun(foreign, { repo: foreign.slug, prompt: "context" });
      h.store.db.query("UPDATE land_entries SET run_id=? WHERE id=?").run(run.id, h.entry.id);
    }
    if (conflict === "missing run")
      h.store.db.query("UPDATE land_entries SET run_id='missing' WHERE id=?").run(h.entry.id);
    if (conflict === "foreign PR" || conflict === "malformed PR")
      h.store.db
        .query("UPDATE land_entries SET pr_url=? WHERE id=?")
        .run(
          conflict === "foreign PR" ? "https://github.com/example/other/pull/7" : "invalid PR",
          h.entry.id,
        );
    const id = h.seed("setup", 100, conflict === "round" ? { round: 2 } : {});
    let preparations = 0;
    const reporter = h.reporter();
    const prepare = reporter.prepareSubmission;
    reporter.prepareSubmission = (...args) => {
      preparations++;
      return prepare(...args);
    };
    const scan = () =>
      detectLandDefects(
        h.store,
        reporter,
        () => true,
        (d) => h.diagnostics.push(d),
      );
    await scan();
    expect(h.consumed()).toEqual([{ observation_id: id, status: "unresolved" }]);
    expect(h.diagnostics).toEqual(["Defect observation identity unresolved"]);
    expect(preparations).toBe(0);
    expect(h.outbox()).toEqual([]);
    await reporter.reconcile();
    expect(h.posts).toEqual([]);
    h.reopen();
    await h.scan();
    await h.reporter().reconcile();
    expect(h.consumed()).toEqual([{ observation_id: id, status: "unresolved" }]);
    expect(h.diagnostics).toEqual(["Defect observation identity unresolved"]);
    expect(h.outbox()).toEqual([]);
    expect(h.posts).toEqual([]);
  },
);

test("matching PR repository casing and an entry without a run remain reportable", async () => {
  const h = harness();
  h.enable(true, 100);
  h.store.db
    .query("UPDATE land_entries SET run_id='', pr_url=? WHERE id=?")
    .run("https://github.com/EXAMPLE/PRODUCT/pull/7", h.entry.id);
  const id = h.seed();
  await h.scan();
  await h.reporter().reconcile();
  expect(h.consumed()).toEqual([{ observation_id: id, status: "submitted" }]);
  expect(h.posts).toHaveLength(1);
});

test("half-open windows survive enabled downtime and exclude disabled finalizations while retaining backlog", async () => {
  const h = harness();
  h.seed("setup", 99);
  h.enable(true, 100);
  const start = h.seed("setup", 100);
  const backlog = h.seed("setup", 110);
  h.reopen();
  h.enable(true, 150);
  const downtime = h.seed("setup", 140);
  h.enable(false, 200);
  h.seed("setup", 200);
  h.seed("setup", 250);
  const interim = h.seed("setup", 250, { interim: 1 });
  await h.scan();
  expect(h.consumed()).toEqual([]);
  expect(h.posts).toEqual([]);
  h.reopen();
  h.enable(false, 275);
  h.enable(true, 300);
  const restart = h.seed("setup", 300);
  h.store.db.query("UPDATE failure_observations SET finalized_at=300,interim=0 WHERE id=?").run(interim);
  await h.scan();
  expect(h.consumed().map((r) => r.observation_id)).toEqual([start, backlog, downtime, interim, restart]);
  expect(h.store.db.query("SELECT start,end FROM defect_enablement_windows ORDER BY start").all()).toEqual([
    { start: 100, end: 200 },
    { start: 300, end: null },
  ]);
  expect(() =>
    h.store.db.exec("INSERT INTO defect_enablement_windows (start,end) VALUES (400,NULL)"),
  ).toThrow();
});

test("bounded batches terminally consume conflicting identities without leaking supplied text", async () => {
  const h = harness();
  h.enable(true, 100);
  const changes: Partial<FailureObservation>[] = [
    { run_id: "land:999999" },
    { handle_kind: "lan" },
    { handle_id: "999999:1" },
    { handle_id: `${h.entry.id}:bogus` },
    { handle_id: `${h.entry.id}:2` },
    { repo: "elsewhere/private" },
  ];
  for (const extra of changes) h.seed("setup", 100, extra);
  for (let i = 0; i < 49; i++) h.seed();
  await h.scan();
  expect(h.consumed()).toHaveLength(50);
  expect(h.diagnostics).toEqual(changes.map(() => "Defect observation identity unresolved"));
  await h.scan();
  expect(h.consumed()).toHaveLength(55);
  expect(h.outbox()).toHaveLength(49);
  const extra = h.seed();
  h.store.upsertRepo({ ...h.source, id: "duplicate", slug: "EXAMPLE/PRODUCT" });
  await h.scan();
  expect(h.consumed().at(-1)).toEqual({ observation_id: extra, status: "unresolved" });
});

test("accepted outbox backlog waits through disabled mounts and resumes once after re-enable", async () => {
  const h = harness();
  h.enable(true, 100);
  const id = h.seed();
  await h.scan();
  expect(h.reporter().read(h.source.id, String(id))?.state).toBe("prepared");
  h.enable(false, 200);
  h.reopen();
  h.enable(false, 250);
  await h.scan();
  await h.reporter().reconcile();
  expect(h.posts).toEqual([]);
  h.reopen();
  h.enable(true, 300);
  await h.reporter().reconcile();
  await h.scan();
  expect(h.posts).toHaveLength(1);
  expect(h.reporter().read(h.source.id, String(id))?.state).toBe("delivered");
  h.reopen();
  await h.reporter().reconcile();
  expect(h.posts).toHaveLength(1);
});

test.each(["github", "local"] as const)(
  "%s routing remains factory-only with recorded causal stage and context",
  async (kind) => {
    const h = harness(kind);
    h.enable(true, 100);
    const classes: Class[] = [
      "setup",
      "confinement",
      "load",
      "undeclared_requirement",
      "platform",
      "flaky",
      "unclassified",
    ];
    for (const cls of classes) h.seed(cls);
    await h.scan();
    await h.reporter().reconcile();
    expect(h.posts).toHaveLength(classes.length);
    for (const [i, [repo, issue, input]] of h.posts.entries()) {
      const cls = classes[i];
      const factory = ["setup", "confinement", "load"].includes(cls ?? "");
      expect(repo).toBe("example/factory");
      expect(issue).toBeNull();
      expect(input.labels).toEqual(["defect"]);
      expect(input.title).toBe(factory ? "Factory defect" : "Factory defect triage");
      if (!factory) expect(input.body).toContain("Destination unresolved");
      const data = JSON.parse(input.body.split("\n").at(-2) ?? "");
      expect(data).toMatchObject({
        detector: "land-check",
        class: cls,
        machineRole: "unknown",
        introducingPr: "unknown",
        suspectedCausalStage: factory ? "gate environment" : "unknown",
        checkIdentity: `check-${i + 1}`,
        checkedPrContext: [7],
        landRefs: [`land:${h.entry.id}`],
        shas: ["a".repeat(40)],
        timestamps: [new Date(1).toISOString(), new Date(100).toISOString()],
      });
      expect(data.runRefs).toHaveLength(1);
      for (const text of ["private-command", "private-output", "private-location"])
        expect(input.body).not.toContain(text);
    }
    h.reopen();
    await h.scan();
    await h.reporter().reconcile();
    expect(h.posts).toHaveLength(classes.length);
  },
);

test("current source policy and credentials registered after preparation prevent publication across restart", async () => {
  const h = harness();
  h.enable(true, 100);
  h.cfg.repos = { [h.source.slug]: { ...repoSettings(h.cfg, h.source.slug), discreet: true } };
  const discreet = h.seed();
  await h.scan();
  expect(h.reporter().read(h.source.id, String(discreet))).toMatchObject({ state: "blocked", body: null });
  h.cfg.repos = {};
  const credential = `late\n${crypto.randomUUID()}`;
  const unsafe = h.seed("setup", 100, { name: credential });
  await h.scan();
  expect(h.reporter().read(h.source.id, String(unsafe))?.state).toBe("prepared");
  registerCredential("TEST_DEFECT_LATE", credential);
  h.reopen();
  await h.reporter().reconcile();
  expect(h.reporter().read(h.source.id, String(unsafe))?.state).toBe("blocked");
  h.reopen();
  await h.scan();
  await h.reporter().reconcile();
  expect(h.posts).toEqual([]);
});

test("deactivation while preparation awaits leaves the observation available for the next generation", async () => {
  const h = harness();
  h.enable(true, 100);
  h.seed();
  const reporter = h.reporter();
  const prepare = reporter.prepareSubmission;
  let ready = () => {};
  const waiting = new Promise<void>((r) => {
    ready = r;
  });
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  reporter.prepareSubmission = async (...args) => {
    const commit = await prepare(...args);
    ready();
    await held;
    return commit;
  };
  let active = true;
  const scan = detectLandDefects(h.store, reporter, () => active);
  await waiting;
  active = false;
  release();
  await scan;
  expect(h.consumed()).toEqual([]);
  expect(h.outbox()).toEqual([]);
  await h.scan();
  expect(h.outbox()).toHaveLength(1);
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function mounted(h: ReturnType<typeof harness>, deps: IntegrationDeps = {}, enabled = true, at = 100) {
  h.cfg.githubDefects = { enabled, factoryRepo: "example/factory", dailyCap: 10 };
  h.cfg.githubPoll = false;
  h.cfg.secrets.DISCORD_BOT_TOKEN = "";
  h.cfg.secrets.GITHUB_WEBHOOK_SECRET = "";
  const clock = waitClock();
  await clock.advance(at - clock.now());
  const factory = {
    cfg: h.cfg,
    store: h.store,
    land: {
      start: () => {},
      stop: async () => {},
      list: () => [],
    },
  } as unknown as Factory;
  const integrations = await mountIntegrations(factory, {
    toolVersions: async () => [],
    gh: async () => {
      throw new Error("unexpected gh");
    },
    prClient: async () => null,
    defectGitHub: h.github,
    identity: async () => app,
    issueClock: { now: clock.now, set: clock.timer.set as typeof setTimeout, clear: clock.timer.clear },
    ...deps,
  });
  return {
    ...integrations,
    clock,
    flush: async (ms = 0) => {
      await clock.advance(ms);
      await new Promise<void>((r) => setImmediate(r));
    },
  };
}

test("mounted reporting publishes labelled factory evidence once and survives restart", async () => {
  const h = harness();
  h.seed(null, 100, { setup_eligible: 1 });
  const first = await mounted(h);
  h.store.observations.finalize(`land:${h.entry.id}`, {
    round: 1,
    sha: "a".repeat(40),
    stageId: 0,
    comparisons: [],
    purpose: "land",
  });
  await first.flush();
  await first.stop();
  expect(h.posts).toHaveLength(1);
  expect(h.posts[0]).toEqual([
    "example/factory",
    null,
    expect.objectContaining({ labels: ["defect"], title: "Factory defect" }),
    app.token,
  ]);
  const data = JSON.parse(h.posts[0]?.[2].body.split("\n").at(-2) ?? "");
  expect(data).toMatchObject({
    detector: "land-check",
    suspectedCausalStage: "gate environment",
    machineRole: "unknown",
  });
  h.reopen();
  const second = await mounted(h);
  await second.flush();
  await second.stop();
  expect(h.posts).toHaveLength(1);
});

test("mounted shutdown coalesces ticks and drops an identity continuation before submission", async () => {
  const h = harness();
  h.seed();
  const entered = deferred<void>();
  const release = deferred<typeof app>();
  let calls = 0;
  const m = await mounted(h, {
    identity: async () => {
      calls++;
      entered.resolve();
      return release.promise;
    },
  });
  await m.flush();
  await entered.promise;
  await m.flush(60_000);
  await m.flush(60_000);
  expect(calls).toBe(1);
  const stopping = m.stop();
  expect(m.clock.pending).toBe(0);
  release.resolve(app);
  await stopping;
  expect(h.posts).toEqual([]);
  expect(h.consumed()).toEqual([]);
  h.reopen();
  const next = await mounted(h);
  await next.flush();
  await next.stop();
  expect(h.posts).toHaveLength(1);
});

test("mounted shutdown retains a dispatched send, recovers it before any fresh POST on re-upgrade", async () => {
  const h = harness();
  const old = h.seed();
  const sent = deferred<void>();
  const release = deferred<unknown>();
  const post = h.github.post;
  h.github.post = async (...args) => {
    await post(...args); // GitHub accepted it; the response is still in flight.
    sent.resolve();
    return release.promise;
  };
  const m = await mounted(h);
  await m.flush();
  await sent.promise;
  const stopping = m.stop();
  release.resolve(undefined);
  await stopping;
  expect(h.reporter().read(h.source.id, String(old))?.state).toBe("sending");
  h.reopen();
  const fresh = h.seed("flaky");
  const order: string[] = [];
  const list = h.github.list;
  h.github.list = async (...args) => {
    order.push("list");
    return list(...args);
  };
  h.github.post = async (...args) => {
    order.push("post");
    return post(...args);
  };
  const next = await mounted(h);
  await next.flush();
  await next.stop();
  expect(order[0]).toBe("list");
  expect(h.posts).toHaveLength(2);
  expect(h.reporter().read(h.source.id, String(old))?.state).toBe("delivered");
  expect(h.reporter().read(h.source.id, String(fresh))?.state).toBe("delivered");
});

test("mounted production policy blocks a discreet source and decoded late credentials across restart", async () => {
  const h = harness();
  h.cfg.repos = { [h.source.slug]: { ...repoSettings(h.cfg, h.source.slug), discreet: true } };
  const discreet = h.seed();
  let m = await mounted(h);
  await m.flush();
  await m.stop();
  expect(h.reporter().read(h.source.id, String(discreet))).toMatchObject({ state: "blocked", body: null });
  h.cfg.repos = {};
  const credential = `mounted\n${crypto.randomUUID()}`;
  const unsafe = h.seed("setup", 100, { name: credential });
  const label = h.github.label;
  h.github.label = async (...args) => {
    // Preparation has finished; the encoded body now needs a fresh decoded registry check.
    expect(h.reporter().read(h.source.id, String(unsafe))?.body).toContain("\\n");
    registerCredential("TEST_MOUNTED_DEFECT_LATE", credential);
    return label(...args);
  };
  m = await mounted(h);
  await m.flush();
  await m.stop();
  expect(h.reporter().read(h.source.id, String(unsafe))?.state).toBe("blocked");
  h.reopen();
  m = await mounted(h);
  await m.flush();
  await m.stop();
  expect(h.posts).toEqual([]);
});

test("startup recovery precedes detection and shutdown prevents dispatch after a paused lookup", async () => {
  const h = harness();
  h.enable(true, 100);
  const old = h.seed();
  await h.scan();
  await h.reporter().reconcile();
  h.store.db.exec("UPDATE defect_outbox SET state='sending'");
  const fresh = h.seed("flaky");
  const entered = deferred<void>();
  const release = deferred<void>();
  const list = h.github.list;
  h.github.list = async (...args) => {
    entered.resolve();
    await release.promise;
    return list(...args);
  };
  const m = await mounted(h);
  await m.flush();
  await entered.promise;
  // Startup has not scanned/accepted the fresh finding while recovery is awaiting GitHub.
  expect(h.consumed()).toEqual([{ observation_id: old, status: "submitted" }]);
  expect(h.reporter().read(h.source.id, String(fresh))).toBeNull();
  const stopping = m.stop();
  release.resolve();
  await stopping;
  expect(h.posts).toHaveLength(1);
  expect(h.reporter().read(h.source.id, String(old))?.state).toBe("sending");
  h.github.list = list;
  h.reopen();
  const next = await mounted(h);
  await next.flush();
  await next.stop();
  expect(h.posts).toHaveLength(2);
  expect(h.reporter().read(h.source.id, String(old))?.state).toBe("delivered");
  expect(h.reporter().read(h.source.id, String(fresh))?.state).toBe("delivered");
});

test("disabled mounts send nothing and a re-enabled mount resumes accepted and unconsumed backlog", async () => {
  const h = harness();
  h.enable(true, 100);
  const accepted = h.seed();
  await h.scan();
  const pending = h.seed("flaky");
  h.reopen();
  const disabled = await mounted(h, {}, false, 200);
  await disabled.flush();
  expect(disabled.clock.pending).toBe(0);
  await disabled.stop();
  expect(h.posts).toEqual([]);
  const excluded = h.seed("platform", 250);
  h.reopen();
  const enabled = await mounted(h, {}, true, 300);
  await enabled.flush();
  await enabled.stop();
  expect(h.posts).toHaveLength(2);
  expect(h.reporter().read(h.source.id, String(accepted))?.state).toBe("delivered");
  expect(h.reporter().read(h.source.id, String(pending))?.state).toBe("delivered");
  expect(h.reporter().read(h.source.id, String(excluded))).toBeNull();
});
