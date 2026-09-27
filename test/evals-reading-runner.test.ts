import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRoleCases, VerifyCaseFileSchema } from "../src/evals/cases.ts";
import { gatesAt } from "../src/evals/prepare.ts";
import { auditDiff } from "../src/gates/audit.ts";
import { gateScriptNames, pickScripts } from "../src/gates/detect.ts";
import { diffSince, readFileAt } from "../src/git/repos.ts";
import { readingTimeout } from "../src/pipeline/engine.ts";
import { FACTORY_PREAMBLE, reviewPrompt, verifyPrompt } from "../src/pipeline/prompts.ts";
import { ReviewSchema, toStrictJsonSchema, VerifySchema } from "../src/pipeline/schemas.ts";
import { sh } from "../src/util/proc.ts";
import { reviewCase, reviewOutput } from "./evals-reading-support.ts";
import { deferred, evalFixture } from "./evals-support.ts";

async function fixture(role: "review" | "verify" = "review") {
  const f = await evalFixture();
  const head = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
  const item = { ...reviewCase, base: f.sha, head };
  const verify = VerifyCaseFileSchema.parse(
    loadRoleCases("verify", new URL("./data/evals-verify.json", import.meta.url).pathname),
  ).cases[2];
  if (!verify) throw new Error("fixture");
  const verifyItem = { ...verify, base: f.sha, head };
  const save = () =>
    writeFileSync(
      f.casePath,
      JSON.stringify({ role, version: 1, cases: [role === "review" ? item : verifyItem] }),
    );
  save();
  const run = (over: Record<string, unknown> = {}) => f.run({ role, models: ["candidate-a"], k: 1, ...over });
  const clean = async () => {
    expect(f.calls.every((s) => !existsSync(s.cwd))).toBe(true);
    expect(
      (await sh(["git", "worktree", "list", "--porcelain"], { cwd: f.cache })).stdout.match(/^worktree /gm),
    ).toHaveLength(1);
    expect(readdirSync(f.cfg.paths.runs).filter((p) => p.startsWith("eval-"))).toEqual([]);
    expect(f.factory.tracker.status("openrouter")?.inFlight).toBe(0);
  };
  return { ...f, item, verifyItem, save, run, clean };
}

