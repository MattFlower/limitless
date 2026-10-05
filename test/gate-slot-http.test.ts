import { expect, spyOn, test } from "bun:test";
import type { Server } from "bun";
import type { HealthResponse } from "../src/core/types.ts";
import { gateSlots, Semaphore } from "../src/gates/slots.ts";
import { createHttpRoutes } from "../src/server/http.ts";
import { fixture, localServer, type Route, requestWithParams } from "./mcp-support.ts";
import { waitClock } from "./wait-clock.ts";

test("gate leases share health occupancy and admin mutation protections", async () => {
  const f = await fixture("lease-test");
  const limit = gateSlots.limit;
  gateSlots.setLimit(1);
  const ids: string[] = [];
  let release = () => {};
  try {
    const routes = createHttpRoutes(f.factory);
    const route = (routes["/api/admin/gate-slot"] as { POST: Route }).POST;
    const health = routes["/api/health"] as Route;
    const read = async () =>
      (await (
        await health(requestWithParams("http://localhost/api/health"), localServer)
      ).json()) as HealthResponse;
    const request = (
      body: unknown,
      headers: Record<string, string> = { "content-type": "application/json" },
    ) =>
      requestWithParams("http://localhost:7400/api/admin/gate-slot", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const peer = (address: string | null) =>
      ({ requestIP: () => (address ? { address } : null) }) as unknown as Server<undefined>;
    const create = await route(request({ name: "deploy" }), localServer);
    expect(create.status).toBe(200);
    const first = (await create.json()) as { id: string; acquired: boolean };
    ids.push(first.id);
    expect(first.acquired).toBe(true);
    expect(await read()).toMatchObject({ gateSlots: { occupied: 1, limit: 1, holders: ["deploy"] } });
    expect(JSON.stringify((await read()).gateSlots)).not.toContain(first.id);
    for (const body of [{ name: "bad" }, { id: first.id }, { id: first.id, release: true }]) {
      for (const address of [null, "192.168.1.2", "::2"]) {
        expect((await route(request(body), peer(address))).status).toBe(403);
      }
      const forwarded: Record<string, string>[] = [
        { "x-forwarded-for": "127.0.0.1" },
        { forwarded: "for=127.0.0.1" },
        { "cf-connecting-ip": "127.0.0.1" },
        { origin: "https://evil.example" },
      ];
      for (const headers of forwarded) {
        expect(
          (await route(request(body, { "content-type": "application/json", ...headers }), localServer))
            .status,
        ).toBe(403);
      }
      expect((await route(request(body, { "content-type": "text/plain" }), localServer)).status).toBe(415);
      expect((await read()).gateSlots?.holders).toEqual(["deploy"]);
    }
    for (const body of [{}, { name: 3 }, { name: "" }, { id: 3 }, { id: first.id, release: "yes" }]) {
      expect((await route(request(body), localServer)).status).toBe(400);
    }
    const abort = new AbortController();
    abort.abort();
    const cancelled = requestWithParams("http://localhost:7400/api/admin/gate-slot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "cancelled" }),
      signal: abort.signal,
    });
    expect((await route(cancelled, localServer)).status).toBe(400);
    expect((await read()).gateSlots?.holders).toEqual(["deploy"]);
    const waiting = gateSlots.acquire(new AbortController().signal, undefined, "run-a");
    const queued = (await (
      await route(request({ name: "land-pr #289" }), localServer)
    ).json()) as typeof first;
    ids.push(queued.id);
    expect(queued.acquired).toBe(false);
    expect((await read()).gateSlots?.holders).toEqual(["deploy"]);
    for (let i = 0; i < 2; i++)
      expect((await route(request({ id: first.id, release: true }), localServer)).status).toBe(200);
    release = await waiting;
    expect((await read()).gateSlots?.holders).toEqual(["run-a"]);
    release();
    await Promise.resolve();
    expect((await read()).gateSlots?.holders).toEqual(["land-pr #289"]);
    expect(await (await route(request({ id: first.id }), localServer)).json()).toMatchObject({
      expired: true,
      acquired: false,
    });
    await route(request({ id: queued.id, release: true }), localServer);
    expect((await read()).gateSlots?.occupied).toBe(0);
    const time = waitClock();
    const expiring = await gateSlots.lease("expiring", false, time.timer.set, time.timer.clear);
    ids.push(expiring);
    expect((await read()).gateSlots?.holders).toEqual(["expiring"]);
    await time.advance(30_000);
    expect((await read()).gateSlots?.occupied).toBe(0);
    expect(gateSlots.heartbeat(expiring)).toBeUndefined();
    expect(time.pending).toBe(0);
  } finally {
    release();
    for (const id of ids) gateSlots.heartbeat(id, true);
    gateSlots.setLimit(limit);
    await f.close();
  }
});

test("the gate-slot route counts running registrations above the cap and rejects invalid flags", async () => {
  const f = await fixture("lease-recovery-test"),
    time = waitClock(),
    slots = new Semaphore(1);
  const lease = spyOn(gateSlots, "lease").mockImplementation((name, immediate, _timer, _clear, running) =>
    slots.lease(name, immediate, time.timer.set, time.timer.clear, running),
  );
  const heartbeat = spyOn(gateSlots, "heartbeat").mockImplementation((id, release) =>
    slots.heartbeat(id, release),
  );
  const release = await slots.acquire(new AbortController().signal, undefined, "new-run");
  const ids: string[] = [];
  try {
    const route = (createHttpRoutes(f.factory)["/api/admin/gate-slot"] as { POST: Route }).POST;
    const request = (body: unknown) =>
      route(
        requestWithParams("http://localhost:7400/api/admin/gate-slot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        localServer,
      );
    expect((await request({ name: "survivor", running: "true" })).status).toBe(400);
    const survivor = (await (await request({ name: "survivor", running: true })).json()) as {
      id: string;
      acquired: boolean;
    };
    ids.push(survivor.id);
    expect(survivor.acquired).toBe(true);
    expect(slots.snapshot()).toEqual({ occupied: 2, limit: 1, holders: ["new-run", "survivor"] });
    const waiter = (await (await request({ name: "waiting" })).json()) as typeof survivor;
    ids.push(waiter.id);
    expect(waiter.acquired).toBe(false);
    await request({ id: survivor.id, release: true });
    expect(await (await request({ id: waiter.id })).json()).toMatchObject({ acquired: false });
    release();
    await time.flush();
    expect(await (await request({ id: waiter.id })).json()).toMatchObject({ acquired: true });
  } finally {
    release();
    for (const id of ids) slots.heartbeat(id, true);
    lease.mockRestore();
    heartbeat.mockRestore();
    await f.close();
  }
  expect(time.pending).toBe(0);
});
