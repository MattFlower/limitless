import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Paths } from "../src/config.ts";
import type { LandEntry, Run } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { gateSlots } from "../src/gates/slots.ts";
import { observerRoots } from "../src/harness/sandbox.ts";
import type { GitHubPrView } from "../src/integrations/github-notifier.ts";
import { type LandPrClient, LandQueue } from "../src/land/queue.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { waitClock } from "./wait-clock.ts";

// These tests drive real git and confined gate commands; under CPU load they outlast Bun's 5 s default.
setDefaultTimeout(30_000);

const SLUG = "test/repo";
const url = (n: number) => `https://github.com/${SLUG}/pull/${n}`;
const gateLogPath = () => join(root, "gates.log");

let root: string;
let bare: string;
let seed: string;
let store: Store;
let paths: Paths;
let clock: ReturnType<typeof waitClock>;
let originalPath: string | undefined;
let slots: number;
const queues: LandQueue[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "limitless-land-"));
  // Confined gate commands may write their log under this root and nowhere else.
  observerRoots.add(realpathSync(root));
  paths = {
    home: join(root, "data"),
    db: join(root, "data/limitless.db"),
    repos: join(root, "data/repos"),
    work: join(root, "data/work"),
    runs: join(root, "data/runs"),
    configDir: join(root, "cfg"),
  };
  for (const dir of [paths.home, paths.repos, paths.work, paths.runs]) mkdirSync(dir, { recursive: true });
  store = new Store(paths.db);
  ci = () => ({ ci: "SUCCESS" });
  landLog.length = 0;
  clock = waitClock();
  slots = gateSlots.limit;
  gateSlots.setLimit(1);
  bare = join(root, "remote.git");
  seed = join(root, "seed");
  mkdirSync(seed);
  await sh(["git", "init", "-q", "--bare", bare], { cwd: root });
  await sh(["git", "init", "-q", "-b", "main"], { cwd: seed });
  writeFileSync(join(seed, "README.md"), "base\n");
  // Each check brackets its own run in a log, so overlapping land checks are visible.
  writeFileSync(
    join(seed, ".limitless.toml"),
    `[gates]\nchecks = [{ name = "land", run = "echo start >> '${gateLogPath()}'; sleep 0.3; echo end >> '${gateLogPath()}'" }]\n`,
  );
  await sh(["git", "add", "."], { cwd: seed });
  await sh(["git", "commit", "-qm", "base"], { cwd: seed });
  await sh(["git", "push", "-q", bare, "main"], { cwd: seed });
  fakeGh();
});

