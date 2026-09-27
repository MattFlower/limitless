import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
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

async function fixture(gate = "test ! -f broken") {
  const f = await evalFixture();
  await sh(["git", "checkout", "--detach", f.sha], { cwd: f.source });
  writeFileSync(
    join(f.source, ".limitless.toml"),
    `[gates]\nchecks = [{ name = "test", run = "${gate}" }]\n[policy]\nprotected_paths = ["protected"]\n`,
  );
  writeFileSync(join(f.source, "overwrite"), "original");
  writeFileSync(join(f.source, "protected"), "original");
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

test("implement invokes once in edit mode with shared prompt, isolates head/hidden bytes, caches complete evidence", async () => {
  const f = await fixture("test ! -f broken && test ! -f hidden/check.sh");
  try {
    f.respond(async (s) => {
      expect(s.mode).toBe("edit");
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
        // Both the original and cached legacy grades are ineligible once warnings are unknown.
        for (const run of f.factory.store.listEvalRuns()) {
          for (const row of f.factory.store.listEvalTrials(run.id)) {
            if (row.details.grade?.implement) row.details.grade.implement.auditWarnings = null;
            f.factory.store.recordEvalTrial(row);
          }
        }
        expect((await f.run()).trials[0]?.details.grade?.implement?.auditWarnings).toHaveLength(1);
        expect(f.calls).toHaveLength(2);
      }
    } finally {
      await f.close();
    }
  });

for (const [command, reason] of [
  ["./hidden/missing-script.sh", "error"],
  ["sh hidden/missing-script.sh", "error"],
  ["./overwrite", "error"],
  ["exit 2", "hidden_tests"],
] as const)
  test(`hidden command classification: ${command}`, async () => {
    const f = await fixture();
    try {
      f.item.hidden.command = command;
      f.save();
      const trial = (await f.run()).trials[0];
      expect(trial).toMatchObject({ pass: false, score: 0, status: reason === "error" ? "error" : "ok" });
      expect(trial?.details.grade?.implement).toMatchObject({ reason, hidden: { timedOut: false } });
      expect(trial?.details.grade?.implement?.hidden?.exitCode).toBeGreaterThan(0);
      if (reason === "error") {
        expect(trial?.details.grade?.implement?.hidden?.output).toBeTruthy();
        f.respond(() => ({ files: { answer: "correct", broken: "yes", protected: "changed" } }));
        const overlap = (await f.run({ cache: false })).trials[0]?.details.grade?.implement;
        expect(overlap?.reason).toBe("error");
        expect(overlap?.gates.some((g) => g.blocking)).toBe(true);
        expect(overlap?.auditBlocks.length).toBeGreaterThan(0);
      }
      expect(f.calls).toHaveLength(reason === "error" ? 2 : 1);
      expect(f.calls.every((s) => !existsSync(s.cwd))).toBe(true);
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
