import { expect, mock, test } from "bun:test";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import { bindClaim, claimScope } from "../src/integrations/claim-guard.ts";
import type { ClaimClient, ClaimRead, ClaimRecord } from "../src/integrations/claim-ref.ts";
import { createReceiptCheckpoint } from "../src/integrations/control-receipt.ts";
import type { InputReceipt } from "../src/integrations/control-record.ts";
import type { LeaseHandle } from "../src/integrations/leases.ts";
import { SharedStoreError, type SharedStoreErrorCode } from "../src/integrations/shared-store.ts";
import { type ClaimKey, claimRef, type ManifestV1, manifestDigest } from "../src/pipeline/portable.ts";

const runId = "a".repeat(32);
const otherRun = "b".repeat(32);
const repo = "example/repo";
const key = "c".repeat(32);
const member = `m-${"d".repeat(16)}`;
const wire = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
function fixture(changes: Partial<ManifestV1> = {}) {
  const manifest: ManifestV1 = {
    schema: 1,
    runId,
    key: { kind: "issue", repo: "EXAMPLE/REPO", number: 12 },
    generation: 2,
    sequence: 0,
    previous: null,
    baseSha: null,
    headSha: null,
    phase: "loop",
    round: 0,
    createdBy: member,
    blobs: { state: { key, digest: "e".repeat(64), size: 1 }, artifacts: [], objects: [] },
    effects: [],
    ...changes,
  };
  const receipt = {
    kind: "receipt" as const,
    repo: "Example/Repo",
    inputKind: "issue" as const,
    inputId: "input",
    state: "committed" as const,
    runId,
    claim: { ...manifest.key, repo: "EXAMPLE/REPO" },
    generation: 2,
    checkpoint: `ckpt1:${key}:${manifestDigest(manifest)}`,
  };
  const record: ClaimRecord = {
    kind: receipt.claim.kind,
    ...(receipt.claim.kind === "run" ? {} : { number: receipt.claim.number }),
    run: runId,
    generation: 2,
    checkpoint: receipt.checkpoint,
    holder: member,
    state: "held",
    status: "running",
  };
  const state = {
    bytes: wire(manifest),
    selection: { kind: "tip", tip: { sha: "f".repeat(40), committedAt: "ignored", record } } as ClaimRead,
  };
  const get = mock(async () => state.bytes);
  const read = mock(async () => state.selection);
  const unused = mock((): never => {
    throw new Error("Unexpected operation");
  });
  const claims: ClaimClient = { read, write: unused };
  const checkpoint = createReceiptCheckpoint({ blobs: { get, put: unused, newKey: unused }, claims });
  return { manifest, receipt, record, state, get, read, unused, checkpoint };
}
async function fixed(work: Promise<unknown>, code: SharedStoreErrorCode) {
  const error = await work.then(
    () => {
      throw new Error("Expected rejection");
    },
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(SharedStoreError);
  expect(error).toMatchObject({ code, message: `Shared store error: ${code}` });
  expect(error).not.toHaveProperty("cause");
  expect(JSON.stringify(error)).not.toContain("sentinel");
}

test("construction and noncommitted receipts perform no IO; invalid inputs reject before IO", async () => {
  const f = fixture();
  expect(f.get).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  const { generation: _generation, checkpoint: _checkpoint, ...identity } = f.receipt;
  expect(await f.checkpoint({ ...identity, state: "reserved" })).toBeNull();
  expect(
    await f.checkpoint({
      kind: "receipt",
      repo,
      inputKind: "comment",
      inputId: "input",
      state: "refused",
      reason: "disabled",
    }),
  ).toBeNull();
  const accessor = Object.defineProperty({}, "kind", {
    get() {
      throw new Error("sentinel");
    },
    enumerable: true,
  });
  for (const value of [
    null,
    [],
    {},
    accessor,
    new Proxy(f.receipt, {}),
    { kind: "boundary", repo, enabledAfter: "2026-10-28T12:34:56.000Z" },
    { ...f.receipt, claim: { ...f.receipt.claim, repo: "other/repo" } },
    { ...f.receipt, claim: { kind: "run", repo, runId: otherRun } },
    { ...f.receipt, checkpoint: `ckpt1:${key.toUpperCase()}:${"e".repeat(64)}` },
    { ...f.receipt, generation: -1 },
  ])
    await fixed(f.checkpoint(value as InputReceipt), "invalid");
  expect(f.get).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.unused).not.toHaveBeenCalled();
});

