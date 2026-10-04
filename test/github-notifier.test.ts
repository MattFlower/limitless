import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStats } from "../src/db/stats.ts";
import { Store } from "../src/db/store.ts";
import {
  type GitHubPrClient,
  reconcileMergedRuns,
  startGitHubNotifier,
} from "../src/integrations/github-notifier.ts";
import { observedPrs } from "../src/integrations/github-poller.ts";
import { pollerHarness, respond, SHA, url } from "./github-poller-support.ts";

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
  const stop = startGitHubNotifier(
    store,
    async (args) => {
      calls.push(args);
    },
    () => {},
    async () => null,
  );
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

test("PR verification runs skip the creation comment", async () => {
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
    prompt: "verify",
    source: "github",
    sourceRef: {
      kind: "pull_request",
      repo: repo.slug,
      number: 12,
      baseRef: "main",
      baseSha: "b".repeat(40),
    },
  });
  store.updateRun(run.id, { status: "failed" });
  await Bun.sleep(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.at(-1)).toContain("failed");
  stop();
});

const prUrl = "https://github.com/MattFlower/limitless/pull/39";

function needsHuman(pr: string | null = prUrl) {
  const repo = store.upsertRepo({
    slug: "MattFlower/limitless",
    kind: "github",
    url: "unused",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "fix", source: "cli" });
  store.updateRun(run.id, {
    status: "needs_human",
    error: "review required",
    finishedAt: 123456,
    ...(pr ? { prUrl: pr } : {}),
  });
  store.startStage(run.id, "implement");
  return run.id;
}

test("merged PR resolves once, preserves evidence, and survives reopening", async () => {
  const id = needsHuman();
  store.putArtifact(id, "report", "markdown", "Human review required");
  store.addEvent({ runId: id, type: "status", message: "Run needs human", data: { to: "needs_human" } });
  const messages: string[] = [];
  const unsubscribe = store.subscribe((msg) => {
    if (msg.kind === "run") messages.push(msg.run.status);
  });
  const client: GitHubPrClient = async () => ({
    url: prUrl,
    state: "MERGED",
    mergedAt: "2026-09-27T20:00:00Z",
    mergedBy: { login: "MattFlower" },
  });
  await reconcileMergedRuns(store, client);
  await reconcileMergedRuns(store, client);
  unsubscribe();
  const run = store.getRun(id);
  expect(run?.status).toBe("resolved");
  expect(run?.merged).toBe(true);
  expect(run?.mergedBy).toBe("MattFlower");
  expect(run?.mergedAt).toBe(Date.parse("2026-09-27T20:00:00Z"));
  expect(run?.finishedAt).toBe(123456);
  expect(run?.error).toBe("review required");
  expect(store.listStages(id)).toHaveLength(1);
  const events = store.listEvents(id).filter((event) => event.type === "status");
  expect(events).toHaveLength(2);
  expect(events[0]?.data).toEqual({ to: "needs_human" });
  expect(events[1]?.data).toEqual({
    from: "needs_human",
    to: "resolved",
    mergedBy: "MattFlower",
    mergedAt: run?.mergedAt,
  });
  expect(messages).toEqual(["resolved"]);
  expect(store.getArtifact(id, "report")).toBe("Human review required");
  store.close();
  store = new Store(join(dir, "store.db"));
  expect(store.getRun(id)?.mergedBy).toBe("MattFlower");
  expect(store.listEvents(id).filter((event) => event.type === "status")).toHaveLength(2);
});

test("only an exact merged PR resolves; failures remain retryable", async () => {
  const id = needsHuman();
  const noPr = needsHuman(null);
  let calls = 0;
  for (const state of [
    { url: prUrl, state: "OPEN", mergedAt: null, mergedBy: null },
    { url: prUrl, state: "CLOSED", mergedAt: null, mergedBy: null },
    {
      url: "https://github.com/MattFlower/limitless/pull/40",
      state: "MERGED",
      mergedAt: "2026-09-27T20:00:00Z",
      mergedBy: null,
    },
    null,
  ]) {
    await reconcileMergedRuns(store, async () => {
      calls++;
      return state;
    });
    expect(store.getRun(id)?.status).toBe("needs_human");
  }
  await reconcileMergedRuns(
    store,
    async () => {
      calls++;
      throw new Error("offline");
    },
    () => {},
  );
  expect(store.getRun(id)?.status).toBe("needs_human");
  expect(store.getRun(noPr)?.status).toBe("needs_human");
  expect(calls).toBe(5);
  await reconcileMergedRuns(store, async () => ({
    url: prUrl,
    state: "MERGED",
    mergedAt: "2026-09-27T20:00:00Z",
    mergedBy: null,
  }));
  expect(store.getRun(id)?.status).toBe("resolved");
  expect(store.getRun(id)?.mergedBy).toBeNull();
});

