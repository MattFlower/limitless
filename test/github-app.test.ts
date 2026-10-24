import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Factory } from "../src/app.ts";
import { startDaemon } from "../src/cli/daemon.ts";
import { doctor } from "../src/cli/setup.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import {
  createPullRequest,
  disableAutoMerge,
  findPullRequest,
  mergePullRequest,
  resolveRepo,
} from "../src/git/repos.ts";
import { homeReadPolicy, readPolicyScope } from "../src/harness/read-policy.ts";
import { mapGitHubEvent, runGh } from "../src/integrations/github.ts";
import {
  configureGitHubIdentity,
  createGitHubIdentity,
  GitHubIdentityError,
  githubIdentity,
  githubRepo,
  githubSh,
} from "../src/integrations/github-identity.ts";
import { getGitHubPr } from "../src/integrations/github-notifier.ts";
import { ghClient, startGitHubPoller } from "../src/integrations/github-poller.ts";
import * as privateReads from "../src/util/private-reads.ts";
import { privateReadPaths, protectPrivateFile } from "../src/util/private-reads.ts";
import * as proc from "../src/util/proc.ts";
import { pollerHarness } from "./github-poller-support.ts";
import { setupFixture } from "./setup-support.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
let dir: string;
let keyPath: string;
const appTable = () => ({ app_id: "123", installation_id: 456, private_key_path: "key.pem", repos: ["O/R"] });
const config = (app: unknown = appTable(), extra = {}) =>
  loadConfig({
    home: dir,
    configDir: dir,
    readOnly: true,
    raw: { github: app === null ? {} : { app }, ...extra },
  });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "github-app-"));
  keyPath = join(dir, "key.pem");
  writeFileSync(keyPath, pem, { mode: 0o600 });
});
afterEach(() => {
  configureGitHubIdentity(null);
  rmSync(dir, { recursive: true, force: true });
});

function endpoint(start = Date.parse("2026-10-01T00:00:00Z")) {
  let now = start;
  let exchanges = 0;
  const token = `installation-${randomUUID()}`;
  const jwts: string[] = [];
  const paths: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    paths.push(url);
    if (url.endsWith("/access_tokens")) {
      const jwt = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
      jwts.push(jwt);
      expect(proc.redactCredentials(jwt)).toBe("[redacted]");
      exchanges++;
      return Response.json({ token, expires_at: new Date(now + 3600_000).toISOString() });
    }
    if (url.endsWith("/app")) return Response.json({ slug: "factory" });
    throw new Error(`Unexpected URL ${url}`);
  };
  return {
    token,
    jwts,
    paths,
    fetch,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    exchanges: () => exchanges,
  };
}

test.each(["regular", "symlink", "absent", "startup failure"])(
  "daemon protects the App key before mounting and releases it: %s",
  async (kind) => {
    const external = mkdtempSync(join(tmpdir(), "github-key-"));
    const target = join(external, "key.pem");
    writeFileSync(target, pem, { mode: 0o600 });
    const path = kind === "symlink" ? join(external, "link.pem") : target;
    if (kind === "symlink") symlinkSync(target, path);
    const cfg = config(kind === "absent" ? null : { ...appTable(), private_key_path: path });
    cfg.port = 0;
    const store = new Store(":memory:");
    const factory = new Factory(cfg, { store, models: [], providers: [], bootSha: "f".repeat(40) });
    const start = spyOn(factory, "start").mockImplementation(() => {});
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    const spellings = [...new Set([resolve(path), realpathSync(path)])];
    const pendingKey = join(external, "pending.pem");
    const check = () => {
      for (const spelling of spellings) {
        expect(privateReadPaths().includes(spelling)).toBe(kind !== "absent");
        const deny = readPolicyScope.run({ home: dir, environment: {} }, () => homeReadPolicy([]));
        expect(deny.denyRead.includes(spelling)).toBe(kind !== "absent");
      }
    };
    try {
      const pending = startDaemon(factory, {}, async () => {
        check();
        if (kind === "startup failure") {
          writeFileSync(pendingKey, pem, { mode: 0o600 });
          writeFileSync(
            join(dir, "config.toml"),
            `[github.app]\napp_id = 123\ninstallation_id = 456\nprivate_key_path = ${JSON.stringify(pendingKey)}\nrepos = ["O/R"]\n`,
          );
          factory.reloadConfig();
          expect(privateReadPaths()).toContain(pendingKey);
          throw new Error("mount failed");
        }
        return { routes: {}, notes: [], stop: async () => {} };
      });
      if (kind === "startup failure") {
        await expect(pending).rejects.toThrow("mount failed");
        factory.reloadConfig();
        expect(privateReadPaths()).not.toContain(pendingKey);
      } else {
        daemon = await pending;
        check();
      }
    } finally {
      await daemon?.server.stop(true);
      start.mockRestore();
      await factory.stop();
      store.close();
      rmSync(external, { recursive: true, force: true });
    }
    for (const spelling of spellings) expect(privateReadPaths()).not.toContain(spelling);
    expect(privateReadPaths()).not.toContain(pendingKey);
  },
);

