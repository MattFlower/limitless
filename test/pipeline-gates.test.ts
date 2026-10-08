import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Factory } from "../src/app.ts";
import { gateSlots } from "../src/gates/slots.ts";
import type { RunState } from "../src/pipeline/context.ts";
import * as proc from "../src/util/proc.ts";
import { sh } from "../src/util/proc.ts";
import { deferred } from "./evals-support.ts";
import { approve, pipelineSetup, roleOf, triage, waitFor } from "./pipeline-support.ts";
import { waitClock } from "./wait-clock.ts";

let home: string;
let repoDir: string;
let factory: Factory | null = null;
const { start } = pipelineSetup({
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
  test.each([
    "passes",
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
  ])("gate timeout: %s", async (scenario) => {
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
    const prompts: string[] = [];
    const f = start((s) => {
      const role = roleOf(s);
      if (role === "triage") return { structured: triage({ suggested_profile: "quick" }) };
      if (role === "review") return { structured: approve };
      prompts.push(s.prompt);
      return { files: { "farewell.txt": "goodbye\n" } };
    });
    const previous = gateSlots.limit;
    gateSlots.setLimit(1);
    let held: Promise<() => void> | undefined;
    let release: (() => void) | undefined;
    let calls = 0;
    let waits = 0;
    const commands: string[] = [];
    const realProcess = proc.runProcess;
    const processSpy = spyOn(proc, "runProcess").mockImplementation(async (opts) => {
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
      const fail =
        (isLint && attempt === (scenario === "retry-lint" ? 5 : 3)) ||
        (scenario === "retry setup failure" && attempt === 4);
      if (timeout && scenario !== "unflagged") {
        if (scenario === "slot" || scenario === "cancel slot")
          held = gateSlots.acquire(new AbortController().signal);
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
    const addEvent = f.store.addEvent.bind(f.store);
    const eventSpy = spyOn(f.store, "addEvent").mockImplementation((event) => {
      if (event.message?.startsWith("Waiting for a gate slot")) queued.resolve();
      return addEvent(event);
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
        await queued.promise;
        release = await held;
        expect(calls).toBe(2);
        if (scenario === "cancel slot") f.cancelRun(run.id);
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
      } else {
        expect(status).toBe("succeeded");
        const retries = ["mixed", "unflagged", "setup"].includes(scenario) ? 0 : 1;
        expect(state?.gateTimeoutReruns ?? 0).toBe(retries);
        expect(prompts).toHaveLength(
          ["twice", "mixed", "unflagged", "setup", "retry setup failure"].includes(scenario) ? 2 : 1,
        );
        if (scenario === "passes" || scenario === "slot") {
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
      release?.();
      if (held) (await held)();
      await f.stop();
      processSpy.mockRestore();
      eventSpy.mockRestore();
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
