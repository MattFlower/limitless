import { z } from "zod";
import type { CiFailure, GitHubFeedKind, TrackedPr } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import type { GitHubResponse, PrSnapshot } from "./github-poller.ts";

const bad = new Set(["failure", "error", "timed_out", "startup_failure", "action_required", "cancelled"]);
const security = /security|codeql|dependenc(?:y|ies)[ -]?review|secret[ -]?scan|sast|dast|vulnerab/i;
const checkSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  completed_at: z.string().nullable().optional(),
  details_url: z.string().nullable().optional(),
  app: z.object({ slug: z.string() }).nullable().optional(),
  output: z
    .object({
      title: z.string().nullable(),
      summary: z.string().nullable(),
      text: z.string().nullable().optional(),
    })
    .optional(),
});
const jobSchema = z.object({
  id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  check_run_url: z.string(),
  name: z.string(),
  labels: z.array(z.string()).optional(),
  started_at: z.string().nullable().optional(),
});
type Check = z.infer<typeof checkSchema>;
type Call = (repo: string, path: string, body?: unknown) => Promise<GitHubResponse | null>;
const bounded = (text: string) => text.trim().slice(0, 500);
/** Logs are data. Only these literal failure patterns participate in deterministic classification. */
export function ciSignature(check: string, log: string, fallback: string, labels: string[] = []) {
  const lines = log.split(/\r?\n/).map((line) => line.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, ""));
  const line = bounded(
    lines.find((l) => /timed out after|##\[error\]|\b(?:error|fail(?:ed|ure)?)\b/i.test(l)) ?? fallback,
  );
  const image =
    bounded(
      lines.find((l) => /^\s*Image:/.test(l))?.replace(/^\s*Image:\s*/, "") ??
        labels.find((label) => /^(?:ubuntu|windows|macos)-/.test(label)) ??
        "",
    ) || null;
  return { check, line, image, signature: JSON.stringify([check, line, image]) };
}
const quote = (s: string) => `> ${s.replace(/\r?\n/g, "\n> ")}`;

