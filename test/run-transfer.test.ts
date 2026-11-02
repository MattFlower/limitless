import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { linkSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizePreparePolicy, recordProvisionalPolicy } from "../src/db/portable-policies.ts";
import { readOfflineProjection, readProjectionIds } from "../src/db/portable-projection.ts";
import { Store } from "../src/db/store.ts";
import { initialRunState } from "../src/pipeline/context.ts";
import { formatManifest, type PortableManifest, parseManifest } from "../src/pipeline/portable.ts";
import type { PrivateObjectReader, RunObjectIO } from "../src/pipeline/run-object-contract.ts";
import {
  createRunTransfer,
  type RunTransferCandidate,
  type RunTransferDependencies,
} from "../src/pipeline/run-transfer.ts";
import { RunTransferError } from "../src/pipeline/run-transfer-errors.ts";
import { transferHash } from "../src/pipeline/run-transfer-integrity.ts";
import { encodeTransferJson } from "../src/pipeline/run-transfer-json.ts";
import type { RunPayloadV1 } from "../src/pipeline/run-transfer-schema.ts";
import { registerCredential } from "../src/util/proc.ts";
import { policyFixture } from "./run-transfer-policy-support.ts";
import { fixture, sha } from "./run-transfer-support.ts";

const stores: Store[] = [],
  dirs: string[] = [];
