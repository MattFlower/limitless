import { availableParallelism } from "node:os";

/**
 * Suite workers: a third of the cores, so concurrent gates, land checks and agents still fit, but
 * never fewer than the 4 that CI's runner has, nor more than 8. LIMITLESS_TEST_WORKERS overrides it.
 */
export function resolveTestWorkers(
  value = process.env.LIMITLESS_TEST_WORKERS,
  cores = availableParallelism(),
): number {
  const n = Number(value);
  if (/^\d+$/.test(value ?? "") && Number.isSafeInteger(n) && n > 0) return n;
  return Math.min(8, Math.max(4, Math.floor(cores / 3)));
}
