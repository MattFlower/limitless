#!/usr/bin/env bun
// Throwaway spike for #304 (docs/research/13-cloud-workers.md §3.1): GitHub Actions latency and
// reliability for one repository, read through `gh api`. It pages with `page=` instead of
// `--paginate`, because the cloud-session GitHub proxy refuses the numeric-ID URLs in `Link` headers.
// Usage: bun scripts/spike-ci-timing.ts <owner/name> <since YYYY-MM-DD> [step name] [jobs to sample]

interface Run {
  id: number;
  conclusion: string | null;
  created_at: string;
  run_started_at?: string;
  updated_at: string;
  run_attempt: number;
}
interface Step {
  name: string;
  started_at: string | null;
  completed_at: string | null;
}
interface Job {
  started_at: string;
  completed_at: string | null;
  steps?: Step[];
}

const [repo, since, stepName = "Run bun run check", sampleArg = "40"] = process.argv.slice(2);
if (!repo || !since) throw new Error("usage: spike-ci-timing.ts <owner/name> <since YYYY-MM-DD> [step] [n]");

function gh<T>(path: string): T {
  const res = Bun.spawnSync(["gh", "api", path]);
  if (res.exitCode !== 0) throw new Error(`gh api ${path}: ${res.stderr.toString().trim()}`);
  return JSON.parse(res.stdout.toString()) as T;
}

const secs = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;
function summary(xs: number[]): string {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? Number.NaN);
  return s.length ? `n=${s.length} median ${at(0.5)} s, p90 ${at(0.9)} s, max ${at(1)} s` : "n=0";
}

const runs: Run[] = [];
for (let page = 1; page <= 10; page++) {
  const batch = gh<{ workflow_runs: Run[] }>(
    `repos/${repo}/actions/runs?per_page=100&page=${page}&created=%3E%3D${since}`,
  ).workflow_runs;
  runs.push(...batch);
  if (batch.length < 100) break;
}

const byConclusion = new Map<string, number>();
for (const r of runs) {
  const key = r.conclusion ?? "pending";
  byConclusion.set(key, (byConclusion.get(key) ?? 0) + 1);
}
console.log(`${runs.length} runs since ${since}:`, Object.fromEntries(byConclusion));
console.log(`re-run attempts: ${runs.filter((r) => r.run_attempt > 1).length}`);

const ok = runs.filter((r) => r.conclusion === "success" && r.run_started_at);
const days = new Map<string, number[]>();
for (const r of ok) {
  const day = r.created_at.slice(0, 10);
  days.set(day, [...(days.get(day) ?? []), secs(r.run_started_at ?? r.created_at, r.updated_at)]);
}
for (const [day, xs] of [...days].sort()) console.log(`${day} successful run duration: ${summary(xs)}`);

const queue: number[] = [];
const step: number[] = [];
const total: number[] = [];
for (const r of ok.slice(0, Number(sampleArg))) {
  for (const job of gh<{ jobs: Job[] }>(`repos/${repo}/actions/runs/${r.id}/jobs`).jobs) {
    queue.push(secs(r.created_at, job.started_at));
    if (job.completed_at) total.push(secs(r.created_at, job.completed_at));
    const s = job.steps?.find((x) => x.name === stepName);
    if (s?.started_at && s.completed_at) step.push(secs(s.started_at, s.completed_at));
  }
}
console.log(`latest ${Math.min(ok.length, Number(sampleArg))} successful runs:`);
console.log(`  queue (run created → job started): ${summary(queue)}`);
console.log(`  step "${stepName}": ${summary(step)}`);
console.log(`  run created → job completed: ${summary(total)}`);
