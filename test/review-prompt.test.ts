import { expect, test } from "bun:test";
import { reviewPrompt } from "../src/pipeline/prompts.ts";
import { registerCredential } from "../src/util/proc.ts";

test("probe finder requires reproduction and distinguishes negative results from environment errors", () => {
  const prompt = reviewPrompt({
    prompt: "Fix the bug",
    spec: null,
    baseSha: "base",
    stat: "",
    gates: [],
    audit: [],
    implementerReport: "",
    finder: "probe",
  });
  for (const instruction of [
    "For each proposed blocker or major finding",
    "reproduce the defect",
    "throwaway test or command",
    "temporary files under TMPDIR",
    "only the affected test files",
    "never run the full suite",
    "attempted command and its observed result in the finding's detail",
    "completed probe does not reproduce",
    "lower the finding to minor or omit it",
    "sandbox or environment limits",
    "nested Seatbelt",
    "loopback servers",
    "Linux-only path",
    "retain its severity",
    "attempted command and the error in detail",
  ])
    expect(prompt).toContain(instruction);
});

test("large first-parent excerpts are bounded after redaction with full diff command and stats", () => {
  const secret = "review-patch-cutoff-credential";
  registerCredential("REVIEW_PATCH_CUTOFF_FIXTURE", secret);
  const firstParent = "a".repeat(40);
  const merge = "b".repeat(40);
  const prompt = reviewPrompt({
    prompt: "Resolve conflicts",
    spec: null,
    baseSha: "c".repeat(40),
    headSha: merge,
    stat: "survives.txt | 1 +",
    gates: [],
    audit: [],
    implementerReport: "",
    resolution: true,
    firstParentPatch: `${"-".repeat(39_988)}${secret}\n${"-lost PR hunk\n".repeat(100_000)}TAIL_HUNK`,
    firstParentStat:
      "greeting.txt | 103077 +---\nfile with spaces.txt | 2 +-\n2 files changed, 2 insertions(+), 103077 deletions(-)",
    firstParentRange: `${firstParent}..${merge}`,
    firstParentFiles: ["greeting.txt", "file with spaces.txt"],
  });
  expect(prompt.length).toBeLessThan(46_000);
  expect(prompt).toContain("truncated to 40000 characters");
  expect(prompt).toContain(
    `git --literal-pathspecs diff ${firstParent}..${merge} -- 'greeting.txt' 'file with spaces.txt'`,
  );
  expect(prompt).toContain("greeting.txt | 103077 +---");
  expect(prompt).toContain("file with spaces.txt | 2 +-");
  expect(prompt).toContain("2 files changed, 2 insertions(+), 103077 deletions(-)");
  expect(prompt).toContain("[redacted]");
  expect(prompt).not.toContain("review-patch-cutoff");
  expect(prompt).not.toContain("TAIL_HUNK");
});
