import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type Paths } from "../src/config.ts";
import type { LandEntry, Run, StreamMessage } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { RunnerFailureEvidence } from "../src/gates/attribution.ts";
import { type GateExecutor, type GateRequest, gateProvenance } from "../src/gates/executor.ts";
import { parseJUnit } from "../src/gates/junit.ts";
import { redactGateData } from "../src/gates/output.ts";
import { type GateResult, type GateRun, runLocalGates } from "../src/gates/run.ts";
import { gateSlots } from "../src/gates/slots.ts";
import { worktreeGitScope } from "../src/git/command.ts";
import * as gitMerge from "../src/git/merge.ts";
import * as repos from "../src/git/repos.ts";
import { ensureCache } from "../src/git/repos.ts";
import { confinementScope, observerRoots } from "../src/harness/sandbox.ts";
import { type GhRunner, runGh } from "../src/integrations/github.ts";
import { configureGitHubIdentity } from "../src/integrations/github-identity.ts";
import { type GitHubPrView, getGitHubPr, reconcileMergedRuns } from "../src/integrations/github-notifier.ts";
import { type GitHubClient, normalizePr, startGitHubPoller } from "../src/integrations/github-poller.ts";
import { type LandPrClient, LandQueue } from "../src/land/queue.ts";
import { processConflictTriggers } from "../src/pipeline/conflict-round.ts";
import { markReport, reportStructure, reportText } from "../src/pipeline/report-privacy.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import * as proc from "../src/util/proc.ts";
import { CommandError, registerCredential, sh } from "../src/util/proc.ts";
import { GateRunSchema } from "../src/workers/protocol.ts";
import { validRun } from "../src/workers/validation.ts";
import { fakeConfinement, recordingConfinement } from "./confinement.ts";
import { deferred } from "./evals-support.ts";
import { fakeGitHub, respond } from "./github-poller-support.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { test, testReadPolicy } from "./read-policy-support.ts";
import { waitClock } from "./wait-clock.ts";

// These tests drive real git and confined gate commands; under CPU load they outlast Bun's 5 s default.
setDefaultTimeout(30_000);

const SLUG = "test/repo";
const url = (n: number) => `https://github.com/${SLUG}/pull/${n}`;
const gateLogPath = () => join(root, "gates.log");
const gateReleasePath = () => join(root, "release");

let root: string;
let bare: string;
let seed: string;
let store: Store;
let paths: Paths;
let clock: ReturnType<typeof waitClock>;
let originalPath: string | undefined;
let slots: number;
let github: ReturnType<typeof fakeGitHub>;
let landConfinement: ReturnType<typeof recordingConfinement>;
const pendingPrReads = new Set<object>();
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
  pendingPrReads.clear();
  observers.clear();
  runs.clear();
  clock = waitClock();
  github = fakeGitHub(clock.now);
  landConfinement = recordingConfinement();
  slots = gateSlots.limit;
  gateSlots.setLimit(1);
  bare = join(root, "remote.git");
  seed = join(root, "seed");
  mkdirSync(seed);
  await sh(["git", "init", "-q", "--bare", bare], { cwd: root });
  await sh(["git", "init", "-q", "-b", "main"], { cwd: seed });
  writeFileSync(join(seed, "README.md"), "base\n");
  // Each check brackets its own run in a log, so overlapping land checks are visible.
  // Keep the overlap window even when the release file already exists.
  // Most tests release checks immediately; stop tests hold them until shutdown.
  writeFileSync(gateReleasePath(), "");
  writeFileSync(
    join(seed, ".limitless.toml"),
    `[gates]\nchecks = [{ name = "land", run = "echo start >> '${gateLogPath()}'; sleep 0.3; while [ ! -e '${gateReleasePath()}' ]; do sleep 0.05; done; echo end >> '${gateLogPath()}'" }]\n`,
  );
  await sh(["git", "add", "."], { cwd: seed });
  await sh(["git", "commit", "-qm", "base"], { cwd: seed });
  await sh(["git", "push", "-q", bare, "main"], { cwd: seed });
  fakeGh();
});

