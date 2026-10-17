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

export function waitUntil(check: () => boolean | Promise<boolean>, options: WaitOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const { signal, timeoutMs, subscribe, pollMs = 25 } = options;
    let done = false;
    let checking = false;
    let dirty = false;
    let unsubscribe: (() => void) | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let immediate: ReturnType<typeof setImmediate> | undefined;
    const finish = (failure?: { reason: unknown }) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(deadline);
      clearImmediate(immediate);
      unsubscribe?.();
      signal.removeEventListener("abort", abort);
      if (failure === undefined) resolve();
      else reject(failure.reason);
    };
    const fail = (reason: unknown) => finish({ reason });
    const abort = () => fail(signal.reason);
    const wake = () => {
      if (done) return;
      if (checking) {
        dirty = true;
        return;
      }
      checking = true;
      // Let the publisher's and scheduler's promise chains settle before inspecting their state.
      immediate = setImmediate(() => {
        immediate = undefined;
        if (done) return;
        void Promise.resolve()
          .then(() => (done ? false : check()))
          .then((ready) => {
            checking = false;
            if (done) return;
            if (ready) finish();
            else if (dirty) {
              dirty = false;
              wake();
            }
          }, fail);
      });
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    deadline = setTimeout(() => fail(new Error(options.description ?? "wait timed out")), timeoutMs);
    if (pollMs !== null) poll = setInterval(wake, pollMs);
    try {
      unsubscribe = subscribe?.(wake);
      if (done) unsubscribe?.();
      else wake();
    } catch (error) {
      fail(error);
    }
  });
}
