/** Finding schema v2 fields a live reviewer must return; stored reviews may omit them. */
export const findingEvidence = {
  failure_scenario: "Running the change produces the wrong result",
  category: "correctness",
  confidence: 0.9,
  introduced_by_diff: true,
} as const;

export const attributionEvidence = {
  change: "base src/a.ts:3 and head src/a.ts:3 retain the same call",
  obligation: "The call must handle missing input",
  obligationSource: "src/a.ts:1 public function contract",
  base: { setup: "ok", result: "Missing input throws on base" },
  head: "Missing input throws on head",
} as const;
