import { describe, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGates, readRetryFiles } from "../src/gates/detect.ts";
import { executeGate, type GateRunner } from "../src/gates/executor.ts";
import { extractFailures } from "../src/gates/failures.ts";
import { MAX_RETRY_FILES, parseJUnit, readJUnit } from "../src/gates/junit.ts";
import { type GateResult, retryRegressions, runGates } from "../src/gates/run.ts";
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
    ["suite failures", suite()],
    ["suite errors", suite("test/a.test.ts", 'errors="1" time="2"')],
    ["testcase failure", suite("test/a.test.ts", 'time="2"', "<testcase><failure/></testcase>")],
    ["testcase error", suite("test/a.test.ts", 'time="2"', "<testcase><error/></testcase>")],
    ["nested suites", `<testsuites><testsuite>${suite()}</testsuite></testsuites>`],
  ])("parses %s", (_kind, xml) => {
    const f = fixture();
    try {
      expect(parseJUnit(xml, f.cwd)).toEqual({
        failedFiles: ["test/a.test.ts"],
        failedFileTimes: { "test/a.test.ts": 2 },
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
const config = {
  setup: [],
  checks: [{ name: "test", run: "full-test", timeoutSec: 37 }],
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
