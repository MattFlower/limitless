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
    entriesDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
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
type Checker = ReturnType<typeof createPrivacyChecker>;
type Scope = { checker: Checker; registry: Checker["registry"]; signer?: () => Buffer | undefined };
export const gatePrivacyScope = new AsyncLocalStorage<Scope>();
export const IDENTITY_CAP = 65536;
export function gateIdentities(r: GateResult): string {
  const values = [
    ...(["command", "executedCommand", "failedFiles", "coveringTest", "coveringTests"] as const).map(
      (k) => r[k],
    ),
    ...(["passedFiles", "skippedFiles", "skippedTests"] as const).map((k) => r.testCoverage?.[k]),
    r.failedFileTimes,
  ];
  let units = 0;
  const withinCap = (value: unknown): boolean => {
    if (typeof value === "string") units += Math.max(1, value.length);
    else if (value && typeof value === "object")
      for (const key in value) {
        if (value === r.failedFileTimes) units += key.length;
        if (units > IDENTITY_CAP || !withinCap(Reflect.get(value, key))) return false;
      }
    return units <= IDENTITY_CAP;
  };
  if (!withinCap(values)) return "identity-cap";
  values[values.length - 1] = Object.keys(r.failedFileTimes ?? {}).sort();
  return JSON.stringify(stable(values));
}
const ATTRIBUTION_PARTS = new Set([
  ...["Unknown testcase evidence", "Cross-file testcase failure", "Ambiguous testcase"],
  ...["Unattributed testcase", "Unknown suite evidence", "Unmatched JUnit counter", "Invalid JUnit evidence"],
  "runner reported an error, bail, or invalid/duplicate summary",
  "runner summary missing or inconsistent with JUnit",
  "unrecognized attribution reason",
]);
/** Release only whole, fixed attribution parts joined by "; "; anything else becomes fixed text. */
const part = (s: string) => ATTRIBUTION_PARTS.has(s) || /^\d+ unattributed (?:failure|error)s?$/.test(s);
export const attributionReason = (value: unknown): string =>
  typeof value === "string" && value.split("; ").every(part) ? value : "unrecognized attribution reason";
const claim = ({ mac: _mac, ...field }: TextPrivacy["output"]) => field;
/** Worker text-privacy records are claims, never proofs: keep them as MAC-free attestations. */
export function remoteGateData(r: GateResult): GateResult {
  const { textPrivacy, ...out } = r;
  if (textPrivacy) {
    const { output, identities } = textPrivacy;
    out.remoteAttestation = { output: claim(output), ...(identities && { identities: claim(identities) }) };
  }
  if (out.failureAttributionReason !== undefined)
    out.failureAttributionReason = attributionReason(out.failureAttributionReason);
  for (const key of ["firstAttempt", "targetedRetry", "retryAttempt"] as const)
    if (out[key]) out[key] = remoteGateData(out[key]);
  return out;
}
