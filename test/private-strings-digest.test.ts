import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrivateStrings, privateStringsDigest } from "../src/gates/private.ts";

const dir = mkdtempSync(join(tmpdir(), "private-digest-"));
afterEach(() => rmSync(join(dir, "private-strings.txt"), { force: true }));
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
const digest = (text?: string) => {
  if (text !== undefined) writeFileSync(join(dir, "private-strings.txt"), text);
  return privateStringsDigest(loadPrivateStrings(dir));
};

test("digest uses the sorted raw set after line parsing", () => {
  const value = digest(" apple \n# comment\n\npear\n");
  expect(value).toMatch(/^[a-f0-9]{64}$/);
  expect(digest("pear\napple\napple\n")).toBe(value);
  expect(digest("Apple\npear\n")).not.toBe(value);
  expect(digest("apple\nplum\n")).not.toBe(value);
  const ligature = digest("ﬁle\n");
  expect(digest("file\n")).not.toBe(ligature);
});

test("missing, empty and comments-only lists have one fixed digest", () => {
  const missing = digest();
  expect(digest("")).toBe(missing);
  expect(digest("\n # only comments\n\t\n")).toBe(missing);
  expect(missing).toBe("191a8c2516c2b981fb7ab2cc6317a9c29eb6a52a46515e39755f16b8568c93ba");
});
