import { describe, expect, spyOn, test } from "bun:test";
import { createDecipheriv, createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import {
  createSharedStoreIO,
  type SharedStoreDeps,
  SharedStoreError,
  type SharedStoreErrorCode,
} from "../src/integrations/shared-store-io.ts";

const runId = "abc123";
const role = "manifest";
const objectKey = "abcdef0123456789".repeat(2);
const dataKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const token = "companion-credential-for-offline-test";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const deferred = <T>() => Promise.withResolvers<T>();
type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

class Remote {
  calls: Call[] = [];
  blobs = new Map<string, string>();
  metadata: unknown = { id: "repository-id", nameWithOwner: "Example/Companion", isPrivate: true };
  hook?: (call: Call) => Promise<Response | undefined>;
  request = async (url: string, init: RequestInit): Promise<Response> => {
    const body = init.body === undefined ? {} : JSON.parse(String(init.body));
    const call: Call = { url, init, body };
    this.calls.push(call);
    const hooked = await this.hook?.(call);
    if (hooked) return hooked;
    if (url === "https://api.github.com/graphql" && String(body.query).startsWith("query("))
      return json({ data: { repository: this.metadata } });
    const prefix = "https://api.github.com/repos/example/companion/git/blobs";
    if (url === prefix && init.method === "POST") {
      expect(body.encoding).toBe("base64");
      expect(typeof body.content).toBe("string");
      const content = String(body.content);
      const sha = createHash("sha1").update(Buffer.from(content, "base64")).digest("hex");
      this.blobs.set(sha, content);
      return json({ sha });
    }
    if (url.startsWith(`${prefix}/`) && init.method === "GET") {
      const content = this.blobs.get(url.slice(prefix.length + 1));
      return content === undefined ? json({}, 404) : json({ encoding: "base64", content });
    }
    throw new Error("Unexpected offline endpoint");
  };
  client(overrides: Partial<SharedStoreDeps> = {}) {
    return createSharedStoreIO({
      repo: "Example/Companion",
      token,
      dataKey,
      request: this.request,
      ...overrides,
    });
  }
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

function code(action: () => unknown, expected: SharedStoreErrorCode) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SharedStoreError);
    expect(error).toMatchObject({ code: expected, message: `Shared store error: ${expected}` });
    expect(error).not.toHaveProperty("cause");
    return;
  }
  throw new Error(`Expected ${expected}`);
}
async function rejects(pending: Promise<unknown>, expected: SharedStoreErrorCode) {
  await expect(pending).rejects.toBeInstanceOf(SharedStoreError);
  await expect(pending).rejects.toMatchObject({ code: expected, message: `Shared store error: ${expected}` });
  await expect(pending).rejects.not.toHaveProperty("cause");
}

function stalledBody() {
  const reading = deferred<void>();
  const complete = deferred<string>();
  const response = json({});
  response.text = () => {
    reading.resolve();
    return complete.promise;
  };
  return { response, reading: reading.promise, complete };
}

function captured(remote: Remote, hook: (call: Call) => Promise<Response | undefined>) {
  const started = deferred<Call>();
  remote.hook = (call) => {
    started.resolve(call);
    return hook(call);
  };
  return started.promise;
}

