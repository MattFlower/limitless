import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GateCommand, GateConfig } from "../src/gates/detect.ts";
import * as junit from "../src/gates/junit.ts";
import { protectGateOutput } from "../src/gates/output-privacy.ts";
import { privateStringsDigest } from "../src/gates/private.ts";
import { retryFailures, runGates, targetedRetrySkipReason, validateRetry } from "../src/gates/run.ts";
import { BunTestCoverage, MAX_TEST_IDENTITY_LENGTH } from "../src/gates/test-coverage.ts";
import * as identityModule from "../src/gates/text-privacy.ts";
import { gateIdentities, gatePrivacyScope, IDENTITY_CAP, withheldText } from "../src/gates/text-privacy.ts";
import { confinementScope, runSandboxed } from "../src/harness/sandbox.ts";
import { coveringTestCommand } from "../src/pipeline/covering-tests.ts";
import { createCredentialRegistry } from "../src/util/credential-matcher.ts";
import {
  createPrivacyRegistry,
  currentPrivacyGeneration,
  privacyLimits,
} from "../src/util/privacy-boundary.ts";
import {
  createPrivacyChecker,
  type PrivacyWorkerPort,
  privacyWorkerHandler,
} from "../src/util/privacy-checker.ts";
import { issuePrivacyWorkerChunks } from "../src/util/privacy-chunks.ts";
import { verifier } from "../src/util/privacy-proof.ts";
import { agentEnv, type ProcResult, runProcess, sh } from "../src/util/proc.ts";
import { fakeConfinement } from "./confinement.ts";
import { test } from "./read-policy-support.ts";
import { seeded } from "./seeded.ts";

const checkers: ReturnType<typeof createPrivacyChecker>[] = [],
  dirs: string[] = [];
