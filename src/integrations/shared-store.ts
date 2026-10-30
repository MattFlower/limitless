import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { addAbortListener } from "node:events";
import { z } from "zod";
import type { BlobRef } from "../pipeline/portable.ts";
import { redactCredentials, registerCredential } from "../util/proc.ts";
import { canonicalRepo } from "./lease-store.ts";

export type SharedStoreErrorCode =
  | "configuration"
  | "invalid"
  | "missing"
  | "corrupt"
  | "unsupported"
  | "conflict"
  | "unavailable"
  | "aborted";
export class SharedStoreError extends Error {
  constructor(readonly code: SharedStoreErrorCode) {
    super(redactCredentials(`Shared store error: ${code}`));
    this.name = "SharedStoreError";
  }
}
export type ExpectedBlob = Pick<BlobRef, "key" | "digest"> & Partial<Pick<BlobRef, "size">>;
export type RetentionOutcome =
  | { kind: "applied"; tip: string }
  | { kind: "unchanged"; tip: string | null }
  | { kind: "moved"; tip: string }
  | { kind: "unconfirmed" };
type Outcome = RetentionOutcome & { blob: BlobRef };
export interface SharedStore {
  newKey(): string;
  put(
    runId: string,
    role: string,
    key: string,
    plaintext: Uint8Array,
    signal?: AbortSignal,
  ): Promise<Outcome>;
  get(runId: string, role: string, expected: ExpectedBlob, signal?: AbortSignal): Promise<Uint8Array>;
}
export type SharedStoreDeps = {
  repo: string;
  token: string;
  dataKey: Uint8Array;
  request?: (url: string, init: RequestInit) => Promise<Response>;
  random?: (size: number) => Uint8Array;
  deadline?: (ms: number) => { signal: AbortSignal; dispose(): void };
};
type Context = { runId: string; role: string; key: string };
// A retention tip and the Git blob OID retained for each object key.
type Tip = { sha: string; root: string; entries: Map<string, string> };

const hex = (length: number) => z.hex().length(length).toLowerCase();
const oid = z.string().regex(/^[0-9a-f]{40}$/);
const contextSchema = z.object({
  runId: z.string().regex(/^[0-9a-z]{6,40}$/),
  role: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  key: hex(32),
});
const expectedSchema = z.object({
  key: hex(32),
  digest: hex(64),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
const created = z.object({ sha: oid });
const refSchema = z.object({ ref: z.string(), object: z.object({ sha: oid, type: z.literal("commit") }) });
const commitSchema = z.object({ sha: oid, message: z.string(), tree: created });
const treeSchema = z.object({
  sha: oid,
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: oid })),
});
const blobSchema = z.object({ sha: oid, encoding: z.literal("base64"), content: z.string() });
const metadataSchema = z.object({
  data: z.object({
    repository: z.object({ id: z.string().min(1), nameWithOwner: z.string(), isPrivate: z.boolean() }),
  }),
});
const mutationSchema = z.object({
  data: z.object({ updateRefs: z.object({ clientMutationId: z.string().nullable() }) }),
});
const metadataQuery =
  "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id nameWithOwner isPrivate}}";
const mutation =
  "mutation($r:ID!,$u:[RefUpdate!]!){updateRefs(input:{repositoryId:$r,refUpdates:$u}){clientMutationId}}";
const author = { name: "limitless", email: "factory@example.invalid" };
const thrown = new Set<SharedStoreErrorCode>(["configuration", "invalid", "unsupported", "conflict"]);

function fail(code: SharedStoreErrorCode): never {
  throw new SharedStoreError(code);
}
function guard<T>(action: () => T, code: SharedStoreErrorCode): T {
  try {
    return action();
  } catch {
    return fail(code);
  }
}
function parse<T>(schema: z.ZodType<T>, input: unknown, code: SharedStoreErrorCode = "corrupt"): T {
  const result = schema.safeParse(input);
  return result.success ? result.data : fail(code);
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const aad = (c: Context) => Buffer.from(JSON.stringify(["limitless-blob", 1, c.runId, c.key, c.role]));
function timer(ms: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, dispose: () => clearTimeout(id) };
}