afterEach(async () => {
  for (const q of queues) await q.stop().catch(() => undefined);
  queues.length = 0;
  configureGitHubIdentity(null);
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
import {appendFileSync,existsSync,readFileSync,writeFileSync,rmSync} from "node:fs";
const file=${JSON.stringify(join(root, "gh"))}, args=process.argv.slice(2);
appendFileSync(file+".calls",args.join(" ")+"\\n");
if(args[0]==="run") {
 if(args[1]==="list") console.log(readFileSync(file+".runs","utf8"));
 if(args[1]==="rerun") writeFileSync(file+".rerun","");
 process.exit(0);
}
const pr=args[2].match(/pull\\/(\\d+)/)?.[1]??"0", merged=existsSync(file+".merged-"+pr);
const branch=existsSync(file+".branch-"+pr)?readFileSync(file+".branch-"+pr,"utf8").trim():"";
const baseRefName=existsSync(file+".base-"+pr)?readFileSync(file+".base-"+pr,"utf8").trim():undefined;
const head=()=>branch?new TextDecoder().decode(Bun.spawnSync(["/usr/bin/git","--git-dir",${JSON.stringify(bare)},"rev-parse","refs/heads/"+branch]).stdout).trim():"";
const extra=existsSync(file+".view-"+pr)?JSON.parse(readFileSync(file+".view-"+pr,"utf8")):{};
const flag=(n)=>args.includes(n);
if(args[1]==="view" && args.includes("title,body,headRefOid,state")) {
 while(existsSync(file+".hold-view")) await Bun.sleep(10);
}
if(args[1]==="view" && args.includes("url,state,isDraft,headRefOid,mergedBy,mergedAt")) {
 if(existsSync(file+".preflight-error")){ console.error("metadata lookup denied"); process.exit(1); }
 if(existsSync(file+".preflight")){ console.log(readFileSync(file+".preflight","utf8")); process.exit(0); }
}
if(args[0]!=="pr"||args[1]!=="merge"){
 if(args[1]==="view") console.log(args.includes("--jq")? (merged?"MERGED":"OPEN") : JSON.stringify({url:args[2],title:"PR text",body:"PR body",baseRefName,headRefOid:head(),state:merged?"MERGED":"OPEN",isDraft:false,mergedBy:merged&&!existsSync(file+".no-metadata")?{login:"owner"}:null,mergedAt:merged&&!existsSync(file+".no-metadata")?"2026-10-13T12:00:00Z":null,statusCheckRollup:[],headRefName:branch,isCrossRepository:false,...extra}));
 process.exit(0);
}
if(flag("--body-file")) writeFileSync(file+".body-"+pr,await Bun.stdin.text());
if(flag("--auto")) writeFileSync(file+".auto","");
if(flag("--disable-auto")){ rmSync(file+".auto",{force:true}); process.exit(0); }
if(existsSync(file+".hang")) await Bun.sleep(600000);
while(existsSync(file+".hold-merge")) await Bun.sleep(10);
const pin=args[args.indexOf("--match-head-commit")+1];
if(pin&&pin!==head()){ console.error("head ref was modified; not merging"); process.exit(1); }
if(existsSync(file+".reject-once")){ rmSync(file+".reject-once"); console.error("HTTP 502"); process.exit(1); }
if(existsSync(file+".reject")){ console.error(readFileSync(file+".reject","utf8")||"Pull request is not mergeable"); process.exit(1); }
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
function delivered(n: number, branch: string, requestedBy?: string): { run: Run; prUrl: string } {
  const repo = store.upsertRepo({
    slug: SLUG,
    kind: "github",
    url: bare,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const run = store.createRun(repo, { repo: SLUG, prompt: `pr ${n}`, requestedBy });
  runs.set(n, run);
  store.updateRun(run.id, {
    prUrl: url(n),
    branch,
    baseBranch: "main",
    status: "succeeded",
    title: `PR ${n}`,
  });
  store.putArtifact(run.id, "report.md", "report", `report for ${n}\n`);
  const node = github.add(SLUG, n);
  observers.set(url(n), (head, ci, failing = []) => {
    node.headRefOid = head;
    const commit = node.commits.nodes[0]?.commit;
    if (commit)
      commit.statusCheckRollup = {
        state: ci,
        contexts: { nodes: failing.map((name) => ({ name, conclusion: "FAILURE" })) },
      };
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
    });
  });
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
async function advanceBase(checkMerged = false): Promise<void> {
  await sh(["git", "checkout", "-q", "main"], { cwd: seed });
  writeFileSync(join(seed, "base.txt"), "moved\n");
  if (checkMerged)
    writeFileSync(
      join(seed, ".limitless.toml"),
      `[gates]\nchecks = [{ name = "land", run = "test -f one.txt && cat base.txt >> '${gateLogPath()}'" }]\n`,
    );
  await sh(["git", "add", "."], { cwd: seed });
  await sh(["git", "commit", "-qm", "base moves"], { cwd: seed });
  await sh(["git", "push", "-q", bare, "main"], { cwd: seed });
}

const remoteHead = (branch: string) =>
  sh(["git", "rev-parse", `refs/heads/${branch}`], { cwd: bare }).then((r) => r.stdout.trim());

function roundRun(ownerId: string, prUrl: string, head: string, db = store): Run {
  const owner = db.getRun(ownerId);
  const repo = owner && db.getRepo(owner.repoId);
  if (!owner || !repo || !owner.branch) throw new Error("missing round owner");
  const result = db.createReviewRound(
    repo,
    owner,
    { prUrl, reviewedSha: head, findings: [], cap: 3 },
    (round) => ({
      repo: repo.slug,
      prompt: "review round",
      baseBranch: owner.branch ?? undefined,
      deliveryBranch: owner.branch ?? undefined,
      sourceRef: { kind: "review-round", runId: owner.id, round, prUrl, reviewedSha: head },
    }),
  );
  if (!("run" in result)) throw new Error("round refused");
  return db.updateRun(result.run.id, { status: "succeeded", title: "Reviewed PR" });
}

function queue(
  opts: {
    cfg?: import("../src/config.ts").Config;
    polling?: boolean;
    requiresApproval?: ReadonlySet<string>;
    client?: LandPrClient;
    ciPollMs?: number;
    ciTimeoutMs?: number;
    ciReruns?: boolean;
    start?: boolean;
    gateExecutor?: GateExecutor;
    gh?: GhRunner;
    github?: GitHubClient;
  } = {},
): LandQueue {
  const q = new LandQueue({
    store,
    paths,
    readPolicy: testReadPolicy,
    github: github.client,
    confinement: landConfinement.backend,
    clock: {
      now: clock.now,
      set: (fn, ms) => clock.timer.set(fn, ms),
      clear: (id) => clock.timer.clear(id as unknown as number),
    },
    log: (message: string) => void landLog.push(message),
    ...opts,
    get gateExecutor() {
      return opts.gateExecutor;
    },
    client: async (url, signal) => {
      const read = {};
      pendingPrReads.add(read);
      try {
        return await (opts.client ?? getGitHubPr)(url, signal);
      } finally {
        pendingPrReads.delete(read);
      }
    },
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
  // A real fake-gh subprocess needs event-loop turns, not elapsed simulated network time.
  if (!pendingPrReads.size) await clock.advance(100);
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

async function waitWithoutClock(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check() && Date.now() < end) await settleIdle();
  expect(check()).toBe(true);
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

const testCommand =
  'bun test --parallel=$(bun scripts/test-workers.ts) --reporter=junit --reporter-outfile="$LIMITLESS_GATE_REPORT"';
const otherTestCommand = "bun test ./other.test.ts";
const retryFile = "space ' quote.test.ts";
const retryCommand = "bun test --isolate './space '\\'' quote.test.ts'";

async function retryLandFixture(
  retryFiles: unknown = "bun test --isolate {files}",
  checkName = "test",
  setup = "prepare",
  command = testCommand,
) {
  writeFileSync(
    join(seed, retryFile),
    'import { test, expect } from "bun:test";\nimport ready from "retry-dependency";\ntest("retry dependency", () => expect(ready).toBe(true));\n',
  );
  writeFileSync(
    join(seed, ".limitless.toml"),
    `[gates]
setup = [${JSON.stringify(setup)}]
checks = [{ name = ${JSON.stringify(checkName)}, run = ${JSON.stringify(command)}, timeoutSec = 300 }, { name = "other", run = ${JSON.stringify(otherTestCommand)}, timeoutSec = 90 }, { name = "lint", run = "lint" }]
${retryFiles === null ? "" : `retry_files = ${JSON.stringify(retryFiles)}`}
`,
  );
  await sh(["git", "add", "."], { cwd: seed });
  await sh(["git", "commit", "-qm", "base retry configuration"], { cwd: seed });
  await sh(["git", "push", "-q", bare, "main"], { cwd: seed });
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", ".limitless.toml", '[gates]\nretry_files = "untrusted {files}"\n');
  observe(1, head);
  approve(1, head);
  return { pr, head };
}

function gateResult(name: string, command: string, overrides: Partial<GateResult> = {}): GateResult {
  return { name, command, ok: true, exitCode: 0, durationMs: 1, output: "passed", ...overrides };
}

function retryRun(req: GateRequest, failures: Record<string, Partial<GateResult>> = {}): GateRun {
  return {
    sha: req.headSha,
    trackedClean: true,
    setupOk: true,
    setup: req.gates.setup.map((command) => gateResult("setup", command)),
    checks: req.gates.checks.map((c) => gateResult(c.name, c.run, failures[c.name])),
  };
}

const testFailure: Partial<GateResult> = {
  ok: false,
  exitCode: 1,
  output: "initial test failure",
  failedFiles: [retryFile],
  failedFileTimes: { [retryFile]: 2 },
  failureAttributionComplete: true,
};

function fakeLandGates(
  run: (req: GateRequest, attempt: number, signal: AbortSignal) => GateRun | Promise<GateRun>,
) {
  const requests: GateRequest[] = [];
  const executor: GateExecutor = {
    kind: "lan",
    freshCheckoutFor: () => true,
    async start(req) {
      requests.push(req);
      return { kind: "lan", id: String(requests.length), startedAt: 0 };
    },
    attach(handle, signal, req) {
      if (!req) throw new Error("Missing fake request");
      const result = Promise.resolve(run(req, Number(handle.id), signal));
      return {
        result,
        events: {
          async *[Symbol.asyncIterator]() {
            const completed = await result;
            for (const r of completed.setup)
              yield { type: "check" as const, phase: "setup" as const, result: r };
            for (const r of completed.checks)
              yield { type: "check" as const, phase: "check" as const, result: r };
          },
        },
        async cancel() {},
      };
    },
  };
  return { executor, requests };
}

test.each(["targeted", "skipped", "mixed", "failure"])("land docs-only selection: %s", async (mode) => {
  mkdirSync(join(seed, "test"));
  writeFileSync(join(seed, "test/a.test.ts"), mode === "skipped" ? "unrelated" : "README.md");
  writeFileSync(join(seed, "test/b.test.ts"), "unrelated");
  writeFileSync(
    join(seed, ".limitless.toml"),
    `[gates]
docs = ["*.md"]
retry_files = "bun test {files}"
checks = [{name="lint",run="fake-lint"}, {name="test",run="bun test --reporter-outfile=$LIMITLESS_GATE_REPORT"}]
`,
  );
  await sh(["git", "add", "."], { cwd: seed });
  await sh(["git", "commit", "-qm", "docs gates"], { cwd: seed });
  await sh(["git", "push", "-q", bare, "main"], { cwd: seed });
  const pr = delivered(1, "pr-1");
  let head = await pushBranch("pr-1", "README.md", "updated\n");
  if (mode === "mixed") head = await pushBranch("pr-1", "source.ts", "export {};\n");
  observe(1, head);
  approve(1, head);
  const fake = fakeLandGates((req) =>
    retryRun(req, mode === "failure" ? { test: { ok: false, exitCode: 1 } } : {}),
  );
  const q = queue({ gateExecutor: fake.executor });
  try {
    const entry = await q.request({ target: pr.run.id });
    await waitFor(() => store.getLandEntry(entry.id)?.state === (mode === "failure" ? "blocked" : "landed"));
    expect(fake.requests.flatMap((r) => r.gates.checks.map((c) => c.run))).toEqual([
      "fake-lint",
      ...(mode === "skipped"
        ? []
        : [
            mode !== "mixed"
              ? "bun test './test/a.test.ts'"
              : "bun test --reporter-outfile=$LIMITLESS_GATE_REPORT",
          ]),
    ]);
    const log = readFileSync(store.getLandEntry(entry.id)?.logPath ?? "", "utf8");
    expect(log).toContain(`"mode":"${mode === "mixed" ? "full" : mode === "failure" ? "targeted" : mode}"`);
    if (mode === "targeted") {
      const message =
        "test: targeted pass (test/a.test.ts; docs-only change; test source references a changed path or basename";
      expect(log).toContain(message);
      expect(store.listEvents(pr.run.id).some((e) => e.type === "gate" && e.message.includes(message))).toBe(
        true,
      );
    }
    if (mode === "failure") {
      expect(store.getLandEntry(entry.id)?.reason).toContain("test failed");
      expect(log).not.toContain("targeted pass");
      expect(ghCalls("pr merge")).toEqual([]);
    }
    if (mode === "skipped") expect(log).toContain("docs-only change; no test reads the changed files");
    expect(
      store.listEvents(pr.run.id).some((e) => e.type === "gate" && e.message.includes("Gate selection:")),
    ).toBe(true);
  } finally {
    await q.stop();
  }
});

test("a land check pins its executor through fresh-checkout retries; the next entry uses the reload", async () => {
  const { pr } = await retryLandFixture();
  const b = fakeLandGates((req) => retryRun(req));
  const a = fakeLandGates((req, attempt) => {
    current = b.executor;
    return retryRun(req, attempt === 1 ? { test: testFailure } : {});
  });
  let current = a.executor;
  const freshLookups: string[] = [];
  a.executor.freshCheckoutFor = (repo) => {
    freshLookups.push(repo);
    return true;
  };
  b.executor.freshCheckoutFor = () => {
    throw new Error("The first entry must use A's fresh checkout policy");
  };
  const q = queue({
    get gateExecutor() {
      return current;
    },
  });
  const first = await q.request({ target: pr.run.id });
  await settle();
  expect(store.getLandEntry(first.id)?.state).toBe("landed");
  expect(a.requests.map((r) => r.gates.checks.map((c) => c.run))).toEqual([
    [testCommand, otherTestCommand, "lint"],
    [retryCommand],
  ]);
  expect(a.requests[1]?.gates.setup).toEqual(["prepare"]);
  expect(freshLookups).toEqual([SLUG]);
  expect(b.requests).toHaveLength(0);

  b.executor.freshCheckoutFor = () => true;
  const secondPr = delivered(2, "pr-2");
  const head = await pushBranch("pr-2", "second.txt", "second\n", 2);
  observe(2, head);
  approve(2, head);
  const second = await q.request({ target: secondPr.run.id });
  await settle();
  expect(store.getLandEntry(second.id)?.state).toBe("landed");
  expect(a.requests).toHaveLength(2);
  expect(b.requests).toHaveLength(1);
  expect(b.requests[0]?.headSha).toBe(head);
});

test("a compound land check cannot pass on its failing test files alone", async () => {
  const command = "bun test; security-scan";
  const { pr, head } = await retryLandFixture(undefined, "test", "prepare", command);
  const fake = fakeLandGates((req, attempt) => retryRun(req, attempt === 1 ? { test: testFailure } : {}));
  const entry = await queue({ gateExecutor: fake.executor }).request({ target: pr.run.id });
  await settle();
  const blocked = store.getLandEntry(entry.id);
  expect(blocked).toMatchObject({
    state: "blocked",
    pushedSha: null,
    reason: `test failed (${blocked?.logPath})`,
  });
  expect(fake.requests.map((r) => r.gates.checks.map((c) => c.run))).toEqual([
    [command, otherTestCommand, "lint"],
  ]);
  const log = readFileSync(blocked?.logPath ?? "", "utf8");
  expect(log).toContain("initial test failure");
  expect(log).toContain(
    `Land ${entry.id} test: no targeted retry: check is not a single bun test invocation`,
  );
  expect(await remoteHead("pr-1")).toBe(head);
  expect(ghCalls("pr merge")).toEqual([]);
});

test("a redacted compound land command stays ineligible for a targeted retry", async () => {
  const command = `bun test ${String.fromCharCode(27)}]0; security-scan #${String.fromCharCode(7)}`;
  const { pr, head } = await retryLandFixture(undefined, "test", "prepare", command);
  const fake = fakeLandGates((req, attempt) => {
    const run = redactGateData(retryRun(req, attempt === 1 ? { test: testFailure } : {}));
    expect(validRun(req, run)).toBe(true);
    return run;
  });
  const entry = await queue({ gateExecutor: fake.executor }).request({ target: pr.run.id });
  await settle();
  const blocked = store.getLandEntry(entry.id);
  expect(blocked?.state).toBe("blocked");
  expect(fake.requests).toHaveLength(1);
  expect(await remoteHead("pr-1")).toBe(head);
  expect(ghCalls("pr merge")).toEqual([]);
  expect(readFileSync(blocked?.logPath ?? "", "utf8")).toContain(
    `Land ${entry.id} test: no targeted retry: check is not a single bun test invocation`,
  );
});

test("a passing LAN land retry that rewrites tracked files remains blocked", async () => {
  const { pr, head } = await retryLandFixture();
  const remote = join(root, "dirty-retry-checkout");
  const fake = fakeLandGates(async (req, attempt, signal) => {
    if (attempt === 1) return retryRun(req, { test: testFailure });
    await sh(["git", "clone", "-q", "--no-hardlinks", req.cwd, remote], { cwd: root });
    const run = await confinementScope.run(fakeConfinement, () =>
      runLocalGates(
        remote,
        {
          ...req.gates,
          setup: [],
          checks: [{ name: "test", run: "echo rewritten > README.md" }],
        },
        signal,
      ),
    );
    expect(run.checks[0]).toMatchObject({ ok: true, exitCode: 0 });
    return { ...run, ...(await gateProvenance(remote, signal, req.headSha)) };
  });
  const entry = await queue({ gateExecutor: fake.executor }).request({ target: pr.run.id });
  await settle();
  const completed = store.getLandEntry(entry.id);
  expect(completed).toMatchObject({ state: "blocked", pushedSha: null });
  expect(completed?.reason).not.toContain("flaky");
  expect(store.failureObservations()).toMatchObject([
    {
      purpose: "land",
      class: "regression",
      history: "retry_rejected",
      handle_id: `${entry.id}:1`,
      interim: 0,
    },
  ]);
  expect(store.failureObservations()[0]?.finalized_at).toBeNumber();
  const log = readFileSync(completed?.logPath ?? "", "utf8");
  expect(log).toContain("Retry rejected:");
  expect(log).toContain('tracked files changed: ["README.md"]');
  expect(log).toContain("initial test failure");
  expect(ghCalls("pr merge")).toEqual([]);
  expect(ghCalls("git push")).toEqual([]);
  expect((await sh(["git", "rev-parse", "pr-1"], { cwd: bare })).stdout.trim()).toBe(head);
});

test.each([false, true])("targeted land retries record flakes through CI (restart: %s)", async (restart) => {
  const { pr, head } = await retryLandFixture();
  const credential = "synthetic-targeted-land-secret";
  registerCredential("TARGETED_LAND_SECRET", credential);
  const fake = fakeLandGates((req, attempt) =>
    retryRun(
      req,
      attempt === 1
        ? {
            test: { ...testFailure, output: `initial test failure ${credential}` },
            other: { ...testFailure, failedFiles: ["README.md"], failedFileTimes: undefined },
          }
        : { [req.gates.checks[0]?.name ?? ""]: { output: `targeted pass ${credential}` } },
    ),
  );
  ci = () => null;
  const q = queue({ gateExecutor: fake.executor });
  const entry = await q.request({ target: pr.run.id });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
  const summary = `flaky: test (${retryFile}); other (README.md)`;
  expect(store.getLandEntry(entry.id)?.reason).toBe(summary);
  expect(store.failureObservations()).toHaveLength(2);
  expect(
    store
      .failureObservations()
      .every((r) => r.class === "flaky" && r.history === "retry_passed" && r.finalized_at !== null),
  ).toBe(true);
  expect(fake.requests.map((r) => r.gates.checks.map((c) => c.run))).toEqual([
    [testCommand, otherTestCommand, "lint"],
    [retryCommand],
    ["bun test --isolate './README.md'"],
  ]);
  expect(fake.requests.map((r) => r.gates.setup)).toEqual([["prepare"], ["prepare"], ["prepare"]]);
  expect(fake.requests.map((r) => r.priority)).toEqual(["ship", "ship", "ship"]);
  expect(fake.requests.slice(1).map((r) => [r.skipGateSlot, r.gates.checks[0]?.timeoutSec])).toEqual([
    [true, 120],
    [false, 90],
  ]);
  expect(store.listEvents(pr.run.id).filter((e) => e.level === "warn")).toMatchObject([
    { type: "gate", message: `Land ${entry.id} ${summary}` },
  ]);
  const log = readFileSync(store.getLandEntry(entry.id)?.logPath ?? "", "utf8");
  expect(log).toContain(`$ ${testCommand}\ninitial test failure [redacted]`);
  expect(log).toContain(
    `# targeted retry\n\n$ prepare\npassed\n\n$ ${retryCommand}\ntargeted pass [redacted]`,
  );
  expect(log).not.toContain(credential);
  if (restart) {
    await q.stop();
    queue({ gateExecutor: fake.executor });
  }
  ci = () => ({ ci: "SUCCESS" });
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({
    state: "landed",
    reason: `${summary}; merged ${head.slice(0, 12)}`,
  });
  expect(fake.requests).toHaveLength(3);
  expect(ghCalls("pr merge")).toHaveLength(1);
});

test.each(["pass", "cancel", "stop"])("local targeted land retry keeps its slot (%s)", async (action) => {
  const { pr, head } = await retryLandFixture();
  const initial = deferred<void>();
  const finishInitial = deferred<void>();
  const retry = deferred<void>();
  const finishRetry = deferred<void>();
  const aborted = deferred<void>();
  const cleanup = deferred<void>();
  let acquired = false;
  const commands: string[] = [];
  const realProcess = proc.runProcess;
  const processSpy = spyOn(proc, "runProcess").mockImplementation(async (opts) => {
    if (opts.cmd[0] !== "/bin/sh") return realProcess(opts);
    opts.onStdoutLine?.(opts.cmd[4] ?? "");
    const command = opts.cmd.at(-1) ?? "";
    commands.push(command);
    if (command === testCommand) {
      initial.resolve();
      await finishInitial.promise;
      const report = opts.env?.LIMITLESS_GATE_REPORT;
      if (!report) throw new Error("missing report path");
      writeFileSync(
        report,
        '<testsuites><testsuite file="README.md" failures="1" time="1"><testcase><failure/></testcase></testsuite></testsuites>',
      );
      for (const line of ["0 pass", "1 fail", "Ran 1 test across 1 file."]) opts.onStdoutLine?.(line);
    }
    if (command.startsWith("bun test --isolate")) {
      retry.resolve();
      if (action === "pass") await finishRetry.promise;
      else {
        await new Promise<void>((resolve) =>
          opts.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        aborted.resolve();
        await cleanup.promise;
        opts.signal?.throwIfAborted();
      }
    }
    return {
      exitCode: command === testCommand ? 1 : 0,
      signal: null,
      cancelled: false,
      timedOut: false,
      idleTimedOut: false,
      truncated: false,
      stdout: "output",
      stderr: "",
      durationMs: 1,
    };
  });
  ci = () => null;
  const q = queue();
  let competitor: Promise<() => void> | undefined;
  let release: (() => void) | undefined;
  try {
    const entry = await q.request({ target: pr.run.id });
    await initial.promise;
    competitor = gateSlots
      .acquire(new AbortController().signal, undefined, "competitor", false, "ship")
      .then((free) => {
        acquired = true;
        return free;
      });
    finishInitial.resolve();
    expect(await Promise.race([retry.promise.then(() => "retry"), competitor.then(() => "competitor")])).toBe(
      "retry",
    );
    expect(acquired).toBe(false);
    expect(gateSlots.snapshot().occupied).toBe(1);
    if (action === "pass") {
      finishRetry.resolve();
      release = await competitor;
      await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
      expect(store.getLandEntry(entry.id)?.reason).toBe("flaky: test (README.md)");
    } else {
      const stopping = action === "stop" ? q.stop() : undefined;
      if (action === "cancel") expect(q.cancel(entry.id)).toBe(true);
      await aborted.promise;
      expect(acquired).toBe(false);
      cleanup.resolve();
      await stopping;
      release = await competitor;
      await q.stop();
      expect(store.getLandEntry(entry.id)?.state).toBe(action === "stop" ? "checking" : "cancelled");
    }
    expect(commands).toEqual([
      "prepare",
      testCommand,
      otherTestCommand,
      "lint",
      "bun test --isolate './README.md'",
    ]);
    expect(await remoteHead("pr-1")).toBe(head);
    expect(ghCalls("pr merge")).toEqual([]);
    release();
    expect(gateSlots.snapshot().occupied).toBe(0);
  } finally {
    finishInitial.resolve();
    finishRetry.resolve();
    cleanup.resolve();
    release?.();
    await q.stop();
    if (competitor) (await competitor)();
    processSpy.mockRestore();
  }
});

test.each([false, true])("LAN land retry in a fresh checkout (setup fails: %s)", async (setupFails) => {
  const setup = setupFails
    ? "echo retry setup failed >&2; exit 1"
    : "mkdir -p node_modules/retry-dependency && echo 'export default true;' > node_modules/retry-dependency/index.js";
  const template = "bun test {files}";
  const { pr, head } = await retryLandFixture(template, "test", setup);
  const fresh = join(root, "retry-checkout");
  const fake = fakeLandGates(async (req, attempt, signal) => {
    if (attempt === 1) return retryRun(req, { test: testFailure });
    await sh(["git", "clone", "-q", "--no-hardlinks", req.cwd, fresh], { cwd: root });
    expect(existsSync(join(fresh, "node_modules"))).toBe(false);
    const run = await confinementScope.run(fakeConfinement, () =>
      runLocalGates(fresh, req.gates, signal, {
        env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
      }),
    );
    return { ...run, ...(await gateProvenance(fresh, signal, req.headSha)) };
  });
  const entry = await queue({ gateExecutor: fake.executor }).request({ target: pr.run.id });
  await settle();
  const completed = store.getLandEntry(entry.id);
  expect(fake.requests).toHaveLength(2);
  const log = readFileSync(completed?.logPath ?? "", "utf8");
  expect(log).toContain("initial test failure");
  if (setupFails) {
    expect(completed).toMatchObject({
      state: "blocked",
      pushedSha: null,
      reason: `test failed (${completed?.logPath})`,
    });
    expect(log).toContain("retry setup failed");
    const diagnostic = `Land ${entry.id} test: no targeted retry: retry setup failed`;
    expect(log).toContain(diagnostic);
    expect(store.listEvents(pr.run.id)).toContainEqual(
      expect.objectContaining({ type: "gate", message: diagnostic }),
    );
    expect(log).not.toContain("\n$ bun test './");
    expect(ghCalls("pr merge")).toEqual([]);
  } else {
    expect(completed).toMatchObject({
      state: "landed",
      reason: `flaky: test (${retryFile}); merged ${head.slice(0, 12)}`,
    });
    expect(log).toContain("(pass) retry dependency");
    expect(log.indexOf(`\n$ ${setup}`, log.indexOf("# targeted retry"))).toBeLessThan(
      log.indexOf("\n$ bun test './"),
    );
    expect(ghCalls("pr merge")).toHaveLength(1);
  }
});

test.each([
  ["fails", testFailure, false],
  ["times out", { ok: false, exitCode: null, timedOut: true }, false],
  ["confinement", { confinementError: true }, false],
  ["retained confinement", { firstAttempt: gateResult("test", "retry", { confinementError: true }) }, false],
  ["another check", {}, true],
] satisfies [string, Partial<GateResult>, boolean][])(
  "a targeted retry %s blocks without a fallback",
  async (_kind, retry, unresolved) => {
    const { pr, head } = await retryLandFixture();
    const fake = fakeLandGates((req, attempt) =>
      retryRun(
        req,
        attempt === 1
          ? {
              test: testFailure,
              ...(unresolved ? { lint: { ok: false, exitCode: 1 } } : {}),
            }
          : { test: retry },
      ),
    );
    const entry = await queue({ gateExecutor: fake.executor }).request({ target: pr.run.id });
    await settle();
    const blocked = store.getLandEntry(entry.id);
    expect(blocked).toMatchObject({
      state: "blocked",
      pushedSha: null,
      reason: `${unresolved ? "lint" : "test"} failed (${blocked?.logPath})`,
    });
    expect(fake.requests.map((r) => r.gates.checks.map((c) => c.run))).toEqual([
      [testCommand, otherTestCommand, "lint"],
      [retryCommand],
    ]);
    expect(await remoteHead("pr-1")).toBe(head);
    expect(ghCalls("pr merge")).toEqual([]);
  },
);

test("land observation classifies a confined targeted retry as confinement", async () => {
  const { pr } = await retryLandFixture();
  const fake = fakeLandGates((req, attempt) =>
    retryRun(req, {
      test: attempt === 1 ? testFailure : { ok: false, exitCode: 1, confinementError: true },
    }),
  );
  const entry = await queue({ gateExecutor: fake.executor }).request({ target: pr.run.id });
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("blocked");
  expect(store.failureObservations()).toHaveLength(1);
  expect(store.failureObservations()[0]).toMatchObject({
    class: "confinement",
    history: "retry_failed",
    finalized_at: expect.any(Number),
  });
});

const ineligibleRetries: { label: string; result?: Partial<GateResult>; template?: string | null }[] = [
  { label: "setup" },
  { label: "legacy evidence", result: { failureAttributionComplete: undefined } },
  { label: "incomplete evidence", result: { failureAttributionComplete: false } },
  { label: "no files", result: { failedFiles: undefined } },
  { label: "empty files", result: { failedFiles: [] } },
  { label: "null exit", result: { exitCode: null } },
  { label: "missing exit", result: { exitCode: undefined } },
  { label: "zero exit", result: { exitCode: 0 } },
  { label: "timeout", result: { timedOut: true } },
  { label: "confinement", result: { confinementError: true } },
  {
    label: "retained confinement",
    result: { targetedRetry: gateResult("test", "earlier", { confinementError: true }) },
  },
  { label: "missing template", template: null },
  { label: "malformed template", template: "bun test --isolate" },
  { label: "duplicate placeholder", template: "bun test --isolate {files} {files}" },
  { label: "invalid files", result: { failedFiles: ["../escape.ts"] } },
  { label: "unmatched command", result: { command: "different-command" } },
];
test.each(ineligibleRetries)("an ineligible land failure blocks without retry: $label", async (row) => {
  const credential = "synthetic-skip-diagnostic-secret";
  const colored = "synthetic-skip-\u001b[31mdiagnostic-secret\u001b[0m";
  registerCredential("SKIP_DIAGNOSTIC_SECRET", credential);
  const { pr, head } = await retryLandFixture(row.template);
  const fake = fakeLandGates((req) =>
    row.label === "setup"
      ? { setupOk: false, setup: [gateResult("setup", "prepare", testFailure)], checks: [] }
      : retryRun(req, {
          test: {
            ...testFailure,
            ...row.result,
            ...(row.label === "incomplete evidence"
              ? { failureAttributionReason: `1 unattributed error: ${colored}` }
              : {}),
          },
        }),
  );
  const entry = await queue({ gateExecutor: fake.executor }).request({ target: pr.run.id });
  await settle();
  const blocked = store.getLandEntry(entry.id);
  expect(blocked).toMatchObject({
    state: "blocked",
    pushedSha: null,
    reason: `${row.label === "setup" ? "setup" : "test"} failed (${blocked?.logPath})`,
  });
  expect(fake.requests).toHaveLength(1);
  if (row.label === "setup") {
    expect(store.failureObservations()).toMatchObject([
      {
        run_id: `land:${entry.id}`,
        purpose: "land",
        handle_id: `${entry.id}:1`,
        phase: "setup",
        class: "setup",
        history: "no_retry",
        interim: 0,
      },
    ]);
    expect(store.failureObservations()[0]?.finalized_at).toBeNumber();
  }
  const expected =
    row.label === "setup"
      ? "setup failures are not retried"
      : row.label.includes("evidence")
        ? "failure attribution incomplete"
        : row.label.includes("confinement")
          ? "confinement failure"
          : row.label.includes("template") || row.label === "duplicate placeholder"
            ? "retry_files must contain {files} once as an unquoted standalone argument"
            : row.label === "null exit" || row.label === "missing exit"
              ? "missing exit status"
              : row.label === "zero exit"
                ? "no nonzero exit status"
                : row.label === "timeout"
                  ? "gate process timed out"
                  : row.label === "invalid files"
                    ? "invalid retry files"
                    : row.label === "unmatched command"
                      ? "check does not match base configuration"
                      : "absent retry files";
  const message = `Land ${entry.id} ${row.label === "setup" ? "setup" : "test"}: no targeted retry: ${expected}`;
  expect(readFileSync(blocked?.logPath ?? "", "utf8")).toContain(message);
  expect(store.listEvents(pr.run.id).some((e) => e.type === "gate" && e.message.includes(message))).toBe(
    true,
  );
  if (row.label === "incomplete evidence") {
    const diagnostics =
      readFileSync(blocked?.logPath ?? "", "utf8") + JSON.stringify(store.listEvents(pr.run.id));
    expect(diagnostics).toContain("1 unattributed error: [redacted]");
    expect(diagnostics).not.toContain(credential);
    expect(diagnostics).not.toContain("\\u001b");
  }
  expect(await remoteHead("pr-1")).toBe(head);
  expect(ghCalls("pr merge")).toEqual([]);
});

test("a completed attributed test timeout with a redacted command lands after one targeted retry", async () => {
  const credential = "synthetic-land-command-secret";
  registerCredential("LAND_COMMAND_SECRET", credential);
  const command = `bun test --test-name-pattern="${credential}"`;
  const { pr, head } = await retryLandFixture("bun test --isolate {files}", "test", "prepare", command);
  const realProcess = proc.runProcess;
  const processSpy = spyOn(proc, "runProcess").mockImplementation(async (opts) => {
    if (opts.cmd[0] !== "/bin/sh") return realProcess(opts);
    opts.onStdoutLine?.(opts.cmd[4] ?? "");
    const failed = opts.cmd.at(-1) === command;
    const output = failed
      ? "(fail) slow test [62000ms]\n  ^ this test timed out after 60000ms.\n0 pass\n1 fail\nRan 1 test across 1 file."
      : "passed";
    if (failed) {
      const report = opts.env?.LIMITLESS_GATE_REPORT;
      if (!report) throw new Error("Missing report path");
      writeFileSync(
        report,
        `<testsuites tests="1" failures="1"><testsuite file="${retryFile}" time="62"><testcase><failure type="TimeoutError" message="test timed out"/></testcase></testsuite></testsuites>`,
      );
    }
    for (const line of output.split("\n")) opts.onStdoutLine?.(line);
    return {
      exitCode: failed ? 1 : 0,
      signal: null,
      cancelled: false,
      timedOut: false,
      idleTimedOut: false,
      truncated: false,
      stdout: output,
      stderr: "",
      durationMs: failed ? 954000 : 1,
    };
  });
  const fake = fakeLandGates(async (req, attempt, signal) => {
    if (attempt > 1) return retryRun(req);
    const run = GateRunSchema.parse(redactGateData(await runLocalGates(req.cwd, req.gates, signal)));
    expect(validRun(req, run)).toBe(true);
    expect(run.checks[0]).toMatchObject({
      command: 'bun test --test-name-pattern="[redacted]"',
      exitCode: 1,
      failureAttributionComplete: true,
      failedFileTimes: { [retryFile]: 62 },
    });
    return run;
  });
  try {
    const entry = await queue({ gateExecutor: fake.executor }).request({ target: pr.run.id });
    await settle();
    const landed = store.getLandEntry(entry.id);
    expect(landed).toMatchObject({
      state: "landed",
      reason: `flaky: test (${retryFile}); merged ${head.slice(0, 12)}`,
    });
    expect(fake.requests.map((r) => r.gates.checks.map((c) => c.run))).toEqual([
      [command, otherTestCommand, "lint"],
      [retryCommand],
    ]);
    expect(fake.requests[1]?.skipGateSlot).toBe(false);
    const log = readFileSync(landed?.logPath ?? "", "utf8");
    expect(log).toContain("this test timed out after 60000ms");
    expect(log).toContain(`# targeted retry\n\n$ prepare\npassed\n\n$ ${retryCommand}`);
    expect(log).not.toContain(credential);
    expect(ghCalls("pr merge")).toHaveLength(1);
  } finally {
    processSpy.mockRestore();
  }
});

test.each(["root error", "unhandled error"])(
  "incomplete captured evidence blocks land without retry: %s",
  async (kind) => {
    const { pr, head } = await retryLandFixture();
    const fake = fakeLandGates((req, attempt) => {
      if (attempt > 1) return retryRun(req); // A passing partial retry must never authorize this land.
      const xml =
        kind === "root error"
          ? '<testsuites errors="1"><testsuite file="README.md" failures="1" errors="0"><testcase><failure/></testcase></testsuite></testsuites>'
          : '<testsuites failures="1"><testsuite file="README.md" failures="1"><testcase><failure/></testcase></testsuite></testsuites>';
      const evidence = new RunnerFailureEvidence();
      const output = `${kind === "unhandled error" ? "# Unhandled error between tests\n1 error\n" : ""}${"noise\n".repeat(2000)}0 pass\n1 fail\nRan 1 test across 1 file.`;
      for (const line of output.split("\n")) evidence.observe(line);
      const junit = parseJUnit(xml, req.cwd);
      expect(junit?.failedFiles).toEqual(["README.md"]);
      return retryRun(req, {
        test: {
          ...testFailure,
          ...junit,
          output: output.slice(-6000),
          failureAttributionComplete: evidence.agrees(junit?.attributedCounts),
          failureAttributionReason:
            evidence.reason(junit?.attributedCounts) ?? junit?.failureAttributionReason,
        },
      });
    });
    const entry = await queue({ gateExecutor: fake.executor }).request({ target: pr.run.id });
    await settle();
    const blocked = store.getLandEntry(entry.id);
    expect(blocked).toMatchObject({
      state: "blocked",
      reason: `test failed (${blocked?.logPath})`,
      pushedSha: null,
    });
    expect(fake.requests).toHaveLength(1);
    const message = `Land ${entry.id} test: no targeted retry: failure attribution incomplete: 1 unattributed error`;
    const log = readFileSync(blocked?.logPath ?? "", "utf8");
    expect(log).not.toContain("1 error");
    expect(log).toContain(message);
    expect(store.listEvents(pr.run.id)).toContainEqual(
      expect.objectContaining({ type: "gate", level: "warn", message }),
    );
    expect(await remoteHead("pr-1")).toBe(head);
    expect(ghCalls("pr merge")).toEqual([]);
  },
);

test("flaky land diagnostics strip formatting before credential redaction", async () => {
  const credential = "synthetic-color-gate-secret";
  const colored = "synthetic-color-\u001b[31mgate-secret\u001b[0m";
  registerCredential("COLOR_GATE_SECRET", credential);
  const { pr, head } = await retryLandFixture("bun test --isolate {files}", colored);
  const fake = fakeLandGates((req, attempt) =>
    retryRun(req, {
      [colored]:
        attempt === 1 ? { ...testFailure, output: `initial ${colored}` } : { output: `targeted ${colored}` },
    }),
  );
  const entry = await queue({ gateExecutor: fake.executor }).request({ target: pr.run.id });
  await settle();
  const landed = store.getLandEntry(entry.id);
  const reason = `flaky: [redacted] (${retryFile})`;
  expect(landed).toMatchObject({ state: "landed", reason: `${reason}; merged ${head.slice(0, 12)}` });
  const warnings = store.listEvents(pr.run.id).filter((e) => e.level === "warn");
  expect(warnings).toMatchObject([{ message: `Land ${entry.id} ${reason}` }]);
  const log = readFileSync(landed?.logPath ?? "", "utf8");
  expect(log).toContain("initial [redacted]");
  expect(log).toContain("targeted [redacted]");
  for (const text of [landed?.reason ?? "", JSON.stringify(warnings), log]) {
    expect(text).not.toContain(credential);
    expect(text).not.toContain(colored);
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\\u001b");
  }
});

test.each(["stop", "cancel"])("a %s during a targeted retry cannot authorize landing", async (action) => {
  const { pr, head } = await retryLandFixture();
  await advanceBase(); // A merge commit would have to be pushed after completed checks.
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<GateRun>();
  const fake = fakeLandGates((req, attempt, signal) => {
    if (attempt !== 2) return retryRun(req, { test: testFailure });
    entered.resolve();
    if (action === "stop")
      signal.addEventListener("abort", () => response.resolve(retryRun(req)), { once: true });
    return response.promise;
  });
  const q = queue({ gateExecutor: fake.executor });
  try {
    const entry = await q.request({ target: pr.run.id });
    await entered.promise;
    expect(store.getLandEntry(entry.id)).toMatchObject({ state: "checking", pushedSha: null, reason: null });
    expect(await remoteHead("pr-1")).toBe(head);
    expect(ghCalls("pr merge")).toEqual([]);
    if (action === "cancel") {
      expect(q.cancel(entry.id)).toBe(true);
      const pending = fake.requests[1];
      if (!pending) throw new Error("Missing targeted retry");
      response.resolve(retryRun(pending));
    }
    await q.stop();
    expect(store.getLandEntry(entry.id)).toMatchObject({
      state: action === "stop" ? "checking" : "cancelled",
      pushedSha: null,
    });
    const fresh = fakeLandGates((req) => retryRun(req, { test: { ...testFailure, failedFiles: undefined } }));
    queue({ gateExecutor: fresh.executor });
    await settle();
    expect(fresh.requests).toHaveLength(action === "stop" ? 1 : 0);
    if (action === "stop") {
      expect(fresh.requests[0]?.gates.setup).toEqual(["prepare"]);
      expect(fresh.requests[0]?.gates.checks.map((c) => c.run)).toEqual([
        testCommand,
        otherTestCommand,
        "lint",
      ]);
      expect(store.getLandEntry(entry.id)?.state).toBe("blocked");
    }
    expect(await remoteHead("pr-1")).toBe(head);
    expect(ghCalls("pr merge")).toEqual([]);
    expect(store.listEvents(pr.run.id).filter((e) => e.level === "warn")).toMatchObject(
      action === "stop" ? [{ message: `Land ${entry.id} test: no targeted retry: absent retry files` }] : [],
    );
  } finally {
    response.resolve({ setupOk: true, setup: [], checks: [] });
    await q.stop();
  }
});

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
  expect((await q.request({ target: first.run.id })).runId).toBe(first.run.id);
  await q.request({ target: second.run.id });
  await waitFor(() => store.getRun(first.run.id)?.merged === true);
  await waitWithoutClock(() => store.getRun(first.run.id)?.mergedBy === "owner", 15_000);
  await settle();
  await waitWithoutClock(() => store.getRun(second.run.id)?.mergedBy === "owner", 15_000);
  const entries = store.listLandEntries();
  expect(entries.map((e) => [e.id, e.state])).toEqual([
    [1, "landed"],
    [2, "landed"],
  ]);
  expect([first, second].map((pr) => store.getRun(pr.run.id)?.merged)).toEqual([true, true]);
  for (const pr of [first, second]) {
    const metadata = { mergedBy: "owner", mergedAt: Date.parse("2026-10-13T12:00:00Z") };
    expect(store.getRun(pr.run.id)).toMatchObject(metadata);
    expect(
      store
        .readFeed({ limit: 100 })
        .items.find((item) => item.kind === "run.merged" && item.runId === pr.run.id)?.data,
    ).toMatchObject(metadata);
  }
  // One repository, one entry at a time: the second check starts only after the first ends.
  expect(gateLog()).toEqual(["start", "end", "start", "end"]);
  expect(ghCalls("pr merge")).toHaveLength(2);
});

test("later merge observations fill queue-landed parent metadata without another merge event", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  const round = roundRun(pr.run.id, url(1), head);
  observe(1, head);
  store.recordApproval(round.id, url(1), head, "orchestrator");
  writeFileSync(join(root, "gh.no-metadata"), "");
  await queue().request({ target: round.id });
  await settle();
  for (const id of [pr.run.id, round.id])
    expect(store.getRun(id)).toMatchObject({ merged: true, mergedBy: null, mergedAt: null });
  const feed = () => store.readFeed({ limit: 100 }).items.filter((item) => item.kind === "run.merged");
  expect(feed().filter((item) => item.runId === pr.run.id)).toHaveLength(1);
  let lookups = 0;
  for (const [login, mergedAt] of [
    [null, "2026-10-13T12:00:00Z"],
    ["owner", null],
    ["another-actor", "2026-10-13T13:00:00Z"],
  ]) {
    store.saveGithubPr({
      url: url(1),
      repo: SLUG,
      runId: pr.run.id,
      delivered: 1,
      nodeId: "PR_1",
      data: JSON.stringify({
        url: url(1),
        state: "MERGED",
        mergedBy: login ? { login } : null,
        mergedAt: mergedAt ?? null,
      }),
    });
    await reconcileMergedRuns(store, async () => {
      lookups++;
      return null;
    });
  }
  for (const id of [pr.run.id, round.id]) {
    const metadata = { mergedBy: "owner", mergedAt: Date.parse("2026-10-13T12:00:00Z") };
    expect(store.getRun(id)).toMatchObject({ merged: true, ...metadata });
    expect(feed().find((item) => item.runId === id)?.data).toMatchObject(metadata);
    expect(feed().find((item) => item.runId === id)?.summary).toContain("merged by owner");
  }
  expect(feed()).toHaveLength(2); // one per run, including the round
  expect(lookups).toBe(0);
  expect(ghCalls("pr merge")).toHaveLength(1);
});

test.each(["complete", "fail", "abort", "timeout", "unmerged", "different PR"])(
  "landing is recorded before the optional metadata read: %s",
  async (outcome) => {
    const pr = delivered(1, "pr-1");
    const head = await pushBranch("pr-1", "one.txt", "one\n");
    const round = roundRun(pr.run.id, url(1), head);
    observe(1, head);
    store.recordApproval(round.id, url(1), head, "orchestrator");
    const response = Promise.withResolvers<GitHubPrView | null>();
    let metadataSignal: AbortSignal | undefined;
    const q = queue({
      client: (_url, signal) => {
        metadataSignal = signal;
        return response.promise; // Deliberately ignores abort: the queue must bound the wait itself.
      },
    });
    try {
      const entry = await q.request({ target: round.id });
      await waitFor(() => metadataSignal !== undefined);
      expect(store.getLandEntry(entry.id)?.state).toBe("landed");
      for (const id of [round.id, pr.run.id])
        expect(store.getRun(id)).toMatchObject({ merged: true, mergedBy: null, mergedAt: null });
      expect(q.cancel(entry.id)).toBe(false);
      if (outcome === "timeout") await clock.advance(30_000);
      if (outcome === "abort") await q.stop();
      if (outcome === "timeout" || outcome === "abort") expect(metadataSignal?.aborted).toBe(true);
      if (outcome === "timeout")
        await waitWithoutClock(
          () => !existsSync(join(paths.work, `land-${entry.id}-${store.getLandEntry(entry.id)?.attempts}`)),
          15_000,
        );
      const observation: GitHubPrView = {
        url: url(outcome === "different PR" ? 2 : 1),
        state: outcome === "unmerged" ? "OPEN" : "MERGED",
        headRefOid: head,
        mergedBy: { login: "owner" },
        mergedAt: "2026-10-13T12:00:00Z",
        ci: null,
        failing: [],
      };
      if (outcome === "fail") response.reject(new Error("metadata unavailable"));
      else response.resolve(observation);
      await waitFor(
        () => !existsSync(join(paths.work, `land-${entry.id}-${store.getLandEntry(entry.id)?.attempts}`)),
      );
      await q.stop();
      expect(store.getLandEntry(entry.id)?.state).toBe("landed");
      for (const id of [round.id, pr.run.id]) {
        const metadata =
          outcome === "complete"
            ? { mergedBy: "owner", mergedAt: Date.parse("2026-10-13T12:00:00Z") }
            : { mergedBy: null, mergedAt: null };
        expect(store.getRun(id)).toMatchObject({ merged: true, ...metadata });
        const feed = store
          .readFeed({ limit: 100 })
          .items.filter((item) => item.kind === "run.merged" && item.runId === id);
        expect(feed).toHaveLength(1);
        expect(feed[0]?.data).toMatchObject(metadata);
      }
    } finally {
      response.resolve(null);
      await q.stop();
    }
  },
);

test.each([
  { metadata: true, target: "round" },
  { metadata: false, target: "round" },
  { metadata: true, target: "owner" },
  { metadata: false, target: "owner" },
])(
  "landing through $target resolves every same-PR round as merged (metadata: $metadata)",
  async ({ metadata, target }) => {
    const pr = delivered(1, "pr-1");
    store.db.query("UPDATE runs SET prompt = ? WHERE id = ?").run("request\nCloses #42", pr.run.id);
    const head = await pushBranch("pr-1", "one.txt", "one\n");
    const round = roundRun(pr.run.id, url(1), head);
    const repo = store.getRepo(pr.run.repoId);
    if (!repo) throw new Error("missing repository");
    // Persist an overlapping claim as an older release could, before transactional claiming.
    const other = store.createRun(repo, { repo: SLUG, prompt: "other request" });
    store.db.query("UPDATE runs SET prompt = ? WHERE id = ?").run("other request\nCloses #42", other.id);
    const finishedAt = 123;
    store.updateRun(other.id, { status: "needs_human", prUrl: url(2) });
    const second = roundRun(pr.run.id, url(1), head);
    store.updateRun(second.id, { status: "needs_human" });
    store.db.query("UPDATE runs SET prompt = ? WHERE id = ?").run("review round\nCloses #42", round.id);
    store.updateRun(round.id, { status: "needs_human", finishedAt, error: "review needs approval" });
    observe(1, head);
    store.recordApproval(round.id, url(1), head, "orchestrator");
    if (!metadata) writeFileSync(join(root, "gh.no-metadata"), "");
    const entry = await queue().request({ target: target === "owner" ? pr.run.id : round.id });
    await settle();
    if (metadata) await waitWithoutClock(() => store.getRun(round.id)?.mergedBy === "owner", 15_000);
    expect(store.getLandEntry(entry.id)?.state).toBe("landed");
    expect(store.getRun(round.id)).toMatchObject({
      merged: true,
      status: "resolved",
      resolution: { kind: "merged", ref: url(1) },
      finishedAt,
      error: "review needs approval",
    });
    expect(store.getRun(pr.run.id)).toMatchObject({ merged: true, status: "succeeded", resolution: null });
    expect(store.getRun(second.id)).toMatchObject({
      merged: true,
      status: "resolved",
      resolution: { kind: "merged", ref: url(1) },
    });
    for (const id of [pr.run.id, round.id, second.id])
      expect(store.getRun(id)).toMatchObject({
        mergedBy: metadata ? "owner" : null,
        mergedAt: metadata ? Date.parse("2026-10-13T12:00:00Z") : null,
      });
    expect(store.getRun(other.id)?.resolution?.kind).toBe("superseded");
  },
);

test.each([false, true])(
  "landing buffers run and feed publications until commit (rollback: %s)",
  async (rollback) => {
    const pr = delivered(1, "pr-1");
    const head = await pushBranch("pr-1", "one.txt", "one\n");
    const round = roundRun(pr.run.id, url(1), head);
    store.updateRun(round.id, { status: "needs_human" });
    observe(1, head);
    store.recordApproval(round.id, url(1), head, "orchestrator");
    const messages: StreamMessage[] = [];
    const inTransaction: boolean[] = [];
    const off = store.subscribe((msg) => {
      if (
        (msg.kind === "run" && msg.run.merged) ||
        (msg.kind === "feed" && ["land.landed", "run.merged", "run.resolved"].includes(msg.item.kind))
      ) {
        messages.push(msg);
        inTransaction.push(store.db.inTransaction);
      }
    });
    const resolve = store.resolveMergedRun.bind(store);
    let calls = 0;
    const beforeCommit: number[] = [];
    const fault = spyOn(store, "resolveMergedRun").mockImplementation((...args) => {
      const result = resolve(...args);
      beforeCommit.push(messages.length);
      if (++calls === 2 && rollback) throw new Error("injected landing rollback");
      return result;
    });
    const q = queue({ client: async () => null });
    try {
      const entry = await q.request({ target: round.id });
      await settle();
      await q.stop();
      expect(calls).toBe(2);
      expect(beforeCommit).toEqual([0, 0]);
      expect(inTransaction.every((active) => !active)).toBe(true);
      expect(store.getLandEntry(entry.id)?.state).toBe(rollback ? "blocked" : "landed");
      for (const id of [pr.run.id, round.id]) expect(store.getRun(id)?.merged).toBe(!rollback);
      const feed = messages.flatMap((msg) => (msg.kind === "feed" ? [msg.item] : []));
      if (rollback) {
        expect(messages).toEqual([]);
        expect(
          store
            .readFeed({ limit: 100 })
            .items.some((item) => item.kind === "land.landed" || item.kind === "run.merged"),
        ).toBe(false);
      } else {
        expect(messages.filter((msg) => msg.kind === "run")).toHaveLength(2);
        expect(feed.map((item) => item.kind).toSorted()).toEqual([
          "land.landed",
          "run.merged",
          "run.merged",
          "run.resolved",
        ]);
      }
    } finally {
      fault.mockRestore();
      off();
      await q.stop();
    }
  },
);

test("three requests submitted together all land, with no further request", async () => {
  const prs = [1, 2, 3].map((n) => delivered(n, `pr-${n}`));
  for (const n of [1, 2, 3]) {
    const head = await pushBranch(`pr-${n}`, `change-${n}.txt`, `change ${n}\n`, n);
    observe(n, head);
    approve(n, head);
  }
  const q = queue();
  await Promise.all(prs.map((pr) => q.request({ target: pr.run.id })));
  await settle();
  expect(store.listLandEntries().map((e) => e.state)).toEqual(["landed", "landed", "landed"]);
  expect(gateLog()).toEqual(["start", "end", "start", "end", "start", "end"]);
});

test("a checking entry whose merge commit is already on the remote tolerates lagging reads and lands", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "change-1.txt", "one\n", 1);
  await advanceBase();
  // The commit a land would have pushed: the approved head with the base merged in.
  await sh(["git", "checkout", "-q", "pr-1"], { cwd: seed });
  await sh(["git", "merge", "-q", "--no-ff", "-m", "limitless: merge base", "main"], { cwd: seed });
  const mergeSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: seed })).stdout.trim();
  await sh(["git", "push", "-q", bare, "HEAD:refs/heads/pr-1"], { cwd: seed });
  observe(1, head, "SUCCESS");
  approve(1, head);
  ci = () => null;
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
  let caughtUp = false;
  let reads = 0;
  queue({
    ciPollMs: 100,
    client: async () => {
      reads++;
      return {
        url: url(1),
        state: "OPEN",
        headRefOid: caughtUp ? mergeSha : head,
        mergedAt: null,
        mergedBy: null,
        ci: "SUCCESS",
        failing: [],
      };
    },
  });
  await waitFor(() => reads > 0);
  await settleIdle();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "checking", pushedSha: mergeSha });
  await waitFor(() => reads >= 2); // Reconciliation accepted the approved head; CI still waits.
  expect(ghCalls("pr merge")).toEqual([]);
  caughtUp = true;
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
  await q.request({ target: behind.run.id });
  await q.request({ target: upToDate.run.id });
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

