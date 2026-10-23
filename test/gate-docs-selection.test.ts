import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatesHash } from "../src/gates/cache.ts";
import { detectGates, readDocs } from "../src/gates/detect.ts";
import { docsOnlyGates } from "../src/gates/docs.ts";
import { compareGates } from "../src/gates/run.ts";
import { sh } from "../src/util/proc.ts";
import { test } from "./read-policy-support.ts";
import { seeded } from "./seeded.ts";

const toml = `[gates]
docs = ["docs/**", "*.md"]
retry_files = "targeted {files}"
setup = ["setup"]
checks = [{name="lint",run="lint"}, {name="test",run="full $LIMITLESS_GATE_REPORT",timeoutSec=37}, {name="typecheck",run="types"}]
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
              ? "targeted './test/a.test.ts'"
              : "targeted './test/a.test.ts' './test/path.spec.ts' './test/space '\\'' quote.test.ts'",
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
        retryFiles: "targeted {files}",
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
