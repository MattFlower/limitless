import { z } from "zod";
import type { Config } from "../config.ts";
import type {
  RepoReviewLens,
  ResolvedProfile,
  ReviewFinder,
  ReviewLens,
  ReviewSystem,
} from "../core/types.ts";
import type { ModelDef, ProviderDef } from "../router/catalog.ts";
import { parseTarget, resolveTarget, transportError } from "../router/targets.ts";

// The same reference syntax as `--models` (no trimming); the catalog check happens at submission.
const TargetSchema = z.string().superRefine((target, ctx) => {
  try {
    parseTarget(target);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: (error as Error).message });
  }
});
// Lens text reaches finder prompts: a slug name cannot start a heading, and focus is quoted there.
const lensShape = {
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "lens name must be a lowercase slug of at most 64 characters"),
  focus: z
    .string()
    .trim()
    .min(1, "lens focus must not be empty")
    .max(2000, "lens focus is at most 2000 characters"),
};
const LensSchema = z.strictObject(lensShape);
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
const VerifierSchema = z
  .strictObject({
    target: TargetSchema.optional(),
    targets: z.array(TargetSchema).min(1, "verifier targets must not be empty").optional(),
  })
  .refine((v) => v.target === undefined || v.targets === undefined, {
    message: 'a verifier takes "target" or "targets", not both',
  });
export const ReviewSystemSchema = z
  .strictObject({
    name: z.string().trim().min(1, "system name must not be empty"),
    mode: z.enum(["single", "panel"], { error: 'unsupported review system mode; use "single" or "panel"' }),
    finders: z.array(FinderSchema),
    verifier: VerifierSchema.optional(),
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

/**
 * An eval candidate built from the daemon's configured roster for a profile: `targets` pins each of
 * its finders in order, then one per inline repo lens.
 */
const RosterReferenceSchema = z.strictObject({
  name: z.string().trim().min(1, "system name must not be empty"),
  replayFrom: z.string().trim().min(1).optional(),
  roster: z.enum(["quick", "standard", "deep"]),
  targets: z.array(TargetSchema).min(1),
  lenses: z.array(LensSchema).optional(),
  verifier: VerifierSchema.refine((v) => v.target !== undefined || v.targets !== undefined, {
    message: 'a roster verifier needs "target" or "targets"',
  }),
  implementerReport: z.enum(["include", "omit"]),
});
export type RosterReference = z.infer<typeof RosterReferenceSchema>;
export type EvalReviewSystem = ReviewSystem | RosterReference;
const EvalSystemSchema = ReviewSystemSchema.safeExtend({ replayFrom: z.string().trim().min(1).optional() });

/** Eval candidates: uniquely named, and every finder pinned so results never depend on live routing. */
export const EvalReviewSystemsSchema = z
  .array(z.unknown())
  .min(1, "at least one review system is required")
  // A `roster` key picks the roster reference schema, so each shape keeps its own error messages.
  .transform((items, ctx) =>
    items.flatMap((item, index): EvalReviewSystem[] => {
      const roster = !!item && typeof item === "object" && "roster" in item;
      const parsed = (roster ? RosterReferenceSchema : EvalSystemSchema).safeParse(item);
      if (parsed.success) return [parsed.data];
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: [index, ...issue.path] });
      return [];
    }),
  )
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
      if ("roster" in system) continue;
      for (const [finder, { target }] of system.finders.entries())
        if (target === undefined)
          ctx.addIssue({
            code: "custom",
            path: [index, "finders", finder, "target"],
            message: `review system ${JSON.stringify(system.name)} needs an explicit finder target; routed finders are not allowed in evals`,
          });
      if (system.verifier && system.verifier.target === undefined && !system.verifier.targets)
        ctx.addIssue({
          code: "custom",
          path: [index, "verifier", "target"],
          message: `review system ${JSON.stringify(system.name)} needs an explicit verifier target; routed verifiers are not allowed in evals`,
        });
    }
  });

/** The panel a roster reference stands for, with the finders pinned as it lists them. */
export function expandRoster(
  system: EvalReviewSystem,
  rosters: Record<ResolvedProfile, ReviewFinder[]>,
): ReviewSystem {
  if (!("roster" in system)) return system;
  const finders = panelFinders(rosters[system.roster], system.lenses ?? []);
  if (system.targets.length !== finders.length)
    throw new Error(
      `review system ${JSON.stringify(system.name)}: roster ${system.roster} has ${finders.length} finders with its lenses; give ${finders.length} targets, not ${system.targets.length}`,
    );
  return EvalSystemSchema.parse({
    replayFrom: system.replayFrom,
    name: system.name,
    mode: "panel",
    finders: finders.map((finder, i) => ({ ...finder, target: system.targets[i] })),
    verifier: system.verifier,
    implementerReport: system.implementerReport,
  });
}

