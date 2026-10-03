import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
