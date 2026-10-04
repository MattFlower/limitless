/** Share of a call's prompt tokens a cache served; writes and uncached input count against it. */
export const cacheHitRate = (cached: number, promptTokens: number): string =>
  promptTokens > 0 ? `${((cached / promptTokens) * 100).toFixed(1)}%` : "n/a";
