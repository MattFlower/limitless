import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { type AttributedTestCounts, attributedJUnitCounts } from "./attribution.ts";
import { redactGateOutput } from "./output.ts";
import { MAX_SKIPPED_TESTS, MAX_TEST_IDENTITY_LENGTH, type TestCoverage } from "./test-coverage.ts";

export const MAX_RETRY_FILES = 50;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

export interface FailedTestFiles {
  failedFiles: string[];
  /** Seconds, including passing tests in each failing file. Missing means unknown. */
  failedFileTimes: Record<string, number>;
  /** Present only when every XML counter agrees with the descendant testcases. */
  attributedCounts?: AttributedTestCounts;
  failureAttributionReason?: string;
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
    const checkout = realpathSync(cwd);
    let failureAttributionReason: string | undefined;
    const attributedCounts = attributedJUnitCounts(
      root,
      failed,
      cwd,
      (file) => {
        try {
          if (file.split(/[\\/]/).includes("node_modules")) return undefined;
          const rel = relative(checkout, realpathSync(resolve(checkout, file)));
          return rel &&
            !isAbsolute(rel) &&
            rel !== ".." &&
            !rel.startsWith(`..${sep}`) &&
            !rel.split(sep).includes("node_modules")
            ? rel
            : undefined;
        } catch {
          return undefined;
        }
      },
      undefined,
      (reason) => {
        failureAttributionReason = redactGateOutput(reason);
      },
    );
    return {
      failedFiles,
      ...(attributedCounts ? { attributedCounts } : {}),
      ...(failureAttributionReason ? { failureAttributionReason } : {}),
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

function readReport(path: string, filesystemBaseline?: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > MAX_REPORT_BYTES ||
      (filesystemBaseline !== undefined && stat.mtimeMs < filesystemBaseline)
    )
      return undefined;
    const xml = readFileSync(fd, "utf8");
    return Buffer.byteLength(xml) <= MAX_REPORT_BYTES ? xml : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readJUnit(path: string, cwd: string): FailedTestFiles | undefined {
  const xml = readReport(path);
  return xml === undefined ? undefined : parseJUnit(xml, cwd);
}

/** Canonical checkout-relative identities shared by reports and the factory diff. */
export function canonicalTestFile(file: string, cwd: string): string | undefined {
  try {
    if (
      !file ||
      (win32.isAbsolute(file) && !isAbsolute(file)) ||
      file.includes("\\") ||
      file.split("/").some((part) => part === ".." || part === "node_modules") ||
      [...file].some(
        (char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
      )
    )
      return undefined;
    const root = realpathSync(cwd);
    const path = realpathSync(resolve(root, file));
    const rel = relative(root, path);
    return rel &&
      !isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      !rel.split(sep).includes("node_modules") &&
      statSync(path).isFile()
      ? rel
      : undefined;
  } catch {
    return undefined;
  }
}

export interface CoveringTestEvidence {
  file: string;
  name: string;
  /** Absence affirms that every exact matching testcase passed in this execution's fresh report. */
  reason?: string;
}

export function readCoveringJUnit(
  path: string,
  cwd: string,
  test: { file: string; name: string },
  filesystemBaseline: number,
  existed: boolean,
): CoveringTestEvidence {
  const evidence: CoveringTestEvidence = { file: test.file.replace(/^\.\//, ""), name: test.name };
  if (existed) return { ...evidence, reason: "JUnit report existed before execution" };
  try {
    const xml = readReport(path, filesystemBaseline);
    if (xml === undefined) return { ...evidence, reason: "JUnit report missing, stale or unsafe" };
    if (/<!DOCTYPE/i.test(xml)) throw new Error("Unsafe XML");
    const root = Bun.XML.parse(xml, { compact: false });
    if (root.name !== "testsuites" && root.name !== "testsuite") throw new Error("Invalid root");
    const requestedFile = canonicalTestFile(test.file, cwd);
    if (!requestedFile) throw new Error("Invalid requested file");
    let matched = false;
    let reason: string | undefined;
    const files = new Set<string>();
    const collect = (node: Bun.XML.Node) => {
      if (node.attributes.file) files.add(node.attributes.file);
      elements(node).forEach(collect);
    };
    collect(root);
    const counts = attributedJUnitCounts(
      root,
      files,
      cwd,
      (file) => canonicalTestFile(file, cwd),
      (node, file, describes = []) => {
        if (!node.attributes.name || describes.some((name) => !name)) throw new Error("Missing name");
        if (
          canonicalTestFile(file ?? "", cwd) !== requestedFile ||
          [...describes, node.attributes.name].join(" ") !== test.name
        )
          return;
        matched = true;
        const outcomes = elements(node);
        if (outcomes.some((child) => child.name === "failure" || child.name === "error"))
          reason = "test failed";
        else if (outcomes.some((child) => child.name === "skipped")) reason ??= "named test skipped";
      },
    );
    if (!counts) throw new Error("Invalid testcase evidence");
    return { ...evidence, reason: reason ?? (matched ? undefined : "name matched no tests") };
  } catch {
    return { ...evidence, reason: "unparseable JUnit report" };
  }
}

/** Successful skip evidence uses the same counter/structure validation as failure attribution. */
export function readJUnitSkips(
  path: string,
  cwd: string,
):
  | {
      counts: AttributedTestCounts;
      skippedTests: NonNullable<TestCoverage["skippedTests"]>;
    }
  | undefined {
  try {
    const xml = readReport(path);
    if (xml === undefined || /<!DOCTYPE/i.test(xml)) return undefined;
    const root = Bun.XML.parse(xml, { compact: false });
    if (root.name !== "testsuites" && root.name !== "testsuite") return undefined;
    const skippedTests: NonNullable<TestCoverage["skippedTests"]> = [];
    const counts = attributedJUnitCounts(
      root,
      new Set(),
      cwd,
      (file) => {
        const canonical = canonicalTestFile(file, cwd);
        if (!canonical) throw new Error("Unsafe report path");
        return canonical;
      },
      (node, rawFile, describes = []) => {
        const children = elements(node);
        const outcomes = children.filter((child) => ["failure", "error", "skipped"].includes(child.name));
        if (outcomes.some((child) => elements(child).length > 0) || outcomes.length > 1)
          throw new Error("Ambiguous testcase");
        if (outcomes[0]?.name !== "skipped") return;
        // Bun's console row (`outer > inner > test`); classname lists describes innermost first.
        const parts = [...describes, node.attributes.name];
        const name = parts.join(" > ");
        const file = rawFile && canonicalTestFile(rawFile, cwd);
        const rawLine = node.attributes.line;
        const line = Number(rawLine);
        if (
          !file ||
          !rawLine ||
          !/^[1-9]\d*$/.test(rawLine) ||
          !Number.isSafeInteger(line) ||
          !node.attributes.name?.trim() ||
          [...name].some(
            (char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
          ) ||
          redactGateOutput(rawFile ?? "") !== rawFile ||
          redactGateOutput(file) !== file ||
          redactGateOutput(name) !== name
        )
          throw new Error("Unusable testcase identity");
        // A separator inside one component would let different describe paths compare equal.
        if (parts.some((part) => !part?.trim() || part.includes(" > ")))
          throw new Error("Ambiguous skip identity");
        if (
          skippedTests.length >= MAX_SKIPPED_TESTS ||
          Math.max(file.length, name.length) > MAX_TEST_IDENTITY_LENGTH
        )
          throw new Error("Skip identity limit");
        skippedTests.push({ file, name, line });
      },
    );
    return counts && counts.failures === 0 && counts.errors === 0 ? { counts, skippedTests } : undefined;
  } catch {
    return undefined;
  }
}
