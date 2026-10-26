import type { GateConfig } from "../gates/detect.ts";
import { quoteRetryFiles, singleBunTest } from "../gates/docs.ts";
import { validRetryFiles } from "../gates/junit.ts";
import { redactGateData } from "../gates/output.ts";
import { confinementFailed, type GateResult, type GateRun } from "../gates/run.ts";
import { MAX_TEST_IDENTITY_LENGTH } from "../gates/test-coverage.ts";
import { worktreeGit } from "../git/command.ts";
import { discardChanges } from "../git/repos.ts";
import type { RunContext } from "./context.ts";
import { gateCommandScope, runGateExecution } from "./gate-execution.ts";
import type { Verify } from "./schemas.ts";

type Test = { file: string; name: string };
export interface CoveringTestRun extends Test {
  verifiedSha: string;
  round: number;
  stageId: number;
  result?: GateResult;
  command?: string;
  skipped?: number;
  reason?: string;
}
export const coveringPattern = (name: string): string =>
  `(?:^| )${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
const controls = (text: string) =>
  [...text].some((c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159));

function matchingSkips(test: Test, result: GateResult): number {
  const pattern = new RegExp(coveringPattern(test.name));
  let file = "";
  let count = 0;
  for (const line of result.output.split(/\r?\n/).map((line) => line.trim())) {
    if (/\.(?:test|spec)\.[cm]?[jt]sx?:$/.test(line)) file = line.slice(0, -1).replace(/^\.\//, "");
    const title = /^\((?:skip|todo)\) (.*?)(?:\s+\[[\d.]+m?s\])?$/.exec(line)?.[1];
    if (file === test.file.replace(/^\.\//, "") && title && pattern.test(title)) count++;
  }
  return Math.max(
    count,
    result.testCoverage?.skippedTests?.filter(
      (t) => t.file === test.file.replace(/^\.\//, "") && pattern.test(t.name),
    ).length ?? 0,
  );
}

export function selectCoveringTests(verify: Verify) {
  let count = 0;
  return verify.criteria.map((c) => {
    const requested = c.status === "blocked" && c.blockedReason === "sandbox" ? (c.covering_tests ?? []) : [];
    const tests = requested.slice(0, 3).filter(() => ++count <= 10);
    return {
      tests,
      reason:
        requested.length > 3
          ? "per-criterion limit reached"
          : tests.length < requested.length
            ? "per-round limit reached"
            : undefined,
    };
  });
}

/** Validate committed membership separately from filesystem containment; neither proves the other. */
export async function coveringTestCommand(test: Test, cfg: GateConfig | undefined, cwd: string, sha: string) {
  const retry = cfg?.retryFiles;
  if (
    cfg?.checks.length !== 1 ||
    !cfg.checks[0] ||
    !singleBunTest(cfg.checks[0].run) ||
    !retry ||
    retry.split("{files}").length !== 2 ||
    !singleBunTest(retry, "{files}")
  )
    return { reason: "targeted retries not configured" };
  if (!validRetryFiles([test.file], cwd)) return { reason: "file outside repository or invalid retry file" };
  if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(test.file)) return { reason: "file is not a test file" };
  if (!test.name.trim() || test.name.length > MAX_TEST_IDENTITY_LENGTH || controls(test.name))
    return { reason: "invalid test name" };
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha)) return { reason: "invalid verified SHA" };
  const tracked = await worktreeGit(
    [
      "git",
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      sha,
      "--",
      test.file.replace(/^\.\//, ""),
    ],
    { cwd, allowFail: true },
  );
  if (tracked.exitCode !== 0 || !tracked.stdout.split("\0").includes(test.file.replace(/^\.\//, "")))
    return { reason: "file not tracked at verified SHA" };

  const command = `${retry.replace("{files}", () => quoteRetryFiles([test.file]))} -t '${coveringPattern(test.name).replaceAll("'", "'\\''")}'`;
  return singleBunTest(command)
    ? { command }
    : { reason: "expanded command is not a single bun test invocation" };
}

export function coveringTestRefusal(
  run: CoveringTestRun | undefined,
  sha: string,
  succeeded: number[],
): string | undefined {
  if (!run) return "no factory record";
  if (run.reason) return run.reason;
  const r = run.result;
  if (!r || !succeeded.includes(run.stageId)) return "no succeeded covering-test stage";
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha) || r.executionProvenance?.sha !== sha)
    return "run executed at a different SHA";
  if (r.executionProvenance.trackedClean !== true) return "run changed tracked files";
  if (
    !r.ok ||
    r.exitCode !== 0 ||
    r.timedOut ||
    confinementFailed(r) ||
    r.testCoverage?.summary?.failed ||
    /^\s*\(fail\)/m.test(r.output)
  )
    return "test failed";
  const coverage = r.testCoverage;
  if (
    run.skipped ||
    coverage?.skippedTests?.some(
      (t) => t.file === run.file.replace(/^\.\//, "") && new RegExp(coveringPattern(run.name)).test(t.name),
    )
  )
    return "named test skipped";
  if (
    !coverage?.summary ||
    coverage.summary.passed < 1 ||
    !coverage.passedFiles.includes(run.file.replace(/^\.\//, ""))
  )
    return "name matched no tests";
  if (coverage.summary.failed !== 0) return "test failed";
  if (coverage.skippedTestsIncomplete) return "named test skip evidence incomplete";
  return undefined;
}

/** Save the result before clearing the durable execution handle, including on restart. */
export async function runCoveringTests(
  ctx: RunContext,
  verify: Verify,
  sha: string,
  checkHead: () => Promise<void>,
) {
  const cwd = ctx.state.worktreePath as string;
  const cfg = ctx.state.gatesConfig;
  ctx.state.coveringTestRuns ??= [];
  const records = ctx.state.coveringTestRuns;
  for (const { tests } of selectCoveringTests(verify))
    for (const test of tests) {
      let record = records.find((r) => r.verifiedSha === sha && r.file === test.file && r.name === test.name);
      if (record?.result || record?.reason) continue;
      const built =
        record?.command && ctx.state.gateExecution?.purpose === `covering-test:${record.stageId}`
          ? { command: record.command }
          : await coveringTestCommand(test, cfg, cwd, sha);
      if (!record) {
        record = { ...test, verifiedSha: sha, round: ctx.state.round, stageId: 0 };
        records.push(record);
      }
      if (!record.stageId && records.filter((r) => r.round === ctx.state.round && r.stageId > 0).length >= 10)
        record.reason = "per-round limit reached";
      if (record.reason || !built.command || !cfg?.checks[0]) {
        record.reason ??= built.reason;
        await ctx.save();
        continue;
      }
      const stage = record.stageId
        ? ctx.store.getStage(record.stageId)
        : ctx.store.startStage(ctx.run.id, "gates", ctx.state.round);
      if (!stage) throw new Error("Missing covering-test stage");
      record.stageId = stage.id;
      record.command = built.command;
      await ctx.save();
      const check = cfg.checks[0];
      const current = record;
      const purpose = `covering-test:${stage.id}`;
      const saveResult = (_handle: unknown, run: GateRun) => {
        current.result = redactGateData(
          run.checks[0]
            ? {
                ...run.checks[0],
                executionProvenance: {
                  sha: run.sha,
                  trackedClean: run.trackedClean,
                  provenanceError: run.provenanceError,
                },
              }
            : undefined,
        );
        if (!current.result) current.reason = "missing check result";
        else current.skipped = matchingSkips(test, current.result);
        ctx.store.finishStage(stage.id, "succeeded", "covering-test execution recorded");
      };
      try {
        await gateCommandScope(ctx, "gates", purpose, cwd, () =>
          runGateExecution(
            ctx,
            "gates",
            purpose,
            cwd,
            {
              ...cfg,
              setup: ctx.deps.gateExecutor?.freshCheckoutFor?.(ctx.repo.slug) ? cfg.setup : [],
              checks: [{ ...check, run: built.command }],
            },
            { fallbackSetup: cfg.setup },
            undefined,
            saveResult,
          ),
        )();
        await ctx.save("covering-test-recorded");
        await checkHead();
      } finally {
        if (ctx.state.gateExecution?.handle.kind !== "inplace") await discardChanges(cwd);
      }
    }
}
