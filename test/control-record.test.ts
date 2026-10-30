import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createControlNamer } from "../src/integrations/control-identity.ts";
import {
  type ControlValue,
  controlKey,
  decodeControlManifest,
  encodeControlManifest,
  type InputReceipt,
  validateControlReplacement,
  validateControlValue,
} from "../src/integrations/control-record.ts";
import type { ControlKey } from "../src/integrations/control-ref.ts";
import { SharedStoreError, type SharedStoreErrorCode } from "../src/integrations/shared-store.ts";
import { withoutIO } from "./control-purity-support.ts";

const namer = createControlNamer(new Uint8Array(32).fill(7));
const runId = "a".repeat(32);
const otherRun = "b".repeat(32);
const member = `m-${"c".repeat(16)}`;
const reserved = {
  kind: "receipt",
  repo: "example/repo",
  inputKind: "issue",
  inputId: "global-input",
  state: "reserved",
  runId,
  claim: { kind: "issue", repo: "example/repo", number: 1 },
} satisfies InputReceipt;
const committed = {
  ...reserved,
  state: "committed" as const,
  generation: 2,
  checkpoint: `ckpt1:${runId}:${"d".repeat(64)}`,
};
const refused = {
  kind: "receipt",
  repo: reserved.repo,
  inputKind: "issue",
  inputId: reserved.inputId,
  state: "refused",
  reason: "not-authorized",
} satisfies InputReceipt;
const boundary = {
  kind: "boundary",
  repo: reserved.repo,
  enabledAfter: "2026-10-28T12:34:56.000Z",
} satisfies ControlValue;
const index = { kind: "run-index", runId, claim: reserved.claim } satisfies ControlValue;
const advert = { kind: "member", member, data: { nested: ["value"] } } satisfies ControlValue;
const land = { kind: "land-authority", repo: reserved.repo, data: null } satisfies ControlValue;
const receiptKey = namer.derive("receipt", [reserved.repo, reserved.inputKind, reserved.inputId]);
const memberKey = namer.derive("member", [member]);
const mutation = (i: number) => ({
  id: i.toString(16).padStart(32, "0"),
  actor: { kind: "member" as const, id: member },
  commandDigest: "e".repeat(64),
});
function envelope(value: unknown = reserved, key: ControlKey = receiptKey) {
  return { schema: 1, key, version: 1, value, mutations: [mutation(0)] };
}
const wire = (value: unknown) => Buffer.from(JSON.stringify(value));
function fails(run: () => unknown, code: SharedStoreErrorCode, sentinel?: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SharedStoreError);
  expect(caught).toMatchObject({ name: "SharedStoreError", code, message: `Shared store error: ${code}` });
  expect(caught).not.toHaveProperty("cause");
  if (sentinel) expect(JSON.stringify(Object.getOwnPropertyDescriptors(caught))).not.toContain(sentinel);
}

test("receipt repository bindings reject independently on reads, proposals and reservation creation", () => {
  for (const base of [reserved, committed]) {
    const bad = { ...base, claim: { ...base.claim, repo: "other/repo" } };
    fails(() => validateControlValue(bad), "invalid");
    fails(() => decodeControlManifest(namer, receiptKey, wire(envelope(bad))), "corrupt");
    fails(() => encodeControlManifest(namer, envelope(bad)), "invalid");
  }
  const bad = { ...reserved, repo: "other/repo" };
  fails(() => validateControlReplacement(namer, null, bad), "invalid");
  fails(
    () =>
      validateControlReplacement(namer, reserved, {
        ...committed,
        claim: { ...reserved.claim, repo: "other/repo" },
      }),
    "invalid",
  );
});

test("receipt and run-index run claims each bind enclosing IDs, including new reservations", () => {
  for (const base of [reserved, committed, index]) {
    const bad = { ...base, claim: { kind: "run" as const, repo: reserved.repo, runId: otherRun } };
    const key = base.kind === "receipt" ? receiptKey : namer.derive("run-index", [reserved.repo, runId]);
    fails(() => validateControlValue(bad), "invalid");
    fails(() => decodeControlManifest(namer, key, wire(envelope(bad, key))), "corrupt");
    fails(() => encodeControlManifest(namer, envelope(bad, key)), "invalid");
    if (base !== committed) fails(() => validateControlReplacement(namer, null, bad), "invalid");
    const good = { ...bad, claim: { ...bad.claim, runId } };
    expect(validateControlValue(good)).toEqual(good);
  }
});