afterEach(() => {
  mock.restore();
  for (const s of stores.splice(0)) s.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const store = (path = ":memory:") => {
  const s = new Store(path);
  stores.push(s);
  return s;
};
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "transfer-"));
  dirs.push(dir);
  return dir;
};
const signal = () => new AbortController().signal;
const repository = { path: "/unused/repo", lockPath: "/unused/cache", trust: "factory-owned" as const };
const deferred = () => Promise.withResolvers<void>();
const reader: PrivateObjectReader = {
  async *objects() {
    yield { oid: sha, type: "blob" };
  },
  async type() {
    return "blob";
  },
  async read() {
    return new TextEncoder().encode("ordinary raw content");
  },
};
function objectIO(): RunObjectIO {
  return {
    export: mock<RunObjectIO["export"]>(async (input) =>
      input.commits.length
        ? {
            bytes: encodeTransferJson({
              refs: input.commits.map((oid) => ({
                name: `refs/limitless-run-objects/${input.runScope}/${oid}`,
                oid,
              })),
            }),
            requiredCommits: [...input.commits],
            refs: [],
            objectFormat: input.objectFormat,
          }
        : null,
    ),
    validate: mock<RunObjectIO["validate"]>(async (input, inspect, abort) => {
      expect(input.requiredCommits).toEqual(input.refs.map((r) => r.oid));
      const header = JSON.parse(new TextDecoder().decode(input.bytes));
      if (JSON.stringify(header.refs) !== JSON.stringify(input.refs)) throw new RunTransferError("invalid");
      await inspect(reader);
      abort.throwIfAborted();
    }),
  };
}
function source(
  objects = true,
  flow: "build" | "verify-change" | "acceptance" = "build",
  followUp: boolean | "conflict" | "ci" = false,
) {
  const s = store(),
    p = policyFixture("single");
  const repo = s.upsertRepo({
    slug: "example/project",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = s.createRun(repo, {
    repo: repo.slug,
    prompt: "Request",
    ...(flow === "verify-change"
      ? {
          sourceRef: {
            kind: "pull_request" as const,
            repo: repo.slug,
            number: 42,
            baseSha: sha,
            headSha: "b".repeat(40),
          },
        }
      : {}),
  });
  const initial = {
    ...initialRunState(run),
    flow,
    answers: ["Recorded answer"],
    feedback: "Recorded feedback",
    roundsOnImplementer: 2,
    triedImplementers: ["fake/model"],
  };
  recordProvisionalPolicy(s, {
    runId: run.id,
    record: p.provisional,
    state: initial,
    expected: null,
    expectedState: null,
  });
  if (objects) {
    finalizePreparePolicy(s, {
      runId: run.id,
      record: p.prepared,
      state: { ...initial, ...p.prepared.fields, phase: "loop", round: 2 },
      expected: { version: 1, digest: p.provisional.recordId },
      expectedState: initial,
    });
    s.db.query("UPDATE runs SET base_sha = ?, head_sha = ? WHERE id = ?").run(sha, "b".repeat(40), run.id);
  }
  s.db.query("UPDATE runs SET cost_usd = 12, cost_equiv_usd = 25, tokens_in = 987 WHERE id = ?").run(run.id);
  const rows = fixture();
  for (const [table, values] of [
    ["stages", rows.stages],
    ["invocations", rows.invocations],
    ["questions", rows.questions],
  ] as const) {
    for (const row of values) {
      const entries = Object.entries({ ...row, runId: run.id });
      s.db
        .query(
          `INSERT INTO ${table} (${entries.map(([k]) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
        )
        .run(...entries.map(([, v]) => (typeof v === "boolean" ? Number(v) : v)));
    }
  }
  if (objects)
    s.db
      .query(
        "INSERT INTO agent_jobs (id, run_id, invocation_id, request, parent_sha, state, attempt, failure_reason, created_at, updated_at) VALUES (?, ?, 19, '{}', ?, 'failed', 4, 'exhausted', 11, 22)",
      )
      .run(`job-${run.id}`, run.id, sha);
  let ownerId = "";
  if (followUp) {
    const owner = s.createRun(repo, { repo: repo.slug, prompt: "Owner" });
    ownerId = owner.id;
    const url = "https://github.com/example/project/pull/42";
    s.db.query("UPDATE runs SET branch = 'topic', pr_url = ? WHERE id = ?").run(url, owner.id);
    s.db
      .query(
        "UPDATE runs SET base_branch = 'topic', delivery_branch = 'topic', pr_url = ?, source_ref = ? WHERE id = ?",
      )
      .run(
        url,
        JSON.stringify({ kind: "review-round", runId: owner.id, round: 3, prUrl: url, reviewedSha: sha }),
        run.id,
      );
    s.db
      .query(
        "INSERT INTO review_rounds (run_id, source_run_id, pr_url, round, reviewed_sha, findings, created_at) VALUES (?, ?, ?, 3, ?, '[]', 80)",
      )
      .run(run.id, owner.id, url, sha);
  }
  if (followUp)
    s.db
      .query("UPDATE review_rounds SET kind = ? WHERE run_id = ?")
      .run(typeof followUp === "string" ? followUp : "review", run.id);
  return { s, runId: run.id, ownerId, flow, followUp };
}
function facade(f: ReturnType<typeof source>, target = store(), objects = objectIO()) {
  let key = 0;
  const deps: RunTransferDependencies = {
    source: f.s,
    offline: { store: target, ownership: "exclusive-offline" },
    objects,
    key: mock(() => (++key).toString(16).padStart(32, "0")),
    manifestContext: ({ run, state }) => ({
      manifest: {
        schema: 2,
        runId: run.id,
        key:
          f.flow === "verify-change" || f.followUp
            ? { kind: "pr", repo: run.repoSlug, number: 42 }
            : { kind: "run", repo: run.repoSlug, runId: run.id },
        generation: 1,
        sequence: 0,
        previous: null,
        baseSha: run.baseSha,
        headSha: run.headSha,
        phase: state.phase,
        round: state.round,
        createdBy: "offline-test",
        effects: [],
        blobs: {
          state: { key: "0".repeat(32), digest: "0".repeat(64), size: 0 },
          artifacts: [],
          objects: [],
        },
      },
    }),
  };
  return { ...createRunTransfer(deps), deps, target };
}
function snapshot(s: Store) {
  return s.db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map(({ name }) => [name, s.db.query(`SELECT * FROM "${name}"`).all()]);
}
function edit(c: RunTransferCandidate, change: (m: PortableManifest, p: RunPayloadV1) => void) {
  const m = parseManifest(c.manifest);
  if (typeof m !== "object" || !("runId" in m)) throw new Error("Invalid fixture manifest");
  const p = structuredClone(c.payload),
    blobs = new Map<string, Uint8Array>([...c.blobs].map(([k, b]) => [k, new Uint8Array(b)]));
  change(m, p);
  const bytes = encodeTransferJson(p);
  blobs.set(m.blobs.state.key, bytes);
  m.blobs.state = { key: m.blobs.state.key, digest: transferHash(bytes), size: bytes.length };
  return { manifest: formatManifest(m), blobs };
}
async function rejected(promise: Promise<unknown>, code?: string) {
  await expect(promise).rejects.toMatchObject({ name: "RunTransferError", ...(code ? { code } : {}) });
}

test.each(["build", "verify-change", "acceptance", "follow-up", "conflict", "ci", "no-objects"] as const)(
  "round-trip %s preserves semantics and exact retained material after reopening",
  async (kind) => {
    const f = source(
      kind !== "no-objects",
      kind === "verify-change" || kind === "acceptance" ? kind : "build",
      kind === "follow-up" || kind === "conflict" || kind === "ci"
        ? kind === "follow-up"
          ? true
          : kind
        : false,
    );
    const path = join(directory(), "offline.db"),
      target = store(path),
      api = facade(f, target);
    // Force destination row IDs to collide with source ordinals.
    const repo = target.upsertRepo({
      slug: "example/other",
      kind: "github",
      url: null,
      localPath: null,
      defaultBranch: "main",
      mergePolicy: "none",
    });
    const unrelated = target.createRun(repo, { repo: repo.slug, prompt: "Existing" });
    for (let i = 0; i < 3; i++) {
      target.startStage(unrelated.id, "review");
      target.askQuestion(unrelated.id, "Existing?");
      target.createInvocation({
        runId: unrelated.id,
        stageId: null,
        role: "review",
        harness: "fake",
        provider: "fake",
        model: "fake",
        modelId: "fake/model",
      });
    }
    const before = snapshot(f.s),
      c = await api.exportRun(f.runId, repository, signal());
    expect(snapshot(f.s)).toEqual(before);
    expect(parseManifest(c.manifest)).toMatchObject({
      schema: 3,
      blobs: { artifacts: [], objects: kind === "no-objects" ? [] : [expect.any(Object)] },
    });
    const ids = await api.importRun(c, signal());
    expect(ids.stages.get(1)).toBe(4);
    expect(readOfflineProjection(target.db, f.runId)).toEqual(c.payload);
    expect(c.payload.run).toMatchObject({ id: f.runId, costUsd: 12, costEquivUsd: 25, tokensIn: 987 });
    expect(c.payload.questions).toHaveLength(2);
    expect(c.payload.state).toMatchObject({
      answers: ["Recorded answer"],
      feedback: "Recorded feedback",
      roundsOnImplementer: 2,
      triedImplementers: ["fake/model"],
    });
    expect(c.payload.jobs).toHaveLength(kind === "no-objects" ? 0 : 1);
    if (kind !== "no-objects")
      expect(c.payload.jobs[0]).toMatchObject({ attempt: 4, state: "failed", failure_reason: "exhausted" });
    if (f.followUp)
      expect(c.payload.followUp).toMatchObject({
        kind: typeof f.followUp === "string" ? f.followUp : "review",
        ownerId: f.ownerId,
      });
    expect(c.payload.invocations[0]).toMatchObject({ inputTokens: 8, costUsd: 0.5 });
    target.close();
    stores.splice(stores.indexOf(target), 1);
    const reopened = store(path),
      retained = facade({ ...f, s: reopened });
    retained.deps.key = () => {
      throw new Error("Must retain opaque keys");
    };
    retained.deps.objects.export = mock(() => {
      throw new Error("Must not repack");
    });
    expect(await retained.exportRun(f.runId, repository, signal())).toEqual(c);
    expect(reopened.getRunState(f.runId)).toBeNull();
    reopened.db.query("UPDATE questions SET question = 'tampered' WHERE run_id = ?").run(f.runId);
    await rejected(retained.exportRun(f.runId, repository, signal()), "conflict");
  },
);

test("unordered payload rows preserve semantics, mappings and exact retained material after reopening", async () => {
  const f = source(),
    path = join(directory(), "offline.db"),
    target = store(path),
    api = facade(f, target),
    c = await api.exportRun(f.runId, repository, signal());
  const input = edit(c, (_m, p) => {
    p.stages.reverse();
    p.invocations.reverse();
    p.questions.reverse();
  });
  const ids = await api.importRun(input, signal());
  for (const kind of ["stages", "invocations", "questions"] as const)
    expect(ids[kind]).toEqual(
      new Map([
        [2, 1],
        [1, 2],
      ]),
    );
  expect(readOfflineProjection(target.db, f.runId)).toEqual(c.payload);
  target.close();
  stores.splice(stores.indexOf(target), 1);
  const reopened = store(path),
    retained = facade({ ...f, s: reopened });
  expect(readOfflineProjection(reopened.db, f.runId)).toEqual(c.payload);
  expect(readProjectionIds(reopened.db, f.runId)).toEqual(ids);
  retained.deps.key = () => {
    throw new Error("Must retain opaque keys");
  };
  retained.deps.objects.export = mock(() => {
    throw new Error("Must not repack");
  });
  const saved = await retained.exportRun(f.runId, repository, signal());
  expect(saved.manifest).toBe(input.manifest);
  expect(saved.blobs).toEqual(input.blobs);
  expect(saved.digest).toBe(transferHash(new TextEncoder().encode(input.manifest)));
  expect(saved.payload).toEqual({
    ...c.payload,
    stages: c.payload.stages.toReversed(),
    invocations: c.payload.invocations.toReversed(),
    questions: c.payload.questions.toReversed(),
  });
});

test("validation rejects corrupt descriptors, headers, references, identities, policy and artifacts before object work", async () => {
  const f = source(),
    api = facade(f),
    c = await api.exportRun(f.runId, repository, signal());
  const before = snapshot(api.target);
  const corruptions = [
    (m: PortableManifest) => {
      m.blobs.state.size++;
    },
    (m: PortableManifest) => {
      m.blobs.state.digest = "f".repeat(64);
    },
    (m: PortableManifest) => {
      m.blobs.objects[0] = { ...m.blobs.state };
    },
    (_m: PortableManifest, p: RunPayloadV1) => {
      p.header.runId = "another1";
    },
    (_m: PortableManifest, p: RunPayloadV1) => {
      const invocation = p.invocations[0];
      if (!invocation) throw new Error("Missing fixture invocation");
      invocation.stageOrdinal = 999;
    },
    (_m: PortableManifest, p: RunPayloadV1) => {
      p.commits = [];
    },
    (_m: PortableManifest, p: RunPayloadV1) => {
      p.state.slottedCommands = [];
    },
    (m: PortableManifest) => {
      Object.assign(m, { schema: 2, blobs: { ...m.blobs, artifacts: [{ ...m.blobs.state }] } });
    },
    (m: PortableManifest) => {
      m.runId = "another1";
    },
  ];
  for (const change of corruptions) {
    const input = edit(c, change);
    // Descriptor edits must happen after the helper regenerates state descriptors.
    if (change === corruptions[0] || change === corruptions[1]) {
      const m = JSON.parse(input.manifest) as PortableManifest;
      change(m, c.payload);
      input.manifest = formatManifest(m);
    }
    await rejected(api.importRun(input, signal()));
    expect(api.deps.objects.validate).toHaveBeenCalledTimes(1);
    expect(snapshot(api.target)).toEqual(before);
  }
  for (const variant of ["missing", "extra", "same-size", "version", "syntax"] as const) {
    const input = edit(c, () => {});
    if (variant === "missing") input.blobs.delete(input.blobs.keys().next().value ?? "");
    if (variant === "extra") input.blobs.set("f".repeat(32), new Uint8Array());
    if (variant === "same-size") {
      const b = input.blobs.values().next().value;
      if (b) b[0] = (b[0] ?? 0) ^ 1;
    }
    if (variant === "version") input.manifest = input.manifest.replace('"schema":3', '"schema":4');
    if (variant === "syntax") input.manifest = "{";
    await rejected(api.importRun(input, signal()));
    expect(snapshot(api.target)).toEqual(before);
  }
});

test.each([false, true])(
  "validation dependencies reject before objects on export and import (owner=%s)",
  async (owner) => {
    const f = source(true, "build", owner),
      api = facade(f),
      c = await api.exportRun(f.runId, repository, signal());
    const before = snapshot(api.target);
    await rejected(
      api.importRun(
        edit(c, (_m, p) => {
          (owner && p.followUp ? p.followUp.owner : p.run).dependsOn = ["another1"];
        }),
        signal(),
      ),
      "unsupported",
    );
    f.s.db
      .query("UPDATE runs SET depends_on = '[\"another1\"]' WHERE id = ?")
      .run(owner ? f.ownerId : f.runId);
    await rejected(api.exportRun(f.runId, repository, signal()), "unsupported");
    expect(api.deps.objects.export).toHaveBeenCalledTimes(1);
    expect(api.deps.objects.validate).toHaveBeenCalledTimes(1);
    expect(snapshot(api.target)).toEqual(before);
  },
);

test("validation snapshots caller buffers and descriptors before awaiting", async () => {
  const f = source(),
    api = facade(f),
    c = await api.exportRun(f.runId, repository, signal());
  const started = deferred(),
    finish = deferred(),
    validate = api.deps.objects.validate;
  api.deps.objects.validate = async (...args) => {
    started.resolve();
    await finish.promise;
    await validate(...args);
  };
  const expected = structuredClone(c),
    pending = api.importRun(c, signal());
  await started.promise;
  c.manifest = "{}";
  for (const b of c.blobs.values()) b.fill(0);
  (c.blobs as Map<string, Uint8Array>).clear();
  finish.resolve();
  await pending;
  expect(await facade({ ...f, s: api.target }).exportRun(f.runId, repository, signal())).toEqual(expected);
});

test("noncanonical version-1 manifest is rejected before object validation or inspection", async () => {
  const f = source(),
    api = facade(f),
    c = await api.exportRun(f.runId, repository, signal());
  const input = edit(c, (m) => {
    m.schema = 1;
  });
  input.manifest = JSON.stringify(JSON.parse(input.manifest), null, 2);
  const before = snapshot(api.target),
    calls = (api.deps.objects.validate as ReturnType<typeof mock>).mock.calls.length,
    read = spyOn(reader, "read");
  await rejected(api.importRun(input, signal()));
  expect(snapshot(api.target)).toEqual(before);
  expect(api.deps.objects.validate).toHaveBeenCalledTimes(calls);
  expect(read).not.toHaveBeenCalled();
});

test("round-trip version-1 manifest bytes remain unchanged", async () => {
  const f = source(),
    api = facade(f),
    c = await api.exportRun(f.runId, repository, signal());
  const input = edit(c, (m) => {
    m.schema = 1;
  });
  await api.importRun(input, signal());
  const saved = await facade({ ...f, s: api.target }).exportRun(f.runId, repository, signal());
  expect(saved.manifest).toBe(input.manifest);
  expect(saved.blobs).toEqual(input.blobs);
  expect(saved.digest).toBe(transferHash(new TextEncoder().encode(input.manifest)));
});

test("privacy successful validation waits for cleanup and missing inspection fails closed", async () => {
  const f = source(),
    api = facade(f),
    c = await api.exportRun(f.runId, repository, signal());
  const cleaning = deferred(),
    cleaned = deferred();
  api.deps.objects.validate = async (_input, inspect) => {
    await inspect(reader);
    cleaning.resolve();
    await cleaned.promise;
  };
  let settled = false;
  const pending = api.importRun(c, signal()).then((result) => {
    settled = true;
    return result;
  });
  await cleaning.promise;
  expect(settled).toBe(false);
  expect(api.target.db.query("SELECT * FROM run_transfer_receipts").all()).toEqual([]);
  cleaned.resolve();
  await pending;
  const target = store(),
    missing = facade(f, target);
  missing.deps.objects.validate = async () => {};
  const before = snapshot(target);
  await rejected(missing.importRun(c, signal()), "incomplete");
  expect(snapshot(target)).toEqual(before);
});

test.each(["export", "import", "retained"] as const)(
  "privacy %s awaits inspection and validator cleanup on failure and abort",
  async (mode) => {
    const f = source(),
      api = facade(f),
      c = await api.exportRun(f.runId, repository, signal());
    if (mode === "retained") await api.importRun(c, signal());
    const active = mode === "retained" ? facade({ ...f, s: api.target }) : api;
    for (const abort of [false, true]) {
      const reading = deferred(),
        inspectDone = deferred(),
        cleaning = deferred(),
        cleaned = deferred();
      const control = new AbortController(),
        before = snapshot(active.target);
      const secret = ["private", "transfer-credential"].join("-");
      registerCredential("TRANSFER_TEST", secret);
      active.deps.objects.validate = async (_input, inspect) => {
        try {
          await inspect({
            ...reader,
            async read() {
              reading.resolve();
              await inspectDone.promise;
              return new TextEncoder().encode(secret);
            },
          });
        } finally {
          cleaning.resolve();
          await cleaned.promise;
        }
      };
      const operation =
        mode === "import"
          ? active.importRun(c, control.signal)
          : active.exportRun(f.runId, repository, control.signal);
      let settled = false;
      const result = operation.finally(() => {
        settled = true;
      });
      const check = result.then(
        () => null,
        (error: unknown) => error,
      );
      await reading.promise;
      if (abort) control.abort();
      await Promise.resolve();
      expect(settled).toBe(false);
      inspectDone.resolve();
      await cleaning.promise;
      expect(settled).toBe(false);
      expect(snapshot(active.target)).toEqual(before);
      cleaned.resolve();
      expect(await check).toMatchObject({ name: "RunTransferError", code: abort ? "aborted" : "invalid" });
      expect(snapshot(active.target)).toEqual(before);
    }
  },
);

test("privacy manifest scope controls expected refs for import and export", async () => {
  const f = source(),
    api = facade(f),
    validate = spyOn(api.deps.objects, "validate"),
    c = await api.exportRun(f.runId, repository, signal());
  const observed = validate.mock.calls[0]?.[0];
  expect(observed?.refs).toEqual(
    c.payload.commits.map((oid) => ({ name: `refs/limitless-run-objects/${f.runId}/${oid}`, oid })),
  );
  const before = snapshot(api.target);
  for (const scope of ["another1", "outside/scope"]) {
    const input = edit(c, () => {}),
      m = JSON.parse(input.manifest) as PortableManifest,
      ref = m.blobs.objects[0];
    const bytes = encodeTransferJson({
      refs: c.payload.commits.map((oid) => ({ name: `refs/limitless-run-objects/${scope}/${oid}`, oid })),
    });
    if (!ref) throw new Error("Missing fixture object descriptor");
    input.blobs.set(ref.key, bytes);
    ref.size = bytes.length;
    ref.digest = transferHash(bytes);
    input.manifest = formatManifest(m);
    await rejected(api.importRun(input, signal()), "invalid");
    expect(snapshot(api.target)).toEqual(before);
  }
  const exporting = api.deps.objects.export;
  api.deps.objects.export = async (...args) => {
    const b = await exporting(...args);
    if (b) b.bytes = encodeTransferJson({ refs: [] });
    return b;
  };
  await rejected(api.exportRun(f.runId, repository, signal()), "invalid");
});

test("concurrency independent facades converge, queued cancellation never executes, conflicts cannot overwrite", async () => {
  const f = source(),
    path = join(directory(), "offline.db"),
    api = facade(f, store(path)),
    other = facade(f, store(path));
  const c = await api.exportRun(f.runId, repository, signal()),
    started = deferred(),
    finish = deferred(),
    validate = api.deps.objects.validate;
  api.deps.objects.validate = async (...args) => {
    started.resolve();
    await finish.promise;
    await validate(...args);
  };
  const first = api.importRun(c, signal());
  await started.promise;
  const cancelled = new AbortController(),
    queued = other.importRun(c, cancelled.signal);
  cancelled.abort();
  await rejected(queued, "aborted");
  expect(other.deps.objects.validate).not.toHaveBeenCalled();
  const identical = other.importRun(c, signal()),
    conflict = other.importRun(
      edit(c, (_m, p) => {
        p.run.title = "Conflicting";
      }),
      signal(),
    );
  const conflictCheck = conflict.then(
    () => null,
    (error: unknown) => error,
  );
  finish.resolve();
  expect(await identical).toEqual(await first);
  expect(await conflictCheck).toMatchObject({ code: "conflict" });
  expect(other.deps.objects.validate).toHaveBeenCalledTimes(2);
  expect(api.target.db.query("SELECT run_id FROM run_transfer_receipts").all()).toHaveLength(1);
  expect(readOfflineProjection(api.target.db, f.runId)).toEqual(c.payload);
  expect(await other.importRun(c, signal())).toEqual(await first);
});

test("concurrency abort during validation, late conflicts and transaction failure leave no partial projection", async () => {
  const f = source(),
    api = facade(f),
    c = await api.exportRun(f.runId, repository, signal());
  const original = api.deps.objects.validate,
    started = deferred(),
    finish = deferred(),
    control = new AbortController(),
    before = snapshot(api.target);
  api.deps.objects.validate = async (...args) => {
    started.resolve();
    await finish.promise;
    await original(...args);
  };
  const pending = api.importRun(c, control.signal),
    check = pending.then(
      () => null,
      (error: unknown) => error,
    );
  await started.promise;
  control.abort();
  finish.resolve();
  expect(await check).toMatchObject({ code: "aborted" });
  expect(snapshot(api.target)).toEqual(before);
  api.deps.objects.validate = original;
  api.target.db.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON run_transfer_blobs BEGIN SELECT RAISE(ABORT, 'late failure'); END",
  );
  await rejected(api.importRun(c, signal()));
  expect(snapshot(api.target)).toEqual(before);
  api.target.db.exec("DROP TRIGGER fail_receipt");
  const inserted = deferred(),
    resume = deferred();
  api.deps.objects.validate = async (...args) => {
    inserted.resolve();
    await resume.promise;
    await original(...args);
  };
  const late = api.importRun(c, signal());
  await inserted.promise;
  const repo = api.target.upsertRepo({
    slug: "example/project",
    kind: "github",
    url: null,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "none",
  });
  const run = api.target.createRun(repo, { repo: repo.slug, prompt: "Late run" });
  api.target.db.query("UPDATE runs SET id = ? WHERE id = ?").run(f.runId, run.id);
  const occupied = snapshot(api.target);
  resume.resolve();
  await rejected(late, "conflict");
  expect(snapshot(api.target)).toEqual(occupied);
  api.target.db.query("DELETE FROM runs WHERE id = ?").run(f.runId);
  api.deps.objects.validate = original;
  await api.importRun(c, signal());
  expect(api.target.db.query("SELECT run_id FROM run_transfer_receipts").all()).toHaveLength(1);
});

test("isolation construction does no IO, rejects database aliases and leaves projections disconnected", async () => {
  const f = source(),
    api = facade(f),
    c = await api.exportRun(f.runId, repository, signal());
  const query = spyOn(f.s.db, "query").mockImplementation(() => {
    throw new Error("Construction IO");
  });
  createRunTransfer(api.deps);
  query.mockRestore();
  const before = snapshot(f.s);
  await rejected(facade(f, f.s).importRun(c, signal()), "conflict");
  expect(snapshot(f.s)).toEqual(before);
  const dir = directory(),
    path = join(dir, "source.db"),
    diskSource = store(path);
  diskSource.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  for (const kind of ["direct", "symlink", "hardlink"]) {
    const alias = kind === "direct" ? path : join(dir, kind);
    if (kind === "symlink") symlinkSync(path, alias);
    if (kind === "hardlink") linkSync(path, alias);
    const isolated = facade({ ...f, s: diskSource }, store(alias));
    await rejected(isolated.importRun(c, signal()), "conflict");
    expect(isolated.deps.objects.validate).not.toHaveBeenCalled();
  }
  const forbidden = [
    "createRun",
    "updateRun",
    "setRunState",
    "startStage",
    "createInvocation",
    "askQuestion",
    "beginLeaseIntent",
  ] as const;
  for (const name of forbidden)
    spyOn(api.target, name).mockImplementation(() => {
      throw new Error("Activation forbidden");
    });
  const publish = mock();
  api.target.subscribe(publish);
  await api.importRun(c, signal());
  expect(publish).not.toHaveBeenCalled();
  expect(api.target.getRunState(f.runId)).toBeNull();
  expect(api.target.db.query("SELECT * FROM agent_jobs").all()).toEqual([]);
  expect(api.target.db.query("SELECT * FROM run_transfer_receipts").all()).toHaveLength(1);
});
