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
): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(canonical({ modelId, harness, prompt, systemAppend, schema, trial, repository })))
    .digest("hex");
}
