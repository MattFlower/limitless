import { parentPort } from "node:worker_threads";
import { PrivateResourceError, preparedPrivateMatches, preparePrivateStrings } from "../gates/private.ts";
import { CredentialMatcher, credentialVariants } from "./credential-matcher.ts";
import {
  type Cut,
  type Metadata,
  type PolicyData,
  type Refusal,
  type Request,
  type ToChecker,
  type Token,
  WITHHELD,
} from "./privacy-boundary-protocol.ts";
import { terminalRedactor } from "./terminal-redaction.ts";

const port = parentPort;
if (!port) throw new Error("Private checker requires a worker");
const EMPTY = new CredentialMatcher(new Map());
const CHUNK = 16 * 1024;
let policyChunks: Uint8Array[] = [];
let chunks: Uint8Array[] = [];
let cached:
  | {
      digest: string;
      private: ReturnType<typeof preparePrivateStrings>;
      credentials: CredentialMatcher;
      form: number;
    }
  | undefined;
let acknowledge: (() => void) | undefined;
const decode = (parts: Uint8Array[]) => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return parts.map((part) => decoder.decode(part, { stream: true })).join("") + decoder.decode();
};
function sourceLength(text: string, unit: Cut["unit"]): number {
  if (unit === "U") return text.length;
  if (unit === "B") return Buffer.byteLength(text);
  let length = 0;
  for (const _char of text) length++;
  return length;
}
function cutText(text: string, cut?: Cut): { text: string; clipped: boolean } {
  if (!cut) return { text, clipped: false };
  const length = sourceLength(text, cut.unit);
  if (length <= cut.limit) return { text, clipped: false };
  if (cut.limit === 0) return { text: "", clipped: true };
  let start = 0;
  let end = text.length;
  if (cut.unit === "B") {
    const bytes = Buffer.from(text);
    if (cut.from === "start") {
      end = cut.limit;
      while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    } else {
      start = bytes.length - cut.limit;
      while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
      end = bytes.length;
    }
    return { text: bytes.subarray(start, end).toString("utf8"), clipped: true };
  }
  if (cut.unit === "CP") {
    let count = 0;
    let offset = 0;
    for (const char of text) {
      if (cut.from === "start" && count === cut.limit) {
        end = offset;
        break;
      }
      if (cut.from === "end" && count === length - cut.limit) {
        start = offset;
        break;
      }
      count++;
      offset += char.length;
    }
  } else if (cut.from === "start") {
    end = cut.limit;
    if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(end))) end--;
  } else {
    start = text.length - cut.limit;
    if (/[\uDC00-\uDFFF]/.test(text.charAt(start)) && /[\uD800-\uDBFF]/.test(text.charAt(start - 1))) start++;
  }
  return { text: text.slice(start, end), clipped: true };
}
function terminal(text: string, matcher: CredentialMatcher): string {
  const stream = terminalRedactor(() => matcher);
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK) pieces.push(stream.push(text.slice(i, i + CHUNK)));
  pieces.push(stream.push("", true));
  return pieces.join("");
}
async function run(request: Request) {
  let scans = 0;
  let compilationMs = 0;
  let metadata: Metadata = {
    truncated: request.truncated,
    checkedComplete: request.checkedComplete,
    withheld: false,
  };
  let output: unknown;
  const refuse = (reason: Refusal) => {
    metadata = { ...metadata, withheld: true, reason };
    return WITHHELD;
  };
  try {
    if (!cached || cached.digest !== request.digest || cached.form !== request.caps.form) {
      const start = performance.now();
      const data = JSON.parse(decode(policyChunks)) as PolicyData;
      cached = {
        digest: request.digest,
        form: request.caps.form,
        private: preparePrivateStrings(
          [...data.entries, ...data.credentials.map((value) => ({ value, entry: -1 }))],
          request.caps.form,
        ),
        credentials: new CredentialMatcher(credentialVariants(data.credentials)),
      };
      compilationMs = performance.now() - start;
    }
    policyChunks = [];
    const policy = cached;
    const text = decode(chunks);
    chunks = [];
    if (text.length > request.caps.input) throw new PrivateResourceError();
    const check = (candidate: string, truncated = false): Refusal | undefined => {
      scans++;
      const hit = preparedPrivateMatches(candidate, policy.private, truncated)[0];
      return hit ? (hit.entry === 0 && hit.value === "" ? "nonconvergence" : "private-match") : undefined;
    };
    const protect = (raw: string): { text: string; metadata: Metadata } => {
      const state: Metadata = {
        truncated: request.truncated,
        checkedComplete: request.checkedComplete,
        withheld: false,
      };
      const deny = (reason: Refusal) => ({ text: WITHHELD, metadata: { ...state, withheld: true, reason } });
      try {
        if (!raw.isWellFormed()) return deny("invalid-input-encoding");
        if (request.mode === "cut") {
          const cut = cutText(raw, request.cut);
          if (cut.clipped) state.truncated = true;
          const reason = check(cut.text, state.truncated === true);
          return reason ? deny(reason) : { text: cut.text, metadata: state };
        }
        // Determine actual clipping even if a prior check refuses the value.
        if (request.cut && sourceLength(raw, request.cut.unit) > request.cut.limit) state.truncated = true;
        let reason = check(raw, request.truncated === true);
        if (reason) return deny(reason);
        state.checkedComplete ||= request.truncated === false;
        const visible = request.terminal ? terminal(raw, EMPTY) : raw;
        if (visible !== raw) {
          reason = check(visible, request.truncated === true);
          if (reason) return deny(reason);
        }
        const redacted = request.terminal
          ? terminal(raw, policy.credentials)
          : policy.credentials.redact(raw);
        const cut = cutText(redacted, request.cut);
        state.truncated = request.truncated === true || cut.clipped ? true : request.truncated;
        if (cut.text !== raw || request.truncated === true) {
          reason = check(cut.text, state.truncated === true);
          if (reason) return deny(reason);
        }
        return { text: cut.text, metadata: state };
      } catch (error) {
        return deny(error instanceof PrivateResourceError ? "resource-refusal" : "checker-unavailable");
      }
    };
    if (request.mode === "text" || request.mode === "cut") {
      const result = protect(text);
      output = result.text;
      metadata = result.metadata;
    } else {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        if (request.mode !== "json") throw new Error("Invalid checker data");
        const result = protect(text);
        output = result.text;
        metadata = result.metadata;
      }
      if (output === undefined) {
        const visit = (value: unknown, depth = 0): unknown => {
          if (depth > 128) throw new PrivateResourceError();
          if (typeof value === "string" || typeof value === "number") {
            const result = protect(String(value));
            return result.metadata.withheld ? WITHHELD : typeof value === "number" ? value : result.text;
          }
          if (Array.isArray(value)) return value.map((field) => visit(field, depth + 1));
          if (value && typeof value === "object") {
            const result: Record<string, unknown> = {};
            for (const [name, field] of Object.entries(value)) {
              const key = protect(name);
              if (key.metadata.withheld || Object.hasOwn(result, key.text)) return WITHHELD;
              Object.defineProperty(result, key.text, { value: visit(field, depth + 1), enumerable: true });
            }
            return result;
          }
          return value;
        };
        output = visit(data);
      }
    }
  } catch (error) {
    policyChunks = [];
    chunks = [];
    output = refuse(
      error instanceof PrivateResourceError
        ? "resource-refusal"
        : error instanceof TypeError
          ? "invalid-input-encoding"
          : "checker-unavailable",
    );
  }
  // Backpressure bounds output buffering on both threads, including graphs with many tiny fields.
  let batch: Token[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const ready = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    port?.postMessage(
      { kind: "batch", tokens: batch },
      batch.flatMap((token) => ("buffer" in token ? [token.buffer] : [])),
    );
    batch = [];
    await ready;
  };
  const emit = async (token: Token) => {
    batch.push(token);
    if (batch.length >= 32 || "buffer" in token) await flush();
  };
  const string = async (value: string, kind: "scalar" | "key") => {
    for (let i = 0; i < value.length || i === 0; ) {
      let end = Math.min(value.length, i + CHUNK);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value.charAt(end - 1))) end--;
      const buffer = new TextEncoder().encode(value.slice(i, end)).buffer;
      await emit({ kind, buffer, last: end === value.length });
      i = end;
      if (i === value.length) break;
    }
  };
  const transmit = async (value: unknown): Promise<void> => {
    if (typeof value === "string") await string(value, "scalar");
    else if (value && typeof value === "object") {
      await emit({ kind: Array.isArray(value) ? "array" : "object" });
      if (Array.isArray(value)) for (const field of value) await transmit(field);
      else
        for (const [name, field] of Object.entries(value)) {
          await string(name, "key");
          await transmit(field);
        }
      await emit({ kind: "end" });
    } else await emit({ kind: "value", value: value as number | boolean | null });
  };
  await transmit(output);
  await flush();
  port?.postMessage({
    kind: "done",
    metadata,
    scans,
    compilationMs,
    prepared: cached?.digest === request.digest && cached.form === request.caps.form,
  });
}
port.on("message", (message: ToChecker | { kind: "ack" }) => {
  if (message.kind === "ack") {
    acknowledge?.();
    acknowledge = undefined;
  } else if (message.kind === "chunk")
    (message.policy ? policyChunks : chunks).push(new Uint8Array(message.buffer));
  else void run(message.request);
});
