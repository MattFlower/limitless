import type { Stats } from "../../src/db/stats.ts";

/** Runs that need the owner now, however old they are; an older daemon reports only the 14-day count. */
export function openNeedsYou(stats: Pick<Stats, "needsYouRunIds" | "totals">): number {
  return stats.needsYouRunIds?.length ?? stats.totals.openNeedsHuman;
}
