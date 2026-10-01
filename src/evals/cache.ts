import type { ReviewSystem } from "../core/types.ts";

/** Sort object keys recursively so schema construction order does not change identity. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function cacheKey(
  modelId: string,
  harness: string,
  prompt: string,
  systemAppend: string,
  schema: Record<string, unknown>,
  trial: number,
  repository?: unknown,
  /** Resolved at submission; null/undefined marks legacy trials whose effort is unknown. */
  effort?: string | null,
  /** Provider and backend model of every target, so a new checkpoint behind a catalog ID is a miss. */
  backends?: unknown,
): string {
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify(
        canonical({
          modelId,
          harness,
          prompt,
          systemAppend,
          schema,
          trial,
          repository,
          effort: effort ?? "legacy-unknown",
          backends,
        }),
      ),
    )
    .digest("hex");
}
/**
 * Behavioural identity of a review system: key order and the display name don't change it, so
 * renaming a system (or `--models` naming it after its target) still reuses cached trials.
 */
export function reviewSystemHash({ name: _name, ...config }: ReviewSystem): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(canonical(config))).digest("hex");
}
