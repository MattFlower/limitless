/** Parse a calendar date or ISO timestamp, rejecting Date.parse's calendar normalization. */
export function parseSince(value: string): number {
  const day = value.slice(0, 10);
  const ms = Date.parse(value);
  if (
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value) &&
    Number.isFinite(ms) &&
    new Date(`${day}T00:00:00Z`).toISOString().startsWith(day) &&
    !/T24:/.test(value)
  )
    return ms;
  throw new Error(`--since: invalid ISO-8601 timestamp ${value}; use YYYY-MM-DD or an ISO timestamp`);
}
