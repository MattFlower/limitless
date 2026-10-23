import type { DayStats } from "../../src/db/stats.ts";

function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The last `count` local calendar days ending today, with days that had no activity filled in as
 * zero, so the chart keeps a steady time axis instead of stretching the active days across it.
 * Days the daemon reported outside that window (it buckets in its own timezone) are kept.
 */
export function padDays(days: DayStats[], count: number, now = Date.now()): DayStats[] {
  const reported = new Map(days.map((d) => [d.day, d]));
  const today = new Date(now);
  const filled: DayStats[] = [];
  for (let back = count - 1; back >= 0; back--) {
    // Constructing from calendar parts (not subtracting 24h) stays correct across DST changes.
    const day = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back));
    filled.push(reported.get(day) ?? { day, runs: 0, succeeded: 0, failed: 0, costUsd: 0, costEquivUsd: 0 });
    reported.delete(day);
  }
  return [...reported.values(), ...filled].sort((a, b) => a.day.localeCompare(b.day));
}