afterEach(async () => {
  for (const q of queues) await q.stop().catch(() => undefined);
  queues.length = 0;
  gateSlots.setLimit(slots);
  observerRoots.clear();
  process.env.PATH = originalPath;
  store.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * A `gh` on PATH that records every call and reads each PR's head out of the bare remote, so a merge
 * whose `--match-head-commit` names another commit is refused exactly as GitHub would. `gh.branch-n`
 * names a PR's branch, `gh.auto` records armed auto-merge, `gh.hang` stalls a merge and `gh.reject`
 * refuses every merge.
 */
function fakeGh(): void {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}
import {appendFileSync,existsSync,readFileSync,writeFileSync} from "node:fs";
const file=${JSON.stringify(join(root, "gh"))}, args=process.argv.slice(2);
appendFileSync(file+".calls",args.join(" ")+"\\n");
const pr=args[2].match(/pull\\/(\\d+)/)?.[1]??"0", merged=existsSync(file+".merged-"+pr);
const branch=existsSync(file+".branch-"+pr)?readFileSync(file+".branch-"+pr,"utf8").trim():"";
const head=()=>branch?new TextDecoder().decode(Bun.spawnSync(["/usr/bin/git","--git-dir",${JSON.stringify(bare)},"rev-parse","refs/heads/"+branch]).stdout).trim():"";
const flag=(n)=>args.includes(n);
if(args[0]!=="pr"||args[1]!=="merge"){ if(args[1]==="view") console.log(merged?"MERGED":"OPEN"); process.exit(0); }
if(flag("--auto")) writeFileSync(file+".auto","");
if(flag("--disable-auto")){ rmSync(file+".auto",{force:true}); process.exit(0); }
if(existsSync(file+".hang")) await Bun.sleep(600000);
const pin=args[args.indexOf("--match-head-commit")+1];
if(pin&&pin!==head()){ console.error("head ref was modified; not merging"); process.exit(1); }
if(existsSync(file+".reject")){ console.error("Pull request is not mergeable"); process.exit(1); }
writeFileSync(file+".merged-"+pr,"");
`,
    { mode: 0o755 },
  );
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
}

/** The poller's saved observation of each PR: the head, its CI rollup and the item it writes. */
/** What the queue reported, so a test can wait for a rerun it cannot otherwise observe. */
const landLog: string[] = [];
const observers = new Map<string, (head: string, ci: string, failing?: string[]) => void>();
/** Feed items dedupe per observation, so each published verdict is a new one. */
let revision = 0;
/** What CI reports next for a waiting entry; `null` leaves it waiting for another signal. */
let ci: () => { ci: string; failing?: string[] } | null = () => ({ ci: "SUCCESS" });
const runs = new Map<number, Run>();

/** The review approval `limitless land` reads: this head, reviewed. */
const approve = (n: number, head: string) => {
  const run = runs.get(n);
  if (!run) throw new Error(`no run for PR ${n}`);
  store.recordApproval(run.id, url(n), head, "orchestrator");
};

/** A succeeded run that delivered `branch` as PR `n`, with the poller's observation of its head. */
function delivered(n: number, branch: string): { run: Run; prUrl: string } {
  const repo = store.upsertRepo({
    slug: SLUG,
    kind: "github",
    url: bare,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, { repo: SLUG, prompt: `pr ${n}` });
  runs.set(n, run);
  store.updateRun(run.id, {
    prUrl: url(n),
    branch,
    baseBranch: "main",
    status: "succeeded",
    title: `PR ${n}`,
  });
  store.putArtifact(run.id, "report.md", "report", `report for ${n}\n`);
  observers.set(url(n), (head, ci, failing = []) =>
    store.saveGithubPr({
      url: url(n),
      repo: SLUG,
      runId: run.id,
      delivered: 1,
      nodeId: `PR_${n}`,
      data: JSON.stringify({
        headRefOid: head,
        state: "OPEN",
        ci,
        failing: failing.map((name) => ({ name, url: null })),
      }),
    }),
  );
  return { run, prUrl: url(n) };
}

const observe = (n: number, head: string, ci = "PENDING", failing: string[] = []) =>
  observers.get(url(n))?.(head, ci, failing);

/** Push `text` to `name`, reusing the branch when a test already pushed one there. */
async function pushBranch(name: string, file: string, text: string, pr = 1): Promise<string> {
  const existing = await sh(["git", "rev-parse", "--verify", "-q", `refs/heads/${name}`], {
    cwd: seed,
    allowFail: true,
  });
  await sh(["git", "checkout", "-q", ...(existing.exitCode === 0 ? [name] : ["-b", name, "main"])], {
    cwd: seed,
  });
  writeFileSync(join(seed, file), text);
  await sh(["git", "add", "."], { cwd: seed });
  await sh(["git", "commit", "-qm", name], { cwd: seed });
  await sh(["git", "push", "-q", bare, `HEAD:refs/heads/${name}`], { cwd: seed });
  // `gh pr view` only ever sees what has been pushed: it reads the branch out of the bare remote.
  writeFileSync(join(root, `gh.branch-${pr}`), name);
  return remoteHead(name);
}

/** The base moves on: a new commit on main, as another landed PR would leave it. */
async function advanceBase(): Promise<void> {
  await sh(["git", "checkout", "-q", "main"], { cwd: seed });
  writeFileSync(join(seed, "base.txt"), "moved\n");
  await sh(["git", "add", "."], { cwd: seed });
  await sh(["git", "commit", "-qm", "base moves"], { cwd: seed });
  await sh(["git", "push", "-q", bare, "main"], { cwd: seed });
}

const remoteHead = (branch: string) =>
  sh(["git", "rev-parse", `refs/heads/${branch}`], { cwd: bare }).then((r) => r.stdout.trim());

function queue(
  opts: {
    polling?: boolean;
    client?: LandPrClient;
    ciPollMs?: number;
    ciTimeoutMs?: number;
    start?: boolean;
  } = {},
): LandQueue {
  const q = new LandQueue({
    store,
    paths,
    confinement: fakeConfinement,
    clock: {
      now: clock.now,
      set: (fn, ms) => clock.timer.set(fn, ms),
      clear: (id) => clock.timer.clear(id as unknown as number),
    },
    log: (message: string) => void landLog.push(message),
    ...opts,
  });
  queues.push(q);
  if (opts.start !== false) q.start();
  return q;
}

/** Answer CI for whatever each entry waits on, then let promise chains settle on the fake clock. */
async function tick(answer?: { ci: string; failing?: string[] }): Promise<void> {
  const plan = answer ?? ci();

  // A claimed entry with a pushed commit is in its CI phase, whatever the claim left it as.
  for (const entry of store.listLandEntries({ active: true }))
    if (entry.pushedSha && plan) observers.get(entry.prUrl)?.(entry.pushedSha, plan.ci, plan.failing ?? []);
  await clock.advance(100);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Advance the injected clock until the queue is idle. */
async function settle(answer?: { ci: string; failing?: string[] }): Promise<void> {
  const end = Date.now() + 20_000;
  while (store.listLandEntries({ active: true }).length) {
    if (Date.now() > end)
      throw new Error(`land queue stuck in ${JSON.stringify(store.listLandEntries({ active: true }))}`);
    await tick(answer);
  }
}

/** Lets the queue's promise chains settle without answering CI or moving the clock. */
async function settleIdle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(check: () => boolean, answer?: { ci: string; failing?: string[] }): Promise<void> {
  const end = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for the land queue");
    await tick(answer);
  }
}

const autoArmed = () => existsSync(join(root, "gh.auto"));
const ghCalls = (verb: string) =>
  (existsSync(join(root, "gh.calls")) ? readFileSync(join(root, "gh.calls"), "utf8") : "")
    .split("\n")
    .filter((call) => call.startsWith(verb));

const gateLog = () =>
  existsSync(gateLogPath()) ? readFileSync(gateLogPath(), "utf8").trim().split("\n") : [];

test("two approved entries on one repository land in order, never checking at once", async () => {
  const first = delivered(1, "pr-1");
  const head1 = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head1);
  approve(1, head1);
  const second = delivered(2, "pr-2");
  const head2 = await pushBranch("pr-2", "two.txt", "two\n", 2);
  observe(2, head2);
  approve(2, head2);
  const q = queue();
  q.request({ runId: first.run.id });
  q.request({ runId: second.run.id });
  await settle();
  const entries = store.listLandEntries();
  expect(entries.map((e) => [e.id, e.state])).toEqual([
    [1, "landed"],
    [2, "landed"],
  ]);
  expect([first, second].map((pr) => store.getRun(pr.run.id)?.merged)).toEqual([true, true]);
  // One repository, one entry at a time: the second check starts only after the first ends.
  expect(gateLog()).toEqual(["start", "end", "start", "end"]);
  expect(ghCalls("pr merge")).toHaveLength(2);
});

test("three requests submitted together all land, with no further request", async () => {
  const prs = [1, 2, 3].map((n) => delivered(n, `pr-${n}`));
  for (const n of [1, 2, 3]) {
    const head = await pushBranch(`pr-${n}`, `change-${n}.txt`, `change ${n}\n`, n);
    observe(n, head);
    approve(n, head);
  }
  const q = queue();
  for (const pr of prs) q.request({ runId: pr.run.id });
  await settle();
  expect(store.listLandEntries().map((e) => e.state)).toEqual(["landed", "landed", "landed"]);
  expect(gateLog()).toEqual(["start", "end", "start", "end", "start", "end"]);
});

test("a checking entry whose merge commit is already on the remote resumes and lands", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "change-1.txt", "one\n", 1);
  await advanceBase();
  // The commit a land would have pushed: the approved head with the base merged in.
  await sh(["git", "checkout", "-q", "pr-1"], { cwd: seed });
  await sh(["git", "merge", "-q", "--no-ff", "-m", "limitless: merge base", "main"], { cwd: seed });
  const mergeSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: seed })).stdout.trim();
  await sh(["git", "push", "-q", bare, "HEAD:refs/heads/pr-1"], { cwd: seed });
  observe(1, mergeSha, "PENDING");
  approve(1, head);
  // What a crash between the push and the waiting_ci update leaves behind.
  const entry = store.createLandEntry({
    runId: pr.run.id,
    repo: SLUG,
    prUrl: url(1),
    baseBranch: "main",
    headBranch: "pr-1",
    approvedSha: head,
  });
  store.updateLandEntry(entry.id, { state: "checking", pushedSha: mergeSha, attempts: 1 });
  queue();
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "landed", pushedSha: mergeSha, attempts: 2 });
  expect(await remoteHead("pr-1")).toBe(mergeSha); // nothing was pushed again
  expect(ghCalls("pr merge")).toEqual([
    `pr merge ${url(1)} --squash --delete-branch --match-head-commit ${mergeSha} --subject PR 1 (#1) --body-file -`,
  ]);
  expect(gateLog()).toEqual([]); // the checks had already run before the crash
});

