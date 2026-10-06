import { brotliDecompressSync, inflateSync } from "node:zlib";

// Unsupported structures and metadata stay opaque. Limit input and decompression so an
// exemption never depends on a truncated read or unbounded allocation.
export const MEDIA_LIMIT = 32 * 1024 * 1024;
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const PAYLOADS = [
  "504b0304",
  "504b0506",
  "504b0708",
  "7f454c46",
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
  "6465780a",
  "63646578",
  "4d5a",
  "0061736d01000000",
  "377abcaf271c",
  "526172211a07",
  "1f8b08",
].map((s) => Buffer.from(s, "hex"));

function valid(ok: unknown): asserts ok {
  if (!ok) throw new Error("Opaque media");
}
function clean(b: Buffer) {
  valid(!PAYLOADS.some((magic) => b.includes(magic)));
  valid(!/%PDF-|ustar|SQLite format 3|<script\b|<\?php|#!\s*\//i.test(b.toString("latin1")));
}
function slice(b: Buffer, at: number, length: number) {
  valid(length >= 0 && at >= 0 && at + length <= b.length);
  return b.subarray(at, at + length);
}
function zero(b: Buffer) {
  valid(b.every((v) => v === 0));
}
function inflate(b: Buffer, brotli = false) {
  const opts = { info: true as const, maxOutputLength: MEDIA_LIMIT };
  const result = (brotli ? brotliDecompressSync(b, opts) : inflateSync(b, opts)) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  valid(result.engine.bytesWritten === b.length);
  clean(result.buffer);
  return result.buffer;
}
function crc(b: Buffer, width: number, polynomial: number, reflected = false) {
  let value = reflected ? 0xffffffff : 0;
  for (const byte of b) {
    value ^= reflected ? byte : byte << (width - 8);
    for (let bit = 0; bit < 8; bit++)
      value = reflected
        ? (value >>> 1) ^ (value & 1 ? polynomial : 0)
        : (value << 1) ^ ((value >>> (width - 1)) & 1 ? polynomial : 0);
    if (width < 32) value &= (1 << width) - 1;
  }
  return (reflected ? value ^ 0xffffffff : value) >>> 0;
}
function png(b: Buffer) {
  valid(slice(b, 0, 8).equals(PNG));
  let at = 8,
    palette = 0,
    ended = false;
  let header: Buffer | undefined;
  const seen = new Set<string>(),
    data: Buffer[] = [];
  while (at < b.length) {
    const length = b.readUInt32BE(at),
      type = b.toString("ascii", at + 4, at + 8);
    const chunk = slice(b, at + 8, length);
    valid(crc(slice(b, at + 4, length + 4), 32, 0xedb88320, true) === b.readUInt32BE(at + 8 + length));
    valid(header || type === "IHDR");
    if (type !== "IDAT") {
      valid(!seen.has(type));
      seen.add(type);
    }
    if (type === "IHDR") {
      valid(length === 13);
      header = chunk;
      valid(
        chunk.readUInt32BE(0) > 0 &&
          chunk.readUInt32BE(4) > 0 &&
          chunk[10] === 0 &&
          chunk[11] === 0 &&
          (chunk[12] ?? 2) <= 1,
      );
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      valid(depths[chunk[9] ?? -1]?.includes(chunk[8] ?? -1));
    } else if (type === "PLTE") {
      valid(!data.length && length > 0 && length <= 768 && length % 3 === 0);
      palette = length / 3;
    } else if (type === "IDAT") {
      valid(!ended);
      data.push(chunk);
    } else if (type === "IEND") {
      valid(length === 0 && data.length > 0);
      at += 12;
      break;
    } else {
      if (data.length) ended = true;
      valid(header);
      const color = header[9],
        fixed: Record<string, number> = { gAMA: 4, cHRM: 32, sRGB: 1, pHYs: 9, tIME: 7 };
      if (type === "tRNS")
        valid(
          !data.length &&
            (color === 3
              ? palette > 0 && length > 0 && length <= palette
              : length === (color === 0 ? 2 : color === 2 ? 6 : -1)),
        );
      else if (type === "bKGD") valid(length === (color === 3 ? 1 : color === 0 || color === 4 ? 2 : 6));
      else if (type === "sBIT")
        valid(!data.length && length === { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 }[color ?? -1]);
      else valid(fixed[type] === length);
    }
    at += length + 12;
  }
  valid(header && seen.has("IEND") && at === b.length);
  const width = header.readUInt32BE(0),
    height = header.readUInt32BE(4);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header[9] ?? -1] ?? 0;
  valid(header[9] !== 3 || palette > 0);
  const bits = channels * (header[8] ?? 0),
    pixels = inflate(Buffer.concat(data));
  let cursor = 0;
  const passes =
    header[12] === 0
      ? [[0, 0, 1, 1]]
      : [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ];
  for (const [x = 0, y = 0, dx = 1, dy = 1] of passes) {
    const w = Math.max(0, Math.ceil((width - x) / dx)),
      h = Math.max(0, Math.ceil((height - y) / dy));
    if (!w || !h) continue;
    const row = Math.ceil((w * bits) / 8);
    valid((row + 1) * h <= pixels.length - cursor);
    for (let i = 0; i < h; i++) {
      valid((pixels[cursor] ?? 5) <= 4);
      cursor += row + 1;
    }
  }
  valid(cursor === pixels.length);
}
function gif(b: Buffer) {
  valid(/^GIF8[79]a$/.test(b.toString("ascii", 0, 6)) && b.readUInt16LE(6) > 0 && b.readUInt16LE(8) > 0);
  let at = 13,
    images = 0,
    total = 0;
  const decodedFrames: Buffer[] = [];
  const global = (b[10] ?? 0) & 128 ? 1 << (((b[10] ?? 0) & 7) + 1) : 0;
  slice(b, at, global * 3);
  at += global * 3;
  const blocks = () => {
    const parts: Buffer[] = [];
    while (true) {
      const n = b[at++];
      valid(n !== undefined);
      if (!n) break;
      parts.push(slice(b, at, n));
      at += n;
    }
    return Buffer.concat(parts);
  };
  while (at < b.length) {
    const marker = b[at++];
    if (marker === 0x3b) {
      valid(images > 0 && at === b.length);
      // Payload signatures can span frames even when each frame is individually clean.
      clean(Buffer.concat(decodedFrames));
      return;
    }
    if (marker === 0x21) {
      const kind = b[at++];
      if (kind === 0xf9) {
        valid(b[at++] === 4);
        const gce = slice(b, at, 4);
        valid(((gce[0] ?? 0) & 0xe0) === 0);
        at += 4;
        valid(b[at++] === 0);
      } else if (kind === 0xff) {
        valid(b[at++] === 11 && b.toString("ascii", at, at + 11) === "NETSCAPE2.0");
        at += 11;
        const loop = blocks();
        valid(loop.length === 3 && loop[0] === 1);
      } else valid(false);
      continue;
    }
    valid(marker === 0x2c);
    const width = b.readUInt16LE(at + 4),
      height = b.readUInt16LE(at + 6),
      flags = b[at + 8] ?? 0;
    valid(
      width > 0 &&
        height > 0 &&
        b.readUInt16LE(at) + width <= b.readUInt16LE(6) &&
        b.readUInt16LE(at + 2) + height <= b.readUInt16LE(8) &&
        (flags & 0x18) === 0,
    );
    at += 9;
    const colors = flags & 128 ? 1 << ((flags & 7) + 1) : global;
    valid(colors > 0);
    if (flags & 128) {
      slice(b, at, colors * 3);
      at += colors * 3;
    }
    const min = b[at++];
    valid(min !== undefined && min >= 2 && min <= 8);
    const packed = blocks(),
      clear = 1 << min,
      end = clear + 1;
    total += width * height;
    valid(total <= MEDIA_LIMIT);
    const decoded = Buffer.alloc(width * height);
    let pos = 0,
      size = min + 1,
      next = end + 1,
      count = 0;
    let previous: number[] | undefined,
      dict: number[][] = [];
    const code = () => {
      valid(pos + size <= packed.length * 8);
      let v = 0;
      for (let i = 0; i < size; i++, pos++) v |= (((packed[pos >> 3] ?? 0) >> (pos & 7)) & 1) << i;
      return v;
    };
    valid(code() === clear);
    const reset = () => {
      dict = Array.from({ length: clear }, (_, i) => [i]);
      size = min + 1;
      next = end + 1;
      previous = undefined;
    };
    reset();
    while (true) {
      const v = code();
      if (v === clear) {
        reset();
        continue;
      }
      if (v === end) break;
      const entry = dict[v] ?? (v === next && previous ? [...previous, previous[0] ?? 0] : undefined);
      valid(entry);
      valid(entry.every((n) => n < colors));
      count += entry.length;
      valid(count <= width * height && count <= MEDIA_LIMIT);
      decoded.set(entry, count - entry.length);
      if (previous && next < 4096) {
        dict[next++] = [...previous, entry[0] ?? 0];
        if (next === 1 << size && size < 12) size++;
      }
      previous = entry;
    }
    valid(count === width * height && Math.ceil(pos / 8) === packed.length);
    decodedFrames.push(decoded);
    images++;
  }
  valid(false);
}
function jpeg(b: Buffer) {
  valid(b.readUInt16BE(0) === 0xffd8);
  let at = 2,
    frame = false,
    quant = false,
    huffman = false,
    scans = 0;
  const components = new Map<number, { h: number; v: number; dc: number; ac: number }>();
  const codes = new Map<number, Map<number, number>>();
  let width = 0,
    height = 0,
    interval = 0;
  while (at < b.length) {
    valid(b[at++] === 0xff);
    while (b[at] === 0xff) at++;
    const marker = b[at++];
    if (marker === 0xd9) {
      valid(frame && quant && huffman && scans > 0 && at === b.length);
      return;
    }
    const length = b.readUInt16BE(at);
    valid(length >= 2);
    const c = slice(b, at + 2, length - 2);
    at += length;
    if (marker === 0xe0)
      valid(
        c.length >= 14 &&
          c.toString("ascii", 0, 5) === "JFIF\0" &&
          c.length === 14 + 3 * (c[12] ?? 0) * (c[13] ?? 0),
      );
    else if (marker === 0xee) valid(c.length === 12 && c.toString("ascii", 0, 5) === "Adobe");
    else if (marker === 0xdb) {
      let p = 0;
      while (p < c.length) {
        const info = c[p++] ?? 255;
        valid((info & 15) <= 3 && info >> 4 <= 1);
        const n = 64 * ((info >> 4) + 1);
        valid(slice(c, p, n).some((v) => v !== 0));
        p += n;
      }
      valid(p === c.length);
      quant = true;
    } else if (marker === 0xc4) {
      let p = 0;
      while (p < c.length) {
        const info = c[p++] ?? 255;
        valid((info & 15) <= 3 && info >> 4 <= 1);
        const counts = slice(c, p, 16);
        p += 16;
        let slots = 1,
          n = 0;
        for (const count of counts) {
          slots = slots * 2 - count;
          valid(slots >= 0);
          n += count;
        }
        valid(n > 0 && n <= 256);
        const values = slice(c, p, n),
          table = new Map<number, number>();
        let code = 0,
          symbol = 0;
        for (let size = 1; size <= 16; size++) {
          for (let i = 0; i < (counts[size - 1] ?? 0); i++)
            table.set((1 << size) + code++, values[symbol++] ?? 0);
          code *= 2;
        }
        codes.set(info, table);
        p += n;
      }
      huffman = true;
    } else if (marker === 0xc0 || marker === 0xc1) {
      valid(
        !frame &&
          c[0] === 8 &&
          c.readUInt16BE(1) > 0 &&
          c.readUInt16BE(3) > 0 &&
          c.length === 6 + 3 * (c[5] ?? 0) &&
          (c[5] ?? 0) > 0,
      );
      for (let p = 6; p < c.length; p += 3) {
        const id = c[p] ?? 0;
        valid(
          !components.has(id) &&
            (c[p + 1] ?? 0) >> 4 > 0 &&
            ((c[p + 1] ?? 0) & 15) > 0 &&
            (c[p + 2] ?? 4) <= 3,
        );
        const h = (c[p + 1] ?? 0) >> 4,
          v = (c[p + 1] ?? 0) & 15;
        valid(h <= 4 && v <= 4);
        components.set(id, { h, v, dc: 0, ac: 0 });
      }
      height = c.readUInt16BE(1);
      width = c.readUInt16BE(3);
      valid(width * height * 4 <= MEDIA_LIMIT);
      frame = true;
    } else if (marker === 0xdd) {
      valid(c.length === 2);
      interval = c.readUInt16BE(0);
    } else if (marker === 0xda) {
      valid(frame && quant && huffman && (c[0] ?? 0) > 0 && c.length === 4 + 2 * (c[0] ?? 0));
      valid(
        scans === 0 &&
          c[0] === components.size &&
          c[c.length - 3] === 0 &&
          c[c.length - 2] === 63 &&
          c[c.length - 1] === 0,
      );
      const order: { h: number; v: number; dc: number; ac: number }[] = [];
      for (let p = 1; p < c.length - 3; p += 2) {
        const component = components.get(c[p] ?? -1);
        valid(component && !order.includes(component));
        component.dc = (c[p + 1] ?? 0) >> 4;
        component.ac = ((c[p + 1] ?? 0) & 15) | 16;
        valid(codes.has(component.dc) && codes.has(component.ac));
        order.push(component);
      }
      const start = at;
      while (at < b.length) {
        if (b[at] !== 0xff) {
          at++;
          continue;
        }
        const next = b[at + 1];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) {
          at += 2;
          continue;
        }
        break;
      }
      valid(at > start);
      jpegScan(slice(b, start, at - start), width, height, order, codes, interval);
      scans++;
    } else valid(false);
  }
  valid(false);
}
function jpegScan(
  b: Buffer,
  width: number,
  height: number,
  components: { h: number; v: number; dc: number; ac: number }[],
  codes: Map<number, Map<number, number>>,
  interval: number,
) {
  let at = 0,
    left = 0,
    byte = 0;
  const bit = () => {
    if (!left) {
      const next = b[at++];
      valid(next !== undefined);
      byte = next;
      left = 8;
      if (byte === 255) valid(b[at++] === 0);
    }
    return (byte >> --left) & 1;
  };
  const align = () => {
    valid((byte & ((1 << left) - 1)) === (1 << left) - 1);
    left = 0;
  };
  const symbol = (id: number) => {
    const table = codes.get(id);
    valid(table);
    let code = 0;
    for (let n = 1; n <= 16; n++) {
      code = code * 2 + bit();
      const value = table.get((1 << n) + code);
      if (value !== undefined) return value;
    }
    throw new Error("Invalid JPEG code");
  };
  const skip = (n: number) => {
    for (let i = 0; i < n; i++) bit();
  };
  const h = Math.max(...components.map((c) => c.h)),
    v = Math.max(...components.map((c) => c.v));
  const mcus = Math.ceil(width / (h * 8)) * Math.ceil(height / (v * 8));
  let restart = 0;
  for (let mcu = 0; mcu < mcus; mcu++) {
    if (interval && mcu && mcu % interval === 0) {
      align();
      valid(b[at++] === 255 && b[at++] === 0xd0 + (restart++ & 7));
    }
    for (const component of components)
      for (let block = 0; block < component.h * component.v; block++) {
        const dc = symbol(component.dc);
        valid(dc <= 11);
        skip(dc);
        let coefficient = 1;
        while (coefficient < 64) {
          const ac = symbol(component.ac);
          if (ac === 0) break;
          if (ac === 0xf0) {
            coefficient += 16;
            valid(coefficient <= 64);
            continue;
          }
          const size = ac & 15;
          valid(size > 0 && size <= 10);
          coefficient += (ac >> 4) + 1;
          valid(coefficient <= 64);
          skip(size);
        }
      }
  }
  align();
  valid(at === b.length);
}
function riff(b: Buffer, kind: string) {
  valid(
    b.toString("ascii", 0, 4) === "RIFF" &&
      b.readUInt32LE(4) + 8 === b.length &&
      b.toString("ascii", 8, 12) === kind,
  );
  const chunks: { tag: string; data: Buffer }[] = [];
  let at = 12;
  while (at < b.length) {
    const tag = b.toString("ascii", at, at + 4),
      n = b.readUInt32LE(at + 4);
    chunks.push({ tag, data: slice(b, at + 8, n) });
    at += 8 + n;
    if (n & 1) valid(b[at++] === 0);
  }
  valid(at === b.length);
  return chunks;
}
function webp(b: Buffer) {
  const chunks = riff(b, "WEBP");
  let image = false;
  let canvas: Buffer | undefined;
  for (const [i, { tag, data: c }] of chunks.entries()) {
    if (tag === "VP8X") {
      valid(i === 0 && c.length === 10 && ((c[0] ?? 255) & ~0x10) === 0);
      zero(c.subarray(1, 4));
      canvas = c;
    } else if (tag === "VP8L") {
      valid(!image && c.length > 5 && c[0] === 0x2f && c.readUInt32LE(1) >>> 29 === 0);
      if (canvas)
        valid(
          canvas.readUIntLE(4, 3) === (c.readUInt32LE(1) & 0x3fff) &&
            canvas.readUIntLE(7, 3) === ((c.readUInt32LE(1) >> 14) & 0x3fff),
        );
      lossless(c);
      image = true;
    } else valid(false);
  }
  valid(image);
}
class Bits {
  pos: number;
  constructor(
    readonly b: Buffer,
    at: number,
  ) {
    this.pos = at * 8;
  }
  read(n: number) {
    valid(n >= 0 && n <= 32 && this.pos + n <= this.b.length * 8);
    let value = 0;
    for (let i = 0; i < n; i++, this.pos++)
      value = value * 2 + (((this.b[this.pos >> 3] ?? 0) >> (7 - (this.pos & 7))) & 1);
    return value;
  }
  skip(n: number) {
    valid(n >= 0 && this.pos + n <= this.b.length * 8);
    this.pos += n;
  }
  unary() {
    let n = 0;
    while (this.read(1) === 0) {
      n++;
      valid(n <= MEDIA_LIMIT);
    }
    return n;
  }
}
class LittleBits extends Bits {
  override read(n: number) {
    valid(n >= 0 && n <= 32 && this.pos + n <= this.b.length * 8);
    let value = 0;
    for (let i = 0; i < n; i++, this.pos++)
      value += (((this.b[this.pos >> 3] ?? 0) >> (this.pos & 7)) & 1) * 2 ** i;
    return value;
  }
}
function prefix(lengths: number[], bits: LittleBits): () => number {
  const used = lengths.flatMap((n, symbol) => (n ? [{ n, symbol }] : []));
  valid(used.length > 0);
  if (used.length === 1) return () => used[0]?.symbol ?? 0;
  let available = 1,
    code = 0;
  const codes = new Map<number, number>();
  for (let n = 1; n <= 15; n++) {
    available = available * 2 - used.filter((v) => v.n === n).length;
    valid(available >= 0);
    for (const v of used.filter((v) => v.n === n)) codes.set((1 << n) + code++, v.symbol);
    code *= 2;
  }
  valid(available === 0);
  return () => {
    let value = 0;
    for (let n = 1; n <= 15; n++) {
      value = value * 2 + bits.read(1);
      const symbol = codes.get((1 << n) + value);
      if (symbol !== undefined) return symbol;
    }
    throw new Error("Invalid prefix code");
  };
}
// libwebp's kCodeToPlane: high nibble is y; low nibble encodes 8 - x.
const WEBP_DISTANCE_PLANE = Buffer.from(
  "1807171928062729161a262a38053739151b363a252b48044749141c353b464a242c58454b343c035759" +
    "131d565a232d444c555b333d68026769121e666a222e545c434d656b323e78017779535d111f646c424e" +
    "767a212f757b313f636d525e00747c414f1020626e30737d515f40727e616f50717f6070",
  "hex",
);
function lossless(b: Buffer) {
  const bits = new LittleBits(b, 1);
  const originalWidth = bits.read(14) + 1;
  let width = originalWidth;
  const height = bits.read(14) + 1;
  bits.read(1);
  valid(bits.read(3) === 0);
  const tree = (alphabet: number) => {
    const lengths: number[] = Array(alphabet).fill(0);
    if (bits.read(1)) {
      const count = bits.read(1) + 1,
        first = bits.read(1 + 7 * bits.read(1));
      valid(first < alphabet);
      lengths[first] = 1;
      if (count === 2) {
        const second = bits.read(8);
        valid(second < alphabet);
        lengths[second] = 1;
      }
    } else {
      const count = bits.read(4) + 4,
        order = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        codeLengths: number[] = Array(19).fill(0);
      for (let i = 0; i < count; i++) codeLengths[order[i] ?? 0] = bits.read(3);
      const decode = prefix(codeLengths, bits);
      const limit = bits.read(1) ? 2 + bits.read(2 + 2 * bits.read(3)) : alphabet;
      valid(limit <= alphabet);
      let at = 0,
        previous = 8;
      for (let i = 0; i < limit && at < alphabet; i++) {
        const value = decode();
        if (value < 16) {
          lengths[at++] = value;
          if (value) previous = value;
        } else {
          const n = value === 16 ? 3 + bits.read(2) : value === 17 ? 3 + bits.read(3) : 11 + bits.read(7);
          valid(at + n <= alphabet);
          lengths.fill(value === 16 ? previous : 0, at, at + n);
          at += n;
        }
      }
    }
    return prefix(lengths, bits);
  };
  const image = (w: number, h: number, main = false): Uint32Array => {
    valid(w * h * 4 <= MEDIA_LIMIT);
    const cached = bits.read(1),
      cacheBits = cached ? bits.read(4) : 0;
    valid(!cached || (cacheBits >= 1 && cacheBits <= 11));
    // Spatially varying code groups require another image and remain uncertain here.
    if (main) valid(bits.read(1) === 0);
    const green = tree(280 + (cacheBits ? 1 << cacheBits : 0));
    const red = tree(256),
      blue = tree(256),
      alpha = tree(256),
      distance = tree(40);
    const output = new Uint32Array(w * h),
      cache = new Uint32Array(cacheBits ? 1 << cacheBits : 0);
    let at = 0;
    const put = (pixel: number) => {
      valid(at < output.length);
      output[at++] = pixel;
      if (cacheBits) cache[Math.imul(pixel, 0x1e35a7bd) >>> (32 - cacheBits)] = pixel;
    };
    const number = (code: number) => {
      if (code < 4) return code + 1;
      const n = (code - 2) >> 1;
      return ((2 + (code & 1)) << n) + bits.read(n) + 1;
    };
    while (at < output.length) {
      const code = green();
      if (code < 256) {
        const r = red(),
          bl = blue(),
          a = alpha();
        put(((a << 24) | (r << 16) | (code << 8) | bl) >>> 0);
      } else if (code < 280) {
        const n = number(code - 256),
          d = number(distance());
        let offset = d - 120;
        if (d <= 120) {
          const plane = WEBP_DISTANCE_PLANE[d - 1];
          valid(plane !== undefined);
          offset = Math.max(1, (plane >> 4) * w + 8 - (plane & 15));
        }
        valid(offset > 0 && offset <= at && at + n <= output.length);
        for (let i = 0; i < n; i++) put(output[at - offset] ?? 0);
      } else {
        valid(cacheBits && code - 280 < cache.length);
        put(cache[code - 280] ?? 0);
      }
    }
    clean(Buffer.from(output.buffer));
    return output;
  };
  let colors: Uint32Array | undefined;
  while (bits.read(1)) {
    const type = bits.read(2);
    // Only color indexing has a supported inverse; other transforms remain opaque.
    valid(type === 3 && !colors);
    const count = bits.read(8) + 1;
    colors = image(count, 1);
    for (let i = 1; i < count; i++) {
      let pixel = 0;
      for (let shift = 0; shift < 32; shift += 8)
        pixel |= ((((colors[i] ?? 0) >>> shift) + ((colors[i - 1] ?? 0) >>> shift)) & 255) << shift;
      colors[i] = pixel >>> 0;
    }
    const n = count <= 2 ? 3 : count <= 4 ? 2 : count <= 16 ? 1 : 0;
    width = Math.ceil(width / (1 << n));
  }
  let pixels = image(width, height, true);
  if (colors) {
    valid(originalWidth * height * 4 <= MEDIA_LIMIT);
    const packed = colors.length <= 2 ? 8 : colors.length <= 4 ? 4 : colors.length <= 16 ? 2 : 1,
      output = new Uint32Array(originalWidth * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < originalWidth; x++) {
        const index =
          ((pixels[y * width + Math.floor(x / packed)] ?? 0) >>> (8 + (x % packed) * (8 / packed))) &
          ((1 << (8 / packed)) - 1);
        output[y * originalWidth + x] = colors[index] ?? 0;
      }
    pixels = output;
  }
  const decoded = Buffer.from(pixels.buffer);
  clean(decoded);
  // Both BGRA and RGBA expose recoverable pixel bytes.
  for (let at = 0; at < decoded.length; at += 4) {
    const blue = decoded[at] ?? 0;
    decoded[at] = decoded[at + 2] ?? 0;
    decoded[at + 2] = blue;
  }
  clean(decoded);
  valid(Math.ceil(bits.pos / 8) === b.length);
  while (bits.pos < b.length * 8) valid(bits.read(1) === 0);
}
function ico(b: Buffer) {
  valid(b.readUInt32LE(0) === 0x10000);
  const count = b.readUInt16LE(4);
  valid(count > 0);
  const ranges: { at: number; length: number }[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    valid(b[at + 3] === 0);
    ranges.push({ at: b.readUInt32LE(at + 12), length: b.readUInt32LE(at + 8) });
  }
  let cursor = 6 + count * 16;
  for (const r of ranges.sort((a, b) => a.at - b.at)) {
    valid(r.at === cursor);
    const c = slice(b, r.at, r.length);
    if (c.subarray(0, 8).equals(PNG)) png(c);
    else {
      valid(
        c.readUInt32LE(0) === 40 &&
          c.readInt32LE(4) > 0 &&
          c.readInt32LE(8) > 0 &&
          c.readInt32LE(8) % 2 === 0 &&
          c.readUInt16LE(12) === 1 &&
          c.readUInt32LE(16) === 0,
      );
      const w = c.readInt32LE(4),
        h = c.readInt32LE(8) / 2,
        depth = c.readUInt16LE(14);
      valid([1, 4, 8, 24, 32].includes(depth));
      const colors = depth <= 8 ? c.readUInt32LE(32) || 1 << depth : 0;
      valid(c.length === 40 + colors * 4 + Math.ceil((w * depth) / 32) * 4 * h + Math.ceil(w / 32) * 4 * h);
    }
    cursor += r.length;
  }
  valid(cursor === b.length);
}
// WOFF2 uses this fixed tag order. SVG and private tables are not eligible for exemption.
const WOFF_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
  "VORG",
  "EBDT",
  "EBLC",
  "gasp",
  "hdmx",
  "kern",
  "LTSH",
  "PCLT",
  "VDMX",
  "vhea",
  "vmtx",
  "BASE",
  "GDEF",
  "GPOS",
  "GSUB",
  "EBSC",
  "JSTF",
  "MATH",
  "CBDT",
  "CBLC",
  "COLR",
  "CPAL",
  "SVG ",
  "sbix",
  "acnt",
  "avar",
  "bdat",
  "bloc",
  "bsln",
  "cvar",
  "fdsc",
  "feat",
  "fmtx",
  "fvar",
  "gvar",
  "hsty",
  "just",
  "lcar",
  "mort",
  "morx",
  "opbd",
  "prop",
  "trak",
  "Zapf",
  "Silf",
  "Glat",
  "Gloc",
  "Feat",
  "Sill",
];
const FONT_TABLES = [
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "cmap",
  "name",
  "post",
  "OS/2",
  "glyf",
  "loca",
  "CFF ",
  "gasp",
];
function fontTables(tables: Map<string, Buffer>, transformed = new Map<string, number>()) {
  for (const [tag, b] of tables) {
    valid(FONT_TABLES.includes(tag));
    clean(b);
  }
  const head = tables.get("head"),
    maxp = tables.get("maxp"),
    hhea = tables.get("hhea"),
    hmtx = tables.get("hmtx");
  valid(head && maxp && hhea && hmtx && tables.has("cmap") && tables.has("name") && tables.has("post"));
  valid(
    head.length === 54 &&
      head.readUInt32BE(12) === 0x5f0f3cf5 &&
      head.readUInt16BE(18) >= 16 &&
      head.readUInt16BE(18) <= 16384 &&
      hhea.length === 36,
  );
  const glyphs = maxp.readUInt16BE(4),
    metrics = hhea.readUInt16BE(34);
  valid(glyphs > 0 && metrics > 0 && metrics <= glyphs && (maxp.length === 6 || maxp.length === 32));
  valid(head.readUInt32BE(0) === 0x10000 && hhea.readUInt32BE(0) === 0x10000);
  const mapping = tables.get("cmap"),
    names = tables.get("post");
  valid(mapping && names);
  cmap(mapping, glyphs);
  post(names, glyphs);
  const os2 = tables.get("OS/2");
  if (os2) valid([78, 86, 96, 96, 96, 100][os2.readUInt16BE(0)] === os2.length);
  const gasp = tables.get("gasp");
  if (gasp) valid(gasp.readUInt16BE(0) <= 1 && gasp.length === 4 + 4 * gasp.readUInt16BE(2));
  if (transformed.has("hmtx")) {
    const flags = hmtx[0] ?? 0;
    valid(
      flags > 0 &&
        flags <= 3 &&
        hmtx.length ===
          1 + metrics * 2 + (flags & 1 ? 0 : metrics * 2) + (flags & 2 ? 0 : (glyphs - metrics) * 2),
    );
  } else valid(hmtx.length === metrics * 4 + (glyphs - metrics) * 2);
  valid(tables.has("CFF ") || (tables.has("glyf") && tables.has("loca")));
  const glyf = tables.get("glyf"),
    loca = tables.get("loca");
  const outlines = tables.get("CFF ");
  if (outlines) cff(outlines, glyphs);
  if (glyf && loca) {
    if (transformed.has("glyf")) {
      valid(
        transformed.has("loca") &&
          transformed.get("loca") === (glyphs + 1) * (head.readInt16BE(50) === 0 ? 2 : 4),
      );
      transformedGlyphs(glyf, glyphs, head.readInt16BE(50));
    } else glyphTable(glyf, loca, glyphs, head.readInt16BE(50));
  }
  const name = tables.get("name");
  valid(name);
  valid(name.readUInt16BE(0) === 0);
  const strings = name.readUInt16BE(4),
    count = name.readUInt16BE(2);
  valid(strings === 6 + count * 12 && strings <= name.length);
  let end = strings;
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12,
      limit = strings + name.readUInt16BE(r + 10) + name.readUInt16BE(r + 8);
    valid(limit <= name.length);
    end = Math.max(end, limit);
  }
  valid(end === name.length);
}
function cmap(b: Buffer, glyphs: number) {
  valid(b.readUInt16BE(0) === 0);
  const count = b.readUInt16BE(2),
    header = 4 + count * 8;
  valid(count > 0 && count <= 128 && header <= b.length);
  const ranges = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const at = b.readUInt32BE(8 + i * 8);
    valid(at >= header);
    if (ranges.has(at)) continue;
    const format = b.readUInt16BE(at);
    const n = format >= 12 ? b.readUInt32BE(at + 4) : b.readUInt16BE(at + 2);
    const c = slice(b, at, n);
    if (format === 0) {
      valid(n === 262);
      for (const glyph of c.subarray(6)) valid(glyph < glyphs);
    } else if (format === 4) {
      const doubled = c.readUInt16BE(6),
        segments = doubled / 2;
      valid(
        doubled > 0 && doubled % 2 === 0 && n >= 16 + segments * 8 && c.readUInt16BE(14 + segments * 2) === 0,
      );
      let previous = -1;
      const used: { at: number; end: number }[] = [];
      for (let j = 0; j < segments; j++) {
        const end = c.readUInt16BE(14 + j * 2),
          start = c.readUInt16BE(16 + segments * 2 + j * 2);
        const delta = c.readInt16BE(16 + segments * 4 + j * 2),
          pos = 16 + segments * 6 + j * 2,
          range = c.readUInt16BE(pos);
        valid(start > previous && end >= start && (range & 1) === 0);
        if (range) used.push({ at: pos + range, end: pos + range + (end - start + 1) * 2 });
        previous = end;
        if (j === segments - 1) valid(start === 65535 && end === 65535);
        for (let value = start; value <= end; value++) {
          let glyph = value;
          if (range) {
            const offset = pos + range + (value - start) * 2;
            valid(offset >= 16 + segments * 8);
            glyph = c.readUInt16BE(offset);
            if (!glyph) continue;
          }
          valid(((glyph + delta) & 65535) < glyphs);
        }
      }
      let end = 16 + segments * 8;
      for (const r of used.sort((a, b) => a.at - b.at)) {
        valid(r.at <= end && r.end <= c.length);
        end = Math.max(end, r.end);
      }
      valid(c.length - end <= 3);
      zero(c.subarray(end));
    } else if (format === 6) {
      const count = c.readUInt16BE(8);
      valid(n === 10 + count * 2 && c.readUInt16BE(6) + count <= 65536);
      for (let j = 0; j < count; j++) valid(c.readUInt16BE(10 + j * 2) < glyphs);
    } else if (format === 12 || format === 13) {
      const count = c.readUInt32BE(12);
      valid(c.readUInt16BE(2) === 0 && n === 16 + count * 12);
      let previous = -1;
      for (let j = 0; j < count; j++) {
        const start = c.readUInt32BE(16 + j * 12),
          end = c.readUInt32BE(20 + j * 12),
          glyph = c.readUInt32BE(24 + j * 12);
        valid(
          start > previous &&
            end >= start &&
            end <= 0x10ffff &&
            glyph + (format === 12 ? end - start : 0) < glyphs,
        );
        previous = end;
      }
    } else valid(false);
    ranges.set(at, at + n);
  }
  let end = header;
  for (const [start, limit] of [...ranges].sort((a, b) => a[0] - b[0])) {
    valid(start >= end && start - end <= 3);
    zero(slice(b, end, start - end));
    end = limit;
  }
  valid(b.length - end <= 3);
  zero(b.subarray(end));
}
function post(b: Buffer, glyphs: number) {
  const version = b.readUInt32BE(0);
  if (version === 0x30000) {
    valid(b.length === 32);
    return;
  }
  if (version === 0x10000) {
    valid(b.length === 32 && glyphs <= 258);
    return;
  }
  valid(version === 0x20000 && b.readUInt16BE(32) === glyphs);
  let at = 34 + glyphs * 2,
    names = 0;
  for (let i = 0; i < glyphs; i++) {
    const index = b.readUInt16BE(34 + i * 2);
    valid(index <= 32767);
    names = Math.max(names, index - 257);
  }
  for (let i = 0; i < names; i++) {
    const n = b[at++];
    valid(n !== undefined && n > 0);
    const text = slice(b, at, n);
    valid(text.every((v) => v >= 32 && v < 127));
    at += n;
  }
  valid(at === b.length);
}

