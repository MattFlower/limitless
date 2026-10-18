import { expect, test } from "bun:test";
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