test("a base that moved is merged in and pushed with the lease; an up-to-date entry pushes nothing", async () => {
  const behind = delivered(1, "pr-1");
  const behindHead = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, behindHead);
  approve(1, behindHead);
  await advanceBase();
  const upToDate = delivered(2, "pr-2");
  const head2 = await pushBranch("pr-2", "two.txt", "two\n", 2);
  observe(2, head2);
  approve(2, head2);
  const q = queue();
  q.request({ runId: behind.run.id });
  q.request({ runId: upToDate.run.id });
  await settle();
  const merged = store.getLandEntry(1);
  expect(merged?.state).toBe("landed");
  const mergeSha = merged?.pushedSha ?? "";
  expect(mergeSha).not.toBe(behindHead);
  // The pushed commit is a factory merge commit that carries the moved base.
  expect(await remoteHead("pr-1")).toBe(mergeSha);
  expect(await remoteHead("main")).not.toBe(behindHead);
  const ancestor = await sh(["git", "merge-base", "--is-ancestor", "refs/remotes/origin/main", mergeSha], {
    cwd: join(paths.repos, `${SLUG.replace("/", "__")}.git`),
  });
  expect(ancestor.exitCode).toBe(0);
  // Nothing to merge, nothing to push: the approved head is what lands.
  const ahead = store.getLandEntry(2);
  expect(ahead).toMatchObject({ state: "landed", pushedSha: await remoteHead("pr-2") });
  expect(ghCalls("pr merge")).toEqual([
    `pr merge ${url(1)} --squash --delete-branch --match-head-commit ${mergeSha} --subject PR 1 (#1) --body-file -`,
    `pr merge ${url(2)} --squash --delete-branch --match-head-commit ${ahead?.pushedSha} --subject PR 2 (#2) --body-file -`,
  ]);
});

