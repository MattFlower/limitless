import { describe, expect } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import { type GateExecutor, gateProvenance, localExecutor } from "../src/gates/executor.ts";
import type { GateRun } from "../src/gates/run.ts";
import { browserCache, browserMcp } from "../src/harness/browser-mcp.ts";
import { RunContext, type RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import { sh } from "../src/util/proc.ts";
import { fakeBrowserCache } from "./browser-mcp-support.ts";
import { deferred } from "./evals-support.ts";
import {
  approve,
  type Handler,
  holdout,
  pass,
  pipelineSetup,
  roleOf,
  spec,
  triage,
  waitFor,
} from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start, previewFixture, wait } = pipelineSetup({
  get home() {
    return home;
  },
  set home(value) {
    home = value;
  },
  get repoDir() {
    return repoDir;
  },
  set repoDir(value) {
    repoDir = value;
  },
  get factory() {
    return factory;
  },
  set factory(value) {
    factory = value;
  },
});

describe("pipeline (fake agents, real git + gates)", () => {
  test("only live-preview verify and implement tool invocations request a browser", async () => {
    const captured: boolean[] = [];
    const f = start((agent) => {
      captured.push(!!agent.browser);
      return { text: "done" };
    });
    await f.stop();
    const run = await f.createRun({ repo: repoDir, prompt: "UI eligibility" });
    const repo = f.store.getRepo(run.repoId);
    if (!repo) throw new Error("missing repo");
    const ctx = new RunContext(f.deps, run, repo, new AbortController().signal);
    const stage = f.store.startStage(run.id, "verify", 0);
    for (const [role, preview, noTools] of [
      ["verify", true, false],
      ["implement", true, false],
      ["review", true, false],
      ["verify", false, false],
      ["verify", true, true],
    ] as const) {
      ctx.previewUrl = preview ? "http://127.0.0.1:43210" : undefined;
      const outcome = await ctx.invoke({
        role,
        stage,
        cwd: repoDir,
        mode: role === "implement" ? "edit" : "readonly",
        complexity: "small",
        prompt: "eligibility",
        noTools,
      });
      expect(outcome.result.status).toBe("ok");
    }
    expect(captured).toEqual([true, true, false, false, false]);
  });

  test.each(["unconfined pin", "missing cache", "incompatible cache", "invalid URL", "scratch failure"])(
    "no browser persists an invocation diagnostic: %s",
    async (failure) => {
      const f = start((agent) => {
        const request =
          failure === "scratch failure" ? { ...agent, scratchDir: join(home, "missing-scratch") } : agent;
        // Other cases waive the confinement gate so only the injected failure disables the browser.
        expect(browserMcp(request, "codex", failure === "unconfined pin" ? undefined : [])).toBeUndefined();
        return { text: "continued without browser" };
      });
      await f.stop();
      const cache = browserCache(f.deps.cfg.paths.home);
      await fakeBrowserCache(cache);
      if (failure === "missing cache") rmSync(cache, { recursive: true });
      if (failure === "incompatible cache")
        writeFileSync(join(cache, "node_modules/@playwright/mcp/package.json"), '{"version":"0.0.1"}');
      const run = await f.createRun({ repo: repoDir, prompt: "UI diagnostic" });
      const repo = f.store.getRepo(run.repoId);
      if (!repo) throw new Error("missing repo");
      const ctx = new RunContext(f.deps, run, repo, new AbortController().signal);
      ctx.previewUrl = failure === "invalid URL" ? "http://example.com" : "http://127.0.0.1:43210";
      const stage = f.store.startStage(run.id, "verify", 0);
      const outcome = await ctx.invoke({
        role: "verify",
        stage,
        cwd: repoDir,
        mode: "readonly",
        complexity: "small",
        prompt: "diagnostic",
      });
      expect(outcome.result.status).toBe("ok");
      expect(
        f.store.listEvents(run.id).filter((event) => event.message.startsWith("Browser disabled:")),
      ).toEqual([
        expect.objectContaining({
          invocationId: outcome.invocation.id,
          level: "warn",
          data: { code: "browser_unavailable", id: "browser-unavailable" },
          message: expect.stringMatching(
            failure === "unconfined pin"
              ? /Browser disabled: .+ not confined: .+redirects/
              : /Browser disabled: .+/,
          ),
        }),
      ]);
    },
  );
  test.each(["remote", "local", "local fallback", "local retry", "setup failure"] as const)(
    "preview prepares coordinator setup: %s",
    async (executor) => {
      await previewFixture();
      const calls = join(home, "setup-calls");
      const count = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").length : 0);
      const setup = [
        executor === "setup failure"
          ? "bun setup-failure.ts"
          : `mkdir -p .setup; echo first >> .setup/order; pwd >> '${calls}'`,
        "mkdir -p .setup; echo second >> .setup/order",
      ];
      const baseConfig = readFileSync(join(repoDir, ".limitless.toml"), "utf8")
        .replace("[gates]", `[gates]\nsetup = ${JSON.stringify(setup)}`)
        .replace('build = "', 'build = "test -f .setup/order && test $(wc -l < .setup/order) -eq 2 && ');
      writeFileSync(join(repoDir, ".limitless.toml"), baseConfig);
      writeFileSync(join(repoDir, ".gitignore"), ".setup/\n");
      writeFileSync(
        join(repoDir, "setup-failure.ts"),
        'console.error("coordinator setup diagnostic"); process.exit(1);',
      );
      await sh(["git", "add", "."], { cwd: repoDir });
      await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "setup fixture"], {
        cwd: repoDir,
      });
      const local = localExecutor();
      let executions = 0;
      const remote: GateExecutor = {
        kind: "lan",
        freshCheckoutFor: () => true,
        async start(request, signal) {
          if (++executions > 2 && executor === "local retry") return local.start(request, signal);
          return { kind: "lan", id: "remote", startedAt: Date.now() };
        },
        attach(handle, signal, request, hooks) {
          if (handle.kind === "local") return local.attach(handle, signal, request, hooks);
          if (!request) throw new Error("Missing gate request");
          const ok = executor !== "local retry" || executions !== 2;
          const result: GateRun = {
            setupOk: true,
            setup: request.gates.setup.map((command) => ({
              name: "setup",
              command,
              ok: true,
              exitCode: 0,
              durationMs: 0,
              output: "",
            })),
            checks: request.gates.checks.map(({ name, run }) => ({
              name,
              command: run,
              ok,
              exitCode: ok ? 0 : 1,
              durationMs: 0,
              output: "",
            })),
          };
          return {
            result: gateProvenance(request.cwd, signal, request.headSha).then((provenance) => ({
              ...result,
              ...provenance,
            })),
            events: { async *[Symbol.asyncIterator]() {} },
            async cancel() {},
          };
        },
      };
      // LAN routing may execute locally; readiness must follow the execution evidence.
      const gateExecutor =
        executor === "local"
          ? undefined
          : executor === "local fallback"
            ? { ...localExecutor(), kind: "lan" as const }
            : remote;
      let cwd = "";
      let beforePreview = -1;
      let duringVerify = -1;
      let verified = false;
      const f = start(
        (agent) => {
          const role = roleOf(agent);
          if (role === "triage") return { structured: triage() };
          if (role === "spec") return { structured: spec };
          if (role === "holdout") return { structured: holdout };
          if (role === "review") {
            beforePreview = count();
            expect(readFileSync(join(home, "preview-steps"), "utf8")).toBe("build\nseed\nserve\n");
            expect(readFileSync(join(cwd, ".setup/order"), "utf8")).toBe("first\nsecond\n");
            return { structured: approve };
          }
          if (role === "verify") {
            verified = true;
            expect(readFileSync(join(cwd, ".setup/order"), "utf8")).toBe("first\nsecond\n");
            duringVerify = count();
            expect(existsSync(join(cwd, ".setup/untrusted"))).toBe(false);
            return { structured: pass };
          }
          cwd = agent.cwd;
          return {
            files: {
              "ui/change.txt": "visible\n",
              ".limitless.toml": baseConfig.replace(
                `setup = ${JSON.stringify(setup)}`,
                'setup = ["mkdir -p .setup; touch .setup/untrusted"]',
              ),
            },
          };
        },
        false,
        false,
        { gateExecutor },
      );
      const run = await f.createRun({ repo: repoDir, prompt: "Change the UI" });
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        executor === "setup failure" ? "needs_human" : "succeeded",
      );
      const preview = f.store.getRunDetail(run.id)?.stages.find((stage) => stage.name === "preview");
      expect(preview?.status).toBe(executor === "setup failure" ? "failed" : "succeeded");
      const events = f.store.listEvents(run.id).filter((event) => event.type === "gate");
      const previewSetup = events.filter((event) => event.message.startsWith("preview setup:"));
      expect(previewSetup).toMatchObject(
        executor === "remote"
          ? setup.map((command) => ({
              level: "info",
              message: expect.stringContaining("preview setup: pass"),
              data: { command, ok: true },
            }))
          : executor === "setup failure"
            ? [
                {
                  level: "warn",
                  message: expect.stringContaining("preview setup: FAIL"),
                  data: { command: setup[0], ok: false },
                },
              ]
            : [],
      );
      if (executor === "local")
        expect(events.some((event) => event.message.startsWith("setup-1: pass"))).toBe(true);
      if (executor === "setup failure") {
        expect(f.store.listStages(run.id).find((stage) => stage.name === "verify")).toMatchObject({
          status: "failed",
          summary: expect.stringContaining("Preview setup failed"),
        });
        expect(preview?.summary).toContain(`Preview setup failed: $ ${setup[0]}`);
        expect(preview?.summary).toContain("coordinator setup diagnostic");
        expect(existsSync(join(cwd, ".setup/order"))).toBe(false);
        expect(existsSync(join(home, "preview-steps"))).toBe(false);
        expect(verified).toBe(false);
        expect(beforePreview).toBe(-1);
      } else {
        expect(verified).toBe(true);
        expect(duringVerify).toBe(beforePreview);
        expect(
          readFileSync(calls, "utf8")
            .trim()
            .split("\n")
            .every((path) => realpathSync(path) === realpathSync(cwd)),
        ).toBe(true);
        expect(readFileSync(join(home, "preview-steps"), "utf8")).toBe("build\nseed\nserve\n");
      }
    },
  );

  test.each(["pass", "unmet", "error", "legacy"] as const)(
    "base preview survives config edits and cleans up after verify %s",
    async (outcome) => {
      await previewFixture();
      let runId = "";
      const previews: { url: string; scratch: string }[] = [];
      const assertStopped = async () => {
        for (const { url, scratch } of previews) {
          expect(existsSync(scratch)).toBe(false);
          await expect(fetch(`${url}/health`)).rejects.toThrow();
        }
      };
      const handler: Handler = async (agent) => {
        const role = roleOf(agent);
        if (role === "triage") return { structured: triage() };
        if (role === "spec") return { structured: spec };
        if (role === "holdout") return { structured: holdout };
        if (role === "review") return { structured: approve };
        if (role === "verify") {
          const stage = factory?.store
            .getRunDetail(runId)
            ?.stages.filter((entry) => entry.name === "preview")
            .at(-1);
          expect(stage?.status).toBe("succeeded");
          const url = stage?.summary?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
          expect(agent.browser?.previewUrl).toBe(url);
          expect(browserMcp(agent, "codex")).toBeUndefined();
          const browser = browserMcp(agent, "codex", []);
          expect(browser?.args[(browser?.args.indexOf("--allowed-origins") ?? -2) + 1]).toBe(url);
          const response = await fetch(`${url}/health`);
          expect(await response.text()).toBe("seeded\n");
          const scratch = response.headers.get("x-scratch") ?? "";
          expect(existsSync(scratch)).toBe(true);
          previews.push({ url, scratch });
          if (outcome === "error") throw new Error("injected verifier failure");
          if (outcome === "unmet" && previews.length === 1)
            return {
              structured: {
                ...pass,
                overall: "fail",
                criteria: pass.criteria.map((c) => (c.id === "AC-1" ? { ...c, status: "unmet" } : c)),
              },
            };
          return { structured: pass };
        }
        await assertStopped();
        return {
          files: {
            "ui/change.txt": `visible ${previews.length}\n`,
            // Removing the table must not disable the trusted base preview.
            ".limitless.toml":
              readFileSync(join(repoDir, ".limitless.toml"), "utf8").split("[preview]")[0] ?? "",
          },
        };
      };
      const f = start(handler);
      await fakeBrowserCache(browserCache(f.deps.cfg.paths.home));
      const run = await f.createRun({ repo: repoDir, prompt: "Change the UI" });
      runId = run.id;
      expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe(
        outcome === "error" ? "needs_human" : "succeeded",
      );
      expect(previews.length).toBeGreaterThan(0);
      await assertStopped();
      const state = f.store.getRunState<RunState>(run.id);
      expect(state?.previewConfig?.paths).toEqual(["ui/"]);
      if (outcome === "unmet") expect(previews).toHaveLength(2);
      if ((outcome !== "pass" && outcome !== "legacy") || !state) return;
      // Replay the persisted round after its verdict was saved, before phase advancement.
      const steps = readFileSync(join(home, "preview-steps"), "utf8");
      expect(steps).toBe("build\nseed\nserve\n");
      await f.stop();
      // Simulate an older run: restore the enabled config from base despite its removal in HEAD.
      if (outcome === "legacy") delete state.previewConfig;
      f.store.setRunState(run.id, { ...state, phase: "loop" });
      f.store.updateRun(run.id, { status: "queued", finishedAt: null });
      f.store.close();
      factory = null;
      const resumed = start(handler);
      expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
      expect(resumed.store.getRunState<RunState>(run.id)?.previewConfig?.paths).toEqual(["ui/"]);
      expect(previews).toHaveLength(2);
      await assertStopped();
      expect(readFileSync(join(home, "preview-steps"), "utf8")).toBe(steps + steps);
      expect(
        resumed.store.getRunDetail(run.id)?.stages.filter((entry) => entry.name === "preview"),
      ).toHaveLength(2);
    },
  );

  test.each([
    "paths = []",
    'paths = ["ui/"]\nbuild="true"\nserve="true"\nready="/health"\nenv={HOME="{scratch}/../escape"}',
    'paths = ["ui/"]\nbuild="true"\nserve="true"\nready=\'/\\evil.example/x\'\nenv={}',
  ])("invalid base preview fails prepare without model spend: %s", async (invalid) => {
    writeFileSync(join(repoDir, ".limitless.toml"), `[preview]\n${invalid}\n`);
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "invalid preview"], {
      cwd: repoDir,
    });
    let calls = 0;
    const f = start(() => {
      calls++;
      return {};
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Change the UI" });
    expect(await waitFor(f, run.id, ["failed", "succeeded", "needs_human"])).toBe("failed");
    expect(calls).toBe(0);
    expect(f.store.listInvocations(run.id)).toHaveLength(0);
    expect(f.store.getRun(run.id)?.error).toContain("Invalid [preview]");
    expect(f.store.getRunDetail(run.id)?.stages.map((stage) => [stage.name, stage.status])).toEqual([
      ["prepare", "failed"],
    ]);
  });

  test.each(["missing base SHA", "missing worktree", "invalid base preview"])(
    "legacy preview backfill fails before model calls: %s",
    async (problem) => {
      if (problem === "invalid base preview") {
        writeFileSync(join(repoDir, ".limitless.toml"), "[preview]\npaths=[]\n");
        await sh(["git", "add", "."], { cwd: repoDir });
        await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "invalid preview"], {
          cwd: repoDir,
        });
        // A repaired worktree must not hide an invalid trusted base.
        writeFileSync(join(repoDir, ".limitless.toml"), "");
      }
      let calls = 0;
      const f = start(() => {
        calls++;
        return {};
      });
      await f.stop();
      const run = await f.createRun({ repo: repoDir, prompt: "Resume an older run" });
      const baseSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
      if (problem !== "missing base SHA") f.store.updateRun(run.id, { baseSha });
      const state: RunState = {
        phase: "triage",
        worktreePath: problem === "missing worktree" ? undefined : repoDir,
        answers: [],
        round: 0,
        roundsOnImplementer: 0,
        triedImplementers: [],
        feedback: null,
        toolCommands: [],
      };
      f.store.setRunState(run.id, state);
      expect(await executeRun(f.deps, run.id, new AbortController().signal)).toBe("failed");
      expect(calls).toBe(0);
      expect(f.store.listInvocations(run.id)).toHaveLength(0);
      expect(f.store.getRun(run.id)?.error).toContain(
        problem === "invalid base preview" ? "Invalid [preview]" : "missing base SHA or worktree",
      );
      expect(f.store.getRunState<RunState>(run.id)?.previewConfig).toBeUndefined();
    },
  );

  test.each(["gates only", "no config file"])("legacy resume backfills absent preview: %s", async (base) => {
    const baseConfig = base === "gates only" ? readFileSync(join(repoDir, ".limitless.toml"), "utf8") : "";
    if (base === "no config file") {
      await sh(["git", "rm", ".limitless.toml"], { cwd: repoDir });
      await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "remove config"], {
        cwd: repoDir,
      });
    }
    const calls: string[] = [];
    let resumedRunId: string | undefined;
    const handler: Handler = (agent) => {
      if (resumedRunId) expect(factory?.store.getRunState<RunState>(resumedRunId)?.previewConfig).toBeNull();
      const role = roleOf(agent);
      calls.push(role);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") return { structured: holdout };
      if (role === "review") return { structured: approve };
      if (role === "verify") return { structured: pass };
      return {
        files: {
          "ui/change.txt": "visible\n",
          ".limitless.toml": `${baseConfig}\n[preview]\npaths=[]\n`,
        },
      };
    };
    const f = start(handler);
    const run = await f.createRun({ repo: repoDir, prompt: "Change the UI" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const state = f.store.getRunState<RunState>(run.id);
    expect(state?.previewConfig).toBeNull();
    expect(f.store.getRunDetail(run.id)?.stages.some((stage) => stage.name === "preview")).toBe(false);
    if (!state) throw new Error("Missing state");
    await f.stop();
    delete state.previewConfig;
    state.phase = "loop";
    f.store.setRunState(run.id, state);
    f.store.updateRun(run.id, { status: "queued", finishedAt: null });
    f.store.close();
    factory = null;
    const before = calls.length;
    resumedRunId = run.id;
    const resumed = start(handler);
    expect(await waitFor(resumed, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(calls.slice(before).sort()).toEqual(["review", "verify"]);
    expect(resumed.store.getRunState<RunState>(run.id)?.previewConfig).toBeNull();
    expect(resumed.store.getRunDetail(run.id)?.stages.some((stage) => stage.name === "preview")).toBe(false);
  });
});

