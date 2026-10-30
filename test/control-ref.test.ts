import { expect, test } from "bun:test";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { bindClaim, claimGuard, claimScope } from "../src/integrations/claim-guard.ts";
import {
  CONTROL_REF_RESPONSE_LIMIT,
  type ControlKey,
  type ControlRefOutcome,
  createControlRefClient,
  createControlRefReader,
} from "../src/integrations/control-ref.ts";
import {
  createCompanionIO,
  createSharedStore,
  type SharedStoreDeps,
  SharedStoreError,
  type SharedStoreErrorCode,
} from "../src/integrations/shared-store.ts";
import { LEASE, windowOpen } from "../src/util/claim-clock.ts";
import {
  dataKey,
  deferred,
  entry,
  isCas,
  isMeta,
  isPost,
  isRead,
  json,
  never,
  Remote,
  synthetic,
  token,
  writes,
  zeros,
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
const writer = (remote: Remote, overrides: Partial<SharedStoreDeps> = {}) =>
  createControlRefClient({ ...deps(remote), ...overrides });
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

const responsePaths = ["metadata", "ref/", "commits/", "trees/", "blobs/"];
const matches = (path: string, call: Parameters<typeof isMeta>[0]) =>
  path === "metadata" ? isMeta(call) : isRead(`git/${path}`)(call);
function streamed(chunks: Uint8Array[], headers = {}, status = 200, remainder?: Promise<void>) {
  const tail = deferred<void>();
  const state = { pulls: 0, cancelled: false, complete: false };
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const chunk = chunks[state.pulls++];
          if (chunk) return controller.enqueue(chunk);
          tail.resolve();
          if (remainder) await remainder;
          state.complete = true;
          controller.close();
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
    { headers, status },
  );
  return { response, state, tail: tail.promise };
}

test("control response limit is 1 MiB; declared overflow refuses before any body read", async () => {
  expect(CONTROL_REF_RESPONSE_LIMIT).toBe(1_048_576);
  for (const path of responsePaths) {
    const remote = new Remote();
    seed(remote);
    const wire = streamed([Buffer.from("private-server-text")], {
      "Content-Length": String(CONTROL_REF_RESPONSE_LIMIT + 1),
    });
    remote.hook = async (call, next) => (matches(path, call) ? wire.response : next());
    await rejects(reader(remote).read(key), "invalid");
    expect(wire.state.pulls).toBe(0);
  }
});

for (const header of [undefined, "1"])
  test(`streamed overflow with ${header ? "understated" : "missing"} length stops before deferred remainder`, async () => {
    for (const path of responsePaths) {
      const remote = new Remote();
      seed(remote);
      const caller = new AbortController();
      const remainder = deferred<void>();
      const wire = streamed(
        [Buffer.alloc(CONTROL_REF_RESPONSE_LIMIT - 1, 32), Buffer.from("é")],
        header ? { "Content-Length": header } : {},
        200,
        remainder.promise,
      );
      remote.hook = async (call, next) => (matches(path, call) ? wire.response : next());
      const pending = reader(remote).read(key, caller.signal);
      try {
        await rejects(Promise.race([pending, wire.tail.then(() => "drained remainder")]), "invalid");
        expect(wire.state).toMatchObject({ pulls: 2, cancelled: true, complete: false });
      } finally {
        caller.abort();
        remainder.resolve();
        await pending.catch(() => undefined);
      }
    }
  });

test("authenticated control responses exactly at the byte limit succeed at every request", async () => {
  const remote = new Remote();
  const { sha } = seed(remote);
  const bodies: ReturnType<typeof streamed>[] = [];
  remote.hook = async (_call, next) => {
    const response = await next();
    const bytes = Buffer.from(await response.text());
    const wire = streamed([bytes, Buffer.alloc(CONTROL_REF_RESPONSE_LIMIT - bytes.length, 32)], {
      "Content-Length": String(CONTROL_REF_RESPONSE_LIMIT),
    });
    bodies.push(wire);
    return wire.response;
  };
  expect(await reader(remote).read(key)).toEqual({ kind: "tip", tip: { sha, bytes: payload } });
  expect(bodies).toHaveLength(5);
  for (const wire of bodies) expect(wire.state.complete).toBe(true);
  const blob = [...remote.blobs.keys()][0] ?? "";
  const frame = Buffer.from(encrypted(), "base64");
  frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 1;
  remote.blobs.set(blob, frame.toString("base64"));
  await rejects(reader(remote).read(key), "corrupt");
});