test.each(["existing", "added"])(
  "daemon retains active and pending App key protections: %s",
  async (kind) => {
    const external = mkdtempSync(join(tmpdir(), "github-key-reload-"));
    const canonical = join(realpathSync(external), "keys");
    mkdirSync(canonical);
    const alias = join(external, "alias");
    symlinkSync(canonical, alias);
    const keys = ["active.pem", "pending.pem", "replacement.pem", "detached.pem"].map((name) => {
      writeFileSync(join(canonical, name), pem, { mode: 0o600 });
      return join(alias, name);
    });
    const [active = "", pending = "", replacement = "", detached = ""] = keys;
    const write = (path: string | null) =>
      writeFileSync(
        join(dir, "config.toml"),
        path
          ? `[github.app]\napp_id = 123\ninstallation_id = 456\nprivate_key_path = ${JSON.stringify(path)}\nrepos = ["O/R"]\n`
          : "",
      );
    write(kind === "existing" ? active : null);
    const cfg = loadConfig({ home: dir, configDir: dir, readOnly: true });
    cfg.port = 0;
    const store = new Store(":memory:");
    const factory = new Factory(cfg, { store, models: [], providers: [], bootSha: "f".repeat(40) });
    const start = spyOn(factory, "start").mockImplementation(() => {});
    let independent = () => {};
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    const spellings = (path: string) => [resolve(path), realpathSync(path)];
    const check = (paths: string[], protectedPaths = true) => {
      const policies = [false, true].map((gate) =>
        readPolicyScope.run({ home: dir, environment: {} }, () => homeReadPolicy([], gate)),
      );
      for (const path of paths) {
        expect(spellings(path)[0]).not.toBe(spellings(path)[1]);
        for (const spelling of spellings(path)) {
          expect(privateReadPaths().includes(spelling)).toBe(protectedPaths);
          for (const policy of policies) expect(policy.denyRead.includes(spelling)).toBe(protectedPaths);
        }
      }
    };
    try {
      daemon = await startDaemon(factory, {}, async () => ({ routes: {}, notes: [], stop: async () => {} }));
      const accepted = kind === "existing" ? [active] : [];
      for (const path of [pending, pending, replacement, null, active]) {
        write(path);
        const result = factory.reloadConfig();
        if (kind === "existing" ? path !== active : path !== null)
          expect(result.restartRequired).toContain("github.app.private_key_path");
        else expect(result.restartRequired).toEqual([]);
        expect(result.applied).toEqual([]);
        expect(factory.cfg.githubApp).toBe(cfg.githubApp);
        expect(factory.deps.cfg.githubApp).toBe(cfg.githubApp);
        if (path) accepted.push(path);
        check(accepted);
      }
      // A registration error must abort before publishing config or a reload event.
      write(detached);
      const before = factory.cfg;
      const feedLength = store.readFeed().items.length;
      const protect = spyOn(privateReads, "protectPrivateFile").mockImplementation(() => {
        throw new Error("protection failed");
      });
      try {
        expect(() => factory.reloadConfig()).toThrow("protection failed");
        expect(factory.cfg).toBe(before);
        expect(factory.deps.cfg.githubApp).toBe(cfg.githubApp);
        expect(store.readFeed().items).toHaveLength(feedLength);
        check([detached], false);
      } finally {
        protect.mockRestore();
      }
      independent = protectPrivateFile(pending);
      await daemon.server.stop(true);
      check([active, replacement], false);
      check([pending]);
      independent();
      check([pending], false);
      // Cleanup detaches the hook so later reloads cannot leak registrations.
      write(detached);
      factory.reloadConfig();
      check([detached], false);
    } finally {
      await daemon?.server.stop(true);
      independent();
      start.mockRestore();
      await factory.stop();
      store.close();
      rmSync(external, { recursive: true, force: true });
    }
  },
);

