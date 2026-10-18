import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPublicationText, sanitizePublication } from "../src/gates/publication.ts";

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

test("publication decodes once and permits clean text and unrecognized references", () => {
  const phrase = ["private", "&", "value"].join(" ");
  expect(() =>
    checkPublicationText("Use & <tag> &unknown; &#65; &#x42; private &amp;amp; value", "PR text", [
      { value: phrase, entry: 1 },
    ]),
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
