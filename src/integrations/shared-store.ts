import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { addAbortListener } from "node:events";
import { z } from "zod";
import type { BlobRef } from "../pipeline/portable.ts";
import { redactCredentials, registerCredential } from "../util/proc.ts";
import { rethrowClaimControl } from "./claim-errors.ts";
import { canonicalRepo } from "./lease-store.ts";

// Codes `put` throws instead of classifying them as a retention outcome.
type Thrown = "configuration" | "invalid" | "unsupported" | "conflict";
export type SharedStoreErrorCode = Thrown | "missing" | "corrupt" | "unavailable" | "aborted";
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
type Stored = RetentionOutcome & { blob: BlobRef };
export interface SharedStore {
  newKey(): string;
  put(runId: string, role: string, key: string, plaintext: Uint8Array, signal?: AbortSignal): Promise<Stored>;
  get(runId: string, role: string, expected: ExpectedBlob, signal?: AbortSignal): Promise<Uint8Array>;
}
export type SharedStoreDeps = { repo: string; token: string; dataKey: Uint8Array } & {
  request?: (url: string, init: RequestInit) => Promise<Response>;
  random?: (size: number) => Uint8Array;
  deadline?: (ms: number) => { signal: AbortSignal; dispose(): void };
};
type Context = { runId: string; role: string; key: string };
// A retention tip and the Git blob OID retained for each object key.
type Tip = { sha: string; root: string; entries: Map<string, string> };
const hex = (length: number) => z.hex().length(length).toLowerCase();
const oid = z.string().regex(/^[0-9a-f]{40}$/);
const runIdPattern = z.string().regex(/^[0-9a-z]{6,40}$/);
const rolePattern = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const contextSchema = z.object({ runId: runIdPattern, role: rolePattern, key: hex(32) });
const expectedSchema = z.object({ key: hex(32), digest: hex(64), size: z.int().nonnegative().optional() });
const created = z.object({ sha: oid });
const target = z.object({ sha: oid, type: z.literal("commit") });
const commitSchema = z.object({ sha: oid, message: z.string(), tree: created });
const entrySchema = z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: oid });
const treeSchema = z.object({ sha: oid, truncated: z.boolean(), tree: z.array(entrySchema) });
const blobSchema = z.object({ sha: oid, encoding: z.literal("base64"), content: z.string() });
const repoInfo = z.object({ id: z.string().min(1), nameWithOwner: z.string(), isPrivate: z.boolean() });
const metadataSchema = z.object({ data: z.object({ repository: repoInfo }) });
const casSchema = z.object({ data: z.object({ updateRefs: z.object({ clientMutationId: z.null() }) }) });
const lookup = "query($o:String!,$n:String!){repository(owner:$o,name:$n){id nameWithOwner isPrivate}}";
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
  } catch (e) {
    rethrowClaimControl(e);
    return fail(code);
  }
}
function parse<T>(schema: z.ZodType<T>, input: unknown, code: SharedStoreErrorCode = "corrupt"): T {
  const result = schema.safeParse(input);
  return result.success ? result.data : fail(code);
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const aad = (c: Context) => Buffer.from(JSON.stringify(["limitless-blob", 1, c.runId, c.key, c.role]));
const ref = (runId: string) => `refs/limitless/store/${runId}`;
function timer(ms: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, dispose: () => clearTimeout(id) };
}
// Settles with `work`, or rejects `aborted` as soon as any signal aborts; listeners never outlive it.
async function abortable<T>(signals: (AbortSignal | undefined)[], work: () => Promise<T>): Promise<T> {
  if (signals.some((s) => s?.aborted)) fail("aborted");
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(new SharedStoreError("aborted"));
  const subscriptions = signals.flatMap((s) => (s ? [addAbortListener(s, abort)] : []));
  try {
    return await Promise.race([work(), aborted.promise]);
  } finally {
    for (const s of subscriptions) s[Symbol.dispose]();
  }
}
/** Internal companion transport and authenticated envelope IO; construction is inert. */
export function createCompanionIO(deps: SharedStoreDeps, maxResponseBytes?: number) {
  const repo = guard(() => canonicalRepo(deps.repo), "configuration");
  if (typeof deps.token !== "string" || !deps.token.trim()) fail("configuration");
  if (!(deps.dataKey instanceof Uint8Array) || deps.dataKey.length !== 32) fail("configuration");
  const dataKey = Buffer.from(deps.dataKey);
  const { token, request = fetch, random = randomBytes, deadline = timer } = deps;
  registerCredential("LIMITLESS_COMPANION_TOKEN", token);
  function draw(size: number): Buffer {
    const bytes = guard(() => Buffer.from(random(size)), "configuration");
    return bytes.length === size ? bytes : fail("configuration");
  }
  function seal(associatedData: Uint8Array, bytes: Uint8Array): string {
    const nonce = draw(12);
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce).setAAD(associatedData);
    const frame = [Buffer.of(1), nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()];
    return Buffer.concat(frame).toString("base64");
  }
  function open(associatedData: Uint8Array, content: string): Buffer {
    // GitHub wraps base64 lines; re-encoding rejects any other noncanonical input.
    const encoded = content.replace(/[\r\n]/g, "");
    const frame = Buffer.from(encoded, "base64");
    if (frame.toString("base64") !== encoded || frame.length < 29) fail("corrupt");
    if (frame[0] !== 1) fail("unsupported");
    const decipher = createDecipheriv("aes-256-gcm", dataKey, frame.subarray(1, 13)).setAAD(associatedData);
    const plaintext = decipher.setAuthTag(frame.subarray(-16)).update(frame.subarray(13, -16));
    // Authentication completes in final(), before any decrypted byte leaves this function.
    return Buffer.concat([plaintext, guard(() => decipher.final(), "corrupt")]);
  }
  async function transport<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      rethrowClaimControl(e);
      return fail("unavailable");
    }
  }
  async function boundedText(res: Response, max: number): Promise<string> {
    if (Number(res.headers.get("content-length")) > max) fail("invalid");
    const reader = res.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await transport(() => reader.read());
        if (done) return Buffer.concat(chunks, size).toString("utf8");
        size += value.byteLength;
        if (size > max) fail("invalid");
        chunks.push(value);
      }
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  // One request with a fresh deadline covering dispatch, headers and the complete body.
  async function call(path: string | null, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const limit = deadline(30_000);
    try {
      const url = `https://api.github.com/${path === null ? "graphql" : `repos/${repo}/${path}`}`;
      return await abortable([limit.signal, signal], async () => {
        const res = await transport(() =>
          request(url, {
            method: body === undefined ? "GET" : "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            redirect: "manual",
            signal: controller.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        const text = maxResponseBytes === undefined ? undefined : await boundedText(res, maxResponseBytes);
        if (!res.ok || res.redirected)
          fail(res.status === 404 && !body && !res.redirected ? "missing" : "unavailable");
        const raw = text ?? (await transport(() => res.text()));
        const json: unknown = guard(() => JSON.parse(raw), path === null ? "unavailable" : "corrupt");
        if (path === null && (!(json instanceof Object) || "errors" in json)) fail("unavailable");
        return json;
      });
    } catch (e) {
      rethrowClaimControl(e);
      if (signal?.aborted) fail("aborted");
      return fail(e instanceof SharedStoreError && e.code !== "aborted" ? e.code : "unavailable");
    } finally {
      controller.abort();
      limit.dispose();
    }
  }
  async function repository(signal?: AbortSignal): Promise<string> {
    const [o, n] = repo.split("/");
    const result = await call(null, { query: lookup, variables: { o, n } }, signal);
    const metadata = parse(metadataSchema, result, "unavailable").data.repository;
    if (metadata.isPrivate !== true || metadata.nameWithOwner.toLowerCase() !== repo) fail("configuration");
    return metadata.id;
  }
  async function content(sha: string, signal?: AbortSignal): Promise<string> {
    const blob = parse(blobSchema, await call(`git/blobs/${sha}`, undefined, signal));
    return blob.sha === sha ? blob.content : fail("corrupt");
  }
  return { draw, seal, open, call, repository, content };
}
export function createSharedStore(deps: SharedStoreDeps): SharedStore {
  const { draw, seal, open, call, repository, content } = createCompanionIO(deps);
  const queues = new Map<string, Promise<unknown>>();
  async function state(runId: string, signal?: AbortSignal): Promise<Tip | null> {
    const head = await call(`git/ref/${ref(runId).slice(5)}`, undefined, signal).catch((e: unknown) =>
      e instanceof SharedStoreError && e.code === "missing" ? null : Promise.reject(e),
    );
    if (head === null) return null;
    const { object } = parse(z.object({ ref: z.literal(ref(runId)), object: target }), head);
    const commit = parse(commitSchema, await call(`git/commits/${object.sha}`, undefined, signal));
    if (commit.sha !== object.sha || !/^limitless-store: 1\n?$/.test(commit.message)) fail("unsupported");
    const tree = async (sha: string) => {
      const result = parse(treeSchema, await call(`git/trees/${sha}`, undefined, signal));
      return result.sha === sha && !result.truncated ? result.tree : fail("unsupported");
    };
    const kind = (e?: z.infer<typeof entrySchema>) => `${e?.mode} ${e?.type} ${e?.path}`;
    const [objects, ...extra] = await tree(commit.tree.sha);
    if (!objects || extra.length || kind(objects) !== "040000 tree objects") fail("unsupported");
    const entries = new Map<string, string>();
    for (const e of await tree(objects.sha)) {
      if (!/^100644 blob [0-9a-f]{32}$/.test(kind(e)) || entries.has(e.path)) fail("unsupported");
      entries.set(e.path, e.sha);
    }
    return { sha: object.sha, root: commit.tree.sha, entries };
  }
  // Serializes one run's puts; a caller cancelled while queued never starts its task.
  function exclusive<T>(runId: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(runId) ?? Promise.resolve();
    const run = abortable([signal], () => previous).then(task);
    // A cancelled waiter settles early, so the queue waits for its predecessor too.
    const tail = Promise.allSettled([previous, run]);
    queues.set(runId, tail);
    void tail.then(() => queues.get(runId) === tail && queues.delete(runId));
    return run;
  }
  return {
    newKey: () => draw(16).toString("hex"),
    async put(runId, role, key, plaintext, signal) {
      const c = parse(contextSchema, { runId, role, key }, "invalid");
      const bytes = plaintext instanceof Uint8Array ? Buffer.from(plaintext) : fail("invalid");
      const blob = { key: c.key, digest: sha256(bytes), size: bytes.length };
      return exclusive(c.runId, signal, async (): Promise<Stored> => {
        let before: Tip | null = null;
        let stage = 0; // 0: establishing remote state, 1: state observed, 2: CAS dispatched.
        // Caller cancellation wins: before CAS dispatch it aborts; afterwards nothing is confirmed.
        const finish = (o: RetentionOutcome): Stored =>
          signal?.aborted ? (stage === 2 ? { kind: "unconfirmed", blob } : fail("aborted")) : { ...o, blob };
        const unchanged = () => finish({ kind: "unchanged", tip: before?.sha ?? null });
        try {
          const id = await repository(signal);
          before = await state(c.runId, signal);
          stage = 1;
          const existing = before?.entries.get(c.key);
          if (before && existing !== undefined) {
            const retained = await content(existing, signal);
            if (!guard(() => open(aad(c), retained).equals(bytes), "conflict")) fail("conflict");
            return finish({ kind: "applied", tip: before.sha });
          }
          const upload = { content: seal(aad(c), bytes), encoding: "base64" };
          const sha = parse(created, await call("git/blobs", upload, signal)).sha;
          const entry = { path: `objects/${c.key}`, mode: "100644", type: "blob", sha };
          const base = before && { base_tree: before.root };
          const tree = parse(created, await call("git/trees", { ...base, tree: [entry] }, signal)).sha;
          const parents = before ? [before.sha] : [];
          const commitBody = { message: "limitless-store: 1", tree, parents, author, committer: author };
          const commit = parse(created, await call("git/commits", commitBody, signal)).sha;
          if (signal?.aborted) fail("aborted");
          stage = 2;
          const update = { name: ref(c.runId), beforeOid: before?.sha ?? "0".repeat(40), afterOid: commit };
          const variables = { r: id, u: [{ ...update, force: false }] };
          const response = await call(null, { query: mutation, variables }, signal).catch((e: unknown) => {
            rethrowClaimControl(e);
            return null;
          });
          if (casSchema.safeParse(response).success) return finish({ kind: "applied", tip: commit });
          // Ambiguous CAS: reconcile; any fresh tip (the attempt included) retaining this blob OID applied.
          const after = await state(c.runId, signal);
          if (after?.entries.get(c.key) === sha) return finish({ kind: "applied", tip: after.sha });
          if (after?.sha === before?.sha) return unchanged();
          return finish(after ? { kind: "moved", tip: after.sha } : { kind: "unconfirmed" });
        } catch (e) {
          rethrowClaimControl(e);
          if (stage < 2 && !signal?.aborted && e instanceof SharedStoreError && thrown.has(e.code)) throw e;
          return stage === 1 ? unchanged() : finish({ kind: "unconfirmed" });
        }
      });
    },
    async get(runId, role, expected, signal) {
      const e = parse(expectedSchema, expected, "invalid");
      const c = parse(contextSchema, { runId, role, key: e.key }, "invalid");
      await repository(signal);
      const sha = (await state(c.runId, signal))?.entries.get(c.key) ?? fail("missing");
      const retained = await content(sha, signal);
      if (signal?.aborted) fail("aborted");
      const bytes = open(aad(c), retained);
      if (sha256(bytes) !== e.digest || (e.size !== undefined && bytes.length !== e.size)) fail("corrupt");
      return signal?.aborted ? fail("aborted") : bytes;
    },
  };
}
