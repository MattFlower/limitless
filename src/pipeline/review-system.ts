import { z } from "zod";
import type { Config } from "../config.ts";
import type { RepoReviewLens, ResolvedProfile, ReviewFinder, ReviewSystem } from "../core/types.ts";
import { parseTarget } from "../router/targets.ts";

// The same reference syntax as `--models` (no trimming); the catalog check happens at submission.
const TargetSchema = z.string().superRefine((target, ctx) => {
  try {
    parseTarget(target);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
  }
});
const LensSchema = z.strictObject({
  name: z.string().trim().min(1, "lens name must not be empty"),
  focus: z.string().trim().min(1, "lens focus must not be empty"),
});
const FinderSchema = z
  .strictObject({
    target: TargetSchema.optional(),
    prompt: z.enum(["standard", "adversarial", "careful"], {
      error: 'finder prompt must be "standard", "adversarial" or "careful"',
    }),
    lens: LensSchema.optional(),
    family: z.enum(["cross", "implementer"]).optional(),
    local: z.boolean().optional(),
  })
  .refine((f) => !f.lens || f.prompt === "standard", {
    path: ["lens"],
    message: 'a lens finder uses the "standard" prompt',
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
    if (
      system.mode === "single" &&
      system.finders.some((f) => f.prompt !== "standard" || f.lens || f.family || f.local)
    )
      ctx.addIssue({
        code: "custom",
        path: ["finders"],
        message: 'mode "single" uses the "standard" prompt, with no lens, family or local finder',
      });
    if (system.mode === "single" && system.verifier)
      ctx.addIssue({ code: "custom", path: ["verifier"], message: 'mode "single" takes no verifier' });
    // A local finder may be skipped, so it never counts.
    if (system.mode === "panel" && system.finders.every((f) => f.local))
      ctx.addIssue({
        code: "custom",
        path: ["finders"],
        message: 'mode "panel" needs at least one finder that is not local',
      });
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

/** Removed behaviour and failure paths: a mechanism lens a small local model can check cheaply. */
const LOCAL_LENS = {
  name: "removed-behaviour-and-failure-paths",
  focus:
    "Behaviour the change removes or narrows (deleted branches, cases, options, fields or checks) that callers still rely on, and failure paths: errors swallowed or misreported, partial writes left behind, cleanup skipped, and retries that repeat side effects.",
};
const STANDARD_ROSTER: ReviewFinder[] = [
  { prompt: "adversarial" },
  { prompt: "careful", family: "implementer" },
  { prompt: "standard", lens: LOCAL_LENS, local: true },
];
/** Panel finders per profile; `deep` also gets the repo lenses, which default to it. */
export const DEFAULT_ROSTERS: Record<ResolvedProfile, ReviewFinder[]> = {
  quick: [{ prompt: "standard" }],
  standard: STANDARD_ROSTER,
  deep: STANDARD_ROSTER,
};
const RosterSchema = z
  .array(FinderSchema)
  .refine((roster) => roster.some((f) => !f.local), "a roster needs at least one finder that is not local");
const RostersSchema = z.strictObject({
  quick: RosterSchema.default(DEFAULT_ROSTERS.quick),
  standard: RosterSchema.default(DEFAULT_ROSTERS.standard),
  deep: RosterSchema.default(DEFAULT_ROSTERS.deep),
});

/** `[review.rosters]` from config.toml; a profile it leaves out keeps its default roster. */
export function parseReviewRosters(raw: unknown): Record<ResolvedProfile, ReviewFinder[]> {
  const parsed = RostersSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`review.rosters: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

const RepoReviewSchema = z.strictObject({
  lenses: z
    .array(
      LensSchema.extend({
        profiles: z
          .array(z.enum(["quick", "standard", "deep"]))
          .min(1)
          .default(["deep"]),
      }) satisfies z.ZodType<RepoReviewLens>,
    )
    .default([]),
});

/** `[review] lenses` from a `.limitless.toml`; callers pass the base commit's, never the change's. */
export function readReviewLenses(contents: string | null): RepoReviewLens[] {
  const review = contents === null ? undefined : (Bun.TOML.parse(contents) as { review?: unknown }).review;
  if (review === undefined) return [];
  const parsed = RepoReviewSchema.safeParse(review);
  if (!parsed.success)
    throw new Error(`Invalid [review] in .limitless.toml:\n${z.prettifyError(parsed.error)}`);
  return parsed.data.lenses;
}

/**
 * The review system a run uses: the production single review unless `[review] mode = "panel"`, then
 * the profile's roster plus a standard-prompt finder for each repo lens listing that profile.
 * `lenses` is undefined for a run prepared in single mode: it stays single, so no panel runs without
 * its base lenses, while switching panel mode off applies to the next review of every run.
 */
export function configuredReviewSystem(
  cfg: Pick<Config, "reviewImplementerReport" | "reviewMode" | "reviewRosters">,
  profile: ResolvedProfile,
  lenses: RepoReviewLens[] | undefined,
): ReviewSystem {
  if (cfg.reviewMode !== "panel" || !lenses) return productionReviewSystem(cfg);
  return ReviewSystemSchema.parse({
    name: `panel-${profile}`,
    mode: "panel",
    finders: [
      ...cfg.reviewRosters[profile],
      ...lenses
        .filter((lens) => lens.profiles.includes(profile))
        .map(({ name, focus }) => ({ prompt: "standard", lens: { name, focus } })),
    ],
    verifier: {},
    implementerReport: cfg.reviewImplementerReport,
  });
}
