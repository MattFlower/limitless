import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { parseAllow } from "../src/core/allow.ts";
import type { AuditAllowance, Repo } from "../src/core/types.ts";
import { Store } from "../src/db/store.ts";
import { attributeRules, auditDiff } from "../src/gates/audit.ts";
import { loadPrivateStrings } from "../src/gates/private.ts";
import { collectGarbage } from "../src/gc.ts";
import { recordWorktree, worktreeGit, worktreeGitScope } from "../src/git/command.ts";
import { completeMerge, prepareMerge } from "../src/git/merge.ts";
import {
  addDetachedWorktree,
  attributeLimits,
  blobPrivateEntries,
  checkoutCommitted,
  checkPrivateRange,
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
import { processScope, sh } from "../src/util/proc.ts";
import { seeded } from "./seeded.ts";

// These tests drive real git and subprocesses; under CPU load they outlast Bun's 5 s default (#140).
setDefaultTimeout(30_000);

let dir: string;
let seed: string;
let work: string;
let base: string;
const original = 'test("ok", () => {});\n';
const edited = 'test.skip("ok", () => {});\n';
const mediaBytes = JSON.parse(
  readFileSync(new URL("./fixtures/media/files.json", import.meta.url), "utf8"),
) as Record<string, string>;
const mediaRegressions = JSON.parse(
  readFileSync(new URL("./fixtures/media/regressions.json", import.meta.url), "utf8"),
) as Record<string, string>;
const mediaFixture = (extension: string, variant = 0) => {
  const file = `${variant}.${extension.toLowerCase().replace("jpeg", "jpg")}`;
  const encoded = mediaBytes[file] ?? mediaRegressions[file];
  if (!encoded) throw new Error(`Missing media fixture: ${file}`);
  return Buffer.from(encoded, "base64");
};
const git = (cwd: string, ...args: string[]) => sh(["git", ...args], { cwd });
const factory = (...args: string[]) => worktreeGit(["git", ...args], { cwd: work });

const seedRepo = seeded(async (root) => {
  const repo = join(root, "seed");
  mkdirSync(repo);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.com");
  for (const file of ["sample.test.ts", "flag.test.ts", "assume.test.ts"])
    writeFileSync(join(repo, file), original);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  return (await git(repo, "rev-parse", "HEAD")).stdout.trim();
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "git-integrity-"));
  seed = join(dir, "seed");
  work = join(dir, "work");
  base = (await seedRepo(dir)).value;
  await git(seed, "worktree", "add", "-qb", "worker", work, base);
  await recordWorktree(work);
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

test.each([false, true])(
  "private strings in binary or -diff content block (replacement: %s)",
  async (replace) => {
    const configDir = join(dir, "config");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "private-strings.txt"), "secret-host.example\n");
    writeFileSync(join(work, ".gitattributes"), "*.dat -diff\n");
    writeFileSync(join(work, "hidden.dat"), "SECRET-HOST.EXAMPLE\n");
    // The entry straddles a 64 KiB stream chunk boundary.
    const blob = Buffer.alloc(200_000);
    blob.write("secret-host.example", 65_530);
    writeFileSync(join(work, "blob.bin"), blob);
    await commitAll(work, "hidden content");
    if (replace) {
      const original = (await git(work, "rev-parse", "HEAD:blob.bin")).stdout.trim();
      const clean = (
        await sh(["git", "hash-object", "-w", "--stdin"], { cwd: work, stdin: "clean\0" })
      ).stdout.trim();
      await git(work, "replace", original, clean);
      expect((await git(work, "cat-file", "blob", original)).stdout).toBe("clean\0");
    }
    // Without a denylist no blob is read.
    expect((await diffSince(work, base)).privateHits).toEqual([]);
    const diff = await diffSince(work, base, undefined, false, loadPrivateStrings(configDir));
    expect(diff.privateHits).toContainEqual({ path: "blob.bin", entry: 1 });
    expect(diff.patch).not.toContain("secret-host.example");
    const findings = auditDiff(diff, { configDir, taskClass: null, protectedPaths: [] }).filter(
      (f) => f.rule === "private-string",
    );
    expect(findings.map((f) => f.file).sort()).toEqual(["blob.bin", "hidden.dat"]);
    expect(findings.every((f) => f.severity === "block")).toBe(true);
    expect(JSON.stringify(findings).toLowerCase()).not.toContain("secret-host.example");
  },
);

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
}, 30_000);

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
  // The factory's add runs no filter driver, whatever attributes select.
  expect(filteredOnAdd).toBe(false);
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
  const worktreeBytes = readFileSync(worktreeConfig);
  await expect(
    worktreeGit(["git", "commit", "--allow-empty", "-qm", "refuse"], { cwd: work, env }),
  ).rejects.toThrow("Unsafe worktree Git administration");
  expect(readFileSync(worktreeConfig)).toEqual(worktreeBytes);
  expect(existsSync(marker)).toBe(false);
  rmSync(worktreeConfig);
  writeFileSync(include, content("included") + content("worktree"));
  const paths = [system, global, include];
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

test("hooks that arrive between cached factory commands are still blanked", async () => {
  const marker = join(dir, "hook-ran");
  const hook = (name: string) =>
    `[hook "${name}"]\n\tcommand = echo ${name} >> '${marker}'\n\tevent = pre-commit\n\tevent = reference-transaction\n`;
  let round = 0;
  const commit = async () => {
    writeFileSync(join(work, "sample.test.ts"), `round ${++round}\n`);
    expect(await commitAll(work, `round ${round}`)).not.toBeNull();
    expect(existsSync(marker)).toBe(false);
  };
  await commit();
  // An include added to the shared config, then a hook added to the included file alone.
  writeFileSync(join(dir, "added.inc"), "[x]\n\ty = 1\n");
  await git(work, "config", "--add", "include.path", join(dir, "added.inc"));
  await commit();
  writeFileSync(join(dir, "added.inc"), hook("added"));
  await commit();
  // An include whose target only appears later.
  await git(work, "config", "--add", "include.path", join(dir, "later.inc"));
  await commit();
  writeFileSync(join(dir, "later.inc"), hook("later"));
  await commit();
  // Conditional includes that start to apply without their file changing.
  writeFileSync(join(dir, "branch.inc"), hook("branch"));
  await git(work, "config", "includeIf.onbranch:hooked/**.path", join(dir, "branch.inc"));
  await commit();
  // Switched through the wrapper: a plain `git checkout` would itself run the planted hooks.
  await factory("checkout", "-q", "-b", "hooked/x");
  await commit();
  writeFileSync(join(dir, "remote.inc"), hook("remote"));
  await git(
    work,
    "config",
    "includeIf.hasconfig:remote.*.url:https://hooked.invalid/**.path",
    join(dir, "remote.inc"),
  );
  await commit();
  await git(work, "remote", "add", "hooked", "https://hooked.invalid/repo.git");
  await commit();
  // Each planted hook is live: git runs it when not blanked (config hooks need Git 2.54).
  const version = (await git(work, "--version")).stdout.match(/(\d+)\.(\d+)/);
  if (version && (Number(version[1]) > 2 || Number(version[2]) >= 54)) {
    await git(work, "hook", "run", "pre-commit");
    expect(readFileSync(marker, "utf8").trim().split("\n").sort()).toEqual([
      "added",
      "branch",
      "later",
      "remote",
    ]);
  }
});

test("an unchanged worktree lists its config once and never hashes the empty tree", async () => {
  const shim = gitShim();
  const run = (...args: string[]) => worktreeGit(["git", ...args], { cwd: work, env: shim.env });
  for (let i = 0; i < 3; i++) {
    await run("status", "--porcelain");
    await run("diff", base);
    await run("log", "-1");
  }
  const calls = shim.calls();
  expect(calls.filter((call) => call.includes(" config --list "))).toHaveLength(1);
  expect(calls.filter((call) => call.includes(" --get-regexp ^hook"))).toEqual([]);
  expect(calls.filter((call) => call.includes(" hash-object "))).toEqual([]);
  // Any edit to a config source lists again.
  await git(work, "config", "user.name", "Edited");
  await run("status", "--porcelain");
  expect(shim.calls().filter((call) => call.includes(" config --list "))).toHaveLength(2);
});

test("a repository found above the working directory is listed again for every command", async () => {
  // An invalid `.git` directory doesn't stop discovery, and becoming valid later would switch repositories.
  const sub = join(work, "sub");
  mkdirSync(join(sub, ".git"), { recursive: true });
  const shim = gitShim();
  for (let i = 0; i < 3; i++)
    await worktreeGit(["git", "status", "--porcelain"], { cwd: sub, env: shim.env });
  expect(shim.calls().filter((call) => call.includes(" config --list "))).toHaveLength(3);
});

/** Every hook key git sees in `cwd`, with the value a factory command sees there: "" once blanked. */
async function hookValues(cwd: string, env = process.env as Record<string, string>) {
  const listed = await sh(["git", "config", "--null", "--name-only", "--get-regexp", "^hook\\."], {
    cwd,
    env,
    allowFail: true,
  });
  const keys = [...new Set(listed.stdout.split("\0").filter(Boolean))];
  const seen = async (key: string) => [
    key,
    (await worktreeGit(["git", "config", "--get", key], { cwd, env })).stdout,
  ];
  return Object.fromEntries(await Promise.all(keys.map(seen)));
}
const hookConfig = (name: string) => `[hook "${name}"]\n\tcommand = true\n\tevent = pre-commit\n`;
const blanked = (name: string) => ({ [`hook.${name}.command`]: "\n", [`hook.${name}.event`]: "\n" });

