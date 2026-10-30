import { expect, test } from "bun:test";
import { type AcceptanceSnapshot, resolveIntent } from "../src/pipeline/acceptance.ts";

const issue = (number: number, body: string) => ({ number, body, author: { login: "owner" } });
// The ticket's intent lines start at line 4 of its body.
const snapshot = (ticket: string, parent: string): AcceptanceSnapshot => ({
  ticket: issue(9, `# Acceptance\n\n## The original intent\n${ticket}\n\n## Tests\n> Not intent.`),
  parent: issue(1, parent),
});
const resolve = (ticket: string, parent: string) => resolveIntent(snapshot(ticket, parent));
const texts = (ticket: string, parent: string) => resolve(ticket, parent).map((u) => u.text);
const brief = (units: ReturnType<typeof resolveIntent>) =>
  units.map((u) => [u.id, u.text, u.class, u.sources.join(",")]);
const goal = `#1's "Goal" section`;
// The section's own lines start at line 2 of the parent.
const inGoal = (body: string) => `## Goal\n${body}\n\n## End\n- Outside.`;
const unsupported = (line: number, where: string, kind: string) =>
  `unsupported Markdown in the intent: line ${line} of ${where}: ${kind}; normalize the ticket`;

const epic784 = `## Goal
Every acceptance ticket can be run by the factory.

## Why
- The orchestrator runs them by hand.
- Each run takes an hour.

## Where things stand
Covering tests landed in #915.

## Demo
Run an acceptance ticket and see one verdict per requirement.

## Risks
- A model could claim evidence it did not check.`;

test("a #784-shaped parent yields only the referenced Goal and Demo units", () => {
  const units = resolve(`${goal}\n\nIn short: the factory runs it.\n\n#1's "Demo" section`, epic784);
  expect(brief(units)).toEqual([
    ["U1", "Every acceptance ticket can be run by the factory.", "behaviour", '#1 "Goal"'],
    ["U2", "Run an acceptance ticket and see one verdict per requirement.", "behaviour", '#1 "Demo"'],
  ]);
});

test("a section's list items and paragraphs are its units, in order, and deeper headings are skipped", () => {
  const parent = `## Goal
Intro paragraph
spanning two lines.
- Dash item.
* Star item.
+ Plus item with a red | blue pipe.
1. Ordered item.
2) Other ordered item.

The service accepts red | blue tokens. <!-- kept as text -->
### Detail
Nested paragraph.

#### Deeper ##
- Nested item.

#1's "Other" section
## Next
- Outside.`;
  expect(texts(goal, parent)).toEqual([
    "Intro paragraph spanning two lines.",
    "Dash item.",
    "Star item.",
    "Plus item with a red | blue pipe.",
    "Ordered item.",
    "Other ordered item.",
    "The service accepts red | blue tokens. <!-- kept as text -->",
    "Nested paragraph.",
    "Nested item.",
    `#1's "Other" section`,
  ]);
});

test.each(["## Next", "# Top", "## Next ##", "##"])(
  "a same or higher heading ends the section: %s",
  (heading) => {
    expect(texts(goal, `## Goal\n- Before.\n${heading}\n- Outside.`)).toEqual(["Before."]);
  },
);

test("(docs) marks exactly its section's units, and a shared text is one unit", () => {
  const units = resolve(
    `${goal}\n#1's "Docs" section (docs)  \n${goal}`,
    "## Goal\n- Behaviour.\n- Shared.\n\n## Docs\n- Documentation.\n- Shared.",
  );
  expect(brief(units)).toEqual([
    ["U1", "Behaviour.", "behaviour", '#1 "Goal"'],
    ["U2", "Shared.", "behaviour", '#1 "Goal",#1 "Docs"'],
    ["U3", "Documentation.", "docs", '#1 "Docs"'],
  ]);
});

test("the referenced heading must be the parent's one column-0 ATX heading with that text", () => {
  const ambiguous = 'section "Goal" does not name exactly one heading of #1';
  expect(() => resolve(goal, "## Goal\n- a\n## Goal\n- b")).toThrow(ambiguous);
  expect(() => resolve(goal, "# Goal\n- a\n\n### Goal ###\n- b")).toThrow(ambiguous);
  expect(() => resolve(goal, "<details>\n\n## Goal\n- Hidden.\n</details>\n\n## Goal\n- Shown.")).toThrow(
    ambiguous,
  );
  expect(() => resolve(goal, "## Absent\n- a")).toThrow(ambiguous);
  expect(() => resolve(goal, "  ## Goal\n- a")).toThrow(ambiguous);
  expect(() => resolve(goal, "Goal\n====\n- a")).toThrow(ambiguous);
  // Only column-0 headings are candidates, and closing hashes need a preceding space.
  expect(texts(goal, "  ## Goal\n- Indented.\n\n## Goal\n- Required.")).toEqual(["Required."]);
  expect(
    texts(
      `#1's "Goal#" section`,
      "## Goal\n- Outside.\n## Goal#\n- Required.\n\n##No space\n####### Too many",
    ),
  ).toEqual(["Required.", "##No space ####### Too many"]);
  expect(() => resolve(`#821's "Goal" section`, "## Goal\n- a")).toThrow(
    "unresolvable source: #821 is not the parent",
  );
});

test.each([
  ["a fence hiding the only heading", "```md\n## Goal\n- Example only.\n## End\n```\n\n## Other", 1],
  ["an indented tilde fence", "Intro.\n\n   ~~~\n   code\n   ~~~\n\n## Goal\n- Required.", 3],
])("%s before the referenced section makes the parent unresolvable", (_name, parent, line) => {
  expect(() => resolve(goal, parent)).toThrow(
    `unresolvable source: line ${line} of #1: fence before the section`,
  );
});