for (const outcome of ["absence", "valid blob", "invalid blob"])
  test(`cancellation during deadline disposal after ${outcome} rejects aborted`, async () => {
    const remote = new Remote();
    seed(remote);
    if (outcome === "absence") remote.refs.clear();
    const caller = new AbortController();
    let body: ReturnType<typeof streamed> | undefined;
    let disposed = false;
    remote.hook = async (call, next) => {
      if (!isRead(outcome === "absence" ? "git/ref/" : "git/blobs/")(call)) return next();
      const response = await next();
      // Malformed blob metadata throws inside content(), before the reader's post-content abort check.
      const bytes = outcome === "invalid blob" ? Buffer.from("{}") : Buffer.from(await response.text());
      body = streamed([bytes], {}, response.status);
      return body.response;
    };
    await rejects(
      reader(remote, {
        deadline: () => ({
          signal: new AbortController().signal,
          dispose() {
            if (!body) return;
            expect(body.state.complete).toBe(true);
            disposed = true;
            caller.abort();
          },
        }),
      }).read(key, caller.signal),
      "aborted",
    );
    expect(disposed).toBe(true);
  });

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
          return new Response(
            new ReadableStream(
              {
                pull() {
                  reached.resolve();
                  return new Promise(() => undefined);
                },
              },
              { highWaterMark: 0 },
            ),
          );
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
        return new Response(
          new ReadableStream({
            pull() {
              throw claim;
            },
          }),
        );
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
      return new Response(
        new ReadableStream({
          pull() {
            throw new SharedStoreError("missing");
          },
        }),
      );
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

for (const existing of [false, true])
  test(`independent writers race with exact CAS and parents from ${existing ? "a tip" : "absence"}`, async () => {
    const remote = new Remote();
    const before = existing ? seed(remote).sha : null;
    const reached = deferred<void>();
    const gates = [deferred<void>(), deferred<void>()];
    let count = 0;
    remote.hook = async (call, next) => {
      if (isCas(call)) {
        const gate = gates[count++];
        if (count === 2) reached.resolve();
        await gate?.promise;
      }
      return next();
    };
    const other = Buffer.from("different control bytes");
    const a = writer(remote).write(key, before, payload);
    const b = writer(remote).write(key, before, other);
    await reached.promise;
    gates[0]?.resolve();
    const winner = await a;
    expect(winner).toMatchObject({ kind: "applied", tip: { bytes: payload } });
    if (winner.kind !== "applied") throw new Error("Expected confirmed winner");
    gates[1]?.resolve();
    expect(await b).toEqual({ kind: "moved", tip: winner.tip });
    const selected = await reader(remote).read(key);
    expect(selected).toEqual({ kind: "tip", tip: winner.tip });
    expect(remote.unconditional).toBe(false);
    const attempts = remote.calls.filter(isCas);
    expect(attempts).toHaveLength(2);
    for (const call of attempts) {
      const sha = call.body.variables?.u?.[0]?.afterOid ?? "";
      expect(call.body.variables).toEqual({
        r: "repository-id",
        u: [{ name: ref(key), beforeOid: before ?? zeros, afterOid: sha, force: false }],
      });
      expect(remote.commits.get(sha)?.parents).toEqual(before ? [before] : []);
    }
    for (const call of remote.calls.filter(isPost("git/commits"))) {
      expect(call.body).toEqual({
        message: "limitless-control: 1",
        tree: expect.any(String),
        parents: before ? [before] : [],
        author: synthetic,
        committer: synthetic,
      });
    }
    for (const call of remote.calls.filter(isPost("git/trees")))
      expect(call.body).toEqual({ tree: [entry("control", expect.any(String))] });
    for (const call of remote.calls) {
      expect(call.init.headers).toEqual({
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      });
      expect(call.init.redirect).toBe("manual");
      expect(call.init.signal?.aborted).toBe(true);
    }
    const uploads = remote.calls.filter(isPost("git/blobs"));
    expect(uploads).toHaveLength(2);
    expect(uploads[0]?.body).toEqual({ content: expect.any(String), encoding: "base64" });
    expect(createCompanionIO(deps(remote)).open(aad(key), uploads[0]?.body.content ?? "")).toEqual(payload);
    expect(createCompanionIO(deps(remote)).open(aad(key), uploads[1]?.body.content ?? "")).toEqual(other);
    expect(JSON.stringify(remote.calls.map((c) => c.body))).not.toContain(other.toString());
  });

