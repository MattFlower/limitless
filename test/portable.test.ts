import { expect, test } from "bun:test";
import type { Run } from "../src/core/types.ts";
import { linkedIssues, Store } from "../src/db/store.ts";
import { lifecycleMarker } from "../src/integrations/issue-lifecycle.ts";
import type { Phase } from "../src/pipeline/context.ts";
import { deliveryMarker } from "../src/pipeline/markers.ts";
import {
  type ClaimKey,
  claimKey,
  claimRef,
  commentMarkers,
  commentMatches,
  type EffectIntent,
  effectId,
  formatManifest,
  type ManifestV1,
  type ManifestV2,
  manifestDigest,
  parseManifest,
} from "../src/pipeline/portable.ts";
import { sh } from "../src/util/proc.ts";
import { feedRound } from "./feed-support.ts";

const id = "abc123";
const slug = "owner/repo";
const prUrl = `https://github.com/${slug}/pull/12`;
const sha40 = "a".repeat(40);
const sha64 = "b".repeat(64);
const digest = "0123456789abcdef".repeat(4);
const blob = { key: "0123456789abcdef0123456789abcdef", digest, size: 0 };
const run: Pick<Run, "id" | "repoSlug" | "sourceRef" | "source" | "prompt"> = {
  id,
  repoSlug: slug,
  sourceRef: null,
  source: "cli",
  prompt: "Work",
};
const intents = [
  { kind: "push", branch: "work/topic", to: sha40 },
  { kind: "pr-create", branch: "work/topic", base: "main" },
  { kind: "pr-edit", pr: 12, bodyDigest: digest },
  { kind: "comment", target: "issue", number: 12, family: "lifecycle", event: "started" },
  { kind: "label", issue: 12, label: "needs attention", add: true },
  { kind: "merge", pr: 12, sha: sha64 },
] as const satisfies readonly EffectIntent[];
function fixture() {
  const store = new Store(":memory:");
  const repo = store.upsertRepo({
    slug,
    kind: "github",
    url: `https://github.com/${slug}`,
    localPath: null,
    defaultBranch: "main",
    mergePolicy: "pr",
  });
  return { store, repo };
}
function manifest(): ManifestV1 {
  return {
    schema: 1,
    runId: id,
    key: { kind: "run", repo: slug, runId: id },
    generation: 0,
    sequence: 0,
    previous: null,
    baseSha: null,
    headSha: null,
    phase: "prepare",
    round: 0,
    createdBy: "mémber 🌱",
    blobs: { state: { ...blob }, artifacts: [], objects: [] },
    effects: [],
  };
}
function fullManifest(): ManifestV1 {
  return {
    ...manifest(),
    key: { kind: "pr", repo: slug, number: 12 },
    generation: 2,
    sequence: 3,
    previous: digest,
    baseSha: sha40,
    headSha: sha64,
    phase: "loop",
    round: 4,
    blobs: { state: { ...blob }, artifacts: [{ ...blob, size: 12 }], objects: [{ ...blob, size: 34 }] },
    effects: structuredClone(intents).map((intent, i) => ({
      id: effectId(id, intent),
      intent,
      state: i % 3 === 0 ? "pending" : i % 3 === 1 ? "uncertain" : "completed",
    })),
  };
}

test("stored review, CI and conflict rounds claim their PR before their owner's issue", () => {
  const { store, repo } = fixture();
  try {
    const owner = store.createRun(repo, {
      repo: slug,
      prompt: "Issue work",
      source: "github",
      sourceRef: { kind: "issue", repo: slug, number: 7 },
    });
    for (const [index, kind] of (["review", "ci", "conflict"] as const).entries()) {
      const round = feedRound(store, repo, owner, kind, index + 1);
      store.db.query("UPDATE review_rounds SET pr_url = ? WHERE run_id = ?").run(prUrl, round.id);
      expect(linkedIssues(round, store)).toEqual([{ repo: slug, number: 7 }]);
      expect(claimKey(round, store)).toEqual({ kind: "pr", repo: slug, number: 12 });
      // The stored round also wins over contradictory sourceRef authority.
      expect(
        claimKey({ ...round, sourceRef: { kind: "pull_request", repo: slug, number: 99 } }, store),
      ).toEqual({ kind: "pr", repo: slug, number: 12 });
      store.db.query("UPDATE review_rounds SET pr_url = ? WHERE run_id = ?").run("bad URL", round.id);
      expect(claimKey(round, store)).toEqual({ none: "not-github" });
    }
  } finally {
    store.close();
  }
});