describe("C02a envelope primitives", () => {
  test("envelope: empty and binary payloads use injected fresh nonces and independent decryption", () => {
    const remote = new Remote();
    let draw = 0;
    const nonces: Buffer[] = [];
    const client = remote.client({
      random: (size) => {
        expect(size).toBe(12);
        const nonce = Buffer.alloc(size, ++draw);
        nonces.push(nonce);
        return nonce;
      },
    });
    for (const payload of [new Uint8Array(), Uint8Array.from([0, 255, 128, 10, 13, 1])]) {
      const sealed = client.seal(runId, role, objectKey.toUpperCase(), payload);
      expect(sealed.blob).toEqual({ key: objectKey, digest: hash(payload), size: payload.length });
      const frame = Buffer.from(sealed.content, "base64");
      expect(frame[0]).toBe(1);
      const nonce = nonces.at(-1);
      if (!nonce) throw new Error("Missing nonce draw");
      expect(frame.subarray(1, 13).toString("hex")).toBe(nonce.toString("hex"));
      const independent = createDecipheriv("aes-256-gcm", dataKey, frame.subarray(1, 13));
      independent.setAAD(Buffer.from(JSON.stringify(["limitless-blob", 1, runId, objectKey, role])));
      independent.setAuthTag(frame.subarray(-16));
      expect(Buffer.concat([independent.update(frame.subarray(13, -16)), independent.final()])).toEqual(
        Buffer.from(payload),
      );
      const wrapped = sealed.content.match(/.{1,12}/g)?.join("\r\n") ?? "";
      expect(client.open(runId, role, sealed.blob, wrapped)).toEqual(Buffer.from(payload));
    }
    expect(nonces[0]).not.toEqual(nonces[1]);
    expect(remote.calls).toHaveLength(0);
  });

  test("envelope: newKey draws exactly 16 bytes, validates randomness and has no IO", () => {
    const remote = new Remote();
    const client = remote.client({
      random: (size) => {
        expect(size).toBe(16);
        return Uint8Array.from({ length: size }, (_, i) => i + 160);
      },
    });
    expect(client.newKey()).toBe("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf");
    code(() => remote.client({ random: () => new Uint8Array(11) }).newKey(), "configuration");
    code(
      () => remote.client({ random: () => new Uint8Array(11) }).seal(runId, role, objectKey, dataKey),
      "configuration",
    );
    code(
      () =>
        remote
          .client({
            random: () => {
              throw new Error(token);
            },
          })
          .newKey(),
      "configuration",
    );
    expect(remote.calls).toHaveLength(0);
  });

  test("authentication: ciphertext, tag, key, run, object key and role are authenticated", () => {
    const remote = new Remote();
    const client = remote.client();
    const sealed = client.seal(runId, role, objectKey, Uint8Array.from([1, 2, 3]));
    for (const offset of [1, 13, -1]) {
      const frame = Buffer.from(sealed.content, "base64");
      const index = offset < 0 ? frame.length + offset : offset;
      frame[index] = (frame[index] ?? 0) ^ 1;
      code(() => client.open(runId, role, sealed.blob, frame.toString("base64")), "corrupt");
    }
    code(
      () => remote.client({ dataKey: new Uint8Array(32) }).open(runId, role, sealed.blob, sealed.content),
      "corrupt",
    );
    code(() => client.open("xyz789", role, sealed.blob, sealed.content), "corrupt");
    code(() => client.open(runId, "state", sealed.blob, sealed.content), "corrupt");
    code(() => client.open(runId, role, { ...sealed.blob, key: "a".repeat(32) }, sealed.content), "corrupt");
  });

  test("bootstrap: key/digest claim pointer needs no size; digest and size checks are independent", () => {
    const client = new Remote().client();
    const payload = Buffer.from(JSON.stringify({ schema: 1, runId }));
    const sealed = client.seal(runId, role, objectKey, payload);
    const pointer = `ckpt1:${objectKey}:${hash(payload)}`;
    const [, key = "", digest = ""] = pointer.split(":");
    expect(
      client.open(runId, role, { key: key.toUpperCase(), digest: digest.toUpperCase() }, sealed.content),
    ).toEqual(payload);
    code(
      () => client.open(runId, role, { ...sealed.blob, digest: "0".repeat(64) }, sealed.content),
      "corrupt",
    );
    code(
      () => client.open(runId, role, { ...sealed.blob, size: payload.length + 1 }, sealed.content),
      "corrupt",
    );
  });

  test("entry-time: construction copies data key and synchronous sealing owns its plaintext", () => {
    const original = new Uint8Array(dataKey);
    const remote = new Remote();
    const client = remote.client({ dataKey: original });
    original.fill(0);
    const plaintext = Buffer.from("entry-time payload");
    const snapshot = Buffer.from(plaintext);
    const sealed = client.seal(runId, role, objectKey, plaintext);
    plaintext.fill(0);
    expect(sealed.blob.digest).toBe(hash(snapshot));
    expect(remote.client().open(runId, role, sealed.blob, sealed.content)).toEqual(snapshot);
    expect(remote.calls).toHaveLength(0);
  });

  test("validation: configuration, contexts and descriptors fail synchronously with no requests", () => {
    const remote = new Remote();
    for (const configuration of [
      { repo: "bad" },
      { repo: "a/b/c" },
      { repo: "a/../b" },
      { token: "" },
      { token: "  " },
      { dataKey: new Uint8Array(31) },
      { dataKey: new Uint8Array(33) },
    ])
      code(() => remote.client(configuration), "configuration");
    const client = remote.client();
    for (const id of ["short", "ABC123", "a".repeat(41), "abc123\n"])
      code(() => client.seal(id, role, objectKey, dataKey), "invalid");
    for (const tag of ["", "Role", "0tag", "a".repeat(33), "free text", "tag\n"])
      code(() => client.seal(runId, tag, objectKey, dataKey), "invalid");
    for (const key of ["", "a".repeat(31), "g".repeat(32), `${objectKey}\n`])
      code(() => client.seal(runId, role, key, dataKey), "invalid");
    for (const descriptor of [
      { key: "bad", digest: "0".repeat(64) },
      { key: objectKey, digest: "g".repeat(64) },
      ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((size) => ({
        key: objectKey,
        digest: "0".repeat(64),
        size,
      })),
    ])
      code(() => client.open(runId, role, descriptor, ""), "invalid");
    expect(remote.calls).toHaveLength(0);
  });

  test("validation: strict base64, truncated frames and unsupported versions", () => {
    const client = new Remote().client();
    const sealed = client.seal(runId, role, objectKey, new Uint8Array());
    for (const content of [
      "",
      "!".repeat(40),
      "YQ=",
      "YQ===",
      ` ${sealed.content}`,
      `${sealed.content}\t`,
      Buffer.alloc(28).toString("base64"),
    ])
      code(() => client.open(runId, role, sealed.blob, content), "corrupt");
    const noncanonical = `${sealed.content.slice(0, -2)}B=`;
    code(() => client.open(runId, role, sealed.blob, noncanonical), "corrupt");
    const frame = Buffer.from(sealed.content, "base64");
    frame[0] = 2;
    code(() => client.open(runId, role, sealed.blob, frame.toString("base64")), "unsupported");
  });
});