test("a git directory or commondir through a retargeted symlink is resolved again before reuse", async () => {
  // Recorded worktrees pin GIT_DIR and GIT_COMMON_DIR to real paths; these probes name them by hand.
  const other = join(dir, "other");
  await git(dir, "init", "-q", "-b", "main", other);
  writeFileSync(
    join(other, ".git", "config"),
    `${readFileSync(join(other, ".git", "config"))}${hookConfig("other")}`,
  );
  const probe = join(dir, "probe");
  mkdirSync(probe);
  const viaLink = { ...(process.env as Record<string, string>), GIT_DIR: join(dir, "link") };
  symlinkSync(join(seed, ".git"), join(dir, "link"));
  await worktreeGit(["git", "rev-parse", "--git-dir"], { cwd: probe, env: viaLink });
  rmSync(join(dir, "link"));
  symlinkSync(join(other, ".git"), join(dir, "link"));
  expect(await hookValues(probe, viaLink)).toEqual(blanked("other"));
  // A worktree's administrative directory whose commondir runs through a symlink.
  const admin = (await git(work, "rev-parse", "--absolute-git-dir")).stdout.trim();
  const viaAdmin = { ...(process.env as Record<string, string>), GIT_DIR: admin };
  symlinkSync(join(seed, ".git"), join(dir, "common"));
  writeFileSync(join(admin, "commondir"), `${join(dir, "common")}\n`);
  await worktreeGit(["git", "rev-parse", "--git-dir"], { cwd: probe, env: viaAdmin });
  rmSync(join(dir, "common"));
  symlinkSync(join(other, ".git"), join(dir, "common"));
  expect(await hookValues(probe, viaAdmin)).toEqual(blanked("other"));
});

test("a commondir path with a trailing space is resolved as git reads it", async () => {
  const other = join(dir, "other");
  await git(dir, "init", "-q", "-b", "main", other);
  writeFileSync(
    join(other, ".git", "config"),
    `${readFileSync(join(other, ".git", "config"))}${hookConfig("other")}`,
  );
  // Git keeps the trailing space: `common ` is the pointer, `common` only a decoy with the same target.
  for (const name of ["common", "common "]) symlinkSync(join(seed, ".git"), join(dir, name));
  const admin = (await git(work, "rev-parse", "--absolute-git-dir")).stdout.trim();
  writeFileSync(join(admin, "commondir"), `${join(dir, "common ")}\n`);
  const probe = join(dir, "probe");
  mkdirSync(probe);
  const env = { ...(process.env as Record<string, string>), GIT_DIR: admin };
  await worktreeGit(["git", "rev-parse", "--git-dir"], { cwd: probe, env });
  rmSync(join(dir, "common "));
  symlinkSync(join(other, ".git"), join(dir, "common "));
  expect(await hookValues(probe, env)).toEqual(blanked("other"));
});

test("a nested .git that stops being a repository hands over to the one above, and is listed again", async () => {
  const outer = join(dir, "outer");
  const inner = join(outer, "inner");
  await git(dir, "init", "-q", "-b", "main", outer);
  await git(dir, "init", "-q", "-b", "main", inner);
  writeFileSync(
    join(outer, ".git", "config"),
    `${readFileSync(join(outer, ".git", "config"))}${hookConfig("outer")}`,
  );
  await worktreeGit(["git", "rev-parse", "--git-dir"], { cwd: inner });
  // Without refs/ (or objects/, or a valid HEAD) git skips inner/.git and finds outer's.
  renameSync(join(inner, ".git", "refs"), join(inner, ".git", "refs.moved"));
  expect(await hookValues(inner)).toEqual(blanked("outer"));
});

test("a nested .git whose objects/ can't be searched hands over to the one above", async () => {
  const outer = join(dir, "outer-objects");
  const inner = join(outer, "inner");
  await git(dir, "init", "-q", "-b", "main", outer);
  await git(dir, "init", "-q", "-b", "main", inner);
  writeFileSync(
    join(outer, ".git", "config"),
    `${readFileSync(join(outer, ".git", "config"))}${hookConfig("outer2")}`,
  );
  await worktreeGit(["git", "rev-parse", "--git-dir"], { cwd: inner });
  // is_git_directory also needs objects/ to be searchable, not only a directory.
  const objects = join(inner, ".git", "objects");
  chmodSync(objects, 0o644);
  try {
    expect(await hookValues(inner)).toEqual(blanked("outer2"));
  } finally {
    chmodSync(objects, 0o755);
  }
});

test("a branch switch in a reftable repository is listed again, since its HEAD is not a file", async () => {
  const version = (await git(dir, "--version")).stdout.match(/(\d+)\.(\d+)/);
  if (!version || (Number(version[1]) === 2 && Number(version[2]) < 45)) return; // reftable needs Git 2.45
  const repo = join(dir, "reftable");
  await git(dir, "init", "-q", "-b", "main", "--ref-format=reftable", repo);
  writeFileSync(join(dir, "branch.inc"), hookConfig("branch"));
  await git(repo, "config", "includeIf.onbranch:hooked/**.path", join(dir, "branch.inc"));
  await worktreeGit(["git", "rev-parse", "--git-dir"], { cwd: repo });
  await git(repo, "symbolic-ref", "HEAD", "refs/heads/hooked/x");
  expect(await hookValues(repo)).toEqual(blanked("branch"));
});

test("config edited while it is being listed is listed again before the command runs", async () => {
  const bin = join(dir, "racy");
  const edited = join(dir, "edited");
  const real = Bun.which("git");
  mkdirSync(bin);
  // The first listing finishes, then the repository config gains a hook before git exits.
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncase "$* " in *" config --list "*) if [ ! -e '${edited}' ]; then out=$('${real}' "$@" | base64); touch '${edited}'; '${real}' -C '${seed}' config hook.racy.command true; '${real}' -C '${seed}' config hook.racy.event pre-commit; printf '%s' "$out" | base64 -d; exit 0; fi;; esac\nexec '${real}' "$@"\n`,
    { mode: 0o755 },
  );
  const env = { ...(process.env as Record<string, string>), PATH: `${bin}:${process.env.PATH}` };
  expect(
    (await worktreeGit(["git", "config", "--get", "hook.racy.command"], { cwd: work, env })).stdout,
  ).toBe("\n");
  expect(existsSync(edited)).toBe(true);
});

test("hooks added through GIT_CONFIG_* variables are blanked in an already cached worktree", async () => {
  await worktreeGit(["git", "rev-parse", "--git-dir"], { cwd: work });
  const env = {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "hook.envy.command",
    GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_KEY_1: "hook.envy.event",
    GIT_CONFIG_VALUE_1: "pre-commit",
  };
  expect(await hookValues(work, env)).toEqual(blanked("envy"));
});

test("a global or XDG config file created after caching is listed again", async () => {
  const { GIT_CONFIG_GLOBAL: _global, ...base } = process.env as Record<string, string>;
  const home = join(dir, "home");
  const variants: [Record<string, string>, string][] = [
    [{ ...base, GIT_CONFIG_GLOBAL: join(dir, "global.config") }, join(dir, "global.config")],
    [{ ...base, HOME: home, XDG_CONFIG_HOME: join(home, "xdg") }, join(home, "xdg", "git", "config")],
  ];
  for (const [env, file] of variants) {
    await worktreeGit(["git", "rev-parse", "--git-dir"], { cwd: work, env });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, hookConfig("global"));
    expect(await hookValues(work, env)).toEqual(blanked("global"));
  }
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
      ? `case "$* " in *" --cached --raw --numstat "*) ${stall === "fail" ? "echo classification-broke >&2; exit 1" : "sleep 30"};; esac`
      : "",
    `case "$* " in *" --pathspec-from-file=- "*) cat > '${inputLog}'.$$; cat '${inputLog}'.$$ >> '${inputLog}'; exec '${Bun.which("git")}' "$@" < '${inputLog}'.$$;; esac`,
    `exec '${Bun.which("git")}' "$@"`,
  ].join("\n");
  writeFileSync(join(bin, "git"), script, { mode: 0o755 });
  const env = { ...(process.env as Record<string, string>), PATH: `${bin}:${process.env.PATH}` };
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const classifications = () => calls().filter((call) => call.includes(" --cached --raw --numstat "));
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
}, 30_000);

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
}, 30_000);

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
}, 30_000);

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
    ["*.pdf binary", {}, true],
    ["*.pdf -diff", {}, true],
    ["*.dat binary", { "edge.dat": nulAt(7_999) }, false],
    ["*.dat binary", { "edge.dat": nulAt(8_000) }, false],
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
}, 30_000);

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
    expect(call).toContain(" diff --cached --raw --numstat");
  }
});

test("pointer candidates are read in one batch per tree, and multi-byte text cannot misalign it", async () => {
  // Distinct text blobs of 126-200 bytes are LFS pointer candidates: per-blob reads timed out on
  // a few thousand of them. The pointer comes after 300 multi-byte UTF-8 blobs in the same batch.
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 42\n`;
  for (let i = 0; i < 300; i++) writeFileSync(join(work, `text-${i}.txt`), `${"é".repeat(65)} ${i}\n`);
  writeFileSync(join(work, "zz-asset.png"), pointer);
  await commitAll(work, "pointer candidates");
  const revision = await headSha(work);
  for (let i = 0; i < 300; i++) writeFileSync(join(work, `text-${i}.txt`), `${"é".repeat(65)} ${i}!\n`);
  writeFileSync(join(work, "zz-asset.png"), Buffer.from([0x89, 0, 1]));
  await commitAll(work, "candidate edits");
  const shim = gitShim();
  const findings = await worktreeGitScope.run(false, async () =>
    auditDiff(await diffSince(work, revision, shim.env), { taskClass: null, protectedPaths: [] }),
  );
  // A base pointer cannot exempt the opaque bytes that replace it.
  expect(findings.filter((f) => f.rule === "binary-content")).toEqual([
    expect.objectContaining({ file: "zz-asset.png", severity: "block" }),
  ]);
  expect(shim.calls().filter((call) => ` ${call} `.includes(" cat-file -p "))).toEqual([]);
  expect(shim.calls().filter((call) => call.includes("cat-file --batch -Z"))).toHaveLength(2);
});

