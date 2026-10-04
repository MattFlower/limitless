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
        feedback: round ? "Repair the failed gate in this fresh invocation." : null,
        round,
        hasHoldout,
      });
      expect(prompt).toContain(
        "The factory commits. Do not run Git commands that write: add, commit, stash, or checkout -- <file>.",
      );
      expect(prompt).toContain("Read-only status, diff and log are fine.");
      expect(prompt).not.toContain("Committing is optional");
      expect(prompt).not.toContain("beyond only the listed criteria");
      expect(prompt).toContain(
        "Stay within the request and specification: add nothing that neither asks for. If part of the specification looks unnecessary for the request, still meet its acceptance criteria and name that part in your final report.",
      );
      // Implementers have killed other runs' gates, deploy gates and land checks with `pkill -f "bun test"`.
      expect(prompt).toContain(
        "Never stop or signal processes you did not start: no `pkill`, `killall` or `kill` by name or pattern.",
      );
      expect(prompt).toContain("Other runs, deploys and the user share this machine.");
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

test("merge resolution still prohibits all Git", () => {
  const prompt = implementPrompt({
    prompt: "resolve",
    spec: null,
    gates: { setup: [], checks: [], source: "none", protectedPaths: [] },
    baseline: null,
    baseSha: "base",
    feedback: null,
    round: 1,
    hasHoldout: false,
    resolution: true,
  });
  expect(prompt).toContain("Do not run Git. Edit files only; the factory stages and commits the merge.");
  expect(prompt).not.toContain("status, diff and log are fine");
});
