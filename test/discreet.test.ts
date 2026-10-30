import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, repoSettings } from "../src/config.ts";
import { deliveryMarker, hasFactoryMark, stripToolAttribution } from "../src/pipeline/markers.ts";
import { renderReport, renderReportArtifacts } from "../src/pipeline/report.ts";
import { reportStructure, stripReportManifest } from "../src/pipeline/report-privacy.ts";
import { roundSection } from "../src/pipeline/review-round.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "discreet-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const config = (toml: string) => {
  writeFileSync(join(root, "config.toml"), toml);
  return loadConfig({ home: join(root, "data"), configDir: root });
};

test("repository settings default, normalize slugs and honor custom prefixes", () => {
  expect(config("").repos).toBeUndefined();
  const cfg = config(
    '[repos."acme/widgets"]\ndiscreet = true\n[repos."Acme/Tools"]\ndiscreet = true\nbranch_prefix = "feat/"',
  );
  expect(repoSettings(cfg, "ACME/Widgets")).toEqual({
    githubActions: false,
    githubActionsPaidMinutes: false,
    discreet: true,
    branchPrefix: "change/",
    landRequiresApproval: false,
  });
  expect(repoSettings(cfg, "acme/tools")).toEqual({
    githubActions: false,
    githubActionsPaidMinutes: false,
    discreet: true,
    branchPrefix: "feat/",
    landRequiresApproval: false,
  });
  expect(repoSettings(cfg, "other/repo")).toEqual({
    githubActions: false,
    githubActionsPaidMinutes: false,
    discreet: false,
    branchPrefix: "change/",
    landRequiresApproval: false,
  });
});

test("unknown repository keys warn while known settings still apply", () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const cfg = config(
      '[repos."Acme/Widgets"]\ndiscreet = true\nbranch_prefix = "feat/"\nland_requires_approval = true',
    );
    expect(repoSettings(cfg, "acme/widgets")).toEqual({
      githubActions: false,
      githubActionsPaidMinutes: false,
      discreet: true,
      branchPrefix: "feat/",
      landRequiresApproval: true,
    });
    expect([...cfg.landRequiresApproval]).toEqual(["acme/widgets"]);
    expect(warning).not.toHaveBeenCalled();
    config('[repos."acme/widgets"]\nunknown_setting = true');
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("acme/widgets"));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("unknown_setting"));
  } finally {
    warning.mockRestore();
  }
});

test("rejects repository tables whose spellings normalize to the same slug", () => {
  expect(() =>
    config('[repos."Acme/Widgets"]\nland_requires_approval = true\n[repos."acme/widgets"]\ndiscreet = true'),
  ).toThrow('Duplicate repository keys "Acme/Widgets" and "acme/widgets"');
});

test.each([
  ['repos = "no"', "repos must be a table"],
  ["repos = 1979-05-27T07:32:00Z", "repos must be a table"],
  ['[repos]\n"acme/widgets" = 1979-05-27T07:32:00Z', "entries must be tables"],
  ['[repos]\n"acme/widgets" = true', "entries must be tables"],
  ['[repos."not-a-slug"]\ndiscreet = true', "owner/name"],
  ['[repos."acme/widgets"]\ndiscreet = "yes"', "discreet must be a boolean"],
  ['[repos."acme/widgets"]\nbranch_prefix = ""', "valid branch prefix"],
  ['[repos."acme/widgets"]\nbranch_prefix = "a..b/"', "valid branch prefix"],
  ['[repos."acme/widgets"]\nbranch_prefix = false', "valid branch prefix"],
])("rejects invalid repository settings: %s", (toml, message) => {
  expect(() => config(toml)).toThrow(message);
});

test.each(["review", "conflict", "ci", "verification"])(
  "%s markers detect both modes after a setting change",
  (kind) => {
    const legacy = deliveryMarker(kind, "private-run");
    const discreet = deliveryMarker(kind, "private-run", true);
    expect(discreet.marker).toMatch(/<!-- [\w-]+:[a-f0-9]{12} -->/);
    expect(discreet.marker).not.toMatch(/limitless|private-run/i);
    expect(discreet.includes(legacy.marker)).toBe(true);
    expect(legacy.includes(discreet.marker)).toBe(true);
    expect(discreet.includes(deliveryMarker(kind, "other-run", true).marker)).toBe(false);
    expect(discreet.includes()).toBe(false);
  },
);

test("review sections retain findings without identifiers", () => {
  const section = roundSection(
    "private-run",
    2,
    [{ severity: "major", title: "Handle empty input", detail: "Fix" }],
    true,
  );
  expect(section.text).toContain("Addressed review findings:");
  expect(section.text).toContain("Handle empty input");
  expect(section.text).not.toMatch(/limitless|private-run/i);
  expect(section.includes(roundSection("private-run", 2, []).text)).toBe(true);
});