test("ambiguous dispatch reconciles selected authenticated bytes once and never retries", async () => {
  for (const existing of [false, true]) {
    for (const evidence of [
      "attempt",
      "equivalent",
      "original",
      "different",
      "absent",
      "unavailable",
      "corrupt",
      "unsupported",
      "missing",
    ]) {
      const remote = new Remote();
      const before = existing ? seed(remote).sha : null;
      let after: string | undefined = before ?? undefined;
      remote.hook = async (call, next) => {
        if (!isCas(call)) {
          if (remote.calls.some(isCas) && evidence === "unavailable") return json({}, 503);
          return next();
        }
        if (evidence === "attempt") {
          await next();
          after = remote.refs.get(ref(key));
        } else if (["equivalent", "different", "corrupt", "unsupported", "missing"].includes(evidence)) {
          const bytes = evidence === "different" ? Buffer.from("other") : payload;
          const content = createCompanionIO(deps(remote)).seal(aad(key), bytes);
          after = seed(remote, key, evidence === "corrupt" ? "!" : content).sha;
          if (evidence === "unsupported") {
            const commit = remote.commits.get(after);
            if (commit) commit.message = "limitless-control: 2";
          }
          if (evidence === "missing") remote.commits.delete(after);
        } else if (evidence === "absent") {
          remote.refs.delete(ref(key));
          after = undefined;
        }
        throw new Error("private dispatch failure");
      };
      const result = await writer(remote).write(key, before, payload);
      const original = before ? { sha: before, bytes: payload } : null;
      const expected: ControlRefOutcome = ["attempt", "equivalent"].includes(evidence)
        ? { kind: "applied", tip: { sha: after ?? "", bytes: payload } }
        : evidence === "original" || (evidence === "absent" && !existing)
          ? { kind: "unchanged", tip: original }
          : evidence === "different"
            ? { kind: "moved", tip: { sha: after ?? "", bytes: Buffer.from("other") } }
            : { kind: "unconfirmed" };
      expect(result).toEqual(expected);
      expect(remote.calls.filter(isCas)).toHaveLength(1);
      expect(remote.calls.filter(isMeta)).toHaveLength(2);
      expect(remote.calls.filter(isRead("git/ref/"))).toHaveLength(evidence === "unavailable" ? 1 : 2);
    }
  }
  for (const response of [
    () => json({}),
    () => new Response("{"),
    () => json({ errors: [{ message: "private" }] }),
    () => json({}, 500),
  ]) {
    const remote = new Remote();
    remote.hook = async (call, next) => (isCas(call) ? response() : next());
    expect(await writer(remote).write(key, null, payload)).toEqual({ kind: "unchanged", tip: null });
    expect(remote.calls.filter(isCas)).toHaveLength(1);
    expect(remote.calls.filter(isRead("git/ref/"))).toHaveLength(2);
  }
});

test("initial mismatch, disappearance, corruption and unavailability never upload or replace", async () => {
  const remote = new Remote();
  const { sha, blob } = seed(remote);
  expect(await writer(remote).write(key, null, payload)).toEqual({
    kind: "moved",
    tip: { sha, bytes: payload },
  });
  expect(await writer(remote).write(key, "a".repeat(40), payload)).toEqual({
    kind: "moved",
    tip: { sha, bytes: payload },
  });
  remote.blobs.set(blob, "!");
  await rejects(writer(remote).write(key, sha, payload), "corrupt");
  remote.refs.clear();
  expect(await writer(remote).write(key, sha, payload)).toEqual({ kind: "unconfirmed" });
  for (const at of [isMeta, isRead("git/ref/")]) {
    remote.hook = async (call, next) => (at(call) ? json({}, 503) : next());
    expect(await writer(remote).write(key, null, payload)).toEqual({ kind: "unconfirmed" });
  }
  expect(writes(remote.calls)).toHaveLength(0);
});

