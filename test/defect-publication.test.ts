import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Repo } from "../src/core/types.ts";
import { loadPrivateStrings, PrivateError } from "../src/gates/private.ts";
import { checkPublicationText } from "../src/gates/publication.ts";
import {
  type DefectEvidence,
  type DefectItem,
  type DefectPreparationDeps,
  defectRecordStatus,
  guardDefectPublication,
  lookupDefectIssue,
  parseDefectEnvelope,
  prepareDefectPublication,
} from "../src/integrations/defect-publication.ts";
import type { GitHubIdentity } from "../src/integrations/github-identity.ts";

const app: GitHubIdentity = { kind: "app", botLogin: "factory[bot]", token: "unused" };
const repo: Repo = {
  id: "opaque-source",
  kind: "github",
  slug: "Example/Product",
  url: null,
  localPath: null,
  defaultBranch: "main",
  mergePolicy: "pr",
  createdAt: 1,
};
const finding: DefectEvidence = {
  sourceId: repo.id,
  detector: "gate",
  class: "setup",
  phase: "check",
  checkIdentity: "lint",
};
const refused = { status: "blocked", diagnostic: "Defect publication blocked" } as const;
function deps(overrides: Partial<DefectPreparationDeps> = {}): DefectPreparationDeps {
  return {
    factory: "Operator/Factory",
    repos: [repo],
    policy: async () => ({ discreet: false }),
    identity: async () => app,
    loadPrivateStrings: () => [],
    registeredCredentials: () => [],
    ...overrides,
  };
}
async function prepared(input: DefectEvidence = finding, overrides: Partial<DefectPreparationDeps> = {}) {
  const result = await prepareDefectPublication(input, deps(overrides));
  if (result.status !== "prepared") throw new Error("Expected a prepared publication");
  return result;
}
const hash = (detector: string, kind: string, source: string, cls: string, phase: string, check: string) =>
  createHash("sha256")
    .update(JSON.stringify(["defect/1", detector, [kind, source], cls, phase, check]))
    .digest("hex");
const suppliedData = (body: string) => JSON.parse(body.split("\n").at(-2) ?? "");

test("canonical array hashing excludes occurrence evidence and preserves exact components", async () => {
  const first = await prepared();
  expect(first.signature).toBe(hash("gate", "github", "example/product", "setup", "check", "lint"));
  const second = await prepared({
    ...finding,
    shas: ["a".repeat(40)],
    runRefs: ["run-2"],
    landRefs: ["land-2"],
    timestamps: ["2026-10-01T00:00:00Z"],
    checkedPrContext: [42],
    machineRole: "worker",
    history: ["load"],
  });
  expect(second.signature).toBe(first.signature);
  expect(second.occurrence).toMatch(/^[a-f0-9]{32}$/);
  expect(second.occurrence).not.toBe(first.occurrence);
  for (const change of [
    { detector: "land" },
    { class: "load" },
    { phase: "setup" as const },
    { checkIdentity: "lint " },
    { checkIdentity: " lint" },
    { checkIdentity: "é" },
    { checkIdentity: "e\u0301" },
  ])
    expect((await prepared({ ...finding, ...change })).signature).not.toBe(first.signature);
  expect((await prepared({ ...finding, checkIdentity: "é" })).signature).not.toBe(
    (await prepared({ ...finding, checkIdentity: "e\u0301" })).signature,
  );
  expect((await prepared(finding, { repos: [{ ...repo, slug: "example/other" }] })).signature).not.toBe(
    first.signature,
  );
  const local = await prepared(finding, { repos: [{ ...repo, kind: "local", slug: "example/product" }] });
  expect(local.signature).toBe(hash("gate", "local", repo.id, "setup", "check", "lint"));
  // Phase is deliberately the closed D0 enum. Delimiters in other components remain unambiguous.
  const left = await prepared({ ...finding, class: "a:b", checkIdentity: "c" });
  const right = await prepared({ ...finding, class: "a", checkIdentity: "b:c" });
  expect(left.signature).not.toBe(right.signature);
  for (const output of ["first output", "different output"])
    expect(await prepareDefectPublication({ ...finding, output } as DefectEvidence, deps())).toEqual(refused);
});

