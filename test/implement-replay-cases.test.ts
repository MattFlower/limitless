import { expect, setDefaultTimeout, spyOn } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  generateReplayCases,
  replayArguments,
  replayProduction,
  replayRequest,
} from "../scripts/implement-replay-cases.ts";
import type { Invocation, Run } from "../src/core/types.ts";
import { hiddenContents, ImplementCaseFileSchema, loadRoleCases } from "../src/evals/cases.ts";
import { gradeImplement } from "../src/evals/implement.ts";
import { prepareImplementCase } from "../src/evals/prepare.ts";
import { createEvalWorktreeFromCache } from "../src/git/repos.ts";
import { confinementScope } from "../src/harness/sandbox.ts";
import type { GhRunner } from "../src/integrations/github.ts";
import { type ReportInput, renderReport } from "../src/pipeline/report.ts";
import * as proc from "../src/util/proc.ts";
import { sh } from "../src/util/proc.ts";
import { recordingConfinement } from "./confinement.ts";
import { test } from "./read-policy-support.ts";
import { seeded } from "./seeded.ts";

setDefaultTimeout(60_000);
const repo = "fixture/replay";
const prompt = "Repair answer.\n\n  Preserve indentation.\n> nested quote\n";
const invocation: Invocation = {
  id: 1,
  runId: "r1",
  stageId: 1,
  role: "implement",
  harness: "codex",
  provider: "codex",
  model: "gpt-6.1-sol",
  modelId: "codex/sol-6.1",
  effort: null,
  status: "ok",
  fast: false,
  fastModeState: null,
  fastModeDisabledReason: null,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  costEquivUsd: 0,
  numTurns: 1,
  waitMs: 0,
  sessionId: null,
  error: null,
  startedAt: 0,
  finishedAt: 1,
};
const report: ReportInput = {
  success: true,
  runId: "r1",
  prompt,
  state: { lastReview: { modelId: "reviewer", verdict: "approve", summary: "Reviewed", findings: [] } },
  models: { implement: ["configured/unused"] },
  invocations: [
    invocation,
    { ...invocation, role: "review", modelId: "reviewer" },
    { ...invocation, harness: "claude", provider: "claude", modelId: "claude/opus" },
    { ...invocation, role: "review", modelId: "reviewer" },
    { ...invocation, role: "review_shadow", modelId: "shadow" },
  ],
  totals: { costUsd: 0, costEquivUsd: 0 },
  runUrl: "https://example.com/runs/r1",
};
const body = renderReport(report);
const changed = "test/modified.test.ts";
const added = "test/added 'quoted'.test.ts";
const renamed = "test/renamed.test.ts";
const paths = [added, changed, renamed];
const testSource = (expected: number, title = "answer and setup") =>
  `import { expect, test } from 'bun:test';\nimport { answer } from '../answer.ts';\nimport { readFileSync } from 'node:fs';\ntest('${title}', () => { expect(answer).toBe(${expected}); expect(readFileSync('setup-output/ready', 'utf8')).toBe('ready'); });\n`;

