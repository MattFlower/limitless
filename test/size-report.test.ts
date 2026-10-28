import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { statedBudget } from "../src/pipeline/budget.ts";
import type { RunState } from "../src/pipeline/context.ts";
import { renderReport, verifiedFailureState } from "../src/pipeline/report.ts";
import { measureSize, type SizeReport } from "../src/pipeline/size.ts";
import { sh } from "../src/util/proc.ts";
import { seeded } from "./seeded.ts";

const seed = seeded(async (cwd) => {
  await sh(["git", "init", "-qb", "main"], { cwd });
  writeFileSync(join(cwd, "initial"), "initial\n");
  await sh(["git", "add", "."], { cwd });
  await sh(["git", "commit", "-qm", "initial"], { cwd });
});
let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
async function fixture() {
  dir = mkdtempSync(join(tmpdir(), "limitless-size-"));
  await seed(dir);
  const git = async (...args: string[]) => (await sh(["git", ...args], { cwd: dir })).stdout.trim();
  const write = (path: string, content: string | Uint8Array) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = async () => {
    await git("add", ".");
    await git("commit", "-qm", "fixture");
    return git("rev-parse", "HEAD");
  };
  return { git, write, commit };
}
const render = (sizeReport: SizeReport) =>
  renderReport({
    runId: "size",
    success: true,
    prompt: "request",
    state: { sizeReport },
    invocations: [],
    totals: { costUsd: 0, costEquivUsd: 0 },
    runUrl: "",
  });

test("measures source, tests, docs using base globs and renders the exact range", async () => {
  const { git, write, commit } = await fixture();
  const base = await git("rev-parse", "HEAD");
  write("src/change.ts", "source\n".repeat(98));
  write(".limitless.toml", '[gates]\ndocs = ["src/**"]');
  write("test/change.ts", "test\n".repeat(200));
  write("docs/change.md", "docs\n".repeat(20));
  const head = await commit();
  const size = {
    ...(await measureSize(dir, base, head, "two-dot", ["docs/**"])),
    stated: statedBudget("Budget: 20 lines"),
  };
  expect(size.source).toEqual({ added: 100, removed: 0 });
  expect(size.tests).toEqual({ added: 200, removed: 0 });
  expect(size.docs).toEqual({ added: 20, removed: 0 });
  const report = render(size);
  expect(report).toContain(
    "Source: +100/−0 (100 lines); tests +200/−0; docs +20/−0. Against a stated budget of 20 (500%)",
  );
  expect(report).toContain(`Range: \`${base.slice(0, 8)}..${head.slice(0, 8)}\` (two-dot)`);
  expect(report.match(/^## Size$/gm)).toHaveLength(1);
});

test("explicit rename detection counts edits at destinations, binary and cross-category moves", async () => {
  const { git, write, commit } = await fixture();
  const names = ["src/same.ts", "src/move.ts", "docs/move.md", "src/pure.ts"];
  for (const [i, name] of names.entries())
    write(name, Array.from({ length: 300 }, (_, n) => `${i} original ${n}\n`).join(""));
  write("src/binary", new Uint8Array([0, 1, 2, 3]));
  const base = await commit();
  await git("config", "diff.renames", "false");
  const destinations = ["src/renamed.ts", "test/move.ts", "src/from-docs.ts", "src/pure-renamed.ts"];
  for (const [i, name] of names.entries()) {
    const dest = destinations[i];
    if (!dest) throw new Error("missing fixture destination");
    write(
      dest,
      Array.from({ length: 300 }, (_, n) =>
        i < 3 && n === 150 ? "replacement\n" : `${i} original ${n}\n`,
      ).join(""),
    );
    rmSync(join(dir, name));
  }
  renameSync(join(dir, "src/binary"), join(dir, "src/binary-renamed"));
  const head = await commit();
  const size = { ...(await measureSize(dir, base, head, "two-dot", ["docs/**"])), stated: null };
  expect(size.source).toEqual({ added: 2, removed: 2 });
  expect(size.tests).toEqual({ added: 1, removed: 1 });
  expect(size.docs).toEqual({ added: 0, removed: 0 });
  expect(size.binary).toBe(1);
  expect(size.renamesAcross).toEqual(
    expect.arrayContaining([
      { from: "src/move.ts", to: "test/move.ts" },
      { from: "docs/move.md", to: "src/from-docs.ts" },
    ]),
  );
  expect(render(size)).toContain("Binary entries: 1 (0 lines)");
  expect(render(size)).toContain('"src/move.ts" → "test/move.ts"');
});

test("NUL parsing preserves tabs, newlines and test precedence over docs", async () => {
  const { git, write, commit } = await fixture();
  const base = await git("rev-parse", "HEAD");
  for (const path of [
    "docs/tab\tfile.md",
    "docs/new\nfile.md",
    "docs/test_case.ts",
    "docs/a.test.ts",
    "docs/a.spec.ts",
    "docs/a_test.ts",
    "__tests__/file",
    "tests/file",
    "test",
  ])
    write(path, "one\n");
  const head = await commit();
  expect(await measureSize(dir, base, head, "two-dot", ["docs/**"])).toMatchObject({
    source: { added: 0, removed: 0 },
    tests: { added: 7, removed: 0 },
    docs: { added: 2, removed: 0 },
  });
});

test.each([
  ["Budget: 0 lines", "a stated budget of 0"],
  ["Budget: 10 lines, maximum 20 lines", "Budget is ambiguous"],
  ["no budget", "No budget was stated."],
])("reports exceptional budgets without a percentage: %s", async (prompt, message) => {
  const { git } = await fixture();
  const head = await git("rev-parse", "HEAD");
  const size = { ...(await measureSize(dir, head, head, "merge-base")), stated: statedBudget(prompt) };
  const report = render(size);
  expect(report).toContain(message);
  expect(report).not.toContain("%");
  expect(report).toContain(`\`${head.slice(0, 8)}...${head.slice(0, 8)}\` (merge-base)`);
  if (size.stated) expect(report).toContain(size.stated.text);
  const state: RunState = {
    toolCommands: [],
    phase: "deliver",
    round: 0,
    answers: [],
    roundsOnImplementer: 0,
    triedImplementers: [],
    feedback: null,
    sizeReport: size,
  };
  expect(verifiedFailureState(state).sizeReport).toEqual(size);
});

test("renders unavailable and redacts measurement errors", () => {
  expect(render({ unavailable: "No base SHA" })).toContain("Size unavailable: No base SHA");
  expect(render({ base: "a", head: "HEAD", mode: "two-dot", error: "git measurement failed" })).toContain(
    "Size unavailable: git measurement failed",
  );
});
