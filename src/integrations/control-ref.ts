import { z } from "zod";
import { rethrowClaimControl } from "./claim-errors.ts";
import { claimGuard } from "./claim-guard.ts";
import { createCompanionIO, type SharedStoreDeps, SharedStoreError } from "./shared-store.ts";

export const CONTROL_REF_RESPONSE_LIMIT = 1_048_576;
// Reserve 4 KiB for blob JSON, 4 escaped CRLF bytes per 60 base64 characters
// (45 frame bytes), and the envelope's version, nonce and authentication tag.
const maxPayloadBytes = Math.floor((CONTROL_REF_RESPONSE_LIMIT - 4096) / 64) * 45 - 29;

export type ControlKind = "receipt" | "boundary" | "run-index" | "member" | "land-authority";
export type ControlKey = Readonly<{ kind: ControlKind; id: string }>;
export type ControlRefTip = { sha: string; bytes: Uint8Array };
export type ControlRefRead =
  | { kind: "absent" }
  | { kind: "tip"; tip: ControlRefTip }
  | { kind: "unconfirmed" };
export interface ControlRefReader {
  read(key: ControlKey, signal?: AbortSignal): Promise<ControlRefRead>;
}
// `unchanged` is an observation; an outstanding dispatched request may still apply later.
export type ControlRefOutcome =
  | { kind: "applied"; tip: ControlRefTip }
  | { kind: "unchanged"; tip: ControlRefTip | null }
  | { kind: "moved"; tip: ControlRefTip }
  | { kind: "unconfirmed" };
export interface ControlRefClient extends ControlRefReader {
  write(
    key: ControlKey,
    before: string | null,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<ControlRefOutcome>;
}
const keySchema = z.object({
  kind: z.enum(["receipt", "boundary", "run-index", "member", "land-authority"]),
  id: z
    .string()
    .length(64)
    .regex(/^[0-9a-f]{64}$/),
});
const absent = Symbol();
const oid = z
  .string()
  .length(40)
  .regex(/^[0-9a-f]{40}$/);
const target = z.object({ sha: oid, type: z.literal("commit") });
const commitSchema = z.object({ sha: oid, message: z.string(), tree: z.object({ sha: oid }) });
const treeSchema = z.object({
  sha: oid,
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), sha: oid })),
});
function fail(code: "invalid" | "corrupt" | "unsupported" | "aborted"): never {
  throw new SharedStoreError(code);
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  return result.success ? result.data : fail("corrupt");
}

export function createControlRefReader(deps: SharedStoreDeps): ControlRefReader {
  return { read: createControlRefClient(deps).read };
}

