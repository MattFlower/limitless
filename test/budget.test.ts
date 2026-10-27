import { expect, test } from "bun:test";
import { commentRunRequest, issueRunRequest } from "../src/integrations/github.ts";
import { statedBudget } from "../src/pipeline/budget.ts";
import { registerCredential } from "../src/util/proc.ts";

test.each([
  ["## Budget\nAbout 80 changed source lines plus tests.", 80],
  ["Budget: about 120 source lines plus tests.", 120],
  ["## Budget\nAbout 1,200 lines.", 1200],
  ["Budget: 100–150 lines", 150],
  ["Budget: 100-150 lines", 150],
  ["# Budget ###\n80 lines", 80],
  ["Budget: 100 to 150 lines", 150],
  ["Budget: 100 — 150 lines", 150],
  ["- **Budget**: 80 lines", 80],
  ["  1) **Budget:** 80 LINES", 80],
  ["Budget: 80 one two three lines", 80],
])("reads a single budget: %s", (prompt, lines) => {
  expect(statedBudget(prompt)).toMatchObject({ kind: "figure", lines });
});

test.each([
  ["Budget: 0 lines", "zero"],
  ["Budget: about 100 source lines; stop at 150 lines", "ambiguous"],
  ["Budget: 100 plus 150 lines", "ambiguous"],
  ["Budget: 2 PRs", null],
  ["Budget: 80 lineup", null],
  ["Budget: 80 one two three four lines", null],
  ["Budget: none\n\n150 lines", null],
])("classifies missing or nonpositive budgets: %s", (prompt, kind) => {
  expect<string | null>(statedBudget(prompt)?.kind ?? null).toEqual(kind);
});

test("removes nested details, both fences and unclosed fences before selecting a section", () => {
  const ignored = "Budget: 999 lines";
  const prompt = `<details><summary>Old</summary>\n${ignored}\n<details>${ignored}</details>\n${ignored}</details>\n\n\x60\x60\x60ts\n${ignored}\n\x60\x60\x60\x60\n~~~\n${ignored}\n~~~~~\n## Plan\n### Budget\nAbout 80 lines.\n## Next\n900 lines\n`;
  expect(statedBudget(prompt)).toMatchObject({ kind: "figure", lines: 80 });
  expect(statedBudget(`~~~\n${ignored}\n## Budget\n80 lines`)).toBeNull();
  expect(statedBudget("## Budget\n80 lines\n### Included\n90 lines\n## End")).toMatchObject({
    kind: "ambiguous",
  });
  expect(statedBudget("Budget: 90 lines\n\n## Budget\n80 lines")).toMatchObject({ lines: 80 });
  expect(statedBudget("<details>Budget: 999 lines\n## Budget\n80 lines")).toBeNull();
});

test("selects each GitHub source independently", () => {
  const issueBody = "## Budget\n300 lines";
  const comment = (request: string, body = issueBody) =>
    commentRunRequest(
      {
        repo: "test/repo",
        number: 1,
        issueTitle: "Issue",
        issueBody: body,
        request,
        author: "owner",
      },
      "owner",
    ).prompt;
  expect(statedBudget(comment("Budget: 50 lines"))).toMatchObject({ lines: 50 });
  expect(statedBudget(comment("Implement this"))).toMatchObject({ lines: 300 });
  expect(statedBudget(comment("Budget: 0 lines"))).toMatchObject({ kind: "zero" });
  expect(statedBudget(comment("Budget: 50", "lines"))).toBeNull();
  const issue = issueRunRequest(
    { repo: "test/repo", number: 1, title: "Budget: 900 lines", body: issueBody, author: "owner" },
    "owner",
  );
  expect(statedBudget(issue.prompt)).toMatchObject({ lines: 300 });
});

test("redacts before collapsing and clipping budget text", () => {
  const secret = `budget-${"secret".repeat(42)}`;
  registerCredential("budget-test", secret);
  const result = statedBudget(`Budget: 80 lines ${secret} ${"description ".repeat(40)}`);
  expect(result?.text.length).toBeLessThanOrEqual(200);
  expect(result?.text).not.toContain("secret");
  expect(result?.text).toContain("[redacted]");
});
