/** Severity class for a quota gauge's fill: amber from 70% used, red from 90%. */
export function gaugeClass(utilization: number): string {
  if (utilization >= 0.9) return "crit";
  if (utilization >= 0.7) return "warn";
  return "";
}
