import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { Stage, StageName } from "../src/core/types.ts";
import type { AgentJobRequest, AgentJobRow } from "../src/db/workers.ts";
import { type GateExecutor, gateProvenance } from "../src/gates/executor.ts";
import { loadPrivateStrings, privateStringsDigest } from "../src/gates/private.ts";
import { runLocalGates } from "../src/gates/run.ts";
import { worktreeGit } from "../src/git/command.ts";
import * as repos from "../src/git/repos.ts";
import { headSha } from "../src/git/repos.ts";
import { type FakeReply, fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { ClaimLostError } from "../src/integrations/claim-errors.ts";
import type { AgentCall, AgentExecutor } from "../src/pipeline/agent-executor.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import type { FaultPlan } from "../src/pipeline/faults.ts";
import { lanAgentExecutor } from "../src/pipeline/lan-agent.ts";
import { startWorkerListener } from "../src/server/workers.ts";
import { sh } from "../src/util/proc.ts";
import { pairWorker, runWorker } from "../src/workers/client.ts";
import { workerRequest } from "../src/workers/tls.ts";
import { fakeConfinement } from "./confinement.ts";
import {
  approve,
  holdout,
  pass,
  pipelineSetup,
  providers,
  roleOf,
  spec,
  triage,
  waitFor,
} from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";
import {
  dependencyPackage,
  expectReaderDependency,
  readerDependencyFixture,
} from "./reader-dependencies-support.ts";
import { findingEvidence } from "./review-support.ts";
import { workerStartupFailures } from "./worker-startup-support.ts";

let home = "",
  repoDir = "",
  factory: Factory | null = null;
const { start, wait, githubFixture, registerGithub, advanceBase } = pipelineSetup({
  get home() {
    return home;
  },
  set home(v) {
    home = v;
  },
  get repoDir() {
    return repoDir;
  },
  set repoDir(v) {
    repoDir = v;
  },
  get factory() {
    return factory;
  },
  set factory(v) {
    factory = v;
  },
});
let previousConfig: string | undefined;
beforeEach(() => {
  previousConfig = process.env.LIMITLESS_CONFIG_DIR;
  process.env.LIMITLESS_CONFIG_DIR = join(home, "cfg");
  mkdirSync(process.env.LIMITLESS_CONFIG_DIR);
  writeFileSync(
    join(home, "cfg", "config.toml"),
    '[workers]\nlisten = "127.0.0.1:7443"\nagents = ["implement"]\nrepos = ["test/repo"]\n',
  );
});
afterEach(() => {
  if (previousConfig === undefined) delete process.env.LIMITLESS_CONFIG_DIR;
  else process.env.LIMITLESS_CONFIG_DIR = previousConfig;
});
const release = "f".repeat(40);
const jobs = (f: Factory) =>
  f.store.db.query<AgentJobRow, []>("SELECT * FROM agent_jobs ORDER BY rowid").all();
const request = (j: AgentJobRow): AgentJobRequest => JSON.parse(j.request);
function boot(
  options: {
    executor?: AgentExecutor;
    review?: (s: AgentSpec) => Promise<void>;
    reviewReply?: (s: AgentSpec) => Promise<FakeReply>;
    implementReply?: (s: AgentSpec) => Promise<FakeReply>;
    faults?: FaultPlan;
    deferStart?: boolean;
    localImplement?: boolean;
    freeProviders?: boolean;
  } = {},
) {
  let locals = 0;
  const startSpy = options.deferStart
    ? spyOn(Factory.prototype, "start").mockImplementation(() => {})
    : undefined;
  const f = start(() => ({}), false, options.freeProviders, {
    bootSha: release,
    providers: [
      ...providers,
      ...(options.freeProviders
        ? [{ id: "delta", label: "Delta", billing: "free" as const, maxConcurrent: 2 }]
        : []),
    ].map((p) => ({ ...p, harness: "claude" })),
    harnesses: {
      claude: fakeHarness(async (s) => {
        if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (roleOf(s) === "review" || s.prompt.startsWith("You are a code-review verifier")) {
          await options.review?.(s);
          return (await options.reviewReply?.(s)) ?? { structured: approve };
        }
        locals++;
        return (await options.implementReply?.(s)) ?? { files: { "farewell.txt": "local goodbye\n" } };
      }),
    },
    agentExecutor:
      options.executor ??
      (options.localImplement
        ? {
            kind: "review-worker",
            run: (call, local) =>
              call.role === "implement" ? local() : lanAgentExecutor(f.workers, f.cfg).run(call, local),
          }
        : undefined),
    faults: options.faults,
  });
  startSpy?.mockRestore();
  f.workers.times.tick = 1;
  f.workers.times.poll = 10;
  return { f, locals: () => locals };
}

test("unreadable private strings during worker preparation stop without changing provider health", async () => {
  const bare = await githubFixture();
  let f: Factory;
  let provider = "";
  let health: ReturnType<Factory["store"]["getProviderRow"]> = null;
  const executor: AgentExecutor = {
    kind: "test",
    async run(call, local) {
      const publication = call.publication;
      if (call.role === "implement" && publication)
        call.publication = {
          ...publication,
          async prepare() {
            provider = call.spec.target.provider;
            f.tracker.record(provider, "unavailable");
            expect(f.tracker.status(provider)?.state).toBe("degraded");
            health = f.store.getProviderRow(provider);
            writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), Buffer.from([0xff]));
            try {
              return await publication.prepare();
            } finally {
              // Scope the read failure to preparation, before the draft-delivery privacy check.
              writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), "");
            }
          },
        };
      return lanAgentExecutor(f.workers, f.cfg).run(call, local);
    },
  };
  const instance = boot({ executor });
  f = instance.f;
  registerGithub(f, bare);
  const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
  expect(await waitFor(f, run.id, ["needs_human", "succeeded"])).toBe("needs_human");
  const message = "Cannot prepare worker job: Cannot read private-strings.txt; publication blocked";
  expect(f.store.getRun(run.id)?.error).toContain(message);
  expect(f.store.listStages(run.id).find((s) => s.name === "implement")).toMatchObject({
    status: "failed",
    summary: expect.stringContaining(message),
  });
  expect(f.store.listInvocations(run.id).filter((i) => i.role === "implement")).toMatchObject([
    { status: "error", error: message, finishedAt: expect.any(Number) },
  ]);
  expect(health).not.toBeNull();
  expect(f.store.getProviderRow(provider)).toEqual(health);
  expect(f.tracker.status(provider)?.inFlight).toBe(0);
  expect(jobs(f)).toHaveLength(0);
  expect(instance.locals()).toBe(0);
});

test.each(["reject", "null"])(
  "cancelling during worker preparation preserves cancellation: %s",
  async (outcome) => {
    const bare = await githubFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let f: Factory;
    let provider = "";
    let health: ReturnType<typeof snapshot> = {};
    const snapshot = () => {
      const { updatedAt: _time, inFlight: _slots, ...status } = f.tracker.status(provider) ?? {};
      return status;
    };
    const executor: AgentExecutor = {
      kind: "test",
      async run(call, local) {
        if (call.role === "implement" && call.publication)
          call.publication.prepare = async () => {
            provider = call.spec.target.provider;
            f.tracker.record(provider, "unavailable");
            health = snapshot();
            entered.resolve();
            await release.promise;
            if (outcome === "reject") throw new Error("Preparation interrupted");
            return null;
          };
        return lanAgentExecutor(f.workers, f.cfg).run(call, local);
      },
    };
    const instance = boot({ executor });
    f = instance.f;
    registerGithub(f, bare);
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    await entered.promise;
    f.cancelRun(run.id);
    release.resolve();
    expect(await waitFor(f, run.id, ["cancelled", "needs_human"])).toBe("cancelled");
    expect(f.store.listInvocations(run.id).filter((i) => i.role === "implement")).toMatchObject([
      { status: "cancelled", finishedAt: expect.any(Number) },
    ]);
    expect(snapshot()).toEqual(health);
    expect(f.tracker.status(provider)?.inFlight).toBe(0);
    expect(jobs(f)).toHaveLength(0);
    expect(instance.locals()).toBe(0);
  },
);