test("sourceRef PR authority, then distinct linked issues, then run identity", () => {
  const { store, repo } = fixture();
  try {
    for (const kind of ["review", "ci", "conflict"]) {
      expect(
        claimKey(
          { ...run, prompt: "Closes #7", sourceRef: { kind: "review-round", kindOfRound: kind, prUrl } },
          store,
        ),
      ).toEqual({ kind: "pr", repo: slug, number: 12 });
    }
    expect(
      claimKey(
        { ...run, source: "github", sourceRef: { kind: "pull_request", repo: "OWNER/Repo", number: 12 } },
        store,
      ),
    ).toEqual({ kind: "pr", repo: slug, number: 12 });
    expect(
      claimKey({ ...run, source: "github", sourceRef: { kind: "issue", repo: slug, number: 7 } }, store),
    ).toEqual({ kind: "issue", repo: slug, number: 7 });
    expect(claimKey({ ...run, prompt: "Closes #7\nCloses #7" }, store)).toEqual({
      kind: "issue",
      repo: slug,
      number: 7,
    });
    expect(claimKey(run, store)).toEqual({ kind: "run", repo: slug, runId: id });
    expect(claimKey({ ...run, repoSlug: "OWNER/REPO" }, store)).toEqual({
      kind: "run",
      repo: slug,
      runId: id,
    });
    expect(claimKey({ ...run, prompt: "Closes #7\nCloses #8" }, store)).toEqual({ none: "several-issues" });
    store.upsertRepo({ ...repo, kind: "local", localPath: "local/repo", url: null });
    expect(claimKey({ ...run, sourceRef: { kind: "review-round", prUrl } }, store)).toEqual({
      none: "not-github",
    });
    expect(claimKey(run, store)).toEqual({ none: "not-github" });
  } finally {
    store.close();
  }
});

test("PR authority requires complete, same-repository positive safe-number metadata", () => {
  const { store } = fixture();
  try {
    for (const url of [
      undefined,
      null,
      12,
      "",
      `https://github.com/${slug}`,
      `https://github.com/${slug}/issues/12`,
      "https://github.com/other/repo/pull/12",
      `${prUrl}/files`,
      `${prUrl}?x=1`,
      `${prUrl}#x`,
      `https://github.com/${slug}?x=/pull/12`,
      `https://github.com/${slug}#/pull/12`,
      `${prUrl}\n`,
      `${prUrl}/extra/pull/13`,
      "https://example.com/owner/repo/pull/12",
      `https://github.com/${slug}/pull/0`,
      `https://github.com/${slug}/pull/01`,
      `https://github.com/${slug}/pull/9007199254740992`,
    ]) {
      expect(
        claimKey({ ...run, prompt: "Closes #7", sourceRef: { kind: "review-round", prUrl: url } }, store),
      ).toEqual({ none: "not-github" });
    }
    for (const ref of [
      { kind: "pull_request", repo: "other/repo", number: 12 },
      { kind: "pull_request", repo: slug, number: "12" },
      { kind: "pull_request", repo: slug, number: 1.5 },
      { kind: "pull_request", repo: slug, number: 0 },
      { kind: "pull_request", repo: slug, number: Number.MAX_SAFE_INTEGER + 1 },
      { kind: "pull_request", number: 12 },
      { kind: "pull_request", repo: slug },
    ])
      expect(claimKey({ ...run, sourceRef: ref }, store)).toEqual({ none: "not-github" });
    expect(
      claimKey(
        { ...run, sourceRef: { kind: "review-round", prUrl: "https://GITHUB.com/OWNER/Repo/pull/12/" } },
        store,
      ),
    ).toEqual({ kind: "pr", repo: slug, number: 12 });
  } finally {
    store.close();
  }
});

test("issue, PR and run refs are distinct valid Git refs and reject invalid keys", async () => {
  const keys: ClaimKey[] = [
    { kind: "issue", repo: slug, number: 12 },
    { kind: "pr", repo: slug, number: 12 },
    { kind: "run", repo: slug, runId: id },
  ];
  expect(keys.map(claimRef)).toEqual([
    "refs/limitless/claims/12",
    "refs/limitless/claims/pr-12",
    "refs/limitless/claims/run-abc123",
  ]);
  for (const key of keys) await sh(["git", "check-ref-format", claimRef(key)], { cwd: process.cwd() });
  for (const runId of ["short", "UPPER1", "abc/123", "a".repeat(41), "abc123\n"])
    expect(() => claimRef({ kind: "run", repo: slug, runId })).toThrow();
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => claimRef({ kind: "issue", repo: slug, number })).toThrow();
});

