import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { parseAllow } from "../src/core/allow.ts";
import type { AuditAllowance, Repo } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { attributeRules, auditDiff } from "../src/gates/audit.ts";
import { collectGarbage } from "../src/gc.ts";
import { worktreeGit, worktreeGitScope } from "../src/git/command.ts";
import { completeMerge, prepareMerge } from "../src/git/merge.ts";
import {
  attributeLimits,
  commitAll,
  createWorktree,
  diffSince,
  discardChanges,
  ensureCache,
  headSha,
  pushBranch,
  readFileAt,
  removeWorktree,
  resetTo,
  sweepClassificationScratch,
} from "../src/git/repos.ts";
import { sh } from "../src/util/proc.ts";

let dir: string;
let seed: string;
let work: string;
let base: string;
const original = 'test("ok", () => {});\n';
const edited = 'test.skip("ok", () => {});\n';
const git = (cwd: string, ...args: string[]) => sh(["git", ...args], { cwd });
const factory = (...args: string[]) => worktreeGit(["git", ...args], { cwd: work });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "git-integrity-"));
  seed = join(dir, "seed");
  work = join(dir, "work");
  mkdirSync(seed);
  await git(seed, "init", "-q", "-b", "main");
  await git(seed, "config", "user.name", "Test");
  await git(seed, "config", "user.email", "test@example.com");
  for (const file of ["sample.test.ts", "flag.test.ts", "assume.test.ts"])
    writeFileSync(join(seed, file), original);
  await git(seed, "add", "-A");
  await git(seed, "commit", "-qm", "base");
  base = (await git(seed, "rev-parse", "HEAD")).stdout.trim();
  await git(seed, "worktree", "add", "-qb", "worker", work, base);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function audited(files = ["sample.test.ts"]) {
  const diff = await diffSince(work, base);
  expect(diff.patch).toContain(`+${edited.trim()}`);
  expect(diff.added).toBeGreaterThanOrEqual(files.length);
  const findings = auditDiff(diff, { taskClass: null, protectedPaths: [] });
  for (const file of files) {
    expect(diff.stat).toContain(file);
    expect(diff.files.some((entry) => entry.path === file)).toBe(true);
    expect(findings.some((finding) => finding.rule === "test-skipped" && finding.file === file)).toBe(true);
    expect(await readFileAt(work, "HEAD", file)).toBe(edited);
  }
}

test("committed -diff attributes cannot hide skipped tests, while 500 KB binaries stay compact", async () => {
  writeFileSync(join(work, ".gitattributes"), "*.ts -diff\n*.png diff\n");
  await commitAll(work, "attributes");
  const before = await headSha(work);
  const binary = Buffer.alloc(500_000, 0x61);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]).copy(binary);
  writeFileSync(join(work, "a.png"), binary);
  writeFileSync(join(work, "sample.test.ts"), edited);
  await commitAll(work, "binary and test edit");
  expect((await git(work, "diff", before, "HEAD", "--", "sample.test.ts")).stdout).not.toContain(
    "test.skip(",
  );
  const diff = await diffSince(work, before);
  const binaryPatch = diff.patch.split("diff --git a/sample.test.ts")[0] ?? "";
  expect(binaryPatch.trim().split("\n").at(-1)).toBe("Binary files /dev/null and b/a.png differ");
  expect(binaryPatch).not.toContain("@@");
  expect(diff.patch.length).toBeLessThan(1_000);
  expect((await factory("log", "-p", "-1")).stdout).toContain("Binary files /dev/null and b/a.png differ");
  expect((await factory("log", "-p", "-1")).stdout.length).toBeLessThan(2_000);
  await audited();
  const findings = auditDiff(await diffSince(work, base), { taskClass: null, protectedPaths: [] });
  expect(findings).toContainEqual(
    expect.objectContaining({
      rule: "gitattributes",
      severity: "block",
      file: ".gitattributes",
      detail: expect.stringContaining("*.ts"),
    }),
  );
  expect(findings).toContainEqual(expect.objectContaining({ rule: "test-skipped", file: "sample.test.ts" }));
});

test("committed nested repositories and changed gitlink commits block, but requested submodules do not", async () => {
  const nested = join(work, "nested repo");
  mkdirSync(nested);
  await git(nested, "init", "-q", "-b", "main");
  await git(nested, "config", "user.name", "Test");
  await git(nested, "config", "user.email", "test@example.com");
  writeFileSync(join(nested, "hidden.test.ts"), edited);
  await git(nested, "add", "-A");
  await git(nested, "commit", "-qm", "nested base");
  await commitAll(work, "nested repository");
  const first = await headSha(work);
  const assertGitlink = async (revision: string) => {
    const diff = await diffSince(work, revision);
    expect(diff.patch).not.toContain("test.skip(");
    expect(diff.gitlinks).toEqual(["nested repo"]);
    expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toContainEqual({
      rule: "gitlink",
      severity: "block",
      file: "nested repo",
      detail: expect.stringContaining("nested repo: nested repository contents are absent from the diff"),
    });
    expect(
      auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["submodules"] }).some(
        (f) => f.rule === "gitlink",
      ),
    ).toBe(false);
  };
  await assertGitlink(base);
  writeFileSync(join(nested, "hidden.test.ts"), `${edited}// next\n`);
  await git(nested, "add", "-A");
  await git(nested, "commit", "-qm", "advance nested repository");
  await commitAll(work, "advance gitlink");
  await assertGitlink(first);
  rmSync(nested, { recursive: true });
  await commitAll(work, "remove gitlink");
  expect(
    auditDiff(await diffSince(work, first), { taskClass: null, protectedPaths: [] }).some(
      (f) => f.rule === "gitlink",
    ),
  ).toBe(false);
});

test("committed .gitmodules ignore=all cannot hide added or changed gitlinks", async () => {
  const nested = join(work, "nested");
  mkdirSync(nested);
  await git(nested, "init", "-q", "-b", "main");
  await git(nested, "config", "user.name", "Test");
  await git(nested, "config", "user.email", "test@example.com");
  writeFileSync(join(nested, "hidden.test.ts"), edited);
  await git(nested, "add", "-A");
  await git(nested, "commit", "-qm", "nested base");
  writeFileSync(join(work, ".gitmodules"), '[submodule "nested"]\n\tpath = nested\n\tignore = all\n');
  await commitAll(work, "ignored nested repository");
  const first = await headSha(work);
  const assertVisible = async (revision: string) => {
    expect((await git(work, "diff", "--raw", revision, "HEAD")).stdout).not.toContain("nested");
    const diff = await diffSince(work, revision);
    expect(diff.gitlinks).toEqual(["nested"]);
    expect(diff.files).toContainEqual({ status: revision === base ? "A" : "M", path: "nested" });
    expect(diff.patch).toContain("Subproject commit");
    expect(diff.patch).not.toContain("test.skip(");
    expect(diff.stat).toContain("nested");
    expect(diff.added).toBeGreaterThan(0);
    expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toContainEqual({
      rule: "gitlink",
      severity: "block",
      file: "nested",
      detail: expect.stringContaining("nested: nested repository contents are absent from the diff"),
    });
  };
  await assertVisible(base);
  writeFileSync(join(nested, "hidden.test.ts"), `${edited}// next\n`);
  await git(nested, "add", "-A");
  await git(nested, "commit", "-qm", "advance ignored repository");
  await git(work, "update-index", "--cacheinfo", `160000,${await headSha(nested)},nested`);
  await git(work, "-c", "submodule.nested.ignore=none", "commit", "-qm", "advance ignored gitlink");
  await assertVisible(first);
});

test("attribute audit exempts base binary content and ordinary eol changes, never base text", async () => {
  writeFileSync(join(work, "image.png"), Buffer.from([0x89, 0x50, 0, 0x47]));
  writeFileSync(join(work, "text.png"), "actually text\n");
  mkdirSync(join(work, "assets"));
  writeFileSync(join(work, "assets", "image.png"), Buffer.from([0x89, 0x50, 0, 0x47]));
  await commitAll(work, "binary and text base");
  const revision = await headSha(work);
  for (const [line, blocked] of [
    ["*.ts eol=lf", false],
    ["image.png binary", false],
    ["assets/*.png binary", false],
    ["*.png binary", true],
    ["*.ts binary", true],
    ["*.ts -diff", true],
    ["*.ts -text", true],
    ["*.ts diff=custom", true],
    ["*.ts filter=custom", true],
    // Unmatched source rules can hide files added in later runs.
    ["new.test.ts -diff", true],
    ["sample.test.ts -diff", true],
    ["# *.ts -diff", false],
  ] as const) {
    writeFileSync(join(work, ".gitattributes"), `${line}\n`);
    await commitAll(work, "attribute edit");
    const findings = auditDiff(await diffSince(work, revision), { taskClass: null, protectedPaths: [] });
    const attribute = findings.find((f) => f.rule === "gitattributes");
    expect(attribute !== undefined).toBe(blocked);
    if (blocked) {
      expect(attribute?.severity).toBe("block");
      expect(attribute?.file).toBe(".gitattributes");
      expect(attribute?.detail).toContain(line.split(" ")[0] ?? "");
      expect(attribute?.detail).toContain("text diffs");
    }
  }
});

