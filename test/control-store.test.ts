import { expect, mock, test } from "bun:test";
import { ClaimLostError } from "../src/integrations/claim-errors.ts";
import type { ClaimClient, ClaimRead, ClaimRecord } from "../src/integrations/claim-ref.ts";
import { createControlDirectory } from "../src/integrations/control-discovery.ts";
import { createControlNamer } from "../src/integrations/control-identity.ts";
import { commandDigest, type JsonValue } from "../src/integrations/control-json.ts";
import {
  CONTROL_HISTORY_ENTRIES,
  CONTROL_MANIFEST_BYTES,
  type ControlActor,
  type ControlValue,
  controlKey,
  encodeControlManifest,
  type InputReceipt,
} from "../src/integrations/control-record.ts";
import {
  type ControlKey,
  type ControlRefClient,
  type ControlRefTip,
  createControlRefClient,
} from "../src/integrations/control-ref.ts";
import { createControlStore } from "../src/integrations/control-store.ts";
import { type SharedStore, SharedStoreError } from "../src/integrations/shared-store.ts";
import { type ManifestV1, manifestDigest } from "../src/pipeline/portable.ts";
import { withoutIO } from "./control-purity-support.ts";
import { dataKey, deferred, isCas, isPost, json, Remote, token } from "./shared-store-fake.ts";

const namer = createControlNamer(dataKey);
const id = (n: number) => n.toString(16).padStart(32, "0");
const mutation = (n: number, command: JsonValue = n) => ({ id: id(n), command });
const repo = "example/repo";
const member = `m-${"d".repeat(16)}`;
const advert = (data: JsonValue = 0): ControlValue => ({ kind: "member", member, data });
const key = controlKey(namer, advert());
const boundary: ControlValue = { kind: "boundary", repo, enabledAfter: "2026-10-28T00:00:00.000Z" };
const reserved = {
  kind: "receipt",
  repo,
  inputKind: "issue",
  inputId: "input",
  state: "reserved",
  runId: "a".repeat(32),
  claim: { kind: "issue", repo, number: 12 },
} satisfies InputReceipt;
const unused = (): never => {
  throw new Error("Unexpected IO");
};
class Memory implements ControlRefClient {
  tips = new Map<string, ControlRefTip>();
  serial = 0;
  name(k: ControlKey) {
    return `${k.kind}/${k.id}`;
  }
  commit(k: ControlKey, bytes: Uint8Array) {
    const tip = { sha: (++this.serial).toString(16).padStart(40, "0"), bytes: Uint8Array.from(bytes) };
    this.tips.set(this.name(k), tip);
    return tip;
  }
  read = mock<ControlRefClient["read"]>(async (k) => {
    const tip = this.tips.get(this.name(k));
    return tip ? { kind: "tip", tip } : { kind: "absent" };
  });
  cas: ControlRefClient["write"] = async (k, before, bytes) => {
    const tip = this.tips.get(this.name(k));
    if (tip && tip.sha !== before) return { kind: "moved", tip };
    if (!tip && before !== null) return { kind: "unconfirmed" };
    return { kind: "applied", tip: this.commit(k, bytes) };
  };
  write = mock<ControlRefClient["write"]>((...args) => this.cas(...args));
}
function fixture(refs: ControlRefClient = new Memory()) {
  const manifest: ManifestV1 = {
    schema: 1,
    runId: reserved.runId,
    key: reserved.claim,
    generation: 1,
    sequence: 0,
    previous: null,
    baseSha: null,
    headSha: null,
    phase: "loop",
    round: 0,
    createdBy: member,
    blobs: { state: { key: id(8), digest: "e".repeat(64), size: 1 }, artifacts: [], objects: [] },
    effects: [],
  };
  const committed = {
    ...reserved,
    state: "committed" as const,
    generation: 2,
    checkpoint: `ckpt1:${id(7)}:${manifestDigest(manifest)}`,
  };
  const record: ClaimRecord = {
    kind: "issue",
    number: 12,
    run: reserved.runId,
    generation: 2,
    checkpoint: committed.checkpoint,
    holder: member,
    state: "held",
    status: "running",
  };
  const state = {
    selection: { kind: "absent" } as ClaimRead,
    bytes: new TextEncoder().encode(JSON.stringify(manifest)),
  };
  const get = mock(async () => state.bytes);
  const claimRead = mock(async () => state.selection);
  const claims: ClaimClient = { read: claimRead, write: unused };
  const blobs: SharedStore = { get, put: unused, newKey: unused };
  const actorValue: ControlActor = { kind: "owner", id: "trusted" };
  const actor = mock(() => actorValue);
  const deps = { refs, blobs, claims, namer, actor };
  const fresh = () => createControlStore(deps);
  const select = () => {
    state.selection = { kind: "tip", tip: { sha: "f".repeat(40), committedAt: "ignored", record } };
  };
  return { ...deps, state, get, claimRead, actorValue, fresh, store: fresh(), committed, record, select };
}
async function rejects(work: Promise<unknown>, code: string) {
  await expect(work).rejects.toMatchObject({
    name: "SharedStoreError",
    code,
    message: `Shared store error: ${code}`,
  });
}
function seed(
  refs: Memory,
  value: ControlValue,
  mutations: { id: string; actor: ControlActor; commandDigest: string }[] = [],
  version = 1,
) {
  const k = controlKey(namer, value);
  return refs.commit(k, encodeControlManifest(namer, { schema: 1, key: k, value, mutations, version }));
}