export function createControlRefClient(deps: SharedStoreDeps): ControlRefClient {
  const io = createCompanionIO(deps, CONTROL_REF_RESPONSE_LIMIT);
  async function read(key: ControlKey, signal?: AbortSignal, verify = true): Promise<ControlRefRead> {
    const captured = keySchema.safeParse(key);
    if (!captured.success) fail("invalid");
    const { kind, id } = captured.data;
    const ref = `refs/control/${kind}/${id}`;
    const aad = Buffer.from(JSON.stringify(["limitless-control", 1, kind, id]));
    try {
      if (verify) await io.repository(signal);
      const head = await io.call(`git/ref/${ref.slice(5)}`, undefined, signal).catch((e: unknown) => {
        rethrowClaimControl(e);
        if (e instanceof SharedStoreError && e.code === "missing") return absent;
        throw e;
      });
      if (signal?.aborted) fail("aborted");
      if (head === absent) return { kind: "absent" };
      const { object } = parse(z.object({ ref: z.literal(ref), object: target }), head);
      const commit = parse(commitSchema, await io.call(`git/commits/${object.sha}`, undefined, signal));
      if (commit.sha !== object.sha) fail("corrupt");
      if (commit.message !== "limitless-control: 1" && commit.message !== "limitless-control: 1\n")
        fail("unsupported");
      const tree = parse(treeSchema, await io.call(`git/trees/${commit.tree.sha}`, undefined, signal));
      if (tree.sha !== commit.tree.sha) fail("corrupt");
      const [entry] = tree.tree;
      if (
        tree.truncated ||
        tree.tree.length !== 1 ||
        !entry ||
        entry.path !== "control" ||
        entry.mode !== "100644" ||
        entry.type !== "blob"
      )
        fail("unsupported");
      const content = await io.content(entry.sha, signal);
      if (signal?.aborted) fail("aborted");
      return { kind: "tip", tip: { sha: commit.sha, bytes: io.open(aad, content) } };
    } catch (e) {
      rethrowClaimControl(e);
      if (signal?.aborted) fail("aborted");
      if (e instanceof SharedStoreError && e.code !== "unavailable") throw e;
      return { kind: "unconfirmed" };
    }
  }
  return {
    read: (key, signal) => read(key, signal),
    async write(key, before, plaintext, signal) {
      const captured = keySchema.safeParse(key);
      if (!captured.success || (before !== null && !oid.safeParse(before).success)) fail("invalid");
      if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > maxPayloadBytes) fail("invalid");
      const bytes = Buffer.from(plaintext);
      const k = captured.data;
      const ref = `refs/control/${k.kind}/${k.id}`;
      const aad = Buffer.from(JSON.stringify(["limitless-control", 1, k.kind, k.id]));
      let observed: ControlRefTip | null = null;
      let stage = 0; // 0: reading initial state, 1: observed, 2: CAS dispatched.
      const unchanged = (): ControlRefOutcome => ({ kind: "unchanged", tip: observed });
      const check = () => {
        if (signal?.aborted) fail("aborted");
        claimGuard();
      };
      try {
        const repository = await io.repository(signal);
        check();
        const initial = await read(k, signal, false);
        check();
        if (initial.kind === "unconfirmed") return { kind: "unconfirmed" };
        observed = initial.kind === "tip" ? initial.tip : null;
        if (observed && observed.sha !== before) return { kind: "moved", tip: observed };
        if (!observed && before !== null) return { kind: "unconfirmed" };
        stage = 1;
        const created = z.object({ sha: oid });
        const upload = { content: io.seal(aad, bytes), encoding: "base64" };
        const blob = parse(created, await io.call("git/blobs", upload, signal)).sha;
        check();
        const entry = { path: "control", mode: "100644", type: "blob", sha: blob };
        const tree = parse(created, await io.call("git/trees", { tree: [entry] }, signal)).sha;
        check();
        const author = { name: "limitless", email: "factory@example.invalid" };
        const body = {
          message: "limitless-control: 1",
          tree,
          parents: observed ? [observed.sha] : [],
          author,
          committer: author,
        };
        const commit = parse(created, await io.call("git/commits", body, signal)).sha;
        check();
        const variables = {
          r: repository,
          u: [{ name: ref, beforeOid: observed?.sha ?? "0".repeat(40), afterOid: commit, force: false }],
        };
        const query =
          "mutation($r:ID!,$u:[RefUpdate!]!){updateRefs(input:{repositoryId:$r,refUpdates:$u}){clientMutationId}}";
        check();
        stage = 2;
        const response = await io.call(null, { query, variables }, signal).catch((e: unknown) => {
          rethrowClaimControl(e);
          return null;
        });
        if (signal?.aborted) return { kind: "unconfirmed" };
        const success = z.object({
          data: z.object({ updateRefs: z.object({ clientMutationId: z.null() }) }),
        });
        if (success.safeParse(response).success) return { kind: "applied", tip: { sha: commit, bytes } };
        const after = await read(k, signal);
        if (signal?.aborted || after.kind === "unconfirmed") return { kind: "unconfirmed" };
        if (after.kind === "absent") return observed ? { kind: "unconfirmed" } : unchanged();
        if (after.tip.sha === observed?.sha) return unchanged();
        if (after.tip.sha === commit || Buffer.from(after.tip.bytes).equals(bytes))
          return { kind: "applied", tip: after.tip };
        return { kind: "moved", tip: after.tip };
      } catch (e) {
        rethrowClaimControl(e);
        if (stage < 2) check();
        if (signal?.aborted) {
          if (stage < 2) fail("aborted");
          return { kind: "unconfirmed" };
        }
        if (
          stage < 2 &&
          e instanceof SharedStoreError &&
          (e.code === "configuration" || (stage === 0 && e.code !== "unavailable"))
        )
          throw e;
        return stage === 1 ? unchanged() : { kind: "unconfirmed" };
      }
    },
  };
}
