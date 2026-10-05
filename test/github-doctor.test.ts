import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubAccessProblem } from "../src/core/types.ts";
import { githubDoctor } from "../src/integrations/github-poller.ts";
import { tomlValue } from "../src/router/config-catalog.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { customProvider } from "./provider-config-support.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "github-doctor-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("the daemon API serves persisted access problems, read only", async () => {
  const f = await fixture();
  try {
    const route = createHttpRoutes(f.factory)["/api/github/access"] as Route;
    const read = async () =>
      (await route(requestWithParams("http://localhost:7400/api/github/access"), localServer)).json();
    expect(await read()).toEqual([]);
    f.factory.store.setGithubAccess("acme/app", { reason: "sso", detail: "SSO authorization required" });
    expect(await read()).toMatchObject([
      { repo: "acme/app", reason: "sso", detail: "SSO authorization required" },
    ]);
    f.factory.store.setGithubAccess("acme/app", null);
    expect(await read()).toEqual([]);
  } finally {
    await f.close();
  }
});

test("doctor formats the problems with their fix", () => {
  const problem = (repo: string, reason: string, detail: string): GitHubAccessProblem => ({
    repo,
    reason,
    detail,
    since: 0,
  });
  expect(githubDoctor([])).toEqual(["GitHub access: ok"]);
  const lines = githubDoctor([
    problem("acme/app", "sso", "SSO authorization required"),
    problem("acme/ip", "ip", "IP allow list"),
    problem("acme/auth", "auth", "Bad gh token: run `gh auth refresh`"),
  ]).join("\n");
  expect(lines).toContain("GitHub access problem in acme/app");
  expect(lines).toContain("sign in to your identity provider");
  expect(lines).toMatch(/acme\/ip[\s\S]*VPN/);
  expect(lines).toMatch(/acme\/auth since .*: Bad gh token: run `gh auth refresh`/);
});

/** Runs `limitless doctor` against `url` with an empty data directory it must never open. */
async function doctor(
  url: string,
  options: { config?: string; mutation?: boolean; violation?: string } = {},
) {
  if (options.config) writeFileSync(join(dir, "config.toml"), options.config);
  const before = readdirSync(dir);
  const child = Bun.spawn(
    ["bun", "--preload", "./test/fixtures/setup-cli-preload.ts", "src/cli/main.ts", "doctor"],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        LIMITLESS_URL: url,
        LIMITLESS_HOME: dir,
        LIMITLESS_CONFIG_DIR: dir,
        LIMITLESS_TEST_SETUP_TRACE: "1",
        LIMITLESS_TEST_SETUP_MUTATION: options.mutation ? "1" : "",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(readdirSync(dir)).toEqual(before);
  const trace = JSON.parse(stderr.split("\n")[0] ?? "");
  expect(trace.violations).toEqual(options.violation ? [options.violation] : []);
  return { stdout, stderr, exit, trace };
}

test("limitless doctor reads access problems through the daemon API, never the database", async () => {
  let problems: GitHubAccessProblem[] = [];
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      paths.push(new URL(req.url).pathname);
      return Response.json(problems);
    },
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    const healthy = await doctor(url);
    expect(healthy.exit).toBe(0);
    expect(healthy.stdout).toContain("ok feed-access: GitHub access: ok");
    expect(healthy.trace.requests).toEqual([
      "GET https://openrouter.ai/api/v1/key",
      "GET http://127.0.0.1:8989/v1/models",
      "GET http://127.0.0.1:8000/v1/models",
      "GET http://twilight:8080/v1/models",
      `GET ${url}/api/health`,
      `GET ${url}/api/github/access`,
    ]);
    problems = [{ repo: "acme/app", reason: "sso", detail: "SSO authorization required", since: 0 }];
    const failing = await doctor(url);
    expect(failing.exit).toBe(1);
    expect(failing.stdout).toContain("GitHub access problem in acme/app");
    expect(failing.stdout).toContain("gh auth refresh");
    expect(paths).toEqual(["/api/health", "/api/github/access", "/api/health", "/api/github/access"]);
  } finally {
    server.stop(true);
  }
  // The daemon is down: report that, with no database fallback.
  const down = await doctor(`http://127.0.0.1:${server.port}`);
  expect(down.exit).toBe(0);
  expect(down.stdout).toContain("warn daemon: unreachable");
  expect(down.stdout).toContain("Fix: limitless service install");
  expect(existsSync(join(dir, "limitless.db"))).toBe(false);
});

test("CLI doctor fakes configured LAN health probes and rejects an unknown target despite caught errors", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json([]) });
  const provider = {
    ...customProvider,
    api_key_env: undefined,
    id: "lan",
    health_url: "http://192.0.2.10:8080/v1/models",
  };
  try {
    const url = `http://127.0.0.1:${server.port}`;
    const healthy = await doctor(url, { config: `providers = ${tomlValue([provider])}\n` });
    expect(healthy.exit).toBe(0);
    expect(healthy.stdout).toContain("ok provider:lan:health: healthy");
    expect(healthy.trace.requests).toContain(`GET ${provider.health_url}`);
    const health_url = "https://unexpected-provider.invalid/health";
    const violation = `Unexpected fetch: GET ${health_url}`;
    const unknown = await doctor(url, {
      config: `providers = ${tomlValue([{ ...provider, health_url }])}\n`,
      violation,
    });
    expect(unknown.stdout).toContain("warn provider:lan:health: health check failed");
    expect(unknown.exit).toBe(1);
    expect(unknown.stderr).toContain(violation);
  } finally {
    server.stop(true);
  }
});

test("CLI doctor detects a service-installation mutation even when doctor catches the command failure", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json([]) });
  try {
    const violation = "Error: Unexpected command: bun main.ts service install";
    const result = await doctor(`http://127.0.0.1:${server.port}`, { mutation: true, violation });
    expect(result.trace.commands).toContain("bun main.ts service install");
    expect(result.stdout).toContain("ok git:");
    expect(result.stdout).toContain("ok gh:");
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain(violation);
  } finally {
    server.stop(true);
  }
});
