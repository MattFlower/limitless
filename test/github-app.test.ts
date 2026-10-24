import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { mapGitHubEvent, runGh } from "../src/integrations/github.ts";
import {
  configureGitHubIdentity,
  createGitHubIdentity,
  githubIdentity,
} from "../src/integrations/github-identity.ts";
import { getGitHubPr } from "../src/integrations/github-notifier.ts";
import { ghClient, startGitHubPoller } from "../src/integrations/github-poller.ts";
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
          body: "body",
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
      title: "change",
      body: "body",
      cwd: dir,
    });
    existing = true;
    await createPullRequest(repo, {
      branch: "change",
      base: "main",
      title: "change",
      body: "body",
      cwd: dir,
    });
    await findPullRequest(repo, "change", dir);
    await mergePullRequest(pr, dir, sha, undefined, undefined, [], { auto: false });
    await disableAutoMerge(pr, dir);
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
