import type { CommandResult } from "../harness/types.ts";
import type { Holdout, Spec, Verify } from "./schemas.ts";

const DENIAL =
  /\b(?:EPERM|EACCES|permission denied|operation not permitted)\b|sandbox[^.\n]*(?:denied|denial|blocked)/i;
// Words that make a diagnostic a quotation or an asserted expectation rather than an observed barrier.
const NOT_OBSERVED =
  /\b(?:expect(?:ed|s|ing)?|assert(?:ion|s)?|quoted|documentation|source (?:code|text)|literal|matches|toThrow)\b/i;
const ASSERTION =
  /\bexpect\(|^\s*expected:|\bassert(?:ion)?(?:error)?\s*(?:failed|error)\b|\bAssertionError\b|\bexpected\b[^\n]*\breceived\b/im;
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

/** A sentence of the evidence reports a denial as something observed, not quoted or expected. */
function localDenial(text: string, separators: RegExp): boolean {
  return text.split(separators).some((part) => DENIAL.test(part) && !NOT_OBSERVED.test(part));
}

function unwrapShell(command: string): string {
  const wrapped = command.trim().match(/^(?:\S*\/)?(?:ba|z|da)?sh\s+-[a-z]+\s+(['"])([\s\S]*)\1$/);
  return wrapped?.[2] ?? command.trim();
}

interface Check {
  executable: string;
  /** The subcommand or script that identifies the check, e.g. `test` for `bun test`. */
  target?: string;
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
    if (!RUNNERS.has(executable)) {
      checks.push({ executable });
      continue;
    }
    const args = tokens.slice(i + 1).filter((t) => !t.startsWith("-"));
    const target = RUNNER_VERBS.has(args[0] ?? "") ? args[1] : args[0];
    checks.push({ executable, target });
  }
  return checks;
}

function mentions(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i").test(text);
}

type Outcome = "ok" | "barrier" | "failed";

function outcome(result: CommandResult): Outcome {
  if (!result.isError) return "ok";
  // A genuine assertion failure in the same run still needs a code fix, whatever else failed.
  if (ASSERTION.test(result.output)) return "failed";
  return localDenial(result.output, /\n/) ? "barrier" : "failed";
}

/**
 * Blocked when the checks this criterion's evidence refers to last ended on an unresolved
 * environment barrier and none of them failed for another reason.
 */
function blockedByEnvironment(evidence: string, commands: CommandResult[]): boolean {
  if (!localDenial(evidence, /[.;\n]/)) return false;
  const latest = new Map<string, Outcome>();
  for (const result of commands) {
    const checks = executedChecks(result.command).filter(
      (c) => mentions(evidence, c.executable) && (!c.target || mentions(evidence, c.target)),
    );
    if (checks.length === 0) continue;
    const key = checks.map((c) => `${c.executable} ${c.target ?? ""}`).join(" && ");
    latest.set(key, outcome(result));
  }
  const outcomes = [...latest.values()];
  return outcomes.includes("barrier") && !outcomes.includes("failed");
}

export function normalizeVerify(
  verify: Verify,
  spec: Spec,
  holdout: Holdout,
  commands: CommandResult[] = [],
): Verify {
  const criteria = verify.criteria.map((c) => ({
    ...c,
    // A met criterion stays met: evidence may mention an EPERM the verifier worked around.
    status:
      (c.status === "unmet" || c.status === "unclear") && blockedByEnvironment(c.evidence, commands)
        ? ("blocked" as const)
        : c.status,
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
