import { describe, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerFailureEvidence } from "../src/gates/attribution.ts";
import { detectGates, readRetryFiles } from "../src/gates/detect.ts";
import { executeGate, type GateRunner } from "../src/gates/executor.ts";
import { extractFailures } from "../src/gates/failures.ts";
import { MAX_RETRY_FILES, parseJUnit, readJUnit } from "../src/gates/junit.ts";
import { type GateResult, retryFailures, retryRegressions, runGates } from "../src/gates/run.ts";
import { agentTestSlots, gateSlots } from "../src/gates/slots.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import { sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { test } from "./read-policy-support.ts";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "gate-retry-files-"));
  mkdirSync(join(cwd, "test"));
  for (const file of ["a.test.ts", "b.test.ts", "space ' quote.test.ts"])
    writeFileSync(join(cwd, "test", file), "");
  return { cwd, close: () => rmSync(cwd, { recursive: true, force: true }) };
}
const suite = (file = "test/a.test.ts", attrs = 'failures="1" time="2"', body = "") =>
  `<testsuite file="${file}" ${attrs}>${body}</testsuite>`;

describe("JUnit failure files", () => {
  test.each([
    ["suite failures", suite(), undefined],
    ["suite errors", suite("test/a.test.ts", 'errors="1" time="2"'), undefined],
    ["testcase failure", suite("test/a.test.ts", 'time="2"', "<testcase><failure/></testcase>"), 0],
    ["testcase error", suite("test/a.test.ts", 'time="2"', "<testcase><error/></testcase>"), 1],
    ["nested suites", `<testsuites><testsuite>${suite()}</testsuite></testsuites>`, undefined],
  ])("parses %s", (_kind, xml, errors) => {
    const f = fixture();
    try {
      expect(parseJUnit(xml, f.cwd)).toEqual({
        failedFiles: ["test/a.test.ts"],
        failedFileTimes: { "test/a.test.ts": 2 },
        ...(errors !== undefined
          ? { attributedCounts: { tests: 1, failures: 1 - errors, errors, skipped: 0 } }
          : {}),
      });
    } finally {
      f.close();
    }
  });

  test("testcase files, escaped attributes and durations cover all tests in a failing file", () => {
    const f = fixture();
    try {
      expect(
        parseJUnit(
          `<testsuite><testcase file="test/space &apos; quote.test.ts" time="3"><failure/></testcase><testcase file="test/space &apos; quote.test.ts" time="4"/></testsuite>`,
          f.cwd,
        ),
      ).toEqual({
        failedFiles: ["test/space ' quote.test.ts"],
        failedFileTimes: { "test/space ' quote.test.ts": 7 },
        attributedCounts: { tests: 2, failures: 1, errors: 0, skipped: 0 },
      });
      expect(parseJUnit(`<testsuites>${suite()}${suite()}</testsuites>`, f.cwd)).toEqual({
        failedFiles: ["test/a.test.ts"],
        failedFileTimes: { "test/a.test.ts": 4 },
      });
      expect(parseJUnit(suite("test/a.test.ts", 'failures="1"'), f.cwd)?.failedFileTimes).toEqual({});
    } finally {
      f.close();
    }
  });

  test.each([
    ["missing report", null],
    ["malformed XML", "<testsuite>"],
    ["no failures", suite("test/a.test.ts", 'failures="0"')],
    ["absolute path", suite("/test/a.test.ts")],
    ["Windows absolute path", suite("C:\\test\\a.test.ts")],
    ["parent traversal", suite("test/../test/a.test.ts")],
    ["nonexistent file", suite("test/missing.test.ts")],
    ["directory", suite("test")],
    ["control", suite("test/a&#xA;.test.ts")],
    ["NUL", suite("test/a\0.test.ts")],
    ["missing file attribute", '<testsuite failures="1"/>'],
    ["unknown failure beside known", `<testsuite>${suite()}<testcase><error/></testcase></testsuite>`],
    [
      "too many files",
      `<testsuites>${Array.from({ length: MAX_RETRY_FILES + 1 }, (_, i) => suite(`test/${i}.test.ts`)).join("")}</testsuites>`,
    ],
  ])("%s falls back to exactly one full retry", async (_kind, xml) => {
    const f = fixture();
    try {
      for (let i = 0; i <= MAX_RETRY_FILES; i++) writeFileSync(join(f.cwd, `test/${i}.test.ts`), "");
      const report = join(f.cwd, "report.xml");
      if (xml !== null) writeFileSync(report, xml);
      const files = readJUnit(report, f.cwd);
      expect(files).toBeUndefined();
      const calls: string[] = [];
      const runner: GateRunner = async (cfg) => {
        calls.push(...cfg.checks.map((c) => c.run));
        return { setupOk: true, setup: [], checks: [{ ...failed, ok: true }] };
      };
      const [result] = await retryRegressions(
        [{ name: "test", result: { ...failed, ...files }, verdict: "regressed", blocking: true }],
        f.cwd,
        config,
        [],
        signal,
        undefined,
        runner,
      );
      expect(calls).toEqual(["full-test"]);
      expect(result?.verdict).toBe("flaky");
    } finally {
      f.close();
    }
  });

  test("nested cases inherit a suite file and unknown timing stays slotted", () => {
    const f = fixture();
    try {
      expect(
        parseJUnit(
          '<testsuite file="test/a.test.ts" failures="1" time="2"><testsuite><testcase><failure/></testcase></testsuite></testsuite>',
          f.cwd,
        ),
      ).toEqual({
        failedFiles: ["test/a.test.ts"],
        failedFileTimes: {},
        attributedCounts: { tests: 1, failures: 1, errors: 0, skipped: 0 },
      });
    } finally {
      f.close();
    }
  });

  test("a symlink escaping the checkout makes the entire list unknown", () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "gate-retry-outside-"));
    try {
      writeFileSync(join(outside, "outside.ts"), "");
      symlinkSync(join(outside, "outside.ts"), join(f.cwd, "escape.ts"));
      expect(parseJUnit(`<testsuites>${suite()}${suite("escape.ts")}</testsuites>`, f.cwd)).toBeUndefined();
    } finally {
      f.close();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

const signal = new AbortController().signal;
const testCheck = { name: "test", run: "full-test", timeoutSec: 37 };
const config = {
  setup: [],
  checks: [testCheck],
  source: "none" as const,
  protectedPaths: [],
  retryFiles: "bun test {files}",
};
const failed: GateResult = {
  name: "test",
  command: "full-test",
  ok: false,
  exitCode: 1,
  output: "failed",
  durationMs: 10,
};

const attributedSuite = suite(
  "test/a.test.ts",
  'tests="1" failures="1" errors="0"',
  "<testcase><failure/></testcase>",
);
const runnerSummary = "0 pass\n1 fail\nRan 1 test across 1 file.";

test.each([
  { label: "matching cases", xml: attributedSuite, complete: true },
  {
    label: "multiple diagnostics in one failing case",
    xml: attributedSuite.replace("<failure/>", "<failure/><failure/>"),
    complete: true,
  },
  {
    label: "matching root and nested inclusive counters",
    xml: `<testsuites tests="1" failures="1" errors="0"><testsuite failures="1">${attributedSuite}</testsuite></testsuites>`,
    complete: true,
  },
  {
    label: "attributed testcase error",
    xml: suite("test/a.test.ts", 'errors="1"', "<testcase><error/></testcase>"),
    complete: true,
  },
  {
    label: "inclusive mixed outcomes across files",
    xml: `<testsuites tests="4" failures="1" errors="1" skipped="1"><testsuite failures="1" errors="1">${attributedSuite}${suite("test/b.test.ts", 'tests="3" failures="0" errors="1" skipped="1"', "<testcase><error/></testcase><testcase/><testcase><skipped/></testcase>")}</testsuite></testsuites>`,
    output: "1 pass\n2 fail\n1 skip\nRan 4 tests across 2 files.",
    complete: true,
  },
  { label: "missing report", xml: "", complete: false },
  { label: "malformed report", xml: "<testsuite>", complete: false },
  {
    label: "root error and suite counter without a case",
    xml: '<testsuites errors="1"><testsuite file="test/a.test.ts" failures="1" errors="0"/></testsuites>',
    complete: false,
  },
  { label: "suite counter without cases", xml: suite(), complete: false },
  {
    label: "unmatched root errors",
    xml: `<testsuites errors="1">${attributedSuite}</testsuites>`,
    complete: false,
  },
  {
    label: "unmatched parent errors",
    xml: `<testsuites><testsuite errors="1">${attributedSuite}</testsuite></testsuites>`,
    complete: false,
  },
  {
    label: "root failure count too large",
    xml: `<testsuites failures="2">${attributedSuite}</testsuites>`,
    complete: false,
  },
  {
    label: "counter contradicts failure cases",
    xml: attributedSuite.replace('failures="1"', 'failures="0"'),
    complete: false,
  },
  {
    label: "malformed counter",
    xml: attributedSuite.replace('errors="0"', 'errors="unknown"'),
    complete: false,
  },
  {
    label: "unattributed root testcase",
    xml: `<testsuites>${attributedSuite}<testcase><failure/></testcase></testsuites>`,
    output: "0 pass\n2 fail",
    complete: false,
  },
  { label: "summary reveals an omitted case", output: "0 pass\n2 fail", complete: false },
  { label: "contradictory pass summary", output: "1 pass\n1 fail", complete: false },
  { label: "contradictory total", output: "0 pass\n1 fail\nRan 2 tests across 1 file.", complete: false },
  { label: "missing summary", output: "(fail) one test", complete: false },
  { label: "missing completion summary", output: "0 pass\n1 fail", complete: false },
  {
    label: "malformed completion summary",
    output: "0 pass\n1 fail\nRan unknown tests across 1 file.",
    complete: false,
  },
  { label: "malformed summary", output: "0 pass\none fail", complete: false },
  { label: "duplicate summary", output: `${runnerSummary}\n1 fail`, complete: false },
  { label: "bailed out", output: `Bailed out after 1 failure\n${runnerSummary}`, complete: false },
  {
    label: "bail before diagnostic tail",
    output: `Bailed out after 2 failures\n${"noise\n".repeat(2_000)}${runnerSummary}`,
    complete: false,
  },
  { label: "test named bail", output: `(fail) Bailed out after 1 failure\n${runnerSummary}`, complete: true },
  { label: "unhandled error", output: `# Unhandled error between tests\n${runnerSummary}`, complete: false },
  { label: "load error", output: `other.test.ts: load error\n${runnerSummary}`, complete: false },
  {
    label: "prefixed load error",
    output: `error: other.test.ts: load error\n${runnerSummary}`,
    complete: false,
  },
  {
    label: "module load error",
    output: `error: Cannot find module './missing'\n${runnerSummary}`,
    complete: false,
  },
  {
    label: "test name mentions unhandled and load errors",
    output: `(fail) handles unhandled errors and load errors: load error\n${runnerSummary}`,
    complete: true,
  },
  { label: "extra error count", output: `${runnerSummary}\n1 error`, complete: false },
  { label: "malformed error count", output: `${runnerSummary}\nNaN errors`, complete: false },
  { label: "zero errors", output: `${runnerSummary}\n0 errors`, complete: true },
  {
    label: "error before output tail",
    output: `# Unhandled error between tests\n${"noise\n".repeat(2_000)}${runnerSummary}`,
    complete: false,
  },
])("land failure evidence: $label", async (row) => {
  const f = fixture();
  try {
    const junit = parseJUnit(row.xml ?? attributedSuite, f.cwd);
    const evidence = new RunnerFailureEvidence();
    for (const line of (row.output ?? runnerSummary).split("\n")) evidence.observe(line);
    const complete = evidence.agrees(junit?.attributedCounts);
    expect(complete).toBe(row.complete);
    let calls = 0;
    const results = await retryFailures(
      [{ check: testCheck, original: { ...failed, ...junit, failureAttributionComplete: complete } }],
      f.cwd,
      config,
      signal,
      undefined,
      async () => {
        calls++;
        return { setupOk: true, setup: [], checks: [{ ...failed, ok: true, exitCode: 0 }] };
      },
      true,
    );
    expect(calls).toBe(row.complete ? 1 : 0);
    expect(results.size).toBe(calls);
  } finally {
    f.close();
  }
});

test.each([
  ["relative foreign frame", "at test/b.test.ts:3:92", "test/b.test.ts", false],
  ["parenthesized location", "at (test/b.test.ts:3:92)", "test/b.test.ts", false],
  ["absolute parenthesized frame", "at leaked ($CWD/test/b.test.ts:3:92)", "test/b.test.ts", false],
  ["absolute membership", "at test/b.test.ts:3:92", "$CWD/test/b.test.ts", false],
  ["canonical alias", "at $CWD/test/./b.test.ts:3:92", "./test/b.test.ts", false],
  ["symlink identity", "at test/alias.test.ts:3:92", "test/b.test.ts", false],
  [
    "decoded XML and testcase file",
    "at leaked (test/space &apos; quote.test.ts:3:92)",
    "test/space &apos; quote.test.ts",
    false,
  ],
  ["same file", "at test/a.test.ts:3:92", "test/b.test.ts", true],
  ["absolute same file", "at leaked ($CWD/test/a.test.ts:3:92)", "test/b.test.ts", true],
  ["non-test module", "at helper.ts:3:92", "test/b.test.ts", true],
  ["node_modules", "at node_modules/pkg/test.ts:3:92", "node_modules/pkg/test.ts", true],
  ["node_modules symlink", "at node_modules/pkg/alias.ts:3:92", "test/b.test.ts", true],
] as const)("JUnit stack attribution: %s", async (_label, frame, passingFile, complete) => {
  const f = fixture();
  try {
    writeFileSync(join(f.cwd, "helper.ts"), "");
    mkdirSync(join(f.cwd, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(f.cwd, "node_modules/pkg/test.ts"), "");
    symlinkSync(join(f.cwd, "test/b.test.ts"), join(f.cwd, "test/alias.test.ts"));
    symlinkSync(join(f.cwd, "test/b.test.ts"), join(f.cwd, "node_modules/pkg/alias.ts"));
    // Passing membership comes after the failure and may live on the testcase itself.
    const xml = `<testsuites>${suite("test/a.test.ts", 'errors="1"', `<testcase><error>Error: leak&#10;    ${frame}&#10;</error></testcase>`)}<testsuite><testcase file="${passingFile}"/></testsuite></testsuites>`;
    const junit = parseJUnit(xml.replaceAll("$CWD", f.cwd), f.cwd);
    expect(junit?.failedFiles).toEqual(["test/a.test.ts"]);
    const evidence = new RunnerFailureEvidence();
    for (const line of "1 pass\n1 fail\nRan 2 tests across 2 files.".split("\n")) evidence.observe(line);
    expect(evidence.agrees(junit?.attributedCounts)).toBe(complete);
    let calls = 0;
    await retryFailures(
      [
        {
          check: testCheck,
          original: {
            ...failed,
            ...junit,
            failureAttributionComplete: evidence.agrees(junit?.attributedCounts),
          },
        },
      ],
      f.cwd,
      config,
      signal,
      undefined,
      async () => {
        calls++;
        return { setupOk: true, setup: [], checks: [{ ...failed, ok: true, exitCode: 0 }] };
      },
      true,
    );
    expect(calls).toBe(complete ? 1 : 0);
  } finally {
    f.close();
  }
});

test("incomplete land evidence preserves factory targeted and full retries", async () => {
  const f = fixture();
  try {
    const original = { ...failed, ...parseJUnit(suite(), f.cwd), failureAttributionComplete: false };
    const calls: boolean[] = [];
    const runner: GateRunner = async (_cfg, options) => {
      calls.push(options?.targeted ?? false);
      return { setupOk: true, setup: [], checks: [{ ...failed, ok: true, exitCode: 0 }] };
    };
    const selected = [{ check: testCheck, original }];
    expect((await retryFailures(selected, f.cwd, config, signal, undefined, runner, true)).size).toBe(0);
    expect(calls).toEqual([]);
    expect((await retryFailures(selected, f.cwd, config, signal, undefined, runner)).get(original)?.ok).toBe(
      true,
    );
    expect(calls).toEqual([true, false]);
  } finally {
    f.close();
  }
});

test("gate capture retains runner errors before the diagnostic tail", async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.cwd, "runner.ts"),
      `await Bun.write(process.env.LIMITLESS_GATE_REPORT, ${JSON.stringify(attributedSuite)});
console.error("# Unhandled error between tests");
console.error("noise\\n".repeat(2000));
console.error(${JSON.stringify(runnerSummary)});
process.exit(1);`,
    );
    const run = await confinementScope.run(fakeConfinement, () =>
      runGates(
        f.cwd,
        { ...config, checks: [{ name: "test", run: `'${process.execPath}' ./runner.ts` }] },
        signal,
      ),
    );
    expect(run.checks[0]?.output).not.toContain("Unhandled error");
    expect(run.checks[0]?.failedFiles).toEqual(["test/a.test.ts"]);
    expect(run.checks[0]?.failureAttributionComplete).toBe(false);
  } finally {
    f.close();
  }
});