const kinds = [
  "valid",
  "base-pass",
  "head-fail",
  "setup-failure",
  "timeout",
  "no-tests",
  "snapshot-failure",
  "load-error",
  "contaminated",
  "fresh-setup",
  "untracked-ready",
  "misleading-title",
  "batch-first",
  "batch-second",
  "gate-failure",
  "audit-failure",
];
const seed = seeded(async (root) => {
  const source = join(root, "source");
  mkdirSync(source);
  const git = async (...args: string[]) => (await sh(["git", ...args], { cwd: source })).stdout.trim();
  await git("init", "-q", "-b", "main");
  const commits: Record<string, { base: string; head: string }> = {};
  mkdirSync(join(source, "evals/implement"), { recursive: true });
  writeFileSync(join(source, "evals/implement/cases.json"), '{"labels":"fixture history"}');
  writeFileSync(join(source, ".gitignore"), "setup-output/\n");
  for (const kind of kinds) {
    rmSync(join(source, "test"), { recursive: true, force: true });
    mkdirSync(join(source, "test"));
    writeFileSync(join(source, "answer.ts"), `export const answer = ${kind === "base-pass" ? 42 : 0};\n`);
    writeFileSync(
      join(source, ".limitless.toml"),
      `[gates]\nsetup = ["${kind === "setup-failure" ? "false" : kind === "untracked-ready" ? "printf ready > ready" : kind === "fresh-setup" ? "mkdir setup-output && printf ready > setup-output/ready" : "mkdir -p setup-output && printf ready > setup-output/ready"}"]\n${kind === "snapshot-failure" ? 'checks = [{ name = "reads-evals", run = "test -f evals/implement/cases.json" }]\n' : kind === "gate-failure" ? 'checks = [{ name = "gate", run = "test ! -f broken-gate" }]\n' : kind === "audit-failure" ? '[policy]\nprotected_paths = ["answer.ts"]\n' : ""}`,
    );
    if (kind === "load-error") rmSync(join(source, "answer.ts"));
    rmSync(join(source, "leaked.ts"), { force: true });
    rmSync(join(source, "broken-gate"), { force: true });
    if (kind === "batch-first")
      writeFileSync(join(source, "leaked.ts"), `${testSource(42)}// batch second label\n`);
    if (kind === "contaminated") writeFileSync(join(source, "leaked.ts"), testSource(42));
    writeFileSync(join(source, changed), testSource(0));
    writeFileSync(
      join(source, "test/modified.test.ts-extra.test.ts"),
      "throw new Error('Unselected test ran');\n",
    );
    writeFileSync(join(source, "test/old.test.ts"), testSource(0));
    writeFileSync(join(source, "test/deleted.test.ts"), testSource(0));
    await git("add", "-A");
    await git("commit", "-qm", `${kind} base`);
    const base = await git("rev-parse", "HEAD");
    writeFileSync(join(source, "answer.ts"), "export const answer = 42;\n");
    if (kind !== "no-tests") {
      for (const path of paths)
        writeFileSync(
          join(source, path),
          kind === "timeout"
            ? "import { test } from 'bun:test'; test('wait', async () => { await Bun.sleep(60000); });\n"
            : kind === "untracked-ready"
              ? testSource(42).replace("setup-output/ready", "ready")
              : kind === "misleading-title"
                ? testSource(42, "Cannot find module error handling")
                : kind === "batch-second"
                  ? `${testSource(42)}// batch second label\n`
                  : testSource(kind === "head-fail" ? 43 : 42),
        );
      rmSync(join(source, "test/old.test.ts"));
      rmSync(join(source, "test/deleted.test.ts"));
    }
    if (kind === "gate-failure") writeFileSync(join(source, "broken-gate"), "broken");
    writeFileSync(join(source, "test/helper.ts"), "// unrelated\n");
    writeFileSync(join(source, "unrelated.ts"), `// ${kind}\n`);
    // Proves that setup for both worktrees is selected from the base, even at head.
    writeFileSync(join(source, ".limitless.toml"), '[gates]\nsetup = ["false"]\n');
    await git("add", "-A");
    await git("commit", "-qm", `${kind} squash`);
    commits[kind] = { base, head: await git("rev-parse", "HEAD") };
  }
  await sh(["git", "clone", "--bare", source, join(root, "cache.git")], { cwd: root });
  await sh(["git", "update-ref", "refs/remotes/origin/main", "refs/heads/main"], {
    cwd: join(root, "cache.git"),
  });
  return commits;
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "replay-cases-test-"));
  const { value: commits } = await seed(root);
  const cache = join(root, "cache.git");
  const casePath = join(root, "dataset/cases.json");
  const original = ImplementCaseFileSchema.shape.cases.element.parse({
    id: "impl-00999",
    repo,
    ...commits.valid,
    complexity: "small",
    prompt: "existing",
    spec: null,
    source: `https://github.com/${repo}/pull/88 (squash annotation)`,
    tags: ["existing"],
    hidden: { files: [], command: "true", timeoutSec: 1 },
  });
  mkdirSync(dirname(casePath));
  writeFileSync(
    casePath,
    JSON.stringify({ role: "implement", version: 1, notes: "Keep envelope metadata", cases: [original] }),
  );
  const responses = new Map<
    number,
    { body: string; url: string; state: string; mergeCommit: { oid: string } | null }
  >();
  for (const [index, kind] of kinds.entries())
    responses.set(index + 1, {
      body,
      url: `https://github.com/${repo}/pull/${index + 1}`,
      state: "MERGED",
      mergeCommit: { oid: commits[kind]?.head ?? "" },
    });
  const gh: GhRunner = async (args) => {
    if (args[0] === "repo") return JSON.stringify({ defaultBranchRef: { name: "main" } });
    const response = responses.get(Number(args[2]));
    if (!response) throw new Error(`Unexpected GitHub call: ${args.join(" ")}`);
    return JSON.stringify(response);
  };
  const recording = recordingConfinement();
  // Nested fixture tests use the current toolchain, outside agent CLI slot wrappers.
  recording.backend.wrap = (cmd) => [
    "/usr/bin/env",
    `PATH=${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    ...cmd,
  ];
  return {
    root,
    cache,
    casePath,
    commits,
    responses,
    original,
    calls: recording.calls,
    backend: recording.backend,
    run: (prs: number[], timeoutSec?: number, complexity: Run["complexity"] = "small") =>
      confinementScope.run(recording.backend, () =>
        generateReplayCases(
          { repo, prs },
          {
            gh,
            casePath,
            cache: async () => cache,
            timeoutSec,
            lookupRun: async (id) => {
              expect(id).toBe("r1");
              return { complexity };
            },
          },
        ),
      ),
    read: () => ImplementCaseFileSchema.parse(JSON.parse(readFileSync(casePath, "utf8"))),
    async clean() {
      const trees = await sh(["git", "worktree", "list", "--porcelain"], { cwd: cache });
      expect(trees.stdout.match(/^worktree /gm)).toHaveLength(1);
      expect(existsSync(join(cache, "worktrees")) ? readdirSync(join(cache, "worktrees")) : []).toEqual([]);
      for (const { opts } of recording.calls) expect(existsSync(opts.cwd)).toBe(false);
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("squash replay preserves request, all hidden bytes, production evidence and IDs; duplicates stay untouched", async () => {
  const f = await fixture();
  try {
    const rows = await f.run([1, 1, 88]);
    expect(rows.map((r) => r.reason)).toEqual(["accepted", "duplicate PR; skipped", "duplicate PR; skipped"]);
    expect(rows[0]).toMatchObject({
      case: "impl-01000",
      base: "fail",
      head: "pass",
      baseFailure: "assertion-failure",
    });
    const file = f.read();
    expect(file.notes).toBe("Keep envelope metadata");
    expect(file.cases[0]).toEqual(f.original);
    const item = file.cases[1];
    expect(item).toMatchObject({
      ...f.commits.valid,
      id: "impl-01000",
      prompt,
      snapshot: true,
      spec: null,
      complexity: "small",
      source: `https://github.com/${repo}/pull/1`,
      hidden: { files: paths },
    });
    expect(item?.tags).toEqual(["replay", "replay-v2", "needs_human:false", "review-rounds:2"]);
    expect(item?.notes).toContain("codex/sol-6.1, claude/opus");
    expect(item?.notes).toContain("run record r1");
    expect(item?.notes).toContain("review rounds: 2 (Work log review rows)");
    expect(item?.notes).not.toContain("configured/unused");
    expect(item?.hidden.command).toBe(
      "bun test './test/added '\\''quoted'\\''.test.ts' './test/modified.test.ts' './test/renamed.test.ts'",
    );
    for (const path of paths)
      expect(readFileSync(join(dirname(f.casePath), "hidden/impl-01000", path))).toEqual(
        Buffer.from(testSource(42)),
      );
    expect(loadRoleCases("implement", f.casePath).cases).toHaveLength(2);
    await sh(
      [join(process.cwd(), "node_modules/.bin/biome"), "check", "--config-path", process.cwd(), f.casePath],
      { cwd: process.cwd() },
    );
    if (!item) throw new Error("Missing generated case");
    const cwd = join(f.root, "prepared");
    const signal = new AbortController().signal;
    const checkout = (base: string, snapshot: boolean) =>
      createEvalWorktreeFromCache(
        f.cache,
        base,
        base,
        cwd,
        signal,
        {
          paths: ["evals/implement"],
          contents: [
            readFileSync(f.casePath),
            ...hiddenContents(item, f.casePath).map((file) => file.content),
          ],
        },
        snapshot,
      );
    await expect(prepareImplementCase({ ...item, snapshot: false }, cwd, signal, checkout)).rejects.toThrow(
      "pinned history contains eval labels",
    );
    const candidate = await confinementScope.run(f.backend, () =>
      prepareImplementCase(item, cwd, signal, checkout),
    );
    try {
      expect(candidate.effective.base).not.toBe(item.base);
      expect(readFileSync(join(cwd, "answer.ts"), "utf8")).toContain("answer = 0");
      expect(existsSync(join(cwd, "evals"))).toBe(false);
      expect(existsSync(join(cwd, added))).toBe(false);
      expect((await sh(["git", "cat-file", "-e", item.head], { cwd, allowFail: true })).exitCode).not.toBe(0);
      const reference = join(f.root, "reference");
      const cleanup = await createEvalWorktreeFromCache(
        f.cache,
        item.base,
        item.head,
        reference,
        signal,
        { paths: ["evals/implement"], contents: [] },
        true,
      );
      try {
        const grade = await confinementScope.run(f.backend, () =>
          gradeImplement(
            candidate.effective,
            reference,
            hiddenContents(item, f.casePath),
            candidate.prepared,
            [],
            signal,
          ),
        );
        expect(grade.pass).toBe(true);
      } finally {
        await cleanup();
      }
    } finally {
      await candidate.cleanup();
    }
    const before = readFileSync(f.casePath);
    expect((await f.run([1]))[0]?.reason).toContain("duplicate");
    expect(readFileSync(f.casePath)).toEqual(before);
    for (const path of paths)
      expect(readFileSync(join(dirname(f.casePath), "hidden/impl-01000", path))).toEqual(
        Buffer.from(testSource(42)),
      );
    await f.clean();
  } finally {
    f.close();
  }
});

