import { afterEach, beforeEach, expect, mock, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { Run } from "../src/core/types.ts";
import { MIGRATION_DIR } from "../src/db/migration-runner.ts";
import { Store } from "../src/db/store.ts";
import * as repos from "../src/git/repos.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { observerRoots } from "../src/harness/sandbox.ts";
import { startGitHubPoller } from "../src/integrations/github-poller.ts";
import { LandQueue } from "../src/land/queue.ts";
import { processConflictTriggers } from "../src/pipeline/conflict-round.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { submitReview } from "../src/pipeline/review-round.ts";
import * as proc from "../src/util/proc.ts";
import { sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { fakeGitHub } from "./github-poller-support.ts";
import { approve, models, policy, providers, roleOf } from "./pipeline-support.ts";
import { findingEvidence } from "./review-support.ts";
import { seeded } from "./seeded.ts";
import { waitClock } from "./wait-clock.ts";

setDefaultTimeout(30_000);
const url = "https://github.com/test/repo/pull/1";
const branch = "limitless/owner-feature";
const seed = seeded(async (root) => {
  const work = join(root, "work");
  mkdirSync(work);
  const git = (...args: string[]) => sh(["git", ...args], { cwd: work });
  await git("init", "-qb", "main");
  writeFileSync(join(work, "greeting.txt"), "hello\n");
  writeFileSync(join(work, "protected.txt"), "keep\n");
  writeFileSync(
    join(work, ".limitless.toml"),
    '[gates]\nchecks = [{name="check",run="! grep -q BAD greeting.txt"}]\n[policy]\nreview_rounds = 1\nprotected_paths = ["protected.txt"]\n',
  );
  await git("add", ".");
  await git("commit", "-qm", "base");
  await git("checkout", "-qb", branch);
  writeFileSync(join(work, "greeting.txt"), "PR intent\n");
  await git("add", ".");
  await git("commit", "-qm", "feature");
  await git("checkout", "-q", "main");
  await sh(["git", "clone", "-q", "--bare", work, join(root, "remote.git")], { cwd: root });
});
let root: string;
let factory: Factory;
let owner: Run;
let clock: ReturnType<typeof waitClock>;
let calls: string[][];
let comments: { body: string }[];
let implementations: number;
let mode: "pass" | "gates" | "review" | "audit" | "empty" | "dropped";
let reviewPrompts: string[];
let verifierCalls: number;
let draft: boolean;
let autoMerge: boolean;
let queue: LandQueue | null;
const git = async (cwd: string, ...args: string[]) => (await sh(["git", ...args], { cwd })).stdout.trim();
const remoteHead = () => git(join(root, "remote.git"), "rev-parse", branch);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "conflict-rounds-"));
  observerRoots.add(realpathSync(root));
  await seed(root);
  clock = waitClock();
  calls = [];
  comments = [];
  implementations = 0;
  reviewPrompts = [];
  verifierCalls = 0;
  draft = false;
  autoMerge = false;
  mode = "pass";
  queue = null;
  const cfg = loadConfig({ home: join(root, "data"), configDir: join(root, "cfg") });
  const firstModel = models[0];
  if (!firstModel) throw new Error("missing model");
  factory = new Factory(cfg, {
    confinement: fakeConfinement,
    providers,
    models: [...models, { ...firstModel, id: "alpha/verifier", model: "verifier", vendor: "google" }],
    policy,
    harnesses: {
      fake: fakeHarness((s) => {
        if (s.prompt.startsWith("You are a code-review verifier")) {
          verifierCalls++;
          return {
            structured: {
              results: [
                {
                  id: "C1",
                  verdict: "CONFIRMED",
                  severity: "high",
                  category: "correctness",
                  evidence: "greeting.txt:1 removed PR intent",
                  trigger: "read the resolved greeting -> PR intent missing",
                },
              ],
            },
          };
        }
        if (roleOf(s) === "review") {
          reviewPrompts.push(s.prompt);
          return {
            structured:
              mode === "review" ||
              (mode === "dropped" &&
                s.prompt.includes("diff against the PR head (first parent)") &&
                s.prompt.includes("-PR intent"))
                ? {
                    verdict: "request_changes",
                    summary: "Resolution lost the PR intent",
                    findings: [
                      {
                        severity: "major",
                        security: false,
                        suggestion: "Restore the PR intent",
                        ...findingEvidence,
                        title: "Lost intent",
                        detail: "Keep the original request",
                        file: "greeting.txt",
                        line: 1,
                      },
                    ],
                  }
                : approve,
          };
        }
        expect(roleOf(s)).toBe("implement");
        implementations++;
        expect(s.prompt).toContain("preserving both intents");
        expect(readFileSync(join(s.cwd, "greeting.txt"), "utf8")).toContain("<<<<<<<");
        return {
          files: {
            "greeting.txt":
              mode === "gates"
                ? "BAD\n"
                : mode === "empty" || mode === "dropped"
                  ? "base intent\n"
                  : "PR intent and base intent\n",
            ...(mode === "audit" ? { "protected.txt": "rewritten\n" } : {}),
          },
        };
      }),
    },
  });
  factory.deps.gh = async (args, _signal, stdin) => {
    calls.push(args);
    if (args[1] === "merge" && args.includes("--disable-auto")) {
      autoMerge = false;
      return "";
    }
    if (args[1] === "comment") {
      comments.push({ body: stdin ?? "" });
      return "";
    }
    if (args[1] === "view")
      return JSON.stringify({
        state: "OPEN",
        isDraft: draft,
        autoMergeRequest: autoMerge ? {} : null,
        headRefOid: await remoteHead(),
        headRefName: branch,
        isCrossRepository: false,
        headRepository: { name: "repo" },
        headRepositoryOwner: { login: "test" },
        body: "report",
        comments,
      });
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  const repo = factory.store.upsertRepo({
    slug: "test/repo",
    kind: "github",
    url: join(root, "remote.git"),
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  owner = factory.store.createRun(repo, {
    repo: repo.slug,
    title: "Add greeting",
    prompt: "Preserve the PR greeting",
    profile: "standard",
  });
  owner = factory.store.updateRun(owner.id, {
    status: "succeeded",
    baseBranch: "main",
    baseSha: await git(join(root, "remote.git"), "rev-parse", "main"),
    branch,
    headSha: await remoteHead(),
    prUrl: url,
  });
});
afterEach(async () => {
  mock.restore();
  await queue?.stop();
  await factory.stop();
  factory.store.close();
  observerRoots.clear();
  rmSync(root, { recursive: true, force: true });
});

async function advanceBase(conflicting = true) {
  const cwd = join(root, "work");
  writeFileSync(join(cwd, conflicting ? "greeting.txt" : "base.txt"), "base intent\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "advance base");
  await git(cwd, "push", "-q", join(root, "remote.git"), "main:refs/heads/main");
  return git(cwd, "rev-parse", "HEAD");
}
function triggers() {
  return factory.store.db
    .query<{ state: string; reason: string | null; run_id: string | null; attempts: number }, []>(
      "SELECT state, reason, run_id, attempts FROM conflict_triggers ORDER BY id",
    )
    .all();
}
async function trigger() {
  factory.store.recordConflictTrigger(url, await remoteHead(), "land", clock.now());
  await processConflictTriggers(factory.store, clock.now, factory.deps.gh);
  return factory.store.reviewRounds(url).at(-1)?.runId as string;
}
async function blockedLand() {
  factory.store.recordApproval(owner.id, url, await remoteHead(), "operator");
  queue = new LandQueue({
    store: factory.store,
    paths: factory.cfg.paths,
    confinement: fakeConfinement,
    gh: factory.deps.gh,
    clock: {
      now: clock.now,
      set: clock.timer.set,
      clear: (id) => clock.timer.clear(id as ReturnType<typeof setInterval>),
    },
    log: () => {},
  });
  const entry = await queue.request({ target: owner.id });
  const deadline = Date.now() + 15_000;
  while (!triggers().some((t) => t.state === "started")) {
    if (Date.now() > deadline) throw new Error("land conflict did not start a round");
    await Bun.sleep(10);
  }
  await queue.stop();
  return entry;
}

test("a land conflict starts once, delivers a checked merge and requires approval of the new head", async () => {
  const head = await remoteHead();
  const tip = await advanceBase();
  const entry = await blockedLand();
  expect(factory.store.getLandEntry(entry.id)?.reason).toBe("conflicts with main");
  queue?.start();
  await queue?.stop();
  expect(factory.store.reviewRounds(url)).toMatchObject([{ kind: "conflict", round: 1, reviewedSha: head }]);
  const id = triggers()[0]?.run_id as string;
  expect(factory.store.reviewRound(id)?.owner.id).toBe(owner.id);
  const push = spyOn(repos, "pushExistingBranch");
  const commands = spyOn(proc, "sh");
  autoMerge = true;
  factory.deps.faults = {
    "store:save": { action: "kill", when: (c) => c.checkpoint === "delivery-complete" },
  };
  expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("running");
  const sha = await remoteHead();
  expect(push.mock.calls).toHaveLength(1);
  expect(push.mock.calls[0]?.[6]).toBe(sha);
  const argv = commands.mock.calls
    .map(([args]) => args)
    .find((args) => args.includes(`${sha}:refs/heads/${branch}`));
  expect(argv).toContain(`--force-with-lease=refs/heads/${branch}:${head}`);
  expect(
    (await git(join(root, "remote.git"), "rev-list", "--parents", "-n1", sha)).split(" ").slice(1),
  ).toEqual([head, tip]);
  expect(await git(join(root, "remote.git"), "show", `${sha}:greeting.txt`)).toBe(
    "PR intent and base intent",
  );
  expect(factory.store.reviewRounds(url)[0]?.deliveredSha).toBe(sha);
  expect(factory.store.getLandEntry(entry.id)).toMatchObject({
    state: "blocked",
    reason: `conflict resolved at ${sha}; approve the new head to land`,
  });
  expect(factory.store.approvalFor(url)?.stale).toBe(true);
  const feed = factory.store
    .readFeed({ after: 0, limit: 100 })
    .items.filter((f) => f.kind === "conflict.round_delivered");
  expect(feed).toHaveLength(1);
  expect(feed[0]?.summary).toContain(sha);
  expect(feed[0]?.title).not.toContain("Review round");
  expect(autoMerge).toBe(false);
  expect(comments).toHaveLength(1);
  expect(comments[0]?.body).toContain(`<!-- limitless-conflict-round:${id} -->`);
  expect(comments[0]?.body).toContain(tip);
  expect(comments[0]?.body).toContain("greeting.txt");
  expect(implementations).toBe(1);
  // Restart delivery after the push/comment checkpoints: no duplicate comment or feed item.
  factory.deps.faults = undefined;
  expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("succeeded");
  expect(comments).toHaveLength(1);
  // Conflict rounds do not consume the trusted review_rounds = 1 budget.
  const result = await submitReview(factory, owner.id, {
    verdict: "changes",
    reviewedSha: sha,
    findings: [{ severity: "major", title: "A review finding", detail: "Address it" }],
  });
  expect("round" in result && factory.store.reviewRound(result.round.id)).toMatchObject({
    kind: "review",
    round: 2,
  });
});

test.each(["gates", "review", "audit"] as const)(
  "a resolution rejected by %s does not push or change the blocked reason",
  async (failure) => {
    const head = await remoteHead();
    await advanceBase();
    const entry = await blockedLand();
    mode = failure;
    const id = triggers()[0]?.run_id as string;
    expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("needs_human");
    expect(await remoteHead()).toBe(head);
    expect(comments).toHaveLength(0);
    expect(factory.store.reviewRounds(url)[0]?.deliveredSha).toBeNull();
    expect(factory.store.getLandEntry(entry.id)?.reason).toBe("conflicts with main");
  },
);

test("a clean base merge is checked and delivered without running implementation", async () => {
  const head = await remoteHead();
  const tip = await advanceBase(false);
  const id = await trigger();
  expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("succeeded");
  expect(
    (await git(join(root, "remote.git"), "rev-list", "--parents", "-n1", await remoteHead()))
      .split(" ")
      .slice(1),
  ).toEqual([head, tip]);
  expect(implementations).toBe(0);
  expect(comments).toHaveLength(1);
});

test("active rounds, delivered heads and the rolling daily cap suppress new rounds", async () => {
  const id = await trigger();
  await trigger();
  expect(factory.store.reviewRounds(url)).toHaveLength(1);
  expect(triggers().at(-1)?.reason).toContain("in flight");
  for (let n = 1; n <= 3; n++) {
    const previous = factory.store.reviewRounds(url).at(-1)?.runId as string;
    factory.store.updateRun(previous, { status: "failed" });
    await trigger();
  }
  expect(factory.store.reviewRounds(url)).toHaveLength(3);
  expect(triggers().at(-1)?.reason).toContain("cap");
  await clock.advance(86_400_001);
  await trigger();
  expect(factory.store.reviewRounds(url)).toHaveLength(4);
  const latest = factory.store.reviewRounds(url).at(-1)?.runId as string;
  factory.store.markRoundDelivered(latest, "b".repeat(40));
  factory.store.updateRun(latest, { status: "succeeded" });
  await trigger();
  expect(triggers().at(-1)?.reason).toContain("already resolved");
  expect(factory.store.getRun(id)?.title).toBe("Conflict round 1: Add greeting");
});

test("a pending trigger starts exactly once across reopening the database", async () => {
  factory.store.recordConflictTrigger(url, await remoteHead(), "land", clock.now());
  const db = factory.cfg.paths.db;
  factory.store.close();
  const reopened = new Store(db);
  try {
    await processConflictTriggers(reopened, clock.now, factory.deps.gh);
    await processConflictTriggers(reopened, clock.now, factory.deps.gh);
    expect(reopened.reviewRounds(url)).toHaveLength(1);
    expect(reopened.listRuns()).toHaveLength(2);
    expect(reopened.pendingConflictTriggers()).toHaveLength(0);
  } finally {
    reopened.close();
  }
});

test.each(["eligible", "draft", "needs-human", "non-factory", "fork", "unknown"])(
  "polling records and consumes the %s conflict observation",
  async (eligibility) => {
    if (eligibility === "needs-human") factory.store.updateRun(owner.id, { status: "needs_human" });
    if (eligibility === "non-factory")
      factory.store.db.query("UPDATE runs SET delivery_branch = ? WHERE id = ?").run(branch, owner.id);
    const github = fakeGitHub(clock.now);
    const node = github.add("test/repo", 1);
    node.headRefOid = await remoteHead();
    const snap = { ...node, activity: { review: [], review_comment: [], comment: [] } };
    factory.store.saveGithubPr(
      { url, repo: "test/repo", runId: owner.id, nodeId: node.id, data: JSON.stringify(snap), delivered: 1 },
      false,
      [],
      clock.now(),
    );
    node.mergeable = eligibility === "unknown" ? "UNKNOWN" : "CONFLICTING";
    Object.assign(node, { isDraft: eligibility === "draft", isCrossRepository: eligibility === "fork" });
    // A tracked observation without a factory owner still exercises the consumer's refusal.
    if (eligibility === "non-factory") {
      factory.store.recordConflictTrigger(url, node.headRefOid, "poller", clock.now());
      factory.store.startConflictTrigger(
        factory.store.pendingConflictTriggers()[0]?.id as number,
        { state: "OPEN", headRefOid: node.headRefOid },
        clock.now(),
      );
    } else {
      const stop = startGitHubPoller(factory.store, {
        client: github.client,
        clock: {
          now: clock.now,
          set: clock.timer.set as unknown as typeof setTimeout,
          clear: clock.timer.clear as unknown as typeof clearTimeout,
        },
        log: () => {},
      });
      try {
        await clock.advance(0);
        for (let i = 0; i < 50 && !github.graphql().length; i++)
          await new Promise<void>((r) => setImmediate(r));
        for (let i = 0; i < 50 && eligibility !== "unknown" && !triggers().length; i++)
          await new Promise<void>((r) => setImmediate(r));
        await clock.flush();
      } finally {
        stop();
      }
    }
    expect(factory.store.reviewRounds(url)).toHaveLength(eligibility === "eligible" ? 1 : 0);
    if (eligibility === "unknown") expect(triggers()).toHaveLength(0);
    else expect(triggers()[0]).toMatchObject({ state: eligibility === "eligible" ? "started" : "skipped" });
    if (eligibility === "draft") expect(triggers()[0]?.reason).toContain("draft");
    if (eligibility === "needs-human") expect(triggers()[0]?.reason).toContain("needs_human");
    if (eligibility === "non-factory") expect(triggers()[0]?.reason).toContain("not a factory");
  },
);

test("a review round in flight also suppresses a conflict trigger", async () => {
  const head = await remoteHead();
  await submitReview(factory, owner.id, {
    verdict: "changes",
    reviewedSha: head,
    findings: [{ severity: "major", title: "Fix it", detail: "Handle empty input" }],
  });
  await trigger();
  expect(factory.store.reviewRounds(url)).toMatchObject([{ kind: "review" }]);
  expect(triggers()[0]?.reason).toContain("in flight");
});

test("a failed round transaction leaves the trigger pending and creates no orphan run", async () => {
  factory.store.recordConflictTrigger(url, await remoteHead(), "land", clock.now());
  factory.store.db.exec(
    "CREATE TRIGGER fail_conflict BEFORE INSERT ON review_rounds BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
  );
  await expect(processConflictTriggers(factory.store, clock.now, factory.deps.gh)).rejects.toThrow(
    "interrupted",
  );
  expect(factory.store.listRuns()).toHaveLength(1);
  expect(triggers()).toMatchObject([{ state: "pending", run_id: null }]);
  factory.store.db.exec("DROP TRIGGER fail_conflict");
  await processConflictTriggers(factory.store, clock.now, factory.deps.gh);
  expect(factory.store.listRuns()).toHaveLength(2);
  expect(triggers()).toMatchObject([{ state: "started" }]);
});

test("a clean merge with the base's exact tree stops without pushing", async () => {
  const cwd = join(root, "work");
  writeFileSync(join(cwd, "greeting.txt"), "PR intent\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "base independently implements greeting");
  await git(cwd, "push", "-q", join(root, "remote.git"), "main:refs/heads/main");
  const head = await remoteHead();
  const id = await trigger();
  expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("needs_human");
  expect(implementations).toBe(0);
  expect(await remoteHead()).toBe(head);
  expect(factory.store.getRun(id)?.error).toBe("the resolution leaves no change against main");
  expect(factory.store.listStages(id).filter((s) => s.name === "review")).toHaveLength(0);
});

test("an ancestor base ends without implementing or pushing", async () => {
  const head = await remoteHead();
  const id = await trigger();
  expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("succeeded");
  expect(await remoteHead()).toBe(head);
  expect(implementations).toBe(0);
  expect(comments).toHaveLength(0);
});

test("restart before merging retains the chosen base and does not rerun the original implementation", async () => {
  const head = await remoteHead();
  const tip = await advanceBase();
  const id = await trigger();
  factory.deps.faults = {
    "store:save": { action: "kill", when: (c) => c.checkpoint === "review-base-chosen" },
  };
  expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("running");
  factory.deps.faults = undefined;
  expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("succeeded");
  expect(implementations).toBe(1);
  expect(
    (await git(join(root, "remote.git"), "rev-list", "--parents", "-n1", await remoteHead()))
      .split(" ")
      .slice(1),
  ).toEqual([head, tip]);
});

test("the migration preserves existing review rows and previous-release inserts", () => {
  const migrations = join(root, "old-migrations");
  mkdirSync(migrations);
  for (const name of readdirSync(MIGRATION_DIR)) {
    if (name.endsWith(".sql") && !name.endsWith("-conflict-rounds.sql"))
      writeFileSync(join(migrations, name), readFileSync(join(MIGRATION_DIR, name)));
  }
  const path = join(root, "previous.sqlite");
  const old = new Store(path, migrations);
  const repo = old.upsertRepo({
    slug: "test/repo",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const source = old.createRun(repo, { repo: repo.slug, prompt: "Owner" });
  const round = old.createRun(repo, { repo: repo.slug, prompt: "Existing round" });
  const head = "a".repeat(40);
  const insert =
    "INSERT INTO review_rounds (run_id, source_run_id, pr_url, round, reviewed_sha, findings, created_at) VALUES (?, ?, ?, ?, ?, '[]', ?)";
  old.db.query(insert).run(round.id, source.id, url, 1, head, clock.now());
  old.close();
  const upgraded = new Store(path);
  try {
    expect(upgraded.reviewRounds(url)).toMatchObject([
      { runId: round.id, kind: "review", reviewedSha: head },
    ]);
    const later = upgraded.createRun(repo, { repo: repo.slug, prompt: "Previous release round" });
    upgraded.db.query(insert).run(later.id, source.id, url, 2, head, clock.now());
    expect(upgraded.reviewRounds(url)).toMatchObject([
      { kind: "review", round: 1 },
      { kind: "review", round: 2 },
    ]);
  } finally {
    upgraded.close();
  }
});

test("startup consumes pending triggers and a restarted consumer never repeats started ones", async () => {
  factory.store.recordConflictTrigger(url, await remoteHead(), "land", clock.now());
  // A saved observation must not replace the live startup lookup.
  factory.store.saveGithubPr(
    {
      url,
      repo: "test/repo",
      runId: owner.id,
      nodeId: null,
      data: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: await remoteHead() }),
      delivered: 1,
    },
    false,
    [],
    clock.now(),
  );
  factory.store.close();
  let reopened = new Store(factory.cfg.paths.db);
  try {
    const startQueue = () =>
      new LandQueue({
        store: reopened,
        paths: factory.cfg.paths,
        gh: factory.deps.gh,
        clock: {
          now: clock.now,
          set: clock.timer.set,
          clear: (id) => clock.timer.clear(id as ReturnType<typeof setInterval>),
        },
        log: () => {},
      });
    let consumer = startQueue();
    consumer.start();
    while (!reopened.reviewRounds(url).length) await new Promise<void>((r) => setImmediate(r));
    await consumer.stop();
    const id = reopened.reviewRounds(url)[0]?.runId;
    expect(id).toBeDefined();
    reopened.close();
    reopened = new Store(factory.cfg.paths.db);
    consumer = startQueue();
    consumer.start();
    await consumer.stop();
    expect(reopened.reviewRounds(url)).toMatchObject([{ runId: id }]);
    expect(reopened.listRuns()).toHaveLength(2);
    expect(reopened.pendingConflictTriggers()).toHaveLength(0);
  } finally {
    reopened.close();
  }
});

test("a blocked entry stops heartbeating while its conflict trigger verifies the PR", async () => {
  await advanceBase();
  factory.store.recordApproval(owner.id, url, await remoteHead(), "operator");
  let release = () => {};
  let reached = () => {};
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gh = factory.deps.gh;
  if (!gh) throw new Error("missing fake gh");
  queue = new LandQueue({
    store: factory.store,
    paths: factory.cfg.paths,
    confinement: fakeConfinement,
    clock: {
      now: clock.now,
      set: clock.timer.set,
      clear: (id) => clock.timer.clear(id as ReturnType<typeof setInterval>),
    },
    gh: async (args, signal, stdin) => {
      reached();
      await hold;
      return (await gh(args, signal, stdin)) ?? "";
    },
    log: () => {},
  });
  const entry = await queue.request({ target: owner.id });
  try {
    await ready;
    expect(factory.store.getLandEntry(entry.id)?.state).toBe("blocked");
    await clock.advance(30_000);
  } finally {
    release();
  }
  // stop only once the worker consumes the lookup: stopping first intentionally leaves it pending.
  const end = Date.now() + 5_000;
  while (factory.store.pendingConflictTriggers().length && Date.now() < end)
    await new Promise<void>((r) => setImmediate(r));
  await queue.stop();
  expect(factory.store.reviewRounds(url)).toHaveLength(1);
});

test("taking the base side of every conflict stops after one implementation", async () => {
  const head = await remoteHead();
  await advanceBase();
  mode = "empty";
  // Older owners use the default base.
  factory.store.db.query("UPDATE runs SET base_branch = NULL WHERE id = ?").run(owner.id);
  const id = await trigger();
  expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("needs_human");
  expect(factory.store.getRun(id)?.error).toBe("the resolution leaves no change against main");
  expect(await remoteHead()).toBe(head);
  expect(implementations).toBe(1);
  expect(reviewPrompts).toHaveLength(0);
});

test.each(["single", "panel"] as const)(
  "the %s resolution reviewer sees dropped PR hunks against the first parent",
  async (reviewMode) => {
    if (reviewMode === "panel") {
      factory.deps.reviewSystem = {
        name: "panel",
        mode: "panel",
        implementerReport: "omit",
        finders: [{ prompt: "standard", target: "beta/m" }],
        verifier: { target: "alpha/verifier" },
      };
    }
    const cwd = join(root, "work");
    await git(cwd, "checkout", "-q", branch);
    writeFileSync(join(cwd, "survives.txt"), "another PR change\n");
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-qm", "another PR change");
    await git(cwd, "push", "-q", join(root, "remote.git"), `${branch}:refs/heads/${branch}`);
    await git(cwd, "checkout", "-q", "main");
    const head = await remoteHead();
    await advanceBase();
    mode = "dropped";
    const id = await trigger();
    expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("needs_human");
    expect(await remoteHead()).toBe(head);
    expect(reviewPrompts).toHaveLength(1);
    expect(verifierCalls).toBe(reviewMode === "panel" ? 1 : 0);
    expect(reviewPrompts[0]).toContain("diff against the PR head (first parent)");
    expect(reviewPrompts[0]).toContain("-PR intent");
    expect(reviewPrompts[0]).toContain("+base intent");
    expect(implementations).toBe(1);
  },
);

test("delivery keeps a new-head approval recorded after an uncheckpointed push", async () => {
  await advanceBase();
  const id = await trigger();
  const mark = factory.store.markRoundDelivered.bind(factory.store);
  const interrupted = spyOn(factory.store, "markRoundDelivered").mockImplementationOnce(() => {
    throw new Error("interrupted after push");
  });
  expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("failed");
  const head = await remoteHead();
  expect(factory.store.reviewRound(id)?.deliveredSha).toBeNull();
  await submitReview(factory, owner.id, { verdict: "approve", reviewedSha: head });
  interrupted.mockImplementation(mark);
  expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("succeeded");
  expect(factory.store.approvalFor(url)).toEqual({ sha: head, stale: false });
});

test("delivery changes only its trigger's land entry with the exact conflict reason", async () => {
  await advanceBase();
  const entry = await blockedLand();
  const second = factory.store.createLandEntry({
    runId: owner.id,
    repo: owner.repoSlug,
    prUrl: url,
    baseBranch: "main",
    headBranch: branch,
    approvedSha: await remoteHead(),
  });
  factory.store.updateLandEntry(second.id, { state: "blocked", reason: "conflicts with main" });
  const id = triggers()[0]?.run_id as string;
  expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("succeeded");
  expect(factory.store.getLandEntry(entry.id)?.reason).toBe(
    `conflict resolved at ${await remoteHead()}; approve the new head to land`,
  );
  expect(factory.store.getLandEntry(second.id)?.reason).toBe("conflicts with main");
});

test("a changed conflict reason on the trigger's entry is preserved", async () => {
  await advanceBase();
  const entry = await blockedLand();
  factory.store.updateLandEntry(entry.id, { reason: "conflicts with another base" });
  const id = triggers()[0]?.run_id as string;
  expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("succeeded");
  expect(factory.store.getLandEntry(entry.id)?.reason).toBe("conflicts with another base");
});

function cachePr(headRefOid: string, isDraft = false) {
  factory.store.saveGithubPr(
    {
      url,
      repo: "test/repo",
      runId: owner.id,
      nodeId: null,
      data: JSON.stringify({ state: "OPEN", isDraft, headRefOid }),
      delivered: 1,
    },
    false,
    [],
    clock.now(),
  );
}

test("a land trigger uses the live head despite an older cached observation", async () => {
  cachePr("a".repeat(40));
  factory.store.observePrHead(url, "a".repeat(40));
  await trigger();
  expect(calls.filter((args) => args[1] === "view")).toHaveLength(1);
  expect(triggers()).toMatchObject([{ state: "started", attempts: 0 }]);
  expect(factory.store.reviewRounds(url)).toHaveLength(1);
});

test("live draft status overrides the cache and a later observation can start the same trigger", async () => {
  const head = await remoteHead();
  cachePr(head);
  draft = true;
  await trigger();
  expect(triggers()).toMatchObject([{ state: "skipped", reason: "PR is draft" }]);
  expect(factory.store.reviewRounds(url)).toHaveLength(0);
  draft = false;
  cachePr(head, true);
  await processConflictTriggers(factory.store, clock.now, factory.deps.gh);
  await processConflictTriggers(factory.store, clock.now, factory.deps.gh);
  expect(triggers()).toMatchObject([{ state: "started", reason: null }]);
  expect(factory.store.reviewRounds(url)).toHaveLength(1);
});

test("startup uses a live lookup rather than a cached non-draft PR", async () => {
  cachePr(await remoteHead());
  draft = true;
  factory.store.recordConflictTrigger(url, await remoteHead(), "land", clock.now());
  const github = fakeGitHub(clock.now);
  const node = github.add("test/repo", 1);
  node.headRefOid = await remoteHead();
  Object.assign(node, { isDraft: true });
  let reached = () => {};
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const start = factory.store.startConflictTrigger.bind(factory.store);
  spyOn(factory.store, "startConflictTrigger").mockImplementation((...args) => {
    const run = start(...args);
    reached();
    return run;
  });
  const stop = startGitHubPoller(factory.store, {
    client: github.client,
    gh: factory.deps.gh,
    clock: {
      now: clock.now,
      set: clock.timer.set as unknown as typeof setTimeout,
      clear: clock.timer.clear as unknown as typeof clearTimeout,
    },
    log: () => {},
  });
  try {
    await clock.advance(0);
    await ready;
    expect(calls.some((args) => args[1] === "view")).toBe(true);
    expect(factory.store.reviewRounds(url)).toHaveLength(0);
    expect(triggers()[0]).toMatchObject({ state: "skipped", reason: "PR is draft" });
  } finally {
    stop();
  }
});

test("lookup failures remain pending and end after five attempts", async () => {
  cachePr(await remoteHead());
  factory.store.recordConflictTrigger(url, await remoteHead(), "land", clock.now());
  const gh = async () => {
    throw new Error("lookup unavailable");
  };
  for (let attempt = 1; attempt <= 5; attempt++) {
    await expect(processConflictTriggers(factory.store, clock.now, gh)).rejects.toThrow("lookup unavailable");
    expect(triggers()[0]).toMatchObject({ state: attempt < 5 ? "pending" : "skipped", attempts: attempt });
    expect(triggers()[0]?.reason).toContain("lookup unavailable");
  }
  await processConflictTriggers(factory.store, clock.now, gh);
  expect(triggers()[0]?.attempts).toBe(5);
  expect(factory.store.listRuns()).toHaveLength(1);
});

test.each([false, true])(
  "a delivered round never pushes after a branch reset (comment missing: %s)",
  async (missing) => {
    const original = await remoteHead();
    await advanceBase();
    const id = await trigger();
    if (missing) {
      const gh = factory.deps.gh;
      if (!gh) throw new Error("missing fake gh");
      factory.deps.gh = async (args, signal, stdin) => {
        if (args.includes("comments")) throw new Error("interrupted before comment");
        return (await gh(args, signal, stdin)) ?? "";
      };
      expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("failed");
      factory.deps.gh = gh;
    } else {
      factory.deps.faults = {
        "store:save": { action: "kill", when: (c) => c.checkpoint === "delivery-complete" },
      };
      expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("running");
      factory.deps.faults = undefined;
    }
    expect(factory.store.reviewRound(id)?.deliveredSha).toHaveLength(40);
    await git(join(root, "remote.git"), "update-ref", `refs/heads/${branch}`, original);
    const push = spyOn(repos, "pushExistingBranch");
    expect(await executeRun(factory.deps, id, new AbortController().signal)).toBe("succeeded");
    expect(push).not.toHaveBeenCalled();
    expect(await remoteHead()).toBe(original);
    expect(comments).toHaveLength(1);
    expect(calls.filter((args) => args[1] === "comment")).toHaveLength(1);
  },
);

test("shared numbering survives previous-release inserts while the review cap ignores conflicts", async () => {
  const conflict = await trigger();
  factory.store.updateRun(conflict, { status: "succeeded" });
  const repo = factory.store.getRepo(owner.repoId);
  if (!repo) throw new Error("missing repo");
  const oldRound = factory.store.createRun(repo, { repo: repo.slug, prompt: "Previous release round" });
  factory.store.updateRun(oldRound.id, { status: "succeeded" });
  factory.store.db
    .query(`INSERT INTO review_rounds (run_id, source_run_id, pr_url, round, reviewed_sha, findings, created_at)
    VALUES (?, ?, ?, (SELECT count(*) + 1 FROM review_rounds WHERE pr_url = ?), ?, '[]', ?)`)
    .run(oldRound.id, owner.id, url, url, await remoteHead(), clock.now());
  const request = (round: number) => ({
    repo: repo.slug,
    prompt: `Review ${round}`,
    baseBranch: branch,
    deliveryBranch: branch,
    sourceRef: {
      kind: "review-round" as const,
      runId: owner.id,
      round,
      prUrl: url,
      reviewedSha: review.reviewedSha,
    },
  });
  const review = { prUrl: url, reviewedSha: await remoteHead(), findings: [], cap: 2 };
  const result = factory.store.createReviewRound(repo, owner, review, request);
  expect("run" in result).toBe(true);
  expect(factory.store.reviewRounds(url)).toMatchObject([
    { kind: "conflict", round: 1 },
    { kind: "review", round: 2 },
    { kind: "review", round: 3 },
  ]);
  if ("run" in result) factory.store.updateRun(result.run.id, { status: "succeeded" });
  expect(factory.store.createReviewRound(repo, owner, review, request)).toHaveProperty("limited");
});

test("round kinds are validated in code without a database CHECK", async () => {
  const id = await trigger();
  factory.store.db.query("UPDATE review_rounds SET kind = 'unknown' WHERE run_id = ?").run(id);
  expect(() => factory.store.reviewRound(id)).toThrow("Invalid review round kind");
  expect(() => factory.store.reviewRounds(url)).toThrow("Invalid review round kind");
});
