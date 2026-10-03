import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubAccessProblem } from "../src/core/types.ts";
import { githubDoctor } from "../src/integrations/github-poller.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";

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
async function doctor(url: string) {
  const child = Bun.spawn(["bun", "src/cli/main.ts", "doctor"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, LIMITLESS_URL: url, LIMITLESS_HOME: dir, LIMITLESS_CONFIG_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(readdirSync(dir)).toEqual([]);
  return { stdout, stderr, exit };
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
    expect(await doctor(url)).toMatchObject({ stdout: "GitHub access: ok\n", exit: 0 });
    problems = [{ repo: "acme/app", reason: "sso", detail: "SSO authorization required", since: 0 }];
    const failing = await doctor(url);
    expect(failing.exit).toBe(1);
    expect(failing.stdout).toContain("GitHub access problem in acme/app");
    expect(failing.stdout).toContain("gh auth refresh");
    expect(paths).toEqual(["/api/github/access", "/api/github/access"]);
  } finally {
    server.stop(true);
  }
  // The daemon is down: report that, with no database fallback.
  const down = await doctor(`http://127.0.0.1:${server.port}`);
  expect(down.exit).toBe(1);
  expect(down.stderr).toContain("Cannot reach the Limitless daemon");
  expect(existsSync(join(dir, "limitless.db"))).toBe(false);
});
