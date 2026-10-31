import { expect, test } from "bun:test";
import { CHECKLIST_CAP, checklistPrompt } from "../src/evals/checklist.ts";
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

const privacyRule =
  "## Privacy\n- Decode: decode before you redact and redact before you truncate.\n  Keep this continuation.\n";
const defectHeading = "## Defects reviews keep finding\n";

test("checklist extracts whole source-ordered bullets and fences embedded delimiters", () => {
  const source = `${privacyRule}- Unrelated privacy rule.\n${defectHeading}Intro, not a rule.\n- **First.** Trace the path.\n  Continued detail.\n  \`\`\`\`text\n  - fenced bullet\n  ## Privacy\n  \`\`\`\`\n- **Second.** Check input.\n## Other\n- Excluded rule.\n`;
  const prompt = checklistPrompt(source.replace(/\n/g, "\r\n"));
  expect(prompt).toContain("[privacy-1] Decode:");
  expect(prompt).toContain("Keep this continuation.");
  expect(prompt).toContain("[defect-1] **First.**");
  expect(prompt).toContain("Continued detail.");
  expect(prompt).toContain("[defect-2] **Second.**");
  expect(prompt.indexOf("[privacy-1]")).toBeLessThan(prompt.indexOf("[defect-1]"));
  expect(prompt).toContain("\n`````text\n");
  expect(prompt).toContain("\n`````\n");
  expect(prompt).toContain("omitted 0 whole items");
  for (const excluded of ["Intro, not a rule", "Unrelated privacy", "Excluded rule", "[defect-3]"])
    expect(prompt).not.toContain(excluded);
});

test("checklist cap retains whole items without skipping ahead and redacts before bounding", () => {
  const secret = "checklist-fixture-credential";
  registerCredential("CHECKLIST_FIXTURE", secret);
  const source = `${privacyRule}${defectHeading}- First ${secret}\n- ${"x".repeat(CHECKLIST_CAP)}\n- LAST_ITEM\n`;
  const prompt = checklistPrompt(source);
  expect(prompt).toContain("[defect-1] First [redacted]");
  expect(prompt).not.toContain(secret);
  expect(prompt).not.toContain("[defect-2]");
  expect(prompt).not.toContain("LAST_ITEM");
  expect(prompt).toContain("omitted 2 whole items");
  const content = prompt.split("```text\n")[1]?.split("\n```")[0];
  expect(content?.length).toBeLessThanOrEqual(CHECKLIST_CAP);
  const prefix =
    "[privacy-1] Decode: decode before you redact and redact before you truncate.\n  Keep this continuation.\n\n[defect-1] ";
  const exact = `${privacyRule}${defectHeading}- ${"a".repeat(CHECKLIST_CAP - prefix.length)}\n- over\n`;
  const bounded = checklistPrompt(exact).split("```text\n")[1]?.split("\n```")[0];
  expect(bounded?.length).toBe(CHECKLIST_CAP);
  expect(checklistPrompt(exact)).toContain("omitted 1 whole items");
});

test.each([
  null,
  "",
  `${privacyRule}${defectHeading}No bullets.`,
  `${defectHeading}- Rule.`,
  `${defectHeading}- Rule.\n## Privacy\n- decode before you redact only`,
  `## Other\n- decode before you redact and redact before you truncate.\n${defectHeading}- Rule.`,
])("checklist fails explicitly for missing required base content (%s)", (source) => {
  expect(() => checklistPrompt(source)).toThrow(/adversarial-checklist: .*base AGENTS.md/);
});

test("trace finder searches universal clauses and restart entry points with concrete evidence only", () => {
  const prompt = reviewPrompt({
    prompt: "Every path must validate, including on resume",
    spec: null,
    baseSha: "base",
    stat: "src/check.ts | 1 +",
    gates: [],
    audit: [],
    implementerReport: "",
    finder: "trace",
  });
  for (const instruction of [
    "First list",
    "every, all, never, only",
    "ordering constraints",
    "on-resume",
    "guard the diff adds or changes",
    "use rg",
    "sibling callers",
    "alternate entry points",
    "files outside the diff",
    "persisted state",
    "outlives a restart",
    "positive line number",
    "violated request clause",
    "failure scenario",
    "speculative blockers",
    "unsuccessful searches",
    "empty findings list",
    "do not perform general logic review",
  ])
    expect(prompt).toContain(instruction);
  expect(prompt).not.toContain("Correctness: bugs, edge cases");
  expect(prompt).not.toContain("a separate step verifies");
});

test("production and adversarial openings are unchanged and the eval additions append one block", () => {
  const input = {
    prompt: "Fix the bug",
    spec: null,
    baseSha: "base",
    stat: "src/a.ts | 1 +",
    gates: [],
    audit: [],
    implementerReport: "",
  };
  // Stored trials are compared against these exact openings; a resumed eval must keep them.
  expect(reviewPrompt(input).split("\n")[0]).toBe(
    "You are an adversarial code reviewer. A different AI model implemented the change below. Your job is to find real problems before it merges — not to be agreeable. Approve only if you would be comfortable merging this into production code you are responsible for.",
  );
  const adversarial = reviewPrompt({ ...input, finder: "adversarial" });
  const opening = adversarial.split("\n")[0] ?? "";
  expect(opening).toBe(
    "You are an adversarial code reviewer. A different AI model implemented the change below. Assume the change can fail, and find out how. Trace bad and boundary inputs, retries, partial failure, ordering, restarts, and version skew between old and new code or data. Give no credit for intent: judge what the code does, not what its comments, names or commit messages say. Report every issue you believe is real, with your confidence; a separate step verifies each finding.",
  );
  const rest = adversarial.slice(opening.length);
  const blocks = new Map<string, string>();
  for (const [finder, instructions] of [
    [
      "adversarial-thorough",
      [
        "Do not stop at the first finding",
        "second-order failures",
        "every removed or replaced block",
        "Never invent a finding",
      ],
    ],
    [
      "adversarial-callers",
      [
        "callers and alternate entry points",
        "files outside the diff",
        "invariant it enforced",
        "name that code by file and line",
      ],
    ],
    [
      "adversarial-calibrated",
      [
        "Severity alone decides whether a finding blocks",
        "next month of normal factory operation",
        "a new test that fails in normal runs stops deploys",
        "stored or shown unredacted",
        "Process asks (a report, measurements, PR text) are not code defects",
        "Lower a finding to minor rather than dropping it",
      ],
    ],
    [
      "adversarial-thorough-calibrated",
      ["Do not stop at the first finding", "next month of normal factory operation"],
    ],
  ] as const) {
    const variant = reviewPrompt({ ...input, finder });
    expect(variant.startsWith(`${opening}\n\n`)).toBe(true);
    expect(variant.endsWith(rest)).toBe(true);
    const block = variant.slice(opening.length + 2, variant.length - rest.length);
    for (const instruction of instructions) expect(block).toContain(instruction);
    blocks.set(finder, block);
  }
  expect(blocks.get("adversarial-thorough-calibrated")).toBe(
    `${blocks.get("adversarial-thorough")}\n\n${blocks.get("adversarial-calibrated")}`,
  );
});
