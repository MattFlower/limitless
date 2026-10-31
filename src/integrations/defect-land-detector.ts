import type { FailureObservation } from "../db/failure-observations.ts";
import type { Store } from "../db/store.ts";
import type { createDefectReporter } from "./defect-reporter.ts";

/** Call once per integration mount, including disabled mounts; stopping leaves the window open. */
export function mountDefectWindow(store: Store, enabled: boolean, now: number): void {
  store.db
    .transaction(() => {
      if (!enabled) store.db.query("UPDATE defect_enablement_windows SET end=? WHERE end IS NULL").run(now);
      else
        store.db
          .query(`INSERT INTO defect_enablement_windows (start, end) SELECT ?, NULL
      WHERE NOT EXISTS (SELECT 1 FROM defect_enablement_windows WHERE end IS NULL)`)
          .run(now);
    })
    .immediate();
}

type Observation = Pick<
  FailureObservation,
  | "id"
  | "run_id"
  | "handle_kind"
  | "handle_id"
  | "repo"
  | "class"
  | "phase"
  | "history"
  | "name"
  | "sha"
  | "observed_at"
  | "finalized_at"
>;
type Reporter = Pick<ReturnType<typeof createDefectReporter>, "prepareSubmission" | "read">;
const pending = `SELECT o.id,o.run_id,o.handle_kind,o.handle_id,o.repo,o.class,o.phase,o.history,
  o.name,o.sha,o.observed_at,o.finalized_at
  FROM failure_observations o INDEXED BY failure_observations_defect_pending
  LEFT JOIN defect_observation_consumption c ON c.observation_id=o.id
  WHERE o.purpose='land' AND o.interim=0 AND o.class IS NOT NULL AND o.finalized_at IS NOT NULL
  AND o.finalized_at >= (SELECT min(start) FROM defect_enablement_windows)
  AND c.observation_id IS NULL AND EXISTS (SELECT 1 FROM defect_enablement_windows w
    WHERE w.start<=o.finalized_at AND (w.end IS NULL OR o.finalized_at<w.end))
  ORDER BY o.id LIMIT 50`;

/** No cursor: late finalizations and enabled-window backlog remain pending until atomic acceptance. */
export async function detectLandDefects(
  store: Store,
  reporter: Reporter,
  active: () => boolean,
  diagnostic: (message: string) => void = console.warn,
): Promise<void> {
  const consume = store.db.query(
    "INSERT INTO defect_observation_consumption (observation_id,status) VALUES (?,?)",
  );
  for (const o of store.db.query<Observation, []>(pending).all()) {
    if (!active()) return;
    const handle = /^([1-9]\d*):([1-9]\d*)$/u.exec(o.handle_id);
    const id = Number(handle?.[1]);
    const entry = Number.isSafeInteger(id) ? store.getLandEntry(id) : null;
    const repos = store.listRepos().filter((r) => r.slug.toLowerCase() === o.repo.toLowerCase());
    const source = repos[0];
    if (
      !entry ||
      !source ||
      repos.length !== 1 ||
      o.handle_kind !== "land" ||
      o.run_id !== `land:${entry.id}` ||
      entry.repo !== o.repo ||
      !Number.isSafeInteger(Number(handle?.[2])) ||
      Number(handle?.[2]) > entry.attempts
    ) {
      consume.run(o.id, "unresolved");
      diagnostic("Defect observation identity unresolved");
      continue;
    }
    const pr = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/iu.exec(entry.prUrl);
    const checked = pr?.[1]?.toLowerCase() === source.slug.toLowerCase() ? Number(pr?.[2]) : NaN;
    const commit = await reporter.prepareSubmission(String(o.id), {
      sourceId: source.id,
      detector: "land-check",
      class: o.class ?? "unclassified",
      phase: o.phase,
      history: o.history ? [o.history] : [],
      checkIdentity: o.name,
      shas: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(o.sha) ? [o.sha] : [],
      landRefs: [`land:${entry.id}`],
      runRefs: entry.runId ? [entry.runId] : [],
      checkedPrContext: Number.isSafeInteger(checked) ? [checked] : [],
      timestamps: [o.observed_at, o.finalized_at].map((at) => new Date(at ?? 0).toISOString()),
      machineRole: "unknown",
    });
    if (!active()) return;
    commit(() => {
      const state = reporter.read(source.id, String(o.id))?.state;
      consume.run(
        o.id,
        state === "no-report" || state === "blocked" || state === "suppressed" ? state : "submitted",
      );
    });
  }
}
