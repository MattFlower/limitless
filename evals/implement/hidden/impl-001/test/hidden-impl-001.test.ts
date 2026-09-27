import { describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";
import { readingTime } from "../src/text.ts";

describe("readingTime", () => {
  test("uses 200 words per minute by default and rounds up", () => {
    expect(readingTime("word ".repeat(200).trim())).toBe(1);
    expect(readingTime("word ".repeat(400).trim())).toBe(2);
    expect(readingTime("word ".repeat(401))).toBe(3);
  });

  test("non-empty text takes at least one minute", () => {
    expect(readingTime("hello world")).toBe(1);
    expect(readingTime("one", 1000)).toBe(1);
  });

  test("empty and whitespace-only text take zero minutes", () => {
    expect(readingTime("")).toBe(0);
    expect(readingTime("   ")).toBe(0);
    expect(readingTime(" \t\n ", 50)).toBe(0);
  });

  test("honors a custom rate and counts whitespace-separated words", () => {
    expect(readingTime("one two three four five", 2)).toBe(3);
    expect(readingTime(" one\ttwo\nthree ", 2)).toBe(2);
    expect(readingTime("one two three four", 2)).toBe(2);
  });

  test("rejects non-positive and non-finite rates, even for empty text", () => {
    for (const wpm of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => readingTime("hello", wpm)).toThrow(RangeError);
      expect(() => readingTime("", wpm)).toThrow(RangeError);
    }
  });
});

describe("reading-time command", () => {
  test("prints minutes at the default rate", () => {
    expect(run(["reading-time", "hello", "world"])).toBe("1");
  });

  test("accepts --wpm before the text", () => {
    expect(run(["reading-time", "--wpm", "2", "one", "two", "three", "four", "five"])).toBe("3");
  });

  test("prints 0 for no text", () => {
    expect(run(["reading-time"])).toBe("0");
  });

  test("throws RangeError for an invalid or missing rate", () => {
    for (const wpm of ["nope", "0", "-5", "Infinity"]) {
      expect(() => run(["reading-time", "--wpm", wpm, "hello"])).toThrow(RangeError);
    }
    expect(() => run(["reading-time", "--wpm"])).toThrow(RangeError);
  });

  test("is listed in the usage text", () => {
    expect(run([])).toContain("reading-time");
  });
});
