import { stripVTControlCharacters } from "node:util";
import { redactCredentials, registeredCredentials } from "../util/proc.ts";

/** Remove terminal formatting before redaction, and redact before any diagnostic or tail cuts. */
export const redactGateOutput = (output: string): string =>
  redactCredentials(stripVTControlCharacters(output));

/** Sanitize decoded values, including historical state and JSON artifacts, without changing rows. */
export const redactGateData = <T>(value: T, redact = redactGateOutput): T =>
  value === undefined
    ? value
    : JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === "string" ? redact(v) : v)));

export function redactGateArtifact(content: string): string {
  try {
    return JSON.stringify(redactGateData(JSON.parse(content)));
  } catch {
    return redactGateOutput(content);
  }
}

/** A raw runner cut may have removed a credential's prefix. Drop its possible decoded overlap. */
export function redactGateStreams(stdout: string, stderr: string, truncated = false) {
  const overlap = Math.max(0, ...registeredCredentials().map((secret) => secret.length - 1));
  stdout = stripVTControlCharacters(stdout);
  stderr = stripVTControlCharacters(stderr);
  let stdoutCut = 0;
  let stderrCut = 0;
  for (const secret of registeredCredentials()) {
    for (let split = 1; split < secret.length; split++) {
      const left = secret.slice(0, split);
      const right = secret.slice(split);
      if (stdout.endsWith(left) && stderr.startsWith(right)) {
        stdoutCut = Math.max(stdoutCut, left.length);
        stderrCut = Math.max(stderrCut, right.length);
      }
    }
  }
  if (stdoutCut) stdout = `${stdout.slice(0, -stdoutCut)}[redacted]`;
  if (stderrCut) stderr = `[redacted]${stderr.slice(stderrCut)}`;
  return {
    stdout: redactCredentials(stdout).slice(truncated ? overlap : 0),
    stderr: redactCredentials(stderr).slice(truncated ? overlap : 0),
  };
}
