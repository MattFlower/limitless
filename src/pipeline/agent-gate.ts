import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AgentGateKey } from "../db/store.ts";
import { baselineCacheKey, gateBunVersion, gateEnvDigest, lockfileHash } from "../gates/cache.ts";
import { executeGate } from "../gates/executor.ts";
import { formatGateOutput } from "../gates/failures.ts";
import { redactGateData, redactGateOutput } from "../gates/output.ts";
import { compareGates, confinementFailed, type GateResult, gateEnv, retryRegressions } from "../gates/run.ts";
import { gateSlotScope } from "../gates/slots.ts";
import { worktreeGit } from "../git/command.ts";
import { exportGateSnapshot, snapshotTree } from "../git/repos.ts";
import { commandScope } from "../harness/sandbox.ts";
import { withScratch } from "../harness/scratch.ts";
import type { RunContext } from "./context.ts";

// Validate durable evidence before allowing it to suppress an execution, including nested retries.
const resultSchema: z.ZodType<GateResult> = z.lazy(() =>
  z.object({
    name: z.string(),
    command: z.string(),
    ok: z.boolean(),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().nonnegative(),
    output: z.string(),
    failures: z.string().optional(),
    timedOut: z.boolean().optional(),
    confinementError: z.boolean().optional(),
    firstAttempt: resultSchema.optional(),
    targetedRetry: resultSchema.optional(),
    failedFiles: z.array(z.string()).optional(),
    failedFileTimes: z.record(z.string(), z.number()).optional(),
    failureAttributionComplete: z.boolean().optional(),
    testCoverage: z
      .object({
        passedFiles: z.array(z.string()),
        skippedFiles: z.array(z.string()),
        skippedTests: z
          .array(z.object({ file: z.string(), name: z.string(), line: z.number().optional() }))
          .optional(),
        skippedTestsIncomplete: z.boolean().optional(),
        summary: z.object({ passed: z.number(), failed: z.number() }).optional(),
      })
      .optional(),
  }),
);
const comparisonSchema = z.object({
  name: z.literal("test"),
  verdict: z.enum(["pass", "fixed", "regressed", "still_failing", "new_failure", "new_pass", "flaky"]),
  blocking: z.boolean(),
  baselineConfinementError: z.boolean().optional(),
  result: resultSchema,
  firstAttempt: resultSchema.optional(),
});
const completed = (result: GateResult) =>
  result.name === "test" &&
  result.exitCode !== null &&
  result.exitCode >= 0 &&
  result.exitCode <= 128 &&
  result.ok === (result.exitCode === 0) &&
  !result.timedOut &&
  !confinementFailed(result);

/** Same environment inputs as the baseline cache, with this run and candidate tree as identity. */
export async function agentGateKey(
  ctx: RunContext,
  cwd: string,
  treeHash: string,
): Promise<AgentGateKey | null> {
  if (!ctx.deps.buildSha) return null;
  const gates = ctx.state.gatesConfig;
  if (!gates) return null;
  const env = gateEnv();
  const executor =
    ctx.deps.gateExecutor?.kind === "lan" && ctx.deps.gateExecutor.freshCheckoutFor?.(ctx.repo.slug) !== false
      ? "lan"
      : "local";
  const key = baselineCacheKey({
    executor,
    repoId: ctx.repo.id,
    baseSha: treeHash,
    gates,
    lockfileHash: lockfileHash(cwd),
    bunVersion:
      executor === "lan"
        ? (ctx.deps.bunVersion ?? Bun.version)
        : await gateBunVersion(ctx.runDir, env, ctx.signal),
    platform: process.platform,
    arch: process.arch,
    buildSha: ctx.deps.buildSha,
    envDigest: gateEnvDigest(env, ctx.deps.cfg.baselineEnv),
  });
  return { runId: ctx.run.id, treeHash, gatesHash: key.gatesHash, envHash: key.envHash };
}

export async function reusableAgentGate(ctx: RunContext, cwd: string, sha: string) {
  if (ctx.state.agentFullSuite !== "gate" || !ctx.state.gatesConfig?.checks.some((c) => c.name === "test"))
    return null;
  try {
    const tree = (
      await worktreeGit(["git", "rev-parse", `${sha}^{tree}`], { cwd, signal: ctx.signal })
    ).stdout.trim();
    const key = await agentGateKey(ctx, cwd, tree);
    return lookupAgentGate(ctx, key);
  } catch (error) {
    ctx.log(redactGateOutput(`Factory gate lookup failed; running checks: ${String(error)}`), "warn");
    return null;
  }
}

