import { expect, test } from "bun:test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { ControlKind } from "../src/integrations/control-ref.ts";
import { canonicalRepo } from "../src/integrations/lease-store.ts";
import { fixedFailure, withoutIO } from "./control-purity-support.ts";

const dataKey = Uint8Array.from({ length: 32 }, (_, i) => i);
const hmac = (key: Uint8Array, text: string | Uint8Array) => createHmac("sha256", key).update(text).digest();
// Independent RFC 5869 extract + single-block expand, without production HKDF or JSON helpers.
const extracted = hmac(Buffer.from("limitless-control-naming", "utf8"), dataKey);
const namingKey = hmac(extracted, Buffer.concat([Buffer.from("v1", "utf8"), Buffer.of(1)]));
const fixtures: { kind: ControlKind; components: string[]; tuple: string }[] = [
  {
    kind: "receipt",
    components: ["example/repo", "issue", "admission-001"],
    tuple: '["limitless-control-id",1,"receipt","example/repo","issue","admission-001"]',
  },
  {
    kind: "receipt",
    components: ["example/repo", "comment", "global-comment-001"],
    tuple: '["limitless-control-id",1,"receipt","example/repo","comment","global-comment-001"]',
  },
  {
    kind: "boundary",
    components: ["example/repo"],
    tuple: '["limitless-control-id",1,"boundary","example/repo"]',
  },
  {
    kind: "run-index",
    components: ["example/repo", "logical-run-001"],
    tuple: '["limitless-control-id",1,"run-index","example/repo","logical-run-001"]',
  },
  {
    kind: "member",
    components: ["opaque-Member-001"],
    tuple: '["limitless-control-id",1,"member","opaque-Member-001"]',
  },
  {
    kind: "land-authority",
    components: ["example/repo"],
    tuple: '["limitless-control-id",1,"land-authority","example/repo"]',
  },
];

test("loading and construction do no IO and all failures hide keys and identity material", async () => {
  const sentinel = randomUUID();
  await withoutIO(async () => {
    const { createControlNamer } = await import("../src/integrations/control-identity.ts");
    const key = Buffer.from(sentinel.replaceAll("-", ""), "utf8");
    const namer = createControlNamer(key);
    expect(namer.derive("member", [sentinel]).id).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(namer)).toEqual(["derive"]);
    for (const invalid of [
      null,
      undefined,
      sentinel,
      {},
      Array(32).fill(1),
      new Int8Array(32),
      new Uint8Array(0),
      new Uint8Array(31),
      new Uint8Array(33),
    ])
      fixedFailure(() => createControlNamer(invalid as Uint8Array), "Invalid control naming key", [
        sentinel,
        key.toString("hex"),
      ]);
    const throwing = Object.defineProperty([], "0", {
      get() {
        throw new Error(sentinel);
      },
      enumerable: true,
    });
    for (const components of [null, [sentinel, undefined], [1], Array(1), throwing])
      fixedFailure(() => namer.derive("member", components as string[]), "Invalid control identity", [
        sentinel,
      ]);
    fixedFailure(() => namer.derive(sentinel as ControlKind, [sentinel]), "Invalid control identity", [
      sentinel,
    ]);
  });
});

test("all control tuples match independent private naming vectors and include every component", async () => {
  const { createControlNamer } = await import("../src/integrations/control-identity.ts");
  const namer = createControlNamer(dataKey);
  const peer = createControlNamer(Uint8Array.from(dataKey));
  const changed = createControlNamer(Uint8Array.from(dataKey, (byte) => byte ^ 255));
  for (const { kind, components, tuple } of fixtures) {
    const key = namer.derive(kind, components);
    expect(key).toEqual({ kind, id: hmac(namingKey, tuple).toString("hex") });
    expect(peer.derive(kind, components)).toEqual(key);
    expect(changed.derive(kind, components).id).not.toBe(key.id);
    expect(key.id).not.toBe(createHash("sha256").update(tuple).digest("hex"));
    expect(key.id).not.toBe(hmac(dataKey, tuple).toString("hex"));
    expect(key.id).not.toBe(
      hmac(namingKey, tuple.replace("limitless-control-id", "limitless-control")).toString("hex"),
    );
    for (let index = 0; index < components.length; index++) {
      const altered = components.map((part, i) => (i === index ? `${part}-changed` : part));
      expect(namer.derive(kind, altered).id).not.toBe(key.id);
    }
    if (kind !== "member") {
      const normalized = [canonicalRepo("Example/Repo"), ...components.slice(1)];
      expect(namer.derive(kind, normalized)).toEqual(key);
    }
    if (kind === "boundary" || kind === "land-authority")
      expect(key.id).not.toBe(createHash("sha256").update("example/repo").digest("hex"));
  }
  expect(namer.derive("boundary", ["example/repo"]).id).not.toBe(
    namer.derive("land-authority", ["example/repo"]).id,
  );
  expect(namer.derive("member", ["Opaque"]).id).not.toBe(namer.derive("member", ["opaque"]).id);
});

test("namers capture owned key bytes including Buffer subarray views", async () => {
  const { createControlNamer } = await import("../src/integrations/control-identity.ts");
  const backing = Buffer.alloc(64, 7);
  const caller = backing.subarray(16, 48);
  const namer = createControlNamer(caller);
  const before = fixtures.map(({ kind, components }) => namer.derive(kind, components));
  backing.fill(0);
  expect(fixtures.map(({ kind, components }) => namer.derive(kind, components))).toEqual(before);
});