for (const moved of [false, true]) {
  test(`after a base merge, lagging head reads ${moved ? "still block someone else's push" : "wait and land"}`, async () => {
    const pr = delivered(1, "pr-1");
    const approved = await pushBranch("pr-1", "one.txt", "one\n");
    observe(1, approved);
    approve(1, approved);
    await advanceBase();
    ci = () => null;
    let caughtUp = false;
    let reads = 0;
    const entry = await queue({
      polling: false,
      ciPollMs: 100,
      client: async () => {
        reads++;
        return {
          url: url(1),
          state: "OPEN",
          mergedAt: null,
          mergedBy: null,
          headRefOid: caughtUp ? (moved ? "c".repeat(40) : await remoteHead("pr-1")) : approved,
          ci: "SUCCESS",
          failing: [],
        };
      },
    }).request({ target: pr.run.id });
    await waitFor(() => reads > 0);
    await settleIdle();
    expect(store.getLandEntry(entry.id)?.state).toBe("waiting_ci");
    await clock.advance(100);
    await waitWithoutClock(() => reads >= 2);
    expect(store.getLandEntry(entry.id)?.state).toBe("waiting_ci");
    expect(ghCalls("pr merge")).toEqual([]); // green CI on the approved head cannot land the merge
    const pushed = store.getLandEntry(entry.id)?.pushedSha;
    expect(pushed).toBe(await remoteHead("pr-1"));
    expect(pushed).not.toBe(approved);
    caughtUp = true;
    await settle();
    if (moved) {
      expect(store.getLandEntry(entry.id)).toMatchObject({
        state: "blocked",
        reason: "head moved after approval",
      });
      expect(ghCalls("pr merge")).toEqual([]);
    } else {
      expect(store.getLandEntry(entry.id)?.state).toBe("landed");
      expect(ghCalls("pr merge")[0]).toContain(`--match-head-commit ${pushed}`);
    }
  });
}

test("poller head versions catching up to a base merge do not block CI inspection", async () => {
  const pr = delivered(1, "pr-1");
  const approved = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, approved);
  store.observePrHead(url(1), approved);
  approve(1, approved);
  await advanceBase();
  ci = () => null;
  let reads = 0;
  const entry = await queue({
    polling: false,
    ciPollMs: 100,
    client: async () => {
      const pushed = await remoteHead("pr-1");
      if (++reads === 1) {
        workflow(pushed, 1, "failure");
        // The poller records our merge while the fallback read is in flight.
        store.observePrHead(url(1), pushed);
        observe(1, pushed, "FAILURE", ["network"]);
        github.responses.set(`repos/${SLUG}/commits/main`, () => {
          // Different reads can catch up while classification is in flight, too.
          store.observePrHead(url(1), approved);
          observe(1, approved);
          store.observePrHead(url(1), pushed);
          observe(1, pushed, "FAILURE", ["network"]);
          return respond(200, { sha: "b".repeat(40) });
        });
      }
      return {
        url: url(1),
        state: "OPEN",
        mergedAt: null,
        mergedBy: null,
        headRefOid: pushed,
        ci: reads === 1 ? "FAILURE" : "SUCCESS",
        failing: reads === 1 ? ["network"] : [],
      };
    },
  }).request({ target: pr.run.id });
  await waitFor(
    () =>
      landLog.some((line) => line.includes("transient CI failure")) ||
      store.getLandEntry(entry.id)?.state === "blocked",
  );
  expect(store.getLandEntry(entry.id)?.state).toBe("waiting_ci");
  const pushed = store.getLandEntry(entry.id)?.pushedSha ?? "";
  workflow(pushed, 2, "success");
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  expect(ghCalls("pr merge")[0]).toContain(`--match-head-commit ${pushed}`);
});

test.each([
  ["draft", "PR is a draft"],
  ["closed", "PR was closed without merging"],
  ["missing head", "PR head is missing"],
  ["empty head", "PR head is missing"],
  ["moved head", "head moved after approval"],
  ["failed lookup", "cannot inspect current GitHub PR metadata"],
  ["invalid JSON", "cannot inspect current GitHub PR metadata"],
  ["missing state", "cannot inspect current GitHub PR metadata"],
  ["missing draft", "cannot inspect current GitHub PR metadata"],
  ["wrong URL", "cannot inspect current GitHub PR metadata"],
])("fresh PR preflight blocks before any check: %s", async (scenario, reason) => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head, "SUCCESS"); // A cached eligible head must not bypass the fresh lookup.
  approve(1, head);
  const view = {
    url: scenario === "wrong URL" ? url(2) : url(1),
    state: scenario === "missing state" ? undefined : scenario === "closed" ? "CLOSED" : "OPEN",
    isDraft: scenario === "missing draft" ? undefined : scenario === "draft",
    headRefOid:
      scenario === "missing head"
        ? undefined
        : scenario === "empty head"
          ? ""
          : scenario === "moved head"
            ? "b".repeat(40)
            : head,
  };
  writeFileSync(join(root, "gh.preflight"), scenario === "invalid JSON" ? "{" : JSON.stringify(view));
  if (scenario === "failed lookup") writeFileSync(join(root, "gh.preflight-error"), "");
  const gates = fakeLandGates((req) => retryRun(req));
  const entry = await queue({ gateExecutor: gates.executor }).request({ target: pr.run.id });
  await settle();
  const blocked = store.getLandEntry(entry.id);
  expect(blocked?.state).toBe("blocked");
  expect(blocked?.reason).toContain(reason);
  if (!["failed lookup", "invalid JSON", "missing state", "missing draft", "wrong URL"].includes(scenario))
    expect(blocked?.reason).toBe(reason);
  if (scenario === "failed lookup") expect(blocked?.reason).toContain("metadata lookup denied");
  expect(store.readFeed({ limit: 100 }).items.find((item) => item.kind === "land.blocked")).toMatchObject({
    summary: blocked?.reason,
    data: { reason: blocked?.reason },
  });
  expect(gates.requests).toHaveLength(0);
  expect(gateLog()).toEqual([]);
  expect(
    ghCalls("pr view").filter((call) => call.includes("url,state,isDraft,headRefOid,mergedBy,mergedAt")),
  ).toHaveLength(1);
  expect(ghCalls("pr merge")).toEqual([]);
  expect(ghCalls("pr ready")).toEqual([]);
});

test("a transient fresh PR preflight failure retries and lands", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head, "SUCCESS");
  approve(1, head);
  let attempts = 0;
  const gates = fakeLandGates((req) => retryRun(req));
  const delay = repos.githubRetry.baseDelayMs;
  repos.githubRetry.baseDelayMs = 1;
  const q = queue({
    gateExecutor: gates.executor,
    gh: async (args, signal) => {
      if (args.includes("url,state,isDraft,headRefOid,mergedBy,mergedAt")) {
        attempts++;
        expect(signal).toBeInstanceOf(AbortSignal);
        if (attempts === 1) throw new CommandError("HTTP 502", 1, "", "HTTP 502", false);
      }
      return (await runGh(args, signal)) ?? "";
    },
  });
  try {
    const entry = await q.request({ target: pr.run.id });
    await settle();
    expect(attempts).toBe(2);
    expect(gates.requests).toHaveLength(1);
    expect(store.getLandEntry(entry.id)?.state).toBe("landed");
    expect(github.calls.filter((c) => c.path === "user" || c.path === "graphql")).toEqual([]);
    expect(ghCalls("pr merge")).toHaveLength(1);
    expect(ghCalls("pr merge")[0]).toContain(`--match-head-commit ${head}`);
  } finally {
    await q.stop();
    repos.githubRetry.baseDelayMs = delay;
  }
});

test("exhausted fresh PR preflight retries report sanitized GitHub unavailability", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head, "SUCCESS");
  approve(1, head);
  const secret = "SYNTHETIC_PREFLIGHT_CREDENTIAL_566";
  registerCredential("land-preflight-test", secret);
  // Put the credential across the stored reason's truncation boundary.
  const diagnostic = `HTTP 502: ${"x".repeat(1895)}${secret}${"y".repeat(2500)}`;
  let attempts = 0;
  const gates = fakeLandGates((req) => retryRun(req));
  const policy = { ...repos.githubRetry };
  Object.assign(repos.githubRetry, { attempts: 3, budgetMs: 5_000, baseDelayMs: 1 });
  const q = queue({
    gateExecutor: gates.executor,
    gh: async () => {
      attempts++;
      throw new CommandError(diagnostic, 1, "", diagnostic, false);
    },
  });
  try {
    const entry = await q.request({ target: pr.run.id });
    await settle();
    const reason =
      `cannot inspect current GitHub PR metadata: Error: GitHub unavailable: HTTP 502: ${"x".repeat(1895)}[redacted]${"y".repeat(2500)}`.slice(
        0,
        2000,
      );
    expect(attempts).toBe(3);
    expect(store.getLandEntry(entry.id)).toMatchObject({ state: "blocked", reason });
    const blocked = store.readFeed({ limit: 100 }).items.find((item) => item.kind === "land.blocked");
    expect(blocked).toMatchObject({ summary: reason.slice(0, 500), data: { reason } });
    expect(reason).toContain("[redacted]");
    expect(JSON.stringify([blocked, landLog, store.getLandEntry(entry.id)])).not.toContain(secret);
    expect(gates.requests).toHaveLength(0);
    expect(ghCalls("pr merge")).toEqual([]);
  } finally {
    await q.stop();
    Object.assign(repos.githubRetry, policy);
  }
});

test.each([
  { action: "cancel", response: "eligible" },
  { action: "claim lost", response: "eligible" },
  { action: "cancel", response: "error" },
  { action: "claim lost", response: "error" },
])("a pending fresh PR preflight retry respects $action on $response", async ({ action, response }) => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head, "SUCCESS");
  approve(1, head);
  const entered = Promise.withResolvers<AbortSignal | undefined>();
  const pending = Promise.withResolvers<string>();
  const gates = fakeLandGates((req) => retryRun(req));
  let attempts = 0;
  const delay = repos.githubRetry.baseDelayMs;
  repos.githubRetry.baseDelayMs = 1;
  const q = queue({
    gateExecutor: gates.executor,
    gh: async (_args, signal) => {
      attempts++;
      if (attempts === 1) throw new CommandError("HTTP 502", 1, "", "HTTP 502", false);
      entered.resolve(signal);
      return pending.promise;
    },
  });
  try {
    const entry = await q.request({ target: pr.run.id });
    const signal = await entered.promise;
    expect(signal).toBeInstanceOf(AbortSignal);
    if (action === "cancel") {
      expect(q.cancel(entry.id)).toBe(true);
      expect(signal?.aborted).toBe(true);
    } else {
      expect(store.claimLandEntry(SLUG, 30_000, "new-owner", clock.now() + 31_000)?.id).toBe(entry.id);
    }
    const before = claimSnapshot(entry);
    if (response === "error") pending.reject(new CommandError("lookup denied", 1, "", "denied", false));
    else pending.resolve(JSON.stringify({ url: url(1), state: "OPEN", isDraft: false, headRefOid: head }));
    await waitWithoutClock(() => clock.pending === 1);
    expect(claimSnapshot(entry)).toEqual(before);
    expect(attempts).toBe(2);
    expect(gates.requests).toHaveLength(0);
    expect(ghCalls("pr merge")).toEqual([]);
  } finally {
    pending.resolve("{}");
    await q.stop();
    repos.githubRetry.baseDelayMs = delay;
  }
});

test("a PR merged outside the queue is recorded as landed before any check", async () => {
  const pr = delivered(1, "pr-1");
  store.updateRun(pr.run.id, { status: "needs_human" });
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head, "SUCCESS");
  approve(1, head);
  writeFileSync(join(root, "gh.merged-1"), "");
  const gates = fakeLandGates((req) => retryRun(req));
  const entry = await queue({ gateExecutor: gates.executor }).request({ target: pr.run.id });
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({
    state: "landed",
    reason: `merged ${head.slice(0, 12)}`,
  });
  expect(store.getRun(pr.run.id)).toMatchObject({ status: "resolved", merged: true, mergedBy: "owner" });
  expect(gates.requests).toHaveLength(0);
  expect(gateLog()).toEqual([]);
  expect(ghCalls("pr merge")).toEqual([]);
});

test("a PR merged outside the queue at another head blocks before any check", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head, "SUCCESS");
  approve(1, head);
  writeFileSync(
    join(root, "gh.preflight"),
    JSON.stringify({ url: url(1), state: "MERGED", isDraft: false, headRefOid: "b".repeat(40) }),
  );
  const gates = fakeLandGates((req) => retryRun(req));
  const entry = await queue({ gateExecutor: gates.executor }).request({ target: pr.run.id });
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({
    state: "blocked",
    reason: "merged PR head is missing or differs from the pushed SHA",
  });
  expect(store.getRun(pr.run.id)?.merged).toBe(false);
  expect(gates.requests).toHaveLength(0);
  expect(ghCalls("pr merge")).toEqual([]);
});

test("a rejected merge blocks, arms no auto-merge, and a later head never lands", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
  approve(1, head);
  const secret = "SYNTHETIC_MERGE_CREDENTIAL_566";
  registerCredential("land-merge-test", secret);
  const diagnostic = `Pull request is not mergeable: ${"x".repeat(1940)}${secret}${"y".repeat(2500)}`;
  writeFileSync(join(root, "gh.reject"), diagnostic);
  const q = queue();
  const entry = await q.request({ target: pr.run.id });
  await settle();
  const reason =
    `merge failed: Pull request is not mergeable: ${"x".repeat(1940)}[redacted]${"y".repeat(2500)}`.slice(
      0,
      2000,
    );
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "blocked", reason });
  const blocked = store.readFeed({ limit: 100 }).items.find((item) => item.kind === "land.blocked");
  expect(blocked).toMatchObject({ summary: reason.slice(0, 500), data: { reason } });
  expect(landLog).toContain(`[land] ${entry.id} blocked: ${reason}`);
  expect(JSON.stringify([blocked, landLog, store.getLandEntry(entry.id)])).not.toContain(secret);
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

test("a CI trigger waits through a held merge and skips the landed PR without lookup", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  store.updateRun(pr.run.id, {
    baseSha: (await sh(["git", "rev-parse", "main"], { cwd: seed })).stdout.trim(),
  });
  observe(1, head);
  approve(1, head);
  writeFileSync(join(root, "gh.hold-merge"), "");
  const q = queue();
  try {
    const entry = await q.request({ target: pr.run.id });
    await waitFor(() => ghCalls("pr merge").some((call) => call.includes("--match-head-commit")));
    expect(store.getLandEntry(entry.id)?.state).toBe("merging");
    store.recordCiFixTrigger(
      pr.prUrl,
      head,
      "failure",
      { check: "test", line: "FAIL", excerpt: "FAIL" },
      clock.now(),
    );
    const gh = async () => {
      throw new Error("unexpected CI lookup during landing");
    };
    await processConflictTriggers(store, clock.now, gh);
    expect(store.reviewRounds(pr.prUrl)).toHaveLength(0);
    expect(store.db.query("SELECT state, attempts FROM ci_fix_triggers").get()).toEqual({
      state: "pending",
      attempts: 0,
    });
    expect((await sh(["git", "rev-parse", "pr-1"], { cwd: bare })).stdout.trim()).toBe(head);
    rmSync(join(root, "gh.hold-merge"));
    await settle();
    expect(store.getLandEntry(entry.id)).toMatchObject({ state: "landed", pushedSha: head });
    await processConflictTriggers(store, clock.now, gh);
    expect(store.db.query("SELECT state, reason FROM ci_fix_triggers").get()).toEqual({
      state: "skipped",
      reason: "PR is not open",
    });
    expect(store.reviewRounds(pr.prUrl)).toHaveLength(0);
  } finally {
    rmSync(join(root, "gh.hold-merge"), { force: true });
    await q.stop();
  }
});

test("a conflict round starting during CI blocks the land before merging", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  store.updateRun(pr.run.id, {
    baseSha: (await sh(["git", "rev-parse", "main"], { cwd: seed })).stdout.trim(),
  });
  observe(1, head);
  approve(1, head);
  let reached = () => {};
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const q = queue({
    polling: false,
    client: async () => {
      reached();
      await hold;
      return {
        url: pr.prUrl,
        state: "OPEN",
        mergedAt: null,
        mergedBy: null,
        headRefOid: head,
        ci: "SUCCESS",
        failing: [],
      };
    },
  });
  try {
    const entry = await q.request({ target: pr.run.id });
    await ready;
    store.recordConflictTrigger(pr.prUrl, head, "poller", clock.now());
    const trigger = store.pendingConflictTriggers()[0];
    if (!trigger) throw new Error("missing conflict trigger");
    expect(
      store.startConflictTrigger(trigger.id, { state: "OPEN", headRefOid: head }, clock.now()),
    ).not.toBeNull();
    release();
    await settle();
    expect(store.getLandEntry(entry.id)).toMatchObject({
      state: "blocked",
      reason: "a conflict round is in flight for this pull request",
    });
    expect(ghCalls("pr merge")).toHaveLength(0);
    expect(existsSync(join(root, "gh.merged-1"))).toBe(false);
  } finally {
    release();
    await q.stop();
  }
});

