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
      annotations_count: z.number().int().nonnegative().optional(),
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
  steps: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })),
});
type Check = z.infer<typeof checkSchema>;
type Call = (
  repo: string,
  path: string,
  body?: unknown,
  optionalLog?: boolean,
) => Promise<GitHubResponse | null>;
const bounded = (text: string) => text.trim().slice(0, 500);
const logLines = (log: string) =>
  Bun.stripANSI(log)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, ""));
const securityFailure = (log: string) =>
  logLines(log).some(
    (line) =>
      /^\s*(?:\(fail\)|FAIL(?:ED)?\b|[×✗✕❌●]|--- FAIL:|not ok\b|##\[error\]|error:)/i.test(line) &&
      security.test(line),
  );
// Bun, Playwright, and the Actions runner's timeout diagnostics, matched as whole lines.
const timeoutDiagnostic =
  /^(?:\s*\^\s*this test timed out after \d+(?:\.\d+)?\s*ms\.?|(?:Error: )?Test timeout of \d+ms exceeded\.|##\[error\]The job running on runner .+ has exceeded the maximum execution time of \d+ minutes\.)$/;
const pending = (f: CiFailure) => f.outcome === "rerunning" || f.outcome === "rerun_requested";
/** Logs are data. Only these literal failure patterns participate in deterministic classification. */
export function ciSignature(check: string, log: string, fallback: string, labels: string[] = []) {
  const lines = logLines(log);
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
async function inspectCi(
  store: Store,
  pr: TrackedPr,
  snap: PrSnapshot,
  call: Call,
  reruns: boolean,
  ready: () => boolean,
  current: () => boolean,
  onFailure: () => void,
  consumer: "poller" | "land",
): Promise<boolean | "head_moved"> {
  const root = `repos/${pr.repo}`;
  const read = async (path: string, optionalLog = false, fallback = "") => {
    const res = await call(pr.repo, `${root}/${path}`, undefined, optionalLog);
    // A verified job may have no uploaded log after its workflow times out.
    if (optionalLog && res?.status === 404)
      return ["error: Job log unavailable (HTTP 404)", fallback].join("\n");
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
  const unsafeEvidence = async (
    check: number,
    job: z.infer<typeof jobSchema>,
    evidence: string,
    count?: number,
  ) => {
    let unsafe = security.test(job.name) || securityFailure(evidence);
    for (const step of job.steps) if (bad.has(step.conclusion ?? "")) unsafe ||= security.test(step.name);
    let seen = 0;
    for (let page = 1; ; page++) {
      const annotations = z
        .array(
          z.object({
            annotation_level: z.string(),
            title: z.string().nullable(),
            message: z.string(),
            raw_details: z.string().nullable().optional(),
          }),
        )
        .parse(await read(`check-runs/${check}/annotations?per_page=100&page=${page}`));
      seen += annotations.length;
      for (const a of annotations)
        if (a.annotation_level === "failure")
          unsafe ||= security.test([a.title, a.message, a.raw_details].join("\n"));
      if (annotations.length < 100) {
        if (count !== undefined && seen !== count) throw new Error("Incomplete CI annotations");
        return unsafe;
      }
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
    if (kind === "ci.needs_fix") onFailure();
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
  const reject = (f: CiFailure, excerpt = f.line) => {
    store.finishCiFailure(f, "rerun_rejected");
    emit("ci.needs_fix", f, `${pr.url}:${f.sha}:${f.signature}`, false, excerpt);
  };
  const requestRerun = async (f: CiFailure, job: number, excerpt: string) => {
    const res = await call(pr.repo, `${root}/actions/jobs/${job}/rerun`, {});
    if (res?.rerunRetryAt !== undefined) {
      reject(f, excerpt);
      return;
    }
    if (res && res.status >= 400 && res.status < 500 && res.status !== 408) {
      reject(f, excerpt);
      return;
    }
    if (res?.status !== 201) throw new Error("CI job rerun was not confirmed");
    store.finishCiFailure(f, "rerunning");
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
  const outstanding = store.ciFailures(pr.url, snap.headRefOid).filter(pending);
  // Only a later attempt of the originating workflow job can resolve a rerun.
  for (const f of outstanding) {
    const origin = f.rerunJob;
    if (!pending(f) || !origin) continue;
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
          : z.string().parse(await read(`actions/jobs/${job.id}/logs`, true));
      if (!current()) return true;
      const failure = {
        ...f,
        ...ciSignature(f.check, log, job.conclusion ?? "failure", job.labels),
        outcome: "failed",
        rerunMarker: null,
        rerunJob: null,
      } as const;
      const checkPrefix = `https://api.github.com/${root}/check-runs/`;
      const checkId =
        job.check_run_url.startsWith(checkPrefix) &&
        job.check_run_url.slice(checkPrefix.length).match(/^(\d+)$/);
      if (!checkId) throw new Error("Incomplete CI rerun check");
      const unsafe = security.test(f.check) || (await unsafeEvidence(Number(checkId[1]), job, log));
      if (!current()) return true;
      if (!unsafe) store.recordCiFailure(failure);
      store.finishCiFailure(f, "failed_again");
      emit("ci.needs_fix", failure, `${pr.url}:${f.sha}:${failure.signature}`, false, log || failure.line);
    } else continue;
    resolved.add(job.id);
  }
  if (snap.ci !== "FAILURE" && snap.ci !== "ERROR") {
    // The rollup can finish before REST; retry unchanged success until every rerun is confirmed.
    return snap.ci !== "SUCCESS" || !store.ciFailures(pr.url, snap.headRefOid).some(pending);
  }
  const failures = await checks(snap.headRefOid);
  if (failures.some((c) => c.head_sha !== snap.headRefOid)) throw new Error("Incomplete PR CI");
  const names = new Set([
    ...snap.failing.map((c) => c.name),
    ...failures.filter((c) => c.status === "completed" && bad.has(c.conclusion ?? "")).map((c) => c.name),
  ]);
  if (!names.size) throw new Error("Incomplete CI failure: no failing checks");
  // Retain unresolved prior attempts even when their checks now pass or are absent below.
  // Reruns requested in this inspection wait for a new GraphQL observation first.
  let paused = false;
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
        if (consumer === "poller") {
          paused = true;
          continue;
        }
      }
      let job: z.infer<typeof jobSchema> | undefined;
      let jobUnsafe = false;
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
        jobUnsafe = await unsafeEvidence(
          c.id,
          job,
          [c.name, c.output?.title, c.output?.summary, c.output?.text].join("\n"),
          c.output?.annotations_count,
        );
        // A job that never started has no downloadable logs.
        if (
          job.started_at !== null &&
          job.conclusion !== "startup_failure" &&
          c.conclusion !== "startup_failure"
        ) {
          const body = await read(`actions/jobs/${job.id}/logs`, true, log);
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
      const evidence = [c.name, c.output?.title, c.output?.summary, c.output?.text, log].join("\n");
      const unsafe = jobUnsafe || security.test(c.name) || securityFailure(evidence);
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
      // GraphQL and check-runs can still describe the original failure after REST confirms its retry.
      if (
        job &&
        prior.some(
          (p) => p.outcome === "failed_then_passed" && p.rerunJob && job.run_attempt <= p.rerunJob.attempt,
        )
      )
        continue;
      if (prior.some(pending)) {
        const refused = prior.find((p) => pending(p) && p.rerunRetryAt != null);
        if (!refused) continue;
        // Older versions deferred explicit refusals; they also retain the head's claim.
        reject(refused, log || f.line);
        continue;
      }
      if (!unsafe) store.recordCiFailure(f);
      const needsFix = () =>
        emit("ci.needs_fix", f, `${pr.url}:${snap.headRefOid}:${f.signature}`, false, log || f.line);
      const transient =
        [c.conclusion, job?.conclusion].some((v) =>
          ["timed_out", "startup_failure", "cancelled"].includes(v ?? ""),
        ) ||
        job?.started_at === null ||
        logLines(log).some((line) => timeoutDiagnostic.test(line));
      // A land must report real failures even when main has the same red check.
      if (state.get(c.name)?.red && transient && !unsafe) {
        paused = true;
        continue;
      }
      if (!unsafe && !prior.length && job && transient && reruns) {
        const siblings = (await jobs(job.run_id, job.run_attempt)).filter((j) => j.name === job.name);
        if (siblings.length !== 1 || siblings[0]?.id !== job.id)
          throw new Error("Ambiguous originating CI job");
        if (!ready()) return false;
        const remote = z
          .object({ head: z.object({ sha: z.string() }), state: z.string() })
          .parse(await read(`pulls/${pr.url.split("/").at(-1)}`));
        if (remote.head.sha !== snap.headRefOid) return "head_moved";
        if (remote.state !== "open" || !current()) continue;
        if (!ready()) return false;
        if (
          store.claimCiRerun(f, marker, {
            id: job.id,
            runId: job.run_id,
            attempt: job.run_attempt,
            name: job.name,
          })
        ) {
          await requestRerun(f, job.id, log || f.line);
          continue;
        }
        // Another Store/daemon may win the atomic claim while this inspection awaits the head read.
        if (store.ciFailures(pr.url, snap.headRefOid).some((p) => pending(p) && p.rerunJob?.id === job.id))
          continue;
      }
      if (!current()) return true;
      needsFix();
    }
  }
  // The existing persisted pending inspection also tracks main-red pauses across restarts.
  const pendingRerun = store
    .ciFailures(pr.url, snap.headRefOid)
    .some((f) => pending(f) && outstanding.some((p) => p.signature === f.signature));
  return !pendingRerun && !paused;
}

export type CiDecision = { complete: boolean; state: "pending" | "failed" | "green" | "head_moved" };
const inspections = new WeakMap<Store, Map<string, Promise<CiDecision>>>();

/** Both CI consumers use the same inspection and durable head-wide claim, including after restart. */
export function ciDecision(
  store: Store,
  pr: TrackedPr,
  snap: PrSnapshot,
  call: Call,
  reruns: boolean,
  ready: () => boolean,
  current: () => boolean,
  consumer: "poller" | "land" = "poller",
): Promise<CiDecision> {
  let active = inspections.get(store);
  if (!active) {
    active = new Map();
    inspections.set(store, active);
  }
  const key = `${pr.url}:${snap.headRefOid}`;
  const previous = active.get(key);
  const result = (async (): Promise<CiDecision> => {
    await previous?.catch(() => undefined);
    if (!current()) return { complete: false, state: "pending" };
    let failed = false;
    const complete = await inspectCi(
      store,
      pr,
      snap,
      call,
      reruns,
      ready,
      current,
      () => {
        failed = true;
      },
      consumer,
    );
    if (complete === "head_moved") return { complete: false, state: "head_moved" };
    const waiting = store.ciFailures(pr.url, snap.headRefOid).some(pending);
    return {
      complete,
      state: !current()
        ? "pending"
        : failed
          ? "failed"
          : !complete || waiting || snap.ci !== "SUCCESS"
            ? "pending"
            : "green",
    };
  })();
  active.set(key, result);
  void result
    .finally(() => {
      if (active.get(key) === result) active.delete(key);
    })
    .catch(() => undefined);
  return result;
}
