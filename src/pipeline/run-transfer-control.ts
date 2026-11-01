import { z } from "zod";
import * as r from "./run-transfer-rows.ts";

const object = z.strictObject;
const text = z.string();
const effort = r.oneOf("none minimal low medium high xhigh max").nullable();
const selection = object({ modelId: text, effort });

// These are historical control fields only. Evidence, acceptance, policy and machine
// resources belong to separate fragments; this schema never authorizes execution.
export const transferControlSchema = object({
  phase: r.oneOf("prepare triage clarify spec loop deliver accept done"),
  flow: r.oneOf("build verify-change acceptance").optional(),
  parked: z.boolean().optional(),
  answers: z.array(text),
  round: r.counter,
  feedback: text.nullable(),
  toolCommands: z.array(text),
  // Recorded scheduling data, independent of destination clocks or lease validity.
  githubWait: object({ ...r.fields("since nextAttemptAt", r.counter), reason: text }).optional(),

  // Selections retain historical target IDs without consulting a destination catalog.
  implementer: object({
    ...r.fields("policyRevision targetId", text.optional()),
    effort: effort.optional(),
    modelId: text,
    tier: r.counter,
    vendor: text,
  }).optional(),
  roundsOnImplementer: r.counter,
  triedImplementers: z.array(z.union([text, selection])),
  ...r.fields("implementationReadyRound implementedRound", r.counter.optional()),
  implementerReport: text.optional(),
  implementerIssue: text.nullable().optional(),
  ...r.fields("environmentRetryRound conflictRound gateTimeoutReruns", r.counter.optional()),

  verification: object({
    ...r.fields("baseSha headSha", r.oid),
    initialComplete: z.boolean().optional(),
  }).optional(),
  ...r.fields("reviewBaseSha iterationBase", r.oid.optional()),
  reviewResolution: object({ sha: r.oid.optional(), feedback: text.optional() }).optional(),
  conflictFiles: z.array(text).optional(),

  // Publication intent and recorded completion are independent checkpoints.
  ...r.fields("publishedSha publishingSha", r.oid.optional()),
  workerCommitRound: r.counter.optional(),
  ...r.fields("deliveryComplete verdictCommentPosted verdictCommentPending", z.boolean().optional()),
  ...r.fields("pendingRebaseSha preRebaseHead", r.oid.optional()),
  deliveryMerges: z
    .array(
      object({
        runId: r.identity,
        ...r.fields("reviewedSha sha head base", r.oid),
      }),
    )
    .optional(),
  postMergeRejection: object({
    reason: text,
    ...r.fields("sha base head", r.oid),
    round: r.counter,
  }).optional(),
  ...r.fields("lastVerifiedSha reviewedSha", r.oid.optional()),
  ...r.fields("rebaseNote terminalReason needsHumanReason", text.optional()),
});

// Typed commit dependencies for C12/C13. Array entries retain order and logical
// deliveryMerges.runId identities; no field here requires local-ID remapping.
export const controlCommitMembers = [
  "verification.baseSha",
  "verification.headSha",
  "reviewBaseSha",
  "iterationBase",
  "reviewResolution.sha",
  "publishedSha",
  "publishingSha",
  "pendingRebaseSha",
  "preRebaseHead",
  "deliveryMerges[].reviewedSha",
  "deliveryMerges[].sha",
  "deliveryMerges[].head",
  "deliveryMerges[].base",
  "postMergeRejection.sha",
  "postMergeRejection.base",
  "postMergeRejection.head",
  "lastVerifiedSha",
  "reviewedSha",
] as const;

export type TransferControl = z.infer<typeof transferControlSchema>;

// Fragment-only boundary: deliberately not a complete state or payload decoder.
export const parseTransferControl = r.boundary(
  (value: unknown): TransferControl => r.parseRecord(transferControlSchema, value),
);