test("a pinned merge whose head moved is refused", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
  approve(1, head);
  writeFileSync(join(root, "gh.hang"), ""); // hold the merge while the head moves underneath it
  const q = queue();
  const entry = await q.request({ target: pr.run.id });
  await waitFor(() => ghCalls("pr merge").some((call) => call.includes("--match-head-commit")));
  const pinned = store.getLandEntry(entry.id)?.pushedSha ?? head;
  await q.stop();
  rmSync(join(root, "gh.hang"));
  const moved = await pushBranch("pr-1", "one.txt", "one\nagain\n", 1);
  ci = () => null;
  observe(1, moved, "PENDING");
  queue();
  await settle();
  expect(
    ghCalls("pr merge")
      .filter((c) => c.includes("--match-head-commit"))
      .at(-1),
  ).toContain(`--match-head-commit ${pinned}`);
  expect(store.getLandEntry(entry.id)).toMatchObject({
    state: "blocked",
    reason: "head moved after approval",
  });
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
  const entry = await q.request({ target: pr.run.id });
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
  const entry = await q.request({ target: pr.run.id });
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
  const entry = await q.request({ target: pr.run.id });
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

test.each([
  ["(fail) identifier", "(fail) identifier"],
  ["\u001b[31m✗ colored identifier\u001b[0m", "✗ colored identifier"],
])("a failing land check keeps its identity after a long diagnostic: %s", async (result, identity) => {
  const credential = "synthetic-land-gate-credential-409";
  registerCredential("LAND_GATE_TEST_TOKEN", credential);
  writeFileSync(
    join(seed, "output.txt"),
    `sample.test.ts:\nerror: values differ\nExpected: 1\nReceived: 2\ncredential: ${credential}\n${"x".repeat(9_000)}\n${result}\n` +
      "skipped summary\n".repeat(700) +
      `credential: ${credential}\n`,
  );
  writeFileSync(
    join(seed, ".limitless.toml"),
    `[gates]\nchecks = [{ name = "lint", run = "cat output.txt; echo 'secret in output'; false" }]\n`,
  );
  await sh(["git", "add", "output.txt"], { cwd: seed });
  await sh(["git", "commit", "-qam", "failing check"], { cwd: seed });
  await sh(["git", "push", "-q", bare, "main"], { cwd: seed });
  const pr = delivered(1, "pr-1");
  const head1 = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head1);
  approve(1, head1);
  const q = queue();
  const entry = await q.request({ target: pr.run.id });
  await settle();
  const blocked = store.getLandEntry(entry.id);
  expect(blocked).toMatchObject({ state: "blocked" });
  // Check names only: the output is in the log, never in the reason.
  expect(blocked?.reason).toMatch(/^lint failed \(/);
  expect(blocked?.reason).not.toContain("secret in output");
  const log = readFileSync(blocked?.logPath ?? "", "utf8");
  expect(log).toContain("error: values differ\nExpected: 1\nReceived: 2");
  expect(log).toContain(identity);
  expect(log).toContain("left out");
  expect(log).toContain("credential: [redacted]");
  expect(log).not.toContain(credential);
  expect(log.indexOf(identity)).toBeLessThan(log.indexOf("skipped summary"));
  expect(log.indexOf("error:")).toBeLessThan(log.indexOf("skipped summary"));
  expect(ghCalls("pr merge")).toEqual([]);
});

test("colliding sanitized base gate names block landing without exposing credentials", async () => {
  const secret = "synthetic-land-gate-name-collision-486";
  registerCredential("land-gate-name-collision", secret);
  writeFileSync(
    join(seed, ".limitless.toml"),
    `[gates]\nchecks = [{ name = "check [redacted]", run = "true" }, { name = "check ${secret}", run = "true" }]\n`,
  );
  await sh(["git", "commit", "-qam", "colliding base gates"], { cwd: seed });
  await sh(["git", "push", "-q", bare, "main"], { cwd: seed });
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  const q = queue();
  const entry = await q.request({ target: pr.run.id });
  await settle();
  const blocked = store.getLandEntry(entry.id);
  expect(blocked).toMatchObject({
    state: "blocked",
    reason: '.limitless.toml gate names must stay distinct once sanitized: "check [redacted]"',
  });
  const feed = store.readFeed({ limit: 100 }).items;
  expect(feed.some((item) => item.kind === "land.blocked")).toBe(true);
  expect(JSON.stringify([blocked?.reason, feed, landLog])).not.toContain(secret);
  expect(gateLog()).toEqual([]);
  expect(ghCalls("pr merge")).toEqual([]);
  expect(await remoteHead("pr-1")).toBe(head);
});

test("stopping mid-check leaves a later entry unstarted", async () => {
  rmSync(gateReleasePath());
  const first = delivered(1, "pr-1");
  const head1 = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head1);
  approve(1, head1);
  const second = delivered(2, "pr-2");
  const head2 = await pushBranch("pr-2", "two.txt", "two\n", 2);
  observe(2, head2);
  approve(2, head2);
  const q = queue();
  await q.request({ target: first.run.id });
  await q.request({ target: second.run.id });
  await waitFor(() => gateLog().length === 1);
  await q.stop(); // the daemon stops with the second entry still queued
  // A check that survived the stop would now finish its 0.3 s sleep and 50 ms poll and log "end".
  writeFileSync(gateReleasePath(), "");
  await Bun.sleep(800);
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
  expect(store.claimLandEntry(SLUG, 30_000, "test-owner")?.id).toBe(entry.id);
  expect(store.claimLandEntry(SLUG, 30_000, "test-owner")).toBeNull();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "checking", attempts: 1 });
  // Only the owner can release a claim.
  expect(store.releaseLandClaims("other-owner")).toBe(0);
  expect(store.releaseLandClaims("test-owner")).toBe(1);
  expect(store.claimLandEntry(SLUG, 30_000, "test-owner")?.id).toBe(entry.id);
});

function crashedLandClaim() {
  const pr = delivered(1, "pr-1");
  const entry = store.createLandEntry({
    runId: pr.run.id,
    repo: SLUG,
    prUrl: url(1),
    baseBranch: "main",
    headBranch: "pr-1",
    approvedSha: "a".repeat(40),
  });
  expect(store.claimLandEntry(SLUG, 30_000, "crashed-owner", clock.now() - 5000)?.id).toBe(entry.id);
  return entry;
}

test("recovery wakeup resumes a crashed owner's checking entry after its claim expires", async () => {
  const entry = crashedLandClaim();
  let reads = 0;
  const git = spyOn(repos, "ensureCache");
  const q = queue({
    start: false,
    client: async () => {
      throw new Error("unexpected CI read");
    },
    gh: async (_args, signal) => {
      reads++;
      // Hold resumed processing at its first dependency, and let shutdown abort it.
      return new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  try {
    q.start();
    await clock.flush();
    await clock.advance(25_000);
    expect(store.getLandEntry(entry.id)).toMatchObject({ state: "checking", attempts: 1 });
    expect(reads).toBe(0);
    await clock.advance(5000);
    expect(store.getLandEntry(entry.id)).toMatchObject({ state: "checking", attempts: 2 });
    expect(store.ownsLandClaim(entry.id, "crashed-owner")).toBe(false);
    expect(reads).toBe(1);
    await clock.advance(30_000);
    expect(store.getLandEntry(entry.id)?.attempts).toBe(2);
    expect(reads).toBe(1);
    expect(git).not.toHaveBeenCalled();
    await q.stop();
    expect(clock.pending).toBe(0);
  } finally {
    await q.stop();
    git.mockRestore();
  }
});

test.each([false, true])(
  "idle recovery is bounded and stops without external work, foreign claim=%s",
  async (foreign) => {
    const entry = foreign ? crashedLandClaim() : undefined;
    const calls: string[] = [];
    const git = spyOn(proc, "sh");
    const cache = spyOn(repos, "ensureCache");
    const claim = spyOn(store, "claimLandEntry");
    const q = queue({
      start: false,
      gh: async () => {
        calls.push("gh");
        throw new Error("unexpected gh call");
      },
      client: async () => {
        calls.push("CI");
        return null;
      },
    });
    try {
      q.start();
      q.start();
      await clock.flush();
      expect(clock.pending).toBe(1);
      for (let i = 0; i < 3; i++) {
        await clock.advance(29_999);
        if (entry) expect(store.heartbeatLandClaim(entry.id, "crashed-owner", clock.now())).toBe(true);
        await clock.advance(1);
        expect(clock.pending).toBe(1);
        if (entry) expect(store.getLandEntry(entry.id)).toMatchObject({ state: "checking", attempts: 1 });
      }
      expect(claim.mock.calls).toHaveLength(foreign ? 5 : 0); // two starts and three recovery pumps
      await q.stop();
      expect(clock.pending).toBe(0);
      const claims = claim.mock.calls.length;
      await clock.advance(90_000);
      expect(claim).toHaveBeenCalledTimes(claims);
      expect(calls).toEqual([]);
      expect(github.rest()).toEqual([]);
      expect(git).not.toHaveBeenCalled();
      expect(cache).not.toHaveBeenCalled();
      expect(ghCalls("pr ")).toEqual([]);
    } finally {
      await q.stop();
      claim.mockRestore();
      git.mockRestore();
      cache.mockRestore();
    }
  },
);

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
  await a.request({ target: first.run.id });
  await a.request({ target: second.run.id });
  b.start();
  a.start();
  await settle();
  expect(store.listLandEntries().map((e) => e.state)).toEqual(["landed", "landed"]);
  expect(gateLog()).toEqual(["start", "end", "start", "end"]);
});

test("a restart during checking re-runs the checks from the start", async () => {
  rmSync(gateReleasePath());
  const pr = delivered(1, "pr-1");
  const head1 = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head1);
  approve(1, head1);
  const first = queue();
  const entry = await first.request({ target: pr.run.id });
  await waitFor(() => gateLog().length === 1); // the check is running
  expect(store.getLandEntry(entry.id)?.state).toBe("checking");
  await first.stop(); // the daemon stopped mid-check
  expect(store.getLandEntry(entry.id)?.state).toBe("checking");
  expect(gateLog()).toEqual(["start"]);
  writeFileSync(gateReleasePath(), "");
  queue();
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "landed", attempts: 2 });
  expect(gateLog()).toEqual(["start", "start", "end"]); // the killed check never finished
});

test("a restart during waiting_ci resumes waiting on the pushed commit", async () => {
  const pr = delivered(1, "pr-1");
  const approved = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, approved);
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
  const entry = await q.request({ target: pr.run.id, sha: approved });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
  await q.stop();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "waiting_ci", pushedSha: approved });
  view.ci = "SUCCESS";
  observe(1, approved, "SUCCESS");
  const saved = store.githubPrData(url(1));
  let reads = 0;
  queue({
    client: async () => {
      reads++;
      return { ...view };
    },
  });
  ci = () => null;
  await settle();
  expect(reads).toBeGreaterThan(0);
  expect(store.githubPrData(url(1))).toBe(saved);
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  const merges = ghCalls("pr merge");
  expect(merges).toHaveLength(1);
  expect(merges[0]).toContain(`--match-head-commit ${approved}`);
  expect(merges[0]).not.toContain("--auto");
});

test.each(["merged", "failed", "exception"] as const)(
  "a late merge result after reclaim leaves the newer claim unchanged: %s",
  async (outcome) => {
    const pr = delivered(1, "pr-1");
    store.updateRun(pr.run.id, { status: "needs_human" });
    const head = await pushBranch("pr-1", "one.txt", "one\n");
    observe(1, head, "SUCCESS");
    approve(1, head);
    if (outcome === "failed") writeFileSync(join(root, "gh.reject"), "");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const merge = repos.mergePullRequest;
    const boundary = spyOn(repos, "mergePullRequest").mockImplementation(async (...args) => {
      const result = await merge(...args);
      entered.resolve();
      await release.promise;
      if (outcome === "exception") throw new Error("merge response failed");
      return result;
    });
    const cleanup = spyOn(repos, "disableAutoMerge");
    const q = queue();
    try {
      const entry = await q.request({ target: pr.run.id });
      await entered.promise;
      expect(store.getLandEntry(entry.id)?.state).toBe("merging");
      expect(store.claimLandEntry(SLUG, 30_000, "new-owner", clock.now() + 31_000)?.id).toBe(entry.id);
      const snapshot = () => ({
        entry: store.db.query("SELECT * FROM land_entries WHERE id = ?").get(entry.id),
        run: store.getRun(pr.run.id),
        feed: store.readFeed({ limit: 100 }).items,
        conflicts: store.pendingConflictTriggers(),
        commands: ghCalls("pr "),
      });
      const before = snapshot();
      release.resolve();
      await waitWithoutClock(() => clock.pending === 1, 15_000);
      await q.stop();
      expect(snapshot()).toEqual(before);
      expect(boundary).toHaveBeenCalledTimes(1);
      expect(cleanup).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await q.stop();
      boundary.mockRestore();
      cleanup.mockRestore();
    }
  },
);

test("a resumed land cannot merge after losing its claim during a CI read", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head, "SUCCESS");
  const entry = store.createLandEntry({
    runId: pr.run.id,
    repo: SLUG,
    prUrl: url(1),
    baseBranch: "main",
    headBranch: "pr-1",
    approvedSha: head,
  });
  store.updateLandEntry(entry.id, { state: "waiting_ci", pushedSha: head });
  const view: GitHubPrView = {
    url: url(1),
    state: "OPEN",
    headRefOid: head,
    mergedAt: null,
    mergedBy: null,
    ci: "SUCCESS",
    failing: [],
  };
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<GitHubPrView | null>();
  let reads = 0;
  const q = queue({
    polling: false,
    client: async () => {
      if (++reads === 1) return view; // The fresh recovery lookup confirms OPEN.
      entered.resolve();
      return response.promise;
    },
  });
  try {
    await entered.promise;
    expect(reads).toBe(2);
    expect(store.claimLandEntry(SLUG, 30_000, "new-owner", clock.now() + 31_000)?.id).toBe(entry.id);
    const snapshot = () => ({
      entry: store.db.query("SELECT * FROM land_entries WHERE id = ?").get(entry.id),
      run: store.getRun(pr.run.id),
      feed: store.readFeed({ limit: 100 }).items,
    });
    const before = snapshot();
    response.resolve(view);
    await waitWithoutClock(() => clock.pending === 1, 15_000);
    await q.stop();
    expect(snapshot()).toEqual(before);
    expect(ghCalls("pr merge")).toEqual([]);
  } finally {
    response.resolve(null);
    await q.stop();
  }
});

test.each(["preparation", "completion"] as const)(
  "a reclaim during push %s prevents further publication and checkpoints",
  async (phase) => {
    const pr = delivered(1, "pr-1");
    const head = await pushBranch("pr-1", "one.txt", "one\n");
    observe(1, head, "SUCCESS");
    approve(1, head);
    await advanceBase();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const remote = repos.remoteBranchSha;
    const push = repos.pushExistingBranch;
    const preparation = spyOn(repos, "remoteBranchSha").mockImplementation(async (...args) => {
      const result = await remote(...args);
      if (phase === "preparation") {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const completion = spyOn(repos, "pushExistingBranch").mockImplementation(async (...args) => {
      const result = await push(...args);
      if (phase === "completion") {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const q = queue();
    try {
      const entry = await q.request({ target: pr.run.id });
      await entered.promise;
      expect(store.claimLandEntry(SLUG, 30_000, "new-owner", clock.now() + 31_000)?.id).toBe(entry.id);
      const snapshot = () => ({
        entry: store.db.query("SELECT * FROM land_entries WHERE id = ?").get(entry.id),
        run: store.getRun(pr.run.id),
        feed: store.readFeed({ limit: 100 }).items,
      });
      const before = snapshot();
      const pushed = await remoteHead("pr-1");
      release.resolve();
      await waitWithoutClock(() => clock.pending === 1, 15_000);
      await q.stop();
      expect(snapshot()).toEqual(before);
      expect(await remoteHead("pr-1")).toBe(pushed);
      expect(completion).toHaveBeenCalledTimes(phase === "preparation" ? 0 : 1);
      expect(ghCalls("pr merge")).toEqual([]);
    } finally {
      release.resolve();
      await q.stop();
      preparation.mockRestore();
      completion.mockRestore();
    }
  },
);

test("a restart during merging takes an already merged PR as landed without merging again", async () => {
  const pr = delivered(1, "pr-1");
  store.updateRun(pr.run.id, { status: "needs_human" });
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head, "SUCCESS");
  approve(1, head);
  const saved = store.githubPrData(url(1));
  ci = () => null; // Keep the retained OPEN, green snapshot throughout recovery.
  const completed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const merge = repos.mergePullRequest;
  const boundary = spyOn(repos, "mergePullRequest").mockImplementation(async (...args) => {
    const outcome = await merge(...args);
    expect(outcome).toBe("merged");
    completed.resolve();
    await release.promise;
    args[3]?.throwIfAborted();
    return outcome;
  });
  const q = queue();
  try {
    const entry = await q.request({ target: pr.run.id });
    await completed.promise; // GitHub completed the command; no local landing has been recorded.
    expect(existsSync(join(root, "gh.merged-1"))).toBe(true);
    expect(store.getLandEntry(entry.id)?.state).toBe("merging");
    const stopped = q.stop();
    release.resolve();
    await stopped;
    boundary.mockRestore();
    expect(store.getLandEntry(entry.id)).toMatchObject({ state: "merging", pushedSha: head });
    expect(store.getRun(pr.run.id)?.merged).toBe(false);
    const reads = ghCalls("pr view").length;
    queue();
    await settle();
    expect(ghCalls("pr view").length).toBeGreaterThan(reads);
    expect(store.githubPrData(url(1))).toBe(saved);
    expect(store.getLandEntry(entry.id)).toMatchObject({ state: "landed", pushedSha: head, attempts: 2 });
    expect(ghCalls("pr merge")).toHaveLength(1);
    expect(store.getRun(pr.run.id)).toMatchObject({
      status: "resolved",
      merged: true,
      mergedBy: "owner",
      mergedAt: Date.parse("2026-10-13T12:00:00Z"),
      resolution: { kind: "merged", ref: url(1) },
    });
  } finally {
    release.resolve();
    await q.stop();
    boundary.mockRestore();
  }
});

test.each([
  "different head",
  "missing head",
  "open missing head",
  "open empty head",
  "failed lookup",
  "missing state",
  "wrong URL",
  "closed PR",
  "closed moved head",
])("recovery blocks a stale green snapshot after a fresh %s", async (scenario) => {
  const pr = delivered(1, "pr-1");
  store.updateRun(pr.run.id, { status: "needs_human" });
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head, "SUCCESS");
  const saved = store.githubPrData(url(1));
  ci = () => null;
  const entry = store.createLandEntry({
    runId: pr.run.id,
    repo: SLUG,
    prUrl: url(1),
    baseBranch: "main",
    headBranch: "pr-1",
    approvedSha: head,
  });
  store.updateLandEntry(entry.id, { state: "checking", pushedSha: head, attempts: 1 });
  let reads = 0;
  queue({
    client: async () => {
      reads++;
      if (scenario === "failed lookup") throw new Error("lookup failed");
      return {
        url: scenario === "wrong URL" ? url(2) : url(1),
        state: scenario.startsWith("open")
          ? "OPEN"
          : scenario === "missing state"
            ? ""
            : scenario.startsWith("closed")
              ? "CLOSED"
              : "MERGED",
        headRefOid: scenario.includes("missing head")
          ? undefined
          : scenario === "open empty head"
            ? ""
            : scenario === "closed PR"
              ? head
              : "b".repeat(40),
        mergedAt: null,
        mergedBy: null,
        ci: "SUCCESS",
        failing: [],
      };
    },
  });
  await settle();
  expect(reads).toBe(1);
  expect(store.githubPrData(url(1))).toBe(saved);
  expect(store.getLandEntry(entry.id)).toMatchObject({
    state: "blocked",
    reason: ["different head", "missing head"].includes(scenario)
      ? "merged PR head is missing or differs from the pushed SHA"
      : scenario.startsWith("open")
        ? "PR head is missing"
        : scenario.startsWith("closed")
          ? "PR was closed without merging"
          : "cannot confirm current GitHub merge state",
  });
  expect(store.getRun(pr.run.id)).toMatchObject({ status: "needs_human", merged: false });
  expect(ghCalls("pr merge")).toEqual([]);
  expect(gateLog()).toEqual([]);
});

test.each(["cancel", "shutdown", "claim lost"])(
  "a late fresh recovery observation respects %s",
  async (interrupt) => {
    const pr = delivered(1, "pr-1");
    const head = await pushBranch("pr-1", "one.txt", "one\n");
    observe(1, head, "SUCCESS");
    const entry = store.createLandEntry({
      runId: pr.run.id,
      repo: SLUG,
      prUrl: url(1),
      baseBranch: "main",
      headBranch: "pr-1",
      approvedSha: head,
    });
    store.updateLandEntry(entry.id, { state: "merging", pushedSha: head, attempts: 1 });
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<GitHubPrView | null>();
    const q = queue({
      client: async () => {
        entered.resolve();
        return response.promise;
      },
    });
    try {
      await entered.promise;
      expect(store.getLandEntry(entry.id)?.state).toBe("checking");
      let stopping: Promise<void> | undefined;
      if (interrupt === "cancel") expect(q.cancel(entry.id)).toBe(true);
      else if (interrupt === "shutdown") stopping = q.stop();
      else {
        // Another daemon reclaimed the expired claim while this read was pending.
        expect(store.claimLandEntry(SLUG, 30_000, "new-owner", clock.now() + 31_000)?.id).toBe(entry.id);
      }
      response.resolve({
        url: url(1),
        state: "MERGED",
        headRefOid: head,
        mergedAt: null,
        mergedBy: null,
        ci: "SUCCESS",
        failing: [],
      });
      if (interrupt === "claim lost") await settleIdle();
      await (stopping ?? q.stop());
      expect(store.getLandEntry(entry.id)).toMatchObject({
        state: interrupt === "cancel" ? "cancelled" : "checking",
        pushedSha: head,
      });
      expect(store.getRun(pr.run.id)?.merged).toBe(false);
      expect(ghCalls("pr merge")).toEqual([]);
    } finally {
      response.resolve(null);
      await q.stop();
    }
  },
);

test("CI that never finishes gives up with a reason", async () => {
  const pr = delivered(1, "pr-1");
  const head1 = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head1);
  approve(1, head1);
  const q = queue({ ciTimeoutMs: 5_000 });
  const entry = await q.request({ target: pr.run.id });
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
  const entry = await q.request({ target: pr.run.id });
  await waitFor(() => !!store.getLandEntry(entry.id)?.pushedSha);
  expect(clock.pending).toBeGreaterThan(0); // the fallback read is armed, and is not what wakes it
  observers.get(url(1))?.(store.getLandEntry(entry.id)?.pushedSha ?? "", "SUCCESS");
  await waitFor(() => store.getLandEntry(entry.id)?.state === "landed");
  expect(ghCalls("pr merge")).toHaveLength(1);
});

function workflow(head: string, attempt: number, conclusion: string, status = "completed"): void {
  const job = {
    id: 20 + attempt,
    run_id: 42,
    run_attempt: attempt,
    name: "network",
    head_sha: head,
    status,
    conclusion: conclusion === "failure" ? "timed_out" : conclusion,
    check_run_url: `https://api.github.com/repos/${SLUG}/check-runs/${10 + attempt}`,
    steps: [],
  };
  const check = {
    id: 10 + attempt,
    name: "network",
    head_sha: head,
    status,
    conclusion: job.conclusion,
    details_url: `https://github.com/${SLUG}/actions/runs/42/job/${job.id}`,
    app: { slug: "github-actions" },
  };
  github.responses.set(`repos/${SLUG}/commits/${head}/check-runs?filter=latest&per_page=100&page=1`, () =>
    respond(200, { total_count: 1, check_runs: [check] }),
  );
  github.responses.set(`repos/${SLUG}/actions/runs/42`, () =>
    respond(200, { head_sha: head, run_attempt: attempt }),
  );
  github.responses.set(`repos/${SLUG}/actions/runs/42/attempts/${attempt}/jobs?per_page=100&page=1`, () =>
    respond(200, { total_count: 1, jobs: [job] }),
  );
  github.responses.set(`repos/${SLUG}/actions/jobs/${job.id}`, () => respond(200, job));
  github.responses.set(`repos/${SLUG}/actions/jobs/${job.id}/logs`, () => respond(200, "runner timed out"));
  github.responses.set(`repos/${SLUG}/check-runs/${check.id}/annotations?per_page=100&page=1`, () =>
    respond(200, []),
  );
  github.responses.set(`repos/${SLUG}/actions/jobs/${job.id}/rerun`, () => respond(201, {}));
  writeFileSync(
    join(root, "gh.runs"),
    JSON.stringify([{ databaseId: 42, headSha: head, attempt, conclusion, status }]),
  );
}

test("a transient CI failure is re-run once and lands", async () => {
  const flaky = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
  approve(1, head);
  ci = () => null; // the test answers CI itself, one verdict at a time
  const q = queue();
  const entry = await q.request({ target: flaky.run.id });
  const published = async () => store.getLandEntry(entry.id)?.pushedSha ?? "";
  await waitFor(() => !!store.getLandEntry(entry.id)?.pushedSha);
  workflow(await published(), 1, "failure");
  observers.get(url(1))?.(await published(), "FAILURE", ["network"]);
  await waitFor(() => landLog.some((l) => l.includes("transient CI failure")));
  expect(
    github
      .rest()
      .filter((c) => c.path.endsWith("/rerun"))
      .map((c) => c.path),
  ).toEqual([`repos/${SLUG}/actions/jobs/21/rerun`]);
  // A stale red rollup does not count as the rerun's result or trigger another request.
  await tick();
  expect(store.getLandEntry(entry.id)?.state).toBe("waiting_ci");
  expect(github.rest().filter((c) => c.path.endsWith("/rerun"))).toHaveLength(1);
  workflow(await published(), 2, "", "in_progress");
  observers.get(url(1))?.(await published(), "SUCCESS");
  await tick();
  expect(store.getLandEntry(entry.id)?.state).toBe("waiting_ci");
  expect(ghCalls("pr merge")).toEqual([]);
  await q.stop();
  queue(); // the persisted attempt also prevents a duplicate rerun after restart
  workflow(await published(), 2, "success");
  observers.get(url(1))?.(await published(), "SUCCESS");
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  expect(landLog.filter((l) => l.includes("transient CI failure"))).toHaveLength(1);
  expect(github.rest().filter((c) => c.path.endsWith("/rerun"))).toHaveLength(1);
});

test("a transient CI failure twice blocks, and a real one is not re-run", async () => {
  const broken = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
  approve(1, head);
  ci = () => null;
  const q = queue();
  const entry = await q.request({ target: broken.run.id });
  await waitFor(() => !!store.getLandEntry(entry.id)?.pushedSha);
  const pinned = store.getLandEntry(entry.id)?.pushedSha ?? "";
  workflow(pinned, 1, "failure");
  observers.get(url(1))?.(pinned, "FAILURE", ["network"]);
  await waitFor(() => landLog.some((l) => l.includes("transient CI failure")));
  workflow(pinned, 2, "failure");
  observers.get(url(1))?.(pinned, "FAILURE", ["network"]);
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "blocked", reason: "CI failed: network" });

  const real = delivered(2, "pr-2");
  const head2 = await pushBranch("pr-2", "two.txt", "two\n", 2);
  observe(2, head2);
  approve(2, head2);
  ci = () => null;
  landLog.length = 0;
  const second = await q.request({ target: real.run.id });
  await waitFor(() => !!store.getLandEntry(second.id)?.pushedSha);
  observers.get(url(2))?.(store.getLandEntry(second.id)?.pushedSha ?? "", "FAILURE", ["build"]);
  await settle();
  expect(store.getLandEntry(second.id)).toMatchObject({ state: "blocked", reason: "CI failed: build" });
  expect(landLog.some((l) => l.includes("transient"))).toBe(false);
  expect(ghCalls("pr merge")).toEqual([]);
  expect(github.rest().filter((c) => c.path.endsWith("/rerun"))).toHaveLength(1);
});

test("non-transient main-red CI blocks with names", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  ci = () => null;
  const main = "b".repeat(40);
  github.responses.set(`repos/${SLUG}/commits/${main}/check-runs?filter=latest&per_page=100&page=1`, () =>
    respond(200, {
      total_count: 2,
      check_runs: ["build", "lint"].map((name, i) => ({
        id: 99 + i,
        name,
        head_sha: main,
        status: "completed",
        conclusion: "failure",
      })),
    }),
  );
  const entry = await queue().request({ target: pr.run.id });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
  const before = clock.now();
  observe(1, store.getLandEntry(entry.id)?.pushedSha ?? "", "FAILURE", ["build", "lint"]);
  await waitWithoutClock(() => store.getLandEntry(entry.id)?.state === "blocked");
  expect(store.getLandEntry(entry.id)).toMatchObject({
    state: "blocked",
    reason: "CI failed: build, lint",
  });
  expect(clock.now()).toBe(before);
  expect(github.rest().filter((c) => c.path.endsWith("/rerun"))).toEqual([]);
  expect(ghCalls("pr merge")).toEqual([]);
});