test("effect IDs are canonical and cover every logical intent field", () => {
  const cases: [EffectIntent, EffectIntent[]][] = [
    [
      intents[0],
      [
        { kind: "push", branch: "other", to: sha40 },
        { kind: "push", branch: "work/topic", to: sha64 },
      ],
    ],
    [
      intents[1],
      [
        { kind: "pr-create", branch: "other", base: "main" },
        { kind: "pr-create", branch: "work/topic", base: "other" },
      ],
    ],
    [
      intents[2],
      [
        { kind: "pr-edit", pr: 13, bodyDigest: digest },
        { kind: "pr-edit", pr: 12, bodyDigest: sha64 },
      ],
    ],
    [
      intents[3],
      [
        { kind: "comment", target: "pr", number: 12, family: "lifecycle", event: "started" },
        { kind: "comment", target: "issue", number: 13, family: "lifecycle", event: "started" },
        { kind: "comment", target: "issue", number: 12, family: "lifecycle", event: "failed" },
        { kind: "comment", target: "issue", number: 12, family: "verification" },
      ],
    ],
    [
      intents[4],
      [
        { kind: "label", issue: 13, label: "needs attention", add: true },
        { kind: "label", issue: 12, label: "different", add: true },
        { kind: "label", issue: 12, label: "needs attention", add: false },
      ],
    ],
    [
      intents[5],
      [
        { kind: "merge", pr: 13, sha: sha64 },
        { kind: "merge", pr: 12, sha: sha40 },
      ],
    ],
  ];
  const all = new Set<string>();
  for (const [intent, changes] of cases) {
    const expected = effectId(id, intent);
    expect(expected).toMatch(/^fx1-[0-9a-f]{32}$/);
    expect(effectId(id, Object.fromEntries(Object.entries(intent).reverse()) as EffectIntent)).toBe(expected);
    expect(effectId("def456", intent)).not.toBe(expected);
    for (const changed of changes) expect(effectId(id, changed)).not.toBe(expected);
    all.add(expected);
  }
  expect(all.size).toBe(6);
});

test("effect ID bytes agree across two local Bun processes", async () => {
  const code = `import { effectId } from './src/pipeline/portable.ts';
    console.log(effectId('abc123', { kind: 'label', issue: 12, label: 'mémber 🌱', add: true }));`;
  const a = await sh([process.execPath, "--eval", code], { cwd: process.cwd() });
  const b = await sh([process.execPath, "--eval", code], { cwd: process.cwd() });
  expect(a.stdout.trim()).toBe(effectId(id, { kind: "label", issue: 12, label: "mémber 🌱", add: true }));
  expect(b.stdout).toBe(a.stdout);
});

test.each([
  ["review-round", "review"],
  ["conflict-round", "conflict"],
  ["ci-round", "ci"],
  ["verification", "verification"],
] as const)("%s recognizes both delivery modes inside bodies", (family, kind) => {
  const intent = { kind: "comment", target: "pr", number: 12, family } as const;
  const markers = [deliveryMarker(kind, id).marker, deliveryMarker(kind, id, true).marker];
  expect(commentMarkers(id, intent)).toEqual(markers);
  for (const marker of markers) expect(commentMatches(id, intent, `before\n${marker}\nafter`)).toBe(true);
  for (const discreet of [false, true])
    expect(commentMatches(id, intent, deliveryMarker(kind, "def456", discreet).marker)).toBe(false);
  expect(commentMatches(id, intent, "ordinary comment")).toBe(false);
});

test.each(["started", "pr", "needs_human", "failed", "cancelled"] as const)(
  "lifecycle event %s keeps its exact published marker",
  (event) => {
    const intent = { kind: "comment", target: "issue", number: 7, family: "lifecycle", event } as const;
    const marker = `<!-- limitless-lifecycle:abc123:${event} -->`;
    expect(lifecycleMarker(id, event)).toBe(marker);
    expect(commentMarkers(id, intent)).toEqual([marker]);
    expect(commentMatches(id, intent, `before\n${marker}\nafter`)).toBe(true);
    expect(commentMatches(id, intent, lifecycleMarker("def456", event))).toBe(false);
    expect(commentMatches(id, intent, lifecycleMarker(id, event === "failed" ? "pr" : "failed"))).toBe(false);
  },
);

test("manifest round trip preserves every field, intent and effect state", () => {
  const m = fullManifest();
  expect(parseManifest(formatManifest(m))).toEqual(m);
  expect(formatManifest(m)).not.toContain("\n");
  for (const key of [
    { kind: "issue", repo: slug, number: 12 },
    { kind: "run", repo: slug, runId: id },
  ] as const)
    expect(parseManifest(formatManifest({ ...m, key }))).toEqual({ ...m, key });
});

