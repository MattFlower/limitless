import { expect, test } from "bun:test";
import { type AcceptanceSnapshot, resolveIntent } from "../src/pipeline/acceptance.ts";

const issue = (number: number, body: string) => ({ number, body, author: { login: "owner" } });
const snapshot = (ticket: string, parent: string): AcceptanceSnapshot => ({
  ticket: issue(9, `# Acceptance\n\n## The original intent\n${ticket}\n\n## Tests\n> Not intent.`),
  parent: issue(1, parent),
});
const plan = `# Plan

| Slice | Outcome |
| --- | --- |
| W4 | The queue skips untrusted issues. |
`;
const files: Record<string, string> = { "docs/PLAN.md": plan };
const read = async (path: string) => {
  const text = files[path];
  if (text === undefined) throw new Error(`unresolvable source: ${path}: file not tracked at verified SHA`);
  return text;
};
const resolve = (ticket: string, parent: string) => resolveIntent(snapshot(ticket, parent), read);
const brief = (units: Awaited<ReturnType<typeof resolveIntent>>) =>
  units.map((u) => [u.id, u.text, u.class, u.sources.join(",")]);

const epic784 = `## Goal
Every acceptance ticket can be run by the factory.

## Why
- The orchestrator runs them by hand.
- Each run takes an hour.

## Where things stand
Covering tests landed in #915.

## Plan
1. P4a-1: the engine run.

## Demo
Run an acceptance ticket and see one verdict per requirement.

## Risks
- A model could claim evidence it did not check.

## Tracking
- [ ] #900`;

test("a #784-shaped parent yields only the quoted Goal and demo units", async () => {
  const units = await resolve(
    `From #1:\n\n> Every acceptance ticket can be run by the factory.\n\nIn short: the factory runs it.\n\n> Run an acceptance ticket and see one verdict per requirement.`,
    epic784,
  );
  expect(brief(units)).toEqual([
    ["U1", "Every acceptance ticket can be run by the factory.", "behaviour", "#1"],
    ["U2", "Run an acceptance ticket and see one verdict per requirement.", "behaviour", "#1"],
  ]);
});

test("#819-shaped quotes from the parent and docs/PLAN.md, and decision bullets, resolve", async () => {
  const parent =
    "Intro paragraph\nspanning two lines.\n\n- Decision: keep polling.\n- Decision: no webhooks.";
  const units = await resolve(
    `> Intro paragraph spanning two lines.\n\nFrom docs/PLAN.md (docs):\n\n> The queue skips untrusted issues.\n\nFrom #1, the owner's decisions:\n\n- Decision: keep polling.\n- Decision: no webhooks.`,
    parent,
  );
  expect(brief(units)).toEqual([
    ["U1", "Intro paragraph spanning two lines.", "behaviour", "#1"],
    ["U2", "The queue skips untrusted issues.", "docs", "docs/PLAN.md"],
    ["U3", "Decision: keep polling.", "behaviour", "#1"],
    ["U4", "Decision: no webhooks.", "behaviour", "#1"],
  ]);
  await expect(
    resolve("From docs/MISSING.md:\n\n> The queue skips untrusted issues.", parent),
  ).rejects.toThrow("unresolvable source: docs/MISSING.md");
});

test("a quote absent from an existing PLAN is not a whole source unit", async () => {
  await expect(
    resolve("From docs/PLAN.md:\n\n> The queue accepts untrusted issues.", "- Parent requirement."),
  ).rejects.toThrow("quote is not a whole source unit");
});

test("quotes must equal one whole source unit", async () => {
  const parent = "- The service retries failed deliveries three times.\n- Other item.";
  await expect(resolve("> The service", parent)).rejects.toThrow("quote is not a whole source unit");
  await expect(resolve("From #821:\n\n> Other item.", parent)).rejects.toThrow("#821 is not the parent");
  const units = await resolve(
    "> - The service retries failed deliveries\n>   three times.\n> - Other item.",
    parent,
  );
  expect(units.map((u) => u.text)).toEqual([
    "The service retries failed deliveries three times.",
    "Other item.",
  ]);
});

test("section references include subsections and dedupe quoted units, excluding fences and details", async () => {
  const parent = `## Epic D: defects become issues
- A defect opens an issue.

### Details
Each issue links its run.

\`\`\`
- not a unit
\`\`\`

<details>
<summary>More</summary>

- hidden item
</details>

## Next epic
- Excluded.

## Epic W4
- Docs explain the queue.`;
  const units = await resolve(
    `> A defect opens an issue.\n\n#1's "Epic D: defects become issues" section\n\n#1's "Epic W4" section (docs)`,
    parent,
  );
  expect(brief(units)).toEqual([
    ["U1", "A defect opens an issue.", "behaviour", '#1,#1 "Epic D: defects become issues"'],
    ["U2", "Each issue links its run.", "behaviour", '#1 "Epic D: defects become issues"'],
    ["U3", "Docs explain the queue.", "docs", '#1 "Epic W4"'],
  ]);
  await expect(resolve(`#1's "Same" section`, "## Same\n- a\n## Same\n- b")).rejects.toThrow(
    "does not name exactly one heading",
  );
  await expect(resolve(`#1's "Absent" section`, "## Same\n- a")).rejects.toThrow(
    "does not name exactly one heading",
  );
});

test("a ticket with neither form resolves to no units", async () => {
  await expect(resolve("Only prose about the intent.", "- a")).rejects.toThrow("resolves to no units");
  await expect(
    resolveIntent({ ticket: issue(9, "No intent section."), parent: issue(1, "- a") }, read),
  ).rejects.toThrow("resolves to no units");
});

test("section boundaries ignore headings inside excluded details blocks", async () => {
  const units = await resolve(
    `#1's "Goal" section`,
    `## Goal
- Required before details.

<details>
<summary>Context</summary>

## Hidden heading
- Hidden context.
</details>

- Required after details.

## Next
- Outside the section.`,
  );
  expect(units.map((u) => u.text)).toEqual(["Required before details.", "Required after details."]);
});

test("a hidden duplicate heading does not make a visible section ambiguous", async () => {
  const units = await resolve(
    `#1's "Goal" section`,
    `<details>
## Goal
- Hidden context.
</details>

## Goal
- Visible requirement.

## Next
- Outside the section.`,
  );
  expect(units.map((u) => u.text)).toEqual(["Visible requirement."]);
});

test("plain context mentioning a section reference creates no additional units", async () => {
  const units = await resolve(
    `> Required behaviour.\n\nThis check does not use #1's "Risks" section.`,
    "## Goal\n- Required behaviour.\n\n## Risks\n- Context only.",
  );
  expect(units.map((u) => u.text)).toEqual(["Required behaviour."]);
});

test("paragraph normalization cannot turn a wrapped mention into a reference line", async () => {
  const units = await resolve(
    `> Required behaviour.\n\n#1's "Risks"\nsection`,
    "## Goal\n- Required behaviour.\n\n## Risks\n- Context only.",
  );
  expect(units.map((u) => u.text)).toEqual(["Required behaviour."]);
});

test("adjacent references preserve order, sources, docs classification and deduplication", async () => {
  const units = await resolve(
    `  #1's "Docs" section (docs)  \n#1's "Goal" section\n#1's "Docs" section (docs)`,
    "## Goal\n- Behaviour.\n\n## Docs\n- Documentation.",
  );
  expect(brief(units)).toEqual([
    ["U1", "Documentation.", "docs", '#1 "Docs"'],
    ["U2", "Behaviour.", "behaviour", '#1 "Goal"'],
  ]);
});
