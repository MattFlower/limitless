import { expect, spyOn, test } from "bun:test";
import * as b from "../src/util/privacy-boundary.ts";
import {
  createPrivacyChecker,
  type PrivacyWorkerPort,
  privacyWorkerHandler,
} from "../src/util/privacy-checker.ts";
import { privacyTexts } from "./privacy-support.ts";
import { waitClock } from "./wait-clock.ts";

const input = (text = "safe") => ({ text, provenance: { kind: "complete" } as const });
type Message = {
  id: number;
  version: number;
  sequence: number;
  generation: object;
  result: object;
  type: string;
};
class Port implements PrivacyWorkerPort {
  onmessage?: PrivacyWorkerPort["onmessage"];
  onerror?: PrivacyWorkerPort["onerror"];
  onexit?: PrivacyWorkerPort["onexit"];
  sent: unknown[] = [];
  refs: boolean[] = [];
  terminated = 0;
  held = false;
  retirement = Promise.withResolvers<void>();
  postMessage(value: unknown) {
    this.sent.push(structuredClone(value));
  }
  ref() {
    this.refs.push(true);
  }
  unref() {
    this.refs.push(false);
  }
  terminate() {
    this.terminated++;
    return this.held ? this.retirement.promise : Promise.resolve();
  }
  emit(data: unknown) {
    this.onmessage?.({ data: structuredClone(data) });
  }
  response(index = this.sent.length - 1): Message {
    let result: unknown;
    const side = {
      postMessage: (value: unknown) => {
        result = value;
      },
      onmessage: undefined as PrivacyWorkerPort["onmessage"],
    };
    privacyWorkerHandler(side);
    side.onmessage?.({ data: this.sent[index] });
    return structuredClone(result) as Message;
  }
  reply() {
    this.emit(this.response());
  }
}
type Options = NonNullable<Parameters<typeof createPrivacyChecker>[0]>;
function fixture(options: Options = {}) {
  const clock = waitClock();
  const ports: Port[] = [];
  const registry = options.registry ?? b.createPrivacyRegistry();
  const checker = createPrivacyChecker({
    registry,
    now: clock.now,
    setTimeout: clock.timer.set,
    clearTimeout: clock.timer.clear,
    workerFactory: () => {
      const p = new Port();
      ports.push(p);
      return p;
    },
    ...options,
  });
  const port = () => {
    const p = ports.at(-1);
    if (!p) throw new Error("No fake worker");
    return p;
  };
  return {
    ...checker,
    clock,
    ports,
    port,
    registry,
    send: (text = "safe", signal?: AbortSignal) => checker.protectText(input(text), { signal }),
  };
}
const read = b.consumeBoundaryText;
async function withheld(value: Promise<b.BoundaryText>, reason: string) {
  expect(read(await value)).toMatchObject({ text: "[withheld: private text]", withheld: true, reason });
}

test("worker operation equals synchronous projections", async () => {
  const f = fixture();
  const host = privacyTexts[0] ?? "synthetic.example";
  f.registry.replacePolicy([{ value: host, entry: 0 }]);
  f.registry.addCredential("ab");
  const policy = b.preparePrivacyPolicy(b.capturePrivacySnapshot(f.registry));
  const cases = [
    input(),
    input(host),
    input("ab"),
    { ...input("safe\x1b[31m text"), terminal: true },
    { ...input("safe tail"), cut: { unit: "U" as const, limit: 4 } },
  ];
  for (const value of cases) {
    const result = f.protectText(value);
    await f.clock.flush();
    f.port().reply();
    expect(read(await result)).toEqual(read(b.protectText({ ...value, policy }, { registry: f.registry })));
    expect(Object.keys(await result)).toEqual([]);
  }
  const jsons = [JSON.stringify({ [host]: 1 }), '{"ab":1}', '["ab","safe"]', '["alpha", "beta", "safe"]'];
  for (const json of jsons) {
    const value = { json, provenance: input().provenance };
    const result = f.protectData(value);
    await f.clock.flush();
    f.port().reply();
    expect(read(await result)).toEqual(read(b.protectData({ ...value, policy }, { registry: f.registry })));
  }
  expect(f.ports).toHaveLength(1);
  expect(f.port().refs.at(-1)).toBe(false);
  expect(f.clock.pending).toBe(0);
  await f.dispose();
});

