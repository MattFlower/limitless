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
          edge_case: z.boolean(),
        }),
      )
      .min(3)
      .max(8),
  })
  .superRefine(({ scenarios }, ctx) => {
    if (scenarios.filter((s) => s.edge_case).length < 2)
      ctx.addIssue({ code: "custom", message: "At least two edge or failure cases are required" });
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

export type Review = Omit<z.infer<typeof ReviewSchema>, "findings"> & {
  findings: (z.infer<typeof ReviewSchema>["findings"][number] & {
    label?: z.infer<typeof LaterReviewSchema>["findings"][number]["label"];
    prior?: string;
  })[];
};

/**
 * A review regraded from stored JSON. The verdict is derived from the findings, so the model's own
 * verdict may be absent; the degenerate-summary rule still applies.
 */
export const StoredReviewSchema = reviewBase
  .extend({ verdict: reviewBase.shape.verdict.optional() })
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
