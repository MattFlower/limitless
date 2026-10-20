import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { redactGateOutput } from "./output.ts";

export const MAX_SKIPPED_TESTS = 1000;
export const MAX_TEST_IDENTITY_LENGTH = 2000;

export interface TestCoverage {
  /** Files with at least one passing row and no failures; may also contain skipped tests. */
  passedFiles: string[];
  skippedFiles: string[];
  skippedTests?: { file: string; name: string }[];
  /** Unusable evidence survives tail truncation, including unattributed skips and failure rows. */
  skippedTestsIncomplete?: boolean;
  summary?: { passed: number; failed: number };
}

/** Bun's file headers and result rows, captured before the process output tail is truncated. */
export class BunTestCoverage {
  private current: string | undefined;
  private files = new Map<string, { passed: boolean; skipped: boolean; failed: boolean }>();
  private passed: number | undefined;
  private failed: number | undefined;
  private sawFailure = false;
  private skipped = new Map<string, { file: string; name: string }>();
  private skipRows = 0;
  private skipSummary = 0;
  private todoSummary = 0;
  private incomplete = false;

  constructor(private cwd?: string) {}

  private canonical(path: string): string {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  }

  observe(line: string): void {
    // Bun's GitHub Actions reporter groups file headers; presentation is not part of the path.
    line = redactGateOutput(line)
      .trim()
      .replace(/^::group::/, "");
    if (line === "::endgroup::") this.current = undefined;
    const summary = /^(\d+) (pass(?:ed)?|fail(?:ed)?)$/.exec(line);
    if (summary?.[2]?.startsWith("pass")) this.passed = Number(summary[1]);
    if (summary?.[2]?.startsWith("fail")) this.failed = Number(summary[1]);
    const skippedSummary = /^(\d+) (skip(?:ped)?|todo)$/.exec(line);
    if (skippedSummary?.[2] === "todo") this.todoSummary = Number(skippedSummary[1]);
    else if (skippedSummary) this.skipSummary = Number(skippedSummary[1]);
    if (/^\(fail\)/.test(line)) this.sawFailure = true;
    const skipped = /^\((?:skip|todo)\)(.*)$/.exec(line);
    if (skipped) {
      this.skipRows++;
      const name = /^\s+(.+)$/.exec(skipped[1] ?? "")?.[1] ?? "";
      const file = this.current ?? "";
      const key = JSON.stringify([file, name]);
      if (
        !file ||
        !name ||
        Math.max(file.length, name.length) > MAX_TEST_IDENTITY_LENGTH ||
        (!this.skipped.has(key) && this.skipped.size >= MAX_SKIPPED_TESTS)
      )
        this.incomplete = true;
      else this.skipped.set(key, { file, name });
    }
    const file = /^(.+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line)?.[1];
    if (file) {
      this.current =
        isAbsolute(file) && this.cwd
          ? relative(this.canonical(this.cwd), this.canonical(file))
          : file.replace(/^\.\//, "");
      if (!this.files.has(this.current))
        this.files.set(this.current, { passed: false, skipped: false, failed: false });
    }
    const entry = this.current ? this.files.get(this.current) : undefined;
    if (!entry) return;
    if (/^\(pass\)/.test(line)) entry.passed = true;
    if (/^\(fail\)/.test(line)) entry.failed = true;
    if (/^\((?:skip|todo|fail)\)/.test(line)) entry.skipped = true;
  }

  result(): TestCoverage {
    return {
      passedFiles: [...this.files].filter(([, value]) => value.passed && !value.failed).map(([file]) => file),
      skippedFiles: [...this.files].filter(([, value]) => value.skipped).map(([file]) => file),
      ...(this.incomplete || this.sawFailure || this.skipRows !== this.skipSummary + this.todoSummary
        ? { skippedTestsIncomplete: true }
        : {}),
      ...(!this.incomplete &&
      this.skipRows === this.skipSummary + this.todoSummary &&
      this.passed !== undefined &&
      this.failed !== undefined
        ? { skippedTests: [...this.skipped.values()] }
        : {}),
      ...(this.passed !== undefined && this.failed !== undefined
        ? { summary: { passed: this.passed, failed: Math.max(this.failed, Number(this.sawFailure)) } }
        : {}),
    };
  }
}
