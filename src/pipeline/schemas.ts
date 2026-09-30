import { z } from "zod";

/** JSON Schema acceptable to both Claude (--json-schema) and OpenAI strict structured outputs. */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema) as Record<string, unknown>;
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "$schema" || k === "minimum" || k === "maximum") continue;
      out[k] = clean(v);
    }
    return out;
  };
  return clean(raw) as Record<string, unknown>;
}

export const TaskClassEnum = z.enum([
  "dependency_update",
  "bugfix",
  "feature",
  "refactor",
  "docs",
  "test",
  "chore",
  "question",
]);
export const ComplexityEnum = z.enum(["trivial", "small", "medium", "large"]);

export const TriageSchema = z.object({
  title: z.string().describe("Short imperative title for the work, max ~70 chars"),
  task_class: TaskClassEnum,
  complexity: ComplexityEnum,
  risk: z.enum(["low", "medium", "high"]),
  ambiguity: z.enum(["low", "medium", "high"]),
  blocking_questions: z
    .array(z.string())
    .describe("Only questions whose answers would substantially change the implementation"),
  summary: z.string().describe("One or two sentences restating what must be done"),
  suggested_profile: z.enum(["quick", "standard", "deep"]),
});
export type Triage = z.infer<typeof TriageSchema>;

export const SpecSchema = z.object({
  summary: z.string(),
  assumptions: z.array(z.string()),
  requirements: z.array(z.string()),
  acceptance_criteria: z.array(
    z.object({
      id: z.string().describe("AC-1, AC-2, ..."),
      criterion: z.string().describe("Observable, testable statement of behavior"),
      how_to_verify: z.string().describe("Concrete command, test, or inspection that proves it"),
    }),
  ),
  out_of_scope: z.array(z.string()),
  blocking_questions: z.array(z.string()),
});
export type Spec = z.infer<typeof SpecSchema>;

export const HoldoutSchema = z
  .object({
    scenarios: z
      .array(
        z.object({
          id: z.string(),
          description: z.string().trim().min(1),
          steps: z.string().trim().min(1),
          expected: z.string().trim().min(1),
          // Informational: holdouts include edge cases only when the request or spec implies them.
          edge_case: z.boolean(),
        }),
      )
      .min(1)
      .max(8),
  })
  .superRefine(({ scenarios }, ctx) => {
    scenarios.forEach((s, i) => {
      if (s.id !== `H-${i + 1}`)
        ctx.addIssue({ code: "custom", path: ["scenarios", i, "id"], message: "IDs must be sequential H-n" });
    });
  });
export type Holdout = z.infer<typeof HoldoutSchema>;

/** Shorter than this (trimmed) with no findings, a first review's summary is a placeholder. */
export const MIN_REVIEW_SUMMARY = 40;
/** Later rounds may legitimately just confirm fixes ("P1 fixed; no regressions found."). */
export const MIN_LATER_REVIEW_SUMMARY = 12;

const summaryField = (min: number) =>
  z.string().describe(`What you checked and concluded; at least ${min} characters when findings is empty`);

const FindingCategoryEnum = z.enum([
  "correctness",
  "security",
  "reliability",
  "data",
  "concurrency",
  "compatibility",
  "test-gap",
  "cleanup",
  "conventions",
]);

/** Evidence fields added in finding schema v2; reviews stored before them omit all four. */
const findingV2 = {
  failure_scenario: z.string().describe("Concrete inputs or state that lead to the wrong output or crash"),
  category: FindingCategoryEnum,
  // Strict JSON schemas drop numeric bounds, so out-of-range values are clamped instead of rejected.
  confidence: z
    .number()
    .overwrite((value) => Math.min(1, Math.max(0, value)))
    .describe("How sure you are that this is a real defect, from 0 to 1"),
  introduced_by_diff: z.boolean().describe("True if the change under review introduced the defect"),
};

const reviewBase = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  summary: summaryField(MIN_REVIEW_SUMMARY),
  findings: z.array(
    z.object({
      severity: z.enum(["blocker", "major", "minor", "nit"]),
      security: z.boolean().describe("True for a security finding"),
      file: z.string().describe("Path, or empty string for general findings"),
      line: z.number().int().describe("Line number, or 0 if not applicable"),
      title: z.string(),
      detail: z.string(),
      suggestion: z.string(),
      ...findingV2,
    }),
  ),
});

const laterReviewBase = reviewBase.extend({
  summary: summaryField(MIN_LATER_REVIEW_SUMMARY),
  findings: z.array(
    reviewBase.shape.findings.element.extend({
      label: z
        .enum(["unaddressed", "regression", "new"])
        .describe(
          "unaddressed: prior blocking finding unresolved; regression: introduced by latest changes; new: first discovered now",
        ),
      prior: z
        .string()
        .describe(
          "For unaddressed: the id of the previous blocking finding it repeats (e.g. P2); otherwise an empty string",
        ),
    }),
  ),
});

// A placeholder like {"summary":"test","findings":[]} would otherwise count as an approval.
const rejectDegenerate =
  (min: number) =>
  <T extends { summary: string; findings: unknown[] }>(review: T, ctx: z.RefinementCtx) => {
    if (review.findings.length === 0 && review.summary.trim().length < min)
      ctx.addIssue({
        code: "custom",
        path: ["summary"],
        message: `A review without findings needs a summary of at least ${min} characters describing what was checked`,
      });
  };

