import { expect, test } from "bun:test";
import {
  capturePrivacySnapshot,
  checkPrepared,
  concat,
  consumeBoundaryText as consume,
  createPrivacyRegistry,
  preparePrivacyPolicy,
  protectData,
  protectText,
} from "../src/util/privacy-boundary.ts";

const marker = "[withheld: private text]";
const host = ["host", "example"].join(".");
const overlap = ["alpha", "beta"].join('","');
const complete = { kind: "complete" } as const;
function fixture(entries: string[] = [], credentials: string[] = []) {
  const registry = createPrivacyRegistry();
  registry.replacePolicy(entries.map((value, entry) => ({ value, entry })));
  for (const value of credentials) registry.addCredential(value);
  const policy = preparePrivacyPolicy(capturePrivacySnapshot(registry));
  const data = (
    json: unknown,
    extra: Partial<Parameters<typeof protectData>[0]> = {},
    options: Parameters<typeof protectData>[1] = {},
  ) => protectData({ json, provenance: complete, policy, ...extra }, { registry, ...options });
  const text = (text: string) => protectText({ text, provenance: complete, policy }, { registry });
  return { registry, policy, data, text };
}
function refused(value: unknown, reason: ReturnType<typeof consume>["reason"]) {
  const projection = consume(value);
  expect(projection).toMatchObject({ text: marker, withheld: true, reason });
  return projection;
}
const escaped = (text: string) =>
  Array.from(text, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");

test("original document precedes credential field replacement", () => {
  const f = fixture([overlap], ["alpha"]);
  const result = refused(f.data('["alpha","beta"]'), "private-match");
  expect(result.text).not.toContain("beta");
});
test("complete serialization precedes clean tail selection", () => {
  const f = fixture([overlap]);
  const json = '["alpha", "beta", "safe"]';
  expect(consume(f.text(json)).withheld).toBe(false);
  expect(checkPrepared(f.policy, json)).toEqual({ clean: true });
  expect(checkPrepared(f.policy, '["alpha","beta","safe"]')).toHaveProperty("match");
  refused(f.data(json, { cut: { side: "tail", limit: 7, unit: "U" } }), "private-match");
});
test("capped serialization receives an independent check", () => {
  const f = fixture([host]);
  const json = JSON.stringify(`${host}\u0301`);
  expect(checkPrepared(f.policy, json)).toEqual({ clean: true });
  expect(consume(f.data(json))).toMatchObject({ text: json, withheld: false });
  refused(f.data(json, { cut: { limit: host.length + 1, unit: "U" } }), "private-match");
});
test.each([
  ['{"safe":[1,true,null,"fine"]}', '{"safe":[1,true,null,"fine"]}'],
  [
    `{"nested":["${escaped("ab")}",{"${escaped("cd")}":"ok"}]}`,
    `{"nested":["${marker}",{"${marker}":"ok"}]}`,
  ],
  ['{"number":[42,43]}', `{"number":["${marker}",43]}`],
  ["true", "true"],
  ["null", "null"],
  ["1.0", "1"],
  ["1e999", "null"],
  ["broken safe", "broken safe"],
])("fields, keys, numbers and scalar roots: %s", (json, expected) => {
  const f = fixture([], ["ab", "cd", "42"]);
  expect(consume(f.text(json)).withheld).toBe(false);
  expect(consume(f.data(json))).toMatchObject({ text: expected, withheld: false, checkedComplete: true });
});
test("malformed JSON uses checked raw text and exact cuts", () => {
  const f = fixture([host], ["short"]);
  expect(consume(f.data("broken safe", { cut: { limit: 4, side: "tail", unit: "U" } }))).toMatchObject({
    text: "safe",
    withheld: false,
    truncated: true,
  });
  refused(f.data(`broken ${host}`), "private-match");
  refused(f.data("broken short", { cut: { limit: 5, side: "tail", unit: "U" } }), "private-match");
});
test("authority binds exact diagnostic bytes, identity and current generation", () => {
  const f = fixture(['"safe"!']);
  const value = f.data('"safe"');
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.keys(value)).toEqual([]);
  expect(consume(value)).toMatchObject({ text: '"safe"', checkedComplete: true, withheld: false });
  expect(consume(value).text).not.toBe(consume(f.text("safe")).text);
  refused(concat([value, f.text("!")]), "private-match");
  for (const copy of [{ ...value }, structuredClone(value), JSON.parse(JSON.stringify(value))])
    refused(copy, "forged");
  for (const change of [
    (registry: typeof f.registry) => registry.replacePolicy([]),
    (registry: typeof f.registry) => registry.addCredential("new-secret"),
  ]) {
    const next = fixture();
    const issued = next.data('["safe"]');
    change(next.registry);
    refused(issued, "stale-generation");
  }
});
test.each([1, 2, 3])("generation checks cover original, field and serialization issuance %i", (at) => {
  const f = fixture();
  let calls = 0;
  refused(
    f.data(
      '"safe"',
      {},
      {
        beforeIssue: () => {
          if (++calls === at) f.registry.addCredential("new-secret");
        },
      },
    ),
    "stale-generation",
  );
});
test("collisions replace the innermost object and unusual keys remain data", () => {
  const f = fixture([], ["ab", "cd"]);
  const json =
    '{"parent":{"collision":{"ab":1,"cd":2},"safe":[3]},"__proto__":{"x":1},"constructor":4,"toJSON":5}';
  expect(consume(f.data(json))).toMatchObject({
    text: `{"parent":{"collision":"${marker}","safe":[3]},"__proto__":{"x":1},"constructor":4,"toJSON":5}`,
    withheld: false,
  });
  expect(consume(f.data(`{"ab":1,"${marker}":2}`)).text).toBe(JSON.stringify(marker));
  expect(consume(f.data('[{"ab":1,"cd":2},4]')).text).toBe(`["${marker}",4]`);
});
test.each([
  [{ kind: "cut", truncated: true }, true],
  [{ kind: "legacy-unknown" }, undefined],
] as const)("parsing cannot promote provenance %j", (provenance, truncated) => {
  expect(refused(fixture().data('["safe"]', { provenance }), "unchecked-provenance")).toMatchObject({
    truncated,
    checkedComplete: false,
  });
});
test.each([
  ["outputUnits", '"abcdef"', '"'],
  ["outputUnits", '{"longkey":true}', "{"],
  ["outputUnits", "[12345]", "["],
  ["outputBytes", '"abcdef"', '"'],
  ["outputBytes", '{"longkey":true}', "{"],
  ["outputBytes", "[12345]", "["],
] as const)("final %s cap allows a one-unit selection from %s", (key, json, expected) => {
  expect(
    consume(fixture().data(json, { cut: { limit: 1, unit: "U" } }, { limits: { [key]: 1 } })),
  ).toMatchObject({ text: expected, withheld: false, checkedComplete: true, truncated: true });
});
test.each([
  ["", 2, 3],
  ["…", 3, 6],
] as const)("selected text includes marker %j in both output bounds", (marker, units, bytes) => {
  const f = fixture();
  const cut = { limit: 2, unit: "U", marker } as const;
  for (const [key, cap] of [
    ["outputUnits", units],
    ["outputBytes", bytes],
  ] as const) {
    expect(consume(f.data('"émore"', { cut }, { limits: { [key]: cap } }))).toMatchObject({
      text: `"é${marker}`,
      withheld: false,
      checkedComplete: true,
      truncated: true,
    });
    refused(f.data('"émore"', { cut }, { limits: { [key]: cap - 1 } }), "output-length");
  }
});
test.each([
  ["depth", "[0]", 1, "json-depth"],
  ["nodes", '{"a":1}', 3, "json-nodes"],
  ["nodes", "[0]", 2, "json-nodes"],
  ["inputUnits", '"é"', 3, "input-length"],
  ["inputBytes", '"é"', 4, "input-length"],
  ["outputUnits", '"é"', 3, "output-length"],
  ["outputBytes", '"é"', 4, "output-length"],
] as const)("recursive and text bound %s admits equality only", (key, json, cap, reason) => {
  const f = fixture();
  expect(consume(f.data(json, {}, { limits: { [key]: cap } })).withheld).toBe(false);
  refused(f.data(json, {}, { limits: { [key]: cap - 1 } }), reason);
});
test("root depth zero, default depth and complete candidate bounds survive selection", () => {
  const f = fixture([], ["ab"]);
  expect(consume(f.data("0", {}, { limits: { depth: 0, nodes: 1 } })).text).toBe("0");
  const nested = (n: number) => `${"[".repeat(n)}0${"]".repeat(n)}`;
  expect(consume(f.data(nested(32))).withheld).toBe(false);
  refused(f.data(nested(33)), "json-depth");
  const cut = { limit: 1, unit: "U" } as const;
  expect(consume(f.data("[true,true]", { cut }, { limits: { outputUnits: 1 } }))).toMatchObject({
    text: "[",
    truncated: true,
    withheld: false,
  });
  for (const key of ["inputUnits", "inputBytes"] as const)
    refused(
      f.data('"ab"', { cut }, { limits: { [key]: 4, outputUnits: 1, outputBytes: 1 } }),
      "input-length",
    );
  refused(f.data('"ab"', {}, { limits: { outputUnits: 4 } }), "output-length");
});
test("malformed Unicode and terminal fields refuse or render through the boundary", () => {
  const f = fixture([host]);
  for (const json of ['"\\ud800"', '{"\\ud800":0}', `"${String.fromCharCode(0xd800)}"`])
    refused(f.data(json), "ill-formed");
  expect(consume(f.data(JSON.stringify("clean\x1b[0m text"), { terminal: true })).text).toBe('"clean text"');
  expect(consume(f.data(JSON.stringify("host.\x1b[31mexample"), { terminal: true })).text).toBe(
    JSON.stringify(marker),
  );
  refused(f.data("0", { policy: { refused: "entries-count" } }), "unreadable-policy");
});
test("live objects are refused without coercion, getters or toJSON", () => {
  let calls = 0;
  const object = {
    get value() {
      calls++;
      throw new Error("synthetic getter");
    },
    toJSON() {
      calls++;
      return "safe";
    },
    toString() {
      calls++;
      return "safe";
    },
  };
  for (const json of [object, null, 1, false, undefined]) refused(fixture().data(json), "nonconvergent");
  expect(calls).toBe(0);
});