test.each([undefined, 123, "bun test", "bun test {files} {files}", "bun test {files}"])(
  "retry_files validation: %s",
  (value) => {
    const warnings: string[] = [];
    const text = `[gates]\n${value === undefined ? "" : `retry_files = ${JSON.stringify(value)}`}`;
    expect(readRetryFiles(text, (warning) => warnings.push(warning))).toBe(
      value === "bun test {files}" ? value : undefined,
    );
    expect(warnings.length).toBe(value === undefined || value === "bun test {files}" ? 0 : 1);
  },
);

test("the repository test check retains worker, timeout and structured report settings", () => {
  const cfg = detectGates(join(import.meta.dir, ".."));
  expect(cfg.retryFiles).toBe("bun test --isolate {files}");
  expect(cfg.checks.find((check) => check.name === "test")).toEqual({
    name: "test",
    run: 'bun test --parallel=$(bun scripts/test-workers.ts) --reporter=junit --reporter-outfile="$LIMITLESS_GATE_REPORT"',
    timeoutSec: 1800,
  });
});

test("targeted Bun arguments select exact paths and safely quote filenames", async () => {
  const f = fixture();
  try {
    for (const file of ["a.test.ts", "test/space ' quote.test.ts"])
      writeFileSync(
        join(f.cwd, file),
        'import { test, expect } from "bun:test"; test("reported file", () => expect(1).toBe(1));',
      );
    for (const file of ["data.test.ts", "test/a.test.ts"])
      writeFileSync(join(f.cwd, file), 'throw new Error("unrelated file must not run");');
    const original = {
      ...failed,
      ...parseJUnit(
        `<testsuites>${suite("a.test.ts")}${suite("test/space &apos; quote.test.ts")}</testsuites>`,
        f.cwd,
      ),
    };
    expect(original.failedFiles).toEqual(["a.test.ts", "test/space ' quote.test.ts"]);
    const calls: string[] = [];
    const [result] = await confinementScope.run(fakeConfinement, () =>
      retryRegressions(
        [{ name: "test", result: original, verdict: "regressed", blocking: true }],
        f.cwd,
        { ...config, retryFiles: `'${process.execPath}' test {files}` },
        [],
        signal,
        undefined,
        async (cfg, options) => {
          calls.push(cfg.checks[0]?.run ?? "");
          return options?.targeted
            ? runGates(f.cwd, cfg, signal)
            : { setupOk: true, setup: [], checks: [{ ...failed, ok: true }] };
        },
      ),
    );
    expect(result?.result.targetedRetry?.ok).toBe(true);
    expect(result?.result.targetedRetry?.output).toContain("2 pass");
    expect(result?.result.targetedRetry?.output).not.toContain("unrelated file must not run");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe("full-test");
    expect(result?.verdict).toBe("flaky");
  } finally {
    f.close();
  }
});

