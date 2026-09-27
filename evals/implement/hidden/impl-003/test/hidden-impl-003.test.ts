import { describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";
import { stripPunctuation } from "../src/text.ts";

describe("stripPunctuation", () => {
  test("deletes ASCII punctuation and symbols but keeps letters and digits", () => {
    expect(stripPunctuation("Hi, world! #1 @home + 2")).toBe("Hi world 1 home 2");
    expect(stripPunctuation("hello-world_42")).toBe("helloworld42");
    expect(stripPunctuation('a$b%c&d*e(f)g"h')).toBe("abcdefgh");
  });

  test("deletes curly quotes and dashes without touching accented letters", () => {
    expect(stripPunctuation("“Café”—crème–brûlée")).toBe("Cafécrèmebrûlée");
    expect(stripPunctuation("‘naïve’ señor")).toBe("naïve señor");
  });

  test("keeps emoji, including joined sequences", () => {
    expect(stripPunctuation("Hi, 👩‍💻! 😀")).toBe("Hi 👩‍💻 😀");
  });

  test("collapses and trims remaining whitespace", () => {
    expect(stripPunctuation("  A,\t \n B!  ")).toBe("A B");
    expect(stripPunctuation("one , two")).toBe("one two");
  });

  test("returns an empty string for empty, whitespace-only and punctuation-only input", () => {
    expect(stripPunctuation("")).toBe("");
    expect(stripPunctuation(" \t\n ")).toBe("");
    expect(stripPunctuation("?!—")).toBe("");
  });
});

describe("strip-punctuation command", () => {
  test("joins its arguments and strips punctuation", () => {
    expect(run(["strip-punctuation", "Hello,", "world!"])).toBe("Hello world");
  });

  test("prints an empty string for no text", () => {
    expect(run(["strip-punctuation"])).toBe("");
  });

  test("is listed in the usage text", () => {
    expect(run([])).toContain("strip-punctuation");
  });
});