test.each([
  [true, "build", "Every gate below passed."],
  [true, "verify-change", "Checks below have no blocking regressions."],
  [false, "build", "⚠️ Needs a human: the checks below did not all pass."],
] as const)("discreet report: success=%s flow=%s", (success, flow, opening) => {
  const report = stripReportManifest(
    renderReport({
      discreet: true,
      success,
      runId: "private-run",
      runUrl: "http://example.com/runs/private-run",
      prompt: "Fix input",
      state: { flow },
      invocations: [],
      totals: { costUsd: 0, costEquivUsd: 0 },
      closesIssue: 42,
    }),
  );
  expect(report).toStartWith(opening);
  expect(report).toContain("Closes #42");
  expect(report).not.toMatch(/limitless|private-run|\/runs\//i);
});

test.each([
  ["limitless: Add farewell", []],
  ["Add farewell\n\nRun: private-run", []],
  ["Mention private-run", []],
  ["See http://example.com/runs/other-run", []],
  ["Public subject", ["Limitless", "test@example.invalid"]],
  ["Public subject", ["Test", "limitless@localhost"]],
] as [string, string[]][])("publication marks: %s", (text, identities) => {
  expect(hasFactoryMark(text, "private-run", "http://example.com", identities)).toBe(true);
});

test("an operator's title may contain the word limitless", () => {
  expect(
    hasFactoryMark("Add limitless options", "private-run", "http://example.com", [
      "Test",
      "test@example.invalid",
    ]),
  ).toBe(false);
});

const attribution = [
  "Built by Limitless",
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  "Co-Authored-By: Claude Fable 5.1",
].join("\n");

test.each([
  "🤖 Generated with [Claude Code](https://claude.com/claude-code) by Anthropic",
  "Generated with Codex for the owner",
  "Built with Claude Code, reviewed by me",
  "Created by Someone <noreply@anthropic.com>, reviewed by me",
])("discreet PR body removes attribution with trailing prose: %s", (line) => {
  expect(hasFactoryMark(line, "")).toBe(true);
  const human = "Co-authored-by: Claude Smith <claude.smith@example.org>";
  const body = stripReportManifest(
    renderReport({
      discreet: true,
      success: true,
      runId: "private-run",
      runUrl: "",
      prompt: "Fix input",
      state: { implementerReport: `Useful summary\n${line}\n${human}` },
      invocations: [],
      totals: { costUsd: 0, costEquivUsd: 0 },
    }),
  );
  expect(body).toContain("Useful summary");
  expect(body).not.toContain(line);
  expect(body).toContain(human);
  expect(hasFactoryMark(body, "private-run")).toBe(false);
});

test.each([
  ...[
    "Limitless",
    "Claude",
    "Claude Code",
    "Codex",
    "ChatGPT",
    "GitHub Copilot",
    "Gemini",
    "Cursor",
    "Aider",
    "Claude Fable 5.1",
    "Claude Opus 5.5",
    "GPT-6.1 Codex",
    "claude-opus-5-5",
  ].flatMap((name) => [name, name.toUpperCase()]),
  ...["Limitless", "Claude Code", "Codex", "ChatGPT", "GitHub Copilot", "Gemini", "Cursor", "Aider"].map(
    (name) => `${name} <unlisted@example.org>`,
  ),
  "Cursor <cursoragent@cursor.com>",
  "Claude Code <claude-code@anthropic.com>",
  ...[
    "limitless@localhost",
    "noreply@anthropic.com",
    "noreply@openai.com",
    "codex@openai.com",
    "copilot@github.com",
    "copilot-swe-agent[bot]@users.noreply.github.com",
    "198982749+Copilot[bot]@users.noreply.github.com",
    "198982749+Copilot@users.noreply.github.com",
    "167198135+copilot[bot]@users.noreply.github.com",
    "199175422+chatgpt-codex-connector[bot]@users.noreply.github.com",
    "223556219+Copilot@users.noreply.github.com",
  ].map((email) => `Someone <${email}>`),
])("shared tooling identity: %s", (identity) => {
  expect(hasFactoryMark(`Co-Authored-By: ${identity}`, "")).toBe(true);
  // Raw author/committer names and emails use the same classifier.
  const match = /^(.*?) <(.*)>$/.exec(identity);
  if (match) expect(hasFactoryMark("Change", "", "", [match[1] ?? "", match[2] ?? ""])).toBe(true);
});

test.each([
  "co-authored",
  "coauthored",
  "co-developed",
  "codeveloped",
  "signed-off",
  "authored",
  "reviewed",
  "tested",
  "suggested",
  "acked",
  "helped",
  "assisted",
  "generated",
])("attribution keys accept separators and spacing: %s", (key) => {
  for (const separator of [":", "=", "#"])
    expect(hasFactoryMark(`  ${key}-by  ${separator}  Claude Fable 5.1`, "")).toBe(true);
});

test.each([
  "Co-authored-by: Claude Smith <claude.smith@example.org>",
  "Co-authored-by: Claude <human@example.org>",
  "Co-authored-by: Someone <claude@example.org>",
  "Reviewed-by: Someone <codex@example.org>",
  "Generated-by: Someone <engineer@anthropic.com>",
  "Use Claude Code and Codex to check the examples",
  "Document how Limitless handles input",
  "Verified by `claude-opus-5-5` in a separate session from the implementer.",
  "Verified by `gemini-3.1-pro` in a separate session from the implementer.",
])("preserves humans and ordinary prose: %s", (text) => {
  expect(hasFactoryMark(text, "")).toBe(false);
  const identity = /: (.*?) <(.*)>$/.exec(text);
  if (identity) expect(hasFactoryMark("Change", "", "", [identity[1] ?? "", identity[2] ?? ""])).toBe(false);
});

test("folded attribution distinguishes human and tooling identities", () => {
  const human = "Co-authored-by: Claude\n Smith <claude.smith@example.org>";
  expect(hasFactoryMark(human, "")).toBe(false);
  expect(stripToolAttribution(human)).toBe(human);
  for (const tooling of [
    "Co-authored-by: Claude\n Code <noreply@anthropic.com>",
    "Co-authored-by: Someone\n Else\n <noreply@anthropic.com>",
  ]) {
    expect(hasFactoryMark(tooling, "")).toBe(true);
    expect(stripToolAttribution(tooling)).toBe("");
  }
});

test.each(["claude-opus-5-5", "gemini-3.1-pro", "Claude"])(
  "discreet rendering sanitizes model content and retains verification evidence (%s)",
  (modelId) => {
    const rendered = renderReportArtifacts({
      discreet: true,
      success: true,
      runId: "private-run",
      runUrl: "",
      prompt: "Fix input",
      state: {
        implementerReport: `${attribution}\n${"Useful summary\n".repeat(400)}\nCo-authored-by: Claude <human@example.org>`,
        spec: {
          summary: "Fix",
          requirements: [],
          assumptions: [`${attribution}\nKeep input`],
          acceptance_criteria: [
            { id: "AC-1", criterion: `${attribution}\nInput accepted`, how_to_verify: "inspect" },
          ],
          out_of_scope: [],
          blocking_questions: [],
        },
        lastVerify: {
          modelId,
          overall: "pass",
          notes: "",
          criteria: [
            { id: "AC-1", status: "met", evidence: `${attribution}\nObserved result`, publicSummary: "" },
          ],
        },
        lastReview: {
          modelId: "reviewer",
          verdict: "approve",
          summary: `${attribution}\nChecked input`,
          findings: [],
        },
      },
      invocations: [],
      totals: { costUsd: 0, costEquivUsd: 0 },
    });
    const structure = reportStructure(rendered.report);
    expect(structure).toBeTruthy();
    const body = stripReportManifest(rendered.report);
    expect(body).toContain("Useful summary");
    expect(body).toContain("| ✅ AC-1 | Input accepted | Observed result |");
    expect(body).toContain("**approve** — Checked input");
    expect(body).toContain(`Verifier: \`${modelId}\` (separate session from the implementer).`);
    expect(hasFactoryMark(body, "private-run")).toBe(false);
    const sources = Object.values(rendered.sources.sources).join("\n");
    expect(sources).toContain("Co-authored-by: Claude <human@example.org>");
    expect(hasFactoryMark(sources, "private-run")).toBe(false);
    const section = roundSection(
      "private-run",
      2,
      [{ severity: "major", title: `${attribution}\nHandle input`, detail: "Fix" }],
      true,
    );
    expect(section.text).toContain("**major**: Handle input");
    expect(hasFactoryMark(section.text, "private-run")).toBe(false);
  },
);

test.each([undefined, false])(
  "non-discreet rendering preserves exact attribution and branding (%s)",
  (discreet) => {
    const report = stripReportManifest(
      renderReport({
        discreet,
        success: true,
        runId: "private-run",
        runUrl: "http://example.com/runs/private-run",
        prompt: "Fix input",
        state: { implementerReport: `Added input\n${attribution}\nKept checks` },
        invocations: [],
        totals: { costUsd: 0, costEquivUsd: 0 },
      }),
    );
    expect(report).toBe(`Built by **Limitless** — every gate below passed.

Flow: build

## Request

> Fix input

## Implementer's summary

Added input
Built by Limitless
🤖 Generated with [Claude Code](https://claude.com/claude-code)
Co-Authored-By: Claude Fable 5.1
Kept checks

## Checks

No automated checks were detected for this repository.

Run \`private-run\` · http://example.com/runs/private-run

🤖 Generated by Limitless
`);
  },
);

test.each([
  "bUiLt By __LiMiTlEsS__",
  "**Verified by Limitless** — passed checks",
  "🤖 gEnErAtEd WiTh [cLaUdE cOdE](https://claude.com/claude-code)",
  "Generated-with # Codex",
  "Assisted by Claude Fable 5.1",
])("shared attribution recognizes formatting: %s", (text) => {
  expect(hasFactoryMark(text, "")).toBe(true);
});