test("the repository retry template isolates globals across reported files before the full retry", async () => {
  const f = fixture();
  try {
    for (const file of ["test/a.test.ts", "test/b.test.ts"])
      writeFileSync(
        join(f.cwd, file),
        'import { test, expect } from "bun:test"; test("isolated global", () => { expect(globalThis.owner).toBeUndefined(); globalThis.owner = "set"; });',
      );
    const full = `'${process.execPath}' test --parallel=1 ./test/a.test.ts ./test/b.test.ts`;
    const cfg = {
      ...config,
      checks: [{ name: "test", run: full }],
      retryFiles: detectGates(join(import.meta.dir, "..")).retryFiles?.replace(
        /^bun /,
        `'${process.execPath}' `,
      ),
    };
    const calls: boolean[] = [];
    const [result] = await confinementScope.run(fakeConfinement, () =>
      retryRegressions(
        [
          {
            name: "test",
            result: {
              ...failed,
              command: full,
              ...parseJUnit(`<testsuites>${suite()}${suite("test/b.test.ts")}</testsuites>`, f.cwd),
            },
            verdict: "regressed",
            blocking: true,
          },
        ],
        f.cwd,
        cfg,
        [],
        signal,
        undefined,
        (retry, options) => {
          calls.push(options?.targeted ?? false);
          return runGates(f.cwd, retry, signal);
        },
      ),
    );
    expect(calls).toEqual([true, false]);
    expect(result?.result.targetedRetry?.ok).toBe(true);
    expect(result?.result.ok).toBe(true);
    expect(result?.verdict).toBe("flaky");
  } finally {
    f.close();
  }
});

