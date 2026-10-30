import { expect, test } from "bun:test";
import { RunTransferError } from "../src/pipeline/run-transfer-errors.ts";
import {
  encodeTransferJson,
  parseTransferCounter,
  parseTransferIdentity,
  parseTransferJson,
  parseTransferOid,
} from "../src/pipeline/run-transfer-json.ts";

test("transfer JSON encodes literal canonical UTF-8 with ordered arrays and optional absence", () => {
  const value = { z: [{ b: null, a: "é 🌱" }, 2, 1], "2": true, "10": { z: 0, a: false } };
  const reordered = { "10": { a: false, z: 0 }, "2": true, z: [{ a: "é 🌱", b: null }, 2, 1] };
  const expected = '{"10":{"a":false,"z":0},"2":true,"z":[{"a":"é 🌱","b":null},2,1]}';
  expect(encodeTransferJson(value)).toEqual(new TextEncoder().encode(expected));
  expect(encodeTransferJson(reordered)).toEqual(new TextEncoder().encode(expected));
  expect(new TextDecoder().decode(encodeTransferJson([2, 1]))).toBe("[2,1]");
  expect(new TextDecoder().decode(encodeTransferJson([1, 2]))).toBe("[1,2]");
  expect(new TextDecoder().decode(encodeTransferJson({}))).toBe("{}");
  expect(new TextDecoder().decode(encodeTransferJson({ a: null }))).toBe('{"a":null}');
  const shared = Object.freeze({ n: -1.25, empty: "", exponent: 1e100 });
  expect(parseTransferJson([shared, shared])).toEqual([shared, shared]);
  expect(new TextDecoder().decode(encodeTransferJson(Object.create(null)))).toBe("{}");
});

test("transfer JSON rejects non-JSON members with a fixed diagnostic and never coerces", () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  let invoked = false;
  const toJSON = () => {
    invoked = true;
    return "sentinel";
  };
  const getter = Object.defineProperty({}, "secret", { enumerable: true, get: toJSON });
  const hidden = Object.defineProperty({}, "secret", { value: undefined });
  const invalid: unknown[] = [
    NaN,
    Infinity,
    -Infinity,
    undefined,
    1n,
    Symbol("sentinel"),
    toJSON,
    [undefined],
    { nested: { value: undefined } },
    { nested: [Infinity] },
    new Array(1),
    cycle,
    new Date(0),
    new Map(),
    { toJSON },
    getter,
    hidden,
    { [Symbol("sentinel")]: 1 },
    Object.assign([], { extra: true }),
  ];
  for (const value of invalid) {
    for (const parse of [parseTransferJson, encodeTransferJson]) {
      expect(() => parse(value)).toThrow(RunTransferError);
      expect(() => parse(value)).toThrow("Run transfer data is invalid");
    }
  }
  expect(invoked).toBe(false);
});

test("transfer scalar boundaries preserve spelling and reject without coercion", () => {
  for (const value of [0, Number.MAX_SAFE_INTEGER]) expect(parseTransferCounter(value)).toBe(value);
  for (const value of ["x", " ", " Mixed é 🌱 ", "a\tb"]) expect(parseTransferIdentity(value)).toBe(value);
  for (const value of ["a".repeat(40), "B".repeat(64)]) expect(parseTransferOid(value)).toBe(value);
  const cases: [(value: unknown) => unknown, unknown[]][] = [
    [parseTransferCounter, [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", NaN, Infinity, null, true]],
    [parseTransferIdentity, ["", "a\u0000b", "a\rb", "a\nb", 1, null, new String("id")]],
    [
      parseTransferOid,
      [
        "a".repeat(39),
        "a".repeat(41),
        "a".repeat(63),
        "a".repeat(65),
        "g".repeat(40),
        ` ${"a".repeat(40)}`,
        `${"a".repeat(40)}\n`,
        1,
        null,
      ],
    ],
  ];
  for (const [parse, values] of cases)
    for (const value of values) expect(() => parse(value)).toThrow("Run transfer data is invalid");
});
