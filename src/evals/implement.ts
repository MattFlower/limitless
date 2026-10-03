import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { EvalGrade, EvalStrategy, EvalTrial } from "../core/types.ts";
import { auditDiff } from "../gates/audit.ts";
import { type GateConfig, gateScriptNames, pickScripts } from "../gates/detect.ts";
import { compareGates, type GateRun, runGates } from "../gates/run.ts";
import { diffSince, discardChanges, readFileAt } from "../git/repos.ts";
import { createScratch, removeScratch, withScratch } from "../harness/scratch.ts";
import type { ModelTarget } from "../harness/types.ts";
import { formatAuditFeedback, formatGateFeedback, implementPrompt } from "../pipeline/prompts.ts";
import type { Router } from "../router/router.ts";
import { EFFORT_LEVELS } from "../router/targets.ts";
import { agentEnv, runProcess, sh } from "../util/proc.ts";
import type { hiddenContents, ImplementCase } from "./cases.ts";
import { gatesAt } from "./prepare.ts";

export async function prepareImplement(item: ImplementCase, cwd: string, signal: AbortSignal) {
  const gates = await gatesAt(cwd, item.base, signal);
  const baseline = await runGates(cwd, gates, signal);
  signal.throwIfAborted();
  if (!baseline.setupOk) throw new Error("baseline gate setup failed");
  if (baseline.checks.some((check) => check.output.startsWith("[timed out]")))
    throw new Error("baseline gate check timed out");
  // A check already failing on the snapshot can never block (still_failing), so gates would
  // stop grading anything; a repository whose checks read evals/ can't use snapshot mode.
  const failing = item.snapshot ? baseline.checks.find((check) => !check.ok) : undefined;
  if (failing)
    throw new Error(
      `snapshot mode removed evals/ and baseline check ${failing.name} fails; this case can't use snapshot mode`,
    );
  // Baseline gates already ran repository code that may have configured filters in .git/config
  // and .gitattributes, so this checkout is no more trustworthy than a candidate's.
  await discardChanges(cwd, agentEnv());
  return {
    gates,
    baseline,
    timeoutMs: 60 * 60_000,
    prompt: implementPrompt({
      prompt: item.prompt,
      spec: item.spec,
      gates,
      baseline,
      baseSha: item.base,
      round: 0,
      feedback: null,
      hasHoldout: false,
    }),
  };
}

/** Reject symlink components, including the final file, before any hidden bytes are written. */
function inject(cwd: string, files: ReturnType<typeof hiddenContents>) {
  if (lstatSync(cwd).isSymbolicLink()) throw new Error("hidden destination repository symlink");
  const root = realpathSync(cwd);
  for (const file of files) {
    let current = root;
    for (const part of file.path.split("/")) {
      current = join(current, part);
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) throw new Error(`hidden destination symlink: ${file.path}`);
    }
  }
  for (const file of files) {
    const destination = join(root, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    // Unlink rather than truncate: a candidate-created hard link must not redirect a write either.
    rmSync(destination, { force: true });
    writeFileSync(destination, file.content, { flag: "wx" });
    chmodSync(destination, file.mode);
  }
}

