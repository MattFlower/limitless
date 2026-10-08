import { stripVTControlCharacters } from "node:util";
import { redactCredentials } from "../util/proc.ts";

/** Remove terminal formatting before redaction, and redact before any diagnostic or tail cuts. */
export const redactGateOutput = (output: string): string =>
  redactCredentials(stripVTControlCharacters(output));