test("startup pass publishes a resolved run and stats count only open needs human", async () => {
  const id = needsHuman();
  needsHuman(null);
  const messages: string[] = [];
  const unsubscribe = store.subscribe((msg) => {
    if (msg.kind === "run") messages.push(msg.run.status);
  });
  const stop = startGitHubNotifier(
    store,
    async () => {},
    () => {},
    async () => ({ url: prUrl, state: "MERGED", mergedAt: "2026-09-27T20:00:00Z", mergedBy: null }),
  );
  for (let i = 0; i < 20 && store.getRun(id)?.status !== "resolved"; i++) await Bun.sleep(5);
  expect(store.getRun(id)?.status).toBe("resolved");
  expect(messages).toContain("resolved");
  const totals = computeStats(store).totals;
  expect(totals.openNeedsHuman).toBe(1);
  expect(totals.openNeedsHumanRate).toBe(0.5);
  stop();
  unsubscribe();
});

for (const status of ["succeeded", "needs_human"] as const) {
  test(`${status} PR merge releases dependents with metadata and preserved evidence`, async () => {
    const id = needsHuman();
    store.updateRun(id, { status });
    const run = store.getRun(id);
    const repo = run && store.getRepo(run.repoId);
    if (!repo) throw new Error("missing repo");
    const dependent = store.createRun(repo, { repo: repo.slug, prompt: "next", dependsOn: [id] });
    for (const response of [
      null,
      { url: prUrl, state: "OPEN" },
      { url: `${prUrl}0`, state: "CLOSED" },
      { url: `${prUrl}0`, state: "MERGED" },
    ]) {
      await reconcileMergedRuns(
        store,
        async () => response && { ...response, mergedAt: "2026-09-27T20:00:00Z", mergedBy: null },
      );
      expect(store.getRun(dependent.id)?.status).toBe("waiting");
    }
    await reconcileMergedRuns(
      store,
      async () => {
        throw new Error("offline");
      },
      () => {},
    );
    expect(store.getRun(dependent.id)?.status).toBe("waiting");
    await reconcileMergedRuns(store, async () => ({
      url: prUrl,
      state: "MERGED",
      mergedAt: "2026-09-27T20:00:00Z",
      mergedBy: { login: "owner" },
    }));
    expect(store.getRun(id)).toMatchObject({
      status: status === "succeeded" ? status : "resolved",
      merged: true,
      mergedBy: "owner",
      mergedAt: Date.parse("2026-09-27T20:00:00Z"),
      error: "review required",
      finishedAt: 123456,
    });
    expect(store.getRun(dependent.id)?.status).toBe("queued");
    await reconcileMergedRuns(
      store,
      async () => {
        throw new Error("must not repoll merged run");
      },
      () => {
        throw new Error("unexpected lookup");
      },
    );
    expect(store.listEvents(dependent.id).filter((event) => event.type === "status")).toHaveLength(1);
  });
}

test("confirmed CLOSED PR blocks dependents, persists and applies to later creation", async () => {
  const id = needsHuman();
  store.updateRun(id, { status: "succeeded" });
  const run = store.getRun(id);
  const repo = run && store.getRepo(run.repoId);
  if (!repo) throw new Error("missing repo");
  const dependent = store.createRun(repo, { repo: repo.slug, prompt: "next", dependsOn: [id] });
  const descendant = store.createRun(repo, {
    repo: repo.slug,
    prompt: "descendant",
    dependsOn: [dependent.id],
  });
  await reconcileMergedRuns(store, async () => ({
    url: prUrl,
    state: "CLOSED",
    mergedAt: null,
    mergedBy: null,
  }));
  store.close();
  store = new Store(join(dir, "store.db"));
  const later = store.createRun(repo, { repo: repo.slug, prompt: "later", dependsOn: [id] });
  const laterDescendant = store.createRun(repo, {
    repo: repo.slug,
    prompt: "later descendant",
    dependsOn: [dependent.id],
  });
  for (const blocked of [dependent.id, descendant.id, later.id, laterDescendant.id]) {
    expect(store.getRun(blocked)).toMatchObject({
      status: "needs_human",
      startedAt: null,
      error: `Dependency ${id}: PR was closed unmerged`,
    });
  }
  await reconcileMergedRuns(store, async () => ({
    url: prUrl,
    state: "MERGED",
    mergedAt: "2026-09-27T20:00:00Z",
    mergedBy: null,
  }));
  expect(store.getRun(dependent.id)?.status).toBe("needs_human");
});

