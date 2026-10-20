import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPublicationText, sanitizePublication } from "../src/gates/publication.ts";
import { registerCredential, registeredCredentials } from "../src/util/proc.ts";

test("publication rewrites local report links and bare paths without changing ordinary links", () => {
  const data = "/factory/data";
  const work = `${data}/work/run`;
  const report = [
    `[hardening.test.ts](${work}/test/hardening.test.ts)`,
    `Changed ${work}/src/main.ts and \`${work}/test/check.ts:12\`.`,
    `[logs](${data}/runs/run/log.txt) and ${data}/scratch/file`,
    `[relative](docs/GUIDE.md) [web](https://example.com/docs)`,
    `[web path](https://example.com${work}/src/main.ts)`,
    `[web query](https://example.com?path=${work}/src/main.ts)`,
    `https://example.com?log=${data}/runs/log.txt`,
    `[spaced](<${work}/a file.ts>)`,
    "/unrelated/absolute/path",
  ].join("\n");
  const expected = [
    "[test/hardening.test.ts](test/hardening.test.ts)",
    "Changed src/main.ts and `test/check.ts:12`.",
    "<data>/runs/run/log.txt and <data>/scratch/file",
    "[relative](docs/GUIDE.md) [web](https://example.com/docs)",
    `[web path](https://example.com${work}/src/main.ts)`,
    `[web query](https://example.com?path=${work}/src/main.ts)`,
    `https://example.com?log=${data}/runs/log.txt`,
    "[a file.ts](<a file.ts>)",
    "/unrelated/absolute/path",
  ].join("\n");
  expect(sanitizePublication(report, work, data)).toBe(expected);
  expect(sanitizePublication(expected, work, data)).toBe(expected);
});

test("publication matches complete directory boundaries and escapes configured prefixes", () => {
  const data = "/factory/data.(1)";
  const work = `${data}/work/run+1`;
  const report = `${work}-other/file ${data}-other/file [sibling](${work}-other/file)`;
  const expected = `<data>/work/run+1-other/file ${data}-other/file <data>/work/run+1-other/file`;
  expect(sanitizePublication(report, `${work}/`, `${data}/`)).toBe(expected);
  expect(sanitizePublication(expected, work, data)).toBe(expected);
  expect(sanitizePublication(`${work} ${data}`, work, data)).toBe(". <data>");
  expect(sanitizePublication("/separate/work/file", "/separate/work", data)).toBe("file");
  expect(sanitizePublication(`${data}/runs/log`, "", data)).toBe("<data>/runs/log");
});

test.each(["&amp;", "&#38;", "&#x26;"])(
  "publication checks decode character references before collapsing whitespace: %s",
  (reference) => {
    const phrase = ["private", "&", "value"].join(" ");
    expect(() =>
      checkPublicationText(`private\n\t${reference}&nbsp;  value`, "PR text", [{ value: phrase, entry: 1 }]),
    ).toThrow("PR text contains a private string (entry 1 in private-strings.txt)");
  },
);

test("publication still checks exact outgoing text before decoding or collapsing it", () => {
  const phrase = ["private", "&amp;", "value"].join("\t");
  expect(() => checkPublicationText(phrase, "PR text", [{ value: phrase, entry: 1 }])).toThrow(
    "PR text contains a private string (entry 1 in private-strings.txt)",
  );
});

test("publication checks standard base64 with caller-selected private entries and credentials", () => {
  const credential = ["synthetic", "publication", "credential"].join("-");
  const privateValue = ["private", "publication", "entry"].join("-");
  registerCredential("publication-content-test", credential);
  const entries = [
    ...registeredCredentials()
      .filter((value) => value === credential)
      .map((value) => ({ value, entry: 1 })),
    { value: privateValue, entry: 2 },
  ];
  for (const { value, entry } of entries) {
    const encoded = Buffer.from(value).toString("base64");
    for (const run of [encoded, encoded.replace(/=+$/, "")]) {
      expect(() => checkPublicationText(`Report: ${run}`, "PR text", entries)).toThrow(`entry ${entry}`);
      expect(() => checkPublicationText(run, "PR text", [])).not.toThrow();
    }
    for (const run of [encoded.slice(0, -4), encoded.slice(1), "ordinary text YWJjZA=="])
      expect(() => checkPublicationText(run, "PR text", entries)).not.toThrow();
  }
  const slashed = ["private", "slashed", "entry???"].join("-");
  const encoded = Buffer.from(slashed).toString("base64");
  expect(encoded).toContain("/");
  expect(() =>
    checkPublicationText(`See reports/${encoded}.txt`, "PR text", [{ value: slashed, entry: 3 }]),
  ).toThrow("entry 3");
});

