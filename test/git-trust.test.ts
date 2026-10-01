import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { join } from "node:path";
import { completeMerge, prepareMerge } from "../src/git/merge.ts";
import { commitAll, diffSince, discardChanges, headSha, resetTo } from "../src/git/repos.ts";
import {
  captureTrust,
  forgetCheckout,
  git,
  loadTrust,
  restoreCheckout,
  restoreTrust,
  saveTrust,
  trustCheckout,
} from "../src/git/trust.ts";
import { sh } from "../src/util/proc.ts";

let home: string;
const marker = (name: string) => join(home, "markers", name);
const markers = () => readdirSync(join(home, "markers"));
// The test's own git calls stand in for the agent but must not trip its markers themselves.
const run = (cwd: string, ...args: string[]) =>
  sh(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd });
// Filenames git must handle literally: spaces, tabs, newlines, a leading hyphen.
const ODD = ["plain.txt", "with space.txt", "tab\there.txt", "new\nline.txt", "-leading.txt"];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "limitless-trust-"));
  mkdirSync(join(home, "markers"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function repo(): Promise<string> {
  const dir = join(home, "repo");
  mkdirSync(dir);
  await run(dir, "init", "-q", "-b", "main");
  for (const name of ODD) writeFileSync(join(dir, name), "one\n");
  await run(dir, "add", "-A");
  await run(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  await run(dir, "remote", "add", "origin", "https://example.invalid/repo.git");
  await run(dir, "config", "remote.origin.pushurl", "no-push://x");
  await run(dir, "config", "branch.main.remote", "origin");
  return dir;
}

/** A standalone repository, or a linked worktree of one (as pipeline runs use). */
async function checkout(layout: "standalone" | "linked"): Promise<string> {
  const dir = await repo();
  if (layout === "standalone") return dir;
  const wt = join(home, "wt");
  await run(dir, "worktree", "add", "-q", "-b", "run", wt);
  return wt;
}

/** What an agent can do to a checkout: hostile config, hooks, attributes and fsmonitor. */
async function tamper(cwd: string) {
  const common = (await run(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).stdout.trim();
  const script = (name: string) => `sh -c 'touch ${marker(name)}; true'`;
  const settings: [string, string][] = [
    ["diff.external", script("external")],
    ["diff.hide.textconv", `sh -c 'touch ${marker("textconv")}; echo hidden'`],
    ["filter.leak.clean", `sh -c 'touch ${marker("filter")}; cat'`],
    ["core.fsmonitor", script("fsmonitor")],
    ["core.hooksPath", join(home, "hooks")],
    ["remote.origin.pushurl", "https://example.invalid/evil.git"],
  ];
  for (const [key, value] of settings) await run(cwd, "config", key, value);
  writeFileSync(join(common, "info", "attributes"), "*.txt diff=hide filter=leak\nplain.txt -diff\n");
  for (const dir of [join(common, "hooks"), join(home, "hooks")]) {
    mkdirSync(dir, { recursive: true });
    for (const hook of ["reference-transaction", "post-checkout", "pre-commit", "commit-msg", "post-merge"])
      writeFileSync(join(dir, hook), `#!/bin/sh\ntouch ${marker(hook)}\n`, { mode: 0o755 });
  }
  return common;
}

test("git() forces the hardening overrides and forwards env and cancellation", async () => {
  const cwd = await repo();
  await tamper(cwd);
  const get = async (key: string) => (await git(["config", "--get", key], { cwd })).stdout.trim();
  expect(await get("core.hooksPath")).toBe("/dev/null");
  expect(await get("core.fsmonitor")).toBe("false");
  expect(await get("diff.external")).toBe("");
  expect(await get("core.attributesFile")).toBe("/dev/null");
  const env = { ...(process.env as Record<string, string>), GIT_AUTHOR_NAME: "Forwarded" };
  expect((await git(["var", "GIT_AUTHOR_IDENT"], { cwd, env })).stdout).toStartWith("Forwarded ");
  const aborted = AbortSignal.abort();
  await expect(git(["status"], { cwd, signal: aborted })).rejects.toThrow();
  expect(markers()).toEqual([]);
});

test("factory git calls never run candidate hooks, fsmonitor or diff drivers", async () => {
  const cwd = await repo();
  const base = await headSha(cwd);
  // Without restoration only the command-line overrides protect these calls; filters need restoring.
  rmSync(join(await tamper(cwd), "info", "attributes"));
  writeFileSync(join(cwd, "plain.txt"), "two\n");
  const sha = await commitAll(cwd, "change");
  expect(sha).not.toBeNull();
  expect((await diffSince(cwd, base)).patch).toContain("+two");
  writeFileSync(join(cwd, "plain.txt"), "dirty\n");
  expect(await discardChanges(cwd)).toBe(true);
  await resetTo(cwd, base);
  // A merge with a conflict, resolved and completed.
  await git(["checkout", "-q", "-b", "side"], { cwd });
  writeFileSync(join(cwd, "plain.txt"), "side\n");
  await commitAll(cwd, "side");
  const side = await headSha(cwd);
  await git(["checkout", "-q", "main"], { cwd });
  writeFileSync(join(cwd, "plain.txt"), "main\n");
  await commitAll(cwd, "main");
  const head = await headSha(cwd);
  expect(await prepareMerge(cwd, head, side)).toEqual(["plain.txt"]);
  writeFileSync(join(cwd, "plain.txt"), "resolved\n");
  await completeMerge(cwd, head, side);
  expect(markers()).toEqual([]);
});

for (const layout of ["standalone", "linked"] as const)
  test(`restoration removes candidate metadata and keeps trusted config (${layout})`, async () => {
    const cwd = await checkout(layout);
    const base = await headSha(cwd);
    const trust = await captureTrust(cwd, layout === "standalone");
    // An unchanged checkout restores cleanly, as does a repeated restoration.
    await restoreTrust(cwd, trust);
    const common = await tamper(cwd);
    const gitDir = (await run(cwd, "rev-parse", "--absolute-git-dir")).stdout.trim();
    await run(cwd, "config", "extensions.worktreeConfig", "true");
    writeFileSync(join(gitDir, "config.worktree"), "[core]\n\tsparseCheckout = true\n");
    for (const name of ODD) writeFileSync(join(cwd, name), "two\n");
    await run(cwd, "update-index", "--skip-worktree", "--", ODD[1] as string);
    await run(cwd, "update-index", "--assume-unchanged", "--", ODD[2] as string);
    await run(cwd, "update-index", "--skip-worktree", "--", ODD[3] as string);
    await run(cwd, "update-index", "--assume-unchanged", "--", ODD[3] as string);
    // Only what runs from here on counts: the agent's own git calls may run its filter.
    for (const name of markers()) rmSync(marker(name));
    for (let i = 0; i < 2; i++) await restoreTrust(cwd, trust);
    expect(existsSync(join(common, "info", "attributes"))).toBe(false);
    expect(existsSync(join(gitDir, "config.worktree"))).toBe(false);
    if (layout === "standalone") expect(readdirSync(join(common, "hooks"))).toEqual([]);
    const get = async (key: string) => (await run(cwd, "config", "--get", key)).stdout.trim();
    expect(await get("remote.origin.url")).toBe("https://example.invalid/repo.git");
    expect(await get("remote.origin.pushurl")).toBe("no-push://x");
    expect(await get("branch.main.remote")).toBe("origin");
    expect((await run(cwd, "ls-files", "-v")).stdout).not.toMatch(/^[a-zS]/m);
    expect(await commitAll(cwd, "all")).not.toBeNull();
    const diff = await diffSince(cwd, base);
    expect(diff.files).toHaveLength(ODD.length);
    for (const name of ODD) expect((await run(cwd, "show", `HEAD:${name}`)).stdout).toBe("two\n");
    expect(diff.patch).toContain("+two");
    expect(diff.patch).not.toContain("hidden");
    expect(diff.added).toBe(ODD.length);
    expect(markers()).toEqual([]);
  });

test("restoration replaces a redirected .git file and fails on missing trusted state", async () => {
  const cwd = await checkout("linked");
  const trust = await captureTrust(cwd, false);
  const original = readFileSync(join(cwd, ".git"), "utf8");
  writeFileSync(join(cwd, ".git"), `gitdir: ${join(home, "elsewhere")}\n`);
  await restoreTrust(cwd, trust);
  expect(readFileSync(join(cwd, ".git"), "utf8")).toBe(original);

  const file = join(home, "trust.json");
  trustCheckout(cwd, loadTrust(file));
  await expect(restoreCheckout(cwd)).rejects.toThrow("trusted git state missing");
  writeFileSync(file, "{not json");
  trustCheckout(cwd, loadTrust(file));
  await expect(restoreCheckout(cwd)).rejects.toThrow("trusted git state unusable");
  // A missing factory copy of a shared config is never replaced by the live (candidate) one.
  saveTrust(file, { ...trust, sharedConfig: join(home, "missing-config") });
  trustCheckout(cwd, loadTrust(file));
  await expect(restoreCheckout(cwd)).rejects.toThrow("trusted git config missing");
  await expect(commitAll(cwd, "x")).rejects.toThrow("trusted git config missing");
  forgetCheckout(cwd);
  await expect(restoreCheckout(cwd, undefined, true)).rejects.toThrow("no trusted git state");

  const standalone = await captureTrust(join(home, "repo"), true);
  rmSync(join(home, "repo", ".git"), { recursive: true });
  writeFileSync(join(home, "repo", ".git"), `gitdir: ${join(home, "elsewhere")}\n`);
  await expect(restoreTrust(join(home, "repo"), standalone)).rejects.toThrow("was replaced");
});
