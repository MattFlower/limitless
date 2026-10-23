import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeGate, type GateRequest } from "../src/gates/executor.ts";
import type { GateRun } from "../src/gates/run.ts";
import { gateSlots } from "../src/gates/slots.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { type AgentCall, localAgentExecutor } from "../src/pipeline/agent-executor.ts";
import { RunContext } from "../src/pipeline/context.ts";
import { reviewPrompt } from "../src/pipeline/prompts.ts";
import { productionReviewSystem } from "../src/pipeline/review-system.ts";
import { reloadFixture } from "./config-reload-support.ts";

test("mixed reloads apply only live keys, compare against active overrides, and record names only", () => {
  const f = reloadFixture('[server]\nport = 7400\n[review]\nimplementer_report = "include"\n');
  const initialSecrets = f.factory.cfg.secrets;
  const sentinel = crypto.randomUUID();
  writeFileSync(join(f.configDir, "secrets.env"), `OPENROUTER_API_KEY=${sentinel}\n`);
  f.write(
    `[server]\nport = 7500\n[limits]\nmax_concurrent_runs = 4\nmax_concurrent_gates = 5\n[review]\nimplementer_report = "omit"\n[workers]\nlisten = "127.0.0.1:7501"\nagents = ["implement"]\nrepos = ["test/repo"]\n[local]\nremote_host = "${sentinel}"\n`,
  );
  const result = f.factory.reloadConfig();
  expect(result).toEqual({
    applied: [
      "limits.max_concurrent_gates",
      "limits.max_concurrent_runs",
      "review.implementer_report",
      "workers.agents",
      "workers.repos",
    ],
    restartRequired: ["local.remote_host", "server.port", "workers.listen"],
    unchanged: [],
  });
  expect(f.factory.cfg.port).toBe(7400);
  expect(f.factory.cfg.workers.listen).toBeUndefined();
  expect(f.factory.deps.agentExecutor).toBeUndefined();
  expect(f.factory.cfg.raw.server).toEqual({ port: 7400 });
  expect(f.factory.cfg.raw.workers).toEqual({ agents: ["implement"], repos: ["test/repo"] });
  expect(f.factory.cfg.secrets).toBe(initialSecrets);
  expect(gateSlots.limit).toBe(5);
  expect(f.factory.reloadConfig()).toEqual({
    applied: [],
    restartRequired: result.restartRequired,
    unchanged: result.applied,
  });
  const items = f.factory.store.readFeed().items;
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({
    kind: "config.reloaded",
    data: { applied: result.applied, restartRequired: result.restartRequired },
  });
  expect(Object.keys(items[0]?.data ?? {}).sort()).toEqual(["applied", "restartRequired"]);
  expect(JSON.stringify({ result, items })).not.toContain(sentinel);
  expect(JSON.stringify({ result, items })).not.toContain("7500");
  f.write("[server]\nport = 7400\n");
  expect(f.factory.reloadConfig()).toEqual({
    applied: result.applied,
    restartRequired: [],
    unchanged: ["server.port"],
  });
  expect(f.factory.cfg.reviewImplementerReport).toBe("include");
  expect(f.factory.cfg.raw.review).toBeUndefined();
  expect(f.factory.cfg.workers.agents).toEqual([]);
  expect(f.factory.reloadConfig()).toEqual({ applied: [], restartRequired: [], unchanged: ["server.port"] });
  expect(f.factory.store.readFeed().items).toHaveLength(4);
});

test("invalid TOML and semantic validation leave config, executors, limits and comparison unchanged", () => {
  const f = reloadFixture('[workers]\nlisten = "127.0.0.1:7501"\nagents = ["implement"]\n');
  const cfg = f.factory.cfg;
  const agent = f.factory.deps.agentExecutor;
  const gate = f.factory.deps.gateExecutor;
  const limit = gateSlots.limit;
  for (const text of [
    "[invalid",
    '[review]\nmode = "wrong"',
    '[limits]\nmax_concurrent_gates = 10\n[workers]\nagents = ["unknown"]',
  ]) {
    f.write(text);
    expect(() => f.factory.reloadConfig()).toThrow();
    expect(f.factory.cfg).toBe(cfg);
    expect(f.factory.deps.agentExecutor).toBe(agent);
    expect(f.factory.deps.gateExecutor).toBe(gate);
    expect(gateSlots.limit).toBe(limit);
    expect(f.factory.store.readFeed().items).toEqual([]);
  }
  f.write('[workers]\nlisten = "127.0.0.1:7501"\nagents = ["implement"]\n');
  expect(f.factory.reloadConfig().applied).toEqual([]);
});