test("construction is inert; reads distinguish absence, uncertainty and invalid selected manifests", async () => {
  const refs = new Memory();
  const f = fixture(refs);
  await withoutIO(async () => {
    f.fresh();
  });
  expect(f.actor).not.toHaveBeenCalled();
  expect(refs.read).not.toHaveBeenCalled();
  expect(await f.store.read(key)).toBeNull();
  refs.read.mockResolvedValueOnce({ kind: "unconfirmed" });
  await rejects(f.store.read(key), "unavailable");
  await rejects(f.store.read({ ...key, id: "bad" }), "invalid");
  seed(refs, boundary);
  const wrong = refs.tips.get(refs.name(controlKey(namer, boundary)));
  if (!wrong) throw new Error("Missing seed");
  refs.tips.set(refs.name(key), wrong);
  await rejects(f.store.read(key), "corrupt");
  refs.commit(key, new TextEncoder().encode('{"schema":2}'));
  await rejects(f.store.read(key), "unsupported");
});

test("A then B survive restart: full-history replay skips reducer/write and rejects actor or command reuse", async () => {
  const refs = new Memory();
  const f = fixture(refs);
  await f.store.mutate(key, mutation(1), () => advert(1));
  await f.store.mutate(key, mutation(2), () => advert(2));
  const reduce = mock(() => advert(99));
  expect(await f.fresh().mutate(key, mutation(1), reduce)).toMatchObject({
    kind: "applied",
    replayed: true,
    tip: { manifest: { version: 2 } },
  });
  expect(reduce).not.toHaveBeenCalled();
  expect(refs.write).toHaveBeenCalledTimes(2);
  await rejects(f.fresh().mutate(key, mutation(1, "changed"), reduce), "conflict");
  f.actorValue.id = "another";
  await rejects(f.fresh().mutate(key, mutation(1), reduce), "conflict");
  expect(reduce).not.toHaveBeenCalled();
});

test.each([boundary, reserved])("independent stores reevaluate %j after CAS loss", async (value) => {
  const refs = new Memory();
  const f = fixture(refs);
  const k = controlKey(namer, value);
  const entered = deferred<void>(),
    release = deferred<void>();
  refs.write.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return refs.cas(...args);
  });
  const reduce = mock((current: ControlValue | null) => current ?? value);
  const loser = f.store.mutate(k, mutation(1), reduce);
  await entered.promise;
  const winner = await f.fresh().mutate(k, mutation(2), () => value);
  if (winner.kind !== "applied") throw new Error("Expected winner");
  release.resolve();
  expect(await loser).toMatchObject({ kind: "applied", replayed: false });
  expect(reduce.mock.calls).toEqual([[null], [value]]);
  expect(refs.write.mock.calls.map((c) => c[1])).toEqual([null, null, winner.tip.sha]);
  expect((await f.store.read(k))?.manifest.mutations.map((m) => m.id)).toEqual([id(2), id(1)]);
});