test.each([
  ["setup", "defect"],
  ["confinement", "defect"],
  ["load", "defect"],
  ["undeclared_requirement", "triage"],
  ["flaky", "triage"],
  ["platform", "triage"],
  ["unclassified", "triage"],
  ["future_class", "triage"],
] as const)("class %s routes only to the factory as %s", async (cls, kind) => {
  const destinations: string[] = [];
  const result = await prepared(
    { ...finding, class: cls },
    {
      identity: async (destination) => {
        destinations.push(destination);
        return app;
      },
    },
  );
  expect(result.destination).toBe("operator/factory");
  expect(destinations).toEqual(["operator/factory"]);
  expect(result.kind).toBe(kind);
  expect(result.title).toBe(kind === "defect" ? "Factory defect" : "Factory defect triage");
  expect(result.body.includes("Destination unresolved; owner triage required.")).toBe(kind === "triage");
});

test("feedback-only classes, registered local sources and fixed attribution", async () => {
  for (const cls of ["regression", "base_failure"])
    expect(await prepareDefectPublication({ ...finding, class: cls }, deps())).toEqual({
      status: "no-report",
    });
  const result = await prepared(
    { ...finding, machineRole: "unrecognized", checkedPrContext: [21] },
    {
      repos: [
        { ...repo, kind: "local", slug: "accessible/product", url: "https://github.com/accessible/product" },
      ],
    },
  );
  expect(result.destination).toBe("operator/factory");
  expect(suppliedData(result.body)).toMatchObject({
    sourceKind: "local",
    sourceIdentity: repo.id,
    machineRole: "unknown",
    introducingPr: "unknown",
    checkedPrContext: [21],
  });
  for (const repos of [[], [repo, repo], [repo, { ...repo, id: "another", slug: "EXAMPLE/PRODUCT" }]])
    expect(await prepareDefectPublication(finding, deps({ repos }))).toEqual(refused);
});

