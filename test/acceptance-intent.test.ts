import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type AcceptanceSnapshot, resolveIntent } from "../src/pipeline/acceptance.ts";
import { groupAcceptanceUnits } from "../src/pipeline/acceptance-follow-ups.ts";

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

test("top-level items own their descendants while paragraphs own themselves", () => {
  const units = resolve(
    goal,
    inGoal("- First.\n  - Child.\n  - Sibling.\n- Second.\n\nParagraph.\nContinued."),
  );
  expect(units.map((u) => u.item)).toEqual(["U1", "U1", "U1", "U4", "U5"]);
  expect([...groupAcceptanceUnits(units)].map(([item, group]) => [item, group.map((u) => u.id)])).toEqual([
    ["U1", ["U1", "U2", "U3"]],
    ["U4", ["U4"]],
    ["U5", ["U5"]],
  ]);
  const deep = resolve(goal, inGoal("- Root.\n  - Child.\n    - Grandchild.\n- Next.\n  - Child."));
  expect(deep.map((u) => u.item)).toEqual(["U1", "U1", "U1", "U4", "U4"]);
});

test("deduplicated units keep the item of their first occurrence across sections", () => {
  const units = resolve(
    `${goal}\n#1's "Docs" section (docs)`,
    "## Goal\n- Root.\n  - Child.\n## Docs\n- Root.\n  - Child.\n  - New child.\n- Root. — Child.",
  );
  expect(units.map((u) => [u.id, u.item, u.text])).toEqual([
    ["U1", "U1", "Root."],
    ["U2", "U1", "Root. — Child."],
    ["U3", "U1", "Root. — New child."],
  ]);
  expect(units[1]?.sources).toEqual(['#1 "Goal"', '#1 "Docs"']);
});

test("legacy persisted manifests group each unit as its own item without re-resolving", () => {
  const manifest = [
    { id: "U1", text: "Root.", class: "behaviour" as const, sources: ['#1 "Goal"'] },
    { id: "U2", text: "Root. — Child.", class: "behaviour" as const, sources: ['#1 "Goal"'] },
  ];
  expect([...groupAcceptanceUnits(manifest)].map(([item, group]) => [item, group.map((u) => u.id)])).toEqual([
    ["U1", ["U1"]],
    ["U2", ["U2"]],
  ]);
  expect(manifest.every((u) => !("item" in u))).toBe(true);
});

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