test("content classification never runs the worktree's clean filters", async () => {
  const marker = join(dir, "filter-ran");
  const filter = join(dir, "marker-filter.sh");
  writeFileSync(filter, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`, { mode: 0o755 });
  const config = join(dir, "marker.gitconfig");
  writeFileSync(config, `[filter "marker"]\n\tclean = ${filter}\n`);
  writeFileSync(join(work, ".gitattributes"), "*.txt filter=marker\n");
  writeFileSync(join(work, "a.txt"), "base\n");
  await commitAll(work, "filtered base");
  const revision = await headSha(work);
  writeFileSync(join(work, "a.txt"), "head\n");
  await commitAll(work, "filtered edit");
  const env = { ...(process.env as Record<string, string>), GIT_CONFIG_GLOBAL: config };
  await worktreeGitScope.run(false, async () =>
    auditDiff(await diffSince(work, revision, env), { taskClass: null, protectedPaths: [] }),
  );
  expect(existsSync(marker)).toBe(false);
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
}, 30_000);

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
  writeFileSync(join(work, path), path.endsWith(".png") ? mediaFixture("png") : Buffer.from([0, 2]));
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
  ["*.zip binary", "block"],
  ["*.woff2 -diff", "block"],
  ["*.mp4 -diff", "block"],
  ["*.pdf binary", "block"],
  ["*.bmp -diff", "block"],
  ["*.psd -diff", "block"],
  ["*.eot -diff", "block"],
  ["*.glb -diff", "block"],
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
  ["ts", "crlf", true],
  ["ts", "legacy", true],
  ["png", "crlf", false],
  ["png", "legacy", false],
  ["png", "missing oid", true],
  ["psd", "missing oid", true],
  ["png", "missing size", true],
  ["png", "invalid hash", true],
  ["png", "invalid size", true],
])("LFS pointer %s (%s) receives only the non-source-path exemption", async (extension, kind, blocks) => {
  let pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 68\n`;
  if (kind === "crlf") pointer = pointer.replaceAll("\n", "\r\n");
  if (kind === "legacy") pointer = pointer.replace("git-lfs", "hawser");
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
  await worktreeGit(
    [
      "git",
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.clean=cat",
      "-c",
      "filter.lfs.required=false",
      "add",
      "-A",
    ],
    {
      cwd: work,
    },
  );
  await factory("commit", "-qm", "LFS pointer fixture");
  const findings = auditDiff(await diffSince(work, base), { taskClass: null, protectedPaths: [] });
  expect(attributeBlocksOf(findings).length > 0).toBe(blocks);
  if (["valid", "crlf", "legacy"].includes(kind))
    expect(findings.filter((f) => f.rule === "binary-content")).toEqual([
      expect.objectContaining({ severity: "block", file: `pointer.${extension}` }),
    ]);
  else
    expect(findings.filter((f) => f.rule === "binary-content")).toEqual([
      expect.objectContaining({
        severity: "block",
        detail: expect.stringContaining("Malformed LFS pointer"),
      }),
    ]);
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

test("new and edited opaque binaries require the binary allowance", async () => {
  const paths = [
    "wasm",
    "WASM",
    "so",
    "dll",
    "dylib",
    "exe",
    "class",
    "pyc",
    "zip",
    "jar",
    "war",
    "apk",
    "whl",
    "tar",
    "gz",
    "bz2",
    "xz",
    "7z",
    "rar",
    "zst",
    "docx",
    "xlsx",
    "pptx",
    "odt",
    "docm",
    "sqlite",
    "db",
    "ai",
    "unknown",
    "pdf",
    "bmp",
    "psd",
    "eot",
    "glb",
    "mp4",
    "avif",
    "tif",
    "tiff",
    "heic",
    "m4a",
    "mkv",
    "mov",
    "avi",
    "webm",
    "aac",
    "fbx",
    "blend",
  ].map((ext, i) => `opaque-${i}.${ext}`);
  paths.push("bun.lockb");
  for (const path of paths) writeFileSync(join(work, path), Buffer.from([0, 1]));
  await commitAll(work, "opaque binary additions");
  const binaryBase = await headSha(work);
  for (const path of paths) writeFileSync(join(work, path), Buffer.from([0, 2]));
  await commitAll(work, "opaque binary edits");
  for (const revision of [base, binaryBase]) {
    const diff = await diffSince(work, revision);
    const findings = auditDiff(diff, { taskClass: null, protectedPaths: [] }).filter(
      (f) => f.rule === "binary-content",
    );
    expect(findings).toHaveLength(paths.length);
    for (const path of paths)
      expect(findings).toContainEqual(
        expect.objectContaining({
          file: path,
          severity: "block",
          detail: expect.stringContaining(`${path}:`),
        }),
      );
    expect(findings.every((f) => f.detail.includes("Allow: binary"))).toBe(true);
    expect(
      auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["binary"] }).filter(
        (f) => f.rule === "binary-content",
      ),
    ).toEqual([]);
  }
});

const assetExtensions = [
  "png",
  "PNG",
  "jpg",
  "jpeg",
  "gif",
  "ico",
  "webp",
  "literal.webp",
  "distance-wide.webp",
  "distance-narrow.webp",
  "lossy.webp",
  "extended.webp",
];
test("validated media exempt new and edited assets and eligible unmatched attribute rules", async () => {
  writeFileSync(join(work, ".gitattributes"), assetExtensions.map((ext) => `*.${ext} binary\n`).join(""));
  await commitAll(work, "unmatched asset rules");
  let diff = await diffSince(work, base);
  let findings = auditDiff(diff, { taskClass: null, protectedPaths: [] });
  expect(findings.filter((f) => f.severity === "block")).toEqual([]);
  expect(findings).toHaveLength(assetExtensions.length);
  const revision = await headSha(work);
  for (const [i, ext] of assetExtensions.entries())
    writeFileSync(join(work, `asset-${i}.${ext}`), mediaFixture(ext));
  const incidental = JSON.parse(
    readFileSync(new URL("./fixtures/media/incidental-mz.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  writeFileSync(join(work, "noise.webp"), Buffer.from(incidental.webp ?? "", "base64"));
  await commitAll(work, "ordinary assets");
  const binaryBase = await headSha(work);
  for (const [i, ext] of assetExtensions.entries())
    writeFileSync(join(work, `asset-${i}.${ext}`), mediaFixture(ext, 1));
  await commitAll(work, "edited assets");
  for (const start of [revision, binaryBase]) {
    diff = await diffSince(work, start);
    findings = auditDiff(diff, { taskClass: null, protectedPaths: [] });
    expect(diff.attributeErrors).toBeUndefined();
    expect(findings).toEqual([]);
  }
}, 30_000);

test("complete PDFs, ZIPs, JARs, UTF-8 TARs and WASM still require an allowance on additions and edits", async () => {
  const paths = ["pdf", "zip", "jar", "tar", "wasm"].map((ext) => `opaque.${ext}`);
  for (const path of paths) writeFileSync(join(work, path), mediaFixture(path.split(".")[1] ?? ""));
  await commitAll(work, "complete opaque additions");
  const binaryBase = await headSha(work);
  for (const path of paths) writeFileSync(join(work, path), mediaFixture(path.split(".")[1] ?? "", 1));
  await commitAll(work, "complete opaque edits");
  for (const revision of [base, binaryBase]) {
    const diff = await diffSince(work, revision);
    const findings = auditDiff(diff, { taskClass: null, protectedPaths: [] });
    expect(findings).toHaveLength(paths.length);
    for (const file of paths)
      expect(findings).toContainEqual(
        expect.objectContaining({
          file,
          rule: "binary-content",
          severity: "block",
          detail: expect.stringContaining(`${file}:`),
        }),
      );
    expect(findings.every((f) => f.detail.includes("Allow: binary"))).toBe(true);
    expect(auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["binary"] })).toEqual([]);
  }
});

test("eligible media must have complete structures, matching signatures and no appended or concatenated payload", async () => {
  const files: { path: string; original: Buffer; changed: Buffer }[] = [];
  for (const [index, extension] of assetExtensions.entries()) {
    const original = mediaFixture(extension);
    const variants = [
      Buffer.concat([original, Buffer.from("hidden trailing bytes")]),
      Buffer.concat([original, mediaFixture("zip")]),
      original.subarray(0, Math.floor(original.length / 2)),
      mediaFixture(extension.toLowerCase() === "png" ? "wav" : "png"),
      Buffer.from([0, 1, 2]),
    ];
    for (const [i, changed] of variants.entries())
      files.push({ path: `tampered-${index}-${i}.${extension}`, original, changed });
  }
  for (const { path, original } of files) writeFileSync(join(work, path), original);
  await commitAll(work, "media base");
  const mediaBase = await headSha(work);
  for (const { path, changed } of files) writeFileSync(join(work, path), changed);
  // The binary allowance must not suppress an independent attribute finding.
  writeFileSync(join(work, ".gitattributes"), "*.mp4 binary\n");
  await commitAll(work, "malformed media");
  for (const revision of [base, mediaBase]) {
    const diff = await diffSince(work, revision);
    const findings = auditDiff(diff, { taskClass: null, protectedPaths: [] });
    const binary = findings.filter((f) => f.rule === "binary-content");
    expect(binary).toHaveLength(files.length);
    for (const { path } of files)
      expect(binary).toContainEqual(expect.objectContaining({ file: path, severity: "block" }));
    const allowed = auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["binary"] });
    expect(allowed).toEqual(findings.filter((f) => f.rule !== "binary-content"));
    expect(allowed).toContainEqual(expect.objectContaining({ rule: "gitattributes", severity: "block" }));
  }
});

