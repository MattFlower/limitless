import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { apiTokenHeaders, readApiToken } from "../src/cli/api-token.ts";
import { startDaemon } from "../src/cli/daemon.ts";
import { localDeployClient } from "../src/cli/deploy-wait.ts";
import { localLeaseClient } from "../src/cli/gate-slot.ts";
import { doctor, setupDeps } from "../src/cli/setup.ts";
import { loadConfig } from "../src/config.ts";
import { buildClaudeArgs } from "../src/harness/claude.ts";
import { buildCodexArgs } from "../src/harness/codex.ts";
import { seatbeltBackend, seatbeltForPort, seatbeltProfile } from "../src/harness/sandbox.ts";
import { SCRATCH_NAME, writeRoots } from "../src/harness/scratch.ts";
import type { AgentSpec } from "../src/harness/types.ts";
import { mountIntegrations } from "../src/integrations/index.ts";
import { httpBackend } from "../src/integrations/mcp.ts";
import { createApiToken } from "../src/server/api-token.ts";
import { Auth } from "../src/server/auth.ts";
import { createHttpRoutes, startHttp } from "../src/server/http.ts";
import { privateReadPaths } from "../src/util/private-reads.ts";
import { agentEnv, redactCredentials, runProcess, sh } from "../src/util/proc.ts";
import { seatbeltSkip } from "./confinement.ts";
import { connect, fixture, localServer, type Route, requestWithParams, resultValue } from "./mcp-support.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let server: Awaited<ReturnType<typeof startHttp>>;
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
  server = await startHttp(f.factory, {
    routes: { "/mcp": () => new Response("ok") },
    ui: { "/index.html": new Blob(["owner UI"]) },
  });
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
  path === "/api/auth/logout";

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
  expect((await fetch(`${base}/api/health`)).status).toBe(200);
  expect((await fetch(`${base}/api/runs`)).status).toBe(401);
  expect((await fetch(`${base}/api/admin/drain`, { method: "POST" })).status).toBe(401);
  for (const method of ["GET", "HEAD", "OPTIONS", "DELETE"])
    expect((await fetch(`${base}/mcp`, { method })).status).toBe(401);
});

