import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, repoSettings } from "../src/config.ts";
import { deliveryMarker } from "../src/pipeline/markers.ts";
import { renderReport } from "../src/pipeline/report.ts";
import { stripReportManifest } from "../src/pipeline/report-privacy.ts";
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
  expect(repoSettings(cfg, "ACME/Widgets")).toEqual({ discreet: true, branchPrefix: "change/" });
  expect(repoSettings(cfg, "acme/tools")).toEqual({ discreet: true, branchPrefix: "feat/" });
  expect(repoSettings(cfg, "other/repo")).toEqual({ discreet: false, branchPrefix: "change/" });
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
  ['[repos."acme/widgets"]\ndiscret = true', "Unknown repos key: discret"],
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
