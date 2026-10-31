import type { GateConfig } from "../gates/detect.ts";
import { quoteRetryFiles, singleBunTest } from "../gates/docs.ts";
import { validRetryFiles } from "../gates/junit.ts";
import { redactGateData } from "../gates/output.ts";
import { confinementFailed, type GateResult, type GateRun } from "../gates/run.ts";
import { MAX_TEST_IDENTITY_LENGTH } from "../gates/test-coverage.ts";
import { worktreeGit } from "../git/command.ts";
import { discardChanges } from "../git/repos.ts";
import { CancelledError, type RunContext } from "./context.ts";
import { InjectedFault, SimulatedTermination } from "./faults.ts";
import { gateCommandScope, runGateExecution } from "./gate-execution.ts";
import type { Verify } from "./schemas.ts";

type Test = { file: string; name: string };
export interface CoveringTestRun extends Test {
  verifiedSha: string;
  round: number;
  stageId: number;
  result?: GateResult;
  command?: string;
  reason?: string;
  unavailable?: boolean;
}
export const coveringPattern = (name: string): string =>
  `(?:^| )${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
const controls = (text: string) =>
  [...text].some((c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159));

export function selectCoveringTests(verify: Verify) {
  return selectCoveringRequests(
    verify.criteria.map((c) =>
      c.status === "blocked" && c.blockedReason === "sandbox" ? (c.covering_tests ?? []) : [],
    ),
  );
}

export const acceptanceCoveringPolicy = { roundLimit: Infinity, groupFiles: true };
const verifierCoveringPolicy = { roundLimit: 10, groupFiles: false };

export function selectCoveringRequests(items: Test[][], policy = verifierCoveringPolicy) {
  let count = 0;
  return items.map((requested) => {
    const tests = requested.slice(0, 3).filter(() => ++count <= policy.roundLimit);
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

const bunCheck = (cfg?: GateConfig) => {
  const checks = cfg?.checks.filter((c) => singleBunTest(c.run)) ?? [];
  return checks.length === 1 ? checks[0] : undefined;
};
const filterArgument = (names: string[]) =>
  ` -t '${names.map(coveringPattern).join("|").replaceAll("'", "'\\''")}'`;

/** Validate committed membership separately from filesystem containment; neither proves the other. */
export async function coveringTestCommand(test: Test, cfg: GateConfig | undefined, cwd: string, sha: string) {
  const retry = cfg?.retryFiles;
  if (!bunCheck(cfg) || !retry || retry.split("{files}").length !== 2 || !singleBunTest(retry, "{files}"))
    return { reason: "targeted retries not configured" };
  const words = retry.match(/(?:[^\s"'\\]|\\[\s\S]|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
  const literal = (word: string) =>
    word.replace(
      /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g,
      (_match: string, single?: string, double?: string, escaped?: string) =>
        single ?? double?.replace(/\\([$`"\\])/g, "$1") ?? escaped ?? "",
    );
  if (words.some((word) => literal(word) === "--"))
    return { reason: "covering tests do not support an option terminator (--) in retry_files" };
  if (!validRetryFiles([test.file], cwd)) return { reason: "file outside repository or invalid retry file" };
  if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(test.file)) return { reason: "file is not a test file" };
  if (!test.name.trim() || test.name.length > MAX_TEST_IDENTITY_LENGTH || controls(test.name))
    return { reason: "invalid test name" };
  const reason = await trackedAtShaRefusal(test.file, cwd, sha);
  if (reason) return { reason };

  // Place the literal filter directly after `bun test`.
  const filter = filterArgument([test.name]);
  const command = retry
    .replace("{files}", () => quoteRetryFiles([test.file]))
    .replace(/^[\t ]*bun[\t ]+test(?=[\t ]|$)/, (prefix) => prefix + filter);
  return singleBunTest(command)
    ? { command }
    : { reason: "expanded command is not a single bun test invocation" };
}

export async function citedFileRefusal(file: string, cwd: string, sha: string) {
  if (!validRetryFiles([file], cwd)) return "file outside repository or invalid retry file";
  return trackedAtShaRefusal(file, cwd, sha);
}

