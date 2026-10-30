import { expect, test } from "bun:test";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { type ControlKey, createControlRefReader } from "../src/integrations/control-ref.ts";
import {
  createCompanionIO,
  createSharedStore,
  type SharedStoreDeps,
  SharedStoreError,
  type SharedStoreErrorCode,
} from "../src/integrations/shared-store.ts";
import {
  dataKey,
  deferred,
  entry,
  isCas,
  isMeta,
  isRead,
  json,
  never,
  Remote,
  token,
  writes,
} from "./shared-store-fake.ts";

const key: ControlKey = { kind: "receipt", id: "0123456789abcdef".repeat(4) };
const payload = Buffer.from([0, 255, 128, 10, 13, 1]);
const aad = (k: ControlKey) => Buffer.from(JSON.stringify(["limitless-control", 1, k.kind, k.id]));
const ref = (k: ControlKey) => `refs/control/${k.kind}/${k.id}`;
const deps = (remote: Remote): SharedStoreDeps => ({
  repo: "Example/Companion",
  token,
  dataKey,
  request: remote.request,
});
const reader = (remote: Remote, overrides: Partial<SharedStoreDeps> = {}) =>
  createControlRefReader({ ...deps(remote), ...overrides });
function encrypted(k = key) {
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", dataKey, nonce).setAAD(aad(k));
  return Buffer.concat([
    Buffer.of(1),
    nonce,
    cipher.update(payload),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
function seed(remote: Remote, k = key, content = encrypted(k)) {
  const blob = remote.blob(content);
  const tree = remote.tree([entry("control", blob)]);
  const sha = remote.commit(tree, [], "limitless-control: 1");
  remote.refs.set(ref(k), sha);
  return { sha, tree, blob };
}
async function rejects(pending: Promise<unknown>, code: SharedStoreErrorCode) {
  const error: unknown = await pending.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SharedStoreError);
  expect(error).toMatchObject({ code, message: `Shared store error: ${code}` });
  expect(error).not.toHaveProperty("cause");
}

test("independent control envelopes bind both identities; IO seals fresh authenticated frames", async () => {
  const remote = new Remote();
  for (const kind of ["receipt", "boundary", "run-index", "member", "land-authority"] as const) {
    const k = { ...key, kind };
    const { sha } = seed(remote, k);
    expect(await reader(remote).read(k)).toEqual({ kind: "tip", tip: { sha, bytes: payload } });
  }
  for (const transplanted of [
    { ...key, kind: "member" as const },
    { ...key, id: "f".repeat(64) },
  ]) {
    seed(remote, transplanted, encrypted(key));
    await rejects(reader(remote).read(transplanted), "corrupt");
  }
  seed(remote);
  await rejects(reader(remote, { dataKey: new Uint8Array(32) }).read(key), "corrupt");
  const nonces: Buffer[] = [];
  const io = createCompanionIO({
    ...deps(remote),
    random: (size) => {
      const nonce = Buffer.alloc(size, nonces.length + 1);
      nonces.push(nonce);
      return nonce;
    },
  });
  for (let i = 0; i < 2; i++) {
    const frame = Buffer.from(io.seal(aad(key), payload), "base64");
    expect(frame[0]).toBe(1);
    expect(frame.subarray(1, 13).toString("hex")).toBe(nonces[i]?.toString("hex") ?? "");
    const decipher = createDecipheriv("aes-256-gcm", dataKey, frame.subarray(1, 13)).setAAD(aad(key));
    decipher.setAuthTag(frame.subarray(-16));
    expect(Buffer.concat([decipher.update(frame.subarray(13, -16)), decipher.final()])).toEqual(payload);
  }
  expect(nonces[0]).not.toEqual(nonces[1]);
  expect(writes(remote.calls)).toEqual([]);
});

test("construction is inert; configuration and arguments reject before transport; snapshots survive awaits", async () => {
  const remote = new Remote();
  const inert = () => {
    throw new Error("eager IO");
  };
  const config = { ...deps(remote), request: inert, random: inert, deadline: inert };
  createSharedStore(config);
  createControlRefReader(config);
  for (const invalid of [{ repo: "" }, { token: "" }, { dataKey: new Uint8Array(31) }])
    expect(() => reader(remote, invalid)).toThrow("Shared store error: configuration");
  for (const invalid of [
    null,
    {},
    { ...key, kind: "blob" },
    ...["", key.id.toUpperCase(), `${key.id}\n`, "g".repeat(64)].map((id) => ({ ...key, id })),
  ])
    await rejects(reader(remote).read(invalid as ControlKey), "invalid");
  expect(remote.calls).toEqual([]);
  const { sha } = seed(remote);
  const owned = { ...key };
  const ownedKey = Uint8Array.from(dataKey);
  const gate = deferred<void>();
  const started = deferred<void>();
  remote.hook = async (_call, next) => {
    started.resolve();
    await gate.promise;
    return next();
  };
  const client = reader(remote, { dataKey: ownedKey });
  ownedKey.fill(0);
  const pending = client.read(owned);
  await started.promise;
  owned.kind = "boundary";
  owned.id = "f".repeat(64);
  gate.resolve();
  expect(await pending).toEqual({ kind: "tip", tip: { sha, bytes: payload } });
  expect(remote.calls.slice(1).map((c) => c.url.split("/git/")[1])).toEqual([
    `ref/control/receipt/${key.id}`,
    `commits/${sha}`,
    `trees/${remote.commits.get(sha)?.tree}`,
    `blobs/${remote.trees.get(remote.commits.get(sha)?.tree ?? "")?.[0]?.sha}`,
  ]);
});

test("only exact-ref absence selects nothing; unattached ciphertext cannot supply a tip", async () => {
  const remote = new Remote();
  seed(remote);
  remote.refs.clear();
  expect(await reader(remote).read(key)).toEqual({ kind: "absent" });
  expect(remote.calls).toHaveLength(2);
  expect(writes(remote.calls)).toEqual([]);
  remote.hook = async (call, next) => (isRead("git/ref/")(call) ? json(null) : next());
  await rejects(reader(remote).read(key), "corrupt");
});

test("selected commits require exact refs, consistent OIDs, complete one-file trees and supported messages", async () => {
  const remote = new Remote();
  const { sha, tree, blob } = seed(remote);
  const head = { ref: ref(key), object: { sha, type: "commit" } };
  const commit = { sha, message: "limitless-control: 1", tree: { sha: tree } };
  const root = { sha: tree, truncated: false, tree: [entry("control", blob)] };
  const wrong = "a".repeat(40);
  const rows: [string, unknown, SharedStoreErrorCode][] = [
    ["ref/", { ...head, ref: `${ref(key)}x` }, "corrupt"],
    ["ref/", { ...head, object: { sha, type: "tag" } }, "corrupt"],
    ...["x", sha.toUpperCase(), `${sha}\n`].map((bad): [string, unknown, SharedStoreErrorCode] => [
      "ref/",
      { ...head, object: { sha: bad, type: "commit" } },
      "corrupt",
    ]),
    ["commits/", { ...commit, sha: wrong }, "corrupt"],
    ["commits/", { ...commit, tree: { sha: "x" } }, "corrupt"],
    ...["limitless-control: 2", "limitless-control: 1\n\n", "limitless-store: 1"].map(
      (message): [string, unknown, SharedStoreErrorCode] => [
        "commits/",
        { ...commit, message },
        "unsupported",
      ],
    ),
    ["trees/", { ...root, sha: wrong }, "corrupt"],
    ["trees/", { ...root, truncated: true }, "unsupported"],
    ["trees/", { ...root, tree: [] }, "unsupported"],
    ["trees/", { ...root, tree: [...root.tree, entry("extra", blob)] }, "unsupported"],
    ...[{ path: "objects" }, { mode: "100755" }, { mode: "120000" }, { type: "tree" }, { sha: "x" }].map(
      (change): [string, unknown, SharedStoreErrorCode] => [
        "trees/",
        { ...root, tree: [{ ...entry("control", blob), ...change }] },
        "sha" in change ? "corrupt" : "unsupported",
      ],
    ),
    ["blobs/", { sha: wrong, encoding: "base64", content: encrypted() }, "corrupt"],
    ["blobs/", { sha: blob, encoding: "utf-8", content: encrypted() }, "corrupt"],
  ];
  for (const [path, value, code] of rows) {
    remote.hook = async (call, next) => (isRead(`git/${path}`)(call) ? json(value) : next());
    await rejects(reader(remote).read(key), code);
  }
  remote.hook = async (call, next) =>
    isRead("git/commits/")(call) ? json({ ...commit, message: "limitless-control: 1\n" }) : next();
  expect(await reader(remote).read(key)).toMatchObject({ kind: "tip" });
  expect(writes(remote.calls)).toEqual([]);
});

test("missing selected objects, corrupt frames, metadata errors and unavailability never become absence", async () => {
  const remote = new Remote();
  const { blob } = seed(remote);
  const client = reader(remote);
  for (const path of ["commits/", "trees/", "blobs/"]) {
    remote.hook = async (call, next) => (isRead(`git/${path}`)(call) ? json({}, 404) : next());
    await rejects(client.read(key), "missing");
  }
  remote.hook = undefined;
  const frame = Buffer.from(encrypted(), "base64");
  frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 1;
  const version = Buffer.from(encrypted(), "base64");
  version[0] = 2;
  for (const [content, code] of [
    [frame.toString("base64"), "corrupt"],
    [version.toString("base64"), "unsupported"],
    ["!", "corrupt"],
    [Buffer.alloc(28).toString("base64"), "corrupt"],
    [` ${encrypted()}`, "corrupt"],
  ] as const) {
    remote.blobs.set(blob, content);
    await rejects(client.read(key), code);
  }
  remote.blobs.set(blob, encrypted());
  expect(await client.read(key)).toMatchObject({ kind: "tip" });
  for (const metadata of [
    { id: "id", nameWithOwner: "Example/Companion", isPrivate: false },
    { id: "id", nameWithOwner: "other/companion", isPrivate: true },
  ]) {
    remote.metadata = metadata;
    const count = remote.calls.length;
    await rejects(client.read(key), "configuration");
    expect(remote.calls.slice(count)).toHaveLength(1);
  }
  for (const metadata of [null, {}, { id: "", nameWithOwner: "example/companion", isPrivate: true }]) {
    remote.metadata = metadata;
    expect(await client.read(key)).toEqual({ kind: "unconfirmed" });
  }
  for (const path of ["metadata", "ref/", "commits/", "trees/", "blobs/"]) {
    remote.metadata = { id: "id", nameWithOwner: "example/companion", isPrivate: true };
    for (const status of [401, 403, 500]) {
      remote.hook = async (call, next) =>
        (path === "metadata" ? isMeta(call) : isRead(`git/${path}`)(call))
          ? json({ message: "server-private-text" }, status)
          : next();
      expect(await client.read(key)).toEqual({ kind: "unconfirmed" });
    }
  }
});

for (const phase of ["headers", "body"] as const)
  for (const path of ["metadata", "ref/", "commits/", "trees/", "blobs/"])
    for (const cancelled of [false, true])
      test(`${phase} stall at ${path}: ${cancelled ? "caller abort" : "deadline expiry"} settles and cleans up`, async () => {
        const remote = new Remote();
        seed(remote);
        const handles: { controller: AbortController; disposed: number }[] = [];
        const caller = new AbortController();
        const reached = deferred<void>();
        let requestSignal: AbortSignal | null | undefined;
        remote.hook = async (call, next) => {
          if (!(path === "metadata" ? isMeta(call) : isRead(`git/${path}`)(call))) return next();
          requestSignal = call.init.signal;
          if (phase === "headers") {
            reached.resolve();
            return never();
          }
          const response = json({});
          response.text = () => {
            reached.resolve();
            return new Promise(() => undefined);
          };
          return response;
        };
        const pending = reader(remote, {
          deadline: (ms) => {
            expect(ms).toBe(30_000);
            const handle = { controller: new AbortController(), disposed: 0 };
            handles.push(handle);
            return { signal: handle.controller.signal, dispose: () => handle.disposed++ };
          },
        }).read(key, caller.signal);
        await reached.promise;
        expect(handles.at(-1)?.disposed).toBe(0);
        if (cancelled) caller.abort();
        else handles.at(-1)?.controller.abort();
        if (cancelled) await rejects(pending, "aborted");
        else expect(await pending).toEqual({ kind: "unconfirmed" });
        expect(requestSignal?.aborted).toBe(true);
        expect(handles).toHaveLength(remote.calls.length);
        for (const handle of handles) expect(handle.disposed).toBe(1);
        for (const call of remote.calls) {
          expect(call.init.signal?.aborted).toBe(true);
          expect(call.init.redirect).toBe("manual");
          expect(call.init.headers).toEqual({
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          });
        }
      });

test("redirects, GraphQL errors and exceptions use fixed diagnostics; claim errors retain identity", async () => {
  const remote = new Remote();
  seed(remote);
  for (const response of [
    json({ errors: [{ message: "private-server-text" }] }),
    new Response("private-server-text", { status: 302 }),
    new Response("{"),
    json({}, 404),
  ]) {
    remote.hook = async () => response;
    expect(await reader(remote).read(key)).toEqual({ kind: "unconfirmed" });
  }
  const redirected = json({}, 404);
  Object.defineProperty(redirected, "redirected", { value: true });
  remote.hook = async (call, next) => (isRead("git/ref/")(call) ? redirected : next());
  expect(await reader(remote).read(key)).toEqual({ kind: "unconfirmed" });
  for (const claim of [new ClaimLostError(), new ClaimWaitError("lease")]) {
    for (const body of [false, true]) {
      remote.hook = async () => {
        if (!body) throw claim;
        const response = json({});
        response.text = async () => {
          throw claim;
        };
        return response;
      };
      expect(
        await reader(remote)
          .read(key)
          .catch((e: unknown) => e),
      ).toBe(claim);
      expect(
        await remote
          .client()
          .put("abc123", "manifest", "a".repeat(32), payload)
          .catch((e: unknown) => e),
      ).toBe(claim);
    }
  }
  remote.hook = async () => {
    throw new Error("private-exception-text");
  };
  expect(await reader(remote).read(key)).toEqual({ kind: "unconfirmed" });
  await rejects(
    remote.client().get("abc123", "manifest", { key: "a".repeat(32), digest: "b".repeat(64) }),
    "unavailable",
  );
});

test("transport exceptions cannot impersonate HTTP absence; claim exceptions survive IO and CAS", async () => {
  const remote = new Remote();
  seed(remote);
  for (const body of [false, true]) {
    remote.hook = async (call, next) => {
      if (!isRead("git/ref/")(call)) return next();
      if (!body) throw new SharedStoreError("missing");
      const response = json({});
      response.text = async () => {
        throw new SharedStoreError("missing");
      };
      return response;
    };
    expect(await reader(remote).read(key)).toEqual({ kind: "unconfirmed" });
  }
  const claim = new ClaimLostError();
  const io = createCompanionIO({
    ...deps(remote),
    random: () => {
      throw claim;
    },
  });
  expect(() => io.seal(aad(key), payload)).toThrow(claim);
  remote.hook = async (call, next) => {
    if (isCas(call)) throw claim;
    return next();
  };
  expect(
    await remote
      .client()
      .put("abc123", "manifest", "a".repeat(32), payload)
      .catch((e: unknown) => e),
  ).toBe(claim);
});
