import type { TaskClass } from "../core/types.ts";
import type { DiffInfo } from "../git/repos.ts";

export interface AuditFinding {
  rule: string;
  severity: "block" | "warn";
  file?: string;
  detail: string;
}

const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$|Test\.java$/;
const TEST_CONFIG =
  /(^|\/)(jest|vitest|playwright|karma|mocha|ava)\.config\.|(^|\/)(pytest\.ini|conftest\.py|tox\.ini|\.mocharc[^/]*|bunfig\.toml)$/;
const CI_CONFIG = /^\.github\/workflows\/|^\.gitlab-ci\.yml$|^\.circleci\//;
const LINT_CONFIG =
  /(^|\/)(biome\.jsonc?|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|\.golangci\.ya?ml|ruff\.toml|\.flake8)$/;
const LOCKFILE =
  /(^|\/)(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|uv\.lock|poetry\.lock)$/;

// Anchored to the start of a statement so test *data* that mentions these (e.g. an auditor's own
// fixtures inside string literals) doesn't trip them.
const SKIP_MARKERS: [RegExp, string][] = [
  [/^\s*(it|test|describe)\.(skip|only|todo)\s*\(/, "test skipped/focused with .skip/.only"],
  [/^\s*x(it|describe|test)\s*\(/, "test disabled with xit/xdescribe"],
  [/^\s*@pytest\.mark\.(skip|xfail)/, "pytest skip/xfail marker"],
  [/^\s*t\.Skip(Now|f)?\(/, "Go t.Skip()"],
  [/^\s*#\[ignore\]/, "Rust #[ignore]"],
  [/^\s*@(Disabled|Ignore)\b/, "JUnit @Disabled/@Ignore"],
];

const SUPPRESSIONS: [RegExp, string][] = [
  [/eslint-disable/, "eslint-disable comment"],
  [/biome-ignore/, "biome-ignore comment"],
  [/@ts-(ignore|nocheck)/, "@ts-ignore/@ts-nocheck"],
  [/#\s*type:\s*ignore/, "type: ignore"],
  [/#\s*noqa/, "noqa"],
  [/\/\/\s*nolint/, "nolint"],
];

const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "GitHub token"],
  [/\bsk-(ant|or|proj)-[A-Za-z0-9_-]{20,}\b/, "API key"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
];

const ASSERTION = /\b(expect|assert\w*|should)\b|\bt\.(Error|Fatal|Fail)/;

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "@@GLOBSTAR@@")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/@@GLOBSTAR@@/g, ".*");
  return new RegExp(`^${escaped}$`);
}

interface FilePatch {
  path: string;
  added: string[];
  removed: string[];
}

export function splitPatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/ b\/(.+)$/);
      cur = { path: m?.[1] ?? "", added: [], removed: [] };
      files.push(cur);
    } else if (cur && line.startsWith("+") && !line.startsWith("+++")) {
      cur.added.push(line.slice(1));
    } else if (cur && line.startsWith("-") && !line.startsWith("---")) {
      cur.removed.push(line.slice(1));
    }
  }
  return files;
}

/**
 * Deterministic checks for reward hacking and scope problems. Blocking findings send the work
 * back to the implementer; warnings are handed to the reviewer as things to scrutinize.
 */
export interface GateScripts {
  /** Script bodies the gate commands depend on (e.g. package.json "test"), before and after. */
  before: Record<string, string>;
  after: Record<string, string>;
}

