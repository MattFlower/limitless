import { afterEach, beforeEach } from "bun:test";

interface WaitOptions {
  signal: AbortSignal;
  timeoutMs: number;
  description?: string;
  subscribe?: (wake: () => void) => () => void;
  // Observable conditions need no polling; filesystem and scheduler conditions still do.
  pollMs?: number | null;
}

/** Cancels timers and subscriptions before fixture teardown, including after a Bun timeout. */
export function testWaits() {
  let controller = new AbortController();
  beforeEach(() => {
    controller = new AbortController();
  });
  afterEach(() => controller.abort());
  return {
    get signal() {
      return controller.signal;
    },
    until(check: () => boolean | Promise<boolean>, options: Omit<WaitOptions, "signal">) {
      return waitUntil(check, { ...options, signal: controller.signal });
    },
  };
}

export async function waitUntil(check: () => boolean | Promise<boolean>, options: WaitOptions): Promise<void> {
  const end = Date.now() + options.timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("barrier timed out");
    await Bun.sleep(5);
  }
}
