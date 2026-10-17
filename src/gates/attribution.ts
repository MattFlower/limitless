import { stripVTControlCharacters } from "node:util";

export interface AttributedTestCounts {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
}

/** Counters are inclusive of descendants; only testcases supply failure evidence. */
export function attributedJUnitCounts(
  root: Bun.XML.Node,
  files: ReadonlySet<string>,
): AttributedTestCounts | undefined {
  const visit = (node: Bun.XML.Node, inheritedFile?: string): AttributedTestCounts => {
    const file = node.attributes.file ?? inheritedFile;
    const counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
    const children = node.children.filter(
      (child): child is Bun.XML.Node => typeof child === "object" && "name" in child,
    );
    if (node.name === "testcase") {
      counts.tests = 1;
      for (const child of children) {
        if (child.name === "failure") counts.failures = 1;
        else if (child.name === "error") counts.errors = 1;
        else if (child.name === "skipped") counts.skipped = 1;
        else if (child.name !== "system-out" && child.name !== "system-err" && child.name !== "properties")
          throw new Error("Unknown testcase evidence");
      }
      if (counts.failures + counts.errors + counts.skipped > 1) throw new Error("Ambiguous testcase");
      if (counts.failures + counts.errors > 0 && (!file || !files.has(file)))
        throw new Error("Unattributed testcase");
    } else {
      for (const child of children) {
        if (child.name === "testsuite" || child.name === "testcase") {
          const nested = visit(child, file);
          for (const key of Object.keys(counts) as (keyof AttributedTestCounts)[]) counts[key] += nested[key];
        } else if (child.name !== "system-out" && child.name !== "system-err" && child.name !== "properties")
          throw new Error("Unknown suite evidence");
      }
    }
    for (const key of Object.keys(counts) as (keyof AttributedTestCounts)[]) {
      const value = node.attributes[key];
      if (value !== undefined && (!/^\d+$/.test(value) || Number(value) !== counts[key]))
        throw new Error("Unmatched JUnit counter");
    }
    return counts;
  };
  try {
    const counts = visit(root);
    return counts.failures + counts.errors > 0 ? counts : undefined;
  } catch {
    return undefined;
  }
}

/** Retain summary/error evidence from the whole stream, independently of the diagnostic tail. */
export class RunnerFailureEvidence {
  private counts = new Map<string, number>();
  private invalid = false;

  observe(raw: string): void {
    const line = stripVTControlCharacters(raw).trim();
    if (/^(?:\((?:pass|fail|skip|todo)\)|[✓✗»])(?:\s|$)/.test(line)) return;
    if (
      /^(?:#\s*)?unhandled (?:errors?|rejections?)\b|(?:^|:\s*)load(?:ing)?[- ]errors?\b|^(?:error:\s*)?(?:cannot|failed to|unable to) (?:load|import|resolve|find module)\b/i.test(
        line,
      )
    )
      this.invalid = true;
    const summary = /^(\d+) (pass(?:ed)?|fail(?:ed)?|skip(?:ped)?|todo|errors?)$/.exec(line);
    if (summary?.[1] && summary[2]) {
      const key = summary[2].replace(/^(pass|fail|skip|error).*$/, "$1");
      if (this.counts.has(key)) this.invalid = true;
      this.counts.set(key, Number(summary[1]));
      if (!Number.isSafeInteger(Number(summary[1]))) this.invalid = true;
      if (key === "error" && Number(summary[1]) !== 0) this.invalid = true;
    } else if (/^\S+ (?:pass(?:ed)?|fail(?:ed)?|skip(?:ped)?|todo|errors?)$/.test(line)) this.invalid = true;
    const ran = /^Ran (\d+) tests? across \d+ files?\./.exec(line);
    if (ran?.[1]) {
      if (this.counts.has("tests")) this.invalid = true;
      this.counts.set("tests", Number(ran[1]));
    } else if (/^Ran .* tests? across /.test(line)) this.invalid = true;
  }

  agrees(counts?: AttributedTestCounts): boolean {
    return (
      !!counts &&
      !this.invalid &&
      this.counts.get("fail") === counts.failures + counts.errors &&
      this.counts.get("pass") === counts.tests - counts.failures - counts.errors - counts.skipped &&
      (this.counts.get("skip") ?? 0) + (this.counts.get("todo") ?? 0) === counts.skipped &&
      this.counts.get("tests") === counts.tests
    );
  }
}