test("real worker rounds publish, adopt, relay events and deliver over an advanced base", async () => {
  const bare = await githubFixture();
  const reviewed: string[] = [];
  const { f, locals } = boot({
    review: async (s) => {
      reviewed.push(await headSha(s.cwd));
      await advanceBase(bare, "base.txt", "new base\n");
    },
  });
  registerGithub(f, bare);
  const listener = await startWorkerListener(f.workers, f.cfg.paths, "127.0.0.1:0", () => {});
  if (!listener) throw new Error("Missing listener");
  const remote = loadConfig({ home: join(home, "remote"), configDir: join(home, "cfg"), raw: {} });
  const controller = new AbortController();
  let task: Promise<void> | undefined;
  let rounds = 0;
  try {
    await pairWorker(listener.url.origin, join(remote.paths.home, "worker"), "worker", (text) =>
      f.workers.approve(text.split(": ")[1] ?? ""),
    );
    task = runWorker(listener.url.origin, remote, release, controller.signal, {
      platform: "darwin",
      confinement: fakeConfinement,
      heartbeatMs: 10,
      capabilityRunner: async () => ({ exitCode: 0, stdout: "logged in" }),
      retryMs: 5,
      tokenLookup: async () => "fixture-worker-token",
      machineState: async () => ({ onAC: true, idleSeconds: 0 }),
      harnesses: {
        claude: fakeHarness((s) => {
          rounds++;
          return {
            files: { "farewell.txt": rounds === 1 ? "BAD\n" : "goodbye\n" },
            events: [
              { type: "text", text: `first ${s.cwd}` },
              { type: "text", text: `second ${s.cwd}` },
            ],
          };
        }),
      },
    });
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "needs_human"])).toBe("succeeded");
    const rows = jobs(f);
    expect(rows).toHaveLength(2);
    const first = rows[0],
      second = rows[1];
    if (!first || !second || !first.result_sha || !second.result_sha)
      throw new Error("Missing worker commits");
    const w1 = first.result_sha,
      w2 = second.result_sha;
    expect(request(first).expectedRemoteSha).toBeNull();
    expect(request(second)).toMatchObject({ parentSha: w1, expectedRemoteSha: w1 });
    for (const [job, parent] of [
      [first, first.parent_sha],
      [second, w1],
    ] as const) {
      const sha = job.result_sha ?? "";
      const req = request(job);
      expect((await sh(["git", "rev-list", "--parents", "-n", "1", sha], { cwd: bare })).stdout.trim()).toBe(
        `${sha} ${parent}`,
      );
      const raw = (await sh(["git", "cat-file", "commit", sha], { cwd: bare })).stdout;
      expect(raw.split("\n\n").slice(1).join("\n\n")).toBe(req.commit?.message ?? "missing");
      expect(raw).toContain(`author ${req.commit?.authorName} <${req.commit?.authorEmail}>`);
      expect(raw).toContain(`committer ${req.commit?.committerName} <${req.commit?.committerEmail}>`);
    }
    expect(reviewed).toEqual([w2]);
    const saved = f.store.getRun(run.id);
    const remoteHead = (
      await sh(["git", "rev-parse", `refs/heads/${saved?.branch}`], { cwd: bare })
    ).stdout.trim();
    expect(saved?.headSha).toBe(remoteHead);
    expect(
      (await sh(["git", "rev-list", "--parents", "-n", "1", remoteHead], { cwd: bare })).stdout
        .trim()
        .split(" "),
    ).toHaveLength(3);
    expect((await sh(["git", "merge-base", "--is-ancestor", w2, remoteHead], { cwd: bare })).exitCode).toBe(
      0,
    );
    expect(
      f.store
        .listStages(run.id)
        .filter((s) => s.name === "implement")
        .map((s) => s.summary),
    ).toEqual([expect.stringContaining(w1), expect.stringContaining(w2)]);
    const texts = f.store
      .listEvents(run.id)
      .filter((e) => /^(first|second) /.test(e.message))
      .map((e) => e.message);
    expect(texts).toEqual(["first <worktree>", "second <worktree>", "first <worktree>", "second <worktree>"]);
    expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("pr create");
    expect(locals()).toBe(0);
  } finally {
    controller.abort();
    await task;
    await listener.stop();
  }
}, 60_000);

function simulated(f: Factory, action: (job: AgentJobRow, req: AgentJobRequest) => Promise<void>) {
  const original = f.workers.enqueueAgentJob.bind(f.workers);
  const tasks: Promise<void>[] = [];
  const enqueue = spyOn(f.workers, "enqueueAgentJob").mockImplementation((req, suppliedId) => {
    const id = original(req, suppliedId);
    if (id) {
      const job = f.workers.agentJob(id);
      if (!job) throw new Error("Missing job");
      const task = action(job, req);
      void task.catch(() => {});
      tasks.push(task);
    }
    return id;
  });
  return async () => {
    enqueue.mockRestore();
    await Promise.all(tasks);
  };
}
async function report(f: Factory, job: AgentJobRow, req: AgentJobRequest, sha: string, quota = false) {
  const result = await fakeHarness(() => ({}))({
    cwd: home,
    target: req.target,
    mode: "edit",
    prompt: "",
    timeoutMs: 1000,
    idleTimeoutMs: 1000,
    maxToolCalls: 10,
    logPath: "",
    signal: new AbortController().signal,
    onEvent() {},
  });
  f.store.db.query("UPDATE agent_jobs SET state='leased' WHERE id=?").run(job.id);
  f.workers.completeAgentJob(
    job.id,
    {
      ...result,
      ...(quota ? { status: "quota", quota: { windows: {}, exhaustedUntil: Date.now() + 60_000 } } : {}),
      parentSha: req.parentSha,
      sha,
      branch: req.branch,
      privateStringsDigest: req.privateStringsDigest,
    },
    sha,
  );
}
async function publish(bare: string, req: AgentJobRequest, wrong = false, contents?: string) {
  await sh(["git", "fetch", bare, req.parentSha], { cwd: repoDir });
  await sh(["git", "reset", "--hard", req.parentSha], { cwd: repoDir });
  writeFileSync(join(repoDir, "farewell.txt"), contents ?? `worker goodbye ${req.parentSha}\n`);
  const commit = req.commit;
  if (!commit) throw new Error("Missing publication");
  await sh(["git", "add", "."], { cwd: repoDir });
  await sh(["git", "commit", "--cleanup=verbatim", "-F", "-"], {
    cwd: repoDir,
    stdin: wrong ? "Wrong message\n" : commit.message,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: commit.authorName,
      GIT_AUTHOR_EMAIL: commit.authorEmail,
      GIT_COMMITTER_NAME: commit.committerName,
      GIT_COMMITTER_EMAIL: commit.committerEmail,
    },
  });
  const sha = await headSha(repoDir);
  await sh(["git", "push", bare, `${sha}:refs/heads/${req.branch}`], { cwd: repoDir });
  return sha;
}

test.each(["lost push", "wrong message", "no changes", "failed safely"])(
  "coordinator handles %s",
  async (scenario) => {
    const bare = await githubFixture();
    const { f, locals } = boot(
      scenario === "no changes" ? { faults: { "stage:gates:before": { action: "kill" } } } : {},
    );
    registerGithub(f, bare);
    let published = "";
    const finish = simulated(f, async (job, req) => {
      if (scenario === "lost push" || scenario === "wrong message")
        published = await publish(bare, req, scenario === "wrong message");
      if (scenario === "lost push" || scenario === "failed safely") {
        f.workers.failAgentJob(job.id, "Worker disconnected");
        f.workers.failAgentJob(job.id, "Worker disconnected");
      } else await report(f, job, req, scenario === "no changes" ? req.parentSha : published);
    });
    try {
      const record = spyOn(f.tracker, "record");
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      if (scenario === "no changes")
        await wait(
          () => f.store.listStages(run.id).some((s) => s.name === "gates" && s.status === "cancelled"),
          { timeoutMs: 10_000, pollMs: null, subscribe: (wake) => f.store.subscribe(wake) },
        );
      const status =
        scenario === "no changes"
          ? f.store.getRun(run.id)?.status
          : await waitFor(f, run.id, ["succeeded", "needs_human"]);
      const final = f.store.getRun(run.id);
      const state = f.store.getRunState<RunState>(run.id);
      const row = jobs(f)[0];
      if (!row || !final?.branch || !state?.worktreePath) throw new Error("Missing run");
      const invocations = f.store.listInvocations(run.id).filter((i) => i.role === "implement");
      if (scenario === "lost push" || scenario === "wrong message") {
        expect(status).toBe("needs_human");
        expect(final.error).toContain(
          scenario === "lost push" ? "during a failed worker attempt" : "Cannot adopt worker commit",
        );
        expect(await headSha(state.worktreePath)).toBe(row.parent_sha);
        expect(locals()).toBe(0);
        expect(invocations[0]).toMatchObject({ status: "error", finishedAt: expect.any(Number) });
        expect(
          (await sh(["git", "rev-parse", `refs/heads/${final.branch}`], { cwd: bare })).stdout.trim(),
        ).toBe(published);
        expect(
          record.mock.calls.filter((args) => args[0] === "alpha").every((args) => args[1] === "ok"),
        ).toBe(true);
      } else {
        expect(status).toBe(scenario === "no changes" ? "running" : "succeeded");
        expect(locals()).toBe(scenario === "failed safely" ? 1 : 0);
        if (scenario === "no changes") {
          expect(await headSha(state.worktreePath)).toBe(row.parent_sha);
          expect(f.store.listStages(run.id).find((s) => s.name === "implement")?.summary).toContain(
            "no changes",
          );
          expect(
            (await sh(["git", "ls-remote", bare, `refs/heads/${final.branch}`], { cwd: repoDir })).stdout,
          ).toBe("");
        }
      }
      record.mockRestore();
    } finally {
      await finish();
    }
  },
);

test("a quota result is adopted before invoke dispatches the next candidate", async () => {
  const bare = await githubFixture();
  const { f, locals } = boot();
  registerGithub(f, bare);
  let attempts = 0;
  const finish = simulated(f, async (job, req) => {
    attempts++;
    await report(f, job, req, await publish(bare, req), attempts === 1);
  });
  try {
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "needs_human"])).toBe("succeeded");
    const [first, second] = jobs(f);
    if (!first?.result_sha || !second) throw new Error("Missing candidate attempts");
    expect(request(second)).toMatchObject({
      parentSha: first.result_sha,
      expectedRemoteSha: first.result_sha,
    });
    expect(
      f.store
        .listInvocations(run.id)
        .filter((i) => i.role === "implement")
        .map((i) => i.status),
    ).toEqual(["quota", "ok"]);
    expect(locals()).toBe(0);
  } finally {
    await finish();
  }
});

