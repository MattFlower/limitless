import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

export interface TestCoverage {
  passedFiles: string[];
  skippedFiles: string[];
  summary?: { passed: number; failed: number };
}

/** Bun's file headers and result rows, captured before the process output tail is truncated. */
export class BunTestCoverage {
  private current: string | undefined;
  private files = new Map<string, { passed: boolean; skipped: boolean }>();
  private passed: number | undefined;
  private failed: number | undefined;

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
    line = stripVTControlCharacters(line)
      .trim()
      .replace(/^::group::/, "");
    if (line === "::endgroup::") this.current = undefined;
    const summary = /^(\d+) (pass(?:ed)?|fail(?:ed)?)$/.exec(line);
    if (summary?.[2]?.startsWith("pass")) this.passed = Number(summary[1]);
    if (summary?.[2]?.startsWith("fail")) this.failed = Number(summary[1]);
    const file = /^(.+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line)?.[1];
    if (file) {
      this.current =
        isAbsolute(file) && this.cwd
          ? relative(this.canonical(this.cwd), this.canonical(file))
          : file.replace(/^\.\//, "");
      if (!this.files.has(this.current)) this.files.set(this.current, { passed: false, skipped: false });
    }
    const entry = this.current ? this.files.get(this.current) : undefined;
    if (!entry) return;
    if (/^\(pass\)/.test(line)) entry.passed = true;
    if (/^\((?:skip|todo|fail)\)/.test(line)) entry.skipped = true;
  }

  result(): TestCoverage {
    return {
      passedFiles: [...this.files]
        .filter(([, value]) => value.passed && !value.skipped)
        .map(([file]) => file),
      skippedFiles: [...this.files].filter(([, value]) => value.skipped).map(([file]) => file),
      ...(this.passed !== undefined && this.failed !== undefined
        ? { summary: { passed: this.passed, failed: this.failed } }
        : {}),
    };
  }
}
