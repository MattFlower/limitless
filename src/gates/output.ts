import { stripVTControlCharacters } from "node:util";
import { redactCredentials } from "../util/proc.ts";

const LAUNCH_FAILURE = "sandbox_apply: Operation not permitted";
export const launchFailure = (output: string) => output.includes(LAUNCH_FAILURE);

/** Scan raw streams independently so redaction and terminal normalization cannot alter the verdict. */
export function launchFailureScan() {
  const pending = { stdout: "", stderr: "" };
  let failed = false;
  return {
    observe(chunk: string, stream: "stdout" | "stderr") {
      const text = pending[stream] + chunk;
      failed ||= launchFailure(text);
      pending[stream] = text.slice(-(LAUNCH_FAILURE.length - 1));
    },
    failed: () => failed,
  };
}

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

/** Runner redaction covers accidental disclosure before framing or cuts. Deliberate cross-stream
 * splitting, interleaving or encoding requires keeping credentials out of gates' reach (#335). */
export function redactGateStreams(stdout: string, stderr: string) {
  return { stdout: redactGateOutput(stdout), stderr: redactGateOutput(stderr) };
}