test.each([false, true])(
  "adopted worker ancestry survives restart and local privacy repairs (retained=%s)",
  async (retained) => {
    const bare = await githubFixture();
    const secret = `private-${crypto.randomUUID()}.example`;
    let f: Factory;
    let localCalls = 0;
    let superseded = "";
    let blob = "";
    const executor: AgentExecutor = {
      kind: "test",
      run: (call, local) =>
        call.role === "implement" && call.round === 1
          ? local()
          : lanAgentExecutor(f.workers, f.cfg).run(call, local),
    };
    const implementReply = async (s: AgentSpec): Promise<FakeReply> => {
      if (++localCalls === 2) {
        superseded = await headSha(s.cwd);
        blob = (await sh(["git", "rev-parse", "HEAD:config.txt"], { cwd: s.cwd })).stdout.trim();
      }
      return {
        files: {
          "farewell.txt": localCalls === 1 ? "BAD\n" : "goodbye\n",
          "config.txt": localCalls === 1 || retained ? `${secret}\n` : "public.example\n",
        },
      };
    };
    ({ f } = boot({
      executor,
      implementReply,
      faults: { "store:save": { action: "kill", when: (c) => c.checkpoint === "worker-commit-adopted" } },
    }));
    writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), secret);
    registerGithub(f, bare);
    const adopt = spyOn(repos, "adoptWorkerCommit");
    const push = spyOn(repos, "pushBranch");
    const finish = simulated(f, async (job, req) =>
      report(f, job, req, await publish(bare, req, false, "BAD\n")),
    );
    try {
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      await wait(
        () => f.store.listStages(run.id).some((s) => s.name === "implement" && s.status === "cancelled"),
        {
          timeoutMs: 10_000,
          pollMs: null,
          subscribe: (wake) => f.store.subscribe(wake),
        },
      );
      await finish();
      await f.stop();
      const adopted = jobs(f)[0]?.result_sha;
      if (!adopted) throw new Error("Missing worker publication");
      expect(adopt).toHaveBeenCalledTimes(1);
      f.store.close();
      ({ f } = boot({ executor, implementReply, deferStart: true }));
      f.cfg.maxRounds = 1;
      f.start();
      expect(await waitFor(f, run.id, ["succeeded", "needs_human", "failed"])).toBe(
        retained ? "needs_human" : "succeeded",
      );
      const done = f.store.getRun(run.id);
      const state = f.store.getRunState<RunState>(run.id);
      if (!done?.headSha || !state?.worktreePath) throw new Error("Missing repaired worker state");
      expect(jobs(f)).toHaveLength(1);
      expect(adopt).toHaveBeenCalledTimes(1);
      expect(localCalls).toBe(2);
      const cwd = retained ? state.worktreePath : bare;
      expect(
        (await sh(["git", "rev-list", "--parents", "-n", "1", done.headSha], { cwd })).stdout.trim(),
      ).toBe(`${done.headSha} ${adopted}`);
      const remoteHead = (
        await sh(["git", "rev-parse", `refs/heads/${done.branch}`], { cwd: bare })
      ).stdout.trim();
      if (retained) {
        expect(done.error).toContain("private string");
        expect(push).not.toHaveBeenCalled();
        expect(remoteHead).toBe(adopted);
      } else {
        expect(push).toHaveBeenCalledTimes(1);
        expect(remoteHead).toBe(state.gateEvidence?.sha as string);
        expect(remoteHead).toBe(done.headSha);
        await repos.checkPrivateRange(bare, `${adopted}..${remoteHead}`, [{ value: secret, entry: 1 }]);
      }
      for (const object of [superseded, blob]) {
        expect(object).toMatch(/^[a-f0-9]{40,64}$/);
        expect(
          (await sh(["git", "cat-file", "-e", object], { cwd: bare, allowFail: true })).exitCode,
        ).not.toBe(0);
      }
    } finally {
      await finish();
      adopt.mockRestore();
      push.mockRestore();
    }
  },
);

test.each(["worker-commit-adopted", "implementation-ready", "different target"])(
  "restart reuses the done result at %s",
  async (checkpoint) => {
    const bare = await githubFixture();
    const { f } = boot({
      faults: {
        "store:save": {
          action: "kill",
          when: (c) =>
            c.checkpoint === (checkpoint === "different target" ? "worker-commit-adopted" : checkpoint),
        },
      },
    });
    registerGithub(f, bare);
    const finish = simulated(f, async (job, req) => report(f, job, req, await publish(bare, req)));
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    await wait(
      () => f.store.listStages(run.id).some((s) => s.name === "implement" && s.status === "cancelled"),
      { timeoutMs: 10_000, pollMs: null, subscribe: (wake) => f.store.subscribe(wake) },
    );
    await finish();
    await f.stop();
    const state = f.store.getRunState<RunState>(run.id);
    const first = jobs(f)[0];
    if (!state?.worktreePath || !first?.result_sha) throw new Error("Missing interrupted adoption");
    expect(await headSha(state.worktreePath)).toBe(first.result_sha);
    expect(state.publishedSha).toBe(checkpoint !== "implementation-ready" ? undefined : first.result_sha);
    f.store.close();
    const { f: resumed, locals } = boot({ deferStart: true });
    if (checkpoint === "different target") resumed.tracker.setEnabled(request(first).target.provider, false);
    const complete = simulated(resumed, async (job, req) =>
      report(resumed, job, req, await publish(bare, req)),
    );
    try {
      resumed.start();
      expect(await waitFor(resumed, run.id, ["succeeded", "needs_human"])).toBe("succeeded");
      expect(jobs(resumed)).toHaveLength(checkpoint === "different target" ? 2 : 1);
      if (checkpoint === "different target") {
        const second = jobs(resumed)[1];
        if (!second?.result_sha) throw new Error("Missing new target result");
        expect(request(second)).toMatchObject({
          parentSha: first.result_sha,
          expectedRemoteSha: first.result_sha,
        });
        expect(request(second).target.provider).not.toBe(request(first).target.provider);
        expect(
          resumed.store
            .listInvocations(run.id)
            .filter((i) => i.role === "implement")
            .at(-1),
        ).toMatchObject({ modelId: request(second).target.modelId, status: "ok" });
        expect(resumed.store.getRunState<RunState>(run.id)?.publishedSha).toBe(second.result_sha);
      }
      expect(
        (await sh(["git", "log", "--format=%H", "-2", first.result_sha], { cwd: bare })).stdout
          .trim()
          .split("\n"),
      ).toEqual([first.result_sha, first.parent_sha]);
      if (checkpoint !== "different target")
        expect(resumed.store.getRunState<RunState>(run.id)?.publishedSha).toBe(first.result_sha);
      expect(resumed.store.getRunState<RunState>(run.id)?.agentJob).toBeUndefined();
      expect(locals()).toBe(0);
    } finally {
      await complete();
    }
  },
);

function approveSimulated(f: Factory) {
  f.workers.pairingKey = "fixture-pairing-key";
  const pending = f.workers.pair("simulated", "fingerprint", "coordinator");
  f.workers.approve(pending.code);
  const worker = f.workers.worker("simulated");
  if (!worker) throw new Error("Missing worker");
  f.workers.heartbeat(
    worker,
    {
      releaseSha: release,
      bunVersion: Bun.version,
      os: "darwin",
      osVersion: "test",
      cpuCount: 4,
      ramBytes: 1024,
      freeSlots: 1,
      onAC: true,
      idleSeconds: 0,
      jobs: [],
      agents: { claude: { version: null, loggedIn: true } },
    },
    "match",
  );
  return worker;
}

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])("rollback cancels a leased job (pushed=%s, handle=%s)", async (pushed, handle) => {
  const bare = await githubFixture();
  const { f } = boot();
  registerGithub(f, bare);
  approveSimulated(f);
  const leased = Promise.withResolvers<void>();
  let workerSha = "";
  const finish = simulated(f, async (job, req) => {
    expect(f.workers.leaseAgentJob("simulated")?.id).toBe(job.id);
    if (pushed) workerSha = await publish(bare, req);
    leased.resolve();
  });
  const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
  await leased.promise;
  await f.stop();
  f.workers.cancelOpenAgentJobs(new Set());
  await finish();
  expect(jobs(f)[0]?.state).toBe("cancelled");
  if (!handle) {
    const state = f.store.getRunState<RunState>(run.id);
    if (!state) throw new Error("Missing state");
    delete state.agentJob;
    f.store.setRunState(run.id, state);
  }
  f.store.close();
  const { f: resumed, locals } = boot();
  const complete = simulated(resumed, async (job, req) =>
    report(resumed, job, req, await publish(bare, req)),
  );
  try {
    expect(await waitFor(resumed, run.id, ["succeeded", "needs_human"])).toBe(
      pushed ? "needs_human" : "succeeded",
    );
    expect(jobs(resumed)).toHaveLength(pushed ? 1 : 2);
    if (pushed) {
      expect(resumed.store.getRun(run.id)?.error).toContain(
        "worker commit was pushed without an accepted report",
      );
      const branch = resumed.store.getRun(run.id)?.branch;
      expect((await sh(["git", "rev-parse", `refs/heads/${branch}`], { cwd: bare })).stdout.trim()).toBe(
        workerSha,
      );
    } else expect(request(jobs(resumed)[1] as AgentJobRow).expectedRemoteSha).toBeNull();
    expect(locals()).toBe(0);
  } finally {
    await complete();
  }
});

test.each([false, true])(
  "cancelling a waiting run reports its leased job (reattached=%s)",
  async (reattached) => {
    const bare = await githubFixture();
    let { f, locals } = boot();
    registerGithub(f, bare);
    const worker = approveSimulated(f);
    const leased = Promise.withResolvers<string>();
    const finish = simulated(f, async (job) => {
      f.workers.leaseAgentJob("simulated");
      leased.resolve(job.id);
    });
    try {
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      const id = await leased.promise;
      if (reattached) {
        await f.stop();
        await finish();
        f.store.close();
        const resumed = boot();
        f = resumed.f;
        locals = resumed.locals;
        await wait(
          () =>
            f.store
              .listEvents(run.id)
              .some((event) => event.message.includes(`Re-attached worker job ${id}`)),
          { timeoutMs: 10_000, pollMs: null, subscribe: (wake) => f.store.subscribe(wake) },
        );
      }
      f.cancelRun(run.id);
      expect(await waitFor(f, run.id, ["cancelled"])).toBe("cancelled");
      expect(f.workers.agentJob(id)?.state).toBe("cancelled");
      const caps = JSON.parse(f.workers.worker(worker.name)?.capabilities ?? "{}");
      expect(f.workers.heartbeat(worker, { ...caps, jobs: [id] }).cancelled).toEqual([id]);
      expect(locals()).toBe(0);
    } finally {
      await finish();
    }
  },
);

