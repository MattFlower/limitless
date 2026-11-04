import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Paths } from "../src/config.ts";
import { finalizePreparePolicy, recordProvisionalPolicy } from "../src/db/portable-policies.ts";
import { readOfflineProjection } from "../src/db/portable-projection.ts";
import { Store } from "../src/db/store.ts";
import { cachePath } from "../src/git/repos.ts";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import type { LeaseHandle } from "../src/integrations/leases.ts";
import { SharedStoreError, type SharedStoreErrorCode } from "../src/integrations/shared-store.ts";
import { buildCandidate, type Candidate, CandidateRefused } from "../src/pipeline/checkpoint-candidate.ts";
import { parsePointer } from "../src/pipeline/checkpoint-settlement.ts";
import { initialRunState, type RunState } from "../src/pipeline/context.ts";
import { claimKey, formatManifest, type ManifestV3, parseManifest } from "../src/pipeline/portable.ts";
import type { PrivateObjectReader, RunObjectIO } from "../src/pipeline/run-object-contract.ts";
import { createRunTransfer } from "../src/pipeline/run-transfer.ts";
import { RunTransferError, type RunTransferErrorCode } from "../src/pipeline/run-transfer-errors.ts";
import { receiptDescriptors, transferHash } from "../src/pipeline/run-transfer-integrity.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import { registerCredential, sh } from "../src/util/proc.ts";
import { policyFixture, seal } from "./run-transfer-policy-support.ts";
import { deferred, entry, Remote } from "./shared-store-fake.ts";

