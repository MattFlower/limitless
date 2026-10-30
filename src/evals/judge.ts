import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { EvalRun, EvalTrial } from "../core/types.ts";
import { selectHarness } from "../harness/select.ts";
import type { ModelTarget } from "../harness/types.ts";
import type { EngineDeps } from "../pipeline/context.ts";
import { JUDGE_PROMPT_VERSION, JUDGE_RULE } from "../pipeline/prompts.ts";
import { blockingReviewFindings } from "../pipeline/review.ts";
import { type StoredReview, StoredReviewSchema, toStrictJsonSchema } from "../pipeline/schemas.ts";
import { recordedTarget } from "../router/targets.ts";
import { redactCredentials } from "../util/proc.ts";
import type { ReviewCase } from "./cases.ts";
import { wilson } from "./stats.ts";

export { JUDGE_PROMPT_VERSION, JUDGE_RULE } from "../pipeline/prompts.ts";
export const JudgmentSchema = z.strictObject({
  matches: z.array(
    z.strictObject({
      gold: z.string(),
      finding: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
    }),
  ),
});
export type Judgment = z.infer<typeof JudgmentSchema>;
export interface JudgeRef {
  modelId: string;
  effort: string | null;
}
export interface JudgeJob {
  status: "running" | "completed" | "failed";
  judged: number;
  reused: number;
  unjudged: number;
  spend: number;
  error?: string;
}
const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
export function judgeInput(item: ReviewCase, output: StoredReview) {
  return {
    gold: item.defects.map((d, i) => ({
      id: `G${i + 1}`,
      file: redactCredentials(d.file),
      lines: d.lines,
      summary: redactCredentials(d.summary),
    })),
    findings: output.findings.map((f, i) => ({
      id: `F${i + 1}`,
      file: redactCredentials(f.file),
      line: f.line,
      title: redactCredentials(f.title),
      detail: redactCredentials(f.detail),
    })),
  };
}
export function judgmentKey(judge: JudgeRef, item: ReviewCase, output: StoredReview) {
  const { gold, findings } = judgeInput(item, output);
  return hash([JUDGE_PROMPT_VERSION, judge.modelId, judge.effort, item.id, hash(gold), hash(findings)]);
}
export function normalizeJudgment(raw: unknown, item: ReviewCase, output: StoredReview): Judgment {
  const parsed = JudgmentSchema.parse(raw);
  const input = judgeInput(item, output);
  const ids = new Set(parsed.matches.map((m) => m.gold));
  if (
    parsed.matches.length !== input.gold.length ||
    ids.size !== input.gold.length ||
    input.gold.some((g) => !ids.has(g.id)) ||
    parsed.matches.some((m) => m.finding !== null && !input.findings.some((f) => f.id === m.finding))
  )
    throw new Error("judgment must name each gold once and only known findings");
  const matches = input.gold.flatMap((g) => parsed.matches.filter((m) => m.gold === g.id));
  const owners = new Map<string, Judgment["matches"][number]>();
  for (const match of matches) {
    match.reason = redactCredentials(match.reason);
    if (match.finding === null) continue;
    const owner = owners.get(match.finding);
    if (owner && owner.confidence >= match.confidence) match.finding = null;
    else {
      owners.set(match.finding, match);
      if (owner) owner.finding = null;
    }
  }
  return { matches };
}
export function selectedJudgingTrials(trials: EvalTrial[], cases: ReviewCase[]) {
  return trials.flatMap((trial) => {
    const item = cases.find(
      (c) => c.id === trial.caseId && c.kind === "real" && c.defects.some((d) => d.required),
    );
    const parsed = StoredReviewSchema.safeParse(trial.output);
    return trial.status === "ok" && item && parsed.success ? [{ trial, item, output: parsed.data }] : [];
  });
}
export function scoreJudged(
  item: ReviewCase,
  output: StoredReview,
  judgments: Judgment[],
  causalAttribution = false,
) {
  const blocking = blockingReviewFindings(output, undefined, undefined, causalAttribution);
  const counts = { caught: 0, total: 0, contested: 0, underRated: 0, agreement: 0, perJudge: [0, 0] };
  if (judgments.length !== 2) return counts;
  for (const [i, gold] of item.defects.entries()) {
    if (!gold.required) continue;
    const matched = judgments.map((j) => j.matches.find((m) => m.gold === `G${i + 1}`)?.finding ?? null);
    const blocks = matched.map((id) => {
      const finding = id ? output.findings[Number(id.slice(1)) - 1] : undefined;
      return finding !== undefined && blocking.includes(finding);
    });
    counts.total++;
    counts.caught += Number(blocks[0] && blocks[1]);
    counts.contested += Number(blocks[0] !== blocks[1]);
    counts.underRated += Number(matched.every(Boolean) && blocks.every((b) => !b));
    counts.agreement += Number(Boolean(matched[0]) === Boolean(matched[1]));
    blocks.forEach((b, index) => {
      counts.perJudge[index] = (counts.perJudge[index] ?? 0) + Number(b);
    });
  }
  return counts;
}
export function summarizeJudged(
  run: EvalRun,
  trials: EvalTrial[],
  cases: ReviewCase[],
  judges: JudgeRef[],
  lookup: (key: string) => Judgment | null,
) {
  const selected = selectedJudgingTrials(trials, cases);
  const scores = selected.flatMap(({ trial, item, output }) => {
    const judgments = judges.map((judge) => lookup(judgmentKey(judge, item, output)));
    return judgments.every((j) => j !== null)
      ? [
          scoreJudged(
            item,
            output,
            judgments,
            run.systems?.find((s) => s.name === trial.details.system)?.causalAttribution,
          ),
        ]
      : [];
  });
  const sum = (key: "caught" | "total" | "contested" | "underRated" | "agreement") =>
    scores.reduce((n, score) => n + score[key], 0);
  const denominator = sum("total");
  const rate = (numerator: number) => ({
    numerator,
    denominator,
    rate: denominator ? numerator / denominator : null,
    ci: wilson(numerator, denominator),
  });
  return {
    judges: judges.map(recordedTarget),
    recall: rate(sum("caught")),
    perJudge: judges.map((judge, i) => ({
      judge: recordedTarget(judge),
      recall: rate(scores.reduce((n, score) => n + (score.perJudge[i] ?? 0), 0)),
    })),
    contested: sum("contested"),
    underRated: sum("underRated"),
    unjudged: selected.length - scores.length,
    agreement: rate(sum("agreement")),
  };
}