test("branch movement before dispatch refuses without enqueuing", async () => {
  const bare = await githubFixture();
  let f: Factory;
  const executor: AgentExecutor = {
    kind: "test",
    async run(call, local) {
      if (call.role === "implement") {
        await advanceBase(bare, "foreign.txt", "foreign\n");
        await sh(["git", "push", bare, `HEAD:refs/heads/${f.store.getRun(call.runId)?.branch}`], {
          cwd: repoDir,
        });
      }
      return lanAgentExecutor(f.workers, f.cfg).run(call, local);
    },
  };
  const instance = boot({ executor });
  f = instance.f;
  registerGithub(f, bare);
  const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
  expect(await waitFor(f, run.id, ["needs_human", "succeeded"])).toBe("needs_human");
  expect(f.store.getRun(run.id)?.error).toContain("another push moved it");
  expect(jobs(f)).toHaveLength(0);
  expect(instance.locals()).toBe(0);
});

test.each([
  "delivery branch",
  "PR exists",
  "verify-change",
  "local repository",
  "dirty worktree",
  "review round",
])("stage keeps %s local", async (scenario) => {
  const bare = await githubFixture();
  let f: Factory;
  let observed = false;
  const executor: AgentExecutor = {
    kind: "test",
    async run(call, local) {
      if (call.role === "implement") {
        observed = true;
        expect(call.publication === undefined).toBe(scenario !== "dirty worktree");
      }
      return lanAgentExecutor(f.workers, f.cfg).run(call, local);
    },
  };
  const original = RunContext.prototype.stage;
  const stage = spyOn(RunContext.prototype, "stage").mockImplementation(async function <T>(
    this: RunContext,
    name: StageName,
    fn: (stage: Stage) => Promise<{ summary: string; value: T }>,
    ...rest: [number?, boolean?, boolean?]
  ) {
    if (name === "implement") {
      if (scenario === "delivery branch")
        this.store.db.query("UPDATE runs SET delivery_branch='existing' WHERE id=?").run(this.run.id);
      if (scenario === "PR exists")
        this.run = this.store.updateRun(this.run.id, { prUrl: "https://github.com/test/repo/pull/1" });
      if (scenario === "verify-change") this.state.flow = "verify-change";
      if (scenario === "local repository") this.repo.kind = "local";
      if (scenario === "dirty worktree")
        writeFileSync(join(this.state.worktreePath ?? "", "leftover.txt"), "leftover\n");
      if (scenario === "review round")
        spyOn(this.store, "reviewRound").mockReturnValue({
          owner: this.run,
          kind: "review",
          prUrl: "https://github.com/test/repo/pull/1",
          round: 1,
          reviewedSha: this.run.baseSha ?? "",
          findings: [],
          deliveredSha: null,
        });
    }
    // Stop after this stage, before the synthetic delivery state is consumed.
    return (original<T>).call(this, name, fn, ...rest);
  });
  const instance = boot({ executor, faults: { "stage:gates:before": { action: "kill" } } });
  f = instance.f;
  registerGithub(f, bare);
  try {
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    await wait(() => f.store.listStages(run.id).some((s) => s.name === "gates" && s.status === "cancelled"), {
      timeoutMs: 10_000,
      pollMs: null,
      subscribe: (wake) => f.store.subscribe(wake),
    });
    expect(observed).toBe(true);
    expect(
      f.store
        .listInvocations(run.id)
        .filter((i) => i.role === "implement")
        .map((i) => i.error),
    ).toEqual([null]);
    expect(instance.locals()).toBe(1);
    expect(jobs(f)).toHaveLength(0);
  } finally {
    stage.mockRestore();
  }
});

test("delivery conflict resolution remains local after a worker publication", async () => {
  const bare = await githubFixture();
  let advanced = false;
  const { f, locals } = boot({
    review: async () => {
      if (!advanced) {
        advanced = true;
        const base = jobs(f)[0]?.parent_sha;
        if (!base) throw new Error("Missing worker parent");
        await sh(["git", "reset", "--hard", base], { cwd: repoDir });
        await advanceBase(bare, "farewell.txt", "base farewell\n");
      }
    },
  });
  registerGithub(f, bare);
  const finish = simulated(f, async (job, req) => report(f, job, req, await publish(bare, req)));
  try {
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "needs_human"])).toBe("succeeded");
    expect(jobs(f)).toHaveLength(1);
    expect(locals()).toBe(1);
  } finally {
    await finish();
  }
});

test("unreadable private strings on restart cancel the reconciled lease before refusing its result", async () => {
  const bare = await githubFixture();
  let { f } = boot();
  registerGithub(f, bare);
  let listener = await startWorkerListener(f.workers, f.cfg.paths, "127.0.0.1:0", () => {});
  if (!listener) throw new Error("Missing listener");
  const pending = f.workers.pair("worker", listener.tls.fingerprint, listener.url.origin);
  f.workers.approve(pending.code);
  const claim = f.workers.claim(pending.secret);
  if (!("token" in claim)) throw new Error("Missing worker token");
  const token = claim.token;
  const call = (path: string, body: unknown) => {
    if (!listener) throw new Error("Missing listener");
    return workerRequest(listener.url.origin, path, body, { token, pin: listener.tls.fingerprint });
  };
  const capabilities = {
    releaseSha: release,
    bunVersion: Bun.version,
    os: "darwin",
    osVersion: "test",
    cpuCount: 4,
    ramBytes: 1024,
    freeSlots: 1,
    onAC: true,
    idleSeconds: 0,
    jobs: [] as string[],
    agents: { claude: { version: null, loggedIn: true } },
    privateStringsDigest: privateStringsDigest(loadPrivateStrings(f.cfg.paths.configDir)),
  };
  await call("/worker/heartbeat", capabilities);
  const leased = Promise.withResolvers<string>();
  const finish = simulated(f, async (job) => {
    await call("/worker/lease", {});
    expect(f.workers.agentJob(job.id)?.state).toBe("leased");
    leased.resolve(job.id);
  });
  const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
  const id = await leased.promise;
  await f.stop();
  await finish();
  await listener.stop();
  f.store.close();
  let provider = "";
  let health: ReturnType<Factory["store"]["getProviderRow"]> = null;
  let reconciliationError: unknown;
  let propagatedError: unknown;
  let stateBeforeError: string | undefined;
  let dispatches = 0;
  const executor: AgentExecutor = {
    kind: "test",
    async run(call, local) {
      const publication = call.publication;
      if (call.role === "implement" && publication) {
        provider = call.spec.target.provider;
        f.tracker.record(provider, "unavailable");
        health = f.store.getProviderRow(provider);
        const dispatch = spyOn(call, "dispatch");
        call.publication = {
          ...publication,
          async resume(request) {
            writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), Buffer.from([0xff]));
            try {
              return await publication.resume(request);
            } catch (error) {
              reconciliationError = error;
              throw error;
            } finally {
              writeFileSync(join(f.cfg.paths.configDir, "private-strings.txt"), "");
            }
          },
        };
        try {
          return await lanAgentExecutor(f.workers, f.cfg).run(call, local);
        } catch (error) {
          propagatedError = error;
          stateBeforeError = f.workers.agentJob(id)?.state;
          dispatches = dispatch.mock.calls.length;
          throw error;
        }
      }
      return local();
    },
  };
  const resumed = boot({ executor, deferStart: true });
  f = resumed.f;
  listener = await startWorkerListener(f.workers, f.cfg.paths, "127.0.0.1:0", () => {});
  try {
    f.start();
    expect(await waitFor(f, run.id, ["needs_human", "succeeded"])).toBe("needs_human");
    expect(reconciliationError).toBeInstanceOf(Error);
    expect(propagatedError).toBe(reconciliationError);
    expect(stateBeforeError).toBe("cancelled");
    expect(dispatches).toBe(0);
    expect(f.store.getRun(run.id)?.error).toContain(
      "Cannot reconcile worker job: Error: Cannot read private-strings.txt; publication blocked",
    );
    expect(health).not.toBeNull();
    expect(f.store.getProviderRow(provider)).toEqual(health);
    expect(jobs(f)).toHaveLength(1);
    expect(resumed.locals()).toBe(0);
    expect((await call("/worker/heartbeat", { ...capabilities, jobs: [id] })).json()).toMatchObject({
      cancelled: [id],
    });
    const job = f.workers.agentJob(id);
    if (!job) throw new Error("Missing job");
    const req = request(job);
    const result = await fakeHarness(() => ({}))({
      cwd: home,
      target: req.target,
      mode: "edit",
      prompt: "",
      timeoutMs: 1000,
      idleTimeoutMs: 1000,
      maxToolCalls: 10,
      logPath: "",
      signal: new AbortController().signal,
      onEvent() {},
    });
    expect(
      (
        await call(`/worker/agent-jobs/${id}/result`, {
          ...result,
          parentSha: req.parentSha,
          sha: req.parentSha,
          branch: req.branch,
          privateStringsDigest: req.privateStringsDigest,
        })
      ).status,
    ).toBe(409);
    expect(f.workers.agentJob(id)).toMatchObject({ state: "cancelled", result: null, result_sha: null });
  } finally {
    await listener?.stop();
  }
});

