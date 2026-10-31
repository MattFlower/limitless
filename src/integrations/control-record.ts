import { types } from "node:util";
import { z } from "zod";
import type { ClaimKey } from "../pipeline/portable.ts";
import { rethrowClaimControl } from "./claim-errors.ts";
import type { ControlNamer } from "./control-identity.ts";
import { canonicalJson, type JsonValue, snapshotJson } from "./control-json.ts";
import type { ControlKey } from "./control-ref.ts";
import { canonicalRepo } from "./lease-store.ts";
import { SharedStoreError } from "./shared-store.ts";

export const CONTROL_MANIFEST_BYTES = 262_144;
// No pruning or rollover: recurring adverts need a separate bounded-history replay protocol.
export const CONTROL_HISTORY_ENTRIES = 1_024;
const id = z.string().regex(/^[0-9a-f]{32}$/);
const member = z.string().regex(/^m-[0-9a-f]{16}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const repo = z.string().transform(canonicalRepo);
const counter = z.int().nonnegative();
const claim = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("issue"), repo, number: z.int().positive() }),
  z.strictObject({ kind: z.literal("pr"), repo, number: z.int().positive() }),
  z.strictObject({ kind: z.literal("run"), repo, runId: id }),
]) satisfies z.ZodType<ClaimKey>;
const actor = z
  .strictObject({
    kind: z.enum(["member", "github", "owner"]),
    id: z.string().min(1),
  })
  .refine((a) => a.kind !== "member" || member.safeParse(a.id).success);
export type ControlActor = z.infer<typeof actor>;
const receiptIdentity = {
  kind: z.literal("receipt"),
  repo,
  inputKind: z.enum(["issue", "comment"]),
  inputId: z.string().min(1),
};
const receipt = z.discriminatedUnion("state", [
  z.strictObject({ ...receiptIdentity, state: z.literal("reserved"), runId: id, claim }),
  z.strictObject({
    ...receiptIdentity,
    state: z.literal("committed"),
    runId: id,
    claim,
    generation: counter,
    checkpoint: z.string().regex(/^ckpt1:[0-9a-f]{32}:[0-9a-f]{64}$/),
  }),
  z.strictObject({
    ...receiptIdentity,
    state: z.literal("refused"),
    reason: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  }),
]);
export type InputReceipt = z.infer<typeof receipt>;
const value = z
  .union([
    receipt,
    // Callers supply timestamps from authenticated GitHub observations, never a local clock.
    z.strictObject({
      kind: z.literal("boundary"),
      repo,
      enabledAfter: z.string().refine((s) => {
        const date = new Date(s);
        return Number.isFinite(date.getTime()) && date.toISOString() === s;
      }),
    }),
    z.strictObject({ kind: z.literal("run-index"), runId: id, claim }),
    // Stored data and actor IDs confer no authentication, capability or landing authority.
    z.strictObject({ kind: z.literal("member"), member, data: z.custom<JsonValue>((v) => v !== undefined) }),
    z.strictObject({
      kind: z.literal("land-authority"),
      repo,
      data: z.custom<JsonValue>((v) => v !== undefined),
    }),
  ])
  .refine((v) => {
    if (v.kind !== "run-index" && (v.kind !== "receipt" || v.state === "refused")) return true;
    return (
      (v.kind !== "receipt" || v.repo === v.claim.repo) &&
      (v.claim.kind !== "run" || v.claim.runId === v.runId)
    );
  });
export type ControlValue = z.infer<typeof value>;
const key = z.strictObject({
  kind: z.enum(["receipt", "boundary", "run-index", "member", "land-authority"]),
  id: digest,
}) satisfies z.ZodType<ControlKey>;
const manifest = z
  .strictObject({
    schema: z.literal(1),
    key,
    version: z.int().positive(),
    value,
    mutations: z.array(z.strictObject({ id, actor, commandDigest: digest })),
  })
  .refine((m) => new Set(m.mutations.map((entry) => entry.id)).size === m.mutations.length);