test("changed attributes respect directory scope and do not trust newly binary content", async () => {
  mkdirSync(join(work, "assets"));
  writeFileSync(join(work, "assets", "text.png"), "base text\n");
  writeFileSync(join(work, "assets", "binary.png"), Buffer.from([0, 1]));
  writeFileSync(join(work, "assets", ".gitattributes"), "*.png eol=lf\n");
  await commitAll(work, "base attributes");
  const revision = await headSha(work);
  writeFileSync(join(work, "assets", "text.png"), Buffer.from([0, 1]));
  writeFileSync(join(work, "assets", ".gitattributes"), "*.png binary\n");
  await commitAll(work, "hide formerly text content");
  const diff = await diffSince(work, revision);
  expect(Object.values(diff.attributeMatches ?? {})).toEqual([["assets/text.png"]]);
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toContainEqual(
    expect.objectContaining({
      rule: "gitattributes",
      file: "assets/.gitattributes",
      detail: expect.stringContaining("assets/text.png"),
    }),
  );
  writeFileSync(join(work, "assets", ".gitattributes"), "binary.png binary\n");
  await commitAll(work, "only base binary path");
  expect(
    auditDiff(await diffSince(work, revision), { taskClass: null, protectedPaths: [] }).some(
      (f) => f.rule === "gitattributes",
    ),
  ).toBe(false);
});

test("binary attribute files, renamed attribute files and literal glob characters cannot conceal rules", async () => {
  writeFileSync(join(work, "attributes.txt"), "*.ts -diff\n");
  writeFileSync(join(work, "a{b,c}.png"), "base text\n");
  for (const file of ["ab.png", "ac.png"]) writeFileSync(join(work, file), Buffer.from([0, 1]));
  writeFileSync(join(work, "++"), "base text\n");
  await commitAll(work, "base patterns");
  const revision = await headSha(work);
  await git(work, "mv", "attributes.txt", ".gitattributes");
  await commitAll(work, "rename attributes into place");
  const renamed = await diffSince(work, revision);
  expect(
    auditDiff(renamed, { taskClass: null, protectedPaths: [] }).some((f) => f.rule === "gitattributes"),
  ).toBe(true);
  for (const content of ["*.ts -diff\n# \0padding\n", "a{b,c}.png binary\n", "++ -diff\n"]) {
    writeFileSync(join(work, ".gitattributes"), content);
    await commitAll(work, "concealing attributes");
    const diff = await diffSince(work, revision);
    expect(
      auditDiff(diff, { taskClass: null, protectedPaths: [] }).some((f) => f.rule === "gitattributes"),
    ).toBe(true);
  }
});

test("quoted Git paths retain their scope and newly added text paths are not treated as base binary", async () => {
  const folder = "assets-\u00e9\nquoted";
  mkdirSync(join(work, folder));
  writeFileSync(join(work, folder, "image.png"), Buffer.from([0, 1]));
  await commitAll(work, "base binary path");
  const revision = await headSha(work);
  writeFileSync(join(work, folder, ".gitattributes"), "*.png binary\n");
  await commitAll(work, "base binary attributes");
  expect(
    auditDiff(await diffSince(work, revision), { taskClass: null, protectedPaths: [] }).some(
      (f) => f.rule === "gitattributes",
    ),
  ).toBe(false);
  writeFileSync(join(work, folder, "new-\u00e9.png"), "new text\n");
  await commitAll(work, "new text under attributes");
  const findings = auditDiff(await diffSince(work, revision), { taskClass: null, protectedPaths: [] });
  expect(findings).toContainEqual(
    expect.objectContaining({
      rule: "gitattributes",
      file: `${folder}/.gitattributes`,
      detail: expect.stringContaining(`${folder}/new-\u00e9.png`),
    }),
  );
  await git(work, "config", "core.quotePath", "false");
  expect(auditDiff(await diffSince(work, revision), { taskClass: null, protectedPaths: [] })).toContainEqual(
    expect.objectContaining({ rule: "gitattributes", file: `${folder}/.gitattributes` }),
  );
});

test("attribute macros cannot claim a binary exemption for an unrelated matching filename", async () => {
  writeFileSync(join(work, ".gitattributes"), "*.ts hidden\n");
  writeFileSync(join(work, "ahidden"), Buffer.from([0, 1]));
  await commitAll(work, "base macro usage");
  const revision = await headSha(work);
  writeFileSync(join(work, ".gitattributes"), "[attr]hidden -diff\n*.ts hidden\n");
  writeFileSync(join(work, "sample.test.ts"), edited);
  await commitAll(work, "concealing macro");
  expect((await git(work, "diff", revision, "HEAD", "--", "sample.test.ts")).stdout).not.toContain(
    "test.skip(",
  );
  const findings = auditDiff(await diffSince(work, revision), { taskClass: null, protectedPaths: [] });
  expect(findings.some((f) => f.rule === "gitattributes" && f.severity === "block")).toBe(true);
  expect(findings.some((f) => f.rule === "test-skipped")).toBe(true);
});

test("renaming into an existing hiding rule does not block; changing that rule still blocks", async () => {
  const notes = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  writeFileSync(join(work, ".gitattributes"), "*.gen linguist-generated\n");
  writeFileSync(join(work, "notes.txt"), `${notes}\n`);
  writeFileSync(join(work, "blob.bin"), Buffer.from([0, 1, 2]));
  await commitAll(work, "base rule and content");
  const revision = await headSha(work);
  await git(work, "mv", "blob.bin", "blob.gen");
  await commitAll(work, "binary rename stays binary");
  const control = await diffSince(work, revision);
  expect(control.textPaths).toEqual([]);
  expect(attributeBlocksOf(auditDiff(control, { taskClass: null, protectedPaths: [] }))).toEqual([]);
  await git(work, "mv", "notes.txt", "out.gen");
  writeFileSync(join(work, "out.gen"), Buffer.concat([Buffer.from(`${notes}\n`), Buffer.from([0])]));
  await commitAll(work, "text source renamed into a hidden binary");
  const diff = await diffSince(work, revision);
  expect(diff.files).toContainEqual(expect.objectContaining({ from: "notes.txt", path: "out.gen" }));
  expect(diff.textPaths).toEqual([]);
  expect(attributeBlocksOf(auditDiff(diff, { taskClass: null, protectedPaths: [] }))).toEqual([]);
  writeFileSync(join(work, ".gitattributes"), "*.gen linguist-generated=true\n");
  await commitAll(work, "change hiding rule");
  expect(
    attributeBlocksOf(auditDiff(await diffSince(work, revision), { taskClass: null, protectedPaths: [] })),
  ).toContainEqual(
    expect.objectContaining({
      severity: "block",
      file: ".gitattributes",
      detail: expect.stringContaining("linguist-generated"),
    }),
  );
});

test.each([
  ["package-lock.json -diff", "packages/x/package-lock.json", false],
  ["*.snap linguist-generated", "__snapshots__/a.snap", false],
  ["dist/** linguist-generated=true", "dist/b.js", false],
  ["*.lock linguist-generated", "new.lock", true],
])("unchanged base rule %s covers new head path %s without blocking", async (rule, path, rename) => {
  writeFileSync(join(work, ".gitattributes"), `${rule}\n`);
  writeFileSync(join(work, "old.txt"), "unchanged text\n");
  await commitAll(work, "base rule");
  const revision = await headSha(work);
  mkdirSync(join(work, path, ".."), { recursive: true });
  if (rename) await git(work, "mv", "old.txt", path);
  else writeFileSync(join(work, path), "new text\n");
  await commitAll(work, "new path under base rule");
  const shim = gitShim();
  const diff = await diffSince(work, revision, shim.env);
  const attributes = diff.attributes?.find((entry) => entry.path === path);
  expect(attributes).toBeDefined();
  expect(attributes?.base).toEqual(attributes?.head);
  expect(shim.calls()).toContainEqual(expect.stringContaining(`check-attr --source=${revision}`));
  const findings = auditDiff(diff, { taskClass: null, protectedPaths: [] });
  expect(attributeBlocksOf(findings)).toEqual([]);
  expect(findings).toContainEqual(
    expect.objectContaining({
      rule: "gitattributes",
      severity: "warn",
      file: path,
      detail: expect.stringContaining("already effective at base"),
    }),
  );
  expect(findings.find((f) => f.file === path && f.rule === "gitattributes")?.detail).toContain(
    rule.split(" ").slice(1).join(" "),
  );
});

test.each(["filter=unset", "linguist-generated=unset"])("literal %s is a hiding attribute", async (attr) => {
  const marker = join(dir, "filter-ran");
  await git(work, "config", "filter.unset.clean", `touch '${marker}'; cat`);
  writeFileSync(join(work, ".gitattributes"), `*.ts ${attr}\n`);
  writeFileSync(join(work, "sample.test.ts"), edited);
  await commitAll(work, "literal hiding value");
  const filteredOnAdd = existsSync(marker);
  rmSync(marker, { force: true });
  const diff = await worktreeGitScope.run(false, () => diffSince(work, base));
  expect(
    diff.attributes?.find((entry) => entry.path === "sample.test.ts")?.head[attr.split("=")[0] ?? ""],
  ).toBe("unset");
  expect(attributeBlocksOf(auditDiff(diff, { taskClass: null, protectedPaths: [] }))).toContainEqual(
    expect.objectContaining({ file: ".gitattributes", severity: "block" }),
  );
  expect(existsSync(marker)).toBe(false);
  expect(filteredOnAdd).toBe(attr === "filter=unset");
});

