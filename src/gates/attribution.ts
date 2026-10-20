import { realpathSync } from "node:fs";
import { resolve } from "node:path";
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
  checkout: string,
  canonicalFile: (file: string) => string | undefined,
  onTestcase?: (node: Bun.XML.Node, file?: string, describes?: (string | undefined)[]) => void,
): AttributedTestCounts | undefined {
  const canonicalCheckout = realpathSync(checkout);
  const reportFiles = new Map<string, Set<string>>();
  const collect = (node: Bun.XML.Node) => {
    const raw = node.attributes.file;
    const file = raw && canonicalFile(raw);
    if (file) {
      const paths = reportFiles.get(file) ?? new Set([file, resolve(canonicalCheckout, file)]);
      paths.add(raw);
      paths.add(resolve(checkout, raw));
      reportFiles.set(file, paths);
    }
    for (const child of node.children) if (typeof child === "object" && "name" in child) collect(child);
  };
  collect(root);
  // Suites nested below a file's suite are Bun describe blocks, outermost first.
  const visit = (
    node: Bun.XML.Node,
    inheritedFile?: string,
    describes: (string | undefined)[] = [],
  ): AttributedTestCounts => {
    const file = node.attributes.file ?? inheritedFile;
    const counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
    const children = node.children.filter(
      (child): child is Bun.XML.Node => typeof child === "object" && "name" in child,
    );
    if (node.name === "testcase") {
      onTestcase?.(node, file, describes);
      counts.tests = 1;
      for (const child of children) {
        if (child.name === "failure") counts.failures = 1;
        else if (child.name === "error") counts.errors = 1;
        else if (child.name === "skipped") counts.skipped = 1;
        else if (child.name !== "system-out" && child.name !== "system-err" && child.name !== "properties")
          throw new Error("Unknown testcase evidence");
        if (child.name === "failure" || child.name === "error") {
          const text = child.children.filter((part) => typeof part === "string").join("");
          for (const frame of text.matchAll(/^\s*at (.+?):\d+:\d+\)?\s*$/gm)) {
            const prefix = frame[1];
            if (!prefix) continue;
            const bareLocation = canonicalFile(prefix);
            const ownFile = file && canonicalFile(file);
            for (const [location, paths] of reportFiles) {
              if (location === ownFile) continue;
              // Match known locations from the end; function names and paths can contain parentheses.
              if (
                bareLocation === location ||
                [...paths].some(
                  (path) => prefix === path || prefix === `(${path}` || prefix.endsWith(` (${path}`),
                )
              )
                throw new Error("Cross-file testcase failure");
            }
          }
        }
      }
      if (counts.failures + counts.errors + counts.skipped > 1) throw new Error("Ambiguous testcase");
      if (counts.failures + counts.errors > 0 && (!file || !files.has(file)))
        throw new Error("Unattributed testcase");
    } else {
      for (const child of children) {
        if (child.name === "testsuite" || child.name === "testcase") {
          const nested = visit(
            child,
            file,
            node.name === "testsuite" && inheritedFile !== undefined
              ? [...describes, node.attributes.name]
              : describes,
          );
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
    return onTestcase || counts.failures + counts.errors > 0 ? counts : undefined;
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
      /^Bailed out after \d+ failures?\.?$|^(?:#\s*)?unhandled (?:errors?|rejections?)\b|(?:^|:\s*)load(?:ing)?[- ]errors?\b|^(?:error:\s*)?(?:cannot|failed to|unable to) (?:load|import|resolve|find module)\b/i.test(
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