export type ControlManifestV1 = z.infer<typeof manifest>;
export type ControlTip = { sha: string; manifest: ControlManifestV1 };
type ValidationCode = "invalid" | "corrupt";
function fail(code: ValidationCode | "limit" | "unsupported"): never {
  throw new SharedStoreError(code);
}
function checked<T>(action: () => T, code: ValidationCode): T {
  try {
    return action();
  } catch (error) {
    if (!types.isProxy(error)) rethrowClaimControl(error);
    return fail(code);
  }
}
function parse<T>(schema: z.ZodType<T>, input: unknown, code: ValidationCode): T {
  return checked(() => schema.parse(snapshotJson(input)), code);
}
export function validateControlValue(input: unknown): ControlValue {
  return parse(value, input, "invalid");
}
export function controlKey(namer: ControlNamer, input: unknown): ControlKey {
  const v = validateControlValue(input);
  const components =
    v.kind === "receipt"
      ? [v.repo, v.inputKind, v.inputId]
      : v.kind === "run-index"
        ? [v.claim.repo, v.runId]
        : v.kind === "member"
          ? [v.member]
          : [v.repo];
  return checked(() => key.parse(snapshotJson(namer.derive(v.kind, components))), "invalid");
}
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function captureManifest(namer: ControlNamer, input: unknown, requested: unknown, code: ValidationCode) {
  const captured = checked(() => snapshotJson(input), code);
  const envelope = checked(() => z.object({ schema: z.int().positive() }).parse(captured), code);
  if (envelope.schema !== 1) fail("unsupported");
  const m = checked(() => manifest.parse(captured), code);
  if (m.mutations.length > CONTROL_HISTORY_ENTRIES) fail("limit");
  const derived = checked(() => controlKey(namer, m.value), code);
  if (!equal(m.key, derived) || (requested !== undefined && !equal(parse(key, requested, code), derived)))
    fail(code);
  return m;
}
export function decodeControlManifest(
  namer: ControlNamer,
  requested: ControlKey,
  bytes: Uint8Array,
): ControlManifestV1 {
  const length = checked(() => {
    if (types.isProxy(bytes) || !types.isUint8Array(bytes)) fail("corrupt");
    const getter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(Uint8Array.prototype),
      "byteLength",
    )?.get;
    if (!getter) fail("corrupt");
    return Reflect.apply(getter, bytes, []) as number;
  }, "corrupt");
  if (length > CONTROL_MANIFEST_BYTES) fail("limit");
  const input: unknown = checked(
    () => JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)),
    "corrupt",
  );
  return captureManifest(namer, input, parse(key, requested, "corrupt"), "corrupt");
}
export function encodeControlManifest(
  namer: ControlNamer,
  input: unknown,
  requested?: ControlKey,
): Uint8Array {
  const m = captureManifest(namer, input, requested, "invalid");
  const bytes = new TextEncoder().encode(canonicalJson(m));
  if (bytes.byteLength > CONTROL_MANIFEST_BYTES) fail("limit");
  return bytes;
}

// Unchanged values remain valid for replay inspection, including records at history capacity.
export function validateControlReplacement(
  namer: ControlNamer,
  before: unknown | null,
  input: unknown,
): ControlValue {
  const next = validateControlValue(input);
  if (before === null) {
    if (next.kind === "receipt" && next.state === "committed") fail("invalid");
    return next;
  }
  const prior = validateControlValue(before);
  if (!equal(controlKey(namer, prior), controlKey(namer, next))) fail("invalid");
  if (prior.kind === "member" || prior.kind === "land-authority") return next;
  if (prior.kind !== "receipt") {
    if (!equal(prior, next)) fail("invalid");
    return next;
  }
  if (next.kind !== "receipt") fail("invalid");
  if (prior.state === "refused") {
    if (!equal(prior, next)) fail("invalid");
  } else {
    if (next.state === "refused" || prior.runId !== next.runId || !equal(prior.claim, next.claim))
      fail("invalid");
    if (prior.state === "committed" && (next.state !== "committed" || next.generation < prior.generation))
      fail("invalid");
  }
  return next;
}
