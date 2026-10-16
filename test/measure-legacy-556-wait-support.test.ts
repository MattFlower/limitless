import { afterEach, describe, expect, mock, test } from "bun:test";
import { testWaits, waitUntil } from "./measure-legacy-556-wait-support.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("aborting a test wait removes its subscription and stops reads before fixture teardown", async () => {
  const controller = new AbortController();
  const read = mock(() => false);
  const unsubscribe = mock(() => {});
  let notify = () => {};
  const pending = waitUntil(read, {
    signal: controller.signal,
    timeoutMs: 1_000,
    subscribe(wake) {
      notify = wake;
      return unsubscribe;
    },
  });
  const rejected = pending.catch((error: unknown) => error);
  await turn();
  expect(read).toHaveBeenCalledTimes(1);
  controller.abort();
  expect(await rejected).toMatchObject({ name: "AbortError" });
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  // Simulate a publication already queued when afterEach aborts and closes the store.
  notify();
  await turn();
  expect(read).toHaveBeenCalledTimes(1);
});

test("a predicate interrupted across an await cannot restart polling after abort", async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<boolean>();
  const read = mock(() => {
    entered.resolve();
    return release.promise;
  });
  const pending = waitUntil(read, { signal: controller.signal, timeoutMs: 1_000 });
  const rejected = pending.catch((error: unknown) => error);
  await entered.promise;
  controller.abort();
  expect(await rejected).toMatchObject({ name: "AbortError" });
  release.resolve(false);
  await turn();
  expect(read).toHaveBeenCalledTimes(1);
});

test("observable waits subscribe before checking and clean up on success or predicate failure", async () => {
  for (const fails of [false, true]) {
    const controller = new AbortController();
    const unsubscribe = mock(() => {});
    let notify = () => {};
    let ready = false;
    const read = mock(() => {
      if (ready && fails) throw new Error("closed store");
      return ready;
    });
    const pending = waitUntil(read, {
      signal: controller.signal,
      timeoutMs: 1_000,
      pollMs: null,
      subscribe(wake) {
        notify = wake;
        return unsubscribe;
      },
    });
    await turn();
    ready = true;
    const result = pending.catch((error: unknown) => error);
    notify();
    if (fails) expect(await result).toMatchObject({ message: "closed store" });
    else await result;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    const reads = read.mock.calls.length;
    notify();
    controller.abort();
    await turn();
    expect(read).toHaveBeenCalledTimes(reads);
  }
});

describe("test wait lifetime", () => {
  const waits = testWaits();
  const read = mock(() => false);
  let result: Promise<unknown>;
  afterEach(async () => {
    expect(await result).toMatchObject({ name: "AbortError" });
    const reads = read.mock.calls.length;
    await turn();
    expect(read).toHaveBeenCalledTimes(reads);
  });
  test("afterEach aborts a pending wait before the fixture can close", async () => {
    const entered = Promise.withResolvers<void>();
    result = waits
      .until(
        () => {
          read();
          entered.resolve();
          return false;
        },
        { timeoutMs: 1_000 },
      )
      .catch((error: unknown) => error);
    await entered.promise;
  });
});
