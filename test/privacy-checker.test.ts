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
type Frame = Record<string, unknown> & { id: number; direction: string; type: string; sequence: number };
// One scheduler for daemon and worker turns; `run` executes them one at a time.
const turns: (() => void)[] = [];
const schedule = (turn: () => void) => void turns.push(turn);
const transfers: { bytes: number; detached: boolean }[] = [];
function copy(value: unknown, transfer: ArrayBuffer[] = []) {
  const lengths = transfer.map((buffer) => buffer.byteLength);
  const frame = structuredClone(value, { transfer }) as Frame;
  for (const [i, buffer] of transfer.entries())
    transfers.push({ bytes: lengths[i] ?? 0, detached: buffer.byteLength === 0 });
  return frame;
}
/** Fake port wired to the real worker handler; worker frames pass through `tamper` before delivery. */
class Port implements PrivacyWorkerPort {
  onmessage?: PrivacyWorkerPort["onmessage"];
  onerror?: PrivacyWorkerPort["onerror"];
  onexit?: PrivacyWorkerPort["onexit"];
  sent: Frame[] = [];
  received: Frame[] = [];
  refs: boolean[] = [];
  terminated = 0;
  held = false;
  retirement = Promise.withResolvers<void>();
  tamper = (frame: Frame): Frame[] => [frame];
  worker = {
    postMessage: (value: unknown, transfer?: ArrayBuffer[]) => {
      for (const frame of this.tamper(copy(value, transfer))) this.emit(frame);
    },
    onmessage: undefined as PrivacyWorkerPort["onmessage"],
  };
  constructor() {
    privacyWorkerHandler(this.worker, { schedule });
  }
  postMessage(value: unknown, transfer?: ArrayBuffer[]) {
    const frame = copy(value, transfer);
    this.sent.push(frame);
    this.worker.onmessage?.({ data: frame });
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
    this.received.push(data as Frame);
    this.onmessage?.({ data });
  }
  /** Holds back matching worker frames instead of delivering them. */
  hold(match: (frame: Frame) => boolean) {
    const held: Frame[] = [];
    this.tamper = (frame) => {
      if (!match(frame)) return [frame];
      held.push(frame);
      return [];
    };
    return held;
  }
}
const W = 4;
// Wire charge of a plain request: 4-byte length headers for the input and the (empty) cut marker.
const charge = (text = "safe") => 8 + Buffer.byteLength(text);
const resultFinal = (frame: Frame) => frame.direction === "result" && frame.type === "complete";
type Options = NonNullable<Parameters<typeof createPrivacyChecker>[0]>;
function fixture(options: Options = {}) {
  const clock = waitClock();
  const ports: Port[] = [];
  const registry = options.registry ?? b.createPrivacyRegistry();
  turns.length = 0;
  const payloads: number[] = [];
  const checker = createPrivacyChecker({
    registry,
    schedule,
    outputWindow: W,
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
  /** Runs scheduled sender turns one at a time, recording payload sends per turn. */
  async function run(limit = Infinity) {
    await clock.flush();
    while (limit-- > 0) {
      const turn = turns.shift();
      if (!turn) return;
      const before = transfers.length;
      turn();
      payloads.push(transfers.length - before);
      await clock.flush();
    }
  }
  return {
    ...checker,
    clock,
    ports,
    port,
    registry,
    run,
    payloads,
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
  f.registry.addCredential("privacy-test-credential");
  const policy = b.preparePrivacyPolicy(b.capturePrivacySnapshot(f.registry));
  const shown = { truncated: false, withheld: false, checkedComplete: true };
  const cut = { truncated: true, withheld: false, checkedComplete: true };
  const refused = (reason: string, truncated?: boolean) => ({
    text: "[withheld: private text]",
    withheld: true,
    checkedComplete: false,
    truncated,
    reason,
  });
  const complete = input().provenance;
  const legacy = { kind: "legacy-unknown" } as const;
  // Request chunks split at stream byte 32768 (text byte 32764); output chunks split every W bytes.
  const cases = [
    [input(), { ...shown, text: "safe" }],
    [input("é😀é"), { ...shown, text: "é😀é" }],
    [input("\uFEFFsafe"), { ...shown, text: "\uFEFFsafe" }],
    [input(host), refused("private-match", false)],
    [input(`${"a".repeat(32760)}${host}`), refused("private-match", false)],
    [input("ab"), refused("private-match", false)],
    [
      { ...input("safe\x1b[31m text"), terminal: true },
      { ...shown, text: "safe text" },
    ],
    [
      { ...input("safe tail"), cut: { unit: "U" as const, limit: 4 } },
      { ...cut, text: "safe" },
    ],
    [
      {
        ...input(`${"a".repeat(32763)}é😀 tail`),
        cut: { unit: "U" as const, limit: 3, side: "tail" as const },
      },
      { ...cut, text: "ail" },
    ],
    [
      {
        ...input(`${"a".repeat(32762)}😀 x`),
        cut: { unit: "B" as const, limit: 3, side: "tail" as const, marker: "…" },
      },
      { ...cut, text: "… x" },
    ],
    [
      { ...input("éxyz"), cut: { unit: "CP" as const, limit: 1, marker: "~" } },
      { ...cut, text: "e~" },
    ],
    [
      { ...input("éé"), cut: { unit: "B" as const, limit: 3 } },
      { ...cut, text: "é" },
    ],
    [input("\uD800 safe"), refused("ill-formed", false)],
    [{ text: "\uD800 safe", provenance: legacy }, refused("unchecked-provenance")],
    [{ text: "safe", provenance: legacy }, refused("unchecked-provenance")],
    [
      input(`id ${Buffer.from("privacy-test-credential").toString("base64")}`),
      refused("private-match", false),
    ],
  ] as const;
  for (const [value, expected] of cases) {
    const result = f.protectText(value);
    await f.run();
    const sync = read(b.protectText({ ...value, policy }, { registry: f.registry }));
    expect(read(await result)).toEqual(sync);
    expect(read(await result)).toMatchObject(expected);
    expect(Object.keys(await result)).toEqual([]);
  }
  const jsons = [
    [JSON.stringify({ [host]: 1 }), refused("private-match", false)],
    ['{"ab":1}', { ...shown, text: '{"[withheld: private text]":1}' }],
    ['["ab","safe"]', { ...shown, text: '["[withheld: private text]","safe"]' }],
    ['["alpha", "beta", "safe"]', { ...shown, text: '["alpha","beta","safe"]' }],
    ['{"k":"privacy-test-credential"}', refused("private-match", false)],
    [`"${"a".repeat(32760)}\\u00e9"`, { ...cut, text: `"${"a".repeat(7)}` }],
  ] as const;
  for (const [json, expected] of jsons) {
    const value = {
      json,
      provenance: complete,
      ...(json.length > 99 && { cut: { unit: "U" as const, limit: 8 } }),
    };
    const result = f.protectData(value);
    await f.run();
    expect(read(await result)).toEqual(read(b.protectData({ ...value, policy }, { registry: f.registry })));
    expect(read(await result)).toMatchObject(expected);
  }
  expect(f.ports).toHaveLength(1);
  expect(f.port().refs.at(-1)).toBe(false);
  expect(f.clock.pending).toBe(0);
  await f.dispose();
});

test("each sender transfers one bounded payload chunk per turn and keeps strings out of control frames", async () => {
  transfers.length = 0;
  const f = fixture({ outputWindow: 1 << 20 });
  const secrets = [
    "entry-synthetic-private-value",
    "credential-synthetic-0123456789",
    "marker-synthetic-text",
  ];
  f.registry.replacePolicy([{ value: secrets[0] ?? "", entry: 7 }]);
  f.registry.addCredential(secrets[1] ?? "");
  const text = "s".repeat(70000);
  const result = f.protectText({ ...input(text), cut: { unit: "U", limit: 40000, marker: secrets[2] } });
  await f.run();
  expect(read(await result)).toMatchObject({ withheld: false, truncated: true });
  const frames = [...f.port().sent, ...f.port().received];
  const chunks = frames.filter((frame) => frame.type === "chunk");
  // 3 request chunks (70097 bytes) and 2 result chunks (40021 bytes) of at most 32 KiB.
  expect(chunks.map((frame) => `${frame.direction}:${frame.sequence}`)).toEqual([
    "request:0",
    "request:1",
    "request:2",
    "result:0",
    "result:1",
  ]);
  expect(transfers.map(({ bytes }) => bytes)).toEqual([32768, 32768, 4561, 32768, 7253]);
  expect(transfers.every(({ detached }) => detached)).toBe(true);
  expect(
    chunks.every((frame) => frame.payload instanceof ArrayBuffer && Object.keys(frame).length === 7),
  ).toBe(true);
  // Every ACK arrives synchronously, yet no turn sent more than one payload.
  expect(Math.max(...f.payloads)).toBe(1);
  expect(f.payloads.filter(Boolean)).toHaveLength(5);
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : value && typeof value === "object"
        ? Object.values(value).flatMap(strings)
        : [];
  const control = frames.flatMap(({ payload: _payload, ...rest }) => strings(rest));
  expect(Math.max(...control.map((value) => value.length))).toBeLessThanOrEqual("privacy/1/1/0".length);
  const final = f.port().sent.find((frame) => frame.direction === "request" && frame.type === "complete");
  expect(final).toMatchObject({ sequence: 3, chunks: 3, bytes: 70097, entries: 1, cut: { limit: 40000 } });
  expect(f.port().received.find(resultFinal)).toMatchObject({ sequence: 2, chunks: 2, bytes: 40021 });
  await f.dispose();
});

test.each([
  "missing",
  "duplicate",
  "reordered",
  "oversized",
  "malformed",
  "version",
  "generation",
  "bytes",
  "chunks",
  "trailing",
  "chunk-bound",
  "chunk-zero",
  "segments",
  "wire-generation",
  "metadata",
  "control-text",
  "limits",
  "kind",
  "cut-unit",
])("worker refuses %s request transfers without running the operation", async (fault) => {
  const f = fixture();
  f.registry.replacePolicy([{ value: "entry-synthetic", entry: 0 }]);
  const result = f.protectText({ ...input("é".repeat(20000)), cut: { unit: "U", limit: 2, marker: "~" } });
  await f.run();
  await result;
  const [first, second, final] = f.port().sent;
  if (!first || !second || !final) throw new Error("Missing request frames");
  const frames = {
    missing: [second, final],
    duplicate: [first, first, second, final],
    reordered: [second, first, final],
    oversized: [{ ...first, payload: new ArrayBuffer(32769) }],
    malformed: [
      // Well-formed segment layout (input, marker, one entry) whose input holds an invalid UTF-8 byte.
      { ...first, payload: new Uint8Array([0, 0, 0, 2, 0xc3, 0x28, 0, 0, 0, 0, 0, 0, 0, 1, 0x61]).buffer },
      { ...final, sequence: 1, chunks: 1, bytes: 15 },
    ],
    version: [first, second, { ...final, version: 1 }],
    generation: [first, second, { ...final, generation: { policy: -1, credentials: 0, checker: 0 } }],
    bytes: [first, second, { ...final, bytes: Number(final.bytes) + 1 }],
    chunks: [first, second, { ...final, chunks: 3 }],
    trailing: [first, { ...second, payload: new Uint8Array([0, 0]).buffer }, { ...final, bytes: 32770 }],
    "chunk-bound": [first, second, { ...final, chunk: 65536 }],
    "chunk-zero": [first, second, { ...final, chunk: 0 }],
    // Only the input segment: the required marker segment is missing.
    segments: [
      { ...first, payload: new Uint8Array([0, 0, 0, 1, 0x61]).buffer },
      { ...final, sequence: 1, chunks: 1, bytes: 5, entries: 0 },
    ],
    "wire-generation": [first, second, final].map((frame) => ({
      ...frame,
      generation: { policy: "1", credentials: 0, checker: 0 },
    })),
    metadata: [
      first,
      second,
      Object.fromEntries(Object.entries(final).filter(([key]) => key !== "operation")),
    ],
    "control-text": [first, second, { ...final, note: "x".repeat(1000) }],
    limits: [first, second, { ...final, limits: { ...b.privacyLimits, inputBytes: "33554432" } }],
    kind: [first, second, { ...final, kind: "x".repeat(1000) }],
    "cut-unit": [first, second, { ...final, cut: { limit: 2, unit: ["U"], side: "prefix" } }],
  }[fault] as Frame[];
  const posted: Frame[] = [];
  const side = {
    postMessage: (value: unknown) => void posted.push(value as Frame),
    onmessage: undefined as PrivacyWorkerPort["onmessage"],
  };
  privacyWorkerHandler(side, { schedule });
  const text = spyOn(b, "protectText");
  expect(() => {
    for (const data of frames) side.onmessage?.({ data });
  }).toThrow();
  expect(text).not.toHaveBeenCalled();
  text.mockRestore();
  expect(posted.every((frame) => frame.direction === "request" && frame.type === "ack")).toBe(true);
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
    f.port().tamper = (frame) => {
      if (resultFinal(frame) && kind === "policy") registry.replacePolicy([]);
      if (resultFinal(frame) && kind === "credentials") registry.addCredential("new-synthetic-secret");
      if (resultFinal(frame) && kind === "checker") label = "v2";
      if (resultFinal(frame) && kind === "identity")
        Object.defineProperty(registry, "generation", { get: () => b.createPrivacyRegistry().generation });
      return [frame];
    };
    await f.run();
    await withheld(a, "stale-generation");
    await withheld(queued, "stale-generation");
    expect(new Set(f.port().sent.map((frame) => frame.id)).size).toBe(1);
    expect(f.ports).toHaveLength(1);
    await f.dispose();
    const later = fixture();
    const good = later.send();
    await later.run();
    const receipt = await good;
    expect(read(receipt).withheld).toBe(false);
    later.registry.addCredential("later-synthetic-secret");
    expect(read(receipt).reason).toBe("stale-generation");
    await later.dispose();
  },
);

const forged = (frame: Frame, fields: object) => (resultFinal(frame) ? [{ ...frame, ...fields }] : [frame]);
const faults: Record<string, (frame: Frame) => Frame[]> = {
  version: (frame) => forged(frame, { version: 1 }),
  generation: (frame) => [{ ...frame, generation: { policy: -1, credentials: 0, checker: 0 } }],
  direction: (frame) => (frame.type === "chunk" ? [{ ...frame, direction: "request" }] : [frame]),
  reordered: (frame) => (frame.type === "chunk" ? [{ ...frame, sequence: 1 }] : [frame]),
  duplicate: (frame) => (frame.type === "chunk" ? [frame, frame] : [frame]),
  missing: (frame) =>
    frame.type === "chunk" ? [{ ...frame, type: "complete", sequence: 1, chunks: 1 }] : [frame],
  oversized: (frame) => (frame.type === "chunk" ? [{ ...frame, payload: new ArrayBuffer(W + 1) }] : [frame]),
  "bulk-chunk": (frame) => (frame.type === "chunk" ? [{ ...frame, text: "unvalidated partial" }] : [frame]),
  "bulk-final": (frame) => forged(frame, { text: "unvalidated partial" }),
  bytes: (frame) => forged(frame, { bytes: 5 }),
  chunks: (frame) => forged(frame, { chunks: 2 }),
  shape: (frame) => forged(frame, { checkedComplete: "yes" }),
  "missing-id": ({ id: _id, ...frame }) => [frame as Frame],
  "extra-registry": (frame) => forged(frame, { registry: {} }),
  "extra-generation": (frame) => forged(frame, { identity: {} }),
  "extra-limits": (frame) => forged(frame, { limits: {} }),
  "extra-policy": (frame) => forged(frame, { policy: {} }),
  "extra-hooks": (frame) => forged(frame, { beforeIssue: {} }),
  "extra-other": (frame) => forged(frame, { other: {} }),
  "duplicate-ack": (frame) => (frame.type === "ack" ? [frame, frame] : [frame]),
  "stale-ack": (frame) => (frame.type === "ack" ? [{ ...frame, sequence: -1 }] : [frame]),
  "result-ack": (frame) => (frame.type === "ack" ? [{ ...frame, direction: "result" }] : [frame]),
  "early-output": (frame) =>
    frame.type === "ack"
      ? [{ ...frame, direction: "result", type: "chunk", payload: new ArrayBuffer(1) }]
      : [frame],
  // A well-formed zero-chunk result final before the request transfer finished.
  "early-final": (frame) =>
    frame.type === "ack"
      ? [
          {
            ...frame,
            ...{ direction: "result", type: "complete", chunks: 0, bytes: 0, truncated: false },
            ...{ checkedComplete: true, withheld: false, policyDigest: "privacy/0/0/0" },
          },
        ]
      : [frame],
};
test.each(Object.keys(faults))("protocol fault: %s withholds and retires", async (fault) => {
  const f = fixture({ maxRequests: 1, byteLimit: charge() + W });
  const issued = spyOn(b, "issuePrivacyWorkerResult");
  const result = f.send();
  await f.clock.flush();
  f.port().tamper = faults[fault] ?? ((frame) => [frame]);
  await f.run();
  await withheld(result, "checker-failed");
  expect(issued).toHaveBeenCalledTimes(1);
  // Output arriving before its grant is refused, never acknowledged.
  if (fault === "early-output" || fault === "early-final")
    expect(f.port().sent.some((frame) => frame.direction === "result")).toBe(false);
  issued.mockRestore();
  expect(f.port().terminated).toBe(1);
  expect(f.clock.pending).toBe(0);
  const next = f.send();
  await f.run();
  expect(f.ports).toHaveLength(2);
  expect(read(await next).withheld).toBe(false);
  await f.dispose();
});

test("wrong and late IDs do not settle other requests, idle workers are unref'd", async () => {
  const f = fixture();
  expect(f.ports).toHaveLength(0);
  const a = f.send();
  await f.clock.flush();
  expect(f.port().refs).toEqual([false, true]);
  let settled = 0;
  void a.then(() => settled++);
  f.port().tamper = (frame) => [{ ...frame, id: -1 }];
  await f.run();
  expect(settled).toBe(0);
  const old = f.port().received.find((frame) => frame.type === "ack");
  if (!old) throw new Error("No ACK");
  f.port().tamper = (frame) => [frame];
  f.port().emit({ ...old, id: Number(f.port().sent[0]?.id) });
  await f.run();
  await a;
  expect(f.port().refs.at(-1)).toBe(false);
  const late = [...f.port().received];
  // Daemon frames of the finished request replayed to the real worker, idle and mid-transfer, are ignored.
  const stale = [...f.port().sent];
  const replay = () => {
    const count = f.port().received.length;
    for (const data of stale) f.port().worker.onmessage?.({ data });
    expect(f.port().received).toHaveLength(count);
  };
  replay();
  const next = f.send();
  await f.run(1);
  replay();
  for (const frame of late) f.port().emit(frame);
  await f.clock.flush();
  expect(settled).toBe(1);
  expect(f.clock.pending).toBe(1);
  await f.run();
  expect(read(await next).withheld).toBe(false);
  await f.dispose();
});

test("eight count slots and UTF-8 byte reservations include queued work and are released", async () => {
  const f = fixture();
  const admitted = Array.from({ length: 8 }, () => f.send());
  await withheld(f.send(), "checker-busy");
  await f.run();
  for (const result of admitted) expect(read(await result).withheld).toBe(false);
  expect(f.clock.pending).toBe(0);
  await f.dispose();
  const small = fixture({ byteLimit: 2 * charge("é") + W });
  const first = small.send("é"),
    second = small.send("é");
  await withheld(small.send("x"), "checker-busy");
  await small.run(1);
  // An input-chunk ACK does not release the request's charge.
  await withheld(small.send("x"), "checker-busy");
  await small.run(3);
  await first;
  const reused = small.send("é");
  await small.run();
  await second;
  expect(read(await reused).withheld).toBe(false);
  await small.dispose();
});

test("byte accounting charges input, policy, credentials, marker and one reserved output window", async () => {
  const value = { ...input("safe é"), cut: { unit: "U" as const, limit: 3, marker: "…" } };
  const budget = async (policy: boolean) => {
    const probe = fixture();
    if (policy) probe.registry.replacePolicy([{ value: "entry-synthetic", entry: 3 }]);
    probe.registry.addCredential("credential-synthetic");
    const result = probe.protectText(value);
    await probe.run();
    await result;
    const final = probe
      .port()
      .sent.find((frame) => frame.direction === "request" && frame.type === "complete");
    await probe.dispose();
    return Number(final?.bytes);
  };
  const bytes = await budget(true);
  // Four length-prefixed UTF-8 segments: input, marker, entry value and credential.
  expect(bytes).toBe(4 + 7 + 4 + 3 + 4 + 15 + 4 + 20);
  expect(await budget(false)).toBe(bytes - 19);
  for (const limit of [bytes + W - 1, bytes + W, 2 * bytes + W]) {
    const f = fixture({ byteLimit: limit });
    f.registry.replacePolicy([{ value: "entry-synthetic", entry: 3 }]);
    f.registry.addCredential("credential-synthetic");
    const active = f.protectText(value),
      queued = f.protectText(value);
    await f.clock.flush();
    if (limit < bytes + W) {
      await withheld(active, "checker-busy");
      expect(f.ports).toHaveLength(0);
      expect(f.clock.pending).toBe(0);
    }
    if (limit < 2 * bytes + W) await withheld(queued, "checker-busy");
    else await withheld(f.protectText(value), "checker-busy");
    await f.run();
    if (limit >= bytes + W) expect(read(await active)).toMatchObject({ withheld: false, text: "saf…" });
    if (limit >= 2 * bytes + W) expect(read(await queued).withheld).toBe(false);
    expect(f.clock.pending).toBe(0);
    await f.dispose();
  }
});

test("full admission still completes output through the reserved window; duplicate ACKs release nothing", async () => {
  const f = fixture({ byteLimit: charge("safe text!!") + W });
  const result = f.send("safe text!!");
  await f.clock.flush();
  const acks = f.port().hold((frame) => frame.type === "ack");
  await f.run();
  expect(acks).toHaveLength(1);
  await withheld(f.send(), "checker-busy");
  const [ack] = acks;
  if (!ack) throw new Error("No ACK");
  f.port().tamper = (frame) => [frame];
  f.port().emit(ack);
  await withheld(f.send(), "checker-busy");
  await f.run();
  // Three W-byte output chunks, each ACKed by the daemon before the next is sent.
  expect(f.port().received.filter((frame) => frame.type === "chunk")).toHaveLength(3);
  expect(read(await result)).toMatchObject({ withheld: false, text: "safe text!!" });
  const again = f.send("safe text!!");
  await f.clock.flush();
  const held = f.port().hold((frame) => frame.type === "ack");
  await f.run();
  const [duplicate] = held;
  if (!duplicate) throw new Error("No ACK");
  f.port().emit(duplicate);
  f.port().emit(duplicate);
  await withheld(again, "checker-failed");
  const reused = f.send("safe text!!");
  await withheld(f.send(), "checker-busy");
  await f.run();
  expect(read(await reused).withheld).toBe(false);
  await f.dispose();
});

test.each(["timeout", "cancel", "exit"])(
  "active %s after partial output waits for retirement; queued work has its own deadline",
  async (mode) => {
    const f = fixture({ byteLimit: 2 * charge() + W });
    const issued = spyOn(b, "issuePrivacyWorkerResult");
    const controller = new AbortController();
    const a = f.send("safe", controller.signal);
    await f.clock.flush();
    const old = f.port(),
      late = old.hold(resultFinal);
    await f.run();
    expect(old.received.filter((frame) => frame.type === "chunk")).toHaveLength(1);
    old.held = true;
    await f.clock.advance(10000);
    const queued = f.send();
    if (mode === "timeout") await f.clock.advance(20000);
    else if (mode === "cancel") controller.abort();
    else old.onexit?.();
    await withheld(
      a,
      { timeout: "checker-timeout", cancel: "checker-cancelled", exit: "checker-failed" }[mode] ?? "",
    );
    await f.clock.flush();
    expect(old.terminated).toBe(mode === "exit" ? 0 : 1);
    if (mode !== "exit") {
      expect(f.ports).toHaveLength(1);
      for (const frame of late) old.emit(frame);
      await f.clock.flush();
      expect(f.ports).toHaveLength(1);
    }
    old.retirement.resolve();
    await f.clock.flush();
    expect(f.ports).toHaveLength(2);
    for (const frame of late) old.emit(frame);
    await f.run();
    expect(read(await queued).withheld).toBe(false);
    const reused = f.send();
    await f.run();
    expect(read(await reused).withheld).toBe(false);
    expect(issued).toHaveBeenCalledTimes(3);
    issued.mockRestore();
    await f.dispose();
  },
);

test("queued deadline and cancellation release reservations without terminating active work", async () => {
  const f = fixture({ byteLimit: 2 * charge() + W });
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
  const reused = [f.send(), f.send()];
  await f.run();
  for (const result of reused) expect(read(await result).withheld).toBe(false);
  await f.dispose();
});

test.each(["mid-transfer", "issuance"])("generation change %s withholds as stale", async (mode) => {
  const f = fixture();
  const issue = b.issuePrivacyWorkerResult;
  const issued = spyOn(b, "issuePrivacyWorkerResult").mockImplementation((...args) => {
    if (mode === "issuance") f.registry.replacePolicy([]);
    return issue(...args);
  });
  const result = f.send("é".repeat(20000));
  await f.run(1);
  if (mode === "mid-transfer") f.registry.addCredential("mid-synthetic-secret");
  await f.run();
  await withheld(result, "stale-generation");
  expect(issued).toHaveBeenCalledTimes(1);
  issued.mockRestore();
  expect(f.port().terminated).toBe(mode === "mid-transfer" ? 1 : 0);
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
    await f.run();
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
  const startup = Promise.withResolvers<PrivacyWorkerPort>();
  const f = fixture({ workerFactory: () => startup.promise });
  const p = new Port();
  const a = f.send(),
    queued = f.send();
  await f.clock.flush();
  const disposed = f.dispose();
  await withheld(a, "checker-failed");
  await withheld(queued, "checker-failed");
  startup.resolve(p);
  await disposed;
  await f.run();
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
  await withheld(result, "input-length");
  expect(f.ports).toHaveLength(0);
  expect(f.clock.pending).toBe(0);
  await withheld(f.protectData({ json: {}, provenance: input().provenance }), "nonconvergent");
  await f.dispose();
});

test.each(["text", "data"] as const)("%s enforces core input caps before admission", async (operation) => {
  for (const [limits, oversized, exact] of [
    [{ inputUnits: 3 }, "xxxx", "xxx"],
    [{ inputBytes: 4 }, "ééé", "éé"],
  ] as const) {
    const clock = waitClock();
    let timers = 0;
    const f = fixture({
      limits,
      maxRequests: 1,
      byteLimit: charge(exact) + W,
      setTimeout: (callback, ms) => {
        timers++;
        return clock.timer.set(callback, ms);
      },
      clearTimeout: clock.timer.clear,
    });
    const send = (text: string) =>
      operation === "text" ? f.send(text) : f.protectData({ json: text, provenance: input().provenance });
    await withheld(send(oversized), "input-length");
    await f.clock.flush();
    expect(f.ports).toHaveLength(0);
    expect(timers).toBe(0);
    expect(clock.pending).toBe(0);
    const admitted = send(exact);
    await withheld(send(oversized), "input-length");
    await withheld(send(exact), "checker-busy");
    await f.run();
    expect(timers).toBe(1);
    expect(f.port().sent.filter((frame) => frame.type === "chunk")).toHaveLength(1);
    const receipt = await admitted;
    expect(read(receipt).withheld).toBe(false);
    expect(read(b.concat([receipt, receipt])).reason).toBe("input-length");
    expect(clock.pending).toBe(0);
    await f.dispose();
  }
});

test.each([
  [{ kind: "cut", truncated: true }, true],
  [{ kind: "legacy-unknown" }, undefined],
  [{ kind: "complete" }, false],
] as const)("local failures retain provenance %j", async (provenance, truncated) => {
  for (const [mode, reason] of [
    ["busy", "checker-busy"],
    ["pre-aborted", "checker-cancelled"],
    ["active-cancel", "checker-cancelled"],
    ["queued-cancel", "checker-cancelled"],
    ["startup", "checker-failed"],
    ["error", "checker-failed"],
    ["exit", "checker-failed"],
    ["active-timeout", "checker-timeout"],
    ["queued-timeout", "checker-timeout"],
    ["protocol", "checker-failed"],
    ["dispose", "checker-failed"],
    ["disposed", "checker-failed"],
    ["input-length", "input-length"],
    ["non-string", "nonconvergent"],
    ["unreadable", "stale-generation"],
    ["stale-admission", "stale-generation"],
    ["stale-dispatch", "stale-generation"],
    ["stale-response", "stale-generation"],
  ] as const) {
    let reads = 0;
    let broken = false;
    const authority = b.createPrivacyRegistry();
    const registry = {
      ...authority,
      snapshot: () => {
        if (broken) throw new Error("synthetic snapshot failure");
        return authority.snapshot();
      },
      get generation() {
        if (mode === "stale-admission" && ++reads === 1) authority.replacePolicy([]);
        return authority.generation;
      },
    };
    const both = ["startup", "error", "exit", "dispose"].includes(mode);
    const f = fixture({
      registry,
      maxRequests: both || mode.startsWith("queued-") ? 2 : 1,
      byteLimit: (both || mode.startsWith("queued-") ? 2 : 1) * charge() + W,
      ...(mode === "startup" ? { workerFactory: () => Promise.reject(new Error("startup")) } : {}),
      ...(mode === "input-length" ? { limits: { inputUnits: 3 } } : {}),
    });
    const controller = new AbortController();
    let first: Promise<b.BoundaryText> | undefined;
    if (mode === "busy" || mode.startsWith("queued-")) {
      first = f.send();
      await f.clock.flush();
      if (mode === "queued-timeout") f.port().held = true;
    }
    if (mode === "disposed") await f.dispose();
    if (mode === "pre-aborted") controller.abort();
    if (mode === "unreadable") broken = true;
    // The requested cut never executes: failure truncation comes from provenance alone.
    const value = { ...input(), provenance, cut: { unit: "U" as const, limit: 0 } };
    const result =
      mode === "non-string"
        ? f.protectData({ ...value, json: {} })
        : f.protectText(value, { signal: controller.signal });
    const queued = both ? f.protectData({ ...value, json: "safe" }) : undefined;
    if (mode === "stale-dispatch") authority.replacePolicy([]);
    await f.clock.flush();
    if (mode === "active-cancel" || mode === "queued-cancel") controller.abort();
    if (mode === "active-timeout" || mode === "queued-timeout") await f.clock.advance(30000);
    if (mode === "error") f.port().onerror?.();
    if (mode === "exit") f.port().onexit?.();
    if (mode === "protocol") f.port().tamper = (frame) => [{ ...frame, type: "partial" }];
    if (mode === "stale-response")
      f.port().tamper = (frame) => {
        if (resultFinal(frame)) authority.addCredential("safe");
        return [frame];
      };
    if (mode === "protocol" || mode === "stale-response") await f.run();
    if (mode === "dispose") await f.dispose();
    const expected = {
      text: "[withheld: private text]",
      withheld: true,
      checkedComplete: false,
      truncated,
      reason,
    };
    expect(read(await result)).toMatchObject(expected);
    if (queued) {
      await f.clock.flush();
      if (mode === "error") f.port().onerror?.();
      if (mode === "exit") f.port().onexit?.();
      expect(read(await queued)).toMatchObject(expected);
    }
    if (mode === "queued-cancel") {
      expect(f.port().terminated).toBe(0);
      expect(f.clock.pending).toBe(1);
    }
    if (mode === "queued-timeout") f.port().retirement.resolve();
    await f.dispose();
    if (first) await first;
    expect(f.clock.pending).toBe(0);
  }
});

test.each([
  { entry: ["alpha", "beta"].join('","'), json: '["alpha","beta"]', original: false },
  { entry: ["alpha", "beta"].join('","'), json: '["alpha", "beta", "safe"]', original: true },
  { entry: ["host", "example"].join("."), json: JSON.stringify("host.examplé"), original: true },
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
    await f.run();
    await withheld(result, "private-match");
    expect(read(await result)).toEqual(read(b.protectData({ ...value, policy }, { registry: f.registry })));
    await f.dispose();
  },
);

test.each(["withheld", "stale", "error", "exit", "startup", "protocol", "cancel", "timeout"])(
  "capacity is reusable after %s settlement",
  async (mode) => {
    let attempts = 0;
    const ports: Port[] = [];
    const f = fixture({
      maxRequests: 1,
      byteLimit: charge() + W,
      workerFactory: () => {
        if (mode === "startup" && attempts++ === 0) throw new Error("synthetic startup failure");
        const port = new Port();
        ports.push(port);
        return port;
      },
    });
    if (mode === "withheld") f.registry.replacePolicy([{ value: "safe", entry: 0 }]);
    const controller = new AbortController();
    const first = f.send("safe", controller.signal);
    await f.clock.flush();
    const port = ports.at(-1);
    if (mode === "stale") f.registry.replacePolicy([]);
    if (port && mode === "protocol") port.tamper = (frame) => [{ ...frame, sequence: 9 }];
    if (mode === "cancel") controller.abort();
    if (mode === "timeout") await f.clock.advance(30000);
    if (mode === "error") port?.onerror?.();
    if (mode === "exit") port?.onexit?.();
    await f.run();
    expect(read(await first).withheld).toBe(true);
    f.registry.replacePolicy([]);
    const next = f.send();
    await withheld(f.send(), "checker-busy");
    await f.run();
    expect(read(await next).withheld).toBe(false);
    expect(f.clock.pending).toBe(0);
    await f.dispose();
  },
);

test("late timers cannot issue twice or release another reservation", async () => {
  const clock = waitClock(),
    callbacks: (() => void)[] = [];
  const f = fixture({
    byteLimit: charge() + W,
    now: clock.now,
    clearTimeout: clock.timer.clear,
    setTimeout: (callback, ms) => {
      callbacks.push(callback);
      return clock.timer.set(callback, ms);
    },
  });
  const spy = spyOn(b, "issuePrivacyWorkerResult");
  const a = f.send();
  await f.run(2);
  const timeout = callbacks[0];
  if (!timeout) throw new Error("No deadline");
  timeout();
  await withheld(a, "checker-timeout");
  timeout();
  expect(spy).toHaveBeenCalledTimes(1);
  const next = f.send();
  await f.clock.flush();
  await withheld(f.send(), "checker-busy");
  await f.run();
  expect(read(await next).withheld).toBe(false);
  expect(spy).toHaveBeenCalledTimes(3);
  await f.dispose();
  spy.mockRestore();
});

test.each([30000, 30001])("completion at %i ms cannot beat a delayed deadline callback", async (elapsed) => {
  let now = 0;
  const f = fixture({ now: () => now, byteLimit: 2 * charge() + W });
  const first = f.send();
  await f.clock.flush();
  const old = f.port();
  const response = old.hold(resultFinal);
  await f.run();
  old.held = true;
  now = 10000;
  const queued = f.send();
  now = elapsed;
  // Move only the injected time: the admission timer has not run yet.
  for (const frame of response) old.emit(frame);
  await withheld(first, "checker-timeout");
  await f.clock.flush();
  expect(old.terminated).toBe(1);
  expect(f.ports).toHaveLength(1);
  expect(f.clock.pending).toBe(1);
  for (const frame of response) old.emit(frame);
  old.retirement.resolve();
  await f.clock.flush();
  expect(f.ports).toHaveLength(2);
  for (const frame of response) old.emit(frame);
  await f.run();
  expect(read(await queued).withheld).toBe(false);
  const reused = f.send();
  await f.run();
  expect(read(await reused).withheld).toBe(false);
  expect(f.clock.pending).toBe(0);
  await f.dispose();
});

test("dispatch does not restart the admission deadline", async () => {
  const f = fixture();
  const first = f.send();
  await f.clock.flush();
  await f.clock.advance(10000);
  const queued = f.send();
  await f.clock.advance(10000);
  // Hold the queued request's input transfer after dispatch.
  f.port().hold((frame) => frame.type === "ack" && frame.id !== f.port().sent[0]?.id);
  await f.run();
  await first;
  expect(new Set(f.port().sent.map((frame) => frame.id)).size).toBe(2);
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