test.each(["pushed", "unrelated"])(
  "rerun preflight waits for the approved-head lag, then handles the %s head",
  async (nextHead) => {
    const pr = delivered(1, "pr-1");
    const approved = await pushBranch("pr-1", "one.txt", "one\n");
    observe(1, approved);
    approve(1, approved);
    await advanceBase();
    ci = () => null;
    const entry = await queue().request({ target: pr.run.id });
    await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
    const pinned = store.getLandEntry(entry.id)?.pushedSha ?? "";
    expect(pinned).not.toBe(approved);
    workflow(pinned, 1, "failure");
    let remote = approved;
    let reads = 0;
    github.responses.set(`repos/${SLUG}/pulls/1`, () => {
      reads++;
      return respond(200, { head: { sha: remote }, state: "open" });
    });
    observe(1, pinned, "FAILURE", ["network"]);
    await waitWithoutClock(
      () => reads === 1 && (clock.pending > 2 || store.getLandEntry(entry.id)?.state === "blocked"),
    );
    expect(store.getLandEntry(entry.id)?.state).toBe("waiting_ci");
    expect(github.rest().filter((c) => c.path.endsWith("/rerun"))).toEqual([]);
    expect(ghCalls("pr merge")).toEqual([]);

    remote = nextHead === "pushed" ? pinned : "c".repeat(40);
    observe(1, pinned, "FAILURE", ["network"]);
    if (nextHead === "unrelated") {
      await waitWithoutClock(() => store.getLandEntry(entry.id)?.state === "blocked");
      expect(store.getLandEntry(entry.id)?.reason).toBe("head moved after approval");
      expect(github.rest().filter((c) => c.path.endsWith("/rerun"))).toEqual([]);
    } else {
      await waitWithoutClock(() => landLog.some((l) => l.includes("transient CI failure")));
      expect(store.getLandEntry(entry.id)?.state).toBe("waiting_ci");
      await tick();
      expect(github.rest().filter((c) => c.path.endsWith("/rerun"))).toHaveLength(1);
      workflow(pinned, 2, "success");
      observe(1, pinned, "SUCCESS");
      await settle();
      expect(store.getLandEntry(entry.id)?.state).toBe("landed");
      expect(github.rest().filter((c) => c.path.endsWith("/rerun"))).toHaveLength(1);
    }
  },
);

test("moved head discovered by rerun preflight blocks immediately", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  ci = () => null;
  const entry = await queue().request({ target: pr.run.id });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
  const pinned = store.getLandEntry(entry.id)?.pushedSha ?? "";
  workflow(pinned, 1, "failure");
  github.responses.set(`repos/${SLUG}/pulls/1`, () =>
    respond(200, { head: { sha: "c".repeat(40) }, state: "open" }),
  );
  const before = clock.now();
  observe(1, pinned, "FAILURE", ["network"]);
  await waitWithoutClock(() => store.getLandEntry(entry.id)?.state === "blocked");
  expect(store.getLandEntry(entry.id)?.reason).toBe("head moved after approval");
  expect(clock.now()).toBe(before);
  expect(github.rest().filter((c) => c.path.endsWith("/rerun"))).toEqual([]);
  expect(ghCalls("pr merge")).toEqual([]);
});

test("moved head interrupts a stalled classifier read", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  ci = () => null;
  const entry = await queue().request({ target: pr.run.id });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
  const pinned = store.getLandEntry(entry.id)?.pushedSha ?? "";
  github.hold = new Promise<void>(() => {});
  observe(1, pinned, "FAILURE", ["build"]);
  await waitWithoutClock(() => github.inFlight === 1);
  const readSignal = github.signals.at(-1);
  expect(readSignal?.aborted).toBe(false);
  const before = clock.now();
  observe(1, "c".repeat(40), "PENDING");
  await waitWithoutClock(() => store.getLandEntry(entry.id)?.state === "blocked");
  expect(readSignal?.aborted).toBe(true);
  expect(github.inFlight).toBe(0);
  expect(store.getLandEntry(entry.id)?.reason).toBe("head moved after approval");
  expect(clock.now()).toBe(before);
  expect(github.rest().filter((c) => c.path.endsWith("/rerun"))).toEqual([]);
  expect(ghCalls("pr merge")).toEqual([]);
});

test("a saved moved head blocks without advancing the clock even when a CI read stalls", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
  approve(1, head);
  ci = () => null;
  let reads = 0;
  const entry = await queue({
    client: (_url, signal) =>
      new Promise<GitHubPrView | null>((_resolve, reject) => {
        reads++;
        // Never answer the read; reject only on shutdown so a failed test can clean up.
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  }).request({ target: pr.run.id });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
  const moved = await pushBranch("pr-1", "one.txt", "one\nagain\n", 1);
  const before = clock.now();
  observe(1, moved, "PENDING");
  const deadline = Date.now() + 800;
  while (store.getLandEntry(entry.id)?.state !== "blocked") {
    if (Date.now() > deadline) throw new Error("head observation did not block the land");
    await settleIdle();
  }
  expect(clock.now()).toBe(before);
  expect(store.getLandEntry(entry.id)?.reason).toBe("head moved after approval");
  expect(reads).toBe(0);
  expect(ghCalls("pr merge")).toEqual([]);
});

test("a cancel during the private-range check stays cancelled after a queue restart", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const check = repos.checkPrivatePublication;
  const range = spyOn(repos, "checkPrivatePublication").mockImplementationOnce(async (...args) => {
    await check(...args);
    entered.resolve();
    await release.promise;
  });
  const q = queue();
  try {
    const entry = await q.request({ target: pr.run.id });
    await entered.promise;
    expect(store.getLandEntry(entry.id)?.state).toBe("checking");
    expect(q.cancel(entry.id)).toBe(true);
    release.resolve();
    await q.stop();
    expect(store.getLandEntry(entry.id)).toMatchObject({ state: "cancelled", pushedSha: null });
    const restarted = queue();
    await restarted.stop();
    expect(store.getLandEntry(entry.id)).toMatchObject({ state: "cancelled", attempts: 1 });
    expect(gateLog()).toEqual(["start", "end"]);
    expect(ghCalls("pr merge")).toEqual([]);
  } finally {
    release.resolve();
    await q.stop();
    range.mockRestore();
  }
});

test.each(["OPEN", "MERGED"])(
  "a cancel during %s CI observation stays cancelled after a queue restart",
  async (state) => {
    const pr = delivered(1, "pr-1");
    const head = await pushBranch("pr-1", "one.txt", "one\n");
    const round = roundRun(pr.run.id, url(1), head);
    store.updateRun(round.id, { status: "needs_human" });
    observe(1, head);
    approve(1, head);
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<GitHubPrView | null>();
    const q = queue({
      polling: false,
      client: async () => {
        entered.resolve();
        return response.promise;
      },
    });
    try {
      const entry = await q.request({ target: pr.run.id });
      await entered.promise;
      expect(store.getLandEntry(entry.id)?.state).toBe("waiting_ci");
      expect(q.cancel(entry.id)).toBe(true);
      response.resolve({
        url: url(1),
        state,
        mergedAt: state === "MERGED" ? "2026-10-13T12:00:00Z" : null,
        mergedBy: state === "MERGED" ? { login: "owner" } : null,
        headRefOid: head,
        ci: "SUCCESS",
        failing: [],
      });
      await q.stop();
      expect(store.getLandEntry(entry.id)).toMatchObject({ state: "cancelled", pushedSha: head });
      const restarted = queue();
      await restarted.stop();
      expect(store.getLandEntry(entry.id)).toMatchObject({ state: "cancelled", attempts: 1 });
      expect(ghCalls("pr merge")).toEqual([]);
      for (const id of [pr.run.id, round.id]) expect(store.getRun(id)?.merged).toBe(state === "MERGED");
      if (state === "MERGED") {
        expect(store.getRun(round.id)?.resolution).toMatchObject({ kind: "merged", ref: url(1) });
        expect(store.getRun(pr.run.id)).toMatchObject({
          mergedBy: "owner",
          mergedAt: Date.parse("2026-10-13T12:00:00Z"),
        });
      }
    } finally {
      response.resolve(null);
      await q.stop();
    }
  },
);

test("a cancel interrupts a CI read that never answers", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
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
  const entry = await q.request({ target: pr.run.id, sha: head });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
  q.cancel(entry.id);
  await q.stop();
  expect(store.getLandEntry(entry.id)?.state).toBe("cancelled");
});

test.each(["review", "conflict", "ci"] as const)(
  "a %s round lands with the original run's checked squash subject",
  async (kind) => {
    const pr = delivered(1, "pr-1");
    const head = await pushBranch("pr-1", "one.txt", "one\n");
    store.updateRun(pr.run.id, { baseSha: await remoteHead("main") });
    let round: Run | null;
    if (kind === "review") {
      round = roundRun(pr.run.id, url(1), head);
      store.updateRun(round.id, { title: "Review round 1: PR 1" });
    } else {
      if (kind === "conflict") store.recordConflictTrigger(url(1), head, "land", clock.now());
      else
        store.recordCiFixTrigger(
          url(1),
          head,
          "failure",
          { check: "test", line: "FAIL", excerpt: "FAIL" },
          clock.now(),
        );
      const trigger =
        kind === "conflict" ? store.pendingConflictTriggers()[0] : store.pendingCiFixTriggers()[0];
      if (!trigger) throw new Error("missing round trigger");
      const observation = { state: "OPEN", headRefOid: head };
      round =
        kind === "conflict"
          ? store.startConflictTrigger(trigger.id, observation, clock.now())
          : store.startCiFixTrigger(trigger.id, observation, clock.now());
      if (round) store.updateRun(round.id, { status: "succeeded" });
    }
    if (!round) throw new Error("round refused");
    expect(store.reviewRound(round.id)?.kind).toBe(kind);
    observe(1, head);
    store.recordApproval(round.id, url(1), head, "orchestrator");
    const publication = repos.checkPrivatePublication;
    const check = spyOn(repos, "checkPrivatePublication").mockImplementation(async (...args) => {
      await publication(...args);
      store.updateRun(pr.run.id, { title: "Changed after publication check" });
    });
    try {
      const entry = await queue().request({ target: round.id });
      await settle();
      expect(store.getLandEntry(entry.id)?.state).toBe("landed");
      expect(check.mock.calls.map(([, , input]) => input?.squash?.title)).toEqual(["PR 1 (#1)"]);
      expect(ghCalls("pr merge")).toEqual([
        `pr merge ${url(1)} --squash --delete-branch --match-head-commit ${head} --subject PR 1 (#1) --body-file -`,
      ]);
    } finally {
      check.mockRestore();
    }
  },
);

test("a review-round land merges current main into the approved head before checking", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  const round = roundRun(pr.run.id, url(1), head);
  observe(1, head);
  store.recordApproval(round.id, url(1), head, "orchestrator");
  await advanceBase(true);
  const entry = await queue().request({ target: round.id });
  expect(entry.baseBranch).toBe("main");
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  expect(gateLog()).toEqual(["moved"]);
  await waitWithoutClock(() => store.getRun(pr.run.id)?.mergedBy === "owner", 15_000);
  const metadata = { merged: true, mergedBy: "owner", mergedAt: Date.parse("2026-10-13T12:00:00Z") };
  expect(store.getRun(pr.run.id)).toMatchObject(metadata);
  expect(
    store
      .readFeed({ limit: 100 })
      .items.find((item) => item.runId === pr.run.id && item.kind === "run.merged")?.data,
  ).toMatchObject({ mergedBy: metadata.mergedBy, mergedAt: metadata.mergedAt });
  const landed = await remoteHead("pr-1");
  for (const sha of [head, await remoteHead("main")])
    expect((await sh(["git", "merge-base", "--is-ancestor", sha, landed], { cwd: bare })).exitCode).toBe(0);
});

for (const state of ["queued", "waiting_ci"] as const) {
  test(`a stored ${state} land with its head as base resolves main before checking`, async () => {
    const pr = delivered(1, "pr-1");
    const head = await pushBranch("pr-1", "one.txt", "one\n");
    const round = roundRun(pr.run.id, url(1), head);
    observe(1, head);
    await advanceBase(true);
    const entry = store.createLandEntry({
      runId: round.id,
      repo: SLUG,
      prUrl: url(1),
      baseBranch: "pr-1",
      headBranch: "pr-1",
      approvedSha: head,
    });
    if (state === "waiting_ci") {
      store.updateRun(pr.run.id, { baseBranch: "" });
      writeFileSync(join(root, "gh.base-1"), "main");
      store.updateLandEntry(entry.id, {
        state,
        pushedSha: head,
        ciRerun: JSON.stringify([
          { databaseId: 1, headSha: head, attempt: 1, status: "completed", conclusion: "failure" },
        ]),
      });
    }
    queue();
    await settle();
    expect(store.getLandEntry(entry.id)).toMatchObject({
      baseBranch: "main",
      state: "landed",
      ciRerun: null,
    });
    expect(gateLog()).toEqual(["moved"]);
    expect(
      (
        await sh(["git", "merge-base", "--is-ancestor", await remoteHead("main"), await remoteHead("pr-1")], {
          cwd: bare,
        })
      ).exitCode,
    ).toBe(0);
  });
}

test("a round with an unavailable owner base uses GitHub's PR base, not the default", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  const round = roundRun(pr.run.id, url(1), head);
  store.updateRun(pr.run.id, { baseBranch: "" });
  writeFileSync(join(root, "gh.base-1"), "release");
  observe(1, head);
  store.recordApproval(round.id, url(1), head, "orchestrator");
  const q = queue({ start: false });
  await q.stop();
  const entry = await q.request({ target: round.id });
  expect(entry).toMatchObject({ baseBranch: "release", state: "queued" });
  expect(ghCalls("pr view")).toHaveLength(1);
});

for (const mode of ["request", "stored"] as const) {
  test(`an undeterminable PR base blocks a ${mode} land before checks or publication`, async () => {
    const pr = delivered(1, "pr-1");
    const head = await pushBranch("pr-1", "one.txt", "one\n");
    const round = roundRun(pr.run.id, url(1), head);
    store.updateRun(pr.run.id, { baseBranch: "pr-1" });
    if (mode === "stored") writeFileSync(join(root, "gh.base-1"), "pr-1");
    observe(1, head);
    store.recordApproval(round.id, url(1), head, "orchestrator");
    const entry =
      mode === "request"
        ? await queue().request({ target: round.id })
        : store.createLandEntry({
            runId: round.id,
            repo: SLUG,
            prUrl: url(1),
            baseBranch: "pr-1",
            headBranch: "pr-1",
            approvedSha: head,
          });
    if (mode === "stored") queue();
    await settle();
    expect(store.getLandEntry(entry.id)).toMatchObject({
      state: "blocked",
      reason: expect.stringContaining("cannot determine PR base branch"),
      pushedSha: null,
      logPath: null,
    });
    expect(gateLog()).toEqual([]);
    expect(await remoteHead("pr-1")).toBe(head);
    expect(ghCalls("pr merge")).toEqual([]);
    expect(existsSync(join(paths.repos, "test__repo.git"))).toBe(false);
    expect(
      store.readFeed({ limit: 100 }).items.find((i) => i.kind === "land.blocked")?.data.reason,
    ).toContain("cannot determine PR base branch");
  });
}

test("a land request names a review round, a pull request URL or its number", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n", 1);
  observe(1, head);
  const round = roundRun(pr.run.id, url(1), head);
  store.recordApproval(round.id, url(1), head, "orchestrator");
  const q = queue({ start: false });
  await q.stop();
  for (const target of [url(1), "1", "#1", round.id, pr.run.id]) {
    const entry = await q.request({ target });
    expect(entry.baseBranch).toBe("main");
    expect(entry.runId).toBe(target === pr.run.id ? pr.run.id : round.id);
    store.updateLandEntry(entry.id, { state: "blocked", reason: "reset" });
  }
});