/** Serial REST inspection. False retains the persisted pending inspection for a later poll. */
export async function classifyCi(
  store: Store,
  pr: TrackedPr,
  snap: PrSnapshot,
  call: Call,
  reruns: boolean,
  ready: () => boolean,
  current: () => boolean,
): Promise<boolean> {
  const root = `repos/${pr.repo}`;
  const read = async (path: string) => {
    const res = await call(pr.repo, `${root}/${path}`);
    if (res?.status !== 200)
      throw new Error(`Incomplete CI inspection: ${path} (${res?.status ?? "paused"})`);
    return res.body;
  };
  const jobs = async (run: number, attempt: number) => {
    const all: z.infer<typeof jobSchema>[] = [];
    for (let page = 1; ; page++) {
      const parsed = z
        .object({ total_count: z.number().int().nonnegative(), jobs: z.array(jobSchema) })
        .parse(await read(`actions/runs/${run}/attempts/${attempt}/jobs?per_page=100&page=${page}`));
      all.push(...parsed.jobs);
      if (all.length === parsed.total_count) return all;
      if (!parsed.jobs.length || all.length > parsed.total_count) throw new Error("Incomplete CI job page");
    }
  };
  const checks = async (ref: string): Promise<Check[]> => {
    const all: Check[] = [];
    for (let page = 1; ; page++) {
      const parsed = z
        .object({ total_count: z.number().int().nonnegative(), check_runs: z.array(checkSchema) })
        .parse(
          await read(`commits/${encodeURIComponent(ref)}/check-runs?filter=latest&per_page=100&page=${page}`),
        );
      all.push(...parsed.check_runs);
      if (all.length === parsed.total_count) break;
      if (!parsed.check_runs.length || all.length > parsed.total_count)
        throw new Error("Incomplete CI check page");
    }
    if (snap.statusNames?.length || snap.truncated) {
      const latest = new Map<string, Check>();
      for (let page = 1; ; page++) {
        const statuses = z
          .array(
            z.object({
              id: z.number(),
              context: z.string(),
              state: z.string(),
              description: z.string().nullable(),
            }),
          )
          .parse(await read(`commits/${encodeURIComponent(ref)}/statuses?per_page=100&page=${page}`));
        for (const s of statuses)
          if (!latest.has(s.context))
            latest.set(s.context, {
              id: s.id,
              name: s.context,
              head_sha: ref,
              status: s.state === "pending" ? "in_progress" : "completed",
              conclusion: s.state,
              output: { title: s.description, summary: s.description },
            });
        if (statuses.length < 100) break;
      }
      all.push(...latest.values());
    }
    return all;
  };
  const emit = (
    kind: GitHubFeedKind,
    f: ReturnType<typeof ciSignature>,
    key: string,
    repository = false,
    excerpt = f.line,
  ) => {
    store.saveGithubPr(null, false, [
      {
        kind,
        repo: pr.repo,
        runId: repository ? null : pr.runId,
        key,
        summary: repository ? "Default branch CI is failing" : "CI failure needs a code or environment fix",
        data: {
          ...(repository ? {} : { url: pr.url, head: snap.headRefOid }),
          signature: { check: quote(f.check), line: quote(f.line), image: f.image && quote(f.image) },
          excerpt: quote(excerpt.trim().slice(0, 2000)),
          untrusted: true,
        },
      },
    ]);
  };
  const branch = store.getRepoBySlug(pr.repo)?.defaultBranch ?? "main";
  const mainSha = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) })
    .parse(await read(`commits/${encodeURIComponent(branch)}`)).sha;
  const main = await checks(mainSha);
  if (main.some((c) => c.head_sha !== mainSha)) throw new Error("Incomplete default branch CI");
  const episodes = store.getSetting<Record<string, { red: boolean; episode: number }>>(
    `ci.main:${pr.repo}`,
    {},
  );
  const state = new Map(Object.entries(episodes));
  for (const name of state.keys())
    if (!main.some((c) => c.name === name)) {
      const old = state.get(name);
      if (old) state.set(name, { ...old, red: false });
    }
  for (const [name, group] of Map.groupBy(main, (c) => c.name)) {
    const failed = group.find(
      (c) => c.status === "completed" && bad.has(c.conclusion ?? "") && c.conclusion !== "cancelled",
    );
    const red = !!failed;
    const old = state.get(name);
    const episode = (old?.episode ?? 0) + (red && !old?.red ? 1 : 0);
    if (failed && snap.failing.some((f) => f.name === name))
      emit(
        "ci.main_red",
        ciSignature(name, "", failed.conclusion ?? "failure"),
        `${pr.repo}:${name}:${episode}`,
        true,
      );
    state.set(name, { red, episode });
  }
  store.setSetting(`ci.main:${pr.repo}`, Object.fromEntries(state));
  if (!current()) return true;
  const resolved = new Set<number>();
  // Only a later attempt of the originating workflow job can resolve a rerun.
  for (const f of store.ciFailures(pr.url, snap.headRefOid)) {
    const origin = f.rerunJob;
    if (f.outcome !== "rerunning" || !origin) continue;
    const run = z
      .object({ head_sha: z.string(), run_attempt: z.number().int().positive() })
      .parse(await read(`actions/runs/${origin.runId}`));
    if (run.head_sha !== f.sha) throw new Error("Outdated CI rerun SHA");
    if (run.run_attempt <= origin.attempt) continue;
    const matches = (await jobs(origin.runId, run.run_attempt)).filter((j) => j.name === origin.name);
    if (matches.length !== 1) throw new Error("Ambiguous CI rerun job");
    const job = matches[0];
    if (
      !job ||
      job.run_id !== origin.runId ||
      job.run_attempt !== run.run_attempt ||
      job.head_sha !== f.sha ||
      job.id === origin.id
    )
      throw new Error("Incomplete CI rerun job");
    if (!current()) return true;
    if (job.status !== "completed") continue;
    if (job.conclusion === "success") store.finishCiFailure(f, "failed_then_passed");
    else if (bad.has(job.conclusion ?? "") && !state.get(f.check)?.red) {
      const log =
        job.started_at === null || job.conclusion === "startup_failure"
          ? ""
          : z.string().parse(await read(`actions/jobs/${job.id}/logs`));
      if (!current()) return true;
      const failure = {
        ...f,
        ...ciSignature(f.check, log, job.conclusion ?? "failure", job.labels),
        outcome: "failed",
        rerunMarker: null,
        rerunJob: null,
      } as const;
      if (!security.test(job.name) && !security.test(failure.line)) store.recordCiFailure(failure);
      store.finishCiFailure(f, "failed_again");
      emit("ci.needs_fix", failure, `${pr.url}:${f.sha}:${failure.signature}`, false, log || failure.line);
    } else continue;
    resolved.add(job.id);
  }
  if (snap.ci !== "FAILURE" && snap.ci !== "ERROR") {
    // The rollup can finish before REST; retry unchanged success until every rerun is confirmed.
    return (
      snap.ci !== "SUCCESS" ||
      !store.ciFailures(pr.url, snap.headRefOid).some((f) => f.outcome === "rerunning")
    );
  }
  const failures = await checks(snap.headRefOid);
  if (failures.some((c) => c.head_sha !== snap.headRefOid)) throw new Error("Incomplete PR CI");
  const names = new Set([
    ...snap.failing.map((c) => c.name),
    ...failures.filter((c) => c.status === "completed" && bad.has(c.conclusion ?? "")).map((c) => c.name),
  ]);
  if (!names.size) throw new Error("Incomplete CI failure: no failing checks");
  for (const name of names) {
    const matches = failures.filter(
      (c) => c.name === name && c.status === "completed" && bad.has(c.conclusion ?? ""),
    );
    // Missing or still-running check data cannot resolve the GraphQL failure.
    if (!matches.length) throw new Error(`Incomplete failing check: ${name}`);
    for (const c of matches) {
      const times = snap.completed?.filter((t) => t.name === c.name) ?? [];
      const completedAt = c.completed_at;
      if (completedAt && times.length && !times.some((t) => Date.parse(t.time) === Date.parse(completedAt)))
        throw new Error("Outdated CI check completion");
      let log = c.output?.text ?? c.output?.summary ?? "";
      if (state.get(c.name)?.red) {
        emit(
          "ci.main_red",
          ciSignature(c.name, log, c.conclusion ?? "failure"),
          `${pr.repo}:${c.name}:${state.get(c.name)?.episode}`,
          true,
        );
        const f = {
          ...ciSignature(c.name, log, c.output?.title ?? c.conclusion ?? "failure"),
          prUrl: pr.url,
          sha: snap.headRefOid,
          outcome: "failed",
          rerunMarker: null,
        } as const;
        if (!security.test(c.name) && !security.test(f.line)) store.recordCiFailure(f);
        continue;
      }
      let job: z.infer<typeof jobSchema> | undefined;
      const prefix = `https://github.com/${pr.repo}/`;
      const ids =
        c.details_url?.toLowerCase().startsWith(prefix.toLowerCase()) &&
        c.details_url.slice(prefix.length).match(/^(?:actions\/)?runs\/\d+\/jobs?\/(\d+)(?:\?.*)?$/);
      if (c.app?.slug === "github-actions" && ids) {
        job = jobSchema.parse(await read(`actions/jobs/${ids[1]}`));
        if (
          job.check_run_url !== `https://api.github.com/${root}/check-runs/${c.id}` ||
          job.head_sha !== snap.headRefOid ||
          job.status !== "completed" ||
          !bad.has(job.conclusion ?? "")
        )
          throw new Error("Incomplete failing job");
        // A job that never started has no downloadable logs.
        if (
          job.started_at !== null &&
          job.conclusion !== "startup_failure" &&
          c.conclusion !== "startup_failure"
        ) {
          const body = await read(`actions/jobs/${job.id}/logs`);
          if (typeof body !== "string") throw new Error("Incomplete CI log");
          log = body;
        }
      }
      const f: CiFailure = {
        ...ciSignature(c.name, log, c.output?.title ?? c.conclusion ?? "failure", job?.labels),
        prUrl: pr.url,
        sha: snap.headRefOid,
        outcome: "failed",
        rerunMarker: null,
      };
      const unsafe = security.test(c.name) || security.test(job?.name ?? "") || security.test(f.line);
      const marker = JSON.stringify([c.id, c.completed_at ?? snap.ciKey]);
      const prior = store
        .ciFailures(pr.url, snap.headRefOid)
        .filter(
          (p) =>
            p.outcome !== "failed" &&
            (p.signature === f.signature ||
              (job && p.rerunJob?.runId === job.run_id && p.rerunJob.name === job.name)),
        );
      if (job && resolved.has(job.id)) continue;
      if (prior.some((p) => p.outcome === "rerunning")) continue;
      if (!unsafe) store.recordCiFailure(f);
      const needsFix = () =>
        emit("ci.needs_fix", f, `${pr.url}:${snap.headRefOid}:${f.signature}`, false, log || f.line);
      const transient =
        [c.conclusion, job?.conclusion].some((v) =>
          ["timed_out", "startup_failure", "cancelled"].includes(v ?? ""),
        ) ||
        job?.started_at === null ||
        /timed out after/i.test(log);
      if (!unsafe && !prior.length && job && transient && reruns) {
        const siblings = (await jobs(job.run_id, job.run_attempt)).filter((j) => j.name === job.name);
        if (siblings.length !== 1 || siblings[0]?.id !== job.id)
          throw new Error("Ambiguous originating CI job");
        if (!ready()) return false;
        const remote = z
          .object({ head: z.object({ sha: z.string() }), state: z.string() })
          .parse(await read(`pulls/${pr.url.split("/").at(-1)}`));
        if (remote.head.sha !== snap.headRefOid || remote.state !== "open" || !current()) continue;
        if (!ready()) return false;
        if (
          store.claimCiRerun(f, marker, {
            id: job.id,
            runId: job.run_id,
            attempt: job.run_attempt,
            name: job.name,
          })
        ) {
          const res = await call(pr.repo, `${root}/actions/jobs/${job.id}/rerun`, {});
          if (res?.status !== 201) throw new Error("CI job rerun was not confirmed");
          store.finishCiFailure(f, "rerunning");
          continue;
        }
      }
      if (!current()) return true;
      for (const p of prior) if (p.outcome === "rerun_requested") store.finishCiFailure(p, "failed_again");
      needsFix();
    }
  }
  return true;
}