function composite(b: Buffer, start: number, glyphs: number) {
  let at = start,
    flags = 0,
    instructions = false;
  do {
    flags = b.readUInt16BE(at);
    valid((flags & ~0x1fff) === 0 && b.readUInt16BE(at + 2) < glyphs);
    at += 4 + (flags & 1 ? 4 : 2);
    const matrix = flags & 8 ? 2 : flags & 64 ? 4 : flags & 128 ? 8 : 0;
    valid(Number(Boolean(flags & 8)) + Number(Boolean(flags & 64)) + Number(Boolean(flags & 128)) <= 1);
    at += matrix;
    valid(at <= b.length);
    instructions ||= Boolean(flags & 256);
  } while (flags & 32);
  return { at, instructions };
}
function glyphTable(b: Buffer, loca: Buffer, glyphs: number, format: number) {
  valid(format === 0 || format === 1);
  const size = format === 0 ? 2 : 4;
  valid(loca.length === (glyphs + 1) * size);
  const offset = (i: number) => (format === 0 ? loca.readUInt16BE(i * 2) * 2 : loca.readUInt32BE(i * 4));
  valid(offset(0) === 0);
  for (let i = 0; i < glyphs; i++) {
    const start = offset(i),
      end = offset(i + 1);
    valid(end >= start && end <= b.length);
    if (end === start) continue;
    const c = slice(b, start, end - start),
      contours = c.readInt16BE(0);
    let at = 10;
    if (contours >= 0) {
      let points = 0;
      for (let j = 0; j < contours; j++) {
        const n = c.readUInt16BE(at) + 1;
        valid(n > points);
        points = n;
        at += 2;
      }
      const instructions = c.readUInt16BE(at);
      at += 2 + instructions;
      valid(at <= c.length);
      let read = 0,
        coordinates = 0;
      while (read < points) {
        const flag = c[at++];
        valid(flag !== undefined && !(flag & 128));
        const repeat = flag & 8 ? (c[at++] ?? -1) + 1 : 1;
        valid(repeat > 0 && read + repeat <= points);
        coordinates += repeat * ((flag & 2 ? 1 : flag & 16 ? 0 : 2) + (flag & 4 ? 1 : flag & 32 ? 0 : 2));
        read += repeat;
      }
      at += coordinates;
    } else {
      valid(contours === -1);
      const result = composite(c, at, glyphs);
      at = result.at;
      if (result.instructions) at += 2 + c.readUInt16BE(at);
    }
    valid(at <= c.length && c.length - at <= 3);
    zero(c.subarray(at));
  }
  const end = offset(glyphs);
  valid(b.length - end <= 3);
  zero(b.subarray(end));
}
function transformedGlyphs(b: Buffer, glyphs: number, format: number) {
  valid(
    b.readUInt16BE(0) === 0 &&
      b.readUInt16BE(4) === glyphs &&
      b.readUInt16BE(6) === format &&
      (format === 0 || format === 1),
  );
  const flags = b.readUInt16BE(2);
  valid(flags <= 1);
  const streams: Buffer[] = [];
  let at = 36;
  for (let i = 0; i < 7; i++) {
    const n = b.readUInt32BE(8 + i * 4);
    streams.push(slice(b, at, n));
    at += n;
  }
  if (flags & 1) {
    slice(b, at, Math.ceil(glyphs / 8));
    at += Math.ceil(glyphs / 8);
  }
  valid(at === b.length);
  const contours = streams[0],
    points = streams[1],
    flagStream = streams[2],
    glyph = streams[3],
    components = streams[4],
    bounds = streams[5],
    instructions = streams[6];
  valid(
    contours &&
      points &&
      flagStream &&
      glyph &&
      components &&
      bounds &&
      instructions &&
      contours.length === glyphs * 2,
  );
  const bitmap = Math.ceil(glyphs / 32) * 4;
  slice(bounds, 0, bitmap);
  let pointAt = 0,
    flagAt = 0,
    glyphAt = 0,
    componentAt = 0,
    boundAt = bitmap,
    instructionAt = 0;
  const uint = (stream: Buffer, pos: number) => {
    const code = stream[pos++];
    valid(code !== undefined);
    if (code === 253) {
      const value = stream.readUInt16BE(pos);
      return { value, at: pos + 2 };
    }
    if (code >= 254) {
      const value = stream[pos++];
      valid(value !== undefined);
      return { value: value + (code === 254 ? 506 : 253), at: pos };
    }
    return { value: code, at: pos };
  };
  for (let i = 0; i < glyphs; i++) {
    const n = contours.readInt16BE(i * 2),
      bbox = ((bounds[i >> 3] ?? 0) >> (7 - (i & 7))) & 1;
    let hasInstructions = false;
    if (n > 0) {
      let count = 0;
      for (let j = 0; j < n; j++) {
        const result = uint(points, pointAt);
        pointAt = result.at;
        valid(result.value > 0);
        count += result.value;
      }
      for (let j = 0; j < count; j++) {
        const flag = flagStream[flagAt++];
        valid(flag !== undefined);
        const value = flag & 127;
        glyphAt += value < 84 ? 1 : value < 120 ? 2 : value < 124 ? 3 : 4;
      }
      hasInstructions = true;
    } else if (n < 0) {
      valid(n === -1 && bbox);
      const result = composite(components, componentAt, glyphs);
      componentAt = result.at;
      hasInstructions = result.instructions;
    }
    if (hasInstructions) {
      const result = uint(glyph, glyphAt);
      glyphAt = result.at;
      instructionAt += result.value;
    }
    if (bbox) boundAt += 8;
    valid(glyphAt <= glyph.length && instructionAt <= instructions.length && boundAt <= bounds.length);
  }
  valid(
    pointAt === points.length &&
      flagAt === flagStream.length &&
      glyphAt === glyph.length &&
      componentAt === components.length &&
      boundAt === bounds.length &&
      instructionAt === instructions.length,
  );
}