test.each(["issue", "pr", "run"] as const)(
  "current %s selection accepts equal and older origins without scope",
  async (kind) => {
    const claim: ClaimKey = kind === "run" ? { kind, repo, runId } : { kind, repo, number: 12 };
    for (const generation of [1, 2]) {
      const f = fixture({ key: claim, generation });
      // State, holder, status and timestamp do not confer execution authority.
      f.record.state = "released";
      f.record.holder = `m-${"e".repeat(16)}`;
      f.record.status = "cancelled";
      const signal = new AbortController().signal;
      expect(await f.checkpoint(f.receipt, signal)).toEqual(f.manifest);
      expect(f.get).toHaveBeenCalledWith(
        runId,
        "manifest",
        { key, digest: manifestDigest(f.manifest) },
        signal,
      );
      expect(f.read).toHaveBeenCalledWith(repo, claimRef(claim), signal);
    }
  },
);

test.each([
  { runId: otherRun },
  { key: { kind: "issue", repo: "other/repo", number: 12 } },
  { key: { kind: "pr", repo, number: 12 } },
  { key: { kind: "issue", repo, number: 13 } },
  { key: { kind: "run", repo, runId: otherRun } },
  { generation: 3 },
] satisfies Partial<ManifestV1>[])("manifest lineage mismatch returns no evidence (%#)", async (changes) => {
  const f = fixture();
  const manifest = { ...f.manifest, ...changes } as ManifestV1;
  f.state.bytes = wire(manifest);
  f.receipt.checkpoint = `ckpt1:${key}:${manifestDigest(manifest)}`;
  f.record.checkpoint = f.receipt.checkpoint;
  expect(await f.checkpoint(f.receipt)).toBeNull();
});

test("run-key origin must match even when the logical manifest run agrees", async () => {
  const f = fixture({ key: { kind: "run", repo, runId } });
  const manifest = { ...f.manifest, key: { kind: "run" as const, repo, runId: otherRun } };
  f.state.bytes = wire(manifest);
  f.receipt.checkpoint = `ckpt1:${key}:${manifestDigest(manifest)}`;
  f.record.checkpoint = f.receipt.checkpoint;
  expect(await f.checkpoint(f.receipt)).toBeNull();
});

test.each([
  { kind: "pr" },
  { number: 13 },
  { run: otherRun },
  { generation: 3 },
  { generation: 1 },
  { checkpoint: `ckpt1:${"f".repeat(32)}:${"e".repeat(64)}` },
  { checkpoint: undefined },
  { holder: "sentinel" },
  { state: "sentinel" },
])("unselected or invalid claim record returns no evidence (%#)", async (changes) => {
  const f = fixture();
  Object.assign(f.record, changes);
  expect(await f.checkpoint(f.receipt)).toBeNull();
});

test.each(["absent", "malformed", "unconfirmed"] as const)("claim observation: %s", async (kind) => {
  const f = fixture();
  f.state.selection =
    kind === "malformed"
      ? { kind: "tip", tip: { sha: "f".repeat(40), committedAt: "sentinel", record: "malformed" } }
      : kind === "unconfirmed"
        ? { kind, error: "sentinel" }
        : { kind };
  if (kind === "unconfirmed") await fixed(f.checkpoint(f.receipt), "unavailable");
  else expect(await f.checkpoint(f.receipt)).toBeNull();
});

test("retrieval precedes selection and caller mutation cannot change the owned receipt", async () => {
  const f = fixture();
  const paused = Promise.withResolvers<Uint8Array>();
  f.get.mockImplementation(() => paused.promise);
  const signal = new AbortController().signal;
  const work = f.checkpoint(f.receipt, signal);
  expect(f.get).toHaveBeenCalledTimes(1);
  expect(f.read).not.toHaveBeenCalled();
  Object.assign(f.receipt, { repo: "other/repo", runId: otherRun, generation: 99, checkpoint: "invalid" });
  Object.assign(f.receipt.claim, { repo: "other/repo", kind: "pr", number: 99 });
  paused.resolve(f.state.bytes);
  expect(await work).toEqual(f.manifest);
  expect(f.read).toHaveBeenCalledWith(repo, "refs/limitless/claims/12", signal);
});

test("a selection changed during retrieval supersedes retained content", async () => {
  const f = fixture();
  const paused = Promise.withResolvers<Uint8Array>();
  f.get.mockImplementation(() => paused.promise);
  const work = f.checkpoint(f.receipt);
  expect(f.read).not.toHaveBeenCalled();
  f.record.generation++;
  paused.resolve(f.state.bytes);
  expect(await work).toBeNull();
  expect(f.read).toHaveBeenCalledTimes(1);
});

