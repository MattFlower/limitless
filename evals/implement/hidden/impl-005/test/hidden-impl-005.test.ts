import { describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";
import { wrap } from "../src/text.ts";

const FOX = "The quick brown fox jumps over the lazy dog";

describe("wrap", () => {
  test("fills each line greedily without exceeding the width", () => {
    expect(wrap(FOX, 10)).toBe("The quick\nbrown fox\njumps over\nthe lazy\ndog");
    expect(wrap(FOX, 15)).toBe("The quick brown\nfox jumps over\nthe lazy dog");
  });

  test("a line may be exactly as long as the width", () => {
    expect(wrap("abc def", 7)).toBe("abc def");
    expect(wrap("abc def", 6)).toBe("abc\ndef");
  });

  test("keeps a word longer than the width whole on its own line", () => {
    expect(wrap("a supercalifragilistic word", 5)).toBe("a\nsupercalifragilistic\nword");
  });

  test("treats any run of whitespace, including newlines, as one separator", () => {
    expect(wrap("  one\n\ntwo\tthree  ", 80)).toBe("one two three");
    expect(wrap("one\ntwo three", 7)).toBe("one two\nthree");
  });

  test("defaults to 80 columns", () => {
    const words = Array.from({ length: 20 }, () => "word");
    expect(wrap(words.join(" "))).toBe(`${words.slice(0, 16).join(" ")}\n${words.slice(16).join(" ")}`);
  });

  test("returns an empty string for empty or whitespace-only text", () => {
    expect(wrap("", 10)).toBe("");
    expect(wrap(" \n\t ", 10)).toBe("");
  });

  test("rejects widths that are not positive integers, even for empty text", () => {
    for (const width of [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => wrap("hello world", width)).toThrow(RangeError);
      expect(() => wrap("", width)).toThrow(RangeError);
    }
  });
});

describe("wrap command", () => {
  test("wraps at 80 columns by default", () => {
    expect(run(["wrap", "hello", "world"])).toBe("hello world");
  });

  test("accepts --width before the text", () => {
    expect(run(["wrap", "--width", "10", ...FOX.split(" ")])).toBe(
      "The quick\nbrown fox\njumps over\nthe lazy\ndog",
    );
  });

  test("prints an empty string for no text", () => {
    expect(run(["wrap"])).toBe("");
  });

  test("throws RangeError for an invalid or missing width", () => {
    for (const width of ["abc", "0", "-2", "1.5"]) {
      expect(() => run(["wrap", "--width", width, "hello"])).toThrow(RangeError);
    }
    expect(() => run(["wrap", "--width"])).toThrow(RangeError);
  });

  test("is listed in the usage text", () => {
    expect(run([])).toContain("wrap");
  });
});
