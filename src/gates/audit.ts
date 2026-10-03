import type { AuditAllowance, TaskClass } from "../core/types.ts";
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
  gitlink: boolean;
}

export function splitPatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/ (b\/.+|"b\/.+")$/);
      let path = m?.[1] ?? "";
      if (path.startsWith('"')) {
        const escapes = "\x07\b\f\n\r\t\v";
        const decoded = path
          .slice(1, -1)
          .replace(/\\([0-7]{3}|[abfnrtv"\\])/g, (_, c: string) =>
            /^[0-7]/.test(c)
              ? String.fromCharCode(Number.parseInt(c, 8))
              : (escapes["abfnrtv".indexOf(c)] ?? c),
          );
        const encoding = /\\[0-7]{3}/.test(path) ? "latin1" : "utf8";
        path = Buffer.from(decoded, encoding).toString("utf8");
      }
      cur = { path: path.slice(2), added: [], removed: [], gitlink: false };
      files.push(cur);
    } else if (cur && /^(new (file )?mode 160000|index .* 160000)$/.test(line)) {
      cur.gitlink = true;
    } else if (cur && line.startsWith("+") && !/^\+\+\+ ("?b\/|\/dev\/null$)/.test(line)) {
      cur.added.push(line.slice(1));
    } else if (cur && line.startsWith("-") && !/^--- ("?a\/|\/dev\/null$)/.test(line)) {
      cur.removed.push(line.slice(1));
    }
  }
  return files;
}

const BUILTIN_DIFF_DRIVER =
  /^(ada|bash|bibtex|cpp|csharp|css|dts|elixir|fortran|fountain|golang|html|java|kotlin|markdown|matlab|objc|pascal|perl|php|python|ruby|rust|scheme)$/;

const HIDES: Record<string, (value: string) => boolean> = {
  diff: (value) => value === "unset" || (value !== "set" && !BUILTIN_DIFF_DRIVER.test(value)),
  text: (value) => value === "unset",
  binary: (value) => value !== "unset",
  filter: (value) => value !== "unset",
  "linguist-generated": (value) => value !== "unset" && value !== "false",
};

/** Hiding attributes (check-attr values: set, unset, unspecified or a string), as written in .gitattributes. */
function hiding(attributes: [string, string][]): string[] {
  return attributes
    .filter(([name, value]) => value !== "unspecified" && HIDES[name]?.(value))
    .map(([name, value]) => (value === "set" ? name : value === "unset" ? `-${name}` : `${name}=${value}`));
}

/** Hiding attributes effective at head that were not effective at base. */
export function newlyHidden(base: Record<string, string>, head: Record<string, string>): string[] {
  const before = hiding(Object.entries(base));
  return hiding(Object.entries(head)).filter((attribute) => !before.includes(attribute));
}

export const isAttributeFile = (path: string) => path.split("/").at(-1)?.toLowerCase() === ".gitattributes";

/** Added attribute lines that can hide text diffs, with the pathspec of the files they can match. */
export function attributeRules(patch: string) {
  return splitPatch(patch)
    .filter((fp) => isAttributeFile(fp.path))
    .flatMap((fp) =>
      fp.added.flatMap((line) => {
        const tokens = line.trim().match(/^("(?:\\.|[^"])*"|\S+)\s+(.+)$/);
        if (!tokens || /^[#!]/.test(tokens[1] ?? "")) return [];
        const found = hiding(
          (tokens[2] ?? "").split(/\s+/).map((token) => {
            const [name = "", value] = token.replace(/^[-!]/, "").split(/=(.*)/);
            return [name, value ?? ({ "-": "unset", "!": "unspecified" }[token[0] ?? ""] || "set")];
          }),
        );
        let pattern = tokens[1] ?? "";
        try {
          if (pattern.startsWith('"')) pattern = JSON.parse(pattern) as string;
        } catch {
          /* Unknown quoting blocks conservatively. */
        }
        // Attribute-file scope as a Git pathspec; icase over-matches, which only adds candidates.
        const directory = fp.path.slice(0, -".gitattributes".length).replace(/[*?[\\]/g, "\\$&");
        const glob = pattern.includes("/") ? pattern.replace(/^\//, "") : `**/${pattern}`;
        // binary/-diff on binary-only content hides nothing; macros and other attributes never qualify,
        // nor do quoted patterns, whose Git C-style unquoting JSON.parse does not reproduce.
        const exemptable =
          !/^("|\[attr\])/.test(tokens[1] ?? "") && found.every((a) => /^(binary|-diff|-text)$/.test(a));
        const rule = { file: fp.path, key: `${fp.path}\0${tokens[1]}`, pattern, attributes: tokens[2] ?? "" };
        return found.length ? [{ ...rule, exemptable, pathspec: `:(glob,icase)${directory}${glob}` }] : [];
      }),
    );
}

const allowHint = (kind: AuditAllowance) => `If this is intended, add \`Allow: ${kind}\` to the request.`;

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
    /** Persisted requester opt-ins; never parsed from specs, commit messages or composed prompts. */
    allow?: readonly AuditAllowance[];
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
  const patches = splitPatch(diff.patch);
  for (const path of diff.gitlinks ?? patches.filter((p) => p.gitlink && p.added.length).map((p) => p.path)) {
    if (!ctx.allow?.includes("submodules"))
      findings.push({
        rule: "gitlink",
        severity: "block",
        file: path,
        detail: `${path}: nested repository contents are absent from the diff, so they cannot be reviewed. Remove the nested repository unless the request asks for it. ${allowHint("submodules")}`,
      });
  }
  const hidden = (file: string | undefined, detail: string) =>
    ctx.allow?.includes("gitattributes") ||
    findings.push({
      rule: "gitattributes",
      severity: "block",
      ...(file ? { file } : {}),
      detail: `${detail} Remove the attribute change unless the request asks for it. ${allowHint("gitattributes")}`,
    });
  for (const { file, key, pattern, attributes, exemptable } of attributeRules(
    diff.attributePatch ?? diff.patch,
  )) {
    const text = diff.attributeMatches?.[key];
    if (!exemptable || text?.length !== 0)
      hidden(file, `${file}: ${pattern} (${attributes}) can hide text diffs for ${text?.[0] ?? pattern}.`);
  }
  for (const { path, base, head } of diff.attributes ?? []) {
    const added = newlyHidden(base, head).join(" ");
    if (added && diff.textPaths?.includes(path))
      hidden(path, `${path}: attributes at head (${added}) hide its diff.`);
  }
  for (const error of diff.attributeErrors ?? [])
    hidden(undefined, `Hidden diffs cannot be ruled out because the ${error}.`);
  for (const f of diff.files) {
    const touched = f.from ? [f.from, f.path] : [f.path];
    const hit = touched.find((p) => protectedRes.some((re) => re.test(p)));
    if (hit) {
      // Protection is against tampering with what exists; adding a new file there is only notable.
      const added = f.status.startsWith("A");
      findings.push({
        rule: "protected-path",
        severity: added ? "warn" : "block",
        file: hit,
        detail: added ? "Added a file under a protected path." : "Edited a protected path.",
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
  for (const fp of patches) {
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