test("embedded image, font and audio payloads remain opaque even inside declared metadata", async () => {
  const png = mediaFixture("png"),
    gif = mediaFixture("gif"),
    jpeg = mediaFixture("jpg"),
    wav = mediaFixture("wav"),
    woff = mediaFixture("woff"),
    webp = mediaFixture("webp");
  const payload = Buffer.from("hidden opaque bytes");
  const pngChunk = Buffer.alloc(payload.length + 12);
  pngChunk.writeUInt32BE(payload.length, 0);
  pngChunk.write("tEXt", 4);
  payload.copy(pngChunk, 8);
  pngChunk.writeUInt32BE(Bun.hash.crc32(pngChunk.subarray(4, -4)), pngChunk.length - 4);
  const jpegComment = Buffer.alloc(payload.length + 4);
  jpegComment.writeUInt16BE(0xfffe, 0);
  jpegComment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(jpegComment, 4);
  const riffChunk = Buffer.alloc(8 + payload.length + (payload.length & 1));
  riffChunk.write("JUNK");
  riffChunk.writeUInt32LE(payload.length, 4);
  payload.copy(riffChunk, 8);
  const riffPayload = (b: Buffer) => {
    const result = Buffer.concat([b, riffChunk]);
    result.writeUInt32LE(result.length - 8, 4);
    return result;
  };
  const privateWoff = Buffer.concat([woff, payload]);
  privateWoff.writeUInt32BE(privateWoff.length, 8);
  privateWoff.writeUInt32BE(woff.length, 36);
  privateWoff.writeUInt32BE(payload.length, 40);
  let codecWebp = Buffer.concat([webp.subarray(0, 20 + webp.readUInt32LE(16)), payload]);
  codecWebp.writeUInt32LE(codecWebp.length - 20, 16);
  if (codecWebp.readUInt32LE(16) & 1) {
    // RIFF padding is outside the codec's declared byte range.
    codecWebp = Buffer.concat([codecWebp, Buffer.from([0])]);
  }
  codecWebp.writeUInt32LE(codecWebp.length - 8, 4);
  // Keep the font's directory, checksums and declared cmap length consistent while
  // inserting bytes the character mapping never references.
  const ttf = mediaFixture("ttf"),
    count = ttf.readUInt16BE(4);
  const directory = Buffer.from(ttf.subarray(0, 12 + count * 16)),
    tables: Buffer[] = [];
  let offset = directory.length,
    headOffset = 0;
  const checksum = (bytes: Buffer) => {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 4) sum = (sum + bytes.readUInt32BE(i)) >>> 0;
    return sum;
  };
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16,
      tag = ttf.toString("ascii", at, at + 4);
    let data = Buffer.from(
      ttf.subarray(ttf.readUInt32BE(at + 8), ttf.readUInt32BE(at + 8) + ttf.readUInt32BE(at + 12)),
    );
    if (tag === "cmap") {
      data = Buffer.concat([data, Buffer.from("hidden opaque bytes!")]);
      const subtable = data.readUInt32BE(8);
      data.writeUInt16BE(data.readUInt16BE(subtable + 2) + 20, subtable + 2);
    }
    if (tag === "head") {
      headOffset = offset;
      data.writeUInt32BE(0, 8);
    }
    const padded = Buffer.alloc((data.length + 3) & ~3);
    data.copy(padded);
    directory.writeUInt32BE(checksum(padded), at + 4);
    directory.writeUInt32BE(offset, at + 8);
    directory.writeUInt32BE(data.length, at + 12);
    tables.push(padded);
    offset += padded.length;
  }
  const tablePayload = Buffer.concat([directory, ...tables]);
  tablePayload.writeUInt32BE((0xb1b0afba - checksum(tablePayload)) >>> 0, headOffset + 8);
  const ancillaryMp3 = mediaFixture("mp3");
  payload.copy(ancillaryMp3, ancillaryMp3.length - payload.length - 8);
  const files: Record<string, Buffer> = {
    "embedded.png": Buffer.concat([png.subarray(0, -12), pngChunk, png.subarray(-12)]),
    "embedded.gif": Buffer.concat([
      gif.subarray(0, -1),
      Buffer.from([0x21, 0xfe, payload.length]),
      payload,
      Buffer.from([0, 0x3b]),
    ]),
    "embedded.jpg": Buffer.concat([jpeg.subarray(0, 2), jpegComment, jpeg.subarray(2)]),
    "embedded.webp": riffPayload(webp),
    "embedded-codec.webp": codecWebp,
    "embedded-entropy.jpg": Buffer.concat([jpeg.subarray(0, -2), payload, jpeg.subarray(-2)]),
    "embedded.wav": riffPayload(wav),
    "embedded.woff": privateWoff,
    "embedded-table.ttf": tablePayload,
    "embedded.mp3": Buffer.concat([Buffer.from("ID3\x04\0\0\0\0\0\x13"), payload, mediaFixture("mp3")]),
    "embedded-ancillary.mp3": ancillaryMp3,
  };
  for (const [path, bytes] of Object.entries(files)) writeFileSync(join(work, path), bytes);
  await commitAll(work, "embedded payloads");
  const diff = await diffSince(work, base);
  const findings = auditDiff(diff, { taskClass: null, protectedPaths: [] });
  expect(findings).toHaveLength(Object.keys(files).length);
  for (const file of Object.keys(files))
    expect(findings).toContainEqual(
      expect.objectContaining({ file, rule: "binary-content", severity: "block" }),
    );
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["binary"] })).toEqual([]);
});

test("GIF LZW pixel bytes are outside foreign-format recognition on additions and edits", async () => {
  const payload = mediaFixture("zip");
  const encode = (pixels: Buffer, frameWidth: number) => {
    const screen = Buffer.alloc(7);
    screen.writeUInt16LE(frameWidth, 0);
    screen.writeUInt16LE(1, 2);
    screen[4] = 0xf7; // A 256-color global palette permits every byte as a pixel index.
    const frames: Buffer[] = [];
    for (let offset = 0; offset < pixels.length; offset += frameWidth) {
      const frame = pixels.subarray(offset, offset + frameWidth),
        image = Buffer.alloc(10);
      image[0] = 0x2c;
      image.writeUInt16LE(frame.length, 5);
      image.writeUInt16LE(1, 7);
      // Clearing before each literal keeps every code nine bits wide and re-encodes
      // the archive so its signatures do not appear in the raw GIF stream.
      const codes = [...[...frame].flatMap((byte) => [256, byte]), 257];
      const packed = Buffer.alloc(Math.ceil((codes.length * 9) / 8));
      let bit = 0;
      for (const code of codes)
        for (let i = 0; i < 9; i++, bit++)
          packed[bit >> 3] = (packed[bit >> 3] ?? 0) | (((code >> i) & 1) << (bit & 7));
      const blocks: Buffer[] = [];
      for (let at = 0; at < packed.length; at += 255) {
        const block = packed.subarray(at, at + 255);
        blocks.push(Buffer.from([block.length]), block);
      }
      frames.push(Buffer.concat([image, Buffer.from([8]), ...blocks, Buffer.from([0])]));
    }
    return Buffer.concat([Buffer.from("GIF89a"), screen, Buffer.alloc(768), ...frames, Buffer.from([0x3b])]);
  };
  const files = [payload.length, 1, 3].map((frameWidth) => ({
    file: `encoded-payload-${frameWidth}.gif`,
    frameWidth,
  }));
  for (const { file, frameWidth } of files)
    writeFileSync(join(work, file), encode(Buffer.alloc(payload.length, 65), frameWidth));
  await commitAll(work, "ordinary encoded pixels");
  const mediaBase = await headSha(work);
  expect(auditDiff(await diffSince(work, base), { taskClass: null, protectedPaths: [] })).toEqual([]);
  for (const { file, frameWidth } of files) writeFileSync(join(work, file), encode(payload, frameWidth));
  await commitAll(work, "ZIP encoded as pixels");
  for (const revision of [base, mediaBase]) {
    const diff = await diffSince(work, revision);
    expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toEqual([]);
  }
});

