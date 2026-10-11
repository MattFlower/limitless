import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { apiTokenHeaders, readApiToken } from "../src/cli/api-token.ts";
import { localDeployClient } from "../src/cli/deploy-wait.ts";
import { localLeaseClient } from "../src/cli/gate-slot.ts";
import { loadConfig } from "../src/config.ts";
import { buildClaudeArgs } from "../src/harness/claude.ts";
import { buildCodexArgs } from "../src/harness/codex.ts";
import { seatbeltBackend, seatbeltForPort, seatbeltProfile } from "../src/harness/sandbox.ts";
import { SCRATCH_NAME, writeRoots } from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { httpBackend } from "../src/integrations/mcp.ts";
import { createApiToken } from "../src/server/api-token.ts";
import { Auth } from "../src/server/auth.ts";
import { createHttpRoutes, startHttp } from "../src/server/http.ts";
import { privateReadPaths } from "../src/util/private-reads.ts";
import { agentEnv, redactCredentials, runProcess, sh } from "../src/util/proc.ts";
import { seatbeltSkip } from "./confinement.ts";
import { connect, fixture, localServer, type Route, requestWithParams, resultValue } from "./mcp-support.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let server: ReturnType<typeof startHttp>;
let token: string;
let base: string;
const daemonPort = () => {
  const port = server.port;
  if (!port) throw new Error("test daemon has no port");
  return port;
};
const tokenPath = () => join(f.factory.cfg.paths.home, "api-token");
beforeAll(async () => {
  f = await fixture();
  f.factory.cfg.port = 0;
  f.factory.cfg.requireApiToken = true;
  server = startHttp(f.factory, { routes: { "/mcp": () => new Response("ok") } });
  base = `http://127.0.0.1:${server.port}`;
  token = readFileSync(tokenPath(), "utf8");
});
afterAll(async () => {
  await server.stop(true);
  await f.close();
});

const post = (path: string, headers: Record<string, string> = {}, body: unknown = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const credential = () => ({ authorization: `Bearer ${token}` });
const exempt = (path: string) =>
  path.startsWith("/webhooks/") ||
  path === "/login" ||
  path === "/enroll" ||
  path.startsWith("/api/auth/passkey/") ||
  path === "/api/auth/logout" ||
  path === "/api/auth/logout-all";

test("all registered mutations, admin routes and MCP require credentials", async () => {
  const routes = createHttpRoutes(f.factory, { routes: { "/mcp": () => new Response("ok") } });
  for (const [pattern, entry] of Object.entries(routes)) {
    if (exempt(pattern)) continue;
    const methods = typeof entry === "function" ? { POST: entry } : (entry as Record<string, unknown>);
    for (const method of Object.keys(methods)) {
      if (
        ["GET", "HEAD", "OPTIONS"].includes(method) &&
        !pattern.startsWith("/api/admin") &&
        pattern !== "/mcp"
      )
        continue;
      const path = pattern.replace(/:[\w]+/g, "x").replace("*", "x");
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json" },
      });
      expect([method, pattern, response.status]).toEqual([method, pattern, 401]);
      const body = await response.text();
      expect(JSON.parse(body).error).toMatch(/API token required.*update/);
      expect(body).not.toContain(token);
    }
  }
  for (const path of ["/api/health", "/api/runs"]) expect((await fetch(`${base}${path}`)).status).toBe(200);
  expect((await fetch(`${base}/api/admin/drain`, { method: "POST" })).status).toBe(401);
  for (const method of ["GET", "HEAD", "OPTIONS", "DELETE"])
    expect((await fetch(`${base}/mcp`, { method })).status).toBe(401);
});

test("token and loopback sessions authorize; bad credentials never fall back", async () => {
  const cookie = new Auth(f.factory.store, f.factory.cfg).signIn("password", "test").split(";")[0] ?? "";
  try {
    for (const enforcement of [true, false]) {
      f.factory.cfg.requireApiToken = enforcement;
      for (const headers of [credential(), { cookie }])
        expect((await post("/api/admin/drain", headers)).status).toBe(200);
      for (const authorization of [
        "Bearer wrong",
        "Bearer",
        "Bearer ",
        "Basic abc",
        `Bearer ${token} extra`,
      ]) {
        expect((await post("/api/admin/drain", { authorization, cookie })).status).toBe(401);
        expect((await fetch(`${base}/api/health`, { headers: { authorization } })).status).toBe(401);
      }
      expect((await post("/api/admin/drain")).status).toBe(enforcement ? 401 : 200);
    }
    expect((await post("/api/admin/drain", { ...credential(), origin: "https://evil.example" })).status).toBe(
      403,
    );
    expect((await fetch(`${base}/api/admin/drain`, { method: "POST", headers: credential() })).status).toBe(
      415,
    );
  } finally {
    f.factory.cfg.requireApiToken = true;
  }
});

