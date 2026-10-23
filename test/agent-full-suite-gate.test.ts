import { expect, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { Factory } from "../src/app.ts";
import { type GateExecutor, type GateRequest, localExecutor } from "../src/gates/executor.ts";
import type { GateComparison } from "../src/gates/run.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { agentEnv, registerCredential, sh } from "../src/util/proc.ts";
import { approve, pipelineSetup, roleOf, triage, waitFor } from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";

const fixture: { home: string; repoDir: string; factory: Factory | null } = {
  home: "",
  repoDir: "",
  factory: null,
};
const { start } = pipelineSetup(fixture);

async function configure(onlyTest = false, noTest = false) {
  writeFileSync(
    join(fixture.repoDir, ".limitless.toml"),
    `[gates]
setup = ${onlyTest ? "[]" : '["echo setup"]'}
checks = [${onlyTest ? "" : '{name="lint",run="echo lint"},'}${noTest ? "" : '{name="test",run="echo trusted-test"}'}]
[limits]
slotted_commands = ["bun test"]
agent_full_suite = "gate"
`,
  );
  await sh(["git", "add", ".limitless.toml"], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "trusted gate policy"], { cwd: fixture.repoDir });
}

test.each([
  "same",
  "only-test",
  "changed",
  "config",
  "env",
  "missing",
  "corrupt",
  "invalid",
  "lookup",
  "print-only",
  "no-build",
  "lan",
  "no-test",
  "timeout",
  "cancelled",
  "confinement",
  "setup-fail",
])("implement snapshot and round gate reuse: %s", async (scenario) => {
  await configure(scenario === "only-test", scenario === "no-test");
  const requests: GateRequest[] = [];
  let tree = "",
    worktree = "",
    snapshotDir = "";
  const executor = localExecutor();
  const recording: GateExecutor = {
    ...executor,
    ...(scenario === "lan" ? { kind: "lan" as const } : {}),
    async start(request, signal) {
      requests.push(request);
      if (worktree && request.priority === "start") {
        snapshotDir = request.cwd;
        expect(request.cwd).not.toBe(worktree);
        expect(request.checks).toEqual(["test"]);
        expect(request.gates.setup).toEqual(scenario === "only-test" ? [] : ["echo setup"]);
        expect(readFileSync(join(request.cwd, "farewell.txt"), "utf8")).toBe("goodbye\n");
        expect(readFileSync(join(request.cwd, "greeting.txt"), "utf8")).toBe("edited\n");
        tree = request.headSha;
      }
      return executor.start(request, signal);
    },
    attach(handle, signal, request, hooks) {
      const execution = executor.attach(handle, signal, request, hooks);
      if (!worktree || request?.priority !== "start") return execution;
      return {
        ...execution,
        result: execution.result.then((run) => {
          if (scenario === "setup-fail")
            return {
              setupOk: false,
              setup: [
                {
                  name: "setup",
                  command: "echo setup",
                  ok: false,
                  exitCode: 9,
                  durationMs: 1,
                  output: "setup failed",
                },
              ],
              checks: [],
            };
          return {
            ...run,
            checks: run.checks.map((check) =>
              scenario === "timeout"
                ? { ...check, ok: false, timedOut: true, exitCode: null }
                : scenario === "cancelled"
                  ? { ...check, ok: false, exitCode: 130 }
                  : scenario === "confinement"
                    ? { ...check, ok: false, exitCode: 1, confinementError: true }
                    : check,
            ),
          };
        }),
      };
    },
  };
  let lookup: ReturnType<typeof spyOn> | undefined;
  const f = start(
    async (agent) => {
      const role = roleOf(agent);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      worktree = agent.cwd;
      writeFileSync(join(worktree, "greeting.txt"), "edited\n");
      writeFileSync(join(worktree, "farewell.txt"), "goodbye\n");
      const git = async (...args: string[]) =>
        (await sh(["git", ...args], { cwd: worktree, env: agentEnv() })).stdout;
      const beforeHead = await git("rev-parse", "HEAD");
      const indexPath = resolve(worktree, (await git("rev-parse", "--git-path", "index")).trim());
      const beforeIndex = readFileSync(indexPath);
      const beforeStatus = await git("status", "--porcelain");
      if (scenario !== "print-only") {
        const directory = agent.commandPath?.split(delimiter)[0];
        if (!directory) throw new Error("missing wrapper");
        const result = await sh([join(directory, "bun"), "test", "--agent-chosen-arguments"], {
          cwd: worktree,
          env: agentEnv(),
          allowFail: true,
        });
        const refused = scenario === "lan" || scenario === "no-test";
        const failed = ["timeout", "cancelled", "confinement", "setup-fail"].includes(scenario);
        expect(result.exitCode).toBe(scenario === "setup-fail" ? 9 : refused || failed ? 1 : 0);
        if (!refused) {
          expect(result.stdout).toContain(
            `Factory gate run of check test on tree ${tree}: ${failed ? "FAIL" : "pass"}`,
          );
          expect(result.stdout).toContain(scenario === "setup-fail" ? "setup failed" : "trusted-test");
        }
      } else agent.onEvent({ type: "text", text: "bun test: 100 pass, 0 fail (factory gate passed)" });
      expect(await git("rev-parse", "HEAD")).toBe(beforeHead);
      expect(await git("status", "--porcelain")).toBe(beforeStatus);
      expect(readFileSync(indexPath)).toEqual(beforeIndex);
      expect(readFileSync(join(worktree, "farewell.txt"), "utf8")).toBe("goodbye\n");
      expect(readFileSync(join(worktree, "greeting.txt"), "utf8")).toBe("edited\n");
      if (scenario === "changed") writeFileSync(join(worktree, "later.txt"), "after snapshot\n");
      if (scenario === "config" || scenario === "env")
        f.store.db.exec(
          `UPDATE agent_gate_executions SET ${scenario === "config" ? "gates_hash" : "env_hash"} = 'different'`,
        );
      if (scenario === "missing") f.store.db.exec("DELETE FROM agent_gate_executions");
      if (scenario === "corrupt") f.store.db.exec("UPDATE agent_gate_executions SET gate_run = '{'");
      if (scenario === "invalid")
        f.store.db.exec(
          `UPDATE agent_gate_executions SET gate_run = '{"name":"test","verdict":"pass","blocking":false,"result":{"ok":true}}'`,
        );
      if (scenario === "lookup")
        lookup = spyOn(f.store, "getAgentGate").mockImplementation(() => {
          throw new Error("lookup unavailable");
        });
      return { text: "implemented" };
    },
    false,
    false,
    { gateExecutor: recording, ...(scenario === "no-build" ? { bootSha: undefined } : {}) },
  );
  try {
    const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell.txt" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const reuse = scenario === "same" || scenario === "only-test";
    const finishing = requests.filter((r) => r.priority === "finish");
    expect(finishing.some((r) => r.checks?.includes("test"))).toBe(!reuse && scenario !== "no-test");
    if (scenario === "only-test") expect(finishing).toEqual([]);
    else expect(finishing.some((r) => r.checks?.includes("lint"))).toBe(true);
    const state = f.store.getRunState<RunState>(run.id);
    if (!state?.worktreePath) throw new Error("missing state");
    const finalTree = (
      await sh(["git", "rev-parse", "HEAD^{tree}"], { cwd: state.worktreePath })
    ).stdout.trim();
    if (reuse) expect(finalTree).toBe(tree);
    if (scenario === "changed") expect(finalTree).not.toBe(tree);
    const checks: GateComparison[] = JSON.parse(f.store.getArtifact(run.id, "gates-0.json") ?? "null");
    const testCheck = checks.find((c) => c.name === "test");
    expect(!!testCheck?.result.reused).toBe(reuse);
    const events = f.store.listEvents(run.id);
    expect(events.some((e) => e.message.includes("reused factory gate execution"))).toBe(reuse);
    if (reuse) {
      expect(events.some((e) => e.message.includes(testCheck?.result.reused?.executionId ?? "missing"))).toBe(
        true,
      );
      expect(state.gateEvidence?.checks.find((c) => c.name === "test")?.result.reused).toEqual(
        testCheck?.result.reused,
      );
    }
    if (["corrupt", "invalid", "lookup"].includes(scenario))
      expect(events.some((e) => e.message.includes("Factory gate lookup failed"))).toBe(true);
    if (
      [
        "no-build",
        "print-only",
        "lan",
        "no-test",
        "timeout",
        "cancelled",
        "confinement",
        "setup-fail",
      ].includes(scenario)
    )
      expect(f.store.db.query("SELECT * FROM agent_gate_executions").all()).toEqual([]);
    if (snapshotDir) expect(existsSync(snapshotDir)).toBe(false);
  } finally {
    lookup?.mockRestore();
  }
});