test("setup that creates an ignored directory runs in fresh preparation, base and head checkouts", async () => {
  const f = await fixture();
  try {
    const rows = await f.run([10]);
    expect(rows[0]).toMatchObject({
      base: "fail",
      head: "pass",
      baseFailure: "assertion-failure",
      reason: "accepted",
    });
    expect(f.read().cases[1]).toMatchObject({ ...f.commits["fresh-setup"], snapshot: true });
    await f.clean();
  } finally {
    f.close();
  }
});

test("grading cleans setup-created untracked files and reports the reference failure without publication", async () => {
  const f = await fixture();
  try {
    const before = readFileSync(f.casePath);
    const [row] = await f.run([11]);
    expect(row).toMatchObject({ base: "fail", head: "fail" });
    expect(row?.reason).toContain("excluded");
    expect(row?.reason).toContain("hidden_tests");
    expect(row?.reason).toContain("ENOENT");
    expect(row?.reason).toContain("ready");
    expect(readFileSync(f.casePath)).toEqual(before);
    expect(existsSync(join(dirname(f.casePath), "hidden"))).toBe(false);
    await f.clean();
  } finally {
    f.close();
  }
});

test.each([
  [13, 14],
  [14, 13],
])("batch contamination checks include later labels in PR order %j", async (first, second) => {
  const f = await fixture();
  try {
    const rows = await f.run([first, second]);
    expect(rows.find((row) => row.pr === 13)?.reason).toContain(
      "pinned history contains an eval dataset or seed patch",
    );
    expect(rows.find((row) => row.pr === 14)?.reason).toBe("accepted");
    const dataset = f.read();
    expect(dataset.cases).toHaveLength(2);
    const added = dataset.cases.slice(1);
    expect(readdirSync(join(dirname(f.casePath), "hidden"))).toEqual(added.map((item) => item.id));
    for (const item of added) {
      const cwd = join(f.root, "completed-dataset");
      const signal = new AbortController().signal;
      const { cleanup } = await confinementScope.run(f.backend, () =>
        prepareImplementCase(item, cwd, signal, (base, snapshot) =>
          createEvalWorktreeFromCache(
            f.cache,
            base,
            base,
            cwd,
            signal,
            {
              paths: ["evals/implement"],
              contents: [
                readFileSync(f.casePath),
                ...dataset.cases.flatMap((entry) =>
                  hiddenContents(entry, f.casePath).map((file) => file.content),
                ),
              ],
            },
            snapshot,
          ),
        ),
      );
      await cleanup();
    }
    await f.clean();
  } finally {
    f.close();
  }
});

