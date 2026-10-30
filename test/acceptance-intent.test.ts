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

test("section references include subsections and dedupe quoted units", async () => {
  const parent = `## Epic D: defects become issues
- A defect opens an issue.

### Details
Each issue links its run.

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

test("details cannot hide later units or terminate a selected section", async () => {
  await expect(
    resolve(
      `#1's "Goal" section`,
      "## Goal\n- Before.\n\n<details>\n## Hidden\n- Hidden.\n</details >\n\n- After.\n\n## End",
    ),
  ).rejects.toThrow("unsupported Markdown in the intent: HTML block or comment; normalize the ticket");
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

const unsupported = (construct: string) =>
  `unsupported Markdown in the intent: ${construct}; normalize the ticket`;

const unsupportedCases = [
  ["short backtick closer", "````md\n```\n## Hidden\n- Hidden.\n````", "fence"],
  ["different fence character", "```md\n~~~\n## Hidden\n- Hidden.\n```", "fence"],
  ["tilde fence with backticks", "~~~md\n```\n## Hidden\n~~~", "fence"],
  ["commented heading or reference", '<!--\n## Hidden\n#1\'s "Other" section\n-->', "HTML block or comment"],
  ["HTML block", "<div>\n## Hidden\n</div>", "HTML block or comment"],
  ["details", "<details>\n## Hidden\n</details >", "HTML block or comment"],
  ["setext equals", "End\n===", "setext heading"],
  ["setext dashes", "End\n---", "setext heading"],
  ["quoted setext", "> End\n> ===", "setext heading"],
  ["list-item setext", "- End\n  ===", "setext heading"],
  ["indented code", "    code", "indented code or heading"],
  ["indented heading", "    ## End", "indented code or heading"],
  ["quoted fence", "> ```md\n> hidden\n> ```", "fence"],
  ["list-item fence", "- ```md\n  ## Hidden\n  ```", "fence"],
  ["list-item HTML", "- <details>\n  ## Hidden\n  </details>", "HTML block or comment"],
] as const;

test.each(unsupportedCases)(
  "selected sections refuse %s before a later heading",
  async (_name, md, reason) => {
    await expect(
      resolve(`#1's "Goal" section`, `## Goal\nBefore.\n\n${md}\n\n- After.\n\n## End\n- Outside.`),
    ).rejects.toThrow(unsupported(reason));
    await expect(
      resolve(`> Before.\n\n${md}\n\n> After.`, "- Before.\n- After.\n\n## Other\n- Other."),
    ).rejects.toThrow(unsupported(reason));
  },
);

test.each(["  ## Goal", "   ## Goal ###"])(
  "a visible duplicate heading is ambiguous: %s",
  async (heading) => {
    await expect(
      resolve(`#1's "Goal" section`, `## Goal\n- Before.\n\n${heading}\n- Other.`),
    ).rejects.toThrow("does not name exactly one heading");
  },
);

test("a matching setext heading outside the selected range makes the reference ambiguous", async () => {
  await expect(resolve(`#1's "Goal" section`, "Goal\n====\n\n## Goal\n- Before.")).rejects.toThrow(
    "does not name exactly one heading",
  );
  await expect(resolve(`#1's "Goal" section`, "## Goal\n- Before.\n\nGoal\n====")).rejects.toThrow(
    unsupported("setext heading"),
  );
});

test.each(["## Goal#", "  ## End", "   ## End ###", "##"])(
  "a valid ATX boundary ends the selected section: %s",
  async (heading) => {
    expect(
      brief(await resolve(`#1's "Goal" section`, `  ## Goal ###\n- Before.\n\n${heading}\n- Outside.`)),
    ).toEqual([["U1", "Before.", "behaviour", '#1 "Goal"']]);
  },
);

test("attached trailing hashes and invalid ATX markers remain distinct", async () => {
  const units = await resolve(
    `#1's "Goal#" section`,
    "## Goal\n- Outside.\n## Goal#\n- Required.\n##No space\n####### Too many",
  );
  expect(units.map((u) => u.text)).toEqual(["Required.", "##No space ####### Too many"]);
});

test.each([
  "````md\n```\n## Goal\n````",
  "~~~md\n```\n## Goal\n~~~",
  "```md\n``` extra\n## Goal\n```",
  "<!--\n## Goal\n-->",
])("heading discovery and quote sources ignore hidden content: %s", async (hidden) => {
  const body = `${hidden}\n\n## Goal\n- Before.`;
  expect((await resolve(`#1's "Goal" section`, body)).map((u) => u.text)).toEqual(["Before."]);
  expect((await resolve("> Before.", body)).map((u) => u.text)).toEqual(["Before."]);
  await expect(resolve("> Goal", body)).rejects.toThrow("quote is not a whole source unit");
});

