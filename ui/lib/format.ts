// Small, dependency-free formatting helpers shared by every page.

/** Real-money formatting: "$12.34", "$0.004" for tiny metered amounts. */
export function money(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** Subscription-equivalent formatting, muted "≈$x.xx" form (caller adds the muted styling). */
export function equivMoney(n: number): string {
  return `≈${money(n)}`;
}

export function compactNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function pct(fraction: number): string {
  if (!Number.isFinite(fraction)) return "0%";
  return `${Math.round(Math.max(0, fraction) * 100)}%`;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "42s", "3m 12s", "1h 05m", "2d 3h" */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < SECOND) return "0s";
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`;
  if (ms < HOUR) {
    const m = Math.floor(ms / MINUTE);
    const s = Math.floor((ms % MINUTE) / SECOND);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / MINUTE);
    return m ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
  }
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** Relative time from now: "just now", "3m ago", "2h ago", "5d ago". */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 5 * SECOND) return "just now";
  if (diff < MINUTE) return `${Math.floor(diff / SECOND)}s ago`;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "resets in 2h 10m" / "resets now" for quota windows. */
export function resetsIn(resetsAt: number | null, now = Date.now()): string {
  if (resetsAt === null) return "";
  const diff = resetsAt - now;
  if (diff <= 0) return "resets now";
  return `resets in ${duration(diff)}`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