test("removing a non-live nested key keeps its active value and reports its TOML path repeatedly", () => {
  const f = reloadFixture('[custom]\n"key.with.dots" = { enabled = true }\n');
  f.write("");
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(f.factory.reloadConfig()).toEqual({
      applied: [],
      restartRequired: ['custom."key.with.dots".enabled'],
      unchanged: [],
    });
    expect(f.factory.cfg.raw.custom).toEqual({ "key.with.dots": { enabled: true } });
  }
});

test("empty non-live tables are reported without changing the active raw configuration", () => {
  const f = reloadFixture("[limits]\n[custom]\n");
  f.write("[newtable]\n");
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(f.factory.reloadConfig()).toEqual({
      applied: [],
      restartRequired: ["custom", "limits", "newtable"],
      unchanged: [],
    });
    expect(f.factory.cfg.raw).toEqual({ limits: {}, custom: {} });
  }
});

test("review roster validation uses the active catalog and does not partially reload", () => {
  const f = reloadFixture();
  f.write(
    '[limits]\nmax_concurrent_gates = 8\n[review]\nmode = "panel"\nrosters.quick = [{target = "missing/model", prompt = "standard"}]\n',
  );
  const before = f.factory.cfg;
  expect(() => f.factory.reloadConfig()).toThrow("Invalid review rosters");
  expect(f.factory.cfg).toBe(before);
  expect(gateSlots.limit).toBe(before.maxConcurrentGates);
  expect(f.factory.store.readFeed().items).toEqual([]);
});

test("a lower gate limit lets occupied slots finish before admitting another suite", async () => {
  const f = reloadFixture("[limits]\nmax_concurrent_gates = 1\n");
  const signal = new AbortController().signal;
  const releaseFirst = await gateSlots.acquire(signal);
  f.write("[limits]\nmax_concurrent_gates = 2\n");
  f.factory.reloadConfig();
  const releaseSecond = await gateSlots.acquire(signal);
  f.write("[limits]\nmax_concurrent_gates = 1\n");
  f.factory.reloadConfig();
  let admitted = false;
  const next = gateSlots.acquire(signal).then((release) => {
    admitted = true;
    return release;
  });
  try {
    await Promise.resolve();
    expect(admitted).toBe(false);
    releaseFirst();
    await Promise.resolve();
    expect(admitted).toBe(false);
    releaseSecond();
    (await next)();
  } finally {
    releaseFirst();
    releaseSecond();
    (await next)();
  }
});