test.each([
  [Uint8Array.of(0xff), "corrupt"],
  [wire({ schema: 1, sentinel: "sentinel" }), "corrupt"],
  [new TextEncoder().encode("sentinel"), "corrupt"],
  [wire({ schema: 99, sentinel: "sentinel" }), "unsupported"],
] as const)("invalid retained bytes use fixed errors (%#)", async (bytes, code) => {
  const f = fixture();
  f.state.bytes = bytes;
  await fixed(f.checkpoint(f.receipt), code);
  expect(f.read).not.toHaveBeenCalled();
});

test("v2 is unsupported; canonical digest disagreement is corrupt", async () => {
  const f = fixture();
  f.state.bytes = wire({ ...f.manifest, createdBy: "sentinel" });
  await fixed(f.checkpoint(f.receipt), "corrupt");
  // v2 must be canonically encoded to pass the shared parser.
  const { formatManifest } = await import("../src/pipeline/portable.ts");
  f.state.bytes = new TextEncoder().encode(formatManifest({ ...f.manifest, schema: 2 }));
  await fixed(f.checkpoint(f.receipt), "unsupported");
});

test("invalid UTF-8 inside otherwise valid JSON cannot become replacement text evidence", async () => {
  const f = fixture();
  const replacement = { ...f.manifest, createdBy: "\uFFFD" };
  const encoded = Buffer.from(wire({ ...f.manifest, createdBy: "sentinel" }));
  const offset = encoded.indexOf("sentinel");
  f.state.bytes = Buffer.concat([
    encoded.subarray(0, offset),
    Uint8Array.of(0xff),
    encoded.subarray(offset + "sentinel".length),
  ]);
  f.receipt.checkpoint = `ckpt1:${key}:${manifestDigest(replacement)}`;
  f.record.checkpoint = f.receipt.checkpoint;
  await fixed(f.checkpoint(f.receipt), "corrupt");
});

test.each(["get", "read"] as const)(
  "%s failures preserve storage/control identity and hide unexpected errors",
  async (dependency) => {
    for (const error of [
      new SharedStoreError("missing"),
      new SharedStoreError("corrupt"),
      new ClaimLostError(),
      new ClaimWaitError("lease"),
    ]) {
      const f = fixture();
      f[dependency].mockImplementation(async () => {
        throw error;
      });
      await expect(f.checkpoint(f.receipt)).rejects.toBe(error);
    }
    const f = fixture();
    f[dependency].mockImplementation(async () => {
      throw new Error("sentinel");
    });
    await fixed(f.checkpoint(f.receipt), "unavailable");
  },
);

test.each(["before", "blob", "claim"] as const)(
  "cancellation uses fixed aborted errors (%s)",
  async (stage) => {
    const f = fixture();
    const controller = new AbortController();
    if (stage === "before") controller.abort("sentinel");
    if (stage === "blob")
      f.get.mockImplementation(async () => {
        controller.abort("sentinel");
        return f.state.bytes;
      });
    if (stage === "claim")
      f.read.mockImplementation(async () => {
        controller.abort("sentinel");
        throw controller.signal.reason;
      });
    await fixed(f.checkpoint(f.receipt, controller.signal), "aborted");
  },
);

test.each(["revoked", "cancelled", "window", "probe"] as const)(
  "ambient %s during IO blocks return without manufacturing authority",
  async (mode) => {
    const f = fixture();
    const handle: LeaseHandle = { repo, ref: claimRef(f.receipt.claim), run: runId, member, generation: 2 };
    let now = 0;
    let cancelled = false;
    let probeError: Error | undefined;
    const original = new ClaimWaitError("unavailable");
    const binding = bindClaim(
      {
        windowOpen: () => {
          if (probeError) throw probeError;
          return now < 10;
        },
      },
      handle,
      () => cancelled,
    );
    const paused = Promise.withResolvers<ClaimRead>();
    const entered = Promise.withResolvers<void>();
    f.read.mockImplementation(() => {
      entered.resolve();
      return paused.promise;
    });
    const work = claimScope.run([binding], () => f.checkpoint(f.receipt));
    await entered.promise;
    if (mode === "revoked") binding.onLost(handle, null);
    if (mode === "cancelled") cancelled = true;
    if (mode === "window") now = 10;
    if (mode === "probe") probeError = original;
    paused.resolve(f.state.selection);
    if (mode === "probe") await expect(work).rejects.toBe(original);
    else if (mode === "revoked") await expect(work).rejects.toBeInstanceOf(ClaimLostError);
    else
      await expect(work).rejects.toMatchObject({
        name: "ClaimWaitError",
        reason: mode === "window" ? "lease" : "cancelled",
      });
  },
);