test("real Bun bail blocks targeted land retry despite matching counters", async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.cwd, "test/a.test.ts"),
      `import { test, expect } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
test("fails once", () => { const seen = existsSync("marker"); writeFileSync("marker", ""); expect(seen).toBe(true); });`,
    );
    writeFileSync(
      join(f.cwd, "test/b.test.ts"),
      'import { test } from "bun:test"; test("pending pass", async () => { await Bun.sleep(300); });',
    );
    writeFileSync(
      join(f.cwd, "test/c.test.ts"),
      'import { test, expect } from "bun:test"; test("permanent failure", () => expect(1).toBe(2));',
    );
    const check = {
      name: "test",
      run: `'${process.execPath}' test --parallel=2 --bail --reporter=junit --reporter-outfile="$LIMITLESS_GATE_REPORT" ./test/a.test.ts ./test/b.test.ts ./test/c.test.ts`,
    };
    const run = await confinementScope.run(fakeConfinement, () =>
      runGates(f.cwd, { ...config, checks: [check] }, signal),
    );
    const original = run.checks[0];
    if (!original) throw new Error("Missing check");
    expect(original.output).toContain("Bailed out after 1 failure");
    expect(original.output).toContain("Ran 1 test across 1 file.");
    expect(original.failedFiles).toEqual(["test/a.test.ts"]);
    expect(original.failureAttributionComplete).toBe(false);
    let calls = 0;
    const retries = await retryFailures(
      [{ check, original }],
      f.cwd,
      config,
      signal,
      undefined,
      async () => {
        calls++;
        return { setupOk: true, setup: [], checks: [{ ...original, ok: true, exitCode: 0 }] };
      },
      true,
    );
    expect(calls).toBe(0);
    expect(retries.size).toBe(0);
  } finally {
    f.close();
  }
});

