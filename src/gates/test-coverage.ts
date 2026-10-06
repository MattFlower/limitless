export interface TestCoverage {
  passedFiles: string[];
  skippedFiles: string[];
}

/** Bun's file headers and result rows, captured before the process output tail is truncated. */
export class BunTestCoverage {
  private current: string | undefined;
  private files = new Map<string, { passed: boolean; skipped: boolean }>();

  observe(line: string): void {
    const file = /^([\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/.exec(line)?.[1];
    if (file) {
      this.current = file.replace(/^\.\//, "");
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
    };
  }
}