test.each(["policy", "credentials", "checker", "identity"])(
  "generation %s is checked at response, dispatch and consumption",
  async (kind) => {
    let label = "v1";
    const registry = b.createPrivacyRegistry(undefined, () => label);
    const f = fixture({ registry });
    const a = f.send(),
      queued = f.send();
    await f.clock.flush();
    const response = f.port().response();
    if (kind === "policy") registry.replacePolicy([]);
    if (kind === "credentials") registry.addCredential("new-synthetic-secret");
    if (kind === "checker") label = "v2";
    if (kind === "identity")
      Object.defineProperty(registry, "generation", { get: () => b.createPrivacyRegistry().generation });
    f.port().emit(response);
    await withheld(a, "stale-generation");
    await withheld(queued, "stale-generation");
    expect(f.port().sent).toHaveLength(1);
    expect(f.ports).toHaveLength(1);
    await f.dispose();
    const later = fixture();
    const good = later.send();
    await later.clock.flush();
    later.port().reply();
    const receipt = await good;
    expect(read(receipt).withheld).toBe(false);
    later.registry.addCredential("later-synthetic-secret");
    expect(read(receipt).reason).toBe("stale-generation");
    await later.dispose();
  },
);

test.each(["version", "sequence", "generation", "shape", "partial", "missing-id"])(
  "protocol fault: %s withholds and retires",
  async (fault) => {
    const f = fixture({ maxRequests: 1, byteLimit: 4 });
    const result = f.send();
    await f.clock.flush();
    const message: Record<string, unknown> = { ...f.port().response() };
    if (fault === "version") message.version = 2;
    if (fault === "sequence") message.sequence = 2;
    if (fault === "generation") message.generation = { policy: -1, credentials: 0, checker: 0 };
    if (fault === "shape") message.result = { text: "unvalidated partial" };
    if (fault === "partial") message.type = "partial";
    if (fault === "missing-id") delete message.id;
    f.port().emit(message);
    await withheld(result, "checker-failed");
    expect(f.port().terminated).toBe(1);
    const next = f.send();
    await f.clock.flush();
    f.port().reply();
    expect(read(await next).withheld).toBe(false);
    await f.dispose();
  },
);

test("wrong and late IDs do not settle other requests, idle workers are unref'd", async () => {
  const f = fixture();
  expect(f.ports).toHaveLength(0);
  const a = f.send();
  await f.clock.flush();
  expect(f.port().refs).toEqual([false, true]);
  const response = f.port().response();
  let settled = 0;
  void a.then(() => settled++);
  f.port().emit({ ...response, id: -1 });
  await f.clock.flush();
  expect(settled).toBe(0);
  f.port().emit(response);
  await a;
  expect(f.port().refs.at(-1)).toBe(false);
  const next = f.send();
  await f.clock.flush();
  f.port().emit(response);
  await f.clock.flush();
  expect(settled).toBe(1);
  expect(f.clock.pending).toBe(1);
  f.port().reply();
  expect(read(await next).withheld).toBe(false);
  await f.dispose();
});

test("eight count slots and UTF-8 byte reservations include queued work and are released", async () => {
  const f = fixture();
  const admitted = Array.from({ length: 8 }, () => f.send());
  await withheld(f.send(), "checker-busy");
  await f.clock.flush();
  for (const result of admitted) {
    f.port().reply();
    expect(read(await result).withheld).toBe(false);
    await f.clock.flush();
  }
  expect(f.clock.pending).toBe(0);
  await f.dispose();
  const small = fixture({ byteLimit: 4 });
  const first = small.send("é"),
    second = small.send("é");
  await withheld(small.send("x"), "checker-busy");
  await small.clock.flush();
  small.port().reply();
  await first;
  await small.clock.flush();
  const reused = small.send("é");
  small.port().reply();
  await second;
  await small.clock.flush();
  small.port().reply();
  expect(read(await reused).withheld).toBe(false);
  await small.dispose();
});

