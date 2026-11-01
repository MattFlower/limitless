import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_DECISION_CONFIDENCE } from "../config.ts";
import { parseAllow } from "../core/allow.ts";
import type { PanelRules } from "../core/types.ts";
import { auditDiff } from "../gates/audit.ts";
import { detectGates, type GateConfig, gateScriptNames, pickScripts } from "../gates/detect.ts";
import { runGates } from "../gates/run.ts";
import { worktreeGit } from "../git/command.ts";
import { diffSince, discardChanges, readFileAt } from "../git/repos.ts";
import { readingTimeout } from "../pipeline/engine.ts";
import { implementPrompt, triagePrompt, verifyPrompt } from "../pipeline/prompts.ts";
import { type ReviewInput, reviewRequest } from "../pipeline/review.ts";
import { ReviewSchema, StoredReviewSchema, TriageSchema, VerifySchema } from "../pipeline/schemas.ts";
import { triageDecisions } from "../pipeline/triage-decisions.ts";
import { agentEnv, sh } from "../util/proc.ts";
import type { EvalCase, ImplementCase, ReviewCase } from "./cases.ts";
import { gradeReview } from "./graders/review.ts";
import { gradeTriage } from "./graders/triage.ts";
import { gradeVerify } from "./graders/verify.ts";

export function seedContent(item: ReviewCase, casePath: string): string | undefined {
  if (!item.seedPatch) return undefined;
  const directory = realpathSync(dirname(casePath));
  const path = realpathSync(resolve(directory, item.seedPatch));
  const rel = relative(directory, path);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new Error("seed path escapes dataset directory");
  return readFileSync(path, "utf8");
}

/** Top-level files whose contents gate detection reads; other entries only need to exist. */
const GATE_FILES = new Set([".limitless.toml", "package.json", "pyproject.toml", "Makefile"]);

/**
 * Gate configuration as of `revision`. The pipeline detects gates (protected paths, gate script
 * names) before implementation, so a change cannot weaken the audit by editing them.
 */
export async function gatesAt(cwd: string, revision: string, signal: AbortSignal): Promise<GateConfig> {
  const dir = join(dirname(cwd), "base-gates");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  try {
    // Factory-created eval checkout: no agent or candidate has written it during preparation.
    const tree = await sh(["git", "ls-tree", "-z", revision], { cwd, signal });
    for (const entry of tree.stdout.split("\0").filter(Boolean)) {
      const [meta = "", name = ""] = entry.split("\t");
      const [, type, oid = ""] = meta.split(" ");
      if (type === "tree") mkdirSync(join(dir, name));
      else if (type === "blob")
        writeFileSync(
          join(dir, name),
          // Factory-only preparation, before any candidate writes the repository.
          GATE_FILES.has(name) ? (await sh(["git", "cat-file", "blob", oid], { cwd, signal })).stdout : "",
        );
    }
    return detectGates(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function prepareEvalGates(
  item: { base: string },
  cwd: string,
  signal: AbortSignal,
  setupOnly = false,
) {
  const gates = await gatesAt(cwd, item.base, signal);
  const baseline = await runGates(cwd, setupOnly ? { ...gates, checks: [] } : gates, signal, {
    holder: setupOnly ? "eval review setup" : "eval baseline",
    priority: "start",
  });
  signal.throwIfAborted();
  return { gates, baseline };
}

export async function prepareImplement(item: ImplementCase, cwd: string, signal: AbortSignal) {
  const { gates, baseline } = await prepareEvalGates(item, cwd, signal);
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

/** Prepare only the candidate base; never transfer the reference solution into its history. */
export async function prepareImplementCase(
  item: ImplementCase,
  cwd: string,
  signal: AbortSignal,
  checkout: (base: string, snapshot: boolean) => Promise<(() => Promise<void>) & { base: string }>,
  prepare = prepareImplement,
) {
  const cleanup = await checkout(item.base, item.snapshot === true);
  try {
    const effective = item.snapshot ? { ...item, base: cleanup.base } : item;
    const prepared = await prepare(effective, cwd, signal);
    return { effective, prepared, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function prepareCase(
  item: Exclude<EvalCase, ImplementCase>,
  cwd: string,
  tree: string,
  patch: string | undefined,
  signal: AbortSignal,
  implementerReportMode: "include" | "omit" = "include",
  decisionConfidence = DEFAULT_DECISION_CONFIDENCE,
  allowLocalBinding = false,
) {
  if ("prompt" in item) {
    const input = { repoSlug: item.repo, prompt: item.prompt, tree };
    return {
      prompt: triagePrompt(input),
      timeoutMs: 5 * 60_000,
      decisionTask: triageDecisions(input, decisionConfidence),
    };
  }
  if (patch !== undefined) {
    // Factory-only seed application, before any agent or candidate writes the checkout.
    await sh(["git", "apply", "--index", "-"], { cwd, stdin: patch, signal });
    await worktreeGit(
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
        "Eval seed",
      ],
      { cwd, signal },
    );
  }
  signal.throwIfAborted();
  const diff = await diffSince(cwd, item.base);
  if ("defects" in item) {
    const gates = await gatesAt(cwd, item.base, signal);
    const names = gateScriptNames(gates);
    const audit = auditDiff(diff, {
      allow: parseAllow(item.input.prompt),
      taskClass: null,
      protectedPaths: gates.protectedPaths,
      toolCommands: [],
      gateScripts: {
        before: pickScripts(await readFileAt(cwd, item.base, "package.json"), names),
        after: pickScripts(await readFileAt(cwd, "HEAD", "package.json"), names),
      },
    });
    const review: ReviewInput = {
      prompt: { ...item.input, implementerReportMode, baseSha: item.base, stat: diff.stat, audit },
      timeoutMs: readingTimeout(diff.added + diff.removed),
    };
    return { prompt: reviewRequest(review).prompt, timeoutMs: review.timeoutMs, review };
  }
  return {
    prompt: verifyPrompt({
      ...item.input,
      allowLocalBinding,
      holdout: item.input.holdout ?? { scenarios: [] },
      baseSha: item.base,
    }),
    timeoutMs: readingTimeout(diff.added + diff.removed, 25),
  };
}
/** What a live model call must return; also the strict JSON schema handed to the harness. */
export function schemaFor(item: Exclude<EvalCase, ImplementCase>) {
  return "prompt" in item ? TriageSchema : "defects" in item ? ReviewSchema : VerifySchema;
}
/** What a stored output must satisfy to be regraded from its JSON without a model call. */
export function storedSchemaFor(item: Exclude<EvalCase, ImplementCase>) {
  return "defects" in item ? StoredReviewSchema : schemaFor(item);
}
export function gradeCase(item: Exclude<EvalCase, ImplementCase>, output: unknown, rules: PanelRules = {}) {
  if ("prompt" in item) return gradeTriage(item, TriageSchema.parse(output));
  if ("defects" in item) return gradeReview(item, StoredReviewSchema.parse(output), rules);
  return gradeVerify(item, VerifySchema.parse(output));
}
