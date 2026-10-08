import { redactGateData, redactGateOutput } from "./output.ts";
import type { GateResult } from "./run.ts";

const FAILURE_RESULT = /^(?:(?:\(fail\)|✗)(?:\s|$)|not ok(?:\s|$))/;
const TIMEOUT = /^\^ this test timed out after \d+(?:\.\d+)?ms\.$/;
const OMITTED = "[failure excerpts: diagnostic lines or failures left out]";

/** Capture before the process runner truncates output, retaining only bounded diagnostics. */
export class FailureExcerpts {
  private lines: string[] = [];
  private excerpts: string[] = [];
  private size = 0;
  private clipped = false;
  private omitted = false;
  private failure: string | undefined;

  observe(raw: string): void {
    const line = redactGateOutput(raw);
    const text = line.trim();
    if (text === OMITTED) {
      this.omitted = true;
      return;
    }
    if (this.failure !== undefined) {
      // Bun emits the timeout explanation just after the result, unlike assertion diagnostics.
      const timeout = TIMEOUT.test(text);
      this.finish(timeout ? line : undefined);
      if (timeout) return;
    }
    const failure = FAILURE_RESULT.test(text);
    if (failure) {
      this.failure = line;
    } else if (/^(?:(?:\((?:pass|skip|todo)\)|✓|»)(?:\s|$)|ok(?:\s|$)|.+\.test\.ts:$)/.test(text)) {
      this.lines = [];
      this.clipped = false;
    } else {
      this.lines.push(line.slice(0, 8_000));
      this.clipped ||= line.length > 8_000;
      if (this.lines.length > 39) {
        this.lines.shift();
        this.clipped = true;
      }
    }
  }

  private finish(timeout?: string): void {
    if (this.failure === undefined) return;
    const identity = [this.failure, ...(timeout ? [timeout] : [])].join("\n").trimEnd();
    const diagnostics = this.lines
      .slice(timeout ? -38 : -39)
      .join("\n")
      .trim();
    const room = 8_000 - OMITTED.length - 2 - this.size;
    if (this.excerpts.length < 10 && room >= identity.length) {
      const kept = diagnostics.slice(0, Math.max(0, room - identity.length - 1)).trimEnd();
      const block = kept ? `${kept}\n${identity}` : identity.trimStart();
      this.excerpts.push(block);
      this.size += block.length + 2;
      this.omitted ||=
        this.clipped || diagnostics.length > kept.length || (!!timeout && this.lines.length > 38);
    } else this.omitted = true;
    this.lines = [];
    this.clipped = false;
    this.failure = undefined;
  }

  result(): string | undefined {
    this.finish();
    // Failures whose identities alone overflow the budget still say that something was left out.
    if (!this.excerpts.length) return this.omitted ? OMITTED : undefined;
    return [...this.excerpts, ...(this.omitted ? [OMITTED] : [])].join("\n\n");
  }
}

export function extractFailures(output: string): string | undefined {
  const excerpts = new FailureExcerpts();
  for (const line of output.split(/\r?\n/)) excerpts.observe(line);
  return excerpts.result();
}

/** Reserve complete result lines before spending the remaining budget on diagnostics. */
function shortenFailureExcerpts(excerpt: string, limit: number): string {
  if (excerpt.length <= limit) return excerpt;
  const lines = excerpt.split("\n").filter((line) => line !== OMITTED);
  const identities = new Set<number>();
  let room = limit - OMITTED.length;
  for (const [i, line] of lines.entries()) {
    if ((FAILURE_RESULT.test(line.trim()) || TIMEOUT.test(line.trim())) && line.length + 1 <= room) {
      identities.add(i);
      room -= line.length + 1;
    }
  }
  const kept: string[] = [];
  for (const [i, line] of lines.entries()) {
    if (identities.has(i)) kept.push(line);
    else if (!FAILURE_RESULT.test(line.trim()) && !TIMEOUT.test(line.trim()) && room > 1) {
      const diagnostic = line.slice(0, room - 1);
      kept.push(diagnostic);
      room -= diagnostic.length + 1;
    }
  }
  return [...kept, OMITTED].join("\n");
}

/** Excerpts come first; legacy results keep their original tail budget. */
export function formatGateOutput(result: Pick<GateResult, "output" | "failures">, limit = 3_000): string {
  result = redactGateData(result);
  if (!result.failures) return result.output.slice(-limit);
  const failures = shortenFailureExcerpts(result.failures, limit - 1_002);
  return `${failures}\n\n${result.output.slice(-1_000)}`;
}
