import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_DECISION_CONFIDENCE } from "../config.ts";
import { parseAllow } from "../core/allow.ts";
import { auditDiff } from "../gates/audit.ts";
import { detectGates, type GateConfig, gateScriptNames, pickScripts } from "../gates/detect.ts";
import { diffSince, readFileAt } from "../git/repos.ts";
import { readingTimeout } from "../pipeline/engine.ts";
import { triagePrompt, verifyPrompt } from "../pipeline/prompts.ts";
import { type ReviewInput, reviewRequest } from "../pipeline/review.ts";
import { ReviewSchema, StoredReviewSchema, TriageSchema, VerifySchema } from "../pipeline/schemas.ts";
import { triageDecisions } from "../pipeline/triage-decisions.ts";
import { sh } from "../util/proc.ts";
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
    const tree = await sh(["git", "ls-tree", "-z", revision], { cwd, signal });
    for (const entry of tree.stdout.split("\0").filter(Boolean)) {
      const [meta = "", name = ""] = entry.split("\t");
      const [, type, oid = ""] = meta.split(" ");
      if (type === "tree") mkdirSync(join(dir, name));
      else if (type === "blob")
        writeFileSync(
          join(dir, name),
          GATE_FILES.has(name) ? (await sh(["git", "cat-file", "blob", oid], { cwd, signal })).stdout : "",
        );
    }
    return detectGates(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    await sh(["git", "apply", "--index", "-"], { cwd, stdin: patch, signal });
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
export function gradeCase(
  item: Exclude<EvalCase, ImplementCase>,
  output: unknown,
  causalAttribution = false,
) {
  if ("prompt" in item) return gradeTriage(item, TriageSchema.parse(output));
  if ("defects" in item) return gradeReview(item, StoredReviewSchema.parse(output), causalAttribution);
  return gradeVerify(item, VerifySchema.parse(output));
}
