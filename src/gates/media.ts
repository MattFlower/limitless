import { inflateSync } from "node:zlib";

// Unsupported structures and metadata stay opaque. Limit input and decompression so an
// exemption never depends on a truncated read or unbounded allocation.
export const MEDIA_LIMIT = 32 * 1024 * 1024;
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const HEADERS = [
  "7f454c46", // ELF
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe", // Mach-O
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca", // Fat Mach-O / Java
  "6465780a",
  "63646578", // DEX
  "0061736d", // WASM
  "377abcaf271c",
  "526172211a07",
  "1f8b08", // 7z, RAR, gzip
].map((s) => Buffer.from(s, "hex"));

/** ZIP readers search backwards for EOCD, and allow a prefix before the archive. */
function zip(b: Buffer): boolean {
  for (let end = b.length - 22; end >= Math.max(0, b.length - 22 - 65535); end--) {
    if (b.readUInt32LE(end) !== 0x06054b50 || end + 22 + b.readUInt16LE(end + 20) !== b.length) continue;
    const count = b.readUInt16LE(end + 10),
      size = b.readUInt32LE(end + 12),
      offset = b.readUInt32LE(end + 16),
      start = end - size,
      prefix = start - offset;
    if (
      b.readUInt16LE(end + 4) !== 0 ||
      b.readUInt16LE(end + 6) !== 0 ||
      b.readUInt16LE(end + 8) !== count ||
      prefix < 0 ||
      start < 0
    )
      continue;
    let at = start,
      entries = 0;
    while (entries < count && at + 46 <= end && b.readUInt32LE(at) === 0x02014b50) {
      const name = b.readUInt16LE(at + 28),
        extra = b.readUInt16LE(at + 30),
        comment = b.readUInt16LE(at + 32),
        local = prefix + b.readUInt32LE(at + 42);
      if (
        b.readUInt16LE(at + 34) !== 0 ||
        local + 30 > start ||
        b.readUInt32LE(local) !== 0x04034b50 ||
        local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28) + b.readUInt32LE(at + 20) >
          start ||
        b.readUInt16LE(local + 26) !== name ||
        !b.subarray(local + 30, local + 30 + name).equals(b.subarray(at + 46, at + 46 + name))
      )
        break;
      at += 46 + name + extra + comment;
      entries++;
    }
    if (entries === count && at === end) return true;
  }
  return false;
}

function executable(b: Buffer): boolean {
  if (HEADERS.some((magic) => b.subarray(0, magic.length).equals(magic))) return true;
  if (b.length < 64 || b.toString("ascii", 0, 2) !== "MZ") return false;
  const pe = b.readUInt32LE(60);
  return pe >= 64 && pe + 24 <= b.length && b.readUInt32LE(pe) === 0x00004550;
}

export function isForbiddenFormat(path: string, bytes: Buffer): boolean {
  return (
    /\.pdf$/i.test(path) ||
    bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) ||
    executable(bytes) ||
    zip(bytes) ||
    bytes.toString("ascii", 257, 262) === "ustar" ||
    bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")) ||
    bytes.subarray(0, 4).equals(Buffer.from("RIFF"))
  );
}

