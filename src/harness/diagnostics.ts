/**
 * Classification of a command's output for verification. Parsers compute it on the complete
 * output before truncating what is displayed, so a late permission error or a late assertion
 * failure is never lost with the tail.
 */
export interface ExecutionDiagnostics {
  /** A permission or sandbox denial reported as something observed, not quoted or expected. */
  denied: boolean;
  /** A genuine test or assertion failure, which needs a code fix whatever else went wrong. */
  assertionFailed: boolean;
}

const DENIAL =
  /\b(?:EPERM|EACCES|permission denied|operation not permitted)\b|sandbox[^.\n]*(?:denied|denial|blocked)/i;
// Words that make a diagnostic a quotation or an asserted expectation rather than an observed barrier.
const NOT_OBSERVED =
  /\b(?:expect(?:ed|s|ing)?|assert(?:ion|s)?|quoted|documentation|source (?:code|text)|literal|matches|toThrow)\b/i;
const ASSERTION =
  /\bexpect\(|^\s*expected:|\bassert(?:ion)?(?:error)?\s*(?:failed|error)\b|\bAssertionError\b|\bexpected\b[^\n]*\breceived\b/im;

/** A sentence of the text reports a denial as something observed, not quoted or expected. */
export function observedDenial(text: string, separators: RegExp = /\n/): boolean {
  return text.split(separators).some((part) => DENIAL.test(part) && !NOT_OBSERVED.test(part));
}

export function assertionFailure(text: string): boolean {
  return ASSERTION.test(text);
}

export function classifyOutput(output: string): ExecutionDiagnostics {
  return { denied: observedDenial(output), assertionFailed: assertionFailure(output) };
}
