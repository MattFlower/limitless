import { z } from "zod";
import type { Repo, Run, RunDetail } from "../core/types.ts";
import { RunTransferError } from "./run-transfer-errors.ts";
import * as json from "./run-transfer-json.ts";

type Words<S extends string> = S extends `${infer K} ${infer Rest}` ? K | Words<Rest> : S;
export function fields<S extends string, T extends z.ZodType>(keys: S, schema: T): Record<Words<S>, T> {
  return Object.fromEntries(keys.split(" ").map((key) => [key, schema])) as Record<Words<S>, T>;
}
export const oneOf = <S extends string>(values: S) => z.enum(values.split(" ") as [Words<S>, ...Words<S>[]]);
export const counter = z.number().transform(json.parseTransferCounter);
export const ordinal = counter.refine((n) => n > 0);
export const identity = z.string().transform(json.parseTransferIdentity);
export const oid = z.string().transform(json.parseTransferOid);
const object = z.strictObject;
const text = z.string();
const nullableText = text.nullable();
const nullableTime = counter.nullable();
const stageName = oneOf(
  "prepare triage clarify spec plan holdout implement gates audit review preview verify accept deliver",
);
const status = oneOf("queued waiting running waiting_input succeeded failed cancelled needs_human resolved");
const runSchema = object({
  ...fields("id repoSlug", identity),
  ...fields("title prompt", text),
  ...fields("requestedBy baseBranch deliveryBranch branch prUrl mergedBy error", nullableText),
  source: oneOf("ui cli chat discord github webhook mcp"),
  ...fields("githubWebhookVerified prClosedUnmerged merged", z.boolean()),
  // Request JSON is open data; record parsing would drop reserved object keys.
  sourceRef: z.custom<Run["sourceRef"]>((v) => v === null || (typeof v === "object" && !Array.isArray(v))),
  dependsOn: z.array(identity),
  profile: oneOf("auto quick standard deep"),
  resolvedProfile: oneOf("quick standard deep").nullable(),
  taskClass: oneOf("dependency_update bugfix feature refactor docs test chore question").nullable(),
  complexity: oneOf("trivial small medium large").nullable(),
  status,
  stage: stageName.nullable(),
  ...fields("baseSha headSha", oid.nullable()),
  ...fields("costUsd costEquivUsd", z.number()),
  ...fields("tokensIn tokensOut priority createdAt", counter),
  ...fields("mergedAt startedAt finishedAt", nullableTime),
  resolution: object({
    kind: oneOf("merged done_elsewhere superseded wont_do pr_closed"),
    ...fields("ref note", nullableText),
    by: text,
    at: counter,
  }).nullable(),
  titleProvenance: oneOf("explicit defaulted").nullable().optional(),
  flow: oneOf("build verify-change acceptance").optional(),
  noBaselineCache: z.boolean().optional(),
  githubWait: object({ ...fields("since nextAttemptAt deadline", counter), reason: text }).optional(),
  models: object(fields("triage spec holdout implement review verify", z.array(text).optional())).optional(),
  allow: z.array(oneOf("submodules gitattributes binary workflows")).optional(),
});
const row = { ordinal: ordinal, runId: identity };
const stageSchema = object({
  ...row,
  name: stageName,
  round: counter,
  status: oneOf("running succeeded failed skipped cancelled"),
  summary: nullableText,
  startedAt: counter,
  finishedAt: nullableTime,
});
const invocationSchema = object({
  ...row,
  stageOrdinal: ordinal.nullable(),
  role: oneOf("triage spec plan plan_review holdout implement review verify summarize chat review_shadow"),
  ...fields("harness provider model modelId", text),
  effort: oneOf("none minimal low medium high xhigh max default").nullable(),
  status: oneOf("running ok error cancelled timeout stuck quota unavailable declined"),
  ...fields("costUsd costEquivUsd", z.number()),
  ...fields("inputTokens outputTokens cacheReadTokens cacheWriteTokens numTurns waitMs", counter),
  fast: z.boolean(),
  ...fields("fastModeState fastModeDisabledReason error", nullableText),
  startedAt: counter,
  finishedAt: nullableTime,
});
const questionSchema = object({
  ...row,
  question: text,
  ...fields("answer answeredBy", nullableText),
  askedAt: counter,
  answeredAt: nullableTime,
});
const rowsSchema = (repo: Repo) =>
  object({
    run: z.unknown().transform((value) => decodeTransferRun(value, repo)),
    stages: z.array(stageSchema),
    invocations: z.array(invocationSchema),
    questions: z.array(questionSchema),
  });