test("a request needs a review approval, or an explicit head that is the PR's", async () => {
  const pr = delivered(1, "pr-1");
  const q = queue({ start: false });
  await expect(q.request({ target: "missing" })).rejects.toThrow("run not found");
  await expect(q.request({ target: "77" })).rejects.toThrow("run not found");
  await expect(q.request({ target: pr.run.id })).rejects.toThrow("no review approval");
  await expect(q.request({ target: pr.run.id, sha: "c".repeat(40) })).rejects.toThrow(
    "not the pull request's current head",
  );
  observe(1, "c".repeat(40));
  approve(1, "c".repeat(40));
  // A head that moved after the approval makes it stale.
  store.observePrHead(url(1), "b".repeat(40));
  await expect(q.request({ target: pr.run.id })).rejects.toThrow("approval is stale");
  expect((await q.request({ target: pr.run.id, sha: "c".repeat(40) })).approvedSha).toBe("c".repeat(40));
  await expect(q.request({ target: pr.run.id, sha: "d".repeat(40) })).rejects.toThrow(
    "not the pull request's current head",
  );
  await expect(q.request({ target: pr.run.id, sha: "short" })).rejects.toThrow("full commit id");
  await expect(q.request({ target: pr.run.id, sha: "c".repeat(40) })).rejects.toThrow(
    "already in the land queue",
  );
  store.saveGithubPr({
    url: url(1),
    repo: SLUG,
    runId: pr.run.id,
    delivered: 1,
    nodeId: "PR_1",
    data: JSON.stringify({ headRefOid: "c".repeat(40), state: "MERGED", ci: "SUCCESS", failing: [] }),
  });
  await expect(q.request({ target: pr.run.id })).rejects.toThrow("MERGED");
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
    const round = roundRun(run.id, url(7), "b".repeat(40), f.factory.store);
    f.factory.store.saveGithubPr({
      url: url(7),
      repo: SLUG,
      runId: run.id,
      delivered: 1,
      nodeId: "PR_7",
      data: JSON.stringify({ headRefOid: "b".repeat(40), state: "OPEN", ci: "PENDING", failing: [] }),
    });
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
    expect((await post({ target: round.id }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post({})).status).toBe(400);
    expect((await post({ target: "missing" })).status).toBe(400);
    const created = (await (await post({ runId: round.id, sha: "b".repeat(40) })).json()) as LandEntry;
    expect(created).toMatchObject({
      runId: round.id,
      baseBranch: "main",
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
    unowned();
    const head = await pushBranch("pr-1", "one.txt", "one\n");
    const manual = (await (await post({ target: url(1), sha: head })).json()) as LandEntry;
    expect(manual).toMatchObject({ runId: null, title: "Hand-made change", state: "queued" });
    const withManual = (await (
      await land.GET(requestWithParams("http://localhost:7400/api/land"), localServer)
    ).json()) as LandEntry[];
    expect(withManual.find((e) => e.id === manual.id)).toMatchObject({
      runId: null,
      title: "Hand-made change",
    });
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

for (const location of ["commit", "author email", "subject", "body"]) {
  test(`publication blocks a private string in the ${location} without disclosing it`, async () => {
    const secret = "denylisted-private-value";
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(join(paths.configDir, "private-strings.txt"), secret);
    const pr = delivered(1, "pr-1");
    const head = await pushBranch("pr-1", "one.txt", location === "commit" ? secret : "one\n");
    const complete = gitMerge.completeMerge;
    const check = spyOn(gitMerge, "completeMerge").mockImplementation(async (...args) => {
      const head = await complete(...args);
      if (location !== "author email") return head;
      const cwd = args[0];
      await sh(
        [
          "git",
          "-c",
          `user.email=${secret}@example.test`,
          "commit",
          "--amend",
          "--no-edit",
          "--reset-author",
        ],
        { cwd },
      );
      return repos.headSha(cwd);
    });
    try {
      if (location === "subject") store.updateRun(pr.run.id, { title: secret });
      if (location === "body") store.putArtifact(pr.run.id, "report.md", "report", secret);
      observe(1, head);
      approve(1, head);
      await advanceBase();
      const entry = await queue().request({ target: pr.run.id });
      await settle();
      expect(store.getLandEntry(entry.id)).toMatchObject({ state: "blocked" });
      expect(store.getLandEntry(entry.id)?.reason).toContain("private string");
      expect(store.getLandEntry(entry.id)?.reason).not.toContain(secret);
      expect(landLog.join("\n")).not.toContain(secret);
      expect(await remoteHead("pr-1")).toBe(head);
      expect(ghCalls("pr merge")).toEqual([]);
    } finally {
      check.mockRestore();
    }
  });
}

test("squash publication strips report metadata and preserves the stored manifest", async () => {
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(join(paths.configDir, "private-strings.txt"), "limitless-report:");
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  const report = markReport(["## Checks", reportText("implementer", "Public summary")]);
  store.putArtifact(pr.run.id, "report.md", "report", report);
  const entry = await queue().request({ target: pr.run.id });
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  const body = readFileSync(join(root, "gh.body-1"), "utf8");
  expect(body).toContain("Public summary");
  expect(body).not.toContain("limitless-report:");
  expect(reportStructure(store.getArtifact(pr.run.id, "report.md") ?? "")).toBeTruthy();
});

test("squash privacy checks and merge use paths relative to the originating worktree", async () => {
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(join(paths.configDir, "private-strings.txt"), paths.home);
  const pr = delivered(1, "pr-1");
  const origin = join(paths.work, "originating-run");
  store.setRunState(pr.run.id, { worktreePath: origin });
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  const secret = "SYNTHETIC_SQUASH_CREDENTIAL_582";
  const report = markReport([
    reportText(
      "implementer",
      `[one](${origin}/one.txt) \`${origin}/one.txt\` [log](${paths.runs}/log.txt) ${secret}`,
    ),
  ]);
  store.putArtifact(pr.run.id, "report.md", "report", report);
  // Register after storing to exercise credential redaction at the land boundary itself.
  registerCredential("squash-publication-test", secret);
  const entry = await queue().request({ target: pr.run.id });
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  const body = readFileSync(join(root, "gh.body-1"), "utf8");
  expect(body).toContain("[one.txt](one.txt) `one.txt` <data>/runs/log.txt [redacted]");
  expect(body).not.toContain(paths.home);
  expect(body).not.toContain(secret);
  expect(body).not.toContain("limitless-report:");
  expect(reportStructure(store.getArtifact(pr.run.id, "report.md") ?? "")).toBeTruthy();
});

test("an empty report sends an explicit empty merge body", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  store.putArtifact(pr.run.id, "report.md", "report", "");
  const entry = await queue().request({ target: pr.run.id });
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  expect(ghCalls("pr merge")[0]).toContain("--body-file -");
  expect(readFileSync(join(root, "gh.body-1"), "utf8")).toBe("");
});

test("a second process cannot reclaim a heartbeating land, but can reclaim its expired heartbeat", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  ci = () => null;
  const q = queue();
  const entry = await q.request({ target: pr.run.id });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
  const second = async (now: number) => {
    const code = `import { Store } from ${JSON.stringify(join(process.cwd(), "src/db/store.ts"))};
      const s = new Store(${JSON.stringify(paths.db)});
      s.releaseLandClaims("second-process");
      console.log(JSON.stringify(s.claimLandEntry(${JSON.stringify(SLUG)}, 30000, "second-process", ${now})));
      s.close();`;
    const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(output) as LandEntry | null;
  };
  await clock.advance(31_000);
  expect(await second(clock.now())).toBeNull();
  expect(store.getLandEntry(entry.id)?.attempts).toBe(1);
  // No more owner timer ticks: another process observes expiry after a further 31 seconds.
  expect(await second(clock.now() + 31_000)).toMatchObject({ id: entry.id, attempts: 2 });
  await q.stop();
  expect(store.releaseLandClaims("second-process")).toBe(1);
});

test("a head observation received during a CI read blocks without a timer", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  ci = () => null;
  const moved = "b".repeat(40);
  let reads = 0;
  const q = queue({
    polling: false,
    client: async () => {
      if (++reads === 1) observe(1, moved, "PENDING");
      return {
        url: url(1),
        state: "OPEN",
        mergedAt: null,
        mergedBy: null,
        headRefOid: reads === 1 ? head : moved,
        ci: "PENDING",
        failing: [],
      };
    },
  });
  const before = clock.now();
  const entry = await q.request({ target: pr.run.id });
  const deadline = Date.now() + 5_000;
  while (store.getLandEntry(entry.id)?.state !== "blocked") {
    if (Date.now() > deadline) throw new Error("CI read lost the head observation");
    await settleIdle();
  }
  expect(clock.now()).toBe(before);
  expect(store.getLandEntry(entry.id)?.reason).toBe("head moved after approval");
  expect(ghCalls("pr merge")).toEqual([]);
});

test("land accepts already-published private ancestry despite an inherited local Git scope and graft", async () => {
  const secret = "denylisted-private-parent";
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(join(paths.configDir, "private-strings.txt"), secret);
  const pr = delivered(1, "pr-1");
  await pushBranch("pr-1", "one.txt", secret);
  const head = await pushBranch("pr-1", "one.txt", "clean\n");
  observe(1, head);
  approve(1, head);
  const repo = store.getRepoBySlug(SLUG);
  if (!repo) throw new Error("missing test repo");
  await ensureCache(paths, repo);
  const graft = join(root, "grafts");
  writeFileSync(graft, `${head} ${await remoteHead("main")}\n`);
  const previous = process.env.GIT_GRAFT_FILE;
  process.env.GIT_GRAFT_FILE = graft;
  try {
    const entry = await worktreeGitScope.run(false, () => queue().request({ target: pr.run.id }));
    await settle();
    expect(store.getLandEntry(entry.id)?.state).toBe("landed");
    expect(ghCalls("pr merge")).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env.GIT_GRAFT_FILE;
    else process.env.GIT_GRAFT_FILE = previous;
  }
});

test.each(["clean", "final", "merge"])(
  "waiting_ci rechecks persisted publication without pushing: %s",
  async (scenario) => {
    const unsafe = `%${"25".repeat(6)}72`;
    const pr = delivered(1, "pr-1");
    await pushBranch("pr-1", "transient.txt", unsafe);
    await sh(["git", "rm", "transient.txt"], { cwd: seed });
    await sh(["git", "commit", "-qm", "remove intermediate"], { cwd: seed });
    const approved = await pushBranch("pr-1", "one.txt", scenario === "final" ? unsafe : "clean\n", 1);
    await advanceBase();
    await sh(["git", "checkout", "-q", "pr-1"], { cwd: seed });
    await sh(["git", "merge", "-q", "--no-ff", "-m", scenario === "merge" ? unsafe : "base merge", "main"], {
      cwd: seed,
    });
    const head = (await sh(["git", "rev-parse", "HEAD"], { cwd: seed })).stdout.trim();
    await sh(["git", "push", "-q", bare, "HEAD:refs/heads/pr-1"], { cwd: seed });
    observe(1, head, "SUCCESS");
    approve(1, approved);
    const entry = store.createLandEntry({
      runId: pr.run.id,
      repo: SLUG,
      prUrl: url(1),
      baseBranch: "main",
      headBranch: "pr-1",
      approvedSha: approved,
    });
    store.updateLandEntry(entry.id, { state: "waiting_ci", pushedSha: head, attempts: 1 });
    const push = spyOn(repos, "pushExistingBranch");
    try {
      queue();
      await settle();
      expect(store.getLandEntry(entry.id)?.state).toBe(scenario === "clean" ? "landed" : "blocked");
      if (scenario !== "clean") expect(store.getLandEntry(entry.id)?.reason).toContain("decoding limit");
      expect(push).not.toHaveBeenCalled();
      expect(await remoteHead("pr-1")).toBe(head);
      expect(ghCalls("pr merge")).toHaveLength(scenario === "clean" ? 1 : 0);
      expect(gateLog()).toEqual([]);
    } finally {
      push.mockRestore();
    }
  },
);

function claimSnapshot(entry: LandEntry) {
  if (!entry.runId) throw new Error("expected a factory entry");
  return {
    entry: store.db.query("SELECT * FROM land_entries WHERE id = ?").get(entry.id),
    run: store.getRun(entry.runId),
    feed: store.readFeed({ limit: 1000 }).items,
    failures: store.ciFailures(entry.prUrl, entry.pushedSha ?? entry.approvedSha),
    triggers: store.pendingCiFixTriggers(),
    main: store.getSetting(`ci.main:${SLUG}`, null),
    events: store.listEvents(entry.runId),
  };
}

test("a reclaim during push retry backoff prevents the next push and all publication", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head, "SUCCESS");
  approve(1, head);
  await advanceBase();
  let pushes = 0;
  let release: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const set = globalThis.setTimeout;
  const execute = proc.sh;
  const transport = spyOn(proc, "sh").mockImplementation((cmd, opts) => {
    if (cmd.includes("push")) {
      pushes++;
      return Promise.reject(
        new CommandError("push unavailable", 1, "", pushes === 1 ? "HTTP 502" : "rejected", false),
      );
    }
    return execute(cmd, opts);
  });
  const pause = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (pushes === 1 && ms === repos.githubRetry.baseDelayMs && !release) {
      // Keep the native timer handle for clearTimeout, but release backoff explicitly.
      timer = set(() => {}, 60_000);
      release = () => callback(...args);
      return timer;
    }
    return set(callback, ms, ...args);
  }) as typeof setTimeout);
  const q = queue({ gateExecutor: fakeLandGates((req) => retryRun(req)).executor });
  try {
    const entry = await q.request({ target: pr.run.id });
    await waitWithoutClock(() => !!release, 15_000);
    expect(store.claimLandEntry(SLUG, 30_000, "new-owner", clock.now() + 31_000)?.id).toBe(entry.id);
    const before = claimSnapshot(entry);
    const now = clock.now();
    release?.();
    await waitWithoutClock(() => clock.pending === 1, 15_000);
    expect(pushes).toBe(1);
    expect(ghCalls("pr merge")).toEqual([]);
    expect(claimSnapshot(entry)).toEqual(before);
    expect(await remoteHead("pr-1")).toBe(head);
    expect(clock.now()).toBe(now);
  } finally {
    release?.();
    if (timer) clearTimeout(timer);
    await q.stop();
    pause.mockRestore();
    transport.mockRestore();
  }
});

test("a restarted land removes only older base exports as plain directories before checkout", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head, "SUCCESS");
  approve(1, head);
  const entry = store.createLandEntry({
    runId: pr.run.id,
    repo: SLUG,
    prUrl: url(1),
    baseBranch: "main",
    headBranch: "pr-1",
    approvedSha: head,
  });
  store.updateLandEntry(entry.id, { state: "checking", attempts: 2 });
  const prefix = `land-${entry.id}`;
  const abandoned = [prefix, `${prefix}-1`, `${prefix}-base`, `${prefix}-1-base`, `${prefix}-2-base`];
  const preserved = [
    `${prefix}-3-base`,
    `${prefix}-4-base`,
    `${prefix}-4`,
    `land-${entry.id + 1}-1-base`,
    `${prefix}-other-base`,
    `${prefix}-2-base-extra`,
    `${prefix}-2-base.git-paths`,
  ];
  for (const name of [...abandoned, ...preserved]) {
    mkdirSync(join(paths.work, name));
    writeFileSync(join(paths.work, name, "sentinel"), name);
  }
  let inspected = false;
  const add = repos.addDetachedWorktree;
  const checkout = spyOn(repos, "addDetachedWorktree").mockImplementation((...args) => {
    expect(args[2]).toBe(join(paths.work, `${prefix}-3`));
    for (const name of abandoned) expect(existsSync(join(paths.work, name))).toBe(false);
    for (const name of preserved) expect(readFileSync(join(paths.work, name, "sentinel"), "utf8")).toBe(name);
    inspected = true;
    return add(...args);
  });
  const removal = spyOn(repos, "removeWorktree");
  const q = queue({ gateExecutor: fakeLandGates((req) => retryRun(req)).executor });
  try {
    await settle();
    await q.stop();
    expect(inspected).toBe(true);
    expect(store.getLandEntry(entry.id)).toMatchObject({ state: "landed", attempts: 3 });
    expect(removal.mock.calls.map(([, , cwd]) => cwd).sort()).toEqual(
      [prefix, `${prefix}-1`, `${prefix}-3`].map((name) => join(paths.work, name)).sort(),
    );
    for (const name of preserved.filter((name) => name !== `${prefix}-3-base`))
      expect(readFileSync(join(paths.work, name, "sentinel"), "utf8")).toBe(name);
  } finally {
    await q.stop();
    checkout.mockRestore();
    removal.mockRestore();
  }
});

test("a reclaim during the pre-merge lookup prevents every merge command", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head, "SUCCESS");
  approve(1, head);
  writeFileSync(join(root, "gh.hold-view"), "");
  const q = queue();
  try {
    const entry = await q.request({ target: pr.run.id });
    await waitFor(() => ghCalls("pr view").some((c) => c.includes("title,body,headRefOid,state")));
    expect(store.claimLandEntry(SLUG, 30_000, "new-owner", clock.now() + 31_000)?.id).toBe(entry.id);
    const before = claimSnapshot(entry);
    rmSync(join(root, "gh.hold-view"));
    await waitWithoutClock(() => clock.pending === 1, 15_000);
    expect(claimSnapshot(entry)).toEqual(before);
    expect(ghCalls("pr merge")).toEqual([]);
  } finally {
    rmSync(join(root, "gh.hold-view"), { force: true });
    await q.stop();
  }
});

test("pushExistingBranch checks the claim after its internal remote lookup and aborts", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head, "SUCCESS");
  approve(1, head);
  await advanceBase();
  const push = repos.pushExistingBranch;
  let before: ReturnType<typeof claimSnapshot> | undefined;
  let entry: LandEntry | undefined;
  let signal: AbortSignal | undefined;
  const boundary = spyOn(repos, "pushExistingBranch").mockImplementation(async (...args) => {
    signal = args[4];
    const guard = args[7];
    args[7] = () => {
      entry = store.claimLandEntry(SLUG, 30_000, "new-owner", clock.now() + 31_000) ?? undefined;
      if (!entry) throw new Error("reclaim failed");
      before = claimSnapshot(entry);
      guard?.();
    };
    return push(...args);
  });
  const q = queue();
  try {
    await q.request({ target: pr.run.id });
    await waitWithoutClock(() => !!before && clock.pending === 1, 15_000);
    if (!entry || !before) throw new Error("guard never reached");
    expect(claimSnapshot(entry)).toEqual(before);
    expect(signal?.aborted).toBe(true);
    expect(await remoteHead("pr-1")).toBe(head);
    expect(ghCalls("pr merge")).toEqual([]);
  } finally {
    await q.stop();
    boundary.mockRestore();
  }
});

test.each([201, 422])("a reclaim during a pending rerun POST leaves no writes (%s)", async (status) => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  ci = () => null;
  const q = queue();
  const response = Promise.withResolvers<ReturnType<typeof respond>>();
  const entered = Promise.withResolvers<void>();
  try {
    const entry = await q.request({ target: pr.run.id });
    await waitFor(() => !!store.getLandEntry(entry.id)?.pushedSha);
    workflow(head, 1, "failure");
    github.responses.set(`repos/${SLUG}/actions/jobs/21/rerun`, () => {
      entered.resolve();
      return response.promise;
    });
    observe(1, head, "FAILURE", ["network"]);
    await entered.promise;
    const reclaimed = store.claimLandEntry(SLUG, 30_000, "new-owner", clock.now() + 31_000);
    if (!reclaimed) throw new Error("reclaim failed");
    const before = claimSnapshot(reclaimed);
    const calls = github.rest().length;
    response.resolve(respond(status, {}));
    await waitWithoutClock(() => clock.pending === 1, 15_000);
    expect(claimSnapshot(reclaimed)).toEqual(before);
    expect(github.rest()).toHaveLength(calls);
    expect(ghCalls("pr merge")).toEqual([]);
  } finally {
    response.resolve(respond(status, {}));
    await q.stop();
  }
});

test("a heartbeat aborts after the replacement owner blocks the entry", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head, "SUCCESS");
  approve(1, head);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  const boundary = spyOn(repos, "mergePullRequest").mockImplementation(async (...args) => {
    signal = args[3];
    entered.resolve();
    await release.promise;
    signal?.throwIfAborted();
    return "merged";
  });
  const q = queue();
  try {
    const entry = await q.request({ target: pr.run.id });
    await entered.promise;
    expect(store.claimLandEntry(SLUG, 30_000, "new-owner", clock.now() + 31_000)?.id).toBe(entry.id);
    store.updateLandEntry(entry.id, { state: "blocked", reason: "replacement blocked" });
    const before = claimSnapshot(entry);
    await clock.advance(10_000);
    expect(signal?.aborted).toBe(true);
    expect(claimSnapshot(entry)).toEqual(before);
    release.resolve();
    await waitWithoutClock(() => clock.pending === 1, 15_000);
  } finally {
    release.resolve();
    await q.stop();
    boundary.mockRestore();
  }
});

