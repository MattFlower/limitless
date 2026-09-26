import { expect, test } from "bun:test";
import { ensureLiveStore, live } from "../ui/store.ts";

test("shared drain state refreshes initially, while connected, and after reconnect", async () => {
  let draining = true;
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
      return { ok: true, uptimeMs: 1, active: [], draining };
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
  draining = false;
  poll();
  await Promise.resolve();
  expect(live.draining()).toBe(false);
  draining = true;
  poll();
  await Promise.resolve();
  expect(live.draining()).toBe(true);
  fail = true;
  connection(false);
  poll();
  await Promise.resolve();
  expect(live.draining()).toBe(true);
  fail = false;
  draining = false;
  connection(true);
  await Promise.resolve();
  expect(live.draining()).toBe(false);
  expect(live.connected()).toBe(true);
  expect(reads).toBe(5);
});