test("reference gate and audit failures retain runner evidence and permit unrelated valid cases", async () => {
  const f = await fixture();
  try {
    const rows = await f.run([15, 16, 1]);
    expect(rows[0]?.reason).toContain('"reason":"gates"');
    expect(rows[0]?.reason).toContain("regressed");
    expect(rows[1]?.reason).toContain('"reason":"audit"');
    expect(rows[1]?.reason).toContain("protected-path");
    expect(rows[2]?.reason).toBe("accepted");
    expect(f.read().cases).toHaveLength(2);
    expect(readdirSync(join(dirname(f.casePath), "hidden"))).toEqual(["impl-01000"]);
    await f.clean();
  } finally {
    f.close();
  }
});

test("base-pass, head-fail and setup failures are exclusions and do not suppress a valid PR", async () => {
  const f = await fixture();
  try {
    const rows = await f.run([2, 3, 4, 1]);
    expect(rows.map((r) => [r.base, r.head])).toEqual([
      ["pass", "pass"],
      ["fail", "fail"],
      ["not-run", "not-run"],
      ["fail", "pass"],
    ]);
    for (const row of rows.slice(0, 3)) expect(row.reason).toContain("excluded");
    expect(rows[2]?.reason).toContain("baseline gate setup failed");
    expect(f.read().cases).toHaveLength(2);
    expect(readdirSync(join(dirname(f.casePath), "hidden"))).toEqual(["impl-01000"]);
    await f.clean();
  } finally {
    f.close();
  }
});

