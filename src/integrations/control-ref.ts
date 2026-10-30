import { z } from "zod";
import { rethrowClaimControl } from "./claim-errors.ts";
import { createCompanionIO, type SharedStoreDeps, SharedStoreError } from "./shared-store.ts";

export const CONTROL_REF_RESPONSE_LIMIT = 1_048_576;

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
  const io = createCompanionIO(deps, CONTROL_REF_RESPONSE_LIMIT);
  return {
    async read(key, signal) {
      const captured = keySchema.safeParse(key);
      if (!captured.success) fail("invalid");
      const { kind, id } = captured.data;
      const ref = `refs/control/${kind}/${id}`;
      const aad = Buffer.from(JSON.stringify(["limitless-control", 1, kind, id]));
      try {
        await io.repository(signal);
        const head = await io.call(`git/ref/${ref.slice(5)}`, undefined, signal).catch((e: unknown) => {
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
    },
  };
}