test("supported WebP pixels pass while opaque transforms, FLAC and WOFF require an allowance", async () => {
  const files = [
    { file: "predictor.webp", original: "literal.webp", changed: "predictor.webp" },
    { file: "literal-payload.webp", original: "literal.webp", changed: "literal-payload.webp" },
    { file: "indexed.webp", original: "webp", changed: "indexed.webp" },
    { file: "distance-one-payload.webp", original: "literal.webp", changed: "distance-one-payload.webp" },
    { file: "distance-two-payload.webp", original: "literal.webp", changed: "distance-two-payload.webp" },
    { file: "fixed.flac", original: "flac", changed: "predicted-0.flac" },
    { file: "lpc.flac", original: "flac", changed: "predicted-8.flac" },
    { file: "frames.flac", original: "flac", changed: "frames.flac" },
    { file: "big-endian.flac", original: "flac", changed: "big-endian.flac" },
    { file: "stereo-left.flac", original: "stereo.flac", changed: "stereo-left.flac" },
    { file: "stereo-right-be.flac", original: "stereo.flac", changed: "stereo-right-be.flac" },
    { file: "stereo-mid-side.flac", original: "stereo.flac", changed: "stereo-mid-side.flac" },
    { file: "split.woff", original: "clean.woff", changed: "split.woff" },
  ];
  for (const { file, original } of files) writeFileSync(join(work, file), mediaFixture(original));
  await commitAll(work, "clean decoded media");
  const mediaBase = await headSha(work);
  expect((await diffSince(work, base)).binaryPaths?.sort()).toEqual(
    files
      .filter(({ file }) => !file.endsWith(".webp"))
      .map(({ file }) => file)
      .sort(),
  );
  for (const { file, changed } of files) writeFileSync(join(work, file), mediaFixture(changed));
  await commitAll(work, "payloads concealed in media encoding");
  // Predictor transforms still fail structural validation independently of pixel content.
  const opaque = files.filter(({ file }) => !file.endsWith(".webp") || file === "predictor.webp");
  for (const revision of [base, mediaBase]) {
    const diff = await diffSince(work, revision);
    const findings = auditDiff(diff, { taskClass: null, protectedPaths: [] });
    expect(findings).toHaveLength(opaque.length);
    for (const { file } of opaque)
      expect(findings).toContainEqual(
        expect.objectContaining({
          file,
          rule: "binary-content",
          severity: "block",
          detail: expect.stringContaining(`${file}:`),
        }),
      );
    expect(findings.every((finding) => finding.detail.includes("Allow: binary"))).toBe(true);
    expect(auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["binary"] })).toEqual([]);
  }
});

test("JPEG thumbnails and ICO pixels may contain signatures while WAV requires an allowance", async () => {
  const files: { path: string; original: Buffer; changed: Buffer }[] = [];
  const magics = [
    "feedface", // Mach-O, both byte orders and word sizes, including fat binaries.
    "cefaedfe",
    "feedfacf",
    "cffaedfe",
    "cafebabe", // Also the Java class signature.
    "bebafeca",
    "cafebabf",
    "bfbafeca",
    "6465780a30333500", // DEX and compact DEX.
    "6364657830303100",
    "4d5a", // DOS/NE/LX executables need not have a PE signature.
  ];
  for (const magic of magics) {
    const original = mediaFixture("wav"),
      changed = Buffer.from(original);
    Buffer.from(magic, "hex").copy(changed, changed.indexOf("data") + 8);
    files.push({ path: `executable-${magic}.wav`, original, changed });
  }
  const jpeg = mediaFixture("jpg"),
    thumbnail = Buffer.alloc(24);
  thumbnail.writeUInt16BE(0xffe0, 0);
  thumbnail.writeUInt16BE(22, 2);
  thumbnail.write("JFIF\0", 4);
  thumbnail[9] = 1;
  thumbnail[10] = 1;
  thumbnail.writeUInt16BE(1, 12);
  thumbnail.writeUInt16BE(1, 14);
  thumbnail[16] = 2;
  thumbnail[17] = 1;
  const originalJpeg = Buffer.concat([jpeg.subarray(0, 2), thumbnail, jpeg.subarray(2)]);
  Buffer.from("cffaedfe", "hex").copy(thumbnail, 18);
  files.push({
    path: "executable-thumbnail.jpg",
    original: originalJpeg,
    changed: Buffer.concat([jpeg.subarray(0, 2), thumbnail, jpeg.subarray(2)]),
  });
  const ico = Buffer.alloc(86);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico[6] = ico[7] = 2;
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(24, 12);
  ico.writeUInt32LE(64, 14);
  ico.writeUInt32LE(22, 18);
  ico.writeUInt32LE(40, 22);
  ico.writeInt32LE(2, 26);
  ico.writeInt32LE(4, 30);
  ico.writeUInt16LE(1, 34);
  ico.writeUInt16LE(24, 36);
  const changedIco = Buffer.from(ico);
  Buffer.from("cafebabe", "hex").copy(changedIco, 62);
  files.push({ path: "executable-pixels.ico", original: ico, changed: changedIco });
  for (const { path, original } of files) writeFileSync(join(work, path), original);
  await commitAll(work, "ordinary raw media regions");
  const mediaBase = await headSha(work);
  expect((await diffSince(work, base)).binaryPaths?.sort()).toEqual(
    files
      .filter(({ path }) => path.endsWith(".wav"))
      .map(({ path }) => path)
      .sort(),
  );
  for (const { path, changed } of files) writeFileSync(join(work, path), changed);
  await commitAll(work, "embedded executable signatures");
  for (const revision of [base, mediaBase]) {
    const diff = await diffSince(work, revision);
    const findings = auditDiff(diff, { taskClass: null, protectedPaths: [] });
    expect(findings).toHaveLength(files.filter(({ path }) => path.endsWith(".wav")).length);
    for (const { path } of files.filter(({ path }) => path.endsWith(".wav")))
      expect(findings).toContainEqual(
        expect.objectContaining({
          file: path,
          rule: "binary-content",
          severity: "block",
          detail: expect.stringContaining("Allow: binary"),
        }),
      );
    expect(auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["binary"] })).toEqual([]);
  }
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

test("LFS inspection batches short and repeated candidate blobs per tree", async () => {
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 2\n`;
  for (let i = 0; i < 128; i++) {
    writeFileSync(join(work, `short-${i}.dat`), `small text ${i}\n`);
    writeFileSync(join(work, `candidate-${i}.dat`), "ordinary text".padEnd(126, "."));
    writeFileSync(join(work, `pointer-${i}.dat`), pointer);
  }
  await commitAll(work, "base blob candidates");
  const revision = await headSha(work);
  for (let i = 0; i < 128; i++) {
    writeFileSync(join(work, `short-${i}.dat`), "changed text\n");
    writeFileSync(join(work, `candidate-${i}.dat`), "changed text\n");
    writeFileSync(join(work, `pointer-${i}.dat`), Buffer.from([0, 1]));
  }
  await commitAll(work, "edited blob candidates");
  const shim = gitShim();
  const diff = await diffSince(work, revision, shim.env);
  expect(diff.binaryErrors).toBeUndefined();
  expect(diff.binaryPaths).toHaveLength(128);
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["binary"] })).toEqual([]);
  // Short blobs also need classification: each tree still uses only one batch.
  expect(shim.calls().filter((call) => ` ${call} `.includes(" cat-file -p "))).toEqual([]);
  expect(shim.calls().filter((call) => call.includes("cat-file --batch -Z"))).toHaveLength(2);
}, 30_000);

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
  writeFileSync(join(work, "photo.png"), mediaFixture("png"));
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
}, 30_000);

test("a new strict LFS pointer under an existing rule is not warned about as text", async () => {
  writeFileSync(join(work, ".gitattributes"), "*.dat filter=lfs diff=lfs merge=lfs -text\n");
  await commitAll(work, "base LFS rule");
  const revision = await headSha(work);
  writeFileSync(
    join(work, "asset.dat"),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 68\n`,
  );
  // Commit the pointer bytes without invoking an installed LFS clean filter.
  await factory(
    "-c",
    "filter.lfs.process=",
    "-c",
    "filter.lfs.clean=cat",
    "-c",
    "filter.lfs.required=false",
    "add",
    "-A",
  );
  await factory("commit", "-qm", "new LFS pointer");
  const diff = await diffSince(work, revision);
  expect(diff.headTextPaths).toEqual([]);
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toEqual([
    expect.objectContaining({ rule: "binary-content", severity: "block" }),
  ]);
});