test.each([
  ["*.png", false],
  ["*.ts", true],
  ["*.png", true],
])("LFS tracking line for %s blocks only when matching content is text (%s)", async (pattern, text) => {
  // Canonical output of git lfs track "<pattern>"; no LFS executable or network is required.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4l8AAAAASUVORK5CYII=",
    "base64",
  );
  writeFileSync(join(work, "icon.png"), text ? "base text\n" : png);
  await commitAll(work, "base content");
  const revision = await headSha(work);
  writeFileSync(join(work, "icon.png"), png);
  writeFileSync(join(work, ".gitattributes"), `${pattern} filter=lfs diff=lfs merge=lfs -text\n`);
  await commitAll(work, "LFS tracking attributes");
  const diff = await diffSince(work, revision);
  expect(attributeBlocksOf(auditDiff(diff, { taskClass: null, protectedPaths: [] })).length > 0).toBe(text);
});

test("an LFS pointer committed for a tracked binary keeps the LFS exemption; a fake pointer path in text does not", async () => {
  // What `git lfs track "*.png"` plus `git add` commits when git-lfs is installed: a pointer.
  // Hermetic: a runner's global LFS filter would rewrite the pointer-like text below too.
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 68\n`;
    writeFileSync(join(work, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    await commitAll(work, "binary base");
    const revision = await headSha(work);
    writeFileSync(join(work, "icon.png"), pointer);
    writeFileSync(join(work, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
    await commitAll(work, "track with LFS");
    const audit = (rev: string) =>
      diffSince(work, rev).then((diff) =>
        attributeBlocksOf(auditDiff(diff, { taskClass: null, protectedPaths: [] })),
      );
    expect(await audit(revision)).toEqual([]);
    // A text file that only looks pointer-like (extra content) is still text, so the rule blocks.
    writeFileSync(join(work, "icon.png"), `${pointer}console.log("hidden")\n`);
    await commitAll(work, "pointer-like text");
    expect((await audit(revision)).length).toBeGreaterThan(0);
  } finally {
    for (const [key, value] of [
      ["GIT_CONFIG_GLOBAL", saved.global],
      ["GIT_CONFIG_NOSYSTEM", saved.system],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test("quoted attribute patterns keep their binary-only exemption when Git can decode them", async () => {
  writeFileSync(join(work, "asset text.png"), "base text\n");
  await commitAll(work, "base");
  const revision = await headSha(work);
  const cases: [string, Record<string, Buffer>, boolean][] = [
    ['"asset image.png" binary', { "asset image.png": Buffer.from([0x89, 0, 1]) }, false],
    ['"asset\\011tab.png" -diff', { "asset\ttab.png": Buffer.from([0x89, 0, 1]) }, false],
    ['"asset text.png" binary', {}, true],
    ['"asset image.png\\q" binary', { "asset image.png\\q": Buffer.from([0x89, 0, 1]) }, true],
  ];
  for (const [line, files, blocked] of cases) {
    await git(work, "reset", "-q", "--hard", revision);
    writeFileSync(join(work, ".gitattributes"), `${line}\n`);
    for (const [path, content] of Object.entries(files)) writeFileSync(join(work, path), content);
    await commitAll(work, line);
    const findings = attributeBlocksOf(
      auditDiff(await diffSince(work, revision), { taskClass: null, protectedPaths: [] }),
    );
    expect([line, findings.length > 0]).toEqual([line, blocked]);
  }
});

test("mixed literal UTF-8 and octal attribute patterns cannot exempt existing text", async () => {
  const paths = ["café notes.txt", "文書 📄 notes.txt"] as const;
  for (const path of paths) writeFileSync(join(work, path), "existing text\n");
  await commitAll(work, "existing Unicode text paths");
  const revision = await headSha(work);
  for (const [pattern, path] of [
    ['"café\\040notes.txt"', paths[0]],
    ['"caf\\303\\251 notes.txt"', paths[0]],
    ['"文書 📄\\040notes.txt"', paths[1]],
  ] as const) {
    await git(work, "reset", "-q", "--hard", revision);
    writeFileSync(join(work, ".gitattributes"), `${pattern} -diff\n`);
    await commitAll(work, "hide existing text with a quoted pattern");
    expect((await git(work, "check-attr", "--source=HEAD", "-z", "diff", "--", path)).stdout).toBe(
      `${path}\0diff\0unset\0`,
    );
    const diff = await diffSince(work, revision);
    expect(diff.files.map((file) => file.path)).toEqual([".gitattributes"]);
    expect(attributeRules(diff.attributePatch ?? diff.patch).map((rule) => rule.pattern)).toEqual([path]);
    expect(Object.values(diff.attributeMatches ?? {})).toEqual([[path]]);
    expect(attributeBlocksOf(auditDiff(diff, { taskClass: null, protectedPaths: [] }))).toContainEqual(
      expect.objectContaining({
        rule: "gitattributes",
        severity: "block",
        file: ".gitattributes",
        detail: expect.stringContaining(path),
      }),
    );
  }
});

test("Git version is checked once and unsupported versions fail before repository commands", async () => {
  const bin = join(dir, "bin");
  const calls = join(dir, "git-calls");
  mkdirSync(bin);
  const script = `import { worktreeGit } from ${JSON.stringify(resolve("src/git/command.ts"))};
    for (let i = 0; i < 2; i++) await worktreeGit(["git", "diff"], { cwd: ${JSON.stringify(work)} });`;
  for (const version of ["2.39.9", "1.99.0", "unknown", "2.40.0", "2.54.0 (Apple Git-1)", "3.0.0"]) {
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$*" in\n--version) printf 'git version ${version}\\n';;\n*--get-regexp*) exit 1;;\nesac\n`,
      { mode: 0o755 },
    );
    const result = await sh([process.execPath, "-e", script], {
      cwd: work,
      env: { ...(process.env as Record<string, string>), PATH: bin },
      allowFail: true,
    });
    const commands = readFileSync(calls, "utf8").trim().split("\n");
    expect(commands.filter((cmd) => cmd === "--version")).toHaveLength(1);
    if (["2.39.9", "1.99.0", "unknown"].includes(version)) {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("requires Git >= 2.40 for --attr-source");
      expect(commands).toEqual(["--version"]);
    } else {
      expect(result.exitCode).toBe(0);
      expect(commands.filter((cmd) => cmd.includes("--attr-source="))).toHaveLength(2);
    }
    rmSync(calls);
  }
});

test("shared cache hooks from an earlier run cannot execute during fetch, worktree lifecycle or GC", async () => {
  const cfg = loadConfig({ home: join(dir, "data"), configDir: join(dir, "config") });
  const store = new Store(cfg.paths.db);
  try {
    const repo = store.upsertRepo({
      slug: "owner/repo",
      kind: "github",
      url: seed,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const cache = await ensureCache(cfg.paths, repo);
    const first = await createWorktree(cfg.paths, repo, "first", "first", "main");
    const marker = join(dir, "cache-hook-ran");
    // Git 2.55 rejects a hook friendly-name equal to an event name, so planted hooks use their own names.
    for (const event of ["reference-transaction", "post-checkout", "post-index-change"]) {
      await git(first.path, "config", `hook.planted-${event}.command`, `echo '${event}' >> '${marker}'`);
      await git(first.path, "config", `hook.planted-${event}.event`, event);
      await git(first.path, "config", `hook.planted-${event}.enabled`, "true");
    }
    const config = readFileSync(join(cache, "config"));
    writeFileSync(join(seed, "next.txt"), "next\n");
    await git(seed, "add", "-A");
    await git(seed, "commit", "-qm", "advance origin");
    const tip = (await git(seed, "rev-parse", "HEAD")).stdout.trim();
    await ensureCache(cfg.paths, repo);
    expect(existsSync(marker)).toBe(false);
    const second = await createWorktree(cfg.paths, repo, "second", "second", "main");
    expect(second.baseSha).toBe(tip);
    expect(await headSha(second.path)).toBe(tip);
    expect(await createWorktree(cfg.paths, repo, "second", "second", "main")).toEqual(second);
    expect(existsSync(marker)).toBe(false);
    await removeWorktree(cfg.paths, repo, second.path);
    expect(existsSync(second.path)).toBe(false);
    for (const missing of [false, true]) {
      const run = store.createRun(repo, { repo: repo.slug, prompt: "gc" });
      store.updateRun(run.id, { status: "succeeded", finishedAt: 0 });
      const tree = await createWorktree(cfg.paths, repo, run.id, "gc", "main");
      if (missing) rmSync(tree.path, { recursive: true, force: true });
      const result = await collectGarbage(store, cfg);
      expect(result.errors).toEqual([]);
      expect(existsSync(tree.path)).toBe(false);
      expect(missing ? result.metadata.length : result.worktrees.length).toBe(1);
    }
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(cache, "config"))).toEqual(config);
    // Prove the configured hook is executable on Git versions supporting config hooks.
    const version = (await git(cache, "--version")).stdout.match(/(\d+)\.(\d+)/);
    if (version && (Number(version[1]) > 2 || Number(version[2]) >= 54)) {
      await git(cache, "hook", "run", "post-checkout");
      expect(readFileSync(marker, "utf8")).toContain("post-checkout");
    }
  } finally {
    store.close();
  }
});