test.each(["request", "retry wait"])(
  "worker shutdown aborts late reporting during %s",
  async (phase) => {
    const bare = await githubFixture();
    const { f } = boot();
    registerGithub(f, bare);
    const listener = await startWorkerListener(f.workers, f.cfg.paths, "127.0.0.1:0", () => {});
    if (!listener) throw new Error("Missing listener");
    const remote = loadConfig({ home: join(home, "remote"), configDir: join(home, "cfg"), raw: {} });
    const controller = new AbortController();
    const reporting = Promise.withResolvers<AbortSignal>();
    const releaseRequest = Promise.withResolvers<void>();
    let reports = 0;
    let offline = false;
    let task: Promise<void> | undefined;
    try {
      await pairWorker(listener.url.origin, join(remote.paths.home, "worker"), "worker", (text) =>
        f.workers.approve(text.split(": ")[1] ?? ""),
      );
      task = runWorker(listener.url.origin, remote, release, controller.signal, {
        platform: "darwin",
        confinement: fakeConfinement,
        heartbeatMs: 10,
        capabilityRunner: async () => ({ exitCode: 0, stdout: "logged in" }),
        retryMs: phase === "request" ? 1 : 60_000,
        tokenLookup: async () => "fixture-worker-token",
        machineState: async () => ({ onAC: true, idleSeconds: 0 }),
        harnesses: { claude: fakeHarness(() => ({ files: { "farewell.txt": "goodbye\n" } })) },
        request: async (...args) => {
          const [, path, body, options] = args;
          if (path.endsWith("/result")) {
            offline = true;
            reports++;
            const signal = options?.signal;
            if (!signal) throw new Error("Missing reporting signal");
            const job = jobs(f)[0];
            if (!job) throw new Error("Missing job");
            expect((body as { sha: string }).sha).not.toBe(job.parent_sha);
            if (phase === "request" && reports === 1) throw new Error("Coordinator offline");
            reporting.resolve(signal);
            if (phase === "request") {
              await Promise.race([
                releaseRequest.promise,
                new Promise<void>((resolve) =>
                  signal.addEventListener("abort", () => resolve(), { once: true }),
                ),
              ]);
              signal.throwIfAborted();
              return { status: 409, data: Buffer.alloc(0), fingerprint: "", json: () => ({}) };
            }
            throw new Error("Coordinator offline");
          }
          if (offline) throw new Error("Coordinator offline");
          return workerRequest(...args);
        },
      });
      await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      const reportSignal = await reporting.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const job = jobs(f)[0];
      expect(job?.attempt_deadline_at).toBeGreaterThan(Date.now() + 60_000);
      expect(reportSignal.aborted).toBe(false);
      controller.abort();
      expect(reportSignal.aborted).toBe(true);
      await task;
      expect(reports).toBe(phase === "request" ? 2 : 1);
      expect(jobs(f)[0]).toMatchObject({ state: "leased", result: null, result_sha: null });
    } finally {
      controller.abort();
      releaseRequest.resolve();
      await task;
      await listener.stop();
    }
  },
  10_000,
);

test.each(["running", "pushed", "fenced", "job-cancelled"])(
  "real worker survives restart while %s",
  async (scenario) => {
    const bare = await githubFixture();
    let { f } = boot();
    registerGithub(f, bare);
    let listener = await startWorkerListener(f.workers, f.cfg.paths, "127.0.0.1:0", () => {});
    if (!listener) throw new Error("Missing listener");
    const origin = listener.url.origin;
    const remote = loadConfig({ home: join(home, "remote"), configDir: join(home, "cfg"), raw: {} });
    const entered = Promise.withResolvers<void>();
    const releaseSession = Promise.withResolvers<void>();
    const published = Promise.withResolvers<string>();
    const reviewed = Promise.withResolvers<void>();
    const releaseReview = Promise.withResolvers<void>();
    let offline = false,
      sessions = 0;
    let fence: (() => void) | undefined;
    let jobSignal: AbortSignal | undefined;
    let cancelJob: string | undefined;
    const controller = new AbortController();
    let task: Promise<void> | undefined;
    try {
      await pairWorker(origin, join(remote.paths.home, "worker"), "worker", (text) =>
        f.workers.approve(text.split(": ")[1] ?? ""),
      );
      task = runWorker(origin, remote, release, controller.signal, {
        platform: "darwin",
        confinement: fakeConfinement,
        heartbeatMs: 10,
        capabilityRunner: async () => ({ exitCode: 0, stdout: "logged in" }),
        retryMs: 5,
        fenceTimer: {
          set(callback) {
            fence = callback;
            return setTimeout(() => {}, 2_147_483_647);
          },
          clear(timer) {
            clearTimeout(timer);
          },
        },
        request: async (_url, path, body, options) => {
          if (offline) {
            if (path.endsWith("/result")) published.resolve((body as { sha: string }).sha);
            if (path === "/worker/heartbeat" && cancelJob)
              return {
                status: 200,
                data: Buffer.alloc(0),
                fingerprint: "",
                json: () => ({ cancelled: [cancelJob] }),
              };
            throw new Error("Coordinator offline");
          }
          if (!listener) throw new Error("Missing listener");
          return workerRequest(listener.url.origin, path, body, options);
        },
        tokenLookup: async () => {
          if (scenario !== "running") {
            entered.resolve();
            await releaseSession.promise;
          }
          return "fixture-worker-token";
        },
        machineState: async () => ({ onAC: true, idleSeconds: 0 }),
        harnesses: {
          claude: fakeHarness(async (spec) => {
            jobSignal = spec.signal;
            sessions++;
            if (scenario === "running") {
              entered.resolve();
              await releaseSession.promise;
            }
            return { files: { "farewell.txt": "goodbye\n" } };
          }),
        },
      });
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      await entered.promise;
      const id = jobs(f)[0]?.id;
      if (!id) throw new Error("Missing job");
      await f.stop();
      expect(f.workers.agentJob(id)?.state).toBe("leased");
      offline = true;
      await listener.stop();
      listener = undefined;
      let pushed: string | undefined;
      if (scenario !== "running") {
        releaseSession.resolve();
        pushed = await published.promise;
        if (scenario === "fenced") {
          if (!fence) throw new Error("Missing fence");
          fence();
        }
        if (scenario === "job-cancelled") {
          if (!jobSignal) throw new Error("Missing job signal");
          const cancelled = Promise.withResolvers<void>();
          jobSignal.addEventListener("abort", () => cancelled.resolve(), { once: true });
          cancelJob = id;
          await cancelled.promise;
          cancelJob = undefined;
          expect(jobSignal.aborted).toBe(true);
        }
      }
      f.store.db.query("UPDATE workers SET last_heartbeat_at=last_heartbeat_at-90000").run();
      f.store.db.query("UPDATE agent_jobs SET lease_expires_at=lease_expires_at-90000 WHERE id=?").run(id);
      f.store.close();
      const resumed = boot({
        deferStart: true,
        review: async () => {
          reviewed.resolve();
          await releaseReview.promise;
        },
      });
      f = resumed.f;
      listener = await startWorkerListener(f.workers, f.cfg.paths, "127.0.0.1:0", () => {});
      f.workers.sweepAgentJobs();
      expect(f.workers.agentJob(id)?.state).toBe("leased");
      offline = false;
      f.start();
      releaseSession.resolve();
      await reviewed.promise;
      const rows = jobs(f),
        state = f.store.getRunState<RunState>(run.id);
      const row = rows[0];
      if (!row?.result_sha || !state?.worktreePath) throw new Error("Missing worker result");
      expect(rows).toHaveLength(1);
      expect(row).toMatchObject({ id, state: "done", attempt: 1 });
      expect(sessions).toBe(1);
      expect(resumed.locals()).toBe(0);
      expect(state.publishedSha).toBe(row.result_sha);
      expect(await headSha(state.worktreePath)).toBe(row.result_sha);
      if (pushed) expect(row.result_sha).toBe(pushed);
      const report = JSON.parse(row.result ?? "null");
      expect(report.privateStringsDigest).toBe(request(row).privateStringsDigest);
      expect(
        (
          await sh(["git", "rev-parse", `refs/heads/${f.store.getRun(run.id)?.branch}`], { cwd: bare })
        ).stdout.trim(),
      ).toBe(row.result_sha);
      releaseReview.resolve();
      expect(await waitFor(f, run.id, ["succeeded", "needs_human"])).toBe("succeeded");
    } finally {
      releaseReview.resolve();
      releaseSession.resolve();
      controller.abort();
      await task;
      await listener?.stop();
    }
  },
  30_000,
);

test.each(["agent-job-started", "missing row", "queued"])("restart checkpoint: %s", async (checkpoint) => {
  const bare = await githubFixture();
  const { f } = boot(
    checkpoint === "agent-job-started"
      ? {
          faults: { "store:save": { action: "kill", when: (c) => c.checkpoint === checkpoint } },
        }
      : {},
  );
  registerGithub(f, bare);
  const queued = Promise.withResolvers<void>();
  const finish = simulated(f, async () => {
    queued.resolve();
  });
  const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
  if (checkpoint === "agent-job-started") {
    await wait(
      () => f.store.listStages(run.id).some((s) => s.name === "implement" && s.status === "cancelled"),
      { timeoutMs: 10_000, pollMs: null, subscribe: (wake) => f.store.subscribe(wake) },
    );
    expect(f.store.getRunState<RunState>(run.id)?.agentJob).toBeUndefined();
    expect(jobs(f)).toHaveLength(0);
  } else await queued.promise;
  await f.stop();
  await finish();
  const old = jobs(f)[0];
  if (checkpoint === "missing row" && old) f.store.db.query("DELETE FROM agent_jobs WHERE id=?").run(old.id);
  f.store.close();
  const { f: resumed, locals } = boot({ deferStart: true });
  const complete = simulated(resumed, async (job, req) =>
    report(resumed, job, req, await publish(bare, req)),
  );
  try {
    if (checkpoint === "queued") {
      const worker = approveSimulated(resumed);
      expect(resumed.workers.leaseAgentJob(worker.name)?.id).toBe(old?.id);
      const job = jobs(resumed)[0];
      if (!job) throw new Error("Missing queued job");
      await report(resumed, job, request(job), await publish(bare, request(job)));
    }
    resumed.start();
    expect(await waitFor(resumed, run.id, ["succeeded", "needs_human"])).toBe("succeeded");
    expect(jobs(resumed)).toHaveLength(1);
    if (checkpoint === "queued") expect(jobs(resumed)[0]?.id).toBe(old?.id);
    expect(locals()).toBe(0);
  } finally {
    await complete();
  }
});

