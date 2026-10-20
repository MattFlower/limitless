import { expect, test } from "bun:test";
import { EventLoopLag } from "../src/server/event-loop-lag.ts";

test("timer lateness starts at zero, stays small on time, and reflects a delayed callback", () => {
  let now = 10_000;
  const lag = new EventLoopLag(() => now);
  expect(lag.maxMs()).toBe(0);
  now = 11_000;
  lag.sample();
  expect(lag.maxMs()).toBe(0);
  now = 12_002;
  lag.sample();
  expect(lag.maxMs()).toBe(2);
  now = 16_502;
  lag.sample();
  expect(lag.maxMs()).toBe(3500);
});

test("a spike expires after a minute, retaining only recent lag samples", () => {
  let now = 0;
  const lag = new EventLoopLag(() => now);
  now = 6000;
  lag.sample();
  expect(lag.maxMs()).toBe(5000);
  for (let i = 0; i < 60; i++) {
    now += 1000;
    lag.sample();
  }
  expect(lag.maxMs()).toBe(5000); // The spike is exactly 60 seconds old.
  now = 66_001;
  expect(lag.maxMs()).toBe(0); // Expiry also works between callbacks.
  now = 67_003;
  lag.sample();
  expect(lag.maxMs()).toBe(3);
  now = 127_004;
  expect(lag.maxMs()).toBe(0);
});

test("early callbacks never produce negative lag", () => {
  let now = 0;
  const lag = new EventLoopLag(() => now);
  now = 999;
  lag.sample();
  expect(lag.maxMs()).toBe(0);
});
