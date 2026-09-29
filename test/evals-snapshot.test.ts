import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImplementCase, ReviewCase } from "../src/evals/cases.ts";
import { createEvalWorktree } from "../src/git/repos.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { sh } from "../src/util/proc.ts";
import { reviewCase, reviewOutput } from "./evals-reading-support.ts";
import { answer, evalFixture } from "./evals-support.ts";

const SEED =
  "diff --git a/seeded.ts b/seeded.ts\nnew file mode 100644\n--- /dev/null\n+++ b/seeded.ts\n@@ -0,0 +1 @@\n+export const seeded = 1;\n";

/** Implement trials run real gates and grading; under CPU load they outlast Bun's 5s default. */
const GATE_TEST_TIMEOUT_MS = 30_000;

/** A pin pair whose history (and both trees) carry eval datasets next to ordinary changes. */
async function fixture(extra: Record<string, string> = {}) {
  const f = await evalFixture();
  const git = async (...args: string[]) => (await sh(["git", ...args], { cwd: f.source })).stdout.trim();
  const write = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(f.source, path, ".."), { recursive: true });
      writeFileSync(join(f.source, path), content);
    }
  };
  write({
    "evals/review/cases.json": '{"historical":"labels"}',
    "src/a.ts": "export const a = 1;\n",
    "run.sh": "echo",
  });
  await git("add", "-A");
  await git("commit", "-qm", "base with labels");
  const base = await git("rev-parse", "HEAD");
  write({
    "evals/review/cases.json": '{"historical":"labels v2"}',
    "evals/implement/hidden/x.sh": "secret",
    "src/a.ts": "export const a = 2;\n",
    "bin.dat": "\0\x01\x02binary",
    ...extra,
  });
  rmSync(join(f.source, "CURRENT.txt"));
  chmodSync(join(f.source, "run.sh"), 0o755);
  await git("add", "-A");
  // A non-UTF-8 filename (unrepresentable on some filesystems, so staged straight into the index).
  await sh(
    [
      "sh",
      "-c",
      `git update-index --add --cacheinfo "100644,$(git hash-object -w run.sh),$(printf 'raw\\377.txt')"`,
    ],
    {
      cwd: f.source,
    },
  );
  await git("commit", "-qm", "head with labels");
  const head = await git("rev-parse", "HEAD");
  await git("push", "-q", f.cache, "HEAD:refs/heads/snap");
  writeFileSync(join(f.home, "seed.patch"), SEED);
  const item: ReviewCase = structuredClone({ ...reviewCase, base, head });
  const saveCases = (role: string, cases: unknown[]) =>
    writeFileSync(f.casePath, JSON.stringify({ role, version: 1, cases }));
  return { ...f, git, base, head, item, saveCases };
}

/** Everything the candidate could reach through git in `cwd`. */
async function exposure(cwd: string, pins: string[]) {
  const git = async (...args: string[]) => (await sh(["git", ...args], { cwd, allowFail: true })).stdout;
  expect(existsSync(join(cwd, "evals"))).toBe(false);
  expect(await git("for-each-ref")).toBe("");
  expect(await git("remote")).toBe("");
  const objects = await git("rev-list", "--all", "--objects", "--reflog");
  expect(objects).not.toMatch(/ evals(\/|$)/m);
  expect(await git("log", "--all", "-p")).not.toContain("labels");
  for (const pin of pins)
    expect((await sh(["git", "cat-file", "-e", pin], { cwd, allowFail: true })).exitCode).not.toBe(0);
  return (await git("log", "--format=%s", "HEAD")).trim().split("\n");
}