test("a fence before the ticket's intent heading refuses, and lines after a section are not scanned", () => {
  expect(() =>
    resolveIntent({
      ticket: issue(9, `\`\`\`\n## The original intent\n${goal}\n\`\`\`\n\n## Tests`),
      parent: issue(1, "## Goal\n- a"),
    }),
  ).toThrow("unresolvable source: line 1 of the ticket: fence before the section");
  expect(texts(goal, "## Goal\n- Before.\n\n## End\n> Quote.\n<details>\n```\nunclosed")).toEqual([
    "Before.",
  ]);
});

test("CRLF and CR line endings keep line boundaries", () => {
  for (const eol of ["\r\n", "\r"]) {
    const units = resolveIntent({
      ticket: issue(9, ["## The original intent", goal, ""].join(eol)),
      parent: issue(1, ["## Goal", "- Required.", "## End", "- Outside."].join(eol)),
    });
    expect(units.map((u) => u.text)).toEqual(["Required."]);
  }
});

test("the intent's prose and list items are context; only whole reference lines resolve", () => {
  const parent = "## Goal\n- Required behaviour.\n\n## Risks\n- Context only.";
  expect(texts(`${goal}\n\nThis check does not use #1's "Risks" section.\n- Nor this.`, parent)).toEqual([
    "Required behaviour.",
  ]);
  expect(texts(`${goal}\n\n#1's "Risks"\nsection`, parent)).toEqual(["Required behaviour."]);
  expect(() => resolve("Only prose about the intent.", parent)).toThrow("resolves to no units");
  expect(() => resolveIntent({ ticket: issue(9, "No intent section."), parent: issue(1, parent) })).toThrow(
    "resolves to no units",
  );
});

const thematic = "thematic break, setext underline or table delimiter";
// Review round 3's reproductions as referenced sections, then round 3's own cases.
const sectionCases: [string, string, number, string][] = [
  ["lazy list item", "- Retry.\nNever omit.", 3, "list item continuation"],
  ["tab after a list marker", "-\tRetry.\n\n    Never omit.", 2, "malformed list item"],
  ["nested list item", "- Retry.\n  - Never omit.", 3, "indented line"],
  ["fenced item", "- Retry.\n\n  ```\n  example\n  ```\n\n  Never omit.", 4, "indented line"],
  ["details item", "- Retry.\n\n  <details>example</details>\n\n  Never omit.", 4, "indented line"],
  ["setext underline in an item", "- Retry.\n  ===\n\n  Never omit.", 3, "indented line"],
  ["lazy quote", "> Retry.\nNever omit.", 2, "blockquote"],
  ["nested quotes", "> First.\n>> Second.", 2, "blockquote"],
  ["escaped row in a continuation", "- Retry.\n\n  | A \\| B |", 4, "indented line"],
  ["thematic breaks", "Before.\n\n---\n\n***\n\nAfter.", 4, thematic],
  ["link definition", "Before.\n\n[policy]: https://example.com", 4, "link definition"],
  ["short backtick closer", "````md\n```\n## Hidden\n- Hidden.\n````", 2, "fence"],
  ["tilde fence", "~~~md\n```\n## Hidden\n~~~", 2, "fence"],
  ["HTML comment", "<!--\n## Hidden\n-->", 2, "HTML"],
  ["details", "<details>\n## Hidden\n</details >", 2, "HTML"],
  ["setext equals", "End\n===", 3, thematic],
  ["setext dashes", "End\n---", 3, thematic],
  ["indented code", "    code", 2, "indented line"],
  ["tab-indented code", "\tcode", 2, "indented line"],
  ["indented heading", "  ## End", 2, "indented line"],
  ["heading inside an item", "- Before.\n\n  ## In list\n  Never omit.", 4, "indented line"],
  ["list-item fence", "- ```md\n  ## Hidden\n  ```", 3, "indented line"],
  ["table row", "| The service accepts red \\| blue tokens. |", 2, "table row"],
  ["bare table", "Colour | Requirement\n--- | ---\nBlue | The service accepts blue tokens.", 3, thematic],
  ["spaced thematic break", "Before.\n\n* * *", 4, thematic],
  ["underscore break", "___", 2, thematic],
  ["footnote definition", "Before.\n\n[^1]: Note.", 4, "link definition"],
  ["empty ordered marker", "Before.\n\n1.", 4, "malformed list item"],
  ["empty plus marker", "+", 2, "malformed list item"],
];
const ticketCases: [string, string, number, string][] = [
  ["quote lead-in", "From #1:\n\n> - Unit one.", 4, "quote lead-in"],
  [
    "file lead-in after prose",
    "Context.\nFrom docs/PLAN.md (docs):\n> The queue skips untrusted issues.",
    5,
    "quote lead-in",
  ],
  ["quoted unit", `${goal}\n\n> Before.`, 6, "blockquote"],
  ["indented reference", `  ${goal}`, 4, "indented line"],
  ["fence in the intent", `\`\`\`\n${goal}\n\`\`\``, 4, "fence"],
];

test.each([
  ...sectionCases.map(([name, body, line, kind]) => [
    name,
    goal,
    inGoal(body),
    unsupported(line, "#1", kind),
  ]),
  ...ticketCases.map(([name, intent, line, kind]) => [
    name,
    intent,
    "## Goal\n- Before.",
    unsupported(line, "the ticket", kind),
  ]),
])("%s refuses, naming its line and kind", (_name, ticket, parent, message) => {
  expect(() => resolve(ticket, parent)).toThrow(message);
});