test("all key tuples use canonical identities and preserve opaque case-sensitive components", () => {
  const fixtures: [unknown, ControlKey][] = [
    [{ ...reserved, repo: "Example/Repo", claim: { ...reserved.claim, repo: "EXAMPLE/REPO" } }, receiptKey],
    [boundary, namer.derive("boundary", [reserved.repo])],
    [
      { ...index, claim: { ...index.claim, repo: "EXAMPLE/REPO" } },
      namer.derive("run-index", [reserved.repo, runId]),
    ],
    [advert, memberKey],
    [land, namer.derive("land-authority", [reserved.repo])],
  ];
  for (const [value, key] of fixtures) {
    expect(controlKey(namer, value)).toEqual(key);
    const decoded = decodeControlManifest(namer, key, wire(envelope(value, key)));
    expect(decoded.key).toEqual(key);
    expect(controlKey(namer, decoded.value)).toEqual(key);
    expect(encodeControlManifest(namer, envelope(value, key), key)).toEqual(
      encodeControlManifest(namer, decoded),
    );
  }
  expect(validateControlValue(fixtures[0]?.[0])).toEqual(reserved);
  expect(controlKey(namer, { ...reserved, inputKind: "comment" })).toEqual(
    namer.derive("receipt", [reserved.repo, "comment", reserved.inputId]),
  );
  expect(controlKey(namer, { ...reserved, inputId: "Global-input" })).not.toEqual(receiptKey);
});

test("transitions accept creation, unchanged replay and monotonic committed proof refresh", () => {
  for (const value of [reserved, refused, boundary, index, advert, land])
    expect(validateControlReplacement(namer, null, value)).toEqual(value);
  for (const value of [reserved, committed, refused, boundary, index, advert, land])
    expect(validateControlReplacement(namer, value, value)).toEqual(value);
  expect(validateControlReplacement(namer, reserved, committed)).toEqual(committed);
  for (const generation of [2, 3, Number.MAX_SAFE_INTEGER]) {
    const refresh = { ...committed, generation, checkpoint: `ckpt1:${otherRun}:${"f".repeat(64)}` };
    expect(validateControlReplacement(namer, committed, refresh)).toEqual(refresh);
  }
  expect(validateControlReplacement(namer, advert, { ...advert, data: [false, null] })).toEqual({
    ...advert,
    data: [false, null],
  });
  expect(validateControlReplacement(namer, land, { ...land, data: { arbitrary: true } })).toEqual({
    ...land,
    data: { arbitrary: true },
  });
  expect(
    validateControlReplacement(namer, reserved, {
      ...committed,
      repo: "EXAMPLE/REPO",
      claim: { ...committed.claim, repo: "Example/Repo" },
    }),
  ).toEqual(committed);
});

const forbidden: [string, unknown | null, unknown][] = [
  ["direct committed creation", null, committed],
  ["boundary timestamp reset", boundary, { ...boundary, enabledAfter: "2026-10-29T12:34:56.000Z" }],
  ["boundary identity reset", boundary, { ...boundary, repo: "other/repo" }],
  ["index run change", index, { ...index, runId: otherRun }],
  ["index claim number change", index, { ...index, claim: { ...index.claim, number: 2 } }],
  ["index claim kind change", index, { ...index, claim: { ...index.claim, kind: "pr" } }],
  ["receipt identity change", reserved, { ...committed, inputId: "another" }],
  ["receipt input kind change", reserved, { ...reserved, inputKind: "comment" }],
  ["reservation run reassignment", reserved, { ...reserved, runId: otherRun }],
  ["reservation committed run reassignment", reserved, { ...committed, runId: otherRun }],
  ["reservation claim reassignment", reserved, { ...committed, claim: { ...reserved.claim, number: 2 } }],
  ["reservation lineage change", reserved, { ...reserved, claim: { ...reserved.claim, kind: "pr" } }],
  ["committed run reassignment", committed, { ...committed, runId: otherRun }],
  ["committed claim reassignment", committed, { ...committed, claim: { ...reserved.claim, number: 2 } }],
  ["selection generation decrease", committed, { ...committed, generation: 1 }],
  ["return to reserved", committed, reserved],
  ["reserved to refused", reserved, refused],
  ["committed to refused", committed, refused],
  ["refusal reason change", refused, { ...refused, reason: "another-reason" }],
  ["refusal to reserved", refused, reserved],
  ["refusal to committed", refused, committed],
  ["member identity change", advert, { ...advert, member: `m-${"d".repeat(16)}` }],
  ["land identity change", land, { ...land, repo: "other/repo" }],
  ["record kind change", land, boundary],
];
test.each(forbidden)("rejects %s", (_name, before, next) => {
  fails(() => validateControlReplacement(namer, before, next), "invalid");
});

