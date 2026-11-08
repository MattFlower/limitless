/** Run with: bun scripts/benchmark-holdout-redaction.ts (offline, owned children, 15 s deadlines). */
import { createHash } from "node:crypto";
import { holdoutRedactor } from "../src/pipeline/prompts.ts";
import type { Holdout } from "../src/pipeline/schemas.ts";
import { agentEnv, runProcess } from "../src/util/proc.ts";

// Frozen implementation from before the bounded-work fix, including its classification cache.
const holdoutBoundaryPattern = (detail: string) => {
  const escaped = detail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?<![\\p{L}\\p{N}_$])${escaped}(?![\\p{L}\\p{N}_$])`;
};

function collectHoldoutLiterals(source: string, collect: (detail: string) => void) {
  for (const literal of source.match(
    /(?<![\w])(["'`])(?:(?!\1)[^\n])*?\1|(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+|--?[A-Za-z][\w-]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?:[A-Z][\w$]*|\d[\w$]*|_[\w$]+)\b/g,
  ) ?? []) {
    collect(/^["'`]/u.test(literal) ? literal.slice(1, -1) : literal);
  }
}

function collectHoldoutDetails(holdout: Holdout, collect: (detail: string) => void) {
  for (const scenario of holdout.scenarios) {
    for (const source of [scenario.description, scenario.steps, scenario.expected]) {
      // Whole phrases cover prose; only syntax-shaped literals are removed in isolation.
      if (source.trim().split(/\s+/).length > 1) collect(source.trim());
      for (const sentence of source.match(/[^.!?\n]+[.!?]/g) ?? [])
        if (sentence.trim().split(/\s+/).length > 1) collect(sentence.trim());
      collectHoldoutLiterals(source, collect);
    }
  }
}

function legacyHoldoutRedactor(holdout: Holdout, publicSources = "") {
  const privateLiterals = new Map<string, boolean>();
  const isPrivate = (detail: string) => {
    let result = privateLiterals.get(detail);
    if (result === undefined) {
      result = !!detail && !new RegExp(holdoutBoundaryPattern(detail), "iu").test(publicSources);
      privateLiterals.set(detail, result);
    }
    return result;
  };
  const details = new Set<string>();
  collectHoldoutDetails(holdout, (detail) => {
    if (isPrivate(detail)) details.add(detail);
  });
  const compile = (literals: Set<string>) =>
    literals.size
      ? new RegExp(
          [...literals]
            .sort((a, b) => b.length - a.length)
            .map(holdoutBoundaryPattern)
            .join("|"),
          "giu",
        )
      : undefined;
  const basePattern = compile(details);
  // Retain only the last observed pattern: event IDs make observed sets mostly unique.
  let lastKey = "";
  let lastPattern: RegExp | undefined;
  return (value: string, includeObservedLiterals = true): string => {
    if (!holdout.scenarios.length) return value;
    const extra = new Set<string>();
    // Observed details belong only to this value; public exemptions are safe to memoize.
    if (includeObservedLiterals)
      collectHoldoutLiterals(value, (detail) => {
        if (!details.has(detail) && isPrivate(detail)) extra.add(detail);
      });
    const key = extra.size ? JSON.stringify([...extra].sort()) : "";
    if (key && key !== lastKey) {
      lastKey = key;
      lastPattern = compile(extra);
    }
    const observedPattern = key ? lastPattern : undefined;
    if (basePattern) basePattern.lastIndex = 0;
    if (observedPattern) observedPattern.lastIndex = 0;
    let base = basePattern?.exec(value);
    let observed = observedPattern?.exec(value);
    let position = 0;
    let removed = 0;
    let safe = "";
    // Merge against the original input, preserving the combined alternation's stable length sort.
    while (base || observed) {
      const match =
        base &&
        (!observed ||
          base.index < observed.index ||
          (base.index === observed.index && base[0].length >= observed[0].length))
          ? base
          : observed;
      if (!match) break;
      safe += `${value.slice(position, match.index)}[private detail]`;
      position = match.index + match[0].length;
      removed++;
      // An overlapping pending match may hide another match starting inside its own span.
      if (base && base.index < position && basePattern) {
        basePattern.lastIndex = position;
        base = basePattern.exec(value);
      }
      if (observed && observed.index < position && observedPattern) {
        observedPattern.lastIndex = position;
        observed = observedPattern.exec(value);
      }
    }
    return removed ? `${safe}${value.slice(position)} [${removed} private details withheld]` : value;
  };
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
    .repeat(160)
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
const values = Array.from({ length: 2000 }, (_, i) => {
  const payload = payloads[i % payloads.length] ?? "";
  const length = 2500;
  const event = `toolu_${i.toString(36)} msg_${i} /work/event-${i}/output.ts:${100_000 + i}`;
  return `${event} ${payload} ${ordinary.repeat(26)}`.slice(0, length);
});

const largeLiterals = Array.from({ length: 6000 }, (_, i) => `privateRuntime_${i}_${"x".repeat(180)}`);
const largeValue = largeLiterals.map((s) => `'${s}'`).join(" ");
const staticHoldout: Holdout = {
  scenarios: largeLiterals.map((literal, i) => ({
    id: `H-${i}`,
    description: "private",
    steps: `'${literal}'`,
    expected: "ok",
    edge_case: false,
  })),
};
const smallHoldout: Holdout = {
  scenarios: [{ id: "H-1", description: "private", steps: "private", expected: "ok", edge_case: false }],
};
const classificationValue = Array.from({ length: 4000 }, (_, i) => `observedId_${i}`).join(" ");
const corpora = {
  ordinary: { holdout, publicSources, values },
  static: { holdout: staticHoldout, publicSources: "", values: [largeValue] },
  observed: { holdout: smallHoldout, publicSources: "", values: [largeValue] },
  classification: {
    holdout: smallHoldout,
    publicSources: `prefix${classificationValue.replaceAll(" ", "suffix prefix")}suffix `.repeat(2),
    values: Array.from({ length: 63 }, (_, batch) =>
      Array.from({ length: Math.min(64, 4000 - batch * 64) }, (_, i) => `observedId_${batch * 64 + i}`).join(
        " ",
      ),
    ),
  },
  oversized: { holdout: smallHoldout, publicSources: "", values: ["ordinary ".repeat(200_000)] },
  unmatched: {
    holdout: smallHoldout,
    publicSources: "",
    values: [8000, 32_000, 65_536].map((size) => "x".repeat(size)),
  },
  whitespace: { holdout: smallHoldout, publicSources: "", values: [" ".repeat(65_536)] },
  dotted: { holdout: smallHoldout, publicSources: "", values: ["x.".repeat(32_768)] },
};
type Corpus = keyof typeof corpora;
const [mode, selected] = process.argv.slice(2);
if ((mode === "before" || mode === "after") && selected && selected in corpora) {
  const corpus = corpora[selected as Corpus];
  let constructionMs = 0;
  let constructing = true;
  let callStart: number | undefined;
  let worstMs = 0;
  let withheld = 0;
  let failure: string | null = null;
  const hash = createHash("sha256");
  const start = performance.now();
  try {
    const redact = (mode === "before" ? legacyHoldoutRedactor : holdoutRedactor)(
      corpus.holdout,
      corpus.publicSources,
    );
    constructionMs = performance.now() - start;
    constructing = false;
    for (const value of corpus.values) {
      callStart = performance.now();
      const output = redact(value);
      worstMs = Math.max(worstMs, performance.now() - callStart);
      withheld += Number(output.startsWith("[value withheld:"));
      hash.update(output);
      callStart = undefined;
    }
  } catch (error) {
    if (constructing) constructionMs = performance.now() - start;
    if (callStart !== undefined) worstMs = performance.now() - callStart;
    failure = error instanceof SyntaxError ? "SyntaxError" : "matcher failure";
  }
  console.log(
    JSON.stringify({
      constructionMs,
      totalMs: performance.now() - start,
      worstMs,
      withheld,
      failure,
      digest: hash.digest("hex"),
    }),
  );
} else {
  console.log(`Bun ${Bun.version}; synthetic corpus; milliseconds; 15 s per owned subprocess`);
  console.log(
    "Limits (UTF-16 units): value/source 65536; before extraction: punctuation-delimited runs 4096, non-whitespace tokens 512; aggregate authored sources 262144; public sources 262144 checked before any classification scan; detail 4096; alternatives/scenarios 512; pattern 32768; classification per operation 4194304 (sum of new detail + public lengths); retained classifications 2048, evicted between values at >1536.",
  );
  const digests = new Map<string, string>();
  for (const [name, corpus] of Object.entries(corpora)) {
    console.log(
      `${name}: scenarios=${corpus.holdout.scenarios.length}; authored=${corpus.holdout.scenarios.reduce((n, s) => n + s.description.length + s.steps.length + s.expected.length, 0)}; public=${corpus.publicSources.length}; values=${corpus.values.length}; aggregate output=${corpus.values.reduce((n, s) => n + s.length, 0)}; adversarial static/observed cases use 6000 literals`,
    );
    for (const mode of ["before", "after"]) {
      const result = await runProcess({
        cmd: [process.execPath, import.meta.path, mode, name],
        cwd: process.cwd(),
        env: agentEnv(),
        timeoutMs: 15_000,
      });
      if (result.timedOut || result.exitCode !== 0) {
        console.log(
          `${mode}: ${result.timedOut ? "deadline exceeded" : "child failed"}; elapsed=${result.durationMs} ms`,
        );
        continue;
      }
      const measured = JSON.parse(result.stdout) as {
        constructionMs: number;
        totalMs: number;
        worstMs: number;
        withheld: number;
        failure: string | null;
        digest: string;
      };
      console.log(
        `${mode}: construction=${measured.constructionMs.toFixed(3)}; total=${measured.totalMs.toFixed(3)}; worst value=${measured.worstMs.toFixed(3)}; whole values withheld=${measured.withheld}/${corpus.values.length}; outcome=${measured.failure ?? "completed"}`,
      );
      if (name === "ordinary") {
        if (mode === "before") digests.set(name, measured.digest);
        else if (digests.has(name) && digests.get(name) !== measured.digest)
          throw new Error("Ordinary output mismatch");
      }
    }
  }
}