const originalPath = process.env.PATH;
beforeEach(() => {
  process.env.PATH = `${dirname(process.execPath)}:${originalPath ?? ""}`;
});
afterEach(async () => {
  process.env.PATH = originalPath;
  for (const checker of checkers.splice(0)) await checker.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function port(): PrivacyWorkerPort {
  const worker = {
    onmessage: undefined as PrivacyWorkerPort["onmessage"],
    postMessage: (data: unknown) => {
      setImmediate(() => parent.onmessage?.({ data: structuredClone(data) }));
    },
  };
  const parent: PrivacyWorkerPort = {
    postMessage: (data) => {
      setImmediate(() => worker.onmessage?.({ data: structuredClone(data) }));
    },
    ref() {},
    unref() {},
    terminate: async () => {},
  };
  privacyWorkerHandler(worker);
  return parent;
}
const config = (checks: GateCommand[]): GateConfig => ({
  setup: [],
  checks,
  source: "detected",
  protectedPaths: [],
});
function fixture(entries: string[] = [], credential?: string) {
  const cwd = mkdtempSync(join(tmpdir(), "gate-output-"));
  dirs.push(cwd);
  const secrets = createCredentialRegistry();
  if (credential) secrets.add(credential);
  const registry = createPrivacyRegistry(secrets);
  registry.refreshPolicy = () => {};
  registry.replacePolicy(entries.map((value, entry) => ({ value, entry })));
  const checker = createPrivacyChecker({ registry, workerFactory: port });
  checkers.push(checker);
  const signer = () => Buffer.alloc(32, 23);
  const scoped = <T>(run: () => T, sign: () => Buffer | undefined = signer) =>
    gatePrivacyScope.run({ checker, registry, signer: sign }, run);
  const gate = async (
    stdout: string,
    stderr = "",
    extra: Partial<GateCommand> = {},
    sign: () => Buffer | undefined = signer,
  ) => {
    writeFileSync(
      join(cwd, "emit.ts"),
      `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exitCode=1;`,
    );
    const run = await scoped(
      () =>
        confinementScope.run(fakeConfinement, () =>
          runGates(
            cwd,
            config([{ name: "test", run: "bun emit.ts", ...extra }]),
            new AbortController().signal,
          ),
        ),
      sign,
    );
    const result = run.checks[0];
    if (!result) throw Error("Missing gate result");
    return result;
  };
  return { cwd, registry, checker, signer, scoped, gate };
}
const capture = (stdout = "marker", stderr = ""): ProcResult => ({
  capture: { provenance: { kind: "complete" }, stdout, stderr },
  stdout: "TAIL MUST NEVER ESCAPE",
  stderr: "TAIL MUST NEVER ESCAPE",
  exitCode: 1,
  signal: null,
  cancelled: false,
  timedOut: false,
  idleTimedOut: false,
  truncated: false,
  durationMs: 0,
});
const control = () => ({ signal: new AbortController().signal, deadline: Date.now() + 120_000 });

test("real gates sign exact untrimmed rendering and identities; workers make MAC-free claims", async () => {
  const f = fixture(),
    stdout = `  ${"x".repeat(6100)} \n`,
    stderr = "  diagnostic \n ";
  const r = await f.gate(stdout, stderr);
  expect(r.output).toBe(`${stdout}\n${stderr}`.slice(-6000));
  expect(r.output).not.toContain("limitless-started-");
  expect(r.failures).toBeUndefined();
  expect(r.textPrivacy?.output).toMatchObject({ withheld: false, checkedComplete: true, kind: "complete" });
  const verify = verifier(f.registry, f.signer).verify;
  expect(verify(r.textPrivacy?.output, "output", r.output)).toBe(true);
  expect(verify(r.textPrivacy?.output, "output", `${r.output}!`)).toBe(false);
  expect(verify(r.textPrivacy?.identities, "identities", gateIdentities(r))).toBe(true);
  const unsigned = await f.gate(" safe ", "", {}, () => undefined);
  expect(unsigned.textPrivacy?.output).toEqual({
    withheld: false,
    checkedComplete: true,
    kind: "complete",
    entriesDigest: privateStringsDigest(f.registry.entries),
  });
  expect(unsigned.textPrivacy?.identities?.mac).toBeUndefined();
});

test("a signing guard refusal never becomes an unsigned release", async () => {
  const f = fixture(),
    key = f.signer().toString("hex");
  const r = await f.scoped(() => protectGateOutput(capture(key), "[]", control()));
  expect(r.output).toBe(withheldText("checker-failed"));
  expect(r.textPrivacy.output).toEqual({ withheld: true, reason: "checker-failed" });
  expect(JSON.stringify(r)).not.toContain(key);
});

test("original whitespace and escaped overlaps are checked before credential redaction", async () => {
  const host = "host.example",
    credential = ` ${host} `;
  const f = fixture([host], credential),
    r = await f.gate(` ${credential} \n`);
  expect(r.output).toBe(withheldText("private-match"));
  expect(JSON.stringify(r)).not.toContain(host);
  const clean = fixture([], credential);
  expect((await clean.gate(` ${credential} \n`)).output).toBe(" [redacted] \n");
  for (const sign of [clean.signer, () => undefined]) {
    const r = await clean.gate("ok\n", "", { run: `bun emit.ts '${credential}'` }, sign);
    expect(r.textPrivacy?.identities).toEqual({ withheld: true, reason: "private-match" });
    expect(r.textPrivacy?.output).toMatchObject({ withheld: false, checkedComplete: true });
  }
  const escaped = fixture([host], "host.exam");
  expect((await escaped.gate("host.exam\\u0070le")).output).toBe(withheldText("private-match"));
});

test("joining streams and normalized tail cuts cannot create unchecked private matches", async () => {
  const joined = fixture(["alpha beta"]);
  expect((await joined.gate("alpha", "beta")).output).toBe(withheldText("private-match"));
  const f = fixture(["host.example"]);
  expect((await f.gate(`prefix host%2eexample${"z".repeat(5990)}`)).output).toBe(
    withheldText("private-match"),
  );
  const normalized = fixture(["\u0301host.example"]);
  expect((await normalized.gate(`a\u0301host.example${"z".repeat(5987)}`)).output).toBe(
    withheldText("private-match"),
  );
});

test("requests settle sequentially in R1-R4 order with one deadline; single streams use R3-R4", async () => {
  const f = fixture(),
    protect = f.checker.protectText,
    calls: { text: string; cut: unknown; deadline?: number; signal?: AbortSignal }[] = [];
  let active = false;
  f.checker.protectText = async (input, c) => {
    expect(active).toBe(false);
    active = true;
    calls.push({ text: input.text, cut: input.cut, ...c });
    try {
      return await protect(input, c);
    } finally {
      active = false;
    }
  };
  const c = control();
  await f.scoped(() => protectGateOutput(capture(" out ", " err "), "identities", c));
  expect(calls.map((c) => c.text)).toEqual([" out ", " err ", " out \n err ", "identities"]);
  expect(calls.map((c) => c.cut)).toEqual([
    { limit: 0, unit: "U", marker: "" },
    { limit: 0, unit: "U", marker: "" },
    { limit: 6000, unit: "U", side: "tail" },
    { limit: 0, unit: "U", marker: "" },
  ]);
  expect(calls.every((call) => call.deadline === c.deadline && call.signal === c.signal)).toBe(true);
  calls.length = 0;
  await f.scoped(() => protectGateOutput(capture("only"), "identities", c));
  expect(calls.map((c) => c.text)).toEqual(["only", "identities"]);
  calls.length = 0;
  f.registry.replacePolicy([{ value: "private", entry: 0 }]);
  const r = await f.scoped(() => protectGateOutput(capture("private", "err"), "identities", c));
  expect(r.output).toBe(withheldText("private-match"));
  expect(calls.map((c) => c.text)).toEqual(["private", "identities"]);
});

test("a changed entries digest across receipts cannot produce an output proof", async () => {
  const f = fixture(),
    protect = f.checker.protectText;
  let count = 0;
  f.checker.protectText = async (...args) => {
    if (++count === 2) f.registry.replacePolicy([{ value: "other-private", entry: 0 }]);
    return protect(...args);
  };
  const r = await f.scoped(() => protectGateOutput(capture("stdout", "stderr"), "identities", control()));
  expect(r.output).toBe(withheldText("stale-generation"));
  expect(r.textPrivacy.output.mac).toBeUndefined();
  expect(count).toBe(3); // R1, R2, then R4.
});

test.each(["checker-busy", "checker-timeout", "checker-cancelled", "checker-failed", "throw"])(
  "checker refusal %s never falls back to process tails",
  async (reason) => {
    const f = fixture();
    f.checker.protectText = async () => {
      if (reason === "throw") throw Error("marker");
      return issuePrivacyWorkerChunks(
        undefined,
        {
          withheld: true,
          checkedComplete: false,
          policyDigest: "test",
          reason: reason as "checker-failed",
          truncated: false,
        },
        currentPrivacyGeneration(f.registry),
        f.registry,
      );
    };
    const r = await f.scoped(() => protectGateOutput(capture(), "identities", control()));
    expect(r.output).toBe(withheldText(reason === "throw" ? "checker-failed" : reason));
    expect(r.textPrivacy.output.mac).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("marker");
    expect(JSON.stringify(r)).not.toContain("TAIL");
  },
);

test.each(["cut", "unknown", "timeout", "cancel"])(
  "incomplete capture %s withholds output but still checks identities",
  async (kind) => {
    const f = fixture(),
      res = capture();
    if (kind === "cut") res.capture = { provenance: { kind: "cut", truncated: true } };
    if (kind === "unknown") res.capture = { provenance: { kind: "legacy-unknown" } };
    res.timedOut = kind === "timeout";
    res.cancelled = kind === "cancel";
    const reason =
      kind === "cut" ? "capture-cap" : kind === "cancel" ? "checker-cancelled" : "capture-incomplete";
    const r = await f.scoped(() => protectGateOutput(res, "identities", control()));
    expect(r.output).toBe(withheldText(reason, res.timedOut));
    expect(r.textPrivacy.output).toEqual({ withheld: true, reason });
    expect(r.textPrivacy.identities?.withheld).toBe(false);
    expect(JSON.stringify(r)).not.toContain("marker");
  },
);

test("capture cap and raw confinement scan remain independent of privacy withholding", async () => {
  const f = fixture(),
    old = privacyLimits.inputUnits;
  try {
    privacyLimits.inputUnits = 100;
    const r = await f.gate("marker".repeat(100));
    expect(r.output).toBe(withheldText("capture-cap"));
    expect(r.confinementError).toBe(false);
  } finally {
    privacyLimits.inputUnits = old;
  }
  const diagnostic = ["sandbox_apply:", " Operation not permitted"].join("");
  const r = await f.gate(diagnostic);
  expect(r.confinementError).toBe(true);
  expect(r.failures).toBeUndefined();
});

test.each([true, false])("capture overflow invalidates evidence on a passing=%s report", async (ok) => {
  const f = fixture(),
    old = privacyLimits.inputUnits;
  writeFileSync(join(f.cwd, "a.test.ts"), "");
  const xml = `<testsuite tests="1" failures="${ok ? 0 : 1}" errors="0" skipped="0"><testcase file="a.test.ts" name="case">${ok ? "" : "<failure/>"}</testcase></testsuite>`;
  const output = `a.test.ts:\n(${ok ? "pass" : "fail"}) case\n${"padding\n".repeat(100)}${ok ? 1 : 0} pass\n${ok ? 0 : 1} fail\nRan 1 test across 1 file.`;
  writeFileSync(
    join(f.cwd, "emit.ts"),
    `import {writeFileSync} from "node:fs";writeFileSync(process.env.LIMITLESS_GATE_REPORT, ${JSON.stringify(xml)});console.log(${JSON.stringify(output)});process.exitCode=${ok ? 0 : 1};`,
  );
  try {
    privacyLimits.inputUnits = 400;
    const run = await f.scoped(() =>
      confinementScope.run(fakeConfinement, () =>
        runGates(f.cwd, config([{ name: "test", run: "bun emit.ts" }]), new AbortController().signal),
      ),
    );
    const r = run.checks[0];
    if (!r) throw Error("Missing gate result");
    expect(r.ok).toBe(ok);
    expect(r.output).toBe(withheldText("capture-cap"));
    expect(r.testCoverage?.skippedTestsIncomplete).toBe(true);
    expect(r.failureAttributionComplete).toBe(false);
    expect(targetedRetrySkipReason(undefined, r, config([]), f.cwd)).toStartWith(
      ok ? "no nonzero exit status" : "failure attribution incomplete",
    );
    expect(
      verifier(f.registry, f.signer).verify(r.textPrivacy?.identities, "identities", gateIdentities(r)),
    ).toBe(true);
  } finally {
    privacyLimits.inputUnits = old;
  }
});

test("identity construction exceptions return fixed unsigned output and identities", async () => {
  const f = fixture();
  const spy = spyOn(identityModule, "gateIdentities").mockImplementation(() => {
    throw Error("PRIVATE-IDENTITY-DETAIL");
  });
  try {
    const r = await f.gate("safe captured diagnostic");
    expect(r.output).toBe(withheldText("checker-failed"));
    expect(r.textPrivacy).toEqual({
      output: { withheld: true, reason: "checker-failed" },
      identities: { withheld: true, reason: "checker-failed" },
    });
    expect(r.failures).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

test("only the exact startup prefix is removed; earlier stdout invalidates the capture", async () => {
  const f = fixture(),
    later = "limitless-started-00000000-0000-0000-0000-000000000000\n";
  expect((await f.gate(`first\n${later}`)).output).toBe(`first\n${later}`);
  const run = (prepend: boolean) =>
    runSandboxed(
      { cmd: ["/bin/sh", "-c", "printf clean"], cwd: f.cwd, env: agentEnv(), captureComplete: true },
      { write: [f.cwd], protect: [] },
      runProcess,
      async () => {},
      prepend
        ? {
            verify: async () => {},
            wrap: (cmd) => ["/bin/sh", "-c", 'printf "before\\n"; exec "$@"', "sh", ...cmd],
          }
        : fakeConfinement,
    );
  const clean = await run(false);
  expect(clean.capture).toEqual({ provenance: { kind: "complete" }, stdout: "clean", stderr: "" });
  const bad = await run(true);
  expect(bad.capture?.provenance.kind).toBe("legacy-unknown");
  expect(bad.stdout).toStartWith("before\nlimitless-started-");
  expect((await f.scoped(() => protectGateOutput(bad, "[]", control()))).output).toBe(
    withheldText("capture-incomplete"),
  );
});

test("coverage file and path caps bound state and clear the refused header's attribution", () => {
  const coverage = new BunTestCoverage();
  for (let i = 0; i < 3000; i++) {
    if (i === 2000) {
      coverage.observe("./file-0.test.ts:");
      expect(coverage.result().skippedTestsIncomplete).toBeUndefined();
    }
    coverage.observe(`file-${i}.test.ts:`);
    coverage.observe("(pass) case");
  }
  expect(coverage.result().passedFiles).toHaveLength(2000);
  expect(coverage.result().skippedTestsIncomplete).toBe(true);
  const paths = new BunTestCoverage();
  paths.observe(`${"x".repeat(MAX_TEST_IDENTITY_LENGTH)}.test.ts:`);
  paths.observe("(pass) case");
  expect(paths.result()).toEqual({ passedFiles: [], skippedFiles: [], skippedTestsIncomplete: true });
});

test.each(["line", "files", "path", "identities"])(
  "%s overflow refuses targeted retry evidence",
  async (kind) => {
    const f = fixture();
    const text =
      kind === "line"
        ? "x".repeat(1024 * 1024)
        : kind === "files"
          ? Array.from({ length: 3000 }, (_, i) => `f-${i}.test.ts:\n(pass) case\n`).join("")
          : kind === "path"
            ? `${"x".repeat(MAX_TEST_IDENTITY_LENGTH)}.test.ts:\n(pass) case\n`
            : "";
    const r = await f.gate(
      text,
      "",
      kind === "identities" ? { run: `false ${"x".repeat(IDENTITY_CAP)}` } : {},
    );
    expect(r.testCoverage?.skippedTestsIncomplete).toBe(true);
    expect(r.failureAttributionComplete).toBe(false);
    expect(targetedRetrySkipReason(undefined, r, config([]), f.cwd)).toStartWith(
      "failure attribution incomplete",
    );
    if (kind === "identities")
      expect(r.textPrivacy?.identities).toEqual({ withheld: true, reason: "identity-cap" });
    else
      expect(
        verifier(f.registry, f.signer).verify(r.textPrivacy?.identities, "identities", gateIdentities(r)),
      ).toBe(true);
  },
);

test("line observer receives only a bounded prefix plus its truncation marker", async () => {
  const f = fixture(),
    lines: string[] = [];
  await runSandboxed(
    {
      cmd: [process.execPath, "-e", 'console.log("x".repeat(1024*1024))'],
      cwd: f.cwd,
      env: agentEnv(),
      maxLineLength: 65536,
      onStdoutLine: (line) => lines.push(line),
    },
    { write: [f.cwd], protect: [] },
    runProcess,
    async () => {},
    fakeConfinement,
  );
  expect(lines).toEqual([`${"x".repeat(65536)} [truncated]`]);
});

test("JUnit readers run in separate event-loop turns and retry diagnostics omit git text", async () => {
  const f = fixture(),
    calls: number[] = [];
  let turn = 0,
    running = true;
  const beat = () => {
    if (running) {
      turn++;
      setImmediate(beat);
    }
  };
  setImmediate(beat);
  const spies = [
    spyOn(junit, "readJUnitSkips"),
    spyOn(junit, "readJUnit"),
    spyOn(junit, "readCoveringJUnit"),
  ] as const;
  spies[0]?.mockImplementation(() => {
    calls.push(turn);
    return undefined;
  });
  spies[1]?.mockImplementation(() => {
    calls.push(turn);
    return undefined;
  });
  spies[2]?.mockImplementation((_path, _cwd, test) => {
    calls.push(turn);
    return { ...test, reason: "missing" };
  });
  try {
    const r = await f.gate("failed", "", {
      coveringTests: [
        { file: "a.test.ts", name: "one" },
        { file: "a.test.ts", name: "two" },
      ],
    });
    expect(calls).toHaveLength(4);
    expect(new Set(calls).size).toBe(4);
    const rejections: string[] = [];
    const rejected = validateRetry(
      { ...r, ok: true },
      r,
      "checked",
      {
        sha: "executed",
        trackedClean: true,
        provenanceError: "SECRET-GIT-TEXT",
      },
      (_original, reason) => rejections.push(reason),
    );
    expect(rejected.output).toBe(
      `${r.output}\n\nRetry rejected: execution SHA executed does not match checked commit checked`,
    );
    // The original proof doesn't cover the composition, so renderers withhold it.
    expect(
      verifier(f.registry, f.signer).verify(rejected.textPrivacy?.output, "output", rejected.output),
    ).toBe(false);
    expect(rejected.failures).toBeUndefined();
    expect(rejected.firstAttempt).toBe(r);
    expect(
      verifier(f.registry, f.signer).verify(rejected.firstAttempt?.textPrivacy?.output, "output", r.output),
    ).toBe(true);
    expect(
      verifier(f.registry, f.signer).verify(rejected.retryAttempt?.textPrivacy?.output, "output", r.output),
    ).toBe(true);
    expect(rejections).toEqual([
      "Retry rejected: execution SHA executed does not match checked commit checked",
    ]);
    expect(rejected.output).not.toContain("SECRET-GIT-TEXT");
    expect(rejected.retryAttempt?.executionProvenance?.provenanceError).toBe("SECRET-GIT-TEXT");
  } finally {
    running = false;
    for (const spy of spies) spy.mockRestore();
  }
});

test("retry setup failure composes protected output, never the private setup command", async () => {
  const f = fixture(["private-case"]);
  const original = await f.gate("original diagnostic");
  const setup = await f.gate("setup diagnostic", "", { run: "bun emit.ts; : private-case; exit 1" });
  expect(setup.textPrivacy?.identities).toEqual({ withheld: true, reason: "private-match" });
  const results = await retryFailures(
    [{ check: { name: original.name, run: original.command }, original }],
    f.cwd,
    config([]),
    new AbortController().signal,
    undefined,
    async () => ({ setupOk: false, setup: [setup], checks: [] }),
  );
  const r = results.get(original);
  expect(r?.output).toBe(`${original.output}\n\nRetry setup failed:\n\n${setup.output}`);
  expect(r?.output).not.toContain("private-case");
  expect(verifier(f.registry, f.signer).verify(r?.textPrivacy?.output, "output", r?.output ?? "")).toBe(
    false,
  );
  expect(r?.failures).toBeUndefined();
  expect(r?.firstAttempt).toBe(original);
  expect(
    verifier(f.registry, f.signer).verify(r?.firstAttempt?.textPrivacy?.output, "output", original.output),
  ).toBe(true);
});

test("command-only private identity is protected", async () => {
  const f = fixture(["private-command"]);
  const r = await f.gate("safe", "", { run: "bun emit.ts; : private-command; exit 1" });
  expect(r.output).toBe("safe");
  expect(r.textPrivacy?.identities).toEqual({ withheld: true, reason: "private-match" });
});

test("JUnit reports parse up to the measured 256 KiB cap and fall back above it", () => {
  const cwd = mkdtempSync(join(tmpdir(), "junit-cap-"));
  try {
    writeFileSync(join(cwd, "a.test.ts"), "");
    const xml =
      '<testsuite tests="1" failures="1"><testcase file="a.test.ts" name="x"><failure/></testcase></testsuite>';
    const sized = (bytes: number) => xml + " ".repeat(bytes - xml.length);
    expect(junit.parseJUnit(sized(256 * 1024), cwd)?.failedFiles).toEqual(["a.test.ts"]);
    expect(junit.parseJUnit(sized(256 * 1024 + 1), cwd)).toBeUndefined();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

const retrySeed = seeded(async (cwd) => {
  await sh(["git", "init", "-q"], { cwd });
  writeFileSync(
    join(cwd, "private-case.test.ts"),
    'import {test} from "bun:test";test("private-case",()=>{});',
  );
  await sh(["git", "add", "."], { cwd });
  await sh(["git", "commit", "-qm", "test fixture"], { cwd });
  return (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
});
test("expanded retry and covering commands execute internally while their identities withhold", async () => {
  const f = fixture(["private-case"]),
    { value: sha } = await retrySeed(f.cwd);
  const cfg = { ...config([{ name: "test", run: "bun test" }]), retryFiles: "bun test {files}" };
  const original = {
    name: "test",
    command: "bun test",
    ok: false,
    exitCode: 1,
    durationMs: 0,
    output: "failed",
    failedFiles: ["private-case.test.ts"],
  };
  const commands: string[] = [];
  const run = async (gates: GateConfig) => {
    commands.push(...gates.checks.map((c) => c.run));
    return { ...(await runGates(f.cwd, gates, new AbortController().signal)), sha, trackedClean: true };
  };
  await f.scoped(() =>
    confinementScope.run(fakeConfinement, async () => {
      const retries = await retryFailures(
        [{ check: cfg.checks[0] as GateCommand, original }],
        f.cwd,
        cfg,
        new AbortController().signal,
        undefined,
        run,
      );
      const retry = retries.get(original)?.targetedRetry;
      expect(retry?.textPrivacy?.identities).toEqual({ withheld: true, reason: "private-match" });
      expect(retries.get(original)?.command).toBe(original.command);
      expect(retry?.ok).toBe(true);
      expect(commands[0]).toContain("private-case.test.ts");
      const covering = await coveringTestCommand(
        { file: "private-case.test.ts", name: "private-case" },
        cfg,
        f.cwd,
        sha,
      );
      if (!covering.command) throw Error(covering.reason);
      const r = (await run(config([{ name: "test", run: covering.command }]))).checks[0];
      expect(r?.textPrivacy?.identities).toEqual({ withheld: true, reason: "private-match" });
      expect(r?.ok).toBe(true);
      expect(r?.command).toContain("private-case");
    }),
  );
});