test("conflict-resolution commits rebuild the linked index and include skip-worktree edits", async () => {
  writeFileSync(join(seed, "sample.test.ts"), "theirs\n");
  writeFileSync(join(seed, "base-only.txt"), "from base\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-qm", "base conflict");
  const nextBase = (await git(seed, "rev-parse", "HEAD")).stdout.trim();
  writeFileSync(join(work, "sample.test.ts"), "ours\n");
  const head = await commitAll(work, "worker conflict");
  if (!head) throw new Error("expected worker commit");
  expect(await prepareMerge(work, head, nextBase)).toEqual(["sample.test.ts"]);
  writeFileSync(join(work, "sample.test.ts"), "resolved\n");
  await git(work, "update-index", "--skip-worktree", "flag.test.ts");
  writeFileSync(join(work, "flag.test.ts"), edited);
  await git(work, "add", "-A");
  expect((await git(work, "show", ":flag.test.ts")).stdout).toBe(original);
  const seedIndex = readFileSync(join(seed, ".git/index"));
  const merged = await completeMerge(work, head, nextBase);
  expect((await factory("rev-list", "--parents", "-n", "1", "HEAD")).stdout.trim()).toBe(
    `${merged} ${head} ${nextBase}`,
  );
  expect(await readFileAt(work, "HEAD", "sample.test.ts")).toBe("resolved\n");
  expect(await readFileAt(work, "HEAD", "flag.test.ts")).toBe(edited);
  expect(await readFileAt(work, "HEAD", "base-only.txt")).toBe("from base\n");
  expect(readFileSync(join(seed, ".git/index"))).toEqual(seedIndex);
});

test("merge index rebuild preserves ignored tracked files and staged additions, but honors deletions", async () => {
  const kept = "base [ignored]\nfile.txt";
  const removed = "deleted.txt";
  const staged = ":resolution.txt";
  writeFileSync(join(seed, ".gitignore"), "*.txt\n");
  writeFileSync(join(seed, kept), "from base\n");
  writeFileSync(join(seed, removed), "remove in resolution\n");
  writeFileSync(join(seed, "sample.test.ts"), "theirs\n");
  await git(seed, "add", "-A");
  await git(seed, "add", "-f", "--", `:(literal)${kept}`, removed);
  await git(seed, "commit", "-qm", "base adds ignored files");
  const nextBase = (await git(seed, "rev-parse", "HEAD")).stdout.trim();
  writeFileSync(join(work, "sample.test.ts"), "ours\n");
  const head = await commitAll(work, "worker conflict");
  if (!head) throw new Error("expected worker commit");
  expect(await prepareMerge(work, head, nextBase)).toEqual(["sample.test.ts"]);
  expect(readFileSync(join(work, kept), "utf8")).toBe("from base\n");
  writeFileSync(join(work, "sample.test.ts"), "resolved\n");
  rmSync(join(work, removed));
  writeFileSync(join(work, staged), "staged resolution\n");
  writeFileSync(join(work, "untracked.txt"), "stay ignored\n");
  await git(work, "add", "-f", "--", `:(literal)${staged}`);
  const seedIndex = readFileSync(join(seed, ".git/index"));
  const merged = await completeMerge(work, head, nextBase);
  expect((await factory("rev-list", "--parents", "-n", "1", "HEAD")).stdout.trim()).toBe(
    `${merged} ${head} ${nextBase}`,
  );
  expect(await readFileAt(work, "HEAD", "sample.test.ts")).toBe("resolved\n");
  expect(await readFileAt(work, "HEAD", kept)).toBe("from base\n");
  expect((await factory("show", `HEAD:${staged}`)).stdout).toBe("staged resolution\n");
  const paths = (await factory("ls-tree", "-rz", "--name-only", "HEAD")).stdout.split("\0");
  expect(paths).not.toContain(removed);
  expect(paths).not.toContain("untracked.txt");
  expect(readFileSync(join(seed, ".git/index"))).toEqual(seedIndex);
});

test("diff, log, names and statistics ignore external diff, textconv and global attributes", async () => {
  const marker = join(dir, "diff-ran");
  const blind = join(dir, "blind.sh");
  writeFileSync(blind, `#!/bin/sh\ntouch '${marker}'\nprintf 'hidden\\n'\n`, { mode: 0o755 });
  await git(work, "config", "diff.external", blind);
  await git(work, "config", "diff.blind.textconv", blind);
  const attributes = resolve(
    work,
    (await git(work, "rev-parse", "--git-path", "info/attributes")).stdout.trim(),
  );
  writeFileSync(attributes, "*.test.ts diff=blind\n");
  const globalAttributes = join(dir, "attributes");
  writeFileSync(globalAttributes, "*.test.ts -diff\n");
  await git(work, "config", "core.attributesFile", globalAttributes);
  for (const file of ["sample.test.ts", "flag.test.ts"]) writeFileSync(join(work, file), edited);
  await commitAll(work, "factory edit");
  await audited(["sample.test.ts", "flag.test.ts"]);
  expect((await factory("log", "-p", "-1")).stdout).toContain(`+${edited.trim()}`);
  expect(existsSync(marker)).toBe(false);
  // The same repository settings blind an ordinary diff.
  expect((await git(work, "diff", `${base}..HEAD`)).stdout).not.toContain("test.skip(");
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  await git(work, "config", "--unset", "diff.external");
  expect((await git(work, "diff", `${base}..HEAD`)).stdout).not.toContain("test.skip(");
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  await audited(["sample.test.ts", "flag.test.ts"]);
  expect(existsSync(marker)).toBe(false);
});

test("replacement commits cannot blind factory inspection or the audit", async () => {
  writeFileSync(join(work, "sample.test.ts"), edited);
  await commitAll(work, "edit");
  const head = await headSha(work);
  await git(work, "replace", head, base);
  expect((await git(work, "diff", `${base}..HEAD`)).stdout).toBe("");
  expect((await git(work, "show", "HEAD:sample.test.ts")).stdout).toBe(original);
  await audited();
  expect((await factory("log", "-p", "-1")).stdout).toContain("test.skip(");
});

test("rebuilding a linked worktree index defeats forged stat data, skip-worktree and assume-unchanged", async () => {
  const cleanBlob = (await git(work, "rev-parse", "HEAD:sample.test.ts")).stdout.trim();
  writeFileSync(join(work, "sample.test.ts"), edited);
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(work, "sample.test.ts"), past, past);
  await git(work, "-c", "index.version=2", "add", "sample.test.ts");
  const editedBlob = (await git(work, "rev-parse", ":sample.test.ts")).stdout.trim();
  const indexPath = resolve(work, (await git(work, "rev-parse", "--git-path", "index")).stdout.trim());
  expect(indexPath).not.toBe(join(seed, ".git/index"));
  const index = readFileSync(indexPath);
  const offset = index.indexOf(Buffer.from(editedBlob, "hex"));
  expect(offset).toBeGreaterThan(12);
  // Keep the edited file's complete stat cache, but claim its content is the clean HEAD blob.
  Buffer.from(cleanBlob, "hex").copy(index, offset);
  createHash("sha1")
    .update(index.subarray(0, -20))
    .digest()
    .copy(index, index.length - 20);
  writeFileSync(indexPath, index);
  await git(work, "update-index", "--skip-worktree", "flag.test.ts");
  await git(work, "update-index", "--assume-unchanged", "assume.test.ts");
  for (const file of ["flag.test.ts", "assume.test.ts"]) writeFileSync(join(work, file), edited);
  await git(work, "add", "-A");
  expect((await git(work, "status", "--porcelain")).stdout).toBe("");
  expect((await git(work, "show", ":sample.test.ts")).stdout).toBe(original);
  const seedIndex = readFileSync(join(seed, ".git/index"));
  expect(await commitAll(work, "factory rebuild")).not.toBeNull();
  expect(readFileSync(join(seed, ".git/index"))).toEqual(seedIndex);
  await audited(["sample.test.ts", "flag.test.ts", "assume.test.ts"]);
  expect(await commitAll(work, "no changes")).toBeNull();
  rmSync(indexPath);
  expect(await commitAll(work, "missing index")).toBeNull();
});

test("script and config hooks never execute during commit, merge, inspection, reset or delivery push", async () => {
  writeFileSync(join(seed, "base.txt"), "advance base\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-qm", "advance");
  const nextBase = (await git(seed, "rev-parse", "HEAD")).stdout.trim();
  const hooks = resolve(work, (await git(work, "rev-parse", "--git-path", "hooks")).stdout.trim());
  const scriptMarker = join(dir, "script-ran");
  const configMarker = join(dir, "config-ran");
  const equalsMarker = join(dir, "equals-hook-ran");
  for (const name of [
    "pre-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "post-merge",
    "post-checkout",
    "pre-push",
    "post-index-change",
  ])
    writeFileSync(join(hooks, name), `#!/bin/sh\ntouch '${scriptMarker}'\n`, { mode: 0o755 });
  const fsmonitor = join(dir, "fsmonitor.sh");
  writeFileSync(fsmonitor, `#!/bin/sh\ntouch '${scriptMarker}'\nprintf 'token\\0'\n`, { mode: 0o755 });
  await git(work, "config", "core.fsmonitor", fsmonitor);
  for (const name of ["agent", "a=b"]) {
    await git(
      work,
      "config",
      `hook.${name}.command`,
      `touch '${name === "agent" ? configMarker : equalsMarker}'`,
    );
    await git(work, "config", `hook.${name}.event`, "post-commit");
    await git(work, "config", `hook.${name}.enabled`, "true");
  }
  const configPath = join(seed, ".git/config");
  const config = readFileSync(configPath);
  const version = (await git(work, "--version")).stdout.match(/(\d+)\.(\d+)/);
  if (version && (Number(version[1]) > 2 || Number(version[2]) >= 54)) {
    await git(work, "hook", "run", "post-commit");
    expect(existsSync(configMarker)).toBe(true);
    expect(existsSync(equalsMarker)).toBe(true);
    rmSync(configMarker);
    rmSync(equalsMarker);
    rmSync(scriptMarker);
  }
  for (const name of ["agent", "a=b"])
    for (const field of ["command", "event", "enabled"])
      expect((await factory("config", "--get", `hook.${name}.${field}`)).stdout).toBe("\n");
  writeFileSync(join(work, "sample.test.ts"), edited);
  const head = await commitAll(work, "factory edit");
  if (!head) throw new Error("expected edit commit");
  await audited();
  expect(await prepareMerge(work, head, nextBase)).toEqual([]);
  const merged = await completeMerge(work, head, nextBase);
  expect((await factory("rev-list", "--parents", "-n", "1", "HEAD")).stdout.trim()).toBe(
    `${merged} ${head} ${nextBase}`,
  );
  await factory("checkout", "-q", "worker");
  await resetTo(work, merged);
  writeFileSync(join(work, "untracked.txt"), "discard me\n");
  expect(await discardChanges(work)).toBe(true);
  const remote = join(dir, "remote.git");
  await git(dir, "init", "-q", "--bare", remote);
  const repo: Repo = {
    id: "r",
    slug: "owner/repo",
    kind: "github",
    url: remote,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
    createdAt: 0,
  };
  await pushBranch(repo, work, "delivered", merged);
  expect((await git(remote, "rev-parse", "refs/heads/delivered")).stdout.trim()).toBe(merged);
  expect(existsSync(scriptMarker)).toBe(false);
  expect(existsSync(configMarker)).toBe(false);
  expect(existsSync(equalsMarker)).toBe(false);
  expect(readFileSync(configPath)).toEqual(config);
});

