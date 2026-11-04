import { afterEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Paths } from "../src/config.ts";
import { finalizePreparePolicy, recordProvisionalPolicy } from "../src/db/portable-policies.ts";
import { readOfflineProjection } from "../src/db/portable-projection.ts";
import { Store } from "../src/db/store.ts";
import { cachePath } from "../src/git/repos.ts";
import { ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import type { LeaseHandle } from "../src/integrations/leases.ts";
import { SharedStoreError } from "../src/integrations/shared-store.ts";
import { buildCandidate, type Candidate, CandidateRefused } from "../src/pipeline/checkpoint-candidate.ts";
import { parsePointer } from "../src/pipeline/checkpoint-settlement.ts";
import { initialRunState } from "../src/pipeline/context.ts";
import { claimKey, formatManifest, type ManifestV3, parseManifest } from "../src/pipeline/portable.ts";
import type { RunObjectIO } from "../src/pipeline/run-object-contract.ts";
import { createRunTransfer } from "../src/pipeline/run-transfer.ts";
import { decodeRunArtifacts } from "../src/pipeline/run-transfer-artifacts.ts";
import { RunTransferError } from "../src/pipeline/run-transfer-errors.ts";
import {
  receiptDescriptors,
  transferHash,
  verifyReceiptPayload,
} from "../src/pipeline/run-transfer-integrity.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import { registerCredential } from "../src/util/proc.ts";
import { policyFixture } from "./run-transfer-policy-support.ts";
import { Remote } from "./shared-store-fake.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  mock.restore();
  for (const dispose of cleanup.splice(0)) dispose();
});
const bytes = (s: string) => new TextEncoder().encode(s);
function parsed(text: string): ManifestV3 {
  const m = parseManifest(text);
  if (typeof m !== "object" || !("schema" in m) || m.schema !== 3) throw new Error("fixture manifest");
  return m;
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "candidate-")),
    store = new Store(":memory:"),
    offline = new Store(":memory:");
  cleanup.push(() => {
    store.close();
    offline.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const paths: Paths = {
    home: dir,
    db: join(dir, "db"),
    repos: join(dir, "repos"),
    work: join(dir, "work"),
    runs: join(dir, "runs"),
    configDir: join(dir, "config"),
  };
  const remote = new Remote(),
    blobs = remote.client();
  const repo = store.upsertRepo({
    slug: "example/project",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const canaries = {
    branch: `topic-${crypto.randomUUID()}`,
    pr: `https://github.com/example/project/pull/${Math.floor(Math.random() * 100000) + 1}`,
    prompt: `request-${crypto.randomUUID()}`,
  };
  const created = store.createRun(repo, { repo: repo.slug, prompt: canaries.prompt });
  const policy = policyFixture("single"),
    initial = initialRunState(created),
    worktreePath = join(dir, "worktree");
  mkdirSync(worktreePath);
  recordProvisionalPolicy(store, {
    runId: created.id,
    record: policy.provisional,
    state: initial,
    expected: null,
    expectedState: null,
  });
  const state = { ...initial, ...policy.prepared.fields, phase: "loop" as const, round: 2, worktreePath };
  finalizePreparePolicy(store, {
    runId: created.id,
    record: policy.prepared,
    state,
    expected: { version: 1, digest: policy.provisional.recordId },
    expectedState: initial,
  });
  store.db
    .query("UPDATE runs SET base_sha=?,head_sha=?,branch=?,pr_url=? WHERE id=?")
    .run("a".repeat(40), "b".repeat(40), canaries.branch, canaries.pr, created.id);
  for (const [name, kind, content] of [
    ["spec.md", "spec", "specification"],
    ["implement-0.md", "report", "implementation"],
    ["holdout-scenarios.json", "holdout", JSON.stringify(["private scenarios"])],
  ]) {
    store.db
      .query("INSERT INTO artifacts (run_id,name,kind,content,created_at) VALUES (?,?,?,?,1)")
      .run(created.id, name ?? "", kind ?? "", content ?? "");
  }
  const run = store.getRun(created.id);
  if (!run) throw new Error("fixture run");
  const handle: LeaseHandle = {
    run: run.id,
    repo: repo.slug,
    ref: "refs/limitless/claims/test",
    member: "test-member",
    generation: 7,
  };
  let raw = `object-${crypto.randomUUID()}`;
  const objects: RunObjectIO = {
    export: mock(async (input) =>
      input.commits.length
        ? {
            bytes: encodeTransferJson(input.commits),
            requiredCommits: input.commits,
            refs: [],
            objectFormat: input.objectFormat,
          }
        : null,
    ),
    validate: mock(async (input, inspect, signal) => {
      expect(JSON.parse(new TextDecoder().decode(input.bytes))).toEqual(input.requiredCommits);
      await inspect({
        async *objects() {
          yield { oid: "a".repeat(40), type: "blob" };
        },
        async type() {
          return "blob";
        },
        async read() {
          return bytes(raw);
        },
      });
      signal.throwIfAborted();
    }),
  };
  const transfer = createRunTransfer({
    source: store,
    offline: { store: offline, ownership: "exclusive-offline" },
    objects,
    key: () => blobs.newKey(),
    manifestContext: ({ run, state }) => {
      const committed = store.checkpointRecord(run.id)?.committed,
        key = claimKey(run, store);
      if ("none" in key) throw new RunTransferError("invalid");
      return {
        manifest: {
          schema: 3,
          runId: run.id,
          key,
          generation: handle.generation,
          sequence: (committed?.sequence ?? 0) + 1,
          previous: committed ? (parsePointer(committed.pointer)?.digest ?? null) : null,
          baseSha: run.baseSha,
          headSha: run.headSha,
          phase: state.phase,
          round: state.round,
          createdBy: handle.member,
          effects: [],
          blobs: {
            state: { key: "0".repeat(32), digest: "0".repeat(64), size: 0 },
            objects: [],
            artifacts: [],
          },
        },
      };
    },
  });
  const deps = { store, paths, member: handle.member, transfer, blobs };
  const build = (guard = () => {}, signal = new AbortController().signal) =>
    buildCandidate(deps, run, handle, guard, signal);
  const commit = (candidate: Candidate) => {
    store.journalCheckpoint(run.id, { ...candidate, generation: handle.generation });
    expect(store.confirmCheckpoint(run.id, candidate.pointer, store.checkpointRecord(run.id))).toBe(true);
  };
  return {
    deps,
    build,
    commit,
    run,
    repo,
    handle,
    remote,
    store,
    offline,
    transfer,
    objects,
    paths,
    state,
    canaries,
    setRaw: (value: string) => {
      raw = value;
    },
  };
}

test("initial and successor metadata, repository selection, no ledger writes, and offline measurement", async () => {
  const f = fixture(),
    before = f.store.checkpointRecord(f.run.id),
    start = performance.now();
  const first = await f.build(),
    elapsed = performance.now() - start;
  console.info(
    `candidate fixture: 2 commits, 1 objects bundle, 3 artifacts (1 holdout), ${f.remote.calls.length} companion requests, ${elapsed.toFixed(2)} ms`,
  );
  const m = parsed(first.manifest);
  expect(m).toMatchObject({
    runId: f.run.id,
    key: { kind: "run", repo: f.repo.slug, runId: f.run.id },
    generation: 7,
    sequence: 1,
    previous: null,
    phase: "loop",
    round: 2,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    createdBy: f.handle.member,
    effects: [],
  });
  expect(first.commits).toEqual(["a".repeat(40), "b".repeat(40)]);
  expect(f.store.checkpointRecord(f.run.id)).toEqual(before);
  expect(f.objects.export).toHaveBeenLastCalledWith(
    expect.objectContaining({
      repository: {
        path: f.state.worktreePath,
        trust: "agent-controlled",
        lockPath: cachePath(f.paths, f.repo),
      },
    }),
    expect.any(AbortSignal),
  );
  f.commit(first);
  const ledger = f.store.checkpointRecord(f.run.id);
  rmSync(f.state.worktreePath, { recursive: true });
  // Change the commit set so export must select a repository rather than reuse a bundle.
  f.store.db.query("UPDATE runs SET head_sha=? WHERE id=?").run("c".repeat(40), f.run.id);
  const current = f.store.getRun(f.run.id);
  if (!current) throw new Error("fixture run");
  const next = await buildCandidate(f.deps, current, f.handle, () => {}, new AbortController().signal);
  expect(parsed(next.manifest)).toMatchObject({
    sequence: 2,
    previous: parsePointer(first.pointer)?.digest,
    headSha: "c".repeat(40),
  });
  expect(f.store.checkpointRecord(f.run.id)).toEqual(ledger);
  expect(f.objects.export).toHaveBeenLastCalledWith(
    expect.objectContaining({
      repository: {
        path: cachePath(f.paths, f.repo),
        trust: "factory-owned",
        lockPath: cachePath(f.paths, f.repo),
      },
    }),
    expect.any(AbortSignal),
  );
});

test.each(["pending", "none"] as const)("rejects %s before export", async (kind) => {
  const f = fixture();
  if (kind === "pending")
    f.store.journalCheckpoint(f.run.id, {
      pointer: "opaque",
      manifest: "opaque",
      generation: 1,
      sequence: 1,
      commits: [],
    });
  else f.store.db.query("UPDATE repos SET kind='local' WHERE id=?").run(f.repo.id);
  const before = f.store.checkpointRecord(f.run.id);
  await expect(f.build()).rejects.toMatchObject({
    name: "CandidateRefused",
    code: kind === "pending" ? "conflict" : "invalid",
  });
  expect(f.objects.export).not.toHaveBeenCalled();
  expect(f.remote.calls).toHaveLength(0);
  expect(f.store.checkpointRecord(f.run.id)).toEqual(before);
});

test("dedupe by slot and role, offline round-trip, encrypted identity and current credential validation", async () => {
  const f = fixture(),
    first = await f.build();
  f.commit(first);
  f.remote.calls = [];
  // Force a fresh state blob while artifacts and the commit set remain identical.
  f.store.db.query("UPDATE runs SET tokens_in=1 WHERE id=?").run(f.run.id);
  const second = await f.build();
  expect(f.remote.calls.filter((c) => c.url.endsWith("/git/blobs") && c.method === "POST")).toHaveLength(2);
  expect(parsed(second.manifest).blobs.artifacts).toEqual(parsed(first.manifest).blobs.artifacts);
  expect(f.objects.export).toHaveBeenCalledTimes(1);
  f.commit(second);
  f.store.db.query("UPDATE artifacts SET content='changed' WHERE run_id=? AND name='spec.md'").run(f.run.id);
  f.store.db.query("UPDATE runs SET tokens_in=2 WHERE id=?").run(f.run.id);
  f.remote.calls = [];
  const third = await f.build(),
    m = parsed(third.manifest);
  expect(f.remote.calls.filter((c) => c.url.endsWith("/git/blobs") && c.method === "POST")).toHaveLength(3);
  const retained = new Map<string, Uint8Array>();
  for (const ref of receiptDescriptors(m))
    retained.set(
      ref.key,
      await f.deps.blobs.get(
        f.run.id,
        ref === m.blobs.state ? "state" : "role" in ref ? String(ref.role) : "objects",
        ref,
      ),
    );
  const payload = verifyReceiptPayload(m, retained),
    artifacts = decodeRunArtifacts(m, retained, payload);
  expect(payload.run).toMatchObject({
    branch: f.canaries.branch,
    prUrl: f.canaries.pr,
    prompt: f.canaries.prompt,
  });
  for (const canary of Object.values(f.canaries)) {
    expect(JSON.stringify(third)).not.toContain(canary);
    for (const call of f.remote.calls) {
      expect(JSON.stringify(call)).not.toContain(canary);
      expect(Buffer.from(call.body.content ?? "", "base64").toString()).not.toContain(canary);
    }
  }
  await f.transfer.importRun({ manifest: third.manifest, blobs: retained }, new AbortController().signal);
  expect(readOfflineProjection(f.offline.db, f.run.id)).toMatchObject({
    state: payload.state,
    commits: third.commits,
  });
  expect(f.offline.listArtifacts(f.run.id)).toHaveLength(3);
  for (const artifact of artifacts)
    expect(f.offline.getArtifact(f.run.id, artifact.name)).toBe(artifact.content);
  const secret = `credential-${crypto.randomUUID()}`;
  f.setRaw(secret);
  registerCredential("candidate-test", secret);
  cleanup.push(() => registerCredential("candidate-test", undefined));
  await expect(f.build()).rejects.toMatchObject({ name: "CandidateRefused", code: "invalid" });
  expect(f.objects.export).toHaveBeenCalledTimes(1);
});

test("every stored payload and manifest read finishes before a pointer, including reused blobs", async () => {
  const f = fixture(),
    first = await f.build();
  f.commit(first);
  f.store.db.query("UPDATE artifacts SET content='new' WHERE run_id=? AND name='spec.md'").run(f.run.id);
  const original = f.deps.blobs.get,
    entered = Promise.withResolvers<void>();
  let release = () => {},
    completed = false;
  const reads: string[] = [];
  f.deps.blobs.get = async (...args) => {
    const gate = Promise.withResolvers<void>();
    release = gate.resolve;
    reads.push(args[1]);
    entered.resolve();
    await gate.promise;
    return original(...args);
  };
  const work = f.build().then((value) => {
    completed = true;
    return value;
  });
  await entered.promise;
  for (let i = 0; i < 6; i++) {
    expect(completed).toBe(false);
    const previous = reads.length;
    release();
    // A turn drains the offline transport's promise chain without a timing margin.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (i < 5) expect(reads.length).toBe(previous + 1);
  }
  await work;
  expect(reads).toEqual(["objects", "state", "holdout", "artifact", "artifact", "manifest"]);
});

test.each(["state", "objects", "holdout", "ciphertext", "payload", "artifact", "manifest"] as const)(
  "read-back rejects %s damage",
  async (damage) => {
    const f = fixture(),
      first = await f.build();
    f.commit(first);
    const original = f.deps.blobs.get;
    let damaged = false;
    f.deps.blobs.get = async (...args) => {
      const [runId, role, ref] = args;
      if (!damaged && (role === damage || (damage === "ciphertext" && role === "artifact"))) {
        damaged = true;
        const entries = f.remote.retained(runId),
          oid = entries.get(ref.key);
        if (damage === "ciphertext" && oid) {
          const sealed = Buffer.from(f.remote.blobs.get(oid) ?? "", "base64");
          sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1;
          f.remote.blobs.set(oid, sealed.toString("base64"));
        } else if (damage !== "manifest") {
          f.remote.store(
            runId,
            [...entries]
              .filter(([key]) => key !== ref.key)
              .map(([path, sha]) => ({ path, sha, mode: "100644", type: "blob" })),
          );
        }
      }
      const result = await original(...args);
      if (
        (damage === "payload" && role === "state") ||
        (damage === "artifact" && role === "artifact") ||
        (damage === "manifest" && role === "manifest")
      )
        return bytes("invalid");
      return result;
    };
    await expect(f.build()).rejects.toMatchObject({ name: "ClaimWaitError", reason: "unavailable" });
  },
);

test("artifact semantic verification failures map to unavailable after a valid storage read", async () => {
  const f = fixture(),
    exportRun = f.deps.transfer.exportRun;
  f.deps.transfer.exportRun = async (...args) => {
    const result = await exportRun(...args),
      m = parsed(result.manifest);
    const ref = m.blobs.artifacts[0];
    if (!ref) throw new Error("fixture artifact");
    const content = result.blobs.get(ref.key);
    if (!content) throw new Error("fixture bytes");
    const envelope = JSON.parse(new TextDecoder().decode(content));
    const changed = encodeTransferJson({ ...envelope, runId: "another123" });
    const blobs = new Map(result.blobs);
    blobs.set(ref.key, changed);
    ref.digest = transferHash(changed);
    ref.size = changed.length;
    return { ...result, blobs, manifest: formatManifest(m) };
  };
  await expect(f.build()).rejects.toEqual(new ClaimWaitError("unavailable"));
  expect(f.remote.calls.filter((c) => c.url.endsWith("/git/blobs") && c.method === "POST")).toHaveLength(5);
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
] as const)("export error %s has fixed diagnostics", async (code) => {
  const f = fixture(),
    error = new RunTransferError(code);
  f.deps.transfer.exportRun = async () => {
    throw error;
  };
  if (code === "aborted") await expect(f.build()).rejects.toBe(error);
  else if (code === "unavailable") await expect(f.build()).rejects.toEqual(new ClaimWaitError("unavailable"));
  else await expect(f.build()).rejects.toEqual(new CandidateRefused(code));
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
] as const)("storage error %s is unavailable", async (code) => {
  const f = fixture();
  f.deps.blobs.put = async () => {
    throw new SharedStoreError(code);
  };
  await expect(f.build()).rejects.toEqual(new ClaimWaitError("unavailable"));
});
test.each(["unchanged", "moved", "unconfirmed"] as const)("put %s stops before read-back", async (kind) => {
  const f = fixture();
  f.deps.blobs.put = async (_run, _role, key, bytes) => ({
    kind,
    tip: "a".repeat(40),
    blob: { key, digest: transferHash(bytes), size: bytes.length },
  });
  await expect(f.build()).rejects.toEqual(new ClaimWaitError("unavailable"));
  expect(f.remote.calls).toHaveLength(0);
});

test.each(["export", "put", "get", "manifest"] as const)(
  "loss after awaited %s preserves identity and stops",
  async (at) => {
    const f = fixture(),
      error = new ClaimLostError(),
      entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    let lost = false,
      writes = 0;
    const pause = async () => {
      entered.resolve();
      await resume.promise;
    };
    const exportRun = f.deps.transfer.exportRun,
      put = f.deps.blobs.put,
      get = f.deps.blobs.get;
    f.deps.transfer.exportRun = async (...args) => {
      const result = await exportRun(...args);
      if (at === "export") await pause();
      return result;
    };
    f.deps.blobs.put = async (...args) => {
      writes++;
      const result = await put(...args);
      if (at === "put") await pause();
      return result;
    };
    f.deps.blobs.get = async (...args) => {
      const result = await get(...args);
      if (at === "get" || (at === "manifest" && args[1] === "manifest")) await pause();
      return result;
    };
    const result = f
      .build(() => {
        if (lost) throw error;
      })
      .catch((e: unknown) => e);
    await entered.promise;
    const before = writes;
    lost = true;
    resume.resolve();
    expect(await result).toBe(error);
    expect(writes).toBe(before);
  },
);

test("claim controls thrown by storage retain identity and cancellation reaches transfer and storage", async () => {
  const f = fixture(),
    wait = new ClaimWaitError("capability");
  const put = f.deps.blobs.put;
  f.deps.blobs.put = async () => {
    throw wait;
  };
  await expect(f.build()).rejects.toBe(wait);
  f.deps.blobs.put = put;
  const controller = new AbortController(),
    exportRun = f.deps.transfer.exportRun;
  f.deps.transfer.exportRun = async (...args) => {
    expect(args[2]).toBe(controller.signal);
    return exportRun(...args);
  };
  f.deps.blobs.put = async (...args) => {
    expect(args[4]).toBe(controller.signal);
    controller.abort();
    throw new SharedStoreError("aborted");
  };
  await expect(f.build(() => {}, controller.signal)).rejects.toEqual(new ClaimWaitError("unavailable"));
  await expect(f.build(() => {}, controller.signal)).rejects.toMatchObject({
    name: "RunTransferError",
    code: "aborted",
  });
});
