import { expect, test } from "bun:test";
import { buildReportRedactor } from "../src/integrations/mcp-change.ts";
import { renderReportArtifacts } from "../src/pipeline/report.ts";
import {
  markReport,
  markReportArtifacts,
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

test("report integrity covers offsets and clipping flags without embedding sources", () => {
  const { report, sources } = markReportArtifacts([
    reportText("verifier", "Visible prefix", "Visible prefix and private tail"),
  ]);
  const encoded = /limitless-report:v3:([A-Za-z0-9_-]+)/u.exec(report)?.[1];
  if (!encoded) throw new Error("Missing report manifest");
  const manifest = Buffer.from(encoded, "base64url").toString("utf8");
  const tampered = Buffer.from(manifest.replace('"clipped":true', '"clipped":false')).toString("base64url");
  expect(manifest).not.toContain("private tail");
  expect(report).not.toContain("private tail");
  expect(sources.sources[0]).toBe("Visible prefix and private tail");
  expect(sources.digest).toBe(reportStructure(report)?.digest ?? "");
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
  const command = `public-command ${"argument ".repeat(50)}`;
  const { report, sources } = renderReportArtifacts({
    success: true,
    runId: "r",
    prompt: "Public request",
    state: {
      implementerReport: `First line\n${"y".repeat(4980)}\nLast line beyond the limit`,
      lastGates: [
        {
          name: "test",
          verdict: "pass",
          blocking: false,
          result: {
            name: "test",
            ok: true,
            command,
            exitCode: 0,
            timedOut: false,
            output: "",
            durationMs: 1,
          },
        },
      ],
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
  expect(spans.filter((span) => span.clipped).map((span) => span.kind)).toEqual([
    "implementer",
    "prose",
    "verifier",
    "prose",
  ]);
  expect(sources.sources[spans.findIndex((span) => span.kind === "implementer")]).toEndWith(
    "Last line beyond the limit",
  );
  expect(Object.values(sources.sources)).toContain(criterion);
  expect(Object.values(sources.sources)).toContain(`\`${command}\``);
  expect(report).toContain(`\`${command.slice(0, 300)}\``);
  expect(Object.values(sources.sources)).toContain(evidence.replaceAll("\n", "<br>"));
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

test("the report footer carries no authored text from a clipped evidence tail", () => {
  const tail = "Unclipped private tail only the verifier observed";
  const evidence = `${"x".repeat(310)} ${tail}`;
  const { report, sources } = renderReportArtifacts({
    success: true,
    runId: "r",
    prompt: "Public request",
    runUrl: "u",
    invocations: [],
    totals: { costUsd: 0, costEquivUsd: 0 },
    state: {
      spec: {
        summary: "Task",
        assumptions: [],
        requirements: [],
        out_of_scope: [],
        blocking_questions: [],
        acceptance_criteria: [{ id: "AC-1", criterion: "Public criterion", how_to_verify: "Run checks" }],
      },
      lastVerify: {
        modelId: "verifier",
        overall: "pass",
        notes: tail,
        criteria: [{ id: "AC-1", status: "met", evidence, publicSummary: "" }],
      },
    },
  });
  const encoded = /limitless-report:v3:([A-Za-z0-9_-]+)/u.exec(report)?.[1];
  if (!encoded) throw new Error("Missing report manifest");
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const manifest = JSON.parse(decoded);
  expect(Object.keys(manifest).sort()).toEqual(["digest", "spans"]);
  for (const span of manifest.spans) {
    expect(Object.keys(span).every((key) => ["kind", "start", "end", "clipped"].includes(key))).toBe(true);
  }
  expect(decoded).not.toContain(tail);
  expect(report).not.toContain(tail);
  expect(Object.values(sources.sources)).toContain(evidence);
  expect(sources.digest).toBe(manifest.digest);
  expect(stripReportManifest(report)).not.toContain(tail);
});

test("boundary emphasis preserves distinct intraword identifiers on both matching sides", () => {
  const visible = "Changed cache_key lookup.\nReviewed cache_key lookup.";
  expect(buildReportRedactor(new Set(["cachekey"]))(visible)).toBe(visible);
  expect(buildReportRedactor(new Set(["cache_key"]))("Changed cachekey lookup.")).toBe(
    "Changed cachekey lookup.",
  );
  expect(buildReportRedactor(new Set(["a*b", "a**b", "a__b"]))("ab")).toBe("ab");
  expect(buildReportRedactor(new Set(["ab"]))("a*b\na**b\na__b")).toBe("a*b\na**b\na__b");
  for (const emphasis of ["_red owl_", "*red owl*"]) {
    expect(buildReportRedactor(new Set(["red owl"]))(emphasis)).toContain("[withheld:");
    expect(buildReportRedactor(new Set([emphasis]))("red owl")).toContain("[withheld:");
  }
});

test.each(["secret_\ntoken", "secret\n_token", "secret_ \ntoken", "the secret_\ntoken leaked"])(
  "an intraword delimiter wrapped at a line break still matches: %j",
  (wrapped) => {
    const redacted = buildReportRedactor(new Set(["secret_token"]))(wrapped);
    expect(redacted).toContain("[withheld:");
    expect(redacted).not.toContain("token");
  },
);

test("an intraword delimiter wrap point stays distinct from an unwrapped identifier", () => {
  expect(buildReportRedactor(new Set(["secret_token"]))("Changed secrettoken lookup.")).toBe(
    "Changed secrettoken lookup.",
  );
});

test.each(["r\u200bed owl", "red o\u2060wl", "red\u00ad owl"])(
  "format characters normalize on both matching sides: %j",
  (phrase) => {
    expect(buildReportRedactor(new Set(["red owl"]))(phrase)).toContain("[withheld:");
    expect(buildReportRedactor(new Set([phrase]))("red owl")).toContain("[withheld:");
  },
);

test("unconfirmed clipped source mapping withholds the whole span", () => {
  const redact = buildReportRedactor(new Set(["red owl"]));
  expect(redact("Visible\nred", "Visible red owl")).toContain("[withheld:");
  expect(redact("red", "Unrelated source")).toContain("[withheld:");
  expect(redact("`public prefix`", "`public prefix and public tail`")).toBe("`public prefix`");
  expect(redact("`public prefix`", "`public prefix and red owl`")).toContain("[withheld:");
});

test("unsettled normalization withholds the whole affected field", () => {
  // Build the undecodable probe at runtime so publication can inspect this test's source.
  const unsettled = `%${"25".repeat(6)}72ed owl`;
  expect(buildReportRedactor(new Set([unsettled]))("Ordinary line")).toContain("[withheld:");
  const filtered = buildReportRedactor(new Set(["red owl"]))(`Ordinary line\n${unsettled}`);
  expect(filtered).toContain("[withheld:");
  expect(filtered).not.toContain("Ordinary line");
});

test.each(["red <e\u200bm>owl</em>", "red <!--x\ny-->owl"])(
  "listed wrapper and normalization classes compose: %j",
  (phrase) => {
    const filtered = buildReportRedactor(new Set(["red owl"]))(`${phrase}\nPublic neighbor`);
    expect(filtered).not.toContain("red");
    expect(filtered).not.toContain("owl");
    expect(filtered).toContain("Public neighbor");
  },
);
