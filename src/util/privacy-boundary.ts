import { createHmac, randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import { loadPrivateStrings, type PrivateStrings } from "../gates/private.ts";
import {
  type Caps,
  type Cut,
  type FromChecker,
  type Metadata,
  type PolicyData,
  type Refusal,
  type Request,
  WITHHELD,
} from "./privacy-boundary-protocol.ts";
import { activity } from "./stall.ts";

export { type Cut, type Refusal, WITHHELD } from "./privacy-boundary-protocol.ts";
export type Provenance =
  | { kind: "complete" }
  | { kind: "cut"; truncated: true; source?: BoundaryText }
  | { kind: "legacy-unknown" };
export type BoundaryPolicy = Readonly<{ policyDigest: string }>;
export type BoundaryText = Readonly<Metadata & { text: string; policyDigest: string }> & {
  readonly [brand]: true;
};
declare const brand: unique symbol;
const policies = new WeakMap<BoundaryPolicy, PolicyData>();
const policySizes = new WeakMap<BoundaryPolicy, number>();
const issued = new WeakMap<BoundaryText, BoundaryPolicy | null>();
const key = randomBytes(32);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const CHUNK = 16 * 1024;

/** JSON-compatible data only: no getters, proxies, cycles or non-finite numbers. Small tokens keep
 * escaping, encoding and hashing off a single large synchronous serialization path. */
async function* jsonPieces(value: unknown): AsyncGenerator<string> {
  const ancestors = new Set<object>();
  function* tokens(v: unknown): Generator<string> {
    if (typeof v === "string") {
      yield '"';
      for (let i = 0; i < v.length; ) {
        let end = Math.min(v.length, i + CHUNK);
        if (end < v.length && /[\uD800-\uDBFF]/.test(v.charAt(end - 1))) end--;
        const piece = v.slice(i, end);
        if (!piece.isWellFormed()) throw new Error("invalid-input-encoding");
        yield JSON.stringify(piece).slice(1, -1);
        i = end;
      }
      yield '"';
    } else if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) {
      yield String(v);
    } else if (typeof v === "object" && v && !ancestors.has(v) && ancestors.size < 128) {
      // Only plain objects and arrays: no inherited enumerable graph to walk before refusing.
      const prototype = Object.getPrototypeOf(v);
      if (
        Array.isArray(v)
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      )
        throw new Error("resource-refusal");
      ancestors.add(v);
      yield Array.isArray(v) ? "[" : "{";
      let first = true;
      if (Array.isArray(v)) {
        for (const field of v) {
          if (!first) yield ",";
          first = false;
          yield* tokens(field);
        }
      } else {
        for (const name in v) {
          if (!Object.hasOwn(v, name)) {
            // Discarded (polluted) names still pass the yield and elapsed-time checks below.
            yield "";
            continue;
          }
          if (!first) yield ",";
          first = false;
          yield* tokens(name);
          yield ":";
          yield* tokens((v as Record<string, unknown>)[name]);
        }
      }
      yield Array.isArray(v) ? "]" : "}";
      ancestors.delete(v);
    } else throw new Error("resource-refusal");
  }
  let batch = "";
  let start = performance.now();
  for (const token of tokens(value)) {
    batch += token;
    if (batch.length >= CHUNK || performance.now() - start >= 4) {
      if (batch) yield batch;
      batch = "";
      await turn();
      start = performance.now();
    }
  }
  if (batch) yield batch;
}