test.each(["moved", "replay", "conflict", "corrupt"])(
  "second contention stops with validated %s",
  async (mode) => {
    const refs = new Memory();
    const f = fixture(refs);
    refs.write.mockImplementation(async () => {
      const n = refs.write.mock.calls.length;
      if (n > 2) throw new Error("Unexpected third write");
      const entry = {
        id: id(n === 2 && mode !== "moved" ? 1 : n + 10),
        actor: f.actorValue,
        commandDigest: commandDigest(mode === "conflict" ? 99 : 1),
      };
      const tip = seed(refs, advert(n), [entry], n);
      return {
        kind: "moved",
        tip: mode === "corrupt" && n === 2 ? { ...tip, bytes: new Uint8Array() } : tip,
      };
    });
    const reduce = mock((_current: ControlValue | null) => advert(9));
    const work = f.store.mutate(key, mutation(1), reduce);
    if (mode === "conflict" || mode === "corrupt") await rejects(work, mode);
    else
      expect(await work).toMatchObject(
        mode === "replay"
          ? { kind: "applied", replayed: true }
          : { kind: "moved", tip: { manifest: { version: 2 } } },
      );
    expect(refs.write).toHaveBeenCalledTimes(2);
    expect(reduce).toHaveBeenCalledTimes(2);
    expect(reduce.mock.calls).toEqual([[null], [advert(1)]]);
  },
);

test("whole transactions serialize per key; cancelled waiters settle early without overtaking", async () => {
  const refs = new Memory();
  const f = fixture(refs);
  const entered = deferred<void>(),
    release = deferred<void>();
  refs.read.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { kind: "absent" };
  });
  const first = f.store.mutate(key, mutation(1), () => advert(1));
  await entered.promise;
  const controller = new AbortController();
  const reduce = mock((_current: ControlValue | null) => advert(2));
  const cancelled = f.store.mutate(key, mutation(2), reduce, controller.signal);
  controller.abort();
  await rejects(cancelled, "aborted");
  const third = f.store.mutate(key, mutation(3), reduce);
  const other = controlKey(namer, boundary);
  expect(await f.store.mutate(other, mutation(4), () => boundary)).toMatchObject({ kind: "applied" });
  expect(refs.read.mock.calls.map((c) => c[0])).toEqual([key, other]);
  expect(reduce).not.toHaveBeenCalled();
  release.resolve();
  await first;
  await third;
  expect(reduce.mock.calls).toEqual([[advert(1)]]);
  expect(refs.read.mock.calls.map((c) => c[0])).toEqual([key, other, key]);
  expect(f.get).not.toHaveBeenCalled();
  expect(f.claimRead).not.toHaveBeenCalled();
});

test("capture precedes queue waiting and IO; reducer snapshots are deeply frozen", async () => {
  const refs = new Memory();
  const f = fixture(refs);
  const entered = deferred<void>(),
    release = deferred<void>();
  refs.read.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return { kind: "absent" };
  });
  const first = f.store.mutate(key, mutation(1), () => advert({ nested: [1] }));
  await entered.promise;
  const mutableKey = { ...key },
    command = { nested: [1] },
    input = mutation(2, command);
  const next = f.store.mutate(mutableKey, input, (current) => {
    expect(Object.isFrozen(current)).toBe(true);
    if (current?.kind !== "member" || !current.data || typeof current.data !== "object")
      throw new Error("Missing data");
    expect(Object.isFrozen(current.data)).toBe(true);
    expect(Object.isFrozen(Object.values(current.data)[0])).toBe(true);
    return advert(2);
  });
  mutableKey.id = "f".repeat(64);
  command.nested.push(2);
  input.id = id(99);
  f.actorValue.id = "changed";
  release.resolve();
  await first;
  await next;
  const tip = await f.store.read(key);
  expect(tip?.manifest.mutations).toEqual(
    [1, 2].map((n) => ({
      id: id(n),
      actor: { kind: "owner", id: "trusted" },
      commandDigest: commandDigest(n === 1 ? 1 : { nested: [1] }),
    })),
  );
  expect(refs.write.mock.calls.map((c) => c[0])).toEqual([key, key]);
});

