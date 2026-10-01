import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ImplementCase } from "../src/evals/cases.ts";
import { formatEvalReport } from "../src/evals/format.ts";
import { gatesAt } from "../src/evals/prepare.ts";
import { runGates } from "../src/gates/run.ts";
import type { FakeReply } from "../src/harness/fake.ts";
import { formatAuditFeedback, formatGateFeedback, implementPrompt } from "../src/pipeline/prompts.ts";
import { SpecSchema } from "../src/pipeline/schemas.ts";
import { sh } from "../src/util/proc.ts";
import { evalMatrix } from "../ui/lib/evals.ts";
import { enableEfforts, evalFixture } from "./evals-support.ts";

// These tests drive real git and subprocesses; under CPU load they outlast Bun's 5 s default (#140).
setDefaultTimeout(30_000);

async function fixture(
  gate = "test ! -f broken",
  baseFiles: (home: string) => Record<string, string> = () => ({}),
  extraModels: Parameters<typeof evalFixture>[0] = [],
) {
  const f = await evalFixture(extraModels);
  await sh(["git", "checkout", "--detach", f.sha], { cwd: f.source });
  writeFileSync(
    join(f.source, ".limitless.toml"),
    `[gates]\nchecks = [{ name = "test", run = "${gate}" }]\n[policy]\nprotected_paths = ["protected"]\n`,
  );
  writeFileSync(join(f.source, "overwrite"), "original");
  writeFileSync(join(f.source, "protected"), "original");
  for (const [path, content] of Object.entries(baseFiles(f.home)))
    writeFileSync(join(f.source, path), content);
  await sh(["git", "add", "-A"], { cwd: f.source });
  await sh(["git", "commit", "-qm", "gates"], { cwd: f.source });
  const base = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
  writeFileSync(join(f.source, "solution"), "secret solution");
  await sh(["git", "add", "-A"], { cwd: f.source });
  await sh(["git", "commit", "-qm", "solution"], { cwd: f.source });
  const head = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
  await sh(["git", "push", f.cache, "HEAD:refs/heads/solution"], { cwd: f.source });
  const item: ImplementCase = {
    id: "one",
    repo: "fixture/repo",
    base,
    head,
    prompt: "Create answer containing correct",
    complexity: "small",
    spec: null,
    source: "fixture",
    tags: [],
    hidden: { files: ["hidden/check.sh", "overwrite"], command: "sh hidden/check.sh", timeoutSec: 5 },
  };
  const hiddenDir = join(f.home, "hidden", item.id);
  mkdirSync(join(hiddenDir, "hidden"), { recursive: true });
  writeFileSync(
    join(hiddenDir, "hidden/check.sh"),
    'test "$(cat answer)" = correct && test "$(cat overwrite)" = secret-hidden-overwrite\n',
  );
  writeFileSync(join(hiddenDir, "overwrite"), "secret-hidden-overwrite");
  const save = () =>
    writeFileSync(f.casePath, JSON.stringify({ role: "implement", version: 1, cases: [item] }));
  save();
  f.respond(() => ({ files: { answer: "correct" }, text: "Implemented", costUsd: 0.1 }));
  return {
    ...f,
    item,
    hiddenDir,
    save,
    run: (over: Record<string, unknown> = {}) =>
      f.run({ role: "implement", models: ["candidate-a"], k: 1, ...over }),
  };
}

async function pinBase(f: Awaited<ReturnType<typeof fixture>>) {
  await sh(["git", "add", "-A"], { cwd: f.source });
  await sh(["git", "commit", "-qm", "updated base"], { cwd: f.source });
  f.item.base = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
  await sh(["git", "push", f.cache, "HEAD:refs/heads/eval-base"], { cwd: f.source });
  f.save();
}

for (const failure of ["setup", "timeout"] as const)
  test(`baseline ${failure} fails preparation without invoking or caching a candidate`, async () => {
    const f = await fixture();
    try {
      writeFileSync(
        join(f.source, ".limitless.toml"),
        failure === "setup"
          ? '[gates]\nsetup = ["false"]\nchecks = [{ name = "test", run = "true" }]\n'
          : '[gates]\nchecks = [{ name = "test", run = "sleep 10", timeoutSec = 0.05 }]\n',
      );
      await pinBase(f);
      for (let run = 0; run < 2; run++) {
        const report = await f.run({ models: ["candidate-a", "candidate-b"], k: 2 });
        expect(report.trials).toHaveLength(4);
        for (const trial of report.trials) {
          expect(trial).toMatchObject({
            status: "error",
            pass: false,
            costUsd: 0,
            costEquivUsd: 0,
            tokensIn: 0,
            tokensOut: 0,
            details: { preparationFailed: true, grade: { implement: { reason: "error" } } },
          });
          expect(trial.details.reason).toContain(failure === "setup" ? "setup failed" : "check timed out");
          expect(trial.details.cache).toBeUndefined();
          expect(f.factory.store.cachedEvalTrials(trial.cacheKey)).toEqual([]);
        }
      }
      expect(f.calls).toHaveLength(0);
      expect(readdirSync(f.cfg.paths.runs).filter((p) => p.startsWith("eval-"))).toEqual([]);
    } finally {
      await f.close();
    }
  });

test("baseline gates are shared across repetitions and providers per case within each run", async () => {
  const f = await fixture("sh count-gates.sh", (home) => ({
    "count-gates.sh": `if test -f answer; then echo candidate >> '${home}/gate-runs'; else echo baseline >> '${home}/gate-runs'; fi\n`,
  }));
  try {
    const second = { ...f.item, id: "two" };
    cpSync(f.hiddenDir, join(f.home, "hidden", second.id), { recursive: true });
    writeFileSync(f.casePath, JSON.stringify({ role: "implement", version: 1, cases: [f.item, second] }));
    for (let run = 1; run <= 2; run++) {
      const report = await f.run({ models: ["candidate-a", "candidate-b"], k: 2, cache: false });
      expect(report.trials).toHaveLength(8);
      expect(report.trials.every((trial) => trial.pass)).toBe(true);
      const lines = readFileSync(join(f.home, "gate-runs"), "utf8").trim().split("\n");
      expect(lines.filter((line) => line === "baseline")).toHaveLength(2 * run);
      expect(lines.filter((line) => line === "candidate")).toHaveLength(8 * run);
    }
  } finally {
    await f.close();
  }
});

