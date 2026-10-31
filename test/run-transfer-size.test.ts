import { expect, test } from "bun:test";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import * as s from "../src/pipeline/run-transfer-size.ts";
import { head, rejects, sha } from "./run-transfer-support.ts";

const range = { base: sha, head, mode: "two-dot" };
const measurement = {
  ...range,
  source: { added: 1, removed: 2 },
  tests: { added: 3, removed: 4 },
  docs: { added: 5, removed: 6 },
  binary: 1,
  renamesAcross: [{ from: "a.ts", to: "test/a.ts" }],
};
test("size variants and all stated budgets preserve stored measurements and typed ranges", () => {
  const inputs = [
    { unavailable: " historical " },
    { ...range, error: "unavailable" },
    ...[
      { kind: "figure", lines: 250, text: "250 source lines" },
      { kind: "zero", text: "none" },
      { kind: "ambiguous", text: "small" },
      null,
    ].map((stated) => ({ ...measurement, mode: "merge-base", stated })),
  ];
  for (const sizeReport of inputs) {
    const value = s.parseTransferSize({ sizeReport });
    expect<unknown>(
      s.parseTransferSize(JSON.parse(new TextDecoder().decode(encodeTransferJson(value)))),
    ).toEqual({
      sizeReport,
    });
    expect<unknown>(s.sizeCommitDependencies(value)).toEqual("base" in sizeReport ? [sha, head] : []);
  }
  expect<unknown>(s.parseTransferSize({})).toEqual({});
});
test("size rejects extra members, invalid ranges, modes, counts and stated budgets", () => {
  for (const sizeReport of [
    { unavailable: "x", extra: true },
    { ...range, base: "bad", error: "x" },
    { ...range, mode: "full", error: "x" },
    { ...measurement, stated: null, binary: -1 },
    { ...measurement, stated: { kind: "figure", text: "x" } },
    { ...measurement, stated: { kind: "zero", text: "x", lines: 0 } },
    { ...measurement, stated: null, renamesAcross: [{ from: "a.ts" }] },
  ])
    rejects(() => s.parseTransferSize({ sizeReport }));
  rejects(() => s.parseTransferSize({ sizeReport: undefined }));
});