test("manifest version 2 round trips every current phase without conversion", () => {
  const phases: Phase[] = ["prepare", "triage", "clarify", "spec", "loop", "deliver", "accept", "done"];
  for (const phase of phases) {
    const m: ManifestV2 = { ...fullManifest(), schema: 2, phase };
    expect(parseManifest(formatManifest(m))).toEqual(m);
    expect(manifestDigest(m)).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestDigest(m)).not.toBe(manifestDigest({ ...m, schema: 1, phase: "prepare" }));
  }
  expect(parseManifest(JSON.stringify({ ...manifest(), phase: "accept" }))).toBe("malformed");
  expect(() => formatManifest({ ...manifest(), phase: "accept" } as unknown as ManifestV1)).toThrow();
  expect(() =>
    formatManifest({ ...manifest(), schema: 2, phase: "sentinel" } as unknown as ManifestV2),
  ).toThrow("Run transfer data is invalid");
});

// Independently specified sorted JSON; digest calculated with Python hashlib.sha256 over UTF-8.
const canonicalFixture =
  '{"baseSha":null,"blobs":{"artifacts":[],"objects":[],"state":{"digest":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","key":"0123456789abcdef0123456789abcdef","size":0}},"createdBy":"mémber 🌱","effects":[],"generation":0,"headSha":null,"key":{"kind":"run","repo":"owner/repo","runId":"abc123"},"phase":"prepare","previous":null,"round":0,"runId":"abc123","schema":1,"sequence":0}';
test("canonical manifest has fixed platform-independent UTF-8 bytes and digest", () => {
  expect(formatManifest(manifest())).toBe(canonicalFixture);
  expect(manifestDigest(manifest())).toBe("7dae3026e4e9c02a60a6c132cb596c490d954e7579d9197f6ef119a7e544a1b0");
  const m = fullManifest();
  const reversed = JSON.parse(
    JSON.stringify(m, (_key, value: unknown) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    ),
  ) as ManifestV1;
  expect(formatManifest(reversed)).toBe(formatManifest(m));
  expect(manifestDigest(reversed)).toBe(manifestDigest(m));
  for (const changed of [
    { ...m, createdBy: "other" },
    { ...m, generation: 3 },
    { ...m, previous: sha64 },
    { ...m, headSha: sha40 },
    { ...m, effects: [...m.effects].reverse() },
    { ...m, blobs: { ...m.blobs, state: { ...blob, size: 1 } } },
  ])
    expect(manifestDigest(changed)).not.toBe(manifestDigest(m));
});