export const ReviewSchema = reviewBase.superRefine(rejectDegenerate(MIN_REVIEW_SUMMARY));
export const LaterReviewSchema = laterReviewBase.superRefine(rejectDegenerate(MIN_LATER_REVIEW_SUMMARY));

/** A panel verifier's ruling on one finder candidate; its severity, not the finder's, is authoritative. */
const VerificationSchema = z.object({
  verdict: z.enum(["CONFIRMED", "PLAUSIBLE", "REFUTED"]),
  evidence: z
    .string()
    .trim()
    .min(1)
    .describe("Quoted code with file:line that supports or disproves the claim"),
  trigger: z.string().trim().min(1).describe("Inputs or state -> the wrong outcome"),
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: FindingCategoryEnum,
});
export type Verification = z.infer<typeof VerificationSchema>;

export const VerifierSchema = z.object({
  results: z.array(VerificationSchema.extend({ id: z.string().describe("The candidate id, e.g. C3") })),
});

type LiveFinding = z.infer<typeof ReviewSchema>["findings"][number];
type FindingV2Field = keyof typeof findingV2;

/** Findings in run state may predate schema v2, so its fields stay optional once stored. */
export type Review = Omit<z.infer<typeof ReviewSchema>, "findings"> & {
  /** Set by panel reviews, whose findings block by verification instead of finder severity. */
  mode?: "panel";
  findings: (Omit<LiveFinding, FindingV2Field> &
    Partial<Pick<LiveFinding, FindingV2Field>> & {
      label?: z.infer<typeof LaterReviewSchema>["findings"][number]["label"];
      prior?: string;
      /** Panel only; absent when the candidate was not verified (capped, cleanup or conventions, or left out by the verifier). */
      verification?: Verification;
      /** Panel only: how many distinct finders raised it (0 for a recheck of a prior blocking finding). */
      agreement?: number;
    })[];
};

/**
 * The diff a panel review covered: R1 the full change, R2 and R3 only the fixes since the previous
 * review, a conflict-resolution review (outside R1-R3) the resolved change against the new base.
 */
export interface ReviewScope {
  kind: "full" | "fix" | "resolution";
  range: string;
}

/**
 * A review regraded from stored JSON, possibly written under an older schema. Grading reads only
 * severity, file and line, and derives the verdict itself, so every other field may be absent
 * (`security` was added later). The degenerate-summary rule still applies.
 */
const StoredFindingSchema = reviewBase.shape.findings.element.extend({
  security: z.boolean().default(false),
  title: z.string().default(""),
  detail: z.string().default(""),
  suggestion: z.string().default(""),
  ...z.object(findingV2).partial().shape,
  verification: VerificationSchema.optional(),
  agreement: z.number().int().optional(),
});
/** A panel's candidates and rulings, kept with eval output so refuted candidates stay regradable. */
const StoredPanelSchema = z.object({
  // Absent in records from before parallel finders and the merge.
  finders: z.array(z.object({ prompt: z.string(), vendor: z.string().nullable() })).optional(),
  candidates: z.array(
    StoredFindingSchema.extend({
      id: z.string(),
      // Null: a prior blocking finding no finder repeated, rechecked by the verifier.
      finder: z.number().int().nullable(),
      vendor: z.string().nullable(),
      raisedBy: z.array(z.number().int()).optional(),
    }),
  ),
  merged: z
    .array(
      StoredFindingSchema.extend({
        into: z.string(),
        finder: z.number().int(),
        vendor: z.string().nullable(),
      }),
    )
    .default([]),
  verdicts: z.array(VerificationSchema.extend({ id: z.string() })),
  refuted: z.array(z.string()),
  capped: z.array(z.string()),
  omitted: z.array(z.string()).default([]),
});
export const StoredReviewSchema = reviewBase
  .extend({
    verdict: reviewBase.shape.verdict.optional(),
    mode: z.literal("panel").optional(),
    summary: z.string().default(""),
    findings: z.array(StoredFindingSchema),
    panel: StoredPanelSchema.optional(),
  })
  .superRefine(rejectDegenerate(MIN_REVIEW_SUMMARY));
export type StoredReview = Omit<Review, "verdict"> & Partial<Pick<Review, "verdict">>;

export const VerifySchema = z.object({
  criteria: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["met", "unmet", "unclear", "blocked"]),
      evidence: z.string().trim().min(1).describe("Command + observed output, or file:line references"),
      publicSummary: z
        .string()
        .describe(
          "For H-ids, short observed behavior without private inputs or expected values; empty for public criteria",
        ),
    }),
  ),
  overall: z.enum(["pass", "fail"]),
  notes: z.string(),
});
export type Verify = z.infer<typeof VerifySchema>;

export function renderSpec(spec: Spec): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");
  return [
    `## Summary\n${spec.summary}`,
    `## Requirements\n${list(spec.requirements)}`,
    `## Acceptance criteria\n${spec.acceptance_criteria.map((a) => `- **${a.id}** ${a.criterion}\n  - verify: ${a.how_to_verify}`).join("\n")}`,
    `## Assumptions\n${list(spec.assumptions)}`,
    `## Out of scope\n${list(spec.out_of_scope)}`,
  ].join("\n\n");
}