test.each(["```\n~~~", "````\n```", "<!--\nnever closed", "<!-- closed --> <!-- unclosed"])(
  "unclosed fences and comments refuse source scanning: %s",
  async (hidden) => {
    const body = `## Goal\n- Before.\n\n## End\n${hidden}`;
    await expect(resolve(`#1's "Goal" section`, body)).rejects.toThrow("unresolvable source");
    await expect(resolve("> Before.", body)).rejects.toThrow("unresolvable source");
  },
);

test("CRLF sources use the same fence and heading boundaries", async () => {
  const body = "~~~md\r\n```\r\n## Goal\r\n~~~\r\n\r\n## Goal\r\n- Required.\r\n";
  expect((await resolve(`#1's "Goal" section`, body)).map((u) => u.text)).toEqual(["Required."]);
  expect((await resolve("> Required.", body)).map((u) => u.text)).toEqual(["Required."]);
});

test("adjacent physical lead-ins use the last source and class", async () => {
  await expect(
    resolve("From #1:\nFrom docs/PLAN.md (docs):\n\n> Parent only.", "- Parent only."),
  ).rejects.toThrow("quote is not a whole source unit");
  expect(
    brief(
      await resolve(
        "Context for the quote.\nFrom #1:\nFrom docs/PLAN.md (docs):\n> The queue skips untrusted issues.\nFrom #1:\n> Parent only.",
        "- Parent only.",
      ),
    ),
  ).toEqual([
    ["U1", "The queue skips untrusted issues.", "docs", "docs/PLAN.md"],
    ["U2", "Parent only.", "behaviour", "#1"],
  ]);
});

test.each(["#1", "docs/PLAN.md"])("a %s list item includes all continuation paragraphs", async (source) => {
  const body =
    "- Retry failed deliveries.\n\n  Never retry a permanent rejection.\n    Keep the original reason.\n\n- Other item.";
  const partial = snapshot(`From ${source}:\n\n> Retry failed deliveries.`, body);
  await expect(resolveIntent(partial, async () => body)).rejects.toThrow("quote is not a whole source unit");
  const complete = snapshot(
    `From ${source} (docs):\n\n> - Retry failed deliveries.\n>\n>   Never retry a permanent rejection.\n>     Keep the original reason.`,
    body,
  );
  expect(brief(await resolveIntent(complete, async () => body))).toEqual([
    [
      "U1",
      "Retry failed deliveries. Never retry a permanent rejection. Keep the original reason.",
      "docs",
      source,
    ],
  ]);
  expect((await resolve(`#1's "Goal" section`, `## Goal\n${body}`)).map((u) => u.text)).toEqual([
    "Retry failed deliveries. Never retry a permanent rejection. Keep the original reason.",
    "Other item.",
  ]);
});

test("a paragraph after a list is a separate whole unit", async () => {
  const body = "- First item.\n\nSeparate paragraph.\n\n- Second item.";
  expect((await resolve("> First item.\n\n> Separate paragraph.", body)).map((u) => u.text)).toEqual([
    "First item.",
    "Separate paragraph.",
  ]);
});

test("escaped pipes refuse intent rows, reference rows and quoted source fragments", async () => {
  const row = "| The service accepts red \\| blue tokens. |";
  const reason = unsupported("escaped pipe in a table row");
  await expect(resolve(`> Before.\n\n${row}`, "- Before.")).rejects.toThrow(reason);
  await expect(resolve(`#1's "Goal" section`, `## Goal\n${row}`)).rejects.toThrow(reason);
  for (const source of ["#1", "docs/PLAN.md"]) {
    for (const quote of ["blue tokens.", "The service accepts red \\| blue tokens."]) {
      await expect(
        resolveIntent(snapshot(`From ${source}:\n> ${quote}`, row), async () => row),
      ).rejects.toThrow(reason);
    }
  }
  expect((await resolve("> Before.", `${row}\n\n- Before.`)).map((u) => u.text)).toEqual(["Before."]);
  expect(
    (await resolve("> The service accepts red or blue tokens.", row.replace("\\|", "or"))).map((u) => u.text),
  ).toEqual(["The service accepts red or blue tokens."]);
});
