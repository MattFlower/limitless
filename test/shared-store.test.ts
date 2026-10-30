import { describe, expect, spyOn, test } from "bun:test";
import { createDecipheriv } from "node:crypto";
import { getEventListeners } from "node:events";
import { formatRecord, parseRecord } from "../src/integrations/claim-ref.ts";
import {
  type RetentionOutcome,
  SharedStoreError,
  type SharedStoreErrorCode,
} from "../src/integrations/shared-store.ts";

import {
  bytesOf,
  type Call,
  dataKey,
  deferred,
  type Entry,
  entry,
  type Hook,
  hash,
  isCas,
  isMeta,
  isPost,
  isRead,
  json,
  keyA,
  keyB,
  keyC,
  never,
  otherRun,
  Remote,
  ref,
  role,
  runId,
  synthetic,
  token,
  writes,
  zeros,
} from "./shared-store-fake.ts";

// Route the first call matching `match` through `handle`; later calls pass through.
function intercept(remote: Remote, match: (call: Call) => boolean, handle: Hook): Promise<Call> {
  const reached = deferred<Call>();
  const previous = remote.hook;
  let used = false;
  remote.hook = (call, next) => {
    if (used || !match(call)) return previous ? previous(call, next) : next();
    used = true;
    reached.resolve(call);
    return handle(call, next);
  };
  return reached.promise;
}
function hold() {
  const gate = deferred<void>();
  const hook: Hook = async (_call, next) => {
    await gate.promise;
    return next();
  };
  return { hook, release: () => gate.resolve() };
}
function stalledBody(value: unknown = {}) {
  const reading = deferred<void>();
  const complete = deferred<string>();
  const response = json(value);
  response.text = () => {
    reading.resolve();
    return complete.promise;
  };
  return { response, reading: reading.promise, complete };
}
function track(pending: Promise<unknown>) {
  const state = { settled: false };
  pending.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}
async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}
function expectError(error: unknown, code: SharedStoreErrorCode) {
  expect(error).toBeInstanceOf(SharedStoreError);
  expect(error).toMatchObject({ code, message: `Shared store error: ${code}` });
  expect(error).not.toHaveProperty("cause");
}
function throws(action: () => unknown, code: SharedStoreErrorCode) {
  try {
    action();
  } catch (error) {
    return expectError(error, code);
  }
  throw new Error(`Expected ${code}`);
}
async function rejects(pending: Promise<unknown>, code: SharedStoreErrorCode) {
  const error = await pending.then(
    () => new Error(`Expected ${code}`),
    (e: unknown) => e,
  );
  expectError(error, code);
}
const blobOf = (key: string, payload: Uint8Array) => ({ key, digest: hash(payload), size: payload.length });
function attempted(call: Call) {
  const update = call.body.variables?.u?.[0];
  if (!update) throw new Error("Missing ref update");
  return update;
}

class Deadlines {
  handles: { controller: AbortController; disposed: number }[] = [];
  deadline = (ms: number) => {
    expect(ms).toBe(30_000);
    const handle = { controller: new AbortController(), disposed: 0 };
    this.handles.push(handle);
    return { signal: handle.controller.signal, dispose: () => handle.disposed++ };
  };
  expire() {
    const handle = this.handles.at(-1);
    if (!handle) throw new Error("No active deadline");
    handle.controller.abort();
  }
  expectDisposed() {
    for (const handle of this.handles) {
      expect(handle.disposed).toBe(1);
      expect(getEventListeners(handle.controller.signal, "abort")).toHaveLength(0);
    }
  }
}