test("review uses the pipeline prompt, recomputed audit, detached seeded HEAD and agent harness", async () => {
  const f = await fixture();
  try {
    f.item.seedPatch = "seed.patch";
    f.item.kind = "seeded";
    f.item.input.gates = [
      {
        name: "test",
        verdict: "regressed",
        blocking: true,
        result: { name: "test", command: "test", ok: false, exitCode: 1, durationMs: 1, output: "failed" },
      },
    ];
    writeFileSync(
      join(f.home, "seed.patch"),
      "diff --git a/example.test.ts b/example.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/example.test.ts\n@@ -0,0 +1 @@\n+test.skip('case', () => {});\n",
    );
    f.save();
    f.respond(async (s) => {
      expect(s.mode).toBe("readonly");
      expect(s.noTools).toBe(false);
      expect(s.systemAppend).toBe(FACTORY_PREAMBLE);
      expect(s.schema).toBe(ReviewSchema);
      expect(s.jsonSchema).toEqual(toStrictJsonSchema(ReviewSchema));
      expect(s.idleTimeoutMs).toBe(600_000);
      expect(s.maxToolCalls).toBe(150);
      expect(readFileSync(join(s.cwd, "example.test.ts"), "utf8")).toContain("test.skip");
      expect(existsSync(join(s.cwd, "seed.patch"))).toBe(false);
      expect((await sh(["git", "rev-parse", "HEAD^"], { cwd: s.cwd })).stdout.trim()).toBe(f.item.head);
      expect(
        (await sh(["git", "symbolic-ref", "-q", "HEAD"], { cwd: s.cwd, allowFail: true })).exitCode,
      ).not.toBe(0);
      const diff = await diffSince(s.cwd, f.sha);
      const gates = await gatesAt(s.cwd, f.sha, s.signal);
      const names = gateScriptNames(gates);
      const audit = auditDiff(diff, {
        taskClass: null,
        protectedPaths: gates.protectedPaths,
        toolCommands: [],
        gateScripts: {
          before: pickScripts(await readFileAt(s.cwd, f.sha, "package.json"), names),
          after: pickScripts(await readFileAt(s.cwd, "HEAD", "package.json"), names),
        },
      });
      expect(audit.length).toBeGreaterThan(0);
      expect(s.prompt).toBe(reviewPrompt({ ...f.item.input, baseSha: f.sha, stat: diff.stat, audit }));
      expect(s.timeoutMs).toBe(readingTimeout(diff.added + diff.removed));
      for (const secret of ["SECRET_SOURCE", "SECRET_DEFECT", "SECRET_AUTHOR", "seed.patch"])
        expect(s.prompt).not.toContain(secret);
      return { structured: reviewOutput(), costUsd: 0.1 };
    });
    const first = await f.run();
    expect(first.trials[0]?.status).toBe("ok");
    expect(f.harnessNames).toEqual(["fake"]);
    await f.clean();
    const firstGrade = first.trials[0]?.details.grade;
    f.item.defects[0] = {
      ...reviewCase.defects[0],
      file: "wrong.ts",
      lines: [10, 20],
      severity: "major",
      category: "correctness",
      summary: "changed labels",
      required: true,
      foundBy: "changed",
    };
    f.save();
    const cached = await f.run();
    expect(cached.summaries[0]).toMatchObject({ cached: 1, costUsd: 0, costEquivUsd: 0 });
    expect(cached.trials[0]?.pass).toBe(false);
    expect(f.factory.evals.report(first.run.id)?.trials[0]?.details.grade).toEqual(firstGrade);
    expect(f.calls).toHaveLength(1);
    // Identical patch content at another path reuses cache; changed content with identical stat does not.
    f.item.seedPatch = "other.patch";
    writeFileSync(join(f.home, "other.patch"), readFileSync(join(f.home, "seed.patch"), "utf8"));
    f.save();
    expect((await f.run()).summaries[0]?.cached).toBe(1);
    writeFileSync(
      join(f.home, "other.patch"),
      readFileSync(join(f.home, "seed.patch"), "utf8").replace("'case'", "'else'"),
    );
    expect((await f.run()).summaries[0]?.cached).toBe(0);
    expect(f.calls).toHaveLength(2);
    await f.clean();
  } finally {
    await f.close();
  }
});

test("verify uses pipeline schema, prompt, private session and head content, retaining per-criterion grades", async () => {
  const f = await fixture("verify");
  try {
    f.respond(async (s) => {
      expect(s.privateSession).toBe(true);
      expect(s.mode).toBe("readonly");
      expect(s.noTools).toBe(false);
      expect(s.schema).toBe(VerifySchema);
      expect(s.jsonSchema).toEqual(toStrictJsonSchema(VerifySchema));
      expect(s.systemAppend).toBe(FACTORY_PREAMBLE);
      expect(s.prompt).toBe(
        verifyPrompt({
          ...f.verifyItem.input,
          holdout: f.verifyItem.input.holdout ?? { scenarios: [] },
          baseSha: f.sha,
        }),
      );
      const diff = await diffSince(s.cwd, f.sha);
      expect(s.timeoutMs).toBe(readingTimeout(diff.added + diff.removed, 25));
      expect((await sh(["git", "rev-parse", "HEAD"], { cwd: s.cwd })).stdout.trim()).toBe(f.verifyItem.head);
      expect(existsSync(join(s.cwd, "CURRENT.txt"))).toBe(true);
      expect(existsSync(join(s.cwd, "PINNED.txt"))).toBe(false);
      return {
        structured: {
          overall: "fail",
          notes: "",
          criteria: Object.entries(f.verifyItem.gold).map(([id, status]) => ({
            id,
            status,
            evidence: "observed",
          })),
        },
      };
    });
    expect((await f.run()).trials[0]?.pass).toBe(true);
    expect(f.harnessNames).toEqual(["fake"]);
    await f.clean();
    delete f.verifyItem.input.holdout;
    f.verifyItem.gold = { "AC-1": "met" };
    f.save();
    expect((await f.run()).trials[0]?.pass).toBe(true);
    await f.clean();
  } finally {
    await f.close();
  }
});

