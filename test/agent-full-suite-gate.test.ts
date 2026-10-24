import { expect, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { Factory } from "../src/app.ts";
import { WorkerStore } from "../src/db/workers.ts";
import { type GateExecutor, type GateRequest, localExecutor } from "../src/gates/executor.ts";
import { lanExecutor } from "../src/gates/lan.ts";
import type { GateComparison } from "../src/gates/run.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { applyGateEvidence } from "../src/pipeline/gate-evidence.ts";
import type { Verify } from "../src/pipeline/schemas.ts";
import { agentEnv, registerCredential, sh } from "../src/util/proc.ts";
import { GateRunSchema } from "../src/workers/protocol.ts";
import { approve, pipelineSetup, roleOf, spec, triage, waitFor } from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";

const fixture: { home: string; repoDir: string; factory: Factory | null } = {
  home: "",
  repoDir: "",
  factory: null,
};
const { start } = pipelineSetup(fixture);

async function configure(onlyTest = false, noTest = false, gitCheck = false, snapshotCommand = "") {
  const testRun = snapshotCommand
    ? `if test -d .git; then ${snapshotCommand}; fi; echo trusted-test`
    : gitCheck
      ? 'git ls-files --error-unmatch greeting.txt && git describe --tags && git rev-parse HEAD^{tree} && test -z "$(git status --porcelain)" && echo trusted-test'
      : "echo trusted-test";
  writeFileSync(
    join(fixture.repoDir, ".limitless.toml"),
    `[gates]
setup = ${onlyTest ? "[]" : '["echo setup"]'}
checks = [${onlyTest ? "" : '{name="lint",run="echo lint"},'}${noTest ? "" : `{name="test",run=${JSON.stringify(testRun)}}`}]
[limits]
slotted_commands = ["bun test"]
agent_full_suite = "gate"
`,
  );
  await sh(["git", "add", ".limitless.toml"], { cwd: fixture.repoDir });
  await sh(["git", "commit", "-qm", "trusted gate policy"], { cwd: fixture.repoDir });
  if (gitCheck) await sh(["git", "tag", "snapshot-base"], { cwd: fixture.repoDir });
}

const commit = "git -c user.name=Test -c user.email=test@example.com commit -qm gate";
const mutations: Record<string, string> = {
  commit: `echo changed > greeting.txt && ${commit} -a`,
  "empty-commit": `${commit} --allow-empty`,
  reset: "git reset --hard HEAD^",
  unreadable: "rm .git/HEAD",
  "tree-unreadable": "git hash-object -w --stdin < greeting.txt > .git/HEAD",
};

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
  "run",
  "executor",
  "executor-route",
  "print-only",
  "no-build",
  "lan",
  "lan-changed",
  "lan-fallback",
  "lan-job-fallback",
  "lan-job-fallback-commit",
  "uncommitted",
  "lan-missing",
  "lan-commit-mismatch",
  "lan-tree-mismatch",
  "lan-sha-only",
  ...Object.keys(mutations),
  "repeat",
  "repeat-lan",
  "no-test",
  "timeout",
  "cancelled",
  "confinement",
  "setup-fail",
])("implement snapshot and round gate reuse: %s", async (scenario) => {
  await configure(
    scenario === "only-test",
    scenario === "no-test",
    scenario === "same",
    scenario === "uncommitted"
      ? "echo generated > greeting.txt"
      : scenario === "lan-job-fallback-commit"
        ? mutations.commit
        : mutations[scenario],
  );
  const unconfirmed =
    scenario in mutations ||
    scenario === "lan-job-fallback-commit" ||
    ["lan-missing", "lan-commit-mismatch", "lan-tree-mismatch", "lan-sha-only"].includes(scenario);
  const requests: GateRequest[] = [];
  let tree = "",
    worktree = "",
    snapshotDir = "";
  const executor = localExecutor();
  const fallbacks = new Map<string, GateExecutor>();
  let executorKind: GateExecutor["kind"] =
    scenario.includes("lan") || scenario === "executor-route" ? "lan" : "local";
  let remote = scenario !== "executor-route";
  const executions: string[] = [];
  let sessionComplete = false;
  const recording: GateExecutor = {
    ...executor,
    get kind() {
      return executorKind;
    },
    freshCheckoutFor: () => executorKind === "lan" && remote,
    async start(request, signal) {
      requests.push(request);
      if (worktree && request.priority === "start") {
        const retry = snapshotDir === request.cwd;
        snapshotDir = request.cwd;
        expect(request.cwd).not.toBe(worktree);
        expect(request.checks).toEqual(["test"]);
        expect(request.gates.setup).toEqual(
          scenario === "only-test" || (retry && !(executorKind === "lan" && remote)) ? [] : ["echo setup"],
        );
        expect(readFileSync(join(request.cwd, "farewell.txt"), "utf8")).toBe("goodbye\n");
        expect(readFileSync(join(request.cwd, "greeting.txt"), "utf8")).toBe("edited\n");
        const git = async (...args: string[]) =>
          (await sh(["git", ...args], { cwd: request.cwd })).stdout.trim();
        expect(await git("cat-file", "-t", request.headSha)).toBe("commit");
        expect(await git("rev-parse", "HEAD")).toBe(request.headSha);
        tree = await git("rev-parse", `${request.headSha}^{tree}`);
        if (scenario === "same" || scenario === "lan") {
          expect(await git("write-tree")).toBe(tree);
          expect(await git("rev-parse", "HEAD^{tree}")).toBe(tree);
          if (scenario === "same") expect(await git("describe", "--tags")).toMatch(/^snapshot-base-1-g/);
          expect(await git("ls-files", "--error-unmatch", "farewell.txt")).toBe("farewell.txt");
          expect(await git("status", "--porcelain")).toBe("");
          expect(existsSync(join(request.cwd, ".git/objects/info/alternates"))).toBe(false);
          // A ref created in the snapshot must never appear in the session.
          await sh(["git", "update-ref", "refs/heads/snapshot-only", "HEAD"], { cwd: request.cwd });
        }
      }
      const failedWorker =
        scenario.startsWith("lan-job-fallback") && worktree && request.priority === "start"
          ? new WorkerStore(f.store, "test-build", { tick: 1 })
          : null;
      const actual = failedWorker ? lanExecutor(failedWorker, [request.repo]) : executor;
      const handle = await actual.start(request, signal);
      if (failedWorker) {
        fallbacks.set(handle.id, actual);
        failedWorker.fail(handle.id, "fixture worker unavailable");
        failedWorker.fail(handle.id, "fixture worker unavailable");
      }
      if (worktree && request.priority === "start") executions.push(handle.id);
      return { ...handle, kind: scenario === "lan-fallback" ? "local" : executorKind };
    },
    attach(handle, signal, request, hooks) {
      const execution = (fallbacks.get(handle.id) ?? executor).attach(handle, signal, request, hooks);
      if (!worktree || request?.priority !== "start") return execution;
      return {
        ...execution,
        result: execution.result.then(async (run) => {
          if (executorKind === "lan" && !fallbacks.has(handle.id)) {
            // Simulate worker-reported post-execution state, independently of the request SHA.
            const head = (await sh(["git", "rev-parse", "HEAD"], { cwd: request.cwd })).stdout.trim();
            run = GateRunSchema.parse({
              ...run,
              ...(scenario === "lan-missing"
                ? {}
                : { sha: scenario === "lan-commit-mismatch" ? "0".repeat(40) : head }),
              ...(["lan-missing", "lan-sha-only"].includes(scenario)
                ? {}
                : {
                    treeHash:
                      scenario === "lan-tree-mismatch"
                        ? "0".repeat(40)
                        : (await sh(["git", "rev-parse", "HEAD^{tree}"], { cwd: request.cwd })).stdout.trim(),
                  }),
            });
          }
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
  let runId = "";
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
        const request = () =>
          sh([join(directory, "bun"), "test", "--agent-chosen-arguments"], {
            cwd: worktree,
            env: agentEnv(),
            allowFail: true,
          });
        const result = await request();
        const refused = scenario === "no-test";
        const failed = ["timeout", "cancelled", "confinement", "setup-fail"].includes(scenario);
        expect(result.exitCode).toBe(scenario === "setup-fail" ? 9 : refused || failed ? 1 : 0);
        if (!refused) {
          expect(result.stdout, result.stderr).toContain(
            `Factory gate run of check test on tree ${tree}: ${failed ? "FAIL" : "pass"}`,
          );
          expect(result.stdout).toContain(scenario === "setup-fail" ? "setup failed" : "trusted-test");
          if (scenario === "same") {
            expect(result.stdout).toContain(tree);
            expect(result.stdout).toContain("snapshot-base-1-g");
          }
          if (unconfirmed) {
            expect(result.stdout).toContain("Result is not reusable because");
            expect(result.stdout).toContain(
              scenario.includes("unreadable") || ["lan-missing", "lan-sha-only"].includes(scenario)
                ? "provenance could not be confirmed"
                : "snapshot changed during the gate",
            );
            expect(f.store.db.query("SELECT * FROM agent_gate_executions").all()).toEqual([]);
            const state = f.store.getRunState<RunState>(runId);
            const blocked: Verify = {
              overall: "fail",
              notes: "",
              criteria: [
                {
                  id: "AC-1",
                  status: "blocked",
                  blockedReason: "sandbox",
                  evidence: result.stdout,
                  publicSummary: "",
                },
              ],
            };
            const substituted = applyGateEvidence(
              blocked,
              {
                ...spec,
                acceptance_criteria: [{ id: "AC-1", criterion: "tests pass", how_to_verify: "bun test" }],
              },
              { scenarios: [] },
              beforeHead.trim(),
              state?.gateEvidence,
            );
            expect(substituted.criteria[0]?.status).toBe("blocked");
            expect(substituted.criteria[0]?.gateEvidence).toBeUndefined();
          }
        }
        if (scenario.startsWith("repeat")) {
          const stored = f.store.db.query("SELECT * FROM agent_gate_executions").all();
          expect(stored).toHaveLength(1);
          const repeated = await request();
          expect(repeated.exitCode).toBe(result.exitCode);
          expect(repeated.stdout).toContain(`reused factory gate execution ${executions[0]}`);
          expect(f.store.db.query("SELECT * FROM agent_gate_executions").all()).toEqual(stored);
          expect(executions).toHaveLength(1);
        }
      } else agent.onEvent({ type: "text", text: "bun test: 100 pass, 0 fail (factory gate passed)" });
      expect(await git("rev-parse", "HEAD")).toBe(beforeHead);
      expect(await git("status", "--porcelain")).toBe(beforeStatus);
      expect(readFileSync(indexPath)).toEqual(beforeIndex);
      if (scenario === "same") expect(await git("branch", "--list", "snapshot-only")).toBe("");
      expect(readFileSync(join(worktree, "farewell.txt"), "utf8")).toBe("goodbye\n");
      expect(readFileSync(join(worktree, "greeting.txt"), "utf8")).toBe("edited\n");
      if (scenario === "changed" || scenario === "lan-changed")
        writeFileSync(join(worktree, "later.txt"), "after snapshot\n");
      if (scenario.startsWith("repeat")) {
        writeFileSync(join(worktree, "later.txt"), "after snapshot\n");
        const directory = agent.commandPath?.split(delimiter)[0];
        if (!directory) throw new Error("missing wrapper");
        const changed = await sh([join(directory, "bun"), "test"], { cwd: worktree, env: agentEnv() });
        expect(changed.stdout).not.toContain("reused factory gate execution");
        expect(executions).toHaveLength(2);
      }
      const invalidate = () => {
        if (["config", "env", "run", "executor", "executor-route"].includes(scenario))
          f.store.db
            .query("DELETE FROM agent_gate_executions WHERE execution_id <> ?")
            .run(executions.at(-1) ?? "");
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
        if (scenario === "executor") executorKind = executorKind === "local" ? "lan" : "local";
        if (scenario === "executor-route") remote = !remote;
        if (scenario === "run") {
          const repo = f.store.listRepos()[0];
          if (!repo) throw new Error("missing repo");
          const other = f.store.createRun(repo, { repo: fixture.repoDir, prompt: "other run" });
          // Its shared handler would overwrite snapshotDir; only a foreign run identity is needed.
          f.store.updateRun(other.id, { status: "cancelled" });
          f.store.db.query("UPDATE agent_gate_executions SET run_id = ?").run(other.id);
        }
      };
      invalidate();
      if (
        [
          "config",
          "env",
          "missing",
          "corrupt",
          "invalid",
          "lookup",
          "run",
          "executor",
          "executor-route",
        ].includes(scenario)
      ) {
        const before = executions.length;
        const directory = agent.commandPath?.split(delimiter)[0];
        if (!directory) throw new Error("missing wrapper");
        expect(
          (await sh([join(directory, "bun"), "test"], { cwd: worktree, env: agentEnv() })).exitCode,
        ).toBe(0);
        expect(executions).toHaveLength(before + 1);
        // The gates-stage lookup must independently reject the same miss.
        invalidate();
      }
      sessionComplete = true;
      return { text: "implemented" };
    },
    false,
    false,
    { gateExecutor: recording, ...(scenario === "no-build" ? { bootSha: undefined } : {}) },
  );
  try {
    const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell.txt" });
    runId = run.id;
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(sessionComplete, JSON.stringify(f.store.listInvocations(run.id).map((i) => i.error))).toBe(true);
    const reuse = [
      "same",
      "only-test",
      "lan",
      "lan-fallback",
      "lan-job-fallback",
      "uncommitted",
      "repeat",
      "repeat-lan",
    ].includes(scenario);
    const finishing = requests.filter((r) => r.runId === run.id && r.priority === "finish");
    expect(finishing.some((r) => r.checks?.includes("test"))).toBe(!reuse && scenario !== "no-test");
    if (scenario === "only-test") expect(finishing).toEqual([]);
    else expect(finishing.some((r) => r.checks?.includes("lint"))).toBe(true);
    const state = f.store.getRunState<RunState>(run.id);
    if (!state?.worktreePath) throw new Error("missing state");
    const finalTree = (
      await sh(["git", "rev-parse", "HEAD^{tree}"], { cwd: state.worktreePath })
    ).stdout.trim();
    if (reuse) expect(finalTree).toBe(tree);
    if (scenario === "changed" || scenario === "lan-changed") expect(finalTree).not.toBe(tree);
    const checks: GateComparison[] = JSON.parse(f.store.getArtifact(run.id, "gates-0.json") ?? "null");
    const testCheck = checks.find((c) => c.name === "test");
    expect(!!testCheck?.result.reused).toBe(reuse);
    const events = f.store.listEvents(run.id);
    expect(events.some((e) => e.message.includes("reused factory gate execution"))).toBe(reuse);
    if (reuse) {
      expect(testCheck?.result.reused?.executionId).toBe(executions.at(-1));
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
      unconfirmed ||
      ["no-build", "print-only", "no-test", "timeout", "cancelled", "confinement", "setup-fail"].includes(
        scenario,
      )
    )
      expect(f.store.db.query("SELECT * FROM agent_gate_executions").all()).toEqual([]);
    if (snapshotDir) expect(existsSync(snapshotDir)).toBe(false);
  } finally {
    lookup?.mockRestore();
  }
});

test.each([
  { flaky: false, kind: "local" as const, invalid: "" },
  { flaky: true, kind: "local" as const, invalid: "" },
  { flaky: false, kind: "lan" as const, invalid: "" },
  { flaky: true, kind: "lan" as const, invalid: "" },
  { flaky: true, kind: "local" as const, invalid: "retry-commit" },
  { flaky: false, kind: "local" as const, invalid: "retry-unreadable" },
  { flaky: true, kind: "lan" as const, invalid: "first-missing" },
  { flaky: true, kind: "lan" as const, invalid: "retry-missing" },
  { flaky: true, kind: "lan" as const, invalid: "retry-mismatch" },
])("failure, retry classification and provenance survive (%j)", async ({ flaky, kind, invalid }) => {
  await configure();
  const configPath = join(fixture.repoDir, ".limitless.toml");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8")
      .replace(
        "[gates]",
        `[gates]\nretry_files = ${JSON.stringify(
          kind === "local" && invalid
            ? `if test -d .git; then ${invalid === "retry-commit" ? `${commit} --allow-empty` : "rm .git/HEAD"}; fi; echo retry {files}`
            : "echo retry {files}",
        )}`,
      )
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
  let executionId = "";
  let sessionComplete = false;
  const executor: GateExecutor = {
    ...local,
    kind,
    freshCheckoutFor: () => kind === "lan",
    async start(req, signal) {
      if (worktree && req.priority === "finish" && sessions === 1 && req.checks?.includes("test"))
        roundZeroTests++;
      if (worktree && req.priority === "start" && kind === "lan")
        expect(req.gates.setup).toEqual(['touch "$HOME/setup-marker"']);
      const handle = await local.start(req, signal);
      if (worktree && req.priority === "start") executionId ||= handle.id;
      return { ...handle, kind };
    },
    attach(handle, signal, req, hooks) {
      const execution = local.attach(handle, signal, req, hooks);
      if (!worktree || req?.priority !== "start") return execution;
      calls++;
      const failed = !flaky || calls === 1;
      const badReport =
        invalid === "first-missing" ? calls === 1 : invalid.startsWith("retry-") && calls === 2;
      return {
        ...execution,
        result: execution.result.then(async (run) => {
          expect(run.checks.every((check) => check.ok)).toBe(true);
          return {
            ...run,
            ...(kind === "lan" && !(badReport && invalid.includes("missing"))
              ? {
                  sha: badReport
                    ? "0".repeat(40)
                    : (await sh(["git", "rev-parse", "HEAD"], { cwd: req.cwd })).stdout.trim(),
                  treeHash: (await sh(["git", "rev-parse", "HEAD^{tree}"], { cwd: req.cwd })).stdout.trim(),
                }
              : {}),
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
      const stored = f.store.db.query("SELECT * FROM agent_gate_executions").all();
      expect(stored).toHaveLength(invalid ? 0 : 1);
      if (invalid) {
        expect(result.stdout).toContain("Result is not reusable because");
        sessionComplete = true;
        return { text: "implementation complete" };
      }
      const repeated = await sh([join(wrapper, "bun"), "test"], {
        cwd: worktree,
        env: agentEnv(),
        allowFail: true,
      });
      expect(repeated.exitCode).toBe(result.exitCode);
      expect(repeated.stdout).toContain(`reused factory gate execution ${executionId}`);
      expect(repeated.stdout.replace(/; reused factory gate execution [^\n]+/, "")).toBe(result.stdout);
      expect(f.store.db.query("SELECT * FROM agent_gate_executions").all()).toEqual(stored);
      expect(calls).toBe(flaky ? 3 : 2);
      sessionComplete = true;
      return { text: "implementation complete" };
    },
    false,
    false,
    { gateExecutor: executor },
  );
  const run = await f.createRun({ repo: fixture.repoDir, prompt: "Add farewell.txt" });
  expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
  expect(sessionComplete).toBe(true);
  const checks: GateComparison[] = JSON.parse(f.store.getArtifact(run.id, "gates-0.json") ?? "null");
  const testCheck = checks.find((c) => c.name === "test");
  if (invalid) {
    expect(testCheck?.result.reused).toBeUndefined();
    expect(testCheck?.result.ok).toBe(true);
    expect(roundZeroTests).toBe(1);
    expect(f.store.db.query("SELECT * FROM agent_gate_executions").all()).toEqual([]);
    expect(calls).toBe(flaky ? 3 : 2);
    return;
  }
  expect(testCheck).toMatchObject({
    verdict: flaky ? "flaky" : "regressed",
    blocking: !flaky,
    result: {
      ok: flaky,
      reused: { executionId },
      firstAttempt: { ok: false },
      targetedRetry: { ok: flaky, command: "echo retry './sample.test.ts'" },
    },
  });
  expect(testCheck?.firstAttempt?.ok).toBe(false);
  expect(roundZeroTests).toBe(0);
  expect(calls).toBe(flaky ? 3 : 2);
  if (!flaky) expect(feedback).toContain("failure excerpt [redacted]");
});