test("invalid inputs, async/throwing reducers and claim errors do not poison queues", async () => {
  const refs = new Memory();
  const f = fixture(refs);
  for (const input of [
    { id: id(1), command: undefined as unknown as JsonValue },
    { id: "bad", command: 1 },
  ])
    await rejects(
      f.store.mutate(key, input, () => advert()),
      "invalid",
    );
  f.actor.mockImplementationOnce(() => {
    throw new Error("private sentinel");
  });
  await rejects(
    f.store.mutate(key, mutation(1), () => advert()),
    "invalid",
  );
  f.actor.mockReturnValueOnce({ kind: "member", id: "bad" });
  await rejects(
    f.store.mutate(key, mutation(1), () => advert()),
    "invalid",
  );
  expect(refs.read).not.toHaveBeenCalled();
  const lost = new ClaimLostError();
  f.actor.mockImplementationOnce(() => {
    throw lost;
  });
  await expect(f.store.mutate(key, mutation(1), () => advert())).rejects.toBe(lost);
  for (const result of [
    () => Promise.resolve(advert()),
    () => Promise.reject(new Error("private sentinel")),
    () => ({
      // biome-ignore lint/suspicious/noThenProperty: Required rejection test for non-Promise thenables.
      then: (_resolve: unknown, reject: (e: Error) => void) => reject(new Error("sentinel")),
    }),
  ]) {
    await rejects(f.store.mutate(key, mutation(1), result as unknown as () => ControlValue), "invalid");
  }
  await rejects(
    f.store.mutate(key, mutation(1), () => {
      throw new Error("private sentinel");
    }),
    "invalid",
  );
  await expect(
    f.store.mutate(key, mutation(1), () => {
      throw lost;
    }),
  ).rejects.toBe(lost);
  await rejects(
    f.store.mutate(key, mutation(1), () => boundary),
    "invalid",
  );
  expect(refs.write).not.toHaveBeenCalled();
  refs.read.mockRejectedValueOnce(new SharedStoreError("unavailable"));
  await rejects(
    f.store.mutate(key, mutation(1), () => advert()),
    "unavailable",
  );
  refs.write.mockRejectedValueOnce(new SharedStoreError("unavailable"));
  await rejects(
    f.store.mutate(key, mutation(1), () => advert()),
    "unavailable",
  );
  expect(await f.store.mutate(key, mutation(1), () => advert())).toMatchObject({ kind: "applied" });
});

test("preconditions, send observations and uncertainty do not retry or invent IDs", async () => {
  const refs = new Memory();
  const f = fixture(refs);
  expect(await f.store.mutate(key, mutation(1), () => undefined)).toEqual({
    kind: "unchanged",
    tip: null,
    reason: "precondition",
  });
  for (const kind of ["unchanged", "unconfirmed"] as const) {
    refs.write.mockResolvedValueOnce(kind === "unchanged" ? { kind, tip: null } : { kind });
    expect(await f.store.mutate(key, mutation(1), () => advert())).toEqual(
      kind === "unchanged" ? { kind, tip: null, reason: "send" } : { kind },
    );
  }
  expect(refs.write).toHaveBeenCalledTimes(2);
});

test("delayed original dispatch and explicit retry are fenced by exact SHA", async () => {
  const refs = new Memory();
  const f = fixture(refs);
  const initial = seed(refs, advert());
  let delayed = async () => {};
  refs.write.mockImplementationOnce(async (...args) => {
    delayed = async () => {
      await refs.cas(...args);
    };
    return { kind: "unchanged", tip: initial };
  });
  expect(await f.store.mutate(key, mutation(1), () => advert(1))).toMatchObject({
    kind: "unchanged",
    reason: "send",
    tip: { sha: initial.sha },
  });
  const entered = deferred<void>(),
    release = deferred<void>();
  refs.write.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return refs.cas(...args);
  });
  const reduce = mock(() => advert(1));
  const retry = f.fresh().mutate(key, mutation(1), reduce);
  await entered.promise;
  await delayed();
  await f.fresh().mutate(key, mutation(2), () => advert(2));
  release.resolve();
  expect(await retry).toMatchObject({ kind: "applied", replayed: true });
  expect(reduce).toHaveBeenCalledTimes(1);
  expect((await f.store.read(key))?.manifest).toMatchObject({
    version: 3,
    value: advert(2),
    mutations: [{ id: id(1) }, { id: id(2) }],
  });
});