test("a rejected merge blocks, arms no auto-merge, and a later head never lands", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
  approve(1, head);
  writeFileSync(join(root, "gh.reject"), "");
  const q = queue();
  const entry = q.request({ runId: pr.run.id });
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "blocked", reason: "merge failed" });
  expect(ghCalls("pr merge").some((c) => c.includes("--auto"))).toBe(false);
  expect(autoArmed()).toBe(false);
  expect(ghCalls("pr merge").at(-1)).toContain("--disable-auto");
  // The head moves after the blocked merge; nothing may land on it.
  const moved = await pushBranch("pr-1", "one.txt", "one\nagain\n", 1);
  observe(1, moved);
  approve(1, moved);
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("blocked");
  expect(store.getRun(pr.run.id)?.merged).toBe(false);
  expect(existsSync(join(root, "gh.merged-1"))).toBe(false);
});

test("a pinned merge whose head moved is refused", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
  approve(1, head);
  writeFileSync(join(root, "gh.hang"), ""); // hold the merge while the head moves underneath it
  const q = queue();
  const entry = q.request({ runId: pr.run.id });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "merging");
  const pinned = store.getLandEntry(entry.id)?.pushedSha ?? head;
  await q.stop();
  rmSync(join(root, "gh.hang"));
  await pushBranch("pr-1", "one.txt", "one\nagain\n", 1);
  queue();
  await settle();
  expect(
    ghCalls("pr merge")
      .filter((c) => c.includes("--match-head-commit"))
      .at(-1),
  ).toContain(`--match-head-commit ${pinned}`);
  expect(ghCalls("pr merge").at(-1)).toContain("--disable-auto");
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "blocked", reason: "merge failed" });
  expect(store.getRun(pr.run.id)?.merged).toBe(false);
  expect(existsSync(join(root, "gh.merged-1"))).toBe(false);
});

