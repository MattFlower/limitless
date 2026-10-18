import { expect, test } from "bun:test";
import { checkPublicationText } from "../src/gates/publication.ts";

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
