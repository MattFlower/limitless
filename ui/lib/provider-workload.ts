import type { ProviderWorkload, WorkloadTotals } from "../../src/db/stats.ts";

const zero = (): WorkloadTotals => ({
  invocations: 0,
  tokensIn: 0,
  tokensOut: 0,
  wallTimeMs: 0,
  costEquivUsd: 0,
});

export function workloadFor(providerId: string, rows: ProviderWorkload[]): ProviderWorkload {
  return (
    rows.find((row) => row.provider === providerId) ?? {
      provider: providerId,
      today: zero(),
      sevenDays: zero(),
    }
  );
}