for (const role of ["triage", "review", "verify", "implement"])
  test(`implement contamination checks scope ${role} labels in base history`, async () => {
    const f = await fixture();
    try {
      const dir = join(f.source, "evals", role);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "cases.json"), '{"labels":"unrelated bytes"}');
      await pinBase(f);
      const trial = (await f.run()).trials[0];
      if (role === "implement") {
        expect(trial?.details.reason).toContain("pinned history contains");
        expect(f.calls).toHaveLength(0);
      } else {
        expect(trial).toMatchObject({ status: "ok", pass: true });
        expect(f.calls).toHaveLength(1);
      }
    } finally {
      await f.close();
    }
  });

test("implement invokes once in edit mode with shared prompt, isolates head/hidden bytes, caches complete evidence", async () => {
  const f = await fixture("test ! -f broken && test ! -f hidden/check.sh");
  try {
    f.respond(async (s) => {
      expect(s.mode).toBe("edit");
      expect(s.maxToolCalls).toBe(400);
      expect(s.schema).toBeUndefined();
      expect(s.jsonSchema).toBeUndefined();
      expect(s.noTools).toBe(false);
      expect(s.scratchDir).toBeTruthy();
      expect(existsSync(join(s.cwd, "hidden/check.sh"))).toBe(false);
      expect(readFileSync(join(s.cwd, "overwrite"), "utf8")).toBe("original");
      expect(
        (await sh(["git", "cat-file", "-e", f.item.head], { cwd: s.cwd, allowFail: true })).exitCode,
      ).not.toBe(0);
      const gates = await gatesAt(s.cwd, f.item.base, s.signal);
      expect(s.prompt).toBe(
        implementPrompt({
          prompt: f.item.prompt,
          spec: f.item.spec,
          gates,
          baseline: await runGates(s.cwd, gates, s.signal),
          baseSha: f.item.base,
          round: 0,
          feedback: null,
          hasHoldout: false,
        }),
      );
      expect(s.prompt).not.toContain("secret-hidden");
      return {
        files: { answer: "correct", overwrite: "candidate" },
        text: "Implemented",
        costUsd: 0.1,
        costEquivUsd: 0.2,
        usage: { input: 10, cacheRead: 2, cacheWrite: 3, output: 4 },
      };
    });
    const first = await f.run();
    expect(first.trials[0]).toMatchObject({
      status: "ok",
      pass: true,
      score: 1,
      output: "Implemented",
      costUsd: 0.1,
      costEquivUsd: 0.2,
      tokensIn: 15,
      tokensOut: 4,
      details: {
        complexity: "small",
        grade: { implement: { reason: null, gates: [{ verdict: "pass" }], hidden: { exitCode: 0 } } },
      },
    });
    expect(first.trials[0]?.details.grade?.implement?.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(first.trials[0]?.durationMs).toBeGreaterThan(0);
    const cached = await f.run();
    expect(cached.trials[0]?.details.grade).toEqual(first.trials[0]?.details.grade);
    expect(cached.trials[0]).toMatchObject({
      costUsd: 0,
      tokensIn: 0,
      durationMs: 0,
      details: { cache: { costUsd: 0.1, tokensIn: 15 } },
    });
    expect(f.calls).toHaveLength(1);
    // Provenance-only head need not exist and does not affect execution identity.
    f.item.head = "f".repeat(40);
    f.save();
    expect((await f.run()).summaries[0]?.cached).toBe(1);
    const oldKey = first.trials[0]?.cacheKey;
    writeFileSync(
      join(f.hiddenDir, "hidden/check.sh"),
      `${readFileSync(join(f.hiddenDir, "hidden/check.sh"), "utf8")}# changed\n`,
    );
    expect((await f.run()).trials[0]?.cacheKey).not.toBe(oldKey);
    f.item.spec = SpecSchema.parse({
      summary: "Create answer",
      requirements: [],
      acceptance_criteria: [],
      out_of_scope: [],
      assumptions: [],
      blocking_questions: [],
    });
    f.save();
    expect((await f.run()).summaries[0]?.cached).toBe(0);
    enableEfforts(f);
    expect((await f.run({ models: ["candidate-a@high"] })).summaries[0]?.cached).toBe(0);
    expect(f.calls).toHaveLength(4);
    // Cache identity follows execution inputs, even when the report text is unchanged.
    for (const change of [
      () => {
        f.item.prompt += " please";
      },
      () => {
        f.item.hidden.command += " # updated";
      },
      () => {
        f.item.hidden.timeoutSec++;
      },
    ]) {
      change();
      f.save();
      expect((await f.run({ models: ["candidate-a@high"] })).summaries[0]?.cached).toBe(0);
    }
    const data = f.factory.evalPolicy();
    const small = data.evaluation.roles.find((r) => r.role === "implement" && r.cell === "small");
    expect(small?.candidates).toHaveLength(2);
    expect(small?.candidates.every((c) => c.reasons.some((reason) => reason.includes("below floor")))).toBe(
      true,
    );
    expect(data.evaluation.generated.implement).toBeUndefined();
    expect(
      evalMatrix(data)
        .rows.find((r) => r.role === "implement")
        ?.cells.some((c) => c.href),
    ).toBe(true);
    expect(f.calls.every((s) => !existsSync(s.cwd) && !existsSync(s.scratchDir ?? s.cwd))).toBe(true);
    expect(readdirSync(f.cfg.paths.runs).filter((p) => p.startsWith("eval-"))).toEqual([]);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
  } finally {
    await f.close();
  }
});

for (const [kind, files, gate, reason] of [
  ["hidden", { answer: "wrong" }, "true", "hidden_tests"],
  ["gates", { answer: "correct", broken: "yes", protected: "changed" }, "test ! -f broken", "gates"],
  ["audit", { answer: "correct", protected: "changed" }, "true", "audit"],
  ["baseline", { answer: "correct" }, "false", null],
  ["warning", { answer: "correct", "package-lock.json": "{}" }, "true", null],
] as const)
  test(`implement grading: ${kind}`, async () => {
    const f = await fixture(gate);
    try {
      f.respond(() => ({ files: Object.fromEntries(Object.entries(files)) }));
      const t = (await f.run()).trials[0];
      expect(t?.pass).toBe(reason === null);
      expect(t?.details.grade?.implement?.reason).toBe(reason);
      if (kind === "baseline") expect(t?.details.grade?.implement?.gates[0]?.verdict).toBe("still_failing");
      if (kind === "gates") expect(t?.details.grade?.implement?.auditBlocks).not.toHaveLength(0);
      if (kind === "warning") {
        expect(t?.details.grade?.implement?.auditBlocks).toEqual([]);
        expect(t?.details.grade?.implement?.auditWarnings).toEqual([
          {
            rule: "lockfile",
            severity: "warn",
            file: "package-lock.json",
            detail: "Lockfile changed in a task that is not a dependency update.",
          },
        ]);
        expect((await f.run()).trials[0]?.details.grade).toEqual(t?.details.grade);
        expect(f.calls).toHaveLength(1);
      }
    } finally {
      await f.close();
    }
  });

// Exit codes such as 126/127 can be caused by the candidate (a deleted or non-executable script),
// so they are graded hidden_tests failures and the evidence is cached like any other grade.
for (const command of ["./hidden/missing-script.sh", "sh hidden/missing-script.sh", "exit 2"])
  test(`hidden command classification: ${command}`, async () => {
    const f = await fixture();
    try {
      f.item.hidden.command = command;
      f.save();
      const trial = (await f.run()).trials[0];
      expect(trial).toMatchObject({ pass: false, score: 0, status: "ok" });
      expect(trial?.details.grade?.implement).toMatchObject({
        reason: "hidden_tests",
        hidden: { timedOut: false },
      });
      expect(trial?.details.grade?.implement?.hidden?.exitCode).toBeGreaterThan(0);
      expect((await f.run()).trials[0]?.details.grade).toEqual(trial?.details.grade);
      expect(f.calls).toHaveLength(1);
      expect(f.calls.every((s) => !existsSync(s.cwd))).toBe(true);
    } finally {
      await f.close();
    }
  });

test("hidden scripts retain mode bits and mode changes invalidate cached grades", async () => {
  const f = await fixture();
  try {
    const script = join(f.hiddenDir, "hidden/check.sh");
    writeFileSync(script, `#!/bin/sh\n${readFileSync(script, "utf8")}test -x overwrite\n`);
    chmodSync(script, 0o751);
    chmodSync(join(f.hiddenDir, "overwrite"), 0o751);
    f.item.hidden.command = "./hidden/check.sh";
    f.save();
    f.respond((s) => {
      expect(statSync(join(s.cwd, "overwrite")).mode & 0o777).toBe(0o644);
      return { files: { answer: "correct" } };
    });
    const passed = (await f.run()).trials[0];
    expect(passed).toMatchObject({
      status: "ok",
      pass: true,
      details: { grade: { implement: { hidden: { exitCode: 0 } } } },
    });
    expect((await f.run()).summaries[0]?.cached).toBe(1);
    chmodSync(script, 0o644);
    const failed = (await f.run()).trials[0];
    expect(failed).toMatchObject({
      status: "ok",
      pass: false,
      details: { grade: { implement: { reason: "hidden_tests", hidden: { exitCode: 126 } } } },
    });
    expect(failed?.cacheKey).not.toBe(passed?.cacheKey);
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("hidden grading scrubs secrets, bounds output, times out, and rejects destination symlinks", async () => {
  const f = await fixture();
  const previous = process.env.LIMITLESS_EVAL_SECRET;
  process.env.LIMITLESS_EVAL_SECRET = "secret";
  try {
    f.item.hidden.command =
      'test -z "$LIMITLESS_EVAL_SECRET" && test "$(cat overwrite)" = secret-hidden-overwrite && head -c 20000 /dev/zero | tr "\\000" x';
    f.save();
    const first = (await f.run()).trials[0];
    expect(first?.pass).toBe(true);
    expect(first?.details.grade?.implement?.hidden?.output.length).toBeLessThanOrEqual(6000);
    f.item.hidden.command = "sleep 10";
    f.item.hidden.timeoutSec = 0.05;
    f.save();
    const timeout = (await f.run()).trials[0];
    expect(timeout?.details.grade?.implement).toMatchObject({
      reason: "timeout",
      hidden: { timedOut: true },
    });
    expect(timeout?.durationMs).toBeLessThan(5000);
    f.item.hidden.command = "true";
    f.save();
    const outside = join(f.home, "outside");
    mkdirSync(outside);
    f.respond((s) => {
      symlinkSync(outside, join(s.cwd, "hidden"));
      return { files: { answer: "correct" } };
    });
    const escaped = (await f.run()).trials[0];
    expect(escaped?.details.grade?.implement?.reason).toBe("error");
    expect(escaped?.costEquivUsd).toBeGreaterThan(0);
    expect(existsSync(join(outside, "check.sh"))).toBe(false);
    expect(f.calls).toHaveLength(3);
    expect(f.calls.every((s) => !existsSync(s.cwd))).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.LIMITLESS_EVAL_SECRET;
    else process.env.LIMITLESS_EVAL_SECRET = previous;
    await f.close();
  }
});

test("candidate-configured git filters run without daemon secrets", async () => {
  const f = await fixture();
  const previous = process.env.LIMITLESS_EVAL_SECRET;
  process.env.LIMITLESS_EVAL_SECRET = "daemon-secret";
  const leak = join(f.home, "leak");
  try {
    f.respond((s) => {
      Bun.spawnSync(
        [
          "git",
          "config",
          "filter.leak.clean",
          `sh -c 'printf "%s" "$LIMITLESS_EVAL_SECRET" >> ${leak}; cat'`,
        ],
        { cwd: s.cwd },
      );
      return { files: { answer: "correct", ".gitattributes": "answer filter=leak\n" } };
    });
    const trial = (await f.run()).trials[0];
    expect(trial?.pass).toBe(true);
    // The filter did run, so the empty result proves the secret was withheld rather than unused.
    expect(existsSync(leak)).toBe(true);
    expect(readFileSync(leak, "utf8")).toBe("");
  } finally {
    if (previous === undefined) delete process.env.LIMITLESS_EVAL_SECRET;
    else process.env.LIMITLESS_EVAL_SECRET = previous;
    await f.close();
  }
});

test("baseline-gate-configured git filters run without daemon secrets during cleanup", async () => {
  // The gate itself runs scrubbed; the leak would come from the Git cleanup after it, which runs
  // the freshly installed clean filter on the dirtied tracked file while computing status.
  const f = await fixture("sh baseline-gate.sh", (home) => ({
    "baseline-gate.sh": [
      `git config filter.leak.clean "sh -c 'printf %s \\"\\$LIMITLESS_EVAL_SECRET\\" >> ${join(home, "leak")}; cat'"`,
      "printf 'overwrite filter=leak\\n' > .gitattributes",
      "echo changed > overwrite",
    ].join("\n"),
  }));
  const previous = process.env.LIMITLESS_EVAL_SECRET;
  process.env.LIMITLESS_EVAL_SECRET = "daemon-secret";
  const leak = join(f.home, "leak");
  try {
    f.respond((s) => {
      // The baseline cleanup already ran the filter before the candidate was invoked.
      expect(existsSync(leak)).toBe(true);
      expect(readFileSync(leak, "utf8")).toBe("");
      expect(readFileSync(join(s.cwd, "overwrite"), "utf8")).toBe("original");
      return { files: { answer: "correct" } };
    });
    const trial = (await f.run()).trials[0];
    expect(trial?.status).toBe("ok");
    expect(trial?.pass).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(readFileSync(leak, "utf8")).toBe("");
  } finally {
    if (previous === undefined) delete process.env.LIMITLESS_EVAL_SECRET;
    else process.env.LIMITLESS_EVAL_SECRET = previous;
    await f.close();
  }
});

test("hidden bytes in renamed/deleted reachable history reject before invocation", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.source, "unrelated"), readFileSync(join(f.hiddenDir, "overwrite")));
    await sh(["git", "add", "-A"], { cwd: f.source });
    await sh(["git", "commit", "-qm", "contamination"], { cwd: f.source });
    rmSync(join(f.source, "unrelated"));
    await sh(["git", "add", "-A"], { cwd: f.source });
    await sh(["git", "commit", "-qm", "delete label"], { cwd: f.source });
    f.item.base = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
    await sh(["git", "push", f.cache, "HEAD:refs/heads/contaminated"], { cwd: f.source });
    f.save();
    expect((await f.run()).trials[0]?.details.reason).toContain("pinned history contains");
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

for (const rounds of [1, 3])
  for (const via of ["stop", "cancel"] as const)
    test(`cancellation during hidden grading retains spend and removes trial resources (rounds=${rounds}, ${via})`, async () => {
      const f = await fixture();
      try {
        f.item.hidden.command = 'test "$(cat answer)" = correct || exit 1; touch grading-started; sleep 10';
        if (rounds > 1)
          f.respond(() => ({ files: { answer: f.calls.length === 1 ? "wrong" : "correct" }, costUsd: 0.1 }));
        f.save();
        const pending = f.run({ rounds });
        let cwd: string | undefined;
        for (let i = 0; i < 200; i++) {
          cwd = f.calls.at(-1)?.cwd;
          if (cwd && existsSync(join(cwd, "grading-started"))) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(cwd && existsSync(join(cwd, "grading-started"))).toBe(true);
        expect(f.factory.store.listEvalRuns().map((r) => f.factory.store.evalSpend(r.id))).toEqual([
          rounds > 1 ? 0.2 : 0.1,
        ]);
        const id = f.factory.store.listEvalRuns()[0]?.id ?? "";
        await (via === "stop" ? f.factory.evals.stop() : f.factory.evals.cancel(id));
        const report = await pending;
        expect(report.run.status).toBe("interrupted");
        expect(report.trials[0]).toMatchObject(
          rounds > 1
            ? {
                // Aborted mid-trial: unscored, but its rounds and spend remain as evidence.
                status: "skipped",
                pass: null,
                score: null,
                costUsd: 0.2,
                details: {
                  roundsUsed: 2,
                  interrupted: true,
                  rounds: [
                    { round: 0, pass: false },
                    { round: 1, pass: null },
                  ],
                },
              }
            : { status: "skipped", pass: null, costUsd: 0.1 },
        );
        if (rounds > 1) {
          expect(report.trials[0]?.details.grade).toBeUndefined();
          expect(report.summaries[0]?.implement?.passAtR).toMatchObject({ denominator: 0 });
          expect(report.summaries[0]?.implement?.recovery).toMatchObject({ denominator: 0, notAttempted: 0 });
        }
        expect(f.factory.store.cachedEvalTrials(report.trials[0]?.cacheKey ?? "")).toEqual([]);
        expect(cwd && existsSync(cwd)).toBe(false);
        expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
      } finally {
        await f.close();
      }
    });

for (const strategy of ["retry", "effort", "switch"] as const)
  test(`multi-round ${strategy} preserves edits, sanitizes grading, records costs and caches`, async () => {
    const f = await fixture();
    const policy = f.factory.policy.implement.small;
    try {
      enableEfforts(f);
      const stronger = f.factory.router.model("candidate-b");
      if (!stronger) throw new Error("missing model");
      stronger.tier = 2;
      f.factory.policy.implement.small = ["candidate-a@low", "candidate-b"];
      f.item.hidden.command +=
        "; result=$?; echo SECRET-OUTPUT; echo SECRET-ERR >&2; touch grading-artifact; git add -A; git -c user.name=grader -c user.email=grader@example.invalid -c core.hooksPath=/dev/null -c commit.gpgsign=false commit --allow-empty -qm SECRET-HIDDEN-COMMIT; exit $result";
      f.save();
      f.respond(async (s): Promise<FakeReply> => {
        const second = f.calls.length === 2;
        expect(f.factory.tracker.status(s.target.provider)?.inFlight).toBe(1);
        expect(s.prompt).not.toMatch(/secret-hidden|hidden\/check|SECRET-OUTPUT|SECRET-ERR|grading-artifact/);
        expect(existsSync(join(s.cwd, "hidden/check.sh"))).toBe(false);
        expect(existsSync(join(s.cwd, "grading-artifact"))).toBe(false);
        if (second) {
          expect(s.resumeSessionId).toBe(strategy === "switch" ? undefined : "round-zero");
          expect(s.target.modelId).toBe(strategy === "switch" ? "candidate-b" : "candidate-a");
          expect(s.target.effort).toBe(
            strategy === "switch" ? undefined : strategy === "effort" ? "high" : "low",
          );
          expect(s.scratchDir).toBe(f.calls[0]?.scratchDir);
          expect(readFileSync(join(s.cwd, "answer"), "utf8")).toBe("wrong");
          expect(readFileSync(join(s.cwd, "overwrite"), "utf8")).toBe("candidate");
          expect(statSync(join(s.cwd, "overwrite")).mode & 0o777).toBe(0o751);
          expect(s.prompt).toContain("1 acceptance tests fail");
          const grade = f.factory.store.listEvalTrials(f.factory.store.listEvalRuns()[0]?.id ?? "")[0]
            ?.details.grade?.implement;
          if (!grade) throw new Error("missing prior grade");
          expect(s.prompt).toContain(formatGateFeedback(grade.gates));
          expect(s.prompt).toContain(formatAuditFeedback(grade.auditBlocks));
          expect((await sh(["git", "log", "--all", "-p"], { cwd: s.cwd })).stdout).not.toContain(
            "secret-hidden",
          );
          rmSync(join(s.cwd, "broken"));
          return { files: { answer: "correct", protected: "original" }, costUsd: 0.2, costEquivUsd: 0.4 };
        }
        chmodSync(join(s.cwd, "overwrite"), 0o751);
        return {
          files: { answer: "wrong", overwrite: "candidate", broken: "yes", protected: "changed" },
          sessionId: "round-zero",
          costUsd: 0.1,
          costEquivUsd: 0.2,
        };
      });
      const report = await f.run({ rounds: 3, strategy });
      expect(f.calls).toHaveLength(2);
      const t = report.trials[0];
      expect(t).toMatchObject({
        modelId: "candidate-a",
        effort: "low",
        pass: true,
        tokensIn: 200,
        tokensOut: 100,
        details: {
          roundsUsed: 2,
          stopReason: "success",
          rounds: [
            { round: 0, pass: false, reason: "gates" },
            { round: 1, pass: true },
          ],
        },
      });
      expect(t?.costUsd).toBeCloseTo(0.3);
      expect(t?.costEquivUsd).toBeCloseTo(0.6);
      expect(report.run).toMatchObject({ rounds: 3, strategy });
      const cached = (await f.run({ rounds: 3, strategy })).trials[0];
      expect(cached?.details.rounds).toEqual(t?.details.rounds);
      expect(cached?.costUsd).toBe(0);
      expect(f.calls).toHaveLength(2);
      expect(f.calls.every((s) => !existsSync(s.cwd) && !existsSync(s.scratchDir ?? s.cwd))).toBe(true);
      expect(f.factory.tracker.status("provider-b")?.inFlight).toBe(0);
      expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
      if (strategy === "switch") {
        f.factory.tracker.setEnabled("provider-b", false);
        const stopped = (await f.run({ rounds: 4, strategy })).trials[0];
        expect(stopped).toMatchObject({ status: "error", details: { roundsUsed: 1 } });
        expect(stopped?.details.reason).toContain("unavailable");
        expect(f.factory.store.cachedEvalTrials(stopped?.cacheKey ?? "")).toEqual([]);
      }
    } finally {
      f.factory.policy.implement.small = policy;
      await f.close();
    }
  });

test("single-round strategies share legacy inputs and cache; multi-round identities differ", async () => {
  const f = await fixture();
  try {
    enableEfforts(f);
    const first = (await f.run()).trials[0];
    for (const strategy of ["retry", "effort", "switch"]) {
      const cached = (await f.run({ rounds: 1, strategy })).trials[0];
      expect(cached?.cacheKey).toBe(first?.cacheKey);
      expect(cached?.details.cache).toBeDefined();
    }
    expect(f.calls).toHaveLength(1);
    const keys = new Set([first?.cacheKey]);
    for (const rounds of [2, 3])
      for (const strategy of ["retry", "effort", "switch"])
        keys.add((await f.run({ rounds, strategy })).trials[0]?.cacheKey);
    expect(keys.size).toBe(7);
    expect(f.calls.every((s) => s.prompt === f.calls[0]?.prompt && s.resumeSessionId === undefined)).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

for (const kind of [
  "limit",
  "effort",
  "default",
  "switch",
  "error",
  "timeout",
  "budget",
  "unavailable",
  "missing-session",
])
  test(`multi-round stops correctly: ${kind}`, async () => {
    const f = await fixture();
    try {
      if (kind === "effort") enableEfforts(f).effort = "high";
      if (kind === "effort" || kind === "default") {
        await expect(f.run({ rounds: 2, strategy: "effort" })).rejects.toThrow("higher supported effort");
        expect(f.calls).toHaveLength(0);
        return;
      }
      if (kind === "timeout") {
        f.item.hidden.command = "sleep 10";
        f.item.hidden.timeoutSec = 0.05;
        f.save();
      }
      f.respond(() => {
        if (kind === "unavailable") f.factory.tracker.setEnabled("openrouter", false);
        return {
          files: { answer: "wrong" },
          costUsd: 0.1,
          sessionId: null,
          status: kind === "error" ? "error" : "ok",
        };
      });
      const report = await f.run({
        rounds: 2,
        strategy: kind === "switch" ? "switch" : "retry",
        maxUsd: kind === "budget" ? 0.1 : 1,
      });
      const t = report.trials[0];
      if (["budget", "unavailable", "switch"].includes(kind)) {
        expect(t?.details.grade?.implement?.reason).toBe("hidden_tests");
        expect(report.summaries[0]?.implement?.recovery).toMatchObject({ denominator: 0, notAttempted: 1 });
      }
      const repeats = kind === "limit" || kind === "missing-session";
      expect(f.calls).toHaveLength(repeats ? 2 : 1);
      expect(f.calls.every((s) => s.resumeSessionId === undefined)).toBe(true);
      expect(t?.details.stopReason).toBe(
        repeats
          ? "round limit"
          : ["error", "timeout"].includes(kind)
            ? "operational failure"
            : kind === "budget"
              ? "eval budget exhausted"
              : kind === "unavailable"
                ? "disabled"
                : "strategy exhausted",
      );
      expect(t?.costUsd).toBeCloseTo(repeats ? 0.2 : 0.1);
      if (["budget", "error", "timeout", "unavailable"].includes(kind))
        expect(f.factory.store.cachedEvalTrials(t?.cacheKey ?? "")).toEqual([]);
    } finally {
      await f.close();
    }
  });

for (const initial of [undefined, "high"] as const)
  test(`effort resolves ${initial ?? "lowest"} and reaches xhigh`, async () => {
    const f = await fixture();
    try {
      const model = enableEfforts(f);
      model.effort = initial;
      model.supportedEfforts = ["xhigh", "high", "low"];
      f.respond(() => ({ files: { answer: "wrong" } }));
      const report = await f.run({ rounds: 5, strategy: "effort" });
      expect(f.calls.map((s) => s.target.effort)).toEqual(
        initial ? ["high", "xhigh"] : ["low", "high", "xhigh"],
      );
      expect(report.trials[0]?.effort).toBe(initial ?? "low");
      await expect(f.run({ models: ["candidate-a@xhigh"], strategy: "effort" })).rejects.toThrow(
        "higher supported effort",
      );
    } finally {
      await f.close();
    }
  });

for (const succeeds of [true, false])
  test(`failed resume falls back once, accounts for both calls, fresh succeeds=${succeeds}`, async () => {
    const f = await fixture();
    try {
      f.respond((s) => ({
        files: { answer: f.calls.length === 1 ? "wrong" : "correct" },
        status: s.resumeSessionId || (f.calls.length > 1 && !succeeds) ? "error" : "ok",
        error: "session unavailable",
        costUsd: 0.1,
      }));
      const report = await f.run({ rounds: 3 });
      expect(f.calls).toHaveLength(3);
      expect(f.calls[1]?.resumeSessionId).toBe("fake-session");
      expect(f.calls[2]?.resumeSessionId).toBeUndefined();
      expect(f.calls[2]?.prompt).toBe(f.calls[1]?.prompt);
      expect(report.trials[0]?.details.rounds?.[1]).toMatchObject({
        resumeFailed: true,
        pass: succeeds ? true : null,
        ...(!succeeds ? { status: "error", reason: "session unavailable" } : {}),
      });
      expect(report.trials[0]?.details.rounds?.[1]?.costUsd).toBeCloseTo(0.2);
      expect(report.trials[0]?.costUsd).toBeCloseTo(0.3);
      expect(report.summaries[0]?.implement?.recovery).toMatchObject({
        denominator: succeeds ? 1 : 0,
        notAttempted: succeeds ? 0 : 1,
      });
      if (!succeeds) expect(report.trials[0]?.details.grade?.implement?.reason).toBe("hidden_tests");
    } finally {
      await f.close();
    }
  });

test("failed grading preserves ignored baseline dependencies and build outputs for recovery", async () => {
  const f = await fixture("sh setup.sh", () => ({
    ".gitignore": "node_modules/\nbuild/\n",
    "setup.sh":
      "test -f answer || { mkdir -p node_modules build; echo installed > node_modules/dependency; echo compiled > build/output; }\n",
  }));
  try {
    f.respond((s) => {
      expect(readFileSync(join(s.cwd, "node_modules/dependency"), "utf8")).toBe("installed\n");
      expect(readFileSync(join(s.cwd, "build/output"), "utf8")).toBe("compiled\n");
      return { files: { answer: f.calls.length === 1 ? "wrong" : "correct" } };
    });
    expect((await f.run({ rounds: 2 })).trials[0]?.pass).toBe(true);
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("recovery rounds never see ignored hidden files or grader outputs", async () => {
  const f = await fixture();
  try {
    f.item.hidden.command += "; result=$?; mkdir -p dist; cp hidden/check.sh dist/compiled; exit $result";
    f.save();
    f.respond((s): FakeReply => {
      if (f.calls.length === 1)
        return { files: { answer: "wrong", ".gitignore": "hidden/\ndist/\n", "dist/own": "kept" } };
      expect(existsSync(join(s.cwd, "hidden"))).toBe(false);
      expect(existsSync(join(s.cwd, "dist/compiled"))).toBe(false);
      expect(readFileSync(join(s.cwd, "dist/own"), "utf8")).toBe("kept");
      expect(readFileSync(join(s.cwd, "overwrite"), "utf8")).toBe("original");
      return { files: { answer: "correct" } };
    });
    expect((await f.run({ rounds: 2 })).trials[0]?.pass).toBe(true);
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("recovery rounds never see hidden tests copied onto pre-existing ignored outputs", async () => {
  const f = await fixture();
  try {
    f.item.hidden.command += "; result=$?; cp hidden/check.sh dist/compiled; exit $result";
    f.save();
    f.respond((s): FakeReply => {
      if (f.calls.length === 1)
        return {
          files: {
            answer: "wrong",
            ".gitignore": "hidden/\ndist/\n",
            "dist/compiled": "built",
            "dist/own": "kept",
          },
        };
      const compiled = join(s.cwd, "dist/compiled");
      expect(existsSync(compiled) ? readFileSync(compiled, "utf8") : "").not.toContain("answer");
      expect(readFileSync(join(s.cwd, "dist/own"), "utf8")).toBe("kept");
      return { files: { answer: "correct" } };
    });
    expect((await f.run({ rounds: 2 })).trials[0]?.pass).toBe(true);
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

// Git lists a nested repository as one unexpanded directory, whose metadata an overwritten child leaves untouched.
test("recovery rounds never see hidden tests copied into ignored nested repositories", async () => {
  const f = await fixture();
  try {
    f.item.hidden.command += "; result=$?; cp hidden/check.sh dist/nested/compiled; exit $result";
    f.save();
    f.respond(async (s): Promise<FakeReply> => {
      if (f.calls.length === 1) {
        await sh(["git", "init", "-q", "dist/nested"], { cwd: s.cwd });
        writeFileSync(join(s.cwd, "dist/nested/compiled"), "built");
        writeFileSync(join(s.cwd, "dist/nested/own"), "kept");
        return { files: { answer: "wrong", ".gitignore": "hidden/\ndist/\n" } };
      }
      const compiled = join(s.cwd, "dist/nested/compiled");
      expect(existsSync(compiled) ? readFileSync(compiled, "utf8") : "").not.toContain("answer");
      expect(readFileSync(join(s.cwd, "dist/nested/own"), "utf8")).toBe("kept");
      return { files: { answer: "correct" } };
    });
    expect((await f.run({ rounds: 2 })).trials[0]?.pass).toBe(true);
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

for (const failure of ["harness-timeout", "hidden-timeout", "gate-timeout", "error"])
  test(`recovery preserves evidence and accounts for ${failure}`, async () => {
    const f = await fixture();
    try {
      if (failure === "hidden-timeout") {
        f.item.hidden.command = 'test "$(cat answer)" != hangs || sleep 10; sh hidden/check.sh';
        f.item.hidden.timeoutSec = 0.05;
        f.save();
      }
      if (failure === "gate-timeout") {
        writeFileSync(
          join(f.source, ".limitless.toml"),
          '[gates]\nchecks = [{ name = "test", run = "test ! -f hangs || sleep 10", timeoutSec = 0.05 }]\n',
        );
        await pinBase(f);
      }
      f.respond((): FakeReply => {
        const recovery = f.calls.length > 1;
        return {
          files: recovery ? { answer: "hangs", hangs: "yes" } : { answer: "wrong" },
          status: recovery
            ? failure === "harness-timeout"
              ? "timeout"
              : failure === "error"
                ? "error"
                : "ok"
            : "ok",
          error:
            recovery && ["harness-timeout", "error"].includes(failure)
              ? "original harness failure"
              : undefined,
          sessionId: null,
          costUsd: 0.1,
        };
      });
      const report = await f.run({ rounds: 3 });
      const trial = report.trials[0];
      expect(f.calls).toHaveLength(2);
      expect(trial?.details.rounds?.[0]).toMatchObject({ pass: false, reason: "hidden_tests" });
      expect(trial?.details.rounds?.[1]).toMatchObject({
        status: failure === "error" ? "error" : "timeout",
        pass: failure === "error" ? null : false,
        reason: ["harness-timeout", "error"].includes(failure) ? "original harness failure" : "timeout",
      });
      expect(trial?.details.grade?.implement?.reason).toBe(failure === "error" ? "hidden_tests" : "timeout");
      expect(trial?.costUsd).toBeCloseTo(0.2);
      expect(report.summaries[0]?.implement?.recovery).toMatchObject({
        numerator: 0,
        denominator: failure === "error" ? 0 : 1,
        notAttempted: failure === "error" ? 1 : 0,
      });
      expect(f.factory.store.cachedEvalTrials(trial?.cacheKey ?? "")).toEqual([]);
    } finally {
      await f.close();
    }
  });

test("switch freezes policy order, ignores live headroom, records harness and keys the chain", async () => {
  const f = await fixture();
  const policy = f.factory.policy.implement.small;
  const route = spyOn(f.factory.router, "route");
  try {
    const model = f.factory.router.model("candidate-b");
    const provider = f.factory.tracker.def("provider-b");
    if (!model || !provider) throw new Error("missing target");
    model.tier = 2;
    provider.harness = "codex";
    f.factory.policy.implement.small = ["candidate-a", "candidate-b"];
    f.respond(() => {
      f.factory.policy.implement.small = ["candidate-a"];
      return { files: { answer: f.calls.length === 1 ? "wrong" : "correct" } };
    });
    const report = await f.run({ rounds: 2, strategy: "switch" });
    expect(f.calls.map((s) => s.target.modelId)).toEqual(["candidate-a", "candidate-b"]);
    expect(report.trials[0]?.harness).toBe("codex");
    expect(report.trials[0]?.details.rounds?.map((r) => r.harness)).toEqual(["fake", "codex"]);
    expect(route).not.toHaveBeenCalled();
    // A resume keeps its predecessor's chain, part of the cache key, despite the policy change.
    const calls = f.calls.length;
    f.factory.store.updateEvalRun(report.run.id, "failed", "boom");
    // Unfinished, so the resume runs it again instead of copying it; another run keeps its cache entry.
    const [finished] = report.trials;
    if (!finished) throw new Error("missing trial");
    f.factory.store.createEvalRun(report.run, [finished]);
    f.factory.store.recordEvalTrial({ ...finished, status: "skipped" });
    const resumed = f.factory.evals.resume(report.run.id);
    await f.factory.evals.wait(resumed?.id ?? "");
    const replayed = f.factory.evals.report(resumed?.id ?? "");
    expect(replayed?.trials[0]?.details.switchChain).toEqual(report.trials[0]?.details.switchChain);
    expect(replayed?.summaries[0]?.cached).toBe(1);
    expect(f.calls).toHaveLength(calls);
    const changed = await f.run({ rounds: 2, strategy: "switch" });
    expect(changed.trials[0]?.cacheKey).not.toBe(report.trials[0]?.cacheKey);
    expect(changed.summaries[0]?.cached).toBe(0);
    f.factory.policy.implement.small = ["candidate-a", "candidate-b"];
    const cached = await f.run({ rounds: 2, strategy: "switch" });
    expect(cached.trials[0]?.harness).toBe("codex");
    expect(cached.summaries[0]?.cached).toBe(1);
  } finally {
    route.mockRestore();
    f.factory.policy.implement.small = policy;
    await f.close();
  }
});

test("resume reruns a multi-round trial whose switch target backend or retry prompt changed", async () => {
  const f = await fixture();
  const policy = f.factory.policy.implement.small;
  const prompts = await import("../src/pipeline/prompts.ts");
  const original = prompts.implementPrompt;
  const retryRule = spyOn(prompts, "implementPrompt");
  try {
    const model = f.factory.router.model("candidate-b");
    if (!model) throw new Error("missing target");
    model.tier = 2;
    f.factory.policy.implement.small = ["candidate-a", "candidate-b"];
    f.respond((s) => ({ files: { answer: s.target.modelId === "candidate-a" ? "wrong" : "correct" } }));
    const resume = async (id: string) => {
      f.factory.store.updateEvalRun(id, "interrupted");
      const resumed = f.factory.evals.resume(id);
      await f.factory.evals.wait(resumed?.id ?? "");
      return f.factory.evals.report(resumed?.id ?? "")?.trials[0];
    };
    const report = await f.run({ rounds: 2, strategy: "switch" });
    expect(f.calls).toHaveLength(2);
    const copied = await resume(report.run.id);
    expect(f.calls).toHaveLength(2);
    expect(copied?.details.resumedFrom).toBe(report.run.id);
    model.model = "b-new-checkpoint";
    const switched = await resume(copied?.evalRunId ?? "");
    expect(f.calls.map((s) => s.target.model).slice(2)).toEqual([expect.any(String), "b-new-checkpoint"]);
    expect(switched?.details.resumedFrom).toBeUndefined();
    retryRule.mockImplementation(
      (input) => `${original(input)}${input.round > 0 ? "\nA new retry rule." : ""}`,
    );
    const retried = await resume(switched?.evalRunId ?? "");
    expect(f.calls).toHaveLength(6);
    expect(f.calls.at(-1)?.prompt).toContain("A new retry rule.");
    expect(retried?.details.resumedFrom).toBeUndefined();
  } finally {
    retryRule.mockRestore();
    f.factory.policy.implement.small = policy;
    await f.close();
  }
});

test("switched retry rounds respect the eval concurrency on their destination provider", async () => {
  const f = await fixture();
  const policy = f.factory.policy.implement.small;
  try {
    const model = f.factory.router.model("candidate-b");
    const a = f.factory.tracker.def("openrouter");
    const b = f.factory.tracker.def("provider-b");
    if (!model || !a || !b) throw new Error("missing target");
    model.tier = 2;
    a.maxConcurrent = 3;
    b.maxConcurrent = 3;
    f.factory.policy.implement.small = ["candidate-a", "candidate-b"];
    const active = new Map<string, number>();
    let maxB = 0;
    f.respond(async (s) => {
      const provider = s.target.provider;
      active.set(provider, (active.get(provider) ?? 0) + 1);
      if (provider === "provider-b") maxB = Math.max(maxB, active.get(provider) ?? 0);
      await Bun.sleep(30);
      active.set(provider, (active.get(provider) ?? 1) - 1);
      // Candidate A always fails its first round, so each of its trials switches to provider B.
      return { files: { answer: provider === "openrouter" ? "wrong" : "correct" } };
    });
    const report = await f.run({
      models: ["candidate-a", "candidate-b"],
      k: 3,
      rounds: 2,
      strategy: "switch",
      concurrency: 1,
      cache: false,
    });
    expect(f.calls.filter((s) => s.target.provider === "provider-b")).toHaveLength(6);
    expect(maxB).toBe(1);
    expect(report.trials.every((t) => t.pass)).toBe(true);
    expect(f.factory.tracker.status("provider-b")?.inFlight).toBe(0);
  } finally {
    f.factory.policy.implement.small = policy;
    await f.close();
  }
});

test("unavailable next tier never skips to a higher available tier", async () => {
  const f = await fixture(undefined, undefined, [
    {
      id: "top",
      provider: "openrouter",
      model: "top",
      tier: 3,
      vendor: "other",
      origin: "unknown",
      baseOrigin: "unknown",
      supportedEfforts: [],
      price: { input: 1, output: 1 },
    },
  ]);
  const policy = f.factory.policy.implement.small;
  try {
    const model = f.factory.router.model("candidate-b");
    if (!model) throw new Error("missing model");
    model.tier = 2;
    f.factory.policy.implement.small = ["candidate-a", "candidate-b", "top"];
    f.factory.tracker.setEnabled("provider-b", false);
    f.respond(() => ({ files: { answer: "wrong" } }));
    const report = await f.run({ rounds: 3, strategy: "switch" });
    expect(f.calls).toHaveLength(1);
    expect(report.trials[0]?.details.grade?.implement?.reason).toBe("hidden_tests");
    expect(report.summaries[0]?.implement?.recovery).toMatchObject({ denominator: 0, notAttempted: 1 });
  } finally {
    f.factory.policy.implement.small = policy;
    await f.close();
  }
});

for (const rounds of [1, 2])
  test(`grading avoids worktree copies and isolates hidden HOME/TMPDIR (rounds=${rounds})`, async () => {
    const f = await fixture();
    const copies = spyOn(fs, "cpSync");
    try {
      f.item.hidden.command += '; result=$?; printf "%s\\n%s" "$HOME" "$TMPDIR"; exit $result';
      f.save();
      const report = await f.run({ rounds });
      expect(report.trials[0]?.pass).toBe(true);
      const paths = report.trials[0]?.details.grade?.implement?.hidden?.output.split("\n") ?? [];
      expect(paths).toHaveLength(2);
      expect(paths[0]).toBe(paths[1]);
      expect(paths.every((p) => !existsSync(p))).toBe(true);
      expect(
        copies.mock.calls.filter(
          ([from]) => String(from).startsWith(`${f.calls[0]?.cwd}/`) && !String(from).endsWith("/.git"),
        ),
      ).toHaveLength(0);
      if (rounds === 1)
        expect(copies.mock.calls.filter(([from]) => String(from).endsWith("/.git"))).toHaveLength(0);
      const text = formatEvalReport(report);
      expect(text.includes("strategy=")).toBe(rounds > 1);
      expect(text.includes("recovery")).toBe(rounds > 1);
      expect(text.match(/pass@1 /g)).toHaveLength(1);
      expect(copies.mock.calls.filter(([, to]) => to === join(f.calls[0]?.cwd ?? "", ".git"))).toHaveLength(
        0,
      );
      copies.mockClear();
      f.respond(() => ({ files: { answer: "wrong" } }));
      await f.run({ rounds, cache: false });
      expect(
        copies.mock.calls.filter(([from]) => from === join(f.calls.at(-1)?.cwd ?? "", ".git")),
      ).toHaveLength(rounds - 1);
    } finally {
      copies.mockRestore();
      await f.close();
    }
  });