test("the capability hook authorizes only gate-slot, preserving loopback restrictions", async () => {
  const capability = { authorization: "Bearer invocation-capability" };
  const routes = createHttpRoutes(f.factory, {
    apiToken: token,
    gateSlotCapability: (req) => req.headers.get("authorization") === capability.authorization,
  });
  const call = (path: string, headers: Record<string, string>, peer = localServer) => {
    const handler = (routes[path] as { POST: Route }).POST;
    return handler(
      requestWithParams(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: '{"id":"unknown"}',
      }),
      peer,
    );
  };
  expect((await call("/api/admin/gate-slot", capability)).status).toBe(200);
  for (const path of ["/api/land", "/api/runs/:id/review"])
    expect((await call(path, capability)).status).toBe(401);
  const remote = { requestIP: () => ({ address: "192.0.2.1" }) } as unknown as Server<undefined>;
  for (const headers of [capability, credential()])
    expect((await call("/api/admin/gate-slot", headers, remote)).status).toBe(403);
});

function editorSpec(): AgentSpec {
  const scratch = join(f.home, "scratch", SCRATCH_NAME);
  mkdirSync(scratch, { recursive: true });
  return {
    cwd: f.repo,
    scratchDir: scratch,
    mode: "edit",
    prompt: "test",
    logPath: join(scratch, "log"),
    timeoutMs: 5000,
    idleTimeoutMs: 5000,
    maxToolCalls: 1,
    signal: new AbortController().signal,
    onEvent: () => {},
    target: {
      modelId: "fake/m",
      provider: "fake",
      harness: "fake",
      model: "test",
      vendor: "test",
      tier: 4,
      billing: "subscription",
    },
  };
}

test("startup rotates a private 0600 token protected in every sandbox spelling", async () => {
  expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(redactCredentials(token)).toBe("[redacted]");
  const spec = editorSpec();
  expect(
    seatbeltForPort(daemonPort())
      .wrap(["true"], writeRoots(spec.cwd, spec.scratchDir ?? ""))
      .join(" "),
  ).toContain(`localhost:${daemonPort()}`);
  const alias = join(f.home, "alias");
  symlinkSync(f.factory.cfg.paths.home, alias);
  const rotated = createApiToken(alias);
  try {
    const path = join(alias, "api-token");
    for (const spelling of [path, realpathSync(path)]) {
      expect(privateReadPaths()).toContain(spelling);
      expect(buildCodexArgs(spec).join(" ")).toContain(`${JSON.stringify(spelling)}="none"`);
      expect(seatbeltProfile(writeRoots(spec.cwd, spec.scratchDir ?? ""))).toContain(
        `(subpath "${spelling}")`,
      );
      const reader = buildClaudeArgs({ ...spec, mode: "readonly" }, "test");
      expect(
        JSON.parse(reader[reader.indexOf("--settings") + 1] ?? "{}").sandbox.filesystem.denyRead,
      ).toContain(spelling);
    }
  } finally {
    rotated.release();
  }
  await server.stop(true);
  server = startHttp(f.factory, { routes: { "/mcp": () => new Response("ok") } });
  base = `http://127.0.0.1:${server.port}`;
  const next = readFileSync(tokenPath(), "utf8");
  expect(next).not.toBe(token);
  expect(next).not.toBe(rotated.token);
  token = next;
});

test("config validates enforcement and defaults off", () => {
  const options = {
    home: f.factory.cfg.paths.home,
    configDir: f.factory.cfg.paths.configDir,
    readOnly: true,
  };
  expect(loadConfig({ ...options, raw: {} }).requireApiToken).toBe(false);
  expect(loadConfig({ ...options, raw: { server: { require_api_token: true } } }).requireApiToken).toBe(true);
  expect(() => loadConfig({ ...options, raw: { server: { require_api_token: "yes" } } })).toThrow(
    "server.require_api_token must be a boolean",
  );
});