export async function trackedAtShaRefusal(file: string, cwd: string, sha: string) {
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha)) return "invalid verified SHA";
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
      file.replace(/^\.\//, ""),
    ],
    { cwd, allowFail: true },
  );
  if (tracked.exitCode !== 0 || !tracked.stdout.split("\0").includes(file.replace(/^\.\//, "")))
    return "file not tracked at verified SHA";
}

export function succeededCoveringStages(ctx: RunContext) {
  return (ctx.state.coveringTestRuns ?? [])
    .filter((r) => {
      const stage = ctx.store.getStage(r.stageId);
      return stage?.runId === ctx.run.id && stage.name === "gates" && stage.status === "succeeded";
    })
    .map((r) => r.stageId);
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
  if (
    !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(sha) ||
    run.verifiedSha !== sha ||
    r.executionProvenance?.sha !== sha
  )
    return "run executed at a different SHA";
  if (r.executionProvenance.trackedClean !== true) return "run changed tracked files";
  const neighborFailed = r.coveringTests?.some((e) => e.reason === "test failed");
  if (
    r.incomplete ||
    r.timedOut ||
    confinementFailed(r) ||
    ((!r.ok || r.exitCode !== 0) && !(r.exitCode === 1 && neighborFailed))
  )
    return "test failed";
  const evidence = r.coveringTest;
  // Tests can forge or replay their in-process JUnit report; filesystem checks cannot authenticate
  // its producer. As with existing trust in test exit status, code review is the defense.
  if (!evidence || evidence.file !== run.file.replace(/^\.\//, "") || evidence.name !== run.name)
    return "missing exact testcase JUnit evidence";
  return evidence.reason;
}

/** Save the result before clearing the durable execution handle, including on restart. */
export async function runCoveringTests(
  ctx: RunContext,
  verify: Verify,
  sha: string,
  checkHead: () => Promise<void>,
) {
  return runCoveringRequests(
    ctx,
    verify.criteria.map((c) =>
      c.status === "blocked" && c.blockedReason === "sandbox" ? (c.covering_tests ?? []) : [],
    ),
    sha,
    checkHead,
  );
}

export async function runCoveringRequests(
  ctx: RunContext,
  items: Test[][],
  sha: string,
  checkHead: () => Promise<void>,
  policy = verifierCoveringPolicy,
) {
  const cwd = ctx.state.worktreePath as string;
  const cfg = ctx.state.gatesConfig;
  const check = bunCheck(cfg);
  ctx.state.coveringTestRuns ??= [];
  const records = ctx.state.coveringTestRuns;
  const groups = new Map<string, CoveringTestRun[]>();
  for (const { tests } of selectCoveringRequests(items, policy))
    for (const test of tests) {
      let record = records.find((r) => r.verifiedSha === sha && r.file === test.file && r.name === test.name);
      if (record?.result || record?.reason) continue;
      const built = record?.command
        ? { command: record.command }
        : await coveringTestCommand(test, cfg, cwd, sha);
      if (!record) {
        record = { ...test, verifiedSha: sha, round: ctx.state.round, stageId: 0 };
        records.push(record);
      }
      if (!built.command) {
        record.reason = built.reason;
        record.unavailable =
          built.reason === "targeted retries not configured" ||
          built.reason === "covering tests do not support an option terminator (--) in retry_files" ||
          built.reason === "expanded command is not a single bun test invocation";
        await ctx.save();
        continue;
      }
      record.command = built.command;
      const key = record.stageId
        ? `stage:${record.stageId}`
        : policy.groupFiles
          ? test.file.replace(/^\.\//, "")
          : JSON.stringify(test);
      const group = groups.get(key) ?? [];
      if (!group.includes(record)) group.push(record);
      groups.set(key, group);
    }
  for (const group of groups.values()) {
    const first = group[0];
    if (!first || !check || !cfg || !first.command) continue;
    if (
      !first.stageId &&
      records.filter((r) => r.round === ctx.state.round && r.stageId > 0).length >= policy.roundLimit
    ) {
      for (const record of group)
        Object.assign(record, { reason: "per-round limit reached", unavailable: true });
      await ctx.save();
      continue;
    }
    const stage = first.stageId
      ? ctx.store.getStage(first.stageId)
      : ctx.store.startStage(ctx.run.id, "gates", ctx.state.round);
    if (!stage) throw new Error("Missing covering-test stage");
    const command = first.stageId
      ? first.command
      : first.command.replace(filterArgument([first.name]), () =>
          filterArgument([...new Set(group.map((r) => r.name))]),
        );
    for (const record of group) Object.assign(record, { stageId: stage.id, command });
    await ctx.save();
    const purpose = `covering-test:${stage.id}`;
    let started = false;
    let preStartFailure = false;
    const saveResult = (_handle: unknown, run: GateRun) => {
      for (const record of group) {
        const result = run.checks[0];
        record.result = redactGateData(
          result
            ? {
                ...result,
                coveringTest:
                  result.coveringTests?.find(
                    (e) => e.file === record.file.replace(/^\.\//, "") && e.name === record.name,
                  ) ?? result.coveringTest,
                executionProvenance: {
                  sha: run.sha,
                  trackedClean: run.trackedClean,
                  provenanceError: run.provenanceError,
                },
              }
            : undefined,
        );
        if (!record.result) Object.assign(record, { reason: "missing check result", unavailable: !started });
      }
      ctx.store.finishStage(stage.id, "succeeded", "covering-test execution recorded");
    };
    try {
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
              checks: [
                {
                  ...check,
                  run: command,
                  coveringTest: { file: first.file, name: first.name },
                  ...(policy.groupFiles
                    ? { coveringTests: group.map(({ file, name }) => ({ file, name })) }
                    : {}),
                },
              ],
            },
            {
              fallbackSetup: cfg.setup,
              onCheckStart: () => {
                started = true;
              },
              onPreStartFailure: () => {
                preStartFailure = true;
              },
            },
            undefined,
            saveResult,
          ),
        )();
      } catch (error) {
        const interrupted =
          error instanceof CancelledError ||
          error instanceof SimulatedTermination ||
          error instanceof InjectedFault;
        const remote = [ctx.deps.gateExecutor?.kind, ctx.state.gateExecution?.handle.kind].some(
          (kind) => kind && kind !== "local",
        );
        if (
          !policy.groupFiles ||
          interrupted ||
          ctx.signal.aborted ||
          ctx.termination ||
          started ||
          (remote && !preStartFailure) ||
          group.some((r) => r.result)
        )
          throw error;
        for (const record of group)
          Object.assign(record, { reason: redactGateData((error as Error).message), unavailable: true });
        ctx.store.finishStage(stage.id, "failed", "covering-test unavailable before check start");
      }
      await ctx.save("covering-test-recorded");
      await checkHead();
    } finally {
      if (ctx.state.gateExecution?.handle.kind !== "inplace") await discardChanges(cwd);
    }
  }
}
