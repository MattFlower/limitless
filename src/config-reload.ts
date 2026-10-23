import { isDeepStrictEqual } from "node:util";
import type { Config } from "./config.ts";

export interface ConfigReload {
  applied: string[];
  restartRequired: string[];
  unchanged: string[];
}

const live = {
  workers: ["agents", "repos"],
  limits: ["max_concurrent_runs", "max_concurrent_gates"],
} as const;
const table = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === "[object Object]";

/** Compare TOML leaves (arrays are atomic), retaining unapplied overrides for the next comparison. */
export function reloadedConfig(current: Config, next: Config): { cfg: Config; result: ConfigReload } {
  const result: ConfigReload = { applied: [], restartRequired: [], unchanged: [] };
  const liveSection = (section: string) => section === "review" || Object.hasOwn(live, section);
  const reloadableSection = (section: string) => table(current.raw[section]) && table(next.raw[section]);
  const compare = (before: unknown, after: unknown, path: string[]) => {
    if (path.length === 1 && liveSection(path[0] ?? "") && !reloadableSection(path[0] ?? "")) {
      result[isDeepStrictEqual(before, after) ? "unchanged" : "restartRequired"].push(path.join("."));
      return;
    }
    if (table(before) || table(after)) {
      const a = table(before) ? before : {};
      const b = table(after) ? after : {};
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) compare(a[key], b[key], [...path, key]);
      if (!path.length || (keys.size && table(before) && table(after))) return;
      if (keys.size && (before === undefined || after === undefined)) return;
    }
    const key = path.map((p) => (/^[\w-]+$/.test(p) ? p : JSON.stringify(p))).join(".");
    const reloadable =
      path[0] === "review" ||
      Object.entries(live).some(([section, keys]) => path[0] === section && keys.some((k) => path[1] === k));
    result[isDeepStrictEqual(before, after) ? "unchanged" : reloadable ? "applied" : "restartRequired"].push(
      key,
    );
  };
  compare(current.raw, next.raw, []);
  for (const keys of Object.values(result)) keys.sort();
  const raw = { ...current.raw };
  if (reloadableSection("review")) raw.review = next.raw.review;
  for (const [section, keys] of Object.entries(live)) {
    const before = current.raw[section];
    const after = next.raw[section];
    if (!table(before) || !table(after)) continue;
    const merged = { ...before };
    for (const key of keys) {
      if (Object.hasOwn(after, key)) merged[key] = after[key];
      else delete merged[key];
    }
    raw[section] = merged;
  }
  return {
    result,
    cfg: {
      ...current,
      raw,
      ...(reloadableSection("workers")
        ? { workers: { ...current.workers, agents: next.workers.agents, repos: next.workers.repos } }
        : {}),
      ...(reloadableSection("limits")
        ? { maxConcurrentRuns: next.maxConcurrentRuns, maxConcurrentGates: next.maxConcurrentGates }
        : {}),
      ...(reloadableSection("review")
        ? {
            reviewMode: next.reviewMode,
            reviewShadow: next.reviewShadow,
            reviewShadowGraceSeconds: next.reviewShadowGraceSeconds,
            reviewTrustedReviewers: next.reviewTrustedReviewers,
            reviewRosters: next.reviewRosters,
            reviewAvoidImplementerVendor: next.reviewAvoidImplementerVendor,
            reviewImplementerReport: next.reviewImplementerReport,
          }
        : {}),
    },
  };
}