function valid(ok: unknown): asserts ok {
  if (!ok) throw new Error("Opaque media");
}
function slice(b: Buffer, at: number, length: number) {
  valid(length >= 0 && at >= 0 && at + length <= b.length);
  return b.subarray(at, at + length);
}
function zero(b: Buffer) {
  valid(b.every((v) => v === 0));
}
function inflate(b: Buffer) {
  const opts = { info: true as const, maxOutputLength: MEDIA_LIMIT };
  const result = inflateSync(b, opts) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  valid(result.engine.bytesWritten === b.length);
  return result.buffer;
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
    valid(Bun.hash.crc32(slice(b, at + 4, length + 4)) === b.readUInt32BE(at + 8 + length));
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
      if (previous && next < 4096) {
        dict[next++] = [...previous, entry[0] ?? 0];
        if (next === 1 << size && size < 12) size++;
      }
      previous = entry;
    }
    valid(count === width * height && Math.ceil(pos / 8) === packed.length);
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
  let alpha = false;
  let canvas: Buffer | undefined;
  for (const [i, { tag, data: c }] of chunks.entries()) {
    if (tag === "VP8X") {
      valid(i === 0 && c.length === 10 && ((c[0] ?? 255) & ~0x10) === 0);
      zero(c.subarray(1, 4));
      canvas = c;
    } else if (tag === "ALPH") {
      valid(canvas && !image && !alpha && canvas[0] === 0x10);
      valid(c.length > 1 && ((c[0] ?? 255) & ~0x1f) === 0 && ((c[0] ?? 0) & 3) <= 1);
      const width = canvas.readUIntLE(4, 3) + 1,
        height = canvas.readUIntLE(7, 3) + 1;
      if (((c[0] ?? 0) & 3) === 0) valid(c.length === 1 + width * height);
      else {
        const header = Buffer.alloc(5);
        header[0] = 0x2f;
        header.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
        lossless(Buffer.concat([header, c.subarray(1)]));
      }
      alpha = true;
    } else if (tag === "VP8 ") {
      valid(!image && (!canvas || Boolean((canvas[0] ?? 0) & 0x10) === alpha));
      const { width, height } = lossy(c);
      if (canvas) valid(canvas.readUIntLE(4, 3) + 1 === width && canvas.readUIntLE(7, 3) + 1 === height);
      image = true;
    } else if (tag === "VP8L") {
      valid(!image && !alpha && c.length > 5 && c[0] === 0x2f && c.readUInt32LE(1) >>> 29 === 0);
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

/** VP8 key-frame header and partition boundaries; RIFF accounts for the entire file. */
function lossy(b: Buffer) {
  const tag = b.readUIntLE(0, 3),
    first = tag >>> 5;
  valid((tag & 1) === 0 && ((tag >> 1) & 7) <= 3 && (tag & 16) !== 0);
  valid(slice(b, 3, 3).equals(Buffer.from("9d012a", "hex")));
  const width = b.readUInt16LE(6),
    height = b.readUInt16LE(8);
  valid(width > 0 && height > 0 && width < 16384 && height < 16384 && width * height * 4 <= MEDIA_LIMIT);
  const header = slice(b, 10, first);
  valid(first >= 2);
  // The token partition count is arithmetic-coded in the first partition.
  let range = 255,
    value = header.readUInt16BE(0),
    at = 2,
    shifts = 0;
  const bit = () => {
    const split = 1 + ((range - 1) >> 1),
      one = value >= split * 256;
    if (one) {
      value -= split * 256;
      range -= split;
    } else range = split;
    while (range < 128) {
      range *= 2;
      value *= 2;
      if (++shifts === 8) {
        valid(at < header.length);
        value += header[at++] ?? 0;
        shifts = 0;
      }
    }
    return Number(one);
  };
  const read = (n: number) => {
    let result = 0;
    for (let i = 0; i < n; i++) result = result * 2 + bit();
    return result;
  };
  read(2); // color space and clamping
  if (bit()) {
    const map = bit(),
      features = bit();
    if (features) {
      bit(); // absolute or delta segmentation
      for (const n of [7, 6]) for (let i = 0; i < 4; i++) if (bit()) read(n + 1);
    }
    if (map) for (let i = 0; i < 3; i++) if (bit()) read(8);
  }
  read(10); // filter type, level and sharpness
  const filterDeltas = bit();
  if (filterDeltas) {
    const update = bit();
    if (update) {
      for (let i = 0; i < 8; i++) {
        const changed = bit();
        if (changed) read(7);
      }
    }
  }
  const partitions = 1 << read(2);
  let cursor = 10 + first + 3 * (partitions - 1);
  valid(cursor < b.length);
  for (let i = 0; i < partitions - 1; i++) {
    const size = b.readUIntLE(10 + first + 3 * i, 3);
    valid(size > 0);
    cursor += size;
    valid(cursor < b.length);
  }
  return { width, height };
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
/** A failed parse removes the exemption; Allow: binary still permits the opaque blob. */
export function isInertMedia(path: string, bytes: Buffer): boolean {
  const extension = path.split(".").at(-1)?.toLowerCase();
  try {
    valid(bytes.length > 0 && bytes.length <= MEDIA_LIMIT);
    valid(!executable(bytes) && !zip(bytes));
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
      default:
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
