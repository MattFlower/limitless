import { expect, test } from "bun:test";
import { outOfRunCriteria } from "../src/pipeline/spec-criteria.ts";
import { specScopeViolation } from "../src/pipeline/spec-scope.ts";

const spec = {
  summary: "Add farewell.txt",
  assumptions: [],
  requirements: ["farewell.txt exists"],
  acceptance_criteria: [
    { id: "AC-1", criterion: "farewell.txt says goodbye", how_to_verify: "cat farewell.txt" },
  ],
  out_of_scope: [],
  blocking_questions: [],
};

test.each(
  "manual,manually,human,humans,owner,owners,orchestrator,reviewer approves,in a browser,visually,screenshot,screenshots,deploy,deploys,deployed,deploying,deployment,deployments,production,live API,after merge,wait for".split(
    ",",
  ),
)("out-of-run criteria match bounded phrases in how_to_verify only: %s", (phrase) => {
  expect(
    outOfRunCriteria({
      ...spec,
      acceptance_criteria: [
        { id: "AC-1", criterion: `(${phrase})`, how_to_verify: "bun test test/page.test.ts" },
      ],
    }),
  ).toEqual([]);
  for (const text of [phrase, phrase.toUpperCase(), phrase.replaceAll(" ", "\n ")]) {
    const criterion = { id: "AC-1", criterion: "Works", how_to_verify: `(${text})` };
    expect(outOfRunCriteria({ ...spec, acceptance_criteria: [criterion] })).toEqual([criterion]);
    expect(
      outOfRunCriteria({
        ...spec,
        acceptance_criteria: [{ ...criterion, how_to_verify: `pre${text}post` }],
      }),
    ).toEqual([]);
  }
  expect(outOfRunCriteria(spec)).toEqual([]);
  expect(
    outOfRunCriteria({
      ...spec,
      acceptance_criteria: [
        { id: "AC-1", criterion: "Test passes", how_to_verify: "bun test test/page.test.ts" },
      ],
    }),
  ).toEqual([]);
});

test("spec scope phrases normalize punctuation and leave ordinary documentation work alone", () => {
  for (const summary of [
    "SPECIFICATION—ONLY task",
    "Documentation  \nonly.",
    "Do NOT modify source code.",
    "No code changes.",
    "Do not modify code in this task.",
  ]) {
    expect(specScopeViolation({ ...spec, summary }, "Add farewell")).toBe(summary);
    expect(specScopeViolation({ ...spec, summary }, `${summary} Explain the behavior.`)).toBeNull();
  }
  for (const summary of [
    "Add code and documentation.",
    "Verify behavior without modifying fixtures.",
    "Document the read-only API.",
    "Do not change the code path for legacy users.",
    "Do not modify code outside src/pipeline.",
    "Must not edit the code generator output.",
    "Do not change code in existing callers.",
    "Existing plugins keep working without code changes.",
    "Existing plugins require no code changes.",
  ]) {
    expect(specScopeViolation({ ...spec, summary }, "Add farewell")).toBeNull();
    expect(specScopeViolation({ ...spec, summary: "No code changes." }, summary)).toBe("No code changes.");
  }
  // "X only" in ordinary prose is not a task restriction (a request that says it is still exempt).
  for (const summary of [
    "The README docs only list supported commands.",
    "The spec only covers the CLI path; the UI is out of scope.",
  ])
    expect(specScopeViolation({ ...spec, summary }, "Add farewell")).toBeNull();
  expect(
    specScopeViolation(
      {
        ...spec,
        acceptance_criteria: [{ id: "AC-1", criterion: "Works", how_to_verify: "Do not modify code" }],
      },
      "Add farewell",
    ),
  ).toBeNull();
});
