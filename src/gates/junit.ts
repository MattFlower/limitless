import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { type AttributedTestCounts, attributedJUnitCounts } from "./attribution.ts";

export const MAX_RETRY_FILES = 50;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

export interface FailedTestFiles {
  failedFiles: string[];
  /** Seconds, including passing tests in each failing file. Missing means unknown. */
  failedFileTimes: Record<string, number>;
  /** Present only when every XML counter agrees with the descendant testcases. */
  attributedCounts?: AttributedTestCounts;
}

/** Validate again before execution: the checkout may have changed since report capture. */
export function validRetryFiles(files: string[], cwd: string): boolean {
  if (!files.length || files.length > MAX_RETRY_FILES) return false;
  try {
    const root = realpathSync(cwd);
    return files.every((file) => {
      if (
        !file ||
        isAbsolute(file) ||
        win32.isAbsolute(file) ||
        file.split(/[\\/]/).includes("..") ||
        [...file].some(
          (char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
        )
      )
        return false;
      const path = realpathSync(resolve(root, file));
      const rel = relative(root, path);
      return (
        !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && statSync(path).isFile()
      );
    });
  } catch {
    return false;
  }
}

const elements = (node: Bun.XML.Node): Bun.XML.Node[] =>
  node.children.filter((child): child is Bun.XML.Node => typeof child === "object" && "name" in child);
const seconds = (value?: string): number | undefined => {
  if (value === undefined || !value.trim()) return undefined;
  const time = Number(value);
  return Number.isFinite(time) && time >= 0 ? time : undefined;
};

/** Only structured JUnit data names files; any incomplete/unsafe failure list is unknown. */
export function parseJUnit(xml: string, cwd: string): FailedTestFiles | undefined {
  try {
    if (xml.length > MAX_REPORT_BYTES || /<!DOCTYPE/i.test(xml)) return undefined;
    const root = Bun.XML.parse(xml, { compact: false });
    if (root.name !== "testsuites" && root.name !== "testsuite") return undefined;
    const failed = new Set<string>();
    const times = new Map<string, number | undefined>();
    const addTime = (file: string, time: number | undefined) => {
      const previous = times.get(file);
      times.set(
        file,
        times.has(file) ? (previous === undefined || time === undefined ? undefined : previous + time) : time,
      );
    };
    const visit = (suite: Bun.XML.Node, inheritedFile?: string) => {
      const children = elements(suite);
      const cases = children.filter((child) => child.name === "testcase");
      const nested = children.filter((child) => child.name === "testsuite");
      const suiteFile = suite.attributes.file ?? inheritedFile;
      let caseFailed = false;
      for (const testcase of cases) {
        const file = testcase.attributes.file ?? suiteFile;
        if (file && file !== suiteFile) addTime(file, seconds(testcase.attributes.time));
        if (elements(testcase).some((child) => child.name === "failure" || child.name === "error")) {
          if (!file) throw new Error("Failure without file");
          failed.add(file);
          caseFailed = true;
        }
      }
      if (suiteFile) addTime(suiteFile, seconds(suite.attributes.time));
      if (Number(suite.attributes.failures) > 0 || Number(suite.attributes.errors) > 0) {
        if (suiteFile) failed.add(suiteFile);
        else if (!caseFailed && !nested.length) throw new Error("Failing suite without files");
      }
      for (const child of nested) visit(child, suiteFile);
    };
    if (root.name === "testsuite") visit(root);
    else for (const suite of elements(root).filter((child) => child.name === "testsuite")) visit(suite);
    const failedFiles = [...failed];
    if (!validRetryFiles(failedFiles, cwd)) return undefined;
    const attributedCounts = attributedJUnitCounts(root, failed);
    return {
      failedFiles,
      ...(attributedCounts ? { attributedCounts } : {}),
      failedFileTimes: Object.fromEntries(
        failedFiles.flatMap((file) => {
          const time = times.get(file);
          return time === undefined ? [] : [[file, time]];
        }),
      ),
    };
  } catch {
    return undefined;
  }
}

export function readJUnit(path: string, cwd: string): FailedTestFiles | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) return undefined;
    return parseJUnit(readFileSync(path, "utf8"), cwd);
  } catch {
    return undefined;
  }
}