test.each([false, true])("reused failure and retry classification survive (flaky=%s)", async (flaky) => {
  await configure();
  const configPath = join(fixture.repoDir, ".limitless.toml");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8")
      .replace("[gates]", '[gates]\nretry_files = "echo retry {files}"')
      .replace('setup = ["echo setup"]', `setup = ['touch "$HOME/setup-marker"']`)
      .replace('run="echo trusted-test"', `run='test -e "$HOME/setup-marker" && echo trusted-test'`),
  );
  writeFileSync(join(fixture.repoDir, "sample.test.ts"), "// fixture\n");
  await sh(["git", "add", ".limitless.toml", "sample.test.ts"], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "targeted retry fixture"], { cwd: fixture.repoDir });
  const secret = `gate-secret-${crypto.randomUUID()}`;
  registerCredential("FACTORY_GATE_TEST_SECRET", secret);
  const local = localExecutor();
  let sessions = 0,
    calls = 0,
    roundZeroTests = 0,
    feedback = "";
  let worktree = "";
  const executor: GateExecutor = {
    ...local,
    start(req, signal) {
      if (worktree && req.priority === "finish" && sessions === 1 && req.checks?.includes("test"))
        roundZeroTests++;
      return local.start(req, signal);
    },
    attach(handle, signal, req, hooks) {
      const execution = local.attach(handle, signal, req, hooks);
      if (!worktree || req?.priority !== "start") return execution;
      calls++;
      const failed = !flaky || calls === 1;
      return {
        ...execution,
        result: execution.result.then((run) => {
          expect(run.checks.every((check) => check.ok)).toBe(true);
          return {
            ...run,
            checks: run.checks.map((r) => ({
              ...r,
              ok: !failed,
              exitCode: failed ? 3 : 0,
              output: failed ? `tail ${secret}` : "pass on retry",
              failures: failed ? `failure excerpt ${secret}` : undefined,
              failedFiles: ["sample.test.ts"],
              failedFileTimes: { "sample.test.ts": 1 },
            })),
          };
        }),
      };
    },
  };
  const f = start(
    async (agent) => {
      const role = roleOf(agent);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      sessions++;
      worktree = agent.cwd;
      if (sessions > 1) {
        feedback = agent.prompt;
        return { files: { "farewell.txt": "fixed\n" } };
      }
      writeFileSync(join(worktree, "farewell.txt"), "goodbye\n");
      const wrapper = agent.commandPath?.split(delimiter)[0];
      if (!wrapper) throw new Error("missing wrapper");
      const result = await sh([join(wrapper, "bun"), "test"], {
        cwd: worktree,
        env: agentEnv(),
        allowFail: true,
      });
      expect(result.exitCode).toBe(flaky ? 0 : 3);
      expect(result.stdout).not.toContain(secret);
      expect(result.stdout).toContain(flaky ? "pass on retry" : "failure excerpt [redacted]");
      return { text: "implementation complete" };
    },
    false,
    false,
    { gateExecutor: executor },
  );
  const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell.txt" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  const checks: GateComparison[] = JSON.parse(f.store.getArtifact(run.id, "gates-0.json") ?? "null");
  const testCheck = checks.find((c) => c.name === "test");
  expect(testCheck).toMatchObject({
    verdict: flaky ? "flaky" : "regressed",
    blocking: !flaky,
    result: {
      ok: flaky,
      reused: { executionId: expect.any(String) },
      firstAttempt: { ok: false },
      targetedRetry: { ok: flaky, command: "echo retry './sample.test.ts'" },
    },
  });
  expect(testCheck?.firstAttempt?.ok).toBe(false);
  expect(roundZeroTests).toBe(0);
  expect(calls).toBe(flaky ? 3 : 2);
  if (!flaky) expect(feedback).toContain("failure excerpt [redacted]");
});