test("entry and byte capacity reject before writing, preserve history and permit existing replay", async () => {
  const refs = new Memory();
  const f = fixture(refs);
  const history = Array.from({ length: CONTROL_HISTORY_ENTRIES - 1 }, (_, n) => ({
    id: id(n),
    actor: f.actorValue,
    commandDigest: commandDigest(n),
  }));
  seed(refs, advert(), history);
  await f.store.mutate(key, mutation(1023), () => advert());
  const full = (await f.store.read(key))?.manifest;
  expect(full?.mutations).toEqual([
    ...history,
    { id: id(1023), actor: f.actorValue, commandDigest: commandDigest(1023) },
  ]);
  await rejects(
    f.store.mutate(key, mutation(1024), () => advert()),
    "limit",
  );
  const reduce = mock(() => advert());
  expect(await f.store.mutate(key, mutation(0), reduce)).toMatchObject({ kind: "applied", replayed: true });
  expect(reduce).not.toHaveBeenCalled();
  expect(refs.write).toHaveBeenCalledTimes(1);
  expect((await f.store.read(key))?.manifest).toEqual(full);
  const fresh = fixture(new Memory());
  const envelope = {
    schema: 1,
    key,
    value: advert(""),
    version: 1,
    mutations: [{ id: id(1), actor: fresh.actorValue, commandDigest: commandDigest(1) }],
  };
  const overhead = encodeControlManifest(namer, envelope).byteLength;
  expect(
    await fresh.store.mutate(key, mutation(1), () => advert("x".repeat(CONTROL_MANIFEST_BYTES - overhead))),
  ).toMatchObject({ kind: "applied" });
  const writes = fresh.refs.write as Memory["write"];
  await rejects(
    fresh.store.mutate(key, mutation(2), () => advert("x".repeat(CONTROL_MANIFEST_BYTES - overhead + 1))),
    "limit",
  );
  expect(writes).toHaveBeenCalledTimes(1);
  seed(refs, advert(), [], Number.MAX_SAFE_INTEGER);
  await rejects(
    f.store.mutate(key, mutation(9), () => advert()),
    "invalid",
  );
  expect(refs.write).toHaveBeenCalledTimes(1);
});

test.each(["upload", "commit", "applied"])(
  "offline recovery after crash at %s preserves authoritative history",
  async (stage) => {
    const remote = new Remote();
    const deps = { repo: "example/companion", token, dataKey, request: remote.request };
    const f = fixture(createControlRefClient(deps));
    let crashed = false;
    remote.hook = async (call, next) => {
      if (crashed && stage === "applied") throw new Error("Acknowledgement unavailable");
      const response = await next();
      if (
        !crashed &&
        (stage === "upload"
          ? isPost("git/blobs")(call)
          : stage === "commit"
            ? isPost("git/commits")(call)
            : isCas(call))
      ) {
        crashed = true;
        throw new Error("Connection lost");
      }
      return response;
    };
    expect(await f.store.mutate(key, mutation(1), () => advert(1))).toMatchObject({
      kind: stage === "applied" ? "unconfirmed" : "unchanged",
    });
    expect(crashed).toBe(true);
    remote.hook = undefined;
    const restarted = fixture(createControlRefClient(deps));
    if (stage !== "applied") await restarted.store.mutate(key, mutation(1), () => advert(1));
    await restarted.store.mutate(key, mutation(2), () => advert(2));
    const reduce = mock(() => advert(99));
    const calls = remote.calls.length;
    expect(await fixture(createControlRefClient(deps)).store.mutate(key, mutation(1), reduce)).toMatchObject({
      kind: "applied",
      replayed: true,
      tip: { manifest: { version: 2, value: advert(2) } },
    });
    expect(reduce).not.toHaveBeenCalled();
    expect(remote.calls.slice(calls).some((c) => isCas(c) || c.url.endsWith("git/blobs"))).toBe(false);
    expect((await restarted.store.read(key))?.manifest.mutations.map((m) => m.id)).toEqual([id(1), id(2)]);
  },
);

