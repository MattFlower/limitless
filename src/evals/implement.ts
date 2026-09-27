import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
import { withScratch } from "../harness/scratch.ts";
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

export function failedImplement(reason: "timeout" | "error", error?: string): EvalGrade {
  return {
    pass: false,
    score: 0,
    fields: {},
    riskUnderCall: null,
    implement: { reason, error, commit: null, gates: [], auditBlocks: [], auditWarnings: [], hidden: null },
  };
}

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
  const modes = new Map<string, number>();
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
    evidence.commit = (await sh(["git", "rev-parse", "HEAD"], { cwd, env, signal })).stdout.trim();
    if (snapshot) {
      // Keep candidate Git metadata private: graders may commit hidden inputs.
      // Reconstruct files only after failure; never copy the worktree (including dependencies).
      cpSync(join(cwd, ".git"), join(snapshot, ".git"), { recursive: true, verbatimSymlinks: true });
      for (const path of (await sh(["git", "ls-files", "-z"], { cwd, env, signal })).stdout
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
          await sh(["git", "-c", "core.hooksPath=/dev/null", "reset", "--hard", "HEAD"], {
            cwd,
            env,
            signal,
          });
          await sh(["git", "clean", "-fd"], { cwd, env, signal });
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