test("publication repeatedly decodes HTML and permits clean text and unrecognized references", () => {
  const phrase = ["private", "&", "value"].join(" ");
  expect(() =>
    checkPublicationText("Use & <tag> &unknown; &#65; &#x42;", "PR text", [{ value: phrase, entry: 1 }]),
  ).not.toThrow();
  expect(() =>
    checkPublicationText("private &amp;amp; value", "PR text", [{ value: phrase, entry: 1 }]),
  ).toThrow("entry 1");
  const percent = (value: string) => Array.from(value, (c) => `%${c.charCodeAt(0).toString(16)}`).join("");
  const html = (value: string) => Array.from(value, (c) => `&#${c.charCodeAt(0)};`).join("");
  const encoded = Buffer.from(phrase).toString("base64");
  for (const text of [percent(html(phrase)), html(percent(phrase)), percent(encoded), html(encoded)])
    expect(() => checkPublicationText(text, "PR text", [{ value: phrase, entry: 1 }])).toThrow("entry 1");
  // Base64 of an encoded spelling alone remains outside scope.
  for (const text of [percent(phrase), html(phrase)])
    expect(() =>
      checkPublicationText(Buffer.from(text).toString("base64"), "PR text", [{ value: phrase, entry: 1 }]),
    ).not.toThrow();
});

test("labels and titles are sanitized independently of relative and case-insensitive web destinations", () => {
  const data = "/factory/data";
  const work = `${data}/work/run`;
  const url = `hTtPs://example.com?path=${work}/a.ts`;
  const input =
    `[${work}/a.ts](src/a.ts) [${work}/b.ts](${url} "See ${work}/c.ts and ${data}/logs/a")\n` +
    `[f](src/a.ts "See ${work}/a.ts") [f](src/a.ts 'See ${data}/logs/a')\n` +
    `[ordinary](src/a.ts "ordinary title") ${url} HTTP://example.com?log=${data}/logs/a\n` +
    `[${work}/different.ts](file://${work}/a.ts "See ${data}/log") HTTPS://example.com?q=[f](${work}/a.ts)\n` +
    `[${work}/dollar$&.ts](src/a.ts)`;
  const expected =
    `[a.ts](src/a.ts) [b.ts](${url} "See c.ts and <data>/logs/a")\n` +
    `[f](src/a.ts "See a.ts") [f](src/a.ts 'See <data>/logs/a')\n` +
    `[ordinary](src/a.ts "ordinary title") ${url} HTTP://example.com?log=${data}/logs/a\n` +
    `[different.ts](a.ts "See <data>/log") HTTPS://example.com?q=[f](${work}/a.ts)\n` +
    `[dollar$&.ts](src/a.ts)`;
  expect(sanitizePublication(input, work, data)).toBe(expected);
  expect(sanitizePublication(expected, work, data)).toBe(expected);
});

test("paths after prose colons are sanitized in labels, titles and bare text", () => {
  const data = "/Users/example/.factory";
  const work = `${data}/work/run`;
  const input =
    `[f](src/a.ts "Source:${work}/a.ts") [Log:${data}/logs/a](src/a.ts)\n` +
    `Source:${work}/b.ts Log:file://${data}/logs/b https://example.com:443/x?p=:${work}/a.ts`;
  const expected =
    `[f](src/a.ts "Source:a.ts") [Log:<data>/logs/a](src/a.ts)\n` +
    `Source:b.ts Log:<data>/logs/b https://example.com:443/x?p=:${work}/a.ts`;
  expect(sanitizePublication(input, work, data)).toBe(expected);
  expect(sanitizePublication(expected, work, data)).toBe(expected);
});

test("configured and canonical aliases rewrite file URLs with complete directory boundaries", () => {
  const temp = mkdtempSync(join(tmpdir(), "publication-alias-"));
  try {
    const data = join(temp, "data");
    const work = join(temp, "external-work");
    mkdirSync(data);
    mkdirSync(work);
    const alias = join(temp, "alias");
    symlinkSync(data, alias, "dir");
    const workAlias = join(alias, "work");
    symlinkSync(work, workAlias, "dir");
    for (const root of [workAlias, realpathSync(workAlias)]) {
      const input = `${root}/a.ts file://${root}/a.ts [f](file://${root}/a.ts) ${root}-other/a.ts`;
      const sibling = root === workAlias ? "<data>/work-other/a.ts" : `${root}-other/a.ts`;
      const expected = `a.ts a.ts [a.ts](a.ts) ${sibling}`;
      expect(sanitizePublication(input, workAlias, alias)).toBe(expected);
      expect(sanitizePublication(expected, workAlias, alias)).toBe(expected);
    }
    for (const root of [alias, realpathSync(alias)]) {
      const input = `${root}/logs/a file://${root}/logs/a [f](file://${root}/logs/a) ${root}-other/a`;
      const expected = `<data>/logs/a <data>/logs/a <data>/logs/a ${root}-other/a`;
      expect(sanitizePublication(input, workAlias, alias)).toBe(expected);
    }
    const missing = join(alias, "removed");
    expect(sanitizePublication(`file://${missing}/a.ts`, missing, alias)).toBe("a.ts");
    expect(sanitizePublication(`${work.toUpperCase()}/a.ts`, work, data)).toBe(`${work.toUpperCase()}/a.ts`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("malformed labels and destinations remain bounded and still sanitize bare local paths", () => {
  const work = "/factory/data/work/run";
  for (const malformed of ["[".repeat(60_000), `[f](${"x".repeat(60_000)}`, "[f](".repeat(12_000)]) {
    const input = `${malformed} ${work}/a.ts`;
    const expected = `${malformed} a.ts`;
    expect(sanitizePublication(input, work, "/factory/data")).toBe(expected);
    expect(sanitizePublication(expected, work, "/factory/data")).toBe(expected);
  }
}, 5_000);
