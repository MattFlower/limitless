import { expect, test } from "bun:test";
import { buildReportRedactor } from "../src/integrations/mcp-change.ts";
import {
  markReport,
  reportStructure,
  reportText,
  stripReportManifest,
} from "../src/pipeline/report-privacy.ts";

test.each([
  "red owl",
  "[red owl](u)",
  "![red owl](u)",
  "**red** _owl_",
  "`red owl`",
  "> red\n> owl",
  "| red owl |",
  "&#114;ed owl",
  "red\nowl",
  "> red o\n> wl",
  "- red\n- owl",
  "All checks passed.",
])("verifier notes redactor withholds normalized private prose %j", (notes) => {
  const redact = buildReportRedactor(new Set(["red owl", "All checks passed."]));
  const filtered = redact(`${notes}\nUnrelated neighbor`);
  expect(filtered).not.toMatch(/red|owl|All checks passed|&#/);
  expect(filtered).toContain("[withheld:");
  expect(filtered).toContain("Unrelated neighbor");
});

test("publication strips only report metadata while stored structure stays valid", () => {
  const report = markReport([
    "## Checks",
    reportText("private", "Private evidence"),
    reportText("verifier", "Public evidence"),
  ]);
  expect(reportStructure(report)).toBeTruthy();
  expect(report).toContain("<!-- limitless-report:");
  const body = stripReportManifest(report);
  expect(body).toBe("## Checks\n\nPrivate evidence\n\nPublic evidence\n");
  expect(stripReportManifest(`<!-- verdict -->\n${report}`)).toBe(`<!-- verdict -->\n${body}`);
  expect(stripReportManifest(body)).toBe(body);
  expect(stripReportManifest("")).toBe("");
  expect(stripReportManifest(`${body}\n<!-- limitless-report:v99:broken`)).toBe(body);
});

test("footer stripping preserves marker text quoted inside the report", () => {
  const report = markReport([
    reportText("prose", "> Explain <!-- limitless-report:v2: metadata"),
    "## Checks",
  ]);
  const body = stripReportManifest(report);
  expect(body).toContain("> Explain <!-- limitless-report:v2: metadata");
  expect(body).toEndWith("## Checks\n");
});

test("private strings with wrapped words match their unwrapped quotations", () => {
  const redact = buildReportRedactor(new Set(["the amber lan\ntern glows"]));
  expect(redact("the amber lantern glows\nPublic neighbor")).toBe(
    "[withheld: holdout result or quotation; 1 line]\nPublic neighbor",
  );
});
