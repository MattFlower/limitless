import type { Worker } from "node:worker_threads";
import * as b from "./privacy-boundary.ts";

type Generation = ReturnType<typeof b.currentPrivacyGeneration>;
type Snapshot = ReturnType<typeof b.capturePrivacySnapshot>;
type Projection = ReturnType<typeof b.consumeBoundaryText>;
type Reason = NonNullable<Projection["reason"]>;
type TextInput = Omit<Parameters<typeof b.protectText>[0], "policy">;
type DataInput = Omit<Parameters<typeof b.protectData>[0], "policy">;
type Input = Omit<TextInput, "text"> & { text?: string; json?: unknown };
type Operation = "text" | "data";
type Control = { signal?: AbortSignal };
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
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: typeof clearTimeout;
};
function envelope(id: number, operation: Operation, input: Input, s: Snapshot, limits: Options["limits"]) {
  const { generation: original, ...policy } = s;
  const { identity: _identity, ...generation } = original;
  return { version: 1, id, sequence: 0, generation, operation, input, snapshot: policy, limits };
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const same = (a: object, b: object) =>
  Object.entries(a).every(([key, value]) => Reflect.get(b, key) === value);
const digest = (g: Omit<Generation, "identity">) => `privacy/${g.policy}/${g.credentials}/${g.checker}`;
const failure = (reason: Reason, generation?: Generation): Projection => ({
  text: "[withheld: private text]",
  withheld: true,
  checkedComplete: false,
  truncated: false,
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
    typeof value.text === "string" &&
    typeof value.checkedComplete === "boolean" &&
    (value.truncated === undefined || typeof value.truncated === "boolean") &&
    value.policyDigest === digest(generation) &&
    (value.withheld === true
      ? value.text === failure("checker-failed").text && reasons.some((reason) => reason === value.reason)
      : value.withheld === false && value.checkedComplete === true && value.reason === undefined)
  );
}
/** Worker-only handler; preparation and the entire synchronous operation stay here. */
export function privacyWorkerHandler(port: Pick<PrivacyWorkerPort, "postMessage" | "onmessage">) {
  port.onmessage = ({ data }) => {
    const request = data as ReturnType<typeof envelope>;
    if (request.version !== 1 || request.sequence !== 0) throw new Error("Invalid privacy request");
    const local = b.createPrivacyRegistry();
    const generation: Generation = { ...request.generation, identity: local.generation.identity };
    const registry = { ...local, generation };
    const policy = b.preparePrivacyPolicy({ ...request.snapshot, generation }, { limits: request.limits });
    const input = { ...request.input, policy };
    const result =
      request.operation === "data"
        ? b.protectData({ ...input, json: input.json }, { registry })
        : b.protectText({ ...input, text: input.text ?? "" }, { registry });
    const output = b.consumeBoundaryText(result);
    const { version, id, generation: wire } = request;
    port.postMessage({ version, id, generation: wire, sequence: 1, type: "complete", result: output });
  };
}
export function createPrivacyChecker(options: Options = {}) {
  const registry = options.registry ?? b.privacyRegistry;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  type Finish = (result: Projection | Reason, terminate?: boolean) => void;
  const pending = new Map<Finish, () => Promise<void>>();
  let bytes = 0;
  let sequence = 0;
  let disposed = false;
  let worker: PrivacyWorkerPort | undefined;
  let active: Finish | undefined;
  let retiring = Promise.resolve();
  let running: Promise<void> | undefined;
  const issue = (result: Projection, generation?: Generation) =>
    b.issuePrivacyWorkerResult(result, generation, registry);
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
    const refuse = (reason: Reason) => Promise.resolve(issue(failure(reason, generation), generation));
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
    const size = Buffer.byteLength(payload);
    if (pending.size >= (options.maxRequests ?? 8) || size > (options.byteLimit ?? Infinity) - bytes)
      return refuse("checker-busy");
    input = { ...input, cut: input.cut && { ...input.cut }, provenance: { ...input.provenance } };
    const authority = generation;
    const deadline = now() + (options.deadlineMs ?? 30000);
    const request = envelope(++sequence, operation, input, snapshot, options.limits);
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
        if (terminate) void retire();
        else worker?.unref();
      }
      result.resolve(issue(typeof value === "string" ? failure(value, authority) : value, authority));
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
        port.onmessage = ({ data }) => {
          if (worker !== port || !pending.has(finish)) return;
          if (record(data) && "id" in data && data.id !== request.id) return;
          if (now() >= deadline) return finish("checker-timeout", true);
          if (!current(authority)) return finish("stale-generation");
          if (
            !record(data) ||
            data.id !== request.id ||
            data.version !== 1 ||
            data.sequence !== 1 ||
            !record(data.generation) ||
            !same(request.generation, data.generation) ||
            data.type !== "complete" ||
            !projection(data.result, authority)
          )
            finish("checker-failed", true);
          else finish(data.result);
        };
        if (!current(authority)) return finish("stale-generation");
        if (now() >= deadline) return finish("checker-timeout", true);
        port.ref();
        port.postMessage(request);
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
