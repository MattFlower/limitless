/** Finding schema v2 fields a live reviewer must return; stored reviews may omit them. */
export const findingEvidence = {
  failure_scenario: "Running the change produces the wrong result",
  category: "correctness",
  confidence: 0.9,
  introduced_by_diff: true,
} as const;
