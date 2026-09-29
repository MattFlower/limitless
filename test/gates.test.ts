import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditDiff } from "../src/gates/audit.ts";
import { detectGates, type GateConfig } from "../src/gates/detect.ts";
import {
  compareGates,
  type GateRun,
  retryBaselineFailures,
  retryRegressions,
  runGates,
} from "../src/gates/run.ts";
import { defaultGateSlots, gateSlots, Semaphore } from "../src/gates/slots.ts";
import type { DiffInfo } from "../src/git/repos.ts";

function tempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "limitless-gates-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("detectGates", () => {
  test("bun project with scripts", () => {
    const dir = tempDir({
      "package.json": JSON.stringify({
        scripts: { lint: "biome check .", typecheck: "tsc", test: "bun test" },
      }),
      "bun.lock": "",
    });
    const g = detectGates(dir);
    expect(g.source).toBe("detected");
    expect(g.setup).toEqual(["bun install --frozen-lockfile"]);
    expect(g.checks.map((c) => c.run)).toEqual(["bun run lint", "bun run typecheck", "bun run test"]);
  });

  test("npm default test script is ignored", () => {
    const dir = tempDir({
      "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      "package-lock.json": "{}",
    });
    expect(detectGates(dir).checks).toEqual([]);
  });

  test(".limitless.toml wins", () => {
    const dir = tempDir({
      "package.json": "{}",
      ".limitless.toml": `[gates]\nsetup = ["make deps"]\nchecks = [{ name = "unit", run = "make test" }]\n[policy]\nmerge = "pr"\nprotected_paths = ["migrations/**"]\n`,
    });
    const g = detectGates(dir);
    expect(g.source).toBe(".limitless.toml");
    expect(g.checks).toEqual([{ name: "unit", run: "make test" }]);
    expect(g.merge).toBe("pr");
    expect(g.protectedPaths).toEqual(["migrations/**"]);
  });

  test("go and rust", () => {
    expect(detectGates(tempDir({ "go.mod": "module x" })).checks.map((c) => c.name)).toEqual(["vet", "test"]);
    expect(detectGates(tempDir({ "Cargo.toml": "[package]" })).checks.map((c) => c.name)).toEqual([
      "check",
      "test",
    ]);
  });
});

describe("runGates / compareGates", () => {
  test("runs commands and captures output", async () => {
    const dir = tempDir({ "ok.txt": "fine" });
    const run = await runGates(
      dir,
      {
        setup: [],
        checks: [
          { name: "exists", run: "test -f ok.txt && echo present" },
          { name: "missing", run: "cat nope.txt" },
        ],
        source: "detected",
        protectedPaths: [],
      },
      new AbortController().signal,
    );
    expect(run.checks[0]?.ok).toBe(true);
    expect(run.checks[0]?.output).toContain("present");
    expect(run.checks[1]?.ok).toBe(false);
  });

  const r = (name: string, ok: boolean) => ({
    name,
    command: name,
    ok,
    exitCode: ok ? 0 : 1,
    durationMs: 1,
    output: "",
  });

  test("classifies regressions vs pre-existing failures", () => {
    const baseline: GateRun = {
      setupOk: true,
      setup: [],
      checks: [r("lint", true), r("test", false), r("types", true)],
    };
    const after: GateRun = {
      setupOk: true,
      setup: [],
      checks: [r("lint", false), r("test", false), r("types", true)],
    };
    const cmp = compareGates(baseline, after);
    expect(cmp.map((c) => [c.name, c.verdict, c.blocking])).toEqual([
      ["lint", "regressed", true],
      ["test", "still_failing", false],
      ["types", "pass", false],
    ]);
  });

  test("setup failure after change is blocking", () => {
    const after: GateRun = { setupOk: false, setup: [r("setup", false)], checks: [] };
    expect(compareGates({ setupOk: true, setup: [r("setup", true)], checks: [] }, after)[0]?.blocking).toBe(
      true,
    );
  });
});

