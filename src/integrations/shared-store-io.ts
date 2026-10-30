import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { addAbortListener } from "node:events";
import { z } from "zod";
import type { BlobRef } from "../pipeline/portable.ts";
import { redactCredentials, registerCredential } from "../util/proc.ts";
import { canonicalRepo } from "./lease-store.ts";

// C02a primitives only; C02b must establish retention before acknowledging a put.
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
export type SharedStoreDeps = {
  repo: string;
  token: string;
  dataKey: Uint8Array;
  request?: (url: string, init: RequestInit) => Promise<Response>;
  random?: (size: number) => Uint8Array;
  deadline?: (ms: number) => { signal: AbortSignal; dispose(): void };
};
const hex = (length: number) =>
  z
    .string()
    .regex(new RegExp(`^[0-9a-f]{${length}}$`, "i"))
    .toLowerCase();
const context = z.object({
  runId: z.string().regex(/^[0-9a-z]{6,40}$/),
  role: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  key: hex(32),
});
const expected = z.object({
  key: hex(32),
  digest: hex(64),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
function fail(code: SharedStoreErrorCode): never {
  throw new SharedStoreError(code);
}
function parse<T>(schema: z.ZodType<T>, input: unknown, code: SharedStoreErrorCode): T {
  const result = schema.safeParse(input);
  return result.success ? result.data : fail(code);
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const aad = (c: z.infer<typeof context>) =>
  Buffer.from(JSON.stringify(["limitless-blob", 1, c.runId, c.key, c.role]));
function deadline(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

export function createSharedStoreIO(deps: SharedStoreDeps) {
  let repo: string;
  try {
    repo = canonicalRepo(deps.repo);
    if (typeof deps.token !== "string" || !deps.token.trim()) fail("configuration");
    if (!(deps.dataKey instanceof Uint8Array) || deps.dataKey.length !== 32) fail("configuration");
  } catch {
    return fail("configuration");
  }
  const key = Buffer.from(deps.dataKey);
  const token = deps.token;
  registerCredential("LIMITLESS_COMPANION_TOKEN", token);
  const request = deps.request ?? fetch;
  const random = deps.random ?? randomBytes;
  const timeout = deps.deadline ?? deadline;
  function draw(size: number) {
    try {
      const bytes = random(size);
      if (!(bytes instanceof Uint8Array) || bytes.length !== size) fail("configuration");
      return Buffer.from(bytes);
    } catch {
      return fail("configuration");
    }
  }
  async function call(path: string | null, body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) fail("aborted");
    let limit: ReturnType<typeof timeout>;
    try {
      limit = timeout(30_000);
    } catch {
      return fail("unavailable");
    }
    const controller = new AbortController();
    const listeners = [limit.signal, signal].flatMap((s) =>
      s ? [addAbortListener(s, () => controller.abort())] : [],
    );
    if (limit.signal.aborted || signal?.aborted) controller.abort();
    const aborted = Promise.withResolvers<never>();
    const listener = addAbortListener(controller.signal, () =>
      aborted.reject(new SharedStoreError("unavailable")),
    );
    try {
      const pending = (async () => {
        controller.signal.throwIfAborted();
        const response = await request(
          path === null ? "https://api.github.com/graphql" : `https://api.github.com/repos/${repo}/${path}`,
          {
            method: body === undefined ? "GET" : "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            redirect: "manual",
            signal: controller.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        );
        controller.signal.throwIfAborted();
        if (response.redirected || !response.ok) {
          await response.body?.cancel();
          if (response.redirected) fail("unavailable");
          if (response.status === 404 && body === undefined && path?.match(/^git\/(ref\/|blobs\/)/))
            fail("missing");
          fail("unavailable");
        }
        const text = await response.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          return fail("corrupt");
        }
        controller.signal.throwIfAborted();
        if (path === null && typeof data === "object" && data !== null && "errors" in data)
          fail("unavailable");
        return data;
      })();
      const result = await Promise.race([pending, aborted.promise]);
      if (signal?.aborted) fail("aborted");
      return result;
    } catch (error) {
      if (signal?.aborted) fail("aborted");
      if (controller.signal.aborted) fail("unavailable");
      throw new SharedStoreError(error instanceof SharedStoreError ? error.code : "unavailable");
    } finally {
      listener[Symbol.dispose]();
      for (const subscription of listeners) subscription[Symbol.dispose]();
      controller.abort();
      limit.dispose();
    }
  }
  const graphql = (query: string, variables: unknown, signal?: AbortSignal) =>
    call(null, { query, variables }, signal);
  return {
    repo,
    newKey: () => draw(16).toString("hex"),
    seal(runId: string, role: string, objectKey: string, plaintext: Uint8Array) {
      const c = parse(context, { runId, role, key: objectKey }, "invalid");
      if (!(plaintext instanceof Uint8Array)) fail("invalid");
      const bytes = Buffer.from(plaintext);
      const nonce = draw(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(c));
      const frame = Buffer.concat([
        Buffer.from([1]),
        nonce,
        cipher.update(bytes),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return {
        blob: { key: c.key, digest: digest(bytes), size: bytes.length } satisfies BlobRef,
        content: frame.toString("base64"),
      };
    },
    open(runId: string, role: string, descriptor: ExpectedBlob, content: string): Uint8Array {
      const e = parse(expected, descriptor, "invalid");
      const c = parse(context, { runId, role, key: e.key }, "invalid");
      if (typeof content !== "string") fail("corrupt");
      const encoded = content.replace(/[\r\n]/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) fail("corrupt");
      const frame = Buffer.from(encoded, "base64");
      if (frame.toString("base64") !== encoded || frame.length < 29) fail("corrupt");
      if (frame[0] !== 1) fail("unsupported");
      let bytes: Buffer;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, frame.subarray(1, 13));
        decipher.setAAD(aad(c));
        decipher.setAuthTag(frame.subarray(-16));
        bytes = Buffer.concat([decipher.update(frame.subarray(13, -16)), decipher.final()]);
      } catch {
        return fail("corrupt");
      }
      if (digest(bytes) !== e.digest || (e.size !== undefined && bytes.length !== e.size)) fail("corrupt");
      return bytes;
    },
    graphql,
    rest(path: string, body?: unknown, signal?: AbortSignal) {
      if (body !== undefined && !/^git\/(blobs|trees|commits)$/.test(path)) fail("invalid");
      if (
        !/^git\/(?:ref\/limitless\/store\/[0-9a-z]{6,40}|(?:blobs|trees|commits)(?:\/[0-9a-f]{40})?)$/.test(
          path,
        )
      )
        fail("invalid");
      return call(path, body, signal);
    },
    async repository(signal?: AbortSignal) {
      const [owner, name] = repo.split("/");
      const result = await graphql(
        "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id nameWithOwner isPrivate}}",
        { owner, name },
        signal,
      );
      const metadata = parse(
        z.object({
          data: z.object({
            repository: z.object({
              id: z.string().min(1),
              nameWithOwner: z.string(),
              isPrivate: z.literal(true),
            }),
          }),
        }),
        result,
        "unavailable",
      ).data.repository;
      if (metadata.nameWithOwner.toLowerCase() !== repo) fail("unavailable");
      return metadata.id;
    },
  };
}