test.each(["review", "verify", "cancel"] as const)(
  "holdout and preview precede both readers; preview survives the join on %s",
  async (failure) => {
    await previewFixture();
    const holdoutReady = deferred<void>();
    const release = { review: deferred<void>(), verify: deferred<void>() };
    let readers = 0;
    const f = start(async (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage() };
      if (role === "spec") return { structured: spec };
      if (role === "holdout") {
        await holdoutReady.promise;
        return { structured: holdout };
      }
      if (role === "review" || role === "verify") {
        expect(readFileSync(join(home, "preview-steps"), "utf8")).toBe("build\nseed\nserve\n");
        readers++;
        await release[role].promise;
        return { structured: role === "review" ? approve : pass };
      }
      return { files: { "ui/change.txt": "visible\n" } };
    });
    await f.stop();
    f.deps.faults = failure === "cancel" ? undefined : { [`stage:${failure}:after`]: { action: "throw" } };
    const run = await f.createRun({ repo: repoDir, prompt: "Change UI", profile: "standard" });
    const controller = new AbortController();
    let settled = false;
    const executing = executeRun(f.deps, run.id, controller.signal).finally(() => {
      settled = true;
    });
    try {
      await wait(
        () => f.store.listStages(run.id).some((s) => s.name === "audit" && s.status === "succeeded"),
        { timeoutMs: 5000 },
      );
      expect(readers).toBe(0);
      expect(f.store.listStages(run.id).some((s) => ["review", "verify", "preview"].includes(s.name))).toBe(
        false,
      );
      holdoutReady.resolve();
      await wait(() => readers === 2, { timeoutMs: 5000 });
      const preview = f.store.listStages(run.id).find((s) => s.name === "preview");
      expect(preview?.status).toBe("succeeded");
      const url = preview?.summary?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
      const response = await fetch(`${url}/health`);
      const scratch = response.headers.get("x-scratch") ?? "";
      expect(existsSync(scratch)).toBe(true);
      const first = failure === "review" ? "review" : "verify";
      if (failure === "cancel") controller.abort();
      release[first].resolve();
      await wait(() => f.store.listStages(run.id).some((s) => s.name === first && s.status !== "running"), {
        timeoutMs: 5000,
      });
      expect(settled).toBe(false);
      if (failure !== "cancel") {
        expect(existsSync(scratch)).toBe(true);
        expect(await (await fetch(`${url}/health`)).text()).toBe("seeded\n");
      }
      release[first === "review" ? "verify" : "review"].resolve();
      expect(await executing).toBe(failure === "cancel" ? "cancelled" : "queued");
      expect(f.store.listStages(run.id).some((s) => s.status === "running")).toBe(false);
      expect(existsSync(scratch)).toBe(false);
      await expect(fetch(`${url}/health`)).rejects.toThrow();
    } finally {
      holdoutReady.resolve();
      release.review.resolve();
      release.verify.resolve();
      await executing;
    }
  },
);
