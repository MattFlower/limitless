import type { Factory } from "../app.ts";
import { repoSettings } from "../config.ts";
import { loadPrivateStrings } from "../gates/private.ts";
import { createDefectGitHub } from "./defect-github.ts";
import { detectLandDefects, mountDefectWindow } from "./defect-land-detector.ts";
import { createDefectReporter, type DefectReporterDeps } from "./defect-reporter.ts";
import { githubIdentity } from "./github-identity.ts";
import type { IssueQueueClock } from "./issue-queue.ts";

export type DefectServiceDeps = Partial<
  Pick<DefectReporterDeps, "identity" | "loadPrivateStrings" | "registeredCredentials">
> & { defectGitHub?: DefectReporterDeps["github"]; issueClock?: IssueQueueClock };

/** A mount owns its send gate and work; stopping deliberately leaves its enablement window open. */
export function startDefectService(factory: Factory, deps: DefectServiceDeps) {
  const { store, cfg } = factory;
  const clock = deps.issueClock ?? { now: Date.now, set: setTimeout, clear: clearTimeout };
  const settings = cfg.githubDefects;
  mountDefectWindow(store, settings?.enabled === true, clock.now());
  if (!settings?.enabled || !settings.factoryRepo) return async () => {};
  const abort = new AbortController();
  let generation = 0;
  const active = () => generation === 0;
  const reporter = createDefectReporter(store, {
    ...deps,
    get repos() {
      return store.listRepos();
    },
    factory: settings.factoryRepo,
    dailyCap: settings.dailyCap,
    loadPrivateStrings:
      deps.loadPrivateStrings ??
      (() => loadPrivateStrings(cfg.paths.configDir, [cfg.paths.repos, cfg.paths.work])),
    policy: (repo) => repoSettings(cfg, typeof repo === "string" ? repo : repo.slug),
    identity: deps.identity ?? githubIdentity,
    github: deps.defectGitHub ?? createDefectGitHub(abort.signal),
    coordinator: () => ({ enabled: active() }),
    now: clock.now,
  });
  let initial = true;
  let flight: Promise<void> | undefined;
  const pass = async () => {
    if (!active()) return;
    if (initial) {
      await reporter.reconcile();
      if (!active()) return;
      initial = false;
    }
    await detectLandDefects(store, reporter, active);
    if (active()) await reporter.reconcile();
  };
  const tick = () =>
    (flight ??= pass()
      .catch(() => console.warn("Defect reporter check failed"))
      .finally(() => {
        flight = undefined;
      }));
  const schedule = (ms: number): ReturnType<typeof setTimeout> =>
    clock.set(() => {
      if (!active()) return;
      timer = schedule(60_000);
      void tick();
    }, ms);
  let timer = schedule(0);
  return async () => {
    generation++;
    clock.clear(timer);
    abort.abort();
    await flight;
  };
}