for (const path of ["git/blobs", "git/trees", "git/commits"])
  test(`preparation at ${path} is not persistence; operational failures observe unchanged`, async () => {
    for (const existing of [false, true]) {
      const remote = new Remote();
      const before = existing ? seed(remote).sha : null;
      const reached = deferred<void>();
      const gate = deferred<void>();
      remote.hook = async (call, next) => {
        const result = await next();
        if (isPost(path)(call)) {
          reached.resolve();
          await gate.promise;
          throw new Error("private preparation failure");
        }
        return result;
      };
      const pending = writer(remote).write(key, before, Buffer.from("new value"));
      expect(
        await Promise.race([reached.promise.then(() => "prepared"), pending.then(() => "settled")]),
      ).toBe("prepared");
      expect(await reader(remote).read(key)).toEqual(
        before ? { kind: "tip", tip: { sha: before, bytes: payload } } : { kind: "absent" },
      );
      gate.resolve();
      expect(await pending).toEqual({
        kind: "unchanged",
        tip: before ? { sha: before, bytes: payload } : null,
      });
      expect(remote.calls.filter(isCas)).toHaveLength(0);
      expect(remote.refs.get(ref(key))).toBe(before ?? undefined);
    }
  });

for (const phase of ["headers", "body"])
  for (const path of ["prepare", "cas", "reconcile"])
    for (const cancel of [false, true])
      test(`writer ${path} ${phase} stall: ${cancel ? "caller cancellation" : "complete-response deadline"}`, async () => {
        const remote = new Remote();
        const caller = new AbortController();
        const reached = deferred<void>();
        const handles: { controller: AbortController; disposed: number }[] = [];
        let stalled: AbortSignal | null | undefined;
        remote.hook = async (call, next) => {
          if (path === "reconcile" && isCas(call)) return json({ errors: [] });
          const at =
            path === "prepare"
              ? isPost("git/commits")(call)
              : path === "cas"
                ? isCas(call)
                : isRead("git/ref/")(call) && remote.calls.some(isCas);
          if (!at) return next();
          stalled = call.init.signal;
          if (phase === "headers") {
            reached.resolve();
            return never();
          }
          return new Response(
            new ReadableStream(
              {
                pull() {
                  reached.resolve();
                  return new Promise(() => undefined);
                },
              },
              { highWaterMark: 0 },
            ),
          );
        };
        const pending = writer(remote, {
          deadline: (ms) => {
            expect(ms).toBe(30_000);
            const h = { controller: new AbortController(), disposed: 0 };
            handles.push(h);
            return { signal: h.controller.signal, dispose: () => h.disposed++ };
          },
        }).write(key, null, payload, caller.signal);
        await reached.promise;
        expect(handles.at(-1)?.disposed).toBe(0);
        if (cancel) caller.abort();
        else handles.at(-1)?.controller.abort();
        if (cancel && path === "prepare") await rejects(pending, "aborted");
        else
          expect(await pending).toEqual(
            path === "reconcile" || (cancel && path === "cas")
              ? { kind: "unconfirmed" }
              : { kind: "unchanged", tip: null },
          );
        expect(stalled?.aborted).toBe(true);
        expect(handles).toHaveLength(remote.calls.length);
        for (const h of handles) expect(h.disposed).toBe(1);
        expect(remote.calls.filter(isCas)).toHaveLength(path === "prepare" ? 0 : 1);
        expect(remote.calls.filter(isRead("git/ref/"))).toHaveLength(
          path === "reconcile" || (path === "cas" && !cancel) ? 2 : 1,
        );
      });