function cff(b: Buffer, glyphs: number) {
  valid(b[0] === 1 && (b[2] ?? 0) >= 4 && (b[3] ?? 0) >= 1 && (b[3] ?? 0) <= 4);
  const ranges: { at: number; end: number }[] = [{ at: 0, end: b[2] ?? 0 }];
  const index = (at: number) => {
    const start = at,
      count = b.readUInt16BE(at);
    at += 2;
    const parts: Buffer[] = [];
    if (count) {
      const size = b[at++];
      valid(size !== undefined && size >= 1 && size <= 4);
      const base = at + (count + 1) * size;
      valid(b.readUIntBE(at, size) === 1);
      for (let i = 0; i < count; i++) {
        const first = b.readUIntBE(at + i * size, size),
          last = b.readUIntBE(at + (i + 1) * size, size);
        parts.push(slice(b, base + first - 1, last - first));
      }
      at = base + b.readUIntBE(at + count * size, size) - 1;
    }
    ranges.push({ at: start, end: at });
    return { parts, end: at };
  };
  const dictionary = (c: Buffer) => {
    const result = new Map<number, number[]>();
    let stack: number[] = [],
      at = 0;
    while (at < c.length) {
      const byte = c[at++];
      valid(byte !== undefined);
      if (byte >= 32 && byte <= 246) stack.push(byte - 139);
      else if (byte >= 247 && byte <= 254) {
        const next = c[at++];
        valid(next !== undefined);
        stack.push(byte <= 250 ? (byte - 247) * 256 + next + 108 : -(byte - 251) * 256 - next - 108);
      } else if (byte === 28) {
        stack.push(c.readInt16BE(at));
        at += 2;
      } else if (byte === 29) {
        stack.push(c.readInt32BE(at));
        at += 4;
      } else if (byte === 30) {
        let done = false;
        while (!done) {
          const next = c[at++];
          valid(next !== undefined);
          valid(next >> 4 !== 13 && (next & 15) !== 13);
          done = next >> 4 === 15 || (next & 15) === 15;
        }
        stack.push(0);
      } else {
        valid(byte <= 21);
        const op = byte === 12 ? 1200 + (c[at++] ?? -100) : byte;
        valid(!result.has(op));
        result.set(op, stack);
        stack = [];
      }
      valid(stack.length <= 48);
    }
    valid(!stack.length);
    return result;
  };
  const names = index(b[2] ?? 0),
    top = index(names.end),
    strings = index(top.end),
    globals = index(strings.end);
  valid(names.parts.length === 1 && top.parts.length === 1);
  for (const s of [...names.parts, ...strings.parts])
    valid(s.length > 0 && s.length <= 65536 && !s.includes(0));
  const dict = dictionary(top.parts[0] ?? Buffer.alloc(0));
  // CID fonts and subroutine execution need a full font interpreter and remain opaque.
  valid(!dict.has(1230));
  const charAt = dict.get(17)?.[0];
  valid(charAt !== undefined);
  const chars = index(charAt);
  valid(chars.parts.length === glyphs);
  const charset = dict.get(15)?.[0] ?? 0;
  if (charset > 2) {
    let at = charset;
    const format = b[at++];
    valid(format !== undefined && format <= 2);
    if (format === 0) at += (glyphs - 1) * 2;
    else {
      let count = 1;
      while (count < glyphs) {
        slice(b, at, 2);
        at += 2;
        const n = format === 1 ? b[at++] : b.readUInt16BE(at);
        valid(n !== undefined);
        if (format === 2) at += 2;
        count += n + 1;
        valid(count <= glyphs);
      }
    }
    slice(b, charset, at - charset);
    ranges.push({ at: charset, end: at });
  }
  const encoding = dict.get(16)?.[0] ?? 0;
  valid(encoding <= 1); // Custom encoding blocks can contain unused data.
  const privateInfo = dict.get(18);
  if (privateInfo) {
    const size = privateInfo[0],
      at = privateInfo[1];
    valid(size !== undefined && at !== undefined);
    const privateDict = dictionary(slice(b, at, size));
    if (size) ranges.push({ at, end: at + size });
    const subrs = privateDict.get(19)?.[0];
    if (subrs !== undefined) valid(index(at + subrs).parts.length === 0);
  }
  valid(globals.parts.length === 0);
  for (const c of chars.parts) {
    let at = 0,
      operands = 0,
      hints = 0,
      ended = false;
    while (at < c.length) {
      const byte = c[at++];
      valid(byte !== undefined);
      if (byte >= 32) {
        if (byte >= 247 && byte <= 254) at++;
        else if (byte === 255) at += 4;
        operands++;
      } else if (byte === 28) {
        at += 2;
        operands++;
      } else {
        valid(!ended && byte !== 10 && byte !== 29 && byte !== 11);
        if (byte === 1 || byte === 3 || byte === 18 || byte === 23 || byte === 19 || byte === 20) {
          hints += Math.floor(operands / 2);
          if (byte === 19 || byte === 20) at += Math.ceil(hints / 8);
        } else if (byte === 12) {
          const op = c[at++];
          valid(op !== undefined && op >= 34 && op <= 37);
        } else if (byte === 14) {
          valid(at === c.length);
          ended = true;
        } else valid([4, 5, 6, 7, 8, 21, 22, 24, 25, 26, 27, 30, 31].includes(byte));
        operands = 0;
      }
      valid(at <= c.length && operands <= 48);
    }
    valid(ended);
  }
  let end = 0;
  for (const range of ranges.sort((a, b) => a.at - b.at)) {
    valid(range.at === end && range.end >= range.at);
    end = range.end;
  }
  valid(end === b.length);
}

