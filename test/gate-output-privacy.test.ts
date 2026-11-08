import { afterEach, beforeEach, expect, spyOn } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GateCommand, GateConfig } from "../src/gates/detect.ts";
import { extractFailures, formatGateOutput, RENDER_LIMITS, renderGateOutput } from "../src/gates/failures.ts";
import * as junit from "../src/gates/junit.ts";
import { projectGateDiagnostics } from "../src/gates/output.ts";
import { protectGateOutput } from "../src/gates/output-privacy.ts";
import { privateStringsDigest } from "../src/gates/private.ts";
import { retryFailures, runGates, targetedRetrySkipReason, validateRetry } from "../src/gates/run.ts";
import { BunTestCoverage, MAX_TEST_IDENTITY_LENGTH } from "../src/gates/test-coverage.ts";
import * as identityModule from "../src/gates/text-privacy.ts";
import { gateIdentities, gatePrivacyScope, IDENTITY_CAP, withheldText } from "../src/gates/text-privacy.ts";
import { confinementScope, runSandboxed } from "../src/harness/sandbox.ts";
import { coveringTestCommand } from "../src/pipeline/covering-tests.ts";
import { postMergeConfirmationText } from "../src/pipeline/post-merge-confirmation.ts";
import { formatGateFeedback, reviewPrompt } from "../src/pipeline/prompts.ts";
import { createCredentialRegistry, credentialRegistry } from "../src/util/credential-matcher.ts";
import {
  capturePrivacySnapshot,
  checkPrepared,
  createPrivacyRegistry,
  currentPrivacyGeneration,
  preparePrivacyPolicy,
  privacyLimits,
} from "../src/util/privacy-boundary.ts";
import {
  createPrivacyChecker,
  type PrivacyWorkerPort,
  privacyWorkerHandler,
} from "../src/util/privacy-checker.ts";
import { issuePrivacyWorkerChunks } from "../src/util/privacy-chunks.ts";
import { provisionPrivacyPolicy } from "../src/util/privacy-policy.ts";
import { checkAndSign, verifier } from "../src/util/privacy-proof.ts";
import { agentEnv, type ProcResult, registerCredential, runProcess, sh } from "../src/util/proc.ts";
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
function fixture(entries: string[] = [], credential?: string, now = Date.now) {
  const cwd = mkdtempSync(join(tmpdir(), "gate-output-"));
  dirs.push(cwd);
  const secrets = createCredentialRegistry();
  if (credential) secrets.add(credential);
  const registry = createPrivacyRegistry(secrets);
  registry.refreshPolicy = () => {};
  registry.replacePolicy(entries.map((value, entry) => ({ value, entry })));
  const checker = createPrivacyChecker({ registry, workerFactory: port, now });
  checkers.push(checker);
  const signer = () => Buffer.alloc(32, 23);
  const excerptGeneration = credentialRegistry.generation;
  const excerptCurrent = () => credentialRegistry.generation === excerptGeneration;
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
  return { cwd, registry, checker, signer, scoped, gate, excerptCurrent };
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
  expect(verify(r.textPrivacy?.output, "output", r.output, true)).toBe(true);
  expect(verify(r.textPrivacy?.output, "output", `${r.output}!`, true)).toBe(false);
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
    const r = await f.gate("diagnostic\n(fail) case", "", {
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
    expect(rejected.textPrivacy?.output).toEqual({ withheld: true, reason: "unproven" });
    expect(rejected.textPrivacy).not.toHaveProperty("failures");
    expect(rejected.textPrivacy).not.toHaveProperty("renderings");
    expect(formatGateOutput(rejected, 9_000)).toBe(withheldText("unproven"));
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
  const original = await f.gate("original diagnostic\n(fail) case");
  expect(original.textPrivacy?.renderings?.[3000]?.withheld).toBe(false);
  const setup = await f.gate("setup diagnostic\n(fail) setup", "", {
    run: "bun emit.ts; : private-case; exit 1",
  });
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
  expect(r?.textPrivacy?.output).toEqual({ withheld: true, reason: "unproven" });
  expect(r?.textPrivacy).not.toHaveProperty("failures");
  expect(r?.textPrivacy).not.toHaveProperty("renderings");
  expect(r && formatGateOutput(r, 3_000)).toBe(withheldText("unproven"));
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

test.each([5999, 6000, 6001])("output proof binds clipping at %s units", async (size) => {
  const f = fixture(),
    text = "x".repeat(size);
  const protectedOutput = await f.scoped(() => protectGateOutput(capture(text), "[]", control()));
  const r = { name: "test", command: "true", ok: false, exitCode: 1, durationMs: 0, ...protectedOutput };
  const project = (value = r) =>
    projectGateDiagnostics(value, { mode: "outward", registry: f.registry, signer: f.signer });
  expect(protectedOutput.textPrivacy.output.truncated === true).toBe(size > 6000);
  expect(project().output).toBe(text.slice(-6000));
  if (size > 6000) {
    for (const truncated of [undefined, false]) {
      const changed = {
        ...r,
        textPrivacy: { ...r.textPrivacy, output: { ...r.textPrivacy.output, truncated } },
      };
      expect(project(changed).output).toBe(withheldText("unproven"));
    }
  }
});

const omitted = "[failure excerpts: diagnostic lines or failures left out]";
const identity = "(fail) case";
const diagnosticRoom = 8000 - omitted.length - 2 - identity.length - 1;
test.each(["line", "budget", "join"])("excerpt own-byte check rejects %s cuts", async (kind) => {
  const entry = kind === "join" ? "alpha beta" : "host.example";
  const source =
    kind === "line"
      ? `${" ".repeat(8000 - entry.length)}${entry}\u0301\n${identity}`
      : kind === "budget"
        ? `${"x".repeat(diagnosticRoom - entry.length)}${entry}\u0301\n${identity}`
        : "(fail) alpha\n(pass) reset\nbeta\n(fail) other";
  const f = fixture([entry]),
    excerpt = extractFailures(source);
  expect(excerpt).toBeDefined();
  const r = await f.scoped(() =>
    protectGateOutput(capture(source), "[]", control(), excerpt, f.excerptCurrent),
  );
  expect(r.textPrivacy.output.withheld).toBe(false);
  expect(r.failures).toBeUndefined();
  expect(r.textPrivacy.failures).toEqual({ withheld: true, reason: "private-match" });
});

test.each([0, 1])(
  "diagnostics exactly filling their room plus %s preserve omission conditions",
  async (extra) => {
    const source = `${"x".repeat(diagnosticRoom + extra)}\n${identity}`;
    const f = fixture(),
      excerpt = extractFailures(source);
    expect(excerpt?.includes(omitted)).toBe(extra === 1);
    const r = await f.scoped(() =>
      protectGateOutput(capture(source), "[]", control(), excerpt, f.excerptCurrent),
    );
    expect(r.failures).toBe(excerpt);
    const verify = verifier(f.registry, f.signer).verify;
    expect(verify(r.textPrivacy.failures, "failures", r.failures ?? "", true)).toBe(true);
    expect(verify(r.textPrivacy.failures, "failures", `${r.failures}!`, true)).toBe(false);
    expect(verify(r.textPrivacy.failures, "failures", r.failures ?? "", false)).toBe(false);
  },
);

test.each(["R1", "R3", "timeout", "cancelled", "cut"])(
  "%s withholding skips excerpts but still checks identities",
  async (kind) => {
    const f = fixture([kind === "R3" ? "alpha beta" : "private-value"]);
    const res =
      kind === "R1"
        ? capture("private-value", "safe")
        : kind === "R3"
          ? capture("alpha", "beta")
          : capture("safe");
    if (kind === "timeout") res.timedOut = true;
    if (kind === "cancelled") res.cancelled = true;
    if (kind === "cut") res.capture = { provenance: { kind: "cut", truncated: true } };
    const checks = spyOn(f.checker, "protectText"),
      cuts = spyOn(f.checker, "protectProducerCut");
    const r = await f.scoped(() => protectGateOutput(res, "[]", control(), identity, f.excerptCurrent));
    expect(r.failures).toBeUndefined();
    expect(r.textPrivacy.failures?.withheld).toBe(true);
    expect(cuts).not.toHaveBeenCalled();
    expect(r.textPrivacy).not.toHaveProperty("renderings");
    expect(checks.mock.calls.at(-1)?.[0].text).toBe("[]");
    expect(r.textPrivacy.identities?.withheld).toBe(false);
  },
);

test.each([true, false])("unsigned excerpts require a clean check: clean=%s", async (clean) => {
  const f = fixture(["private-value"]),
    c = control();
  const cuts = spyOn(f.checker, "protectProducerCut");
  const r = await f.scoped(
    () => protectGateOutput(capture("source"), "[]", c, clean ? identity : "private-value", f.excerptCurrent),
    () => undefined,
  );
  expect(r.failures).toBe(clean ? identity : undefined);
  expect(r.textPrivacy).not.toHaveProperty("failures");
  expect(cuts.mock.calls[0]?.[1]).toEqual(c);
});

test("an entries change between source and excerpt refuses the excerpt", async () => {
  const f = fixture(),
    original = f.checker.protectProducerCut;
  spyOn(f.checker, "protectProducerCut").mockImplementation((...args) => {
    f.registry.replacePolicy([{ value: "elsewhere", entry: 0 }]);
    return original(...args);
  });
  const r = await f.scoped(() =>
    protectGateOutput(capture("source"), "[]", control(), identity, f.excerptCurrent),
  );
  expect(r.failures).toBeUndefined();
  expect(r.textPrivacy.failures).toEqual({ withheld: true, reason: "stale-generation" });
});

test("runner and deploy extraction retain whole-value short credential redaction", async () => {
  const credential = "s7Token";
  registerCredential("EXCERPT_SHORT_TEST", credential);
  const f = fixture([], credential),
    source = `${credential}\n${identity}`;
  expect(extractFailures(source)).toBe(`[redacted]\n${identity}`);
  const r = await f.gate(source);
  expect(r.failures).toBe(`[redacted]\n${identity}`);
});

test("passing gates never request excerpts even with failure-shaped rows", async () => {
  const f = fixture(),
    cuts = spyOn(f.checker, "protectProducerCut");
  const r = await f.gate(`diagnostic\n${identity}`, "", { run: "bun emit.ts; exit 0" });
  expect(r.ok).toBe(true);
  expect(r.failures).toBeUndefined();
  expect(cuts).not.toHaveBeenCalled();
});

test.each(
  [true, false].flatMap((signed) =>
    ["source", "identities", "excerpt", "after-excerpt", "unchanged"].map(
      (stage) => [signed, stage] as const,
    ),
  ),
)("excerpt collection credentials stay current: signed=%s registration=%s", async (signed, stage) => {
  const f = fixture(),
    token = `excerpt-race-${signed}-${stage}-${"q".repeat(48)}`,
    source = `${"x".repeat(7905)}${token}\n(fail) case`,
    prefix = token.slice(0, 24),
    original = f.checker.protectText,
    originalCut = f.checker.protectProducerCut;
  // This is the fragment collected before any checker hook registers the complete token.
  expect(extractFailures(source)).toContain(prefix);
  const register = () => {
    registerCredential("EXCERPT_RACE_TEST", token);
    f.registry.addCredential(token);
  };
  let requests = 0;
  spyOn(f.checker, "protectText").mockImplementation((...args) => {
    if (++requests === (stage === "source" ? 1 : stage === "identities" ? 2 : 0)) register();
    return original(...args);
  });
  const cuts = spyOn(f.checker, "protectProducerCut").mockImplementation(async (...args) => {
    if (stage === "excerpt") register();
    const receipt = await originalCut(...args);
    if (stage === "after-excerpt") register();
    return receipt;
  });
  const r = await f.gate(source, "", {}, signed ? f.signer : () => undefined);
  expect(r.textPrivacy?.output.withheld).toBe(false);
  expect(r.textPrivacy?.identities?.withheld).toBe(false);
  if (stage === "source") {
    expect(r.output).toBe(`${"x".repeat(7905)}[redacted]\n(fail) case`.slice(-6000));
    expect(cuts.mock.calls.map(([input]) => input.text)).not.toContain(extractFailures(source));
  }
  if (stage === "unchanged") {
    expect(r.failures).toContain(prefix);
    if (signed)
      expect(
        verifier(f.registry, f.signer).verify(r.textPrivacy?.failures, "failures", r.failures ?? "", true),
      ).toBe(true);
  } else {
    expect(r.failures).toBeUndefined();
    if (signed) expect(r.textPrivacy?.failures).toEqual({ withheld: true, reason: "stale-generation" });
  }
  if (!signed) expect(r.textPrivacy).not.toHaveProperty("failures");
});

test("resumed historical tail proofs project as unproven while current tail proofs release", async () => {
  const f = fixture(),
    protectedOutput = await f.scoped(() => protectGateOutput(capture("x".repeat(6100)), "[]", control()));
  const historical = {
    kind: "complete",
    mac: createHmac("sha256", f.signer())
      .update(
        JSON.stringify([
          "limitless-gate-proof/1",
          "complete",
          "privacy/1",
          privateStringsDigest(f.registry.entries),
          "output",
          createHash("sha256").update(protectedOutput.output).digest("hex"),
        ]),
      )
      .digest("hex"),
  };
  const current = {
    name: "test",
    command: "true",
    ok: false,
    exitCode: 1,
    durationMs: 0,
    ...protectedOutput,
  };
  for (const truncated of [false, true]) {
    const restored: typeof current = JSON.parse(
      JSON.stringify({
        ...current,
        textPrivacy: {
          ...current.textPrivacy,
          output: { ...current.textPrivacy.output, ...historical, truncated },
        },
      }),
    );
    expect(
      projectGateDiagnostics(restored, { mode: "outward", registry: f.registry, signer: f.signer }).output,
    ).toBe(withheldText("unproven"));
  }
  const restored: typeof current = JSON.parse(JSON.stringify(current));
  expect(
    projectGateDiagnostics(restored, { mode: "outward", registry: f.registry, signer: f.signer }).output,
  ).toBe("x".repeat(6000));
});

const renderedResult = async (
  f: ReturnType<typeof fixture>,
  output = "z".repeat(6000),
  failures = "checked diagnostic\n(fail) case",
) => ({
  name: "test",
  command: "test",
  ok: false,
  exitCode: 1,
  durationMs: 1,
  ...(await f.scoped(() => protectGateOutput(capture(output), "[]", control(), failures, f.excerptCurrent))),
});

test("checked renderings restore excerpts and tail in feedback, review and confirmation", async () => {
  const f = fixture(),
    r = await renderedResult(f);
  const c = {
    name: "test",
    result: r,
    verdict: "regressed" as const,
    blocking: true,
    coordinatorConfirmation: {
      worker: "test",
      reason: "failed on coordinator",
      originalVerdict: "regressed" as const,
      result: r,
    },
  };
  f.scoped(() => {
    for (const limit of RENDER_LIMITS) {
      const expected = `checked diagnostic\n(fail) case\n\n${"z".repeat(1000)}`;
      expect(formatGateOutput(r, limit)).toBe(expected);
      expect(formatGateOutput(r, limit)).toBe(renderGateOutput(r, limit));
      for (const text of [
        formatGateFeedback([c]),
        reviewPrompt({
          prompt: "test",
          spec: null,
          baseSha: "base",
          stat: "",
          gates: [c],
          audit: [],
          implementerReport: "",
        }),
        postMergeConfirmationText(c, true),
      ])
        expect(text).toContain(expected);
    }
  });
});

test("rendering cuts preserve complete identities and surrogate pairs", () => {
  for (const limit of RENDER_LIMITS) {
    for (const r of [
      { output: `a😀${"z".repeat(limit - 1)}` },
      { output: `a😀${"z".repeat(999)}`, failures: `${"😀".repeat(6000)}\n(fail) preserved` },
    ]) {
      const text = renderGateOutput(r, limit);
      expect(text.length).toBeLessThanOrEqual(limit);
      expect(text.isWellFormed()).toBe(true);
      if (r.failures) {
        expect(text).toContain("(fail) preserved");
        expect(text).toContain(omitted);
      }
    }
  }
});

test.each(["partial", "tail-normalization"])("rendering checks its exact cut bytes: %s", async (kind) => {
  // Unlike the prefix-cut accent case, this cut removes the base letter at the head.
  const entry = kind === "partial" ? "host.example" : "\u0301x";
  const source = kind === "partial" ? `${"x".repeat(4000)}host.exa` : `a\u0301x${"!".repeat(2998)}`;
  const f = fixture([entry]),
    candidate = source.slice(-3000);
  const policy = preparePrivacyPolicy(capturePrivacySnapshot(f.registry));
  expect(checkPrepared(policy, source)).toEqual({ clean: true });
  expect(checkPrepared(policy, candidate, { truncated: true })).toMatchObject({ match: { entries: [0] } });
  const r = {
    name: "test",
    command: "test",
    ok: true,
    exitCode: 0,
    durationMs: 1,
    ...(await f.scoped(() => protectGateOutput(capture(source), "[]", control()))),
  };
  expect(r.textPrivacy.renderings?.[3000]).toEqual({ withheld: true, reason: "private-match" });
  f.scoped(() => {
    expect(formatGateOutput(r, 3000)).toBe(withheldText("unproven"));
    expect(formatGateOutput(r, 9000)).toBe(source);
  });
});

test("a private match in one rendering still checks and releases the other limit", async () => {
  // The 3,000 cut drops the accent after the entry; the 9,000 rendering keeps the excerpt whole.
  const keep = 3000 - 1002 - omitted.length - identity.length - 2;
  const failures = `${"x".repeat(keep - 12)}host.example\u0301${"!".repeat(200)}\n${identity}`;
  const f = fixture(["host.example"]),
    cuts = spyOn(f.checker, "protectProducerCut");
  const r = await renderedResult(f, "z".repeat(6000), failures);
  const [short, long] = RENDER_LIMITS.map((limit) => renderGateOutput(r, limit));
  const policy = preparePrivacyPolicy(capturePrivacySnapshot(f.registry));
  expect(checkPrepared(policy, failures)).toEqual({ clean: true });
  expect(checkPrepared(policy, long ?? "", { truncated: true })).toEqual({ clean: true });
  expect(checkPrepared(policy, short ?? "", { truncated: true })).toMatchObject({ match: { entries: [0] } });
  expect(r.failures).toBe(failures);
  expect(cuts).toHaveBeenCalledTimes(3);
  expect(r.textPrivacy.renderings?.[3000]).toEqual({ withheld: true, reason: "private-match" });
  expect(r.textPrivacy.renderings?.[9000]?.withheld).toBe(false);
  f.scoped(() => {
    expect(formatGateOutput(r, 3000)).toBe(withheldText("unproven"));
    expect(formatGateOutput(r, 9000)).toBe(`${failures}\n\n${"z".repeat(1000)}`);
  });
});

test.each([2999, 3000, 3001, 6000])("exact output bytes reuse output proofs at %s units", async (size) => {
  const f = fixture(),
    cuts = spyOn(f.checker, "protectProducerCut"),
    checks = spyOn(f.checker, "protectText");
  const output = "z".repeat(size),
    r = {
      name: "test",
      command: "test",
      ok: true,
      exitCode: 0,
      durationMs: 1,
      ...(await f.scoped(() => protectGateOutput(capture(output), "[]", control()))),
    };
  expect(checks).toHaveBeenCalledTimes(2);
  expect(cuts).toHaveBeenCalledTimes(size > 3000 ? 1 : 0);
  if (size <= 3000) expect(r.textPrivacy).not.toHaveProperty("renderings");
  f.scoped(() => {
    expect(formatGateOutput(r, 3000)).toBe(output.slice(-3000));
    expect(formatGateOutput(r, 9000)).toBe(output);
    expect(formatGateOutput({ ...r, output: `X${output.slice(1)}` }, 9000)).toBe(withheldText("unproven"));
  });
  const unsigned = await f.scoped(
    () => protectGateOutput(capture(output), "[]", control()),
    () => undefined,
  );
  expect(unsigned.textPrivacy).not.toHaveProperty("renderings");
});

test.each(["output", "excerpt", "limit", "kind", "cut", "key"])(
  "rendering proof binds recomputed bytes and metadata: %s",
  async (tamper) => {
    const f = fixture(),
      r = await renderedResult(f);
    const record = r.textPrivacy.renderings?.[3000];
    if (!record) throw Error("No rendering proof");
    if (tamper === "output") {
      r.output = `${r.output.slice(0, -1)}Q`;
      const fresh = await f.scoped(() => protectGateOutput(capture(r.output), "[]", control()));
      r.textPrivacy.output = fresh.textPrivacy.output;
    }
    if (tamper === "excerpt") r.failures = r.failures?.replace("diagnostic", "DIAGNOSTIC");
    if (tamper === "limit") Object.assign(record, r.textPrivacy.renderings?.[9000]);
    if (tamper === "kind") record.kind = "attested:lan";
    if (tamper === "cut") record.truncated = false;
    if (tamper === "key") {
      const foreign = await f.scoped(
        () => protectGateOutput(capture(r.output), "[]", control(), r.failures, f.excerptCurrent),
        () => Buffer.alloc(32, 51),
      );
      Object.assign(record, foreign.textPrivacy.renderings?.[3000]);
    }
    f.scoped(() => expect(formatGateOutput(r, 3000)).toBe(withheldText("unproven")));
  },
);

test("renderings observe current policy and credentials without rewriting text", async () => {
  const f = fixture(),
    file = join(f.cwd, "private-strings.txt");
  writeFileSync(file, "");
  provisionPrivacyPolicy(f.cwd, [], { registry: f.registry });
  const r = await renderedResult(f, undefined, "fresh-render-credential-928\n(fail) case");
  f.scoped(() => {
    const text = formatGateOutput(r);
    expect(text).toContain("fresh-render-credential-928");
    writeFileSync(file, "different-policy-entry\n");
    expect(formatGateOutput(r)).toBe(withheldText("unproven"));
    writeFileSync(file, "");
    expect(formatGateOutput(r)).toBe(text);
    registerCredential("RENDER_TEST", "fresh-render-credential-928");
    expect(formatGateOutput(r)).toBe(withheldText("credential-changed"));
    expect(r.failures).toContain("fresh-render-credential-928");
  });
});

test.each(["deadline", "generation", "failure"])(
  "rendering requests stop and preserve output on %s",
  async (kind) => {
    let now = Date.now();
    const f = fixture([], undefined, () => now),
      c = control(),
      original = f.checker.protectProducerCut;
    const calls = spyOn(f.checker, "protectProducerCut").mockImplementation((...args) => {
      if (calls.mock.calls.length === 2) {
        if (kind === "deadline") now = c.deadline;
        if (kind === "generation") f.registry.replacePolicy([{ value: "unrelated-entry", entry: 0 }]);
        if (kind === "failure") throw Error("checker failed");
      }
      return original(...args);
    });
    const r = await f.scoped(() =>
      protectGateOutput(capture("z".repeat(6000)), "[]", c, "diagnostic\n(fail) case", f.excerptCurrent),
    );
    expect(calls).toHaveBeenCalledTimes(2); // R5 and R6; R7 is withheld without submission.
    expect(
      calls.mock.calls.every((args) => args[1]?.deadline === c.deadline && args[1]?.signal === c.signal),
    ).toBe(true);
    expect(r.output).toBe("z".repeat(6000));
    expect(r.textPrivacy.output.withheld).toBe(false);
    for (const limit of RENDER_LIMITS)
      expect(r.textPrivacy.renderings?.[limit]).toEqual({
        withheld: true,
        reason:
          kind === "deadline"
            ? "checker-timeout"
            : kind === "generation"
              ? "stale-generation"
              : "checker-failed",
      });
  },
);

test("R7 expiry keeps the released R6 rendering and shares its deadline", async () => {
  let now = Date.now();
  const f = fixture([], undefined, () => now),
    c = control(),
    protect = f.checker.protectProducerCut;
  const cuts = spyOn(f.checker, "protectProducerCut").mockImplementation((...args) => {
    if (cuts.mock.calls.length === 3) now = c.deadline;
    return protect(...args);
  });
  const r = {
    name: "test",
    command: "test",
    ok: false,
    exitCode: 1,
    durationMs: 1,
    ...(await f.scoped(() =>
      protectGateOutput(capture("z".repeat(6000)), "[]", c, "diagnostic\n(fail) case", f.excerptCurrent),
    )),
  };
  expect(cuts).toHaveBeenCalledTimes(3);
  expect(cuts.mock.calls.every((args) => args[1]?.deadline === c.deadline)).toBe(true);
  expect(r.textPrivacy.output.withheld).toBe(false);
  expect(r.textPrivacy.renderings?.[9000]).toEqual({ withheld: true, reason: "checker-timeout" });
  const refresh = spyOn(f.registry, "refreshPolicy");
  f.scoped(() => {
    expect(formatGateOutput(r, 3000)).toBe(`diagnostic\n(fail) case\n\n${"z".repeat(1000)}`);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(formatGateOutput(r, 9000)).toBe(withheldText("unproven"));
  });
});

test("a credential formed only by the rendering join refuses its cut proof", async () => {
  const output = "j".repeat(6000),
    failures = "producer-render-join-928\n(fail) unique";
  const credential = `${failures}\n\n${output.slice(-1000)}`,
    f = fixture([], credential);
  const r = await renderedResult(f, output, failures);
  expect(r.output).toBe(output);
  expect(r.failures).toBe(failures);
  expect(r.textPrivacy.output.withheld).toBe(false);
  for (const limit of RENDER_LIMITS) {
    expect(r.textPrivacy.renderings?.[limit]).toEqual({ withheld: true, reason: "private-match" });
    f.scoped(() => expect(formatGateOutput(r, limit)).toBe(withheldText("unproven")));
  }
});

test("a complete proof cannot authorize a rendering that needs cut semantics", async () => {
  const f = fixture(["host.example"]),
    r = await renderedResult(f, `${"x".repeat(4000)}host.exa`, "");
  const bytes = renderGateOutput(r, 3000);
  const proof = await checkAndSign({
    checker: f.checker,
    signer: f.signer,
    kind: "complete",
    field: "rendering:3000",
    text: bytes,
  });
  if (!proof) throw Error("Complete text should pass without partial-prefix semantics");
  r.textPrivacy.renderings = { "3000": { ...proof, withheld: false, truncated: false } };
  f.scoped(() => expect(formatGateOutput(r, 3000)).toBe(withheldText("unproven")));
});