test("strict value schemas reject identifiers, numeric boundaries, timestamps and unknown fields", () => {
  const bad: unknown[] = [
    null,
    [],
    {},
    { ...reserved, extra: true },
    { ...reserved, inputKind: "pr" },
    { ...reserved, inputId: "" },
    { ...reserved, repo: "example/repo/extra" },
    ...["", "short", runId.toUpperCase(), `${runId}\n`].map((runId) => ({ ...reserved, runId })),
    ...["short", "A".repeat(32)].map((runId) => ({
      ...index,
      runId,
      claim: { kind: "run", repo: reserved.repo, runId },
    })),
    { ...reserved, claim: { ...reserved.claim, extra: 1 } },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].flatMap((number) => [
      { ...reserved, claim: { ...reserved.claim, number } },
      { ...index, claim: { ...reserved.claim, kind: "pr", number } },
    ]),
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((generation) => ({ ...committed, generation })),
    ...["x", committed.checkpoint.toUpperCase(), `${committed.checkpoint}\n`].map((checkpoint) => ({
      ...committed,
      checkpoint,
    })),
    ...["", "Bad", "bad_tag", "a".repeat(33), "bad\n"].map((reason) => ({ ...refused, reason })),
    ...[
      "",
      "2026-10-28T12:34:56Z",
      "2026-10-28T12:34:56.000+00:00",
      "2026-02-30T00:00:00.000Z",
      "invalid",
    ].map((enabledAfter) => ({ ...boundary, enabledAfter })),
    ...["", "m-short", member.toUpperCase()].map((member) => ({ ...advert, member })),
    { kind: "member", member },
    { kind: "land-authority", repo: reserved.repo },
    { ...committed, reason: "refused" },
    { ...refused, runId },
  ];
  for (const candidate of bad) {
    fails(() => validateControlValue(candidate), "invalid");
    fails(() => decodeControlManifest(namer, receiptKey, wire(envelope(candidate))), "corrupt");
  }
  for (const kind of ["issue", "pr"])
    expect(
      validateControlValue({
        ...reserved,
        claim: { ...reserved.claim, kind, number: Number.MAX_SAFE_INTEGER },
      }),
    ).toMatchObject({ claim: { number: Number.MAX_SAFE_INTEGER } });
  expect(validateControlValue({ ...committed, generation: 0 })).toMatchObject({ generation: 0 });
});