/** Fingerprint ignored and untracked entries without following symlinks or trusting directory metadata. */
async function untrackedState(cwd: string, env: Record<string, string>, since: bigint) {
  const state = new Map<string, string>();
  const visit = (path: string) => {
    const file = join(cwd, path);
    const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      state.set(path, "directory");
      for (const entry of readdirSync(file)) visit(`${path}/${entry}`);
    } else {
      const meta = `${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      const body =
        stat.ctimeNs < since
          ? ""
          : stat.isSymbolicLink()
            ? readlinkSync(file)
            : stat.isFile()
              ? readFileSync(file)
              : "";
      state.set(path, `${meta}:${createHash("sha256").update(body).digest("hex")}`);
    }
  };
  const out = await sh(["git", "ls-files", "-z", "-o"], { cwd, env });
  for (const path of out.stdout.split("\0").filter(Boolean)) visit(path.replace(/\/$/, ""));
  return state;
}

/** Refuse to remove through a parent replaced with a symlink. Cleanup failure stops recovery. */
function removeWithin(root: string, path: string) {
  let current = root;
  for (const part of path.split("/").slice(0, -1)) {
    current = join(current, part);
    if (!lstatSync(current, { throwIfNoEntry: false })?.isDirectory()) return;
  }
  rmSync(join(root, path), { recursive: true, force: true });
  for (let dir = dirname(join(root, path)); dir !== root && readdirSync(dir).length === 0; dir = dirname(dir))
    rmSync(dir, { recursive: true });
}

async function restoreCandidate(
  cwd: string,
  env: Record<string, string>,
  commit: string,
  before: Map<string, string>,
  since: bigint,
) {
  await sh(["git", "-c", "core.hooksPath=/dev/null", "reset", "--hard", "-q", commit], { cwd, env });
  await sh(["git", "clean", "-fdq"], { cwd, env });
  const root = realpathSync(cwd);
  for (const [path, fingerprint] of await untrackedState(cwd, env, since))
    if (before.get(path) !== fingerprint) removeWithin(root, path);
  for (const [path, fingerprint] of await untrackedState(cwd, env, since))
    if (before.get(path) !== fingerprint) throw new Error(`Grading artifact remains: ${path}`);
}

export function failedImplement(reason: "timeout" | "error", error?: string): EvalGrade {
  return {
    pass: false,
    score: 0,
    fields: {},
    riskUnderCall: null,
    implement: { reason, error, commit: null, gates: [], auditBlocks: [], auditWarnings: [], hidden: null },
  };
}

/** Exercise nonempty feedback branches when fingerprinting retry prompts, even before a failure. */
export const RETRY_FEEDBACK_GRADE: EvalGrade = {
  ...failedImplement("error"),
  implement: {
    reason: "gates",
    commit: null,
    gates: (["regressed", "new_failure"] as const).map((verdict) => ({
      name: "CHECK",
      verdict,
      blocking: true,
      result: { name: "CHECK", command: "COMMAND", ok: false, exitCode: 1, durationMs: 0, output: "OUTPUT" },
    })),
    auditBlocks: [undefined, "FILE"].map((file) => ({
      rule: "RULE",
      severity: "block",
      file,
      detail: "DETAIL",
    })),
    auditWarnings: [],
    hidden: { exitCode: 1, timedOut: false, output: "" },
  },
};

export async function gradeImplement(
  item: ImplementCase,
  cwd: string,
  files: ReturnType<typeof hiddenContents>,
  prepared: { gates: GateConfig; baseline: GateRun },
  toolCommands: string[],
  signal: AbortSignal,
): Promise<EvalGrade> {
  // The candidate controls .git/config and .gitattributes, so filters and diff drivers are its code.
  const env = agentEnv();
  const evidence: NonNullable<EvalGrade["implement"]> = {
    reason: null,
    commit: null,
    gates: [],
    auditBlocks: [],
    auditWarnings: [],
    hidden: null,
  };
  let checkout: string | undefined;
  let before: Map<string, string> | undefined;
  const since = BigInt(Date.now() - 5_000) * 1_000_000n;
  try {
    signal.throwIfAborted();
    await sh(["git", "add", "-A"], { cwd, env, signal });
    await sh(
      [
        "git",
        "-c",
        "user.name=Limitless",
        "-c",
        "user.email=limitless@localhost",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "Eval implementation",
      ],
      { cwd, env, signal },
    );
    const commit = (await sh(["git", "rev-parse", "HEAD"], { cwd, env, signal })).stdout.trim();
    evidence.commit = commit;
    before = await untrackedState(cwd, env, since);
    // Grade in a fresh repository outside the candidate's: hidden files never touch its checkout,
    // and its Git metadata (filters, drivers, hooks, index flags) has no say in grading. Fetching
    // only reads the candidate's objects; nothing in the grading repository points back at it.
    checkout = createScratch(cwd);
    const opts = { cwd: checkout, env, signal };
    await sh(["git", "init", "-q"], opts);
    await sh(["git", "fetch", "-q", "--no-tags", "--no-write-fetch-head", cwd, commit, item.base], opts);
    await sh(["git", "-c", "advice.detachedHead=false", "checkout", "-q", "--detach", commit], opts);
    // Audit before gates run: their commands could move HEAD or rewrite the grading repository.
    const names = gateScriptNames(prepared.gates);
    const findings = auditDiff(await diffSince(checkout, item.base, env), {
      request: item.prompt,
      taskClass: null,
      protectedPaths: prepared.gates.protectedPaths,
      toolCommands,
      gateScripts: {
        before: pickScripts(await readFileAt(checkout, item.base, "package.json", env), names),
        after: pickScripts(await readFileAt(checkout, commit, "package.json", env), names),
      },
    });
    evidence.auditBlocks = findings.filter((finding) => finding.severity === "block");
    evidence.auditWarnings = findings.filter((finding) => finding.severity === "warn");
    const after = await runGates(checkout, prepared.gates, signal);
    signal.throwIfAborted();
    await sh(["git", "reset", "--hard", "-q", commit], opts);
    await sh(["git", "clean", "-fdq"], opts);
    evidence.gates = compareGates(prepared.baseline, after);
    const gateTimeout = [
      ...prepared.baseline.setup,
      ...prepared.baseline.checks,
      ...after.setup,
      ...after.checks,
    ].some((g) => g.output.startsWith("[timed out]"));
    if (gateTimeout) evidence.reason = "timeout";
    inject(checkout, files);
    const grading = checkout;
    const hidden = await withScratch(grading, (scratch) =>
      runProcess({
        cmd: ["/bin/sh", "-c", item.hidden.command],
        cwd: grading,
        env: agentEnv({ HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch }),
        signal,
        timeoutMs: item.hidden.timeoutSec * 1000,
        tailLimit: 6000,
      }),
    );
    signal.throwIfAborted();
    evidence.hidden = {
      exitCode: hidden.exitCode,
      timedOut: hidden.timedOut,
      output: `${hidden.stdout}\n${hidden.stderr}`.trim().slice(-6000),
    };
    // Only a shell that never reported an exit status is operational. Exit codes such as 126/127
    // can come from the candidate deleting or chmod-ing something the command needs, so they grade
    // as hidden_tests failures and stay cacheable.
    const launchFailed = hidden.exitCode === null;
    evidence.reason =
      hidden.timedOut || gateTimeout
        ? "timeout"
        : launchFailed
          ? "error"
          : evidence.gates.some((g) => g.blocking)
            ? "gates"
            : evidence.auditBlocks.length
              ? "audit"
              : hidden.exitCode !== 0
                ? "hidden_tests"
                : null;
  } catch (error) {
    signal.throwIfAborted();
    evidence.reason ??= "error";
    evidence.error = (error as Error).message;
  } finally {
    // A failed removal throws: recovery must not continue while grading artifacts remain.
    try {
      if (checkout) removeScratch(checkout);
    } finally {
      if (before && evidence.commit) await restoreCandidate(cwd, env, evidence.commit, before, since);
    }
  }
  return {
    pass: evidence.reason === null,
    score: evidence.reason === null ? 1 : 0,
    fields: {},
    riskUnderCall: null,
    implement: evidence,
  };
}

export function nextImplementTarget(
  router: Router,
  chain: EvalTrial["details"]["switchChain"],
  target: ModelTarget,
  strategy: EvalStrategy,
) {
  if (strategy === "retry") return target;
  if (strategy === "switch") {
    const next = chain?.find((candidate) => candidate.tier > target.tier);
    if (!next) return undefined;
    const model = router.model(next.modelId);
    if (!model) throw new Error("Switch target unavailable: model removed");
    return { ...router.toTarget(model, next.effort), tier: next.tier };
  }
  const levels = EFFORT_LEVELS;
  const index = target.effort === undefined ? -1 : levels.indexOf(target.effort);
  const model = router.model(target.modelId);
  if (index < 0 || !model) return undefined;
  const effort = levels.slice(index + 1).find((level) => model.supportedEfforts.includes(level));
  if (!effort) return undefined;
  try {
    const resolved = router.resolveFor("implement", { modelId: model.id, effort });
    return router.toTarget(model, resolved.effort);
  } catch {
    return undefined;
  }
}

export function implementRetryPrompt(
  item: ImplementCase,
  prepared: Awaited<ReturnType<typeof prepareImplement>>,
  grade: EvalGrade,
  round: number,
) {
  const evidence = grade.implement;
  if (!evidence) throw new Error("missing implementation grade");
  return implementPrompt({
    ...prepared,
    prompt: item.prompt,
    spec: item.spec,
    baseSha: item.base,
    round,
    hasHoldout: false,
    feedback: [
      formatGateFeedback(evidence.gates),
      formatAuditFeedback([...evidence.auditBlocks, ...evidence.auditWarnings]),
      evidence.hidden && evidence.hidden.exitCode !== 0 ? "1 acceptance tests fail" : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
}