test("effective hooks from system, global, includes and environment config are overridden without rewriting them", async () => {
  const marker = join(dir, "hook-ran");
  const system = join(dir, "system.config");
  const global = join(dir, "global.config");
  const include = join(dir, "included.config");
  const content = (name: string) =>
    `[hook "${name}"]\n command = touch '${marker}'\n event = post-commit\n enabled = true\n`;
  writeFileSync(system, content("system"));
  writeFileSync(global, `${content("global")}[include]\n path = ${include}\n`);
  writeFileSync(include, content("included"));
  await git(work, "config", "extensions.worktreeConfig", "true");
  await git(work, "config", "--worktree", "hook.worktree.command", `touch '${marker}'`);
  await git(work, "config", "--worktree", "hook.worktree.event", "post-commit");
  const worktreeConfig = resolve(
    work,
    (await git(work, "rev-parse", "--git-path", "config.worktree")).stdout.trim(),
  );
  const env = {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_SYSTEM: system,
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "0",
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "hook.environment.command",
    GIT_CONFIG_VALUE_0: `touch '${marker}'`,
    GIT_CONFIG_KEY_1: "hook.environment.event",
    GIT_CONFIG_VALUE_1: "post-commit",
    GIT_CONFIG_KEY_2: "hook.environment.enabled",
    GIT_CONFIG_VALUE_2: "true",
    LIMITLESS_GIT_EMPTY_HOOK: `touch '${marker}'`,
  };
  const paths = [system, global, include, worktreeConfig];
  const configs = paths.map((path) => readFileSync(path));
  for (const name of ["system", "global", "included", "environment", "worktree"]) {
    const result = await worktreeGit(["git", "config", "--get", `hook.${name}.command`], { cwd: work, env });
    expect(result.stdout).toBe("\n");
  }
  await worktreeGit(["git", "commit", "--allow-empty", "-qm", "safe"], { cwd: work, env });
  expect(existsSync(marker)).toBe(false);
  for (const [i, path] of paths.entries()) {
    const before = configs[i];
    if (!before) throw new Error("missing config snapshot");
    expect(readFileSync(path)).toEqual(before);
  }
});

test("hook discovery fails closed on invalid config and honors cancellation even with allowFail", async () => {
  const global = join(dir, "invalid.config");
  writeFileSync(global, "[invalid\n");
  const env = { ...(process.env as Record<string, string>), GIT_CONFIG_GLOBAL: global };
  const cmd = ["git", "commit", "--allow-empty", "-qm", "must not commit"];
  await expect(worktreeGit(cmd, { cwd: work, env, allowFail: true })).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(worktreeGit(cmd, { cwd: work, signal: controller.signal, allowFail: true })).rejects.toThrow();
  expect(await headSha(work)).toBe(base);
  expect(readFileSync(global, "utf8")).toBe("[invalid\n");
});

test("local pipeline scope retains original git settings and index behavior", async () => {
  await git(work, "config", "hook.agent.command", "original-command");
  await git(work, "update-index", "--skip-worktree", "sample.test.ts");
  writeFileSync(join(work, "sample.test.ts"), edited);
  await worktreeGitScope.run(false, async () => {
    expect((await factory("config", "--get", "hook.agent.command")).stdout.trim()).toBe("original-command");
    expect(await commitAll(work, "local")).toBeNull();
  });
  expect(await commitAll(work, "github")).not.toBeNull();
  await audited();
});

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const attributeBlocksOf = (findings: { rule: string; severity: string; file?: string; detail: string }[]) =>
  findings.filter((f) => f.rule === "gitattributes" && f.severity === "block");

/** A `git` on PATH that logs every argv and can stall content classification. */
function gitShim(stall: boolean | "fail" = false) {
  const bin = join(dir, "shim");
  const log = join(dir, "git.log");
  const inputLog = join(dir, "pathspecs.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(inputLog, "");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${log}'`,
    stall
      ? `case "$* " in *" --cached --numstat "*) ${stall === "fail" ? "echo classification-broke >&2; exit 1" : "sleep 30"};; esac`
      : "",
    `case "$* " in *" --pathspec-from-file=- "*) cat > '${inputLog}'.$$; cat '${inputLog}'.$$ >> '${inputLog}'; exec '${Bun.which("git")}' "$@" < '${inputLog}'.$$;; esac`,
    `exec '${Bun.which("git")}' "$@"`,
  ].join("\n");
  writeFileSync(join(bin, "git"), script, { mode: 0o755 });
  const env = { ...(process.env as Record<string, string>), PATH: `${bin}:${process.env.PATH}` };
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const classifications = () => calls().filter((call) => call.includes(" --cached --numstat "));
  return { env, calls, classifications, pathspecs: () => readFileSync(inputLog, "utf8").split("\0") };
}

test("repository patch-format config cannot hide gitattributes or skipped-test findings", async () => {
  mkdirSync(join(work, "sub"));
  writeFileSync(join(work, "sub", "keep.txt"), "keep\n");
  writeFileSync(join(work, ".gitattributes"), "*.ts -diff\n");
  writeFileSync(join(work, "sample.test.ts"), edited);
  await commitAll(work, "conceal");
  const settings = [
    ["color.ui", "always"],
    ["color.diff", "always"],
    ["diff.noprefix", "true"],
    ["diff.dstPrefix", "x/"],
    ["diff.srcPrefix", "y/"],
    ["diff.mnemonicPrefix", "true"],
    ["diff.relative", "true"],
    ["diff.submodule", "log"],
    ["color.diff.new", "red"],
  ];
  for (const configs of [...settings.map((setting) => [setting]), settings]) {
    for (const [key, value] of configs) await git(work, "config", key ?? "", value ?? "");
    const diff = await diffSince(work, base);
    const rules = auditDiff(diff, { taskClass: null, protectedPaths: [] }).map((f) => f.rule);
    expect(rules).toContain("gitattributes");
    expect(rules).toContain("test-skipped");
    const fromSubdirectory = await worktreeGit(["git", "diff", base, "HEAD"], { cwd: join(work, "sub") });
    for (const output of [diff.patch, (await factory("log", "-p", "-1")).stdout, fromSubdirectory.stdout]) {
      expect(output).not.toContain("\x1b[");
      expect(output).toContain("diff --git a/sample.test.ts b/sample.test.ts\n");
      expect(output).toContain("--- a/sample.test.ts\n+++ b/sample.test.ts\n");
      expect(output).toContain(`\n-${original.trim()}\n+${edited.trim()}\n`);
      expect(output).toContain("+++ b/.gitattributes\n@@ -0,0 +1 @@\n+*.ts -diff\n");
    }
    for (const [key] of configs) await git(work, "config", "--unset", key ?? "");
  }
});

