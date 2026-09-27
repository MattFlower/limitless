import { expect, test } from "bun:test";
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
import { gatesAt } from "../src/evals/prepare.ts";
import { runGates } from "../src/gates/run.ts";
import { implementPrompt } from "../src/pipeline/prompts.ts";
import { SpecSchema } from "../src/pipeline/schemas.ts";
import { sh } from "../src/util/proc.ts";
import { evalMatrix } from "../ui/lib/evals.ts";
import { enableEfforts, evalFixture } from "./evals-support.ts";

async function fixture(
  gate = "test ! -f broken",
  baseFiles: (home: string) => Record<string, string> = () => ({}),
) {
  const f = await evalFixture();
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

test("cancellation during hidden grading retains spend and removes trial resources", async () => {
  const f = await fixture();
  try {
    f.item.hidden.command = "touch grading-started; sleep 10";
    f.save();
    const pending = f.run();
    let cwd: string | undefined;
    for (let i = 0; i < 200; i++) {
      cwd = f.calls[0]?.cwd;
      if (cwd && existsSync(join(cwd, "grading-started"))) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(cwd && existsSync(join(cwd, "grading-started"))).toBe(true);
    expect(f.factory.store.listEvalRuns().map((r) => f.factory.store.evalSpend(r.id))).toEqual([0.1]);
    await f.factory.evals.stop();
    const report = await pending;
    expect(report.run.status).toBe("failed");
    expect(report.trials[0]).toMatchObject({ status: "skipped", pass: null, costUsd: 0.1 });
    expect(cwd && existsSync(cwd)).toBe(false);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
  } finally {
    await f.close();
  }
});