test("snapshot baseline and contamination exclusions clean up and permit a later valid PR", async () => {
  const f = await fixture();
  try {
    const before = readFileSync(f.casePath);
    const rows = await f.run([7, 9]);
    expect(rows[0]?.reason).toContain("snapshot mode removed evals/ and baseline check reads-evals fails");
    expect(rows[1]?.reason).toContain("pinned history contains an eval dataset or seed patch");
    expect(rows.every((row) => row.base === "not-run" && row.head === "not-run")).toBe(true);
    expect(readFileSync(f.casePath)).toEqual(before);
    expect(existsSync(join(dirname(f.casePath), "hidden"))).toBe(false);
    await f.clean();
    const continued = await f.run([7, 1]);
    expect(continued[0]?.reason).toContain("baseline check reads-evals fails");
    expect(continued[1]?.reason).toBe("accepted");
    expect(f.read().cases).toHaveLength(2);
    expect(readdirSync(join(dirname(f.casePath), "hidden"))).toEqual(["impl-01000"]);
    await f.clean();
  } finally {
    f.close();
  }
});

test("only Bun loader diagnostics classify base failures as load errors", async () => {
  const f = await fixture();
  try {
    const rows = await f.run([8, 12]);
    expect(rows[0]).toMatchObject({
      base: "fail",
      head: "pass",
      baseFailure: "load-error",
      reason: "accepted",
    });
    expect(f.read().cases[1]?.tags).toContain("base-load-error");
    expect(f.read().cases[1]?.tags).toContain("replay-v2");
    expect(rows[1]).toMatchObject({
      base: "fail",
      head: "pass",
      baseFailure: "assertion-failure",
      reason: "accepted",
    });
    expect(f.read().cases[2]?.tags).not.toContain("base-load-error");
    await f.clean();
  } finally {
    f.close();
  }
});

