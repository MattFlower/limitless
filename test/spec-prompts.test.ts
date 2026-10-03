import { expect, test } from "bun:test";
import { specPrompt } from "../src/pipeline/prompts.ts";

test.each([
  ["trivial", "1–2"],
  ["small", "1–3"],
  ["medium", "3–5"],
  ["large", "5–8"],
  [undefined, "2–8"],
] as const)("spec prompt sizes criteria for %s complexity", (complexity, range) => {
  const prompt = specPrompt({ prompt: "Add farewell", answers: [], complexity });
  expect(prompt).toContain(`acceptance_criteria: ${range} observable`);
  expect(prompt).toContain(
    "Require a specific new test only where behavior is new or at risk of regression, not for every criterion",
  );
  expect(prompt).toContain("Each needs a concrete how_to_verify");
});

test("spec prompt confines the read-only rule to investigation", () => {
  const prompt = specPrompt({ prompt: "Add farewell", answers: [] });
  expect(prompt).toContain("task below.\n\nYou are only writing the specification");
  expect(prompt).toContain("while investigating the repository, read and search but do not edit files");
  expect(prompt).toContain("change itself will be implemented later");
  expect(prompt).not.toContain("DO NOT modify anything");
  expect(prompt).toContain("verifiable inside the run's own checkout");
  expect(prompt).toContain("using the repository's commands and tests");
  expect(prompt).toContain(
    "a person, the orchestrator, a browser, live external services, a deploy, or a later event",
  );
  expect(prompt).toContain("Put such concerns under assumptions or out_of_scope");
});
