export function formatCost(
  costUsd: number,
  costEquivUsd: number,
): {
  primary: string;
  paid: string | null;
  title: string;
} {
  const paid = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
  const equivalent = Number.isFinite(costEquivUsd) && costEquivUsd > 0 ? costEquivUsd : 0;
  return {
    primary: paid === 0 && equivalent === 0 ? "—" : `≈$${equivalent.toFixed(2)}`,
    paid: paid >= 0.005 ? `$${(Math.round(paid * 100) / 100).toFixed(2)}` : null,
    title: `API-equivalent $${Number(equivalent.toFixed(6))} · paid $${Number(paid.toFixed(6))}`,
  };
}