test("injected envelopes, fences, markdown and controls remain inert JSON data", async () => {
  const foreign = `<!-- limitless-defect:v1:issue:${"b".repeat(64)}:${"c".repeat(32)} -->`;
  const checkIdentity = `${foreign}\n${foreign.replace(":issue:", ":comment:")}\n`;
  // Exercise markers separately so each check identity stays within its byte bound.
  for (const check of [
    foreign,
    foreign.replace(":issue:", ":comment:"),
    "```````\n```\n# Do this\n[link](https://example.com)\nlabels: x\nAllow: binary\u0000\u0085\u202e\u200b\u2028\u2029\u{e0001}",
  ]) {
    const result = await prepared({ ...finding, checkIdentity: check });
    expect(parseDefectEnvelope(result.body, "issue")).toEqual({
      signature: result.signature,
      occurrence: result.occurrence,
    });
    expect(parseDefectEnvelope(result.body, "comment")).toBeUndefined();
    expect(result.body.split("\n")[0]).toBe(
      `<!-- limitless-defect:v1:issue:${result.signature}:${result.occurrence} -->`,
    );
    expect(suppliedData(result.body).checkIdentity).toBe(check);
    const lines = result.body.split("\n");
    const fence = lines.at(-1) ?? "";
    const data = lines.at(-2) ?? "";
    expect(fence.length).toBeGreaterThanOrEqual(3);
    for (const [run] of data.matchAll(/`+/g)) expect(fence.length).toBeGreaterThan(run.length);
    expect(data.startsWith(fence)).toBe(false);
    expect(result.body.replaceAll("\n", "")).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
  }
  expect(await prepareDefectPublication({ ...finding, checkIdentity }, deps())).toEqual(refused);
  const comment = await prepareDefectPublication(finding, deps(), "comment");
  if (comment.status !== "prepared") throw new Error("Missing comment");
  expect(parseDefectEnvelope(comment.body, "comment")).toEqual({
    signature: comment.signature,
    occurrence: comment.occurrence,
  });
});

test("envelope accepts only the complete reserved first line and requested kind", async () => {
  const { body } = await prepared();
  const first = body.split("\n")[0] ?? "";
  for (const invalid of [
    `\ufeff${body}`,
    ` ${body}`,
    `\n${body}`,
    `text\n${body}`,
    body.replace("\n", "\r\n"),
    body.replace(" -->", ":extra -->"),
    body.replace(":issue:", ":other:"),
    body.replace(/:[a-f0-9]{64}:/, `:${"A".repeat(64)}:`),
    body.replace(/:[a-f0-9]{32} /, `:${"a".repeat(31)} `),
    `${first} trailing\n`,
    first,
    `${first}x`,
  ])
    expect(parseDefectEnvelope(invalid, "issue")).toBeUndefined();
});

test("strict allowlist and all component, identity and reference bounds refuse without clipping", async () => {
  const invalid: unknown[] = [
    { ...finding, sourceId: "" },
    { ...finding, sourceId: undefined },
    { ...finding, checkIdentity: " " },
    { ...finding, detector: "d".repeat(33) },
    { ...finding, detector: "non ascii é" },
    { ...finding, detector: "gate.bad" },
    { ...finding, class: "c".repeat(65) },
    { ...finding, checkIdentity: "é".repeat(129) },
    { ...finding, checkIdentity: "prefix [REDACTED]" },
    { ...finding, checkIdentity: "[redacted diagnostic]" },
    { ...finding, phase: "other" },
    { ...finding, runRefs: ["x".repeat(257)] },
    { ...finding, runRefs: Array(9).fill("run") },
    { ...finding, checkedPrContext: Array(9).fill(1) },
    { ...finding, history: Array(9).fill("load") },
    { ...finding, timestamps: Array(9).fill("2026-10-01T00:00:00Z") },
    { ...finding, reason: "diagnostic" },
    { ...finding, introducingPr: 42 },
    { ...finding, command: "echo anything" },
  ];
  for (const input of invalid)
    expect(await prepareDefectPublication(input as DefectEvidence, deps())).toEqual(refused);
  for (const source of [
    { ...repo, slug: "bad//slug" },
    { ...repo, slug: "example/.." },
    { ...repo, slug: `example/${"r".repeat(250)}` },
    { ...repo, kind: "local" as const, id: "x".repeat(257) },
    { ...repo, kind: "local" as const, id: "[redacted]" },
  ])
    expect(
      await prepareDefectPublication({ ...finding, sourceId: source.id }, deps({ repos: [source] })),
    ).toEqual(refused);
  const accepted = await prepared({
    ...finding,
    detector: "d".repeat(32),
    class: "x".repeat(64),
    checkIdentity: "é".repeat(128),
    runRefs: Array(8).fill("r"),
  });
  expect(suppliedData(accepted.body).checkIdentity).toBe("é".repeat(128));
});

test("full rendered byte budget refuses expansion even though individual values fit", async () => {
  const expanded = "\u0001".repeat(256);
  const input = {
    ...finding,
    sourceId: expanded,
    class: "\u0001".repeat(64),
    checkIdentity: expanded,
    runRefs: Array(8).fill(expanded),
    landRefs: Array(8).fill(expanded),
    history: Array(8).fill("\u0001".repeat(64)),
    shas: Array(8).fill("a".repeat(64)),
    timestamps: Array(8).fill(`2026-10-01T00:00:00.${"0".repeat(235)}Z`),
  };
  // All values fit their field limits; JSON escaping expands the complete projection beyond 32 KiB.
  expect(
    await prepareDefectPublication(input, deps({ repos: [{ ...repo, kind: "local", id: expanded }] })),
  ).toEqual(refused);
  const payload = await prepared();
  expect(guardDefectPublication({ ...payload, title: "x".repeat(32769) }, deps())).toEqual(refused);
});

test("source and destination policy and App-only identity fail closed", async () => {
  const cases: Partial<DefectPreparationDeps>[] = [
    { policy: async (value) => ({ discreet: typeof value !== "string" }) },
    { policy: async (value) => ({ discreet: typeof value === "string" }) },
    { policy: async (value) => (typeof value === "string" ? { discreet: false } : undefined) },
    {
      policy: async () => {
        throw new Error("sensitive policy failure");
      },
    },
    { identity: async () => ({ kind: "owner" }) },
    { identity: async () => undefined },
    {
      identity: async () => {
        throw new Error("sensitive identity failure");
      },
    },
    { identity: async () => ({ kind: "app", token: "unused", botLogin: "" }) },
    { factory: "https://github.com/operator/factory" },
  ];
  for (const override of cases)
    expect(await prepareDefectPublication(finding, deps(override))).toEqual(refused);
});

const encodings = [
  (s: string) => Array.from(s, (c) => `%${c.charCodeAt(0).toString(16)}`).join(""),
  (s: string) => Array.from(s, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  (s: string) => Array.from(s, (c) => `&#${c.charCodeAt(0)};`).join(""),
  (s: string) => Buffer.from(s).toString("base64"),
];
test("both privacy registries cover supported decoding including credential-aware base64", async () => {
  const secret = ["synthetic", "guard", "value"].join("-");
  for (const registry of ["policy", "credential"]) {
    const options =
      registry === "policy"
        ? { loadPrivateStrings: () => [{ value: secret, entry: 8 }] }
        : { registeredCredentials: () => [secret] };
    for (const encode of encodings) {
      const checkIdentity = encode(secret);
      expect(checkIdentity).not.toContain(secret);
      expect(await prepareDefectPublication({ ...finding, checkIdentity }, deps(options))).toEqual(refused);
    }
  }
  // Guarding the final projection also protects fixed titles and prose.
  expect(
    await prepareDefectPublication(
      finding,
      deps({ registeredCredentials: () => ["Recorded factory defect."] }),
    ),
  ).toEqual(refused);
});

test("decoder refusal and unavailable privacy sources expose only the fixed refusal", async () => {
  let nested = "%41";
  for (let i = 0; i < 6; i++) nested = nested.replaceAll("%", "%25");
  for (const load of [
    () => {
      throw new PrivateError("sensitive private failure");
    },
    () => {
      throw new Error("sensitive generic failure");
    },
  ])
    expect(await prepareDefectPublication(finding, deps({ loadPrivateStrings: load }))).toEqual(refused);
  expect(await prepareDefectPublication({ ...finding, checkIdentity: nested }, deps())).toEqual(refused);
  expect(
    await prepareDefectPublication(
      finding,
      deps({
        registeredCredentials: () => {
          throw new Error("unavailable registry");
        },
      }),
    ),
  ).toEqual(refused);
  const dir = mkdtempSync(join(tmpdir(), "defect-policy-"));
  try {
    expect((await prepared(finding, { loadPrivateStrings: () => loadPrivateStrings(dir) })).status).toBe(
      "prepared",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logical codec values catch quote, backslash and newline secrets hidden by rendering", async () => {
  for (const separator of ['"', "\\", "\n"]) {
    const value = ["synthetic", "value"].join(separator);
    const clean = await prepared({ ...finding, checkIdentity: value });
    expect(suppliedData(clean.body).checkIdentity).toBe(value);
    if (separator === '"') {
      // This establishes the non-tautological gap: final rendering alone does not catch JSON quotes.
      expect(() =>
        checkPublicationText(`${clean.title}\n${clean.body}`, "test", [{ value, entry: 1 }]),
      ).not.toThrow();
    }
    for (const overrides of [
      { registeredCredentials: () => [value] },
      { loadPrivateStrings: () => [{ value, entry: 3 }] },
    ])
      expect(await prepareDefectPublication({ ...finding, checkIdentity: value }, deps(overrides))).toEqual(
        refused,
      );
    expect(guardDefectPublication(clean, deps({ registeredCredentials: () => [value] }))).toEqual(refused);
  }
});

async function issue(overrides: Partial<DefectItem> = {}): Promise<DefectItem> {
  return {
    number: 10,
    body: (await prepared()).body,
    createdAt: "2026-10-01T00:00:00Z",
    author: { login: "FACTORY[bot]", type: "Bot" },
    lastEditedAt: null,
    includesCreatedEdit: false,
    ...overrides,
  };
}
test("lookup lists every issue page including closed issues and excludes PRs and copies", async () => {
  const valid = await issue();
  const signature = parseDefectEnvelope(valid.body, "issue")?.signature ?? "";
  const person = { ...valid, author: { login: "person", type: "User" } };
  const calls: unknown[] = [];
  const result = await lookupDefectIssue("Operator/Factory", app, signature, async (destination, options) => {
    calls.push([destination, options.state, options.page, options.perPage]);
    return options.page === 1
      ? Array.from({ length: 100 }, (_, i) => ({ ...person, number: i + 20 }))
      : [
          { ...valid, number: 1, pull_request: {} },
          { ...valid, number: 2, body: `text\n${valid.body}` },
          { ...valid, state: "closed" },
        ];
  });
  expect(calls).toEqual([
    ["operator/factory", "all", 1, 100],
    ["operator/factory", "all", 2, 100],
  ]);
  expect(result).toEqual({ status: "found", issue: valid });
  expect(
    await lookupDefectIssue("operator/factory", app, signature, async () => [
      person,
      { ...valid, body: `data\n${valid.body}` },
    ]),
  ).toEqual({ status: "absent" });
});

test("edited or provenance-missing App candidates block creation even alongside a valid match", async () => {
  const valid = await issue();
  const signature = parseDefectEnvelope(valid.body, "issue")?.signature ?? "";
  for (const provenance of [
    { lastEditedAt: "2026-10-02T00:00:00Z" },
    { lastEditedAt: undefined },
    { includesCreatedEdit: true },
    { includesCreatedEdit: undefined },
    { includesCreatedEdit: null },
  ]) {
    expect(
      await lookupDefectIssue("operator/factory", app, signature, async () => [{ ...valid, ...provenance }]),
    ).toEqual({ status: "blocked" });
    expect(
      await lookupDefectIssue("operator/factory", app, signature, async () => [
        valid,
        { ...valid, number: 11, ...provenance },
      ]),
    ).toEqual({ status: "blocked" });
  }
});

test("lookup picks oldest creation time then number and emits only a fixed duplicate diagnostic", async () => {
  const newer = await issue();
  const oldest = { ...newer, number: 12, createdAt: "2026-09-01T00:00:00Z" };
  const signature = parseDefectEnvelope(newer.body, "issue")?.signature ?? "";
  const result = await lookupDefectIssue("operator/factory", app, signature, async () => [
    newer,
    { ...oldest, number: 13 },
    oldest,
  ]);
  expect(result).toEqual({ status: "found", issue: oldest, diagnostic: "Duplicate defect issues" });
});

test("partial pagination, malformed pages and aborts cannot establish absence or a match", async () => {
  const valid = await issue();
  const signature = parseDefectEnvelope(valid.body, "issue")?.signature ?? "";
  for (const later of [null, {}, [{ number: 1 }], "unparsed", undefined])
    expect(
      await lookupDefectIssue("operator/factory", app, signature, async (_repo, { page }) =>
        page === 1 ? Array(100).fill(valid) : later,
      ),
    ).toEqual({ status: "unknown" });
  expect(
    await lookupDefectIssue("operator/factory", app, signature, async (_repo, { page }) => {
      if (page === 1) return Array(100).fill(valid);
      throw new Error("private page error");
    }),
  ).toEqual({ status: "unknown" });
  const controller = new AbortController();
  expect(
    await lookupDefectIssue(
      "operator/factory",
      app,
      signature,
      async () => {
        controller.abort();
        return [];
      },
      controller.signal,
    ),
  ).toEqual({ status: "unknown" });
  let called = false;
  expect(
    await lookupDefectIssue(
      "operator/factory",
      app,
      signature,
      async () => {
        called = true;
        return [];
      },
      controller.signal,
    ),
  ).toEqual({ status: "unknown" });
  expect(called).toBe(false);
  expect(await lookupDefectIssue("operator/factory", { kind: "owner" }, signature, async () => [])).toEqual({
    status: "unknown",
  });
  expect(await lookupDefectIssue("operator/factory", app, signature, async () => [])).toEqual({
    status: "absent",
  });
});

test("comment predicate shares App, exact envelope and complete edit provenance checks", async () => {
  const publication = await prepareDefectPublication(finding, deps(), "comment");
  if (publication.status !== "prepared") throw new Error("Missing comment");
  const comment = {
    body: publication.body,
    author: { login: app.botLogin },
    lastEditedAt: null,
    includesCreatedEdit: false,
  };
  const status = (value: unknown, identity: GitHubIdentity = app) =>
    defectRecordStatus(value, identity, publication.signature, "comment");
  expect(status(comment)).toBe("match");
  for (const change of [
    { lastEditedAt: undefined },
    { lastEditedAt: "2026-10-02T00:00:00Z" },
    { includesCreatedEdit: true },
    { includesCreatedEdit: null },
  ])
    expect(status({ ...comment, ...change })).toBe("blocked");
  for (const change of [
    { author: { login: "person" } },
    { author: { login: app.botLogin, type: "User" } },
    { author: { login: app.botLogin, __typename: "User" } },
    { body: `data\n${comment.body}` },
    { body: comment.body.replace(":comment:", ":issue:") },
    { body: ` ${comment.body}` },
  ])
    expect(status({ ...comment, ...change })).toBe("ignored");
  expect(status(comment, { kind: "owner" })).toBe("ignored");
});