const fixtures: { store: Store; offline: Store; root: string }[] = [];
afterEach(() => {
  mock.restore();
  for (const f of fixtures.splice(0)) {
    f.store.close();
    f.offline.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
const manifestOf = (c: Candidate): ManifestV3 => {
  const m = parseManifest(c.manifest);
  if (typeof m !== "object" || !("runId" in m) || m.schema !== 3) throw new Error("fixture manifest");
  return m;
};
function fixture(baseSha = "a".repeat(40), headSha = "b".repeat(40)) {
  const root = mkdtempSync(join(tmpdir(), "candidate-")),
    store = new Store(":memory:"),
    offline = new Store(":memory:"),
    remote = new Remote(),
    blobs = remote.client();
  const paths: Paths = {
    home: root,
    db: join(root, "db"),
    repos: join(root, "repos"),
    work: join(root, "work"),
    runs: join(root, "runs"),
    configDir: join(root, "config"),
  };
  const repo = store.upsertRepo({
    slug: "example/project",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = store.createRun(repo, { repo: repo.slug, prompt: "Request" });
  const p = policyFixture("single"),
    initial = initialRunState(run);
  recordProvisionalPolicy(store, {
    runId: run.id,
    record: p.provisional,
    state: initial,
    expected: null,
    expectedState: null,
  });
  finalizePreparePolicy(store, {
    runId: run.id,
    record: seal({ ...p.prepared, trustedBase: baseSha, scriptSource: baseSha }),
    state: { ...initial, ...p.prepared.fields, phase: "loop", round: 2 },
    expected: { version: 1, digest: p.provisional.recordId },
    expectedState: initial,
  });
  store.db.query("UPDATE runs SET base_sha=?, head_sha=? WHERE id=?").run(baseSha, headSha, run.id);
  for (const [name, kind, content] of [
    ["spec.md", "spec", "specification"],
    ["diff.patch", "diff", "a small diff"],
    ["holdout-scenarios.json", "holdout", "[]"],
  ])
    store.putArtifact(run.id, name ?? "", kind ?? "", content ?? "");
  const handle: LeaseHandle = {
    repo: repo.slug,
    run: run.id,
    ref: `refs/limitless/claims/run-${run.id}`,
    member: "m-0123456789abcdef",
    generation: 4,
  };
  const reader: PrivateObjectReader = {
    async *objects() {
      yield { oid: baseSha, type: "blob" };
    },
    async type() {
      return "blob";
    },
    async read() {
      return new TextEncoder().encode("fixture raw object");
    },
  };
  const objects: RunObjectIO = {
    export: mock(async (input) => ({
      bytes: encodeTransferJson(input.commits),
      requiredCommits: input.commits,
      refs: [],
      objectFormat: input.objectFormat,
    })),
    validate: mock(async (input, inspect, signal) => {
      expect(JSON.parse(new TextDecoder().decode(input.bytes))).toEqual(input.requiredCommits);
      await inspect(reader);
      signal.throwIfAborted();
    }),
  };
  const transfer = createRunTransfer({
    source: store,
    offline: { store: offline, ownership: "exclusive-offline" },
    objects,
    key: () => blobs.newKey(),
    manifestContext: ({ run, state }) => {
      const key = claimKey(run, store);
      if ("none" in key) throw new RunTransferError("invalid");
      return {
        manifest: {
          schema: 3,
          runId: run.id,
          key,
          generation: handle.generation,
          sequence: 0,
          previous: null,
          baseSha: run.baseSha,
          headSha: run.headSha,
          phase: state.phase,
          round: state.round,
          createdBy: handle.member,
          effects: [],
          blobs: {
            state: { key: "0".repeat(32), digest: "0".repeat(64), size: 0 },
            artifacts: [],
            objects: [],
          },
        },
      };
    },
  });
  const deps = { store, paths, member: handle.member, transfer, blobs };
  const controller = new AbortController(),
    guard = mock(() => {});
  const puts = spyOn(blobs, "put"),
    gets = spyOn(blobs, "get");
  const build = () => buildCandidate(deps, run, handle, guard, controller.signal);
  const commit = (c: Candidate) => {
    store.journalCheckpoint(run.id, { ...c, generation: handle.generation });
    expect(store.confirmCheckpoint(run.id, c.pointer, store.checkpointRecord(run.id))).toBe(true);
  };
  const state = () => {
    const s = store.getRunState<RunState>(run.id);
    if (!s) throw new Error("fixture state");
    return s;
  };
  const advance = () => store.setRunState(run.id, { ...state(), round: state().round + 1 });
  const f = {
    root,
    store,
    offline,
    remote,
    blobs,
    deps,
    run,
    repo,
    handle,
    objects,
    reader,
    build,
    commit,
    state,
    advance,
    puts,
    gets,
    controller,
    guard,
  };
  fixtures.push(f);
  return f;
}
const unavailable = { name: "ClaimWaitError", reason: "unavailable" };

test("construction: initial and successor context, no local ledger or claim writes, removed worktree", async () => {
  const f = fixture(),
    worktree = join(f.root, "checkout");
  mkdirSync(worktree);
  f.store.setRunState(f.run.id, { ...f.state(), worktreePath: worktree });
  const exportRun = spyOn(f.deps.transfer, "exportRun");
  const before = f.store.checkpointRecord(f.run.id),
    leases = f.store.db.query("SELECT * FROM claim_leases").all();
  const c = await f.build(),
    m = manifestOf(c);
  expect(m).toMatchObject({
    schema: 3,
    runId: f.run.id,
    sequence: 1,
    previous: null,
    generation: 4,
    phase: "loop",
    round: 2,
    createdBy: f.handle.member,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    effects: [],
  });
  expect(exportRun.mock.calls[0]?.[1]).toEqual({
    path: worktree,
    lockPath: cachePath(f.deps.paths, f.repo),
    trust: "agent-controlled",
  });
  expect(f.store.checkpointRecord(f.run.id)).toEqual(before);
  expect(f.store.db.query("SELECT * FROM claim_leases").all()).toEqual(leases);
  expect([...f.remote.refs.keys()]).toEqual([`refs/limitless/store/${f.run.id}`]);
  f.commit(c);
  f.advance();
  rmSync(worktree, { recursive: true });
  const ledger = f.store.checkpointRecord(f.run.id),
    successor = await f.build();
  expect(manifestOf(successor)).toMatchObject({
    sequence: 2,
    previous: parsePointer(c.pointer)?.digest,
    round: 3,
  });
  expect(f.store.checkpointRecord(f.run.id)).toEqual(ledger);
  expect(exportRun.mock.calls[1]?.[1]).toEqual({
    path: cachePath(f.deps.paths, f.repo),
    lockPath: cachePath(f.deps.paths, f.repo),
    trust: "factory-owned",
  });
  expect(c.commits).toEqual(["a".repeat(40), "b".repeat(40)]);
});

test.each(["pending", "none"])("construction: refuses %s before any transfer or storage", async (kind) => {
  const f = fixture(),
    exportRun = spyOn(f.deps.transfer, "exportRun");
  if (kind === "pending")
    f.store.journalCheckpoint(f.run.id, {
      generation: 1,
      sequence: 1,
      pointer: "pending",
      manifest: "pending",
      commits: [],
    });
  else f.store.db.query("UPDATE repos SET kind='local' WHERE id=?").run(f.repo.id);
  await expect(f.build()).rejects.toMatchObject({
    name: "CandidateRefused",
    code: kind === "pending" ? "conflict" : "invalid",
  });
  expect(exportRun).not.toHaveBeenCalled();
  expect(f.remote.calls).toHaveLength(0);
});

test.each([false, true])("read-back: every get blocks resolution, reused=%s", async (reused) => {
  const f = fixture();
  if (reused) {
    f.commit(await f.build());
    f.advance();
  }
  f.gets.mockClear();
  f.puts.mockClear();
  const gates = Array.from({ length: 6 }, () => ({ entered: deferred<void>(), release: deferred<void>() }));
  let index = 0,
    done = false;
  const direct = f.remote.client();
  f.gets.mockImplementation(async (...args) => {
    const gate = gates[index++];
    if (!gate) throw new Error("unexpected get");
    gate.entered.resolve();
    await gate.release.promise;
    return direct.get(...args);
  });
  const building = f.build().then((c) => {
    done = true;
    return c;
  });
  try {
    for (const [i, gate] of gates.entries()) {
      await gate.entered.promise;
      expect(done).toBe(false);
      expect(f.puts.mock.calls.filter((c) => c[1] === "manifest")).toHaveLength(i === 5 ? 1 : 0);
      gate.release.resolve();
    }
    const c = await building;
    expect(f.gets.mock.calls.map((c) => c[2].key).sort()).toEqual(
      [...receiptDescriptors(manifestOf(c)).map((r) => r.key), parsePointer(c.pointer)?.key ?? ""].sort(),
    );
  } finally {
    for (const g of gates) g.release.resolve();
  }
});

test.each(["state", "objects", "holdout"])("read-back: missing %s in retention tree", async (role) => {
  const f = fixture(),
    direct = f.remote.client();
  f.commit(await f.build());
  f.advance();
  f.puts.mockClear();
  f.gets.mockImplementation(async (run, tag, expected, signal) => {
    if (tag === role)
      f.remote.store(
        run,
        [...f.remote.retained(run)]
          .filter(([key]) => key !== expected.key)
          .map(([key, sha]) => entry(key, sha)),
      );
    return direct.get(run, tag, expected, signal);
  });
  await expect(f.build()).rejects.toMatchObject(unavailable);
  expect(f.puts.mock.calls.some((c) => c[1] === "manifest")).toBe(false);
});

test("read-back: corrupted reused artifact ciphertext refuses", async () => {
  const f = fixture(),
    c = await f.build();
  f.commit(c);
  f.advance();
  const key = manifestOf(c).blobs.artifacts[0]?.key;
  const oid = f.remote.retained(f.run.id).get(key ?? "") ?? "";
  const bytes = Buffer.from(f.remote.blobs.get(oid) ?? "", "base64");
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  f.remote.blobs.set(oid, bytes.toString("base64"));
  f.puts.mockClear();
  await expect(f.build()).rejects.toMatchObject(unavailable);
  expect(f.puts.mock.calls.map((c) => c[1])).toEqual(["state"]);
});

test.each(["digest", "artifact", "manifest"])("read-back: verification catches %s failure", async (fault) => {
  const f = fixture(),
    direct = f.remote.client();
  if (fault === "artifact") {
    const original = f.deps.transfer.exportRun;
    spyOn(f.deps.transfer, "exportRun").mockImplementation(async (...args) => {
      const c = await original(...args),
        m = manifestOf({ ...c, pointer: "", sequence: 1, commits: [] });
      const ref = m.blobs.artifacts[0];
      if (!ref) throw new Error("fixture artifact");
      const bytes = encodeTransferJson({
        format: "limitless-run-artifact",
        version: 1,
        runId: f.run.id,
        name: "invalid.md",
        kind: "spec",
        content: "bad",
        createdAt: 1,
      });
      const blobs = new Map(c.blobs);
      blobs.set(ref.key, bytes);
      ref.digest = transferHash(bytes);
      ref.size = bytes.length;
      return { ...c, blobs, manifest: formatManifest(m) };
    });
  } else
    f.gets.mockImplementation(async (...args) => {
      const bytes = await direct.get(...args);
      return args[1] === (fault === "manifest" ? "manifest" : "state") ? new Uint8Array([0]) : bytes;
    });
  await expect(f.build()).rejects.toMatchObject(unavailable);
  expect(f.puts.mock.calls.some((c) => c[1] === "manifest")).toBe(fault === "manifest");
});

test("dedupe: unchanged objects/artifacts, one changed artifact and offline import", async () => {
  const f = fixture(),
    initial = await f.build();
  f.commit(initial);
  f.advance();
  f.puts.mockClear();
  const successor = await f.build(),
    m = manifestOf(successor);
  expect(f.puts.mock.calls.map((c) => c[1])).toEqual(["state", "manifest"]);
  expect(m.blobs.artifacts).toEqual(manifestOf(initial).blobs.artifacts);
  expect(m.blobs.objects).toEqual(manifestOf(initial).blobs.objects);
  expect(f.objects.export).toHaveBeenCalledTimes(1);
  expect(f.objects.validate).toHaveBeenCalledTimes(2);
  f.commit(successor);
  f.advance();
  f.puts.mockClear();
  f.store.db
    .query("UPDATE artifacts SET content='new specification' WHERE run_id=? AND name='spec.md'")
    .run(f.run.id);
  const changed = await f.build(),
    next = manifestOf(changed);
  expect(f.puts.mock.calls.map((c) => c[1])).toEqual(["state", "artifact", "manifest"]);
  expect(next.blobs.artifacts.slice(0, 2)).toEqual(m.blobs.artifacts.slice(0, 2));
  expect(next.blobs.artifacts[2]?.key).not.toBe(m.blobs.artifacts[2]?.key);
  const input = new Map<string, Uint8Array>();
  for (const [role, refs] of [
    ["state", [next.blobs.state]],
    ["objects", next.blobs.objects],
    ...next.blobs.artifacts.map((r) => [r.role, [r]] as const),
  ] as const)
    for (const ref of refs) input.set(ref.key, await f.blobs.get(f.run.id, role, ref));
  await f.deps.transfer.importRun({ manifest: changed.manifest, blobs: input }, f.controller.signal);
  expect(readOfflineProjection(f.offline.db, f.run.id)?.state.round).toBe(4);
  expect(f.offline.getArtifact(f.run.id, "spec.md")).toBe("new specification");
  expect(f.offline.getArtifact(f.run.id, "holdout-scenarios.json")).toBe("[]");
});

test.each(["slot", "role", "size"])("dedupe: does not reuse a %s mismatch", async (kind) => {
  const f = fixture(),
    c = await f.build(),
    m = manifestOf(c);
  const first = m.blobs.artifacts[0],
    last = m.blobs.artifacts[2];
  if (!first || !last) throw new Error("fixture artifacts");
  if (kind === "slot") [m.blobs.artifacts[0], m.blobs.artifacts[2]] = [last, first];
  if (kind === "role") first.role = "holdout";
  if (kind === "size") first.size++;
  f.commit({ ...c, manifest: formatManifest(m) });
  f.advance();
  f.puts.mockClear();
  await f.build();
  expect(f.puts.mock.calls.map((c) => c[1])).toEqual(
    kind === "slot" ? ["state", "artifact", "artifact", "manifest"] : ["state", "artifact", "manifest"],
  );
});

test("dedupe: reused bundle is inspected with the current credential registry", async () => {
  const f = fixture(),
    c = await f.build();
  f.commit(c);
  f.advance();
  f.puts.mockClear();
  const credential = ["newly", "registered", "object", "credential"].join("-");
  spyOn(f.reader, "read").mockResolvedValue(new TextEncoder().encode(credential));
  registerCredential("CANDIDATE_OBJECT_TEST", credential);
  await expect(f.build()).rejects.toBeInstanceOf(CandidateRefused);
  expect(f.objects.export).toHaveBeenCalledTimes(1);
  expect(f.puts).not.toHaveBeenCalled();
});

test("privacy: branch, PR URL and prompt are private in companion requests and survive decryption", async () => {
  const f = fixture(),
    canaries = [
      `branch-canary-${f.run.id}`,
      `https://github.com/example/project/pull/784123`,
      `prompt-canary-${f.run.id}`,
    ];
  f.store.db.query("UPDATE runs SET branch=?, pr_url=?, prompt=? WHERE id=?").run(...canaries, f.run.id);
  const c = await f.build();
  for (const call of f.remote.calls) {
    const text =
      call.url + JSON.stringify(call.body) + Buffer.from(call.body.content ?? "", "base64").toString();
    for (const canary of canaries) expect(text).not.toContain(canary);
  }
  const bytes = await f.blobs.get(f.run.id, "state", manifestOf(c).blobs.state);
  const text = new TextDecoder().decode(bytes);
  for (const canary of canaries) expect(text).toContain(canary);
});

test.each([
  "invalid",
  "unsupported",
  "incomplete",
  "corrupt",
  "conflict",
  "missing",
  "unavailable",
  "aborted",
] satisfies RunTransferErrorCode[])("error-mapping: export %s", async (code) => {
  const f = fixture(),
    error = new RunTransferError(code);
  spyOn(f.deps.transfer, "exportRun").mockRejectedValue(error);
  const result = await f.build().catch((e: unknown) => e);
  if (code === "aborted") expect(result).toBe(error);
  else if (code === "unavailable") expect(result).toMatchObject(unavailable);
  else {
    expect(result).toBeInstanceOf(CandidateRefused);
    expect(result).toMatchObject({ code, message: code });
  }
  expect(f.remote.calls).toHaveLength(0);
});

test.each([
  "configuration",
  "invalid",
  "unsupported",
  "conflict",
  "missing",
  "corrupt",
  "unavailable",
  "aborted",
  "limit",
] satisfies SharedStoreErrorCode[])("error-mapping: storage %s", async (code) => {
  const f = fixture();
  f.puts.mockRejectedValue(new SharedStoreError(code));
  await expect(f.build()).rejects.toMatchObject(unavailable);
  expect(f.puts).toHaveBeenCalledTimes(1);
  expect(f.gets).not.toHaveBeenCalled();
  f.puts.mockRestore();
  f.gets.mockRejectedValue(new SharedStoreError(code));
  await expect(f.build()).rejects.toMatchObject(unavailable);
});

test.each(["unchanged", "moved", "unconfirmed"] as const)("error-mapping: ambiguous put %s", async (kind) => {
  const f = fixture();
  f.puts.mockImplementation(async (_run, _role, key, bytes) => ({
    kind,
    tip: "a".repeat(40),
    blob: { key, digest: transferHash(bytes), size: bytes.length },
  }));
  await expect(f.build()).rejects.toMatchObject(unavailable);
  expect(f.puts).toHaveBeenCalledTimes(1);
  expect(f.gets).not.toHaveBeenCalled();
});

test.each(["export", "get", "put", "guard"])(
  "error-mapping: preserves claim-control identity through %s",
  async (site) => {
    const f = fixture(),
      error = new ClaimWaitError("lease");
    if (site === "export") spyOn(f.deps.transfer, "exportRun").mockRejectedValue(error);
    if (site === "get") f.gets.mockRejectedValue(error);
    if (site === "put") f.puts.mockRejectedValue(error);
    if (site === "guard")
      f.guard.mockImplementation(() => {
        throw error;
      });
    await expect(f.build()).rejects.toBe(error);
  },
);

test.each(["export", "reuse", "payload-put", "payload-get", "manifest-put", "manifest-get"])(
  "error-mapping: stale guard and cancellation after deferred %s",
  async (site) => {
    for (const cancelled of [false, true]) {
      const f = fixture();
      if (site === "reuse") {
        f.commit(await f.build());
        f.advance();
      }
      const entered = deferred<void>(),
        release = deferred<void>(),
        lost = new ClaimLostError();
      let stale = false;
      f.guard.mockImplementation(() => {
        if (stale) throw lost;
      });
      const pause = async <T>(value: T): Promise<T> => {
        entered.resolve();
        await release.promise;
        return value;
      };
      if (site === "export") {
        const original = f.deps.transfer.exportRun;
        spyOn(f.deps.transfer, "exportRun").mockImplementation(async (...args) =>
          pause(await original(...args)),
        );
      } else {
        const direct = f.remote.client();
        if (site.endsWith("put"))
          f.puts.mockImplementation(async (...args) => {
            const result = await direct.put(...args);
            return args[1] === (site === "manifest-put" ? "manifest" : "state") ? pause(result) : result;
          });
        else
          f.gets.mockImplementation(async (...args) => {
            const result = await direct.get(...args);
            return args[1] === (site === "manifest-get" ? "manifest" : site === "reuse" ? "objects" : "state")
              ? pause(result)
              : result;
          });
      }
      const building = f.build().catch((e: unknown) => e);
      try {
        await entered.promise;
        const writes = f.puts.mock.calls.length;
        if (cancelled) f.controller.abort();
        else stale = true;
        release.resolve();
        const result = await building;
        if (cancelled) expect(result).toMatchObject({ name: "RunTransferError", code: "aborted" });
        else expect(result).toBe(lost);
        expect(f.puts.mock.calls).toHaveLength(writes);
      } finally {
        release.resolve();
      }
    }
  },
);

test("dedupe: offline candidate measurement (one local commit, fake object IO)", async () => {
  const f = fixture(),
    path = cachePath(f.deps.paths, f.repo);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "fixture.txt"), "fixture raw object\n");
  await sh(["git", "init", "-q", "-b", "main"], { cwd: path });
  await sh(["git", "add", "fixture.txt"], { cwd: path });
  await sh(["git", "commit", "-qm", "fixture"], { cwd: path });
  const { stdout } = await sh(["git", "rev-parse", "HEAD"], { cwd: path });
  const measured = fixture(stdout.trim(), stdout.trim());
  measured.store.setRunState(measured.run.id, { ...measured.state(), worktreePath: path });
  const start = performance.now(),
    c = await measured.build(),
    wallMs = performance.now() - start;
  const requests = measured.remote.calls.length;
  const fixtureBytes = receiptDescriptors(manifestOf(c)).reduce((n, ref) => n + ref.size, 0);
  expect(c.commits).toEqual([stdout.trim()]);
  console.info(
    JSON.stringify({
      measurement: "offline candidate",
      requests,
      wallMs: +wallMs.toFixed(2),
      commits: c.commits.length,
      artifacts: 3,
      payloadBytes: fixtureBytes,
      repository: "one file, 19 bytes, one commit",
      objectIO: "fake export and validation; real local Git fixture, offline encrypted companion",
    }),
  );
});
