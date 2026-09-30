import { z } from "zod";
import type { Config } from "../config.ts";
import type { ReviewSystem } from "../core/types.ts";
import { parseTarget } from "../router/targets.ts";

// The same reference syntax as `--models` (no trimming); the catalog check happens at submission.
const TargetSchema = z.string().superRefine((target, ctx) => {
  try {
    parseTarget(target);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
  }
});
const FinderSchema = z.strictObject({
  target: TargetSchema.optional(),
  prompt: z.enum(["standard", "adversarial", "careful"], {
    error: 'finder prompt must be "standard", "adversarial" or "careful"',
  }),
});
export const ReviewSystemSchema = z
  .strictObject({
    name: z.string().trim().min(1, "system name must not be empty"),
    mode: z.enum(["single", "panel"], { error: 'unsupported review system mode; use "single" or "panel"' }),
    finders: z.array(FinderSchema),
    verifier: z.strictObject({ target: TargetSchema.optional() }).optional(),
    implementerReport: z.enum(["include", "omit"], {
      error: 'implementerReport must be "include" or "omit"',
    }),
  })
  .superRefine((system, ctx) => {
    if (system.mode === "single" && system.finders.length !== 1)
      ctx.addIssue({ code: "custom", path: ["finders"], message: 'mode "single" takes exactly one finder' });
    if (system.mode === "single" && system.finders.some((f) => f.prompt !== "standard"))
      ctx.addIssue({
        code: "custom",
        path: ["finders"],
        message: 'mode "single" uses the "standard" prompt',
      });
    if (system.mode === "single" && system.verifier)
      ctx.addIssue({ code: "custom", path: ["verifier"], message: 'mode "single" takes no verifier' });
    if (system.mode === "panel" && !system.finders.length)
      ctx.addIssue({ code: "custom", path: ["finders"], message: 'mode "panel" needs at least one finder' });
    if (system.mode === "panel" && !system.verifier)
      ctx.addIssue({ code: "custom", path: ["verifier"], message: 'mode "panel" needs a verifier' });
  }) satisfies z.ZodType<ReviewSystem>;

/** Eval candidates: uniquely named, and every finder pinned so results never depend on live routing. */
export const EvalReviewSystemsSchema = z
  .array(ReviewSystemSchema)
  .min(1, "at least one review system is required")
  .superRefine((systems, ctx) => {
    const names = new Set<string>();
    for (const [index, system] of systems.entries()) {
      if (names.has(system.name))
        ctx.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `duplicate review system name ${JSON.stringify(system.name)}`,
        });
      names.add(system.name);
      for (const [finder, { target }] of system.finders.entries())
        if (target === undefined)
          ctx.addIssue({
            code: "custom",
            path: [index, "finders", finder, "target"],
            message: `review system ${JSON.stringify(system.name)} needs an explicit finder target; routed finders are not allowed in evals`,
          });
      if (system.verifier && system.verifier.target === undefined)
        ctx.addIssue({
          code: "custom",
          path: [index, "verifier", "target"],
          message: `review system ${JSON.stringify(system.name)} needs an explicit verifier target; routed verifiers are not allowed in evals`,
        });
    }
  });

/** Parses a `--systems` file: `{ "systems": [ReviewSystem, ...] }`. */
export function parseEvalReviewSystems(text: string, source: string): ReviewSystem[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source}: malformed JSON: ${(error as Error).message}`);
  }
  const parsed = z.strictObject({ systems: EvalReviewSystemsSchema }).safeParse(json);
  if (!parsed.success)
    throw new Error(`${source}: invalid review systems:\n${z.prettifyError(parsed.error)}`);
  return parsed.data.systems;
}

/** Production reviews with one routed standard finder, honoring `[review] implementer_report`. */
export function productionReviewSystem(cfg: Pick<Config, "reviewImplementerReport">): ReviewSystem {
  return ReviewSystemSchema.parse({
    name: "production",
    mode: "single",
    finders: [{ prompt: "standard" }],
    implementerReport: cfg.reviewImplementerReport,
  });
}