function lookupAgentGate(ctx: RunContext, key: AgentGateKey | null) {
  try {
    if (!key) return null;
    const record = ctx.store.getAgentGate(key);
    if (!record) return null;
    const comparison = comparisonSchema.parse(redactGateData(record.comparison));
    const test = ctx.state.gatesConfig?.checks.find((c) => c.name === "test");
    if (
      !record.executionId ||
      !Number.isFinite(record.createdAt) ||
      !completed(comparison.result) ||
      comparison.result.command !== redactGateOutput(test?.run ?? "")
    )
      throw new Error("invalid factory gate record");
    return {
      ...comparison,
      result: {
        ...comparison.result,
        reused: { executionId: record.executionId, treeHash: key.treeHash, createdAt: record.createdAt },
      },
    };
  } catch (error) {
    ctx.log(redactGateOutput(`Factory gate lookup failed; running checks: ${String(error)}`), "warn");
    return null;
  }
}

function sessionResult(result: GateResult, tree: string) {
  const safe = redactGateData(result);
  return {
    status: result.timedOut || result.exitCode === null || result.exitCode > 128 ? 1 : result.exitCode,
    text: redactGateOutput(
      `Factory gate run of check test on tree ${tree}: ${result.ok ? "pass" : "FAIL"} (${Math.round(result.durationMs / 1000)}s)${result.reused ? `; reused factory gate execution ${result.reused.executionId}` : ""}\n${formatGateOutput(safe)}`,
    ),
  };
}

/** Only factory-owned executor results enter the record; session arguments and output are unused. */
export async function runAgentGate(ctx: RunContext, cwd: string, sessionSignal: AbortSignal) {
  const signal = AbortSignal.any([ctx.signal, sessionSignal]);
  const config = ctx.state.gatesConfig;
  if (!config?.checks.some((c) => c.name === "test")) throw new Error("No test gate configured");
  return withScratch(cwd, async (scratch) => {
    const tree = await snapshotTree(cwd, signal);
    const checkout = join(scratch, "checkout");
    mkdirSync(checkout);
    await exportGateSnapshot(cwd, tree, checkout, signal);
    return gateSlotScope(
      commandScope(checkout, async () => {
        const key = await agentGateKey(ctx, checkout, tree);
        const reused = lookupAgentGate(ctx, key);
        signal.throwIfAborted();
        if (reused) return sessionResult(reused.result, tree);
        const head = (
          await worktreeGit(["git", "rev-parse", "HEAD"], { cwd: checkout, signal })
        ).stdout.trim();
        let executionId = "";
        const gates = { ...config, checks: config.checks.filter((c) => c.name === "test") };
        const run = (retry = gates, options?: { skipGateSlot?: boolean }) =>
          executeGate(
            {
              runId: ctx.run.id,
              repo: ctx.repo.slug,
              cwd: checkout,
              baseSha: ctx.run.baseSha ?? "",
              headSha: head,
              gates: retry,
              checks: ["test"],
              priority: "start",
              skipGateSlot: options?.skipGateSlot,
            },
            signal,
            { holder: ctx.run.id },
            ctx.deps.gateExecutor,
            undefined,
            async (handle) => {
              executionId ||= handle.id;
            },
          );
        const after = await run();
        signal.throwIfAborted();
        const changed = (
          await worktreeGit(
            [
              "git",
              "diff",
              "--no-renames",
              "--name-only",
              "-z",
              ctx.state.verification?.baseSha ?? ctx.run.baseSha ?? "HEAD",
              tree,
            ],
            { cwd, signal },
          )
        ).stdout
          .split("\0")
          .filter(Boolean);
        const comparisons = await retryRegressions(
          compareGates(ctx.state.baseline ?? null, after),
          checkout,
          gates,
          changed,
          signal,
          undefined,
          run,
          ctx.deps.gateExecutor?.freshCheckoutFor?.(ctx.repo.slug),
        );
        signal.throwIfAborted();
        const comparison = comparisons.find((c) => c.name === "test");
        const result = after.setupOk ? comparison?.result : after.setup.find((r) => !r.ok);
        if (!result) throw new Error("Factory gate returned no test result");
        if (key && after.setupOk && comparison && completed(result)) {
          ctx.store.putAgentGate(key, {
            executionId,
            createdAt: Date.now(),
            comparison: redactGateData(comparison),
          });
        }
        return sessionResult(result, tree);
      }),
    )();
  });
}
