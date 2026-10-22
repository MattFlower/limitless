import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { Stage, StageName } from "../src/core/types.ts";
import type { AgentJobRequest, AgentJobRow } from "../src/db/workers.ts";
import { headSha } from "../src/git/repos.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import type { AgentExecutor } from "../src/pipeline/agent-executor.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import type { FaultPlan } from "../src/pipeline/faults.ts";
import { lanAgentExecutor } from "../src/pipeline/lan-agent.ts";
import { startWorkerListener } from "../src/server/workers.ts";
import { sh } from "../src/util/proc.ts";
import { pairWorker, runWorker } from "../src/workers/client.ts";
import { fakeConfinement } from "./confinement.ts";
import { approve, pipelineSetup, providers, roleOf, triage, waitFor } from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";

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
  options: { executor?: AgentExecutor; review?: (s: AgentSpec) => Promise<void>; faults?: FaultPlan } = {},
) {
  let locals = 0;
  const f = start(() => ({}), false, false, {
    bootSha: release,
    providers: providers.map((p) => ({ ...p, harness: "claude" })),
    harnesses: {
      claude: fakeHarness(async (s) => {
        if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
        if (roleOf(s) === "review") {
          await options.review?.(s);
          return { structured: approve };
        }
        locals++;
        return { files: { "farewell.txt": "local goodbye\n" } };
      }),
    },
    agentExecutor: options.executor,
    faults: options.faults,
  });
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
      confinement: fakeConfinement,
      heartbeatMs: 10,
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
  const enqueue = spyOn(f.workers, "enqueueAgentJob").mockImplementation((req) => {
    const id = original(req);
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
async function publish(bare: string, req: AgentJobRequest, wrong = false) {
  await sh(["git", "fetch", bare, req.parentSha], { cwd: repoDir });
  await sh(["git", "reset", "--hard", req.parentSha], { cwd: repoDir });
  writeFileSync(join(repoDir, "farewell.txt"), `worker goodbye ${req.parentSha}\n`);
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

test("restart after the adoption move recovers the lease from HEAD", async () => {
  const bare = await githubFixture();
  const { f } = boot({
    faults: { "store:save": { action: "kill", when: (c) => c.checkpoint === "worker-commit-adopted" } },
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
  expect(state.publishedSha).toBeUndefined();
  f.store.close();
  const { f: resumed, locals } = boot();
  const complete = simulated(resumed, async (job, req) =>
    report(resumed, job, req, await publish(bare, req)),
  );
  try {
    expect(await waitFor(resumed, run.id, ["succeeded", "needs_human"])).toBe("succeeded");
    const second = jobs(resumed)[1];
    if (!second?.result_sha) throw new Error("Missing resumed job");
    expect(request(second)).toMatchObject({
      parentSha: first.result_sha,
      expectedRemoteSha: first.result_sha,
    });
    expect(
      (await sh(["git", "log", "--format=%H", "-3", second.result_sha], { cwd: bare })).stdout
        .trim()
        .split("\n"),
    ).toEqual([second.result_sha, first.result_sha, first.parent_sha]);
    expect(resumed.store.getRunState<RunState>(run.id)?.publishedSha).toBe(second.result_sha);
    expect(locals()).toBe(0);
  } finally {
    await complete();
  }
});

function approveSimulated(f: Factory) {
  f.workers.pairingKey = "fixture-pairing-key";
  const pending = f.workers.pair("simulated", "fingerprint", "coordinator");
  f.workers.approve(pending.code);
  const worker = f.workers.worker("simulated");
  if (!worker) throw new Error("Missing worker");
  f.workers.heartbeat(worker, {
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
  });
  return worker;
}

test.each([false, true])("restart cancels a leased job (pushed=%s)", async (pushed) => {
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
  f.workers.cancelOpenAgentJobs();
  await finish();
  expect(jobs(f)[0]?.state).toBe("cancelled");
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
      expect(resumed.store.getRun(run.id)?.error).toContain("worker commit was not adopted");
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

test("cancelling a waiting run reports its leased job on the next heartbeat", async () => {
  const bare = await githubFixture();
  const { f, locals } = boot();
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
    f.cancelRun(run.id);
    expect(await waitFor(f, run.id, ["cancelled"])).toBe("cancelled");
    expect(f.workers.agentJob(id)?.state).toBe("cancelled");
    const caps = JSON.parse(f.workers.worker(worker.name)?.capabilities ?? "{}");
    expect(f.workers.heartbeat(worker, { ...caps, jobs: [id] }).cancelled).toEqual([id]);
    expect(locals()).toBe(0);
  } finally {
    await finish();
  }
});

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
