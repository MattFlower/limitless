export function resolveTestWorkers(value = process.env.LIMITLESS_TEST_WORKERS): number {
  const n = Number(value);
  return /^\d+$/.test(value ?? "") && Number.isSafeInteger(n) && n > 0 ? n : 4;
}
