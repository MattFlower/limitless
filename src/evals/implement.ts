import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvalGrade } from "../core/types.ts";
import { auditDiff } from "../gates/audit.ts";
import { type GateConfig, gateScriptNames, pickScripts } from "../gates/detect.ts";
import { compareGates, type GateRun, runGates } from "../gates/run.ts";
import { diffSince, discardChanges, readFileAt } from "../git/repos.ts";
import { implementPrompt } from "../pipeline/prompts.ts";
import { agentEnv, runProcess, sh } from "../util/proc.ts";
import type { hiddenContents, ImplementCase } from "./cases.ts";
import { gatesAt } from "./prepare.ts";

export async function prepareImplement(item: ImplementCase, cwd: string, signal: AbortSignal) {
  const gates = await gatesAt(cwd, item.base, signal);
  const baseline = await runGates(cwd, gates, signal);
  signal.throwIfAborted();
  await discardChanges(cwd);
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
): Promise<EvalGrade> {
  const evidence: NonNullable<EvalGrade["implement"]> = {
    reason: null,
    commit: null,
    gates: [],
    auditBlocks: [],
    auditWarnings: [],
    hidden: null,
  };
  try {
    signal.throwIfAborted();
    await sh(["git", "add", "-A"], { cwd, signal });
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
      { cwd, signal },
    );
    evidence.commit = (await sh(["git", "rev-parse", "HEAD"], { cwd, signal })).stdout.trim();
    const after = await runGates(cwd, prepared.gates, signal);
    signal.throwIfAborted();
    await discardChanges(cwd);
    evidence.gates = compareGates(prepared.baseline, after);
    const gateTimeout = [
      ...prepared.baseline.setup,
      ...prepared.baseline.checks,
      ...after.setup,
      ...after.checks,
    ].some((g) => g.output.startsWith("[timed out]"));
    if (gateTimeout) evidence.reason = "timeout";
    const names = gateScriptNames(prepared.gates);
    const findings = auditDiff(await diffSince(cwd, item.base), {
      taskClass: null,
      protectedPaths: prepared.gates.protectedPaths,
      toolCommands,
      gateScripts: {
        before: pickScripts(await readFileAt(cwd, item.base, "package.json"), names),
        after: pickScripts(await readFileAt(cwd, "HEAD", "package.json"), names),
      },
    });
    evidence.auditBlocks = findings.filter((finding) => finding.severity === "block");
    evidence.auditWarnings = findings.filter((finding) => finding.severity === "warn");
    inject(cwd, files);
    const hidden = await runProcess({
      cmd: ["/bin/sh", "-c", item.hidden.command],
      cwd,
      env: agentEnv(),
      signal,
      timeoutMs: item.hidden.timeoutSec * 1000,
      tailLimit: 6000,
    });
    signal.throwIfAborted();
    evidence.hidden = {
      exitCode: hidden.exitCode,
      timedOut: hidden.timedOut,
      output: `${hidden.stdout}\n${hidden.stderr}`.trim().slice(-6000),
    };
    // Shells reserve 126/127 for commands that cannot execute. Dash uses 2 for an unreadable script.
    const launchFailed =
      hidden.exitCode === null ||
      hidden.exitCode === 126 ||
      hidden.exitCode === 127 ||
      (hidden.exitCode === 2 &&
        /^.*\bsh: .*cannot open .*: (No such file|Permission denied)/m.test(hidden.stderr));
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
  }
  return {
    pass: evidence.reason === null,
    score: evidence.reason === null ? 1 : 0,
    fields: {},
    riskUnderCall: null,
    implement: evidence,
  };
}
