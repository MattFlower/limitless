import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { EvalGrade, EvalStrategy, EvalTrial } from "../core/types.ts";
import { auditDiff } from "../gates/audit.ts";
import { type GateConfig, gateScriptNames, pickScripts } from "../gates/detect.ts";
import { compareGates, type GateRun, runGates } from "../gates/run.ts";
import { diffSince, discardChanges, readFileAt } from "../git/repos.ts";
import { git, restoreCheckout } from "../git/trust.ts";
import { withScratch } from "../harness/scratch.ts";
import type { ModelTarget } from "../harness/types.ts";
import { formatAuditFeedback, formatGateFeedback, implementPrompt } from "../pipeline/prompts.ts";
import type { Router } from "../router/router.ts";
import { EFFORT_LEVELS } from "../router/targets.ts";
import { agentEnv, runProcess } from "../util/proc.ts";
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

/**
 * Every ignored entry, descending into directories Git reports unexpanded (nested repositories) so
 * each file beneath them is tracked on its own. Symlinks are never followed.
 */
async function* ignoredEntries(cwd: string, env: Record<string, string>, signal: AbortSignal) {
  const root = realpathSync(cwd);
  const out = await git(["ls-files", "-z", "-o", "-i", "--exclude-standard"], { cwd, env, signal });
  const pending = out.stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replace(/\/$/, ""));
  for (let path = pending.shift(); path !== undefined; path = pending.shift()) {
    yield path;
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (stat?.isDirectory())
      pending.unshift(...readdirSync(join(root, path)).map((entry) => `${path}/${entry}`));
  }
}

/**
 * Identify an ignored file's exact pre-grade state. ctime can't be forged by the grader, but coarse
 * filesystem clocks can hide a same-tick rewrite, so recently changed files also carry their contents.
 * Directories are compared by their entries, not their metadata: overwriting a child leaves it unchanged.
 */
function fingerprint(root: string, path: string, since: bigint) {
  const file = join(root, path);
  const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isDirectory()) return "directory";
  const meta = `${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  if (stat.ctimeNs < since) return meta;
  const body = stat.isSymbolicLink() ? readlinkSync(file) : stat.isFile() ? readFileSync(file) : "";
  return `${meta}:${createHash("sha256").update(body).digest("hex")}`;
}

async function ignoredState(cwd: string, env: Record<string, string>, signal: AbortSignal) {
  const root = realpathSync(cwd);
  const since = BigInt(Date.now() - 5_000) * 1_000_000n;
  const state = new Map<string, string | null>();
  for await (const path of ignoredEntries(cwd, env, signal)) state.set(path, fingerprint(root, path, since));
  return { since, state };
}

/** Remove a path without following symlinked parents, then prune directories it left empty. */
function removeWithin(root: string, path: string) {
  const parts = path.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return;
  }
  rmSync(join(root, path), { recursive: true, force: true });
  for (let dir = dirname(join(root, path)); dir !== root && readdirSync(dir).length === 0; dir = dirname(dir))
    rmSync(dir, { recursive: true });
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
  restore = false,
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
  const snapshot = restore ? mkdtempSync(join(dirname(cwd), "grade-")) : undefined;
  let snapshotReady = false;
  let ignoredBefore: Awaited<ReturnType<typeof ignoredState>> | undefined;
  const modes = new Map<string, number>();
  try {
    signal.throwIfAborted();
    // Config, hooks, attributes and index flags go back to the factory's before anything is staged.
    await restoreCheckout(cwd, signal, true);
    await git(["add", "-A"], { cwd, env, signal });
    await git(
      [
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
    evidence.commit = (await git(["rev-parse", "HEAD"], { cwd, env, signal })).stdout.trim();
    if (snapshot) {
      // Keep candidate Git metadata private: graders may commit hidden inputs.
      // Reconstruct files only after failure; never copy the worktree (including dependencies).
      cpSync(join(cwd, ".git"), join(snapshot, ".git"), { recursive: true, verbatimSymlinks: true });
      for (const path of (await git(["ls-files", "-z"], { cwd, env, signal })).stdout
        .split("\0")
        .filter(Boolean))
        if (!lstatSync(join(cwd, path)).isSymbolicLink()) modes.set(path, statSync(join(cwd, path)).mode);
      snapshotReady = true;
    }
    const after = await runGates(cwd, prepared.gates, signal);
    signal.throwIfAborted();
    await discardChanges(cwd, env);
    evidence.gates = compareGates(prepared.baseline, after);
    const gateTimeout = [
      ...prepared.baseline.setup,
      ...prepared.baseline.checks,
      ...after.setup,
      ...after.checks,
    ].some((g) => g.output.startsWith("[timed out]"));
    if (gateTimeout) evidence.reason = "timeout";
    const names = gateScriptNames(prepared.gates);
    const findings = auditDiff(await diffSince(cwd, item.base, env), {
      taskClass: null,
      protectedPaths: prepared.gates.protectedPaths,
      toolCommands,
      gateScripts: {
        before: pickScripts(await readFileAt(cwd, item.base, "package.json", env), names),
        after: pickScripts(await readFileAt(cwd, "HEAD", "package.json", env), names),
      },
    });
    evidence.auditBlocks = findings.filter((finding) => finding.severity === "block");
    evidence.auditWarnings = findings.filter((finding) => finding.severity === "warn");
    if (snapshot) ignoredBefore = await ignoredState(cwd, env, signal);
    inject(cwd, files);
    const hidden = await withScratch(cwd, (scratch) =>
      runProcess({
        cmd: ["/bin/sh", "-c", item.hidden.command],
        cwd,
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
    if (snapshot) {
      try {
        if (snapshotReady && evidence.reason !== null && !signal.aborted) {
          // Preserve ignored dependencies/build outputs across recovery rounds.
          rmSync(join(cwd, ".git"), { recursive: true, force: true });
          cpSync(join(snapshot, ".git"), join(cwd, ".git"), { recursive: true, verbatimSymlinks: true });
          await git(["reset", "--hard", "HEAD"], {
            cwd,
            env,
            signal,
          });
          await git(["clean", "-fd"], { cwd, env, signal });
          // Ignore rules are candidate-controlled: drop hidden files and anything the grader created
          // or rewrote, since a pre-existing ignored output may now hold hidden test contents.
          if (ignoredBefore) {
            const root = realpathSync(cwd);
            for (const file of files) removeWithin(root, file.path);
            for await (const path of ignoredEntries(cwd, env, signal)) {
              const before = ignoredBefore.state.get(path);
              if (before === undefined || before !== fingerprint(root, path, ignoredBefore.since))
                removeWithin(root, path);
            }
            await git(["reset", "--hard", "HEAD"], {
              cwd,
              env,
              signal,
            });
          }
          for (const [path, mode] of modes) chmodSync(join(cwd, path), mode);
        }
      } finally {
        rmSync(snapshot, { recursive: true, force: true });
      }
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
