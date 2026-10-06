// Regression tests for defects found by the cross-vendor (Codex) review of the M1 core.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { auditDiff } from "../src/gates/audit.ts";
import { gateScriptNames, pickScripts } from "../src/gates/detect.ts";
import { compareGates } from "../src/gates/run.ts";
import { parseNameStatus, resolveRepo } from "../src/git/repos.ts";
import { fakeHarness } from "../src/harness/fake.ts";
import { ProviderTracker } from "../src/router/providers.ts";
import { startHttp } from "../src/server/http.ts";
import {
  ProcessTerminationError,
  processInspection,
  processScope,
  runProcess,
  sh,
} from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { findingEvidence } from "./review-support.ts";

// These tests drive real git and subprocesses; under CPU load they outlast Bun's 5 s default (#140).
setDefaultTimeout(30_000);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "limitless-hard-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const reserves = { claudeFiveHour: 0.8, claudeSevenDay: 0.85, codexWeekly: 0.9, codexFiveHour: 0.9 };

describe("process handling", () => {
  test("a child that exits before reading stdin does not crash us (EPIPE)", async () => {
    const res = await runProcess({
      cmd: ["/bin/sh", "-c", "exit 3"],
      cwd: dir,
      env: process.env as Record<string, string>,
      stdin: "x".repeat(5_000_000),
    });
    expect(res.exitCode).toBe(3);
  });

  test.each(["", ">/dev/null 2>&1"])(
    "background processes left by the child are reaped (%s)",
    async (stdio) => {
      const marker = join(dir, "alive");
      const pidFile = join(dir, "pid");
      // The leftover keeps touching the marker; the child exits only once it is running. Should reaping
      // fail, the leftover still stops once afterEach removes `dir`, or after about 5 s.
      const leftover = `i=0; while [ $i -lt 100 ] && [ -d ${dir} ]; do touch ${marker}; i=$((i+1)); sleep 0.05; done`;
      await runProcess({
        cmd: [
          "/bin/sh",
          "-c",
          `(${leftover}) ${stdio} & echo $! > ${pidFile}; while [ ! -e ${marker} ]; do sleep 0.01; done`,
        ],
        cwd: dir,
        env: process.env as Record<string, string>,
      });
      expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
      await Bun.sleep(20);
      rmSync(marker);
      await Bun.sleep(300);
      expect(await Bun.file(marker).exists()).toBe(false);
    },
  );

  test("a descendant ignoring SIGTERM cannot recreate removed scratch after return", async () => {
    const scratch = join(dir, "scratch");
    const child = join(dir, "child.js");
    const parent = join(dir, "parent.js");
    writeFileSync(
      child,
      `const fs = require("node:fs"); process.on("SIGTERM", () => {});
      setInterval(() => { fs.mkdirSync(${JSON.stringify(scratch)}, {recursive:true}); }, 5);
      setTimeout(() => process.exit(), 15000);`,
    );
    writeFileSync(
      parent,
      `const {spawn} = require("node:child_process");
      const fs = require("node:fs");
      spawn(process.execPath, [${JSON.stringify(child)}], {stdio:"ignore"}).unref();
      const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(scratch)})) { clearInterval(timer); process.exit(0); } }, 5);`,
    );
    await runProcess({
      cmd: [process.execPath, parent],
      cwd: dir,
      env: process.env as Record<string, string>,
      timeoutMs: 3000,
    });
    expect(existsSync(scratch)).toBe(true);
    rmSync(scratch, { recursive: true, force: true });
    await Bun.sleep(100);
    expect(existsSync(scratch)).toBe(false);
  });

  test.each(["normal", "error", "cancelled", "timeout", "stuck"])(
    "detached reparented writer is gone before cleanup on %s",
    async (ending) => {
      const pidFile = join(dir, "detached-pid");
      const ready = join(dir, "writer-ready");
      const writer = join(dir, "writer.js");
      const launcher = join(dir, "launcher.js");
      const parent = join(dir, "parent.js");
      writeFileSync(
        writer,
        `const fs = require("node:fs");
        process.on("SIGTERM", () => {});
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        setInterval(() => fs.appendFileSync(${JSON.stringify(ready)}, "x"), 5);
        setTimeout(() => process.exit(), 15000);`,
      );
      writeFileSync(
        launcher,
        `require("node:child_process").spawn(process.execPath,
        [${JSON.stringify(writer)}], {detached:true, stdio:"ignore"}).unref();`,
      );
      writeFileSync(
        parent,
        `const {spawn} = require("node:child_process"); const fs = require("node:fs");
        const launcher = spawn(process.execPath, [${JSON.stringify(launcher)}], {stdio:"ignore"});
        launcher.on("exit", () => {
          const timer = setInterval(() => {
            if (!fs.existsSync(${JSON.stringify(ready)})) return;
            clearInterval(timer); console.log(process.env.LIMITLESS_INVOCATION);
            ${ending === "normal" || ending === "error" ? `process.exit(${ending === "error" ? 3 : 0});` : "setInterval(() => {}, 1000);"}
          }, 5);
        });`,
      );
      const env = { ...process.env };
      delete env.LIMITLESS_INVOCATION;
      const control = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        env,
        stdio: "ignore",
      });
      let argumentControl: ChildProcess | undefined;
      const controller = new AbortController();
      let writerPid: number | undefined;
      let cleanup = false;
      try {
        const res = await runProcess({
          cmd: [process.execPath, parent],
          cwd: dir,
          env: env as Record<string, string>,
          signal: controller.signal,
          onStdoutLine: (marker) => {
            writerPid = Number(readFileSync(pidFile, "utf8"));
            argumentControl = spawn(
              process.execPath,
              ["-e", "setInterval(() => {}, 1000)", `LIMITLESS_INVOCATION=${marker}`],
              { env, stdio: "ignore" },
            );
            if (ending === "cancelled" || ending === "stuck") controller.abort(new Error(ending));
          },
          timeoutMs: ending === "timeout" ? 1500 : undefined,
        });
        // A real wall timeout must be the reason the invocation ended.
        if (ending === "timeout") expect(res.timedOut).toBe(true);
        if (ending === "cancelled" || ending === "stuck") expect(res.cancelled).toBe(true);
        if (ending === "normal" || ending === "error") expect(res.exitCode).toBe(ending === "error" ? 3 : 0);
        expect(writerPid).toBeGreaterThan(0);
        await (async () => {
          expect(() => process.kill(writerPid ?? 0, 0)).toThrow();
          expect(control.pid).toBeGreaterThan(0);
          expect(process.kill(control.pid ?? 0, 0)).toBe(true);
          expect(argumentControl?.pid).toBeGreaterThan(0);
          expect(process.kill(argumentControl?.pid ?? 0, 0)).toBe(true);
          cleanup = true;
          rmSync(ready);
        })();
        expect(cleanup).toBe(true);
      } finally {
        controller.abort();
        control.kill("SIGKILL");
        argumentControl?.kill("SIGKILL");
        await new Promise<void>((resolve) => control.once("close", () => resolve()));
        if (existsSync(pidFile)) {
          try {
            process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
          } catch {}
        }
      }
    },
  );

  test.each([false, true])(
    "inspection selects exact markers and uid, excluding argv matches (exec race: %s)",
    async (changing) => {
      const children = Array.from({ length: 3 }, () =>
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }),
      );
      const [writer, control, foreign] = children;
      const uid = process.getuid?.() ?? 0;
      const kill = process.kill.bind(process);
      const signalled: number[] = [];
      let plainInspections = 0;
      const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (signal === "SIGTERM" || signal === "SIGKILL") signalled.push(pid);
        return kill(pid, signal);
      });
      try {
        await processInspection.run(
          async (withEnvironment, marker) => {
            const writerCommand =
              changing && withEnvironment && plainInspections === 0 ? "starting" : "writer";
            if (!withEnvironment) plainInspections++;
            const alive = (child: ChildProcess | undefined) => {
              if (!child?.pid) return false;
              try {
                return kill(child.pid, 0);
              } catch {
                return false;
              }
            };
            return [
              `${process.pid} ${uid} S inspector LIMITLESS_PROCESS_SCAN=${marker}`,
              ...(alive(writer)
                ? [
                    `${writer?.pid} ${uid} S ${writerCommand}${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}`,
                  ]
                : []),
              `${control?.pid} ${uid} S control LIMITLESS_INVOCATION=${marker}${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}-other OTHER_LIMITLESS_INVOCATION=${marker}` : ""}`,
              `${foreign?.pid} ${uid + 1} S foreign${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}`,
            ].join("\n");
          },
          () =>
            runProcess({
              cmd: ["/bin/sh", "-c", "exit 0"],
              cwd: dir,
              env: process.env as Record<string, string>,
            }),
        );
        expect(signalled.length).toBeGreaterThan(0);
        expect(signalled.every((pid) => pid === writer?.pid)).toBe(true);
        expect(kill(control?.pid ?? 0, 0)).toBe(true);
        expect(kill(foreign?.pid ?? 0, 0)).toBe(true);
      } finally {
        killSpy.mockRestore();
        for (const child of children) child.kill("SIGKILL");
        await Promise.all(
          children.map((child) =>
            child.exitCode !== null || child.signalCode !== null
              ? Promise.resolve()
              : new Promise<void>((resolve) => child.once("close", () => resolve())),
          ),
        );
      }
    },
  );

  test("surviving descendants block cleanup and report termination failure", async () => {
    const children = new Map<ChildProcess, Promise<void>>();
    const kill = process.kill.bind(process);
    const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    let kills = 0;
    const signals: (string | number | undefined)[] = [];
    const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === writer.pid && (signal === "SIGTERM" || signal === "SIGKILL")) {
        kills++;
        signals.push(signal);
        return true;
      }
      return kill(pid, signal);
    });
    const started = performance.now();
    try {
      await processInspection.run(
        async (withEnvironment, marker) =>
          `${writer.pid} ${process.getuid?.()} S writer${withEnvironment ? ` LIMITLESS_INVOCATION=${marker}` : ""}\n` +
          `${process.pid} ${process.getuid?.()} S inspector LIMITLESS_PROCESS_SCAN=${marker}`,
        () =>
          processScope.run(
            {
              signal: new AbortController().signal,
              killGraceMs: 0,
              children,
              scratchDirs: new Set(),
            },
            async () => {
              const invocation = runProcess({
                cmd: ["/bin/sh", "-c", "exit 0"],
                cwd: dir,
                env: process.env as Record<string, string>,
              });
              await expect(invocation).rejects.toBeInstanceOf(ProcessTerminationError);
              expect(processScope.getStore()?.terminationError?.message).toContain(
                "Marked processes still alive",
              );
              let cleanup = false;
              try {
                await sh(["/bin/sh", "-c", "touch cleanup-started"], { cwd: dir });
                cleanup = true;
              } catch (error) {
                expect(error).toBeInstanceOf(ProcessTerminationError);
              }
              expect(cleanup).toBe(false);
              expect(existsSync(join(dir, "cleanup-started"))).toBe(false);
            },
          ),
      );
      expect(kills).toBeGreaterThan(1);
      expect(signals.slice(0, 2)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(performance.now() - started).toBeLessThan(15_000);
      expect(children.size).toBe(1);
      expect(kill(writer.pid ?? 0, 0)).toBe(true);
    } finally {
      killSpy.mockRestore();
      writer.kill("SIGKILL");
      await new Promise<void>((resolve) => writer.once("close", () => resolve()));
    }
  }, 20_000);

  test("sh refuses to return truncated output", async () => {
    const res = await sh(["/bin/sh", "-c", "head -c 70000 /dev/zero | tr '\\0' a"], { cwd: dir });
    expect(res.stdout.length).toBe(70_000);
  });
});

describe("repos", () => {
  test("two local repos with the same basename get distinct slugs", async () => {
    const store = new Store(join(dir, "db.sqlite"));
    for (const p of ["a/service", "b/service"]) {
      mkdirSync(join(dir, p), { recursive: true });
      await sh(["git", "init", "-q"], { cwd: join(dir, p) });
    }
    const a = await resolveRepo(store, join(dir, "a/service"));
    const b = await resolveRepo(store, join(dir, "b/service"));
    expect(a.id).not.toBe(b.id);
    expect(b.localPath).toBe(join(dir, "b/service"));
    expect((await resolveRepo(store, join(dir, "b/service"))).id).toBe(b.id);
    store.close();
  });

  test("name-status keeps both sides of a rename", () => {
    expect(parseNameStatus("R100\tprotected/x.test.ts\tsrc/disabled.txt\nM\ta.ts\n")).toEqual([
      { status: "R100", path: "src/disabled.txt", from: "protected/x.test.ts" },
      { status: "M", path: "a.ts" },
    ]);
  });
});

describe("audit hardening", () => {
  const diff = (files: ReturnType<typeof parseNameStatus>, patch = "") => ({
    patch,
    files,
    stat: "",
    added: 0,
    removed: 0,
  });

  test("renaming a protected file or moving a test out of the runner's reach is blocked", () => {
    const f = auditDiff(diff(parseNameStatus("R100\tprotected/x.test.ts\tsrc/disabled.txt")), {
      taskClass: "feature",
      protectedPaths: ["protected/**"],
    });
    const rules = f.map((x) => `${x.rule}:${x.severity}`);
    expect(rules).toContain("protected-path:block");
    expect(rules).toContain("test-moved-out:block");
  });

  test("changing a script a gate runs is blocked", () => {
    const f = auditDiff(diff([{ status: "M", path: "package.json" }]), {
      taskClass: "bugfix",
      protectedPaths: [],
      gateScripts: {
        before: { test: "bun test", lint: "biome check ." },
        after: { test: "true", lint: "biome check ." },
      },
    });
    expect(f).toEqual([
      {
        rule: "gate-script-changed",
        severity: "block",
        file: "package.json",
        detail: 'Changed the "test" script that a factory check runs ("bun test" → "true").',
      },
    ]);
  });

  test("skip markers inside string literals are not flagged", () => {
    const patch = [
      "diff --git a/t/a.test.ts b/t/a.test.ts",
      "+++ b/t/a.test.ts",
      `+  const src = "it.skip('x', () => {})";`,
    ].join("\n");
    const f = auditDiff(diff([{ status: "M", path: "t/a.test.ts" }], patch), {
      taskClass: "test",
      protectedPaths: [],
    });
    expect(f.find((x) => x.rule === "test-skipped")).toBeUndefined();
  });

  test("gate script names come from the gate commands", () => {
    const names = gateScriptNames({
      setup: ["bun install --frozen-lockfile"],
      checks: [
        { name: "lint", run: "bun run lint" },
        { name: "t", run: "npm test" },
        { name: "b", run: "bun test" },
      ],
      source: "detected",
      protectedPaths: [],
    });
    expect(names.sort()).toEqual(["lint", "test"]);
    expect(pickScripts(JSON.stringify({ scripts: { lint: "biome", other: "x" } }), ["lint", "test"])).toEqual(
      {
        lint: "biome",
      },
    );
  });

  test("setup failing after the change blocks, even if it also failed before", () => {
    const r = (name: string, ok: boolean) => ({
      name,
      command: name,
      ok,
      exitCode: ok ? 0 : 1,
      durationMs: 1,
      output: "",
    });
    const cmp = compareGates(
      { setupOk: false, setup: [r("setup", false)], checks: [r("test", true)] },
      { setupOk: false, setup: [r("setup", false)], checks: [] },
    );
    expect(cmp.every((c) => c.blocking)).toBe(true);
    expect(cmp.map((c) => c.verdict)).toEqual(["regressed", "not_run"]);
  });
});

describe("provider tracker hardening", () => {
  test("a cancelled waiter does not strand the next one", async () => {
    const store = new Store(join(dir, "db.sqlite"));
    const tracker = new ProviderTracker(
      [{ id: "p", label: "p", harness: "fake", billing: "free", maxConcurrent: 1 }],
      store,
      reserves,
      {},
    );
    const release = await tracker.acquire("p", new AbortController().signal);
    const cancelled = new AbortController();
    const first = tracker.acquire("p", cancelled.signal).catch(() => "cancelled");
    let secondGot = false;
    const second = tracker.acquire("p", new AbortController().signal).then((r) => {
      secondGot = true;
      return r;
    });
    cancelled.abort();
    expect(await first).toBe("cancelled");
    release();
    const release2 = await second;
    expect(secondGot).toBe(true);
    release2();
    store.close();
  });

  test("a zero budget means the provider is never used", () => {
    const store = new Store(join(dir, "db.sqlite"));
    const tracker = new ProviderTracker(
      [{ id: "or", label: "or", harness: "claude", billing: "metered", maxConcurrent: 1 }],
      store,
      reserves,
      {},
      { or: 0 },
    );
    expect(tracker.unavailableReason("or")).toBe("at reserve limit");
    store.close();
  });
});

describe("HTTP API", () => {
  test("refuses cross-origin and non-JSON mutations", async () => {
    const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg"), port: 0 });
    const factory = new Factory(cfg, {
      confinement: fakeConfinement,
      harnesses: { fake: fakeHarness(() => ({})) },
    });
    const server = startHttp(factory);
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const evil = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ repo: "x/y", prompt: "rm -rf" }),
      });
      expect(evil.status).toBe(403);
      const textPlain = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ repo: "x/y", prompt: "p" }),
      });
      expect(textPlain.status).toBe(415);
      const tunnel = await fetch(`${base}/api/runs`, { headers: { "cf-connecting-ip": "1.2.3.4" } });
      expect(tunnel.status).toBe(403);
      const ok = await fetch(`${base}/api/runs`);
      expect(ok.status).toBe(200);
    } finally {
      await server.stop(true);
      factory.store.close();
    }
  });
});

describe("pipeline hardening", () => {
  async function setupRepo(files: Record<string, string>): Promise<string> {
    const repo = join(dir, "target");
    mkdirSync(repo);
    for (const [p, c] of Object.entries(files)) writeFileSync(join(repo, p), c);
    await sh(["git", "init", "-q", "-b", "main"], { cwd: repo });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repo });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
    return repo;
  }

  const providers = [
    { id: "a", label: "a", harness: "fake" as const, billing: "subscription" as const, maxConcurrent: 2 },
    { id: "b", label: "b", harness: "fake" as const, billing: "subscription" as const, maxConcurrent: 2 },
  ];
  const models = [
    {
      id: "a/m",
      provider: "a",
      model: "a",
      vendor: "anthropic" as const,
      origin: "unknown",
      baseOrigin: "unknown",
      supportedEfforts: [],
      tier: 4 as const,
      price: { input: 0, output: 0 },
    },
    {
      id: "b/m",
      provider: "b",
      model: "b",
      vendor: "openai" as const,
      origin: "unknown",
      baseOrigin: "unknown",
      supportedEfforts: [],
      tier: 4 as const,
      price: { input: 0, output: 0 },
    },
  ];
  const everyone = { default: ["a/m", "b/m"] };
  const policy = {
    triage: everyone,
    spec: everyone,
    holdout: everyone,
    implement: everyone,
    review: everyone,
    verify: everyone,
  } as never;

  const role = (prompt: string) =>
    prompt.startsWith("Classify")
      ? "triage"
      : prompt.startsWith("Write the specification")
        ? "spec"
        : prompt.startsWith("Write holdout checks")
          ? "holdout"
          : prompt.startsWith("You are an adversarial")
            ? "review"
            : prompt.startsWith("You are the acceptance verifier")
              ? "verify"
              : "implement";

  async function waitDone(f: Factory, id: string): Promise<string> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const s = f.store.getRun(id)?.status as string;
      if (["succeeded", "failed", "needs_human", "cancelled"].includes(s)) return s;
      if (Date.now() > deadline) throw new Error(`timeout (${s})`);
      await Bun.sleep(25);
    }
  }

  test("an unconfirmed shutdown fails the implement round without starting cleanup or another round", () =>
    processInspection.run(
      async (_withEnvironment, marker) =>
        `${process.pid} ${process.getuid?.()} S inspector LIMITLESS_PROCESS_SCAN=${marker}`,
      async () => {
        const repo = await setupRepo({ "a.txt": "a\n" });
        let implementCalls = 0;
        const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg") });
        const f = new Factory(cfg, {
          confinement: fakeConfinement,
          providers,
          models,
          policy,
          harnesses: {
            fake: fakeHarness(async (spec) => {
              if (role(spec.prompt) === "triage")
                return {
                  structured: {
                    title: "t",
                    task_class: "feature",
                    complexity: "small",
                    risk: "low",
                    ambiguity: "low",
                    blocking_questions: [],
                    summary: "s",
                    suggested_profile: "quick",
                  },
                };
              implementCalls++;
              return processInspection.run(
                async () => {
                  throw new Error("cannot inspect marked descendant");
                },
                async () => {
                  await runProcess({
                    cmd: ["/bin/sh", "-c", "exit 0"],
                    cwd: spec.cwd,
                    env: process.env as Record<string, string>,
                  });
                  return {};
                },
              );
            }),
          },
        });
        f.start();
        try {
          const run = await f.createRun({ repo, prompt: "change a" });
          expect(await waitDone(f, run.id)).toBe("needs_human");
          expect(implementCalls).toBe(1);
          expect(f.store.getRun(run.id)?.error).toContain("Invocation termination could not be confirmed");
          expect(f.store.getRunState<{ feedback: string }>(run.id)?.feedback).toContain(
            "cannot inspect marked descendant",
          );
          expect(f.store.listInvocations(run.id).find((i) => i.role === "implement")).toMatchObject({
            status: "error",
            error: expect.stringContaining("cannot inspect marked descendant"),
          });
          expect(f.store.listStages(run.id).find((s) => s.name === "implement")).toMatchObject({
            status: "failed",
            round: 0,
          });
          expect(f.store.listStages(run.id).some((s) => s.name === "gates" && s.round === 0)).toBe(false);
        } finally {
          await f.stop();
          f.store.close();
        }
      },
    ));

  test("a verifier that skips criteria cannot pass, and an 'approve' with a blocker is a rejection", async () => {
    const repo = await setupRepo({ "a.txt": "a\n" });
    let verifies = 0;
    let reviews = 0;
    const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg") });
    const f = new Factory(cfg, {
      confinement: fakeConfinement,
      providers,
      models,
      policy,
      harnesses: {
        fake: fakeHarness((s) => {
          const r = role(s.prompt);
          if (r === "triage")
            return {
              structured: {
                title: "t",
                task_class: "feature",
                complexity: "small",
                risk: "low",
                ambiguity: "low",
                blocking_questions: [],
                summary: "s",
                suggested_profile: "standard",
              },
            };
          if (r === "spec")
            return {
              structured: {
                summary: "s",
                assumptions: [],
                requirements: [],
                acceptance_criteria: [
                  { id: "AC-1", criterion: "one", how_to_verify: "x" },
                  { id: "AC-2", criterion: "two", how_to_verify: "y" },
                ],
                out_of_scope: [],
                blocking_questions: [],
              },
            };
          if (r === "holdout")
            return {
              structured: {
                scenarios: [
                  { id: "H-1", description: "case 1", steps: "cat a.txt", expected: "a", edge_case: false },
                  {
                    id: "H-2",
                    description: "case 2",
                    steps: "test -s a.txt",
                    expected: "exit zero",
                    edge_case: true,
                  },
                  {
                    id: "H-3",
                    description: "case 3",
                    steps: "test ! -e b.txt",
                    expected: "exit zero",
                    edge_case: true,
                  },
                ],
              },
            };
          if (r === "review") {
            reviews++;
            return {
              structured: {
                verdict: "approve",
                summary: "fine: checked the diff against every requirement",
                findings:
                  reviews === 1
                    ? [
                        {
                          severity: "blocker",
                          security: false,
                          ...findingEvidence,
                          file: "a.txt",
                          line: 1,
                          title: "broken",
                          detail: "d",
                          suggestion: "s",
                        },
                      ]
                    : [],
              },
            };
          }
          if (r === "verify") {
            verifies++;
            // First verifier only reports AC-1 and claims "pass"; second covers both.
            return {
              structured:
                verifies === 1
                  ? {
                      criteria: [{ id: "AC-1", status: "met", evidence: "e", publicSummary: "" }],
                      overall: "pass",
                      notes: "",
                    }
                  : {
                      criteria: [
                        { id: "AC-1", status: "met", evidence: "e", publicSummary: "" },
                        { id: "AC-2", status: "met", evidence: "e", publicSummary: "" },
                        { id: "H-1", status: "met", evidence: "e", publicSummary: "" },
                        { id: "H-2", status: "met", evidence: "e", publicSummary: "" },
                        { id: "H-3", status: "met", evidence: "e", publicSummary: "" },
                      ],
                      overall: "pass",
                      notes: "",
                    },
            };
          }
          return { files: { "a.txt": `a${Math.random()}\n` } };
        }),
      },
    });
    f.start();
    try {
      const run = await f.createRun({ repo, prompt: "change a" });
      expect(await waitDone(f, run.id)).toBe("succeeded");
      expect(reviews).toBe(3); // round 0 rejected (blocker), round 1 approved, round 2 approved
      expect(verifies).toBe(2); // round 1 verify incomplete → fail, round 2 pass
      const verify1 = JSON.parse(f.store.getArtifact(run.id, "verify-1.json") as string);
      expect(verify1.overall).toBe("fail");
      expect(verify1.criteria.find((c: { id: string }) => c.id === "AC-2").status).toBe("unclear");
    } finally {
      await f.stop();
      f.store.close();
    }
  });

  test("weakening the test script is caught even though gates then pass", async () => {
    const repo = await setupRepo({
      "package.json": JSON.stringify({ scripts: { test: "exit 1" } }),
      ".limitless.toml": '[gates]\nchecks = [{ name = "test", run = "npm run test" }]\n',
    });
    let rounds = 0;
    const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg") });
    const f = new Factory(cfg, {
      confinement: fakeConfinement,
      providers,
      models,
      policy,
      harnesses: {
        fake: fakeHarness((s) => {
          const r = role(s.prompt);
          if (r === "triage")
            return {
              structured: {
                title: "t",
                task_class: "bugfix",
                complexity: "small",
                risk: "low",
                ambiguity: "low",
                blocking_questions: [],
                summary: "s",
                suggested_profile: "quick",
              },
            };
          if (r === "review")
            return {
              structured: {
                verdict: "approve",
                summary: "ok: checked the diff against every requirement",
                findings: [],
              },
            };
          rounds++;
          return { files: { "package.json": JSON.stringify({ scripts: { test: "true" } }) } };
        }),
      },
    });
    f.start();
    try {
      const run = await f.createRun({ repo, prompt: "make the tests pass" });
      expect(await waitDone(f, run.id)).toBe("needs_human");
      const events = f.store.listEvents(run.id, { limit: 5000 });
      expect(events.some((e) => e.type === "audit" && e.message.includes("gate-script-changed"))).toBe(true);
      expect(rounds).toBeGreaterThan(1);
    } finally {
      await f.stop();
      f.store.close();
    }
  });
});

describe("resume after restart", () => {
  test("a restart during review resumes at the checks without re-implementing", async () => {
    const repo = join(dir, "target");
    mkdirSync(repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    await sh(["git", "init", "-q", "-b", "main"], { cwd: repo });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: repo });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });

    const providers = [
      { id: "a", label: "a", harness: "fake" as const, billing: "free" as const, maxConcurrent: 2 },
    ];
    const models = [
      {
        id: "a/m",
        provider: "a",
        model: "a",
        vendor: "anthropic" as const,
        origin: "unknown",
        baseOrigin: "unknown",
        supportedEfforts: [],
        tier: 4 as const,
        price: { input: 0, output: 0 },
      },
    ];
    const everyone = { default: ["a/m"] };
    const policy = { triage: everyone, implement: everyone, review: everyone } as never;
    let implementCalls = 0;
    let reviewDelay = 30_000;
    const harness = fakeHarness((s) => {
      if (s.prompt.startsWith("Classify"))
        return {
          structured: {
            title: "t",
            task_class: "feature",
            complexity: "small",
            risk: "low",
            ambiguity: "low",
            blocking_questions: [],
            summary: "s",
            suggested_profile: "quick",
          },
        };
      if (s.prompt.startsWith("You are an adversarial"))
        return {
          delayMs: reviewDelay,
          structured: {
            verdict: "approve",
            summary: "ok: checked the diff against every requirement",
            findings: [],
          },
        };
      implementCalls++;
      return { files: { "b.txt": "b\n" } };
    });
    const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "cfg") });

    const first = new Factory(cfg, {
      confinement: fakeConfinement,
      providers,
      models,
      policy,
      harnesses: { fake: harness },
    });
    first.start();
    const run = await first.createRun({ repo, prompt: "add b" });
    const deadline = Date.now() + 10_000;
    while (first.store.getRun(run.id)?.stage !== "review" && Date.now() < deadline) await Bun.sleep(20);
    first.scheduler.drain();
    expect(first.scheduler.draining).toBe(true);
    await first.stop(); // simulated restart mid-review
    expect(first.store.getRun(run.id)?.status).toBe("queued");
    first.store.close();

    reviewDelay = 0;
    const second = new Factory(cfg, {
      confinement: fakeConfinement,
      providers,
      models,
      policy,
      harnesses: { fake: harness },
    });
    expect(second.scheduler.draining).toBe(false);
    // Also cover an abrupt shutdown that left a persisted running status.
    second.store.updateRun(run.id, { status: "running" });
    second.start();
    try {
      const end = Date.now() + 10_000;
      while (second.store.getRun(run.id)?.status !== "succeeded" && Date.now() < end) await Bun.sleep(20);
      expect(second.store.getRun(run.id)?.status).toBe("succeeded");
      expect(implementCalls).toBe(1);
      expect(
        second.store.listEvents(run.id).some((event) => event.message.includes("re-queued to resume")),
      ).toBe(true);
    } finally {
      await second.stop();
      second.store.close();
    }
  });
});

describe("repo cache concurrency", () => {
  test("concurrent runs share one clone of a remote repo", async () => {
    const { ensureCache, fetchBase } = await import("../src/git/repos.ts");
    const origin = join(dir, "origin");
    mkdirSync(origin);
    writeFileSync(join(origin, "a.txt"), "a\n");
    await sh(["git", "init", "-q", "-b", "main"], { cwd: origin });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: origin });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: origin });
    const paths = {
      home: dir,
      db: "",
      repos: join(dir, "repos"),
      work: join(dir, "work"),
      runs: "",
      configDir: "",
    };
    const repo = {
      id: "r",
      slug: "o/origin",
      kind: "github" as const,
      url: origin,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr" as const,
      createdAt: 0,
    };
    const caches = await Promise.all([
      ensureCache(paths, repo),
      ensureCache(paths, repo),
      ensureCache(paths, repo),
    ]);
    for (const c of caches) {
      const r = await sh(["git", "rev-parse", "origin/main"], { cwd: c });
      expect(r.stdout.trim()).toHaveLength(40);
    }

    writeFileSync(join(origin, "b.txt"), "b\n");
    await sh(["git", "add", "."], { cwd: origin });
    await sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "advance"], {
      cwd: origin,
    });
    const tip = (await sh(["git", "rev-parse", "HEAD"], { cwd: origin })).stdout.trim();
    const fetched = await Promise.all([
      ...Array.from({ length: 8 }, () => fetchBase(paths, repo, "main")),
      ensureCache(paths, repo),
    ]);
    expect(fetched.slice(0, -1)).toEqual(Array(8).fill(tip));
    expect((await sh(["git", "rev-parse", "origin/main"], { cwd: caches[0] })).stdout.trim()).toBe(tip);
  });
});

test("adding a file under a protected path warns; editing one blocks", () => {
  const f = auditDiff(
    {
      patch: "",
      files: [
        { status: "A", path: "test/fixtures/new.json" },
        { status: "M", path: "test/fixtures/old.json" },
      ],
      stat: "",
      added: 0,
      removed: 0,
    },
    { taskClass: "feature", protectedPaths: ["test/fixtures/**"] },
  );
  expect(f.map((x) => `${x.file}:${x.severity}`)).toEqual([
    "test/fixtures/new.json:warn",
    "test/fixtures/old.json:block",
  ]);
});

test("review/verify timeouts scale with the size of the change", async () => {
  const { readingTimeout } = await import("../src/pipeline/engine.ts");
  expect(readingTimeout(0)).toBe(20 * 60_000);
  expect(readingTimeout(935)).toBe(40 * 60_000);
  expect(readingTimeout(935, 25)).toBe(45 * 60_000);
  expect(readingTimeout(10_000)).toBe(60 * 60_000);
});
