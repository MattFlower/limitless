import { stripVTControlCharacters } from "node:util";
import type { GateResult } from "./run.ts";

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
    const line = stripVTControlCharacters(raw);
    const text = line.trim();
    if (this.failure !== undefined) {
      // Bun emits the timeout explanation just after the result, unlike assertion diagnostics.
      const timeout = /^\^ this test timed out after \d+(?:\.\d+)?ms\.$/.test(text);
      this.finish(timeout ? line : undefined);
      if (timeout) return;
    }
    const failure = /^(?:(?:\(fail\)|✗)(?:\s|$)|not ok(?:\s|$))/.test(text);
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
    if (!this.excerpts.length) return undefined;
    return [...this.excerpts, ...(this.omitted ? [OMITTED] : [])].join("\n\n");
  }
}

export function extractFailures(output: string): string | undefined {
  const excerpts = new FailureExcerpts();
  for (const line of output.split(/\r?\n/)) excerpts.observe(line);
  return excerpts.result();
}

/** Excerpts come first; legacy results keep their original tail budget. */
export function formatGateOutput(result: Pick<GateResult, "output" | "failures">, limit = 3_000): string {
  if (!result.failures) return result.output.slice(-limit);
  const room = limit - 1_000 - OMITTED.length - 3;
  const failures =
    result.failures.length > room ? `${result.failures.slice(0, room)}\n${OMITTED}` : result.failures;
  return `${failures}\n\n${result.output.slice(-1_000)}`;
}