test("a push to the PR after approval blocks the entry and merges nothing", async () => {
  const pr = delivered(1, "pr-1");
  const head1 = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head1);
  approve(1, head1);
  await advanceBase(); // forces the factory merge commit, so the entry has to push
  const q = queue();
  const entry = q.request({ runId: pr.run.id });
  // Someone pushes to the branch after the operator approved the head.
  const pushedByHand = await pushBranch("pr-1", "one.txt", "one\nedited\n", 1);
  observe(1, pushedByHand);
  approve(1, pushedByHand);
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({
    state: "blocked",
    reason: "head moved after approval",
  });
  expect(await remoteHead("pr-1")).toBe(pushedByHand); // the factory's push never landed
  expect(ghCalls("pr merge")).toEqual([]);
  expect(store.getRun(pr.run.id)?.merged).toBe(false);
});

test("a conflicting base blocks the entry without pushing", async () => {
  const pr = delivered(1, "pr-1");
  const approved = await pushBranch("pr-1", "shared.txt", "from the pr\n", 1);
  observe(1, approved);
  approve(1, approved);
  await sh(["git", "checkout", "-q", "main"], { cwd: seed });
  writeFileSync(join(seed, "shared.txt"), "from the base\n");
  await sh(["git", "add", "."], { cwd: seed });
  await sh(["git", "commit", "-qm", "base takes the file"], { cwd: seed });
  await sh(["git", "push", "-q", bare, "main"], { cwd: seed });
  const q = queue();
  const entry = q.request({ runId: pr.run.id });
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "blocked", reason: "conflicts with main" });
  expect(await remoteHead("pr-1")).toBe(approved);
  expect(ghCalls("pr merge")).toEqual([]);
});

test("red CI on the pushed commit blocks the entry with the failing check names", async () => {
  const pr = delivered(1, "pr-1");
  const approved = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, approved);
  approve(1, approved);
  const q = queue();
  const entry = q.request({ runId: pr.run.id });
  await settle({ ci: "FAILURE", failing: ["build", "typecheck"] });
  expect(store.getLandEntry(entry.id)).toMatchObject({
    state: "blocked",
    reason: "CI failed: build, typecheck",
  });
  expect(ghCalls("pr merge")).toEqual([]);
  expect(store.getRun(pr.run.id)?.merged).toBe(false);
  const feed = store.readFeed({ limit: 100 }).items.filter((i) => i.kind.startsWith("land."));
  expect(feed.map((i) => i.kind)).toEqual(["land.queued", "land.blocked"]);
  expect(feed[1]?.data).toMatchObject({ url: url(1), sha: approved, reason: "CI failed: build, typecheck" });
});

test("a failing land check blocks the entry with the check names and no output", async () => {
  writeFileSync(
    join(seed, ".limitless.toml"),
    `[gates]\nchecks = [{ name = "lint", run = "echo 'secret in output'; false" }]\n`,
  );
  await sh(["git", "commit", "-qam", "failing check"], { cwd: seed });
  await sh(["git", "push", "-q", bare, "main"], { cwd: seed });
  const pr = delivered(1, "pr-1");
  const head1 = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head1);
  approve(1, head1);
  const q = queue();
  const entry = q.request({ runId: pr.run.id });
  await settle();
  const blocked = store.getLandEntry(entry.id);
  expect(blocked).toMatchObject({ state: "blocked" });
  // Check names only: the output is in the log, never in the reason.
  expect(blocked?.reason).toMatch(/^lint failed \(/);
  expect(blocked?.reason).not.toContain("secret in output");
  expect(ghCalls("pr merge")).toEqual([]);
});

test("stopping mid-check leaves a later entry unstarted", async () => {
  const first = delivered(1, "pr-1");
  const head1 = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head1);
  approve(1, head1);
  const second = delivered(2, "pr-2");
  const head2 = await pushBranch("pr-2", "two.txt", "two\n", 2);
  observe(2, head2);
  approve(2, head2);
  const q = queue();
  q.request({ runId: first.run.id });
  q.request({ runId: second.run.id });
  await waitFor(() => gateLog().length === 1);
  await q.stop(); // the daemon stops with the second entry still queued
  expect(store.getLandEntry(1)?.state).toBe("checking");
  for (let i = 0; i < 20; i++) await settleIdle();
  expect(store.getLandEntry(2)?.state).toBe("queued");
  expect(gateLog()).toEqual(["start"]);
});

