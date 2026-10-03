import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { createHttpRoutes } from "../src/server/http.ts";
import { fixture, type Route, requestWithParams } from "./mcp-support.ts";

const proxy = "10.0.0.20",
  origin = "https://limitless.example.test",
  password = "correct horse battery";
const DAY = 86_400_000;
let f: Awaited<ReturnType<typeof fixture>>;

beforeAll(async () => {
  f = await fixture();
  f.factory.cfg.trustedProxies = [proxy];
  f.factory.cfg.publicOrigins = [origin];
});
afterAll(() => f.close());

type Call = { method?: string; headers?: Record<string, string>; body?: string; address?: string };
/** Fresh routes (and so a fresh sign-in limiter) over the shared store, called as through the proxy by default. */
function routes() {
  f.factory.store.revokeAuthSessions();
  const table = createHttpRoutes(f.factory, { ui: { "/index.html": new Blob(["<!doctype html>shell"]) } });
  const call = (url: string, { method = "GET", headers = {}, body, address = proxy }: Call = {}) => {
    const path = url.split("?")[0] ?? "";
    const entry = table[path] ?? (path.startsWith("/runs/") ? table["/runs/*"] : table["/*"]);
    const route = typeof entry === "function" ? entry : (entry as Record<string, Route>)[method];
    const peer = { requestIP: () => ({ address }), timeout: () => {} } as unknown as Server<undefined>;
    const init = { method, headers: { host: "limitless.example.test", ...headers }, body };
    return (route as Route)(requestWithParams(`http://localhost:7400${url}`, init), peer);
  };
  const admin = (path: string, input: unknown) =>
    call(path, {
      method: "POST",
      address: "127.0.0.1",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  const signIn = (attempt: string, headers: Record<string, string> = { origin }) =>
    call("/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "TestBrowser/1",
        ...headers,
      },
      body: new URLSearchParams({ username: "limitless", password: attempt, next: "/runs/abc" }).toString(),
    });
  const session = async () => {
    const res = await signIn(password);
    expect(res.status).toBe(303);
    return { cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  return { call, admin, signIn, session };
}

test("loopback needs no session; proxied requests without one get 401 for the API and the login page", async () => {
  const { call } = routes();
  for (const path of ["/api/health", "/runs/abc"])
    expect((await call(path, { address: "127.0.0.1" })).status).toBe(200);
  expect(await (await call("/api/auth/session", { address: "127.0.0.1" })).json()).toEqual({ session: null });
  for (const path of ["/api/health", "/api/stream", "/api/runs/abc/stream", "/api/auth/session"]) {
    const res = await call(path);
    expect([path, res.status, await res.json()]).toEqual([path, 401, { error: "sign-in required" }]);
  }
  const page = await call("/runs/abc?tab=diff");
  expect(page.status).toBe(303);
  const location = page.headers.get("location") ?? "";
  expect(location).toBe("/login?next=%2Fruns%2Fabc%3Ftab%3Ddiff");
  const form = await (await call(location)).text();
  for (const field of [
    'autocomplete="username"',
    'autocomplete="current-password"',
    'value="/runs/abc?tab=diff"',
  ])
    expect(form).toContain(field);
  expect(await (await call("/login?next=//evil.example")).text()).toContain('name="next" value="/"');
  f.factory.cfg.auth = "proxy";
  expect((await call("/api/health")).status).toBe(200);
  f.factory.cfg.auth = "required";
});

test("a password sign-in sets a Strict, Secure, HttpOnly cookie, stored hashed, that the API and SSE accept", async () => {
  const { call, admin, signIn } = routes();
  expect((await signIn(password)).status).toBe(401);
  expect((await admin("/api/admin/auth/password", { password: "too short" })).status).toBe(400);
  expect((await admin("/api/admin/auth/password", { password })).status).toBe(200);
  const viaProxy = { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" };
  expect((await call("/api/admin/auth/password", viaProxy)).status).toBe(403);
  expect((await signIn(password, { origin: "https://evil.example" })).status).toBe(403);
  const res = await signIn(password);
  expect([res.status, res.headers.get("location")]).toEqual([303, "/runs/abc"]);
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(
    /^__Host-limitless-session=[\w-]{43}; Max-Age=15552000; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
  );
  const token = setCookie.slice(setCookie.indexOf("=") + 1, setCookie.indexOf(";"));
  expect(JSON.stringify(f.factory.store.db.query("SELECT * FROM auth_sessions").all())).not.toContain(token);
  const headers = { cookie: `theme=dark; ${setCookie.split(";")[0]}` };
  for (const path of ["/api/health", "/runs/abc"]) expect((await call(path, { headers })).status).toBe(200);
  expect(await (await call("/api/auth/session", { headers })).json()).toMatchObject({
    session: { method: "password", device: "TestBrowser/1" },
  });
  const stream = await call("/api/stream", { headers });
  expect([stream.status, stream.headers.get("content-type")]).toEqual([200, "text/event-stream"]);
  const reader = stream.body?.getReader();
  if (!reader) throw new Error("no SSE body");
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(": connected");
  await f.factory.createRun({ repo: f.repo, prompt: "while signed in" });
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"kind":"run"');
  const listed = await call("/api/admin/auth/sessions", { address: "127.0.0.1" });
  expect(await listed.json()).toMatchObject([{ method: "password", device: "TestBrowser/1" }]);
  f.factory.store.revokeAuthSessions();
  await f.factory.createRun({ repo: f.repo, prompt: "after sign-out" });
  expect((await reader.read()).done).toBe(true);
});

test("revoked, idle and absolutely expired sessions are refused; sign-out ends one or all", async () => {
  const { call, admin, session } = routes();
  await admin("/api/admin/auth/password", { password });
  const allowed = async (headers: Record<string, string>) => (await call("/api/health", { headers })).status;
  const [a, b] = [await session(), await session()];
  const { id } = (await (await call("/api/auth/session", { headers: a })).json()).session;
  expect(await (await admin("/api/admin/auth/sessions/revoke", { id })).json()).toEqual({ revoked: 1 });
  expect([await allowed(a), await allowed(b)]).toEqual([401, 200]);

  const db = f.factory.store.db;
  db.query("UPDATE auth_sessions SET last_seen_at = ?").run(Date.now() - 30 * DAY);
  expect(await allowed(b)).toBe(401);
  expect((await call("/runs/abc", { headers: b })).status).toBe(303);
  const c = await session();
  db.query("UPDATE auth_sessions SET created_at = ?").run(Date.now() - 180 * DAY);
  expect(await allowed(c)).toBe(401);

  const json = { origin, "content-type": "application/json" };
  const [d, e, g] = [await session(), await session(), await session()];
  const out = await call("/api/auth/logout", { method: "POST", headers: { ...d, ...json } });
  expect(out.headers.get("set-cookie")).toStartWith("__Host-limitless-session=; Max-Age=0;");
  expect([await allowed(d), await allowed(e), await allowed(g)]).toEqual([401, 200, 200]);
  expect(
    await (await call("/api/auth/logout-all", { method: "POST", headers: { ...e, ...json } })).json(),
  ).toEqual({
    revoked: 2,
  });
  expect([await allowed(e), await allowed(g)]).toEqual([401, 401]);
});

test("repeated failed sign-ins from one address are refused for a while", async () => {
  const { admin, signIn } = routes();
  await admin("/api/admin/auth/password", { password });
  for (let i = 0; i < 5; i++) expect((await signIn("wrong password")).status).toBe(401);
  const limited = await signIn(password);
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(800);
  expect(limited.headers.get("set-cookie")).toBeNull();
});
