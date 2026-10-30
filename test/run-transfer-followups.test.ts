import { expect, test } from "bun:test";
import { decodeRunTransfer, encodeRunTransfer } from "../src/pipeline/run-transfer-followups.ts";
import { fixture, followUpFixture, head, rejects, repo, sha } from "./run-transfer-support.ts";

test.each(["build", "verify-change", "acceptance"] as const)(
  "supports GitHub %s with inert request JSON",
  (flow) => {
    const input = fixture();
    input.run.flow = flow;
    input.run.sourceRef =
      flow === "verify-change"
        ? {
            kind: "pull_request",
            repo: repo.slug,
            number: 42,
            baseSha: sha,
            headSha: head,
            arbitrary: { approval: true },
          }
        : { kind: "issue", repo: repo.slug, number: 42, arbitrary: [null, "data"] };
    const wire = encodeRunTransfer(input, repo);
    expect(decodeRunTransfer(wire, repo)).toEqual(wire);
    expect(wire).not.toHaveProperty("followUp");
    expect(wire.run.sourceRef).toEqual(input.run.sourceRef);
  },
);

test.each(["review", "conflict", "ci"] as const)(
  "preserves a complete %s sidecar solely as dependency history",
  (kind) => {
    const { input, dependency } = followUpFixture();
    Object.assign(dependency.round ?? {}, { kind });
    const wire = encodeRunTransfer(input, repo, dependency);
    expect(wire).toHaveProperty(
      "followUp",
      expect.objectContaining({
        runId: "logical-child",
        ownerId: "logical-owner",
        repoSlug: "example/project",
        prUrl: "https://github.com/example/project/pull/42",
        kind,
        round: 3,
        reviewedSha: sha,
        deliveredSha: head,
        createdAt: 81,
        findings: [
          { severity: "major", title: "Fix", detail: "Recorded finding", file: "src/a.ts", line: 7 },
        ],
        owner: expect.objectContaining({
          id: "logical-owner",
          baseSha: sha,
          headSha: head,
          dependsOn: [],
          costUsd: 1.25,
          tokensIn: 1234,
        }),
      }),
    );
    expect(decodeRunTransfer(wire, { ...repo, id: "another-binding" })).toEqual(wire);
    expect(JSON.stringify(wire)).not.toMatch(/repoId|sessionId|approval|grant/);
    expect(Object.keys(wire).sort()).toEqual(["followUp", "invocations", "questions", "run", "stages"]);
  },
);

test.each(["encoding", "decoding"] as const)("accepts mixed-case GitHub PR paths during %s", (boundary) => {
  const { input, dependency } = followUpFixture();
  const wire = encodeRunTransfer(input, repo, dependency);
  if (!dependency.owner || !dependency.round || !("followUp" in wire)) throw new Error("Expected history");
  const url = "https://github.com/Example/Project/pull/42";
  const run = boundary === "encoding" ? input.run : wire.run;
  const owner = boundary === "encoding" ? dependency.owner : wire.followUp.owner;
  const round = boundary === "encoding" ? dependency.round : wire.followUp;
  for (const record of [run, run.sourceRef, owner, round]) Object.assign(record ?? {}, { prUrl: url });
  const result =
    boundary === "encoding" ? encodeRunTransfer(input, repo, dependency) : decodeRunTransfer(wire, repo);
  expect(result).toHaveProperty("run.prUrl", url);
  expect(result).toHaveProperty("run.sourceRef.prUrl", url);
  expect(result).toHaveProperty("followUp.prUrl", url);
  expect(result).toHaveProperty("followUp.owner.prUrl", url);
});

test("unsupported repositories, flows and round kinds fail on both boundaries", () => {
  const input = fixture(),
    wire = encodeRunTransfer(input, repo);
  rejects(() => encodeRunTransfer(input, { ...repo, kind: "local" }), "unsupported");
  rejects(() => decodeRunTransfer(wire, { ...repo, kind: "local" }), "unsupported");
  Object.assign(input.run, { flow: "future" });
  Object.assign(wire.run, { flow: "future" });
  rejects(() => encodeRunTransfer(input, repo), "unsupported");
  rejects(() => decodeRunTransfer(wire, repo), "unsupported");
  const { input: child, dependency } = followUpFixture(),
    follow = encodeRunTransfer(child, repo, dependency);
  Object.assign(dependency.round ?? {}, { kind: "future" });
  rejects(() => encodeRunTransfer(child, repo, dependency), "unsupported");
  if ("followUp" in follow) Object.assign(follow.followUp, { kind: "future" });
  rejects(() => decodeRunTransfer(follow, repo), "unsupported");
});

