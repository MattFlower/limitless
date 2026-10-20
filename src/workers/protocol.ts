import { createHash } from "node:crypto";
import { z } from "zod";
import { launchFailure } from "../gates/output.ts";
import type { GateResult } from "../gates/run.ts";
import { MAX_SKIPPED_TESTS, MAX_TEST_IDENTITY_LENGTH } from "../gates/test-coverage.ts";

export function pairingCode(coordinator: string, worker: string, nonce: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["limitless-worker-pair-v1", coordinator, worker, nonce]))
    .digest();
  return [...digest.subarray(0, 16)].map((b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
}

export const Heartbeat = z
  .object({
    releaseSha: z.string().min(1).max(128),
    bunVersion: z.string().min(1).max(64),
    os: z.literal("darwin"),
    osVersion: z.string().max(128),
    cpuCount: z.number().int().positive(),
    ramBytes: z.number().int().positive(),
    freeSlots: z.number().int().nonnegative(),
    onAC: z.boolean(),
    idleSeconds: z.number().nonnegative(),
    jobs: z.array(z.string().uuid()).max(128),
    updateWarning: z.string().max(4000).optional(),
  })
  .strict();
export type Capabilities = z.infer<typeof Heartbeat>;
export const Pair = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const Claim = z.object({ secret: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const LeaseRequest = z.object({ jobs: z.array(z.string().uuid()).max(128).default([]) }).strict();
export const Check: z.ZodType<GateResult> = z.lazy(() =>
  z
    .object({
      name: z.string(),
      command: z.string(),
      ok: z.boolean(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().finite().nonnegative(),
      output: z.string(),
      failures: z.string().optional(),
      timedOut: z.boolean().optional(),
      confinementError: z.boolean().optional(),
      firstAttempt: Check.optional(),
      targetedRetry: Check.optional(),
      failedFiles: z.array(z.string()).optional(),
      failureAttributionComplete: z.boolean().optional(),
      failedFileTimes: z.record(z.string(), z.number().finite().nonnegative()).optional(),
      testCoverage: z
        .object({
          passedFiles: z.array(z.string()),
          skippedFiles: z.array(z.string()),
          skippedTestsIncomplete: z.boolean().optional(),
          skippedTests: z
            .array(
              z
                .object({
                  file: z.string().min(1).max(MAX_TEST_IDENTITY_LENGTH),
                  name: z.string().min(1).max(MAX_TEST_IDENTITY_LENGTH),
                  line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
                })
                .strict(),
            )
            .max(MAX_SKIPPED_TESTS)
            .optional(),
          summary: z
            .object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative() })
            .strict()
            .optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .refine((r) => !r.confinementError && !launchFailure(r.output), "Worker confinement failed")
    .refine(
      (r) => !r.ok || (r.exitCode === 0 && !r.timedOut && !r.confinementError),
      "Inconsistent passing check",
    ),
);
export const GateRunSchema = z
  .object({
    sha: z
      .string()
      .regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/i)
      .optional(),
    setupOk: z.boolean(),
    setup: z.array(Check),
    checks: z.array(Check),
  })
  .strict();
export const Result = z.object({ sha: z.string(), run: GateRunSchema }).strict();
export const CheckEvent = z
  .object({ type: z.literal("check"), phase: z.enum(["setup", "check"]), result: Check })
  .strict();
export const timing = {
  heartbeat: 10_000,
  fresh: 30_000,
  lease: 60_000,
  pickup: 60_000,
  poll: 30_000,
  tick: 100,
};
export type WorkerTiming = typeof timing;
