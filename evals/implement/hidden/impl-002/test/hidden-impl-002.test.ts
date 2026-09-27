import { describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";
import { textStats } from "../src/text.ts";

describe("textStats", () => {
  test("summarizes characters, words, sentences, paragraphs and reading time", () => {
    const text = "Hello world. This is text!";
    expect(textStats(text)).toEqual({
      characters: text.length,
      words: 5,
      sentences: 2,
      paragraphs: 1,
      readingTime: 1,
    });
  });

  test("counts a run of sentence punctuation as one terminator", () => {
    expect(textStats("What?! Wait... Done!!!").sentences).toBe(3);
  });

  test.each([
    ["one\ntwo", 1],
    ["one\n\ntwo", 2],
    ["one\n\n\n\ntwo\n\nthree", 3],
    ["one\r\n \r\n\r\ntwo", 2],
    ["\n \n one\n\ntwo \n\t\n", 2],
  ])("counts paragraphs in %j", (text, expected) => {
    expect(textStats(text).paragraphs).toBe(expected);
  });

  test("uses the default reading rate", () => {
    expect(textStats("word ".repeat(401)).readingTime).toBe(3);
  });

  test("empty and whitespace-only text", () => {
    expect(textStats("")).toEqual({
      characters: 0,
      words: 0,
      sentences: 0,
      paragraphs: 0,
      readingTime: 0,
    });
    expect(textStats(" \t\n")).toEqual({
      characters: 3,
      words: 0,
      sentences: 0,
      paragraphs: 0,
      readingTime: 0,
    });
  });
});

describe("stats command", () => {
  test("prints an aligned table", () => {
    expect(run(["stats", "Hello", "world!"])).toBe(
      [
        "Characters    12",
        "Words         2",
        "Sentences     1",
        "Paragraphs    1",
        "Reading time  1 minutes",
      ].join("\n"),
    );
  });

  test("prints JSON with --json", () => {
    const result = JSON.parse(run(["stats", "--json", "Hello", "world!"]));
    expect(result).toEqual({
      characters: 12,
      words: 2,
      sentences: 1,
      paragraphs: 1,
      readingTime: 1,
    });
    expect(result).toEqual(textStats("Hello world!"));
  });

  test("is listed in the usage text", () => {
    expect(run([])).toContain("stats");
  });
});