test("real Bun asynchronous failure in a passing file blocks targeted land retry", async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.cwd, "test/a.test.ts"),
      `import { test } from "bun:test";
test("arms leak", () => {
  const poll = () => {
    if (globalThis.active) { Promise.reject(new Error("leaked from a")); return; }
    setTimeout(poll, 1).unref();
  };
  setTimeout(poll, 1).unref();
});`,
    );
    writeFileSync(
      join(f.cwd, "test/b.test.ts"),
      'import { test } from "bun:test"; test("receives leak", async () => { globalThis.active = true; await Bun.sleep(100); });',
    );
    const check = {
      name: "test",
      run: `'${process.execPath}' test --reporter=junit --reporter-outfile="$LIMITLESS_GATE_REPORT" ./test/a.test.ts ./test/b.test.ts`,
    };
    const run = await confinementScope.run(fakeConfinement, () =>
      runGates(f.cwd, { ...config, checks: [check] }, signal),
    );
    const original = run.checks[0];
    if (!original) throw new Error("Missing check");
    expect(original.output).toContain("leaked from a");
    expect(original.output).toContain("1 pass");
    expect(original.output).toContain("1 fail");
    expect(original.failedFiles).toEqual(["test/b.test.ts"]);
    expect(original.failureAttributionComplete).toBe(false);
    let calls = 0;
    const retries = await retryFailures(
      [{ check, original }],
      f.cwd,
      config,
      signal,
      undefined,
      async () => {
        calls++;
        return { setupOk: true, setup: [], checks: [{ ...original, ok: true, exitCode: 0 }] };
      },
      true,
    );
    expect(calls).toBe(0);
    expect(retries.size).toBe(0);
  } finally {
    f.close();
  }
});