function panelFinders(roster: ReviewFinder[], lenses: ReviewLens[]): ReviewFinder[] {
  return [
    ...roster,
    ...lenses.map(({ name, focus }) => ({ prompt: "standard" as const, lens: { name, focus } })),
  ];
}

/** Parses a `--systems` file: `{ "systems": [ReviewSystem or roster reference, ...] }`. */
export function parseEvalReviewSystems(text: string, source: string): EvalReviewSystem[] {
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

/**
 * Checked at startup, so a mistyped pin fails loudly instead of routing by policy: roster targets
 * must be catalog models the review role can run, and a local finder's must be free. Single mode
 * uses no roster, so there a problem (e.g. a pinned model a later release dropped) only warns.
 */
export function checkRosterTargets(
  cfg: Pick<Config, "reviewMode" | "reviewRosters" | "reviewShadow">,
  models: ModelDef[],
  providers: ProviderDef[],
  warn: (message: string) => void,
): void {
  const rosters = cfg.reviewRosters;
  const problems = Object.entries(rosters).flatMap(([profile, finders]) =>
    finders.flatMap(({ target, local }, i) => {
      if (target === undefined) return [];
      try {
        const resolved = resolveTarget(target, (id) => models.find((m) => m.id === id));
        const provider = providers.find((p) => p.id === resolved.model.provider);
        const problem =
          transportError("review", resolved, provider) ??
          (local && provider?.billing !== "free" ? "a local finder needs a free model" : null);
        return problem ? [`review.rosters.${profile}[${i}].target ${target}: ${problem}`] : [];
      } catch (error) {
        return [`review.rosters.${profile}[${i}].target ${target}: ${(error as Error).message}`];
      }
    }),
  );
  if (!problems.length) return;
  const message = `Invalid review rosters: ${problems.join("; ")}`;
  if (cfg.reviewMode === "panel" || cfg.reviewShadow === "panel") throw new Error(message);
  warn(`${message} (ignored: [review] mode is single)`);
}

/** `[review.rosters]` from config.toml; a profile it leaves out keeps its default roster. */
export function parseReviewRosters(raw: unknown): Record<ResolvedProfile, ReviewFinder[]> {
  const parsed = RostersSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`review.rosters: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

const REPO_LENS_KEYS = ["name", "focus", "profiles"];
const RepoReviewSchema = z.object({
  lenses: z
    .array(
      z.object({
        ...lensShape,
        profiles: z
          .array(z.enum(["quick", "standard", "deep"]))
          .min(1)
          .default(["deep"]),
      }) satisfies z.ZodType<RepoReviewLens>,
    )
    .refine(
      (lenses) => new Set(lenses.map((l) => l.name)).size === lenses.length,
      "lens names must be unique",
    )
    .default([]),
});

/**
 * `[review] lenses` from a `.limitless.toml`; callers pass the base commit's, never the change's.
 * Keys this release does not know are ignored with a warning, so a later release's keys never fail a run.
 */
export function readReviewLenses(contents: string | null, warn: (message: string) => void): RepoReviewLens[] {
  const review = contents === null ? undefined : (Bun.TOML.parse(contents) as { review?: unknown }).review;
  if (review === undefined) return [];
  const parsed = RepoReviewSchema.safeParse(review);
  if (!parsed.success)
    throw new Error(`Invalid [review] in .limitless.toml:\n${z.prettifyError(parsed.error)}`);
  const unknown = (table: unknown, known: string[], at: string) =>
    Object.keys(table as object).flatMap((key) => (known.includes(key) ? [] : [`${at}.${key}`]));
  const lenses = (review as { lenses?: unknown[] }).lenses ?? [];
  const ignored = [
    ...unknown(review, ["lenses"], "review"),
    ...lenses.flatMap((lens, i) => unknown(lens, REPO_LENS_KEYS, `review.lenses[${i}]`)),
  ];
  if (ignored.length) warn(`Ignoring unknown .limitless.toml keys: ${ignored.join(", ")}`);
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
    finders: panelFinders(
      cfg.reviewRosters[profile],
      lenses.filter((lens) => lens.profiles.includes(profile)),
    ),
    verifier: {},
    implementerReport: cfg.reviewImplementerReport,
  });
}
