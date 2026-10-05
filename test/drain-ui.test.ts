import { expect, test } from "bun:test";
import type { HealthResponse } from "../src/core/types.ts";
import { ensureLiveStore, live } from "../ui/store.ts";

test("shared drain state refreshes initially, while connected, and after reconnect", async () => {
  let draining = true;
  let gateSlots: HealthResponse["gateSlots"] = { occupied: 1, limit: 2, holders: ["run-a"] };
  let fail = false;
  let poll = () => {};
  let connection = (_connected: boolean) => {};
  let reads = 0;
  ensureLiveStore({
    listRuns: async () => [],
    getProviders: async () => [],
    getAlerts: async () => [],
    getHealth: async () => {
      reads++;
      if (fail) throw new Error("restarting");
      return { ok: true, uptimeMs: 1, sha: "boot-commit", active: [], draining, gateSlots };
    },
    openGlobalStream: (_message, connected) => {
      connection = connected;
      return () => {};
    },
    poll: (fn, ms) => {
      poll = fn;
      expect(ms).toBe(5000);
    },
  });
  await Promise.resolve();
  expect(live.draining()).toBe(true);
  expect(live.gateSlots()).toEqual({ occupied: 1, limit: 2, holders: ["run-a"] });
  gateSlots = { occupied: 2, limit: 2, holders: ["run-a", "deploy"] };
  draining = false;
  poll();
  await Promise.resolve();
  expect(live.draining()).toBe(false);
  expect(live.gateSlots()?.holders).toEqual(["run-a", "deploy"]);
  gateSlots = { occupied: 0, limit: 2, holders: [] };
  draining = true;
  poll();
  await Promise.resolve();
  expect(live.draining()).toBe(true);
  expect(live.gateSlots()?.occupied).toBe(0);
  fail = true;
  connection(false);
  poll();
  await Promise.resolve();
  expect(live.draining()).toBe(true);
  fail = false;
  gateSlots = undefined;
  draining = false;
  connection(true);
  await Promise.resolve();
  expect(live.draining()).toBe(false);
  expect(live.connected()).toBe(true);
  expect(reads).toBe(5);
  expect(live.gateSlots()).toBeUndefined();
});