test("local clients authenticate, pick up rotation, omit missing tokens and keep children clean", async () => {
  const previous = process.env.LIMITLESS_HOME;
  process.env.LIMITLESS_HOME = f.factory.cfg.paths.home;
  const signal = new AbortController().signal;
  try {
    const deploy = localDeployClient(daemonPort());
    expect((await deploy.admin("drain", signal)).draining).toBe(true);
    const lease = localLeaseClient(daemonPort());
    const held = await lease({ name: "token-test" }, signal);
    expect((await lease({ id: held.id }, signal)).acquired).toBe(true);
    await lease({ id: held.id, release: true }, signal);
    const proxy = await connect(httpBackend(base));
    try {
      const run = resultValue<{ id: string }>(
        await proxy.client.callTool({
          name: "limitless_create_run",
          arguments: { repo: f.repo, prompt: "authenticated" },
        }),
      );
      const cli = join(import.meta.dir, "../src/cli/main.ts");
      const env = { ...process.env, LIMITLESS_URL: base, LIMITLESS_PORT: String(server.port) };
      expect((await sh([process.execPath, cli, "cancel", run.id], { cwd: f.repo, env })).exitCode).toBe(0);
      const child = await sh(
        [
          process.execPath,
          cli,
          "gate-slot",
          "--",
          process.execPath,
          "-e",
          "console.log(JSON.stringify(process.env))",
        ],
        { cwd: f.repo, env },
      );
      expect(child.stdout).not.toContain(token);
      expect(JSON.stringify(agentEnv())).not.toContain(token);
      f.factory.cfg.port = daemonPort();
      await server.stop(true);
      server = startHttp(f.factory);
      base = `http://127.0.0.1:${server.port}`;
      token = readFileSync(tokenPath(), "utf8");
      expect((await deploy.admin("drain", signal)).draining).toBe(true);
      const renewed = await lease({ name: "rotated-token" }, signal);
      expect(renewed.acquired).toBe(true);
      await lease({ id: renewed.id, release: true }, signal);
      renameSync(tokenPath(), `${tokenPath()}.missing`);
      try {
        expect(apiTokenHeaders()).toEqual({});
        expect(readApiToken()).toBeNull();
        mkdirSync(tokenPath());
        try {
          expect(readApiToken()).toBeNull();
        } finally {
          rmSync(tokenPath(), { recursive: true });
        }
        const seen: Headers[] = [];
        const record = spyOn(globalThis, "fetch").mockImplementation(
          Object.assign(
            async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
              seen.push(new Headers(init?.headers));
              return Response.json({ id: "missing", acquired: true, draining: true, active: [], parked: [] });
            },
            { preconnect: fetch.preconnect },
          ),
        );
        try {
          await deploy.admin("drain", signal);
          await lease({ name: "missing" }, signal);
          await httpBackend(base).create({ repo: f.repo, prompt: "missing" });
          expect(seen).toHaveLength(3);
          for (const headers of seen) expect(headers.has("authorization")).toBe(false);
        } finally {
          record.mockRestore();
        }
        const old = await sh([process.execPath, cli, "cancel", run.id], {
          cwd: f.repo,
          env: { ...env, LIMITLESS_URL: base },
          allowFail: true,
        });
        expect(old.exitCode).not.toBe(0);
        expect(old.stderr).toMatch(/401: API token required.*update/);
        expect(old.stderr).not.toContain(token);
      } finally {
        renameSync(`${tokenPath()}.missing`, tokenPath());
      }
    } finally {
      await proxy.close();
    }
  } finally {
    if (previous === undefined) delete process.env.LIMITLESS_HOME;
    else process.env.LIMITLESS_HOME = previous;
  }
});

async function sandboxProbe(command: string[], codex = false) {
  const spec = editorSpec();
  const roots = { ...writeRoots(spec.cwd, spec.scratchDir ?? ""), daemonPort: server.port };
  const profile = buildCodexArgs(spec).filter(
    (arg, i, all) => all[i - 1] === "-c" && arg.includes("permissions"),
  );
  return runProcess({
    cmd: codex
      ? ["codex", "sandbox", ...profile.flatMap((p) => ["-c", p]), "--", ...command]
      : seatbeltBackend.wrap(command, roots),
    cwd: spec.cwd,
    env: { ...agentEnv(), TMPDIR: spec.scratchDir ?? "" },
    timeoutMs: 10_000,
  });
}
const curl = (url: string, method = "GET") => [
  "/usr/bin/curl",
  "--max-time",
  "5",
  "-s",
  "-o",
  "/dev/null",
  "-w",
  "%{http_code}",
  "-X",
  method,
  "-H",
  "content-type: application/json",
  url,
];

test.skipIf(seatbeltSkip !== null)(
  `Seatbelt denies token reads and daemon connections, permits other loopback ports ${seatbeltSkip ?? ""}`,
  async () => {
    const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const ipv6 = Bun.serve({ hostname: "::1", port: server.port, fetch: () => new Response("ok") });
    try {
      expect((await sandboxProbe(["/bin/cat", tokenPath()])).exitCode).not.toBe(0);
      for (const host of ["127.0.0.1", "[::1]"]) {
        const response = await sandboxProbe(curl(`http://${host}:${server.port}/api/runs/x/review`, "POST"));
        expect(response.exitCode).not.toBe(0);
      }
      expect((await sandboxProbe(curl(`http://127.0.0.1:${other.port}`))).stdout).toBe("200");
      const spec = editorSpec();
      const wrapped = seatbeltForPort(daemonPort()).wrap(
        ["true"],
        writeRoots(spec.cwd, spec.scratchDir ?? ""),
      );
      expect(wrapped.join(" ")).toContain(`localhost:${server.port}`);
    } finally {
      await other.stop(true);
      await ipv6.stop(true);
    }
  },
);

function codexUnavailable() {
  if (seatbeltSkip) return seatbeltSkip;
  if (!Bun.which("codex")) return "codex CLI not installed";
  const probe = Bun.spawnSync(["codex", "sandbox", "--", "true"], { stdout: "ignore", stderr: "ignore" });
  return probe.exitCode === 0 ? null : `codex sandbox cannot start here (exit ${probe.exitCode})`;
}
const codexSkip = codexUnavailable();
test.skipIf(seatbeltSkip !== null || codexSkip !== null)(
  `Codex editor cannot read the token or review without it ${codexSkip ?? ""}`,
  async () => {
    expect((await sandboxProbe(["/bin/cat", tokenPath()], true)).exitCode).not.toBe(0);
    expect((await sandboxProbe(curl(`${base}/api/runs/x/review`, "POST"), true)).stdout).toBe("401");
  },
);
