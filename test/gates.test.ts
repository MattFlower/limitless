import { describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseAllow, validateAllow } from "../src/core/allow.ts";
import { attributeRules, auditDiff, newlyHidden, unquote } from "../src/gates/audit.ts";
import {
  baselineCacheKey,
  cacheableBaseline,
  gateEnvDigest,
  gatesHash,
  lockfileHash,
  singleFlight,
} from "../src/gates/cache.ts";
import { detectGates, type GateConfig } from "../src/gates/detect.ts";
import { loadPrivateStrings, privateMatches, redactPrivate } from "../src/gates/private.ts";
import {
  compareGates,
  type GateRun,
  retryBaselineFailures as productionBaselineRetry,
  runGates as productionGates,
  retryRegressions as productionRetry,
} from "../src/gates/run.ts";
import { defaultGateSlots, gateSlots, Semaphore } from "../src/gates/slots.ts";
import { recordWorktree } from "../src/git/command.ts";
import { checkoutCommitted, type DiffInfo } from "../src/git/repos.ts";
import * as sandbox from "../src/harness/sandbox.ts";
import { ConfinementError } from "../src/harness/sandbox.ts";
import { formatAuditFeedback, formatGateFeedback } from "../src/pipeline/prompts.ts";
import * as proc from "../src/util/proc.ts";
import { sh } from "../src/util/proc.ts";
import { fakeConfinement, seatbeltSkip } from "./confinement.ts";

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

  test("a baseline whose check subprocess was killed beneath the gate shell is not cacheable", async () => {
    const cfg = config("echo x >> runs; /bin/sh -c 'kill -KILL $$'; exit $?");
    const { run, runs } = await baseline(cfg, tempDir({}));
    const [c] = run.checks;
    expect([c?.exitCode, c?.firstAttempt?.exitCode, runs]).toEqual([137, 137, 2]);
    expect(cacheableBaseline(run, cfg)).toBe(false);
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

describe("audit allowances and attribute rules", () => {
  test("only standalone Allow lines count, each kind independently", () => {
    expect(parseAllow("Vendor it\r\n  ALLOW:  Submodules \r\nmore")).toEqual(["submodules"]);
    expect(parseAllow("allow:gitattributes\nAllow: submodules\nAllow: submodules")).toEqual([
      "submodules",
      "gitattributes",
    ]);
    for (const text of [
      "do not use git submodules",
      "Please Allow: submodules",
      "> Allow: submodules",
      "Allow: submodules, gitattributes",
      "Allow: everything",
      "Allow submodules",
    ])
      expect(parseAllow(text)).toEqual([]);
    expect(validateAllow(undefined)).toEqual([]);
    expect(validateAllow(["gitattributes", "submodules", "gitattributes"])).toEqual([
      "submodules",
      "gitattributes",
    ]);
    expect(() => validateAllow(["submodules", "Submodules"])).toThrow('Invalid allow value "Submodules"');
    expect(() => validateAllow([1])).toThrow("expected submodules,gitattributes,binary");
  });

  test("built-in diff drivers are harmless alone but not beside a hiding attribute", () => {
    const rules = (line: string) =>
      attributeRules(`diff --git a/.gitattributes b/.gitattributes\n+++ b/.gitattributes\n+${line}`).map(
        (rule) => [rule.pattern, rule.exemptable],
      );
    for (const driver of ["java", "markdown", "golang", "rust", "scheme", "cpp"])
      expect(rules(`*.x diff=${driver}`)).toEqual([]);
    expect(rules("*.java diff=java filter=custom")).toEqual([["*.java", false]]);
    expect(rules("*.java diff=javascript")).toEqual([["*.java", false]]);
    expect(rules("*.ts linguist-generated")).toEqual([["*.ts", false]]);
    expect(rules("*.ts linguist-generated=false")).toEqual([]);
    for (const value of ["unset", "unspecified", "false", "set", "custom"])
      expect(rules(`*.ts filter=${value}`)).toEqual([["*.ts", false]]);
    for (const value of ["unset", "unspecified", "set", "true"])
      expect(rules(`*.ts linguist-generated=${value}`)).toEqual([["*.ts", false]]);
    expect(rules("*.ts -filter -linguist-generated")).toEqual([]);
    for (const attr of ["filter", "diff", "merge"])
      expect(rules(`*.png ${attr}=lfs`)).toEqual([["*.png", true]]);
    expect(rules("*.png binary")).toEqual([["*.png", true]]);
    expect(rules("*.png -diff -text")).toEqual([["*.png", true]]);
    expect(rules("*.png binary=set diff=unset text=unset")).toEqual([["*.png", true]]);
    expect(rules("[attr]hidden -diff")).toEqual([["[attr]hidden", false]]);
    expect(rules('"asset image.png" binary')).toEqual([["asset image.png", true]]);
    expect(rules('"caf\\303\\251\\t\\"x\\"\\\\y.png" -diff')).toEqual([['café\t"x"\\y.png', true]]);
    expect(rules('"[attr]quoted" binary')).toEqual([["[attr]quoted", false]]);
    expect(rules('"bad\\q.png" binary')).toEqual([['"bad\\q.png"', false]]);
    expect(rules('"unterminated binary')).toEqual([['"unterminated', false]]);
    expect(unquote('"a\\u0041"')).toBeNull();
    expect(unquote('"\\a\\b\\f\\n\\r\\v"')).toBe("\x07\b\f\n\r\v");
    expect(newlyHidden({ diff: "unspecified" }, { diff: "java", "linguist-generated": "set" })).toEqual([
      "linguist-generated",
    ]);
    expect(newlyHidden({ diff: "unset" }, { diff: "unset" })).toEqual([]);
  });
});

describe("private strings", () => {
  test.each(["A", "R100"])("quoted %s filename and unrelated diagnostics cannot reveal entries", (status) => {
    const configDir = mkdtempSync(join(tmpdir(), "private-strings-"));
    try {
      writeFileSync(join(configDir, "private-strings.txt"), "secret-host.example\ni\u0307-host.example");
      const patch =
        'diff --git "a/secret-host.example\\t.txt" "b/secret-host.example\\t.txt"\n+++ "b/secret-host.example\\t.txt"\n@@ -0,0 +1 @@\n+SECRET-HOST.EXAMPLE\n';
      const findings = auditDiff(diff(patch, [{ status, path: "secret-host.example\t.txt" }]), {
        configDir,
        taskClass: null,
        protectedPaths: [],
        toolCommands: ["git commit --no-verify İ-host.example"],
      });
      expect(findings.filter((f) => f.rule === "private-string")).toHaveLength(2);
      expect(
        findings.filter((f) => f.rule === "private-string").every((f) => f.file === "[redacted filename]"),
      ).toBe(true);
      const output = JSON.stringify(findings);
      expect(output).not.toContain("secret-host.example");
      expect(output).not.toContain("İ-host.example");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("local loader, absent file, physical entry numbers, and unreadable file", () => {
    const configDir = mkdtempSync(join(tmpdir(), "private-strings-"));
    try {
      const changes = diff("diff --git a/a.txt b/a.txt\n@@ -0,0 +1 @@\n+SECRET-HOST.EXAMPLE", [
        { status: "A", path: "a.txt" },
      ]);
      expect(loadPrivateStrings(configDir)).toEqual([]);
      expect(auditDiff(changes, { configDir, taskClass: null, protectedPaths: [] })).toEqual([]);
      writeFileSync(join(configDir, "private-strings.txt"), "  # ignored\n\n  secret-host.example  \n");
      const findings = auditDiff(changes, { configDir, taskClass: null, protectedPaths: [] });
      expect(findings).toEqual([
        {
          rule: "private-string",
          severity: "block",
          file: "a.txt",
          detail: "a.txt:1 contains a private string (entry 3 in private-strings.txt)",
        },
      ]);
      rmSync(join(configDir, "private-strings.txt"));
      mkdirSync(join(configDir, "private-strings.txt"));
      expect(() => loadPrivateStrings(configDir)).toThrow(
        "Cannot read private-strings.txt; publication blocked",
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("multiple hunks, header-like content, added and renamed filenames redact every finding and feedback", () => {
    const configDir = mkdtempSync(join(tmpdir(), "private-strings-"));
    try {
      writeFileSync(join(configDir, "private-strings.txt"), "secret-host.example\nsecond-entry");
      const patch =
        "diff --git a/safe.txt b/safe.txt\n--- a/safe.txt\n+++ b/safe.txt\n@@ -1,2 +1,3 @@\n context\n+SECRET-HOST.EXAMPLE second-entry\n kept\n@@ -20 +21,2 @@\n keep\n+++ b/secret-host.example\n";
      const changes = diff(patch, [
        { status: "M", path: "safe.txt" },
        { status: "A", path: "SECRET-HOST.EXAMPLE.txt" },
        { status: "R100", path: "secret-host.example.test.ts" },
      ]);
      const findings = auditDiff(changes, { configDir, taskClass: null, protectedPaths: ["*.ts"] });
      expect(findings.filter((f) => f.rule === "private-string")).toHaveLength(5);
      expect(findings.some((f) => f.detail.startsWith("safe.txt:22 "))).toBe(true);
      expect(findings.filter((f) => f.file === "[redacted filename]")).toHaveLength(3);
      expect(JSON.stringify(findings).toLowerCase()).not.toContain("secret-host.example");
      expect(JSON.stringify(findings)).not.toContain("second-entry");
      expect(formatAuditFeedback(findings).toLowerCase()).not.toContain("secret-host.example");
      expect(formatAuditFeedback(findings)).toContain("entry 2 in private-strings.txt");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("auditDiff", () => {
  test("explicit allowances are narrow and independent; request wording never exempts", () => {
    const patch = [
      "diff --git a/vendor/nested b/vendor/nested",
      "new file mode 160000",
      "index 0000000..1234567",
      "+++ b/vendor/nested",
      "+Subproject commit 1234567",
      "diff --git a/.gitattributes b/.gitattributes",
      "+++ b/.gitattributes",
      "+*.ts -diff",
      "diff --git a/a.test.ts b/a.test.ts",
      "+++ b/a.test.ts",
      '+test.skip("hidden", () => {});',
    ].join("\n");
    const changes = diff(patch, [
      { status: "A", path: "vendor/nested" },
      { status: "A", path: ".gitattributes" },
      { status: "M", path: "a.test.ts" },
    ]);
    for (const [allow, rules] of [
      [[], ["gitlink", "gitattributes", "test-skipped"]],
      [["submodules"], ["gitattributes", "test-skipped"]],
      [["gitattributes"], ["gitlink", "test-skipped"]],
      [["submodules", "gitattributes"], ["test-skipped"]],
    ] as const) {
      expect(auditDiff(changes, { taskClass: null, protectedPaths: [], allow }).map((f) => f.rule)).toEqual([
        ...rules,
      ]);
    }
    const findings = auditDiff(changes, { taskClass: null, protectedPaths: [] });
    expect(findings.find((f) => f.rule === "gitlink")?.detail).toContain(
      "Remove the nested repository unless the request asks for it. If this is intended, add `Allow: submodules` to the request.",
    );
    expect(findings.find((f) => f.rule === "gitattributes")?.detail).toContain(
      "Remove the attribute change unless the request asks for it. If this is intended, add `Allow: gitattributes` to the request.",
    );
    expect(
      auditDiff(changes, {
        taskClass: null,
        protectedPaths: [],
        toolCommands: ["echo submodule .gitattributes"],
      }).map((f) => f.rule),
    ).toEqual(["gitlink", "gitattributes", "test-skipped"]);
  });

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

describe("baseline cache", () => {
  const cfg: GateConfig = {
    setup: ["bun install"],
    checks: [
      { name: "lint", run: "bun run lint" },
      { name: "test", run: "bun test" },
    ],
    source: ".limitless.toml",
    protectedPaths: [],
  };
  const result = (name: string, command: string, over: Partial<GateRun["checks"][number]> = {}) => ({
    name,
    command,
    ok: true,
    exitCode: 0,
    durationMs: 1,
    output: "",
    ...over,
  });
  const complete: GateRun = {
    setupOk: true,
    setup: [result("setup", "bun install")],
    checks: [
      result("lint", "bun run lint"),
      result("test", "bun test", { firstAttempt: result("test", "bun test", { ok: false, exitCode: 1 }) }),
    ],
  };

  test("only a baseline whose every configured step passed is cacheable", () => {
    expect(cacheableBaseline(complete, cfg)).toBe(true);
    const [lint, tests] = complete.checks as [GateRun["checks"][number], GateRun["checks"][number]];
    const failed = { ...tests, ok: false, exitCode: 1 };
    const incomplete: GateRun[] = [
      { setupOk: false, setup: [result("setup", "bun install", { ok: false, exitCode: 1 })], checks: [] },
      { ...complete, checks: [lint] },
      // A check that failed its first attempt and its retry: a flaky base must not be cached.
      { ...complete, checks: [lint, failed] },
      { ...complete, checks: [{ ...lint, ok: false, exitCode: 2 }, tests] },
      { ...complete, checks: [lint, { ...failed, timedOut: true, exitCode: null }] },
      { ...complete, checks: [lint, { ...tests, firstAttempt: { ...failed, exitCode: 143 } }] },
      { ...complete, checks: [lint, { ...tests, command: "bun test --bail" }] },
      { ...complete, setup: [] },
    ];
    for (const run of incomplete) expect(cacheableBaseline(run, cfg)).toBe(false);
  });

  test("changing any key input misses: base, repo, gates, lockfile, Bun, platform, arch, build, env", () => {
    const inputs = {
      repoId: "repo",
      baseSha: "a".repeat(40),
      gates: cfg,
      lockfileHash: "lock",
      bunVersion: "1.3.0",
      platform: "darwin",
      arch: "arm64",
      buildSha: "b".repeat(40),
      envDigest: "env",
    };
    const key = JSON.stringify(baselineCacheKey(inputs));
    expect(JSON.stringify(baselineCacheKey({ ...inputs }))).toBe(key);
    const changes: Partial<typeof inputs>[] = [
      { repoId: "other" },
      { baseSha: "c".repeat(40) },
      { gates: { ...cfg, checks: [{ name: "lint", run: "bun run lint --fix" }] } },
      { lockfileHash: "lock2" },
      { bunVersion: "1.3.1" },
      { platform: "linux" },
      { arch: "x64" },
      { buildSha: "d".repeat(40) },
      { envDigest: "env2" },
    ];
    for (const change of changes)
      expect(JSON.stringify(baselineCacheKey({ ...inputs, ...change }))).not.toBe(key);
  });

  test("the lockfile hash follows lockfile content", () => {
    const dir = tempDir({ "bun.lock": "a" });
    const before = lockfileHash(dir);
    expect(lockfileHash(dir)).toBe(before);
    writeFileSync(join(dir, "bun.lock"), "b");
    expect(lockfileHash(dir)).not.toBe(before);
    writeFileSync(join(dir, "bun.lock"), "a");
    writeFileSync(join(dir, "go.sum"), "x");
    expect(lockfileHash(dir)).not.toBe(before);
  });

  test("the env digest covers PATH and gate variables, hashes them, and ignores secrets", () => {
    const env = { PATH: "/usr/bin:/bin", NODE_OPTIONS: "", OPENAI_API_KEY: "sk-secret-value" };
    const digest = gateEnvDigest(env);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(gateEnvDigest({ ...env, PATH: "/opt/bin:/usr/bin:/bin" })).not.toBe(digest);
    expect(gateEnvDigest({ ...env, NODE_OPTIONS: "--max-old-space-size=1" })).not.toBe(digest);
    expect(gateEnvDigest({ ...env, OPENAI_API_KEY: "sk-other" })).toBe(digest);
    expect(gateEnvDigest({ ...env, npm_config_ignore_scripts: "true" })).not.toBe(digest);
    expect(gateEnvDigest({ ...env, LD_LIBRARY_PATH: "/opt/lib" })).not.toBe(digest);
    expect(gateEnvDigest({ ...env, npm_config__authToken: "npm-secret" })).toBe(digest);
    expect(gateEnvDigest({ ...env, MY_GATE_FLAG: "1" })).toBe(digest);
    expect(gateEnvDigest({ ...env, MY_GATE_FLAG: "1" }, ["MY_GATE_FLAG"])).not.toBe(
      gateEnvDigest({ ...env, MY_GATE_FLAG: "2" }, ["MY_GATE_FLAG"]),
    );
  });

  test("known nonsecret settings with secret-looking names still key the env digest", () => {
    const env = { PATH: "/usr/bin:/bin" };
    const digest = gateEnvDigest(env);
    // Toolchain settings, not credentials, despite containing PRIVATE / AUTH.
    expect(gateEnvDigest({ ...env, GOPRIVATE: "example.com/*" })).not.toBe(digest);
    expect(gateEnvDigest({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" })).not.toBe(digest);
    expect(gateEnvDigest({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" })).not.toBe(
      gateEnvDigest({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: "1" }),
    );
    // Prefix-family credentials stay out; an operator-declared name is included as written.
    expect(gateEnvDigest({ ...env, CARGO_REGISTRY_TOKEN: "t" })).toBe(digest);
    expect(gateEnvDigest({ ...env, NODE_AUTH_TOKEN: "t" })).toBe(digest);
    expect(gateEnvDigest({ ...env, MY_AUTH_MODE: "a" }, ["MY_AUTH_MODE"])).not.toBe(
      gateEnvDigest({ ...env, MY_AUTH_MODE: "b" }, ["MY_AUTH_MODE"]),
    );
  });

  test("single flight runs one caller per key at a time", async () => {
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signal = new AbortController().signal;
    const reusable = () => true;
    const first = singleFlight(
      "k",
      signal,
      async () => {
        order.push("first start");
        await gate;
        order.push("first end");
      },
      reusable,
    );
    const second = singleFlight("k", signal, async () => order.push("second"), reusable);
    const other = singleFlight("other", signal, async () => order.push("other"), reusable);
    await other;
    expect(order).toEqual(["first start", "other"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first start", "other", "first end", "second"]);
    const aborted = new AbortController();
    let unblock = () => {};
    const blocker = singleFlight(
      "k",
      signal,
      () => new Promise<void>((resolve) => (unblock = resolve)),
      reusable,
    );
    const waiting = singleFlight("k", aborted.signal, async () => {}, reusable);
    aborted.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    unblock();
    await blocker;
  });

  test("waiters on a flight with an unreusable result run concurrently", async () => {
    const signal = new AbortController().signal;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let peak = 0;
    const attempt = async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(20);
      active--;
      return false;
    };
    const ok = (passed: boolean) => passed;
    const failing = singleFlight("fail", signal, () => gate.then(() => false), ok);
    const waiters = [1, 2, 3].map(() => singleFlight("fail", signal, attempt, ok));
    release();
    expect(await Promise.all([failing, ...waiters])).toEqual([false, false, false, false]);
    expect(peak).toBe(3);
  });

  test("the config hash ignores key order but not content", () => {
    const reordered = JSON.parse(
      `{"protectedPaths":[],"source":".limitless.toml","checks":[{"run":"bun run lint","name":"lint"},{"run":"bun test","name":"test"}],"setup":["bun install"]}`,
    ) as GateConfig;
    expect(gatesHash(reordered)).toBe(gatesHash(cfg));
    expect(gatesHash({ ...cfg, checks: [...cfg.checks].reverse() })).not.toBe(gatesHash(cfg));
    expect(gatesHash({ ...cfg, checks: [{ name: "lint", run: "bun run lint", timeoutSec: 60 }] })).not.toBe(
      gatesHash({ ...cfg, checks: [{ name: "lint", run: "bun run lint" }] }),
    );
  });
});

const runGates: typeof productionGates = (cwd, cfg, signal, hooks) =>
  sandbox.confinementScope.run(fakeConfinement, () => productionGates(cwd, cfg, signal, hooks));
const retryBaselineFailures: typeof productionBaselineRetry = (run, cwd, cfg, signal, onWait) =>
  sandbox.confinementScope.run(fakeConfinement, () => productionBaselineRetry(run, cwd, cfg, signal, onWait));
const retryRegressions: typeof productionRetry = (cmp, cwd, cfg, changed, signal, onWait) =>
  sandbox.confinementScope.run(fakeConfinement, () =>
    productionRetry(cmp, cwd, cfg, changed, signal, onWait),
  );
describe("confined gates on the committed tree", () => {
  const git = (cwd: string, ...args: string[]) =>
    sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  async function linked() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "limitless-gates-git-")));
    const cache = join(root, "cache");
    const work = join(root, "work");
    await git(root, "init", "-q", cache);
    writeFileSync(join(cache, "tracked.txt"), "committed");
    writeFileSync(join(cache, ".gitignore"), "hidden/\nbunfig.toml\nnode_modules/\n");
    await git(cache, "add", "-A");
    await git(cache, "commit", "-qm", "base");
    await git(cache, "worktree", "add", "-q", "--detach", work);
    await recordWorktree(work);
    return { root, cache, work };
  }

  test.skipIf(seatbeltSkip !== null)(
    `setup, checks and retries write only the checkout and scratch, descendants included ${seatbeltSkip ?? ""}`,
    async () => {
      const { root, work } = await linked();
      try {
        const canary = join(root, "canary");
        writeFileSync(canary, "untouched");
        const cfg: GateConfig = {
          setup: ['echo built > built.txt && echo cached > "$HOME/cache"'],
          checks: [
            { name: "inside", run: 'test -f built.txt && echo t > "$TMPDIR/t"' },
            { name: "escape", run: `sh -c "echo pwned > '${canary}'"` },
          ],
          source: "detected",
          protectedPaths: [],
        };
        const run = await productionGates(work, cfg, new AbortController().signal);
        expect(run.setupOk).toBe(true);
        expect(run.checks.map((c) => [c.name, c.ok])).toEqual([
          ["inside", true],
          ["escape", false],
        ]);
        const retried = await productionBaselineRetry(run, work, cfg, new AbortController().signal);
        expect(retried.checks[1]?.ok).toBe(false);
        expect(readFileSync(canary, "utf8")).toBe("untouched");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("unavailable confinement is an error, never a still_failing result", async () => {
    const { root, work } = await linked();
    const spy = spyOn(sandbox, "verifySeatbelt").mockImplementation(async () => {
      throw new sandbox.ConfinementError("Write confinement unavailable");
    });
    try {
      const marker = join(root, "ran");
      const cfg: GateConfig = {
        setup: [],
        checks: [{ name: "check", run: `touch '${marker}'; false` }],
        source: "detected",
        protectedPaths: [],
      };
      const failed = {
        name: "check",
        command: cfg.checks[0]?.run ?? "",
        ok: false,
        exitCode: 1,
        durationMs: 1,
        output: "",
      };
      const failing: GateRun = { setupOk: true, setup: [], checks: [failed] };
      await expect(productionGates(work, cfg, new AbortController().signal)).rejects.toThrow(
        sandbox.ConfinementError,
      );
      await expect(productionBaselineRetry(failing, work, cfg, new AbortController().signal)).rejects.toThrow(
        sandbox.ConfinementError,
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      spy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("gates see committed bytes plus fresh setup, even when status reports nothing", async () => {
    const { root, cache, work } = await linked();
    try {
      // Ignored payloads via .gitignore and info/exclude, plus a skip-worktree edit status hides.
      mkdirSync(join(work, "hidden"));
      writeFileSync(join(work, "hidden", "x.ts"), "payload");
      writeFileSync(join(work, "bunfig.toml"), 'preload = ["./hidden/x.ts"]');
      writeFileSync(join(cache, ".git", "info", "exclude"), "excluded.ts\n");
      writeFileSync(join(work, "excluded.ts"), "payload");
      mkdirSync(join(work, "node_modules"));
      writeFileSync(join(work, "node_modules", "stale"), "agent-installed");
      await git(work, "update-index", "--skip-worktree", "tracked.txt");
      writeFileSync(join(work, "tracked.txt"), "forged");
      expect((await git(work, "status", "--porcelain")).stdout).toBe("");
      await checkoutCommitted(work);
      const cfg: GateConfig = {
        setup: ["mkdir -p node_modules && echo fresh > node_modules/dep"],
        checks: [
          {
            name: "committed",
            run: 'test ! -e hidden && test ! -e bunfig.toml && test ! -e excluded.ts && test ! -e node_modules/stale && test "$(cat tracked.txt)" = committed && test -f node_modules/dep',
          },
        ],
        source: "detected",
        protectedPaths: [],
      };
      const run = await runGates(work, cfg, new AbortController().signal);
      expect(run.checks[0]?.output).toBe("");
      expect(run.checks[0]?.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test.skipIf(process.platform !== "darwin")(
  "backend launch failure after preflight cannot become still_failing against a failing baseline",
  async () => {
    const cwd = tempDir({});
    let probes = 0;
    let launches = 0;
    const runner = spyOn(proc, "runProcess").mockImplementation(async (opts) => {
      const probing = opts.cmd.at(-1)?.endsWith("/denied");
      if (probing) {
        probes++;
        writeFileSync(opts.cmd.at(-2) ?? "", "ok");
      } else launches++;
      return {
        exitCode: probing ? 0 : 71,
        stdout: probing ? "verified" : "",
        stderr: "sandbox initialization failed",
        signal: null,
        cancelled: false,
        timedOut: false,
        idleTimedOut: false,
        truncated: false,
        durationMs: 1,
      };
    });
    try {
      const config: GateConfig = {
        source: "detected",
        setup: [],
        checks: [{ name: "test", run: "exit 1" }],
        protectedPaths: [],
      };
      const baseline = {
        setupOk: true,
        setup: [],
        checks: [{ name: "test", command: "exit 1", ok: false, exitCode: 1, output: "", durationMs: 1 }],
      };
      await expect(
        (async () =>
          compareGates(baseline, await productionGates(cwd, config, new AbortController().signal)))(),
      ).rejects.toThrow(ConfinementError);
      expect(probes).toBe(1);
      expect(launches).toBe(1);
    } finally {
      runner.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "gate setup and dependent checks share scratch and clean it after completion",
  async () => {
    const cwd = tempDir({});
    let scratch = "";
    const runner = spyOn(proc, "runProcess").mockImplementation(async (opts) => {
      if (opts.cmd.at(-1)?.endsWith("/denied")) {
        writeFileSync(opts.cmd.at(-2) ?? "", "ok");
      } else {
        const current = opts.env.TMPDIR ?? "";
        if (opts.cmd.at(-1) === "setup") {
          scratch = current;
          writeFileSync(join(scratch, "setup-output"), "ready");
        } else {
          expect(current).toBe(scratch);
          expect(readFileSync(join(current, "setup-output"), "utf8")).toBe("ready");
        }
        opts.onStdoutLine?.(opts.cmd[7] ?? "");
      }
      return {
        exitCode: 0,
        stdout: opts.cmd.at(-1)?.endsWith("/denied") ? "verified" : "",
        stderr: "",
        signal: null,
        cancelled: false,
        timedOut: false,
        idleTimedOut: false,
        truncated: false,
        durationMs: 1,
      };
    });
    try {
      const result = await productionGates(
        cwd,
        {
          source: "detected",
          setup: ["setup"],
          checks: [{ name: "test", run: "check" }],
          protectedPaths: [],
        },
        new AbortController().signal,
      );
      expect(result.checks[0]?.ok).toBe(true);
      expect(existsSync(scratch)).toBe(false);
    } finally {
      runner.mockRestore();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

for (const padding of [0, 70_000])
  test(`nested sandbox diagnostic blocks despite identical baseline and ${padding} trailing bytes`, async () => {
    const cwd = tempDir({});
    try {
      const cfg: GateConfig = {
        setup: [],
        source: "detected",
        protectedPaths: [],
        checks: [
          {
            name: "nested",
            run: `printf 'sandbox_apply: Operation not permitted\n'; printf '%${padding}s' ''; exit 1`,
          },
        ],
      };
      const signal = new AbortController().signal;
      const baseline = await runGates(cwd, cfg, signal);
      const retried = await retryBaselineFailures(baseline, cwd, cfg, signal);
      expect(retried).toBe(baseline);
      const cmp = compareGates(baseline, await runGates(cwd, cfg, signal));
      expect(cmp[0]).toMatchObject({ verdict: "confinement_error", blocking: true });
      expect(await retryRegressions(cmp, cwd, cfg, [], signal)).toBe(cmp);
      expect(formatGateFeedback(cmp)).toContain("CONFINEMENT ERROR (sandbox launch failed)");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

for (const padding of [0, 70_000])
  test(`output-only confinement results stay blocking through comparison and retries (${padding} bytes)`, async () => {
    const result = {
      name: "check",
      command: "exit 0",
      ok: false,
      exitCode: 1,
      durationMs: 0,
      output: `sandbox_apply: Operation not permitted\n${"x".repeat(padding)}`,
    };
    const passed = { ...result, ok: true, exitCode: 0, output: "passed" };
    const run = (check: GateRun["checks"][number]): GateRun => ({
      setupOk: true,
      setup: [],
      checks: [check],
    });
    const failed = run(result);
    const recovered: GateRun = run({ ...passed, firstAttempt: result });
    const cfg: GateConfig = {
      setup: [],
      checks: [{ name: result.name, run: result.command }],
      source: "detected",
      protectedPaths: [],
    };
    const signal = new AbortController().signal;
    // No subprocess may retry away this operational failure, including restored results without flags.
    expect(await retryBaselineFailures(failed, "/nonexistent", cfg, signal)).toBe(failed);
    for (const [baseline, after] of [
      [failed, failed],
      [run(passed), failed],
      [failed, run(passed)],
      [run(passed), recovered],
      [recovered, run(passed)],
    ] as const) {
      const cmp = compareGates(baseline, after);
      expect(cmp[0]).toMatchObject({ verdict: "confinement_error", blocking: true });
      expect(await retryRegressions(cmp, "/nonexistent", cfg, [], signal)).toBe(cmp);
      expect(formatGateFeedback(cmp)).toContain("CONFINEMENT ERROR (sandbox launch failed)");
    }
    const setup: GateRun = { setupOk: false, setup: [result], checks: [] };
    expect(compareGates(setup, setup)[0]).toMatchObject({ verdict: "confinement_error", blocking: true });
  });

test("a confinement failure on regression retry cannot become flaky", async () => {
  const cwd = tempDir({});
  try {
    const command = "echo 'sandbox_apply: Operation not permitted'; exit 0";
    const result = {
      name: "check",
      command,
      ok: false,
      exitCode: 1,
      output: "ordinary failure",
      durationMs: 0,
    };
    const cmp = await retryRegressions(
      [{ name: "check", verdict: "regressed", blocking: true, result }],
      cwd,
      { setup: [], source: "detected", protectedPaths: [], checks: [{ name: "check", run: command }] },
      [],
      new AbortController().signal,
    );
    expect(cmp[0]).toMatchObject({ verdict: "confinement_error", blocking: true });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.skipIf(seatbeltSkip !== null)(
  `real nested Seatbelt produces a blocking confinement verdict ${seatbeltSkip ?? ""}`,
  async () => {
    const cwd = tempDir({});
    try {
      const cfg: GateConfig = {
        setup: [],
        source: "detected",
        protectedPaths: [],
        checks: [
          { name: "nested", run: '/usr/bin/sandbox-exec -p "(version 1)(allow default)" /usr/bin/true' },
        ],
      };
      const run = await productionGates(cwd, cfg, new AbortController().signal);
      expect(compareGates(run, run)[0]).toMatchObject({ verdict: "confinement_error", blocking: true });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test("private policy rejects broken lists and repository aliases; normalizes both sides", () => {
  const root = mkdtempSync(join(tmpdir(), "private-policy-"));
  const config = join(root, "config");
  const file = join(config, "private-strings.txt");
  mkdirSync(config);
  try {
    expect(loadPrivateStrings(config)).toEqual([]);
    symlinkSync(join(root, "missing"), file);
    expect(() => loadPrivateStrings(config)).toThrow("Cannot read");
    rmSync(file);
    writeFileSync(file, Buffer.from([0xff]));
    expect(() => loadPrivateStrings(config)).toThrow("Cannot read");
    writeFileSync(file, "# ignored\n\nＳＥＣＲＥＴ－ＨＯＳＴ．ＥＸＡＭＰＬＥ\n");
    const entries = loadPrivateStrings(config);
    expect(entries[0]?.entry).toBe(3);
    for (const text of [
      "secret-host.example",
      "ＳＥＣＲＥＴ－ＨＯＳＴ．ＥＸＡＭＰＬＥ",
      "%73ecret-host%2Eexample",
      "\\u0073ecret-host.example",
      "%5Cu0073ecret-host.example",
      JSON.stringify("\\u0073\\u0065\\u0063\\u0072\\u0065\\u0074-host.example"),
      "%bad% secret-host.example",
    ]) {
      expect(privateMatches(text, entries)).toHaveLength(1);
      expect(privateMatches(redactPrivate(text, entries), entries)).toEqual([]);
    }
    expect(privateMatches("secret-\nhost.example", entries)).toEqual([]);
    // Compatibility letters must be normalized before context-sensitive lowercasing.
    writeFileSync(file, "AΣᴬ");
    expect(privateMatches("aσa", loadPrivateStrings(config))).toHaveLength(1);
    writeFileSync(file, "＃secret-host.example");
    expect(privateMatches("#secret-host.example", loadPrivateStrings(config))).toHaveLength(1);
    const alias = join(root, "alias");
    symlinkSync(config, alias);
    expect(() => loadPrivateStrings(alias, [config])).toThrow("inside repository");
    expect(() => loadPrivateStrings(join(config, "absent"), [config])).toThrow("inside repository");
    const repo = join(root, "repo");
    mkdirSync(repo);
    symlinkSync(config, join(repo, "outward"));
    expect(() => loadPrivateStrings(join(repo, "outward"), [repo])).toThrow("inside repository");
    rmSync(file);
    writeFileSync(join(repo, "list"), "secret-host.example");
    symlinkSync(join(repo, "list"), file);
    expect(() => loadPrivateStrings(config, [repo])).toThrow("inside repository");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon invocation directory is not an implicit repository root", async () => {
  const root = mkdtempSync(join(tmpdir(), "private-daemon-cwd-"));
  const config = join(root, "config");
  const repo = join(root, "repo");
  mkdirSync(config);
  mkdirSync(repo);
  writeFileSync(join(config, "private-strings.txt"), "secret-host.example");
  const program = `
    import { loadPrivateStrings } from ${JSON.stringify(resolve("src/gates/private.ts"))};
    if (loadPrivateStrings()[0]?.value !== "secret-host.example") throw new Error("missing list");
    loadPrivateStrings(undefined, [${JSON.stringify(repo)}]);
    for (const roots of [[${JSON.stringify(config)}], [${JSON.stringify(root)}]]) {
      let blocked = false;
      try { loadPrivateStrings(undefined, roots); }
      catch (error) { blocked = error.message.includes("inside repository"); }
      if (!blocked) throw new Error("repository config accepted");
    }
  `;
  try {
    const child = Bun.spawn([process.execPath, "-e", program], {
      cwd: root,
      env: { ...process.env, LIMITLESS_CONFIG_DIR: "config" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toBe("");
    expect(await child.exited).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private config excludes common git directories and all linked worktrees canonically", async () => {
  const root = mkdtempSync(join(tmpdir(), "private-boundaries-"));
  try {
    const repo = join(root, "repo");
    const work = join(root, "work");
    const other = join(root, "other");
    await sh(["git", "init", "-q", repo], { cwd: root });
    await sh(["git", "commit", "--allow-empty", "-qm", "base"], { cwd: repo });
    await sh(["git", "worktree", "add", "-qb", "work", work], { cwd: repo });
    await sh(["git", "worktree", "add", "-qb", "other", other], { cwd: repo });
    for (const boundary of [repo, work, other, join(repo, ".git")]) {
      const config = join(boundary, "config-private");
      mkdirSync(config);
      writeFileSync(join(config, "private-strings.txt"), "secret-host.example");
      const alias = join(root, "alias");
      symlinkSync(config, alias);
      expect(() => loadPrivateStrings(config, [work])).toThrow("inside repository");
      expect(() => loadPrivateStrings(alias, [work])).toThrow("inside repository");
      rmSync(alias);
    }
    const aliasWork = join(root, "alias-work");
    mkdirSync(aliasWork);
    symlinkSync(join(repo, ".git"), join(aliasWork, ".git"));
    expect(() => loadPrivateStrings(join(repo, "config-private"), [aliasWork])).toThrow("inside repository");
    const external = join(root, "repo-sibling");
    mkdirSync(external);
    writeFileSync(join(external, "private-strings.txt"), "secret-host.example");
    expect(loadPrivateStrings(external, [work])).toEqual([{ value: "secret-host.example", entry: 1 }]);
    rmSync(join(external, "private-strings.txt"));
    symlinkSync(join(other, "config-private", "private-strings.txt"), join(external, "private-strings.txt"));
    expect(() => loadPrivateStrings(external, [work])).toThrow("inside repository");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("waiting behind a lease does not spend the internal gate's execution timeout", async () => {
  const previous = gateSlots.limit;
  gateSlots.setLimit(1);
  const id = await gateSlots.lease("deploy");
  const queued = Promise.withResolvers<void>();
  try {
    const run = runGates(
      process.cwd(),
      {
        setup: [],
        checks: [{ name: "short", run: "true", timeoutSec: 0.1 }],
        source: "detected",
        protectedPaths: [],
      },
      new AbortController().signal,
      { holder: "run-timeout", onWait: () => queued.resolve() },
    );
    await queued.promise;
    await Bun.sleep(200);
    expect(gateSlots.snapshot().holders).toEqual(["deploy"]);
    gateSlots.heartbeat(id, true);
    expect((await run).checks[0]?.ok).toBe(true);
    expect(gateSlots.snapshot().occupied).toBe(0);
  } finally {
    gateSlots.heartbeat(id, true);
    gateSlots.setLimit(previous);
  }
});

test("gate subprocess excludes an arbitrary unselected provider credential", async () => {
  const { customProvider, providerFixture } = await import("./provider-config-support.ts");
  const fixture = providerFixture([{ ...customProvider, api_key_env: "MAC_MLX_KEY" }]);
  const saved = process.env.MAC_MLX_KEY;
  try {
    process.env.MAC_MLX_KEY = "FAKE_GATE_CREDENTIAL_733";
    fixture.load();
    const gate = await runGates(
      fixture.root,
      {
        setup: [],
        checks: [{ name: "env", run: 'test -z "$MAC_MLX_KEY" && printf "credential=absent CI=%s" "$CI"' }],
        source: "detected",
        protectedPaths: [],
        merge: "pr",
      },
      new AbortController().signal,
    );
    expect(gate.checks[0]).toMatchObject({ ok: true, output: "credential=absent CI=1" });
  } finally {
    if (saved === undefined) delete process.env.MAC_MLX_KEY;
    else process.env.MAC_MLX_KEY = saved;
    fixture.close();
  }
});