export type PortableRun = z.infer<typeof runSchema>;
export type TransferRows = z.infer<ReturnType<typeof rowsSchema>>;
export type TransferRowInput = Pick<RunDetail, "run" | "stages" | "invocations" | "questions">;
export function parseRecord<T>(schema: z.ZodType<T>, value: unknown): T {
  json.parseTransferJson(value);
  const result = schema.safeParse(value);
  if (!result.success) throw new RunTransferError("invalid");
  return result.data;
}
export function decodeTransferRun(value: unknown, repo: Repo, code: "invalid" | "incomplete" = "invalid") {
  json.parseTransferJson(value);
  if (value && typeof value === "object") {
    if ("dependsOn" in value && Array.isArray(value.dependsOn) && value.dependsOn.length)
      throw new RunTransferError("unsupported");
    if (
      "flow" in value &&
      typeof value.flow === "string" &&
      !["build", "verify-change", "acceptance"].includes(value.flow as string)
    )
      throw new RunTransferError("unsupported");
  }
  const run = parseRecord(runSchema, value);
  const ref = run.sourceRef;
  if (ref?.kind === "pull_request") {
    json.parseTransferOid(ref.baseSha);
    json.parseTransferOid(ref.headSha);
  }
  if (ref?.kind === "review-round" && "reviewedSha" in ref) json.parseTransferOid(ref.reviewedSha);
  if (repo.kind !== "github") throw new RunTransferError("unsupported");
  if (
    run.repoSlug !== repo.slug ||
    ((ref?.kind === "issue" || ref?.kind === "pull_request") &&
      (ref.repo !== repo.slug || json.parseTransferCounter(ref.number) === 0))
  )
    throw new RunTransferError(code);
  return run;
}
export function encodeTransferRun(run: Run, repo: Repo, code: "invalid" | "incomplete" = "invalid") {
  json.parseTransferJson(run);
  const { repoId, ...portable } = run;
  const result = decodeTransferRun(portable, repo, code);
  if (repoId !== repo.id) throw new RunTransferError(code);
  return result;
}
export function decodeRunTransferRows(value: unknown, repo: Repo): TransferRows {
  const rows = parseRecord(rowsSchema(repo), value);
  const hasStage = (n: number) => rows.stages.some((s) => s.ordinal === n);
  for (const collection of [rows.stages, rows.invocations, rows.questions]) {
    if (
      new Set(collection.map((r) => r.ordinal)).size !== collection.length ||
      collection.some((r) => r.runId !== rows.run.id)
    )
      throw new RunTransferError("invalid");
  }
  if (rows.invocations.some((i) => i.stageOrdinal !== null && !hasStage(i.stageOrdinal)))
    throw new RunTransferError("invalid");
  return rows;
}
export function encodeRunTransferRows(input: TransferRowInput, repo: Repo): TransferRows {
  parseRecord(object(fields("run stages invocations questions", z.unknown())), input);
  const run = encodeTransferRun(input.run, repo);
  const ordered = <T extends { id: number }>(rows: T[]): T[] => {
    const ids = rows.map((r) => parseRecord(ordinal, r.id));
    if (new Set(ids).size !== rows.length) throw new RunTransferError("invalid");
    return [...rows].sort((a, b) => a.id - b.id);
  };
  const stages = ordered(input.stages);
  const stageOrdinals = new Map(stages.map((s, i) => [s.id, i + 1]));
  const result = {
    run,
    stages: stages.map(({ id: _id, ...s }, i) => ({ ...s, ordinal: i + 1 })),
    invocations: ordered(input.invocations).map(({ id: _id, stageId, sessionId: _session, ...v }, i) => ({
      ...v,
      ordinal: i + 1,
      stageOrdinal: stageId === null ? null : stageOrdinals.get(stageId),
    })),
    questions: ordered(input.questions).map(({ id: _id, ...q }, i) => ({ ...q, ordinal: i + 1 })),
  };
  return decodeRunTransferRows(result, repo);
}
