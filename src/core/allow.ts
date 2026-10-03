import type { AuditAllowance } from "./types.ts";

export const AUDIT_ALLOWANCES: readonly AuditAllowance[] = ["submodules", "gitattributes", "binary"];

/** `Allow: submodules` or `Allow: gitattributes` on a line of its own in requester-authored text. */
export function parseAllow(text: string): AuditAllowance[] {
  const lines = [...text.matchAll(/^[ \t]*allow:[ \t]*(submodules|gitattributes|binary)[ \t]*\r?$/gim)];
  return AUDIT_ALLOWANCES.filter((kind) => lines.some((m) => m[1]?.toLowerCase() === kind));
}

/** The explicit `--allow` / API option; unknown values are rejected, never ignored. */
export function validateAllow(input: unknown): AuditAllowance[] {
  const values: unknown[] = [input ?? []].flat();
  for (const value of values)
    if (!AUDIT_ALLOWANCES.includes(value as AuditAllowance))
      throw new Error(`Invalid allow value ${JSON.stringify(value)}: expected ${AUDIT_ALLOWANCES.join()}`);
  return AUDIT_ALLOWANCES.filter((kind) => values.includes(kind));
}
