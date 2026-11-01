import type { Worker } from "node:worker_threads";
import * as b from "./privacy-boundary.ts";
import * as t from "./privacy-transport.ts";

type Generation = ReturnType<typeof b.currentPrivacyGeneration>;
type Snapshot = ReturnType<typeof b.capturePrivacySnapshot>;
type Projection = ReturnType<typeof b.consumeBoundaryText>;
type Reason = NonNullable<Projection["reason"]>;
type TextInput = Omit<Parameters<typeof b.protectText>[0], "policy">;
type DataInput = Omit<Parameters<typeof b.protectData>[0], "policy">;
type Input = Omit<TextInput, "text"> & { text?: string; json?: unknown };
type Operation = "text" | "data";
type Control = { signal?: AbortSignal };
type Limits = typeof b.privacyLimits;
type Final = t.Frame & ReturnType<typeof envelope>["meta"] & { type: string };
export type PrivacyWorkerPort = Pick<Worker, "postMessage" | "ref" | "unref"> & {
  onmessage?: ((event: { data: unknown }) => void) | null;
  onerror?: (() => void) | null;
  onexit?: (() => void) | null;
  terminate(): Promise<unknown>;
};
type Options = {
  registry?: typeof b.privacyRegistry;
  workerFactory?: () => PrivacyWorkerPort | Promise<PrivacyWorkerPort>;
  limits?: Partial<typeof b.privacyLimits>;
  maxRequests?: number;
  deadlineMs?: number;
  byteLimit?: number;
  outputWindow?: number;
  schedule?: t.Schedule;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: typeof clearTimeout;
};
/** Strings travel only as payload segments; entry numbers never reach a projection, so are omitted. */
function envelope(operation: Operation, input: Input, s: Snapshot, limits: Limits, chunk: number) {
  const { identity: _identity, ...generation } = s.generation;
  const { cut, provenance: p } = input;
  const texts = [String(operation === "text" ? input.text : input.json), String(cut?.marker ?? "")];
  const stream = t.segments([...texts, ...s.entries.map(({ value }) => value), ...s.credentials]);
  const kind = p.kind === "cut" || p.kind === "complete" ? p.kind : ("legacy-unknown" as const);
  const unit = cut && (["U", "B", "CP"].includes(cut.unit) ? cut.unit : "-");
  const limit = cut && Number.isSafeInteger(cut.limit) ? cut.limit : -1;
  const bounds = cut && { limit, unit, side: cut.side === "tail" ? "tail" : "prefix" };
  const meta = { operation, kind, cut: bounds, terminal: !!input.terminal, entries: s.entries.length };
  return { generation, stream, meta: { ...meta, limits, chunk } };
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const same = (a: object, b: object) =>
  Object.entries(a).every(([key, value]) => Reflect.get(b, key) === value);
const digest = (g: Omit<Generation, "identity">) => `privacy/${g.policy}/${g.credentials}/${g.checker}`;
const failure = (reason: Reason, generation?: Generation, provenance?: b.Provenance): Projection => ({
  text: "[withheld: private text]",
  withheld: true,
  checkedComplete: false,
  truncated: provenance?.kind === "cut" ? true : provenance?.kind === "complete" ? false : undefined,
  policyDigest: generation ? digest(generation) : "privacy/unavailable",
  reason,
});
const reasons = [
  ...b.privacyRefusals,
  ..."private-match unchecked-provenance stale-generation input-length output-length assembly-count forged unreadable-policy invalid-cut json-depth json-nodes checker-busy checker-timeout checker-cancelled checker-failed".split(
    " ",
  ),
];
function projection(value: unknown, generation: Generation): value is Projection {
  if (!record(value)) return false;
  return (
    Object.keys(value).every((key) =>
      ["text", "truncated", "checkedComplete", "withheld", "policyDigest", "reason"].includes(key),
    ) &&
    typeof value.text === "string" &&
    typeof value.checkedComplete === "boolean" &&
    (value.truncated === undefined || typeof value.truncated === "boolean") &&
    value.policyDigest === digest(generation) &&
    (value.withheld === true
      ? value.text === failure("checker-failed").text && reasons.some((reason) => reason === value.reason)
      : value.withheld === false && value.checkedComplete === true && value.reason === undefined)
  );
}
const final =
  "version id direction type sequence generation chunks bytes truncated checkedComplete withheld policyDigest reason";
function operate(f: Final, parts: ArrayBuffer[]) {
  const [text = "", marker = "", ...rest] = t.decodeSegments(parts);
  if (!(f.entries <= rest.length)) t.fault();
  const entries = rest.slice(0, f.entries).map((value, entry) => ({ value, entry }));
  const local = b.createPrivacyRegistry();
  const generation: Generation = { ...f.generation, identity: local.generation.identity };
  const registry = { ...local, generation };
  const snapshot = { entries, credentials: rest.slice(f.entries), generation };
  const policy = b.preparePrivacyPolicy(snapshot, { limits: f.limits });
  const provenance: b.Provenance = f.kind === "cut" ? { kind: "cut", truncated: true } : { kind: f.kind };
  const cut = f.cut && ({ ...f.cut, marker } as b.BoundaryCut);
  const input = { provenance, policy, cut, terminal: f.terminal };
  const result =
    f.operation === "data"
      ? b.protectData({ ...input, json: text }, { registry })
      : b.protectText({ ...input, text }, { registry });
  return b.consumeBoundaryText(result);
}
/** Worker-only handler; reassembly, preparation and the entire synchronous operation stay here. */
export function privacyWorkerHandler(
  port: Pick<PrivacyWorkerPort, "postMessage" | "onmessage">,
  { schedule = setImmediate as t.Schedule } = {},
) {
  let head: Final | undefined;
  let input = t.receiver("request", t.maxChunk, Infinity);
  let output: ReturnType<typeof t.sender> | undefined;
  port.onmessage = ({ data }) => {
    const f = data as Final;
    if (!head && f.direction === "request" && f.type === "chunk" && f.sequence === 0) head = f;
    if (!head || f.version !== t.version || f.id !== head.id || !same(head.generation, f.generation))
      t.fault();
    const { id, generation } = head ?? f;
    const post: t.Post = (step, rest, transfer) => {
      port.postMessage(t.frame(id, generation, step, rest), transfer);
      if (step[0] === "result" && step[1] === "complete") {
        head = output = undefined;
        input = t.receiver("request", t.maxChunk, Infinity);
      }
    };
    if (!output && input.chunk(f)) return post(["request", "ack", f.sequence]);
    if (!output && input.complete(f)) {
      const { text, ...result } = operate(f, input.parts);
      output = t.sender("result", t.encode(text), f.chunk, post, result);
      return schedule(output.turn);
    }
    if (!output?.ack(f, schedule)) t.fault();
  };
}
export function createPrivacyChecker(options: Options = {}) {
  const registry = options.registry ?? b.privacyRegistry;
  const limits = { ...b.privacyLimits, ...options.limits };
  const now = options.now ?? Date.now;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const schedule = options.schedule ?? setImmediate;
  // One checker-wide output window stays reserved inside byteLimit; an output grant occupies it.
  const window = Math.min(t.maxChunk, Math.max(1, Math.trunc(options.outputWindow ?? t.maxChunk)));
  type Finish = (result: Projection | Reason, terminate?: boolean) => void;
  const pending = new Map<Finish, () => Promise<void>>();
  let bytes = 0;
  let granted = 0;
  let sequence = 0;
  let disposed = false;
  let worker: PrivacyWorkerPort | undefined;
  let active: Finish | undefined;
  let retiring = Promise.resolve();
  let running: Promise<void> | undefined;
  const issue = (result: Projection, generation?: Generation) =>
    b.issuePrivacyWorkerResult(result, generation, registry, limits);
  const current = (generation: Generation) => {
    try {
      return same(generation, b.currentPrivacyGeneration(registry));
    } catch {
      return false;
    }
  };
  function retire() {
    const port = worker;
    worker = undefined;
    if (port)
      retiring = (async () => {
        try {
          port.unref();
          await port.terminate();
        } catch {
          disposed = true;
          for (const finish of pending.keys()) finish("checker-failed");
        }
      })();
    return retiring;
  }
  async function pump() {
    while (!disposed && pending.size) {
      await retiring;
      await pending.values().next().value?.();
    }
  }
  function wake() {
    running ??= pump().finally(() => {
      running = undefined;
      if (!disposed && pending.size) wake();
    });
  }
  function submit(operation: Operation, input: Input, signal?: AbortSignal): Promise<b.BoundaryText> {
    let generation: Generation | undefined;
    const refuse = (reason: Reason) =>
      Promise.resolve(issue(failure(reason, generation, input.provenance), generation));
    let snapshot: Snapshot;
    try {
      snapshot = b.capturePrivacySnapshot(registry);
      generation = snapshot.generation;
      if (!current(generation)) return refuse("stale-generation");
    } catch {
      return refuse("unreadable-policy");
    }
    if (disposed) return refuse("checker-failed");
    if (signal?.aborted) return refuse("checker-cancelled");
    const payload = operation === "text" ? input.text : input.json;
    if (typeof payload !== "string") return refuse("nonconvergent");
    if (payload.length > limits.inputUnits || Buffer.byteLength(payload) > limits.inputBytes)
      return refuse("input-length");
    const request = envelope(operation, input, snapshot, limits, window);
    const size = request.stream.size;
    if (pending.size >= (options.maxRequests ?? 8) || size + window > (options.byteLimit ?? 64 << 20) - bytes)
      return refuse("checker-busy");
    input = { ...input, cut: input.cut && { ...input.cut }, provenance: { ...input.provenance } };
    const authority = generation;
    const deadline = now() + (options.deadlineMs ?? 30000);
    const id = ++sequence;
    const result = Promise.withResolvers<b.BoundaryText>();
    let timeout: Parameters<typeof clearTimeout>[0];
    const cancel = () => finish("checker-cancelled", active === finish);
    const finish: Finish = (value, terminate = false) => {
      if (!pending.delete(finish)) return;
      bytes -= size;
      clearTimer(timeout);
      signal?.removeEventListener("abort", cancel);
      if (active === finish) {
        active = undefined;
        granted = 0;
        if (terminate) void retire();
        else worker?.unref();
      }
      result.resolve(
        issue(typeof value === "string" ? failure(value, authority, input.provenance) : value, authority),
      );
    };
    pending.set(finish, async () => {
      active = finish;
      try {
        if (!current(authority)) return finish("stale-generation");
        if (!worker) {
          worker = await options.workerFactory?.();
          if (!worker) throw new Error("Privacy worker unavailable");
          worker.unref();
        }
        if (!pending.has(finish) || disposed) return void (await retire());
        const port = worker;
        port.onerror = () => {
          if (worker === port) {
            finish("checker-failed", true);
            void retire();
          }
        };
        port.onexit = () => {
          if (worker === port) {
            worker = undefined;
            finish("checker-failed");
          }
        };
        const post: t.Post = (step, rest, transfer) => {
          if (worker !== port || active !== finish) return;
          if (step[1] === "complete") granted = window;
          try {
            port.postMessage(t.frame(id, request.generation, step, rest), transfer);
          } catch {
            finish("checker-failed", true);
          }
        };
        const input = t.sender("request", request.stream.bytes, t.maxChunk, post, request.meta);
        const output = t.receiver("result", window, limits.outputBytes);
        const receive = (d: Record<string, unknown>) => {
          if (d.version !== t.version || !same(request.generation, d.generation as object)) return;
          if (input.ack(d, schedule)) return true;
          // Owned and bounded: this ACK returns the chunk's window credit and grants the next one.
          if (granted === window && output.chunk(d))
            return post(["result", "ack", output.parts.length - 1]) ?? true;
          if (!output.complete(d) || !Object.keys(d).every((key) => final.split(" ").includes(key))) return;
          const parts = output.parts.map((part) => new Uint8Array(part));
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts));
          const { truncated, checkedComplete, withheld, policyDigest, reason } = d;
          const result = { text, truncated, checkedComplete, withheld, policyDigest, reason };
          return (
            text.length <= limits.outputUnits && projection(result, authority) && (finish(result) ?? true)
          );
        };
        port.onmessage = ({ data }) => {
          if (worker !== port || !pending.has(finish)) return;
          if (record(data) && "id" in data && data.id !== id) return;
          if (now() >= deadline) return finish("checker-timeout", true);
          if (!current(authority)) return finish("stale-generation", true);
          try {
            if (!record(data) || data.id !== id || !receive(data)) finish("checker-failed", true);
          } catch {
            finish("checker-failed", true);
          }
        };
        if (!current(authority)) return finish("stale-generation");
        if (now() >= deadline) return finish("checker-timeout", true);
        port.ref();
        schedule(input.turn);
        await result.promise;
      } catch {
        finish("checker-failed", true);
      }
    });
    bytes += size;
    timeout = setTimer(() => finish("checker-timeout", active === finish), Math.max(0, deadline - now()));
    signal?.addEventListener("abort", cancel, { once: true });
    wake();
    return result.promise;
  }
  return {
    protectText: (input: TextInput, { signal }: Control = {}) => submit("text", input, signal),
    protectData: (input: DataInput, { signal }: Control = {}) => submit("data", input, signal),
    async dispose() {
      disposed = true;
      for (const finish of pending.keys()) finish("checker-failed", active === finish);
      await retire();
      await running;
    },
  };
}