test.each(["valid", "missing oid", "missing size", "invalid hash", "invalid size", "extra line"])(
  "binary edits of %s base LFS pointers are judged on the new content",
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
    await worktreeGit(
      [
        "git",
        "-c",
        "filter.lfs.process=",
        "-c",
        "filter.lfs.clean=cat",
        "-c",
        "filter.lfs.required=false",
        "add",
        "-A",
      ],
      {
        cwd: work,
      },
    );
    await factory("commit", "-qm", "base LFS pointer");
    const revision = await headSha(work);
    for (const path of ["tracked.png", "tracked.dat", "tracked.ts"])
      writeFileSync(join(work, path), Buffer.from([0, 1]));
    await worktreeGit(
      [
        "git",
        "-c",
        "filter.lfs.process=",
        "-c",
        "filter.lfs.clean=cat",
        "-c",
        "filter.lfs.required=false",
        "add",
        "-A",
      ],
      {
        cwd: work,
      },
    );
    await factory("commit", "-qm", "binary LFS edit");
    const findings = auditDiff(await diffSince(work, revision), { taskClass: null, protectedPaths: [] });
    expect(findings.filter((f) => f.rule === "binary-content")).toEqual(
      kind === "valid"
        ? ["tracked.dat", "tracked.png", "tracked.ts"].map((file) =>
            expect.objectContaining({ severity: "block", file }),
          )
        : [
            expect.objectContaining({
              severity: "block",
              detail: expect.stringContaining("Malformed LFS pointer"),
            }),
          ],
    );
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

test("a global LFS-like driver never filters factory commits or checkouts, and bad config fails closed", async () => {
  const marker = join(dir, "filtered");
  const driver = join(dir, "driver.sh");
  writeFileSync(
    driver,
    `#!/bin/sh\necho "$0 $*" >> '${marker}'\necho 'version https://git-lfs.github.com/spec/v1'\n`,
    {
      mode: 0o755,
    },
  );
  const included = join(dir, "included.gitconfig");
  writeFileSync(included, `[filter "inc"]\n\tclean = ${driver}\n\tsmudge = ${driver}\n\trequired = true\n`);
  const global = join(dir, "global.gitconfig");
  writeFileSync(
    global,
    `[filter "lfs"]\n\tclean = ${driver}\n\tsmudge = ${driver}\n\tprocess = ${driver}\n\trequired = true\n[include]\n\tpath = ${included}\n`,
  );
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = global;
  try {
    const code = "module.exports = () => { require('child_process').execSync('id'); };\n";
    mkdirSync(join(work, "lib"));
    writeFileSync(join(work, ".gitattributes"), "*.dat filter=lfs\n*.inc filter=inc\n");
    writeFileSync(join(work, "lib", "helper.dat"), code);
    writeFileSync(join(work, "lib", "more.inc"), code);
    const head = await commitAll(work, "helper");
    expect(head).not.toBeNull();
    expect(await readFileAt(work, "HEAD", "lib/helper.dat")).toBe(code);
    expect(await readFileAt(work, "HEAD", "lib/more.inc")).toBe(code);
    rmSync(join(work, "lib"), { recursive: true });
    await checkoutCommitted(work);
    expect(readFileSync(join(work, "lib", "helper.dat"), "utf8")).toBe(code);
    await resetTo(work, base);
    await resetTo(work, head as string);
    expect(readFileSync(join(work, "lib", "more.inc"), "utf8")).toBe(code);
    expect(existsSync(marker)).toBe(false);
    const review = join(dir, "detached-review");
    await addDetachedWorktree(work, head as string, review);
    expect(readFileSync(join(review, "lib", "helper.dat"), "utf8")).toBe(code);
    expect(readFileSync(join(review, "lib", "more.inc"), "utf8")).toBe(code);
    expect(existsSync(marker)).toBe(false);
    // The audit sees the real bytes, not a pointer.
    const diff = await diffSince(work, base);
    expect(diff.patch).toContain("+module.exports");
    expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toContainEqual(
      expect.objectContaining({ rule: "gitattributes", file: ".gitattributes" }),
    );
    // A config file discovery cannot parse stops the factory instead of running unfiltered-or-not.
    writeFileSync(global, '[filter "lfs"\n\tclean = broken');
    writeFileSync(join(work, "lib", "helper.dat"), "changed");
    await expect(commitAll(work, "after bad config")).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
});

test("a filter selected by in-tree attributes and repository config does not run on add", async () => {
  const marker = join(dir, "filtered");
  await git(work, "config", "filter.spy.clean", `touch '${marker}'; echo pointer`);
  await git(work, "config", "filter.spy.required", "true");
  writeFileSync(join(work, ".gitattributes"), "*.ts filter=spy\n");
  writeFileSync(join(work, "sample.test.ts"), edited);
  await commitAll(work, "filtered");
  expect(existsSync(marker)).toBe(false);
  await audited();
});

for (const attack of [
  "config",
  "config.worktree",
  "redirect",
  "reflog",
  "dangling",
  "hardlink",
  "missing-common",
  "wrong-common",
  "wrong-backlink",
])
  test(`trusted git refuses private admin attack: ${attack}`, async () => {
    const admin = (await git(work, "rev-parse", "--absolute-git-dir")).stdout.trim();
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "sample.test.ts"), "outside original");
    writeFileSync(join(outside, "untracked"), "do not delete");
    const sentinel = join(outside, "executed");
    const payload = join(work, "payload");
    writeFileSync(payload, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
    const snapshot = () =>
      readdirSync(outside)
        .sort()
        .map((name) => [name, readFileSync(join(outside, name)).toString("hex")]);
    const before = snapshot();
    if (attack === "config" || attack === "config.worktree")
      writeFileSync(
        join(admin, attack),
        `[core]\nworktree = ${outside}\n[commit]\ngpgsign = true\n[gpg]\nprogram = ${payload}\n`,
      );
    if (attack === "redirect") {
      rmSync(join(admin, "commondir"));
      symlinkSync(join(seed, ".git", "objects"), join(admin, "objects"));
      writeFileSync(join(admin, "config"), `[core]\nworktree = ${outside}\n`);
    }
    if (attack === "reflog") {
      rmSync(join(admin, "logs", "HEAD"));
      symlinkSync(join(outside, "untracked"), join(admin, "logs", "HEAD"));
    }
    if (attack === "dangling") symlinkSync(join(outside, "absent"), join(admin, "dangling"));
    if (attack === "hardlink") linkSync(join(outside, "untracked"), join(admin, "linked"));
    if (attack === "missing-common") rmSync(join(admin, "commondir"));
    if (attack === "wrong-common") writeFileSync(join(admin, "commondir"), outside);
    if (attack === "wrong-backlink") writeFileSync(join(admin, "gitdir"), join(outside, ".git"));
    const index = readFileSync(join(admin, "index"));
    await expect(commitAll(work, "must refuse")).rejects.toThrow();
    await expect(checkoutCommitted(work)).rejects.toThrow();
    expect(readFileSync(join(admin, "index"))).toEqual(index);
    expect(snapshot()).toEqual(before);
    expect(existsSync(sentinel)).toBe(false);
  });

test("recorded directories override inherited Git authority; missing records fail closed", async () => {
  writeFileSync(join(work, "sample.test.ts"), edited);
  const inherited = Object.fromEntries(
    ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"].map((key) => [key, process.env[key]]),
  );
  try {
    process.env.GIT_DIR = join(dir, "absent");
    process.env.GIT_COMMON_DIR = join(dir, "absent");
    process.env.GIT_WORK_TREE = seed;
    expect(await commitAll(work, "valid")).not.toBeNull();
    writeFileSync(join(work, "sample.test.ts"), "dirty");
    await checkoutCommitted(work);
    expect(readFileSync(join(work, "sample.test.ts"), "utf8")).toBe(edited);
    expect(readFileSync(join(seed, "sample.test.ts"), "utf8")).toBe(original);
  } finally {
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  rmSync(`${work}.git-paths`);
  await expect(commitAll(work, "unrecorded")).rejects.toThrow("Missing trusted Git paths");
  await expect(checkoutCommitted(work)).rejects.toThrow("Missing trusted Git paths");
});

test.each([
  ["GIT_AUTHOR_NAME", "author name"],
  ["GIT_AUTHOR_EMAIL", "author email"],
  ["GIT_COMMITTER_NAME", "committer name"],
  ["GIT_COMMITTER_EMAIL", "committer email"],
])("publication checks %s even after its changes are removed", async (variable, field) => {
  const config = join(dir, "config");
  mkdirSync(config);
  writeFileSync(join(config, "private-strings.txt"), "secret-host.example");
  writeFileSync(join(work, "transient.txt"), "safe");
  await git(work, "add", ".");
  await sh(["git", "commit", "-qm", "safe"], {
    cwd: work,
    env: { ...(process.env as Record<string, string>), [variable]: "secret-host.example" },
  });
  rmSync(join(work, "transient.txt"));
  await commitAll(work, "remove transient");
  const error = await checkPrivateRange(work, `${base}..HEAD`, loadPrivateStrings(config)).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain(field);
  expect(String(error)).not.toContain("secret-host.example");
});

test.each(["author-email", "message", "clean"])(
  "publication ignores UTF-16 log config: %s",
  async (scenario) => {
    await git(work, "config", "i18n.logOutputEncoding", "UTF-16");
    writeFileSync(join(work, "safe.txt"), "safe");
    await git(work, "add", ".");
    await git(
      work,
      "commit",
      "--author=Safe <" +
        (scenario === "author-email" ? "fake@secret-host.example" : "safe@example.com") +
        ">",
      "-qm",
      scenario === "message" ? "Safe subject\n\nsecret-host.example" : "safe",
    );
    const scan = checkPrivateRange(work, `${base}..HEAD`, [{ value: "secret-host.example", entry: 1 }]);
    if (scenario === "clean") await scan;
    else {
      const error = await scan.catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("entry 1");
      expect(String(error)).not.toContain("secret-host.example");
      if (scenario === "author-email") expect(String(error)).toContain("author email");
    }
  },
);

test("a planted graft cannot hide a published ancestor from the range check", async () => {
  writeFileSync(join(work, "transient.txt"), "safe");
  await commitAll(work, "hidden subject\n\nsecret-host.example");
  const hidden = await headSha(work);
  writeFileSync(join(work, "safe.txt"), "safe");
  await commitAll(work, "safe");
  const tip = await headSha(work);
  // The graft makes the tip look parentless, hiding the denylisted commit from rev-list.
  const common = (
    await sh(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: work })
  ).stdout.trim();
  mkdirSync(join(common, "info"), { recursive: true });
  writeFileSync(join(common, "info", "grafts"), `${tip}\n`);
  expect(hidden).not.toBe(tip);
  await expect(
    checkPrivateRange(work, `${base}..HEAD`, [{ value: "secret-host.example", entry: 1 }]),
  ).rejects.toThrow("entry 1");
});

/** Points one parent slot of `target` in a commit-graph file's CDAT chunk at `parent`, as a forged graph would. */
function forgeGraphParent(path: string, target: string, slot: number, parent: string) {
  const data = readFileSync(path);
  const hashLength = data[5] === 1 ? 20 : 32;
  const chunks = new Map<string, number>();
  for (let i = 0; i <= (data[6] ?? 0); i++) {
    const at = 8 + i * 12;
    chunks.set(data.subarray(at, at + 4).toString("latin1"), Number(data.readBigUInt64BE(at + 4)));
  }
  const [fanout, lookup, cdat] = ["OIDF", "OIDL", "CDAT"].map((id) => chunks.get(id));
  if (fanout === undefined || lookup === undefined || cdat === undefined)
    throw new Error("unexpected commit-graph");
  const oids = Array.from({ length: data.readUInt32BE(fanout + 255 * 4) }, (_, i) =>
    data.subarray(lookup + i * hashLength, lookup + (i + 1) * hashLength).toString("hex"),
  );
  data.writeUInt32BE(
    oids.indexOf(parent),
    cdat + oids.indexOf(target) * (hashLength + 16) + hashLength + 4 * slot,
  );
  writeFileSync(path, data);
}

test.each(["shallow", "commit-graph"])(
  "a planted %s cannot hide a published ancestor from the range check",
  async (kind) => {
    writeFileSync(join(work, "transient.txt"), "safe");
    await commitAll(work, "hidden subject\n\nsecret-host.example");
    const hidden = await headSha(work);
    writeFileSync(join(work, "mid.txt"), "safe");
    await commitAll(work, "mid");
    const mid = await headSha(work);
    writeFileSync(join(work, "safe.txt"), "safe");
    await commitAll(work, "safe");
    const tip = await headSha(work);
    const common = (
      await sh(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: work })
    ).stdout.trim();
    // Either one makes `mid` look parentless or based directly on `base`, skipping the denylisted commit.
    if (kind === "shallow") writeFileSync(join(common, "shallow"), `${mid}\n`);
    else {
      await sh(["git", "commit-graph", "write", "--reachable"], { cwd: work });
      const graph = join(common, "objects", "info", "commit-graph");
      chmodSync(graph, 0o644);
      forgeGraphParent(graph, mid, 0, base);
    }
    expect((await sh(["git", "rev-list", `${base}..${tip}`], { cwd: work })).stdout).not.toContain(hidden);
    await expect(
      checkPrivateRange(work, `${base}..HEAD`, [{ value: "secret-host.example", entry: 1 }]),
    ).rejects.toThrow("entry 1");
  },
);

