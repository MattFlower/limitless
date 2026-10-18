import { expect, test } from "bun:test";
import type { GateResult, GateRun } from "../src/gates/run.ts";
import { FACTORY_PREAMBLE, implementPrompt } from "../src/pipeline/prompts.ts";

const passed: GateResult = {
  name: "test",
  command: "bun test",
  ok: true,
  exitCode: 0,
  durationMs: 1,
  output: "",
  confinementError: false,
};
const failed = { ...passed, ok: false, exitCode: 1 };

function promptWithBaseline(baseline: GateRun | null): string {
  return implementPrompt({
    prompt: "Fix the bug",
    spec: null,
    gates: {
      setup: [],
      checks: [{ name: "test", run: "bun test" }],
      source: "none",
      protectedPaths: [],
    },
    baseline,
    baseSha: "base",
    feedback: null,
    round: 0,
    hasHoldout: false,
  });
}

test.each(["flag", "output", "passing output", "firstAttempt", "targetedRetry"] as const)(
  "implement guidance for an unusable baseline detected via %s",
  (kind) => {
    const confinement = {
      ...(kind === "passing output" ? passed : failed),
      ...(kind === "flag"
        ? { confinementError: true }
        : { confinementError: undefined, output: "sandbox_apply: Operation not permitted" }),
    };
    const check =
      kind === "firstAttempt" || kind === "targetedRetry" ? { ...passed, [kind]: confinement } : confinement;
    const prompt = promptWithBaseline({ setupOk: true, setup: [], checks: [check] });
    expect(prompt).toContain("baseline result unavailable for comparison");
    expect(prompt).toContain("a failing candidate check will block");
    expect(prompt).not.toContain("already FAILING");
    expect(prompt).not.toContain("not your fault");
    expect(prompt).not.toContain("fix only if in scope");
  },
);

test.each(["ordinary failure", "passing", "missing counterpart", "no baseline"])(
  "implement baseline guidance: %s",
  (kind) => {
    const baseline =
      kind === "no baseline"
        ? null
        : {
            setupOk: true,
            setup: [],
            checks: [
              kind === "ordinary failure"
                ? failed
                : kind === "missing counterpart"
                  ? { ...failed, name: "lint" }
                  : passed,
            ],
          };
    const prompt = promptWithBaseline(baseline);
    const guidance = "already FAILING on the base branch (not your fault, fix only if in scope)";
    if (kind === "ordinary failure") expect(prompt).toContain(guidance);
    else expect(prompt).not.toContain(guidance);
    expect(prompt).not.toContain("unavailable for comparison");
    expect(prompt).not.toContain("a failing candidate check will block");
  },
);

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

test("every factory role receives the shared-machine process rule", () => {
  expect(FACTORY_PREAMBLE).toMatch(/never signal processes you did not start/i);
  expect(FACTORY_PREAMBLE).toContain("never pkill/killall by name");
  expect(FACTORY_PREAMBLE).toContain("other runs and the user share this machine");
});
