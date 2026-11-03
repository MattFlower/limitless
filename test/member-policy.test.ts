import { expect, test } from "bun:test";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { linkSync } from "node:fs";
import { join } from "node:path";
import { loadPrivateStrings, privateStringsDigest } from "../src/gates/private.ts";
import { ClaimLostError } from "../src/integrations/claim-errors.ts";
import {
  decodeControlManifest,
  encodeControlManifest,
  validateControlReplacement,
} from "../src/integrations/control-record.ts";
import { checkParity, parityKey } from "../src/integrations/member-policy.ts";
import { SharedStoreError } from "../src/integrations/shared-store.ts";
import { decrypt, fixture, refName } from "./member-support.ts";
import { dataKey, isRead, json } from "./shared-store-fake.ts";

test("policy publishes only an independently keyed digest with an owner ledger entry", async () => {
  const f = fixture();
  f.list("pear\napple\napple\n# ignored\n");
  expect((await f.publish()).kind).toBe("applied");
  const key = f.namer.derive("policy", ["private-strings"]);
  const manifest = JSON.parse(Buffer.from(decrypt(f.remote, key)).toString());
  const canonical = JSON.stringify(["limitless-private-strings/1", "apple", "pear"]);
  const secret = hkdfSync("sha256", dataKey, "limitless-private-strings-parity", "v1", 32);
  const expected = createHmac("sha256", Buffer.from(secret)).update(canonical).digest("hex");
  expect(parityKey(dataKey)).toEqual(Buffer.from(secret));
  expect(manifest.value).toEqual({ kind: "policy", name: "private-strings", digest: expected });
  expect(manifest.mutations[0].actor).toEqual({ kind: "owner", id: "owner-id" });
  const unkeyed = privateStringsDigest(loadPrivateStrings(f.configDir));
  expect(unkeyed).toBe(createHash("sha256").update(canonical).digest("hex"));
  expect(expected).not.toBe(unkeyed);
  const naming = hkdfSync("sha256", dataKey, "limitless-control-naming", "v1", 32);
  expect(expected).not.toBe(createHmac("sha256", Buffer.from(naming)).update(canonical).digest("hex"));
  const memberKey = f.namer.derive("member", [`m-${"a".repeat(16)}`]);
  f.remote.refs.set(refName(memberKey), f.remote.refs.get(refName(key)) ?? "");
  expect(await f.refs.read(memberKey).catch((error: unknown) => error)).toMatchObject({ code: "corrupt" });
});

test("parity reads unchanged tips by ref only, and downloads changed policy tips", async () => {
  const f = fixture();
  expect(await checkParity(f)).toBe("unknown");
  f.list("apple\npear\n");
  await f.publish();
  expect(await checkParity(f)).toBe("match");
  f.list(" # comment\npear\napple\napple\n");
  f.remote.calls = [];
  expect(await checkParity(f)).toBe("match");
  expect(f.remote.calls.filter(isRead("git/ref/"))).toHaveLength(1);
  for (const path of ["commits", "trees", "blobs"])
    expect(f.remote.calls.filter(isRead(`git/${path}/`))).toHaveLength(0);
  expect(f.remote.calls).toHaveLength(2);
  f.list("plum\npear\n");
  expect(await checkParity(f)).toBe("differs");
  await f.publish();
  f.list("apple\npear\n");
  f.remote.calls = [];
  expect(await checkParity(f)).toBe("differs");
  for (const path of ["ref", "commits", "trees", "blobs"])
    expect(f.remote.calls.filter(isRead(`git/${path}/`))).toHaveLength(1);
});

test("unavailable, corrupt, and hard-linked lists are unknown even after a match", async () => {
  const f = fixture();
  f.list("apple");
  await f.publish();
  expect(await checkParity(f)).toBe("match");
  f.remote.hook = async () => json({}, 503);
  expect(await checkParity(f)).toBe("unknown");
  f.remote.hook = undefined;
  const key = f.namer.derive("policy", ["private-strings"]);
  const tip = f.remote.refs.get(refName(key)) ?? null;
  await f.refs.write(key, tip, Buffer.from("{"));
  expect(await checkParity(f)).toBe("unknown");
  await f.refs.write(
    key,
    f.remote.refs.get(refName(key)) ?? null,
    encodeControlManifest(f.namer, {
      schema: 1,
      key,
      version: 3,
      mutations: [],
      value: {
        kind: "policy",
        name: "private-strings",
        digest: privateStringsDigest(loadPrivateStrings(f.configDir), parityKey(dataKey)),
      },
    }),
  );
  expect(await checkParity(f)).toBe("match");
  linkSync(join(f.configDir, "private-strings.txt"), join(f.configDir, "second-link"));
  expect(await checkParity(f)).toBe("unknown");
});

test("claim control and cancellation propagate unchanged", async () => {
  const f = fixture();
  for (const error of [
    new ClaimLostError(),
    new SharedStoreError("aborted"),
    new DOMException("cancelled", "AbortError"),
  ]) {
    const refs = {
      read: async (): Promise<never> => {
        throw error;
      },
    };
    expect(await checkParity({ ...f, refs }).catch((caught: unknown) => caught)).toBe(error);
  }
  const own = new AbortController();
  const cancelled = new Error("cancelled");
  const refs = {
    read: async () => {
      own.abort(cancelled);
      return { kind: "absent" as const };
    },
  };
  expect(await checkParity({ ...f, refs }, own.signal).catch((error: unknown) => error)).toBe(cancelled);
});

test("policy round trips, replaces its digest, and rejects transplant and non-strict values", () => {
  const f = fixture();
  const key = f.namer.derive("policy", ["private-strings"]);
  const value = { kind: "policy" as const, name: "private-strings" as const, digest: "a".repeat(64) };
  const manifest = { schema: 1 as const, key, version: 1, value, mutations: [] };
  const bytes = encodeControlManifest(f.namer, manifest);
  expect(decodeControlManifest(f.namer, key, bytes)).toEqual(manifest);
  expect(validateControlReplacement(f.namer, value, { ...value, digest: "b".repeat(64) })).toEqual({
    ...value,
    digest: "b".repeat(64),
  });
  expect(() =>
    decodeControlManifest(f.namer, f.namer.derive("member", [`m-${"a".repeat(16)}`]), bytes),
  ).toThrow();
  for (const bad of [
    { ...value, name: "other" },
    { ...value, extra: true },
  ])
    expect(() => encodeControlManifest(f.namer, { ...manifest, value: bad })).toThrow();
});
