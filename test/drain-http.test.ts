import { expect, test } from "bun:test";
import type { Server } from "bun";
import type { HealthResponse } from "../src/core/types.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";

test("admin drain uses real loopback peers and existing mutation protections", async () => {
  const f = await fixture();
  try {
    const routes = createHttpRoutes(f.factory);
    const drain = (routes["/api/admin/drain"] as { POST: Route }).POST;
    const resume = (routes["/api/admin/resume"] as { POST: Route }).POST;
    const health = routes["/api/health"] as Route;
    const request = (headers: Record<string, string> = { "content-type": "application/json" }) =>
      requestWithParams("http://localhost:7400/api/admin/drain", { method: "POST", headers });
    const peer = (address: string | null) =>
      ({ requestIP: () => (address ? { address } : null) }) as unknown as Server<undefined>;
    expect((routes["/api/admin/drain"] as { GET?: Route }).GET).toBeUndefined();
    const read = async () =>
      (await (
        await health(requestWithParams("http://localhost/api/health"), localServer)
      ).json()) as HealthResponse;
    expect(await read()).toMatchObject({ ok: true, draining: false, active: [] });
    expect(typeof (await read()).uptimeMs).toBe("number");
    for (const address of [
      "127.0.0.1",
      "127.2.3.4",
      "::1",
      "0:0:0:0:0:0:0:1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:127.0.0.1",
    ]) {
      expect((await drain(request(), peer(address))).status).toBe(200);
      expect((await drain(request(), peer(address))).status).toBe(200);
      expect((await read()).draining).toBe(true);
      expect((await resume(request(), peer(address))).status).toBe(200);
      expect((await resume(request(), peer(address))).status).toBe(200);
    }
    for (const action of [drain, resume]) {
      for (const address of [null, "192.168.1.1", "::ffff:192.168.1.1", "::2", "garbage"]) {
        expect(
          (
            await action(
              request({
                "content-type": "application/json",
                "x-forwarded-for": "127.0.0.1",
                host: "localhost",
              }),
              peer(address),
            )
          ).status,
        ).toBe(403);
      }
      expect(
        (
          await action(
            request({ "content-type": "application/json", "cf-connecting-ip": "127.0.0.1" }),
            localServer,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await action(
            request({ "content-type": "application/json", origin: "https://evil.example" }),
            localServer,
          )
        ).status,
      ).toBe(403);
      for (const type of [null, "text/plain", "application/jsonp"]) {
        const headers: Record<string, string> = type ? { "content-type": type } : {};
        expect((await action(request(headers), localServer)).status).toBe(415);
      }
    }
    expect((await read()).draining).toBe(false);
    const run = await f.factory.createRun({ repo: f.repo, prompt: "wait" });
    f.factory.store.updateRun(run.id, { status: "running" });
    expect((await read()).active).toEqual([]); // Persisted status is not scheduler membership.
    f.factory.store.updateRun(run.id, { status: "queued" });
    f.factory.scheduler.tick();
    expect((await read()).active).toEqual([run.id]);
    await drain(request(), localServer);
    expect(await read()).toMatchObject({ draining: true, active: [run.id] });
  } finally {
    await f.close();
  }
});