function checksum(b: Buffer, head = false) {
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) n = n * 256 + (b[i + j] ?? 0);
    if (!head || i !== 8) sum = (sum + n) >>> 0;
  }
  return sum;
}
function font(b: Buffer, kind: string) {
  const woff = kind === "woff",
    woff2 = kind === "woff2";
  const flavor = b.readUInt32BE(woff || woff2 ? 4 : 0);
  valid(flavor === 0x10000 || flavor === 0x4f54544f);
  if (kind === "ttf") valid(flavor === 0x10000);
  if (kind === "otf") valid(flavor === 0x4f54544f);
  const tables = new Map<string, Buffer>();
  const transformed = new Map<string, number>();
  if (woff2) {
    valid(b.toString("ascii", 0, 4) === "wOF2" && b.readUInt32BE(8) === b.length && b.readUInt16BE(14) === 0);
    zero(slice(b, 28, 20));
    const count = b.readUInt16BE(12);
    valid(count > 0 && count <= FONT_TABLES.length);
    let at = 48,
      total = 0;
    const uint = () => {
      let n = 0;
      for (let i = 0; i < 5; i++) {
        const v = b[at++];
        valid(v !== undefined && !(i === 0 && v === 128));
        n = n * 128 + (v & 127);
        valid(n <= 0xffffffff);
        if (!(v & 128)) return n;
      }
      throw new Error("Invalid base128");
    };
    const entries: { tag: string; length: number; original: number; transformed: boolean }[] = [];
    for (let i = 0; i < count; i++) {
      const flags = b[at++];
      valid(flags !== undefined);
      let tag = WOFF_TAGS[flags & 63];
      if ((flags & 63) === 63) {
        tag = slice(b, at, 4).toString("ascii");
        at += 4;
      }
      valid(tag && FONT_TABLES.includes(tag) && !entries.some((e) => e.tag === tag));
      const version = flags >> 6,
        original = uint(),
        glyf = tag === "glyf" || tag === "loca";
      valid(glyf ? version === 0 || version === 3 : version === 0 || (tag === "hmtx" && version === 1));
      const transformed = glyf ? version === 0 : version !== 0,
        length = transformed ? uint() : original;
      valid(tag !== "loca" || !transformed || length === 0);
      entries.push({ tag, length, original, transformed });
      total += length;
    }
    const compressed = b.readUInt32BE(20);
    valid(at + compressed <= b.length && b.length <= ((at + compressed + 3) & ~3) && total <= MEDIA_LIMIT);
    zero(b.subarray(at + compressed));
    const data = inflate(slice(b, at, compressed), true);
    valid(data.length === total);
    let offset = 0;
    for (const e of entries) {
      const c = slice(data, offset, e.length);
      offset += e.length;
      tables.set(e.tag, c);
      if (e.transformed) transformed.set(e.tag, e.original);
    }
  } else {
    if (woff) {
      valid(
        b.toString("ascii", 0, 4) === "wOFF" && b.readUInt32BE(8) === b.length && b.readUInt16BE(14) === 0,
      );
      zero(slice(b, 24, 20));
    }
    const count = b.readUInt16BE(woff ? 12 : 4);
    valid(count > 0 && count <= FONT_TABLES.length);
    const header = woff ? 44 : 12,
      record = woff ? 20 : 16;
    const ranges: { at: number; size: number }[] = [];
    let total = 12 + count * 16;
    for (let i = 0; i < count; i++) {
      const p = header + i * record,
        tag = slice(b, p, 4).toString("ascii");
      valid(FONT_TABLES.includes(tag) && !tables.has(tag));
      const at = b.readUInt32BE(p + (woff ? 4 : 8)),
        size = b.readUInt32BE(p + (woff ? 8 : 12));
      const original = woff ? b.readUInt32BE(p + 12) : size;
      valid(at % 4 === 0 && size <= original && original <= MEDIA_LIMIT);
      valid(total + ((original + 3) & ~3) <= MEDIA_LIMIT);
      const raw = slice(b, at, size),
        c = size < original ? inflate(raw) : raw;
      valid(c.length === original && checksum(c, tag === "head") === b.readUInt32BE(p + (woff ? 16 : 4)));
      tables.set(tag, c);
      ranges.push({ at, size });
      total += (original + 3) & ~3;
    }
    let end = header + count * record;
    for (const r of ranges.sort((a, b) => a.at - b.at)) {
      valid(r.at === ((end + 3) & ~3));
      zero(slice(b, end, r.at - end));
      end = r.at + r.size;
    }
    valid(b.length >= end && b.length <= ((end + 3) & ~3));
    zero(b.subarray(end));
    if (woff) {
      valid(b.readUInt32BE(16) === total);
      // Scan the reconstituted sfnt data, including signatures crossing table boundaries.
      clean(Buffer.concat([...tables.values()].flatMap((c) => [c, Buffer.alloc(-c.length & 3)])));
    }
  }
  valid(
    flavor === 0x10000
      ? tables.has("glyf") && !tables.has("CFF ")
      : tables.has("CFF ") && !tables.has("glyf"),
  );
  fontTables(tables, transformed);
}
function wav(b: Buffer) {
  const chunks = riff(b, "WAVE");
  let align = 0,
    data = false;
  for (const { tag, data: c } of chunks) {
    if (tag === "fmt ") {
      valid(!align && !data && (c.length === 16 || (c.length === 18 && c.readUInt16LE(16) === 0)));
      const format = c.readUInt16LE(0),
        channels = c.readUInt16LE(2),
        rate = c.readUInt32LE(4),
        bits = c.readUInt16LE(14);
      align = c.readUInt16LE(12);
      valid(
        ((format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && [32, 64].includes(bits))) &&
          channels > 0 &&
          rate > 0 &&
          align === (channels * bits) / 8 &&
          c.readUInt32LE(8) === rate * align,
      );
    } else if (tag === "data") {
      valid(align > 0 && !data && c.length > 0 && c.length % align === 0);
      data = true;
    } else valid(false);
  }
  valid(data);
}
function mp3(b: Buffer) {
  let at = 0,
    frames = 0,
    version: number | undefined,
    rate: number | undefined;
  let reservoir = 0;
  const mainData: Buffer[] = [],
    gaps: [number, number][] = [];
  let mainLength = 0,
    consumed = 0;
  while (at < b.length) {
    const h = b.readUInt32BE(at),
      v = (h >>> 19) & 3,
      layer = (h >>> 17) & 3,
      bitrate = (h >>> 12) & 15,
      sample = (h >>> 10) & 3;
    valid(
      h >>> 21 === 0x7ff &&
        v !== 1 &&
        layer === 1 &&
        bitrate > 0 &&
        bitrate < 15 &&
        sample < 3 &&
        (h & 3) !== 2,
    );
    valid(version === undefined || (version === v && rate === sample));
    version = v;
    rate = sample;
    const rates = [44100, 48000, 32000];
    const kbps =
      v === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const hz = (rates[sample] ?? 0) / (v === 3 ? 1 : v === 2 ? 2 : 4);
    const length = Math.floor(((v === 3 ? 144000 : 72000) * (kbps[bitrate] ?? 0)) / hz) + ((h >>> 9) & 1);
    const mono = ((h >>> 6) & 3) === 3,
      channels = mono ? 1 : 2;
    // CRC-protected frames need a separate checksum implementation; remain opaque.
    valid(((h >>> 16) & 1) === 1);
    const sideSize = v === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const side = new Bits(slice(b, at + 4, sideSize), 0);
    const back = side.read(v === 3 ? 9 : 8);
    valid(back <= reservoir);
    const start = mainLength - back,
      gap = Math.ceil(consumed / 8);
    valid(start * 8 >= consumed);
    if (start > gap) gaps.push([gap, start]);
    side.skip(v === 3 ? (mono ? 5 : 3) + channels * 4 : mono ? 1 : 2);
    let used = 0;
    for (let granule = 0; granule < (v === 3 ? 2 : 1); granule++)
      for (let channel = 0; channel < channels; channel++) {
        used += side.read(12);
        valid(side.read(9) <= 288);
        side.skip(8 + (v === 3 ? 4 : 9));
        const switching = side.read(1);
        if (switching) {
          valid(side.read(2) !== 0);
          side.skip(1);
        }
        for (let i = 0; i < (switching ? 2 : 3); i++) {
          const table = side.read(5);
          valid(table !== 4 && table !== 14);
        }
        if (switching) side.skip(9);
        else valid(side.read(4) + side.read(3) <= 20);
        side.skip(v === 3 ? 3 : 2);
      }
    valid(side.pos === sideSize * 8);
    const main = slice(b, at + 4 + sideSize, length - 4 - sideSize);
    valid(used <= (main.length + back) * 8);
    mainData.push(main);
    mainLength += main.length;
    consumed = start * 8 + used;
    reservoir = Math.min(v === 3 ? 511 : 255, Math.floor(((main.length + back) * 8 - used) / 8));
    at += length;
    frames++;
  }
  valid(frames > 0 && at === b.length);
  gaps.push([Math.ceil(consumed / 8), mainLength]);
  const bytes = Buffer.concat(mainData);
  // Ancillary space is not audio. Accept only fixed encoder identification and
  // padding, rather than letting unused reservoir bytes conceal opaque content.
  for (const [start, end] of gaps)
    valid(/^[\0U]*(?:LAME[0-9]\.[0-9]{3})?[\0U]*$/.test(bytes.toString("latin1", start, end)));
}
function comments(b: Buffer, start: number, framing: boolean) {
  let at = start;
  const text = () => {
    const n = b.readUInt32LE(at);
    at += 4;
    const s = slice(b, at, n);
    at += n;
    valid(n <= 65536 && !s.includes(0));
    new TextDecoder("utf8", { fatal: true }).decode(s);
  };
  text();
  const count = b.readUInt32LE(at);
  at += 4;
  valid(count <= 1024);
  for (let i = 0; i < count; i++) text();
  if (framing) valid(b[at++] === 1);
  valid(at === b.length);
}
function opus(b: Buffer) {
  valid(b.length > 0);
  const toc = b[0] ?? 0,
    code = toc & 3;
  let at = 1,
    end = b.length,
    count = code === 0 ? 1 : 2,
    vbr = code === 2;
  const length = () => {
    const first = b[at++];
    valid(first !== undefined);
    if (first < 252) return first;
    const second = b[at++];
    valid(second !== undefined);
    return first + 4 * second;
  };
  if (code === 3) {
    const flags = b[at++];
    valid(flags !== undefined);
    count = flags & 63;
    vbr = Boolean(flags & 128);
    valid(count > 0 && count <= 48);
    if (flags & 64) {
      let padding = 0,
        value: number | undefined;
      do {
        value = b[at++];
        valid(value !== undefined);
        padding += value === 255 ? 254 : value;
      } while (value === 255);
      valid(padding <= end - at);
      zero(b.subarray(end - padding));
      end -= padding;
    }
  }
  const config = toc >> 3;
  const duration =
    config >= 16
      ? 2.5 * (1 << (config & 3))
      : config >= 12
        ? 10 * (1 << (config & 1))
        : ([10, 20, 40, 60][config & 3] ?? 0);
  valid(count * duration <= 120);
  if (vbr) {
    let total = 0;
    for (let i = 1; i < count; i++) {
      const n = length();
      valid(n <= 1275);
      total += n;
    }
    valid(at + total <= end && end - at - total <= 1275);
  } else valid(end >= at && (end - at) % count === 0 && (end - at) / count <= 1275);
}
function ogg(b: Buffer) {
  let at = 0,
    seq = 0,
    serial: number | undefined,
    ended = false;
  let pending: Buffer[] = [];
  const packets: Buffer[] = [];
  while (at < b.length) {
    valid(!ended && b.toString("ascii", at, at + 4) === "OggS" && b[at + 4] === 0);
    const flags = b[at + 5] ?? 255,
      id = b.readUInt32LE(at + 14);
    valid(
      (flags & ~7) === 0 &&
        (seq === 0 ? flags === 2 : !(flags & 2)) &&
        Boolean(flags & 1) === Boolean(pending.length) &&
        b.readUInt32LE(at + 18) === seq &&
        (serial === undefined || serial === id),
    );
    serial = id;
    const segments = slice(b, at + 27, b[at + 26] ?? 0),
      length = segments.reduce((sum, n) => sum + n, 0);
    const page = Buffer.from(slice(b, at, 27 + segments.length + length)),
      expected = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    valid(crc(page, 32, 0x04c11db7) === expected);
    let p = at + 27 + segments.length;
    for (const size of segments) {
      pending.push(slice(b, p, size));
      p += size;
      if (size < 255) {
        packets.push(Buffer.concat(pending));
        pending = [];
      }
    }
    ended = Boolean(flags & 4);
    at = p;
    seq++;
  }
  valid(ended && !pending.length && packets.length >= 3);
  const first = packets[0];
  valid(first);
  if (first.toString("ascii", 0, 8) === "OpusHead") {
    valid(first.length === 19 && first[8] === 1 && (first[9] === 1 || first[9] === 2) && first[18] === 0);
    const tags = packets[1];
    valid(tags && tags.toString("ascii", 0, 8) === "OpusTags");
    comments(tags, 8, false);
    for (const p of packets.slice(2)) opus(p);
  } else valid(false); // Other codecs and Ogg multiplexing remain opaque.
}
function flac(b: Buffer) {
  valid(b.toString("ascii", 0, 4) === "fLaC");
  let at = 4,
    last = false,
    stream: Buffer | undefined;
  while (!last) {
    const type = b[at] ?? 255,
      n = b.readUIntBE(at + 1, 3),
      c = slice(b, at + 4, n);
    at += 4 + n;
    last = Boolean(type & 128);
    if (!stream) {
      valid((type & 127) === 0 && n === 34);
      stream = c;
    } else if ((type & 127) === 1) zero(c);
    else if ((type & 127) === 4) comments(c, 0, false);
    else if ((type & 127) === 3) valid(n % 18 === 0);
    else valid(false);
  }
  valid(stream);
  const rate = stream.readUInt32BE(10) >>> 12,
    channels = (((stream[12] ?? 0) >> 1) & 7) + 1;
  const depth = ((stream.readUInt16BE(12) >> 4) & 31) + 1;
  const total = Number(stream.readBigUInt64BE(10) & 0xfffffffffn);
  valid(rate > 0 && depth >= 4 && depth <= 32);
  let samples = 0,
    frames = 0;
  const pcm: Buffer[] = [],
    bytesPerSample = Math.ceil(depth / 8);
  while (at < b.length) {
    const start = at;
    valid(b[at] === 255 && ((b[at + 1] ?? 0) & 0xfe) === 0xf8 && !((b[at + 3] ?? 1) & 1));
    const variable = (b[at + 1] ?? 0) & 1,
      blockCode = (b[at + 2] ?? 0) >> 4,
      rateCode = (b[at + 2] ?? 0) & 15;
    const assignment = (b[at + 3] ?? 0) >> 4,
      depthCode = ((b[at + 3] ?? 0) >> 1) & 7;
    at += 4;
    valid(blockCode > 0 && rateCode < 15 && assignment <= 10 && depthCode !== 3);
    let number = b[at++];
    valid(number !== undefined);
    if (number >= 128) {
      let leading = 0;
      for (let mask = 128; number & mask; mask >>= 1) leading++;
      valid(leading >= 2 && leading <= 7);
      number &= (1 << (7 - leading)) - 1;
      for (let i = 1; i < leading; i++) {
        const v = b[at++];
        valid(v !== undefined && (v & 192) === 128);
        number = number * 64 + (v & 63);
      }
    }
    valid(number === (variable ? samples : frames));
    let block =
      blockCode === 1
        ? 192
        : blockCode <= 5
          ? 576 << (blockCode - 2)
          : blockCode >= 8
            ? 256 << (blockCode - 8)
            : 0;
    if (blockCode === 6) block = (b[at++] ?? -1) + 1;
    else if (blockCode === 7) {
      block = b.readUInt16BE(at) + 1;
      at += 2;
    }
    let frameRate =
      [rate, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000][rateCode] ?? 0;
    if (rateCode === 12) frameRate = (b[at++] ?? 0) * 1000;
    else if (rateCode >= 13) {
      frameRate = b.readUInt16BE(at) * (rateCode === 14 ? 10 : 1);
      at += 2;
    }
    const frameDepth = [depth, 8, 12, 0, 16, 20, 24, 32][depthCode];
    valid(
      frameRate === rate &&
        frameDepth === depth &&
        (assignment < 8 ? assignment + 1 : 2) === channels &&
        block > 0,
    );
    valid(crc(slice(b, start, at - start), 8, 7) === b[at++]);
    valid((samples + block) * channels * bytesPerSample <= MEDIA_LIMIT);
    const bits = new Bits(b, at);
    const decoded: number[][] = [];
    for (let channel = 0; channel < channels; channel++) {
      valid(bits.read(1) === 0);
      const type = bits.read(6),
        wasted = bits.read(1) ? bits.unary() + 1 : 0;
      const side =
        (assignment === 8 && channel === 1) ||
        (assignment === 9 && channel === 0) ||
        (assignment === 10 && channel === 1);
      const sampleBits = depth + (side ? 1 : 0) - wasted;
      valid(sampleBits > 0);
      const signed = (n: number) => {
        const sign = bits.read(1);
        return bits.read(n - 1) - sign * 2 ** (n - 1);
      };
      let values: number[] = [];
      if (type === 0) values = Array(block).fill(signed(sampleBits));
      else if (type === 1) for (let i = 0; i < block; i++) values.push(signed(sampleBits));
      else {
        valid((type >= 8 && type <= 12) || type >= 32);
        const order = type >= 32 ? (type & 31) + 1 : type - 8;
        valid(order <= block);
        for (let i = 0; i < order; i++) values.push(signed(sampleBits));
        let shift = 0;
        const coefficients = type >= 32 ? [] : [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]][order];
        valid(coefficients);
        if (type >= 32) {
          const precision = bits.read(4) + 1;
          valid(precision <= 15);
          shift = signed(5);
          for (let i = 0; i < order; i++) coefficients.push(signed(precision));
        }
        const method = bits.read(2),
          partition = bits.read(4);
        valid(method <= 1 && block % (1 << partition) === 0);
        const paramBits = method === 0 ? 4 : 5;
        for (let p = 0; p < 1 << partition; p++) {
          const n = block / (1 << partition) - (p === 0 ? order : 0);
          valid(n >= 0);
          const rice = bits.read(paramBits);
          const raw = rice === (1 << paramBits) - 1 ? bits.read(5) : undefined;
          for (let i = 0; i < n; i++) {
            let residual = 0;
            if (raw !== undefined) residual = raw ? signed(raw) : 0;
            else {
              const folded = bits.unary() * 2 ** rice + bits.read(rice);
              valid(Number.isSafeInteger(folded));
              residual = folded % 2 ? -(folded + 1) / 2 : folded / 2;
            }
            const prediction = coefficients.reduce(
              (sum, coefficient, j) => sum + coefficient * (values[values.length - j - 1] ?? 0),
              0,
            );
            valid(Number.isSafeInteger(prediction));
            values.push(residual + Math.floor(prediction / 2 ** shift));
          }
        }
      }
      valid(values.length === block);
      decoded.push(
        values.map((v) => {
          const sample = v * 2 ** wasted;
          valid(
            Number.isSafeInteger(sample) &&
              sample >= -(2 ** (depth + (side ? 1 : 0) - 1)) &&
              sample < 2 ** (depth + (side ? 1 : 0) - 1),
          );
          return sample;
        }),
      );
    }
    const frame = Buffer.alloc(block * channels * bytesPerSample);
    for (let i = 0; i < block; i++) {
      const first = decoded[0]?.[i] ?? 0,
        second = decoded[1]?.[i] ?? 0,
        mid = first * 2 + (second & 1);
      for (let channel = 0; channel < channels; channel++) {
        let value = decoded[channel]?.[i] ?? 0;
        if (assignment === 8 && channel === 1) value = first - second;
        else if (assignment === 9 && channel === 0) value = first + second;
        else if (assignment === 10) value = (mid + (channel === 0 ? second : -second)) / 2;
        valid(Number.isSafeInteger(value) && value >= -(2 ** (depth - 1)) && value < 2 ** (depth - 1));
        frame.writeIntLE(value, (i * channels + channel) * bytesPerSample, bytesPerSample);
      }
    }
    pcm.push(frame);
    while (bits.pos & 7) valid(bits.read(1) === 0);
    at = bits.pos / 8;
    valid(crc(slice(b, start, at - start), 16, 0x8005) === b.readUInt16BE(at));
    at += 2;
    samples += block;
    frames++;
  }
  valid(frames > 0 && (total === 0 || total === samples));
  const decoded = Buffer.concat(pcm);
  const views = [decoded];
  // Split reconstructed channels after stereo decorrelation, across frame boundaries.
  if (channels > 1)
    for (let channel = 0; channel < channels; channel++) {
      const view = Buffer.alloc(samples * bytesPerSample);
      for (let sample = 0; sample < samples; sample++) {
        const at = (sample * channels + channel) * bytesPerSample;
        decoded.copy(view, sample * bytesPerSample, at, at + bytesPerSample);
      }
      views.push(view);
    }
  // Interleaved and separate PCM channels can be recovered in either byte order.
  for (const view of views) {
    clean(view);
    for (let at = 0; at < view.length; at += bytesPerSample) view.subarray(at, at + bytesPerSample).reverse();
    clean(view);
  }
}

/** A failed parse removes the exemption; Allow: binary still permits the opaque blob. */
export function isInertMedia(path: string, bytes: Buffer): boolean {
  const extension = path.split(".").at(-1)?.toLowerCase();
  try {
    valid(bytes.length > 0 && bytes.length <= MEDIA_LIMIT);
    clean(bytes);
    switch (extension) {
      case "png":
        png(bytes);
        break;
      case "jpg":
      case "jpeg":
        jpeg(bytes);
        break;
      case "gif":
        gif(bytes);
        break;
      case "webp":
        webp(bytes);
        break;
      case "ico":
        ico(bytes);
        break;
      case "woff":
      case "woff2":
      case "ttf":
      case "otf":
        font(bytes, extension);
        break;
      case "mp3":
        mp3(bytes);
        break;
      case "ogg":
        ogg(bytes);
        break;
      case "wav":
        wav(bytes);
        break;
      case "flac":
        flac(bytes);
        break;
      default:
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
