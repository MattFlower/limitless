import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { expectPureModule, fixedFailure, withoutIO } from "./control-purity-support.ts";

test("JSON module imports only pure dependencies and references no IO globals", () => {
  expectPureModule(new URL("../src/integrations/control-json.ts", import.meta.url), [
    "node:crypto",
    "node:util",
  ]);
});

test("module loading and JSON operations are inert and failures disclose only fixed errors", async () => {
  const sentinel = randomUUID();
  await withoutIO(async () => {
    const { canonicalJson, commandDigest, snapshotJson } = await import(
      "../src/integrations/control-json.ts"
    );
    const command = { text: sentinel };
    expect(canonicalJson(command)).toBe(JSON.stringify(command));
    expect(commandDigest(command)).toHaveLength(64);
    expect(snapshotJson(command)).toEqual(command);
    let accessed = false;
    const throwing = Object.defineProperty({}, sentinel, {
      enumerable: true,
      get() {
        accessed = true;
        throw new Error(sentinel);
      },
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error(sentinel);
        },
      },
    );
    for (const operation of [canonicalJson, commandDigest, snapshotJson])
      for (const value of [throwing, proxy, { [sentinel]: undefined }])
        fixedFailure(() => operation(value), "Invalid control JSON", [sentinel]);
    expect(accessed).toBe(false);
  });
});

test("canonical JSON sorts ordinally at every depth, including numeric keys, and preserves arrays", async () => {
  const { canonicalJson } = await import("../src/integrations/control-json.ts");
  const nested = { z: 1, a: true };
  const input = { z: [nested, nested, null, false], "2": "two", "10": "ten", a: 'é\n"\\\t', A: 0 };
  const expected =
    '{"10":"ten","2":"two","A":0,"a":"é\\n\\"\\\\\\t","z":[{"a":true,"z":1},{"a":true,"z":1},null,false]}';
  expect(canonicalJson(input)).toBe(expected);
  expect(canonicalJson({ A: 0, a: input.a, "10": "ten", "2": "two", z: input.z })).toBe(expected);
  expect(canonicalJson([2, 1])).toBe("[2,1]");
  expect(canonicalJson({ é: 1, Z: 2, a: 3 })).toBe('{"Z":2,"a":3,"é":1}');
  const bare = Object.assign(Object.create(null), { b: 2, a: 1 });
  expect(canonicalJson(bare)).toBe('{"a":1,"b":2}');
  expect(canonicalJson(JSON.parse('{"__proto__":{"ok":true}}'))).toBe('{"__proto__":{"ok":true}}');
});

test("negative zero is refused at every depth while ordinary zero stays valid", async () => {
  const { canonicalJson, commandDigest, snapshotJson } = await import("../src/integrations/control-json.ts");
  for (const operation of [canonicalJson, commandDigest, snapshotJson]) {
    for (const value of [-0, { nested: { value: -0 } }, [[-0]]])
      fixedFailure(() => operation(value), "Invalid control JSON");
    for (const value of [0, { nested: { value: 0 } }, [[0]]]) expect(() => operation(value)).not.toThrow();
  }
});

test("proxies are refused at every depth without invoking traps", async () => {
  const { canonicalJson, commandDigest, snapshotJson } = await import("../src/integrations/control-json.ts");
  let traps = 0;
  const trap = () => {
    traps++;
    throw new Error("Proxy trap invoked");
  };
  for (const target of [{ x: 1 }, [1]]) {
    const proxy = new Proxy(target, { get: trap, getPrototypeOf: trap, ownKeys: trap });
    for (const operation of [canonicalJson, commandDigest, snapshotJson])
      for (const value of [proxy, { nested: { value: proxy } }, [[proxy]]])
        fixedFailure(() => operation(value), "Invalid control JSON");
  }
  expect(traps).toBe(0);
});

test("every non-JSON value rejects instead of being omitted, coerced or custom serialized", async () => {
  const { canonicalJson, commandDigest, snapshotJson } = await import("../src/integrations/control-json.ts");
  const cycle: unknown[] = [];
  cycle.push(cycle);
  const sparse = [1, 2, 3];
  Reflect.deleteProperty(sparse, "1");
  class Instance {
    field = 1;
  }
  let serialized = false;
  const invalid: unknown[] = [
    undefined,
    { a: { b: undefined } },
    [undefined],
    Array(1),
    sparse,
    NaN,
    Infinity,
    -Infinity,
    { number: NaN },
    [Infinity],
    cycle,
    () => 1,
    Symbol(),
    1n,
    { value: Symbol() },
    new Date(),
    /x/,
    new Map(),
    new Set(),
    new Uint8Array(1),
    new Number(1),
    new String("x"),
    new Boolean(false),
    new Instance(),
    {
      toJSON() {
        serialized = true;
        return {};
      },
    },
    { [Symbol()]: 1 },
    Object.defineProperty({}, "hidden", { value: undefined }),
    Object.assign([1], { extra: 2 }),
    Object.create({ inherited: 1 }),
  ];
  for (const value of invalid)
    for (const operation of [canonicalJson, commandDigest, snapshotJson])
      fixedFailure(() => operation(value), "Invalid control JSON");
  expect(serialized).toBe(false);
});

test("snapshots own every nested value and digests hash the original canonical UTF-8 bytes", async () => {
  const { canonicalJson, commandDigest, snapshotJson } = await import("../src/integrations/control-json.ts");
  const command = { z: { y: [{ b: "雪", a: 1 }], a: false }, a: [3, 2, 1], "2": "two", "10": "ten" };
  const original = '{"10":"ten","2":"two","a":[3,2,1],"z":{"a":false,"y":[{"a":1,"b":"雪"}]}}';
  const expectedDigest = createHash("sha256").update(original, "utf8").digest("hex");
  const snapshot = snapshotJson(command);
  expect(commandDigest(command)).toBe(expectedDigest);
  const item = command.z.y[0];
  if (!item) throw new Error("Missing fixture item");
  item.a = 9;
  item.b = "changed";
  command.z.y[0] = { a: 9, b: "changed" };
  command.z.y.push({ a: 10, b: "new" });
  command.z.a = true;
  command.a.reverse();
  expect(canonicalJson(snapshot)).toBe(original);
  expect(commandDigest(snapshot)).toBe(expectedDigest);
  expect(commandDigest(command)).not.toBe(expectedDigest);
});