test("startup polling includes succeeded PRs and never overlaps event-triggered checks", async () => {
  const id = needsHuman();
  store.updateRun(id, { status: "succeeded" });
  let calls = 0;
  let release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = startGitHubNotifier(
    store,
    async () => {},
    () => {},
    async () => {
      calls++;
      await barrier;
      return { url: prUrl, state: "MERGED", mergedAt: "2026-09-27T20:00:00Z", mergedBy: null };
    },
  );
  try {
    store.updateRun(id, { title: "one" });
    store.updateRun(id, { title: "two" });
    expect(calls).toBe(1);
    release();
    for (let i = 0; i < 20 && !store.getRun(id)?.merged; i++) await Bun.sleep(5);
    expect(store.getRun(id)).toMatchObject({ status: "succeeded", merged: true });
    expect(calls).toBe(1);
  } finally {
    release();
    stop();
  }
});

test("with polling, observations reconcile runs: merged metadata, resolution, dependants and one run.merged", async () => {
  const h = pollerHarness();
  try {
    const human = h.factoryPr("o/r", 1, "needs_human");
    h.store.updateRun(human.id, { error: "review required" });
    h.store.putArtifact(human.id, "report", "markdown", "Human review required");
    const done = h.factoryPr("o/r", 2);
    const closed = h.factoryPr("o/r", 3);
    const dependant = h.store.createRun(h.repo("o/r"), { repo: "o/r", prompt: "next", dependsOn: [done.id] });
    expect(dependant.status).toBe("waiting");
    // Wired as mountIntegrations does with polling on: the notifier reads observations, never GitHub.
    const stopNotifier = startGitHubNotifier(
      h.store,
      async () => {},
      () => {},
      observedPrs(h.store),
    );
    h.start();
    await h.advance(0);
    for (const n of [1, 2]) {
      const node = h.node("o/r", n);
      node.state = "MERGED";
      node.mergedAt = "2026-10-03T05:00:00Z";
      node.mergedBy = { login: "MattFlower" };
    }
    h.node("o/r", 3).state = "CLOSED";
    await h.advance(15_000);
    await h.advance(15_000);
    stopNotifier();
    const mergedAt = Date.parse("2026-10-03T05:00:00Z");
    expect(h.store.getRun(human.id)).toMatchObject({
      status: "resolved",
      merged: true,
      mergedBy: "MattFlower",
      mergedAt,
    });
    expect(h.store.getRun(human.id)?.error).toBe("review required");
    expect(h.store.getArtifact(human.id, "report")).toBe("Human review required");
    expect(h.store.getRun(done.id)).toMatchObject({
      status: "succeeded",
      merged: true,
      mergedBy: "MattFlower",
    });
    expect(h.store.getRun(closed.id)).toMatchObject({ merged: false, prClosedUnmerged: true });
    expect(h.store.getRun(dependant.id)?.status).toBe("queued");
    const feed = h.store.readFeed({ limit: 1000 }).items;
    const mergedRuns = feed.filter((i) => i.kind === "run.merged").map((i) => i.runId);
    expect(mergedRuns.toSorted()).toEqual([human.id, done.id].toSorted());
    expect(feed.filter((i) => i.kind === "pr.merged")).toHaveLength(2);
    expect(feed.filter((i) => i.kind === "pr.closed")).toHaveLength(1);
    expect(h.gh.calls.every((c) => c.path === "graphql" || /^repos\/o\/r\/pulls\/\d$/.test(c.path))).toBe(
      true,
    );
  } finally {
    h.close();
  }
});

