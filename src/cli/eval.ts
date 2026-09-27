import type { EvalReport } from "../evals/stats.ts";

export interface EvalCliIO {
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  print: (text: string) => void;
  wait: (ms: number) => Promise<unknown>;
}
export function formatEvalReport(report: EvalReport): string {
  const number = (n: number | null) => (n === null ? "n/a" : n.toFixed(3));
  const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
  const lines = [
    `${report.run.id}: ${report.run.status} (role=${report.run.role}, k=${report.run.k}, maxUsd=${report.run.maxUsd})`,
  ];
  if (report.run.error) lines.push(report.run.error);
  for (const m of report.summaries) {
    const c = m.comparison;
    lines.push(
      `${m.modelId}: ${m.cases} cases, ${m.evaluatedTrials} evaluated trials; skipped=${m.skipped}, errors=${m.errors}, cached=${m.cached}, pending=${m.pending}, unscored=${m.unscored}`,
      `  pass ${pct(m.passRate)} (${m.passes}/${m.evaluatedTrials}), Wilson 95% CI ${m.ci ? `[${pct(m.ci[0])}, ${pct(m.ci[1])}]` : "n/a"}; mean score ${number(m.meanScore)}`,
      `  risk under-call ${pct(m.riskUnderCallRate)} (n=${m.riskDenominator}); flip ${pct(m.flipRate)} (n=${m.flipDenominator})`,
      `  metered $${m.costUsd.toFixed(4)}; API-equivalent $${m.costEquivUsd.toFixed(4)}; p50 invocation ${number(m.p50LatencyMs)} ms (n=${m.latencyDenominator})`,
      `  vs ${c.bestModel ?? "n/a"}: difference ${number(c.meanDifference)}, one-sided 95% lower ${number(c.lowerBound)}, nonInferior=${c.nonInferior ?? "n/a"}; paired cases=${c.pairedCases} (candidate complete=${c.candidateCompleteCases}, best complete=${c.bestCompleteCases}), delta=${c.delta}, resamples=${c.resamples}, seed=${c.seed}`,
    );
  }
  return lines.join("\n");
}
export async function evalCommand(
  args: string[],
  flags: Record<string, string | boolean | undefined>,
  io: EvalCliIO,
): Promise<void> {
  const [action, value] = args;
  if (args.length !== 2 || !value || !["run", "report"].includes(action ?? ""))
    throw new Error("usage: limitless eval run <role> --models a,b | eval report <eval-id> [--json]");
  if (action === "report") {
    const report = await io.api<EvalReport>(`/api/evals/${encodeURIComponent(value)}`);
    io.print(flags.json ? JSON.stringify(report) : formatEvalReport(report));
    return;
  }
  if (typeof flags.models !== "string" || !flags.models.trim()) throw new Error("--models a,b is required");
  const numeric = (key: string) => {
    const raw = flags[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !raw.trim() || !Number.isFinite(Number(raw)))
      throw new Error(`--${key} must be a finite number`);
    return Number(raw);
  };
  const { id } = await io.api<{ id: string }>("/api/evals", {
    method: "POST",
    body: JSON.stringify({
      role: value,
      models: flags.models.split(","),
      k: numeric("k"),
      maxUsd: numeric("max-usd"),
      caseIds: typeof flags.cases === "string" ? flags.cases.split(",") : undefined,
      cache: !flags["no-cache"],
    }),
  });
  io.print(id);
  if (!flags.follow) return;
  for (;;) {
    const report = await io.api<EvalReport>(`/api/evals/${encodeURIComponent(id)}`);
    if (report.run.status !== "queued" && report.run.status !== "running") {
      io.print(formatEvalReport(report));
      return;
    }
    await io.wait(500);
  }
}