test("repository parser recognizes structured references", () => {
  for (const args of [
    ["pr", "view", "--repo", "o/r"],
    ["pr", "view", "-R", "o/r"],
    ["pr", "view", "--repo=o/r"],
    ["pr", "view", "-R=o/r"],
    ["pr", "view", "https://github.com/o/r/pull/1"],
    ["repo", "view", "https://github.com/o/r"],
    ["api", "repos/o/r/issues/1"],
    ["repo", "view", "o/r"],
  ])
    expect(githubRepo(args)).toBe("o/r");
});

test.each([
  "--body",
  "-b",
  "--body-file",
  "--subject",
  "--title",
  "-t",
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--jq",
  "-q",
  "--json",
  "--template",
  "--match-head-commit",
  "--head",
  "-H",
  "--header",
  "--base",
  "-B",
  "--state",
  "--method",
  "-X",
  "--input",
  "--limit",
  "-L",
  "--label",
  "-l",
  "--search",
])("repository parser skips %s values", (flag) => {
  for (const value of [
    "--repo",
    "-R",
    "--repo=x/y",
    "--repo x/y",
    "https://github.com/x/y/pull/2",
    "repos/x/y/issues",
    "body=--repo x/y",
  ]) {
    expect(githubRepo(["pr", "create", flag, value, "--repo", "o/r"])).toBe("o/r");
    expect(githubRepo(["api", flag, value])).toBeUndefined();
    expect(githubRepo(["pr", "create", `${flag}=${value}`])).toBeUndefined();
  }
});

test("explicit repositories reject conflicting references before gh starts, but ignore field values", async () => {
  const e = endpoint();
  configureGitHubIdentity(config().githubApp, e);
  const runner = spyOn(proc, "runProcess").mockResolvedValue(success(""));
  try {
    for (const [repo, other] of [
      ["o/r", "x/y"],
      ["x/y", "o/r"],
    ]) {
      for (const reference of [
        [`https://github.com/${other}/pull/1`],
        ["--repo", other ?? ""],
        ["-R", other ?? ""],
        [`--repo=${other}`],
        [`repos/${other}/issues/1`],
        ["--repo", repo ?? "", `https://github.com/${other}/pull/1`],
      ]) {
        await expect(githubSh(["gh", "pr", "view", ...reference], { cwd: dir }, repo)).rejects.toBeInstanceOf(
          GitHubIdentityError,
        );
      }
    }
    expect(runner).not.toHaveBeenCalled();
    expect(e.exchanges()).toBe(0);
    await githubSh(["gh", "pr", "view", "https://github.com/o/r/pull/1"], { cwd: dir }, "O/R");
    for (const value of ["body=--repo x/y", "body=https://github.com/x/y/pull/2"]) {
      await githubSh(["gh", "api", "repos/o/r/issues/1/comments", "-f", value], { cwd: dir }, "o/r");
    }
    for (const [flag, value] of [
      ["--body", "--repo"],
      ["--title", "https://github.com/x/y/pull/9"],
    ]) {
      await githubSh(
        ["gh", "pr", "edit", "https://github.com/o/r/pull/1", flag ?? "", value ?? ""],
        { cwd: dir },
        "o/r",
      );
    }
    expect(runner).toHaveBeenCalledTimes(5);
    for (const [opts] of runner.mock.calls) expect(opts.env.GH_TOKEN).toBe(e.token);
  } finally {
    runner.mockRestore();
  }
});