test.each(["implement", "agents off", "listener off"])(
  "factory keeps only live handles: %s",
  async (mode) => {
    const { f } = boot({ deferStart: true });
    const repo = f.store.upsertRepo({
      slug: "test/repo",
      kind: "github",
      url: null,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const run = f.store.createRun(repo, { repo: repo.slug, prompt: "Round" });
    f.store.updateRun(run.id, { status: "waiting" });
    const terminal = f.store.createRun(repo, { repo: repo.slug, prompt: "Finished" });
    f.store.updateRun(terminal.id, { status: "succeeded" });
    const enqueue = (runId: string) => {
      const id = f.workers.enqueueAgentJob({
        runId,
        invocationId: 1,
        parentSha: release,
        prompt: "Round",
        target: {
          modelId: "test",
          model: "test",
          provider: "alpha",
          vendor: "test",
          tier: 1,
          billing: "subscription",
          harness: "claude",
        },
        timeoutMs: 1000,
      });
      if (!id) throw new Error("Missing job");
      return id;
    };
    const kept = enqueue(run.id),
      terminalJob = enqueue(terminal.id),
      orphan = enqueue(run.id),
      done = enqueue(run.id),
      failed = enqueue(run.id);
    f.store.setRunState(run.id, { agentJob: { round: 1, id: kept } });
    f.store.setRunState(terminal.id, { agentJob: { round: 1, id: terminalJob } });
    f.store.db.query("UPDATE agent_jobs SET state='leased' WHERE id=?").run(done);
    f.workers.completeAgentJob(done, {}, release);
    f.workers.failAgentJob(failed, "Failed");
    f.workers.failAgentJob(failed, "Failed");
    if (mode === "agents off") f.cfg.workers.agents = [];
    if (mode === "listener off") f.cfg.workers.listen = undefined;
    // Reuse the persisted store to observe construction separately from start.
    const next = new Factory(f.cfg, {
      store: f.store,
      providers,
      confinement: fakeConfinement,
      loadSource: () => 0,
    });
    factory = next;
    const scheduler = spyOn(next.scheduler, "start").mockImplementation(() => {});
    expect([kept, terminalJob, orphan].map((id) => next.workers.agentJob(id)?.state)).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
    next.start();
    expect([kept, terminalJob, orphan, done, failed].map((id) => next.workers.agentJob(id)?.state)).toEqual([
      mode === "implement" ? "queued" : "cancelled",
      "cancelled",
      "cancelled",
      "done",
      "failed",
    ]);
    const stopOrphan = enqueue(run.id);
    await next.stop();
    expect(next.workers.agentJob(stopOrphan)?.state).toBe("cancelled");
    expect(next.workers.agentJob(kept)?.state).toBe(mode === "implement" ? "queued" : "cancelled");
    scheduler.mockRestore();
  },
);

test("publication resume checks HEAD, cleanliness, expected SHA and the private list", async () => {
  const bare = await githubFixture();
  let f: Factory,
    checked = false;
  const executor: AgentExecutor = {
    kind: "test",
    async run(call, local) {
      const hooks = call.publication;
      if (hooks && !checked) {
        checked = true;
        const req = await hooks.prepare();
        if (!req) throw new Error("Missing publication");
        expect(await hooks.resume(req)).toBe(true);
        expect(await hooks.resume({ ...req, privateStringsDigest: "d".repeat(64) })).toBe(false);
        expect(await hooks.resume({ ...req, expectedRemoteSha: release })).toBe(false);
        const file = join(call.worktree, "untracked.txt");
        writeFileSync(file, "dirty\n");
        expect(await hooks.resume(req)).toBe(false);
        rmSync(file);
        await worktreeGit(["git", "commit", "--allow-empty", "-qm", "moved HEAD"], { cwd: call.worktree });
        expect(await hooks.resume(req)).toBe(false);
        await worktreeGit(["git", "reset", "--hard", req.parentSha], { cwd: call.worktree });
        expect(await hooks.resume(req)).toBe(true);
      }
      return lanAgentExecutor(f.workers, f.cfg).run(call, local);
    },
  };
  const instance = boot({ executor });
  f = instance.f;
  registerGithub(f, bare);
  const complete = simulated(f, async (job, req) => report(f, job, req, await publish(bare, req)));
  try {
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "needs_human"])).toBe("succeeded");
    expect(checked).toBe(true);
    expect(jobs(f)).toHaveLength(1);
    expect(instance.locals()).toBe(0);
  } finally {
    await complete();
  }
});

async function reviewWorker(f: Factory, handler: (s: AgentSpec) => Promise<FakeReply>) {
  const listener = await startWorkerListener(f.workers, f.cfg.paths, "127.0.0.1:0", () => {});
  if (!listener) throw new Error("Missing listener");
  const remote = loadConfig({ home: join(home, "review-worker"), configDir: join(home, "cfg"), raw: {} });
  const controller = new AbortController();
  await pairWorker(listener.url.origin, join(remote.paths.home, "worker"), "reviewer", (text) =>
    f.workers.approve(text.split(": ")[1] ?? ""),
  );
  const task = runWorker(listener.url.origin, remote, release, controller.signal, {
    platform: "darwin",
    confinement: fakeConfinement,
    heartbeatMs: 10,
    retryMs: 5,
    capabilityRunner: async () => ({ exitCode: 0, stdout: "logged in" }),
    machineState: async () => ({ onAC: true, idleSeconds: 0 }),
    tokenLookup: async () => {
      throw new Error("Review must not acquire publication credentials");
    },
    harnesses: { claude: fakeHarness(handler) },
  });
  return async () => {
    controller.abort();
    await task;
    await listener.stop();
  };
}

test("second LAN review resolves its previous SHA from a private bundle after coordinator and worker GC", async () => {
  const bare = await githubFixture();
  let previous = "";
  let unrelated = "";
  let reviews = 0;
  let implementations = 0;
  let f: Factory;
  ({ f } = boot({
    implementReply: async () => ({ files: { "farewell.txt": `goodbye ${++implementations}\n` } }),
    executor: {
      kind: "test",
      async run(call, local) {
        if (call.role === "implement") return local();
        if (previous) {
          const repo = f.store.getRepo(f.store.getRun(call.runId)?.repoId ?? "");
          if (!repo) throw new Error("Missing repository");
          const cwd = repos.cachePath(f.cfg.paths, repo);
          await sh(["git", "reflog", "expire", "--expire=now", "--all"], { cwd });
          await sh(["git", "gc", "--prune=now"], { cwd });
        }
        return lanAgentExecutor(f.workers, f.cfg).run(call, local);
      },
    },
  }));
  f.cfg.workers.agents = ["review"];
  registerGithub(f, bare);
  const checkouts: string[] = [];
  const stop = await reviewWorker(f, async (s) => {
    checkouts.push(s.cwd);
    if (++reviews === 1) {
      previous = await headSha(s.cwd);
      const job = jobs(f)[0];
      const repo = f.store.getRepo(f.store.getRun(job?.run_id ?? "")?.repoId ?? "");
      if (!repo) throw new Error("Missing review repo");
      const cwd = repos.cachePath(f.cfg.paths, repo);
      const tree = (await sh(["git", "rev-parse", `${previous}^{tree}`], { cwd })).stdout.trim();
      unrelated = (
        await worktreeGit(["git", "commit-tree", tree, "-m", "unrelated run"], { cwd })
      ).stdout.trim();
      await worktreeGit(
        ["git", "update-ref", `refs/limitless/iterations/unrelated/${unrelated}`, unrelated],
        { cwd },
      );
      return {
        structured: {
          ...approve,
          verdict: "request_changes",
          findings: [
            {
              severity: "blocker",
              security: false,
              ...findingEvidence,
              file: "farewell.txt",
              line: 1,
              title: "Wrong text",
              detail: "Use the second farewell",
              suggestion: "Change the farewell",
            },
          ],
        },
      };
    }
    expect(s.prompt).toContain(`git diff ${previous}..`);
    // Each agent job has an independent cache. Its private refs must survive GC too.
    const cache = join(dirname(s.cwd), "repo.git");
    await sh(["git", "reflog", "expire", "--expire=now", "--all"], { cwd: cache });
    await sh(["git", "gc", "--prune=now"], { cwd: cache });
    const diff = await sh(["git", "diff", `${previous}..HEAD`], { cwd: s.cwd });
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout).toContain("-goodbye 1");
    expect(diff.stdout).toContain("+goodbye 2");
    expect(
      (await sh(["git", "cat-file", "-e", unrelated], { cwd: s.cwd, allowFail: true })).exitCode,
    ).not.toBe(0);
    expect(
      (await sh(["git", "for-each-ref", "refs/limitless/iterations/unrelated/"], { cwd: s.cwd })).stdout,
    ).toBe("");
    return { structured: approve };
  });
  try {
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(reviews).toBe(2);
    expect(new Set(checkouts).size).toBe(2);
    expect(jobs(f)).toHaveLength(2);
    const repo = f.store.getRepo(run.repoId);
    if (!repo) throw new Error("Missing final repo");
    const cache = repos.cachePath(f.cfg.paths, repo);
    await wait(() => repos.iterationRefs(cache, run.id).then((refs) => refs.length === 0), {
      timeoutMs: 10_000,
    });
    expect(await repos.iterationRefs(cache, "unrelated")).toHaveLength(1);
  } finally {
    await stop();
  }
}, 60_000);