test("overlapping stages retain independent review snapshots and later stages see reloads", async () => {
  const f = reloadFixture('[review]\nimplementer_report = "include"\n');
  const repo = f.factory.store.upsertRepo({
    slug: "test/repo",
    kind: "local",
    localPath: f.home,
    url: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = f.factory.store.createRun(repo, { repo: repo.slug, prompt: "test" });
  const ctx = new RunContext(f.factory.deps, run, repo, new AbortController().signal);
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const prompt = () =>
    reviewPrompt({
      prompt: "work",
      spec: null,
      baseSha: "a".repeat(40),
      stat: "",
      gates: [],
      audit: [],
      implementerReport: "REPORT_SENTINEL",
      implementerReportMode: productionReviewSystem(ctx.deps.cfg).implementerReport,
    });
  const original = ctx.stage("review", async () => {
    expect(prompt()).toContain("REPORT_SENTINEL");
    started.resolve();
    await release.promise;
    return { summary: "reviewed", value: prompt() };
  });
  await started.promise;
  try {
    f.write('[review]\nimplementer_report = "omit"\n');
    f.factory.reloadConfig();
    await ctx.stage(
      "holdout",
      async () => {
        expect(prompt()).not.toContain("REPORT_SENTINEL");
        f.write('[review]\nimplementer_report = "include"\n');
        f.factory.reloadConfig();
        await Promise.resolve();
        expect(prompt()).not.toContain("REPORT_SENTINEL");
        release.resolve();
        expect(await original).toContain("REPORT_SENTINEL");
        return { summary: "overlap", value: undefined };
      },
      0,
      true,
    );
    expect(await ctx.stage("review", async () => ({ summary: "later", value: prompt() }))).toContain(
      "REPORT_SENTINEL",
    );
  } finally {
    release.resolve();
    await original;
  }
});

const workerConfig = (agents: string[], repos = ["test/repo"]) =>
  `[workers]\nlisten = "127.0.0.1:7501"\nagents = ${JSON.stringify(agents)}\nrepos = ${JSON.stringify(repos)}\n[gates]\nexecutor = "lan"\n`;

test.each(["implement", "review"] as const)(
  "%s routing reloads preserve the selected LAN call",
  async (role) => {
    const f = reloadFixture(workerConfig([]));
    const spec: AgentSpec = {
      cwd: f.home,
      mode: role === "implement" ? "edit" : "readonly",
      prompt: role,
      timeoutMs: 1000,
      idleTimeoutMs: 1000,
      maxToolCalls: 10,
      signal: new AbortController().signal,
      logPath: join(f.home, "log"),
      onEvent() {},
      target: {
        provider: "test",
        modelId: "test/model",
        model: "model",
        vendor: "test",
        harness: "claude",
        billing: "subscription",
        tier: 1,
      },
    };
    const call: AgentCall = {
      runId: "run",
      invocationId: 1,
      role,
      repoSlug: "test/repo",
      worktree: f.home,
      spec,
      checkout: { parentSha: "a".repeat(40), baseSha: "a".repeat(40), branch: "change/test" },
      shadow: false,
      private: false,
      denyRead: undefined,
      slottedCommands: [],
      dispatch() {},
    };
    if (role === "implement")
      call.publication = {
        started: async () => {},
        resume: async () => true,
        prepare: async () => ({
          parentSha: "a".repeat(40),
          baseSha: "a".repeat(40),
          branch: "change/test",
          commit: {
            message: "Change",
            authorName: "Test",
            authorEmail: "test@example.com",
            committerName: "Test",
            committerEmail: "test@example.com",
          },
          repoUrl: "https://github.com/test/repo.git",
          expectedRemoteSha: null,
          discreet: false,
          privateStringsDigest: "c".repeat(64),
        }),
        adopt: async () => {},
        remoteSha: async () => null,
      };
    const local = () => fakeHarness(() => ({ text: "local" }))(spec);
    const invoke = () => (f.factory.deps.agentExecutor ?? localAgentExecutor).run(call, local);
    expect((await invoke()).finalText).toBe("local");
    f.write(workerConfig([role]));
    f.factory.reloadConfig();
    expect(f.factory.deps.agentExecutor?.kind).toBe("lan");
    const started = Promise.withResolvers<string>();
    call.dispatch = () => {
      const job = f.factory.store.db
        .query<{ id: string }, []>("SELECT id FROM agent_jobs WHERE state='queued'")
        .get();
      if (!job) throw new Error("Missing dispatched worker job");
      started.resolve(job.id);
    };
    const running = invoke();
    const id = await started.promise;
    try {
      f.write(workerConfig([]));
      f.factory.reloadConfig();
      expect(f.factory.deps.agentExecutor).toBeUndefined();
      expect((await invoke()).finalText).toBe("local");
      f.write(workerConfig([role], ["test/other"]));
      f.factory.reloadConfig();
      expect((await invoke()).finalText).toBe("local");
      const report = {
        ...(await fakeHarness(() => ({ text: "remote" }))(spec)),
        parentSha: "a".repeat(40),
        branch: "change/test",
        sha: "a".repeat(40),
        ...(role === "implement" ? { privateStringsDigest: "c".repeat(64) } : {}),
      };
      f.factory.store.db.query("UPDATE agent_jobs SET state='leased' WHERE id=?").run(id);
      expect(f.factory.workers.completeAgentJob(id, report, "a".repeat(40))).toBe(true);
      expect((await running).finalText).toBe("remote");
    } finally {
      f.factory.workers.cancelAgentJob(id);
      await running;
    }
  },
);

test("gate repository reloads preserve an in-flight execution and keep the active executor mode", async () => {
  const f = reloadFixture(workerConfig([]));
  const req: GateRequest = {
    repo: "test/repo",
    cwd: f.home,
    baseSha: "a".repeat(40),
    headSha: "a".repeat(40),
    gates: { setup: [], checks: [], source: "none", protectedPaths: [] },
  };
  const started = Promise.withResolvers<string>();
  const pending = executeGate(
    req,
    new AbortController().signal,
    {},
    f.factory.deps.gateExecutor,
    undefined,
    async (h) => {
      started.resolve(h.id);
    },
  );
  const id = await started.promise;
  try {
    f.write(workerConfig([], ["test/other"]).replace('executor = "lan"', 'executor = "local"'));
    expect(f.factory.reloadConfig().restartRequired).toEqual(["gates.executor"]);
    const executor = f.factory.deps.gateExecutor;
    expect(executor?.kind).toBe("lan");
    expect(executor?.freshCheckoutFor?.("test/repo")).toBe(false);
    expect(executor?.freshCheckoutFor?.("test/other")).toBe(true);
    expect((await executor?.start(req, new AbortController().signal))?.kind).toBe("local");
    expect((await executor?.start({ ...req, repo: "test/other" }, new AbortController().signal))?.kind).toBe(
      "lan",
    );
    const result: GateRun = { setup: [], checks: [], setupOk: true };
    f.factory.store.db
      .query("UPDATE gate_jobs SET state='done',result=? WHERE id=?")
      .run(JSON.stringify(result), id);
    expect(await pending).toEqual(result);
  } finally {
    f.factory.workers.cancel(id);
    await pending.catch(() => {});
  }
});
