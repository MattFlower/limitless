import { fail } from "node:assert";
/** Internal stop-and-wait framing between the privacy checker and its worker; never persisted. */
export const version = 2;
export const maxChunk = 32 * 1024;
type Wire = { policy: number; credentials: number; checker: number };
type Direction = "request" | "result";
export type Frame = { version: number; id: number; direction: Direction; sequence: number; generation: Wire };
type Step = [direction: Direction, type: "chunk" | "ack" | "complete", sequence: number];
export type Post = (step: Step, rest?: object, transfer?: ArrayBuffer[]) => void;
export type Schedule = (turn: () => void) => void;
type Received = Record<string, unknown>;
export function frame(id: number, generation: Wire, [direction, type, sequence]: Step, rest = {}) {
  return { version, id, direction, type, sequence, generation, ...rest };
}
/** Lazy UTF-8 that keeps lone surrogates as 3-byte sequences, so the worker can refuse them itself. */
export function* encode(text: string) {
  for (const char of text) {
    const c = char.codePointAt(0) ?? 0;
    if (c < 0x80) yield c;
    else if (c < 0x800) yield* [0xc0 | (c >> 6), 0x80 | (c & 63)];
    else if (c < 0x10000) yield* [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
    else yield* [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
  }
}
export function segments(texts: string[]) {
  const bytes = function* () {
    for (const text of texts) {
      const n = Buffer.byteLength(text);
      yield* [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
      yield* encode(text);
    }
  };
  return { size: texts.reduce((total, text) => total + 4 + Buffer.byteLength(text), 0), bytes: bytes() };
}
export function sender(direction: Direction, bytes: Iterator<number>, max: number, post: Post, end: object) {
  let sent = 0;
  let size = 0;
  let waiting = false;
  const turn = () => {
    const chunk = new Uint8Array(max);
    let n = 0;
    for (let next = bytes.next(); !next.done; next = n < max ? bytes.next() : { done: true, value: 0 })
      chunk[n++] = next.value;
    waiting = n > 0;
    if (!n) return post([direction, "complete", sent], { chunks: sent, bytes: size, ...end });
    const payload = chunk.slice(0, n).buffer;
    size += n;
    post([direction, "chunk", sent++], { payload }, [payload]);
  };
  const ack = (f: Received, schedule: Schedule) => {
    if (f.direction !== direction || f.type !== "ack" || !waiting || f.sequence !== sent - 1) return false;
    waiting = false;
    schedule(turn);
    return true;
  };
  return { turn, ack };
}
export function receiver(direction: Direction, max: number, cap: number) {
  const parts: ArrayBuffer[] = [];
  let size = 0;
  const at = (f: Received, type: string) =>
    f.direction === direction && f.type === type && f.sequence === parts.length;
  const chunk = ({ payload, ...f }: Received) => {
    if (!at(f, "chunk") || Object.keys(f).length !== 6 || !(payload instanceof ArrayBuffer)) return false;
    if (!payload.byteLength || payload.byteLength > max || size + payload.byteLength > cap) return false;
    size += payload.byteLength;
    return parts.push(payload) > 0;
  };
  const complete = (f: Received) => at(f, "complete") && f.chunks === parts.length && f.bytes === size;
  return { chunk, complete, parts };
}
export const fault = (): never => fail("Malformed privacy payload");
export function decodeSegments(parts: ArrayBuffer[]) {
  const bytes = join(parts);
  const texts: string[] = [];
  for (let i = 0, end = 0; i < bytes.length; i = end) {
    end = i + 4 + bytes.readUInt32BE(i);
    texts.push(decode(end <= bytes.length ? bytes.subarray(i + 4, end) : fault()));
  }
  return texts;
}
export const join = (parts: ArrayBuffer[]) => Buffer.concat(parts.map((part) => new Uint8Array(part)));
/** Lenient decoding is safe because only the exact canonical re-encoding is accepted. */
function decode(bytes: Uint8Array) {
  let text = "";
  for (let i = 0, extra = 0; i < bytes.length; i += 1 + extra) {
    const lead = bytes[i] ?? 0;
    extra = lead < 0xc0 ? 0 : lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3;
    let code = extra ? lead & (0x3f >> extra) : lead;
    for (const next of bytes.subarray(i + 1, i + 1 + extra)) code = (code << 6) | (next & 63);
    text += String.fromCodePoint(code);
  }
  let i = 0;
  for (const byte of encode(text)) if (byte !== bytes[i++]) fault();
  return i === bytes.length ? text : fault();
}