test("snapshot commits are deterministic, neutral and preserve the non-eval diff exactly", async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const labels = { paths: ["evals/review"], contents: [] };
  try {
    await expect(
      createEvalWorktree(
        f.cfg.paths,
        f.factory.store,
        "fixture/repo",
        f.base,
        f.head,
        join(f.home, "plain"),
        signal,
        labels,
      ),
    ).rejects.toThrow("pinned history contains eval labels");
    const snapshots: string[][] = [];
    for (const name of ["one", "two"]) {
      const cwd = join(f.home, name);
      const checkout = await createEvalWorktree(
        f.cfg.paths,
        f.factory.store,
        "fixture/repo",
        f.base,
        f.head,
        cwd,
        signal,
        labels,
        true,
      );
      const git = async (...args: string[]) => (await sh(["git", ...args], { cwd })).stdout;
      expect(await exposure(cwd, [f.base, f.head])).toEqual(["Snapshot head", "Snapshot base"]);
      expect((await git("rev-list", "--count", "HEAD")).trim()).toBe("2");
      expect((await git("rev-parse", "HEAD^")).trim()).toBe(checkout.base);
      expect(await git("diff", "--binary", "--full-index", checkout.base, "HEAD")).toBe(
        (
          await sh(
            ["git", "diff", "--binary", "--full-index", f.base, f.head, "--", ".", ":(exclude)evals"],
            {
              cwd: f.source,
            },
          )
        ).stdout,
      );
      expect(await git("diff", checkout.base, "HEAD", "--", "run.sh")).toContain("new mode 100755");
      expect(await git("ls-tree", "--name-only", "HEAD")).toContain('"raw\\377.txt"');
      // Identity, dates, message and headers are fixed, so each commit hash depends only on its tree.
      const identity = "Limitless <limitless@localhost> 1000000000 +0000";
      for (const [rev, message] of [
        ["HEAD", "Snapshot head"],
        [checkout.base, "Snapshot base"],
      ] as const)
        expect((await git("cat-file", "commit", rev)).replace(/^(tree|parent) [0-9a-f]{40}\n/gm, "")).toBe(
          `author ${identity}\ncommitter ${identity}\n\n${message}\n`,
        );
      snapshots.push([
        checkout.base,
        (await git("rev-parse", `${checkout.base}^{tree}`)).trim(),
        (await git("rev-parse", "HEAD^{tree}")).trim(),
      ]);
      await checkout();
      expect(existsSync(cwd)).toBe(false);
    }
    expect(snapshots[0]).toEqual(snapshots[1] ?? []);
    expect(readdirSync(f.home).filter((p) => p.endsWith(".snapshot"))).toEqual([]);
  } finally {
    await f.close();
  }
});