test("#822's real section resolves all 37 units, including the Fencing subtree, offline", () => {
  const body = readFileSync(new URL("./fixtures/acceptance-epic822.md", import.meta.url), "utf8");
  const units = resolveIntent({
    ticket: issue(828, `## The original intent\n#822's "Epic Q: issues are the work queue" section`),
    parent: issue(822, body),
  });
  const eligible =
    "**Eligible:** an open issue in a configured repository is eligible when both of these hold.";
  const order = "**Order:**";
  const claim =
    "**Claim (exactly once), on every path.** A run for an issue can also start from the webhook `limitless` label, a `/limitless` comment, MCP, or `limitless run` with `Closes #n` (how I start issues today). All of them pass the same claim check, one implementation: an issue that's already claimed is refused with the claiming run's link. The webhook label trigger becomes a faster way into the queue, not a second path.";
  const fencing =
    "**Fencing.** Checking first narrows the window between waking and acting but can't close it, so every outward step is also pinned:";
  const lifecycle = "**Lifecycle:**";
  const shared = "What must become shared:";
  expect(units.map((unit) => unit.text)).toEqual([
    eligible,
    `${eligible} — **Trusted origin.** A trusted account (configured; default: the GitHub owner) wrote it, and no one else has edited the body since. Use GitHub's edit history (\`lastEditedBy\` / \`userContentEdits\`). Comments never reach the run (#377), so only the body matters.`,
    `${eligible} — **Approved.** It carries a priority label \`priority:0\` … \`priority:10\` (lower is more urgent; owner, 2026-10-23), applied by a trusted account. The issue events API records who applied each label (\`labeled\` events carry \`actor.login\`; confirmed on #774). Today every label shows the owner, because the factory acts as the owner; with the App, the factory's own labels show as its bot account. No priority means a note or a draft, never built. With several priority labels, the most urgent wins and the issue gets a comment saying so.`,
    `${eligible} — **\`priority:0\` is urgent.** It takes the next free run slot ahead of everything else, and may exceed the issue-run cap by one. 1–3 are the everyday levels; the rest are room for later.`,
    `${eligible} — Epics (issues with sub-issues) are never built themselves.`,
    order,
    `${order} — Higher priority first, then oldest first.`,
    `${order} — An issue whose blockers are open waits. Blockers come from GitHub's native "blocked by" relationship and sub-issue order where available, otherwise from a \`Blocked by #n\` line in the body.`,
    claim,
    `${claim} — The label \`limitless:in-progress\` plus a comment naming the run, for people.`,
    `${claim} — For machines, a claim record that is atomic. A label isn't: two coordinators can both add one. Create a ref, \`refs/limitless/claims/<issue>\`. GitHub refuses to create a ref that already exists, which gives compare-and-swap.`,
    `${claim} — The ref points at a commit whose message names the coordinator and a lease deadline. The holder renews it; a stale claim can be taken over after its lease.`,
    `${claim} — **Leases.** Each renewal is a new commit whose parent is the previous claim commit. Updating a ref without force must be a fast-forward, so renewing and taking over are compare-and-swap: a holder that has lost the claim can't renew, and of two coordinators taking over, only one succeeds. The commits get GitHub's own timestamps, so lease expiry doesn't depend on any machine's clock. Initial values: renew every 3 minutes, expire after 10.`,
    `${claim} — **A machine that vanishes, freezes or sleeps** stops renewing. After the lease expires, another coordinator takes the claim.`,
    `${claim} — **How a holder learns it lost the claim.** It keeps the time of its last successful renewal on a monotonic clock. After a freeze or a sleep, the first timer to fire sees a gap longer than the lease, so the holder assumes the claim is lost and asks GitHub before doing anything else. If the claim tip is someone else's commit, the claim is lost. If it is still its own, the holder renews with a fast-forward, which GitHub refuses if the ref moved in the meantime. A holder that has lost its claim cancels the local run and publishes nothing.`,
    `${claim} — ${fencing}`,
    `${claim} — ${fencing} — pushes carry the branch head they expect (\`--force-with-lease=<branch>:<sha>\`), so a stale holder's push fails once the new holder has pushed;`,
    `${claim} — ${fencing} — merges carry the checked head (\`--match-head-commit\`);`,
    `${claim} — ${fencing} — each claim commit carries a generation number, and the factory's comments and labels include it, so readers ignore a stale holder's late write;`,
    `${claim} — ${fencing} — the new holder re-reads the branch and PR before acting, so a stale push that landed first is only extra commits it adopts.`,
    `${claim} — **Reconciliation.** The new holder adopts the existing branch and PR (found through the issue's links and the branch naming), and never opens a second one. Recorded side effects don't repeat (AGENTS.md).`,
    `${claim} — **Alive but not progressing** is a different case. Renewals prove liveness, not progress, and another machine can't tell slow from stuck, so it never takes a live claim. Instead the holder records its last stage transition in the claim. The existing stage timeouts end a hung stage, and a run with no progress for a set time is labelled \`limitless:needs-you\` for the owner.`,
    `${claim} — With one coordinator, the local run record (\`sourceRef\`) already dedupes; the ref makes it safe for more.`,
    lifecycle,
    `${lifecycle} — Claimed → the run starts; the issue gets the run link.`,
    `${lifecycle} — PR opened → linked (\`Closes #n\`). Merged → GitHub closes the issue.`,
    `${lifecycle} — \`needs_human\` or a question → \`limitless:needs-you\` with the question.`,
    `${lifecycle} — Failed → the claim is released, the issue is labelled \`limitless:failed\` with the reason, and it is **not** picked again until a trusted account re-approves it, so a failing issue can't loop.`,
    "**Polling:** conditional requests (`since`, ETags) every few minutes, inside a fixed rate-limit budget. Webhooks only make it faster. This also unblocks issue triggers on the work machine.",
    "**Comment commands:** a trusted author's comment that starts with `/limitless` or mentions the App (`@limitless-software-factory`) is a command, read by polling the repository's comment stream (`since`). The mention is only a text convention: without webhooks, GitHub doesn't deliver it to the App, and what matters is who wrote the comment.",
    "**Capacity:** a coordinator claims only when it has a free run slot. A cap on issue-sourced runs keeps room for hand-started work.",
    "What already travels through git or GitHub needs nothing new: each change's `.limitless.toml` from its base commit, PR state, CI, and approvals as PR reviews (#687's approval polling).",
    shared,
    `${shared} — **The issue claim** (above).`,
    `${shared} — **One land per repository at a time.** Today that lock is a row in one coordinator's database (\`claimLandEntry\`). Across machines it needs the same ref claim, \`refs/limitless/land/<repo>\`, and merges stay pinned with \`--match-head-commit\`.`,
    `${shared} — **The owner's attention:** questions and approvals go to the issue and the PR, not to one machine's UI.`,
    "Each machine keeps its own database, providers, quota, executor (#784) and workers. A conversation with me on any machine files or edits issues, and whichever coordinator has capacity picks them up.",
  ]);
  expect(units.map((unit) => [unit.id, unit.class, unit.sources])).toEqual(
    Array.from({ length: 37 }, (_, i) => [
      `U${i + 1}`,
      "behaviour",
      ['#822 "Epic Q: issues are the work queue"'],
    ]),
  );
});