test("discovered reservation keeps its run/claim without local indexes; only selected inherited proof commits", async () => {
  const remote = new Remote();
  remote.hook = async (call, next) => {
    if (!call.body.query?.includes("refs(")) return next();
    return json({
      data: {
        repository: {
          id: "repository-id",
          refs: {
            nodes: [...remote.refs.keys()]
              .filter((r) => r.startsWith("refs/control/receipt/"))
              .map((r) => ({ prefix: "refs/control/receipt/", name: r.split("/").at(-1) })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
  };
  const deps = { repo: "example/companion", token, dataKey, request: remote.request };
  const original = fixture(createControlRefClient(deps));
  await original.store.mutate(controlKey(namer, reserved), mutation(1), () => reserved);
  const recovered = fixture(createControlRefClient(deps));
  const page = await createControlDirectory(deps).listReceiptCandidates();
  expect(page.keys).toHaveLength(1);
  const discovered = page.keys[0];
  if (!discovered) throw new Error("Missing candidate");
  expect((await recovered.store.read(discovered))?.manifest.value).toEqual(reserved);
  expect(recovered.claimRead).not.toHaveBeenCalled();
  for (const change of [{ runId: "b".repeat(32) }, { claim: { ...reserved.claim, number: 13 } }])
    await rejects(
      recovered.store.mutate(discovered, mutation(2), () => ({ ...reserved, ...change })),
      "invalid",
    );
  const commit = () => recovered.store.mutate(discovered, mutation(2), () => recovered.committed);
  expect(await commit()).toMatchObject({ kind: "unchanged", reason: "precondition" });
  recovered.select();
  for (const change of [
    { run: "b".repeat(32) },
    { generation: 3 },
    { checkpoint: `ckpt1:${id(9)}:${"e".repeat(64)}` },
  ]) {
    recovered.state.selection = {
      kind: "tip",
      tip: { sha: "f".repeat(40), committedAt: "ignored", record: { ...recovered.record, ...change } },
    };
    expect(await commit()).toMatchObject({ kind: "unchanged", reason: "precondition" });
  }
  recovered.select();
  expect(await commit()).toMatchObject({ kind: "applied", replayed: false });
  expect(recovered.get).toHaveBeenCalledTimes(5);
  recovered.record.generation++;
  const reads = recovered.claimRead.mock.calls.length,
    gets = recovered.get.mock.calls.length;
  expect(await recovered.fresh().mutate(discovered, mutation(2), unused)).toMatchObject({
    kind: "applied",
    replayed: true,
  });
  expect(recovered.claimRead).toHaveBeenCalledTimes(reads);
  expect(recovered.get).toHaveBeenCalledTimes(gets);
  expect(await recovered.store.receiptCheckpoint(recovered.committed)).toBeNull();
});

test("receipt contention repeats proof against fresh selection and preserves reservation lineage", async () => {
  const refs = new Memory();
  const f = fixture(refs);
  const k = controlKey(namer, reserved);
  seed(refs, reserved);
  f.select();
  refs.write.mockImplementationOnce(async () => {
    f.record.generation++;
    return { kind: "moved", tip: seed(refs, reserved, [], 2) };
  });
  const reduce = mock(() => f.committed);
  expect(await f.store.mutate(k, mutation(1), reduce)).toMatchObject({
    kind: "unchanged",
    reason: "precondition",
  });
  expect(reduce).toHaveBeenCalledTimes(2);
  expect(f.get).toHaveBeenCalledTimes(2);
  expect(f.claimRead).toHaveBeenCalledTimes(2);
  expect(refs.write).toHaveBeenCalledTimes(1);
  expect((await f.store.read(k))?.manifest.value).toEqual(reserved);
});