test("review snapshot: plain mode rejects the pin; snapshot reaches the candidate with seeded HEAD", async () => {
  const f = await fixture();
  try {
    f.saveCases("review", [f.item]);
    const plain = await f.run({ role: "review", models: ["candidate-a"], k: 1 });
    expect(String(plain.trials[0]?.details.reason)).toContain("pinned history contains eval labels");
    expect(f.calls).toHaveLength(0);
    f.saveCases("review", [{ ...f.item, snapshot: true, kind: "seeded", seedPatch: "seed.patch" }]);
    f.respond(async (s) => {
      expect(await exposure(s.cwd, [f.base, f.head])).toEqual([
        "Eval seed",
        "Snapshot head",
        "Snapshot base",
      ]);
      const base = (await sh(["git", "rev-parse", "HEAD~2"], { cwd: s.cwd })).stdout.trim();
      expect(s.prompt).toContain(base);
      expect(s.prompt).not.toContain(f.base);
      const diff = (await sh(["git", "diff", "--name-only", `${base}..HEAD`], { cwd: s.cwd })).stdout;
      expect(diff.trim().split("\n").sort()).toEqual([
        '"raw\\377.txt"',
        "CURRENT.txt",
        "bin.dat",
        "run.sh",
        "seeded.ts",
        "src/a.ts",
      ]);
      return { structured: reviewOutput(10, "major") };
    });
    const report = await f.run({ role: "review", models: ["candidate-a"], k: 1 });
    expect(report.trials[0]).toMatchObject({ status: "ok", pass: true });
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("verify snapshot prompts name the snapshot base", async () => {
  const f = await fixture();
  try {
    const verify = JSON.parse(readFileSync(new URL("./data/evals-verify.json", import.meta.url), "utf8"));
    f.saveCases("verify", [{ ...verify.cases[2], base: f.base, head: f.head, snapshot: true }]);
    let spec: AgentSpec | undefined;
    f.respond(async (s) => {
      spec = s;
      expect(await exposure(s.cwd, [f.base, f.head])).toEqual(["Snapshot head", "Snapshot base"]);
      expect(s.prompt).toContain((await sh(["git", "rev-parse", "HEAD^"], { cwd: s.cwd })).stdout.trim());
      return { structured: { criteria: [], verdict: "fail", summary: "x" } };
    });
    await f.run({ role: "verify", models: ["candidate-a"], k: 1 });
    expect(spec?.prompt).not.toContain(f.base);
  } finally {
    await f.close();
  }
});

test("triage snapshot lists the sanitized tree and keeps plain and snapshot cache entries apart", async () => {
  const f = await fixture();
  try {
    f.dataset.repos["fixture/repo"] = f.head;
    f.dataset.cases = f.dataset.cases.slice(0, 1);
    f.save();
    const run = () => f.run({ models: ["candidate-a"], k: 1 });
    await run();
    expect(f.calls[0]?.prompt).toContain("evals");
    const [first] = f.dataset.cases;
    if (!first) throw new Error("fixture");
    first.snapshot = true;
    f.save();
    f.respond((s) => {
      expect(readdirSync(s.cwd)).toEqual([]);
      return { structured: answer };
    });
    const snapshot = await run();
    expect(snapshot.summaries[0]?.cached).toBe(0);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]?.prompt).not.toMatch(/\bevals\b/);
    expect(f.calls[1]?.prompt).toContain("bin.dat");
    const cwd = join(f.home, "triage");
    const checkout = await createEvalWorktree(
      f.cfg.paths,
      f.factory.store,
      "fixture/repo",
      f.head,
      f.head,
      cwd,
      new AbortController().signal,
      { paths: ["evals/review"], contents: [] },
      true,
    );
    expect(await exposure(cwd, [f.head])).toEqual(["Snapshot head", "Snapshot base"]);
    expect((await sh(["git", "rev-parse", "HEAD^"], { cwd })).stdout.trim()).toBe(checkout.base);
    await checkout();
    expect((await run()).summaries[0]?.cached).toBe(1);
    expect(readdirSync(f.cfg.paths.runs).filter((p) => p.startsWith("eval-"))).toEqual([]);
  } finally {
    await f.close();
  }
});

test("snapshot still rejects exact label contents kept outside evals/, before invoking", async () => {
  const f = await fixture({ "docs/seed-copy.patch": SEED });
  try {
    f.saveCases("review", [{ ...f.item, snapshot: true, kind: "seeded", seedPatch: "seed.patch" }]);
    const report = await f.run({ role: "review", models: ["candidate-a"], k: 1 });
    expect(report.trials[0]).toMatchObject({ status: "error", pass: false });
    expect(String(report.trials[0]?.details.reason)).toContain("eval dataset or seed patch");
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("review snapshot never reuses plain-mode cached output", async () => {
  const f = await evalFixture();
  try {
    const head = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
    const item = { ...structuredClone(reviewCase), base: f.sha, head };
    const run = (snapshot?: boolean) => {
      writeFileSync(
        f.casePath,
        JSON.stringify({ role: "review", version: 1, cases: [{ ...item, snapshot }] }),
      );
      return f.run({ role: "review", models: ["candidate-a"], k: 1 });
    };
    f.respond(() => ({ structured: reviewOutput() }));
    await run();
    expect((await run(true)).summaries[0]?.cached).toBe(0);
    expect((await run(true)).summaries[0]?.cached).toBe(1);
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test(
  "implement snapshot starts from the sanitized base without the solution or hidden files",
  async () => {
    const f = await fixture({ solution: "secret solution" });
    try {
      const item: ImplementCase = {
        id: "one",
        repo: "fixture/repo",
        base: f.base,
        head: f.head,
        snapshot: true,
        prompt: "Create answer containing correct",
        complexity: "small",
        spec: null,
        source: "fixture",
        tags: [],
        hidden: { files: ["check.sh"], command: "sh check.sh", timeoutSec: 5 },
      };
      mkdirSync(join(f.home, "hidden", item.id), { recursive: true });
      writeFileSync(join(f.home, "hidden", item.id, "check.sh"), 'test "$(cat answer)" = correct\n');
      f.saveCases("implement", [item]);
      let base = "";
      f.respond(async (s) => {
        if (base) {
          // Recovery prompts point at the snapshot base, never the original pin.
          expect(s.prompt).toContain(`git diff ${base}..HEAD`);
          return { files: { answer: "correct" }, text: "Implemented" };
        }
        // Implement pins both trees to base, so the reference head never enters the snapshot.
        expect(await exposure(s.cwd, [f.base, f.head])).toEqual(["Snapshot head", "Snapshot base"]);
        expect((await sh(["git", "diff", "HEAD^", "HEAD"], { cwd: s.cwd })).stdout).toBe("");
        for (const path of ["solution", "check.sh", "bin.dat"])
          expect(existsSync(join(s.cwd, path))).toBe(false);
        expect(readFileSync(join(s.cwd, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
        base = (await sh(["git", "rev-parse", "HEAD^"], { cwd: s.cwd })).stdout.trim();
        return { files: { answer: "wrong" }, text: "Implemented" };
      });
      const report = await f.run({ role: "implement", models: ["candidate-a"], k: 1, rounds: 2 });
      expect(report.trials[0]).toMatchObject({ status: "ok", pass: true, details: { roundsUsed: 2 } });
      expect(f.calls).toHaveLength(2);
      expect(f.calls.every((s) => !s.prompt.includes(f.base))).toBe(true);
    } finally {
      await f.close();
    }
  },
  GATE_TEST_TIMEOUT_MS,
);

test(
  "implement snapshot fails preparation when a baseline check reads evals/; plain mode is unaffected",
  async () => {
    const f = await evalFixture();
    try {
      writeFileSync(
        join(f.source, ".limitless.toml"),
        '[gates]\nchecks = [{ name = "reads-evals", run = "test -f evals/data.txt" }]\n',
      );
      mkdirSync(join(f.source, "evals"));
      writeFileSync(join(f.source, "evals/data.txt"), "fixture data the test suite reads");
      await sh(["git", "add", "-A"], { cwd: f.source });
      await sh(["git", "commit", "-qm", "checks read evals"], { cwd: f.source });
      const base = (await sh(["git", "rev-parse", "HEAD"], { cwd: f.source })).stdout.trim();
      await sh(["git", "push", "-q", f.cache, "HEAD:refs/heads/reads-evals"], { cwd: f.source });
      const item: ImplementCase = {
        id: "one",
        repo: "fixture/repo",
        base,
        head: base,
        prompt: "Create answer containing correct",
        complexity: "small",
        spec: null,
        source: "fixture",
        tags: [],
        hidden: { files: ["check.sh"], command: "sh check.sh", timeoutSec: 5 },
      };
      mkdirSync(join(f.home, "hidden", item.id), { recursive: true });
      writeFileSync(join(f.home, "hidden", item.id, "check.sh"), 'test "$(cat answer)" = correct\n');
      f.respond(() => ({ files: { answer: "correct" }, text: "Implemented" }));
      const run = (snapshot: boolean) => {
        writeFileSync(
          f.casePath,
          JSON.stringify({ role: "implement", version: 1, cases: [{ ...item, snapshot }] }),
        );
        return f.run({ role: "implement", models: ["candidate-a"], k: 1 });
      };
      expect((await run(false)).trials[0]).toMatchObject({ status: "ok", pass: true });
      expect(f.calls).toHaveLength(1);
      const [trial] = (await run(true)).trials;
      expect(trial).toMatchObject({ status: "error", pass: false, details: { preparationFailed: true } });
      expect(String(trial?.details.reason)).toContain(
        "snapshot mode removed evals/ and baseline check reads-evals fails; this case can't use snapshot mode",
      );
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  GATE_TEST_TIMEOUT_MS,
);

test("triage snapshot fetches a pin reachable only from a tag, by exact SHA", async () => {
  const f = await evalFixture();
  const git = async (...args: string[]) => (await sh(["git", ...args], { cwd: f.source })).stdout.trim();
  try {
    writeFileSync(join(f.source, "tag-only.txt"), "x");
    await git("add", "-A");
    await git("commit", "-qm", "tag only");
    f.dataset.repos["fixture/repo"] = await git("rev-parse", "HEAD");
    await git("tag", "v1");
    await git("reset", "-q", "--hard", "HEAD^");
    for (const item of f.dataset.cases) item.snapshot = true;
    f.save();
    const report = await f.run({ models: ["candidate-a"], k: 1 });
    expect(report.run.status).toBe("completed");
    expect(report.trials.map((t) => t.status)).toEqual(["ok", "ok", "ok"]);
    expect(f.calls.every((s) => s.prompt.includes("tag-only.txt"))).toBe(true);
  } finally {
    await f.close();
  }
});

for (const snapshot of [false, true])
  test(`triage missing pin fails only its own cases (snapshot: ${snapshot})`, async () => {
    const f = await evalFixture();
    try {
      // A second local cache, so the failed fetch never reaches the network.
      await sh(["git", "clone", "-q", "--bare", f.source, join(f.cfg.paths.repos, "fixture__other.git")], {
        cwd: f.home,
      });
      const missing = "f".repeat(40);
      f.dataset.repos["fixture/other"] = missing;
      f.dataset.cases = f.dataset.cases.map((item) => ({
        ...item,
        snapshot,
        ...(item.id === "c" ? { repo: "fixture/other" } : {}),
      }));
      f.save();
      const report = await f.run({ models: ["candidate-a"], k: 1 });
      expect(report.run.status).toBe("completed");
      const byCase = Object.fromEntries(report.trials.map((t) => [t.caseId, t]));
      expect(byCase.a?.status).toBe("ok");
      expect(byCase.b?.status).toBe("ok");
      expect(byCase.c).toMatchObject({ status: "error", pass: false, details: { preparationFailed: true } });
      expect(String(byCase.c?.details.reason)).toContain(missing);
      expect(f.calls).toHaveLength(2);
      expect(readdirSync(f.cfg.paths.runs).filter((p) => p.startsWith("eval-"))).toEqual([]);
    } finally {
      await f.close();
    }
  });