test("a repository claim is durable: a second claim finds nothing", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
  approve(1, head);
  const entry = store.createLandEntry({
    runId: pr.run.id,
    repo: SLUG,
    prUrl: url(1),
    baseBranch: "main",
    headBranch: "pr-1",
    approvedSha: head,
  });
  store.createLandEntry({
    runId: pr.run.id,
    repo: SLUG,
    prUrl: url(2),
    baseBranch: "main",
    headBranch: "pr-2",
    approvedSha: head,
  });
  // The first claim holds the repository; the next is refused by the store, not by memory.
  expect(store.claimLandEntry(SLUG, 30_000)?.id).toBe(entry.id);
  expect(store.claimLandEntry(SLUG, 30_000)).toBeNull();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "checking", attempts: 1 });
  // Only a start releases it: one daemon owns this database, so a claim it finds is a dead one's.
  expect(store.releaseLandClaims()).toBe(1);
  expect(store.claimLandEntry(SLUG, 30_000)?.id).toBe(entry.id);
});

test("two queues on one database never run two checks for the same repository", async () => {
  gateSlots.setLimit(2);
  const first = delivered(1, "pr-1");
  const head1 = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head1);
  approve(1, head1);
  const second = delivered(2, "pr-2");
  const head2 = await pushBranch("pr-2", "two.txt", "two\n", 2);
  observe(2, head2);
  approve(2, head2);
  const a = queue({ start: false });
  const b = queue({ start: false });
  a.request({ runId: first.run.id });
  a.request({ runId: second.run.id });
  b.start();
  a.start();
  await settle();
  expect(store.listLandEntries().map((e) => e.state)).toEqual(["landed", "landed"]);
  expect(gateLog()).toEqual(["start", "end", "start", "end"]);
});

test("a restart during checking re-runs the checks from the start", async () => {
  const pr = delivered(1, "pr-1");
  const head1 = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head1);
  approve(1, head1);
  const first = queue();
  const entry = first.request({ runId: pr.run.id });
  await waitFor(() => gateLog().length === 1); // the check is running
  expect(store.getLandEntry(entry.id)?.state).toBe("checking");
  await first.stop(); // the daemon stopped mid-check
  expect(store.getLandEntry(entry.id)?.state).toBe("checking");
  expect(gateLog()).toEqual(["start"]);
  queue();
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "landed", attempts: 2 });
  expect(gateLog()).toEqual(["start", "start", "end"]); // the killed check never finished
});

test("a restart during waiting_ci resumes waiting on the pushed commit", async () => {
  const pr = delivered(1, "pr-1");
  const approved = await pushBranch("pr-1", "one.txt", "one\n", 1);
  // Polling off: the queue reads `gh pr view` instead of the poller's saved observation.
  const view: GitHubPrView = {
    url: url(1),
    state: "OPEN",
    mergedAt: null,
    mergedBy: null,
    headRefOid: approved,
    ci: "PENDING",
    failing: [],
  };
  const q = queue({ polling: false, client: async () => ({ ...view }) });
  const entry = q.request({ runId: pr.run.id, sha: approved });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
  await q.stop();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "waiting_ci", pushedSha: approved });
  view.ci = "SUCCESS";
  queue({ polling: false, client: async () => ({ ...view }) });
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  expect(ghCalls("pr merge")).toHaveLength(1);
});

test("a restart during merging takes an already merged PR as landed without merging again", async () => {
  const pr = delivered(1, "pr-1");
  const head1 = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head1);
  approve(1, head1);
  writeFileSync(join(root, "gh.hang"), "");
  const q = queue();
  const entry = q.request({ runId: pr.run.id });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "merging");
  await q.stop();
  expect(store.getLandEntry(entry.id)?.state).toBe("merging");
  rmSync(join(root, "gh.hang"));
  // The merge had in fact landed before the daemon stopped.
  writeFileSync(join(root, "gh.merged-1"), "");
  queue();
  await settle();
  expect(store.getLandEntry(entry.id)).toBeTruthy();
  expect(ghCalls("pr merge")).toHaveLength(1);
  expect(store.getRun(pr.run.id)?.merged).toBe(true);
  expect(store.listLandEntries()[0]?.state).toBe("landed");
});

test("CI that never finishes gives up with a reason", async () => {
  const pr = delivered(1, "pr-1");
  const head1 = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head1);
  approve(1, head1);
  const q = queue({ ciTimeoutMs: 5_000 });
  const entry = q.request({ runId: pr.run.id });
  await settle({ ci: "PENDING" });
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "blocked", reason: "CI did not finish" });
  expect(ghCalls("pr merge")).toEqual([]);
});