test.each(["-", "*", "+", "1.", "2)", "123456789.", "999999999)"])(
  "marker %s works at every depth with siblings, ascent and replacement ancestry",
  (marker) => {
    expect(
      texts(
        goal,
        inGoal(`${marker} Parent.
  ${marker} First.
    ${marker} Deep.
      ${marker} Leaf.
      + Leaf sibling.
    * Replacement.
      - New leaf.
  - Second.
    + New branch.
+ Next.
  * Third.
    1) Last.`),
      ),
    ).toEqual([
      "Parent.",
      "Parent. — First.",
      "Parent. — First. — Deep.",
      "Parent. — First. — Deep. — Leaf.",
      "Parent. — First. — Deep. — Leaf sibling.",
      "Parent. — First. — Replacement.",
      "Parent. — First. — Replacement. — New leaf.",
      "Parent. — Second.",
      "Parent. — Second. — New branch.",
      "Next.",
      "Next. — Third.",
      "Next. — Third. — Last.",
    ]);
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
  ["one-space item", "- Parent.\n - Invalid.", 3, "indented line"],
  ["three-space item", "- Parent.\n  - Child.\n   - Too deep.", 4, "indented line"],
  ["five-space item", "- Parent.\n  - Child.\n    - Deep.\n     - Invalid.", 5, "indented line"],
  ["jump from zero to four spaces", "- Parent.\n    - Orphan.", 3, "orphan sub-item"],
  ["jump from two to six spaces", "- Parent.\n  - Child.\n      - Orphan.", 4, "orphan sub-item"],
  [
    "stale ancestor after ascent",
    "- Parent.\n  - Child.\n    - Deep.\n  - Replacement.\n      - Orphan.",
    6,
    "orphan sub-item",
  ],
  [
    "stale ancestor after new root",
    "- Parent.\n  - Child.\n    - Deep.\n- Replacement.\n    - Orphan.",
    6,
    "orphan sub-item",
  ],
  ["tab-indented item", "- Parent.\n  - Child.\n\t- Too deep.", 4, "indented line"],
  ["mixed tab indentation", "- Parent.\n  - Child.\n  \t- Too deep.", 4, "indented line"],
  ["tab within spaces", "- Parent.\n  - Child.\n \t - Invalid.", 4, "indented line"],
  ["child after paragraph", "- Parent.\n  - Child.\n\nParagraph.\n  - Orphan.", 6, "orphan sub-item"],
  ["child after blank", "- Parent.\n  - Child.\n\n  - Orphan.", 5, "orphan sub-item"],
  ["child after heading", "- Parent.\n  - Child.\n### Detail\n  - Orphan.", 5, "orphan sub-item"],
  ["unindented child continuation", "- Parent.\n  - Child.\nNever omit.", 4, "list item continuation"],
  ["indented child continuation", "- Parent.\n  - Child.\n  Never omit.", 4, "indented line"],
  ["indented root continuation", "- Parent.\n Never omit.", 3, "indented line"],
  ["deep continuation", "- Parent.\n  - Child.\n    - Deep.\n    Never omit.", 5, "indented line"],
  ["lazy deep continuation", "- Parent.\n  - Child.\n    - Deep.\nNever omit.", 5, "list item continuation"],
  ["child marker tab separator", "- Parent.\n  - Child.\n  -\tInvalid.", 4, "indented line"],
  ["empty child marker", "- Parent.\n  - Child.\n  +", 4, "indented line"],
  ["empty ordered child marker", "- Parent.\n  - Child.\n  1. ", 4, "indented line"],
  ["ten-digit child marker", "- Parent.\n  - Child.\n  1234567890. Invalid.", 4, "indented line"],
  ["two-space dash thematic break", "- Parent.\n  - Child.\n  - - -", 4, thematic],
  ["two-space star thematic break", "- Parent.\n  - Child.\n  * * *", 4, thematic],
  ["four-space thematic break", "- Parent.\n  - Child.\n    - - -", 4, thematic],
  ["six-space thematic break", "- Parent.\n  - Child.\n    - Deep.\n      * * *", 5, thematic],
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
  ["deep child in ticket", `${goal}\n    - A requirement of its own.`, 5, "indented line"],
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
