import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditDiff } from "../src/gates/audit.ts";
import { detectGates } from "../src/gates/detect.ts";
import { compareGates, type GateRun, runGates } from "../src/gates/run.ts";
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
