import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { createPrivacyChecker } from "../util/privacy-checker.ts";
import { stable } from "./cache.ts";
import type { GateResult } from "./run.ts";

export const fieldPrivacySchema = z
  .strictObject({
    withheld: z.boolean(),
    truncated: z.boolean().optional(),
    checkedComplete: z.boolean().optional(),
    reason: z.string().optional(),
    kind: z.enum(["complete", "attested:lan", "attested:github-actions", "rendering"]).optional(),
    mac: z.string().optional(),
  })
  .refine((field) => !field.withheld || field.mac === undefined, "Withheld fields are unsigned");
export const textPrivacySchema = z.strictObject({
  output: fieldPrivacySchema,
  identities: fieldPrivacySchema.optional(),
});
export type TextPrivacy = z.infer<typeof textPrivacySchema>;
export const withheldText = (reason: unknown, timedOut = false) =>
  `[withheld: ${typeof reason === "string" && /^[a-z-]{1,40}$/.exec(reason)?.[0] === reason ? reason : "unproven"}${timedOut ? "; timed out" : ""}]`;
export const gatePrivacyScope = new AsyncLocalStorage<{
  checker: ReturnType<typeof createPrivacyChecker>;
  registry: ReturnType<typeof createPrivacyChecker>["registry"];
  signer?: () => Buffer | undefined;
}>();
export const IDENTITY_CAP = 65536;
export function gateIdentities(r: GateResult): string {
  const values = [
    ...(["command", "executedCommand", "failedFiles", "coveringTest", "coveringTests"] as const).map(
      (k) => r[k],
    ),
    ...(["passedFiles", "skippedFiles", "skippedTests"] as const).map((k) => r.testCoverage?.[k]),
    Object.keys(r.failedFileTimes ?? {}).sort(),
  ];
  const size = (value: unknown): number =>
    typeof value === "string"
      ? value.length
      : value && typeof value === "object"
        ? Object.values(value).reduce<number>((n, v) => n + size(v), 0)
        : 0;
  return size(values) > IDENTITY_CAP ? "identity-cap" : JSON.stringify(stable(values));
}