type Edit = { path: string[]; value?: unknown; remove?: boolean };
const invalid: [string, Edit][] = [
  ["extra root", { path: ["extra"], value: true }],
  ["extra claim", { path: ["key", "extra"], value: true }],
  ["extra blobs", { path: ["blobs", "extra"], value: true }],
  ["extra blob ref", { path: ["blobs", "state", "extra"], value: true }],
  ["extra artifact", { path: ["blobs", "artifacts", "0", "extra"], value: true }],
  ["extra object", { path: ["blobs", "objects", "0", "extra"], value: true }],
  ["extra effect", { path: ["effects", "0", "extra"], value: true }],
  ...intents.map((_, i): [string, Edit] => [
    `extra intent ${i}`,
    { path: ["effects", String(i), "intent", "extra"], value: true },
  ]),
  ...["previous", "baseSha", "headSha", "runId", "createdBy"].map((field): [string, Edit] => [
    `missing ${field}`,
    { path: [field], remove: true },
  ]),
  ["missing state ref", { path: ["blobs", "state"], remove: true }],
  ["missing artifacts", { path: ["blobs", "artifacts"], remove: true }],
  ["missing blob digest", { path: ["blobs", "state", "digest"], remove: true }],
  ["missing claim number", { path: ["key", "number"], remove: true }],
  ["missing effect state", { path: ["effects", "0", "state"], remove: true }],
  ["missing intent field", { path: ["effects", "0", "intent", "to"], remove: true }],
  ...["generation", "sequence", "round"].flatMap((field): [string, Edit][] => [
    [`fractional ${field}`, { path: [field], value: 1.5 }],
    [`negative ${field}`, { path: [field], value: -1 }],
    [`unsafe ${field}`, { path: [field], value: Number.MAX_SAFE_INTEGER + 1 }],
  ]),
  ...["baseSha", "headSha", "previous"].map((field): [string, Edit] => [
    `bad ${field}`,
    { path: [field], value: "bad" },
  ]),
  ["invalid run ID", { path: ["runId"], value: "ABC123" }],
  ["unknown phase", { path: ["phase"], value: "implement" }],
  ["bad blob key", { path: ["blobs", "state", "key"], value: "a".repeat(31) }],
  ["bad blob digest", { path: ["blobs", "state", "digest"], value: sha40 }],
  ["fractional blob size", { path: ["blobs", "state", "size"], value: 1.5 }],
  ["negative blob size", { path: ["blobs", "state", "size"], value: -1 }],
  ["invalid effect ID", { path: ["effects", "0", "id"], value: "fx2-abc" }],
  ["unknown state", { path: ["effects", "0", "state"], value: "done" }],
  ["invalid branch", { path: ["effects", "0", "intent", "branch"], value: "bad..branch" }],
  ["invalid push SHA", { path: ["effects", "0", "intent", "to"], value: "bad" }],
  ["invalid base", { path: ["effects", "1", "intent", "base"], value: "-bad" }],
  ["invalid body digest", { path: ["effects", "2", "intent", "bodyDigest"], value: sha40 }],
  ["invalid PR number", { path: ["effects", "2", "intent", "pr"], value: 0 }],
  ["invalid event", { path: ["effects", "3", "intent", "event"], value: "done" }],
  ["missing lifecycle event", { path: ["effects", "3", "intent", "event"], remove: true }],
  ["delivery event", { path: ["effects", "3", "intent", "family"], value: "review-round" }],
  ["invalid family", { path: ["effects", "3", "intent", "family"], value: "review" }],
  ["invalid target", { path: ["effects", "3", "intent", "target"], value: "repo" }],
  ["fractional comment number", { path: ["effects", "3", "intent", "number"], value: 1.5 }],
  ["invalid issue number", { path: ["effects", "4", "intent", "issue"], value: -1 }],
  ["coerced boolean", { path: ["effects", "4", "intent", "add"], value: "true" }],
  ["invalid merge SHA", { path: ["effects", "5", "intent", "sha"], value: "g".repeat(40) }],
  ["unsafe claim number", { path: ["key", "number"], value: Number.MAX_SAFE_INTEGER + 1 }],
];
test.each(invalid)("manifest rejects %s", (_name, edit) => {
  const m = fullManifest();
  let parent: Record<string, unknown> = m;
  const path = [...edit.path];
  const field = path.pop();
  if (field === undefined) throw new Error("empty edit path");
  for (const segment of path) parent = parent[segment] as Record<string, unknown>;
  if (edit.remove) delete parent[field];
  else parent[field] = edit.value;
  expect(parseManifest(JSON.stringify(m))).toBe("malformed");
  expect(parseManifest(JSON.stringify({ ...m, schema: 2 }))).toBe("malformed");
});

test("parser inspects numeric versions before validating and never coerces schema", () => {
  for (const text of ["{", "null", "[]", "true", "1", "{}", '{"schema":"1"}', '{"schema":"2"}'])
    expect(parseManifest(text)).toBe("malformed");
  expect(parseManifest('{"schema":2}')).toBe("malformed");
  for (const schema of ["1", "2"])
    expect(parseManifest(JSON.stringify({ ...manifest(), schema }))).toBe("malformed");
  expect(parseManifest(JSON.stringify({ ...fullManifest(), schema: 2, extra: "future" }))).toBe("malformed");
  expect(parseManifest('{"schema":3}')).toEqual({ unsupported: 3 });
  expect(parseManifest(JSON.stringify({ schema: -2.5, extra: "future" }))).toEqual({
    unsupported: -2.5,
  });
});

test("valid manifest boundaries include both SHA lengths, run ID limits and maximum safe counters", () => {
  for (const phase of ["prepare", "triage", "clarify", "spec", "loop", "deliver", "done"] as const) {
    const m = { ...fullManifest(), phase, generation: Number.MAX_SAFE_INTEGER };
    expect(parseManifest(formatManifest(m))).toEqual(m);
  }
  for (const runId of ["a".repeat(6), "z".repeat(40)]) {
    const m = { ...manifest(), runId, key: { kind: "run", repo: slug, runId } as const };
    expect(parseManifest(formatManifest(m))).toEqual(m);
  }
  expect(
    parseManifest(JSON.stringify({ ...manifest(), key: { kind: "run", repo: slug, runId: "short" } })),
  ).toBe("malformed");
});
