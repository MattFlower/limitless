import { getPrivacyChecker } from "../util/privacy-checker.ts";
import { verifier } from "../util/privacy-proof.ts";
import { projectGateDiagnostics, redactGateOutput } from "./output.ts";
import type { GateResult } from "./run.ts";
import { gatePrivacyScope, withheldText } from "./text-privacy.ts";

const FAILURE_RESULT = /^(?:(?:\(fail\)|✗)(?:\s|$)|not ok(?:\s|$))/;
const TIMEOUT = /^\^ this test timed out after \d+(?:\.\d+)?ms\.$/;
const OMITTED = "[failure excerpts: diagnostic lines or failures left out]";

/** Capture already-redacted lines before runner tail cuts, retaining only bounded diagnostics. */
export class FailureExcerpts {
  private lines: string[] = [];
  private excerpts: string[] = [];
  private size = 0;
  private clipped = false;
  private omitted = false;
  private failure: string | undefined;

  observe(line: string): void {
    const text = line.trim();
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
  for (const line of output.split(/\r?\n/)) excerpts.observe(redactGateOutput(line));
  return excerpts.result();
}

export const RENDER_LIMITS = [3_000, 9_000] as const;
type RenderLimit = (typeof RENDER_LIMITS)[number];
const high = (n: number) => n >= 0xd800 && n <= 0xdbff;
const low = (n: number) => n >= 0xdc00 && n <= 0xdfff;
const head = (s: string, room: number) =>
  s.slice(0, high(s.charCodeAt(room - 1)) && low(s.charCodeAt(room)) ? room - 1 : room);
const tail = (s: string, room: number) => {
  const start = Math.max(0, s.length - room);
  return s.slice(high(s.charCodeAt(start - 1)) && low(s.charCodeAt(start)) ? start + 1 : start);
};

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
      const diagnostic = head(line, room - 1);
      kept.push(diagnostic);
      room -= diagnostic.length + 1;
    }
  }
  return [...kept, OMITTED].join("\n");
}

/** Render exact candidate bytes; only the producer checks and signs cuts. */
export function renderGateOutput(
  result: Pick<GateResult, "output" | "failures">,
  limit: RenderLimit,
): string {
  if (!result.failures) return tail(result.output, limit);
  return `${shortenFailureExcerpts(result.failures, limit - 1_002)}\n\n${tail(result.output, 1_000)}`;
}

export function formatGateOutput(result: GateResult, limit: RenderLimit = 3_000): string {
  const scope = gatePrivacyScope.getStore();
  const snapshot = verifier(scope?.registry ?? getPrivacyChecker().registry, scope?.signer);
  const projected = projectGateDiagnostics(result, { mode: "outward", snapshot });
  if (projected.textPrivacy?.output.withheld) return projected.output;
  if (!RENDER_LIMITS.includes(limit)) return withheldText("unproven");
  const bytes = renderGateOutput(result, limit);
  if (bytes === result.output) return projected.output;
  const record = result.textPrivacy?.renderings?.[limit];
  if (
    record?.withheld !== false ||
    record.truncated !== true ||
    !snapshot.verify(record, `rendering:${limit}`, bytes, record.truncated === true)
  )
    return withheldText("unproven");
  return redactGateOutput(bytes) === bytes ? bytes : withheldText("credential-changed");
}