/** Snapshots are held privately; the public handle and its keyed digest contain no policy text. */
export async function preparePrivacyPolicy(input: {
  entries: PrivateStrings;
  credentials: readonly string[];
}): Promise<BoundaryPolicy> {
  const snapshot: PolicyData = { entries: [], credentials: [] };
  let size = 0;
  for (const entry of input.entries) {
    size += entry.value.length;
    if (size > 32 * 1024 * 1024 || snapshot.entries.length + snapshot.credentials.length >= 16_384)
      throw new Error("resource-refusal");
    snapshot.entries.push({ value: entry.value, entry: entry.entry });
    if (snapshot.entries.length % 256 === 0) await turn();
  }
  const seen = new Set<string>();
  for (const value of input.credentials) {
    size += value.length;
    if (size > 32 * 1024 * 1024 || snapshot.entries.length + snapshot.credentials.length >= 16_384)
      throw new Error("resource-refusal");
    if (value && !seen.has(value)) {
      seen.add(value);
      snapshot.credentials.push(value);
    }
    if (seen.size % 256 === 0) await turn();
  }
  const hash = createHmac("sha256", key);
  let bytes = 0;
  for await (const piece of jsonPieces(snapshot)) {
    hash.update(piece);
    bytes += Buffer.byteLength(piece);
  }
  const policy = Object.freeze({ policyDigest: hash.digest("hex") });
  policies.set(policy, snapshot);
  policySizes.set(policy, bytes);
  return policy;
}

export async function loadBoundaryPolicy(): Promise<BoundaryPolicy | null> {
  try {
    // The worker imports neither this loader nor proc's global registration state.
    const { registeredCredentials } = await import("./proc.ts");
    return await preparePrivacyPolicy({
      entries: loadPrivateStrings(),
      credentials: registeredCredentials(),
    });
  } catch {
    return null;
  }
}

function boundary(text: string, metadata: Metadata, policy: BoundaryPolicy | null): BoundaryText {
  const result = Object.freeze({
    text,
    ...metadata,
    policyDigest: policy?.policyDigest ?? "",
  }) as BoundaryText;
  issued.set(result, policy);
  return result;
}
const refused = (
  reason: Refusal,
  truncated: boolean | undefined,
  policy: BoundaryPolicy | null,
  checkedComplete = false,
) => boundary(WITHHELD, { withheld: true, reason, truncated, checkedComplete }, policy);

type Job = {
  request: Request;
  policy: BoundaryPolicy;
  value: unknown;
  bytes: number;
  resolve: (result: unknown) => void;
};
type Slot = { worker: Worker; digest?: string; job?: Job; timer?: ReturnType<typeof setTimeout> };
export type BoundaryOptions = {
  caps?: Partial<Caps>;
  workers?: number;
  workerPath?: string | URL;
};

/** One active request per worker, bounded reservations for queued/active inputs, and one prepared
 * policy per worker. Workers never keep an idle process alive; a pending request has a deadline. */