test.each(["timeout", "cancel"])(
  "active %s waits for retirement; queued work has its own deadline",
  async (mode) => {
    const f = fixture({ byteLimit: 8 });
    const controller = new AbortController();
    const a = f.send("safe", controller.signal);
    await f.clock.flush();
    const old = f.port(),
      late = old.response();
    old.held = true;
    await f.clock.advance(10000);
    const queued = f.send();
    if (mode === "timeout") await f.clock.advance(20000);
    else controller.abort();
    await withheld(a, mode === "timeout" ? "checker-timeout" : "checker-cancelled");
    await f.clock.flush();
    expect(old.terminated).toBe(1);
    expect(f.ports).toHaveLength(1);
    old.emit(late);
    await f.clock.flush();
    expect(f.ports).toHaveLength(1);
    old.retirement.resolve();
    await f.clock.flush();
    expect(f.ports).toHaveLength(2);
    old.emit(late);
    f.port().reply();
    expect(read(await queued).withheld).toBe(false);
    const reused = f.send();
    await f.clock.flush();
    f.port().reply();
    expect(read(await reused).withheld).toBe(false);
    await f.dispose();
  },
);

test("queued deadline and cancellation release reservations without terminating active work", async () => {
  const f = fixture({ byteLimit: 8 });
  const a = f.send();
  await f.clock.flush();
  const old = f.port();
  old.held = true;
  await f.clock.advance(1000);
  const abort = new AbortController(),
    cancelled = f.send("safe", abort.signal);
  abort.abort();
  await withheld(cancelled, "checker-cancelled");
  const queued = f.send();
  await f.clock.advance(29000);
  // The active worker retires at its own deadline; the queue still has only 1 s left.
  await withheld(a, "checker-timeout");
  await f.clock.advance(1000);
  await withheld(queued, "checker-timeout");
  expect(f.ports).toHaveLength(1);
  expect(old.terminated).toBe(1);
  expect(f.clock.pending).toBe(0);
  old.retirement.resolve();
  await f.dispose();
});

test.each(["startup", "error", "exit", "dispose"])(
  "%s settles active and queued work once without daemon fallback",
  async (mode) => {
    const startup = Promise.withResolvers<PrivacyWorkerPort>();
    const f = fixture(mode === "startup" ? { workerFactory: () => startup.promise } : {});
    const spy = spyOn(b, "protectText");
    const a = f.send(),
      queued = f.send();
    let resolutions = 0;
    void a.then(() => resolutions++);
    void queued.then(() => resolutions++);
    await f.clock.flush();
    if (mode === "startup") {
      startup.reject(new Error("synthetic startup failure"));
      await f.clock.flush();
    } else if (mode === "error") f.port().onerror?.();
    else if (mode === "exit") f.port().onexit?.();
    else await f.dispose();
    await withheld(a, "checker-failed");
    // Queued work runs only on a replacement; disposal settles it immediately.
    await f.clock.flush();
    if (mode === "error") f.port().onerror?.();
    if (mode === "exit") f.port().onexit?.();
    await withheld(queued, "checker-failed");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await f.dispose();
    await f.clock.flush();
    expect(resolutions).toBe(2);
    expect(f.clock.pending).toBe(0);
    await withheld(f.send(), "checker-failed");
    expect(f.ports.every((p) => p.terminated > 0 || mode === "exit")).toBe(true);
  },
);

test("disposal during startup retires the eventual worker and ignores late output", async () => {
  const startup = Promise.withResolvers<PrivacyWorkerPort>(),
    p = new Port();
  const f = fixture({ workerFactory: () => startup.promise });
  const a = f.send(),
    queued = f.send();
  await f.clock.flush();
  const disposed = f.dispose();
  await withheld(a, "checker-failed");
  await withheld(queued, "checker-failed");
  startup.resolve(p);
  await disposed;
  expect(p.terminated).toBe(1);
  expect(p.sent).toHaveLength(0);
});

test("unreadable authority and core admission failures withhold", async () => {
  let broken = false;
  const registry = b.createPrivacyRegistry(undefined, () => {
    if (broken) throw new Error("synthetic policy failure");
    return "v1";
  });
  const f = fixture({ registry, limits: { inputUnits: 3 } });
  broken = true;
  expect(read(await f.send()).withheld).toBe(true);
  expect(f.ports).toHaveLength(0);
  broken = false;
  const result = f.send();
  await f.clock.flush();
  f.port().reply();
  await withheld(result, "input-length");
  await withheld(f.protectData({ json: {}, provenance: input().provenance }), "nonconvergent");
  await f.dispose();
});