export function auditDiff(
  diff: DiffInfo,
  ctx: {
    taskClass: TaskClass | null;
    protectedPaths: string[];
    toolCommands?: string[];
    gateScripts?: GateScripts;
  },
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  if (diff.files.length === 0 && ctx.taskClass !== "question") {
    findings.push({
      rule: "empty-diff",
      severity: "block",
      detail: "The implementation produced no changes.",
    });
    return findings;
  }

  const protectedRes = ctx.protectedPaths.map(globToRegex);
  for (const f of diff.files) {
    const touched = f.from ? [f.from, f.path] : [f.path];
    const hit = touched.find((p) => protectedRes.some((re) => re.test(p)));
    if (hit) {
      findings.push({
        rule: "protected-path",
        severity: "block",
        file: hit,
        detail: "Edited a protected path.",
      });
    }
    if (f.status.startsWith("D") && TEST_FILE.test(f.path)) {
      findings.push({
        rule: "test-deleted",
        severity: "warn",
        file: f.path,
        detail: "A test file was deleted.",
      });
    }
    if (f.status.startsWith("R") && f.from && TEST_FILE.test(f.from) && !TEST_FILE.test(f.path)) {
      findings.push({
        rule: "test-moved-out",
        severity: "block",
        file: f.from,
        detail: `Test file renamed to ${f.path}, where the test runner will no longer find it.`,
      });
    }
    if (TEST_CONFIG.test(f.path))
      findings.push({
        rule: "test-config",
        severity: "warn",
        file: f.path,
        detail: "Test runner config changed.",
      });
    if (CI_CONFIG.test(f.path))
      findings.push({ rule: "ci-config", severity: "warn", file: f.path, detail: "CI workflow changed." });
    if (LINT_CONFIG.test(f.path))
      findings.push({
        rule: "lint-config",
        severity: "warn",
        file: f.path,
        detail: "Lint configuration changed.",
      });
    if (LOCKFILE.test(f.path) && ctx.taskClass !== "dependency_update") {
      findings.push({
        rule: "lockfile",
        severity: "warn",
        file: f.path,
        detail: "Lockfile changed in a task that is not a dependency update.",
      });
    }
  }

  let assertionsAdded = 0;
  let assertionsRemoved = 0;
  for (const fp of splitPatch(diff.patch)) {
    const isTest = TEST_FILE.test(fp.path);
    for (const line of fp.added) {
      for (const [re, label] of SKIP_MARKERS) {
        if (isTest && re.test(line))
          findings.push({ rule: "test-skipped", severity: "block", file: fp.path, detail: label });
      }
      for (const [re, label] of SUPPRESSIONS) {
        if (re.test(line))
          findings.push({ rule: "suppression", severity: "warn", file: fp.path, detail: `Added ${label}.` });
      }
      for (const [re, label] of SECRETS) {
        if (re.test(line))
          findings.push({
            rule: "secret",
            severity: "block",
            file: fp.path,
            detail: `Possible ${label} added.`,
          });
      }
      if (isTest && ASSERTION.test(line)) assertionsAdded++;
    }
    if (isTest) for (const line of fp.removed) if (ASSERTION.test(line)) assertionsRemoved++;
  }
  if (assertionsRemoved - assertionsAdded >= 3) {
    findings.push({
      rule: "assertions-removed",
      severity: "warn",
      detail: `Net ${assertionsRemoved - assertionsAdded} assertions removed from tests.`,
    });
  }
  const scripts = ctx.gateScripts;
  if (scripts) {
    for (const [name, before] of Object.entries(scripts.before)) {
      const after = scripts.after[name];
      if (after === before) continue;
      findings.push({
        rule: "gate-script-changed",
        severity: "block",
        file: "package.json",
        detail:
          after === undefined
            ? `Removed the "${name}" script that a factory check runs.`
            : `Changed the "${name}" script that a factory check runs ("${before}" → "${after}").`,
      });
    }
  }
  for (const cmd of ctx.toolCommands ?? []) {
    if (/--no-verify\b/.test(cmd)) {
      findings.push({
        rule: "no-verify",
        severity: "warn",
        detail: `Agent ran a command with --no-verify: ${cmd}`,
      });
    }
  }
  return dedupe(findings);
}

function dedupe(findings: AuditFinding[]): AuditFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.rule}|${f.file ?? ""}|${f.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