test.each([false, true])(
  "real Bun own-file failure with helper=%s permits one targeted land retry",
  async (helper) => {
    const f = fixture();
    try {
      writeFileSync(join(f.cwd, "helper.ts"), 'export function fail() { throw new Error("own failure"); }');
      writeFileSync(
        join(f.cwd, "test/a.test.ts"),
        `import { test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { fail } from "../helper.ts";
test("fails once", () => {
  if (existsSync("marker")) return;
  writeFileSync("marker", "");
  ${helper ? "fail();" : 'throw new Error("own failure");'}
});`,
      );
      const check = {
        name: "test",
        run: `'${process.execPath}' test --reporter=junit --reporter-outfile="$LIMITLESS_GATE_REPORT" ./test/a.test.ts`,
      };
      const cfg = { ...config, checks: [check], retryFiles: `'${process.execPath}' test {files}` };
      await confinementScope.run(fakeConfinement, async () => {
        const run = await runGates(f.cwd, cfg, signal);
        const original = run.checks[0];
        if (!original) throw new Error("Missing check");
        expect(original.failureAttributionComplete).toBe(true);
        expect(original.failedFiles).toEqual(["test/a.test.ts"]);
        const calls: string[] = [];
        const retries = await retryFailures(
          [{ check, original }],
          f.cwd,
          cfg,
          signal,
          undefined,
          async (retry, options) => {
            expect(options?.targeted).toBe(true);
            calls.push(...retry.checks.map((c) => c.run));
            return runGates(f.cwd, retry, signal);
          },
          true,
        );
        expect(calls).toEqual([`'${process.execPath}' test './test/a.test.ts'`]);
        expect(retries.get(original)?.ok).toBe(true);
        expect(retries.size).toBe(1);
      });
    } finally {
      f.close();
    }
  },
);