test.each([
  { entry: ["alpha", "beta"].join('","'), json: '["alpha","beta"]', original: false },
  { entry: ["alpha", "beta"].join('","'), json: '["alpha", "beta", "safe"]', original: true },
  { entry: ["host", "example"].join("."), json: JSON.stringify("host.example\u0301"), original: true },
])(
  "worker preserves original, full serialization and selected serialization checks: %j",
  async ({ entry, json, original }) => {
    const f = fixture();
    f.registry.replacePolicy([{ value: entry, entry: 0 }]);
    const policy = b.preparePrivacyPolicy(b.capturePrivacySnapshot(f.registry));
    expect(read(b.protectText({ ...input(json), policy }, { registry: f.registry })).withheld).toBe(
      !original,
    );
    const value = {
      json,
      provenance: input().provenance,
      cut: { unit: "U" as const, limit: entry.length + 1 },
    };
    const result = f.protectData(value);
    await f.clock.flush();
    f.port().reply();
    await withheld(result, "private-match");
    expect(read(await result)).toEqual(read(b.protectData({ ...value, policy }, { registry: f.registry })));
    await f.dispose();
  },
);

test.each(["withheld", "stale", "error", "exit", "startup"])(
  "capacity is reusable after %s settlement",
  async (mode) => {
    let attempts = 0;
    const ports: Port[] = [];
    const f = fixture({
      maxRequests: 1,
      byteLimit: 4,
      workerFactory: () => {
        if (mode === "startup" && attempts++ === 0) throw new Error("synthetic startup failure");
        const port = new Port();
        ports.push(port);
        return port;
      },
    });
    if (mode === "withheld") f.registry.replacePolicy([{ value: "safe", entry: 0 }]);
    const first = f.send();
    await f.clock.flush();
    const port = ports.at(-1);
    if (mode === "stale") f.registry.replacePolicy([]);
    if (mode === "withheld" || mode === "stale") port?.reply();
    if (mode === "error") port?.onerror?.();
    if (mode === "exit") port?.onexit?.();
    expect(read(await first).withheld).toBe(true);
    f.registry.replacePolicy([]);
    const next = f.send();
    await f.clock.flush();
    const replacement = ports.at(-1);
    if (!replacement) throw new Error("No replacement");
    replacement.reply();
    expect(read(await next).withheld).toBe(false);
    expect(f.clock.pending).toBe(0);
    await f.dispose();
  },
);

test("late timers cannot issue twice or release another reservation", async () => {
  const clock = waitClock(),
    callbacks: (() => void)[] = [];
  const f = fixture({
    byteLimit: 4,
    now: clock.now,
    clearTimeout: clock.timer.clear,
    setTimeout: (callback, ms) => {
      callbacks.push(callback);
      return clock.timer.set(callback, ms);
    },
  });
  const spy = spyOn(b, "issuePrivacyWorkerResult");
  const a = f.send();
  await f.clock.flush();
  const timeout = callbacks[0];
  if (!timeout) throw new Error("No deadline");
  timeout();
  await withheld(a, "checker-timeout");
  timeout();
  expect(spy).toHaveBeenCalledTimes(1);
  const next = f.send();
  await f.clock.flush();
  await withheld(f.send(), "checker-busy");
  f.port().reply();
  expect(read(await next).withheld).toBe(false);
  await f.dispose();
  spy.mockRestore();
});

test("dispatch does not restart the admission deadline", async () => {
  const f = fixture();
  const first = f.send();
  await f.clock.flush();
  await f.clock.advance(10000);
  const queued = f.send();
  await f.clock.advance(10000);
  f.port().reply();
  await first;
  await f.clock.flush();
  expect(f.port().sent).toHaveLength(2);
  await f.clock.advance(20000);
  await withheld(queued, "checker-timeout");
  expect(f.port().terminated).toBe(1);
  await f.dispose();
});

test("failed retirement withholds queued work and prevents replacement computation", async () => {
  const f = fixture();
  const a = f.send(),
    queued = f.send();
  await f.clock.flush();
  f.port().terminate = () => Promise.reject(new Error("synthetic retirement failure"));
  f.port().onerror?.();
  await withheld(a, "checker-failed");
  await withheld(queued, "checker-failed");
  expect(f.ports).toHaveLength(1);
  expect(f.port().refs.at(-1)).toBe(false);
  await withheld(f.send(), "checker-failed");
  await f.dispose();
});
