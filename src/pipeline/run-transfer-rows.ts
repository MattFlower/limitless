import { z } from "zod";
import type { Run, RunDetail, Repo as StoredRepo } from "../core/types.ts";
import { RunTransferError, rethrowRunTransfer } from "./run-transfer-errors.ts";
import * as json from "./run-transfer-json.ts";
export const boundary =
  <A extends unknown[], T>(action: (...args: A) => T) =>
  (...args: A): T => {
    try {
      return action(...args);
    } catch (error) {
      try {
        if (!(error instanceof RunTransferError)) rethrowRunTransfer(error, "invalid");
      } catch (caught) {
        rethrowRunTransfer(caught, "invalid");
      }
      throw error;
    }
  };
const member = (value: unknown, key: string): unknown =>
  value && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
export function preflight(value: unknown, owner?: unknown) {
  for (const run of [member(value, "run"), owner ?? member(member(value, "followUp"), "owner")]) {
    const dependencies = member(run, "dependsOn");
    if (Array.isArray(dependencies) && dependencies.length) throw new RunTransferError("unsupported");
  }
}
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
  ...fields("mergedAt startedAt finishedAt", counter.nullable()),
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
  finishedAt: counter.nullable(),
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
  finishedAt: counter.nullable(),
});
const questionSchema = object({
  ...row,
  question: text,
  ...fields("answer answeredBy", nullableText),
  askedAt: counter,
  answeredAt: counter.nullable(),
});
const rowsSchema = object({
  run: runSchema,
  stages: z.array(stageSchema),
  invocations: z.array(invocationSchema),
  questions: z.array(questionSchema),
});
export type PortableRun = z.infer<typeof runSchema>;
export type TransferRows = z.infer<typeof rowsSchema>;
export type TransferRepository = Pick<StoredRepo, "id" | "kind" | "slug">;
type Repo = TransferRepository;
export type TransferRowInput = Pick<RunDetail, "run" | "stages" | "questions"> & {
  invocations: (Omit<RunDetail["invocations"][number], "sessionId"> & { sessionId?: string | null })[];
};
export function parseRecord<T>(schema: z.ZodType<T>, value: unknown): T {
  json.parseTransferJson(value);
  const result = schema.safeParse(value);
  if (!result.success) throw new RunTransferError("invalid");
  return result.data;
}
// Source-only classification: portable parsers never strip resources or unknown members.
export function transferSource<T>(schema: z.ZodType<T>, value: unknown, excluded: string[] = []): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunTransferError("invalid");
  const result = schema.safeParse(
    Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.includes(key))),
  );
  if (!result.success)
    throw new RunTransferError(
      result.error.issues.some((issue) => issue.code === "unrecognized_keys") ? "unsupported" : "invalid",
    );
  const defined = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(defined)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, item]) => item !== undefined)
              .map(([k, item]) => [k, defined(item)]),
          )
        : v;
  return parseRecord(schema, defined(result.data));
}
export const decodeTransferRun = boundary(
  (value: unknown, repo: Repo, code: "invalid" | "incomplete" = "invalid") => {
    preflight({ run: value });
    const flow = member(value, "flow");
    if (typeof flow === "string" && !["build", "verify-change", "acceptance"].includes(flow))
      throw new RunTransferError("unsupported");
    const run = parseRecord(runSchema, value);
    const ref = run.sourceRef;
    if (ref?.kind === "pull_request") {
      json.parseTransferOid(ref.baseSha);
      json.parseTransferOid(ref.headSha);
    }
    if (ref?.kind === "review-round" && "reviewedSha" in ref) json.parseTransferOid(ref.reviewedSha);
    if (repo.kind !== "github") throw new RunTransferError("unsupported");
    const slug = repo.slug.toLowerCase();
    if (
      run.repoSlug.toLowerCase() !== slug ||
      ((ref?.kind === "issue" || ref?.kind === "pull_request") &&
        (identity.parse(ref.repo).toLowerCase() !== slug || json.parseTransferCounter(ref.number) === 0))
    )
      throw new RunTransferError(code);
    return run;
  },
);
export const encodeTransferRun = boundary(
  (run: Run, repo: Repo, code: "invalid" | "incomplete" = "invalid") => {
    preflight({ run });
    const { repoId, ...portable } = run;
    for (const [key, schema] of Object.entries(runSchema.shape))
      if (schema.isOptional() && Reflect.get(portable, key) === undefined)
        Reflect.deleteProperty(portable, key);
    if (portable.models && typeof portable.models === "object" && !Array.isArray(portable.models)) {
      portable.models = { ...portable.models };
      for (const key of ["triage", "spec", "holdout", "implement", "review", "verify"] as const)
        if (portable.models[key] === undefined) delete portable.models[key];
    }
    const result = decodeTransferRun(portable, repo, code);
    if (repoId !== repo.id) throw new RunTransferError(code);
    return result;
  },
);
export const decodeRunTransferRows = boundary((value: unknown, repo: Repo): TransferRows => {
  preflight(value);
  decodeTransferRun(member(value, "run"), repo);
  const rows = parseRecord(rowsSchema, value);
  const hasStage = (n: number) => rows.stages.some((s) => s.ordinal === n);
  for (const collection of [rows.stages, rows.invocations, rows.questions]) {
    const ordinals = new Set(collection.map((r) => r.ordinal));
    if (collection.some((r, i) => r.runId !== rows.run.id || !ordinals.has(i + 1)))
      throw new RunTransferError("invalid");
  }
  if (rows.invocations.some((i) => i.stageOrdinal !== null && !hasStage(i.stageOrdinal)))
    throw new RunTransferError("invalid");
  return rows;
});
export const encodeRunTransferRows = boundary((input: TransferRowInput, repo: Repo): TransferRows => {
  preflight(input);
  const run = encodeTransferRun(input.run, repo);
  const ordered = <T extends { id: number }>(rows: T[]): T[] => {
    if (!Array.isArray(rows)) throw new RunTransferError("invalid");
    const ids = rows.map((r) => parseRecord(ordinal, r.id));
    if (new Set(ids).size !== rows.length) throw new RunTransferError("invalid");
    return [...rows].sort((a, b) => a.id - b.id);
  };
  const stages = ordered(input.stages);
  const stageOrdinals = new Map(stages.map((s, i) => [s.id, i + 1]));
  const result = {
    ...input,
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
});
