import { expect, test } from "bun:test";
import { ciArtifactXml, ciTestReport } from "../src/integrations/ci-test-evidence.ts";
import { bunJunit, junit, reportZip } from "./ci-evidence-support.ts";

test.each([false, true])("Bun 1.4.3 occurrence counts survive merging (reverse=%s)", (reverse) => {
  const cases = [...bunJunit.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)].map((m) => m[0]);
  const xml = reverse
    ? bunJunit.replace(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g, () => cases.pop() ?? "")
    : bunJunit;
  const report = ciTestReport(xml);
  expect(report.counts).toEqual({ tests: 4, failures: 1, errors: 0, skipped: 1 });
  expect([...report.tests]).toEqual(
    reverse
      ? [
          [
            '["repeated.test.ts",["repeated.test.ts"],"","mixed"]',
            { file: "repeated.test.ts", outcome: "skipped" },
          ],
          [
            '["repeated.test.ts",["repeated.test.ts"],"","table %s"]',
            { file: "repeated.test.ts", outcome: "failure" },
          ],
        ]
      : [
          [
            '["repeated.test.ts",["repeated.test.ts"],"","table %s"]',
            { file: "repeated.test.ts", outcome: "failure" },
          ],
          [
            '["repeated.test.ts",["repeated.test.ts"],"","mixed"]',
            { file: "repeated.test.ts", outcome: "skipped" },
          ],
        ],
  );
});

test.each(["root", "suite"])("%s counters validate occurrences, including omitted counters", (level) => {
  const change = (xml: string, key: string, value?: string) =>
    xml.replace(level === "root" ? /<testsuites\b[^>]*>/ : /<testsuite\b[^>]*>/, (tag) =>
      tag.replace(new RegExp(` ${key}="[^"]*"`), value === undefined ? "" : ` ${key}="${value}"`),
    );
  // The captured report already omits zero errors counters on both levels.
  expect(ciTestReport(bunJunit).counts.errors).toBe(0);
  for (const key of ["tests", "failures", "skipped"]) {
    expect(() => ciTestReport(change(bunJunit, key))).toThrow("Incomplete JUnit counts");
    for (const value of ["0", "2", "-1", "1.5", "no"])
      expect(() => ciTestReport(change(bunJunit, key, value))).toThrow("Incomplete JUnit counts");
  }
  const withErrors = bunJunit
    .replace("<failure type=", "<error type=")
    .replace("</failure>", "</error>")
    .replaceAll('failures="1"', 'failures="0"');
  expect(() => ciTestReport(withErrors)).toThrow("Incomplete JUnit counts");
  const complete = withErrors.replaceAll('failures="0"', 'failures="0" errors="1"');
  expect(ciTestReport(complete).counts).toEqual({ tests: 4, failures: 0, errors: 1, skipped: 1 });
  expect(() => ciTestReport(change(complete, "errors"))).toThrow("Incomplete JUnit counts");
  expect(() => ciTestReport(change(complete, "errors", "0"))).toThrow("Incomplete JUnit counts");
  expect(ciTestReport(junit("pass").replace(/ (failures|errors|skipped)="0"/g, "")).counts).toEqual({
    tests: 1,
    failures: 0,
    errors: 0,
    skipped: 0,
  });
});

test("repeated errors take precedence over failures and skips", () => {
  const xml = `<testsuites tests="3" failures="1" errors="1" skipped="1">${junit("skipped")}${junit()}${junit("error").replace('errors="0"', 'errors="1"')}</testsuites>`;
  expect([...ciTestReport(xml).tests.values()]).toEqual([{ file: "test/example.test.ts", outcome: "error" }]);
});

test.each([undefined, "signed", "unsigned"] as const)("ZIP accepts matching %s metadata", (descriptor) => {
  expect(ciArtifactXml(reportZip(bunJunit, descriptor))).toEqual([bunJunit]);
});

test.each([
  ["version", 4, 21],
  ["flags", 6, 2],
  ["encryption", 6, 1],
  ["method", 8, 99],
  ["CRC", 14, 0],
  ["compressed size", 18, 0],
  ["uncompressed size", 22, 0],
] as const)("ZIP rejects local %s disagreement", (_label, offset, value) => {
  const zip = Buffer.from(reportZip(bunJunit));
  if (offset < 14) zip.writeUInt16LE(value, offset);
  else zip.writeUInt32LE(value, offset);
  expect(() => ciArtifactXml(zip)).toThrow();
});

test.each(["signed", "unsigned"] as const)("ZIP validates %s descriptors and placeholders", (descriptor) => {
  const original = Buffer.from(reportZip(bunJunit, descriptor));
  const central = original.readUInt32LE(original.length - 6);
  const trailer = central - (descriptor === "signed" ? 16 : 12);
  const fields = descriptor === "signed" ? trailer + 4 : trailer;
  for (const offset of [0, 4, 8]) {
    const zip = Buffer.from(original);
    zip.writeUInt32LE(0, fields + offset);
    expect(() => ciArtifactXml(zip)).toThrow("Conflicting ZIP descriptor");
    const contradictory = Buffer.from(original);
    contradictory.writeUInt32LE(1, 14 + offset);
    expect(() => ciArtifactXml(contradictory)).toThrow("Conflicting ZIP sizes or CRC");
  }
  // Nonzero local metadata is allowed only when it matches the central entry.
  original.copy(original, 14, central + 16, central + 28);
  expect(ciArtifactXml(original)).toEqual([bunJunit]);
  for (const keep of [0, 4, 8, descriptor === "signed" ? 15 : 11]) {
    const zip = Buffer.concat([original.subarray(0, trailer + keep), original.subarray(central)]);
    zip.writeUInt32LE(trailer + keep, zip.length - 6);
    expect(() => ciArtifactXml(zip)).toThrow();
  }
});