test.each(["permissions", "symlink", "directory"])("signing refuses a changed key: %s", async (kind) => {
  const e = endpoint();
  const app = config().githubApp;
  if (!app) throw new Error("missing App config");
  configureGitHubIdentity(app, e);
  const runner = spyOn(proc, "runProcess").mockResolvedValue(success(""));
  try {
    if (kind === "permissions") {
      await githubSh(["gh", "pr", "view", "1"], { cwd: dir }, "o/r");
      chmodSync(keyPath, 0o644);
      e.advance(3300_000);
    } else {
      const path = join(dir, "replacement");
      if (kind === "symlink") symlinkSync(keyPath, path);
      else mkdirSync(path);
      configureGitHubIdentity({ ...app, privateKeyPath: path }, e);
    }
    runner.mockClear();
    const requests = e.paths.length;
    const error = await githubSh(["gh", "pr", "create", "--repo", "o/r"], { cwd: dir }).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(GitHubIdentityError);
    expect(String(error)).toMatch(
      kind === "permissions" ? /0644/ : kind === "symlink" ? /symlink/i : /not a regular file/,
    );
    expect(String(error)).not.toContain("-----BEGIN");
    expect(e.paths).toHaveLength(requests);
    expect(runner).not.toHaveBeenCalled();
  } finally {
    runner.mockRestore();
  }
});

test("optional App config normalizes IDs, repositories and relative key paths", () => {
  expect(config(null).githubApp).toBeNull();
  writeFileSync(
    join(dir, "config.toml"),
    '[github.app]\napp_id = "123"\ninstallation_id = 456\nprivate_key_path = "key.pem"\nrepos = ["O/R"]\n',
  );
  expect(loadConfig({ home: dir, configDir: dir, readOnly: true }).githubApp).toEqual({
    appId: 123,
    installationId: 456,
    privateKeyPath: keyPath,
    repos: ["o/r"],
  });
  chmodSync(keyPath, 0o400);
  expect(config().githubApp?.privateKeyPath).toBe(keyPath);
});

test.each(["app_id", "installation_id", "private_key_path", "repos"])("App config requires %s", (key) => {
  const table: Record<string, unknown> = appTable();
  delete table[key];
  expect(() => config(table)).toThrow(`github.app.${key}`);
});
test.each([0o644, 0o640, 0o601])("key permissions %s refuse with path and mode", (mode) => {
  chmodSync(keyPath, mode);
  expect(() => config()).toThrow(`${keyPath} must be a regular file mode 0600 (is 0${mode.toString(8)})`);
});
test.each(["directory", "missing"])("App key refuses a %s path", (kind) => {
  const path = kind === "directory" ? dir : join(dir, "absent.pem");
  expect(() => config({ ...appTable(), private_key_path: path })).toThrow(
    `github.app.private_key_path ${path}`,
  );
});
test("discreet repositories refuse the App's factory mark case-insensitively", () => {
  expect(() => config(appTable(), { repos: { "o/r": { discreet: true } } })).toThrow(
    /O\/R.*\[bot\].*factory mark/,
  );
});
test.each([
  { app_id: -1 },
  { installation_id: "1.5" },
  { repos: [] },
  { repos: ["bad"] },
  { private_key_path: "" },
])("invalid App values name the key: %j", (invalid) => {
  expect(() => config({ ...appTable(), ...invalid })).toThrow(`github.app.${Object.keys(invalid)[0]}`);
});

