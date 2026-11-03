import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type Paths } from "../src/config.ts";
import type { Repo } from "../src/core/types.ts";
import * as command from "../src/git/command.ts";
import { cachePath, probePushAccess } from "../src/git/repos.ts";
import { claimScope } from "../src/integrations/claim-guard.ts";
import { sh } from "../src/util/proc.ts";

setDefaultTimeout(30_000);
let dir: string;
let paths: Paths;
let repo: Repo;
const git = (cwd: string, ...args: string[]) => sh(["git", ...args], { cwd });
beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "push-access-test-")));
  paths = loadConfig({ home: join(dir, "factory"), configDir: join(dir, "config"), raw: {} }).paths;
  const remote = join(dir, "remote.git");
  await git(dir, "init", "-q", "--bare", "--template=", remote);
  const blob = (
    await sh(["git", "hash-object", "-w", "--stdin"], { cwd: remote, stdin: "sentinel\n" })
  ).stdout.trim();
  await git(remote, "update-ref", "refs/tags/keep", blob);
  repo = {
    id: "r",
    slug: "owner/repo",
    kind: "github",
    url: pathToFileURL(remote).href,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
    createdAt: 0,
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test.each([false, true])(
  "dry-run uses the push wrapper and leaves remote refs unchanged (cache: %s)",
  async (cached) => {
    const cache = cachePath(paths, repo);
    if (cached) await git(dir, "init", "-q", "--bare", "--template=", cache);
    const remote = join(dir, "remote.git");
    const before = (await git(remote, "for-each-ref")).stdout;
    const execute = command.cacheGit;
    let transport = "";
    let dispatched = false;
    let initialized = false;
    const spy = spyOn(command, "cacheGit").mockImplementation(async (args, opts, guard) => {
      if (args.includes("init")) {
        initialized = true;
        expect(args.slice(0, 5)).toEqual(["git", "init", "-q", "--bare", "--template="]);
      }
      if (args[1] === "push") {
        expect(args.slice(0, 5)).toEqual(["git", "push", "--dry-run", "--porcelain", repo.url ?? ""]);
        expect(args).toHaveLength(6);
        expect(args[5]).toMatch(/^:refs\/heads\/limitless-access-probe-[0-9a-f]{16}$/);
        expect(guard).toBeFunction();
        transport = realpathSync(opts.cwd);
        expect((await git(transport, "rev-parse", "--is-bare-repository")).stdout.trim()).toBe("true");
        const guarded = () => {
          dispatched = true;
          guard?.();
        };
        return execute(args, opts, guarded);
      }
      return execute(args, opts, guard);
    });
    try {
      expect(await probePushAccess(paths, repo)).toBe(true);
      expect(dispatched).toBe(true);
      expect(initialized).toBe(!cached);
      if (cached) expect(transport).toBe(realpathSync(cache));
      else {
        expect(transport).not.toBe(cache);
        expect(existsSync(dirname(transport))).toBe(false);
      }
      expect((await git(remote, "for-each-ref")).stdout).toBe(before);
    } finally {
      spy.mockRestore();
    }
  },
);

test("missing remote returns false and removes its scratch transport", async () => {
  expect(await probePushAccess(paths, { ...repo, url: pathToFileURL(join(dir, "missing.git")).href })).toBe(
    false,
  );
});

test("an existing non-git cache is replaced by a temporary bare transport", async () => {
  mkdirSync(cachePath(paths, repo));
  expect(await probePushAccess(paths, repo)).toBe(true);
});

test("a file at the cache path still uses a fresh transport", async () => {
  writeFileSync(cachePath(paths, repo), "not a repository");
  expect(await probePushAccess(paths, repo)).toBe(true);
});

test("dispatch guard refusal never starts a push, and abort remains an abort", async () => {
  const cache = cachePath(paths, repo);
  await git(dir, "init", "-q", "--bare", "--template=", cache);
  const claim = {
    handle: { repo: repo.slug, ref: "refs/heads/claim", run: "run", member: "m", generation: 1 },
    lost: true,
    cancelled: () => false,
    windowOpen: () => true,
    onLost: () => {},
  };
  expect(await claimScope.run([claim], () => probePushAccess(paths, repo))).toBe(false);
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await expect(probePushAccess(paths, repo, abort.signal)).rejects.toThrow("cancelled");
  expect(await probePushAccess(paths, { ...repo, kind: "local", url: null, localPath: dir })).toBe(false);
});