export async function judgeTrials(
  deps: EngineDeps,
  run: EvalRun,
  cases: ReviewCase[],
  targets: ModelTarget[],
  judges: JudgeRef[],
  maxUsd: number,
  job: JudgeJob,
  signal: AbortSignal,
  slot: (provider: string) => Promise<() => void>,
) {
  const selected = selectedJudgingTrials(deps.store.listEvalTrials(run.id), cases);
  const work = selected.flatMap(({ item, output }) =>
    targets.map((target, i) => ({ item, output, target, judge: judges[i] })),
  );
  const directory = mkdtempSync(join(tmpdir(), "limitless-judge-"));
  try {
    const settled = await Promise.allSettled(
      Array.from({ length: run.concurrency ?? 1 }, async () => {
        for (let task = work.shift(); task; task = work.shift()) {
          const { item, output, target, judge } = task;
          if (!judge) continue;
          const key = judgmentKey(judge, item, output);
          if (deps.store.evalJudgment(key)) {
            job.reused++;
            continue;
          }
          let costUsd = 0;
          for (let attempt = 0; attempt < 2; attempt++) {
            if (signal.aborted || job.spend >= maxUsd) break;
            const release = await slot(target.provider);
            try {
              if (signal.aborted || job.spend >= maxUsd) break;
              // Another trial with identical content may have filled the shared cache while we waited.
              if (deps.store.evalJudgment(key)) {
                job.reused++;
                break;
              }
              const harness = deps.harnesses[selectHarness("summarize", target).harnessName];
              if (!harness) throw new Error("judge harness unavailable");
              deps.router.assertOriginEligible(target.modelId);
              const result = await harness({
                target,
                prompt: `${JUDGE_RULE}\n\n${JSON.stringify(judgeInput(item, output))}`,
                schema: JudgmentSchema,
                structuredRetries: 0,
                jsonSchema: toStrictJsonSchema(JudgmentSchema),
                cwd: directory,
                mode: "readonly",
                noTools: true,
                privateSession: true,
                timeoutMs: 180_000,
                idleTimeoutMs: 180_000,
                maxToolCalls: 0,
                signal,
                logPath: join(directory, `${key}.log`),
                onEvent: () => {},
              });
              job.spend += result.costUsd;
              costUsd += result.costUsd;
              if (result.status !== "ok" && !result.invalidOutput) break;
              let matches: Judgment;
              try {
                matches = normalizeJudgment(result.structured ?? JSON.parse(result.finalText), item, output);
              } catch {
                continue;
              } // One retry for invalid output only.
              deps.store.recordEvalJudgment(key, judge, item.id, JUDGE_PROMPT_VERSION, matches, costUsd);
              job.judged++;
              break;
            } catch {
              break;
            } finally {
              release();
            }
          }
        }
      }),
    );
    const failed = settled.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  job.unjudged = selected.filter(({ item, output }) =>
    judges.some((j) => !deps.store.evalJudgment(judgmentKey(j, item, output))),
  ).length;
}
