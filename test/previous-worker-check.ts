import { z } from "zod";

// Frozen 70047eaa nested Check contract, before excerpt/rendering records.
// Do not import live protocol or privacy schemas.
const fieldPrivacySchema = z
  .strictObject({
    withheld: z.boolean(),
    truncated: z.boolean().optional(),
    checkedComplete: z.boolean().optional(),
    entriesDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    reason: z.string().optional(),
    kind: z.enum(["complete", "attested:lan", "attested:github-actions", "rendering"]).optional(),
    mac: z.string().optional(),
  })
  .refine((field) => !field.withheld || field.mac === undefined);
const textPrivacySchema = z.strictObject({
  output: fieldPrivacySchema,
  identities: fieldPrivacySchema.optional(),
});
const transferDictionary = <T>(item: z.ZodType<T>) =>
  z.custom<Record<string, T>>(
    (v) =>
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.values(v).every((entry) => item.safeParse(entry).success),
  );
export const PreviousCheck: z.ZodType = z.lazy(() =>
  z
    .object({
      name: z.string(),
      command: z.string(),
      executedCommand: z.string().optional(),
      coveringTest: z
        .object({
          file: z.string(),
          name: z.string(),
          reason: z.string().optional(),
          reportUnavailable: z.boolean().optional(),
        })
        .strict()
        .optional(),
      coveringTests: z
        .array(
          z
            .object({
              file: z.string(),
              name: z.string(),
              reason: z.string().optional(),
              reportUnavailable: z.boolean().optional(),
            })
            .strict(),
        )
        .optional(),
      ok: z.boolean(),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().finite().nonnegative(),
      output: z.string(),
      textPrivacy: textPrivacySchema.optional(),
      failures: z.string().optional(),
      timedOut: z.boolean().optional(),
      confinementError: z.boolean().optional(),
      firstAttempt: PreviousCheck.optional(),
      targetedRetry: PreviousCheck.optional(),
      retryAttempt: PreviousCheck.optional(),
      failedFiles: z.array(z.string()).optional(),
      failureAttributionComplete: z.boolean().optional(),
      failureAttributionReason: z.string().optional(),
      failedFileTimes: transferDictionary(z.number().finite().nonnegative()).optional(),
      testCoverage: z
        .object({
          passedFiles: z.array(z.string()),
          skippedFiles: z.array(z.string()),
          skippedTestsIncomplete: z.boolean().optional(),
          skippedTests: z
            .array(
              z
                .object({
                  file: z.string().min(1).max(2000),
                  name: z.string().min(1).max(2000),
                  line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
                })
                .strict(),
            )
            .max(1000)
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
    .refine(
      (r) =>
        !r.confinementError && !r.output.includes(["sandbox_apply:", "Operation not permitted"].join(" ")),
      "Worker confinement failed",
    )
    .refine(
      (r) => !r.ok || (r.exitCode === 0 && !r.timedOut && !r.confinementError),
      "Inconsistent passing check",
    ),
);