export function createSharedStore(deps: SharedStoreDeps): SharedStore {
  const repo = guard(() => canonicalRepo(deps.repo), "configuration");
  if (typeof deps.token !== "string" || !deps.token.trim()) fail("configuration");
  if (!(deps.dataKey instanceof Uint8Array) || deps.dataKey.length !== 32) fail("configuration");
  const dataKey = Buffer.from(deps.dataKey);
  const { token, request = fetch, random = randomBytes, deadline = timer } = deps;
  registerCredential("LIMITLESS_COMPANION_TOKEN", token);
  const queues = new Map<string, Promise<void>>();

  function draw(size: number): Buffer {
    const bytes = guard(() => Buffer.from(random(size)), "configuration");
    return bytes.length === size ? bytes : fail("configuration");
  }
  function seal(c: Context, bytes: Uint8Array): string {
    const nonce = draw(12);
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce).setAAD(aad(c));
    const frame = [Buffer.of(1), nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()];
    return Buffer.concat(frame).toString("base64");
  }
  function open(c: Context, content: string): Buffer {
    // GitHub wraps base64 lines; re-encoding rejects any other noncanonical input.
    const encoded = content.replace(/[\r\n]/g, "");
    const frame = Buffer.from(encoded, "base64");
    if (frame.toString("base64") !== encoded || frame.length < 29) fail("corrupt");
    if (frame[0] !== 1) fail("unsupported");
    return guard(() => {
      const decipher = createDecipheriv("aes-256-gcm", dataKey, frame.subarray(1, 13)).setAAD(aad(c));
      decipher.setAuthTag(frame.subarray(-16));
      return Buffer.concat([decipher.update(frame.subarray(13, -16)), decipher.final()]);
    }, "corrupt");
  }
  async function send(path: string | null, body: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const response = await request(`https://api.github.com/${path ?? "graphql"}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      redirect: "manual",
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.redirected || !response.ok)
      fail(response.status === 404 && body === undefined ? "missing" : "unavailable");
    const text = await response.text();
    const data: unknown = guard(() => JSON.parse(text), "corrupt");
    if (path === null && (typeof data !== "object" || data === null || "errors" in data)) fail("unavailable");
    return data;
  }
  // One request with a fresh deadline covering dispatch, headers and the complete body.
  async function call(path: string | null, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) fail("aborted");
    const controller = new AbortController();
    const settled = Promise.withResolvers<never>();
    const abort = () => {
      controller.abort();
      settled.reject(new SharedStoreError("unavailable"));
    };
    const subscriptions: Disposable[] = [];
    let limit: ReturnType<typeof deadline> | undefined;
    try {
      limit = deadline(30_000);
      for (const s of [limit.signal, signal]) if (s) subscriptions.push(addAbortListener(s, abort));
      if (limit.signal.aborted) abort();
      const url = path === null ? null : `repos/${repo}/${path}`;
      return await Promise.race([send(url, body, controller.signal), settled.promise]);
    } catch (e) {
      if (signal?.aborted) fail("aborted");
      return fail(e instanceof SharedStoreError && !controller.signal.aborted ? e.code : "unavailable");
    } finally {
      for (const s of subscriptions) s[Symbol.dispose]();
      controller.abort();
      limit?.dispose();
    }
  }
  async function repository(signal?: AbortSignal): Promise<string> {
    const [owner, name] = repo.split("/");
    const result = await call(null, { query: metadataQuery, variables: { owner, name } }, signal);
    const metadata = parse(metadataSchema, result, "unavailable").data.repository;
    if (metadata.isPrivate !== true || metadata.nameWithOwner.toLowerCase() !== repo) fail("configuration");
    return metadata.id;
  }
  async function state(runId: string, signal?: AbortSignal): Promise<Tip | null> {
    const ref = `refs/limitless/store/${runId}`;
    const head = await call(`git/ref/${ref.slice(5)}`, undefined, signal).catch((e: unknown) => {
      if (e instanceof SharedStoreError && e.code === "missing") return null;
      throw e;
    });
    if (head === null) return null;
    const { ref: name, object } = parse(refSchema, head);
    if (name !== ref) fail("unsupported");
    const commit = parse(commitSchema, await call(`git/commits/${object.sha}`, undefined, signal));
    if (commit.sha !== object.sha || !/^limitless-store: 1\n?$/.test(commit.message)) fail("unsupported");
    const tree = async (sha: string) => {
      const result = parse(treeSchema, await call(`git/trees/${sha}`, undefined, signal));
      return result.sha === sha && !result.truncated ? result.tree : fail("unsupported");
    };
    const [objects, ...extra] = await tree(commit.tree.sha);
    if (extra.length || objects?.path !== "objects" || objects.mode !== "040000" || objects.type !== "tree")
      fail("unsupported");
    const entries = new Map<string, string>();
    for (const e of await tree(objects.sha)) {
      if (!/^[0-9a-f]{32}$/.test(e.path) || e.mode !== "100644" || e.type !== "blob" || entries.has(e.path))
        fail("unsupported");
      entries.set(e.path, e.sha);
    }
    return { sha: object.sha, root: commit.tree.sha, entries };
  }
  async function content(sha: string, signal?: AbortSignal): Promise<string> {
    const blob = parse(blobSchema, await call(`git/blobs/${sha}`, undefined, signal));
    return blob.sha === sha ? blob.content : fail("corrupt");
  }
  // Serializes one run's puts; a caller cancelled while queued never starts its task.
  async function exclusive<T>(runId: string, signal: AbortSignal | undefined, task: () => Promise<T>) {
    const previous = queues.get(runId) ?? Promise.resolve();
    const done = Promise.withResolvers<void>();
    const tail = previous.then(() => done.promise);
    queues.set(runId, tail);
    const aborted = Promise.withResolvers<never>();
    const subscription =
      signal && addAbortListener(signal, () => aborted.reject(new SharedStoreError("aborted")));
    try {
      await Promise.race([previous, aborted.promise]);
      subscription?.[Symbol.dispose]();
      return await task();
    } finally {
      subscription?.[Symbol.dispose]();
      done.resolve();
      if (queues.get(runId) === tail) queues.delete(runId);
    }
  }

  return {
    newKey: () => draw(16).toString("hex"),
    async put(runId, role, key, plaintext, signal) {
      const c = parse(contextSchema, { runId, role, key }, "invalid");
      if (!(plaintext instanceof Uint8Array)) fail("invalid");
      const bytes = Buffer.from(plaintext);
      const blob = { key: c.key, digest: sha256(bytes), size: bytes.length };
      const unconfirmed: Outcome = { kind: "unconfirmed", blob };
      return exclusive(c.runId, signal, async (): Promise<Outcome> => {
        let before: Tip | null = null;
        let observed = false;
        let sent = false;
        try {
          const id = await repository(signal);
          before = await state(c.runId, signal);
          const existing = before?.entries.get(c.key);
          if (before && existing !== undefined) {
            const retained = await content(existing, signal);
            const same = guard(() => open(c, retained).equals(bytes), "conflict");
            return same ? { kind: "applied", tip: before.sha, blob } : fail("conflict");
          }
          observed = true;
          const upload = { content: seal(c, bytes), encoding: "base64" };
          const sha = parse(created, await call("git/blobs", upload, signal)).sha;
          const entry = { path: `objects/${c.key}`, mode: "100644", type: "blob", sha };
          const treeBody = { ...(before && { base_tree: before.root }), tree: [entry] };
          const tree = parse(created, await call("git/trees", treeBody, signal)).sha;
          const parents = before ? [before.sha] : [];
          const commitBody = { message: "limitless-store: 1", tree, parents, author, committer: author };
          const commit = parse(created, await call("git/commits", commitBody, signal)).sha;
          if (signal?.aborted) fail("aborted");
          sent = true;
          const name = `refs/limitless/store/${c.runId}`;
          const update = { name, beforeOid: before?.sha ?? "0".repeat(40), afterOid: commit, force: false };
          const variables = { r: id, u: [update] };
          const response = await call(null, { query: mutation, variables }, signal).catch(() => null);
          if (mutationSchema.safeParse(response).success) return { kind: "applied", tip: commit, blob };
          // The CAS outcome is ambiguous: classify a fresh observation of the ref.
          const after = await state(c.runId, signal);
          if (after && (after.sha === commit || after.entries.get(c.key) === sha))
            return { kind: "applied", tip: after.sha, blob };
          if (after?.sha === before?.sha) return { kind: "unchanged", tip: before?.sha ?? null, blob };
          return after ? { kind: "moved", tip: after.sha, blob } : unconfirmed;
        } catch (e) {
          if (sent) return unconfirmed;
          if (signal?.aborted) fail("aborted");
          if (e instanceof SharedStoreError && thrown.has(e.code)) throw e;
          return observed ? { kind: "unchanged", tip: before?.sha ?? null, blob } : unconfirmed;
        }
      });
    },
    async get(runId, role, expected, signal) {
      const e = parse(expectedSchema, expected, "invalid");
      const c = parse(contextSchema, { runId, role, key: e.key }, "invalid");
      await repository(signal);
      const sha = (await state(c.runId, signal))?.entries.get(c.key) ?? fail("missing");
      const bytes = open(c, await content(sha, signal));
      if (sha256(bytes) !== e.digest || (e.size !== undefined && bytes.length !== e.size)) fail("corrupt");
      return bytes;
    },
  };
}
