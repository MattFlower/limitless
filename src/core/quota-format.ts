export function utilizationPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "0%";
  // Round to 1e-4 % first: 0.07 * 100 is 7.000000000000001 in floating point and must not show 8%.
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 1e6) / 1e4;
  return `${Math.ceil(percent)}%`;
}

export function observationAge(observedAt: number | null | undefined, now = Date.now()): string {
  if (observedAt === null || observedAt === undefined || !Number.isFinite(observedAt)) return "as of unknown";
  const elapsed = Math.max(0, now - observedAt);
  if (elapsed < 60_000) return "as of just now";
  if (elapsed < 3_600_000) return `as of ${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `as of ${Math.floor(elapsed / 3_600_000)} hr ago`;
  const days = Math.floor(elapsed / 86_400_000);
  return `as of ${days} ${days === 1 ? "day" : "days"} ago`;
}