const handle = {
  repo: "example/project",
  ref: "refs/limitless/claims/1",
  run: "run-a",
  member: "m-0123456789abcdef",
  generation: 1,
};
for (const change of ["lost", "suspend", "expired", "cancelled", "identity", "valid"])
  test(`ambient claim ${change} during preparation retains scope and blocks invalid CAS`, async () => {
    const remote = new Remote();
    const ready = deferred<void>();
    const resume = deferred<void>();
    const anchor = { inclusive: 1_000, exclusive: 1_000 };
    let now = { ...anchor };
    let cancelled = false;
    let failure: ClaimWaitError | undefined;
    let checks = 0;
    const claim = bindClaim(
      {
        windowOpen: () => {
          checks++;
          if (failure) throw failure;
          return windowOpen(anchor, now);
        },
      },
      handle,
      () => cancelled,
    );
    remote.hook = async (call, next) => {
      const response = await next();
      if (isPost("git/commits")(call)) {
        ready.resolve();
        await resume.promise;
      }
      if (isCas(call)) claimGuard(); // Transport also observes the retained ambient scope.
      return response;
    };
    const pending = claimScope
      .run([claim], () => writer(remote).write(key, null, payload))
      .catch((e: unknown) => e);
    await ready.promise;
    expect(checks).toBe(0);
    if (change === "lost") claim.onLost(handle, null);
    if (change === "suspend") now.inclusive += LEASE.suspendToleranceMs + 1;
    if (change === "expired")
      now = { inclusive: anchor.inclusive + LEASE.windowMs, exclusive: anchor.exclusive + LEASE.windowMs };
    if (change === "cancelled") cancelled = true;
    if (change === "identity") failure = new ClaimWaitError("unavailable");
    resume.resolve();
    const result = await pending;
    if (change === "valid") expect(result).toMatchObject({ kind: "applied" });
    else if (failure) expect(result).toBe(failure);
    else if (change === "lost") expect(result).toBeInstanceOf(ClaimLostError);
    else
      expect(result).toMatchObject({
        name: "ClaimWaitError",
        reason: change === "cancelled" ? "cancelled" : "lease",
      });
    expect(remote.calls.filter(isCas)).toHaveLength(change === "valid" ? 1 : 0);
    expect(anchor).toEqual({ inclusive: 1_000, exclusive: 1_000 });
  });

test("claim-control exceptions from preparation, CAS and reconciliation escape by identity", async () => {
  for (const at of ["upload", "commit", "cas", "reconcile"])
    for (const body of [false, true]) {
      const remote = new Remote();
      const error = new ClaimLostError();
      remote.hook = async (call, next) => {
        if (at === "reconcile" && isCas(call)) return json({ errors: [] });
        const matched =
          at === "upload"
            ? isPost("git/blobs")(call)
            : at === "commit"
              ? isPost("git/commits")(call)
              : at === "cas"
                ? isCas(call)
                : isRead("git/ref/")(call) && remote.calls.some(isCas);
        if (!matched) return next();
        if (!body) throw error;
        return new Response(
          new ReadableStream({
            pull() {
              throw error;
            },
          }),
        );
      };
      expect(
        await writer(remote)
          .write(key, null, payload)
          .catch((e: unknown) => e),
      ).toBe(error);
      expect(remote.calls.filter(isCas)).toHaveLength(at === "upload" || at === "commit" ? 0 : 1);
    }
});

test("writer construction, validation and captured mutable inputs preserve reader contracts", async () => {
  const remote = new Remote();
  const inert = () => {
    throw new Error("eager IO");
  };
  createControlRefClient({ ...deps(remote), request: inert, random: inert, deadline: inert });
  for (const invalid of [{ repo: "" }, { token: "" }, { dataKey: new Uint8Array(31) }])
    expect(() => writer(remote, invalid)).toThrow("Shared store error: configuration");
  for (const invalid of [
    undefined,
    "",
    "f".repeat(39),
    "f".repeat(41),
    "F".repeat(40),
    `${"f".repeat(40)}\n`,
    "g".repeat(40),
  ])
    await rejects(writer(remote).write(key, invalid as string, payload), "invalid");
  for (const invalid of [null, {}, { ...key, kind: "blob" }, { ...key, id: key.id.toUpperCase() }])
    await rejects(writer(remote).write(invalid as ControlKey, null, payload), "invalid");
  await rejects(writer(remote).write(key, null, "plaintext" as unknown as Uint8Array), "invalid");
  const caller = new AbortController();
  caller.abort();
  await rejects(writer(remote).write(key, null, payload, caller.signal), "aborted");
  expect(remote.calls).toHaveLength(0);
  const owned = { ...key };
  const bytes = Buffer.from(payload);
  const secret = Uint8Array.from(dataKey);
  const ready = deferred<void>();
  const resume = deferred<void>();
  remote.hook = async (call, next) => {
    if (isMeta(call)) {
      ready.resolve();
      await resume.promise;
    }
    return next();
  };
  const client = writer(remote, { dataKey: secret });
  secret.fill(0);
  const pending = client.write(owned, null, bytes);
  await ready.promise;
  owned.kind = "member";
  owned.id = "f".repeat(64);
  bytes.fill(0);
  resume.resolve();
  expect(await pending).toMatchObject({ kind: "applied", tip: { bytes: payload } });
  expect(await reader(remote).read(key)).toMatchObject({ kind: "tip", tip: { bytes: payload } });
  expect(await reader(remote).read(owned)).toEqual({ kind: "absent" });
});