test("real Bun JUnit capture keeps failing files, console excerpts and coverage", async () => {
  const f = fixture();
  try {
    // This standalone fixture must not inherit this repository's test root/preload.
    writeFileSync(
      join(f.cwd, "test/a.test.ts"),
      'import { test, expect } from "bun:test"; test("passes", () => expect(1).toBe(1));',
    );
    writeFileSync(
      join(f.cwd, "test/b.test.ts"),
      'import { test, expect } from "bun:test"; test("fails", () => expect(1).toBe(2));',
    );
    const report = join(f.cwd, "report.xml");
    const output = await sh(
      [process.execPath, "test", "--parallel=2", "--reporter=junit", `--reporter-outfile=${report}`],
      { cwd: f.cwd, allowFail: true },
    );
    expect(output.exitCode).toBe(1);
    expect(parseJUnit(readFileSync(report, "utf8"), f.cwd)?.failedFiles).toEqual(["test/b.test.ts"]);
    expect(extractFailures(`${output.stdout}\n${output.stderr}`)).toContain("(fail) fails");
    const gates = await confinementScope.run(fakeConfinement, () =>
      runGates(
        f.cwd,
        {
          ...config,
          checks: [
            {
              name: "test",
              run: `'${process.execPath}' test --parallel=2 --reporter=junit --reporter-outfile="$LIMITLESS_GATE_REPORT"`,
            },
          ],
        },
        signal,
      ),
    );
    expect(gates.checks[0]?.failedFiles).toEqual(["test/b.test.ts"]);
    expect(gates.checks[0]?.failures).toContain("(fail) fails");
    expect(gates.checks[0]?.testCoverage?.summary).toBeTruthy();
    expect(gates.checks[0]?.failureAttributionComplete).toBe(true);
  } finally {
    f.close();
  }
});

