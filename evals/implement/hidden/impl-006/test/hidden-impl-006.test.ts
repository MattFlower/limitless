import { describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";
import { wordFrequencies } from "../src/text.ts";

describe("wordFrequencies", () => {
  test("sorts by count, breaking ties by first appearance", () => {
    expect(wordFrequencies("the cat and the hat and the bat")).toEqual([
      { word: "the", count: 3 },
      { word: "and", count: 2 },
      { word: "cat", count: 1 },
      { word: "hat", count: 1 },
      { word: "bat", count: 1 },
    ]);
  });

  test("strips leading and trailing punctuation but keeps inner punctuation", () => {
    expect(wordFrequencies('"Hello," she said. Hello! (don\'t) — well-known...')).toEqual([
      { word: "Hello", count: 2 },
      { word: "she", count: 1 },
      { word: "said", count: 1 },
      { word: "don't", count: 1 },
      { word: "well-known", count: 1 },
    ]);
  });

  test("keeps accented letters and digits", () => {
    expect(wordFrequencies("café naïve café 42 42 42")).toEqual([
      { word: "42", count: 3 },
      { word: "café", count: 2 },
      { word: "naïve", count: 1 },
    ]);
  });

  test("is case-sensitive by default", () => {
    expect(wordFrequencies("The the THE cat")).toEqual([
      { word: "The", count: 1 },
      { word: "the", count: 1 },
      { word: "THE", count: 1 },
      { word: "cat", count: 1 },
    ]);
  });

  test("ignoreCase compares and reports words in lowercase", () => {
    expect(wordFrequencies("The the THE Cat café CAFÉ", { ignoreCase: true })).toEqual([
      { word: "the", count: 3 },
      { word: "café", count: 2 },
      { word: "cat", count: 1 },
    ]);
  });

  test("returns an empty list when there are no words", () => {
    expect(wordFrequencies("")).toEqual([]);
    expect(wordFrequencies("  \n\t ")).toEqual([]);
    expect(wordFrequencies("— ... !!")).toEqual([]);
  });
});

describe("freq command", () => {
  test("prints one `<count> <word>` line per word, most frequent first", () => {
    expect(run(["freq", "the", "cat", "the", "hat"])).toBe("2 the\n1 cat\n1 hat");
  });

  test("--top limits the number of lines", () => {
    expect(run(["freq", "--top", "1", "a", "b", "b"])).toBe("2 b");
    expect(run(["freq", "--top", "10", "a", "b", "b"])).toBe("2 b\n1 a");
  });

  test("--ignore-case folds case", () => {
    expect(run(["freq", "--ignore-case", "The", "the", "cat"])).toBe("2 the\n1 cat");
  });

  test("options can be combined in either order", () => {
    const words = ["A", "a", "B", "c", "b", "b"];
    expect(run(["freq", "--ignore-case", "--top", "2", ...words])).toBe("3 b\n2 a");
    expect(run(["freq", "--top", "2", "--ignore-case", ...words])).toBe("3 b\n2 a");
  });

  test("prints an empty string when there are no words", () => {
    expect(run(["freq"])).toBe("");
    expect(run(["freq", "--top", "3"])).toBe("");
  });

  test("throws RangeError when --top is not a positive integer or is missing", () => {
    for (const top of ["0", "-1", "1.5", "abc"]) {
      expect(() => run(["freq", "--top", top, "a"])).toThrow(RangeError);
    }
    expect(() => run(["freq", "--top"])).toThrow(RangeError);
  });

  test("is listed in the usage text", () => {
    expect(run([])).toContain("freq");
  });
});