test("a terminal observation reconciles a run that finishes delivery later, including after a restart", async () => {
  const h = pollerHarness();
  try {
    const run = h.factoryPr("o/r", 1, "running");
    h.start();
    await h.advance(0);
    const node = h.node("o/r", 1);
    node.state = "MERGED";
    node.mergedAt = "2026-10-03T05:00:00Z";
    await h.advance(45_000);
    expect(h.store.getRun(run.id)?.merged).toBe(false);
    const calls = h.gh.calls.length;
    h.reopen();
    const stopNotifier = startGitHubNotifier(
      h.store,
      async () => {},
      () => {},
      observedPrs(h.store),
    );
    h.start();
    h.store.updateRun(run.id, { status: "succeeded" });
    for (let i = 0; i < 20 && !h.store.getRun(run.id)?.merged; i++) await Bun.sleep(1);
    stopNotifier();
    expect(h.store.getRun(run.id)).toMatchObject({
      merged: true,
      mergedAt: Date.parse("2026-10-03T05:00:00Z"),
    });
    expect(h.store.readFeed({ limit: 1000 }).items.filter((i) => i.kind === "run.merged")).toHaveLength(1);
    expect(h.gh.calls.length).toBe(calls);
  } finally {
    h.close();
  }
});

test("a terminal observation whose feed write fails stays retryable and reconciles only once written", async () => {
  const h = pollerHarness();
  try {
    const run = h.factoryPr("o/r", 1);
    h.start();
    await h.advance(0);
    h.store.db.exec(
      "CREATE TEMP TRIGGER boom BEFORE INSERT ON feed WHEN NEW.kind = 'pr.merged' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    const node = h.node("o/r", 1);
    node.state = "MERGED";
    node.mergedAt = "2026-10-03T05:00:00Z";
    await h.advance(15_000);
    expect(h.store.getRun(run.id)?.merged).toBe(false);
    h.store.db.exec("DROP TRIGGER boom");
    await h.advance(15_000);
    const kinds = h.store.readFeed({ limit: 1000 }).items.map((i) => i.kind);
    expect(kinds.filter((k) => k === "pr.merged" || k === "run.merged")).toEqual(["pr.merged", "run.merged"]);
    expect(h.store.getRun(run.id)?.merged).toBe(true);
  } finally {
    h.close();
  }
});

test("with polling, PRs the poller does not track are reconciled through the per-run client, once", async () => {
  const h = pollerHarness();
  try {
    // A Dependabot existing-branch verify run and a PR-verification run: neither PR is the poller's.
    const dependabot = h.store.createRun(
      h.repo("o/r"),
      {
        repo: "o/r",
        prompt: "verify",
        source: "github",
        requestedBy: "dependabot[bot]",
        baseBranch: "deps",
        deliveryBranch: "deps",
        sourceRef: {
          kind: "pull_request",
          repo: "o/r",
          number: 7,
          baseRef: "main",
          baseSha: SHA,
          headSha: SHA,
        },
      },
      true,
    );
    h.store.updateRun(dependabot.id, { prUrl: url("o/r", 7), status: "succeeded" });
    const verify = h.store.createRun(h.repo("o/r"), {
      repo: "o/r",
      prompt: "verify",
      source: "github",
      sourceRef: { kind: "pull_request", repo: "o/r", number: 8, baseRef: "main", baseSha: SHA },
    });
    h.store.updateRun(verify.id, { prUrl: url("o/r", 8), status: "needs_human" });
    // The poller's own PR has no snapshot yet and then hits an access failure: never a fallback read.
    const own = h.factoryPr("o/r", 1);
    const fallback = mock(async (prUrl: string) => ({
      url: prUrl,
      state: "MERGED",
      mergedAt: "2026-10-03T05:00:00Z",
      mergedBy: { login: "dependabot[bot]" },
    }));
    const client = observedPrs(h.store, fallback);
    await reconcileMergedRuns(h.store, client, () => {});
    expect(fallback.mock.calls.map((c) => c[0]).toSorted()).toEqual([url("o/r", 7), url("o/r", 8)]);
    const mergedAt = Date.parse("2026-10-03T05:00:00Z");
    expect(h.store.getRun(dependabot.id)).toMatchObject({
      merged: true,
      mergedBy: "dependabot[bot]",
      mergedAt,
    });
    expect(h.store.getRun(verify.id)).toMatchObject({ status: "resolved", merged: true, mergedAt });
    expect(h.store.getRun(own.id)?.merged).toBe(false);
    h.gh.deny.set("o/r", () => respond(403, { message: "SSO" }, { "x-github-sso": "required" }));
    h.start();
    await h.advance(0);
    expect(h.store.githubAccessProblems().map((p) => p.repo)).toEqual(["o/r"]);
    fallback.mockClear();
    h.reopen();
    await reconcileMergedRuns(h.store, observedPrs(h.store, fallback), () => {});
    await reconcileMergedRuns(h.store, observedPrs(h.store, fallback), () => {});
    expect(fallback).not.toHaveBeenCalled();
    const merged = h.store.readFeed({ limit: 1000 }).items.filter((i) => i.kind === "run.merged");
    expect(merged.map((i) => i.runId).toSorted()).toEqual([dependabot.id, verify.id].toSorted());
  } finally {
    h.close();
  }
});

test("a stale snapshot never hides an untracked PR from the fallback; a merged one is authoritative", async () => {
  const h = pollerHarness();
  try {
    // The factory run observed the PR open, then failed over 7 days ago, so the poller stopped tracking it.
    const factory = h.factoryPr("o/r", 1);
    const merged = h.factoryPr("o/r", 2);
    h.start();
    await h.advance(0);
    h.store.updateRun(factory.id, { status: "failed", finishedAt: Date.now() - 8 * 86_400_000 });
    const verify = h.store.createRun(h.repo("o/r"), {
      repo: "o/r",
      prompt: "verify",
      source: "github",
      sourceRef: { kind: "pull_request", repo: "o/r", number: 1, baseRef: "main", baseSha: SHA },
    });
    h.store.updateRun(verify.id, { prUrl: url("o/r", 1), status: "needs_human" });
    expect(JSON.parse(h.store.githubPrData(url("o/r", 1)) ?? "null")?.state).toBe("OPEN");
    expect(h.store.githubTracked().map((p) => p.url)).toEqual([url("o/r", 2)]);
    // The poller then sees its other PR merge; that observation needs no fallback read.
    const node = h.node("o/r", 2);
    node.state = "MERGED";
    node.mergedAt = "2026-10-03T04:00:00Z";
    h.store.updateRun(merged.id, { status: "needs_human" });
    await h.advance(15_000);
    h.reopen();
    const fallback = mock(async (prUrl: string) => ({
      url: prUrl,
      state: "MERGED",
      mergedAt: "2026-10-03T05:00:00Z",
      mergedBy: { login: "octocat" },
    }));
    await reconcileMergedRuns(h.store, observedPrs(h.store, fallback), () => {});
    expect(fallback.mock.calls.map((c) => c[0])).toEqual([url("o/r", 1)]);
    expect(h.store.getRun(verify.id)).toMatchObject({ merged: true, mergedBy: "octocat" });
    expect(h.store.getRun(merged.id)).toMatchObject({ merged: true, mergedAt: Date.parse(node.mergedAt) });
  } finally {
    h.close();
  }
});

for (const kind of ["issue", "pull_request"] as const) {
  test.each(["matching", "encoded", "malformed", "unreadable", "absent", "clean"])(
    `private factory ${kind} comment: %s`,
    async (scenario) => {
      const calls: string[][] = [];
      const file = join(dir, "private-strings.txt");
      if (scenario === "unreadable") mkdirSync(file);
      else if (scenario !== "absent")
        writeFileSync(file, scenario === "malformed" ? Buffer.from([0xff]) : "secret-host.example");
      const stop = startGitHubNotifier(
        store,
        async (args) => {
          calls.push(args);
        },
        () => {},
        async () => null,
        dir,
      );
      try {
        const repo = store.upsertRepo({
          slug: "fake/repo",
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
          sourceRef: { kind, repo: repo.slug, number: 1 },
        });
        calls.length = 0;
        store.updateRun(run.id, {
          status: "succeeded",
          prUrl:
            scenario === "encoded"
              ? "https://%73ecret-host.example/pr/1"
              : scenario === "matching"
                ? "https://secret-host.example/pr/1"
                : undefined,
        });
        await Bun.sleep(0);
        expect(calls).toHaveLength(["clean", "absent"].includes(scenario) ? 1 : 0);
      } finally {
        stop();
      }
    },
  );
}
