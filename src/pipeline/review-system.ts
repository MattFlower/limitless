import { z } from "zod";
import type { Config } from "../config.ts";
import type { ReviewSystem } from "../core/types.ts";

const FinderSchema = z.strictObject({
  target: z.string().trim().min(1, "finder target must not be empty").optional(),
  prompt: z.literal("standard", { error: 'unsupported finder prompt; only "standard" is implemented' }),
});
export const ReviewSystemSchema = z.strictObject({
  name: z.string().trim().min(1, "system name must not be empty"),
  mode: z.literal("single", { error: 'unsupported review system mode; only "single" is implemented' }),
  finders: z.array(FinderSchema).length(1, 'mode "single" takes exactly one finder'),
  implementerReport: z.enum(["include", "omit"], { error: 'implementerReport must be "include" or "omit"' }),
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