test.each(["worker only", "local fallback"] as const)(
  "quick LAN review prepares dependencies on the executing host: %s",
  async (layout) => {
    const install = await readerDependencyFixture(repoDir);
    const setup =
      layout === "worker only"
        ? `case "$PWD" in *remote-gate-*|*worker-agent-*) true ;; *) echo "toolchain is available only on the worker" >&2; exit 1 ;; esac; ${install}`
        : install;
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\nsetup = [${JSON.stringify(setup)}]\nchecks = []\n`,
    );
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "commit", "-qm", "worker toolchain"], { cwd: repoDir });
    const bare = await githubFixture();
    dependencyPackage(join(home, "node_modules/zod"), "3.0.0");
    dependencyPackage(join(home, "review-worker/node_modules/zod"), "3.0.0");
    let f: Factory;
    let localReviews = 0;
    let workerReviews = 0;
    ({ f } = boot({
      executor: {
        kind: "test",
        run: (call, local) =>
          call.role === "implement" ? local() : lanAgentExecutor(f.workers, f.cfg).run(call, local),
      },
      review: async (s) => {
        if (layout === "worker only") throw new Error("Review must run on worker");
        localReviews++;
        await expectReaderDependency(s.cwd);
      },
    }));
    const remoteGates: GateExecutor = {
      kind: "lan",
      async start() {
        return { kind: "lan", id: crypto.randomUUID(), startedAt: Date.now() };
      },
      attach(handle, signal, req) {
        if (!req) throw new Error("Missing gate request");
        const cwd = join(home, `remote-gate-${handle.id}`);
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          result: (async () => {
            await sh(["git", "clone", "--quiet", "--no-hardlinks", req.cwd, cwd], { cwd: home, signal });
            await sh(["git", "checkout", "--quiet", "--detach", req.headSha], { cwd, signal });
            return {
              ...(await runLocalGates(cwd, req.gates, signal)),
              ...(await gateProvenance(cwd, signal, req.headSha)),
            };
          })(),
          async cancel() {},
        };
      },
    };
    f.deps.gateExecutor = remoteGates;
    f.cfg.workers.agents = ["review"];
    registerGithub(f, bare);
    const stop =
      layout === "worker only"
        ? await reviewWorker(f, async (s) => {
            workerReviews++;
            await expectReaderDependency(s.cwd);
            return { structured: approve };
          })
        : await simulated(f, async (job) => {
            f.workers.failAgentJob(job.id, "Disconnected");
            f.workers.failAgentJob(job.id, "Disconnected");
          });
    try {
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(workerReviews).toBe(layout === "worker only" ? 1 : 0);
      expect(localReviews).toBe(layout === "local fallback" ? 1 : 0);
      expect(jobs(f)).toHaveLength(1);
    } finally {
      await stop();
    }
  },
  30_000,
);

test("LAN review installs dependencies and acceptance verification stays local", async () => {
  const install = await readerDependencyFixture(repoDir);
  writeFileSync(
    join(repoDir, ".limitless.toml"),
    `[gates]\nsetup = [${JSON.stringify(install)}]\nchecks = []\n`,
  );
  await sh(["git", "add", "."], { cwd: repoDir });
  await sh(["git", "commit", "-qm", "offline reviewer dependencies"], { cwd: repoDir });
  const bare = await githubFixture();
  dependencyPackage(join(home, "review-worker/node_modules/zod"), "3.0.0");
  let verifications = 0;
  let reviews = 0;
  let f: Factory;
  const handler = async (s: AgentSpec): Promise<FakeReply> => {
    const role = roleOf(s);
    if (role === "triage") return { structured: triage() };
    if (role === "spec") return { structured: spec };
    if (role === "holdout") return { structured: holdout };
    if (role === "verify") {
      verifications++;
      await expectReaderDependency(s.cwd);
      expect(f.store.getRunState<RunState>(run.id)?.worktreePath).toBe(s.cwd);
      return { structured: pass };
    }
    if (role === "review") throw new Error("Review should use worker");
    return { files: { "farewell.txt": "goodbye\n" } };
  };
  f = start(handler, false, false, {
    bootSha: release,
    providers: providers.map((p) => ({ ...p, harness: "claude" })),
    harnesses: { claude: fakeHarness(handler) },
    agentExecutor: {
      kind: "test",
      run: (call, local) => lanAgentExecutor(f.workers, f.cfg).run(call, local),
    },
  });
  f.cfg.workers.agents = ["review", "verify"];
  registerGithub(f, bare);
  const stop = await reviewWorker(f, async (s) => {
    reviews++;
    await expectReaderDependency(s.cwd);
    return { structured: approve };
  });
  const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "standard" });
  try {
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(reviews).toBe(1);
    expect(verifications).toBe(1);
    expect(jobs(f)).toMatchObject([{ state: "done" }]);
    const job = jobs(f)[0];
    if (!job) throw new Error("Missing review job");
    expect(request(job)).toMatchObject({ role: "review", readerSetup: [install] });
  } finally {
    await stop();
  }
}, 30_000);

// Compare artifact structure while allowing run-specific model, duration and SHA values.
function structure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structure);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, structure(v)]));
  return value === null ? null : typeof value;
}

test.each(["single", "panel", "panel pinned"] as const)(
  "real worker reviews readonly and delivers: %s",
  async (scenario) => {
    const mode = scenario === "single" ? "single" : "panel";
    const pinned = scenario === "panel pinned";
    const bare = await githubFixture();
    let localReviews = 0;
    const review = async (s: AgentSpec): Promise<FakeReply> => {
      if (s.prompt.startsWith("You are a code-review verifier"))
        return {
          structured: {
            results: [
              {
                id: "C1",
                verdict: "REFUTED",
                severity: "low",
                category: "correctness",
                evidence: "farewell.txt:1 contains a valid farewell",
                trigger: "Reading the farewell",
              },
            ],
          },
        };
      return {
        structured:
          mode === "single" || s.target.modelId === "alpha/m" || s.prompt.includes("# Lens: coordinator")
            ? approve
            : {
                ...approve,
                findings: [
                  {
                    severity: "minor",
                    security: false,
                    file: "farewell.txt",
                    line: 1,
                    title: "Check farewell",
                    detail: "The farewell may be too terse",
                    suggestion: "Check it",
                    failure_scenario: "Reading the farewell",
                    category: "correctness",
                    confidence: 0.9,
                    introduced_by_diff: true,
                  },
                ],
              },
      };
    };
    let f: Factory;
    let checked = 0;
    const reviewCalls: AgentCall[] = [];
    const refs = async () => (await sh(["git", "show-ref"], { cwd: bare })).stdout;
    const executor: AgentExecutor = {
      kind: "test",
      async run(call, local) {
        if (call.role === "implement") return local();
        if (call.role === "review") reviewCalls.push(call);
        if (call.role !== "review" || !f.cfg.workers.agents.includes("review"))
          return lanAgentExecutor(f.workers, f.cfg).run(call, local);
        if (call.spec.prompt.includes("# Lens: coordinator"))
          return lanAgentExecutor(f.workers, f.cfg).run(call, local);
        const before = await refs();
        const head = await headSha(call.worktree);
        const status = (await worktreeGit(["git", "status", "--porcelain"], { cwd: call.worktree })).stdout;
        expect(before).not.toContain(`refs/heads/${call.checkout?.branch}`);
        expect(call.checkout).toMatchObject({
          parentSha: head,
          baseSha: f.store.getRun(call.runId)?.baseSha,
        });
        expect(f.tracker.status(call.spec.target.provider)?.inFlight).toBeGreaterThan(0);
        const result = await lanAgentExecutor(f.workers, f.cfg).run(call, local);
        expect(await headSha(call.worktree)).toBe(head);
        expect((await worktreeGit(["git", "status", "--porcelain"], { cwd: call.worktree })).stdout).toBe(
          status,
        );
        expect(await refs()).toBe(before);
        checked++;
        return result;
      },
    };
    const instance = boot({
      executor,
      freeProviders: mode === "panel",
      reviewReply: async (s) => {
        localReviews++;
        return review(s);
      },
    });
    f = instance.f;
    f.cfg.workers.agents = ["implement", "review"];
    if (mode === "panel")
      f.deps.reviewSystem = {
        name: "panel",
        mode: "panel",
        finders: [
          { target: "alpha/m", prompt: "standard" },
          { target: "beta/m", prompt: "adversarial" },
          {
            prompt: "standard",
            local: true,
            lens: { name: "coordinator", focus: "Check the farewell locally." },
          },
        ],
        verifier: {},
        implementerReport: "include",
      };
    registerGithub(f, bare);
    const sessions: AgentSpec[] = [];
    const stop = await reviewWorker(f, async (s) => {
      sessions.push(s);
      expect(s.mode).toBe("readonly");
      expect(s.cwd).not.toBe(f.store.getRunState<RunState>(jobs(f)[0]?.run_id ?? "")?.worktreePath);
      // A misbehaving harness cannot change the coordinator or publish its writes.
      return { ...(await review(s)), files: { "worker-only.txt": "discard me\n" } };
    });
    try {
      const runOptions = {
        repo: "test/repo",
        prompt: "Add farewell",
        profile: "quick" as const,
        ...(pinned ? { models: { review: ["beta/m", "alpha/m"] } } : {}),
      };
      const run = await f.createRun(runOptions);
      const status = await waitFor(f, run.id, ["succeeded", "needs_human"]);
      expect(f.store.getRun(run.id)?.error).toBeNull();
      expect(status).toBe("succeeded");
      const rows = jobs(f);
      expect(rows).toHaveLength(mode === "single" ? 1 : 3);
      expect(checked).toBe(rows.length);
      expect(sessions).toHaveLength(rows.length);
      expect(localReviews).toBe(mode === "panel" ? 1 : 0);
      expect(instance.locals()).toBe(1);
      const state = f.store.getRunState<RunState>(run.id);
      const localCalls = reviewCalls.filter((call) => call.spec.prompt.includes("# Lens: coordinator"));
      expect(localCalls).toHaveLength(mode === "panel" ? 1 : 0);
      for (const call of localCalls) {
        expect(call.checkout).toBeUndefined();
        expect(call.spec.target).toMatchObject({
          harness: "claude",
          billing: pinned ? "subscription" : "free",
        });
        for (const field of ["backend", "openai", "decisions"])
          expect(call.spec.target).not.toHaveProperty(field);
        expect(rows.some((row) => row.invocation_id === call.invocationId)).toBe(false);
      }
      const workerCalls = reviewCalls.filter((call) => !localCalls.includes(call));
      expect(rows.map((row) => row.invocation_id).sort()).toEqual(
        workerCalls.map((call) => call.invocationId).sort(),
      );
      if (mode === "panel") {
        expect(workerCalls.filter((call) => roleOf(call.spec) === "review")).toHaveLength(2);
        expect(
          workerCalls.filter((call) => call.spec.prompt.startsWith("You are a code-review verifier")),
        ).toHaveLength(1);
      }
      for (const row of rows) {
        expect(request(row)).toMatchObject({ role: "review", mode: "readonly" });
        expect(request(row)).not.toHaveProperty("commit");
        expect(row).toMatchObject({ state: "done", result_sha: row.parent_sha });
        expect(state?.reviewHistory?.at(-1)?.sha).toBe(row.parent_sha);
      }
      expect(state?.agentJob).toBeUndefined();
      expect(readFileSync(join(home, "gh-calls"), "utf8")).toContain("pr create");
      const artifact = JSON.parse(f.store.getArtifact(run.id, "review-1.json") ?? "null");
      f.cfg.workers.agents = [];
      const local = await f.createRun(runOptions);
      expect(await waitFor(f, local.id, ["succeeded", "needs_human"])).toBe("succeeded");
      expect(jobs(f)).toHaveLength(rows.length);
      expect(structure(artifact)).toEqual(
        structure(JSON.parse(f.store.getArtifact(local.id, "review-1.json") ?? "null")),
      );
      if (mode === "panel") expect(artifact.panel.verdicts).not.toHaveLength(0);
    } finally {
      await stop();
    }
  },
  30_000,
);

test("review worker failures fall back without affecting provider health", async () => {
  const bare = await githubFixture();
  let f: Factory;
  let localReviews = 0;
  let checked = false;
  const executor: AgentExecutor = {
    kind: "test",
    async run(call, local) {
      if (call.role !== "review") return local();
      const provider = call.spec.target.provider;
      f.tracker.record(provider, "unavailable");
      const health = f.store.getProviderRow(provider);
      const result = await lanAgentExecutor(f.workers, f.cfg).run(call, async () => {
        expect(f.store.getProviderRow(provider)).toEqual(health);
        checked = true;
        return local();
      });
      expect(f.store.getProviderRow(provider)).toEqual(health);
      return result;
    },
  };
  ({ f } = boot({
    executor,
    review: async () => {
      localReviews++;
    },
  }));
  f.cfg.workers.agents = ["review"];
  registerGithub(f, bare);
  const finish = simulated(f, async (job) => {
    f.workers.failAgentJob(job.id, "Disconnected");
    f.workers.failAgentJob(job.id, "Disconnected");
  });
  try {
    const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "needs_human"])).toBe("succeeded");
    expect(checked).toBe(true);
    expect(localReviews).toBe(1);
    expect(jobs(f)).toHaveLength(1);
  } finally {
    await finish();
  }
});

test("shutdown cancels review and resume runs review again", async () => {
  const bare = await githubFixture();
  let { f } = boot({ localImplement: true });
  f.cfg.workers.agents = ["review"];
  registerGithub(f, bare);
  const queued = Promise.withResolvers<void>();
  const finish = simulated(f, async () => {
    queued.resolve();
  });
  const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
  await queued.promise;
  const old = jobs(f)[0];
  if (!old) throw new Error("Missing review job");
  expect(request(old).role).toBe("review");
  await f.stop();
  await finish();
  expect(f.workers.agentJob(old.id)?.state).toBe("cancelled");
  expect(f.store.getRunState<RunState>(run.id)?.agentJob).toBeUndefined();
  f.store.close();
  const resumed = boot({ localImplement: true, deferStart: true });
  f = resumed.f;
  f.cfg.workers.agents = ["review"];
  const stop = await reviewWorker(f, async () => ({ structured: approve }));
  try {
    f.start();
    expect(await waitFor(f, run.id, ["succeeded", "needs_human"])).toBe("succeeded");
    const rows = jobs(f);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.state)).toEqual(["cancelled", "done"]);
    expect(rows[1]?.parent_sha).toBe(old.parent_sha);
    expect(resumed.locals()).toBe(0);
  } finally {
    await stop();
  }
});

test.each(workerStartupFailures)(
  "worker startup %s falls back without provider penalties",
  async (_label, error) => {
    const bare = await githubFixture();
    let f: Factory;
    let provider = "";
    let before: ReturnType<typeof snapshot> | undefined;
    let after: ReturnType<typeof snapshot> | undefined;
    const snapshot = () => {
      const { updatedAt: _time, inFlight: _slots, ...status } = f.tracker.status(provider) ?? {};
      return { tracker: status, stored: f.store.getProviderRow(provider) };
    };
    const instance = boot({
      executor: {
        kind: "test",
        async run(call, local) {
          if (call.role === "implement") {
            provider = call.spec.target.provider;
            before = snapshot();
          }
          return lanAgentExecutor(f.workers, f.cfg).run(call, () => {
            if (call.role === "implement") after = snapshot();
            return local();
          });
        },
      },
    });
    f = instance.f;

    registerGithub(f, bare);
    const listener = await startWorkerListener(f.workers, f.cfg.paths, "127.0.0.1:0", () => {});
    if (!listener) throw new Error("Missing listener");
    const remote = loadConfig({ home: join(home, "remote"), configDir: join(home, "cfg"), raw: {} });
    const controller = new AbortController();
    let task: Promise<void> | undefined;
    let attempts = 0;
    try {
      await pairWorker(listener.url.origin, join(remote.paths.home, "worker"), "worker", (text) =>
        f.workers.approve(text.split(": ")[1] ?? ""),
      );
      task = runWorker(listener.url.origin, remote, release, controller.signal, {
        platform: "darwin",
        confinement: fakeConfinement,
        heartbeatMs: 10,
        retryMs: 5,
        capabilityRunner: async () => ({ exitCode: 0, stdout: "logged in" }),
        tokenLookup: async () => "fixture-worker-token",
        machineState: async () => ({ onAC: true, idleSeconds: 0 }),
        harnesses: {
          claude: fakeHarness(() => {
            attempts++;
            // The job is already leased; expire the unclaimed retry promptly after it fails.
            f.workers.times.pickup = 1;
            return { fault: "exit", error };
          }),
        },
      });
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, run.id, ["succeeded", "needs_human"])).toBe("succeeded");
      expect(attempts).toBe(1);
      expect(instance.locals()).toBe(1);
      expect(after).toEqual(before);
      expect(jobs(f)).toMatchObject([
        { state: "failed", result: null, result_sha: null, excluded: '["worker"]' },
      ]);
      expect(jobs(f)[0]?.failure_reason).toBeTruthy();
      // Read the delivered branch: the run's worktree can be cleaned up once the run has finished.
      const delivered = f.store.getRun(run.id);
      expect(
        (await sh(["git", "show", `refs/heads/${delivered?.branch}:farewell.txt`], { cwd: bare })).stdout,
      ).toBe("local goodbye\n");
      expect(f.store.listStages(run.id).filter((stage) => stage.name === "implement")).toMatchObject([
        { status: "succeeded", summary: expect.not.stringContaining("no changes") },
      ]);
      expect(f.store.listInvocations(run.id).filter((i) => i.role === "implement")).toMatchObject([
        { status: "ok", error: null },
      ]);
    } finally {
      controller.abort();
      await task;
      await listener.stop();
    }
  },
  60_000,
);

test.each(["remoteSha", "resume", "adopt"])(
  "worker publication preserves claim interruption: %s",
  async (boundary) => {
    const bare = await githubFixture();
    const sentinel = new ClaimLostError();
    let observed: unknown;
    let reached = false;
    let interruptedState: RunState | undefined;
    let publishedBefore: string | undefined;
    const saves = spyOn(RunContext.prototype, "save");
    const executor: AgentExecutor = {
      kind: "test",
      async run(call, local) {
        const hooks = call.publication;
        if (!hooks) return local();
        const req = await hooks.prepare();
        if (!req) throw new Error("Missing publication");
        publishedBefore = f.store.getRunState<RunState>(call.runId)?.publishedSha;
        const injected =
          boundary === "remoteSha"
            ? spyOn(repos, "remoteBranchSha").mockRejectedValue(sentinel)
            : boundary === "resume"
              ? spyOn(repos, "headSha").mockRejectedValue(sentinel)
              : spyOn(repos, "adoptWorkerCommit").mockRejectedValue(sentinel);
        try {
          reached = true;
          try {
            if (boundary === "remoteSha") await hooks.prepare();
            else if (boundary === "resume") await hooks.resume(req);
            else await hooks.adopt("e".repeat(40), req);
          } catch (error) {
            observed = error;
            interruptedState = structuredClone(f.store.getRunState<RunState>(call.runId) ?? undefined);
          }
        } finally {
          injected.mockRestore();
        }
        throw sentinel;
      },
    };
    const { f, locals } = boot({ executor });
    registerGithub(f, bare);
    try {
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      expect(await waitFor(f, run.id, ["cancelled", "failed", "needs_human", "succeeded"])).toBe("cancelled");
      expect(f.store.getRun(run.id)?.error).toBe("superseded: claim lost");
      expect(reached).toBe(true);
      expect(observed).toBe(sentinel);
      expect(locals()).toBe(0);
      expect(jobs(f)).toHaveLength(0);
      expect(interruptedState?.workerCommitRound).toBeUndefined();
      expect(interruptedState?.publishedSha).toBe(publishedBefore);
      expect(saves.mock.calls.map(([reason]) => reason)).not.toContain("worker-commit-adopted");
    } finally {
      saves.mockRestore();
    }
  },
);
