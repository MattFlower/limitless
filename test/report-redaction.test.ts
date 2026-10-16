import { expect, test } from "bun:test";
import { buildReportRedactor } from "../src/integrations/mcp-change.ts";
import { renderReport } from "../src/pipeline/report.ts";
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
    reportText("verifier", "Public evidence", "Public evidence\nUnrendered source"),
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

test("report integrity covers the unclipped matching source", () => {
  const report = markReport([reportText("verifier", "Visible prefix", "Visible prefix and private tail")]);
  const encoded = /limitless-report:v3:([A-Za-z0-9_-]+)/u.exec(report)?.[1];
  if (!encoded) throw new Error("Missing report manifest");
  const manifest = Buffer.from(encoded, "base64url").toString("utf8");
  const tampered = Buffer.from(manifest.replace("private tail", "public tail")).toString("base64url");
  expect(reportStructure(report)?.spans[0]?.source).toBe("Visible prefix and private tail");
  expect(reportStructure(report.replace(encoded, tampered))).toBeNull();
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

test("published reports keep long public cells and summaries readable", () => {
  const criterion = `Public criterion ${"word ".repeat(80)}`;
  const evidence = `Command output\nsecond line ${"ok ".repeat(120)}`;
  const report = renderReport({
    success: true,
    runId: "r",
    prompt: "Public request",
    state: {
      implementerReport: `First line\n${"y".repeat(4980)}\nLast line beyond the limit`,
      spec: {
        summary: "Public task",
        assumptions: [],
        requirements: [],
        out_of_scope: [],
        blocking_questions: [],
        acceptance_criteria: [{ id: "AC-1", criterion, how_to_verify: "Run checks" }],
      },
      lastVerify: {
        modelId: "verifier",
        overall: "pass",
        notes: "",
        criteria: [{ id: "AC-1", status: "met", evidence, publicSummary: "" }],
      },
    },
    invocations: [],
    totals: { costUsd: 0, costEquivUsd: 0 },
    runUrl: "u",
  });
  expect(report).not.toContain("[withheld");
  expect(report).toContain(`| ✅ AC-1 | ${criterion.slice(0, 300)} | Command output<br>second line ok ok`);
  expect(report).toContain(`First line\n${"y".repeat(4980)}\n\n## Acceptance criteria`);
  expect(report).not.toContain("Last line beyond the limit");
  const spans = reportStructure(report)?.spans ?? [];
  expect(spans.filter((span) => span.source).map((span) => span.kind)).toEqual(["implementer", "verifier"]);
  expect(spans.find((span) => span.kind === "implementer")?.source).toEndWith("Last line beyond the limit");
  expect(spans.find((span) => span.kind === "verifier")?.source).toContain(evidence.replaceAll("\n", "<br>"));
});

test("clipped spans withhold a tail that starts a private string", () => {
  const redact = buildReportRedactor(new Set(["the amber lantern glows ultraviolet"]));
  const source = "Visible\nends with the amber lan<br>tern glows ultraviolet";
  expect(redact("Visible\nends with the amber lan<br>tern gl", source)).toBe(
    "Visible\n[withheld: holdout result or quotation; 1 line]",
  );
  expect(redact("Visible\nends with the amber lantern gl")).toBe("Visible\nends with the amber lantern gl");
  expect(redact("Visible\nends with the", "Visible\nends with the public output")).toBe(
    "Visible\nends with the",
  );
  expect(redact("Visible\nends with the", source)).toBe(
    "Visible\n[withheld: holdout result or quotation; 1 line]",
  );
});

test("private strings with wrapped words match their unwrapped quotations", () => {
  const redact = buildReportRedactor(new Set(["the amber lan\ntern glows"]));
  expect(redact("the amber lantern glows\nPublic neighbor")).toBe(
    "[withheld: holdout result or quotation; 1 line]\nPublic neighbor",
  );
});