test("envelopes reject unsupported schemas separately, malformed UTF-8/JSON and strict nested fields", () => {
  const m = envelope();
  const entry = mutation(0);
  const bad = [
    null,
    [],
    {},
    { ...m, extra: 1 },
    ...[null, "1", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((schema) => ({ ...m, schema })),
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"].map((version) => ({ ...m, version })),
    { ...m, key: { ...receiptKey, extra: 1 } },
    { ...m, key: { ...receiptKey, id: "F".repeat(64) } },
    { ...m, mutations: [entry, entry] },
    { ...m, mutations: [{ ...entry, extra: true }] },
    ...["short", "A".repeat(32)].map((id) => ({ ...m, mutations: [{ ...entry, id }] })),
    ...["short", "F".repeat(64)].map((commandDigest) => ({ ...m, mutations: [{ ...entry, commandDigest }] })),
    ...[
      { kind: "member", id: "bad" },
      { kind: "github", id: "" },
      { kind: "owner", id: "" },
      { kind: "unknown", id: "x" },
      { ...entry.actor, extra: true },
    ].map((actor) => ({ ...m, mutations: [{ ...entry, actor }] })),
  ];
  for (const input of bad) {
    fails(() => decodeControlManifest(namer, receiptKey, wire(input)), "corrupt");
    fails(() => encodeControlManifest(namer, input), "invalid");
  }
  for (const bytes of [
    Buffer.from("{"),
    Buffer.from("{} trailing"),
    Buffer.from([0xff]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), wire(m)]),
  ])
    fails(() => decodeControlManifest(namer, receiptKey, bytes), "corrupt");
  for (const schema of [2, Number.MAX_SAFE_INTEGER]) {
    fails(() => decodeControlManifest(namer, receiptKey, wire({ ...m, schema })), "unsupported");
    fails(() => encodeControlManifest(namer, { ...m, schema }), "unsupported");
  }
  for (const actor of [
    { kind: "github" as const, id: "Global-ID" },
    { kind: "owner" as const, id: "Provisioned-ID" },
  ]) {
    const input = { ...m, mutations: [{ ...entry, actor }] };
    expect(decodeControlManifest(namer, receiptKey, wire(input)).mutations[0]?.actor).toEqual(actor);
  }
});

test("requested, enclosed and recomputed keys must all agree exactly", () => {
  const wrong = { ...receiptKey, id: "f".repeat(64) };
  fails(() => decodeControlManifest(namer, wrong, wire(envelope())), "corrupt");
  fails(() => decodeControlManifest(namer, receiptKey, wire(envelope(reserved, wrong))), "corrupt");
  fails(() => decodeControlManifest(namer, wrong, wire(envelope(reserved, wrong))), "corrupt");
  fails(() => encodeControlManifest(namer, envelope(reserved, wrong)), "invalid");
  fails(() => encodeControlManifest(namer, envelope(), wrong), "invalid");
  const wrongKind = { ...receiptKey, kind: "member" as const };
  fails(() => decodeControlManifest(namer, wrongKind, wire(envelope(reserved, wrongKind))), "corrupt");
  fails(
    () => decodeControlManifest(namer, { ...receiptKey, extra: true } as ControlKey, wire(envelope())),
    "corrupt",
  );
  fails(() => decodeControlManifest(namer, undefined as unknown as ControlKey, wire(envelope())), "corrupt");
});

test("read byte limits apply before JSON parsing, including exact capacity", () => {
  const m = envelope();
  const base = wire(m);
  const exact = Buffer.concat([base, Buffer.alloc(262144 - base.byteLength, 32)]);
  expect(exact.byteLength).toBe(262144);
  expect<unknown>(decodeControlManifest(namer, receiptKey, exact)).toEqual(m);
  const over = Buffer.concat([exact, Buffer.of(32)]);
  expect(over.byteLength).toBe(262145);
  fails(() => decodeControlManifest(namer, receiptKey, over), "limit");
  fails(() => decodeControlManifest(namer, receiptKey, Buffer.alloc(262145)), "limit");
});

test("canonical write bytes independently fit exactly, then reject one more UTF-8 byte", () => {
  for (const size of [262144, 262145]) {
    const m = envelope({ ...advert, data: "" }, memberKey);
    const remaining = size - Buffer.byteLength(JSON.stringify(m), "utf8");
    m.value = { ...advert, data: "雪".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3) };
    expect(Buffer.byteLength(JSON.stringify(m), "utf8")).toBe(size);
    if (size === 262144) {
      const bytes = encodeControlManifest(namer, m);
      expect(bytes.byteLength).toBe(size);
      expect<unknown>(decodeControlManifest(namer, memberKey, bytes)).toEqual(m);
    } else {
      fails(() => encodeControlManifest(namer, m), "limit");
      fails(() => decodeControlManifest(namer, memberKey, wire(m)), "limit");
    }
  }
});