test("effective attributes block hiding enabled by deletions, base macros and nested files", async () => {
  mkdirSync(join(work, "pkg"));
  writeFileSync(join(work, "pkg", "a.ts"), "export const a = 1;\n");
  writeFileSync(
    join(work, ".gitattributes"),
    "[attr]quiet -diff\n*.ts -diff\n*.test.ts diff\npkg/*.ts diff\n",
  );
  await commitAll(work, "base attributes");
  const revision = await headSha(work);
  const cases: [string, Record<string, string>, string, string | null][] = [
    [
      "deleted override",
      { ".gitattributes": "[attr]quiet -diff\n*.ts -diff\npkg/*.ts diff\n" },
      "sample.test.ts",
      "-diff",
    ],
    [
      "base macro",
      { ".gitattributes": "[attr]quiet -diff\n*.test.ts quiet\npkg/*.ts diff\n" },
      "sample.test.ts",
      "-diff",
    ],
    ["nested file", { "pkg/.gitattributes": "a.ts linguist-generated\n" }, "pkg/a.ts", "linguist-generated"],
    [
      "generated",
      { ".gitattributes": "[attr]quiet -diff\n*.test.ts linguist-generated=true\npkg/*.ts diff\n" },
      "sample.test.ts",
      "linguist-generated=true",
    ],
    ["safe attribute", { "pkg/.gitattributes": "*.ts eol=lf\n" }, "pkg/a.ts", null],
    ["removed hiding", { ".gitattributes": "*.test.ts diff\npkg/*.ts diff\n" }, "flag.test.ts", null],
  ];
  for (const [name, files, changed, hidden] of cases) {
    await git(work, "reset", "-q", "--hard", revision);
    for (const [path, content] of Object.entries(files)) writeFileSync(join(work, path), content);
    writeFileSync(join(work, changed), `${readFileSync(join(work, changed), "utf8")}// ${name}\n`);
    await commitAll(work, name);
    const diff = await diffSince(work, revision);
    const entry = diff.attributes?.find((a) => a.path === changed);
    for (const tree of [entry?.base, entry?.head])
      expect(Object.keys(tree ?? {}).sort()).toEqual(
        ["binary", "diff", "filter", "linguist-generated", "merge", "text"].sort(),
      );
    const finding = attributeBlocksOf(auditDiff(diff, { taskClass: null, protectedPaths: [] })).find(
      (f) => f.file === changed,
    );
    if (hidden === null) expect(finding).toBeUndefined();
    else {
      expect(finding?.detail).toContain(hidden);
      expect(finding?.detail).toContain("If this is intended, add `Allow: gitattributes` to the request.");
    }
  }
});

test("three-dot attribute comparisons use the merge base, not the advanced target", async () => {
  writeFileSync(join(work, ".gitattributes"), "*.ts -diff\n*.test.ts diff\n");
  await commitAll(work, "base attributes");
  await git(work, "branch", "target");
  writeFileSync(join(work, ".gitattributes"), "*.ts -diff\n");
  writeFileSync(join(work, "sample.test.ts"), edited);
  await commitAll(work, "worker deletes override");
  await git(work, "checkout", "-q", "target");
  writeFileSync(join(work, ".gitattributes"), "*.ts -diff\n");
  await commitAll(work, "target deletes override too");
  const target = await headSha(work);
  await git(work, "checkout", "-q", "worker");
  const findings = auditDiff(await diffSince(work, target, undefined, true), {
    taskClass: null,
    protectedPaths: [],
  });
  expect(attributeBlocksOf(findings)).toContainEqual(expect.objectContaining({ file: "sample.test.ts" }));
});

test("upper- and mixed-case attribute files are inspected at any depth, renamed or binary", async () => {
  mkdirSync(join(work, "pkg"));
  writeFileSync(join(work, "pkg", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(work, "attributes.txt"), "*.ts filter=x\n");
  await commitAll(work, "base");
  const revision = await headSha(work);
  for (const [path, content, rename] of [
    [".GITATTRIBUTES", "*.ts -diff\n", false],
    ["pkg/.GitAttributes", "*.ts -diff\n# \0binary\n", false],
    ["pkg/.gitATTRIBUTES", "", true],
  ] as const) {
    await git(work, "reset", "-q", "--hard", revision);
    if (rename) await git(work, "mv", "attributes.txt", path);
    else writeFileSync(join(work, path), content);
    await commitAll(work, path);
    const diff = await diffSince(work, revision);
    const rule = rename ? "*.ts filter=x" : "*.ts -diff";
    expect(diff.attributePatch).toContain(`+${rule}`);
    expect(attributeBlocksOf(auditDiff(diff, { taskClass: null, protectedPaths: [] }))).toContainEqual(
      expect.objectContaining({
        severity: "block",
        file: path,
        detail: expect.stringContaining(rule.split(" ")[0] ?? ""),
      }),
    );
  }
});

test("built-in diff drivers and binary-only patterns are harmless; text at either tree blocks", async () => {
  const nulAt = (index: number) => Buffer.concat([Buffer.alloc(index, 0x61), Buffer.from([0])]);
  writeFileSync(join(work, "Main.java"), "class Main {}\n");
  writeFileSync(join(work, "README.md"), "# readme\n");
  writeFileSync(join(work, "text.bmp"), "text\n");
  writeFileSync(join(work, "logo.gif"), "text\n");
  writeFileSync(join(work, "photo.jpg"), Buffer.from([0, 1]));
  await commitAll(work, "base");
  const revision = await headSha(work);
  const cases: [string, Record<string, string | Buffer>, boolean][] = [
    ["*.java diff=java", { "Main.java": "class Main { int x; }\n" }, false],
    ["*.md diff=markdown", { "README.md": "# changed\n" }, false],
    ["*.png binary", { "icon.png": Buffer.from([0x89, 0, 1]) }, false],
    ["*.ico -diff", { "icon.ico": Buffer.from([0x89, 0, 1]) }, false],
    ["*.pdf binary", {}, false],
    ["*.pdf -diff", {}, false],
    ["*.dat binary", { "edge.dat": nulAt(7_999) }, false],
    ["*.dat binary", { "edge.dat": nulAt(8_000) }, true],
    ["*.bmp binary", { "icon.bmp": Buffer.from([0x89, 0, 1]) }, true],
    ["*.gif binary", { "logo.gif": Buffer.from([0, 1]) }, true],
    ["*.jpg -diff", { "photo.jpg": "now text\n" }, true],
    ["*.java diff=java filter=custom", { "Main.java": "class Main { int y; }\n" }, true],
  ];
  for (const [line, files, blocked] of cases) {
    await git(work, "reset", "-q", "--hard", revision);
    writeFileSync(join(work, ".gitattributes"), `${line}\n`);
    for (const [path, content] of Object.entries(files)) writeFileSync(join(work, path), content);
    await commitAll(work, line);
    const findings = attributeBlocksOf(
      auditDiff(await diffSince(work, revision), { taskClass: null, protectedPaths: [] }),
    );
    expect([line, findings.length > 0]).toEqual([line, blocked]);
  }
});

test("local repositories classify content with an explicit empty attribute source", async () => {
  writeFileSync(join(work, "image.png"), "base text\n");
  await commitAll(work, "base text image");
  const revision = await headSha(work);
  const shim = gitShim();
  for (const line of ["*.png binary", "*.png -diff"]) {
    writeFileSync(join(work, ".gitattributes"), `${line}\n`);
    await commitAll(work, line);
    const findings = await worktreeGitScope.run(false, async () =>
      auditDiff(await diffSince(work, revision, shim.env), { taskClass: null, protectedPaths: [] }),
    );
    expect(attributeBlocksOf(findings)).toContainEqual(
      expect.objectContaining({ severity: "block", detail: expect.stringContaining("image.png") }),
    );
  }
  expect(shim.classifications().length).toBeGreaterThan(0);
  for (const call of shim.classifications()) {
    expect(call).toStartWith("--git-dir=");
    expect(call).toContain(` --attr-source=${EMPTY_TREE} `);
    const scratch = call.match(/^--git-dir=(\S+)/)?.[1];
    expect(scratch).toBeDefined();
    expect(scratch && existsSync(scratch)).toBe(false);
    expect(call).toContain(" diff --cached --numstat");
  }
});

test("content classification covers changed blobs and pattern candidates within a deadline", async () => {
  mkdirSync(join(work, "assets"));
  for (let i = 0; i < 20; i++) writeFileSync(join(work, `unrelated-${i}.ts`), `export const x${i} = ${i};\n`);
  writeFileSync(join(work, "assets", "icon.png"), Buffer.from([0x89, 0, 1]));
  writeFileSync(join(work, "Main.java"), "class Main {}\n");
  await commitAll(work, "base");
  const revision = await headSha(work);
  const audit = async (env: Record<string, string>) =>
    attributeBlocksOf(
      auditDiff(await diffSince(work, revision, env), { taskClass: null, protectedPaths: [] }),
    );

  let shim = gitShim();
  writeFileSync(join(work, "Main.java"), "class Main { int x; }\n");
  await commitAll(work, "ordinary edit");
  expect(await audit(shim.env)).toEqual([]);
  expect(shim.calls().some((call) => call.includes("check-attr"))).toBe(false);
  expect(shim.classifications()).toHaveLength(2);
  for (const call of shim.classifications()) expect(call).not.toContain("unrelated-");

  shim = gitShim();
  writeFileSync(join(work, ".gitattributes"), "*.java diff=java\n");
  await commitAll(work, "driver only");
  expect(await audit(shim.env)).toEqual([]);
  expect(shim.classifications()).toHaveLength(2);
  for (const call of shim.classifications()) expect(call).not.toContain("unrelated-");

  shim = gitShim();
  writeFileSync(join(work, ".gitattributes"), "*.java diff=java\nassets/icon.png binary\n");
  await commitAll(work, "narrow binary rule");
  expect(await audit(shim.env)).toEqual([]);
  expect(shim.classifications()).toHaveLength(4);
  expect(shim.pathspecs().filter((path) => path === ":(glob,icase)assets/icon.png")).toHaveLength(2);
  for (const call of shim.classifications()) expect(call).not.toContain(":(glob,icase)");
  for (const call of shim.calls().filter((call) => call.includes(" reset ")))
    expect(call).toContain("--pathspec-from-file=- --pathspec-file-nul");
  for (const call of shim.classifications()) expect(call).not.toContain("unrelated-");

  shim = gitShim(true);
  const previous = attributeLimits.timeoutMs;
  attributeLimits.timeoutMs = 300;
  const started = Date.now();
  try {
    const findings = await audit(shim.env);
    expect(Date.now() - started).toBeLessThan(10_000);
    // Unclassified, the binary rule is not exempt, and the timeout itself blocks.
    expect(findings).toContainEqual(expect.objectContaining({ file: ".gitattributes", severity: "block" }));
    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "block",
        detail: expect.stringContaining("attribute inspection timed out after 300 ms"),
      }),
    );
  } finally {
    attributeLimits.timeoutMs = previous;
  }
});