test("writer checks private companion identity freshly and uses fixed private failure diagnostics", async () => {
  const remote = new Remote();
  const client = writer(remote);
  expect(await client.write(key, null, payload)).toMatchObject({ kind: "applied" });
  const before = remote.refs.get(ref(key)) ?? "";
  for (const metadata of [
    { id: "repository-id", nameWithOwner: "Example/Companion", isPrivate: false },
    { id: "repository-id", nameWithOwner: "other/companion", isPrivate: true },
  ]) {
    remote.metadata = metadata;
    const count = remote.calls.length;
    await rejects(client.write(key, before, payload), "configuration");
    expect(remote.calls.slice(count)).toHaveLength(1);
  }
  for (const at of [isMeta, isPost("git/blobs"), isCas]) {
    const fresh = new Remote();
    fresh.hook = async (call, next) => {
      if (at(call)) throw new Error(`private server text ${token} ${payload.toString("hex")}`);
      return next();
    };
    const result = await writer(fresh).write(key, null, payload);
    expect(result).toEqual(at === isMeta ? { kind: "unconfirmed" } : { kind: "unchanged", tip: null });
  }
});

test("writer response bounds apply during preparation, CAS and reconciliation", async () => {
  for (const path of ["prepare", "cas", "reconcile"]) {
    const remote = new Remote();
    const wire = streamed([Buffer.alloc(CONTROL_REF_RESPONSE_LIMIT), Buffer.from("x")]);
    remote.hook = async (call, next) => {
      if (path === "reconcile" && isCas(call)) return json({ errors: [] });
      const at =
        path === "prepare"
          ? isPost("git/blobs")(call)
          : path === "cas"
            ? isCas(call)
            : isRead("git/ref/")(call) && remote.calls.some(isCas);
      return at ? wire.response : next();
    };
    expect(await writer(remote).write(key, null, payload)).toEqual(
      path === "reconcile" ? { kind: "unconfirmed" } : { kind: "unchanged", tip: null },
    );
    expect(wire.state).toMatchObject({ pulls: 2, cancelled: true });
  }
});

for (const path of ["git/blobs", "git/commits"])
  test(`caller abort after successful ${path} response cannot acknowledge preparation`, async () => {
    const remote = new Remote();
    const caller = new AbortController();
    let prepared = false;
    remote.hook = async (call, next) => {
      const response = await next();
      if (isPost(path)(call)) prepared = true;
      return response;
    };
    await rejects(
      writer(remote, {
        deadline: () => ({
          signal: new AbortController().signal,
          dispose() {
            if (prepared) caller.abort();
          },
        }),
      }).write(key, null, payload, caller.signal),
      "aborted",
    );
    expect(prepared).toBe(true);
    expect(remote.calls.filter(isCas)).toHaveLength(0);
    expect(await reader(remote).read(key)).toEqual({ kind: "absent" });
  });

test("unchanged after a dispatch deadline is an observation; the outstanding CAS can still apply", async () => {
  const remote = new Remote();
  const reached = deferred<void>();
  const resume = deferred<void>();
  const completed = deferred<void>();
  const handles: AbortController[] = [];
  remote.hook = async (call, next) => {
    if (!isCas(call)) return next();
    reached.resolve();
    await resume.promise;
    const response = await next();
    completed.resolve();
    return response;
  };
  const pending = writer(remote, {
    deadline: () => {
      const controller = new AbortController();
      handles.push(controller);
      return { signal: controller.signal, dispose() {} };
    },
  }).write(key, null, payload);
  await reached.promise;
  handles.at(-1)?.abort();
  expect(await pending).toEqual({ kind: "unchanged", tip: null });
  expect(await reader(remote).read(key)).toEqual({ kind: "absent" });
  resume.resolve();
  await completed.promise;
  expect(await reader(remote).read(key)).toMatchObject({ kind: "tip", tip: { bytes: payload } });
  expect(remote.calls.filter(isCas)).toHaveLength(1);
});