test("1024 ledger entries remain complete, ordered and replayable; appending cannot prune or roll identity", () => {
  const mutations = Array.from({ length: 1024 }, (_, i) => ({
    id: i.toString(16).padStart(32, "0"),
    actor: { kind: "owner" as const, id: `provisioned-${i}` },
    commandDigest: (i + 1).toString(16).padStart(64, "0"),
  }));
  const m = { ...envelope(advert, memberKey), mutations, version: Number.MAX_SAFE_INTEGER };
  expect(wire(m).byteLength).toBeLessThan(262144);
  const decoded = decodeControlManifest(namer, memberKey, wire(m));
  expect(decoded.mutations).toEqual(mutations);
  expect<unknown>(decodeControlManifest(namer, memberKey, encodeControlManifest(namer, m))).toEqual(m);
  expect(validateControlReplacement(namer, decoded.value, decoded.value)).toEqual(advert);
  const candidate = { ...m, mutations: [...mutations, mutation(1024)] };
  fails(() => encodeControlManifest(namer, candidate), "limit");
  fails(() => decodeControlManifest(namer, memberKey, wire(candidate)), "limit");
  fails(() => encodeControlManifest(namer, { ...m, version: m.version + 1 }), "invalid");
  expect(decoded.mutations).toEqual(mutations);
  expect(decoded.key).toEqual(memberKey);
});

test("operations return owned canonical snapshots and match independently specified canonical bytes", async () => {
  await withoutIO(async () => {
    const input = { ...advert, data: { z: ["雪"], a: { b: 1 } } };
    const captured = validateControlValue(input);
    const replaced = validateControlReplacement(namer, advert, input);
    const m = envelope(input, memberKey);
    const bytes = encodeControlManifest(namer, m);
    const expected = `{"key":{"id":"${memberKey.id}","kind":"member"},"mutations":[{"actor":{"id":"${member}","kind":"member"},"commandDigest":"${"e".repeat(64)}","id":"${"0".repeat(32)}"}],"schema":1,"value":{"data":{"a":{"b":1},"z":["雪"]},"kind":"member","member":"${member}"},"version":1}`;
    expect(Buffer.from(bytes).toString("utf8")).toBe(expected);
    const decoded = decodeControlManifest(namer, memberKey, bytes);
    input.data.a.b = 99;
    input.data.z.push("changed");
    const entry = m.mutations[0];
    if (!entry) throw new Error("Missing fixture entry");
    entry.actor.id = `m-${"f".repeat(16)}`;
    bytes.fill(0);
    const original = { ...advert, data: { a: { b: 1 }, z: ["雪"] } };
    expect(captured).toEqual(original);
    expect(replaced).toEqual(original);
    expect(decoded.value).toEqual(original);
    expect(decoded.mutations).toEqual([mutation(0)]);
  });
});

test("non-JSON proposals and caller exceptions disclose only fixed errors without IO", async () => {
  const sentinel = randomUUID();
  const cycle: unknown[] = [];
  cycle.push(cycle);
  const throwing = Object.defineProperty({}, "private", {
    enumerable: true,
    get() {
      throw new Error(sentinel);
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error(sentinel);
      },
    },
  );
  await withoutIO(async () => {
    for (const data of [
      undefined,
      NaN,
      Infinity,
      -0,
      1n,
      new Date(),
      cycle,
      throwing,
      proxy,
      { [sentinel]: undefined },
    ]) {
      const input = { ...advert, data };
      fails(() => validateControlValue(input), "invalid", sentinel);
      fails(() => controlKey(namer, input), "invalid", sentinel);
      fails(() => encodeControlManifest(namer, envelope(input, memberKey)), "invalid", sentinel);
      fails(() => validateControlReplacement(namer, advert, input), "invalid", sentinel);
    }
    fails(
      () => decodeControlManifest(namer, receiptKey, Buffer.from(`{"${sentinel}":`)),
      "corrupt",
      sentinel,
    );
    const throwingNamer = {
      derive() {
        throw new Error(sentinel);
      },
    };
    fails(() => controlKey(throwingNamer, advert), "invalid", sentinel);
    fails(
      () => decodeControlManifest(throwingNamer, memberKey, wire(envelope(advert, memberKey))),
      "corrupt",
      sentinel,
    );
  });
});