test("JWT verifies as RS256; token exchanges share a flight, cache and refresh at five minutes", async () => {
  const e = endpoint();
  const identity = createGitHubIdentity(config().githubApp, e);
  const results = await Promise.all([identity("O/R"), identity("o/r")]);
  expect(results).toEqual([
    { kind: "app", token: e.token, botLogin: "factory[bot]" },
    { kind: "app", token: e.token, botLogin: "factory[bot]" },
  ]);
  const jwt = e.jwts[0] ?? "";
  const [header = "", payload = "", signature = ""] = jwt.split(".");
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  expect(claims.iss).toBe(123);
  expect(claims.iat).toBeGreaterThanOrEqual(e.now() / 1000 - 60);
  expect(claims.iat).toBeLessThanOrEqual(e.now() / 1000);
  expect(claims.exp).toBe(e.now() / 1000 + 540);
  expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  expect(
    verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")),
  ).toBe(true);
  e.advance(3300_000 - 1);
  await identity("o/r");
  expect(e.exchanges()).toBe(1);
  e.advance(1);
  await Promise.all([identity("o/r"), identity("o/r")]);
  expect(e.exchanges()).toBe(2);
  expect(e.paths.filter((p) => p.endsWith("/app"))).toHaveLength(1);
  expect(proc.redactCredentials(`x ${e.token} ${jwt}`)).toBe("x [redacted] [redacted]");
  const old = process.env.GH_TOKEN;
  try {
    process.env.GH_TOKEN = e.token;
    const env = proc.agentEnv();
    expect(env.GH_TOKEN).toBe("limitless-agents-have-no-github-access");
    for (const value of Object.values(env)) expect([e.token, jwt, keyPath, pem]).not.toContain(value);
  } finally {
    if (old === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = old;
  }
});

const success = (stdout: string): proc.ProcResult => ({
  exitCode: 0,
  signal: null,
  cancelled: false,
  timedOut: false,
  idleTimedOut: false,
  stdout,
  stderr: "",
  truncated: false,
  durationMs: 0,
});

test("all gh entry points inject the App token, while owner calls retain their environment", async () => {
  const e = endpoint();
  configureGitHubIdentity(config().githubApp, e);
  const calls: proc.ProcOptions[] = [];
  const pr = "https://github.com/o/r/pull/1";
  const sha = "a".repeat(40);
  let existing = false;
  const runner = spyOn(proc, "runProcess").mockImplementation(async (opts) => {
    calls.push(opts);
    const args = opts.cmd;
    if (args[1] === "repo")
      return success(
        JSON.stringify({ defaultBranchRef: { name: "main" }, sshUrl: "git@github.com:o/r.git" }),
      );
    if (args[2] === "list") return success(existing ? pr : "");
    if (args[2] === "create") return success(pr);
    if (args[2] === "view")
      return success(
        JSON.stringify({
          url: pr,
          state: "OPEN",
          headRefOid: sha,
          title: "change",
          body: "--repo",
          mergedAt: null,
          mergedBy: null,
        }),
      );
    return success("");
  });
  const store = new Store(":memory:");
  try {
    await runGh(["issue", "comment", "1", "--repo", "O/R", "--body", "test"]);
    await runGh(["api", "graphql"], undefined, undefined, "o/r");
    const repo = await resolveRepo(store, "o/r");
    await getGitHubPr(pr);
    await createPullRequest(repo, {
      branch: "change",
      base: "main",
      title: "--repo",
      body: "https://github.com/x/y/pull/9",
      cwd: dir,
    });
    existing = true;
    await createPullRequest(repo, {
      branch: "change",
      base: "main",
      title: "--repo",
      body: "https://github.com/x/y/pull/9",
      cwd: dir,
    });
    await findPullRequest(repo, "change", dir);
    await mergePullRequest(pr, dir, sha, undefined, undefined, [], { auto: false });
    await disableAutoMerge(pr, dir);
    expect(calls.some((call) => call.cmd[2] === "merge" && call.cmd.includes("--body"))).toBe(true);
    expect(calls.some((call) => call.cmd[2] === "edit")).toBe(true);
    expect(calls.length).toBeGreaterThan(10);
    for (const call of calls) expect(call.env.GH_TOKEN).toBe(e.token);
    expect(e.exchanges()).toBe(1);
    calls.length = 0;
    await runGh(["pr", "view", "https://github.com/other/repo/pull/2"]);
    expect(calls[0]?.env.GH_TOKEN).toBe(process.env.GH_TOKEN);
    expect(await githubIdentity("other/repo")).toEqual({ kind: "owner" });
    configureGitHubIdentity(null);
    await runGh(["pr", "view", pr]);
    expect(calls[1]?.env.GH_TOKEN).toBe(process.env.GH_TOKEN);
    expect(e.exchanges()).toBe(1);
  } finally {
    store.close();
    runner.mockRestore();
  }
});

test("PR recovery and edits refuse a URL outside the helper's known repository", async () => {
  const e = endpoint();
  configureGitHubIdentity(config().githubApp, e);
  const store = new Store(":memory:");
  const repo = store.upsertRepo({
    slug: "o/r",
    kind: "github",
    url: "git@github.com:o/r.git",
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  const pr = "https://github.com/x/y/pull/9";
  const runner = spyOn(proc, "runProcess").mockImplementation(async (opts) =>
    success(opts.cmd[2] === "view" ? JSON.stringify({ url: pr, headRefOid: "a".repeat(40) }) : pr),
  );
  try {
    await expect(
      findPullRequest(repo, "change", dir, undefined, { headSha: "a".repeat(40), prUrl: pr }),
    ).rejects.toBeInstanceOf(GitHubIdentityError);
    expect(runner).not.toHaveBeenCalled();
    await expect(
      createPullRequest(repo, { branch: "change", base: "main", title: "--repo", body: pr, cwd: dir }),
    ).rejects.toBeInstanceOf(GitHubIdentityError);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]?.[0].cmd[2]).toBe("list");
  } finally {
    runner.mockRestore();
    store.close();
  }
});

test("REST sends the App bearer even for explicitly scoped GraphQL", async () => {
  const e = endpoint();
  configureGitHubIdentity(config().githubApp, e);
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(`bearer ${e.token}`);
    return Response.json({ data: {} });
  }) as typeof globalThis.fetch);
  const runner = spyOn(proc, "runProcess").mockRejectedValue(new Error("unexpected owner token lookup"));
  try {
    await ghClient("repos/o/r/pulls/1");
    await ghClient("graphql", { query: "test" }, undefined, "o/r");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(e.exchanges()).toBe(1);
    expect(runner).not.toHaveBeenCalled();
  } finally {
    runner.mockRestore();
    fetch.mockRestore();
  }
});