describe("gate slots and flaky retry", () => {
  const signal = new AbortController().signal;
  const config = (run: string): GateConfig => ({
    setup: [],
    checks: [{ name: "test", run }],
    source: "detected",
    protectedPaths: [],
  });

  test("the semaphore bounds concurrent gate processes", async () => {
    const dir = tempDir({});
    const log = join(dir, "log");
    const cfg = config(`echo + >> '${log}'; sleep 0.2; echo - >> '${log}'`);
    const previous = gateSlots.limit;
    let waits = 0;
    gateSlots.setLimit(2);
    try {
      const runs = Array.from({ length: 5 }, () => runGates(dir, cfg, signal, { onWait: () => waits++ }));
      expect((await Promise.all(runs)).every((run) => run.checks[0]?.ok)).toBe(true);
    } finally {
      gateSlots.setLimit(previous);
    }
    let running = 0;
    let peak = 0;
    for (const line of readFileSync(log, "utf8").trim().split("\n")) {
      running += line === "+" ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBeLessThanOrEqual(2);
    expect(waits).toBe(3);
    expect(defaultGateSlots(3)).toBe(1);
    expect(defaultGateSlots(16)).toBe(4);
  });

  test("a queued slot request gives up on cancel without taking a slot", async () => {
    const slots = new Semaphore(1);
    const release = await slots.acquire(signal);
    const cancel = new AbortController();
    const queued = slots.acquire(cancel.signal);
    cancel.abort();
    await expect(queued).rejects.toThrow();
    release();
    let waited = false;
    (await slots.acquire(signal, () => (waited = true)))();
    expect(waited).toBe(false);
  });

  /** Baseline passed (or not), then the check ran after the change and maybe once more. */
  async function retried(run: string, baselineOk = true) {
    const dir = tempDir({});
    const cfg = config(run);
    const base = { name: "test", command: run, ok: baselineOk, exitCode: 0, durationMs: 1, output: "" };
    const cmp = compareGates({ setupOk: true, setup: [], checks: [base] }, await runGates(dir, cfg, signal));
    const [c] = await retryRegressions(cmp, dir, cfg, ["src/app.ts"], signal);
    const runs = readFileSync(join(dir, "runs"), "utf8").trim().split("\n").length;
    return { c, summary: [c?.verdict, c?.blocking, c?.firstAttempt?.ok ?? "not retried", runs] };
  }

  test("fail → retry → pass is flaky and does not block", async () => {
    const { c, summary } = await retried(
      "echo x >> runs; test -f once || { touch once; echo slow; exit 1; }",
    );
    expect(summary).toEqual(["flaky", false, false, 2]);
    expect(c?.result.ok).toBe(true);
    expect(c?.firstAttempt?.output).toContain("slow");
  });

  test("fail → retry → fail stays blocking", async () => {
    expect((await retried("echo x >> runs; exit 1")).summary).toEqual(["regressed", true, false, 2]);
  });

  test("a check failing on the baseline or pointing at a changed file is not retried", async () => {
    const failing = await retried("echo x >> runs; exit 1", false);
    expect(failing.summary).toEqual(["still_failing", false, "not retried", 1]);
    const pointed = await retried("echo x >> runs; echo 'at /repo/src/app.ts:12:3'; exit 1");
    expect(pointed.summary).toEqual(["regressed", true, "not retried", 1]);
  });

  /** Baseline run plus its one retry; `runs` counts check invocations. */
  async function baseline(cfg: GateConfig, dir: string, abort = new AbortController()) {
    const run = await retryBaselineFailures(await runGates(dir, cfg, signal), dir, cfg, abort.signal);
    const log = join(dir, "runs");
    const runs = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
    return { run, runs };
  }

  test("baseline fail → retry → pass is recorded as passing with the first attempt", async () => {
    const dir = tempDir({});
    const { run, runs } = await baseline(
      config("echo x >> runs; test -f once || { touch once; echo slow; exit 1; }"),
      dir,
    );
    const [c] = run.checks;
    expect([c?.ok, c?.firstAttempt?.ok, runs]).toEqual([true, false, 2]);
    expect(c?.firstAttempt?.output).toContain("slow");
    expect(compareGates(run, await runGates(dir, config("exit 1"), signal))[0]).toMatchObject({
      verdict: "regressed",
      blocking: true,
    });
  });

  test("baseline fail → retry → fail stays failing and later failures don't block", async () => {
    const dir = tempDir({});
    const { run, runs } = await baseline(
      config("echo x >> runs; echo attempt $(( $(wc -l < runs) )); exit 1"),
      dir,
    );
    const [c] = run.checks;
    // The failed re-run is the result; the first failure is kept alongside it.
    expect([c?.ok, c?.firstAttempt?.ok, runs]).toEqual([false, false, 2]);
    expect([c?.output, c?.firstAttempt?.output]).toEqual(["attempt 2", "attempt 1"]);
    expect(compareGates(run, await runGates(dir, config("exit 1"), signal))[0]).toMatchObject({
      verdict: "still_failing",
      blocking: false,
    });
  });

  test("a failing baseline check whose output merely looks like a timeout is still retried", async () => {
    const dir = tempDir({});
    const { run, runs } = await baseline(
      config("echo x >> runs; test -f once || { touch once; echo '[timed out] from nested tool'; exit 1; }"),
      dir,
    );
    expect([run.checks[0]?.ok, run.checks[0]?.firstAttempt?.timedOut, runs]).toEqual([true, undefined, 2]);
  });

  test("baseline setup failures, timeouts and cancellation are not retried", async () => {
    const setupDir = tempDir({});
    const setupCfg = { ...config("echo x >> runs; exit 1"), setup: ["echo s >> setups; exit 1"] };
    const setup = await baseline(setupCfg, setupDir);
    expect([setup.run.setupOk, setup.runs, readFileSync(join(setupDir, "setups"), "utf8")]).toEqual([
      false,
      0,
      "s\n",
    ]);

    const slowDir = tempDir({});
    const slowCfg: GateConfig = {
      ...config(""),
      checks: [{ name: "test", run: "echo x >> runs; sleep 5", timeoutSec: 0.2 }],
    };
    const slow = await baseline(slowCfg, slowDir);
    expect([slow.run.checks[0]?.ok, slow.run.checks[0]?.timedOut, slow.runs]).toEqual([false, true, 1]);

    const cancelled = new AbortController();
    cancelled.abort();
    const abortDir = tempDir({});
    expect((await baseline(config("echo x >> runs; exit 1"), abortDir, cancelled)).runs).toBe(1);
  });
});

function diff(patch: string, files: { status: string; path: string }[]): DiffInfo {
  return { patch, files, stat: "", added: 0, removed: 0 };
}

describe("auditDiff", () => {
  test("blocks an empty diff", () => {
    const f = auditDiff(diff("", []), { taskClass: "feature", protectedPaths: [] });
    expect(f).toEqual([
      { rule: "empty-diff", severity: "block", detail: "The implementation produced no changes." },
    ]);
  });

  test("blocks newly skipped tests and flags suppressions", () => {
    const patch = [
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "+++ b/src/a.test.ts",
      "+  it.skip('does the thing', () => {",
      "diff --git a/src/a.ts b/src/a.ts",
      "+++ b/src/a.ts",
      "+  // @ts-ignore",
    ].join("\n");
    const f = auditDiff(
      diff(patch, [
        { status: "M", path: "src/a.test.ts" },
        { status: "M", path: "src/a.ts" },
      ]),
      { taskClass: "bugfix", protectedPaths: [] },
    );
    expect(f.find((x) => x.rule === "test-skipped")?.severity).toBe("block");
    expect(f.find((x) => x.rule === "suppression")?.severity).toBe("warn");
  });

  test("blocks secrets and protected paths, warns on lockfiles and CI", () => {
    const patch = [
      "diff --git a/cfg.ts b/cfg.ts",
      "+++ b/cfg.ts",
      `+const key = "ghp_${"a".repeat(36)}";`,
    ].join("\n");
    const f = auditDiff(
      diff(patch, [
        { status: "M", path: "cfg.ts" },
        { status: "M", path: "db/migrations/001.sql" },
        { status: "M", path: "bun.lock" },
        { status: "M", path: ".github/workflows/ci.yml" },
      ]),
      { taskClass: "feature", protectedPaths: ["db/migrations/**"] },
    );
    const rules = Object.fromEntries(f.map((x) => [x.rule, x.severity]));
    expect(rules).toMatchObject({
      secret: "block",
      "protected-path": "block",
      lockfile: "warn",
      "ci-config": "warn",
    });
  });

  test("lockfile changes are fine for dependency updates", () => {
    const f = auditDiff(diff("", [{ status: "M", path: "package-lock.json" }]), {
      taskClass: "dependency_update",
      protectedPaths: [],
    });
    expect(f.find((x) => x.rule === "lockfile")).toBeUndefined();
  });

  test("flags net assertion removal and --no-verify", () => {
    const patch = [
      "diff --git a/t/x_test.go b/t/x_test.go",
      "+++ b/t/x_test.go",
      '-  t.Errorf("a")',
      '-  t.Errorf("b")',
      '-  t.Fatal("c")',
    ].join("\n");
    const f = auditDiff(diff(patch, [{ status: "M", path: "t/x_test.go" }]), {
      taskClass: "refactor",
      protectedPaths: [],
      toolCommands: ["git commit --no-verify -m x"],
    });
    expect(f.map((x) => x.rule).sort()).toEqual(["assertions-removed", "no-verify"]);
  });
});
