import { stripVTControlCharacters } from "node:util";
import { type ProcResult, redactCredentials, registeredCredentials } from "../util/proc.ts";

export const launchFailure = (output: string) => output.includes("sandbox_apply: Operation not permitted");

/** Remove terminal formatting before redaction, and redact before any diagnostic or tail cuts. */
export const redactGateOutput = (output: string): string =>
  redactCredentials(stripVTControlCharacters(output));

/** Sanitize decoded historical data without changing rows; preserve the raw confinement verdict. */
export const redactGateData = <T>(value: T): T =>
  value === undefined
    ? value
    : JSON.parse(
        JSON.stringify(value, (_key, v: unknown) => {
          if (typeof v === "string") return redactGateOutput(v);
          if (v && typeof v === "object" && "ok" in v && "output" in v && typeof v.output === "string") {
            if ("confinementError" in v && v.confinementError != null) return v;
            return { ...v, confinementError: launchFailure(v.output) };
          }
          return v;
        }),
      );

/** A raw runner cut may have removed a credential's prefix. Drop only that stream's overlap. */
export function redactGateStreams(
  stdout: string,
  stderr: string,
  cuts: Pick<ProcResult, "stdoutTruncated" | "stderrTruncated"> = {},
) {
  // Literal redaction covers accidental disclosure: one write stays on one stream. Deliberate splits,
  // interleaving or encoding require keeping credentials out of gate commands' reach (#335).
  const overlap = Math.max(0, ...registeredCredentials().map((secret) => secret.length - 1));
  return {
    stdout: redactGateOutput(stdout).slice(cuts.stdoutTruncated ? overlap : 0),
    stderr: redactGateOutput(stderr).slice(cuts.stderrTruncated ? overlap : 0),
  };
}
