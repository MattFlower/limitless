import { isDeepStrictEqual } from "node:util";
import type { Worker } from "node:worker_threads";
import * as b from "./privacy-boundary.ts";
import * as c from "./privacy-chunks.ts";
import * as t from "./privacy-transport.ts";

type Generation = ReturnType<typeof b.currentPrivacyGeneration>;
type Snapshot = ReturnType<typeof b.capturePrivacySnapshot>;
type Projection = Omit<ReturnType<typeof b.consumeBoundaryText>, "text">;
type Reason = NonNullable<Projection["reason"]>;
type TextInput = Omit<Parameters<typeof b.protectText>[0], "policy">;
type DataInput = Omit<Parameters<typeof b.protectData>[0], "policy">;
type Input = Omit<TextInput, "text"> & { text?: string; json?: unknown };
type Operation = "text" | "data";
type Control = { signal?: AbortSignal };
type Final = t.Frame & ReturnType<typeof fixed> & { type: string };
type Side = Pick<PrivacyWorkerPort, "postMessage" | "onmessage">;
type Fixed = Record<string, unknown> & { cut?: Partial<b.BoundaryCut> };
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
/** Bounded fixed metadata (strings travel as payload segments); a valid request-final is its own normal form. */
function fixed({ operation, kind, cut, terminal, entries, limits, chunk }: Fixed) {
  const n = (v: unknown, max?: number) => (int(v, max) ? Number(v) : (Symbol() as never));
  const unit = cut && (["U", "B", "CP"].includes(cut.unit as string) ? cut.unit : "-");
  const limit = cut && Number.isSafeInteger(cut.limit) ? cut.limit : -1;
  const bounds = cut && { limit, unit, side: cut.side === "tail" ? "tail" : "prefix" };
  const fixedLimits = Object.keys(b.privacyLimits).map((key) => [key, n(Reflect.get(Object(limits), key))]);
  return {
    operation: operation === "data" ? operation : ("text" as const),
    kind: (kind === "cut" || kind === "complete" ? kind : "legacy-unknown") as b.Provenance["kind"],
    ...{ cut: bounds, terminal: !!terminal, entries: n(entries), chunk: n(chunk, t.maxChunk) || n(-1) },
    limits: Object.fromEntries(fixedLimits) as typeof b.privacyLimits,
  };
}
function envelope(operation: Operation, input: Input, s: Snapshot, limits: object, chunk: number) {
  const { identity: _identity, ...generation } = s.generation;
  const texts = [String(operation === "text" ? input.text : input.json), String(input.cut?.marker ?? "")];
  const stream = t.segments([...texts, ...s.entries.map(({ value }) => value), ...s.credentials]);
  const meta = { ...input, operation, kind: input.provenance.kind, entries: s.entries.length, limits, chunk };
  return { generation, stream, meta: fixed(meta) };
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const same = (a: object, b: object) =>
  Object.entries(a).every(([key, value]) => Reflect.get(b, key) === value);
const int = (v: unknown, max = 2 ** 53) => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;
const wire = (g: unknown, like: object) =>
  isDeepStrictEqual(g, like) &&
  `${Object.entries(like).map(([key, n]) => int(n) && key)}` === "policy,credentials,checker";
const marker = new TextEncoder().encode("[withheld: private text]");
const digest = (g: Omit<Generation, "identity">) => `privacy/${g.policy}/${g.credentials}/${g.checker}`;
const failure = (reason: Reason, generation?: Generation, provenance?: b.Provenance): Projection => ({
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
      ["truncated", "checkedComplete", "withheld", "policyDigest", "reason"].includes(key),
    ) &&
    typeof value.checkedComplete === "boolean" &&
    (value.truncated === undefined || typeof value.truncated === "boolean") &&
    value.policyDigest === digest(generation) &&
    (value.withheld === true
      ? reasons.some((reason) => reason === value.reason)
      : value.withheld === false && value.checkedComplete === true && value.reason === undefined)
  );
}
const final =
  "version id direction type sequence generation chunks bytes truncated checkedComplete withheld policyDigest reason";
function operate(f: Final, parts: ArrayBuffer[]) {
  if (Object.keys(f).length !== 15 || !isDeepStrictEqual(f, { ...f, ...fixed(f as Fixed) })) t.fault();
  const [text = "", marker, ...rest] = t.decodeSegments(parts);
  if (marker === undefined || !(f.entries <= rest.length)) t.fault();
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
/** Worker-only handler; preparation and the entire synchronous operation stay here. */
export function privacyWorkerHandler(port: Side, { schedule = setImmediate as t.Schedule } = {}) {
  let head: Final | undefined;
  let last = 0; // Daemon IDs only increase: frames for another or a finished request are ignored.
  let input = t.receiver("request", t.maxChunk, Infinity);
  let output: ReturnType<typeof t.sender> | undefined;
  port.onmessage = ({ data }) => {
    const f = data as Final;
    if (head ? f.id !== head.id : f.id <= last) return;
    if (!head && f.direction === "request" && f.type === "chunk" && f.sequence === 0) head = f;
    if (!head || f.version !== t.version || !wire(f.generation, head.generation)) t.fault();
    const { id, generation } = head ?? f;
    last = id;
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
  const issue = (result: Projection, generation?: Generation, parts?: ArrayBuffer[]) =>
    c.issuePrivacyWorkerChunks(parts, result, generation, registry);
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
  function submit(operation: Operation, input: Input, signal?: AbortSignal): Promise<c.BoundaryChunks> {
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
    const result = Promise.withResolvers<c.BoundaryChunks>();
    let staged: ArrayBuffer[] | undefined;
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
      if (typeof value === "string" && staged) staged.length = 0;
      result.resolve(
        issue(
          typeof value === "string" ? failure(value, authority, input.provenance) : value,
          authority,
          typeof value === "string" ? undefined : staged,
        ),
      );
      staged = undefined;
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
        const output = t.receiver("result", window, limits.outputBytes, limits.outputUnits);
        staged = output.parts;
        let markerBytes = 0,
          markerMismatch = 0;
        const receive = (d: Record<string, unknown>) => {
          if (d.version !== t.version || !wire(d.generation, request.generation)) return;
          if (input.ack(d, schedule)) return true;
          if (granted !== window) return; // Output needs the request sent, then each chunk's window credit.
          if (output.chunk(d)) {
            const payload = new Uint8Array(d.payload as ArrayBuffer);
            for (let i = 0; i < Math.min(payload.length, marker.length - markerBytes); i++)
              markerMismatch |= (payload[i] ?? 0) ^ (marker[markerBytes + i] ?? 0);
            markerBytes = Math.min(marker.length + 1, markerBytes + payload.length);
            return post(["result", "ack", output.parts.length - 1]) ?? true;
          }
          if (!output.complete(d) || !Object.keys(d).every((key) => final.split(" ").includes(key))) return;
          const { truncated, checkedComplete, withheld, policyDigest, reason } = d;
          const value = { truncated, checkedComplete, withheld, policyDigest, reason };
          if (withheld && (markerBytes !== marker.length || markerMismatch !== 0)) return;
          return projection(value, authority) && (finish(value) ?? true);
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