test("formatter failure excludes publication and leaves original dataset bytes intact", async () => {
  const f = await fixture();
  const original = proc.sh;
  const format = spyOn(proc, "sh").mockImplementation((cmd, opts) => {
    if (cmd[0]?.endsWith("/biome")) throw new Error("fixture formatter failure");
    return original(cmd, opts);
  });
  try {
    const before = readFileSync(f.casePath);
    expect((await f.run([1]))[0]?.reason).toContain("dataset formatter failed: fixture formatter failure");
    expect(readFileSync(f.casePath)).toEqual(before);
    expect(existsSync(join(dirname(f.casePath), "hidden/impl-01000"))).toBe(false);
    expect(readdirSync(dirname(f.casePath)).sort()).toEqual(["cases.json"]);
    await f.clean();
  } finally {
    format.mockRestore();
    f.close();
  }
});

test("a real hidden-command timeout cannot count as a base failure and publishes nothing", async () => {
  const f = await fixture();
  try {
    const before = readFileSync(f.casePath);
    const rows = await f.run([5], 0.05);
    expect(rows[0]).toMatchObject({ base: "timeout", head: "timeout" });
    expect(rows[0]?.reason).toContain("excluded");
    expect(readFileSync(f.casePath)).toEqual(before);
    expect(existsSync(join(dirname(f.casePath), "hidden"))).toBe(false);
    await f.clean();
  } finally {
    f.close();
  }
});

test("missing Request, unmerged PRs, no tests, missing commits and unsupported run complexity are refused before validation", async () => {
  const f = await fixture();
  try {
    const valid = f.responses.get(1);
    if (!valid) throw new Error("Missing fixture PR");
    f.responses.set(7, { ...valid, body: "## Summary\nNo request" });
    f.responses.set(8, { ...valid, state: "OPEN", mergeCommit: null });
    f.responses.set(9, valid);
    f.responses.set(10, { ...valid, mergeCommit: { oid: "0".repeat(40) } });
    const before = readFileSync(f.casePath);
    const rows = [...(await f.run([7, 8, 6, 10])), ...(await f.run([9], undefined, "large"))];
    expect(rows[0]?.reason).toContain("Request");
    expect(rows[1]?.reason).toContain("merged");
    expect(rows[2]?.reason).toContain("No qualifying test");
    expect(rows[3]?.reason).toContain("failed");
    expect(rows[4]?.reason).toContain("complexity");
    expect(rows.every((r) => r.base === "not-run" && r.head === "not-run")).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect(readFileSync(f.casePath)).toEqual(before);
    expect(existsSync(join(dirname(f.casePath), "hidden"))).toBe(false);
  } finally {
    f.close();
  }
});