describe("envelope and authentication", () => {
  test("envelope: empty and binary payloads round-trip with injected fresh nonces", async () => {
    const remote = new Remote();
    const nonces: Buffer[] = [];
    const client = remote.client({
      random: (size) => {
        expect(size).toBe(12);
        const nonce = Buffer.alloc(size, nonces.length + 1);
        nonces.push(nonce);
        return nonce;
      },
    });
    const cases = [
      { key: keyA, payload: new Uint8Array() },
      { key: keyB, payload: Uint8Array.from([0, 255, 128, 10, 13, 1]) },
    ];
    for (const { key, payload } of cases) {
      const outcome = await client.put(runId, role, key.toUpperCase(), payload);
      expect(outcome).toMatchObject({ kind: "applied", blob: blobOf(key, payload) });
      const read = await remote.client().get(runId, role, blobOf(key, payload));
      expect(Buffer.from(read)).toEqual(Buffer.from(payload));
    }
    const frames = remote.calls
      .filter(isPost("git/blobs"))
      .map((c) => Buffer.from(String(c.body.content), "base64"));
    expect(frames).toHaveLength(2);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toEqual(nonces[1]);
    for (const [i, { key, payload }] of cases.entries()) {
      const frame = frames[i] ?? Buffer.alloc(0);
      expect(frame[0]).toBe(1);
      expect(frame.subarray(1, 13).toString("hex")).toBe(nonces[i]?.toString("hex") ?? "");
      const independent = createDecipheriv("aes-256-gcm", dataKey, frame.subarray(1, 13));
      independent.setAAD(Buffer.from(JSON.stringify(["limitless-blob", 1, runId, key, role])));
      independent.setAuthTag(frame.subarray(-16));
      const plaintext = Buffer.concat([independent.update(frame.subarray(13, -16)), independent.final()]);
      expect(plaintext).toEqual(Buffer.from(payload));
    }
  });

  test("envelope: a 10 MiB payload round-trips through wrapped base64", async () => {
    const remote = new Remote();
    const payload = Uint8Array.from({ length: 10 * 1024 * 1024 }, (_, i) => i % 251);
    expect(await remote.client().put(runId, role, keyA, payload)).toMatchObject({ kind: "applied" });
    expect(Buffer.from(await remote.client().get(runId, role, blobOf(keyA, payload)))).toEqual(
      Buffer.from(payload),
    );
  });

  test("envelope: newKey encodes 16 random bytes and randomness failures are configuration errors", () => {
    const remote = new Remote();
    const client = remote.client({
      random: (size) => {
        expect(size).toBe(16);
        return Uint8Array.from({ length: size }, (_, i) => i + 160);
      },
    });
    expect(client.newKey()).toBe("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf");
    throws(() => remote.client({ random: () => new Uint8Array(15) }).newKey(), "configuration");
    const broken = () => {
      throw new Error(token);
    };
    throws(() => remote.client({ random: broken }).newKey(), "configuration");
    expect(remote.calls).toHaveLength(0);
  });

  test("authentication: tampering, another data key and transplanted frames never return plaintext", async () => {
    const remote = new Remote();
    const client = remote.client();
    const payload = bytesOf("authenticated payload");
    const { blob } = await client.put(runId, role, keyA, payload);
    const expected = { key: keyA, digest: blob.digest };
    const sha = remote.retained(runId).get(keyA) ?? "";
    const original = remote.blobs.get(sha) ?? "";
    for (const offset of [1, 13, -1]) {
      const frame = Buffer.from(original, "base64");
      const index = offset < 0 ? frame.length + offset : offset;
      frame[index] = (frame[index] ?? 0) ^ 1;
      remote.blobs.set(sha, frame.toString("base64"));
      await rejects(client.get(runId, role, expected), "corrupt");
    }
    remote.blobs.set(sha, original);
    await rejects(remote.client({ dataKey: new Uint8Array(32) }).get(runId, role, expected), "corrupt");
    await rejects(client.get(runId, "state", expected), "corrupt");
    remote.store(otherRun, [entry(keyA, sha)]);
    await rejects(client.get(otherRun, role, expected), "corrupt");
    remote.store(runId, [entry(keyA, sha), entry(keyB, sha)]);
    await rejects(client.get(runId, role, { key: keyB, digest: blob.digest }), "corrupt");
    expect(Buffer.from(await client.get(runId, role, expected))).toEqual(Buffer.from(payload));
  });

  test("bootstrap: an existing ckpt1 claim pointer reads a manifest without its size", async () => {
    const remote = new Remote();
    const manifest = bytesOf(JSON.stringify({ schema: 1, runId }));
    const { blob } = await remote.client().put(runId, "manifest", keyA, manifest);
    const message = formatRecord({
      kind: "run",
      state: "held",
      generation: 1,
      holder: "m-0123456789abcdef",
      run: runId,
      status: "running",
      checkpoint: `ckpt1:${blob.key}:${blob.digest}`,
    });
    const record = parseRecord(message, `refs/limitless/claims/run-${runId}`);
    if (record === "malformed" || !record.checkpoint) throw new Error("Claim pointer did not parse");
    const [, key = "", digest = ""] = record.checkpoint.split(":");
    const reader = remote.client();
    expect(Buffer.from(await reader.get(runId, "manifest", { key, digest }))).toEqual(Buffer.from(manifest));
    const wrongDigest = { key, digest: hash(bytesOf("other")), size: manifest.length };
    await rejects(reader.get(runId, "manifest", wrongDigest), "corrupt");
    await rejects(reader.get(runId, "manifest", { key, digest, size: manifest.length + 1 }), "corrupt");
  });

  test("entry-time: put and get use snapshots of caller-owned inputs taken before transport", async () => {
    const remote = new Remote();
    const ownedKey = new Uint8Array(dataKey);
    const client = remote.client({ dataKey: ownedKey });
    ownedKey.fill(0);
    const plaintext = bytesOf("entry-time payload");
    const snapshot = Buffer.from(plaintext);
    const writing = hold();
    const started = intercept(remote, isMeta, writing.hook);
    const pending = client.put(runId, role, keyA, plaintext);
    await started;
    plaintext.fill(0);
    writing.release();
    expect(await pending).toMatchObject({ kind: "applied", blob: blobOf(keyA, snapshot) });
    const expected = blobOf(keyA, snapshot);
    const reading = hold();
    const read = intercept(remote, isMeta, reading.hook);
    const result = remote.client().get(runId, role, expected);
    await read;
    Object.assign(expected, { key: keyB, digest: "0".repeat(64), size: 0 });
    reading.release();
    expect(Buffer.from(await result)).toEqual(snapshot);
  });
});