test.each(["small", "six files", "over duration", "unknown duration"])(
  "targeted local executor slot policy: %s",
  async (size) => {
    const f = fixture();
    const previous = gateSlots.limit;
    gateSlots.setLimit(1);
    const release = await gateSlots.acquire(signal);
    const controller = new AbortController();
    let work: Promise<unknown> | undefined;
    try {
      const files = Array.from({ length: size === "six files" ? 6 : 5 }, (_, i) => `test/${i}.test.ts`);
      for (const file of files) writeFileSync(join(f.cwd, file), "");
      const original: GateResult = {
        ...failed,
        failedFiles: files,
        failedFileTimes:
          size === "unknown duration"
            ? undefined
            : Object.fromEntries(
                files.map((file) => [file, size === "over duration" ? 13 : size === "six files" ? 1 : 12]),
              ),
      };
      const waited = Promise.withResolvers<void>();
      let onWaitCalls = 0;
      let completed = false;
      work = confinementScope
        .run(fakeConfinement, () =>
          retryRegressions(
            [{ name: "test", result: original, verdict: "regressed", blocking: true }],
            f.cwd,
            { ...config, retryFiles: "false {files}" },
            [],
            controller.signal,
            () => {
              onWaitCalls++;
              waited.resolve();
            },
            (cfg, options) =>
              executeGate(
                {
                  repo: "test/repo",
                  cwd: f.cwd,
                  baseSha: "base",
                  headSha: "head",
                  gates: cfg,
                  skipGateSlot: options?.skipGateSlot,
                },
                controller.signal,
                {
                  onWait: () => {
                    onWaitCalls++;
                    waited.resolve();
                  },
                },
              ),
          ),
        )
        .then((result) => {
          completed = true;
          return result;
        });
      if (size === "small") {
        await work;
        expect(onWaitCalls).toBe(0);
        expect(gateSlots.snapshot().occupied).toBe(1);
        expect(agentTestSlots.snapshot().occupied).toBe(0);
      } else {
        await waited.promise;
        expect(completed).toBe(false);
        expect(onWaitCalls).toBe(1);
        release();
        await work;
      }
    } finally {
      controller.abort();
      release();
      await work?.catch(() => {});
      gateSlots.setLimit(previous);
      f.close();
    }
  },
);

test.each([
  { label: "five files totaling 60 seconds", count: 5, time: 12, skip: true, timeout: 120 },
  { label: "short original timeout", count: 1, time: 0, skip: true, timeout: 37, originalTimeout: 37 },
  {
    label: "default original timeout",
    count: 1,
    time: 1,
    skip: true,
    timeout: 120,
    originalTimeout: undefined,
  },
  { label: "six files", count: 6, time: 1, skip: false, timeout: 300 },
  { label: "over 60 seconds", count: 5, time: 13, skip: false, timeout: 300 },
  { label: "unknown duration", count: 1, time: undefined, skip: false, timeout: 300 },
  { label: "negative duration", count: 1, time: -1, skip: false, timeout: 300 },
  { label: "infinite duration", count: 1, time: Infinity, skip: false, timeout: 300 },
  { label: "NaN duration", count: 1, time: NaN, skip: false, timeout: 300 },
])("targeted-only retries preserve bounds: $label", async (row) => {
  const f = fixture();
  try {
    const files = Array.from({ length: row.count }, (_, i) => `test/${i}.test.ts`);
    for (const file of files) writeFileSync(join(f.cwd, file), "");
    const result: GateResult = {
      ...failed,
      failureAttributionComplete: true,
      failedFiles: files,
      failedFileTimes:
        row.time === undefined ? {} : Object.fromEntries(files.map((file) => [file, row.time])),
    };
    const check = {
      name: "test",
      run: "full-test",
      timeoutSec: "originalTimeout" in row ? row.originalTimeout : 300,
    };
    let calls = 0;
    const results = await retryFailures(
      [{ check, original: result }],
      f.cwd,
      config,
      signal,
      undefined,
      async (cfg, options) => {
        calls++;
        expect(options).toEqual({ targeted: true, skipGateSlot: row.skip });
        expect(cfg.setup).toEqual([]);
        expect(cfg.checks[0]?.timeoutSec).toBe(row.timeout);
        expect(cfg.checks[0]?.run).toBe(`bun test ${files.map((file) => `'./${file}'`).join(" ")}`);
        return { setupOk: true, setup: [], checks: [{ ...failed, ok: true, exitCode: 0 }] };
      },
      true,
    );
    expect(calls).toBe(1);
    expect(results.get(result)).toMatchObject({
      ok: true,
      firstAttempt: result,
      targetedRetry: { ok: true },
    });
  } finally {
    f.close();
  }
});