test("factory git ignores commit-graphs and pack bitmaps, which could change what a push sends", async () => {
  const bin = join(dir, "logging-bin");
  const calls = join(dir, "git-calls");
  mkdirSync(bin);
  const real = Bun.which("git");
  if (!real) throw new Error("missing git");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${real}' "$@"\n`, {
    mode: 0o755,
  });
  await worktreeGit(["git", "rev-parse", "HEAD"], {
    cwd: work,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } as Record<string, string>,
  });
  const call = readFileSync(calls, "utf8")
    .split("\n")
    .find((line) => line.endsWith("rev-parse HEAD"));
  expect(call).toContain("-c core.commitGraph=false -c pack.useBitmaps=false");
});

test.each(["mergetag", "gpgsig", "encoding", "utf8", "invalid-utf8", "message-header", "replacement"])(
  "publication inspects raw commit headers: %s",
  async (scenario) => {
    const tree = (await git(work, "rev-parse", `${base}^{tree}`)).stdout.trim();
    const tag = `mergetag object ${base}\n type commit\n tag safe\n tagger Safe <fake@secret-host.example> 1 +0000\n \n safe tag\n`;
    const extra =
      scenario === "gpgsig"
        ? "gpgsig safe\n secret-host.example\n"
        : ["mergetag", "replacement"].includes(scenario)
          ? tag
          : scenario === "encoding"
            ? "encoding ISO-8859-1\n"
            : scenario === "utf8"
              ? "encoding UTF-8\n"
              : "";
    const raw = `tree ${tree}\nparent ${base}\nauthor Safe <safe@example.com> 1 +0000\ncommitter Safe <safe@example.com> 1 +0000\n${extra}\nsafe${scenario === "message-header" ? "\nencoding ISO-8859-1" : ""}\n`;
    const object = join(dir, "commit-object");
    writeFileSync(
      object,
      scenario === "invalid-utf8" ? Buffer.concat([Buffer.from(raw), Buffer.from([0xff])]) : raw,
    );
    const sha = (await git(work, "hash-object", "-t", "commit", "-w", object)).stdout.trim();
    await git(work, "reset", "--hard", sha);
    if (scenario === "replacement") await git(work, "replace", sha, base);
    expect((await git(work, "tag", "--list")).stdout).toBe("");
    const scan = checkPrivateRange(work, `${base}..HEAD`, [{ value: "secret-host.example", entry: 1 }]);
    if (["utf8", "message-header"].includes(scenario)) await scan;
    else {
      const error = await scan.catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(["encoding", "invalid-utf8"].includes(scenario) ? "UTF-8" : "entry 1");
      expect(String(error)).not.toContain("secret-host.example");
      expect(String(error)).not.toContain("safe@example.com");
      expect(String(error)).not.toContain("ISO-8859-1");
    }
  },
);

test.each(["patch", "message", "merge", "excluded"])("publication range checks %s", async (scenario) => {
  const entries = [{ value: "secret-host.example", entry: 1 }];
  writeFileSync(
    join(work, "transient.txt"),
    ["message", "merge"].includes(scenario) ? "safe" : "secret-host.example",
  );
  await commitAll(work, scenario === "message" ? "safe subject\n\nsecret-host.example" : "safe");
  if (scenario === "merge") {
    const side = await headSha(work);
    await git(work, "reset", "--hard", base);
    writeFileSync(join(work, "other.txt"), "safe");
    await commitAll(work, "other");
    await git(work, "merge", "--no-ff", "--no-commit", side);
    writeFileSync(join(work, "transient.txt"), "secret-host.example");
    await commitAll(work, "safe merge");
  }
  rmSync(join(work, "transient.txt"));
  await commitAll(work, "remove transient");
  const start = scenario === "excluded" ? await headSha(work) : base;
  writeFileSync(join(work, "safe.txt"), "safe");
  await commitAll(work, "safe");
  const scan = checkPrivateRange(work, `${start}..HEAD`, entries);
  if (scenario === "excluded") await scan;
  else await expect(scan).rejects.toThrow("entry 1");
});

test("publication range checks gitlink paths even when config ignores submodules", async () => {
  await git(work, "config", "diff.ignoreSubmodules", "all");
  await git(work, "update-index", "--add", "--cacheinfo", `160000,${base},secret-host.example`);
  await git(work, "commit", "--no-verify", "-qm", "safe");
  await git(work, "rm", "-q", "--cached", "secret-host.example");
  await git(work, "commit", "--no-verify", "-qm", "remove gitlink");
  await expect(
    checkPrivateRange(work, `${base}..HEAD`, [{ value: "secret-host.example", entry: 1 }]),
  ).rejects.toThrow("entry 1");
});