describe("validation and absence", () => {
  test("validation: configuration and inputs are rejected before any request", async () => {
    const remote = new Remote();
    for (const overrides of [
      { repo: "bad" },
      { repo: "a/b/c" },
      { token: "" },
      { token: "  " },
      { dataKey: new Uint8Array(31) },
      { dataKey: new Uint8Array(33) },
    ])
      throws(() => remote.client(overrides), "configuration");
    const client = remote.client();
    const payload = bytesOf("x");
    const digest = hash(payload);
    const invalid = [
      ...["short", "ABC123", "a".repeat(41), `${runId}\n`].map((id) => client.put(id, role, keyA, payload)),
      ...["", "Role", "0tag", "a".repeat(33), "free text", "tag\n"].map((tag) =>
        client.put(runId, tag, keyA, payload),
      ),
      ...["", "a".repeat(31), "g".repeat(32), `${keyA}\n`].map((key) =>
        client.put(runId, role, key, payload),
      ),
      client.put(runId, role, keyA, "text" as unknown as Uint8Array),
      client.get(runId, role, { key: "bad", digest }),
      client.get(runId, role, { key: keyA, digest: "g".repeat(64) }),
      client.get(runId, role, { key: keyA, digest: digest.slice(1) }),
      ...[-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map((size) =>
        client.get(runId, role, { key: keyA, digest, size }),
      ),
      client.get("short", role, { key: keyA, digest }),
      client.get(runId, "Role", { key: keyA, digest }),
    ];
    for (const pending of invalid) await rejects(pending, "invalid");
    expect(remote.calls).toHaveLength(0);
  });

  test("validation: missing ref, entry and blob are absence; failures are never absence", async () => {
    const remote = new Remote();
    const client = remote.client();
    const payload = bytesOf("present");
    const { blob } = await client.put(runId, role, keyA, payload);
    const expected = { key: keyA, digest: blob.digest };
    await rejects(client.get(otherRun, role, expected), "missing");
    await rejects(client.get(runId, role, { key: keyB, digest: blob.digest }), "missing");
    const sha = remote.retained(runId).get(keyA) ?? "";
    const content = remote.blobs.get(sha) ?? "";
    remote.blobs.delete(sha);
    await rejects(client.get(runId, role, expected), "missing");
    remote.blobs.set(sha, content);
    const failures: (() => Response)[] = [
      ...[401, 403, 429, 500].map((status) => () => json({ message: "denied" }, status)),
      () => new Response(null, { status: 302, headers: { Location: "https://example.invalid/" } }),
      () => {
        const response = json({});
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
      () => {
        throw new Error("connection reset");
      },
    ];
    const reads = [isMeta, isRead("git/ref/"), isRead("git/trees/"), isRead("git/blobs/")];
    for (const [i, match] of reads.entries())
      for (const failure of failures) {
        remote.hook = async (call, next) => (match(call) ? failure() : next());
        await rejects(client.get(runId, role, expected), "unavailable");
        const count = remote.calls.length;
        // The idempotent retry of a retained key reads every object a get reads; a blob-read
        // failure follows the observed state, so it is unchanged rather than unconfirmed.
        const observed = i === reads.length - 1;
        expect(await client.put(runId, role, keyA, payload)).toEqual(
          observed
            ? { kind: "unchanged", tip: remote.refs.get(ref(runId)) ?? null, blob: blobOf(keyA, payload) }
            : { kind: "unconfirmed", blob: blobOf(keyA, payload) },
        );
        expect(writes(remote.calls.slice(count))).toEqual([]);
      }
    remote.hook = undefined;
    expect(Buffer.from(await client.get(runId, role, expected))).toEqual(Buffer.from(payload));
  });

  test("validation: malformed responses and frames are corrupt; unknown structures are unsupported", async () => {
    const remote = new Remote();
    const client = remote.client();
    const payload = bytesOf("structure");
    const { blob } = await client.put(runId, role, keyA, payload);
    const expected = { key: keyA, digest: blob.digest };
    const sha = remote.retained(runId).get(keyA) ?? "";
    const tip = remote.refs.get(ref(runId)) ?? "";
    const corruptReads: [(call: Call) => boolean, unknown][] = [
      [isRead("git/ref/"), { ref: ref(runId), object: { sha: "xyz", type: "commit" } }],
      [isRead("git/ref/"), { ref: ref(runId), object: { sha: tip.toUpperCase(), type: "commit" } }],
      [isRead("git/commits/"), { sha: tip, message: "limitless-store: 1" }],
      [isRead("git/trees/"), { sha: "a".repeat(40), truncated: false }],
      [isRead("git/blobs/"), { sha, encoding: "utf-8", content: "x" }],
    ];
    for (const [match, value] of corruptReads) {
      remote.hook = async (call, next) => (match(call) ? json(value) : next());
      await rejects(client.get(runId, role, expected), "corrupt");
    }
    remote.hook = async (call, next) => (isRead("git/ref/")(call) ? new Response("{") : next());
    await rejects(client.get(runId, role, expected), "corrupt");
    remote.hook = undefined;
    const original = remote.blobs.get(sha) ?? "";
    const version = Buffer.from(original, "base64");
    version[0] = 2;
    const frames: [string, SharedStoreErrorCode][] = [
      ["!".repeat(40), "corrupt"],
      [`${original.slice(0, -1)}`, "corrupt"],
      [` ${original}`, "corrupt"],
      [Buffer.alloc(28, 1).toString("base64"), "corrupt"],
      [version.toString("base64"), "unsupported"],
    ];
    for (const [content, code] of frames) {
      remote.blobs.set(sha, content);
      await rejects(client.get(runId, role, expected), code);
    }
    remote.blobs.set(sha, original);
    const objects = (entries: Entry[]) => ({
      path: "objects",
      mode: "040000",
      type: "tree",
      sha: remote.tree(entries),
    });
    const unsupported: (() => void)[] = [
      () => remote.store(runId, [{ ...entry(keyA, sha), mode: "100755" }]),
      () => remote.store(runId, [{ ...entry(keyA, sha), mode: "120000" }]),
      () => remote.store(runId, [{ path: keyA, mode: "160000", type: "commit", sha: tip }]),
      () => remote.store(runId, [entry(keyA.toUpperCase(), sha)]),
      () => remote.store(runId, [entry("README", sha)]),
      () => remote.store(runId, [entry(keyA, sha), entry(keyA, sha)]),
      () => remote.plant(runId, [objects([entry(keyA, sha)]), entry("zz-extra", sha)]),
      () => remote.plant(runId, [{ ...objects([]), mode: "100644", type: "blob", sha }]),
      () => remote.store(runId, [entry(keyA, sha)], "limitless-claim: 1"),
      () => remote.store(runId, [entry(keyA, sha)], "limitless-store: 1\n\n"),
      () => {
        remote.store(runId, [entry(keyA, sha)]);
        remote.hook = async (call, next) => {
          const response = await next();
          if (!isRead("git/trees/")(call)) return response;
          return json({ ...(await response.json()), truncated: true });
        };
      },
    ];
    for (const plant of unsupported) {
      plant();
      await rejects(client.get(runId, role, expected), "unsupported");
      const count = remote.calls.length;
      await rejects(client.put(runId, role, keyB, payload), "unsupported");
      expect(writes(remote.calls.slice(count))).toEqual([]);
      remote.hook = undefined;
    }
    remote.store(runId, [entry(keyA, sha)], "limitless-store: 1\n");
    expect(Buffer.from(await client.get(runId, role, expected))).toEqual(Buffer.from(payload));
  });

  test("validation: repository metadata must be private, matching and readable", async () => {
    const remote = new Remote();
    const client = remote.client();
    const payload = bytesOf("metadata");
    const { blob } = await client.put(runId, role, keyA, payload);
    const expected = { key: keyA, digest: blob.digest };
    for (const metadata of [
      { id: "repository-id", nameWithOwner: "Example/Companion", isPrivate: false },
      { id: "repository-id", nameWithOwner: "other/companion", isPrivate: true },
    ]) {
      remote.metadata = metadata;
      await rejects(client.get(runId, role, expected), "configuration");
      await rejects(client.put(runId, role, keyB, payload), "configuration");
    }
    for (const metadata of [null, {}, { id: "", nameWithOwner: "example/companion", isPrivate: true }]) {
      remote.metadata = metadata;
      await rejects(client.get(runId, role, expected), "unavailable");
      expect(await client.put(runId, role, keyB, payload)).toMatchObject({ kind: "unconfirmed" });
    }
    remote.metadata = { id: "repository-id", nameWithOwner: "example/companion", isPrivate: true };
    for (const failure of [
      json({ data: { repository: remote.metadata }, errors: [{ message: "x" }] }),
      json({ message: "Not Found" }, 404),
    ]) {
      remote.hook = async (call, next) => (isMeta(call) ? failure : next());
      await rejects(client.get(runId, role, expected), "unavailable");
    }
    remote.hook = undefined;
    expect(Buffer.from(await client.get(runId, role, expected))).toEqual(Buffer.from(payload));
  });
});

describe("retention", () => {
  test("retention: an upload stays unreachable and put pending until the conditional CAS applies", async () => {
    const remote = new Remote();
    const client = remote.client();
    const payload = bytesOf("first");
    const cas = hold();
    const started = intercept(remote, isCas, cas.hook);
    const pending = client.put(runId, role, keyA, payload);
    const state = track(pending);
    const update = attempted(await started);
    await flush();
    expect(state.settled).toBe(false);
    const [treeCall] = remote.calls.filter(isPost("git/trees"));
    const [commitCall] = remote.calls.filter(isPost("git/commits"));
    const commit = remote.commits.get(update.afterOid);
    const uploaded = remote.trees.get(remote.trees.get(commit?.tree ?? "")?.[0]?.sha ?? "")?.[0]?.sha ?? "";
    expect(remote.blobs.has(uploaded)).toBe(true);
    expect(remote.refs.has(ref(runId))).toBe(false);
    await rejects(remote.client().get(runId, role, blobOf(keyA, payload)), "missing");
    expect(treeCall?.body).toEqual({ tree: [entry(`objects/${keyA}`, uploaded)] });
    expect(commitCall?.body).toEqual({
      message: "limitless-store: 1",
      tree: commit?.tree,
      parents: [],
      author: synthetic,
      committer: synthetic,
    });
    expect(update).toEqual({ name: ref(runId), beforeOid: zeros, afterOid: update.afterOid, force: false });
    expect((await started).body.variables?.r).toBe("repository-id");
    cas.release();
    expect(await pending).toEqual({ kind: "applied", tip: update.afterOid, blob: blobOf(keyA, payload) });
    expect(remote.retained(runId)).toEqual(new Map([[keyA, uploaded]]));

    const count = remote.calls.length;
    const second = await client.put(runId, role, keyB, bytesOf("second"));
    const calls = remote.calls.slice(count);
    const appended = calls.filter(isPost("git/trees"))[0]?.body;
    expect(appended?.base_tree).toBe(commit?.tree);
    expect(appended?.tree).toEqual([entry(`objects/${keyB}`, remote.retained(runId).get(keyB) ?? "")]);
    expect(calls.filter(isPost("git/commits"))[0]?.body.parents).toEqual([update.afterOid]);
    const append = attempted(calls.filter(isCas)[0] ?? calls[0] ?? (await started));
    expect(append).toMatchObject({ beforeOid: update.afterOid, force: false });
    expect(second).toMatchObject({ kind: "applied", tip: append.afterOid });
    expect([...remote.retained(runId).keys()].sort()).toEqual([keyA, keyB].sort());
  });

  test("immutable: identical retry is applied without writes; conflicting content or role is rejected", async () => {
    const remote = new Remote();
    const client = remote.client();
    const payload = bytesOf("immutable");
    const first = await client.put(runId, role, keyA, payload);
    const tip = remote.refs.get(ref(runId));
    const retained = remote.retained(runId);
    const count = remote.calls.length;
    expect(await remote.client().put(runId, role, keyA.toUpperCase(), payload)).toEqual(first);
    await rejects(client.put(runId, role, keyA, bytesOf("changed")), "conflict");
    await rejects(client.put(runId, "state", keyA, payload), "conflict");
    expect(writes(remote.calls.slice(count))).toEqual([]);
    expect(remote.refs.get(ref(runId))).toBe(tip);
    expect(remote.retained(runId)).toEqual(retained);
    expect(Buffer.from(await client.get(runId, role, first.blob))).toEqual(Buffer.from(payload));
  });
});

describe("concurrency", () => {
  test("mutex: same-run puts serialize while another run proceeds", async () => {
    const remote = new Remote();
    const client = remote.client();
    const cas = hold();
    const started = intercept(remote, isCas, cas.hook);
    const first = client.put(runId, role, keyA, bytesOf("a"));
    await started;
    const count = remote.calls.length;
    const second = client.put(runId, role, keyB, bytesOf("b"));
    const state = track(second);
    expect(await client.put(otherRun, role, keyA, bytesOf("c"))).toMatchObject({ kind: "applied" });
    expect(remote.calls.slice(count).some((c) => c.url.endsWith(ref(runId).slice(5)))).toBe(false);
    expect(state.settled).toBe(false);
    cas.release();
    expect(await first).toMatchObject({ kind: "applied" });
    expect(await second).toMatchObject({ kind: "applied" });
    expect([...remote.retained(runId).keys()].sort()).toEqual([keyA, keyB].sort());
  });

  test("mutex: rejection and cancellation release the queue; a cancelled waiter sends nothing", async () => {
    const remote = new Remote();
    const client = remote.client();
    await client.put(runId, role, keyA, bytesOf("a"));
    const metadata = hold();
    const reached = intercept(remote, isMeta, metadata.hook);
    const conflicting = client.put(runId, role, keyA, bytesOf("changed"));
    await reached;
    const following = client.put(runId, role, keyB, bytesOf("b"));
    metadata.release();
    await rejects(conflicting, "conflict");
    expect(await following).toMatchObject({ kind: "applied" });

    const cas = hold();
    const started = intercept(remote, isCas, cas.hook);
    const head = client.put(runId, role, keyC, bytesOf("c"));
    await started;
    const count = remote.calls.length;
    const controller = new AbortController();
    const queued = client.put(runId, role, "d".repeat(32), bytesOf("d"), controller.signal);
    controller.abort();
    await rejects(queued, "aborted");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    cas.release();
    expect(await head).toMatchObject({ kind: "applied" });
    await flush();
    expect(remote.calls.length).toBe(count);
    expect(await client.put(runId, role, "d".repeat(32), bytesOf("d"))).toMatchObject({ kind: "applied" });
    expect(remote.retained(runId).size).toBe(4);
  });

  test("mutex: a write queued behind a cancelled waiter still waits for the active write", async () => {
    const remote = new Remote();
    const client = remote.client();
    const cas = hold();
    const started = intercept(remote, isCas, cas.hook);
    const head = client.put(runId, role, keyA, bytesOf("a"));
    await started;
    const count = remote.calls.length;
    const controller = new AbortController();
    const cancelled = client.put(runId, role, keyB, bytesOf("b"), controller.signal);
    controller.abort();
    await rejects(cancelled, "aborted");
    const third = client.put(runId, role, keyC, bytesOf("c"));
    const state = track(third);
    await flush();
    expect(remote.calls.length).toBe(count);
    expect(state.settled).toBe(false);
    cas.release();
    expect(await head).toMatchObject({ kind: "applied" });
    expect(await third).toMatchObject({ kind: "applied" });
    expect([...remote.retained(runId).keys()].sort()).toEqual([keyA, keyC].sort());
  });

  async function race(remote: Remote, existing: boolean) {
    if (existing) await remote.client().put(runId, role, keyC, bytesOf("base"));
    const cas = hold();
    const started = intercept(remote, isCas, cas.hook);
    const pending = remote.client().put(runId, role, keyA, bytesOf("a"));
    await started;
    const winner = await remote.client().put(runId, role, keyB, bytesOf("b"));
    cas.release();
    const loser = await pending;
    return {
      winner,
      loser,
      tip: remote.refs.get(ref(runId)),
      keys: [...remote.retained(runId).keys()].sort(),
    };
  }

  test("race: independent clients rely on conditional writes; explicit retry preserves the union", async () => {
    for (const existing of [false, true]) {
      const remote = new Remote();
      const { winner, loser, tip } = await race(remote, existing);
      expect(winner).toMatchObject({ kind: "applied", tip });
      expect(loser).toEqual({ kind: "moved", tip: tip ?? "", blob: blobOf(keyA, bytesOf("a")) });
      expect(await remote.client().put(runId, role, keyA, bytesOf("a"))).toMatchObject({ kind: "applied" });
      const union = existing ? [keyA, keyB, keyC] : [keyA, keyB];
      expect([...remote.retained(runId).keys()].sort()).toEqual(union.sort());
      const reader = remote.client();
      for (const [key, text] of [
        [keyA, "a"],
        [keyB, "b"],
      ] as const)
        expect(Buffer.from(await reader.get(runId, role, blobOf(key, bytesOf(text))))).toEqual(
          Buffer.from(text),
        );

      // Without CAS and fast-forward enforcement the same race silently loses the winner's object.
      const mutant = new Remote();
      mutant.unconditional = true;
      const lost = await race(mutant, existing);
      expect(lost.loser.kind).toBe("applied");
      expect(lost.keys).not.toContain(keyB);
    }
  });
});

describe("ambiguous outcomes and crash recovery", () => {
  type Expect = "attempt" | "old" | "fresh" | null;
  const rejected = () => json({ data: { updateRefs: null }, errors: [{ message: "timeout" }] });
  const rows: {
    name: string;
    existing: boolean;
    cas: (r: Remote, next: () => Promise<Response>) => Promise<Response>;
    kind: RetentionOutcome["kind"];
    tip: Expect;
  }[] = [
    {
      name: "validated mutation response",
      existing: true,
      cas: (_r, next) => next(),
      kind: "applied",
      tip: "attempt",
    },
    {
      name: "lost response, fresh tip is the attempt",
      existing: true,
      cas: async (_r, next) => {
        await next();
        throw new Error("connection reset");
      },
      kind: "applied",
      tip: "attempt",
    },
    {
      name: "HTTP-200 GraphQL errors after the update applied",
      existing: false,
      cas: async (_r, next) => {
        await next();
        return rejected();
      },
      kind: "applied",
      tip: "attempt",
    },
    {
      name: "another tip retains the attempted blob",
      existing: true,
      cas: async (r, next) => {
        await next();
        r.append(runId, keyB);
        throw new Error("connection reset");
      },
      kind: "applied",
      tip: "fresh",
    },
    {
      name: "fresh tip equals the old tip",
      existing: true,
      cas: async () => {
        throw new Error("connection reset");
      },
      kind: "unchanged",
      tip: "old",
    },
    {
      name: "creation remains absent",
      existing: false,
      cas: async () => rejected(),
      kind: "unchanged",
      tip: "old",
    },
    {
      name: "HTTP-200 GraphQL errors beside success-shaped data",
      existing: true,
      cas: async () => json({ data: { updateRefs: { clientMutationId: null } }, errors: [{ message: "x" }] }),
      kind: "unchanged",
      tip: "old",
    },
    {
      name: "unvalidated success shape",
      existing: true,
      cas: async () => json({ data: {} }),
      kind: "unchanged",
      tip: "old",
    },
    {
      name: "another tip lacks the mapping",
      existing: true,
      cas: async (r, next) => {
        r.append(runId, keyB);
        return next();
      },
      kind: "moved",
      tip: "fresh",
    },
    {
      name: "another creator won",
      existing: false,
      cas: async (r, next) => {
        r.append(runId, keyB);
        return next();
      },
      kind: "moved",
      tip: "fresh",
    },
    {
      name: "an existing ref disappeared",
      existing: true,
      cas: async (r) => {
        r.refs.delete(ref(runId));
        return rejected();
      },
      kind: "unconfirmed",
      tip: null,
    },
    {
      name: "reconciliation read fails",
      existing: true,
      cas: async (r) => {
        r.hook = async (call, next) => (isRead("git/ref/")(call) ? json({ message: "x" }, 500) : next());
        return rejected();
      },
      kind: "unconfirmed",
      tip: null,
    },
    {
      name: "reconciliation observes a malformed store",
      existing: true,
      cas: async (r) => {
        r.store(runId, [entry("README", r.blob("eA=="))]);
        return rejected();
      },
      kind: "unconfirmed",
      tip: null,
    },
  ];
  for (const row of rows)
    test(`ambiguous: ${row.name} is ${row.kind}`, async () => {
      const remote = new Remote();
      if (row.existing) await remote.client().put(runId, role, keyC, bytesOf("base"));
      const old = remote.refs.get(ref(runId)) ?? null;
      const started = intercept(remote, isCas, (_call, next) => row.cas(remote, next));
      const payload = bytesOf("ambiguous");
      const count = remote.calls.length;
      const outcome = await remote.client().put(runId, role, keyA, payload);
      const attempt = attempted(await started).afterOid;
      const fresh = remote.refs.get(ref(runId)) ?? null;
      const tip = { attempt, old, fresh, null: null }[row.tip ?? "null"];
      expect(outcome as unknown).toEqual({
        kind: row.kind,
        ...(row.kind === "unconfirmed" ? {} : { tip }),
        blob: blobOf(keyA, payload),
      });
      expect(remote.calls.slice(count).filter(isCas)).toHaveLength(1);
      remote.hook = undefined;
      if (row.kind === "applied")
        expect(Buffer.from(await remote.client().get(runId, role, outcome.blob))).toEqual(
          Buffer.from(payload),
        );
    });

  test("ambiguous: a CAS applying after reconciliation saw the old tip loses nothing on retry", async () => {
    for (const racing of [false, true]) {
      const remote = new Remote();
      const client = remote.client();
      await client.put(runId, role, keyC, bytesOf("base"));
      const old = remote.refs.get(ref(runId));
      const late = deferred<() => Promise<Response>>();
      intercept(remote, isCas, async (_call, next) => {
        late.resolve(next);
        return json({ errors: [{ message: "timeout" }] });
      });
      const payload = bytesOf("late");
      expect(await client.put(runId, role, keyA, payload)).toEqual({
        kind: "unchanged",
        tip: old ?? null,
        blob: blobOf(keyA, payload),
      });
      const apply = await late.promise;
      if (racing) {
        const cas = hold();
        const started = intercept(remote, isCas, cas.hook);
        const retry = client.put(runId, role, keyA, payload);
        await started;
        await apply();
        cas.release();
        expect(await retry).toMatchObject({ kind: "moved", tip: remote.refs.get(ref(runId)) });
      } else await apply();
      const count = remote.calls.length;
      expect(await client.put(runId, role, keyA, payload)).toMatchObject({
        kind: "applied",
        tip: remote.refs.get(ref(runId)),
      });
      expect(writes(remote.calls.slice(count))).toEqual([]);
      expect([...remote.retained(runId).keys()].sort()).toEqual([keyA, keyC].sort());
      expect(Buffer.from(await client.get(runId, role, blobOf(keyA, payload)))).toEqual(Buffer.from(payload));
      expect(Buffer.from(await client.get(runId, role, blobOf(keyC, bytesOf("base"))))).toEqual(
        Buffer.from("base"),
      );
    }
  });

  test("crash: recreated clients read only retained objects and recover idempotently", async () => {
    for (const boundary of ["git/blobs", "git/commits", "cas"] as const) {
      const remote = new Remote();
      const crashed = new AbortController();
      const reached = intercept(
        remote,
        boundary === "cas" ? isCas : isPost(boundary),
        async (_call, next) => {
          await next();
          return never();
        },
      );
      const payload = bytesOf("crash");
      const abandoned = remote
        .client()
        .put(runId, role, keyA, payload, crashed.signal)
        .catch(() => null);
      await reached;
      await flush();
      const recovered = remote.client();
      const count = remote.calls.length;
      if (boundary === "cas") {
        expect(Buffer.from(await recovered.get(runId, role, blobOf(keyA, payload)))).toEqual(
          Buffer.from(payload),
        );
        expect(await recovered.put(runId, role, keyA, payload)).toMatchObject({
          kind: "applied",
          tip: remote.refs.get(ref(runId)),
        });
        expect(writes(remote.calls.slice(count))).toEqual([]);
      } else {
        const unattached = [...remote.blobs.keys()];
        expect(unattached).toHaveLength(1);
        await rejects(recovered.get(runId, role, blobOf(keyA, payload)), "missing");
        expect(await recovered.put(runId, role, keyA, payload)).toMatchObject({ kind: "applied" });
        expect(unattached).not.toContain(remote.retained(runId).get(keyA));
      }
      crashed.abort();
      await abandoned;
    }
  });
});

describe("cancellation and deadlines", () => {
  test("cancellation: get abort takes precedence over validation after its complete body", async () => {
    const remote = new Remote();
    const payload = bytesOf("cancelled read");
    const { blob } = await remote.client().put(runId, role, keyA, payload);
    const sha = remote.retained(runId).get(keyA) ?? "";
    const frame = Buffer.from(remote.blobs.get(sha) ?? "", "base64");
    frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 1;
    remote.blobs.set(sha, frame.toString("base64"));
    const controller = new AbortController();
    let readingBlob = false;
    intercept(remote, isRead("git/blobs/"), async (_call, next) => {
      readingBlob = true;
      return next();
    });
    const client = remote.client({
      deadline: () => ({
        signal: new AbortController().signal,
        // Disposal marks complete body consumption, before get validates the envelope.
        dispose: () => readingBlob && controller.abort(),
      }),
    });
    await rejects(client.get(runId, role, blob, controller.signal), "aborted");
  });

  for (const stage of ["metadata", "upload", "commit", "the gap before CAS"] as const)
    test(`cancellation: abort during ${stage} rejects aborted without a ref mutation`, async () => {
      const remote = new Remote();
      await remote.client().put(runId, role, keyC, bytesOf("base"));
      const tip = remote.refs.get(ref(runId));
      const controller = new AbortController();
      const match = {
        metadata: isMeta,
        upload: isPost("git/blobs"),
        commit: isPost("git/commits"),
        "the gap before CAS": isPost("git/commits"),
      };
      let delivered = false;
      const reached = intercept(remote, match[stage], async (_call, next) => {
        if (stage !== "the gap before CAS") return never();
        delivered = true;
        return next();
      });
      // The commit request's deadline is disposed after its response is complete, before CAS dispatch.
      const deadline = () => ({
        signal: new AbortController().signal,
        dispose: () => delivered && controller.abort(),
      });
      const count = remote.calls.length;
      const pending = remote.client({ deadline }).put(runId, role, keyA, bytesOf("a"), controller.signal);
      await reached;
      if (stage !== "the gap before CAS") controller.abort();
      await rejects(pending, "aborted");
      expect(remote.calls.slice(count).filter(isCas)).toEqual([]);
      expect(remote.refs.get(ref(runId))).toBe(tip);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    });

  for (const phase of ["headers", "body"] as const)
    test(`cancellation: abort after CAS dispatch during ${phase} is unconfirmed without reconciliation`, async () => {
      const remote = new Remote();
      const controller = new AbortController();
      const body = stalledBody();
      const reached = intercept(remote, isCas, async (_call, next) => {
        await next();
        return phase === "headers" ? never() : body.response;
      });
      const payload = bytesOf("after dispatch");
      const pending = remote.client().put(runId, role, keyA, payload, controller.signal);
      await reached;
      if (phase === "body") await body.reading;
      const count = remote.calls.length;
      controller.abort();
      expect(await pending).toEqual({ kind: "unconfirmed", blob: blobOf(keyA, payload) });
      await flush();
      expect(remote.calls.length).toBe(count);
      const recovered = await remote.client().put(runId, role, keyA, payload, new AbortController().signal);
      expect(recovered).toMatchObject({ kind: "applied", tip: remote.refs.get(ref(runId)) });
    });

  for (const boundary of ["validated response", "reconciliation"] as const)
    test(`cancellation: abort while confirming the ${boundary} is unconfirmed`, async () => {
      const remote = new Remote();
      const controller = new AbortController();
      intercept(remote, isCas, async (_call, next) => {
        const response = await next();
        if (boundary === "validated response") return response;
        throw new Error("connection reset");
      });
      // Abort as the request that would confirm the outcome disposes its deadline, after its complete body.
      const casAt = () => remote.calls.findIndex(isCas);
      const confirming = () =>
        casAt() >= 0 &&
        (boundary === "validated response" ||
          remote.calls.slice(casAt()).filter(isRead("git/trees/")).length === 2);
      const deadline = () => ({
        signal: new AbortController().signal,
        dispose: () => confirming() && controller.abort(),
      });
      const payload = bytesOf("confirming");
      const pending = remote.client({ deadline }).put(runId, role, keyA, payload, controller.signal);
      expect(await pending).toEqual({ kind: "unconfirmed", blob: blobOf(keyA, payload) });
      expect(controller.signal.aborted).toBe(true);
      const after = remote.calls.slice(casAt() + 1);
      expect(after).toHaveLength(boundary === "validated response" ? 0 : 4);
      expect(remote.retained(runId).has(keyA)).toBe(true);
      const recovered = await remote.client().put(runId, role, keyA, payload, new AbortController().signal);
      expect(recovered).toMatchObject({ kind: "applied", tip: remote.refs.get(ref(runId)) });
    });

  const deadlineRows = [
    { name: "initial ref read", match: isRead("git/ref/"), apply: false, kind: "unconfirmed" },
    { name: "upload", match: isPost("git/blobs"), apply: false, kind: "unchanged" },
    { name: "unapplied CAS", match: isCas, apply: false, kind: "unchanged" },
    { name: "applied CAS", match: isCas, apply: true, kind: "applied" },
  ] as const;
  for (const row of deadlineRows)
    for (const phase of ["headers", "body"] as const)
      test(`deadline: ${row.name} stalled in ${phase} is ${row.kind}`, async () => {
        const remote = new Remote();
        await remote.client().put(runId, role, keyC, bytesOf("base"));
        const old = remote.refs.get(ref(runId)) ?? null;
        const deadlines = new Deadlines();
        const body = stalledBody();
        const reached = intercept(remote, row.match, async (_call, next) => {
          if (row.apply) await next();
          return phase === "headers" ? never() : body.response;
        });
        const payload = bytesOf("deadline");
        const pending = remote.client({ deadline: deadlines.deadline }).put(runId, role, keyA, payload);
        const stalled = await reached;
        if (phase === "body") await body.reading;
        deadlines.expire();
        const outcome = await pending;
        const tip = row.kind === "applied" ? remote.refs.get(ref(runId)) : old;
        expect(outcome as unknown).toEqual({
          kind: row.kind,
          ...(row.kind === "unconfirmed" ? {} : { tip }),
          blob: blobOf(keyA, payload),
        });
        const after = remote.calls.slice(remote.calls.indexOf(stalled) + 1);
        expect(after.some(isRead("git/ref/"))).toBe(row.match === isCas);
        expect(writes(after)).toEqual([]);
        deadlines.expectDisposed();
      });

  for (const failure of ["HTTP 503", "headers", "body"] as const)
    test(`deadline: a retained-object read failing by ${failure} after observed state is unchanged`, async () => {
      const remote = new Remote();
      const payload = bytesOf("retained");
      await remote.client().put(runId, role, keyA, payload);
      const tip = remote.refs.get(ref(runId)) ?? null;
      const deadlines = new Deadlines();
      const body = stalledBody();
      const reached = intercept(remote, isRead("git/blobs/"), async () => {
        if (failure === "HTTP 503") return json({ message: "unavailable" }, 503);
        return failure === "headers" ? never() : body.response;
      });
      const pending = remote.client({ deadline: deadlines.deadline }).put(runId, role, keyA, payload);
      const stalled = await reached;
      if (failure === "body") await body.reading;
      if (failure !== "HTTP 503") deadlines.expire();
      expect(await pending).toEqual({ kind: "unchanged", tip, blob: blobOf(keyA, payload) });
      expect(remote.calls.slice(remote.calls.indexOf(stalled) + 1)).toEqual([]);
      deadlines.expectDisposed();
    });

  test("deadline: failed reconciliation after a CAS timeout is unconfirmed; timed-out get is unavailable", async () => {
    const remote = new Remote();
    const deadlines = new Deadlines();
    const client = remote.client({ deadline: deadlines.deadline });
    const cas = intercept(remote, isCas, async () => never());
    const reconciliation = intercept(remote, (c) => isRead("git/ref/")(c) && remote.calls.some(isCas), never);
    const payload = bytesOf("deadline");
    const pending = client.put(runId, role, keyA, payload);
    await cas;
    deadlines.expire();
    await reconciliation;
    deadlines.expire();
    expect(await pending).toEqual({ kind: "unconfirmed", blob: blobOf(keyA, payload) });
    remote.hook = undefined;
    expect(await client.put(runId, role, keyA, payload)).toMatchObject({ kind: "applied" });
    const read = intercept(remote, isRead("git/blobs/"), never);
    const reading = client.get(runId, role, blobOf(keyA, payload));
    await read;
    deadlines.expire();
    await rejects(reading, "unavailable");
    deadlines.expectDisposed();
  });

  test("deadline: an already expired deadline never dispatches and is still disposed", async () => {
    const remote = new Remote();
    const deadlines = new Deadlines();
    const deadline = (ms: number) => {
      const handle = deadlines.deadline(ms);
      deadlines.expire();
      return handle;
    };
    const client = remote.client({ deadline });
    const payload = bytesOf("expired");
    await rejects(client.get(runId, role, blobOf(keyA, payload)), "unavailable");
    expect(await client.put(runId, role, keyA, payload)).toEqual({
      kind: "unconfirmed",
      blob: blobOf(keyA, payload),
    });
    expect(remote.calls).toHaveLength(0);
    deadlines.expectDisposed();
  });

  test("deadline: the default timer gives each request 30 seconds and clears it", async () => {
    const remote = new Remote();
    const timers = spyOn(globalThis, "setTimeout");
    const clears = spyOn(globalThis, "clearTimeout");
    try {
      await remote.client().put(runId, role, keyA, bytesOf("timer"));
      const ours = timers.mock.calls.flatMap((call, i) =>
        call[1] === 30_000 ? [timers.mock.results[i]?.value] : [],
      );
      expect(ours).toHaveLength(remote.calls.length);
      for (const id of ours) expect(clears).toHaveBeenCalledWith(id);
    } finally {
      timers.mockRestore();
      clears.mockRestore();
    }
  });
});

describe("privacy and inert construction", () => {
  test("privacy: only the companion credential and encrypted payloads reach the wire", async () => {
    const remote = new Remote();
    const client = remote.client();
    const probeRole = "probe-private-role";
    const payload = Buffer.from("private checkpoint probe\0with binary data");
    const outcome = await client.put(runId, probeRole, keyA, payload);
    const count = remote.calls.length;
    const reader = remote.client();
    const expected = blobOf(keyA, payload);
    expect(Buffer.from(await reader.get(runId, probeRole, expected))).toEqual(payload);
    expect(remote.calls.length).toBeGreaterThan(count);
    for (const call of remote.calls) {
      expect(call.init.headers).toEqual({
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      });
      expect(call.init.redirect).toBe("manual");
      const wire = JSON.stringify({ url: call.url, body: call.init.body });
      for (const secret of [
        "private checkpoint probe",
        payload.toString("base64"),
        payload.toString("hex"),
        probeRole,
        outcome.blob.digest,
        Buffer.from(dataKey).toString("hex"),
        Buffer.from(dataKey).toString("base64"),
      ])
        expect(wire).not.toContain(secret);
    }
    const sha = remote.retained(runId).get(keyA) ?? "";
    remote.blobs.set(sha, Buffer.alloc(40, 1).toString("base64"));
    await rejects(reader.get(runId, probeRole, expected), "corrupt");
    remote.blobs.delete(sha);
    await rejects(reader.get(runId, probeRole, expected), "missing");
    for (const status of [401, 403, 500]) {
      remote.hook = async () => json({ message: `${token} ${payload.toString()}` }, status);
      const error = await reader.get(runId, probeRole, expected).catch((e: unknown) => e);
      expectError(error, "unavailable");
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(token);
      const put = await client.put(runId, probeRole, keyB, payload);
      expect(JSON.stringify(put)).not.toContain(token);
    }
  });

  test("inert construction and delayed completion: no IO, no wall clock and no early acknowledgement", async () => {
    const remote = new Remote();
    const deadlines = new Deadlines();
    const clock = spyOn(Date, "now").mockImplementation(() => {
      throw new Error("No wall clock");
    });
    try {
      const client = remote.client({ deadline: deadlines.deadline });
      expect(remote.calls).toHaveLength(0);
      expect(deadlines.handles).toHaveLength(0);
      const cas = hold();
      const started = intercept(remote, isCas, cas.hook);
      const payload = bytesOf("delayed");
      const pending = client.put(runId, role, keyA, payload);
      const state = track(pending);
      await started;
      await flush();
      expect(state.settled).toBe(false);
      expect(deadlines.handles.at(-1)?.disposed).toBe(0);
      cas.release();
      expect(await pending).toMatchObject({ kind: "applied", tip: remote.refs.get(ref(runId)) });
      expect(Buffer.from(await client.get(runId, role, blobOf(keyA, payload)))).toEqual(Buffer.from(payload));
      for (const call of remote.calls.filter(isPost("git/commits")))
        expect(String(call.init.body)).not.toMatch(/date/i);
      deadlines.expectDisposed();
    } finally {
      clock.mockRestore();
    }
  });
});