test("worktreeGit rejects leading options that take a separate value", async () => {
  await worktreeGitScope.run(true, async () => {
    for (const option of ["-C", "--git-dir", "--work-tree", "--namespace"])
      await expect(worktreeGit(["git", option, work, "status"], { cwd: work })).rejects.toThrow(
        `worktreeGit: pass ${option} as a single --opt=value token`,
      );
    expect(
      (await worktreeGit(["git", "-c", "advice.statusHints=false", "status", "--short"], { cwd: work }))
        .exitCode,
    ).toBe(0);
  });
});

test.each(["nul.test.ts", "sample.test.ts", "nul\ttest.test.ts", "nul\ntest.test.ts"])(
  "binary bytes block hidden test content in %s; only the binary allowance suppresses it",
  async (path) => {
    writeFileSync(join(work, path), `// \0\n${edited}${original}`);
    await commitAll(work, "test with NUL");
    const diff = await diffSince(work, base);
    expect(diff.patch).toContain("Binary files");
    expect(diff.patch).not.toContain("test.skip(");
    for (const allow of [
      [],
      ["submodules"],
      ["gitattributes"],
      ["submodules", "gitattributes"],
      parseAllow("Please Allow: binary"),
      parseAllow("> Allow: binary"),
      parseAllow("Allow: binary, please"),
      parseAllow("  ALLOW: Binary\r\n"),
    ] as AuditAllowance[][]) {
      const findings = auditDiff(diff, { taskClass: null, protectedPaths: [], allow });
      const binary = findings.filter((f) => f.rule === "binary-content");
      if (allow.includes("binary")) expect(binary).toEqual([]);
      else {
        expect(binary).toEqual([expect.objectContaining({ file: path, severity: "block" })]);
        expect(binary[0]?.detail).toContain("NUL");
        expect(binary[0]?.detail).toContain("hide the content from review");
        expect(binary[0]?.detail).toContain("Allow: binary");
      }
    }
  },
);

test.each([
  ["unknown.blob", false, true],
  ["added.png", false, false],
  ["text.png", true, true],
  ["binary.ts", true, true],
])("binary content in %s uses its base classification (%s)", async (path, exists, blocks) => {
  if (exists) {
    writeFileSync(join(work, path), path === "binary.ts" ? Buffer.from([0, 1]) : "base text\n");
    await commitAll(work, "base blob");
  }
  const revision = await headSha(work);
  writeFileSync(join(work, path), Buffer.from([0, 2]));
  await commitAll(work, "binary blob");
  const findings = auditDiff(await diffSince(work, revision), { taskClass: null, protectedPaths: [] });
  expect(findings.some((f) => f.rule === "binary-content" && f.severity === "block")).toBe(blocks);
});

test("attributes cannot force a binary-content finding for text", async () => {
  writeFileSync(join(work, ".gitattributes"), "*.ts binary\n");
  writeFileSync(join(work, "sample.test.ts"), edited);
  await commitAll(work, "hidden text");
  const findings = await worktreeGitScope.run(false, async () =>
    auditDiff(await diffSince(work, base), { taskClass: null, protectedPaths: [] }),
  );
  expect(attributeBlocksOf(findings).length).toBeGreaterThan(0);
  expect(findings.filter((f) => f.rule === "binary-content")).toEqual([]);
});

test("a rename from text to a binary image keeps its text origin", async () => {
  const text = Array.from({ length: 200 }, (_, i) => `original line ${i}\n`).join("");
  writeFileSync(join(work, "origin.txt"), text);
  await commitAll(work, "text origin");
  const revision = await headSha(work);
  await git(work, "config", "diff.renames", "false");
  await git(work, "mv", "origin.txt", "moved.png");
  writeFileSync(join(work, "moved.png"), `\0${text}`);
  await commitAll(work, "renamed binary");
  const diff = await diffSince(work, revision);
  expect(diff.files).toContainEqual(expect.objectContaining({ path: "moved.png", from: "origin.txt" }));
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toContainEqual(
    expect.objectContaining({ rule: "binary-content", severity: "block", file: "moved.png" }),
  );
});

test.each([
  ["src/**/*.impl.ts -diff", "block"],
  ["*.png -diff", "warn"],
  ["*.zip binary", "warn"],
  ["*.woff2 -diff", "warn"],
  ["*.mp4 -diff", "warn"],
  ["*.unknown -diff", "block"],
  ["* -diff", "block"],
])("unmatched hiding rule %s produces a %s", async (line, severity) => {
  writeFileSync(join(work, ".gitattributes"), `${line}\n`);
  await commitAll(work, "unmatched rule");
  const findings = auditDiff(await diffSince(work, base), { taskClass: null, protectedPaths: [] });
  expect(findings).toContainEqual(
    expect.objectContaining({
      rule: "gitattributes",
      severity,
      file: ".gitattributes",
      detail: expect.stringContaining(line.split(" ")[0] ?? ""),
    }),
  );
  if (severity === "warn") {
    expect(attributeBlocksOf(findings)).toEqual([]);
    expect(findings[0]?.detail).toContain("matches no files yet");
  }
});

test.each([
  ["png", "valid", false],
  ["psd", "valid", false],
  ["onnx", "valid", false],
  ["\npointer.png", "valid", false],
  ["ts", "valid", true],
  ["png", "missing oid", true],
  ["psd", "missing oid", true],
  ["png", "missing size", true],
  ["png", "invalid hash", true],
  ["png", "invalid size", true],
])("LFS pointer %s (%s) receives only the non-source-path exemption", async (extension, kind, blocks) => {
  let pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 68\n`;
  if (kind === "missing oid") pointer = pointer.replace(/oid.*\n/, "");
  if (kind === "missing size") pointer = pointer.replace(/size.*\n/, "");
  if (kind === "invalid hash") pointer = pointer.replace("a".repeat(64), "bad");
  if (kind === "invalid size") pointer = pointer.replace("size 68", "size -1");
  writeFileSync(join(work, `pointer.${extension}`), pointer);
  writeFileSync(
    join(work, ".gitattributes"),
    `*.${extension.endsWith("png") ? "png" : extension} filter=lfs diff=lfs merge=lfs -text\n`,
  );
  // Bypass any globally installed clean filter; commit exactly these pointer bytes.
  await worktreeGit(["git", "-c", "filter.lfs.clean=cat", "-c", "filter.lfs.required=false", "add", "-A"], {
    cwd: work,
  });
  await factory("commit", "-qm", "LFS pointer fixture");
  const findings = auditDiff(await diffSince(work, base), { taskClass: null, protectedPaths: [] });
  expect(attributeBlocksOf(findings).length > 0).toBe(blocks);
  expect(findings.filter((f) => f.rule === "binary-content")).toEqual([]);
});

test.each(["diff", "-diff"])(
  "info attributes (%s) cannot alter binary-content classification",
  async (attr) => {
    const info = resolve(work, (await git(work, "rev-parse", "--git-path", "info/attributes")).stdout.trim());
    writeFileSync(info, `*.ts ${attr}\n`);
    writeFileSync(join(work, "sample.test.ts"), `// \0\n${edited}`);
    await commitAll(work, "binary with info attributes");
    const findings = auditDiff(await diffSince(work, base), { taskClass: null, protectedPaths: [] });
    expect(findings).toContainEqual(
      expect.objectContaining({
        rule: "binary-content",
        severity: "block",
        file: "sample.test.ts",
      }),
    );
  },
);

test("binary-content classification works for SHA-256 repositories", async () => {
  const repo = join(dir, "sha256");
  mkdirSync(repo);
  await git(repo, "init", "-q", "--object-format=sha256");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "old.txt"), "base text\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  const revision = await headSha(repo);
  writeFileSync(join(repo, "old.txt"), "base\0text\n");
  writeFileSync(join(repo, "new.ts"), "// \0\n");
  await commitAll(repo, "binary");
  expect(
    auditDiff(await diffSince(repo, revision), { taskClass: null, protectedPaths: [] })
      .filter((f) => f.rule === "binary-content")
      .map((f) => f.file)
      .sort(),
  ).toEqual(["new.ts", "old.txt"]);
});

test.each(["diff", "-diff"])(
  "global attributes (%s) cannot alter local binary classification",
  async (attr) => {
    const config = join(dir, "global.config");
    const attrs = join(dir, "global.attributes");
    writeFileSync(config, `[core]\nattributesFile = ${attrs}\n`);
    writeFileSync(attrs, `*.ts ${attr}\n`);
    writeFileSync(join(work, "sample.test.ts"), `// \0\n${edited}`);
    await commitAll(work, "binary with global attributes");
    const env = { ...(process.env as Record<string, string>), GIT_CONFIG_GLOBAL: config };
    const findings = await worktreeGitScope.run(false, async () =>
      auditDiff(await diffSince(work, base, env), { taskClass: null, protectedPaths: [] }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        rule: "binary-content",
        severity: "block",
        file: "sample.test.ts",
      }),
    );
  },
);

