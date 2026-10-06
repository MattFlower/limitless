import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isForbiddenFormat, isInertMedia } from "../src/gates/media.ts";

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/media/files.json", import.meta.url), "utf8"),
) as Record<string, string>;
const incidental = JSON.parse(
  readFileSync(new URL("./fixtures/media/incidental-mz.json", import.meta.url), "utf8"),
) as Record<string, string>;
const fixture = (extension: string) => Buffer.from(fixtures[`0.${extension}`] ?? "", "base64");

test("cwebp lossy image with incidental MZ in compressed data passes", () => {
  const bytes = Buffer.from(incidental.webp ?? "", "base64");
  expect(isInertMedia("noise.webp", bytes)).toBe(true);
});

const pe = Buffer.alloc(88);
pe.write("MZ");
pe.writeUInt32LE(64, 60);
pe.write("PE\0\0", 64);
const executables = [pe, Buffer.from("7f454c46", "hex"), Buffer.from("0061736d01000000", "hex")];
for (const extension of ["png", "jpg", "gif", "webp", "ico"]) {
  test(`${extension} passes while ZIP polyglots and trailing executables block`, () => {
    const image = fixture(extension);
    expect(isInertMedia(`image.${extension}`, image)).toBe(true);
    const zip = Buffer.concat([image, fixture("zip")]);
    expect(isForbiddenFormat(`image.${extension}`, zip)).toBe(true);
    expect(isInertMedia(`image.${extension}`, zip)).toBe(false);
    for (const executable of executables)
      expect(isInertMedia(`image.${extension}`, Buffer.concat([image, executable]))).toBe(false);
  });
}

// The final pixels and mask can also be a ZIP, without trailing bytes in the ICO.
function bitmapIcon(payload: Buffer) {
  const bytes = Buffer.alloc(462);
  bytes.writeUInt16LE(1, 2);
  bytes.writeUInt16LE(1, 4);
  bytes[6] = 32;
  bytes[7] = 4;
  bytes.writeUInt16LE(1, 10);
  bytes.writeUInt16LE(24, 12);
  bytes.writeUInt32LE(440, 14);
  bytes.writeUInt32LE(22, 18);
  bytes.writeUInt32LE(40, 22);
  bytes.writeInt32LE(32, 26);
  bytes.writeInt32LE(8, 30);
  bytes.writeUInt16LE(1, 34);
  bytes.writeUInt16LE(24, 36);
  payload.copy(bytes, bytes.length - payload.length);
  return bytes;
}

test("ZIP recognition requires a consistent directory, including prefixed archives and comments", () => {
  const archive = fixture("zip");
  expect(isInertMedia("image.ico", bitmapIcon(archive))).toBe(false);
  expect(isForbiddenFormat("image.ico", bitmapIcon(archive))).toBe(true);
  const comment = Buffer.from("archive comment");
  const commented = Buffer.from(archive);
  commented.writeUInt16LE(comment.length, commented.length - 2);
  expect(isInertMedia("image.ico", bitmapIcon(Buffer.concat([commented, comment])))).toBe(false);
  const broken = Buffer.from(archive);
  broken.writeUInt32LE(0xffffffff, broken.length - 6);
  expect(isInertMedia("image.ico", bitmapIcon(broken))).toBe(true);
  expect(isForbiddenFormat("image.ico", bitmapIcon(broken))).toBe(false);
});

test("PE requires its signature at e_lfanew; other executable headers must start the file", () => {
  expect(isForbiddenFormat("blob", pe)).toBe(true);
  expect(isForbiddenFormat("blob", Buffer.from("MZ ordinary bytes"))).toBe(false);
  for (const bytes of [...executables.slice(1), Buffer.from("cffaedfe", "hex")]) {
    expect(isForbiddenFormat("blob", bytes)).toBe(true);
    expect(isForbiddenFormat("blob", Buffer.concat([Buffer.from("pixels"), bytes]))).toBe(false);
  }
});
