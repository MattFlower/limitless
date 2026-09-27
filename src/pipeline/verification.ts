import { assertionFailure, classifyOutput, observedDenial } from "../harness/diagnostics.ts";
import type { CommandResult } from "../harness/types.ts";
import type { Holdout, Spec, Verify } from "./schemas.ts";

const READERS = new Set(["cat", "rg", "grep", "sed", "head", "tail", "echo", "printf", "less", "awk", "wc"]);
const PREFIXES = new Set(["env", "time", "command", "exec", "nice", "nohup"]);
const RUNNERS = new Set([
  "bun",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "bunx",
  "deno",
  "cargo",
  "go",
  "make",
  "uv",
  "just",
]);
const RUNNER_VERBS = new Set(["run", "exec", "x"]);
// `2>&1`, `>out`, `<in`; a bare `>` or `<` also consumes the following file name.
const REDIRECT = /^\d*(?:>>?|<)/;

function unwrapShell(command: string): string {
  const wrapped = command.trim().match(/^(?:\S*\/)?(?:ba|z|da)?sh\s+-[a-z]+\s+(['"])([\s\S]*)\1$/);
  return wrapped?.[2] ?? command.trim();
}

export interface Check {
  executable: string;
  /** The subcommand or script that identifies the check, e.g. `test` for `bun test`. */
  target?: string;
  /** Remaining positional arguments: `bun test a.test.ts` and `bun test b.test.ts` are distinct checks. */
  args: string[];
}

/** The checks a (possibly wrapped, prefixed or chained) shell command executes. */
export function executedChecks(command: string): Check[] {
  const checks: Check[] = [];
  for (const segment of unwrapShell(command).split(/&&|\|\||[;|\n]/)) {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i] as string;
      // `env -u NAME` / `env -C DIR` consume the following argument.
      if (/^-[uC]$/.test(token) && i > 0) i += 2;
      else if (/^[A-Za-z_]\w*=/.test(token) || PREFIXES.has(token) || (i > 0 && token.startsWith("-"))) i++;
      else break;
    }
    const executable = tokens[i]?.split("/").at(-1);
    if (!executable || executable === "cd" || executable === "export" || READERS.has(executable)) continue;
    const args: string[] = [];
    let flag = false;
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j] as string;
      if (REDIRECT.test(token)) {
        if (/^\d*(?:>>?|<)$/.test(token)) j++;
        flag = false;
      } else if (token.startsWith("-")) flag = !token.includes("=");
      else {
        // `--timeout 5000` is a flag value, `--filter test/a.test.ts` a path that names the check.
        if (!flag || /[/.]/.test(token)) args.push(token);
        flag = false;
      }
    }
    if (!RUNNERS.has(executable)) {
      checks.push({ executable, args });
      continue;
    }
    const verb = RUNNER_VERBS.has(args[0] ?? "") ? 1 : 0;
    checks.push({ executable, target: args[verb], args: args.slice(verb + 1) });
  }
  return checks;
}

function identity(check: Check): string {
  return [check.executable, check.target ?? "", ...check.args].join(" ");
}

function mentions(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i").test(text);
}

type Outcome = "ok" | "barrier" | "failed";

function outcome(result: CommandResult): Outcome {
  if (!result.isError) return "ok";
  const { denied, assertionFailed } = result.diagnostics ?? classifyOutput(result.output);
  // A genuine assertion failure in the same run still needs a code fix, whatever else failed.
  if (assertionFailed) return "failed";
  return denied ? "barrier" : "failed";
}

/**
 * The latest outcome of each distinct check the evidence refers to. A rerun supersedes only the
 * same check: a successful unit test run leaves an integration test's barrier unresolved.
 */
function referencedOutcomes(evidence: string, commands: CommandResult[]): Outcome[] {
  const matches = commands.map((result) => ({
    result,
    checks: executedChecks(result.command).filter(
      (c) => mentions(evidence, c.executable) && (!c.target || mentions(evidence, c.target)),
    ),
  }));
  // Evidence naming a check's arguments (a test file) refers to that check, not to others' files.
  const named = (c: Check) => c.args.some((arg) => mentions(evidence, arg));
  const specific = matches.some((m) => m.checks.some(named));
  const latest = new Map<string, Outcome>();
  for (const { result, checks } of matches) {
    const relevant = specific ? checks.filter((c) => c.args.length === 0 || named(c)) : checks;
    if (relevant.length === 0) continue;
    latest.set(relevant.map(identity).join(" && "), outcome(result));
  }
  return [...latest.values()];
}

type Status = Verify["criteria"][number]["status"];

function normalizeStatus(status: Status, evidence: string, commands: CommandResult[]): Status {
  // A met criterion stays met: evidence may mention an EPERM the verifier worked around.
  if (status === "met") return status;
  const outcomes = referencedOutcomes(evidence, commands);
  const barrier = outcomes.includes("barrier") && !outcomes.includes("failed");
  if (status === "blocked") {
    // An explicit block is still an actionable failure when its checks (or the evidence itself)
    // report an assertion mismatch rather than an observed denial.
    if (outcomes.includes("failed")) return "unmet";
    return !observedDenial(evidence, /[.;\n]/) && assertionFailure(evidence) ? "unmet" : "blocked";
  }
  return observedDenial(evidence, /[.;\n]/) && barrier ? "blocked" : status;
}

export function normalizeVerify(
  verify: Verify,
  spec: Spec,
  holdout: Holdout,
  commands: CommandResult[] = [],
): Verify {
  const criteria = verify.criteria.map((c) => ({
    ...c,
    status: normalizeStatus(c.status, c.evidence, commands),
  }));
  for (const id of [...spec.acceptance_criteria.map((ac) => ac.id), ...holdout.scenarios.map((s) => s.id)]) {
    if (!criteria.some((c) => c.id === id))
      criteria.push({ id, status: "unclear", evidence: "The verifier did not report on this criterion." });
  }
  const unique = new Set(criteria.map((c) => c.id)).size === criteria.length;
  return {
    ...verify,
    criteria,
    overall: unique && criteria.every((c) => c.status === "met") ? "pass" : "fail",
  };
}

export function blockedOnly(verify: Verify): boolean {
  return (
    verify.criteria.some((c) => c.status === "blocked") &&
    verify.criteria.every((c) => c.status === "met" || c.status === "blocked")
  );
}

export const ENVIRONMENT_BLOCKED = "verification blocked by the environment";