test("a CI feed item lands the entry without the clock moving", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
  approve(1, head);
  ci = () => null; // only the test publishes an observation, and no clock ever advances
  const q = queue();
  const entry = q.request({ runId: pr.run.id });
  await waitFor(() => !!store.getLandEntry(entry.id)?.pushedSha);
  expect(clock.pending).toBeGreaterThan(0); // the fallback read is armed, and is not what wakes it
  observers.get(url(1))?.(store.getLandEntry(entry.id)?.pushedSha ?? "", "SUCCESS");
  await waitFor(() => store.getLandEntry(entry.id)?.state === "landed");
  expect(ghCalls("pr merge")).toHaveLength(1);
});

test("a transient CI failure is re-run once and lands", async () => {
  const flaky = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
  approve(1, head);
  ci = () => null; // the test answers CI itself, one verdict at a time
  const q = queue();
  const entry = q.request({ runId: flaky.run.id });
  const published = async () => store.getLandEntry(entry.id)?.pushedSha ?? "";
  await waitFor(() => !!store.getLandEntry(entry.id)?.pushedSha);
  observers.get(url(1))?.(await published(), "FAILURE", ["network"]);
  await waitFor(() => landLog.some((l) => l.includes("transient CI failure")));
  observers.get(url(1))?.(await published(), "SUCCESS");
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  expect(landLog.filter((l) => l.includes("transient CI failure"))).toHaveLength(1);
});

test("a transient CI failure twice blocks, and a real one is not re-run", async () => {
  const broken = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
  approve(1, head);
  ci = () => null;
  const q = queue();
  const entry = q.request({ runId: broken.run.id });
  await waitFor(() => !!store.getLandEntry(entry.id)?.pushedSha);
  const pinned = store.getLandEntry(entry.id)?.pushedSha ?? "";
  observers.get(url(1))?.(pinned, "FAILURE", ["network"]);
  await waitFor(() => landLog.some((l) => l.includes("transient CI failure")));
  observers.get(url(1))?.(pinned, "FAILURE", ["network"]);
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "blocked", reason: "CI failed: network" });

  const real = delivered(2, "pr-2");
  const head2 = await pushBranch("pr-2", "two.txt", "two\n", 2);
  observe(2, head2);
  approve(2, head2);
  ci = () => null;
  landLog.length = 0;
  const second = q.request({ runId: real.run.id });
  await waitFor(() => !!store.getLandEntry(second.id)?.pushedSha);
  observers.get(url(2))?.(store.getLandEntry(second.id)?.pushedSha ?? "", "FAILURE", ["build"]);
  await settle();
  expect(store.getLandEntry(second.id)).toMatchObject({ state: "blocked", reason: "CI failed: build" });
  expect(landLog.some((l) => l.includes("transient"))).toBe(false);
  expect(ghCalls("pr merge")).toEqual([]);
});

test("a head that changes while waiting blocks at once", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
  approve(1, head);
  ci = () => ({ ci: "PENDING" });
  const q = queue();
  const entry = q.request({ runId: pr.run.id });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
  const moved = await pushBranch("pr-1", "one.txt", "one\nagain\n", 1);
  ci = () => null; // the moved head is the last thing this PR reports
  observers.get(url(1))?.(moved, "SUCCESS");
  await waitFor(() => store.getLandEntry(entry.id)?.state === "blocked");
  expect(store.getLandEntry(entry.id)?.reason).toBe("head moved after approval");
  expect(ghCalls("pr merge")).toEqual([]);
});

test("a cancel interrupts a CI read that never answers", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  let calls = 0;
  const q = queue({
    polling: false,
    ciPollMs: 10,
    // A reader that hangs until it is told to stop: cancel must not wait for it.
    client: (_url, signal) =>
      new Promise<GitHubPrView | null>((resolve) => {
        if (++calls > 1) return resolve(null);
        signal?.addEventListener("abort", () => resolve(null), { once: true });
      }),
  });
  const entry = q.request({ runId: pr.run.id, sha: head });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
  q.cancel(entry.id);
  await q.stop();
  expect(store.getLandEntry(entry.id)?.state).toBe("cancelled");
});

