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

// Representative static section: the request quotes these parent labels, but omits #822's full text.
const epic822 = `## Epic Q: issues are the work queue
- Issues are the work queue.
- **Order:**
  - Process issues in order.
  - Respect dependencies.
- **Claim (exactly once), on every path.**
  - Claim an issue before starting work.
  - Avoid duplicate runs.
- Keep the queue visible.
## Next
- Outside.`;

test("a #822-shaped section keeps parent units and contextual children in order", () => {
  const units = resolveIntent({
    ticket: issue(828, `## The original intent\n#822's "Epic Q: issues are the work queue" section`),
    parent: issue(822, epic822),
  });
  expect(brief(units)).toEqual([
    ["U1", "Issues are the work queue.", "behaviour", '#822 "Epic Q: issues are the work queue"'],
    ["U2", "**Order:**", "behaviour", '#822 "Epic Q: issues are the work queue"'],
    ["U3", "**Order:** — Process issues in order.", "behaviour", '#822 "Epic Q: issues are the work queue"'],
    ["U4", "**Order:** — Respect dependencies.", "behaviour", '#822 "Epic Q: issues are the work queue"'],
    [
      "U5",
      "**Claim (exactly once), on every path.**",
      "behaviour",
      '#822 "Epic Q: issues are the work queue"',
    ],
    [
      "U6",
      "**Claim (exactly once), on every path.** — Claim an issue before starting work.",
      "behaviour",
      '#822 "Epic Q: issues are the work queue"',
    ],
    [
      "U7",
      "**Claim (exactly once), on every path.** — Avoid duplicate runs.",
      "behaviour",
      '#822 "Epic Q: issues are the work queue"',
    ],
    ["U8", "Keep the queue visible.", "behaviour", '#822 "Epic Q: issues are the work queue"'],
  ]);
});

test.each(["-", "*", "+", "1.", "2)", "123456789.", "999999999)"])(
  "marker %s works for parents and children",
  (marker) => {
    expect(
      texts(goal, inGoal(`${marker} Parent.\n  ${marker} First.\n  - Second.\n+ Next.\n  * Third.`)),
    ).toEqual(["Parent.", "Parent. — First.", "Parent. — Second.", "Next.", "Next. — Third."]);
  },
);

test("children preserve normalization, written-text deduplication, sources and behaviour precedence", () => {
  const parent = `## Goal
- Parent  text.
  - Use \`a  b\`.
  - Use \`a b\`.
## Docs
- Parent  text.
  - Use \`a  b\`.`;
  expect(brief(resolve(`#1's "Docs" section (docs)\n${goal}\n${goal}`, parent))).toEqual([
    ["U1", "Parent text.", "behaviour", '#1 "Docs",#1 "Goal"'],
    ["U2", "Parent text. — Use `a b`.", "behaviour", '#1 "Docs",#1 "Goal"'],
    ["U3", "Parent text. — Use `a b`.", "behaviour", '#1 "Goal"'],
  ]);
  expect(brief(resolve(`${goal} (docs)`, parent))).toEqual([
    ["U1", "Parent text.", "docs", '#1 "Goal"'],
    ["U2", "Parent text. — Use `a b`.", "docs", '#1 "Goal"'],
    ["U3", "Parent text. — Use `a b`.", "docs", '#1 "Goal"'],
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

test("the intent's prose is context; only whole reference lines resolve", () => {
  const parent = "## Goal\n- Required behaviour.\n\n## Risks\n- Context only.";
  expect(texts(`${goal}\n\nThis check does not use #1's "Risks" section.`, parent)).toEqual([
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
  ["orphan child", "  - Never omit.", 2, "orphan sub-item"],
  ["three-space item", "- Parent.\n  - Child.\n   - Too deep.", 4, "indented line"],
  ["nested child", "- Parent.\n  - Child.\n    - Too deep.", 4, "indented line"],
  ["tab-indented item", "- Parent.\n  - Child.\n\t- Too deep.", 4, "indented line"],
  ["mixed tab indentation", "- Parent.\n  - Child.\n  \t- Too deep.", 4, "indented line"],
  ["child after paragraph", "- Parent.\n  - Child.\n\nParagraph.\n  - Orphan.", 6, "orphan sub-item"],
  ["child after blank", "- Parent.\n  - Child.\n\n  - Orphan.", 5, "orphan sub-item"],
  ["child after heading", "- Parent.\n  - Child.\n### Detail\n  - Orphan.", 5, "orphan sub-item"],
  ["unindented child continuation", "- Parent.\n  - Child.\nNever omit.", 4, "list item continuation"],
  ["indented child continuation", "- Parent.\n  - Child.\n  Never omit.", 4, "indented line"],
  ["child marker tab separator", "- Parent.\n  - Child.\n  -\tInvalid.", 4, "indented line"],
  ["empty child marker", "- Parent.\n  - Child.\n  +", 4, "indented line"],
  ["empty ordered child marker", "- Parent.\n  - Child.\n  1. ", 4, "indented line"],
  ["ten-digit child marker", "- Parent.\n  - Child.\n  1234567890. Invalid.", 4, "indented line"],
  ["two-space dash thematic break", "- Parent.\n  - Child.\n  - - -", 4, thematic],
  ["two-space star thematic break", "- Parent.\n  - Child.\n  * * *", 4, thematic],
  ["two-space bare thematic break", "- Parent.\n  - Child.\n  ---", 4, "indented line"],
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
  ["child in ticket", `${goal}\n  - A requirement of its own.`, 5, "indented line"],
  ["fence in the intent", `\`\`\`\n${goal}\n\`\`\``, 4, "fence"],
  // A requirement written as a list item next to a reference would otherwise be dropped silently.
  [
    "list item beside a reference",
    `${goal}\n- A requirement of its own.`,
    5,
    "list item; only section references produce units",
  ],
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

test("round 4 review: edge spellings never drop, split or merge a requirement", () => {
  // Only ASCII spaces and tabs trim: `##` followed by NBSP is paragraph text, so nothing after it is lost.
  expect(texts(goal, inGoal("Before.\n## \nNever omit."))).toEqual(["Before. ## Never omit."]);
  // `2.` inside a paragraph is text on GitHub; splitting it off would quote part of a rendered paragraph.
  expect(() => resolve(goal, inGoal("Keep the rejection\n2. Never retry."))).toThrow(
    unsupported(3, "#1", "numbered line inside a paragraph"),
  );
  // A list starting at 1 may interrupt a paragraph, as on GitHub.
  expect(texts(goal, inGoal("Keep the rejection.\n1. Never retry."))).toEqual([
    "Keep the rejection.",
    "Never retry.",
  ]);
  // Code spans keep their spacing, so these are two requirements, not one.
  expect(texts(goal, inGoal("Use `a  b`.\n\nUse `a b`."))).toHaveLength(2);
});

test("a unit referenced with and without (docs) requires behaviour evidence in either order", () => {
  const parent = "## Goal\n- Required.";
  for (const ticket of [`${goal} (docs)\n${goal}`, `${goal}\n${goal} (docs)`])
    expect(brief(resolve(ticket, parent))).toEqual([["U1", "Required.", "behaviour", '#1 "Goal"']]);
});