describe("C02a companion transport primitives", () => {
  test("deadline: the default timer has a 30-second budget and is cleared after completion", async () => {
    const timers = spyOn(globalThis, "setTimeout");
    const clears = spyOn(globalThis, "clearTimeout");
    try {
      expect(await new Remote().client().repository()).toBe("repository-id");
      expect(timers).toHaveBeenCalledTimes(1);
      expect(timers.mock.calls[0]?.[1]).toBe(30_000);
      expect(clears).toHaveBeenCalledWith(timers.mock.results[0]?.value);
    } finally {
      timers.mockRestore();
      clears.mockRestore();
    }
  });

  test("validation: inert construction, canonical private metadata and matching repository ID", async () => {
    const remote = new Remote();
    const client = remote.client();
    expect(client.repo).toBe("example/companion");
    expect(remote.calls).toHaveLength(0);
    expect(await client.repository()).toBe("repository-id");
    expect(remote.calls[0]?.body.variables).toEqual({ owner: "example", name: "companion" });
    for (const metadata of [
      null,
      {},
      { id: "", nameWithOwner: "example/companion", isPrivate: true },
      { id: "id", nameWithOwner: "example/companion", isPrivate: false },
      { id: "id", nameWithOwner: "other/companion", isPrivate: true },
    ]) {
      remote.metadata = metadata;
      await rejects(client.repository(), "unavailable");
    }
  });

  test("validation: exact REST absence differs from authorization, rate limits and unreadable objects", async () => {
    const remote = new Remote();
    const client = remote.client();
    remote.hook = async () => json({}, 404);
    await rejects(client.rest(`git/ref/limitless/store/${runId}`), "missing");
    await rejects(client.rest(`git/blobs/${"a".repeat(40)}`), "missing");
    await rejects(client.rest(`git/trees/${"a".repeat(40)}`), "unavailable");
    await rejects(client.rest("git/blobs", { encoding: "base64", content: "" }), "unavailable");
    await rejects(client.repository(), "unavailable");
    for (const status of [301, 302, 307, 401, 403, 429, 500]) {
      remote.hook = async () => json({ message: token }, status);
      await rejects(client.rest(`git/ref/limitless/store/${runId}`), "unavailable");
    }
    remote.hook = async () => {
      const response = json({});
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    };
    await rejects(client.repository(), "unavailable");
    remote.hook = async () => {
      throw new Error(token);
    };
    await rejects(client.rest(`git/ref/limitless/store/${runId}`), "unavailable");
  });

  test("validation: endpoints cannot escape the repository or perform REST ref mutations", () => {
    const remote = new Remote();
    const client = remote.client();
    for (const path of [
      "https://example.com",
      "../other/git/blobs",
      "git/blobs?x=1",
      "git/blobs/../../x",
      `git/blobs/${"g".repeat(40)}`,
      "git/refs/heads/main",
    ])
      code(() => client.rest(path), "invalid");
    code(() => client.rest(`git/ref/limitless/store/${runId}`, { sha: "a".repeat(40) }), "invalid");
    expect(remote.calls).toHaveLength(0);
  });

  test("validation: malformed JSON and HTTP-200 GraphQL errors fail without automatic retries", async () => {
    const remote = new Remote();
    const client = remote.client();
    remote.hook = async () => new Response("{");
    await rejects(client.repository(), "corrupt");
    remote.hook = async () =>
      json({ data: { updateRefs: { clientMutationId: null } }, errors: [{ message: token }] });
    await rejects(client.graphql("mutation{updateRefs{clientMutationId}}", {}), "unavailable");
    expect(remote.calls).toHaveLength(2);
  });

  for (const phase of ["headers", "body"] as const) {
    test(`deadline: covers ${phase}, settles without cooperative transport and disposes listeners`, async () => {
      const remote = new Remote();
      const deadlines = new Deadlines();
      const headers = deferred<Response>();
      const body = stalledBody();
      const started = captured(remote, () =>
        phase === "headers" ? headers.promise : Promise.resolve(body.response),
      );
      const client = remote.client({ deadline: deadlines.deadline });
      const pending = client.repository();
      await started;
      if (phase === "body") await body.reading;
      deadlines.expire();
      await rejects(pending, "unavailable");
      expect(remote.calls).toHaveLength(1);
      deadlines.expectDisposed();
      headers.resolve(json({}));
      body.complete.resolve("{}");
      remote.hook = undefined;
      expect(await client.repository()).toBe("repository-id");
      expect(deadlines.handles).toHaveLength(2);
      deadlines.expectDisposed();
    });

    test(`cancellation: caller abort during ${phase} takes precedence and sends no later requests`, async () => {
      const remote = new Remote();
      const deadlines = new Deadlines();
      const controller = new AbortController();
      const headers = deferred<Response>();
      const body = stalledBody();
      const started = captured(remote, () =>
        phase === "headers" ? headers.promise : Promise.resolve(body.response),
      );
      const client = remote.client({ deadline: deadlines.deadline });
      const pending = client.repository(controller.signal);
      await started;
      if (phase === "body") await body.reading;
      controller.abort(new Error(token));
      deadlines.expire();
      await rejects(pending, "aborted");
      expect(remote.calls).toHaveLength(1);
      deadlines.expectDisposed();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      headers.resolve(json({}));
      body.complete.resolve("{}");
    });
  }

  test("deadline: writes time out during headers and body without being resent", async () => {
    for (const phase of ["headers", "body"] as const) {
      const remote = new Remote();
      const deadlines = new Deadlines();
      const headers = deferred<Response>();
      const body = stalledBody();
      const started = captured(remote, () =>
        phase === "headers" ? headers.promise : Promise.resolve(body.response),
      );
      const client = remote.client({ deadline: deadlines.deadline });
      const pending = client.graphql("mutation{updateRefs{clientMutationId}}", { r: "repository-id" });
      await started;
      if (phase === "body") await body.reading;
      deadlines.expire();
      await rejects(pending, "unavailable");
      expect(remote.calls).toHaveLength(1);
      deadlines.expectDisposed();
      headers.resolve(json({}));
      body.complete.resolve("{}");
    }
  });

  test("deadline: already expired signal never dispatches and still disposes its handle", async () => {
    const remote = new Remote();
    const deadlines = new Deadlines();
    const client = remote.client({
      deadline: (ms) => {
        const handle = deadlines.deadline(ms);
        deadlines.expire();
        return handle;
      },
    });
    await rejects(client.repository(), "unavailable");
    expect(remote.calls).toHaveLength(0);
    deadlines.expectDisposed();
  });

  test("cancellation: already aborted callers allocate no deadline or request", async () => {
    const remote = new Remote();
    const deadlines = new Deadlines();
    const controller = new AbortController();
    controller.abort();
    await rejects(remote.client({ deadline: deadlines.deadline }).repository(controller.signal), "aborted");
    expect(remote.calls).toHaveLength(0);
    expect(deadlines.handles).toHaveLength(0);
  });

  test("deadline: body transport rejection is unavailable, malformed consumed JSON is corrupt", async () => {
    const remote = new Remote();
    const deadlines = new Deadlines();
    const response = json({});
    response.text = () => Promise.reject(new Error(token));
    remote.hook = async () => response;
    await rejects(remote.client({ deadline: deadlines.deadline }).repository(), "unavailable");
    deadlines.expectDisposed();
    await rejects(
      remote
        .client({
          deadline: () => {
            throw new Error(token);
          },
        })
        .repository(),
      "unavailable",
    );
  });

  test("entry-time: request body is serialized before waiting for transport", async () => {
    const remote = new Remote();
    const headers = deferred<Response>();
    const started = captured(remote, () => headers.promise);
    const input = { tree: [{ path: `objects/${objectKey}`, sha: "a".repeat(40) }] };
    const pending = remote.client().rest("git/trees", input);
    await started;
    input.tree[0] = { path: "changed", sha: "b".repeat(40) };
    headers.resolve(json({ sha: "c".repeat(40) }));
    await pending;
    expect(remote.calls[0]?.body).toEqual({ tree: [{ path: `objects/${objectKey}`, sha: "a".repeat(40) }] });
  });

  test("privacy: independent remote blob readback uses only companion authorization and encrypted payload", async () => {
    const remote = new Remote();
    const deadlines = new Deadlines();
    const client = remote.client({ deadline: deadlines.deadline });
    const payload = Buffer.from("private checkpoint probe with binary\0data");
    const sealed = client.seal(runId, "probe-secret-role", objectKey, payload);
    expect(await client.repository()).toBe("repository-id");
    const uploaded = await client.rest("git/blobs", { content: sealed.content, encoding: "base64" });
    if (!uploaded || typeof uploaded !== "object" || !("sha" in uploaded)) throw new Error("Missing blob ID");
    const reader = remote.client({ deadline: deadlines.deadline });
    await reader.repository();
    const read = await reader.rest(`git/blobs/${uploaded.sha}`);
    if (!read || typeof read !== "object" || !("content" in read)) throw new Error("Missing content");
    expect(reader.open(runId, "probe-secret-role", sealed.blob, String(read.content))).toEqual(payload);
    expect(remote.calls).toHaveLength(4);
    for (const call of remote.calls) {
      expect(call.init.headers).toEqual({
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      });
      expect(call.init.redirect).toBe("manual");
      const wire = JSON.stringify({ url: call.url, body: call.body });
      for (const secret of [
        payload.toString(),
        payload.toString("base64"),
        "probe-secret-role",
        sealed.blob.digest,
        Buffer.from(dataKey).toString("hex"),
        Buffer.from(dataKey).toString("base64"),
      ])
        expect(wire).not.toContain(secret);
    }
    remote.blobs.clear();
    await rejects(reader.rest(`git/blobs/${uploaded.sha}`), "missing");
    remote.blobs.set(String(uploaded.sha), Buffer.alloc(32).toString("base64"));
    const corrupt = await reader.rest(`git/blobs/${uploaded.sha}`);
    if (!corrupt || typeof corrupt !== "object" || !("content" in corrupt))
      throw new Error("Missing content");
    code(() => reader.open(runId, "probe-secret-role", sealed.blob, String(corrupt.content)), "unsupported");
    remote.hook = async () => json({ message: `${token} ${payload}` }, 403);
    await rejects(reader.repository(), "unavailable");
    deadlines.expectDisposed();
  });

  test("inert construction and delayed completion: wall clock reads are unnecessary", async () => {
    const remote = new Remote();
    const deadlines = new Deadlines();
    const headers = deferred<Response>();
    const started = captured(remote, () => headers.promise);
    const clock = spyOn(Date, "now").mockImplementation(() => {
      throw new Error("No wall clock");
    });
    try {
      const client = remote.client({ deadline: deadlines.deadline });
      expect(remote.calls).toHaveLength(0);
      const sealed = client.seal(runId, role, objectKey, dataKey);
      expect(client.open(runId, role, sealed.blob, sealed.content)).toEqual(Buffer.from(dataKey));
      let settled = false;
      const pending = client.repository().then((id) => {
        settled = true;
        return id;
      });
      await started;
      expect(settled).toBe(false);
      expect(deadlines.handles[0]?.disposed).toBe(0);
      headers.resolve(json({ data: { repository: remote.metadata } }));
      expect(await pending).toBe("repository-id");
      deadlines.expectDisposed();
    } finally {
      clock.mockRestore();
    }
  });
});
