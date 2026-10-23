import { describe, expect, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import { gateSlots } from "../src/gates/slots.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { executeRun } from "../src/pipeline/engine.ts";
import * as proc from "../src/util/proc.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import { deferred } from "./evals-support.ts";
import { approve, pipelineSetup, roleOf, triage, waitFor } from "./pipeline-support.ts";
import { test } from "./read-policy-support.ts";
import { waitClock } from "./wait-clock.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start, githubFixture, registerGithub, advanceBase } = pipelineSetup({
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
  // Literal commands and escaped gate names across a gate-started restart are covered in
  // gate-executor.test.ts; this case covers package scripts named by gates.
  test("literal gate state survives restart: script names", async () => {
    const secret = "synthetic-gate-resume-credential-494";
    registerCredential("resume-command-test", secret);
    const scripts = { ok: "true", output: `true # ${secret}` };
    const checks = Object.keys(scripts).map((name) => ({ name, run: `bun run ${name}` }));
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ scripts }));
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\nchecks = [${checks.map((c) => `{ name = ${JSON.stringify(c.name)}, run = ${JSON.stringify(c.run)} }`).join(", ")}]\n`,
    );
    await sh(["git", "add", "."], { cwd: repoDir });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "literal gates"], {
      cwd: repoDir,
    });
    const f = start((s) => {
      if (roleOf(s) === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (roleOf(s) === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    await f.stop();
    const commands: string[] = [];
    const realProcess = proc.runProcess;
    const processSpy = spyOn(proc, "runProcess").mockImplementation((opts) => {
      if (opts.cmd[0] === "/bin/sh") commands.push(opts.cmd.at(-1) ?? "");
      return realProcess(opts);
    });
    try {
      const verdicts = [];
      for (const restart of [false, true]) {
        commands.length = 0;
        f.deps.faults = restart
          ? {
              "store:save": {
                action: "kill",
                when: (c) => c.stage === "gates" && c.checkpoint === "gate-started",
              },
            }
          : undefined;
        const run = await f.createRun({
          repo: repoDir,
          prompt: "Add farewell",
          profile: "quick",
          noBaselineCache: true,
        });
        const execute = () => executeRun(f.deps, run.id, new AbortController().signal);
        if (restart) expect(await execute()).toBe("running");
        expect(await execute()).toBe("succeeded");
        const state = f.store.getRunState<RunState>(run.id);
        expect(state?.baselineScripts).toEqual(scripts);
        expect(state?.lastAudit).not.toContainEqual(expect.objectContaining({ rule: "gate-script-changed" }));
        expect(state?.lastGates?.map((c) => [c.name, c.result.command, c.verdict])).toEqual([
          ["ok", "bun run ok", "pass"],
          ["output", "bun run output", "pass"],
        ]);
        expect(commands).toEqual(["bun run ok", "bun run output", "bun run ok", "bun run output"]);
        verdicts.push(state?.lastGates?.[0]?.verdict);
        const outward = JSON.stringify([
          f.store.listEvents(run.id),
          f.store.getArtifact(run.id, "gates-0.json"),
          f.store.getArtifact(run.id, "baseline-gates.json"),
        ]);
        expect(outward).not.toContain(secret);
        expect(outward).not.toContain("\\u001b");
      }
      expect(verdicts[1]).toBe(verdicts[0]);
    } finally {
      processSpy.mockRestore();
    }
  });

  // A queued competitor must wait until the timeout re-run finishes.
  test.each([
    "twice",
    "base",
    "slot",
    "cancel slot",
    "cancel retry",
    "mixed",
    "unflagged",
    "setup",
    "retry setup failure",
    "retry-lint",
    "retry clean once",
    "retry clean persists",
  ])("gate timeout: %s", async (scenario) => {
    const retryClean = scenario.startsWith("retry clean");
    const limit = scenario === "twice" ? 37 : 900;
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\n${scenario.includes("setup") ? 'setup = ["fake-setup"]\n' : ""}checks = [{ name = "test", run = "fake-test", timeoutSec = ${limit} }${["mixed", "retry-lint"].includes(scenario) ? ', { name = "lint", run = "fake-lint" }' : ""}]\n`,
    );
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "timeout fixture"], {
      cwd: repoDir,
    });
    const clock = waitClock();
    const scheduled = [deferred<void>(), deferred<void>()];
    const queued = deferred<void>();
    const finishRetry = deferred<void>();
    let acquired = false;
    const prompts: string[] = [];
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      prompts.push(s.prompt);
      return {
        files: { "farewell.txt": "goodbye\n" },
        ...(retryClean && prompts.length === 1 ? { status: "stuck", error: "repeated shell call" } : {}),
      };
    });
    const previous = gateSlots.limit;
    gateSlots.setLimit(1);
    let held: Promise<() => void> | undefined;
    let release: (() => void) | undefined;
    let calls = 0;
    let cleanAttempts = 0;
    let waits = 0;
    const commands: string[] = [];
    const realProcess = proc.runProcess;
    const processSpy = spyOn(proc, "runProcess").mockImplementation(async (opts) => {
      // Only fail the checkout between the timed-out gate and its re-run.
      if (
        retryClean &&
        calls === 2 &&
        prompts.length === 1 &&
        opts.cmd.at(-2) === "clean" &&
        opts.cmd.at(-1) === "-ffdxq"
      ) {
        cleanAttempts++;
        if (cleanAttempts === 1 || scenario === "retry clean persists")
          throw new proc.CommandError("could not lstat node_modules/writer", 1, "", "", false);
      }
      if (opts.cmd[0] !== "/bin/sh") return realProcess(opts);
      opts.signal?.throwIfAborted();
      const attempt = calls++;
      // Confined gate commands arrive as `/bin/sh -c <start check> sh <token> /bin/sh -c <command>`.
      const command = opts.cmd.at(-1) ?? "";
      opts.onStdoutLine?.(opts.cmd[4] ?? "");
      commands.push(command);
      const isLint = command === "fake-lint";
      const timeout =
        scenario === "base"
          ? attempt < 2
          : attempt ===
              (["mixed", "setup", "retry-lint"].includes(scenario)
                ? 2
                : scenario === "retry setup failure"
                  ? 3
                  : 1) ||
            (["twice", "cancel retry"].includes(scenario) && attempt === 2);
      if (attempt === 2 && (scenario === "slot" || scenario === "cancel slot")) {
        queued.resolve();
        await finishRetry.promise;
        opts.signal?.throwIfAborted();
      }
      const fail =
        (isLint && attempt === (scenario === "retry-lint" ? 5 : 3)) ||
        (scenario === "retry setup failure" && attempt === 4);
      if (timeout && scenario !== "unflagged") {
        if (scenario === "slot" || scenario === "cancel slot")
          held = gateSlots.acquire(new AbortController().signal).then((free) => {
            acquired = true;
            return free;
          });
        await new Promise<void>((resolve, reject) => {
          const timer = clock.timer.set(resolve, opts.timeoutMs ?? 900_000);
          opts.signal?.addEventListener(
            "abort",
            () => {
              clock.timer.clear(timer);
              reject(opts.signal?.reason);
            },
            { once: true },
          );
          scheduled[waits++]?.resolve();
        });
        opts.signal?.throwIfAborted();
      }
      return {
        exitCode: timeout || fail ? 1 : 0,
        signal: null,
        cancelled: false,
        timedOut: timeout && scenario !== "unflagged",
        idleTimedOut: false,
        truncated: false,
        stdout: timeout
          ? `${scenario === "unflagged" ? "[timed out] from nested tool\n" : ""}RUN slow acceptance test\nfarewell.txt:12\n`
          : fail
            ? scenario === "retry-lint"
              ? "transient lint error"
              : "farewell.txt:12: lint error"
            : "passed",
        stderr: "",
        durationMs: timeout ? (opts.timeoutMs ?? 900_000) : 1,
      };
    });
    try {
      const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
      if (scenario !== "unflagged") {
        await scheduled[0]?.promise;
        await clock.advance(900_000);
        if (scenario === "base" || scenario === "twice") {
          await scheduled[1]?.promise;
          await clock.advance(900_000);
        }
      }
      if (scenario === "slot" || scenario === "cancel slot") {
        expect(await Promise.race([queued.promise.then(() => "retry"), held?.then(() => "competitor")])).toBe(
          "retry",
        );
        expect(acquired).toBe(false);
        expect(calls).toBe(3);
        if (scenario === "cancel slot") f.cancelRun(run.id);
        finishRetry.resolve();
        release = await held;
        release?.();
      }
      if (scenario === "cancel retry") {
        await scheduled[1]?.promise;
        f.cancelRun(run.id);
      }
      const status = await waitFor(f, run.id, ["succeeded", "failed", "needs_human", "cancelled"]);
      const state = f.store.getRunState<RunState>(run.id);
      if (scenario.startsWith("cancel")) {
        expect(status).toBe("cancelled");
        expect(prompts).toHaveLength(1);
        expect(state?.gateTimeoutReruns).toBe(1);
        expect(clock.pending).toBe(0);
      } else if (scenario === "base") {
        expect(status).toBe("needs_human");
        expect(f.store.getRun(run.id)?.error).toBe("gate timed out on the base revision too");
        expect(prompts).toHaveLength(1);
        expect(calls).toBe(2);
        expect(state?.feedback).toBeNull();
        expect(f.store.getArtifact(run.id, "gates-0.json")).toContain('"timedOut": true');
      } else if (retryClean) {
        expect(status).toBe("succeeded");
        expect(cleanAttempts).toBe(2);
        expect(calls).toBe(3);
        const persistent = scenario === "retry clean persists";
        expect(prompts).toHaveLength(persistent ? 2 : 1);
        expect(state?.round).toBe(persistent ? 1 : 0);
        expect(f.store.getArtifact(run.id, "gates-timeout-0.json")).toContain('"timedOut":true');
        expect(f.store.listStages(run.id).find((s) => s.name === "gates")).toMatchObject({
          round: 0,
          status: persistent ? "failed" : "succeeded",
        });
        if (persistent) {
          expect(prompts[1]).toContain("Worktree cleanup failed after retry");
          expect(prompts[1]).toContain("could not lstat node_modules/writer");
          expect(prompts[1]).toContain("stuck: repeated shell call");
        } else expect(state?.lastGates?.[0]?.firstAttempt?.timedOut).toBe(true);
      } else {
        expect(status).toBe("succeeded");
        const retries = ["mixed", "unflagged", "setup"].includes(scenario) ? 0 : 1;
        expect(state?.gateTimeoutReruns ?? 0).toBe(retries);
        expect(prompts).toHaveLength(
          ["twice", "mixed", "unflagged", "setup", "retry setup failure"].includes(scenario) ? 2 : 1,
        );
        if (scenario === "slot") {
          expect(state?.round).toBe(0);
          expect(state?.feedback).toBeNull();
        }
        if (scenario === "retry-lint") {
          expect(commands).toEqual([
            "fake-test",
            "fake-lint",
            "fake-test",
            "fake-lint",
            "fake-test",
            "fake-lint",
            "fake-lint",
          ]);
          expect(state?.round).toBe(0);
          expect(state?.feedback).toBeNull();
          expect(state?.lastGates?.find((c) => c.name === "lint")).toMatchObject({
            verdict: "flaky",
            blocking: false,
            firstAttempt: { ok: false, output: "transient lint error" },
            result: { ok: true },
          });
        }
        if (scenario === "twice") {
          expect(prompts[1]).toContain("Check `test` timed out after 37 s twice");
          expect(prompts[1]).toContain("the last test running was slow acceptance test");
          expect(prompts[1]).not.toContain("now FAILS");
          expect(calls).toBe(4);
        }
        if (retries) {
          const evidence = JSON.parse(f.store.getArtifact(run.id, "gates-0.json") ?? "[]");
          if (scenario === "retry setup failure") {
            expect(calls).toBe(7);
            expect(prompts[1]).toContain("Check `setup` now FAILS");
            expect(f.store.getArtifact(run.id, "gates-timeout-0.json")).toContain('"timedOut":true');
          } else expect(evidence[0]?.firstAttempt?.timedOut).toBe(true);
          expect(evidence[0]?.result.timedOut ?? false).toBe(scenario === "twice");
          expect(f.store.getArtifact(run.id, "report.md")).toContain("Timeout-caused gate re-runs: 1");
          expect(
            f.store
              .readFeed({ limit: 1000 })
              .items.filter((item) => item.runId === run.id && item.kind === "run.gate_timeout_retry"),
          ).toMatchObject([{ summary: "Timeout-caused gate re-runs: 1", data: { gateTimeoutReruns: 1 } }]);
        }
      }
    } finally {
      finishRetry.resolve();
      release?.();
      await f.stop();
      if (held) (await held)();
      processSpy.mockRestore();
      gateSlots.setLimit(previous);
    }
  });

  test.each([
    "slot",
    "twice",
    "failure",
    "mixed",
    "retry failure",
    "setup",
    "retry setup",
    "confinement",
    "unflagged",
    "cancel slot",
    "cancel retry",
    "slow pass",
    "slow twice",
    "slow changed file",
    "slow confinement",
    "slow targeted fresh",
  ])("post-merge gate re-check: %s", async (scenario) => {
    const slow = scenario.startsWith("slow");
    const targeted = scenario === "slow targeted fresh";
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\n${targeted ? 'retry_files = "fake-targeted {files}"\n' : ""}setup = ["fake-setup"]\nchecks = [{ name = "test", run = "fake-test", timeoutSec = 37 }, { name = "lint", run = "fake-lint" }]\n`,
    );
    await sh(
      ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "post-merge timeout fixture"],
      {
        cwd: repoDir,
      },
    );
    const bare = await githubFixture();
    const originalBase = (await sh(["git", "rev-parse", "HEAD"], { cwd: repoDir })).stdout.trim();
    let approvedSha = "";
    let baseTip = "";
    const f = start(async (s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") {
        approvedSha = (await sh(["git", "rev-parse", "HEAD"], { cwd: s.cwd })).stdout.trim();
        baseTip = await advanceBase(bare, "base.txt", "new base\n");
        return { structured: approve };
      }
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    registerGithub(f, bare);
    if (targeted && f.deps.gateExecutor) f.deps.gateExecutor.freshCheckoutFor = () => true;
    const clock = waitClock();
    const scheduled = [deferred<void>(), deferred<void>()];
    const queued = deferred<void>();
    const finishRetry = deferred<void>();
    let acquired = false;
    const previous = gateSlots.limit;
    gateSlots.setLimit(1);
    let held: Promise<() => void> | undefined;
    let release: (() => void) | undefined;
    let attempts = 0;
    let testAttempts = 0;
    let runId = "";
    const retryPurposes: string[] = [];
    let waits = 0;
    let mergedHead = "";
    const commands: string[] = [];
    const realProcess = proc.runProcess;
    const processSpy = spyOn(proc, "runProcess").mockImplementation(async (opts) => {
      if (opts.cmd[0] !== "/bin/sh") return realProcess(opts);
      opts.signal?.throwIfAborted();
      opts.onStdoutLine?.(opts.cmd[4] ?? "");
      const command = opts.cmd.at(-1) ?? "";
      const cwd = opts.cwd ?? repoDir;
      const postMerge = existsSync(join(cwd, "base.txt"));
      if (postMerge) {
        commands.push(command);
        if (command === "fake-setup") {
          attempts++;
          const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
          if (attempts === 1) mergedHead = sha;
          else {
            expect(sha).toBe(mergedHead);
            expect(readFileSync(join(cwd, "greeting.txt"), "utf8")).toBe("hello\n");
            expect(existsSync(join(cwd, "timeout-debris"))).toBe(false);
          }
          if (attempts === 2 && (scenario === "slot" || scenario === "cancel slot")) {
            queued.resolve();
            await finishRetry.promise;
            opts.signal?.throwIfAborted();
          }
        }
      }
      if (postMerge && (command === "fake-test" || command.startsWith("fake-targeted"))) {
        if (command === "fake-test") testAttempts++;
        if (slow && (testAttempts > 1 || command.startsWith("fake-targeted"))) {
          expect(readFileSync(join(cwd, "slow-build-output"), "utf8")).toBe("built\n");
          retryPurposes.push(f.store.getRunState<RunState>(runId)?.gateExecution?.purpose ?? "missing");
          if (scenario === "slow pass") {
            queued.resolve();
            await finishRetry.promise;
            expect(acquired).toBe(false);
          }
        }
        if (slow && testAttempts === 1 && command === "fake-test") {
          writeFileSync(join(cwd, "slow-build-output"), "built\n");
          if (targeted) {
            const report = opts.env?.LIMITLESS_GATE_REPORT;
            if (!report) throw new Error("Missing JUnit report path");
            writeFileSync(
              report,
              '<testsuites tests="1" failures="1" errors="0" skipped="0"><testsuite tests="1" failures="1" errors="0" skipped="0"><testcase file="farewell.txt" name="failure" time="1"><failure>failed</failure></testcase></testsuite></testsuites>',
            );
          }
          if (scenario === "slow pass")
            held = gateSlots.acquire(new AbortController().signal).then((free) => {
              acquired = true;
              return free;
            });
        }
      }
      const timeout =
        postMerge &&
        !slow &&
        ((command === "fake-test" &&
          (attempts === 1 || scenario === "twice" || scenario === "cancel retry") &&
          !["failure", "setup", "unflagged"].includes(scenario)) ||
          (command === "fake-setup" && scenario === "setup"));
      const fail =
        postMerge &&
        ((command === "fake-test" &&
          ((slow && (testAttempts === 1 || scenario === "slow twice")) ||
            scenario === "failure" ||
            scenario === "unflagged" ||
            (scenario === "retry failure" && attempts === 2))) ||
          (command === "fake-lint" && scenario === "mixed") ||
          (command === "fake-setup" && scenario === "retry setup" && attempts === 2));
      if (timeout) {
        if (scenario === "slot" || scenario === "cancel slot")
          held = gateSlots.acquire(new AbortController().signal).then((free) => {
            acquired = true;
            return free;
          });
        writeFileSync(join(cwd, "greeting.txt"), "gate dirt\n");
        writeFileSync(join(cwd, "timeout-debris"), "gate dirt\n");
        writeFileSync(join(cwd, ".limitless.toml"), "untrusted gate configuration\n");
        await new Promise<void>((resolve, reject) => {
          const timer = clock.timer.set(resolve, opts.timeoutMs ?? 900_000);
          opts.signal?.addEventListener(
            "abort",
            () => {
              clock.timer.clear(timer);
              reject(opts.signal?.reason);
            },
            { once: true },
          );
          scheduled[waits++]?.resolve();
        });
        opts.signal?.throwIfAborted();
      }
      const stderr =
        (timeout && scenario === "confinement") ||
        (scenario === "slow confinement" && postMerge && command === "fake-test" && testAttempts === 2)
          ? ["sandbox_apply:", "Operation not permitted"].join(" ")
          : "";
      opts.onRawChunk?.(stderr, "stderr");
      return {
        exitCode: timeout ? null : fail ? 1 : 0,
        signal: null,
        cancelled: false,
        timedOut: timeout,
        idleTimedOut: false,
        truncated: false,
        stdout:
          fail && scenario === "slow changed file"
            ? "farewell.txt:12: failure"
            : timeout || fail
              ? "[timed out] from nested tool"
              : "passed",
        stderr,
        durationMs:
          command === "fake-test" &&
          (!postMerge || slow || (scenario === "retry failure" && testAttempts === 2))
            ? postMerge
              ? 400_000
              : 100_000
            : timeout
              ? (opts.timeoutMs ?? 900_000)
              : 1,
      };
    });
    try {
      const run = await f.createRun({ repo: "test/repo", prompt: "Add farewell", profile: "quick" });
      runId = run.id;
      if (!slow && !["failure", "unflagged"].includes(scenario)) {
        await scheduled[0]?.promise;
        await clock.advance(900_000);
      }
      if (scenario === "slow pass") await queued.promise;
      if (scenario === "slot" || scenario === "cancel slot" || scenario === "slow pass") {
        expect(await Promise.race([queued.promise.then(() => "retry"), held?.then(() => "competitor")])).toBe(
          "retry",
        );
        expect(acquired).toBe(false);
        expect(attempts).toBe(slow ? 1 : 2);
        expect(commands).toEqual(
          slow
            ? ["fake-setup", "fake-test", "fake-lint", "fake-test"]
            : ["fake-setup", "fake-test", "fake-lint", "fake-setup"],
        );
        if (scenario === "cancel slot") f.cancelRun(run.id);
        finishRetry.resolve();
        release = await held;
        release?.();
      }
      if (scenario === "twice" || scenario === "cancel retry") {
        await scheduled[1]?.promise;
        if (scenario === "cancel retry") f.cancelRun(run.id);
        else await clock.advance(900_000);
      }
      const status = await waitFor(f, run.id, ["succeeded", "failed", "needs_human", "cancelled"]);
      const state = f.store.getRunState<RunState>(run.id);
      const retries = [
        "slot",
        "cancel slot",
        "twice",
        "retry failure",
        "retry setup",
        "cancel retry",
      ].includes(scenario);
      expect(attempts).toBe(targeted ? 3 : retries ? 2 : 1);
      if (slow || scenario === "retry failure") expect(testAttempts).toBe(2);
      if (slow)
        expect(retryPurposes).toEqual(
          targeted ? ["regression-retry-targeted", "regression-retry"] : ["regression-retry"],
        );
      expect(clock.pending).toBe(0);
      if (scenario.startsWith("cancel")) {
        expect(status).toBe("cancelled");
        return;
      }
      const evidence = JSON.parse(f.store.getArtifact(run.id, "gates-rebase-0.json") ?? "[]");
      const stage = f.store
        .listStages(run.id)
        .filter((s) => s.name === "gates")
        .at(-1);
      if (retries) {
        expect(f.store.getArtifact(run.id, "gates-rebase-timeout-0.json")).toContain('"timedOut":true');
        expect(state?.gateTimeoutReruns).toBe(1);
        if (scenario !== "retry setup")
          expect(evidence[0]?.firstAttempt).toMatchObject({ timedOut: true, exitCode: null });
      }
      if (slow) {
        const recovered = !["slow twice", "slow confinement"].includes(scenario);
        expect(evidence[0]).toMatchObject({
          verdict: recovered ? "flaky" : scenario === "slow confinement" ? "confinement_error" : "regressed",
          blocking: !recovered,
          firstAttempt: { ok: false, durationMs: 400_000 },
          result: { ok: recovered, firstAttempt: { ok: false, durationMs: 400_000 } },
        });
        if (targeted) {
          expect(evidence[0]?.result.targetedRetry).toMatchObject({
            ok: true,
            command: "fake-targeted './farewell.txt'",
          });
          expect(commands).toEqual([
            "fake-setup",
            "fake-test",
            "fake-lint",
            "fake-setup",
            "fake-targeted './farewell.txt'",
            "fake-setup",
            "fake-test",
          ]);
        }
        const warnings = f.store
          .listEvents(run.id)
          .filter((e) => e.type === "gate" && e.message.includes("post-merge re-check"));
        expect(warnings).toHaveLength(1);
        expect(warnings).toMatchObject([
          {
            level: "warn",
            message: `test post-merge re-check: ran 4.0x its pre-merge time (400s vs 100s): ${recovered ? "pass (flaky, not blocking)" : "FAIL again"}`,
          },
        ]);
      }
      if (scenario === "slot" || (slow && !["slow twice", "slow confinement"].includes(scenario))) {
        expect(status).toBe("succeeded");
        expect(stage?.status).toBe("succeeded");
        if (slow) {
          expect(state?.lastGates?.[0]).toMatchObject({
            verdict: "flaky",
            blocking: false,
            firstAttempt: { ok: false },
          });
          expect(f.store.getArtifact(run.id, "report.md")).toContain("Flaky: `test`");
        } else {
          expect(state?.lastGates?.[0]?.firstAttempt?.timedOut).toBe(true);
          expect(commands).toEqual([
            "fake-setup",
            "fake-test",
            "fake-lint",
            "fake-setup",
            "fake-test",
            "fake-lint",
          ]);
        }
        expect(f.store.getRun(run.id)).toMatchObject({ baseSha: baseTip, headSha: mergedHead });
      } else {
        expect(status).toBe("needs_human");
        const reason = f.store.getRun(run.id)?.error ?? "";
        if (scenario === "twice") {
          expect(reason).toContain("post-merge gate timed out");
          expect(reason).not.toContain("regressed");
          expect(stage).toMatchObject({ status: "failed", summary: "post-merge gate timed out" });
          expect(evidence[0]?.result).toMatchObject({ timedOut: true, exitCode: null });
          expect(f.store.getArtifact(run.id, "report.md")).toContain("post-merge gate timed out");
        } else {
          expect(reason).toContain("post-merge gates regressed");
          expect(stage).toMatchObject({ status: "failed", summary: "post-merge gates regressed" });
          expect(evidence.some((c: { blocking: boolean }) => c.blocking)).toBe(true);
        }
        expect(f.store.getRun(run.id)).toMatchObject({ baseSha: originalBase, headSha: approvedSha });
        if (!state?.worktreePath) throw new Error("Missing post-merge worktree");
        expect((await sh(["git", "rev-parse", "HEAD"], { cwd: state.worktreePath })).stdout.trim()).toBe(
          approvedSha,
        );
        expect(state?.lastGates?.every((c) => c.result.ok && !c.blocking)).toBe(true);
      }
      expect(state?.pendingRebaseSha).toBeUndefined();
      expect(state?.preRebaseHead).toBeUndefined();
      expect(state?.preRebaseGates).toBeUndefined();
      expect(state?.gateExecution).toBeUndefined();
    } finally {
      finishRetry.resolve();
      release?.();
      await f.stop();
      if (held) (await held)();
      processSpy.mockRestore();
      gateSlots.setLimit(previous);
    }
  });

  test("a check that fails once after the change is retried, reported flaky, and does not block", async () => {
    const count = join(home, "gate-runs");
    // Run 1 is the baseline, run 2 the post-change gates, run 3 the retry.
    const check = `echo x >> '${count}'; test $(( $(wc -l < '${count}') )) -ne 2`;
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\nchecks = [{ name = "check", run = "${check}" }]\n`,
    );
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "flaky gate"], {
      cwd: repoDir,
    });
    let implementations = 0;
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      implementations++;
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    expect(implementations).toBe(1);
    const gates = f.store.getRunState<RunState>(run.id)?.lastGates?.[0];
    expect([gates?.verdict, gates?.blocking, gates?.firstAttempt?.ok]).toEqual(["flaky", false, false]);
    expect(
      f.store.listEvents(run.id).some((e) => e.message === "check retry: pass (flaky, not blocking)"),
    ).toBe(true);
    expect(f.store.getArtifact(run.id, "report.md")).toContain("Flaky: `check` failed, then passed");
  });

  test("a baseline check that fails once is retried and recorded as passing, so a regression blocks", async () => {
    const count = join(home, "gate-runs");
    // Run 1 is the baseline, run 2 its retry; every run after the change fails.
    const check = `echo x >> '${count}'; test $(( $(wc -l < '${count}') )) -eq 2`;
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\nchecks = [{ name = "check", run = "${check}" }]\n`,
    );
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "flaky baseline"], {
      cwd: repoDir,
    });
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).not.toBe("succeeded");
    const baseline = f.store.getRunState<RunState>(run.id)?.baseline?.checks[0];
    expect([baseline?.ok, baseline?.firstAttempt?.ok]).toEqual([true, false]);
    const artifact = JSON.parse(f.store.getArtifact(run.id, "baseline-gates.json") ?? "{}");
    expect([artifact.checks?.[0]?.ok, artifact.checks?.[0]?.firstAttempt?.ok]).toEqual([true, false]);
    const flaky = f.store.listEvents(run.id).find((e) => e.message === "baseline check: flaky");
    expect(flaky?.data).toMatchObject({ flaky: true, firstAttempt: { ok: false }, retry: { ok: true } });
    const gates = f.store.getRunState<RunState>(run.id)?.lastGates?.[0];
    expect([gates?.verdict, gates?.blocking]).toEqual(["regressed", true]);
    // Baseline, its retry, then each post-change round and its regression retry.
    expect(readFileSync(count, "utf8").trim().split("\n").length % 2).toBe(0);
  });

  test("a baseline check that fails twice stays failing and does not block after the change", async () => {
    const count = join(home, "gate-runs");
    const check = `echo x >> '${count}'; echo attempt $(( $(wc -l < '${count}') )); exit 1`;
    writeFileSync(
      join(repoDir, ".limitless.toml"),
      `[gates]\nchecks = [{ name = "check", run = "${check}" }]\n`,
    );
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "broken baseline"], {
      cwd: repoDir,
    });
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const run = await f.createRun({ repo: repoDir, prompt: "Add farewell", profile: "quick" });
    expect(await waitFor(f, run.id, ["succeeded", "failed", "needs_human"])).toBe("succeeded");
    const state = f.store.getRunState<RunState>(run.id);
    const baseline = state?.baseline?.checks[0];
    expect([
      baseline?.ok,
      baseline?.output,
      baseline?.firstAttempt?.ok,
      baseline?.firstAttempt?.output,
    ]).toEqual([false, "attempt 2", false, "attempt 1"]);
    // Both failed attempts stay in the artifact.
    const artifact = JSON.parse(f.store.getArtifact(run.id, "baseline-gates.json") ?? "{}");
    expect([artifact.checks?.[0]?.output, artifact.checks?.[0]?.firstAttempt?.output]).toEqual([
      "attempt 2",
      "attempt 1",
    ]);
    expect([state?.lastGates?.[0]?.verdict, state?.lastGates?.[0]?.blocking]).toEqual([
      "still_failing",
      false,
    ]);
    const events = f.store.listEvents(run.id);
    expect(events.some((e) => e.message.endsWith(": flaky"))).toBe(false);
    const again = events.find((e) => e.message === "baseline check: retry FAIL again");
    expect(again?.data).toMatchObject({ flaky: false, firstAttempt: { ok: false }, retry: { ok: false } });
    // Two baseline attempts, one post-change run (still_failing is never retried).
    expect(readFileSync(count, "utf8").trim().split("\n").length).toBe(3);
  });
});