test("moving an existing binary into a new source path blocks", async () => {
  writeFileSync(join(work, "image.png"), Buffer.from([0, 1, 2]));
  await commitAll(work, "binary base");
  const revision = await headSha(work);
  await git(work, "mv", "image.png", "hidden.test.ts");
  await commitAll(work, "new source path");
  const diff = await diffSince(work, revision);
  expect(diff.files).toContainEqual(expect.objectContaining({ from: "image.png", path: "hidden.test.ts" }));
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toContainEqual(
    expect.objectContaining({ rule: "binary-content", severity: "block", file: "hidden.test.ts" }),
  );
});

test.each(["nul.test.mts", "nul.cts", "nul.jsx", "lib/helper.dat", "script", "state.snap"])(
  "new and edited binary head content blocks in %s",
  async (path) => {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), "text\0hidden\n");
    await commitAll(work, "binary addition");
    for (const revision of [base, await headSha(work)]) {
      writeFileSync(join(work, path), "changed\0hidden\n");
      await commitAll(work, "binary edit");
      const diff = await diffSince(work, revision);
      expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toContainEqual(
        expect.objectContaining({ rule: "binary-content", file: path, severity: "block" }),
      );
      expect(auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["binary"] })).toEqual([]);
    }
    writeFileSync(join(work, path), "ordinary text\n");
    await commitAll(work, "text base");
    const textBase = await headSha(work);
    writeFileSync(join(work, path), "changed\0hidden\n");
    await commitAll(work, "text to binary edit");
    expect(
      auditDiff(await diffSince(work, textBase), { taskClass: null, protectedPaths: [] }),
    ).toContainEqual(expect.objectContaining({ rule: "binary-content", file: path, severity: "block" }));
  },
);

const assetExtensions = [
  "png",
  "pdf",
  "woff2",
  "jar",
  "war",
  "apk",
  "whl",
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "psd",
  "ai",
  "heic",
  "wasm",
  "so",
  "dll",
  "dylib",
  "exe",
  "class",
  "pyc",
  "sqlite",
  "db",
  "glb",
  "fbx",
  "blend",
];
test("known binary extensions exempt assets and unmatched attribute rules", async () => {
  writeFileSync(join(work, ".gitattributes"), assetExtensions.map((ext) => `*.${ext} binary\n`).join(""));
  await commitAll(work, "unmatched asset rules");
  let diff = await diffSince(work, base);
  let findings = auditDiff(diff, { taskClass: null, protectedPaths: [] });
  expect(findings.filter((f) => f.severity === "block")).toEqual([]);
  expect(findings).toHaveLength(assetExtensions.length);
  const revision = await headSha(work);
  for (const ext of assetExtensions) writeFileSync(join(work, `asset.${ext}`), Buffer.from([0, 1, 2]));
  await commitAll(work, "ordinary assets");
  diff = await diffSince(work, revision);
  findings = auditDiff(diff, { taskClass: null, protectedPaths: [] });
  expect(diff.attributeErrors).toBeUndefined();
  expect(findings).toEqual([]);
});

test("16,000 added files use stdin pathspecs without uncertainty findings", async () => {
  const files = Array.from({ length: 16_000 }, (_, i) => `${i}-${"long-name-".repeat(12)}.dat`);
  for (const path of files) writeFileSync(join(work, path), "new text\n");
  await commitAll(work, "large addition");
  const diff = await diffSince(work, base);
  expect(diff.files).toHaveLength(files.length);
  expect(diff.headTextPaths).toHaveLength(files.length);
  expect(diff.attributeErrors).toBeUndefined();
  expect(diff.binaryErrors).toBeUndefined();
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toEqual([]);
}, 120_000);

test("failed binary classification blocks even with attribute and binary allowances", async () => {
  writeFileSync(join(work, "payload.dat"), Buffer.from([0, 1]));
  await commitAll(work, "payload");
  const shim = gitShim("fail");
  const diff = await diffSince(work, base, shim.env);
  for (const allow of [["gitattributes"], ["gitattributes", "binary"]] as AuditAllowance[][]) {
    const findings = auditDiff(diff, { taskClass: null, protectedPaths: [], allow });
    expect(findings).toContainEqual(
      expect.objectContaining({
        rule: "binary-content",
        severity: "block",
        detail: expect.stringContaining("classification-broke"),
      }),
    );
  }
});

test("existing hiding warnings group text paths per rule and omit binary PNGs", async () => {
  writeFileSync(
    join(work, ".gitattributes"),
    "gen/** linguist-generated\nother/** linguist-generated\n*.png binary\n",
  );
  await commitAll(work, "base hiding rules");
  const revision = await headSha(work);
  for (const directory of ["gen", "other"]) mkdirSync(join(work, directory));
  for (let i = 0; i < 312; i++) writeFileSync(join(work, "gen", `${i}.dat`), "generated text\n");
  for (let i = 0; i < 2; i++) writeFileSync(join(work, "other", `${i}.dat`), "other generated text\n");
  writeFileSync(join(work, "photo.png"), Buffer.from([0, 1]));
  await commitAll(work, "generated text and binary asset");
  const findings = auditDiff(await diffSince(work, revision), { taskClass: null, protectedPaths: [] });
  expect(findings).toHaveLength(2);
  expect(findings).toContainEqual(
    expect.objectContaining({
      severity: "warn",
      detail: expect.stringContaining("312"),
    }),
  );
  expect(findings.map((f) => f.detail).some((detail) => detail.includes("gen/** linguist-generated"))).toBe(
    true,
  );
  expect(findings.map((f) => f.detail).some((detail) => detail.includes("other/** linguist-generated"))).toBe(
    true,
  );
  expect(findings.some((f) => f.file === "photo.png")).toBe(false);
});

test.each(["valid", "missing oid", "missing size", "invalid hash", "invalid size", "extra line"])(
  "binary edits of %s base LFS pointers require a strict pointer exemption",
  async (kind) => {
    let pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 2\n`;
    if (kind === "missing oid") pointer = pointer.replace(/oid.*\n/, "");
    if (kind === "missing size") pointer = pointer.replace(/size.*\n/, "");
    if (kind === "invalid hash") pointer = pointer.replace("a".repeat(64), "bad");
    if (kind === "invalid size") pointer = pointer.replace("size 2", "size -1");
    if (kind === "extra line") pointer += "extra\n";
    for (const path of ["tracked.png", "tracked.dat", "tracked.ts"]) writeFileSync(join(work, path), pointer);
    writeFileSync(join(work, ".gitattributes"), "tracked.* filter=lfs diff=lfs merge=lfs -text\n");
    // Disable LFS explicitly: neither clean nor smudge may need git-lfs installed.
    await worktreeGit(["git", "-c", "filter.lfs.clean=cat", "-c", "filter.lfs.required=false", "add", "-A"], {
      cwd: work,
    });
    await factory("commit", "-qm", "base LFS pointer");
    const revision = await headSha(work);
    for (const path of ["tracked.png", "tracked.dat", "tracked.ts"])
      writeFileSync(join(work, path), Buffer.from([0, 1]));
    await worktreeGit(["git", "-c", "filter.lfs.clean=cat", "-c", "filter.lfs.required=false", "add", "-A"], {
      cwd: work,
    });
    await factory("commit", "-qm", "binary LFS edit");
    const findings = auditDiff(await diffSince(work, revision), { taskClass: null, protectedPaths: [] });
    expect(findings.filter((f) => f.rule === "binary-content").length).toBe(kind === "valid" ? 0 : 3);
  },
);

test("startup sweep removes only classification directories older than one hour", () => {
  const now = Date.now();
  const paths = [
    "limitless-classify-old",
    "limitless-classify-recent",
    "limitless-classify-boundary",
    "unrelated-old",
  ];
  for (const name of paths) mkdirSync(join(dir, name));
  for (const name of [paths[0], paths[3]])
    utimesSync(join(dir, name ?? ""), new Date(now - 3_600_001), new Date(now - 3_600_001));
  utimesSync(join(dir, paths[2] ?? ""), new Date(now - 3_600_000), new Date(now - 3_600_000));
  writeFileSync(join(dir, "limitless-classify-file"), "keep");
  sweepClassificationScratch(dir, now);
  expect(existsSync(join(dir, paths[0] ?? ""))).toBe(false);
  for (const name of paths.slice(1)) expect(existsSync(join(dir, name))).toBe(true);
  expect(existsSync(join(dir, "limitless-classify-file"))).toBe(true);
});

test("info attributes cannot hide text edits from the main audit patch", async () => {
  const info = resolve(work, (await git(work, "rev-parse", "--git-path", "info/attributes")).stdout.trim());
  writeFileSync(info, "*.ts -diff\n");
  writeFileSync(join(work, "sample.test.ts"), edited);
  await commitAll(work, "text edit hidden by info attributes");
  expect((await git(work, "diff", base, "HEAD")).stdout).not.toContain("test.skip(");
  const diff = await diffSince(work, base);
  expect(diff.patch).toContain(`+${edited.trim()}`);
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toContainEqual(
    expect.objectContaining({ rule: "test-skipped", severity: "block", file: "sample.test.ts" }),
  );
});

test("UTF-16 source content remains blocked", async () => {
  writeFileSync(join(work, "unicode.ts"), Buffer.from("export const hidden = 1;\n", "utf16le"));
  await commitAll(work, "UTF-16 source");
  expect(auditDiff(await diffSince(work, base), { taskClass: null, protectedPaths: [] })).toContainEqual(
    expect.objectContaining({ rule: "binary-content", file: "unicode.ts", severity: "block" }),
  );
});