test("a hidden command that cannot launch is operational, with both results not-run and no publication", async () => {
  const f = await fixture();
  try {
    const wrap = f.backend.wrap;
    f.backend.wrap = (cmd, roots) =>
      wrap(
        cmd.map((arg) => (arg.startsWith("bun test ") ? "exec missing-replay-test-command" : arg)),
        roots,
      );
    const before = readFileSync(f.casePath);
    const rows = await f.run([1]);
    expect(rows[0]).toMatchObject({ base: "not-run", head: "not-run" });
    expect(rows[0]?.reason).toContain("hidden_tests");
    expect(rows[0]?.reason).toContain("missing-replay-test-command");
    expect(readFileSync(f.casePath)).toEqual(before);
    expect(existsSync(join(dirname(f.casePath), "hidden"))).toBe(false);
    await f.clean();
  } finally {
    f.close();
  }
});

test("absent production fields stay unknown, use medium, and preserve needs_human evidence", async () => {
  const f = await fixture();
  try {
    const valid = f.responses.get(1);
    if (!valid) throw new Error("Missing fixture PR");
    f.responses.set(1, {
      ...valid,
      body: `⚠️ Built by **Limitless** but it **needs a human**: failed checks.\n\n## Request\n\n> Repair answer.\n`,
    });
    expect((await f.run([1]))[0]?.reason).toBe("accepted");
    expect(f.read().cases[1]).toMatchObject({
      complexity: "medium",
      tags: ["replay", "replay-v2", "needs_human:true", "review-rounds:unknown"],
    });
    expect(f.read().cases[1]?.notes).toContain("unknown (default medium)");
    expect(f.read().cases[1]?.notes).toContain("observed implement models: unknown");
    await f.clean();
  } finally {
    f.close();
  }
});

test("panel review ordinals take precedence over Work log invocation counts", async () => {
  const panel = renderReport({
    ...report,
    state: {
      ...report.state,
      reviewHistory: [1, 2, 3].map((panelReview) => ({
        round: panelReview,
        sha: "a".repeat(40),
        blocking: [],
        followUps: [],
        panelReview,
        scope: { kind: "full", range: "base..head" },
      })),
    },
  });
  const metadata = await replayProduction(panel);
  expect(metadata.tags).toContain("review-rounds:3");
  expect(metadata.notes).toContain("review rounds: 3 (highest recorded panel-review ordinal)");
});

test("missing or unavailable run records explicitly default complexity without inventing report evidence", async () => {
  for (const lookup of [
    undefined,
    async () => null,
    async () => ({ complexity: null }),
    async () => {
      throw new Error("Run record unavailable");
    },
  ]) {
    const metadata = await replayProduction(body, lookup);
    expect(metadata.complexity).toBe("medium");
    expect(metadata.notes).toContain("Triage complexity: unknown (default medium)");
    expect(metadata.notes).toContain("r1");
    expect(metadata.notes).toMatch(/lookup not configured|complexity unavailable|lookup unavailable/);
  }
});

test("arguments and quoted Request boundaries are strict without rewriting content", () => {
  expect(replayArguments(["--repo", repo, "--pr", "1,2,1"])).toEqual({ repo, prs: [1, 2, 1] });
  for (const args of [
    [],
    ["--repo", "bad", "--pr", "1"],
    ["--repo", repo, "--pr", "0"],
    ["--repo", repo, "--pr", "1,"],
    ["--repo", repo, "--pr", "1", "extra"],
  ])
    expect(() => replayArguments(args)).toThrow();
  expect(replayRequest(body)).toBe(prompt);
  expect(replayRequest("## Request\n\n> line\r\n> next\r\n> \n\n## Checks\n")).toBe("line\r\nnext\r\n");
  for (const request of [
    "",
    "## Request\n\n> ",
    "## Request\n\nnot quoted",
    "## Request\n\n> ok\nmalformed",
    "## Request\n\n>ok",
  ])
    expect(() => replayRequest(request)).toThrow();
});