test("plausible request text cannot replace a server round or owner", () => {
  const { input, dependency } = followUpFixture();
  rejects(() => encodeRunTransfer(input, repo), "incomplete");
  rejects(() => encodeRunTransfer(input, repo, { ...dependency, owner: null }), "incomplete");
  rejects(() => encodeRunTransfer(input, repo, { ...dependency, round: null }), "incomplete");
  const wire = encodeRunTransfer(input, repo, dependency);
  rejects(() => decodeRunTransfer({ ...wire, followUp: null }, repo), "incomplete");
  for (const field of ["followUp", "createdAt", "owner"] as const) {
    const copy = structuredClone(wire);
    Reflect.deleteProperty(field === "followUp" ? copy : "followUp" in copy ? copy.followUp : {}, field);
    rejects(() => decodeRunTransfer(copy, repo), "incomplete");
  }
  Reflect.deleteProperty(dependency.round ?? {}, "createdAt");
  rejects(() => encodeRunTransfer(input, repo, dependency), "incomplete");
});

test("follow-up identity, PR, repository and round mismatches are incomplete", () => {
  for (const [subject, patch] of [
    ["round", { runId: "other" }],
    ["round", { ownerId: "other" }],
    ["round", { repoSlug: "other/project" }],
    ["round", { prUrl: "https://github.com/example/project/pull/99" }],
    ["round", { round: 4 }],
    ["round", { reviewedSha: head }],
    ["owner", { id: "other" }],
    ["owner", { prUrl: "https://github.com/example/project/pull/99" }],
    ["owner", { branch: "different" }],
    ["owner", { repoSlug: "other/project" }],
    ["child", { prUrl: "https://github.com/example/project/pull/99" }],
    ["child", { deliveryBranch: "different" }],
  ] as const) {
    const { input, dependency } = followUpFixture();
    const wire = encodeRunTransfer(input, repo, dependency);
    Object.assign(subject === "child" ? input.run : (dependency[subject] ?? {}), patch);
    if (!("followUp" in wire)) throw new Error("Expected dependency history");
    Object.assign(
      subject === "child" ? wire.run : subject === "owner" ? wire.followUp.owner : wire.followUp,
      patch,
    );
    rejects(() => encodeRunTransfer(input, repo, dependency), "incomplete");
    rejects(() => decodeRunTransfer(wire, repo), "incomplete");
  }
});

test("both boundaries reject nonempty dependencies on the primary run and owner", () => {
  for (const subject of ["primary", "owner"] as const) {
    const { input, dependency } = followUpFixture(),
      wire = encodeRunTransfer(input, repo, dependency);
    const run = subject === "primary" ? input.run : dependency.owner;
    if (!run || !("followUp" in wire)) throw new Error("Expected owner");
    Object.assign(run, {
      dependsOn: ["unresolved"],
      sourceRef: { ...run.sourceRef, dependenciesSatisfied: true },
    });
    Object.assign(subject === "primary" ? wire.run : wire.followUp.owner, { dependsOn: ["unresolved"] });
    rejects(() => encodeRunTransfer(input, repo, dependency), "unsupported");
    rejects(() => decodeRunTransfer(wire, repo), "unsupported");
  }
});

test("strict follow-up fields carry no approval, publication authority or local bindings", () => {
  for (const patch of [
    { approval: true },
    { grant: {} },
    { deliveredSha: "bad" },
    { round: 0 },
    { kind: 1 },
    { createdAt: Infinity },
    { findings: [{ severity: "critical", title: "bad", detail: "bad" }] },
  ]) {
    const { input, dependency } = followUpFixture(),
      wire = encodeRunTransfer(input, repo, dependency);
    Object.assign(dependency.round ?? {}, patch);
    if ("followUp" in wire) Object.assign(wire.followUp, patch);
    rejects(() => encodeRunTransfer(input, repo, dependency));
    rejects(() => decodeRunTransfer(wire, repo));
  }
  for (const patch of [{ repoId: "local" }, { sessionId: "session" }, { approval: true }]) {
    const { input, dependency } = followUpFixture(),
      wire = encodeRunTransfer(input, repo, dependency);
    if ("followUp" in wire) Object.assign(wire.followUp.owner, patch);
    rejects(() => decodeRunTransfer(wire, repo));
  }
  const { input, dependency } = followUpFixture();
  Object.assign(dependency.round ?? {}, {
    deliveredSha: null,
    findings: [{ severity: "nit", title: "x", detail: "y" }],
  });
  expect(encodeRunTransfer(input, repo, dependency)).toHaveProperty("followUp.deliveredSha", null);
});