test("private reads and all streams require the token or a session; anonymous UI redirects", async () => {
  const run = await f.factory.createRun({ repo: f.repo, prompt: "private prompt" });
  for (const name of ["holdout-scenarios.json", "verify-1.json"])
    f.factory.store.putArtifact(run.id, name, "json", '{"hidden":"scenario"}');
  f.factory.store.addEvent({ runId: run.id, type: "log", message: "private event" });
  const cookie = new Auth(f.factory.store, f.factory.cfg).signIn("password", "reader").split(";")[0] ?? "";
  const paths = [
    ...["holdout-scenarios.json", "verify-1.json"].map((name) => `/api/runs/${run.id}/artifacts/${name}`),
    `/api/runs/${run.id}`,
    `/api/runs/${run.id}/events`,
    "/api/runs",
    "/api/feed",
    "/api/chat/private",
    "/api/github/access",
    "/api/stream",
    `/api/runs/${run.id}/stream`,
    "/api/chat/private/stream",
  ];
  for (const path of paths) {
    for (const headers of [{}, credential(), { cookie }] as Record<string, string>[]) {
      const abort = new AbortController();
      try {
        const res = await fetch(`${base}${path}`, { headers, signal: abort.signal });
        expect([path, res.status]).toEqual([path, Object.keys(headers).length ? 200 : 401]);
        if (path.includes("/artifacts/") && res.ok) expect(await res.json()).toEqual({ hidden: "scenario" });
        else if (!path.endsWith("/stream")) await res.text();
      } finally {
        abort.abort();
      }
    }
  }
  for (const path of ["/", "/unknown", "/assets.js", `/runs/${run.id}?tab=diff`]) {
    const res = await fetch(`${base}${path}`, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?next=${encodeURIComponent(path)}`);
  }
  for (const path of ["/api/health", "/login", "/enroll", "/api/auth/session"])
    expect((await fetch(`${base}${path}`)).status).toBe(200);
  for (const method of ["HEAD", "OPTIONS", "POST"])
    expect((await fetch(`${base}/api/health`, { method })).status).toBe(401);
  f.factory.cfg.requireApiToken = false;
  try {
    expect((await fetch(`${base}/api/runs/${run.id}`)).status).toBe(200);
  } finally {
    f.factory.cfg.requireApiToken = true;
  }
});

test("logout-all always needs credentials and anonymous logout revokes only its caller", async () => {
  const auth = new Auth(f.factory.store, f.factory.cfg);
  for (const enforcement of [false, true]) {
    f.factory.cfg.requireApiToken = enforcement;
    try {
      for (const useToken of [false, true]) {
        f.factory.store.revokeAuthSessions();
        const cookie = auth.signIn("password", "owner").split(";")[0] ?? "";
        const another = auth.signIn("passkey", "owner-2").split(";")[0] ?? "";
        expect((await post("/api/auth/logout-all")).status).toBe(401);
        expect((await post("/api/auth/logout")).status).toBe(200);
        expect((await post("/api/admin/drain", { cookie })).status).toBe(200);
        expect(auth.session(new Headers({ cookie: another }))).not.toBeNull();
        const revoked = await post("/api/auth/logout-all", useToken ? credential() : { cookie });
        expect(revoked.status).toBe(200);
        expect(await revoked.json()).toEqual({ revoked: 2 });
        expect(auth.session(new Headers({ cookie }))).toBeNull();
        expect(auth.session(new Headers({ cookie: another }))).toBeNull();
        if (enforcement) expect((await post("/api/admin/drain", { cookie })).status).toBe(401);
      }
    } finally {
      f.factory.cfg.requireApiToken = true;
    }
  }
});

test("loopback password sign-in authorizes the UI and mutations under enforcement", async () => {
  const auth = new Auth(f.factory.store, f.factory.cfg);
  await auth.setPassword("correct horse battery");
  expect(await (await fetch(`${base}/api/auth/session`)).json()).toEqual({ session: null });
  expect(await (await fetch(`${base}/login`)).text()).toContain('<form method="post" action="/login">');
  const res = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "correct horse battery", next: "/" }),
  });
  expect(res.status).toBe(303);
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).not.toBe("");
  expect((await post("/api/admin/drain", { cookie })).status).toBe(200);
  expect(await (await fetch(`${base}/`, { headers: { cookie } })).text()).toBe("owner UI");
});

test("token and loopback sessions authorize; bad credentials never fall back", async () => {
  const cookie = new Auth(f.factory.store, f.factory.cfg).signIn("password", "test").split(";")[0] ?? "";
  try {
    for (const enforcement of [true, false]) {
      f.factory.cfg.requireApiToken = enforcement;
      for (const headers of [credential(), { cookie }])
        expect((await post("/api/admin/drain", headers)).status).toBe(200);
      for (const authorization of ["Bearer wrong", "Bearer", "Bearer ", `Bearer ${token} extra`]) {
        expect((await post("/api/admin/drain", { authorization, cookie })).status).toBe(401);
        expect((await fetch(`${base}/api/health`, { headers: { authorization } })).status).toBe(401);
      }
      expect((await post("/api/admin/drain")).status).toBe(enforcement ? 401 : 200);
      expect((await post("/api/admin/drain", { authorization: "Basic abc" })).status).toBe(
        enforcement ? 401 : 200,
      );
      expect((await post("/api/admin/drain", { authorization: "Basic abc", cookie })).status).toBe(200);
      expect((await fetch(`${base}/api/health`, { headers: { authorization: "Basic abc" } })).status).toBe(
        200,
      );
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
  server = await startHttp(f.factory, { routes: { "/mcp": () => new Response("ok") } });
  base = `http://127.0.0.1:${server.port}`;
  const next = readFileSync(tokenPath(), "utf8");
  expect(next).not.toBe(token);
  expect(next).not.toBe(rotated.token);
  token = next;
});

test("startup protects a not-yet-published token before resuming queued land checks", async () => {
  const startup = await fixture();
  startup.factory.cfg.port = 0;
  startup.factory.cfg.githubPoll = false;
  const path = join(startup.factory.cfg.paths.home, "api-token");
  const scratch = join(startup.home, "scratch", SCRATCH_NAME);
  mkdirSync(scratch, { recursive: true });
  startup.factory.store.createLandEntry({
    runId: "queued",
    repo: "test/repo",
    prUrl: "https://github.com/test/repo/pull/1",
    baseBranch: "main",
    headBranch: "pr-1",
    approvedSha: "a".repeat(40),
  });
  const observations: string[] = [];
  const land = spyOn(startup.factory.land, "start").mockImplementation(() => {
    expect(startup.factory.land.list()[0]?.state).toBe("queued");
    expect(privateReadPaths()).toContain(path);
    observations.push(seatbeltProfile(writeRoots(startup.repo, scratch)));
    expect(() => readFileSync(path)).toThrow();
  });
  const start = spyOn(startup.factory, "start").mockImplementation(() => {
    expect(privateReadPaths()).toContain(path);
    expect(readFileSync(path, "utf8")).toMatch(/^[a-f0-9]{64}$/);
  });
  let running: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    running = await startDaemon(startup.factory, {}, (factory) =>
      mountIntegrations(factory, {
        toolVersions: async () => [],
        gh: async () => {},
        prClient: async () => null,
      }),
    );
    expect(land).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(observations[0]).toContain(`(subpath "${path}")`);
  } finally {
    await running?.integrations.stop();
    await running?.server.stop(true);
    land.mockRestore();
    start.mockRestore();
    await startup.close();
  }
  expect(privateReadPaths()).not.toContain(path);
});

for (const failedStep of ["mount", "first bind", "second bind"] as const) {
  test(`failed ${failedStep} waits for all integration cleanup before releasing token protection`, async () => {
    const startup = await fixture();
    startup.factory.cfg.port = 0;
    startup.factory.cfg.githubPoll = true;
    startup.factory.cfg.listenLan = failedStep === "second bind" ? "192.0.2.1" : null;
    const path = join(startup.factory.cfg.paths.home, "api-token");
    writeFileSync(path, "prior token", { mode: 0o600 });
    const scratch = join(startup.home, "scratch", SCRATCH_NAME);
    mkdirSync(scratch, { recursive: true });
    const repo = startup.factory.store.upsertRepo({
      slug: "test/repo",
      kind: "github",
      url: "unused",
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "pr",
    });
    const run = startup.factory.store.createRun(repo, { repo: repo.slug, prompt: "tracked PR" });
    startup.factory.store.updateRun(run.id, {
      status: "succeeded",
      prUrl: "https://github.com/test/repo/pull/1",
    });
    const intervals = spyOn(globalThis, "setInterval");
    const clearIntervals = spyOn(globalThis, "clearInterval");
    const timers = spyOn(globalThis, "setTimeout");
    const clearTimers = spyOn(globalThis, "clearTimeout");
    const unsubscriptions: ReturnType<typeof mock>[] = [];
    const subscribe = startup.factory.store.subscribe.bind(startup.factory.store);
    const subscriptions = spyOn(startup.factory.store, "subscribe").mockImplementation((listener) => {
      const unsubscribe = mock(subscribe(listener));
      unsubscriptions.push(unsubscribe);
      return unsubscribe;
    });
    const landStart = spyOn(startup.factory.land, "start");
    const landStop = startup.factory.land.stop.bind(startup.factory.land);
    const stopping = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const stopped = spyOn(startup.factory.land, "stop").mockImplementation(async () => {
      await landStop();
      stopping.resolve();
      await finish.promise;
      // A failed cleanup must not replace the startup error or skip the other cleanups.
      throw new Error("injected cleanup failure");
    });
    const factoryStart = spyOn(startup.factory, "start");
    const listenerStop = mock(() => Promise.resolve());
    const failure = new Error(`injected ${failedStep} failure`);
    let binds = 0;
    const serve = (() => {
      if (++binds === (failedStep === "second bind" ? 2 : 1)) throw failure;
      return { stop: listenerStop };
    }) as unknown as typeof Bun.serve<undefined>;
    let integrations: Awaited<ReturnType<typeof mountIntegrations>> | undefined;
    const result = startDaemon(
      startup.factory,
      {},
      async (factory) => {
        integrations = await mountIntegrations(factory, {
          toolVersions: async () => {
            expect(landStart).toHaveBeenCalledTimes(1);
            if (failedStep === "mount") throw failure;
            return [];
          },
          gh: async () => {},
          prClient: async () => null,
          github: async () => ({ status: 200, headers: new Headers(), body: {} }),
        });
        return integrations;
      },
      serve,
    ).catch((error: unknown) => error);
    try {
      await Promise.race([
        stopping.promise,
        result.then(() => {
          throw new Error("startup finished without waiting for integration cleanup");
        }),
      ]);
      expect(privateReadPaths()).toContain(path);
      expect(seatbeltProfile(writeRoots(startup.repo, scratch))).toContain(`(subpath "${path}")`);
      expect(readFileSync(path, "utf8")).toBe("prior token");
      expect(intervals).toHaveBeenCalledTimes(1);
      expect(timers).toHaveBeenCalled();
      for (const interval of intervals.mock.results)
        expect(clearIntervals).toHaveBeenCalledWith(interval.value);
      for (const timer of timers.mock.results) expect(clearTimers).toHaveBeenCalledWith(timer.value);
      expect(unsubscriptions).toHaveLength(2);
      for (const unsubscribe of unsubscriptions) expect(unsubscribe).toHaveBeenCalledTimes(1);
      finish.resolve();
      expect(await result).toBe(failure);
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(factoryStart).not.toHaveBeenCalled();
      expect(privateReadPaths()).not.toContain(path);
      expect(readFileSync(path, "utf8")).toBe("prior token");
      if (failedStep === "second bind") expect(listenerStop).toHaveBeenCalledWith(true);
      if (integrations) {
        const mcp = integrations.routes["/mcp"];
        if (!mcp) throw new Error("missing MCP route");
        expect((await mcp(new Request("http://127.0.0.1/mcp", { method: "POST" }), localServer)).status).toBe(
          503,
        );
      }
    } finally {
      finish.resolve();
      await result;
      // Also release test-owned resources if a regression interrupts startup before cleanup.
      for (const interval of intervals.mock.results)
        clearInterval(interval.value as ReturnType<typeof setInterval>);
      for (const timer of timers.mock.results) clearTimeout(timer.value as ReturnType<typeof setTimeout>);
      for (const unsubscribe of unsubscriptions) unsubscribe();
      intervals.mockRestore();
      clearIntervals.mockRestore();
      timers.mockRestore();
      clearTimers.mockRestore();
      subscriptions.mockRestore();
      landStart.mockRestore();
      stopped.mockRestore();
      factoryStart.mockRestore();
      await startup.close();
    }
  });
}

for (const owner of ["startHttp", "startDaemon"] as const) {
  test(`${owner} waits for a delayed listener stop after second-bind failure`, async () => {
    const startup = await fixture();
    startup.factory.cfg.port = 0;
    startup.factory.cfg.listenLan = "192.0.2.1";
    const path = join(startup.factory.cfg.paths.home, "api-token");
    const scratch = join(startup.home, "scratch", SCRATCH_NAME);
    mkdirSync(scratch, { recursive: true });
    const stopping = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const failure = new Error("injected second-bind failure");
    const integrationStop = mock(async () => {});
    const factoryStart = spyOn(startup.factory, "start").mockImplementation(() => {});
    let listener: Server<undefined> | undefined;
    let closeListener: (() => Promise<void>) | undefined;
    const serve = ((options: Parameters<typeof Bun.serve<undefined>>[0]) => {
      if (listener) throw failure;
      listener = Bun.serve(options);
      const stop = listener.stop.bind(listener);
      closeListener = () => stop(true);
      listener.stop = async (force) => {
        stopping.resolve();
        await finish.promise;
        await stop(force);
      };
      return listener;
    }) as typeof Bun.serve<undefined>;
    let settled = false;
    const result = (
      owner === "startHttp"
        ? startHttp(startup.factory, {}, serve)
        : startDaemon(
            startup.factory,
            {},
            async () => ({ routes: {}, notes: [], stop: integrationStop }),
            serve,
          )
    ).then(
      () => {
        settled = true;
        throw new Error("startup unexpectedly succeeded");
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await stopping.promise;
      if (!listener) throw new Error("first listener did not bind");
      const url = new URL("/api/health", listener.url);
      const health = await fetch(url);
      expect(health.status).toBe(200);
      await health.text();
      expect(settled).toBe(false);
      expect(privateReadPaths()).toContain(path);
      expect(seatbeltProfile(writeRoots(startup.repo, scratch))).toContain(`(subpath "${path}")`);
      finish.resolve();
      expect(await result).toBe(failure);
      await expect(fetch(url)).rejects.toThrow();
      expect(privateReadPaths()).not.toContain(path);
      expect(factoryStart).not.toHaveBeenCalled();
      expect(integrationStop).toHaveBeenCalledTimes(owner === "startDaemon" ? 1 : 0);
    } finally {
      finish.resolve();
      await result;
      await closeListener?.();
      factoryStart.mockRestore();
      await startup.close();
    }
  });
}

test("failed binds never replace the running daemon's token or leak private path registrations", async () => {
  const before = readFileSync(tokenPath());
  const paths = privateReadPaths();
  const previous = process.env.LIMITLESS_HOME;
  process.env.LIMITLESS_HOME = f.factory.cfg.paths.home;
  const lanBefore = f.factory.cfg.listenLan;
  try {
    for (const failedBind of [1, 2]) {
      let calls = 0;
      f.factory.cfg.listenLan = failedBind === 2 ? "192.0.2.1" : null;
      const stop = spyOn({ stop: () => Promise.resolve() }, "stop");
      const bind = (() => {
        if (++calls === failedBind) throw new Error("injected bind failure");
        return { stop };
      }) as unknown as typeof Bun.serve<undefined>;
      await expect(startHttp(f.factory, {}, bind)).rejects.toThrow("injected bind failure");
      expect(readFileSync(tokenPath())).toEqual(before);
      expect(privateReadPaths()).toEqual(paths);
      if (failedBind === 2) expect(stop).toHaveBeenCalledWith(true);
      expect((await fetch(`${base}/api/runs`, { headers: apiTokenHeaders() })).status).toBe(200);
      const lease = localLeaseClient(daemonPort());
      const held = await lease({ name: "failed-second-start" }, new AbortController().signal);
      expect(held.acquired).toBe(true);
      await lease({ id: held.id, release: true }, new AbortController().signal);
    }
    // Refcounts, not just membership: stopping the owner must remove the final registration.
    await server.stop(true);
    expect(privateReadPaths()).not.toContain(tokenPath());
    f.factory.cfg.listenLan = lanBefore;
    server = await startHttp(f.factory);
    base = `http://127.0.0.1:${server.port}`;
    token = readFileSync(tokenPath(), "utf8");
  } finally {
    f.factory.cfg.listenLan = lanBefore;
    if (previous === undefined) delete process.env.LIMITLESS_HOME;
    else process.env.LIMITLESS_HOME = previous;
  }
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
      expect(
        resultValue<{ id: string }>(
          await proxy.client.callTool({ name: "limitless_get_run", arguments: { id: run.id } }),
        ).id,
      ).toBe(run.id);
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
      server = await startHttp(f.factory);
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

test("clients preserve daemon authentication errors, and doctor sends the token for access reads", async () => {
  const message = "API token required: update the limitless CLI";
  const accessHeaders: (string | null)[] = [];
  const stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/health") return Response.json({ ok: true, sha: "test" });
      if (path === "/api/github/access") {
        accessHeaders.push(req.headers.get("authorization"));
        return Response.json([]);
      }
      if (path.endsWith("/events")) return Response.json([]);
      if (path === "/api/runs" && req.method === "POST")
        return Response.json({ id: "test", repoSlug: "test/repo", status: "queued" });
      return Response.json({ error: message }, { status: 401 });
    },
  });
  const port = stub.port;
  if (!port) throw new Error("stub has no port");
  try {
    const signal = new AbortController().signal;
    await expect(localLeaseClient(port)({ name: "test" }, signal)).rejects.toThrow(`HTTP 401: ${message}`);
    await expect(localDeployClient(port).admin("drain", signal)).rejects.toThrow(`HTTP 401: ${message}`);
    const cli = await sh(
      [
        process.execPath,
        join(import.meta.dir, "../src/cli/main.ts"),
        "run",
        "test",
        "--repo",
        "test/repo",
        "-f",
      ],
      {
        cwd: f.repo,
        env: { ...process.env, LIMITLESS_URL: `http://127.0.0.1:${stub.port}` },
        allowFail: true,
      },
    );
    expect(cli.exitCode).not.toBe(0);
    expect(cli.stderr).toContain(`401: ${message}`);
    const deps = setupDeps({ home: f.factory.cfg.paths.home, configDir: f.factory.cfg.paths.configDir });
    await doctor({
      ...deps,
      url: `http://127.0.0.1:${stub.port}`,
      run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
      readJson: async () => null,
    });
    expect(accessHeaders).toEqual([`Bearer ${token}`]);
  } finally {
    await stub.stop(true);
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
