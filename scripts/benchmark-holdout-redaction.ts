/** Run with: bun scripts/benchmark-holdout-redaction.ts */
import { holdoutRedactor } from "../src/pipeline/prompts.ts";
import type { Holdout } from "../src/pipeline/schemas.ts";

// Frozen pre-optimization algorithm, including independent extraction and boundary logic.
function referenceRedactHoldoutText(
  value: string,
  holdout: Holdout,
  publicSources = "",
  includeObservedLiterals = true,
): string {
  if (!holdout.scenarios.length) return value;
  const boundaryPattern = (detail: string) => {
    const escaped = detail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return `(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`;
  };

  const observed = includeObservedLiterals ? value : undefined;
  const details = new Set<string>();
  const collect = (detail: string) => {
    if (detail && !new RegExp(boundaryPattern(detail), "iu").test(publicSources)) details.add(detail);
  };
  const collectLiterals = (source: string) => {
    for (const literal of source.match(
      /(?<![\w])(["'`])(?:(?!\1)[^\n])*?\1|(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+|--?[A-Za-z][\w-]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?:[A-Z][\w$]*|\d[\w$]*|_[\w$]+)\b/g,
    ) ?? []) {
      collect(/^["'`]/u.test(literal) ? literal.slice(1, -1) : literal);
    }
  };
  for (const scenario of holdout.scenarios) {
    for (const source of [scenario.description, scenario.steps, scenario.expected]) {
      // Whole phrases cover prose; only syntax-shaped literals are removed in isolation.
      if (source.trim().split(/\s+/).length > 1) collect(source.trim());
      for (const sentence of source.match(/[^.!?\n]+[.!?]/g) ?? [])
        if (sentence.trim().split(/\s+/).length > 1) collect(sentence.trim());
      collectLiterals(source);
    }
  }
  // Observed values and runtime error identifiers need not occur in the authored scenarios.
  if (observed !== undefined) collectLiterals(observed);
  if (!details.size) return value;
  const pattern = new RegExp(
    [...details]
      .sort((a, b) => b.length - a.length)
      .map(boundaryPattern)
      .join("|"),
    "giu",
  );
  let removed = 0;
  // A single pass counts displayed replacements and never scans inserted placeholders.
  const safe = value.replace(pattern, () => {
    removed++;
    return "[private detail]";
  });
  return removed ? `${safe} [${removed} private details withheld]` : safe;
}
const holdout: Holdout = {
  scenarios: Array.from({ length: 8 }, (_, i) => ({
    id: `H-${i + 1}`,
    description: `Validate the private collection for case ${i} with 'violet-case-${i}'. The ordering must remain stable when duplicate entries arrive together. An empty collection must produce the documented response without discarding earlier successful work.`,
    steps: `Execute /fixtures/private-case-${i} using --hidden-mode-${i} with privateInput_${i} and 73${i}. Compare the first result with the repeated request. Then submit 'overlap phrase ${i}' followed by 'overlap phrase ${i} extended' and check the final record.`,
    expected: `Return ERR_PRIVATE_${i} for the invalid entry. Keep the valid entries available and preserve their ordering after validation.`,
    edge_case: i % 2 === 0,
  })),
};
const publicSources =
  "Public documentation describes the collection request and stable ordering. Use --public-mode, publicInput, /api/public and 42 for the supported example.\n"
    .repeat(140)
    .slice(0, 20 * 1024);
const ordinary =
  "The agent inspected the collection and is checking the expected behavior before reporting the result. ";
const payloads = [
  "ordinary progress output with no private details",
  "--public-mode publicInput /api/public 42",
  ...holdout.scenarios.flatMap((s, i) => [
    s.description.split(". ")[0] ?? "",
    `/fixtures/private-case-${i} --hidden-mode-${i} privateInput_${i} 73${i}`,
    `ERR_PRIVATE_${i} 'overlap phrase ${i} extended'`,
  ]),
  "'observed runtime value' --runtime-mode runtimeError_99",
];
const values = Array.from({ length: 20_000 }, (_, i) => {
  const payload = payloads[i % payloads.length] ?? "";
  const length = 100 + (i % 301);
  return `${payload} ${ordinary.repeat(4)}`.slice(0, length);
});
const scenarioLengths = holdout.scenarios.map(
  (s) => s.description.length + s.steps.length + s.expected.length,
);
console.log(`Bun ${Bun.version}; synthetic corpus; all durations in milliseconds (ms)`);
console.log(`Scenarios: ${scenarioLengths.length}; characters each: ${scenarioLengths.join(", ")}`);
console.log(
  `Public sources: ${publicSources.length} characters; strings: ${values.length}; lengths: ${Math.min(...values.map((s) => s.length))}–${Math.max(...values.map((s) => s.length))} characters`,
);

function measure(redact: (value: string) => string) {
  let worstMs = 0;
  const outputs: string[] = [];
  const start = performance.now();
  for (const value of values) {
    const callStart = performance.now();
    const output = redact(value);
    worstMs = Math.max(worstMs, performance.now() - callStart);
    outputs.push(output);
  }
  return { totalMs: performance.now() - start, worstMs, outputs };
}

const before = measure((value) => referenceRedactHoldoutText(value, holdout, publicSources));
console.log(`Before: total ${before.totalMs.toFixed(3)} ms; worst call ${before.worstMs.toFixed(3)} ms`);
const constructionStart = performance.now();
const redact = holdoutRedactor(holdout, publicSources);
const constructionMs = performance.now() - constructionStart;
const after = measure(redact);
const totalMs = constructionMs + after.totalMs;
console.log(
  `After: construction ${constructionMs.toFixed(3)} ms; calls total ${after.totalMs.toFixed(3)} ms; total including construction ${totalMs.toFixed(3)} ms; worst call ${after.worstMs.toFixed(3)} ms`,
);
for (let i = 0; i < values.length; i++) {
  if (before.outputs[i] !== after.outputs[i]) throw new Error(`Output mismatch at string ${i}`);
}
console.log(
  `Outputs identical: ${values.length}/${values.length}; speedup including construction: ${(before.totalMs / totalMs).toFixed(2)}x`,
);
