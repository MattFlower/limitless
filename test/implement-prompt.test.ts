import { expect, test } from "bun:test";
import { implementPrompt } from "../src/pipeline/prompts.ts";

for (const round of [0, 1]) {
  for (const hasHoldout of [true, false]) {
    test(`implement scope guidance: round ${round}, holdout ${hasHoldout}`, () => {
      const prompt = implementPrompt({
        prompt: "Add a farewell file",
        spec: null,
        gates: { setup: [], checks: [], source: "none", protectedPaths: [] },
        baseline: null,
        baseSha: "base123",
        feedback: null,
        round,
        hasHoldout,
      });
      expect(prompt).not.toContain("beyond only the listed criteria");
      expect(prompt).toContain(
        "Stay within the request and specification: add nothing that neither asks for. If part of the specification looks unnecessary for the request, still meet its acceptance criteria and name that part in your final report.",
      );
      if (round === 0 && hasHoldout) {
        expect(prompt).toContain(
          "A separate verifier will check private scenarios derived from the request, including edge and failure cases: handle the edge and failure cases the request implies, within its scope.",
        );
      } else {
        expect(prompt).not.toContain("A separate verifier will check private scenarios");
      }
    });
  }
}
