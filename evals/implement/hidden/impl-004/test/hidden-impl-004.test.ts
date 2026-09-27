import { describe, expect, test } from "bun:test";
import { run } from "../src/cli.ts";
import { titleCase } from "../src/text.ts";

describe("titleCase", () => {
  test("does not capitalize letters after an accented letter", () => {
    expect(titleCase("café au lait")).toBe("Café Au Lait");
    expect(titleCase("crème brûlée")).toBe("Crème Brûlée");
  });

  test("capitalizes words that start with a non-ASCII letter", () => {
    expect(titleCase("élan vital")).toBe("Élan Vital");
    expect(titleCase("ωμέγα βήτα")).toBe("Ωμέγα Βήτα");
  });

  test("does not capitalize after an apostrophe", () => {
    expect(titleCase("don't stop")).toBe("Don't Stop");
    expect(titleCase("it’s over")).toBe("It’s Over");
  });

  test("still capitalizes hyphenated parts and words after punctuation", () => {
    expect(titleCase("well-known facts")).toBe("Well-Known Facts");
    expect(titleCase("(quoted) words")).toBe("(Quoted) Words");
  });

  test("leaves letters after digits and the rest of each word unchanged", () => {
    expect(titleCase("3rd place")).toBe("3rd Place");
    expect(titleCase("the quick fox")).toBe("The Quick Fox");
    expect(titleCase("ALREADY upper iPhone")).toBe("ALREADY Upper IPhone");
    expect(titleCase("one\ttwo\nthree")).toBe("One\tTwo\nThree");
    expect(titleCase("")).toBe("");
  });
});

describe("title command", () => {
  test("uses the fixed title casing", () => {
    expect(run(["title", "café", "au", "lait"])).toBe("Café Au Lait");
  });
});
