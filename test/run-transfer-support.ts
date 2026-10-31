import { expect } from "bun:test";
import type { Repo, Run } from "../src/core/types.ts";
import type { RunTransferErrorCode } from "../src/pipeline/run-transfer-errors.ts";
import type { FollowUpInput } from "../src/pipeline/run-transfer-followups.ts";
import type { TransferRowInput } from "../src/pipeline/run-transfer-rows.ts";

export const sha = "a".repeat(40),
  head = "B".repeat(64);
export const repo: Repo = {
  id: "local-binding",
  slug: "example/project",
  kind: "github",
  url: null,
  localPath: null,
  defaultBranch: "main",
  mergePolicy: "pr",
  createdAt: 1,
};
export function fixture(): TransferRowInput {
  const run: Run = {
    id: "logical-run",
    repoId: repo.id,
    repoSlug: repo.slug,
    title: "Recorded title",
    prompt: "Request text",
    source: "mcp",
    sourceRef: { kind: "custom", nested: { unknown: [true, null, 1] } },
    requestedBy: "mcp:consumer",
    githubWebhookVerified: false,
    profile: "auto",
    resolvedProfile: "deep",
    taskClass: "bugfix",
    complexity: "small",
    status: "resolved",
    dependsOn: [],
    prClosedUnmerged: true,
    resolution: { kind: "done_elsewhere", ref: "other-run", note: null, by: "human", at: 77 },
    stage: "review",
    baseBranch: "main",
    deliveryBranch: null,
    baseSha: sha,
    branch: "factory/topic",
    headSha: head,
    prUrl: "https://github.com/example/project/pull/42",
    merged: false,
    mergedBy: null,
    mergedAt: null,
    costUsd: 1.25,
    costEquivUsd: 8.5,
    tokensIn: 1234,
    tokensOut: 98,
    error: null,
    createdAt: 11,
    startedAt: 12,
    finishedAt: 76,
    priority: 2,
    titleProvenance: "explicit",
    flow: "build",
    noBaselineCache: false,
    allow: ["binary"],
    githubWait: { since: 21, nextAttemptAt: 22, deadline: 25, reason: "recorded" },
    models: { review: ["vendor/model"] },
  };
  return {
    run,
    stages: [
      {
        id: 900,
        runId: run.id,
        name: "review",
        round: 2,
        status: "succeeded",
        summary: "second",
        startedAt: 51,
        finishedAt: 66,
      },
      {
        id: 31,
        runId: run.id,
        name: "review",
        round: 1,
        status: "failed",
        summary: null,
        startedAt: 31,
        finishedAt: 50,
      },
    ],
    invocations: [
      {
        id: 721,
        runId: run.id,
        stageId: 900,
        sessionId: "private-session",
        role: "review_shadow",
        harness: "fake",
        provider: "provider",
        model: "model",
        modelId: "vendor/model",
        effort: "default",
        status: "ok",
        costUsd: 0.25,
        costEquivUsd: 2.5,
        inputTokens: 101,
        outputTokens: 23,
        cacheReadTokens: 43,
        cacheWriteTokens: 53,
        numTurns: 3,
        waitMs: 19,
        fast: true,
        fastModeState: "enabled",
        fastModeDisabledReason: null,
        error: null,
        startedAt: 52,
        finishedAt: 60,
      },
      {
        id: 19,
        runId: run.id,
        stageId: null,
        sessionId: null,
        role: "triage",
        harness: "fake",
        provider: "provider",
        model: "other",
        modelId: "vendor/other",
        effort: null,
        status: "declined",
        costUsd: 0.5,
        costEquivUsd: 1,
        inputTokens: 8,
        outputTokens: 9,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        numTurns: 1,
        waitMs: 0,
        fast: false,
        fastModeState: null,
        fastModeDisabledReason: "disabled",
        error: "uncertain",
        startedAt: 13,
        finishedAt: 20,
      },
    ],
    questions: [
      {
        id: 101,
        runId: run.id,
        question: "Open?",
        answer: null,
        askedAt: 65,
        answeredAt: null,
        answeredBy: null,
      },
      {
        id: 8,
        runId: run.id,
        question: "Answered?",
        answer: "Yes",
        askedAt: 25,
        answeredAt: 26,
        answeredBy: "human",
      },
    ],
  };
}
export function followUpFixture(): { input: TransferRowInput; dependency: FollowUpInput } {
  const input = fixture(),
    owner = structuredClone(input.run);
  owner.id = "logical-owner";
  input.run.id = "logical-child";
  input.stages = [];
  input.invocations = [];
  input.questions = [];
  input.run.baseBranch = owner.branch;
  input.run.deliveryBranch = owner.branch;
  input.run.sourceRef = {
    kind: "review-round",
    runId: owner.id,
    prUrl: owner.prUrl,
    round: 3,
    reviewedSha: sha,
    extra: { dependenciesSatisfied: true },
  };
  return {
    input,
    dependency: {
      owner,
      round: {
        runId: input.run.id,
        ownerId: owner.id,
        repoSlug: repo.slug,
        prUrl: input.run.prUrl ?? "",
        kind: "review",
        round: 3,
        reviewedSha: sha,
        deliveredSha: head,
        createdAt: 81,
        findings: [
          { severity: "major", title: "Fix", detail: "Recorded finding", file: "src/a.ts", line: 7 },
        ],
      },
    },
  };
}
export function rejects(fn: () => unknown, code: RunTransferErrorCode = "invalid") {
  expect(fn).toThrow(expect.objectContaining({ name: "RunTransferError", code }));
}