test("replacement checkout survives the stale worker's cleanup", async () => {
  const pr = delivered(1, "pr-1");
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  observe(1, head, "SUCCESS");
  approve(1, head);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const publication = repos.checkPrivatePublication;
  let firstPath = "";
  let first = true;
  const boundary = spyOn(repos, "checkPrivatePublication").mockImplementation(async (...args) => {
    const result = await publication(...args);
    if (first) {
      first = false;
      firstPath = args[0];
      entered.resolve();
      await release.promise;
    }
    return result;
  });
  const q = queue();
  let replacement: LandQueue | undefined;
  let replacementWork: Promise<void> | undefined;
  try {
    const entry = await q.request({ target: pr.run.id });
    await entered.promise;
    rmSync(gateReleasePath());
    // A second daemon has its own in-memory drain map. Invoke its claimed worker directly here.
    replacement = queue({ start: false });
    const worker = replacement as unknown as {
      owner: string;
      process: (entry: LandEntry) => Promise<void>;
    };
    const claimed = store.claimLandEntry(SLUG, 30_000, worker.owner, clock.now() + 31_000);
    if (!claimed) throw new Error("replacement did not claim");
    replacementWork = worker.process(claimed);
    const path = join(paths.work, `land-${entry.id}-${claimed.attempts}`);
    await waitWithoutClock(() => existsSync(`${path}.git-paths`) && existsSync(`${path}-base`), 15_000);
    expect(path).not.toBe(firstPath);
    release.resolve();
    const stale = q as unknown as { workers: Map<string, Promise<void>> };
    await Promise.all(stale.workers.values());
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.git-paths`)).toBe(true);
    writeFileSync(gateReleasePath(), "");
    await replacementWork;
    expect(store.getLandEntry(entry.id)?.state).toBe("landed");
    expect(readdirSync(paths.work)).toEqual([]);
  } finally {
    release.resolve();
    writeFileSync(gateReleasePath(), "");
    await q.stop();
    await replacement?.stop();
    await replacementWork;
    boundary.mockRestore();
  }
});

/** A hand-made PR, never registered with a run or the GitHub poller. */
function unowned(view: Record<string, unknown> = {}) {
  store.upsertRepo({
    slug: SLUG,
    kind: "github",
    url: bare,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  writeFileSync(
    join(root, "gh.view-1"),
    JSON.stringify({
      baseRefName: "main",
      title: "Hand-made change",
      statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
      ...view,
    }),
  );
}

test("an unowned PR lands the confined base merge at exactly the pushed head", async () => {
  unowned();
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  await advanceBase(true);
  const push = spyOn(repos, "pushExistingBranch");
  const publication = spyOn(repos, "checkPrivatePublication");
  try {
    const entry = await queue().request({ target: url(1), sha: head });
    expect(entry).toMatchObject({ state: "queued", runId: null, title: "Hand-made change" });
    await settle();
    const pushed = await remoteHead("pr-1");
    expect(pushed).not.toBe(head);
    expect(store.getLandEntry(entry.id)).toMatchObject({ state: "landed", runId: null, pushedSha: pushed });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]?.[3]).toBe(head); // lease on the approved head
    expect(gateLog()).toEqual(["moved"]);
    expect(landConfinement.calls.length).toBeGreaterThan(0);
    expect(store.getLandEntry(entry.id)?.logPath).toBe(join(paths.home, "land", `land-${entry.id}.log`));
    const merges = ghCalls("pr merge");
    expect(merges).toHaveLength(1);
    expect(merges[0]).toContain(`--match-head-commit ${pushed}`);
    expect(merges[0]).toContain("--subject Hand-made change (#1)");
    expect(publication.mock.calls.map(([, , input]) => input?.squash?.title)).toEqual([
      "Hand-made change (#1)",
    ]);
    expect(merges[0]).not.toContain("--auto");
    expect(readFileSync(join(root, "gh.body-1"), "utf8")).toBe("");
    expect(store.readFeed({ limit: 100 }).items.filter((i) => i.kind.startsWith("land."))).toEqual([
      expect.objectContaining({ kind: "land.queued", runId: null, repo: SLUG }),
      expect.objectContaining({ kind: "land.landed", runId: null, repo: SLUG }),
    ]);
    expect(store.listRuns()).toEqual([]);
  } finally {
    push.mockRestore();
    publication.mockRestore();
  }
});

test("a push after approval blocks an unowned PR", async () => {
  unowned();
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  const q = queue({ start: false });
  await q.stop();
  const entry = await q.request({ target: url(1), sha: head });
  await pushBranch("pr-1", "one.txt", "two\n");
  q.start();
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({
    state: "blocked",
    reason: "head moved after approval",
  });
  expect(ghCalls("pr merge")).toEqual([]);
  expect(store.readFeed({ limit: 100 }).items.find((i) => i.kind === "land.blocked")).toMatchObject({
    runId: null,
    repo: SLUG,
  });
});

test.each([
  { view: { state: "CLOSED" }, reason: "pull request is CLOSED" },
  { view: { state: "MERGED" }, reason: "pull request is MERGED" },
  { view: { isCrossRepository: true }, reason: "cross-repository" },
  { view: {}, sha: undefined, reason: "--sha" },
  { view: {}, sha: "b".repeat(40), reason: "sha is not the pull request's current head" },
  { view: {}, sha: "short", reason: "sha must be a full commit id" },
  { view: { title: " " }, reason: "missing merge subject" },
  { view: { baseRefName: "pr-1" }, reason: "no valid base distinct from the head" },
  { view: { baseRefName: "bad..branch" }, reason: "no valid base distinct from the head" },
  { view: { headRefName: "bad..branch" }, reason: "invalid PR head branch" },
])("refuses an unowned PR: $reason", async (scenario) => {
  unowned(scenario.view);
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  const sha = "sha" in scenario ? scenario.sha : head;
  await expect(queue().request({ target: url(1), sha })).rejects.toThrow(scenario.reason);
  expect(store.listLandEntries()).toEqual([]);
  expect(store.readFeed({ limit: 100 }).items).toEqual([]);
});

test.each(["absent", "local"])("refuses an unconfigured GitHub repository (%s)", async (kind) => {
  if (kind === "local")
    store.upsertRepo({
      slug: "other/repo",
      kind: "local",
      url: null,
      localPath: seed,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
  await expect(
    queue().request({ target: "https://github.com/other/repo/pull/5", sha: "a".repeat(40) }),
  ).rejects.toThrow("repository other/repo is not a configured GitHub repository");
  expect(store.listLandEntries()).toEqual([]);
  expect(store.readFeed({ limit: 100 }).items).toEqual([]);
  expect(ghCalls("pr view")).toEqual([]);
});

test.each(["checking", "waiting_ci"])("an unowned PR resumes after stopping during %s", async (state) => {
  unowned();
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  await advanceBase();
  if (state === "checking") rmSync(gateReleasePath());
  else unowned({ statusCheckRollup: [{ name: "build", status: "IN_PROGRESS" }] });
  const push = spyOn(repos, "pushExistingBranch");
  try {
    const first = queue();
    const entry = await first.request({ target: url(1), sha: head });
    await waitFor(() =>
      state === "checking" ? gateLog().length === 1 : store.getLandEntry(entry.id)?.state === state,
    );
    await first.stop();
    expect(store.getLandEntry(entry.id)?.state).toBe(state);
    const pushed = store.getLandEntry(entry.id)?.pushedSha;
    const pushes = push.mock.calls.length;
    writeFileSync(gateReleasePath(), "");
    unowned();
    // Reopen the database too: title and progress must survive without an in-memory run.
    store.close();
    store = new Store(paths.db);
    queue();
    await settle();
    expect(store.getLandEntry(entry.id)).toMatchObject({ state: "landed", runId: null, attempts: 2 });
    expect(gateLog()).toEqual(state === "checking" ? ["start", "start", "end"] : ["start", "end"]);
    expect(push).toHaveBeenCalledTimes(1);
    if (state === "waiting_ci") {
      expect(push.mock.calls.length).toBe(pushes);
      expect(store.getLandEntry(entry.id)?.pushedSha).toBe(pushed);
    }
    expect(ghCalls("pr merge")).toHaveLength(1);
    expect(ghCalls("pr merge")[0]).toContain("--subject Hand-made change (#1)");
  } finally {
    push.mockRestore();
  }
});

test("a conflict on an unowned PR blocks without pushing or starting a round", async () => {
  unowned();
  const head = await pushBranch("pr-1", "shared.txt", "from the PR\n");
  await pushBranch("main", "shared.txt", "from the base\n", 0);
  const entry = await queue().request({ target: url(1), sha: head });
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "blocked", reason: "conflicts with main" });
  expect(await remoteHead("pr-1")).toBe(head);
  expect(ghCalls("pr merge")).toEqual([]);
  await processConflictTriggers(store, clock.now);
  expect(store.listRuns()).toEqual([]);
  expect(store.pendingConflictTriggers()).toEqual([]);
});

test("an unowned PR already merged before restart is recorded without another merge", async () => {
  unowned();
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  const q = queue();
  unowned({ statusCheckRollup: [{ name: "build", status: "IN_PROGRESS" }] });
  const entry = await q.request({ target: url(1), sha: head });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
  await q.stop();
  store.updateLandEntry(entry.id, { state: "merging" });
  writeFileSync(join(root, "gh.merged-1"), "");
  queue();
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "landed", runId: null });
  expect(gateLog()).toEqual(["start", "end"]);
  expect(ghCalls("pr merge")).toEqual([]);
});

test.each(["push", "merge"])("an unowned PR's private subject blocks before %s", async (boundary) => {
  const privateText = "synthetic-private-land-subject";
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(join(paths.configDir, "private-strings.txt"), privateText);
  unowned({ title: privateText });
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  if (boundary === "push") await advanceBase();
  const push = spyOn(repos, "pushExistingBranch");
  try {
    const entry = await queue().request({ target: url(1), sha: head });
    await settle();
    expect(store.getLandEntry(entry.id)?.state).toBe("blocked");
    expect(push).not.toHaveBeenCalled();
    expect(ghCalls("pr merge")).toEqual([]);
    expect(await remoteHead("pr-1")).toBe(head);
  } finally {
    push.mockRestore();
  }
});

test("red CI on an unowned PR blocks without a CI fix round", async () => {
  unowned({ statusCheckRollup: [{ name: "network", status: "COMPLETED", conclusion: "FAILURE" }] });
  const head = await pushBranch("pr-1", "one.txt", "one\n");
  workflow(head, 1, "failure");
  const entry = await queue({ ciReruns: false }).request({ target: url(1), sha: head });
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({ state: "blocked", reason: "CI failed: network" });
  expect(store.pendingCiFixTriggers()).toEqual([]);
  expect(store.listRuns()).toEqual([]);
  expect(ghCalls("pr merge")).toEqual([]);
});

test("a discreet stored PR lands with a neutral base merge subject", async () => {
  const name = "change/feature";
  const pr = delivered(1, name);
  const head = await pushBranch(name, "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  await advanceBase();
  const base = await remoteHead("main");
  const cfg = loadConfig({
    home: paths.home,
    configDir: paths.configDir,
    raw: { repos: { [SLUG]: { discreet: true } } },
  });
  store.setRunState(pr.run.id, {});
  const q = queue({ cfg });
  const entry = await q.request({ target: pr.run.id });
  await settle();
  expect(store.runForPr(url(1))?.id).toBe(pr.run.id);
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  expect((await sh(["git", "log", "-1", "--format=%B", name], { cwd: bare })).stdout.trim()).toBe(
    `Merge base ${base}`,
  );
  const identities = (await sh(["git", "log", "--format=%an %ae %cn %ce", `main..${name}`], { cwd: bare }))
    .stdout;
  expect(identities).not.toMatch(/Limitless|limitless@localhost/);
});

test.each([true, false])("squash body uses current repository settings (discreet: %s)", async (discreet) => {
  const pr = delivered(1, "change/feature", "dependabot[bot]");
  store.db.query("UPDATE runs SET prompt = ? WHERE id = ?").run("Work\nCloses #7\nCloses #8", pr.run.id);
  const head = await pushBranch("change/feature", "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  const report = `## Checks\nHistorical checks\n\nRun \`${pr.run.id}\` · http://example.com/runs/${pr.run.id}\n🤖 Generated by Limitless`;
  store.putArtifact(pr.run.id, "report.md", "report", report);
  store.setRunState(pr.run.id, {
    implementerReport:
      "Public summary\nBuilt by Limitless\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nCo-Authored-By: Claude Fable 5.1\nRetained evidence",
    spec: {
      summary: "Fix input",
      requirements: [],
      assumptions: [],
      acceptance_criteria: [{ id: "AC-1", criterion: "Input accepted", how_to_verify: "inspect" }],
      out_of_scope: [],
      blocking_questions: [],
    },
    lastVerify: {
      modelId: "claude-opus-5-5",
      overall: "pass",
      notes: "",
      criteria: [{ id: "AC-1", status: "met", evidence: "Observed input", publicSummary: "" }],
    },
  });
  const cfg = loadConfig({
    home: paths.home,
    configDir: paths.configDir,
    raw: { repos: { [SLUG]: { discreet } } },
  });
  const q = queue({
    cfg,
    client: async (url, signal) => {
      // CI is inspected after publication checks; the eventual merge must use the checked body.
      if (discreet) store.setRunState(pr.run.id, { implementerReport: "Changed after publication check" });
      return getGitHubPr(url, signal);
    },
  });
  const entry = await q.request({ target: pr.run.id });
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  const body = readFileSync(join(root, "gh.body-1"), "utf8");
  if (discreet) {
    expect(body).toContain("## Checks");
    expect(body).toContain("Public summary");
    expect(body).toContain("\n\nCloses #7\n\nCloses #8");
    expect(body).toContain("Retained evidence");
    expect(body).toContain("| ✅ AC-1 | Input accepted | Observed input |");
    expect(body).toContain("Verifier: `claude-opus-5-5` (separate session from the implementer).");
    expect(body).not.toMatch(/Claude Code|Claude Fable|Co-Authored-By/);
    expect(body).toContain("Routing: free-first (Dependabot)");
    expect(body).not.toContain("Changed after publication check");
    expect(body).not.toMatch(/limitless|\/runs\//i);
    expect(body).not.toContain(pr.run.id);
  } else expect(body).toBe(report);
});

test.each([false, true])(
  "discreet landing renders a needs-human owner's squash body (verified work: %s)",
  async (verified) => {
    const pr = delivered(1, "change/feature");
    const head = await pushBranch("change/feature", "one.txt", "one\n");
    observe(1, head);
    approve(1, head);
    store.updateRun(pr.run.id, { status: "needs_human", error: "Checks failed" });
    store.setRunState(pr.run.id, {
      implementerReport: "Work needs attention",
      ...(verified ? { lastVerifiedSha: head, lastVerifiedEvidence: {} } : {}),
    });
    const cfg = loadConfig({
      home: paths.home,
      configDir: paths.configDir,
      raw: { repos: { [SLUG]: { discreet: true } } },
    });
    const entry = await queue({ cfg }).request({ target: pr.run.id });
    await settle();
    expect(store.getLandEntry(entry.id)?.state).toBe("landed");
    const body = readFileSync(join(root, "gh.body-1"), "utf8");
    expect(body).toContain("Needs a human");
    expect(body).toContain("Work needs attention");
    if (verified) expect(body).toContain(`Verified at \`${head}\`; failed after verification`);
    else expect(body).not.toContain("Failed after verification");
    expect(body).not.toMatch(/limitless|\/runs\//i);
    expect(body).not.toContain(pr.run.id);
  },
);

test("discreet landing blocks when the saved state cannot render a current squash body", async () => {
  const pr = delivered(1, "change/feature");
  const head = await pushBranch("change/feature", "one.txt", "one\n");
  observe(1, head);
  approve(1, head);
  const cfg = loadConfig({
    home: paths.home,
    configDir: paths.configDir,
    raw: { repos: { [SLUG]: { discreet: true } } },
  });
  const q = queue({ cfg });
  const entry = await q.request({ target: pr.run.id });
  await settle();
  expect(store.getLandEntry(entry.id)).toMatchObject({
    state: "blocked",
    reason: expect.stringMatching(/Discreet mode.*missing run state/),
  });
  expect(ghCalls("pr merge")).toEqual([]);
});

test.each(["Built by Limitless", "See http://example.com/runs/other-run"])(
  "discreet squash titles use the shared publication detector: %s",
  async (title) => {
    const pr = delivered(1, "change/feature");
    const head = await pushBranch("change/feature", "one.txt", "one\n");
    observe(1, head);
    approve(1, head);
    store.updateRun(pr.run.id, { title });
    store.setRunState(pr.run.id, { implementerReport: "Public summary" });
    const cfg = loadConfig({
      home: paths.home,
      configDir: paths.configDir,
      raw: { repos: { [SLUG]: { discreet: true } } },
    });
    cfg.uiUrl = "http://example.com";
    const entry = await queue({ cfg }).request({ target: pr.run.id });
    await settle();
    expect(store.getLandEntry(entry.id)).toMatchObject({
      state: "blocked",
      reason: "Discreet mode blocked factory marks in squash title",
    });
    expect(ghCalls("pr merge")).toEqual([]);
  },
);
function approvalPolicy(): ReadonlySet<string> {
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(join(paths.configDir, "config.toml"), '[repos."TEST/Repo"]\nland_requires_approval = true\n');
  return loadConfig({ ...paths, readOnly: true }).landRequiresApproval;
}

function reviewObservation(head: string, state = "APPROVED", login = "other", commit = head, n = 1) {
  const node = github.nodes.get(`PR_${SLUG}_${n}`);
  if (!node) throw new Error("missing test PR");
  node.headRefOid = head;
  node.latestOpinionatedReviews.nodes = [
    {
      state,
      author: { login, __typename: "User" },
      authorCanPushToRepository: true,
      commit: { oid: commit },
    },
  ];
  const snapshot = normalizePr(node);
  store.saveGithubPr({
    url: url(n),
    repo: SLUG,
    runId: runs.get(n)?.id ?? null,
    delivered: 1,
    nodeId: node.id,
    data: JSON.stringify({
      ...snapshot,
      observedAt: clock.now(),
      requestSeq: store.nextGithubObservationSeq(),
    }),
  });
}

test.each([false, true])(
  "polling releases approval waiting before checks (external PR: %s)",
  async (external) => {
    // Repository policy cannot disable the operator's gate, even in the candidate config.
    const head = await pushBranch(
      "one",
      ".limitless.toml",
      '[repos."test/repo"]\nland_requires_approval = false\n',
    );
    let target = url(1);
    if (external) {
      store.upsertRepo({
        slug: SLUG,
        kind: "github",
        url: bare,
        localPath: null,
        defaultBranch: "main",
        mergePolicy: "pr",
      });
      github.add(SLUG, 1);
      writeFileSync(join(root, "gh.base-1"), "main");
    } else {
      target = delivered(1, "one").run.id;
      approve(1, head);
    }
    const node = github.nodes.get(`PR_${SLUG}_1`);
    if (!node) throw new Error("missing test PR");
    node.headRefOid = head;
    const commit = node.commits.nodes[0]?.commit;
    if (commit) commit.statusCheckRollup = { state: "SUCCESS", contexts: { nodes: [] } };
    github.responses.set("user", () => respond(200, { login: "factory" }));
    const stop = startGitHubPoller(store, {
      client: github.client,
      gh: runGh,
      requiresApproval: approvalPolicy(),
      ciReruns: false,
      clock: {
        now: clock.now,
        set: clock.timer.set as unknown as typeof setTimeout,
        clear: clock.timer.clear as unknown as typeof clearTimeout,
      },
    });
    try {
      const q = queue({ requiresApproval: approvalPolicy() });
      const entry = await q.request({ target, ...(external ? { sha: head } : {}) });
      await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
      expect(q.list()[0]).toMatchObject({
        state: "waiting_approval",
        reason: `Another GitHub account must approve ${head}`,
      });
      expect(gateLog()).toEqual([]);
      expect(ghCalls("pr merge")).toEqual([]);
      // Factory-side approval is present, but stale and self GitHub reviews must still wait.
      node.latestOpinionatedReviews.nodes = [
        {
          state: "APPROVED",
          author: { login: "other", __typename: "User" },
          authorCanPushToRepository: true,
          commit: { oid: "a".repeat(40) },
        },
        {
          state: "APPROVED",
          author: { login: "FaCtOrY", __typename: "User" },
          authorCanPushToRepository: true,
          commit: { oid: head },
        },
      ];
      for (let i = 0; i < 2; i++) {
        await clock.advance(15000);
        await settleIdle();
      }
      expect(store.getLandEntry(entry.id)?.state).toBe("waiting_approval");
      expect(gateLog()).toEqual([]);
      const waiting = store.readFeed({ limit: 100 }).items.filter((i) => i.kind === "land.waiting_approval");
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.data).toMatchObject({
        state: "waiting_approval",
        reason: `Another GitHub account must approve ${head}`,
      });
      node.latestOpinionatedReviews.nodes = [
        {
          state: "APPROVED",
          author: { login: "other", __typename: "User" },
          authorCanPushToRepository: true,
          commit: { oid: head },
        },
      ];
      await clock.advance(15000);
      await settle();
      expect(store.getLandEntry(entry.id)).toMatchObject({ state: "landed", pushedSha: head });
      expect(store.getLandEntry(entry.id)?.reason).not.toContain("must approve");
      expect(gateLog()).toEqual(["start", "end"]);
      expect(ghCalls("pr merge")[0]).toContain(`--match-head-commit ${head}`);
      expect(ghCalls("pr review")).toEqual([]);
      expect(github.calls.every((c) => !c.path.endsWith("/reviews"))).toBe(true);
    } finally {
      stop();
    }
  },
);

test.each([true, false])(
  "first-observation approval allows a base merge and restart (polling: %s)",
  async (polling) => {
    const head = await pushBranch("one", "one.txt", "one\n");
    const pr = delivered(1, "one");
    approve(1, head);
    reviewObservation(head);
    await advanceBase();
    github.responses.set("user", () => respond(200, { login: "factory" }));
    ci = () => null;
    const requiresApproval = approvalPolicy();
    const options = {
      requiresApproval,
      polling,
      client: async (url: string, signal?: AbortSignal) => {
        const view = await getGitHubPr(url, signal);
        return view ? { ...view, ci: ci()?.ci ?? "PENDING" } : null;
      },
    };
    const q = queue(options);
    const entry = await q.request({ target: pr.run.id });
    await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
    const pushed = store.getLandEntry(entry.id)?.pushedSha;
    expect(pushed).toBeString();
    expect(pushed).not.toBe(head);
    await q.stop();
    // The base merge does not need a new approval, including after restart.
    if (!pushed) throw new Error("missing pushed SHA");
    observe(1, pushed, "SUCCESS");
    queue(options);
    ci = () => ({ ci: "SUCCESS" });
    await settle();
    expect(store.getLandEntry(entry.id)?.state).toBe("landed");
    expect(ghCalls("pr merge")[0]).toContain(`--match-head-commit ${pushed}`);
  },
);

test.each([false, true])(
  "waiting approval survives restart and late identity cannot overwrite cancellation or ownership (steal: %s)",
  async (steal) => {
    const head = await pushBranch("one", "one.txt", "one\n");
    const pr = delivered(1, "one");
    approve(1, head);
    observe(1, head); // Legacy snapshot: login:state summaries alone are insufficient.
    const requiresApproval = approvalPolicy();
    github.responses.set("user", () => respond(503, { message: "identity unavailable" }));
    const q = queue({ requiresApproval });
    const entry = await q.request({ target: pr.run.id });
    await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
    await expect(q.request({ target: pr.run.id })).rejects.toThrow("already in the land queue");
    const next = store.createLandEntry({
      runId: null,
      repo: SLUG,
      prUrl: url(2),
      baseBranch: "main",
      headBranch: "two",
      approvedSha: head,
    });
    expect(store.claimLandEntry(SLUG, 30000, "other-worker", clock.now())?.id).toBe(next.id);
    store.releaseLandClaims("other-worker");
    await q.stop();
    store.close();
    store = new Store(paths.db);
    expect(store.getLandEntry(entry.id)?.state).toBe("waiting_approval");
    const identity = Promise.withResolvers<ReturnType<typeof respond>>();
    let requested = false;
    github.responses.set("user", () => {
      requested = true;
      return identity.promise;
    });
    // Keep the second entry out of this race; it was independently claimable while entry 1 waited.
    store.updateLandEntry(next.id, { state: "cancelled" });
    const resumed = queue({ requiresApproval });
    await waitFor(() => requested);
    expect(store.getLandEntry(next.id)?.state).toBe("cancelled");
    if (steal) {
      store.db
        .query(`INSERT INTO land_entries
        (run_id, repo, pr_url, base_branch, head_branch, approved_sha, state, created_at, updated_at)
        VALUES ('', ?, ?, 'main', 'one', ?, 'queued', 1, 1)`)
        .run(SLUG, url(1), head);
    } else expect(resumed.cancel(entry.id)).toBe(true);
    reviewObservation(head);
    identity.resolve(respond(200, { login: "factory" }));
    await settleIdle();
    await resumed.stop();
    expect(store.getLandEntry(entry.id)?.state).toBe(steal ? "blocked" : "cancelled");
    if (steal) expect(store.getLandEntry(entry.id)?.reason).toContain("superseded");
    expect(ghCalls("pr merge")).toEqual([]);
    expect(gateLog()).toEqual([]);
    expect(
      store.readFeed({ limit: 100 }).items.filter((i) => i.kind === "land.waiting_approval"),
    ).toHaveLength(1);
  },
);

test("unknown factory identity cannot release an otherwise qualifying approval", async () => {
  const head = await pushBranch("one", "one.txt", "one\n");
  const pr = delivered(1, "one");
  approve(1, head);
  reviewObservation(head);
  github.responses.set("user", () => respond(200, {}));
  const q = queue({ requiresApproval: approvalPolicy() });
  const entry = await q.request({ target: pr.run.id });
  await waitFor(() => github.calls.some((c) => c.path === "user"));
  expect(store.getLandEntry(entry.id)?.state).toBe("waiting_approval");
  expect(gateLog()).toEqual([]);
  github.responses.set("user", () => respond(200, { login: "factory" }));
  await clock.advance(1);
  reviewObservation(head);
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
});

test("removing operator policy releases a persisted approval wait", async () => {
  const head = await pushBranch("one", "one.txt", "one\n");
  const pr = delivered(1, "one");
  observe(1, head);
  approve(1, head);
  github.responses.set("user", () => respond(200, { login: "factory" }));
  const q = queue({ requiresApproval: approvalPolicy() });
  const entry = await q.request({ target: pr.run.id });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
  await q.stop();
  const before = github.calls.length;
  queue({ requiresApproval: new Set(["other/repo"]) });
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  expect(github.calls.slice(before).filter((c) => c.path === "user" || c.path === "graphql")).toEqual([]);
});

test("a dismissal during identity lookup cannot release an old approval observation", async () => {
  const head = await pushBranch("one", "one.txt", "one\n");
  const pr = delivered(1, "one");
  approve(1, head);
  reviewObservation(head);
  const identity = Promise.withResolvers<ReturnType<typeof respond>>();
  let requested = false;
  github.responses.set("user", () => {
    requested = true;
    return identity.promise;
  });
  const entry = await queue({ requiresApproval: approvalPolicy() }).request({ target: pr.run.id });
  await waitFor(() => requested);
  reviewObservation(head, "DISMISSED");
  identity.resolve(respond(200, { login: "factory" }));
  await settleIdle();
  expect(store.getLandEntry(entry.id)?.state).toBe("waiting_approval");
  expect(gateLog()).toEqual([]);
  expect(ghCalls("pr merge")).toEqual([]);
  await clock.advance(1);
  reviewObservation(head);
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
});

const approvalCiClient: LandPrClient = async (url, signal) => {
  const view = await getGitHubPr(url, signal);
  return view ? { ...view, ci: ci()?.ci ?? "PENDING" } : null;
};

test("parked PR leaves the worker free for approved PRs, then rejoins and lands", async () => {
  const head1 = await pushBranch("one", "one.txt", "one\n");
  const first = delivered(1, "one");
  observe(1, head1);
  approve(1, head1);
  const head2 = await pushBranch("two", "two.txt", "two\n", 2);
  const second = delivered(2, "two");
  approve(2, head2);
  reviewObservation(head2, "APPROVED", "other", head2, 2);
  github.responses.set("user", () => respond(200, { login: "factory" }));
  const q = queue({ requiresApproval: approvalPolicy() });
  const e1 = await q.request({ target: first.run.id });
  await waitFor(() => store.getLandEntry(e1.id)?.state === "waiting_approval");
  const e2 = await q.request({ target: second.run.id });
  await waitFor(() => store.getLandEntry(e2.id)?.state === "landed");
  expect(store.getLandEntry(e1.id)?.state).toBe("waiting_approval");
  await clock.advance(1);
  reviewObservation(head1);
  await settle();
  expect(store.getLandEntry(e1.id)?.state).toBe("landed");
  expect(ghCalls("pr merge").map((line) => line.includes(url(2)))).toEqual([true, false]);
});

test.each(["DISMISSED", "CHANGES_REQUESTED", "PAGINATED"])(
  "pre-merge %s parks pushed work and emits a new wait episode",
  async (state) => {
    const head = await pushBranch("one", "one.txt", "one\n");
    const pr = delivered(1, "one");
    observe(1, head);
    approve(1, head);
    await advanceBase();
    github.responses.set("user", () => respond(200, { login: "factory" }));
    ci = () => null;
    const q = queue({ requiresApproval: approvalPolicy(), polling: false, client: approvalCiClient });
    const entry = await q.request({ target: pr.run.id });
    await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
    reviewObservation(head);
    await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
    const pushed = store.getLandEntry(entry.id)?.pushedSha;
    if (!pushed) throw new Error("missing pushed head");
    expect(pushed).not.toBe(head);
    reviewObservation(pushed, state === "PAGINATED" ? "APPROVED" : state);
    const node = github.nodes.get(`PR_${SLUG}_1`);
    if (!node) throw new Error("missing test PR");
    node.latestOpinionatedReviews.pageInfo.hasNextPage = state === "PAGINATED";
    ci = () => ({ ci: "SUCCESS" });
    await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
    expect(store.getLandEntry(entry.id)?.pushedSha).toBe(pushed);
    expect(ghCalls("pr merge")).toEqual([]);
    expect(
      store.readFeed({ limit: 100 }).items.filter((i) => i.kind === "land.waiting_approval"),
    ).toHaveLength(2);
    if (state === "PAGINATED") expect(store.getLandEntry(entry.id)?.reason).toContain("pagination");
    node.latestOpinionatedReviews.pageInfo.hasNextPage = false;
    reviewObservation(pushed);
    await settle();
    expect(store.getLandEntry(entry.id)?.state).toBe("landed");
    expect(gateLog()).toEqual(["start", "end"]);
  },
);

test("enabling policy for an in-flight pushed entry requires approval before merging", async () => {
  const head = await pushBranch("one", "one.txt", "one\n");
  const pr = delivered(1, "one");
  observe(1, head);
  approve(1, head);
  ci = () => null;
  const original = queue({ polling: false, client: approvalCiClient });
  const entry = await original.request({ target: pr.run.id });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_ci");
  expect(github.calls.filter((c) => c.path === "user")).toEqual([]);
  await original.stop();
  github.responses.set("user", () => respond(200, { login: "factory" }));
  ci = () => ({ ci: "SUCCESS" });
  queue({ requiresApproval: approvalPolicy(), polling: false, client: approvalCiClient });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
  expect(github.calls.some((c) => c.path === "user")).toBe(true);
  expect(ghCalls("pr merge")).toEqual([]);
  reviewObservation(head);
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
});

test.each([
  [true, 200],
  [true, 502],
  [true, 429],
  [false, 200],
] as const)(
  "failed review observation never releases saved approval (polling=%s HTTP=%s)",
  async (polling, status) => {
    const head = await pushBranch("one", "one.txt", "one\n");
    const pr = delivered(1, "one");
    observe(1, head);
    approve(1, head);
    reviewObservation(head);
    const saved = store.githubPrData(url(1));
    github.responses.set("user", () => respond(200, { login: "factory" }));
    github.deny.set(SLUG, () =>
      respond(status, { errors: [{ message: status === 429 ? "rate limit" : "unavailable" }] }),
    );
    const q = queue({ requiresApproval: approvalPolicy(), polling });
    const entry = await q.request({ target: pr.run.id });
    await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
    const stop = polling
      ? startGitHubPoller(store, {
          client: github.client,
          gh: runGh,
          ciReruns: false,
          clock: {
            now: clock.now,
            set: clock.timer.set as unknown as typeof setTimeout,
            clear: clock.timer.clear as unknown as typeof clearTimeout,
          },
        })
      : () => {};
    try {
      for (let i = 0; i < 3; i++) {
        await clock.advance(15000);
        await settleIdle();
      }
      expect(store.githubPrData(url(1))).toBe(saved);
      expect(store.getLandEntry(entry.id)?.state).toBe("waiting_approval");
      expect(gateLog()).toEqual([]);
      expect(ghCalls("pr merge")).toEqual([]);
      expect(q.cancel(entry.id)).toBe(true);
      expect(store.getLandEntry(entry.id)).toMatchObject({ state: "cancelled", approvalWaitStartedAt: 0 });
    } finally {
      stop();
    }
  },
);

test.each(["CLOSED", "DRAFT", "MOVED", "MERGED"])(
  "waiting PR becoming %s leaves waiting through the ordinary terminal path",
  async (state) => {
    const head = await pushBranch("one", "one.txt", "one\n");
    const pr = delivered(1, "one");
    observe(1, head);
    approve(1, head);
    github.responses.set("user", () => respond(200, { login: "factory" }));
    const entry = await queue({ requiresApproval: approvalPolicy(), polling: false }).request({
      target: pr.run.id,
    });
    await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
    const node = github.nodes.get(`PR_${SLUG}_1`);
    if (!node) throw new Error("missing test PR");
    if (state === "DRAFT") Object.assign(node, { isDraft: true });
    else if (state === "MOVED") node.headRefOid = "b".repeat(40);
    else node.state = state;
    await waitFor(() => store.getLandEntry(entry.id)?.state !== "waiting_approval");
    if (state === "MERGED") await settle();
    expect(store.getLandEntry(entry.id)).toMatchObject({
      state: state === "MERGED" ? "landed" : "blocked",
      approvalWaitStartedAt: 0,
    });
    if (state !== "MERGED")
      expect(store.getLandEntry(entry.id)?.reason).toBe(
        state === "CLOSED"
          ? "PR was closed without merging"
          : state === "DRAFT"
            ? "PR is a draft"
            : "head moved after approval",
      );
    expect(ghCalls("pr merge")).toEqual([]);
    expect(gateLog()).toEqual([]);
  },
);

test("startup supersedes an older wait requeued by the previous release", async () => {
  const head = await pushBranch("one", "one.txt", "one\n");
  const pr = delivered(1, "one");
  observe(1, head);
  approve(1, head);
  const input = {
    runId: pr.run.id,
    repo: SLUG,
    prUrl: url(1),
    baseBranch: "main",
    headBranch: "one",
    approvedSha: head,
  };
  const old = store.createLandEntry(input);
  store.updateLandEntry(old.id, { state: "waiting_approval", approvalWaitStartedAt: clock.now() - 1 });
  store.db
    .query(`INSERT INTO land_entries
    (run_id, repo, pr_url, base_branch, head_branch, approved_sha, state, created_at, updated_at)
    VALUES (?, ?, ?, 'main', 'one', ?, 'queued', 1, 1)`)
    .run(pr.run.id, SLUG, url(1), head);
  github.responses.set("user", () => respond(200, { login: "factory" }));
  reviewObservation(head);
  queue({ requiresApproval: approvalPolicy() });
  expect(store.getLandEntry(old.id)).toMatchObject({
    state: "blocked",
    approvalWaitStartedAt: 0,
    reason: "superseded by a newer land entry",
  });
  await settle();
  expect(store.getLandEntry(old.id)?.state).toBe("blocked");
  expect(ghCalls("pr merge")).toHaveLength(1);
});

test.each([false, true])("502 merge retry rechecks approval (dismissed: %s)", async (dismissed) => {
  const head = await pushBranch("one", "one.txt", "one\n");
  const pr = delivered(1, "one");
  approve(1, head);
  reviewObservation(head);
  github.responses.set("user", () => respond(200, { login: "factory" }));
  writeFileSync(join(root, "gh.reject-once"), "");
  const execute = proc.sh;
  const evidenceCounts: number[] = [];
  const transport = spyOn(proc, "sh").mockImplementation(async (cmd, opts) => {
    const merging =
      cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "merge" && !cmd.includes("--disable-auto");
    if (merging) evidenceCounts.push(github.graphql().length);
    try {
      return await execute(cmd, opts);
    } catch (error) {
      if (merging && dismissed) reviewObservation(head, "DISMISSED");
      throw error;
    }
  });
  const delay = repos.githubRetry.baseDelayMs;
  repos.githubRetry.baseDelayMs = 1;
  try {
    const entry = await queue({ requiresApproval: approvalPolicy() }).request({ target: pr.run.id });
    if (dismissed) await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
    else await settle();
    expect(store.getLandEntry(entry.id)?.state).toBe(dismissed ? "waiting_approval" : "landed");
    expect(ghCalls("pr merge")).toHaveLength(dismissed ? 1 : 2);
    expect(github.graphql().length).toBeGreaterThanOrEqual(3); // Claim, first attempt, retry.
    expect(evidenceCounts[0]).toBeGreaterThanOrEqual(2);
    if (!dismissed) {
      expect(evidenceCounts[1]).toBeGreaterThan(evidenceCounts[0] ?? 0);
      expect(ghCalls("pr merge")[1]).toContain(`--match-head-commit ${head}`);
    }
  } finally {
    transport.mockRestore();
    repos.githubRetry.baseDelayMs = delay;
  }
});

test.each(["CHANGES_REQUESTED", "APPROVED"])(
  "an older-start poll overlapping the final approval forces a fresh read (%s)",
  async (state) => {
    const head = await pushBranch("one", "one.txt", "one\n");
    const pr = delivered(1, "one");
    approve(1, head);
    reviewObservation(head);
    github.responses.set("user", () => respond(200, { login: "factory" }));
    const pollEntered = Promise.withResolvers<void>();
    const releasePoll = Promise.withResolvers<void>();
    const pollSaved = Promise.withResolvers<void>();
    const save = store.saveGithubPr.bind(store);
    let pollSeq = 0;
    let firstDirectSeq = 0;
    const saving = spyOn(store, "saveGithubPr").mockImplementation((...args) => {
      const currentSeq = store.githubReview(url(1))?.requestSeq ?? 0;
      save(...args);
      const snapshot = JSON.parse(args[0]?.data ?? "null");
      if (snapshot?.requestSeq && snapshot.requestSeq < currentSeq) {
        firstDirectSeq = currentSeq;
        pollSeq = snapshot.requestSeq;
        pollSaved.resolve();
      }
    });
    const stop = approvalPoller(async (path, body, signal) => {
      if (path === "graphql") {
        pollEntered.resolve();
        await releasePoll.promise;
      }
      return github.client(path, body, signal);
    });
    let directReads = 0;
    const client: GitHubClient = async (path, body, signal) => {
      const response = await github.client(path, body, signal);
      if (path !== "graphql") return response;
      const captured = respond(response.status, structuredClone(response.body));
      if (++directReads === 2) {
        expect(store.listLandEntries()[0]?.state).toBe("merging");
        const review = github.nodes.get(`PR_${SLUG}_1`)?.latestOpinionatedReviews.nodes[0];
        if (!review) throw new Error("missing test review");
        review.state = state;
        releasePoll.resolve();
        await pollSaved.promise;
        stop();
      }
      return captured;
    };
    try {
      await clock.advance(0);
      await pollEntered.promise;
      const entry = await queue({
        requiresApproval: approvalPolicy(),
        github: client,
        gateExecutor: fakeLandGates((req) => retryRun(req)).executor,
      }).request({ target: pr.run.id });
      await waitFor(() => ["landed", "waiting_approval"].includes(store.getLandEntry(entry.id)?.state ?? ""));
      expect(pollSeq).toBeLessThan(firstDirectSeq);
      expect(store.getLandEntry(entry.id)?.state).toBe(state === "APPROVED" ? "landed" : "waiting_approval");
      expect(ghCalls("pr merge")).toHaveLength(state === "APPROVED" ? 1 : 0);
      expect(directReads).toBe(3); // Claim, held final approval, then a non-overlapping read.
    } finally {
      releasePoll.resolve();
      stop();
      saving.mockRestore();
    }
  },
);

test("overlap on every final approval read parks after three reads without merging", async () => {
  const head = await pushBranch("one", "one.txt", "one\n");
  const pr = delivered(1, "one");
  approve(1, head);
  reviewObservation(head);
  github.responses.set("user", () => respond(200, { login: "factory" }));
  let finalReads = 0;
  const client: GitHubClient = async (path, body, signal) => {
    const response = await github.client(path, body, signal);
    if (path === "graphql" && store.listLandEntries()[0]?.state === "merging") {
      finalReads++;
      reviewObservation(head);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
  };
  const entry = await queue({
    requiresApproval: approvalPolicy(),
    github: client,
    gateExecutor: fakeLandGates((req) => retryRun(req)).executor,
  }).request({ target: pr.run.id });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval" || finalReads > 3);
  expect(store.getLandEntry(entry.id)).toMatchObject({
    state: "waiting_approval",
    reason: "Review state changed during the final approval check",
  });
  expect(finalReads).toBe(3);
  expect(ghCalls("pr merge")).toEqual([]);
});

test("a newer polled change request overtakes a delayed final direct approval", async () => {
  const head = await pushBranch("one", "one.txt", "one\n");
  const pr = delivered(1, "one");
  approve(1, head);
  reviewObservation(head);
  github.responses.set("user", () => respond(200, { login: "factory" }));
  const started = Promise.withResolvers<void>();
  const held = Promise.withResolvers<ReturnType<typeof respond>>();
  let oldResponse: ReturnType<typeof respond> | undefined;
  const client: GitHubClient = async (path, body, signal) => {
    const response = await github.client(path, body, signal);
    if (path === "graphql" && store.listLandEntries()[0]?.state === "merging" && !oldResponse) {
      oldResponse = respond(response.status, structuredClone(response.body));
      started.resolve();
      return held.promise;
    }
    return response;
  };
  const entry = await queue({ requiresApproval: approvalPolicy(), github: client }).request({
    target: pr.run.id,
  });
  await waitFor(() => !!oldResponse);
  await started.promise;
  reviewObservation(head, "CHANGES_REQUESTED");
  const newer = store.githubReview(url(1));
  const pollData = store.githubPrData(url(1));
  if (!oldResponse) throw new Error("missing held approval");
  held.resolve(oldResponse);
  await waitWithoutClock(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
  expect(store.githubReview(url(1))?.requestSeq).toBeGreaterThan(newer?.requestSeq ?? 0);
  expect(store.githubPrData(url(1))).toBe(pollData);
  expect(store.githubReview(url(1))?.reviewEvidence?.[0]?.state).toBe("CHANGES_REQUESTED");
  expect(ghCalls("pr merge")).toEqual([]);
  reviewObservation(head);
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  expect(ghCalls("pr merge")[0]).toContain(`--match-head-commit ${head}`);
});

test.each(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"])(
  "paginated opinionated reviews remain incomplete even if a review becomes %s between pages",
  async (state) => {
    const head = await pushBranch("one", "one.txt", "one\n");
    const pr = delivered(1, "one");
    approve(1, head);
    observe(1, head);
    github.responses.set("user", () => respond(200, { login: "factory" }));
    let dismissed = false;
    const client: GitHubClient = async (path, body, signal) => {
      const result = await github.client(path, body, signal);
      const response = respond(result.status, structuredClone(result.body));
      const node = github.nodes.get(`PR_${SLUG}_1`);
      if (path === "graphql" && node && node.latestOpinionatedReviews.nodes.length > 20) {
        const approval = node.latestOpinionatedReviews.nodes[0];
        if (approval && state === "DISMISSED") {
          approval.state = "DISMISSED";
          dismissed = true;
        }
      }
      return response;
    };
    const entry = await queue({ requiresApproval: approvalPolicy(), github: client }).request({
      target: pr.run.id,
    });
    await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
    const node = github.nodes.get(`PR_${SLUG}_1`);
    if (!node) throw new Error("missing test PR");
    node.latestOpinionatedReviews.nodes = Array.from({ length: 25 }, (_, i) => ({
      state: i === 0 ? "APPROVED" : state === "CHANGES_REQUESTED" && i === 24 ? state : "COMMENTED",
      author: { login: `reviewer-${i}`, __typename: "User" },
      authorCanPushToRepository: true,
      commit: { oid: head },
    }));
    // A truncated conditional poll triggers a direct read, which must stop at page one.
    const response = await github.client("graphql", { query: "observation", variables: { ids: [node.id] } });
    const raw = (response.body as { data: { nodes: unknown[] } }).data.nodes[0];
    const snapshot = normalizePr(raw);
    expect(snapshot?.reviewEvidenceComplete).toBe(false);
    store.saveGithubPr({
      url: url(1),
      repo: SLUG,
      runId: pr.run.id,
      delivered: 1,
      nodeId: node.id,
      data: JSON.stringify({ ...snapshot, requestSeq: store.nextGithubObservationSeq() }),
    });
    await waitFor(() => store.getLandEntry(entry.id)?.reason?.includes("pagination") === true);
    await settleIdle();
    expect(store.getLandEntry(entry.id)?.state).toBe("waiting_approval");
    expect(store.getLandEntry(entry.id)?.reason).toContain("incomplete");
    expect(github.graphql().some((c) => c.after === "20")).toBe(false);
    expect(dismissed).toBe(state === "DISMISSED");
    expect(ghCalls("pr merge")).toEqual([]);
    expect(gateLog()).toEqual([]);
    expect(store.readFeed().items.findLast((i) => i.kind === "land.waiting_approval")?.data.reason).toContain(
      "pagination",
    );
  },
);

test("a COMMENTED latest review cannot clear a push reviewer's change request across polls", async () => {
  const head = await pushBranch("one", "one.txt", "one\n");
  const pr = delivered(1, "one");
  approve(1, head);
  reviewObservation(head, "CHANGES_REQUESTED", "reviewer-b");
  const node = github.nodes.get(`PR_${SLUG}_1`);
  if (!node) throw new Error("missing test PR");
  node.latestReviews.nodes = [{ state: "COMMENTED", author: { login: "reviewer-b" } }];
  node.latestOpinionatedReviews.nodes.push({
    state: "APPROVED",
    author: { login: "reviewer-a", __typename: "User" },
    authorCanPushToRepository: true,
    commit: { oid: head },
  });
  const approval = node.latestOpinionatedReviews.nodes[1];
  if (approval) node.latestReviews.nodes.push(approval);
  github.responses.set("user", () => respond(200, { login: "factory" }));
  const entry = await queue({ requiresApproval: approvalPolicy(), polling: false }).request({
    target: pr.run.id,
  });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
  const calls = github.graphql().length;
  await waitFor(() => github.graphql().length >= calls + 2);
  expect(store.getLandEntry(entry.id)?.state).toBe("waiting_approval");
  expect(ghCalls("pr merge")).toEqual([]);
});

function approvalPoller(client: GitHubClient = github.client) {
  return startGitHubPoller(store, {
    client,
    gh: runGh,
    requiresApproval: approvalPolicy(),
    ciReruns: false,
    clock: {
      now: clock.now,
      set: clock.timer.set as unknown as typeof setTimeout,
      clear: clock.timer.clear as unknown as typeof clearTimeout,
    },
  });
}

test.each(["in-flight", "backward clock", "legacy"])(
  "only a poll requested after the wait releases approval (%s)",
  async (scenario) => {
    const head = await pushBranch("one", "one.txt", "one\n");
    const pr = delivered(1, "one");
    approve(1, head);
    reviewObservation(head);
    const node = github.nodes.get(`PR_${SLUG}_1`);
    if (!node) throw new Error("missing test PR");
    const approval = [...node.latestOpinionatedReviews.nodes];
    node.latestOpinionatedReviews.nodes = [];
    const commit = node.commits.nodes[0]?.commit;
    if (commit) commit.statusCheckRollup = { state: "SUCCESS", contexts: { nodes: [] } };
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<ReturnType<typeof respond>>();
    let held = false;
    const client: GitHubClient = async (path, body, signal) => {
      if (path === "graphql" && scenario === "in-flight" && !held) {
        held = true;
        started.resolve();
        return response.promise;
      }
      return github.client(path, body, signal);
    };
    let stop = () => {};
    if (scenario === "in-flight") {
      stop = approvalPoller(client);
      await clock.advance(0);
      await started.promise;
    } else if (scenario === "backward clock") await clock.advance(-60000);
    else {
      const data = JSON.parse(store.githubPrData(url(1)) ?? "null");
      delete data.requestSeq;
      data.observedAt = clock.now() + 60000;
      store.saveGithubPr({
        url: url(1),
        repo: SLUG,
        runId: pr.run.id,
        delivered: 1,
        nodeId: node.id,
        data: JSON.stringify(data),
      });
    }
    const identity = Promise.withResolvers<ReturnType<typeof respond>>();
    let identityCalls = 0;
    github.responses.set("user", () =>
      ++identityCalls === 2 ? identity.promise : respond(200, { login: "factory" }),
    );
    try {
      const entry = await queue({ requiresApproval: approvalPolicy() }).request({ target: pr.run.id });
      await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
      const priorSeq = JSON.parse(store.githubPrData(url(1)) ?? "null")?.requestSeq;
      const marker = store.getLandEntry(entry.id)?.approvalWaitRequestSeq;
      if (!marker) throw new Error("missing wait request marker");
      if (scenario === "in-flight") {
        await clock.advance(1);
        response.resolve(
          respond(200, {
            data: {
              nodes: [
                { ...node, latestOpinionatedReviews: { ...node.latestOpinionatedReviews, nodes: approval } },
              ],
            },
          }),
        );
        await waitWithoutClock(
          () => JSON.parse(store.githubPrData(url(1)) ?? "null")?.requestSeq !== priorSeq,
        );
      }
      identity.resolve(respond(200, { login: "factory" }));
      await settleIdle();
      const saved = JSON.parse(store.githubPrData(url(1)) ?? "null");
      if (scenario !== "legacy") expect(saved.requestSeq).toBeLessThanOrEqual(marker);
      else expect(saved.requestSeq).toBeUndefined();
      expect(store.getLandEntry(entry.id)).toMatchObject({
        state: "waiting_approval",
        attempts: 1,
        approvalWaitRequestSeq: marker,
      });
      expect(ghCalls("pr merge")).toEqual([]);
      node.latestOpinionatedReviews.nodes = approval;
      if (scenario === "in-flight") await clock.advance(15000);
      else {
        stop = approvalPoller();
        await clock.advance(0);
      }
      await waitWithoutClock(() => JSON.parse(store.githubPrData(url(1)) ?? "null")?.requestSeq > marker);
      await settle();
      expect(store.getLandEntry(entry.id)?.state).toBe("landed");
    } finally {
      stop();
    }
  },
);

test("a review-path NOT_FOUND poll cannot release a parked entry", async () => {
  const head = await pushBranch("one", "one.txt", "one\n");
  const pr = delivered(1, "one");
  approve(1, head);
  reviewObservation(head, "DISMISSED");
  github.responses.set("user", () => respond(200, { login: "factory" }));
  const entry = await queue({ requiresApproval: approvalPolicy() }).request({ target: pr.run.id });
  await waitFor(() => store.getLandEntry(entry.id)?.state === "waiting_approval");
  const before = store.githubPrData(url(1));
  const node = github.nodes.get(`PR_${SLUG}_1`);
  if (!node) throw new Error("missing test PR");
  const approval = {
    state: "APPROVED",
    author: { login: "other", __typename: "User" },
    authorCanPushToRepository: true,
    commit: { oid: head },
  };
  let observed = false;
  const stop = approvalPoller(async (path, body, signal) => {
    if (path !== "graphql") return github.client(path, body, signal);
    observed = true;
    return respond(200, {
      data: {
        nodes: [
          {
            ...node,
            latestOpinionatedReviews: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [approval, null],
            },
          },
        ],
      },
      errors: [{ type: "NOT_FOUND", path: ["nodes", 0, "latestOpinionatedReviews", "nodes", 1] }],
    });
  });
  try {
    await clock.advance(0);
    await waitWithoutClock(() => observed);
    await settleIdle();
    expect(store.githubPrData(url(1))).toBe(before);
    expect(store.getLandEntry(entry.id)?.state).toBe("waiting_approval");
    expect(ghCalls("pr merge")).toEqual([]);
  } finally {
    stop();
  }
});

test.each(["HTTP", "errors", "id", "URL", "null review", "pageInfo", "cursor", "changed head"])(
  "failed or incomplete approval evidence grants no approval (%s)",
  async (failure) => {
    const head = await pushBranch("one", "one.txt", "one\n");
    const pr = delivered(1, "one");
    approve(1, head);
    const node = github.nodes.get(`PR_${SLUG}_1`);
    if (!node) throw new Error("missing test PR");
    node.headRefOid = head;
    node.latestOpinionatedReviews.nodes = Array.from({ length: 21 }, (_, i) => ({
      state: "APPROVED",
      author: { login: `reviewer-${i}`, __typename: "User" },
      authorCanPushToRepository: true,
      commit: { oid: head },
    }));
    github.responses.set("user", () => respond(200, { login: "factory" }));
    const client: GitHubClient = async (path, body, signal) => {
      const response = await github.client(path, body, signal);
      if (path !== "graphql") return response;
      const raw = structuredClone(node);
      const reviews = {
        ...raw.latestOpinionatedReviews,
        nodes: raw.latestOpinionatedReviews.nodes.slice(20),
      };
      if (failure === "id") raw.id = "wrong-id";
      if (failure === "URL") raw.url = url(2);
      if (failure === "changed head") raw.headRefOid = "b".repeat(40);
      return respond(failure === "HTTP" ? 502 : 200, {
        data: {
          nodes: [
            {
              ...raw,
              latestOpinionatedReviews: {
                ...reviews,
                nodes: failure === "null review" ? [...reviews.nodes, null] : reviews.nodes,
                pageInfo:
                  failure === "pageInfo"
                    ? undefined
                    : failure === "cursor"
                      ? { hasNextPage: true, endCursor: "20" }
                      : reviews.pageInfo,
              },
            },
          ],
        },
        ...(failure === "errors" ? { errors: [{ type: "NOT_FOUND" }] } : {}),
      });
    };
    const entry = await queue({ requiresApproval: approvalPolicy(), github: client }).request({
      target: pr.run.id,
    });
    await waitFor(
      () =>
        store.getLandEntry(entry.id)?.state === (failure === "changed head" ? "blocked" : "waiting_approval"),
    );
    if (failure === "changed head")
      expect(store.getLandEntry(entry.id)?.reason).toBe("head moved after approval");
    expect(github.graphql().some((call) => call.after === "20")).toBe(false);
    expect(ghCalls("pr merge")).toEqual([]);
    expect(gateLog()).toEqual([]);
  },
);

test("an old watcher cannot release a new wait with the same wall-clock marker", async () => {
  const head = await pushBranch("one", "one.txt", "one\n");
  const pr = delivered(1, "one");
  approve(1, head);
  observe(1, head);
  const identity = Promise.withResolvers<ReturnType<typeof respond>>();
  let lookups = 0;
  github.responses.set("user", () =>
    ++lookups === 2 ? identity.promise : respond(200, { login: "factory" }),
  );
  const requiresApproval = approvalPolicy();
  const q = queue({ requiresApproval });
  const entry = await q.request({ target: pr.run.id });
  await waitFor(() => lookups === 2);
  const waiting = store.getLandEntry(entry.id);
  reviewObservation(head);
  const renewed = store.transaction(() =>
    store.updateLandEntry(entry.id, {
      state: "waiting_approval",
      approvalWaitStartedAt: waiting?.approvalWaitStartedAt,
      approvalWaitRequestSeq: store.nextGithubObservationSeq(),
    }),
  );
  identity.resolve(respond(200, { login: "factory" }));
  await settleIdle();
  expect(store.getLandEntry(entry.id)).toMatchObject({
    state: "waiting_approval",
    attempts: 1,
    approvalWaitRequestSeq: renewed.approvalWaitRequestSeq,
  });
  expect(ghCalls("pr merge")).toEqual([]);
  await q.stop();
  queue({ requiresApproval });
  await settleIdle();
  expect(store.getLandEntry(entry.id)?.state).toBe("waiting_approval");
  reviewObservation(head);
  await settle();
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
});

test("App approvals use the cached bot login, count the owner and reject the factory", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = join(root, "app.pem");
  writeFileSync(key, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const requests: string[] = [];
  configureGitHubIdentity(
    { appId: 123, installationId: 456, privateKeyPath: key, repos: [SLUG] },
    {
      fetch: async (url) => {
        requests.push(url);
        if (url.endsWith("/app")) return Response.json({ slug: "factory" });
        if (url.endsWith("/access_tokens"))
          return Response.json({
            token: "test-installation-token",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          });
        throw new Error(`Unexpected App request ${url}`);
      },
    },
  );
  github.responses.set("user", () => respond(200, { login: "owner" }));
  const head = await pushBranch("one", "one.txt", "one\n");
  const pr = delivered(1, "one");
  approve(1, head);
  reviewObservation(head, "APPROVED", "owner");
  const q = queue({ requiresApproval: approvalPolicy() });
  const entry = await q.request({ target: pr.run.id });
  await waitFor(() => ["landed", "waiting_approval"].includes(store.getLandEntry(entry.id)?.state ?? ""));
  expect(store.getLandEntry(entry.id)?.state).toBe("landed");
  await q.stop();
  const nextHead = await pushBranch("two", "two.txt", "two\n", 2);
  const next = delivered(2, "two");
  approve(2, nextHead);
  reviewObservation(nextHead, "APPROVED", "factory[bot]", nextHead, 2);
  const waiting = await queue({ requiresApproval: approvalPolicy() }).request({ target: next.run.id });
  await waitFor(() => store.getLandEntry(waiting.id)?.state === "waiting_approval");
  expect(github.calls.filter((c) => c.path === "user")).toEqual([]);
  expect(requests.filter((url) => url.endsWith("/app"))).toHaveLength(1);
  expect(requests.filter((url) => url.endsWith("/access_tokens"))).toHaveLength(1);
});

test("lost land attempt stays open until the replacement blocks", async () => {
  const { pr } = await retryLandFixture();
  const fake = fakeLandGates((req) => ({
    ...retryRun(req),
    setupOk: false,
    checks: [],
    setup: [gateResult("setup", "prepare", { ok: false, exitCode: 1, output: "setup failed" })],
  }));
  const q = queue({ gateExecutor: fake.executor });
  const insert = store.observations.insert.bind(store.observations);
  let reclaimed = false;
  const spy = spyOn(store.observations, "insert").mockImplementation((row) => {
    insert(row);
    if (!reclaimed) {
      reclaimed = true;
      expect(store.claimLandEntry(SLUG, 30_000, "replacement", clock.now() + 31_000)?.id).toBe(
        Number(row.run_id.slice(5)),
      );
    }
  });
  try {
    const entry = await q.request({ target: pr.run.id });
    await waitWithoutClock(() => reclaimed, 15_000);
    await Promise.all((q as unknown as { workers: Map<string, Promise<void>> }).workers.values());
    expect(store.getLandEntry(entry.id)?.state).toBe("checking");
    expect(store.failureObservations()).toMatchObject([
      { handle_id: `${entry.id}:1`, finalized_at: null, history: null },
    ]);
    const replacement = queue({ start: false, gateExecutor: fake.executor });
    const worker = replacement as unknown as { owner: string; process: (entry: LandEntry) => Promise<void> };
    const claimed = store.claimLandEntry(SLUG, 30_000, worker.owner, clock.now() + 62_000);
    if (!claimed) throw new Error("missing replacement claim");
    await worker.process(claimed);
    expect(store.getLandEntry(entry.id)?.state).toBe("blocked");
    expect(store.failureObservations()).toMatchObject([
      { handle_id: `${entry.id}:1`, class: "setup", history: "interrupted" },
      { handle_id: `${entry.id}:3`, class: "setup", history: "no_retry" },
    ]);
    expect(store.failureObservations().every((r) => r.finalized_at !== null)).toBe(true);
  } finally {
    spy.mockRestore();
    await q.stop();
  }
});
