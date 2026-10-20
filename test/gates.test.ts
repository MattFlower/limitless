import { describe, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  linkSync,
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
import { Store } from "../src/db/store.ts";
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
import { extractFailures, FailureExcerpts, formatGateOutput } from "../src/gates/failures.ts";
import {
  canonical,
  checkPrivateText,
  loadPrivateStrings,
  privateMatches,
  redactPrivate,
} from "../src/gates/private.ts";
import {
  compareGates,
  type GateRun,
  retryBaselineFailures as productionBaselineRetry,
  runGates as productionGates,
  retryRegressions as productionRetry,
} from "../src/gates/run.ts";
import { defaultGateSlots, type GatePriority, gateSlots, Semaphore } from "../src/gates/slots.ts";
import { recordWorktree } from "../src/git/command.ts";
import { checkoutCommitted, type DiffInfo } from "../src/git/repos.ts";
import * as sandbox from "../src/harness/sandbox.ts";
import { ConfinementError } from "../src/harness/sandbox.ts";
import { formatAuditFeedback, formatGateFeedback } from "../src/pipeline/prompts.ts";
import * as proc from "../src/util/proc.ts";
import { sh } from "../src/util/proc.ts";
import { resolveTestWorkers } from "../src/util/test-workers.ts";
import { fakeConfinement, recordingConfinement, seatbeltSkip } from "./confinement.ts";
import { truncationEncodings } from "./privacy-support.ts";
import { test } from "./read-policy-support.ts";

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

  test.each(["formatting", "credential"])("refuses sanitized gate name collisions (%s)", (kind) => {
    const secret = "synthetic-detect-gate-name-credential-486";
    proc.registerCredential("detect-gate-name-test", secret);
    const sanitized = kind === "formatting" ? "check" : "check [redacted]";
    const names = [sanitized, kind === "formatting" ? "check\x1b[31m" : `check ${secret}`];
    const dir = tempDir({
      ".limitless.toml": `[gates]\nchecks = [${names.map((name) => `{ name = ${JSON.stringify(name)}, run = "true" }`).join(", ")}]\n`,
    });
    try {
      expect(() => detectGates(dir)).toThrow(
        `.limitless.toml gate names must stay distinct once sanitized: "${sanitized}"`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps literal gate names when sanitized names are distinct", () => {
    const secret = "synthetic-detect-control-credential-486";
    proc.registerCredential("detect-gate-name-control", secret);
    const names = ["check\x1b[31m", `other ${secret}`];
    const dir = tempDir({
      ".limitless.toml": `[gates]\nchecks = [${names.map((name) => `{ name = ${JSON.stringify(name)}, run = "true" }`).join(", ")}]\n`,
    });
    try {
      expect(detectGates(dir).checks).toEqual(names.map((name) => ({ name, run: "true" })));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  test("intact credentials on either stream are redacted without holding failure lines", async () => {
    const secret = "synthetic-intact-stream-credential-421";
    proc.registerCredential("INTACT_STREAM_TEST_TOKEN", secret);
    const dir = tempDir({
      "stdout.txt": `error: ${secret}\n(fail) stdout assertion\n`,
      "stderr.txt": `(fail) stderr ${secret}\n^ this test timed out after 100ms.\n`,
    });
    try {
      const run = await runGates(
        dir,
        {
          setup: [],
          source: "detected",
          protectedPaths: [],
          checks: [{ name: "test", run: "cat stdout.txt; cat stderr.txt >&2; exit 1" }],
        },
        new AbortController().signal,
      );
      expect(run.checks[0]?.output).toBe(
        "error: [redacted]\n(fail) stdout assertion\n\n(fail) stderr [redacted]\n^ this test timed out after 100ms.",
      );
      expect(run.checks[0]?.failures).toContain(
        "(fail) stderr [redacted]\n^ this test timed out after 100ms.",
      );
      expect(JSON.stringify(run)).not.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(["stdout", "stderr"])(
    "the untruncated %s stream keeps its failure diagnostics",
    async (stream) => {
      const secret = "synthetic-per-stream-cut-credential-421";
      proc.registerCredential("PER_STREAM_CUT_TEST_TOKEN", secret);
      const diagnostic = "(fail) retained identity\n^ this test timed out after 100ms.\n";
      const dir = tempDir({ "long.txt": "x".repeat(65_000), "short.txt": diagnostic });
      try {
        const run = await runGates(
          dir,
          {
            setup: [],
            source: "detected",
            protectedPaths: [],
            checks: [
              {
                name: "test",
                run:
                  stream === "stdout"
                    ? "cat long.txt; cat short.txt >&2; exit 1"
                    : "cat long.txt >&2; cat short.txt; exit 1",
              },
            ],
          },
          new AbortController().signal,
        );
        // The stdout tail can itself fall outside the combined tail, but its early excerpt must survive.
        if (stream === "stdout") expect(run.checks[0]?.output).toContain(diagnostic.trim());
        expect(run.checks[0]?.failures).toContain(diagnostic.trim());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test.each(["literal", "JSON"])("huge %s credentials leave no fragments at tail cuts", async (form) => {
    const prefix = "synthetic-huge-key-";
    const suffix = "-huge-key-footer";
    const secret = prefix + "\\".repeat(35_000 - prefix.length - suffix.length) + suffix;
    proc.registerCredential("HUGE_STREAM_TEST_TOKEN", secret);
    const encoded = form === "JSON" ? JSON.stringify(secret).slice(1, -1) : secret;
    const dir = tempDir({
      "huge.txt": `error: ${encoded}\n(fail) huge\n${"\u001b[0m".repeat(8_000)}${"z".repeat(5_950)}`,
    });
    try {
      const run = await runGates(
        dir,
        {
          setup: [],
          source: "detected",
          protectedPaths: [],
          checks: [
            { name: "stdout", run: "cat huge.txt; exit 1" },
            { name: "stderr", run: "cat huge.txt >&2; exit 1" },
          ],
        },
        new AbortController().signal,
      );
      for (const result of run.checks) {
        expect(result.failures).toContain("error: [redacted]");
        expect(result.output.length).toBeLessThanOrEqual(6_000);
        const text = JSON.stringify(result);
        for (const value of [secret, encoded]) {
          const fragments = new Set(
            Array.from({ length: value.length - 7 }, (_, i) => value.slice(i, i + 8)),
          );
          for (const fragment of fragments) expect(text).not.toContain(fragment);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("credential fragments cannot survive the runner cap or normalized tail cuts", async () => {
    const secret = "synthetic-runner-cap-credential-421";
    proc.registerCredential("RUNNER_CAP_TEST_TOKEN", secret);
    const dir = tempDir({
      "cap.txt": `${secret}${"\u001b[0m".repeat(15_995)}`,
      "tail.txt": `${secret}${"\u001b[0mz".repeat(5_980)}`,
      "excerpt.txt": `error: ${secret}\n${"x".repeat(9_000)}${secret}\n(fail) assertion\n`,
    });
    try {
      const run = await runGates(
        dir,
        {
          setup: [],
          source: "detected",
          protectedPaths: [],
          checks: ["cap", "tail", "excerpt"].flatMap((name) => [
            { name: `${name}-stdout`, run: `cat ${name}.txt; exit 1` },
            { name: `${name}-stderr`, run: `cat ${name}.txt >&2; exit 1` },
          ]),
        },
        new AbortController().signal,
      );
      for (const result of run.checks) {
        const text = `${result.output}\n${result.failures ?? ""}`;
        for (let i = 0; i <= secret.length - 8; i++) expect(text).not.toContain(secret.slice(i, i + 8));
      }
      expect(run.checks).toHaveLength(6);
      expect(run.checks[2]?.output).toContain("[redacted]");
      expect(run.checks[4]?.failures).toContain("[redacted]");
      expect(run.checks[4]?.failures).toContain("left out");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("raw confinement classification survives redaction and cannot be created by ANSI normalization", async () => {
    const marker = "sandbox_apply: Operation not permitted";
    const secret = `${marker} synthetic-raw-confinement-421`;
    proc.registerCredential("RAW_CONFINEMENT_TEST_TOKEN", secret);
    const dir = tempDir({
      "interrupted.txt": marker.replace("Operation", "Oper\u001b[0mation"),
      "raw.txt": secret,
    });
    try {
      const run = await runGates(
        dir,
        {
          setup: [],
          source: "detected",
          protectedPaths: [],
          checks: [
            { name: "interrupted", run: "cat interrupted.txt; exit 1" },
            { name: "raw", run: "cat raw.txt; exit 1" },
          ],
        },
        new AbortController().signal,
      );
      expect(run.checks[0]).toMatchObject({ output: marker, confinementError: false });
      expect(run.checks[1]).toMatchObject({ output: "[redacted]", confinementError: true });
      expect(compareGates(null, run).map((c) => c.verdict)).toEqual(["new_failure", "confinement_error"]);
      const legacy = { ...run, checks: run.checks.slice(0, 1).map(({ confinementError: _flag, ...r }) => r) };
      expect(compareGates(null, legacy)[0]?.verdict).toBe("confinement_error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("redacts setup, checks and retries before tail cuts, callbacks and persistence", async () => {
    const credential = "synthetic-gate-boundary-credential-409";
    proc.registerCredential("GATE_BOUNDARY_TEST_TOKEN", credential);
    const output =
      `${credential}.test.ts:\n(pass) earlier\nerror: credential ${credential}\n(fail) assertion\n${"summary\n".repeat(1_000)}` +
      `${credential}${"z".repeat(5_980)}`;
    const dir = tempDir({ "output.txt": output });
    const db = join(dir, "store.db");
    let store = new Store(db);
    try {
      const cfg: GateConfig = {
        setup: ["cat output.txt"],
        checks: [
          { name: "test", run: "cat output.txt; exit 1" },
          { name: "pass", run: "cat output.txt" },
        ],
        source: "detected",
        protectedPaths: [],
      };
      const observed: string[] = [];
      const signal = new AbortController().signal;
      const run = await runGates(dir, cfg, signal, {
        onResult: (result) => observed.push(JSON.stringify(result)),
      });
      for (const result of [...run.setup, ...run.checks]) {
        expect(result.output).toContain("[redacted]");
        expect(result.output).not.toContain(credential.slice(-20));
      }
      expect(run.checks[0]?.failures).toContain("error: credential [redacted]");
      expect(observed).toHaveLength(3);
      const retried = await retryBaselineFailures(run, dir, cfg, signal);
      expect(retried.checks[0]?.firstAttempt).toBe(run.checks[0]);
      expect(retried.checks[0]?.failures).toContain("error: credential [redacted]");
      const failed = run.checks[0];
      if (!failed) throw new Error("missing check result");
      const regression = await retryRegressions(
        [{ name: "test", verdict: "regressed", blocking: true, result: failed }],
        dir,
        cfg,
        [],
        signal,
      );
      expect(regression[0]?.result.failures).toContain("error: credential [redacted]");
      for (const text of [...observed, JSON.stringify(retried), JSON.stringify(regression)]) {
        expect(text).not.toContain(credential);
        expect(text).not.toContain(credential.slice(-20));
      }
      const repo = store.upsertRepo({
        slug: "test/repo",
        kind: "github",
        localPath: null,
        url: "https://example.com/repo",
        defaultBranch: "main",
        mergePolicy: "pr",
      });
      const saved = store.createRun(repo, { repo: repo.slug, prompt: "test" });
      const key = { repoId: repo.id, baseSha: "base", gatesHash: "gates", envHash: "env" };
      store.putArtifact(saved.id, "gates.json", "gates", JSON.stringify(retried));
      store.setRunState(saved.id, retried);
      // Only successful checks are cached in production.
      store.putBaselineCache(key, { ...run, checks: run.checks.filter((r) => r.ok) }, saved.id);
      store.close();
      store = new Store(db);
      for (const text of [
        store.getArtifact(saved.id, "gates.json"),
        JSON.stringify(store.getRunState(saved.id)),
        JSON.stringify(store.getBaselineCache(key, 0)),
      ]) {
        expect(text).toContain("[redacted]");
        expect(text).not.toContain(credential);
        expect(text).not.toContain(credential.slice(-20));
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("redacts terminal-formatted credentials before failure excerpt bounds", async () => {
    const credential = "synthetic-excerpt-credential-409";
    proc.registerCredential("EXCERPT_TEST_TOKEN", credential);
    const colored = `${credential.slice(0, 12)}\u001b[31m${credential.slice(12)}\u001b[0m`;
    const dir = tempDir({ "output.txt": `${"x".repeat(7_900)}${colored}\n(fail) assertion\n` });
    try {
      const run = await runGates(
        dir,
        {
          setup: [],
          checks: [{ name: "test", run: "cat output.txt; exit 1" }],
          source: "detected",
          protectedPaths: [],
        },
        new AbortController().signal,
      );
      expect(run.checks[0]?.failures).toContain("[redacted]");
      expect(JSON.stringify(run)).not.toContain(credential);
      expect(JSON.stringify(run)).not.toContain(credential.slice(0, 12));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("redacts ANSI on every line of a multiline credential before excerpts and artifacts", async () => {
    const secret = "synthetic-colored-first-paragraph\n\nsynthetic-colored-last-paragraph";
    proc.registerCredential("COLORED_MULTILINE_TEST_TOKEN", secret);
    const colored = secret
      .split("\n")
      .map((line) => `\u001b[31m${line}\u001b[0m`)
      .join("\n");
    const output = `error: ${colored}\n(fail) colored assertion\n`;
    const dir = tempDir({
      "emit.ts": `process.stdout.write(${JSON.stringify(output)}); process.exitCode = 1;`,
    });
    const store = new Store(":memory:");
    try {
      const run = await runGates(
        dir,
        {
          setup: [],
          source: "detected",
          protectedPaths: [],
          checks: [{ name: "test", run: `'${process.execPath}' emit.ts` }],
        },
        new AbortController().signal,
      );
      expect(run.checks[0]?.output).toBe("error: [redacted]\n(fail) colored assertion");
      expect(run.checks[0]?.failures).toBe("error: [redacted]\n(fail) colored assertion");
      const repo = store.upsertRepo({
        slug: "test/repo",
        kind: "github",
        localPath: null,
        url: "https://example.com/repo",
        defaultBranch: "main",
        mergePolicy: "pr",
      });
      const saved = store.createRun(repo, { repo: repo.slug, prompt: "test" });
      store.putArtifact(saved.id, "gates.json", "gates", JSON.stringify(run));
      const artifact = store.getArtifact(saved.id, "gates.json");
      expect(artifact).toContain("[redacted]");
      for (const fragment of secret.split("\n").filter(Boolean)) expect(artifact).not.toContain(fragment);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["2", "2"],
    ["invalid", String(resolveTestWorkers(""))],
  ])("gate command receives validated test workers: %s", async (value, expected) => {
    const previous = process.env.LIMITLESS_TEST_WORKERS;
    const secret = process.env.LIMITLESS_TEST_SECRET;
    const dir = tempDir({});
    try {
      process.env.LIMITLESS_TEST_WORKERS = value;
      process.env.LIMITLESS_TEST_SECRET = "must-stay-private";
      const run = await runGates(
        dir,
        {
          setup: [],
          checks: [
            {
              name: "workers",
              run: `printf '%s\\n' "$LIMITLESS_TEST_WORKERS" "\${LIMITLESS_TEST_SECRET-unset}"; "${process.execPath}" "${resolve("scripts/test-workers.ts")}"`,
            },
          ],
          source: "detected",
          protectedPaths: [],
        },
        new AbortController().signal,
      );
      expect(run.checks[0]?.ok).toBe(true);
      expect(run.checks[0]?.output).toBe(`${expected}\nunset\n${expected}`);
    } finally {
      if (previous === undefined) delete process.env.LIMITLESS_TEST_WORKERS;
      else process.env.LIMITLESS_TEST_WORKERS = previous;
      if (secret === undefined) delete process.env.LIMITLESS_TEST_SECRET;
      else process.env.LIMITLESS_TEST_SECRET = secret;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("retains early failure diagnostics in the result and its existing artifact", async () => {
    const output =
      "sample.test.ts:\n(pass) earlier\nerror: values differ\nExpected: 1\nReceived: 2\n(fail) assertion\n" +
      "skipped summary\n".repeat(7_000);
    const dir = tempDir({ "output.txt": output });
    const store = new Store(":memory:");
    try {
      const run = await runGates(
        dir,
        {
          setup: [],
          checks: [
            { name: "test", run: "cat output.txt; exit 1" },
            { name: "pass", run: "cat output.txt" },
          ],
          source: "detected",
          protectedPaths: [],
        },
        new AbortController().signal,
      );
      expect(run.checks[0]?.ok).toBe(false);
      expect(run.checks[0]?.output).toBe(output.trim().slice(-6_000));
      expect(run.checks[0]?.output).not.toContain("error:");
      expect(run.checks[0]?.failures).toContain("error: values differ\nExpected: 1\nReceived: 2");
      expect(formatGateFeedback(compareGates(null, run))).toContain(
        "error: values differ\nExpected: 1\nReceived: 2",
      );
      expect(run.checks[1]?.ok).toBe(true);
      expect(run.checks[1]).not.toHaveProperty("failures");
      const repo = store.upsertRepo({
        slug: "test/repo",
        kind: "github",
        localPath: null,
        url: "https://example.com/repo",
        defaultBranch: "main",
        mergePolicy: "pr",
      });
      const savedRun = store.createRun(repo, { repo: repo.slug, prompt: "test" });
      store.putArtifact(savedRun.id, "gates.json", "gates", JSON.stringify(run));
      const saved = JSON.parse(store.getArtifact(savedRun.id, "gates.json") ?? "null") as GateRun;
      expect(saved.checks[0]?.output).toBe(output.trim().slice(-6_000));
      expect(saved.checks[0]?.failures).toContain("Expected: 1\nReceived: 2");
      expect(store.listArtifacts(savedRun.id)).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  test.each(["flag", "output", "firstAttempt", "targetedRetry"] as const)(
    "baseline confinement failure makes only its check unusable (%s)",
    (kind) => {
      const passed = { ...r("test", true), confinementError: false };
      const confinement = {
        ...r("test", false),
        ...(kind === "flag"
          ? { confinementError: true }
          : { output: "sandbox_apply: Operation not permitted" }),
      };
      const baseline: GateRun = {
        setupOk: true,
        setup: [],
        checks: [
          kind === "firstAttempt" || kind === "targetedRetry"
            ? { ...passed, [kind]: confinement }
            : confinement,
          r("lint", true),
        ],
      };
      const compare = (result: GateRun["checks"][number]) =>
        compareGates(baseline, { setupOk: true, setup: [], checks: [result, r("lint", true)] });
      const cmp = compare(passed);
      expect(cmp.map((c) => [c.verdict, c.blocking])).toEqual([
        ["new_pass", false],
        ["pass", false],
      ]);
      expect(cmp[0]?.result).toBe(passed);
      expect(formatGateFeedback(cmp)).toBe("");
      for (const timedOut of [false, true]) {
        const failed = { ...r("test", false), output: "candidate assertion failed", timedOut };
        const cmp = compare(failed);
        expect(cmp[0]).toMatchObject({ verdict: "new_failure", blocking: true });
        expect(cmp[0]?.result).toBe(failed);
        const feedback = formatGateFeedback(cmp);
        expect(feedback).toContain("Baseline couldn't be compared because of baseline confinement failure");
        expect(feedback).toContain(failed.output);
        expect(feedback).not.toContain("CONFINEMENT ERROR");
        expect(feedback).not.toContain("sandbox launch failed");
        expect(feedback).not.toContain("passed before your change");
        if (timedOut) expect(feedback).toContain("timed out");
      }
    },
  );

  test("gate counterparts prefer exact names and reject sanitized ambiguity on either side", () => {
    const base = (checks: GateRun["checks"]): GateRun => ({ setupOk: true, setup: [], checks });
    const red = "check\x1b[31m";
    const blue = "check\x1b[34m";
    // Exact identities win even when sanitized names collide.
    expect(
      compareGates(base([r("check", false), r(red, true)]), base([r("check", false), r(red, false)])).map(
        (c) => [c.verdict, c.blocking],
      ),
    ).toEqual([
      ["still_failing", false],
      ["regressed", true],
    ]);
    // A unique counterpart on one side is insufficient when the other side collides.
    const cases: [GateRun["checks"], GateRun["checks"]][] = [
      [[r("check", false)], [r(red, false), r(blue, false)]],
      [[r(red, false), r(blue, false)], [r("check", false)]],
    ];
    for (const [before, after] of cases) {
      expect(compareGates(base(before), base(after)).map((c) => [c.verdict, c.blocking])).toEqual(
        after.map(() => ["new_failure", true]),
      );
    }
  });

  test("setup failure after change is blocking", () => {
    const after: GateRun = { setupOk: false, setup: [r("setup", false)], checks: [] };
    expect(compareGates({ setupOk: true, setup: [r("setup", true)], checks: [] }, after)[0]?.blocking).toBe(
      true,
    );
  });
});

describe("failure excerpts", () => {
  test("extracts real FORCE_COLOR Bun failures across passing and skipped results", async () => {
    const dir = tempDir({
      "colored.test.ts": `import { test, expect } from "bun:test";
test("first assertion", () => { expect({ value: "received-one" }).toEqual({ value: "expected-one" }); });
test("passing boundary", () => { console.error("passing noise"); });
test.skip("skipped boundary", () => {});
test("second assertion", () => { expect({ value: "received-two" }).toEqual({ value: "expected-two" }); });`,
    });
    try {
      const result = await sh([process.execPath, "test", "./colored.test.ts"], {
        cwd: dir,
        env: proc.agentEnv({ FORCE_COLOR: "1", NO_COLOR: "0" }),
        timeoutMs: 10_000,
        allowFail: true,
      });
      expect(result.exitCode).toBe(1);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain("\u001b[");
      expect(output).toContain("✗");
      expect(output).toContain("✓");
      expect(output).toContain("»");
      const excerpt = extractFailures(output);
      expect(excerpt?.match(/✗/g)).toHaveLength(2);
      expect(excerpt).toContain("✗ first assertion");
      expect(excerpt).toContain("✗ second assertion");
      for (const name of ["one", "two"]) {
        expect(excerpt).toContain(`expected-${name}`);
        expect(excerpt).toContain(`received-${name}`);
      }
      expect(excerpt).toContain("error: expect(received).toEqual(expected)");
      expect(excerpt?.split("\n")).not.toContain("passing noise");
      expect(excerpt).not.toContain("\u001b");
      const skip = output.split("\n").find((line) => line.includes("»"));
      if (!skip) throw new Error("missing colored skip result");
      expect(extractFailures(`skip noise\n${skip}\nerror: next\n(fail) next`)).toBe(
        "error: next\n(fail) next",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each(["", "next.test.ts:\n", "✓ passed\n", "» skipped\n"])(
    "keeps trailing timeout diagnostics before %j with the timed-out failure",
    (boundary) => {
      const timeout = "  ^ this test timed out after 25ms.";
      const output = `(fail) timeout-a [25.01ms]\n${timeout}\n${boundary}error: next\n(fail) next`;
      expect(extractFailures(output)).toBe(
        `(fail) timeout-a [25.01ms]\n${timeout}\n\nerror: next\n(fail) next`,
      );
      expect(extractFailures(`✗ timeout-a\n${timeout}\nnext.test.ts:`)).toBe(`✗ timeout-a\n${timeout}`);
    },
  );

  test("reports left-out failures when no failure identity fits the budget", () => {
    const output = Array.from(
      { length: 12 },
      (_, i) => `error: reason ${i}\n(fail) failure-${i}-${"n".repeat(9_000)}`,
    ).join("\n");
    expect(extractFailures(output)).toBe("[failure excerpts: diagnostic lines or failures left out]");
    expect(extractFailures("(pass) fine\n")).toBeUndefined();
  });

  test("strips ANSI and stops at bun results and file headers", () => {
    const output =
      "old diagnostics\n(pass) earlier\nerror: first\n\u001b[31m(fail) one\u001b[0m\r\n" +
      "discard me\npath with spaces/new.test.ts:\n\u001b[31merror: second\u001b[0m\nExpected: yes\nReceived: no\n(fail) two\n";
    expect(extractFailures(output)).toBe(
      "error: first\n(fail) one\n\nerror: second\nExpected: yes\nReceived: no\n(fail) two",
    );
  });

  test("recognizes indented TAP failures and preceding TAP results", () => {
    expect(
      extractFailures(
        "unrelated\n  ok 1 - passed\n  error: broken\n  \u001b[31mnot ok 2 - failed\u001b[0m\n",
      ),
    ).toBe("error: broken\n  not ok 2 - failed");
    expect(extractFailures("ok 1 - passed\nno failures")).toBeUndefined();
  });

  test("forty-five 1 MiB lines keep failure excerpt retention bounded", () => {
    const collector = new FailureExcerpts();
    // Inspect retained data, since a final excerpt cap alone does not bound live memory.
    const retained = collector as unknown as { lines: string[] };
    for (let i = 0; i < 45; i++) {
      collector.observe(`${i}: ${"x".repeat(1_048_576)}`);
      expect(retained.lines.length).toBeLessThanOrEqual(39);
      expect(retained.lines.every((line) => line.length <= 8_000)).toBe(true);
      expect(retained.lines.reduce((size, line) => size + line.length, 0)).toBeLessThanOrEqual(39 * 8_000);
    }
    collector.observe("(fail) bounded diagnostics");
    const result = collector.result();
    expect(result?.length).toBeLessThanOrEqual(8_000);
    expect(result).toContain("(fail) bounded diagnostics");
    expect(result).toContain("left out");
  });

  test("caps diagnostic lines and keeps the failure line with an omission note", () => {
    const excerpt = extractFailures(
      `sample.test.ts:\n${Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")}\n(fail) last`,
    );
    expect(excerpt).not.toContain("line 10\n");
    expect(excerpt).toContain("line 11\n");
    expect(excerpt?.split("\n\n")[0]?.split("\n")).toHaveLength(40);
    expect(excerpt).toContain("(fail) last");
    expect(excerpt).toContain("left out");
    const timeout = extractFailures(
      `${Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")}\n(fail) timeout\n  ^ this test timed out after 25ms.\nnext.test.ts:`,
    );
    expect(timeout?.split("\n\n")[0]?.split("\n")).toHaveLength(40);
    expect(timeout).toContain("(fail) timeout\n  ^ this test timed out after 25ms.");
    expect(timeout).toContain("left out");
  });

  test("keeps the first ten failures and notes omitted failures", () => {
    const excerpt = extractFailures(
      Array.from({ length: 12 }, (_, i) => `error: ${i}\n(fail) test ${i}`).join("\n"),
    );
    expect(excerpt?.match(/\(fail\)/g)).toHaveLength(10);
    expect(excerpt).toContain("error: 0\n(fail) test 0");
    expect(excerpt).toContain("error: 9\n(fail) test 9");
    expect(excerpt).not.toContain("test 10");
    expect(excerpt).toContain("left out");
  });

  test("caps total characters and notes omitted diagnostics", () => {
    const excerpt = extractFailures(`error: first\n(fail) first\n${"x".repeat(9_000)}\n(fail) second`);
    expect(excerpt?.length).toBeLessThanOrEqual(8_000);
    expect(excerpt).toContain("error: first\n(fail) first");
    expect(excerpt).toContain("(fail) second");
    expect(excerpt).toContain("left out");
  });

  test.each(["(fail) named-bun", "not ok 1 - named-tap"])(
    "reserves the identity when clipping an overlong diagnostic before %s",
    (result) => {
      const excerpt = extractFailures(`error: reason\n${"x".repeat(9_000)}\n${result}`);
      expect(excerpt).toContain("error: reason");
      expect(excerpt).toContain(result);
      expect(excerpt?.length).toBeLessThanOrEqual(8_000);
      expect(excerpt?.split("\n\n")[0]?.split("\n").length).toBeLessThanOrEqual(40);
      expect(excerpt).toContain("left out");
    },
  );

  test.each([3_000, 9_000])("shortening to %i keeps every identity and the timeout explanation", (limit) => {
    const timeout = "  ^ this test timed out after 25ms.";
    const failures = extractFailures(
      `error: first\n(fail) first\nerror: reason\n${"x".repeat(9_000)}\n✗ second\n${timeout}`,
    );
    const output = formatGateOutput({ output: "summary\n".repeat(800), failures }, limit);
    expect(output).toContain("(fail) first");
    expect(output).toContain(`✗ second\n${timeout}`);
    expect(output.indexOf("(fail) first")).toBeLessThan(output.indexOf("✗ second"));
    expect(output.indexOf("✗ second")).toBeLessThan(output.indexOf("summary"));
    expect(output).toContain("left out");
    expect(output.length).toBeLessThanOrEqual(limit);
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

  test.each([
    ["start", "finish", "ship", "start", "ship", "finish"],
    ["ship", "start", "finish", "finish", "start", "ship"],
  ] as GatePriority[][])("slots order classes and preserve FIFO: %j", async (...priorities) => {
    const slots = new Semaphore(1);
    const release = await slots.acquire(signal, undefined, "held");
    const admitted: number[] = [];
    const waiting = priorities.map((priority, i) =>
      slots.acquire(signal, undefined, String(i), false, priority).then((free) => {
        admitted.push(i);
        return free;
      }),
    );
    expect(slots.snapshot().holders).toEqual(["held"]);
    slots.setLimit(3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const expected = ["ship", "finish", "start"].flatMap((p) =>
      priorities.flatMap((priority, i) => (priority === p ? [i] : [])),
    );
    expect(admitted).toEqual(expected.slice(0, 2));
    const releases: (() => void)[] = [];
    for (const i of expected.slice(0, 2)) {
      const pending = waiting[i];
      if (!pending) throw new Error("missing queued waiter");
      releases.push(await pending);
    }
    slots.setLimit(1);
    for (const free of releases) free();
    expect(slots.snapshot().holders).toEqual(["held"]);
    release();
    release();
    for (const i of expected.slice(2)) {
      const pending = waiting[i];
      if (!pending) throw new Error("missing queued waiter");
      (await pending)();
    }
    expect(admitted).toEqual(expected);
    expect(slots.snapshot().occupied).toBe(0);
  });

  test.each(["ship", "finish", "start"] as const)("cancel removes a queued %s waiter", async (priority) => {
    const slots = new Semaphore(1);
    const release = await slots.acquire(signal);
    const cancel = new AbortController();
    const queued = slots.acquire(cancel.signal, undefined, "cancelled", false, priority);
    const start = slots.acquire(signal, undefined, "start", false, "start");
    const finish = slots.acquire(signal, undefined, "finish", false, "finish");
    const ship = slots.acquire(signal, undefined, "ship", false, "ship");
    cancel.abort();
    await expect(queued).rejects.toThrow();
    release();
    for (const [name, pending] of [
      ["ship", ship],
      ["finish", finish],
      ["start", start],
    ] as const) {
      const free = await pending;
      expect(slots.snapshot().holders).toEqual([name]);
      free();
    }
    expect(slots.snapshot().occupied).toBe(0);
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

describe("scratch output audit warnings", () => {
  test.each([
    ["A", ".tmp-gate/report.xml", true],
    ["A", ".github/workflows/x.yml", false],
    ["A", ".github/dependabot.yml", false],
    ["A", "ordinary.txt", false],
    ["A", ".rootfile", false],
    ["A", "src/.cache/report.xml", false],
    ["M", ".tmp-gate/report.xml", false],
    ["D", ".tmp-gate/report.xml", false],
    ["R100", ".tmp-gate/report.xml", false],
  ])("hidden directory rule: %s %s", (status, path, warns) => {
    const findings = auditDiff(diff("", [{ status, path }]), { taskClass: null, protectedPaths: [] });
    expect(findings.filter((f) => f.rule === "root-hidden-addition")).toEqual(
      warns ? [expect.objectContaining({ severity: "warn", file: path })] : [],
    );
    if (warns) {
      expect(findings[0]?.detail).toContain("scratch/TMPDIR");
      expect(findings[0]?.detail).toContain("Intentional additions may remain");
    }
  });

  test("established hidden directories exempt only the hidden-directory warning", () => {
    const path = ".config/report.txt";
    const findings = auditDiff(
      {
        ...diff("", [{ status: "A", path }]),
        baseHiddenDirs: [".config"],
        headTextPaths: [path],
        headTextSizes: { [path]: 102_401 },
      },
      { taskClass: null, protectedPaths: [] },
    );
    expect(findings.map((f) => f.rule)).toEqual(["large-text-addition"]);
  });

  test("terminal formatting is normalized before private filenames and details are redacted", () => {
    const privateValue = ["secret", "host.example"].join("-");
    const configDir = tempDir({ "private-strings.txt": privateValue });
    try {
      const path = `.tmp-gate/secret-${String.fromCharCode(27)}[31mhost.example.txt`;
      const findings = auditDiff(
        { ...diff("", [{ status: "A", path }]), binaryPaths: [path] },
        {
          configDir,
          taskClass: null,
          protectedPaths: [],
        },
      );
      expect(findings.filter((f) => f.rule === "root-hidden-addition")).toEqual([
        expect.objectContaining({
          rule: "root-hidden-addition",
          severity: "warn",
          file: "[redacted filename]",
        }),
      ]);
      expect(findings.find((f) => f.rule === "binary-content")?.detail).toContain("[redacted]");
      expect(JSON.stringify(findings)).not.toContain(privateValue);
      expect(formatAuditFeedback(findings)).toContain("[redacted filename]");
      expect(formatAuditFeedback(findings)).not.toContain(privateValue);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test.each([
    ["below", "a", 102_399, true, "A", false],
    ["exact", "a", 102_400, true, "A", false],
    ["above", "a", 102_401, true, "A", true],
    ["multibyte exact", "é", 51_200, true, "A", false],
    ["multibyte above", "é", 51_201, true, "A", true],
    ["binary", "a\0", 60_000, false, "A", false],
    ["modified", "a", 102_401, true, "M", false],
  ])("text size rule: %s", (_label, unit, count, text, status, warns) => {
    const content = unit.repeat(count);
    const info = {
      ...diff("", [{ status, path: "report.data" }]),
      headTextPaths: text ? ["report.data"] : [],
      headTextSizes: { "report.data": Buffer.byteLength(content, "utf8") },
    };
    const findings = auditDiff(info, { taskClass: null, protectedPaths: [] });
    expect(findings.filter((f) => f.rule === "large-text-addition")).toEqual(
      warns ? [expect.objectContaining({ severity: "warn", file: "report.data" })] : [],
    );
    expect(formatAuditFeedback(findings)).toBe("");
  });
});

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
  test("base64 matches protected UTF-8 values in padded, unpadded and surrounding text runs", () => {
    const value = ["synthetic", "é", "credential"].join("-");
    const entries = [{ value, entry: 3 }];
    for (const text of [value, `prefix:${value}:suffix`]) {
      const encoded = Buffer.from(text).toString("base64");
      for (const run of [encoded, encoded.replace(/=+$/, "")]) {
        expect(privateMatches(`payload: ${run}`, entries)).toEqual(entries);
        expect(privateMatches(`logs/${run}.txt`, entries)).toEqual(entries);
        expect(() => checkPrivateText(run, "body", entries)).toThrow("entry 3");
        expect(redactPrivate(run, entries)).toBe("[redacted diagnostic]");
      }
    }
    const encoded = Buffer.from(value).toString("base64");
    // Runs whose bytes still hold the whole value are withheld even with stray padding or a binary prefix.
    for (const run of [
      `${encoded}==`,
      Buffer.concat([Buffer.from([255]), Buffer.from(value)]).toString("base64"),
    ])
      expect(privateMatches(run, entries)).toEqual(entries);
    for (const run of [encoded.slice(0, -4), encoded.toLowerCase(), "YQ==", "abcd!"]) {
      expect(privateMatches(run, entries)).toEqual([]);
      expect(() => checkPrivateText(run, "body", entries)).not.toThrow();
    }
    let unrelated = "ordinary unrelated text";
    for (let round = 0; round < 8; round++) unrelated = Buffer.from(unrelated).toString("base64");
    expect(privateMatches(unrelated, entries)).toEqual([]);
    expect(privateMatches(Buffer.from(value).toString("base64"), [])).toEqual([]);
    const wide = "Ａ".repeat(4);
    const policy = [{ value: wide, entry: 7 }];
    expect(privateMatches(Buffer.from(wide).toString("base64"), policy)).toEqual(policy);
    // Its ASCII normalization is shorter than the protected value's UTF-8 eligibility floor.
    expect(privateMatches(Buffer.from("AAAA").toString("base64"), policy)).toEqual([]);
    // Padding does not supply bytes toward that floor either.
    expect(privateMatches(Buffer.from("A").toString("base64"), [{ value: "Ａ", entry: 7 }])).toEqual([]);
  });

  test("base64 whose alphabet slash follows a directory prefix still matches", () => {
    // One of three "?" bytes always ends a base64 group as "/".
    const value = ["synthetic", "slashed", "credential???"].join("-");
    const entries = [{ value, entry: 4 }];
    const encoded = Buffer.from(value).toString("base64");
    expect(encoded).toContain("/");
    for (const run of [encoded, encoded.replace(/=+$/, "")]) {
      for (const text of [`notes/${run}.txt`, `a/b/${run}`, `dir/${run}/more.txt`, `x/${run}/y/z`])
        expect(privateMatches(text, entries)).toEqual(entries);
      expect(privateMatches(`notes/${run.slice(0, -4)}.txt`, entries)).toEqual([]);
    }
    proc.registerCredential("audit-slashed-base64-test", value);
    const path = `vendor/${encoded}`;
    const findings = auditDiff(
      { ...diff("", [{ status: "A", path }]), gitlinks: [path] },
      { taskClass: null, protectedPaths: [] },
    );
    expect(findings.find((f) => f.rule === "gitlink")).toMatchObject({ file: "[redacted filename]" });
    for (const part of [value, ...encoded.split("/").filter((part) => part.length >= 8)])
      expect(JSON.stringify(findings)).not.toContain(part);
  });

  test.each(["percent", "HTML", "base64", "unpadded base64"])(
    "every audit rule withholds %s filenames and detail references before literal redaction",
    (encoding) => {
      const credential = ["synthetic", "audit", "credential"].join("-");
      const privateValue = ["private", "audit", "entry"].join("-");
      proc.registerCredential("audit-encoded-test", credential);
      const configDir = tempDir({ "private-strings.txt": privateValue });
      try {
        for (const value of [credential, privateValue]) {
          const encoded =
            encoding === "percent"
              ? Array.from(value, (c) => `%${c.charCodeAt(0).toString(16)}`).join("")
              : encoding === "HTML"
                ? Array.from(value, (c) => `&#${c.charCodeAt(0)};`).join("")
                : Buffer.from(value)
                    .toString("base64")
                    .replace(encoding === "base64" ? /$/ : /=+$/, "");
          const path = `vendor-${encoded}`;
          const findings = auditDiff(
            { ...diff("", [{ status: "A", path }]), gitlinks: [path] },
            {
              configDir,
              taskClass: null,
              protectedPaths: [],
              toolCommands: [`git commit --no-verify -m '${value} ${encoded}'`],
            },
          );
          expect(findings.find((f) => f.rule === "gitlink")).toEqual({
            rule: "gitlink",
            severity: "block",
            file: "[redacted filename]",
            detail: "[redacted diagnostic]",
          });
          expect(JSON.stringify(findings)).not.toContain(encoded);
          expect(findings.find((f) => f.rule === "no-verify")?.detail).toBe("[redacted diagnostic]");
        }
        const path = `vendor-${String.fromCharCode(27)}[31mclean`;
        expect(
          auditDiff(
            { ...diff("", [{ status: "A", path }]), gitlinks: [path] },
            { configDir, taskClass: null, protectedPaths: [] },
          ).find((f) => f.rule === "gitlink"),
        ).toMatchObject({ file: "vendor-clean", detail: expect.stringContaining("vendor-clean") });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    },
  );

  test("audit preserves raw decoding-limit refusals when literal redaction breaks an escape", () => {
    const repeated = "25".repeat(6);
    proc.registerCredential("audit-decoding-limit-test", repeated);
    const findings = auditDiff(diff("", []), {
      taskClass: "question",
      protectedPaths: [],
      toolCommands: [`git commit --no-verify -m '%${repeated}72'`],
    });
    expect(findings.find((f) => f.rule === "no-verify")?.detail).toBe("[redacted diagnostic]");
  });

  test("audit withholds an encoded credential that another credential's literal redaction breaks", () => {
    const credential = ["synthetic", "nested", "credential"].join("-");
    const encoded = Buffer.from(credential).toString("base64");
    proc.registerCredential("audit-nested-outer-test", credential);
    proc.registerCredential("audit-nested-inner-test", encoded.slice(0, 12));
    const findings = auditDiff(diff("", []), {
      taskClass: "question",
      protectedPaths: [],
      toolCommands: [
        `git commit --no-verify -m ${encoded}`,
        `git commit --no-verify -m '${credential}' # literal`,
      ],
    });
    expect(findings.filter((f) => f.rule === "no-verify").map((f) => f.detail)).toEqual([
      "[redacted diagnostic]",
      "Agent ran a command with --no-verify: git commit --no-verify -m '[redacted]' # literal",
    ]);
  });

  test("audit withholds a base64 encoding that contains its own credential literally", () => {
    // Repeated base64 converges on a prefix that its own encoding begins with.
    let seed = "synthetic-self-encoding";
    for (let round = 0; round < 24; round++) seed = Buffer.from(seed).toString("base64");
    const credential = seed.slice(0, 16);
    const encoded = Buffer.from(credential).toString("base64");
    expect(encoded.startsWith(credential)).toBe(true);
    proc.registerCredential("audit-self-encoding-test", credential);
    const findings = auditDiff(diff("", []), {
      taskClass: "question",
      protectedPaths: [],
      toolCommands: [
        `git commit --no-verify -m ${encoded}`,
        `git commit --no-verify -m '${credential}' # literal`,
      ],
    });
    expect(findings.filter((f) => f.rule === "no-verify").map((f) => f.detail)).toEqual([
      "[redacted diagnostic]",
      "Agent ran a command with --no-verify: git commit --no-verify -m '[redacted]' # literal",
    ]);
  });

  test("base64 matching stays linear on slash-heavy runs", () => {
    const value = ["synthetic", "slash", "run"].join("-");
    const run = `${"/".repeat(200_000)}${Buffer.from(value).toString("base64")}`;
    const started = performance.now();
    expect(privateMatches(run, [{ value, entry: 2 }])).toEqual([{ value, entry: 2 }]);
    expect(privateMatches(`${"/".repeat(200_000)}YWJjZA==`, [{ value, entry: 2 }])).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test.each(truncationEncodings)("protects every clipped %s escape boundary", (_name, encode) => {
    const entries = [{ value: "private-prospect.example", entry: 3 }];
    const text = encode(entries[0]?.value ?? "");
    // Include every cutoff after the first complete encoded character, including partial escapes.
    for (let cut = encode("p").length; cut < text.length; cut++)
      expect(privateMatches(`Public: ${text.slice(0, cut)}`, entries, true)).toEqual(entries);
    expect(privateMatches("Public: ＰＲＩＶＡＴＥ-pro", entries, true)).toEqual(entries);
    expect(privateMatches("Public: private-pro", entries)).toEqual([]);
    expect(privateMatches("Public: private-pro unrelated", entries, true)).toEqual([]);
  });

  test.each([
    ["double URL", "%2573ecret-host.example"],
    ["Unicode-escaped percent", "\\u002573ecret-host.example"],
    ["URL of Unicode", "%5Cu0073ecret-host.example"],
    ["alternating layers", "%5Cu002573ecret-host.example"],
  ])("blocks %s encoding in publication and diagnostics", (_kind, text) => {
    const entries = [{ value: "secret-host.example", entry: 3 }];
    expect(privateMatches(text, entries)).toEqual(entries);
    expect(() => checkPrivateText(text, "body", entries)).toThrow("entry 3");
    expect(redactPrivate(text, entries)).toBe("[redacted diagnostic]");
  });

  test("private decoding fails closed at the round bound even without denylist entries", () => {
    const entries = [{ value: "secret-host.example", entry: 3 }];
    let nested = "%61 harmless";
    for (let i = 0; i < 3; i++) nested = encodeURIComponent(nested);
    expect(privateMatches(nested, entries)).toEqual([]);
    expect(redactPrivate(nested, entries)).toBe(nested);
    nested = encodeURIComponent(nested);
    for (const policy of [entries, []]) {
      expect(privateMatches(nested, policy)).toHaveLength(1);
      expect(() => checkPrivateText(nested, "body", policy)).toThrow("decoding limit");
      expect(redactPrivate(nested, policy)).toBe("[redacted diagnostic]");
    }
    for (let i = 0; i < 3; i++) nested = encodeURIComponent(nested);
    expect(() => checkPrivateText(nested, "body", [])).toThrow("decoding limit");
  });

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

  // Only the inert image formats may name a rule that matches no files yet; git-integrity covers Git's side.
  test.each([
    ["*.png -diff", "warn"],
    ["*.woff2 -diff", "block"],
    ["*.mp4 -diff", "block"],
    ["*.pdf binary", "block"],
    ["*.bmp -diff", "block"],
    ["*.psd -diff", "block"],
    ["*.eot -diff", "block"],
    ["*.glb -diff", "block"],
    ["*.unknown -diff", "block"],
  ])("an unmatched rule %s produces a %s", (line, severity) => {
    const patch = `diff --git a/.gitattributes b/.gitattributes\n+++ b/.gitattributes\n+${line}`;
    const keys = attributeRules(patch).map((rule) => rule.key);
    expect(keys).toHaveLength(1);
    const unmatched = {
      ...diff(patch, [{ status: "A", path: ".gitattributes" }]),
      attributePatch: patch,
      attributeMatches: Object.fromEntries(keys.map((key) => [key, []])),
      attributeUnmatched: keys,
    };
    expect(auditDiff(unmatched, { taskClass: null, protectedPaths: [] })).toEqual([
      expect.objectContaining({
        rule: "gitattributes",
        severity,
        file: ".gitattributes",
        detail: expect.stringContaining(line.split(" ")[0] ?? ""),
      }),
    ]);
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

test.each(["baseline", "regression"])("standalone %s retries own scratch per check", async (kind) => {
  const cwd = tempDir({});
  const signal = new AbortController().signal;
  const cfg: GateConfig = {
    setup: [],
    source: "none",
    protectedPaths: [],
    checks: ["first", "second"].map((name) => ({
      name,
      run: 'if test -f "$HOME/marker"; then echo true; else echo false; fi; touch "$HOME/marker"',
    })),
  };
  const failed: GateRun = {
    setupOk: true,
    setup: [],
    checks: cfg.checks.map((c) => ({
      name: c.name,
      command: c.run,
      ok: false,
      exitCode: 1,
      durationMs: 0,
      output: "transient",
    })),
  };
  try {
    const checks =
      kind === "baseline"
        ? (await retryBaselineFailures(failed, cwd, cfg, signal)).checks
        : (
            await retryRegressions(
              compareGates({ ...failed, checks: failed.checks.map((r) => ({ ...r, ok: true })) }, failed),
              cwd,
              cfg,
              [],
              signal,
            )
          ).map((c) => c.result);
    expect(checks.map((r) => r.output)).toEqual(["false", "false"]);
    expect(checks.every((r) => r.ok)).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

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
      if (opts.cmd.some((arg) => arg.includes('head -c 1 "$1"')))
        return {
          exitCode: 1,
          stdout: "",
          stderr: "head: Operation not permitted",
          signal: null,
          cancelled: false,
          timedOut: false,
          idleTimedOut: false,
          truncated: false,
          durationMs: 1,
        };
      const signalProbe = opts.cmd[0] === "/bin/sh";
      const probing = signalProbe || opts.cmd.at(-1)?.endsWith("/denied");
      if (probing) {
        probes++;
        if (!signalProbe) writeFileSync(opts.cmd.at(-2) ?? "", "ok");
      } else launches++;
      return {
        exitCode: probing ? 0 : 71,
        stdout: signalProbe ? "signals-verified" : probing ? "verified" : "",
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
      expect(probes).toBe(2);
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
      if (opts.cmd.some((arg) => arg.includes('head -c 1 "$1"')))
        return {
          exitCode: 1,
          stdout: "",
          stderr: "head: Operation not permitted",
          signal: null,
          cancelled: false,
          timedOut: false,
          idleTimedOut: false,
          truncated: false,
          durationMs: 1,
        };
      if (opts.cmd.at(-1)?.endsWith("/denied")) {
        writeFileSync(opts.cmd.at(-2) ?? "", "ok");
      } else if (opts.cmd[0] !== "/bin/sh") {
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
        stdout:
          opts.cmd[0] === "/bin/sh"
            ? "signals-verified"
            : opts.cmd.at(-1)?.endsWith("/denied")
              ? "verified"
              : "",
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
    const credential = "sandbox_apply: Operation not permitted synthetic-confinement-409";
    proc.registerCredential("CONFINEMENT_DIAGNOSTIC_TEST_TOKEN", credential);
    const cwd = tempDir({ "credential.txt": `credential: ${credential}\n` });
    try {
      const cfg: GateConfig = {
        setup: [],
        source: "detected",
        protectedPaths: [],
        checks: [
          {
            name: "nested",
            run: `cat credential.txt; printf '%${padding}s' ''; cat credential.txt; exit 1`,
          },
        ],
      };
      const signal = new AbortController().signal;
      const baseline = await runGates(cwd, cfg, signal);
      expect(baseline.checks[0]?.output).toContain("credential: [redacted]");
      expect(baseline.checks[0]?.output).not.toContain(credential);
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
  test(`output-only confinement results distinguish candidate and baseline through retries (${padding} bytes)`, async () => {
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
    for (const [baseline, after, verdict, blocking] of [
      [failed, failed, "confinement_error", true],
      [run(passed), failed, "confinement_error", true],
      [failed, run(passed), "new_pass", false],
      [run(passed), recovered, "confinement_error", true],
      [failed, recovered, "confinement_error", true],
      [recovered, run(passed), "new_pass", false],
    ] as const) {
      const cmp = compareGates(baseline, after);
      expect(cmp[0]).toMatchObject({ verdict, blocking });
      expect(await retryRegressions(cmp, "/nonexistent", cfg, [], signal)).toBe(cmp);
      if (blocking) expect(formatGateFeedback(cmp)).toContain("CONFINEMENT ERROR (sandbox launch failed)");
      else expect(formatGateFeedback(cmp)).toBe("");
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

test("signal confinement covers setup, checks and baseline/regression retries; failure never becomes a pass", async () => {
  const cwd = tempDir({});
  const { backend, calls } = recordingConfinement();
  const signal = new AbortController().signal;
  const cfg: GateConfig = {
    setup: ["echo setup"],
    checks: [{ name: "test", run: "test -f passed" }],
    source: "none",
    protectedPaths: [],
  };
  try {
    await sandbox.confinementScope.run(backend, async () => {
      const baseline = await productionGates(cwd, cfg, signal);
      expect(baseline.checks[0]?.ok).toBe(false);
      writeFileSync(join(cwd, "passed"), "ok");
      const retry = await productionBaselineRetry(baseline, cwd, cfg, signal);
      expect(retry.checks[0]?.ok).toBe(true);
      expect(calls.map((call) => call.opts.cmd.at(-1))).toEqual([
        "echo setup",
        "test -f passed",
        "test -f passed",
      ]);
      const compare = compareGates(retry, baseline);
      backend.verify = async () => {
        throw new ConfinementError("Signal confinement not verified");
      };
      await expect(productionRetry(compare, cwd, cfg, [], signal)).rejects.toThrow("Signal confinement");
      await expect(productionBaselineRetry(baseline, cwd, cfg, signal)).rejects.toThrow("Signal confinement");
      await expect(productionGates(cwd, cfg, signal)).rejects.toThrow("Signal confinement");
      expect(calls).toHaveLength(3);
    });
    for (const diagnostic of ["sandbox_apply: Operation not permitted"]) {
      const failed: GateRun = {
        setupOk: true,
        setup: [],
        checks: [
          {
            name: "test",
            command: "test -f passed",
            ok: false,
            exitCode: 1,
            durationMs: 1,
            output: diagnostic,
          },
        ],
      };
      expect(compareGates(failed, failed)[0]).toMatchObject({ verdict: "confinement_error", blocking: true });
      expect(await productionBaselineRetry(failed, cwd, cfg, signal)).toBe(failed);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("passing checks can print sandbox research and caught signal-probe errors", async () => {
  const cwd = tempDir({});
  try {
    const result = await runGates(
      cwd,
      {
        source: "none",
        setup: [],
        protectedPaths: [],
        checks: [
          {
            name: "diagnostics",
            run: 'echo "warn: sandbox initialization failed, retrying"; echo "Signal confinement not verified"; exit 0',
          },
        ],
      },
      new AbortController().signal,
    );
    expect(result.checks[0]?.ok).toBe(true);
    expect(result.checks[0]?.confinementError).toBeFalsy();
    expect(compareGates(null, result)[0]).toMatchObject({ verdict: "new_pass", blocking: false });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

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

test("private policy skips only git's own transient worktree states", () => {
  const root = mkdtempSync(join(tmpdir(), "private-linked-"));
  const config = join(root, "config");
  const repo = join(root, "repo");
  const admin = join(repo, ".git", "worktrees");
  const entry = (name: string) => join(admin, name);
  const load = () => loadPrivateStrings(config, [repo]);
  const reset = () => {
    rmSync(admin, { recursive: true, force: true });
    mkdirSync(admin, { recursive: true });
  };
  mkdirSync(config);
  writeFileSync(join(config, "private-strings.txt"), "secret-host.example\n");
  try {
    // git creates the entry (and its "initializing" lock) before writing gitdir, removes gitdir
    // before the entry, and truncates gitdir before writing it.
    reset();
    mkdirSync(entry("adding"));
    expect(load()).toHaveLength(1);
    const lock = join(entry("adding"), "locked");
    writeFileSync(lock, "initializing\n");
    writeFileSync(join(entry("adding"), "gitdir"), "");
    expect(load()).toHaveLength(1);
    // Only git's own add lock counts: not a lock reason, not a symlink to that text, not no lock
    // (`worktree move` rewrites gitdir).
    writeFileSync(lock, "busy\n");
    expect(load).toThrow("Cannot read");
    rmSync(lock);
    writeFileSync(join(root, "marker"), "initializing\n");
    symlinkSync(join(root, "marker"), lock);
    expect(load).toThrow("Cannot read");
    rmSync(lock);
    expect(load).toThrow("Cannot read");
    // A complete entry holding a config blocks, also when git wrote the path relative to the entry
    // (a named holder, so resolving it against the process's cwd can't land on an ancestor).
    const held = join(root, "holder", "config");
    mkdirSync(held, { recursive: true });
    writeFileSync(join(held, "private-strings.txt"), "secret-host.example\n");
    for (const target of [join(root, "holder", ".git"), "../../../../holder/.git"]) {
      reset();
      mkdirSync(entry("holder"));
      writeFileSync(join(entry("holder"), "gitdir"), `${target}\n`);
      expect(() => loadPrivateStrings(held, [repo])).toThrow("inside repository");
    }
    // From a linked checkout whose .git file and commondir are relative, the scan still finds the holder.
    mkdirSync(join(root, "wt"));
    writeFileSync(join(root, "wt", ".git"), "gitdir: ../repo/.git/worktrees/wt\n");
    mkdirSync(entry("wt"));
    writeFileSync(join(entry("wt"), "commondir"), "../..\n");
    writeFileSync(join(entry("wt"), "gitdir"), `${join(root, "wt", ".git")}\n`);
    expect(() => loadPrivateStrings(held, [join(root, "wt")])).toThrow("inside repository");
    // A partly written gitdir naming the filesystem root contains everything.
    writeFileSync(join(entry("holder"), "gitdir"), "/\n");
    expect(load).toThrow("inside repository");
    // A dangling symlink is not an absent entry: gitdir, the entry and the worktrees directory.
    reset();
    mkdirSync(entry("linked"));
    symlinkSync(join(root, "gone"), join(entry("linked"), "gitdir"));
    expect(load).toThrow("Cannot read");
    reset();
    symlinkSync(join(root, "gone"), entry("linked"));
    expect(load).toThrow("Cannot read");
    rmSync(admin, { recursive: true });
    symlinkSync(join(root, "gone"), admin);
    expect(load).toThrow("Cannot read");
    // Any other unreadable gitdir blocks too.
    reset();
    mkdirSync(join(entry("broken"), "gitdir"), { recursive: true });
    expect(load).toThrow("Cannot read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private policy rechecks from scratch when a path vanishes mid-check and reads only what it checked", () => {
  const root = mkdtempSync(join(tmpdir(), "private-race-"));
  const repo = join(root, "repo");
  const admin = join(repo, ".git", "worktrees");
  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(join(repo, "config", "private-strings.txt"), "repo-controlled\n");
  const config = join(root, "config");
  mkdirSync(config);
  writeFileSync(join(config, "private-strings.txt"), "secret-host.example\n");
  const realpath = fs.realpathSync;
  const lstat = fs.lstatSync;
  const open = fs.openSync;
  const readFile = fs.readFileSync;
  try {
    // canonical() itself never substitutes a spelling for a path that vanished under it.
    const vanished = join(root, "vanished");
    mkdirSync(vanished);
    const unlinking = spyOn(fs, "realpathSync").mockImplementation(((path: string) => {
      if (path === vanished) rmSync(vanished, { recursive: true, force: true });
      return realpath(path);
    }) as typeof fs.realpathSync);
    try {
      expect(() => canonical(vanished)).toThrow("ENOENT");
    } finally {
      unlinking.mockRestore();
    }
    // Another run removes its worktree between canonicalization's lstat and realpath.
    const other = join(root, "other");
    mkdirSync(other);
    mkdirSync(join(admin, "other"), { recursive: true });
    writeFileSync(join(admin, "other", "gitdir"), `${join(other, ".git")}\n`);
    const removing = spyOn(fs, "realpathSync").mockImplementation(((path: string) => {
      if (path === other) rmSync(other, { recursive: true, force: true });
      return realpath(path);
    }) as typeof fs.realpathSync);
    try {
      expect(loadPrivateStrings(config, [repo])).toHaveLength(1);
      expect(removing.mock.calls.some(([path]) => path === other)).toBe(true);
    } finally {
      removing.mockRestore();
    }
    // A path that keeps vanishing blocks after three whole attempts.
    const spellings = new Set([
      join(config, "private-strings.txt"),
      join(realpath(config), "private-strings.txt"),
    ]);
    const vanishing = spyOn(fs, "realpathSync").mockImplementation(((path: string) => {
      if (spellings.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return realpath(path);
    }) as typeof fs.realpathSync);
    try {
      expect(() => loadPrivateStrings(config, [repo])).toThrow("Cannot read");
      expect(vanishing.mock.calls.filter(([path]) => spellings.has(String(path)))).toHaveLength(3);
    } finally {
      vanishing.mockRestore();
    }
    // A symlinked config is removed while it is canonicalized and restored before the read, so the
    // check sees an unresolved spelling while the read would land inside the repository. It is passed
    // through an alias of the temp root, so canonical()'s fallback spelling differs on every platform.
    const linked = join(root, "cfg");
    symlinkSync(join(repo, "config"), linked);
    symlinkSync(root, join(root, "alias"));
    const passed = join(root, "alias", "cfg");
    expect(() => loadPrivateStrings(passed, [repo])).toThrow("inside repository");
    // Removed at its first realpath; restored when the final lstat reaches the fallback spelling.
    const asPassed = join(passed, "private-strings.txt");
    const fallback = join(realpath(root), "cfg", "private-strings.txt");
    let removed = false;
    let restored = false;
    let openedFallback = false;
    const swapping = spyOn(fs, "realpathSync").mockImplementation(((path: string) => {
      if (path === asPassed && !removed) {
        removed = true;
        rmSync(linked);
      }
      return realpath(path);
    }) as typeof fs.realpathSync);
    const restoring = spyOn(fs, "lstatSync").mockImplementation(((path: string, options?: fs.StatOptions) => {
      if (path === fallback && removed && !restored) {
        restored = true;
        symlinkSync(join(repo, "config"), linked);
      }
      return lstat(path, options);
    }) as typeof fs.lstatSync);
    const watching = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: fs.OpenMode) => {
      if (path === fallback) openedFallback = true;
      return open(path, flags);
    }) as typeof fs.openSync);
    try {
      expect(() => loadPrivateStrings(passed, [repo])).toThrow("inside repository");
      // The descriptor check, not an earlier one, blocked it.
      expect({ removed, restored, openedFallback }).toEqual({
        removed: true,
        restored: true,
        openedFallback: true,
      });
    } finally {
      swapping.mockRestore();
      restoring.mockRestore();
      watching.mockRestore();
    }
    // A hard link to the repository's list can report the outside name, so a second link blocks.
    const hardened = join(root, "hard");
    mkdirSync(hardened);
    linkSync(join(repo, "config", "private-strings.txt"), join(hardened, "private-strings.txt"));
    expect(() => loadPrivateStrings(hardened, [repo])).toThrow("more than one hard link");
    rmSync(hardened, { recursive: true });
    // The config directory is swapped for a link into the repository after every check, just before
    // the file is opened (or, for a path-based check, read).
    const swapped = join(root, "swapped");
    mkdirSync(swapped);
    writeFileSync(join(swapped, "private-strings.txt"), "secret-host.example\n");
    const target = join(realpath(swapped), "private-strings.txt");
    let swappedAt = "";
    const swap = (at: string) => {
      swappedAt = at;
      rmSync(swapped, { recursive: true });
      symlinkSync(join(repo, "config"), swapped);
    };
    const opening = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, flags: fs.OpenMode) => {
      if (path === target && !swappedAt) swap("open");
      return open(path, flags);
    }) as typeof fs.openSync);
    const reading = spyOn(fs, "readFileSync").mockImplementation(((
      path: fs.PathOrFileDescriptor,
      options?: Parameters<typeof fs.readFileSync>[1],
    ) => {
      if (path === target && !swappedAt) swap("read");
      return options === undefined ? readFile(path) : readFile(path, options);
    }) as typeof fs.readFileSync);
    try {
      expect(() => loadPrivateStrings(swapped, [repo])).toThrow("inside repository");
      expect(swappedAt).toBe("open");
    } finally {
      opening.mockRestore();
      reading.mockRestore();
    }
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gate-lease-")));
  const cache = join(root, "cache");
  const work = join(root, "work");
  await sh(["git", "init", "-q", cache], { cwd: root });
  writeFileSync(join(cache, "README"), "fixture");
  await sh(["git", "add", "."], { cwd: cache });
  await sh(["git", "commit", "-qm", "fixture"], { cwd: cache });
  await sh(["git", "worktree", "add", "-q", "--detach", work], { cwd: cache });
  await recordWorktree(work);
  const previous = gateSlots.limit;
  gateSlots.setLimit(1);
  const id = await gateSlots.lease("deploy");
  const queued = Promise.withResolvers<void>();
  try {
    const run = runGates(
      work,
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
    rmSync(root, { recursive: true, force: true });
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
      fixture.work,
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