test.each(["401", "network", "malformed", "expired"])(
  "failed exchange %s fails a write before spawning gh, with a redacted reason",
  async (failure) => {
    let jwt = "";
    const token = `invalid-${randomUUID()}`;
    configureGitHubIdentity(config().githubApp, {
      fetch: async (_url, init) => {
        jwt = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
        if (failure === "network") throw new Error(`offline ${jwt}`);
        if (failure === "malformed") return new Response("not JSON");
        if (failure === "expired") return Response.json({ token, expires_at: "2000-01-01" });
        return Response.json({ token, message: `Bad credentials ${jwt} ${token}` }, { status: 401 });
      },
    });
    const runner = spyOn(proc, "runProcess").mockRejectedValue(new Error("must not spawn"));
    try {
      const error = await runGh(["pr", "create", "--repo", "o/r"]).catch((e: unknown) => String(e));
      expect(error).toContain("GitHub App token exchange failed: HTTP");
      if (failure === "401") expect(error).toContain("401: Bad credentials");
      expect(error).not.toContain(jwt);
      expect(error).not.toContain(token);
      expect(error).not.toContain(pem);
      expect(runner).not.toHaveBeenCalled();
    } finally {
      runner.mockRestore();
    }
  },
);

test("gh command errors redact registered installation credentials", async () => {
  const e = endpoint();
  configureGitHubIdentity(config().githubApp, e);
  const runner = spyOn(proc, "runProcess").mockImplementation(async () => ({
    ...success(""),
    exitCode: 1,
    stderr: `${e.token} ${e.jwts[0]}`,
  }));
  try {
    const error = await runGh(["pr", "create", "--repo", "o/r"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(proc.CommandError);
    expect(String(error)).toContain("[redacted]");
    expect(String(error)).not.toContain(e.token);
    expect(String(error)).not.toContain(e.jwts[0] ?? "missing JWT");
  } finally {
    runner.mockRestore();
  }
});

test.each(["covered", "missing", "exchange failure", "owner"])(
  "doctor reports %s identity without secrets",
  async (kind) => {
    const f = setupFixture();
    const e = endpoint(Date.now());
    try {
      f.d.config = kind === "owner" ? config(null) : config();
      f.d.fetch = async (url, init) => {
        if (url.includes("api.github.com/app")) {
          if (kind === "exchange failure") {
            const jwt = new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
            e.jwts.push(jwt);
            return Response.json(
              { token: e.token, message: `Bad credentials ${jwt} ${e.token}` },
              { status: 401 },
            );
          }
          return e.fetch(url, init);
        }
        if (url.includes("/installation/repositories")) {
          expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${e.token}`);
          if (kind === "covered" && url.endsWith("page=1"))
            return Response.json(
              { repositories: [{ full_name: "o/other" }] },
              {
                headers: {
                  link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
                },
              },
            );
          return Response.json({ repositories: [{ full_name: kind === "missing" ? "o/other" : "o/r" }] });
        }
        return new Response("", { status: 503 });
      };
      const run = f.d.run;
      f.d.run = (args, ...rest) =>
        args.join(" ") === "gh api user"
          ? Promise.resolve({ exitCode: 0, stdout: '{"login":"owner"}', stderr: "" })
          : run(args, ...rest);
      const checks = await doctor(f.d);
      const check = checks.find((c) => c.id === "github-identity");
      expect(check?.status).toBe(kind === "missing" || kind === "exchange failure" ? "fail" : "ok");
      expect(check?.message).toContain(
        kind === "owner"
          ? "owner gh login: owner"
          : kind === "exchange failure"
            ? "401"
            : "factory[bot]: token exchange ok",
      );
      if (kind === "missing") expect(check?.message).toContain("not covered: o/r");
      if (kind === "covered") expect(check?.message).toContain("installation repositories: o/other, o/r");
      for (const secret of [e.token, ...e.jwts, pem]) expect(JSON.stringify(checks)).not.toContain(secret);
    } finally {
      f.close();
    }
  },
);

test("poller carries the repository into every REST and GraphQL request", async () => {
  const h = pollerHarness();
  const repos: (string | undefined)[] = [];
  h.factoryPr("o/r", 1);
  const stop = startGitHubPoller(h.store, {
    client: (path, body, signal, repo) => {
      repos.push(repo);
      return h.gh.client(path, body, signal);
    },
    gh: async () => {
      throw new Error("unexpected conflict lookup");
    },
    clock: {
      now: h.clock.now,
      set: h.clock.timer.set as unknown as typeof setTimeout,
      clear: h.clock.timer.clear,
    },
  });
  try {
    await h.advance(0);
    expect(repos.length).toBeGreaterThan(0);
    expect(repos.every((repo) => repo === "o/r")).toBe(true);
  } finally {
    stop();
    h.close();
  }
});

test("App comments and labels keep the webhook's owner trust boundary", async () => {
  const e = endpoint();
  const identity = await createGitHubIdentity(config().githubApp, e)("o/r");
  if (identity.kind !== "app") throw new Error("missing App identity");
  const event = {
    action: "created",
    repository: { full_name: "owner/repo" },
    sender: { login: "owner" },
    issue: { number: 1, title: "task", body: "text", user: { login: "owner" } },
    comment: { user: { login: "owner" }, body: "/limitless do it" },
  };
  expect(mapGitHubEvent("issue_comment", event, "owner").request?.requestedBy).toBe("owner");
  const bot = { login: identity.botLogin };
  expect(
    mapGitHubEvent(
      "issue_comment",
      { ...event, sender: bot, comment: { ...event.comment, user: bot } },
      "owner",
    ).request,
  ).toBeUndefined();
  expect(
    mapGitHubEvent(
      "issues",
      { ...event, action: "labeled", sender: bot, label: { name: "limitless" } },
      "owner",
    ).request,
  ).toBeUndefined();
});