test("audit uses gate configuration from base, so a change cannot disable its own findings", async () => {
  const f = await fixture();
  try {
    const commit = async (files: Record<string, string | null>) => {
      for (const [name, content] of Object.entries(files))
        if (content === null) rmSync(join(f.source, name));
        else writeFileSync(join(f.source, name), content);
      await sh(["git", "add", "-A"], { cwd: f.source });
      await sh(["git", "commit", "-qm", "step"], { cwd: f.source });
      return (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
    };
    const scriptBase = await commit({
      "package.json": JSON.stringify({ scripts: { test: "bun test" } }),
      "bun.lock": "",
    });
    const scriptHead = await commit({ "package.json": JSON.stringify({ scripts: {} }) });
    const tomlBase = await commit({
      ".limitless.toml": '[policy]\nprotected_paths = ["guard.txt"]\n',
      "guard.txt": "keep",
    });
    const tomlHead = await commit({ ".limitless.toml": "", "guard.txt": "tampered" });
    writeFileSync(
      f.casePath,
      JSON.stringify({
        role: "review",
        version: 1,
        cases: [
          { ...f.item, id: "script", base: scriptBase, head: scriptHead },
          { ...f.item, id: "protected", base: tomlBase, head: tomlHead },
        ],
      }),
    );
    f.respond(() => ({ structured: reviewOutput() }));
    const report = await f.run();
    expect(report.trials.map((t) => t.status)).toEqual(["ok", "ok"]);
    expect(f.calls[0]?.prompt).toContain('Removed the "test" script');
    expect(f.calls[1]?.prompt).toContain("Edited a protected path.");
    await f.clean();
  } finally {
    await f.close();
  }
});

test("rejects pins whose reachable history exposes eval labels or seed patches", async () => {
  for (const leak of ["dataset", "seed"] as const) {
    const f = await fixture();
    try {
      const patch =
        "diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+n\n";
      writeFileSync(join(f.home, "seed.patch"), patch);
      f.item.seedPatch = "seed.patch";
      f.save();
      mkdirSync(join(f.source, leak === "dataset" ? "evals/review" : "notes"), { recursive: true });
      if (leak === "dataset") writeFileSync(join(f.source, "evals/review/cases.json"), "{}");
      else writeFileSync(join(f.source, "notes/copy.patch"), patch);
      await sh(["git", "add", "-A"], { cwd: f.source });
      await sh(["git", "commit", "-qm", "labels"], { cwd: f.source });
      // Labels committed before the head and deleted again stay readable through history.
      await sh(["git", "rm", "-rq", leak === "dataset" ? "evals" : "notes"], { cwd: f.source });
      await sh(["git", "commit", "-qm", "later"], { cwd: f.source });
      f.item.head = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
      f.save();
      const report = await f.run();
      expect(report.trials[0]).toMatchObject({ status: "error", pass: false });
      expect(String(report.trials[0]?.details.reason)).toContain(
        leak === "dataset" ? "eval labels" : "seed patch",
      );
      expect(f.calls).toHaveLength(0);
      await f.clean();
    } finally {
      await f.close();
    }
  }
});

test("fetches missing branch and PR-only pins and invalidates same-stat repository changes", async () => {
  const f = await fixture();
  try {
    const hidden: string[] = [];
    f.respond(async (s) => {
      // The candidate sees only history reachable from the pins: no refs, remotes or later commits.
      const git = (...args: string[]) => sh(["git", ...args], { cwd: s.cwd, allowFail: true });
      expect((await git("for-each-ref")).stdout).toBe("");
      expect((await git("remote")).stdout).toBe("");
      expect((await git("log", "--all", "--reflog", "--format=%H")).stdout).toBe(
        (await git("rev-list", "HEAD")).stdout,
      );
      expect((await git("worktree", "list", "--porcelain")).stdout.match(/^worktree /gm)).toHaveLength(1);
      for (const sha of hidden) expect((await git("cat-file", "-e", `${sha}^{commit}`)).exitCode).not.toBe(0);
      return { structured: reviewOutput(), finalText: readFileSync(join(s.cwd, "CURRENT.txt"), "utf8") };
    });
    await f.run();
    const original = f.item.head;
    for (const pr of [false, true]) {
      if (pr) await sh(["git", "checkout", "--detach", original], { cwd: f.source });
      writeFileSync(join(f.source, "CURRENT.txt"), pr ? "pr!" : "alt");
      await sh(["git", "add", "."], { cwd: f.source });
      await sh(["git", "commit", "-qm", "next"], { cwd: f.source });
      f.item.head = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
      if (pr) {
        await sh(["git", "update-ref", "refs/pull/1/head", f.item.head], { cwd: f.source });
        await sh(["git", "checkout", "--detach", original], { cwd: f.source });
      }
      f.save();
      const report = await f.run();
      expect(report.trials[0]?.status).toBe("ok");
      expect(report.summaries[0]?.cached).toBe(0);
      expect(f.calls.at(-1)?.prompt).toBe(f.calls[0]?.prompt);
      expect(
        (await sh(["git", "cat-file", "-e", `${f.item.head}^{commit}`], { cwd: f.cache })).exitCode,
      ).toBe(0);
      await f.clean();
      hidden.push(f.item.head);
    }
    expect(f.calls).toHaveLength(3);
    // Later commits now sit in the shared cache but stay invisible to an earlier pin.
    f.item.head = original;
    f.item.input.prompt = "rerun without cache";
    f.save();
    expect((await f.run()).trials[0]?.status).toBe("ok");
    expect(f.calls).toHaveLength(4);
    await f.clean();
  } finally {
    await f.close();
  }
});

test("preparation, patch, harness and output failures remove worktrees and release slots", async () => {
  for (const failure of ["missing", "patch", "throw", "invalid"] as const) {
    const f = await fixture();
    try {
      if (failure === "missing") f.item.head = "0".repeat(40);
      if (failure === "patch") {
        f.item.seedPatch = "bad.patch";
        writeFileSync(join(f.home, "bad.patch"), "bad patch");
      }
      f.save();
      f.respond(() => {
        if (failure === "throw") throw new Error("injected");
        return { structured: { invalid: true } };
      });
      const report = await f.run();
      expect(report.trials[0]).toMatchObject({ status: "error", pass: false });
      expect(report.summaries[0]).toMatchObject({ predictionTrials: 0, errors: 1 });
      if (failure === "missing" || failure === "patch")
        expect(report.summaries[0]?.latencyDenominator).toBe(0);
      await f.clean();
    } finally {
      await f.close();
    }
  }
});

test("shutdown removes active and capacity-waiting worktrees", async () => {
  const f = await fixture();
  try {
    const entered = deferred<void>();
    f.respond(async (s) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        s.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { status: "cancelled" };
    });
    const first = f.factory.evals.submit({ role: "review", models: ["candidate-a"] });
    await entered.promise;
    const waiting = deferred<void>();
    const acquire = f.factory.tracker.acquire.bind(f.factory.tracker);
    const spy = spyOn(f.factory.tracker, "acquire").mockImplementation((id, signal) => {
      waiting.resolve();
      return acquire(id, signal);
    });
    const second = f.factory.evals.submit({ role: "review", models: ["candidate-a"] });
    await waiting.promise;
    spy.mockRestore();
    await f.factory.evals.stop();
    for (const id of [first.id, second.id]) expect(f.factory.evals.report(id)?.run.status).toBe("failed");
    const report = f.factory.evals.report(second.id);
    expect(report?.trials[0]).toMatchObject({
      status: "skipped",
      pass: null,
      score: null,
      details: { reason: "daemon shutdown" },
    });
    expect(report?.trials[0]?.details.preparationFailed).toBeUndefined();
    expect(report?.summaries[0]).toMatchObject({
      evaluatedTrials: 0,
      errors: 0,
      skipped: 1,
      passRate: null,
      predictionTrials: 0,
      latencyDenominator: 0,
    });
    expect(f.calls).toHaveLength(1);
    await f.clean();
  } finally {
    await f.close();
  }
});