test("a request needs a review approval, or an explicit head that is the PR's", () => {
  const pr = delivered(1, "pr-1");
  const q = queue({ start: false });
  expect(() => q.request({ runId: "missing" })).toThrow("run not found");
  expect(() => q.request({ runId: pr.run.id })).toThrow("no review approval");
  observe(1, "c".repeat(40));
  approve(1, "c".repeat(40));
  // A head that moved after the approval makes it stale.
  store.observePrHead(url(1), "b".repeat(40));
  expect(() => q.request({ runId: pr.run.id })).toThrow("approval is stale");
  expect(q.request({ runId: pr.run.id, sha: "c".repeat(40) }).approvedSha).toBe("c".repeat(40));
  expect(() => q.request({ runId: pr.run.id, sha: "d".repeat(40) })).toThrow(
    "not the pull request's current head",
  );
  expect(() => q.request({ runId: pr.run.id, sha: "short" })).toThrow("full commit id");
  expect(() => q.request({ runId: pr.run.id, sha: "c".repeat(40) })).toThrow("already in the land queue");
  store.saveGithubPr({
    url: url(1),
    repo: SLUG,
    runId: pr.run.id,
    delivered: 1,
    nodeId: "PR_1",
    data: JSON.stringify({ headRefOid: "c".repeat(40), state: "MERGED", ci: "SUCCESS", failing: [] }),
  });
  expect(() => q.request({ runId: pr.run.id })).toThrow("MERGED");
  expect(store.listLandEntries({ limit: 100 }).filter((e) => e.state === "landed")).toHaveLength(0);
});

test("cancelling a queued land stops it before any git runs", async () => {
  const pr = delivered(1, "pr-1");
  const approved = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, approved);
  approve(1, approved);
  store.createLandEntry({
    runId: pr.run.id,
    repo: SLUG,
    prUrl: url(1),
    baseBranch: "main",
    headBranch: "pr-1",
    approvedSha: approved,
  });
  const q = queue();
  expect(q.cancel(1)).toBe(true);
  expect(q.cancel(1)).toBe(false);
  await settle();
  expect(store.getLandEntry(1)?.state).toBe("cancelled");
  expect(gateLog()).toEqual([]);
});

test("the API queues, lists and cancels lands behind the loopback and content-type guards", async () => {
  const f = await fixture();
  try {
    await f.factory.land.stop(); // no worker: this test is about the routes, not the land itself
    const repo = f.factory.store.upsertRepo({
      slug: SLUG,
      kind: "github",
      url: bare,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const run = f.factory.store.createRun(repo, { repo: SLUG, prompt: "api" });
    f.factory.store.updateRun(run.id, { prUrl: url(7), branch: "pr-7", baseBranch: "main" });
    const routes = createHttpRoutes(f.factory);
    const land = routes["/api/land"] as { GET: Route; POST: Route };
    const cancel = routes["/api/land/:id/cancel"] as { POST: Route };
    const json = { "content-type": "application/json" };
    const post = (body: unknown, headers: Record<string, string> = json) =>
      land.POST(
        requestWithParams("http://localhost:7400/api/land", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
        localServer,
      );
    expect((await post({ runId: run.id }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post({})).status).toBe(400);
    expect((await post({ runId: "missing" })).status).toBe(400);
    const created = (await (await post({ runId: run.id, sha: "b".repeat(40) })).json()) as LandEntry;
    expect(created).toMatchObject({
      runId: run.id,
      prUrl: url(7),
      approvedSha: "b".repeat(40),
      state: "queued",
    });
    const listed = (await (
      await land.GET(requestWithParams("http://localhost:7400/api/land"), localServer)
    ).json()) as LandEntry[];
    expect(listed.map((e) => e.id)).toEqual([created.id]);
    const cancelIt = cancel.POST(
      requestWithParams(
        "http://localhost:7400/api/land/1/cancel",
        { method: "POST", headers: json, body: "{}" },
        { id: String(created.id) },
      ),
      localServer,
    );
    expect((await cancelIt).status).toBe(200);
    expect(f.factory.store.getLandEntry(created.id)?.state).toBe("cancelled");
    expect(
      (
        await cancel.POST(
          requestWithParams(
            "http://localhost:7400/api/land/1/cancel",
            { method: "POST", headers: json, body: "{}" },
            { id: String(created.id) },
          ),
          localServer,
        )
      ).status,
    ).toBe(404);
    const remote = {
      timeout: () => {},
      requestIP: () => ({ address: "10.0.0.9", family: "IPv4", port: 40000 }),
    } as unknown as import("bun").Server<undefined>;
    expect(
      (
        await land.POST(
          requestWithParams("http://localhost:7400/api/land", { method: "POST", headers: json, body: "{}" }),
          remote,
        )
      ).status,
    ).toBe(403);
  } finally {
    await f.close();
  }
});