test.each([
  "matching",
  "clean",
  "missing",
  "unreadable",
  "removed",
  "staged",
  "extended",
  "extended-clean",
  "corrupt",
  "crlf",
  "legacy",
  "legacy-crlf",
  "crlf-clean",
  "legacy-clean",
  "malformed",
  "bad-extension",
])("LFS payload inspection: %s", async (scenario) => {
  const payload = Buffer.from(scenario.includes("clean") ? "safe\0" : "%73ecret-host.example\0");
  const oid = createHash("sha256").update(payload).digest("hex");
  const object = join(seed, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
  mkdirSync(join(object, ".."), { recursive: true });
  if (scenario === "unreadable") mkdirSync(object);
  else if (scenario !== "missing")
    writeFileSync(object, scenario === "corrupt" ? Buffer.alloc(payload.length, 97) : payload);
  let pointer = `version https://${scenario.startsWith("legacy") ? "hawser" : "git-lfs"}.github.com/spec/v1\n${scenario.startsWith("extended") ? `ext-0-test sha256:${"a".repeat(64)}\n` : ""}oid sha256:${oid}\nsize ${payload.length}\n`;
  if (scenario.includes("crlf")) pointer = pointer.replaceAll("\n", "\r\n");
  if (scenario === "malformed") pointer = pointer.replace("size ", "unknown ");
  if (scenario === "bad-extension") pointer = pointer.replace("oid ", "ext-0-test broken\noid ");
  writeFileSync(join(work, "asset.dat"), pointer);
  if (scenario === "staged") await git(work, "add", ".");
  else await commitAll(work, "asset");
  if (scenario === "removed") {
    rmSync(join(work, "asset.dat"));
    await commitAll(work, "remove asset");
  }
  const entries = [{ value: "secret-host.example", entry: 1 }];
  const scan = checkPrivateRange(work, `${base}..HEAD`, entries, scenario === "staged");
  if (scenario.includes("clean")) {
    await scan;
    expect((await diffSince(work, base, undefined, false, entries)).privateHits).toEqual([]);
  } else
    await expect(scan).rejects.toThrow(
      ["malformed", "bad-extension"].includes(scenario)
        ? "Malformed LFS pointer"
        : ["missing", "unreadable", "corrupt"].includes(scenario)
          ? "Cannot inspect local LFS payload"
          : "entry 1",
    );
  if (!["removed", "staged"].includes(scenario)) {
    const classified = await diffSince(work, base);
    const findings = auditDiff(classified, { taskClass: "feature", protectedPaths: [] });
    if (["malformed", "bad-extension"].includes(scenario))
      expect(findings.some((f) => f.severity === "block" && f.detail.includes("Malformed LFS pointer"))).toBe(
        true,
      );
    else expect(classified.attributeMatches).toBeDefined();
    if (!["missing", "unreadable", "corrupt", "malformed", "bad-extension"].includes(scenario)) {
      const inspected = await diffSince(work, base, undefined, false, entries);
      expect(inspected.privateHits?.length).toBe(scenario.includes("clean") ? 0 : 1);
    }
  }
});

test.each(["complete", "truncated", "failed", "timeout", "timeout-exit-0", "cancelled"])(
  "one byte-framed batch, %s",
  async (scenario) => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const ids = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
    const bytes = Buffer.concat([
      Buffer.from("\0é"),
      Buffer.alloc(65_530, 97),
      Buffer.from("%73ecret-host.example"),
    ]);
    const response = Buffer.concat(
      ids.map((id) => Buffer.concat([Buffer.from(`${id} blob ${bytes.length}\n`), bytes, Buffer.from("\n")])),
    );
    const output = join(dir, "batch");
    writeFileSync(output, scenario === "truncated" ? response.subarray(0, -1) : response);
    const calls = join(dir, "calls");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\necho "$*" >> '${calls}'\ncat >/dev/null\n${["timeout", "cancelled"].includes(scenario) ? "sleep 10" : `cat '${output}'`}\n${scenario === "timeout-exit-0" ? "trap 'exit 0' TERM\nsleep 10 &\nwait\n" : ""}exit ${scenario === "failed" ? 1 : 0}\n`,
      { mode: 0o755 },
    );
    const limit = attributeLimits.timeoutMs;
    const controller = new AbortController();
    const scope = {
      signal: controller.signal,
      killGraceMs: 10,
      children: new Map(),
      scratchDirs: new Set<string>(),
    };
    try {
      if (scenario.startsWith("timeout")) attributeLimits.timeoutMs = 250;
      const scan = processScope.run(scope, () =>
        worktreeGitScope.run(false, () =>
          blobPrivateEntries(work, { ...process.env, PATH: `${bin}:${process.env.PATH}` }, ids, [
            { value: "secret-host.example", entry: 1 },
          ]),
        ),
      );
      if (scenario === "cancelled") {
        while (!existsSync(calls)) await Bun.sleep(1);
        controller.abort();
      }
      if (scenario === "complete") expect(await scan).toEqual(ids.map((id) => [id, 1]));
      else await expect(scan).rejects.toThrow();
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
        "--no-replace-objects cat-file --batch",
      ]);
    } finally {
      attributeLimits.timeoutMs = limit;
    }
  },
);

test("fonts and audio require a binary allowance even with complete media structures", async () => {
  const extensions = ["woff", "woff2", "ttf", "otf", "mp3", "ogg", "wav", "flac"];
  for (const ext of extensions) writeFileSync(join(work, `asset.${ext}`), mediaFixture(ext));
  await commitAll(work, "font and audio fixtures");
  const diff = await diffSince(work, base);
  expect(diff.binaryPaths?.sort()).toEqual(extensions.map((ext) => `asset.${ext}`).sort());
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toHaveLength(extensions.length);
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["binary"] })).toEqual([]);
});

test("LFS binary allowance follows the available new payload", async () => {
  const pointer = (bytes: Buffer, local: boolean) => {
    const oid = createHash("sha256").update(bytes).digest("hex");
    if (local) {
      const folder = join(seed, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4));
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, oid), bytes);
    }
    return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`;
  };
  writeFileSync(join(work, "replacement.png"), pointer(mediaFixture("png"), false));
  await commitAll(work, "base pointer");
  const revision = await headSha(work);
  let previous = revision;
  for (const variant of [0, 1]) {
    writeFileSync(join(work, "missing.png"), pointer(Buffer.from(`unavailable ${variant}`), false));
    writeFileSync(join(work, "archive.png"), pointer(mediaFixture("zip", variant), true));
    writeFileSync(join(work, "image.png"), pointer(mediaFixture("png", variant), true));
    writeFileSync(join(work, "replacement.png"), mediaFixture("zip", variant));
    await commitAll(work, "new LFS content");
    const diff = await diffSince(work, variant === 0 ? revision : previous);
    expect(diff.binaryErrors).toBeUndefined();
    expect(diff.binaryPaths?.sort()).toEqual(["archive.png", "missing.png", "replacement.png"]);
    expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toHaveLength(3);
    expect(auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["binary"] })).toEqual([]);
    previous = await headSha(work);
  }
});

test("executable image additions and mode-only changes need a binary allowance", async () => {
  await factory("config", "core.filemode", "true");
  for (const file of ["upgrade.png", "downgrade.png", "unchanged.png"])
    writeFileSync(join(work, file), mediaFixture("png"));
  chmodSync(join(work, "downgrade.png"), 0o755);
  await commitAll(work, "image modes base");
  const revision = await headSha(work);
  writeFileSync(join(work, "added.png"), mediaFixture("png"), { mode: 0o755 });
  chmodSync(join(work, "upgrade.png"), 0o755);
  chmodSync(join(work, "downgrade.png"), 0o644);
  writeFileSync(join(work, "unchanged.png"), mediaFixture("png", 1));
  await commitAll(work, "image mode changes");
  const diff = await diffSince(work, revision);
  expect(diff.binaryPaths?.sort()).toEqual(["added.png", "downgrade.png", "upgrade.png"]);
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toHaveLength(3);
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["binary"] })).toEqual([]);
});

test("PDF and container formats cannot use the text-content exclusion", async () => {
  const files = {
    "ascii.pdf": "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
    "disguised.txt": " \n%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n",
    "plain.pdf": "ordinary text\n",
    "archive.txt": "Rar!\x1a\x07\x01opaque ASCII container",
    "ordinary.txt": "ordinary text\n",
  };
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(work, file), bytes);
  await commitAll(work, "text-like forbidden formats");
  const diff = await diffSince(work, base);
  expect(diff.binaryPaths?.sort()).toEqual(["archive.txt", "ascii.pdf", "disguised.txt", "plain.pdf"]);
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toHaveLength(4);
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["binary"] })).toEqual([]);
});

test("whole-blob classification catches a valid V7 TAR with its first NUL at 9728", async () => {
  // V7 headers allow space-terminated octal fields and full-width names without NULs.
  const header = Buffer.alloc(512, 0x20);
  header.fill(0x61, 0, 100);
  header.write("0000644 ", 100);
  header.write("0000000 ", 108);
  header.write("0000000 ", 116);
  header.write("00000000000 ", 124);
  header.write("00000000000 ", 136);
  header[156] = 0x30;
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}  `, 148);
  const tar = Buffer.concat([...Array.from({ length: 19 }, () => header), Buffer.alloc(1024)]);
  writeFileSync(join(work, "late.tar"), tar);
  writeFileSync(join(work, "late.txt"), Buffer.concat([Buffer.alloc(9728, 0x61), Buffer.from([0])]));
  writeFileSync(join(work, "late-signature.txt"), `${"a".repeat(9728)}%PDF-1.4\n%%EOF\n`);
  await commitAll(work, "late binary bytes");
  const diff = await diffSince(work, base);
  expect(diff.binaryPaths?.sort()).toEqual(["late-signature.txt", "late.tar", "late.txt"]);
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [] })).toHaveLength(3);
  expect(auditDiff(diff, { taskClass: null, protectedPaths: [], allow: ["binary"] })).toEqual([]);
});