export function createPrivacyBoundary(options: BoundaryOptions = {}) {
  const limits: Caps = { input: 8 * 1024 * 1024, form: 32 * 1024 * 1024, pending: 64 * 1024 * 1024 };
  const caps: Caps = { ...limits };
  for (const name of ["input", "form", "pending"] as const) {
    const value = options.caps?.[name] ?? limits[name];
    if (!Number.isSafeInteger(value) || value < 0 || value > limits[name])
      throw new Error("resource-refusal");
    caps[name] = value;
  }
  const maximum = Number.isFinite(options.workers)
    ? Math.max(1, Math.min(2, Math.floor(options.workers ?? 1)))
    : 1;
  let workerPath = options.workerPath ?? new URL("./privacy-boundary-worker.ts", import.meta.url);
  const slots = new Set<Slot>();
  const queue: Job[] = [];
  let pending = 0;
  const stats = { scans: 0, compilationMs: 0 };
  const failure = (job: Job, reason: Refusal) =>
    job.request.mode === "text" || job.request.mode === "cut"
      ? refused(reason, job.request.truncated, job.policy, job.request.checkedComplete)
      : WITHHELD;
  const finish = (slot: Slot, result: unknown) => {
    const job = slot.job;
    if (!job) return;
    clearTimeout(slot.timer);
    slot.job = undefined;
    pending -= job.bytes;
    job.resolve(result);
    pump();
  };
  const broken = (slot: Slot, reason: Refusal = "checker-unavailable") => {
    if (!slots.delete(slot)) return;
    // Drop queued work too: a checker failure cannot leave callers waiting behind a dead worker.
    for (const job of queue.splice(0)) {
      pending -= job.bytes;
      job.resolve(failure(job, "checker-unavailable"));
    }
    if (slot.job) finish(slot, failure(slot.job, reason));
    void slot.worker.terminate();
  };
  async function send(slot: Slot, job: Job) {
    const post = (piece: string, policy: boolean) =>
      activity("privacy.transfer", () => {
        const buffer = new TextEncoder().encode(piece).buffer;
        slot.worker.postMessage({ kind: "chunk", buffer, policy }, [buffer]);
      });
    try {
      if (slot.digest !== job.policy.policyDigest) {
        for await (const piece of jsonPieces(policies.get(job.policy))) {
          if (slot.job !== job) return;
          post(piece, true);
        }
        slot.digest = job.policy.policyDigest;
      }
      let units = 0;
      if (typeof job.value === "string" && job.request.mode !== "data") {
        for (let i = 0; i < job.value.length; ) {
          if (slot.job !== job) return;
          let end = Math.min(job.value.length, i + CHUNK);
          if (end < job.value.length && /[\uD800-\uDBFF]/.test(job.value.charAt(end - 1))) end--;
          activity("privacy.input", () => {
            const piece = (job.value as string).slice(i, end);
            if (!piece.isWellFormed()) throw new Error("invalid-input-encoding");
            post(piece, false);
          });
          i = end;
          await turn();
        }
      } else {
        for await (const piece of jsonPieces(job.value)) {
          if (slot.job !== job) return;
          units += piece.length;
          if (units > caps.input) throw new Error("resource-refusal");
          post(piece, false);
        }
      }
      if (slot.job === job) slot.worker.postMessage({ kind: "run", request: job.request });
    } catch (error) {
      broken(
        slot,
        error instanceof Error && error.message === "invalid-input-encoding"
          ? "invalid-input-encoding"
          : "resource-refusal",
      );
    }
  }
  function spawn(): Slot {
    const worker = new Worker(workerPath);
    const slot: Slot = { worker };
    slots.add(slot);
    let root: unknown;
    const stack: { value: unknown[] | Record<string, unknown>; key?: string }[] = [];
    let scalar = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const attach = (value: unknown) => {
      const parent = stack.at(-1);
      if (!parent) root = value;
      else if (Array.isArray(parent.value)) parent.value.push(value);
      else if (parent.key !== undefined) {
        Object.defineProperty(parent.value, parent.key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        parent.key = undefined;
      } else throw new Error("Invalid checker response");
    };
    const receive = (message: FromChecker) => {
      if (!slot.job) return;
      try {
        activity("privacy.result", () => {
          switch (message.kind) {
            case "batch":
              for (const token of message.tokens) receive(token);
              setImmediate(() => {
                if (slots.has(slot)) worker.postMessage({ kind: "ack" });
              });
              break;
            case "object":
            case "array": {
              const value = message.kind === "object" ? {} : [];
              attach(value);
              stack.push({ value });
              break;
            }
            case "end":
              stack.pop();
              break;
            case "value":
              attach(message.value);
              break;
            case "scalar":
            case "key":
              scalar += decoder.decode(message.buffer, { stream: !message.last });
              if (message.last) {
                if (message.kind === "key") {
                  const parent = stack.at(-1);
                  if (!parent) throw new Error("Invalid checker response");
                  parent.key = scalar;
                } else attach(scalar);
                scalar = "";
              }
              break;
            case "done": {
              const job = slot.job;
              if (!job) return;
              stats.scans += message.scans;
              stats.compilationMs += message.compilationMs;
              slot.digest = message.prepared ? job.policy.policyDigest : undefined;
              const result =
                job.request.mode === "text" || job.request.mode === "cut"
                  ? boundary(typeof root === "string" ? root : WITHHELD, message.metadata, job.policy)
                  : root;
              root = undefined;
              stack.length = 0;
              finish(slot, result);
            }
          }
        });
      } catch {
        broken(slot);
      }
    };
    worker.on("message", receive);
    worker.on("error", () => broken(slot));
    worker.on("exit", () => broken(slot));
    worker.unref();
    return slot;
  }
  function pump() {
    while (queue.length) {
      let slot = [...slots].find((candidate) => !candidate.job);
      if (!slot && slots.size < maximum) {
        try {
          slot = spawn();
        } catch {
          for (const job of queue.splice(0)) {
            pending -= job.bytes;
            job.resolve(failure(job, "checker-unavailable"));
          }
          return;
        }
      }
      if (!slot) return;
      const job = queue.shift();
      if (!job) return;
      slot.job = job;
      slot.timer = setTimeout(() => broken(slot), 120_000);
      void send(slot, job);
    }
  }
  function submit(
    value: unknown,
    provenance: Provenance,
    policy: BoundaryPolicy | null,
    mode: Request["mode"],
    cut?: Cut,
    terminal?: boolean,
    prior?: BoundaryText,
  ): Promise<unknown> {
    const previous = provenance.kind === "cut" ? provenance.source : undefined;
    const genuine =
      previous &&
      issued.has(previous) &&
      !previous.withheld &&
      issued.get(previous)?.policyDigest === policy?.policyDigest;
    const truncated = prior
      ? prior.truncated
      : provenance.kind === "complete"
        ? false
        : provenance.kind === "cut"
          ? true
          : undefined;
    const deny = (reason: Refusal) =>
      Promise.resolve(mode === "text" || mode === "cut" ? refused(reason, truncated, policy) : WITHHELD);
    if (!policy || !policies.has(policy)) return deny("policy-unreadable");
    if (provenance.kind === "legacy-unknown" || (provenance.kind === "cut" && !genuine))
      return deny("unverified-provenance");
    if (
      cut &&
      (!Number.isSafeInteger(cut.limit) ||
        cut.limit < 0 ||
        !["U", "B", "CP"].includes(cut.unit) ||
        !["start", "end"].includes(cut.from))
    )
      return deny("resource-refusal");
    const units = typeof value === "string" ? value.length : caps.input;
    const snapshot = policies.get(policy);
    if (!snapshot) return deny("policy-unreadable");
    const bytes = 3 * units + (policySizes.get(policy) ?? caps.pending);
    if (units > caps.input || bytes > caps.pending - pending || queue.length >= 64)
      return deny("resource-refusal");
    pending += bytes;
    return new Promise((resolve) => {
      queue.push({
        value,
        policy,
        bytes,
        resolve,
        request: {
          mode,
          caps,
          digest: policy.policyDigest,
          cut,
          terminal,
          truncated,
          checkedComplete: prior?.checkedComplete ?? !!genuine,
        },
      });
      pump();
    });
  }
  const protectText = async (input: {
    text: string;
    provenance: Provenance;
    policy: BoundaryPolicy | null;
    cut?: Cut;
    terminal?: boolean;
  }): Promise<BoundaryText> =>
    (await submit(
      input.text,
      input.provenance,
      input.policy,
      "text",
      input.cut,
      input.terminal,
    )) as BoundaryText;
  const cutBoundaryText = async (
    source: BoundaryText,
    cut: Cut,
    policy = issued.get(source) ?? null,
  ): Promise<BoundaryText> => {
    if (!issued.has(source) || source.withheld || issued.get(source)?.policyDigest !== policy?.policyDigest)
      return refused("unverified-provenance", issued.has(source) ? source.truncated : undefined, policy);
    // Unlike cut provenance, a second operation has not necessarily clipped anything yet.
    const result = (await submit(
      source.text,
      { kind: "complete" },
      policy,
      "cut",
      cut,
      false,
      source,
    )) as BoundaryText;
    return boundary(
      result.text,
      {
        ...result,
        truncated: source.truncated === true || result.truncated === true ? true : source.truncated,
        checkedComplete: source.checkedComplete,
      },
      policy,
    );
  };
  return {
    protectText,
    cutBoundaryText,
    get stats() {
      return { ...stats };
    },
    protectData: (value: unknown, provenance: Provenance, policy: BoundaryPolicy | null) =>
      submit(value, provenance, policy, "data"),
    protectJsonText: (text: string, provenance: Provenance, policy: BoundaryPolicy | null) =>
      submit(text, provenance, policy, "json"),
    setWorkerPath(path: string | URL) {
      workerPath = path;
      for (const slot of [...slots]) broken(slot);
    },
  };
}
const defaults = createPrivacyBoundary();
export const { protectText, cutBoundaryText, protectData, protectJsonText } = defaults;
