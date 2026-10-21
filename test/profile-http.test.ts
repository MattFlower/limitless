import type { SamplingProfileStackFrame } from "bun:jsc";
import * as jsc from "bun:jsc";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { Factory } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db/store.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { registerCredential } from "../src/util/proc.ts";
import { localServer, type Route, requestWithParams } from "./mcp-support.ts";

let home: string;
let factory: Factory;
let route: Route;
const token = "a".repeat(64);
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "limitless-profile-"));
  const cfg = loadConfig({ home, configDir: join(home, "config") });
  cfg.requireApiToken = true;
  factory = new Factory(cfg, { store: new Store(":memory:") });
  route = (createHttpRoutes(factory, { apiToken: token })["/api/admin/profile"] as { POST: Route }).POST;
});
afterAll(async () => {
  await factory.stop();
  factory.store.close();
  rmSync(home, { recursive: true, force: true });
});

const request = (payload: unknown = {}, headers: Record<string, string> = {}) =>
  requestWithParams("http://localhost:7400/api/admin/profile", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(payload),
  });

test("admin profile samples an unrelated named timer callback", async () => {
  const timer = setInterval(function limitlessProfileBusyTimer709() {
    const until = performance.now() + 10;
    while (performance.now() < until) {}
  }, 1);
  try {
    const response = await route(request({ seconds: 0.3 }), localServer);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.seconds).toBe(0.3);
    expect(result.functions).toContain("limitlessProfileBusyTimer709");
    expect(result.stackTraces.split("\n")[0]).toMatch(
      /limitlessProfileBusyTimer709 \([^)]*profile-http\.test\.ts:\d+\)/,
    );
    for (const field of [result.functions, result.stackTraces])
      expect(Buffer.byteLength(field)).toBeLessThanOrEqual(64 * 1024);
  } finally {
    clearInterval(timer);
  }
});

test("admin profile rejects concurrent requests with 409", async () => {
  const started = Promise.withResolvers<void>();
  const server = {
    ...localServer,
    timeout: () => started.resolve(),
  } as unknown as Server<undefined>;
  const pending = route(request({ seconds: 0.2 }), server);
  try {
    await started.promise;
    const other = (createHttpRoutes(factory, { apiToken: token })["/api/admin/profile"] as { POST: Route })
      .POST;
    const response = await other(request({ seconds: 0.2 }), localServer);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "A profile is already running" });
  } finally {
    expect((await pending).status).toBe(200);
  }
});

test("admin profile validates seconds and uses the admin access protections", async () => {
  for (const seconds of [0.19, 120.01, "0.3", null])
    expect((await route(request({ seconds }), localServer)).status).toBe(400);
  expect((await route(request(null), localServer)).status).toBe(400);
  expect((await route(request({}, { authorization: "" }), localServer)).status).toBe(401);
  expect((await route(request({}, { authorization: "Bearer wrong" }), localServer)).status).toBe(401);
  expect((await route(request({}, { "x-forwarded-for": "127.0.0.1" }), localServer)).status).toBe(403);
  expect((await route(request({}, { origin: "https://evil.example" }), localServer)).status).toBe(403);
  expect((await route(request({}, { "content-type": "text/plain" }), localServer)).status).toBe(415);
  const remote = { requestIP: () => ({ address: "192.0.2.1" }) } as unknown as Server<undefined>;
  expect((await route(request(), remote)).status).toBe(403);
});

const frame = (name: string, line = 42): SamplingProfileStackFrame => ({
  sourceID: 1,
  name,
  location: "",
  sourceURL: "file:///example.ts",
  line,
  column: 1,
  category: "Baseline",
  flags: 0,
});

test("admin profile counts stacks by their first eight frames and ranks by frequency", async () => {
  const rare = Array.from({ length: 9 }, (_, i) => frame(`caller${i}`, i + 1));
  const busy = [frame("busy"), frame("")];
  const profiler = spyOn(jsc, "profile").mockReturnValue({
    functions: "",
    bytecodes: "",
    stackTraces: {
      interval: 0.001,
      traces: [rare, busy, busy, [...rare.slice(0, 8), frame("different")], busy].map(
        (frames, timestamp) => ({ timestamp, frames }),
      ),
      sources: [],
    },
  });
  try {
    const response = await route(request({ seconds: 0.2 }), localServer);
    expect(response.status).toBe(200);
    expect((await response.json()).stackTraces).toBe(
      "3  busy (file:///example.ts:42) < <anonymous> (file:///example.ts:42)\n" +
        "2  caller0 (file:///example.ts:1) < caller1 (file:///example.ts:2) < " +
        "caller2 (file:///example.ts:3) < caller3 (file:///example.ts:4) < " +
        "caller4 (file:///example.ts:5) < caller5 (file:///example.ts:6) < " +
        "caller6 (file:///example.ts:7) < caller7 (file:///example.ts:8)",
    );
  } finally {
    profiler.mockRestore();
  }
});

test("admin profile clears failures, defaults seconds, and redacts before capping UTF-8 text", async () => {
  const secret = "profile-test-credential";
  registerCredential("PROFILE_TEST_CREDENTIAL", secret);
  const text = secret + "é".repeat(40_000);
  const profiler = spyOn(jsc, "profile")
    .mockImplementationOnce(() => {
      throw new Error(`profiler failed: ${secret}`);
    })
    .mockReturnValue({
      functions: text,
      bytecodes: "",
      stackTraces: {
        interval: 0.001,
        traces: [{ timestamp: 0, frames: [{ ...frame("busy"), sourceURL: text }] }],
        sources: [],
      },
    });
  const timeout = spyOn(localServer, "timeout");
  try {
    const failure = await route(request(), localServer);
    expect(failure.status).toBe(400);
    expect(await failure.json()).toEqual({ error: "profiler failed: [redacted]" });
    const response = await route(request(), localServer);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.seconds).toBe(30);
    expect(timeout).toHaveBeenCalledWith(expect.any(Request), 0);
    expect(profiler).toHaveBeenCalledWith(expect.any(Function), 1000);
    for (const field of [result.functions, result.stackTraces]) {
      expect(field).not.toContain(secret);
      expect(field).toContain("[redacted]");
      expect(field).not.toContain("�");
      expect(Buffer.byteLength(field)).toBeGreaterThan(64 * 1024 - 4);
      expect(Buffer.byteLength(field)).toBeLessThanOrEqual(64 * 1024);
    }
    for (const seconds of [0.2, 120]) {
      const boundary = await route(request({ seconds }), localServer);
      expect(boundary.status).toBe(200);
      expect((await boundary.json()).seconds).toBe(seconds);
    }
    profiler.mockReturnValue({
      functions: "x".repeat(65_532) + secret,
      bytecodes: "",
      stackTraces: { interval: 0.001, traces: [], sources: [] },
    });
    const capped = await route(request({ seconds: 0.2 }), localServer);
    expect((await capped.json()).functions).toBe(`${"x".repeat(65_532)}[red`);
  } finally {
    profiler.mockRestore();
    timeout.mockRestore();
  }
});
