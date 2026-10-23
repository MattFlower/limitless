import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globToRegex } from "../src/gates/audit.ts";
import { gatesHash } from "../src/gates/cache.ts";
import { detectGates, readDocs } from "../src/gates/detect.ts";
import { docsOnlyGates } from "../src/gates/docs.ts";
import { compareGates } from "../src/gates/run.ts";
import { sh } from "../src/util/proc.ts";
import { test } from "./read-policy-support.ts";
import { seeded } from "./seeded.ts";

const toml = `[gates]
docs = ["docs/**", "*.md"]
retry_files = "bun test {files}"
setup = ["setup"]
checks = [{name="lint",run="lint"}, {name="test",run="bun test --reporter-outfile=$LIMITLESS_GATE_REPORT",timeoutSec=37}, {name="typecheck",run="types"}]
`;
const seed = seeded(async (cwd) => {
  mkdirSync(join(cwd, "docs"));
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "test"));
  for (const [file, text] of Object.entries({
    ".limitless.toml": toml,
    "docs/guide.md": "guide",
    "docs/old.md": "old",
    "src/x.ts": "source",
    "test/a.test.ts": "guide.md old.md",
    "test/b.test.ts": "unrelated",
    "test/path.spec.ts": "docs/guide.md",
    "test/space ' quote.test.ts": "guide.md",
  }))
    writeFileSync(join(cwd, file), text);
  await sh(["git", "init", "-q", "-b", "main"], { cwd });
  await commit(cwd);
});
async function commit(cwd: string) {
  await sh(["git", "add", "-A"], { cwd });
  await sh(["git", "commit", "-qm", "fixture"], { cwd });
  return (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
}

test.each([
  "targeted",
  "skipped",
  "mixed",
  "rename",
  "deletion",
  "empty",
  "no tests",
  "too many",
  "invalid files",
])("committed docs selection: %s", async (scenario) => {
  const cwd = mkdtempSync(join(tmpdir(), "docs-selection-"));
  try {
    await seed(cwd);
    const base = (await sh(["git", "rev-parse", "HEAD"], { cwd })).stdout.trim();
    const cfg = detectGates(cwd);
    if (scenario === "rename") renameSync(join(cwd, "src/x.ts"), join(cwd, "docs/x.md"));
    else if (scenario === "deletion") rmSync(join(cwd, "docs/old.md"));
    else if (scenario !== "empty") {
      writeFileSync(join(cwd, scenario === "skipped" ? "docs/unread.md" : "docs/guide.md"), "edited");
      if (scenario === "mixed") writeFileSync(join(cwd, "src/x.ts"), "edited");
      if (scenario === "no tests") rmSync(join(cwd, "test"), { recursive: true });
      if (scenario === "too many")
        for (let i = 0; i < 51; i++) writeFileSync(join(cwd, `test/${i}.test.ts`), "guide.md");
      // Commit fixture changes to test discovery first, then make a docs-only diff.
    }
    let diffBase = base;
    if (["no tests", "too many"].includes(scenario)) {
      diffBase = await commit(cwd);
      writeFileSync(join(cwd, "docs/guide.md"), "second edit");
    }
    const head = scenario === "empty" ? base : await commit(cwd);
    if (scenario === "targeted") {
      writeFileSync(join(cwd, "test/a.test.ts"), "no reference in working tree");
      writeFileSync(join(cwd, "test/b.test.ts"), "guide.md");
    }
    if (scenario === "invalid files") rmSync(join(cwd, "test/a.test.ts"));
    const docs = await docsOnlyGates(cwd, cfg, diffBase, head);
    const expected = ["targeted", "deletion", "skipped"].includes(scenario)
      ? scenario === "skipped"
        ? "skipped"
        : "targeted"
      : "full";
    expect(docs.selection.mode).toBe(expected);
    if (expected === "full") expect(docs.gates).toBe(cfg);
    else {
      expect(docs.gates.setup).toEqual(["setup"]);
      const run = docs.annotate({
        setupOk: true,
        setup: [],
        checks: docs.gates.checks.map((c) => ({
          name: c.name,
          command: c.run,
          ok: true,
          exitCode: 0,
          durationMs: 1,
          output: "passed",
        })),
      });
      expect(run.checks.map((r) => r.name)).toEqual(["lint", "test", "typecheck"]);
      if (expected === "targeted") {
        expect(docs.selection.files).toEqual(
          scenario === "deletion"
            ? ["test/a.test.ts"]
            : ["test/a.test.ts", "test/path.spec.ts", "test/space ' quote.test.ts"],
        );
        expect(docs.gates.checks[1]).toMatchObject({
          timeoutSec: 37,
          run:
            scenario === "deletion"
              ? "bun test './test/a.test.ts'"
              : "bun test './test/a.test.ts' './test/path.spec.ts' './test/space '\\'' quote.test.ts'",
        });
      } else
        expect(compareGates(null, run)[1]).toMatchObject({
          verdict: "not_run",
          blocking: false,
          result: {
            ok: false,
            exitCode: null,
            durationMs: 0,
            output: "docs-only change; no test reads the changed files",
            docsOnly: { mode: "skipped" },
          },
        });
    }
    if (scenario === "rename") expect(docs.selection.changedPaths).toEqual(["docs/x.md", "src/x.ts"]);
    for (const config of [
      { ...cfg, docs: undefined },
      { ...cfg, retryFiles: undefined },
      { ...cfg, retryFiles: "invalid" },
      { ...cfg, checks: [{ name: "test", run: "full" }] },
      { ...cfg, checks: [...cfg.checks, { name: "second", run: "$LIMITLESS_GATE_REPORT" }] },
    ])
      expect((await docsOnlyGates(cwd, config, diffBase, head)).gates).toBe(config);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("docs config validates and leaves legacy baseline hashes unchanged", () => {
  const cwd = mkdtempSync(join(tmpdir(), "docs-config-"));
  try {
    writeFileSync(join(cwd, ".limitless.toml"), toml.replace('docs = ["docs/**", "*.md"]\n', ""));
    const cfg = detectGates(cwd);
    expect(gatesHash(cfg)).toBe(
      gatesHash({
        setup: ["setup"],
        checks: cfg.checks,
        source: ".limitless.toml",
        protectedPaths: [],
        retryFiles: "bun test {files}",
      }),
    );
    const warnings: string[] = [];
    for (const value of ['"docs/**"', '[""]', '["docs/**", 3]']) {
      expect(readDocs(`[gates]\ndocs = ${value}`, (m) => warnings.push(m))).toBeUndefined();
    }
    expect(warnings).toHaveLength(3);
    expect(warnings.every((w) => w.includes("Invalid [gates].docs"))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.each([
  ["docs/**/guide.md", "docs/guide.md", true],
  ["docs/**/guide.md", "docs/a/b/guide.md", true],
  ["docs/**/guide.md", "docs/notguide.md", false],
  ["docs/**/guide.md", "docsx/guide.md", false],
  ["*.md", "README.md", true],
  ["*.md", "docs/x.md", false],
  ["docs/**", "docs/a/b/c.md", true],
  ["docs/**", "docsx/a.md", false],
  ["test/fixtures/**", "test/fixtures/a/b.ts", true],
  ["test/AGENTS.md", "test/AGENTS.md", true],
  ["test/AGENTS.md", "test/AGENTSxmd", false],
  ["test/AGENTS.md", "test/AGENTS.md\n", false],
  ["docs/**", "docs/a\nb.md", true],
  ["a?b", "a/b", false],
  ["a?b", "axb", true],
  ["**/guide.md", "guide.md", true],
  ["**", "a/b.ts", true],
  ["a**b", "a/x/b", false],
  ["a.+^{}$()|[]\\.md", "a.+^{}$()|[]\\.md", true],
] as const)("glob %s matches %s: %s", (pattern, path, matches) => {
  expect(globToRegex(pattern).test(path)).toBe(matches);
});

test("docs glob boundaries and unknown runners keep the configured checks", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "docs-runner-"));
  try {
    await seed(cwd);
    const base = await commitDoc(cwd, "docs/notguide.md", "base");
    const head = await commitDoc(cwd, "docs/notguide.md", "edited");
    const cfg = detectGates(cwd);
    const boundary = await docsOnlyGates(cwd, { ...cfg, docs: ["docs/**/guide.md"] }, base, head);
    expect(boundary.selection.mode).toBe("full");
    expect(boundary.gates.checks).toEqual(cfg.checks);
    for (const [run, retryFiles] of [
      ["npm test $LIMITLESS_GATE_REPORT", "bun test {files}"],
      ["bun test $LIMITLESS_GATE_REPORT", "npx vitest run {files}"],
      ["bun testing $LIMITLESS_GATE_REPORT", "bun test {files}"],
      ["env CI=1 bun test $LIMITLESS_GATE_REPORT", "bun test {files}"],
      ["bun test $LIMITLESS_GATE_REPORT", "bun testx {files}"],
    ] as const) {
      const config = { ...cfg, checks: [{ name: "test", run }], retryFiles };
      const docs = await docsOnlyGates(cwd, config, base, head);
      expect(docs.selection).toMatchObject({ mode: "full", files: [] });
      expect(docs.selection.reason).toContain("unrecognized test runner");
      expect(docs.selection.reason).toContain(run);
      expect(docs.selection.reason).toContain(retryFiles);
      expect(docs.gates).toBe(config);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function commitDoc(cwd: string, path: string, text: string) {
  writeFileSync(join(cwd, path), text);
  return commit(cwd);
}

test("Bun underscore test names and all supported extensions are targeted", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "docs-bun-tests-"));
  try {
    await seed(cwd);
    const files = ["doc_test.ts", "x_spec.mts"];
    for (const suffix of [".test", "_test", ".spec", "_spec"])
      for (const ext of ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"])
        files.push(`test/doc${suffix}.${ext}`);
    for (const file of files) writeFileSync(join(cwd, file), "docs/names.md");
    writeFileSync(join(cwd, "test/excluded.test.mjsx"), "docs/names.md");
    const base = await commitDoc(cwd, "docs/names.md", "base");
    const head = await commitDoc(cwd, "docs/names.md", "edited");
    const cfg = detectGates(cwd);
    const docs = await docsOnlyGates(cwd, cfg, base, head);
    expect(docs.selection.mode).toBe("targeted");
    expect(docs.selection.files).toEqual(files.sort());
    expect(docs.gates.checks[1]?.run).toBe(`bun test ${files.map((p) => `'./${p}'`).join(" ")}`);
    // With just the two underscore names, neither can be mistaken for no references.
    for (const file of files.filter((p) => p.startsWith("test/"))) rmSync(join(cwd, file));
    const fewer = await commit(cwd);
    const changed = await commitDoc(cwd, "docs/names.md", "edited again");
    const selected = await docsOnlyGates(cwd, cfg, fewer, changed);
    expect(selected.selection.files).toEqual(["doc_test.ts", "x_spec.mts"]);
    expect(selected.gates.checks[1]?.run).toBe("bun test './doc_test.ts' './x_spec.mts'");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
