import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  DEFAULT_EVAL_CONCURRENCY,
  type ResolvedProfile,
  type ReviewFinder,
  type ReviewSystem,
} from "../core/types.ts";
import { DEFAULT_ROSTERS, EvalReviewSystemsSchema, expandRoster } from "../pipeline/review-system.ts";
import { HoldoutSchema, SpecSchema, TriageSchema } from "../pipeline/schemas.ts";
import type { Router } from "../router/router.ts";
import { EFFORT_LEVELS } from "../router/targets.ts";
import { reviewSystemHash } from "./cache.ts";

const nonempty = z.string().trim().min(1);
const repoId = z.string().regex(/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/, "expected owner/name");
const gold = <T extends z.ZodType>(value: T) => z.union([value, z.array(value).min(1), z.null()]);
export const GoldSchema = z.strictObject({
  task_class: gold(TriageSchema.shape.task_class),
  complexity: gold(TriageSchema.shape.complexity),
  risk: gold(TriageSchema.shape.risk),
  ambiguity: gold(TriageSchema.shape.ambiguity),
  needs_questions: gold(z.boolean()),
});
export const CaseFileSchema = z
  .strictObject({
    role: z.literal("triage"),
    version: z.literal(1),
    notes: z.string().optional(),
    repos: z.record(repoId, z.string().regex(/^[a-fA-F0-9]{40}$/, "expected full pinned commit SHA")),
    cases: z
      .array(
        z.strictObject({
          id: nonempty,
          repo: repoId,
          prompt: z.string().refine((s) => s.trim().length > 0, "prompt must not be blank"),
          gold: GoldSchema,
          tags: z.array(nonempty),
          notes: z.string().optional(),
          snapshot: z.boolean().optional(),
        }),
      )
      .min(1),
  })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    for (const [index, item] of file.cases.entries()) {
      if (ids.has(item.id))
        ctx.addIssue({ code: "custom", path: ["cases", index, "id"], message: "duplicate case ID" });
      ids.add(item.id);
      if (!Object.hasOwn(file.repos, item.repo))
        ctx.addIssue({ code: "custom", path: ["cases", index, "repo"], message: "missing repository pin" });
    }
  });
export type CaseFile = z.infer<typeof CaseFileSchema>;
export type TriageCase = CaseFile["cases"][number];
export const DEFAULT_CASE_FILE = fileURLToPath(new URL("../../evals/triage/cases.json", import.meta.url));
export function loadCases(path = DEFAULT_CASE_FILE): CaseFile {
  try {
    return CaseFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`Invalid eval cases ${path}: ${(error as Error).message}`);
  }
}
const pin = z.string().regex(/^[a-fA-F0-9]{40}$/, "expected full pinned commit SHA");
const GateResultSchema = z.strictObject({
  name: nonempty,
  command: z.string(),
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().finite().nonnegative(),
  output: z.string(),
  timedOut: z.boolean().optional(),
});
export const GateComparisonSchema = z.strictObject({
  name: nonempty,
  verdict: z.enum([
    "pass",
    "fixed",
    "regressed",
    "still_failing",
    "new_failure",
    "new_pass",
    "not_run",
    "flaky",
  ]),
  blocking: z.boolean(),
  result: GateResultSchema,
  firstAttempt: GateResultSchema.optional(),
});
/** `snapshot: true` gives the candidate neutral commits of the pinned trees without `evals/`. */
const repositoryCase = { id: nonempty, repo: repoId, base: pin, head: pin, snapshot: z.boolean().optional() };
export const ReviewCaseSchema = z
  .strictObject({
    ...repositoryCase,
    kind: z.enum(["real", "clean", "seeded"]),
    source: z.string(),
    input: z.strictObject({
      prompt: nonempty,
      spec: SpecSchema.nullable(),
      implementerReport: z.string(),
      gates: z.array(GateComparisonSchema),
    }),
    defects: z.array(
      z.strictObject({
        file: nonempty,
        lines: z
          .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
          .refine(([start, end]) => start <= end, "invalid defect range"),
        severity: z.enum(["blocker", "major", "minor", "nit"]),
        category: nonempty,
        summary: nonempty,
        required: z.boolean(),
        foundBy: z.string(),
      }),
    ),
    seedPatch: nonempty
      .refine(
        (path) =>
          !isAbsolute(path) &&
          !path.includes("\\") &&
          !path.split("/").includes("..") &&
          !path.includes("\0"),
        "seed path must stay inside dataset directory",
      )
      .optional(),
  })
  .superRefine((item, ctx) => {
    // Snapshot mode strips the top-level evals/ directory, so the candidate could never see these.
    for (const [index, defect] of item.defects.entries())
      if (item.snapshot && /^(\.\/)*evals(\/|$)/.test(defect.file))
        ctx.addIssue({
          code: "custom",
          path: ["defects", index, "file"],
          message: "snapshot mode removes evals/, so a gold defect cannot lie under it",
        });
  });
export const VerifyCaseSchema = z
  .strictObject({
    ...repositoryCase,
    input: z.strictObject({
      prompt: nonempty,
      spec: SpecSchema,
      gates: z.array(GateComparisonSchema),
      holdout: HoldoutSchema.optional(),
    }),
    gold: z
      .record(nonempty, z.enum(["met", "unmet"]))
      .refine((gold) => Object.keys(gold).length > 0, "empty gold"),
  })
  .superRefine((item, ctx) => {
    const ids = [...item.input.spec.acceptance_criteria, ...(item.input.holdout?.scenarios ?? [])].map(
      (c) => c.id,
    );
    if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["input"], message: "criterion IDs must be nonempty and unique" });
    for (const id of Object.keys(item.gold))
      if (!ids.includes(id))
        ctx.addIssue({ code: "custom", path: ["gold", id], message: "unknown gold criterion ID" });
  });
function envelope<R extends "review" | "verify" | "implement", T extends z.ZodType<{ id: string }>>(
  role: R,
  item: T,
) {
  return z
    .strictObject({
      role: z.literal(role),
      version: z.literal(1),
      notes: z.string().optional(),
      cases: z.array(item).min(1),
    })
    .superRefine((file, ctx) => {
      const ids = new Set<string>();
      for (const [index, item] of file.cases.entries()) {
        if (ids.has(item.id))
          ctx.addIssue({ code: "custom", path: ["cases", index, "id"], message: "duplicate case ID" });
        ids.add(item.id);
      }
    });
}
const safePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !isAbsolute(path) &&
      !/[\\\0:]/.test(path) &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git"),
    "expected safe repository-relative path",
  );
export const ImplementCaseSchema = z.strictObject({
  ...repositoryCase,
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  complexity: z.enum(["trivial", "small", "medium"]),
  prompt: z.string().refine((s) => s.trim().length > 0, "prompt must not be blank"),
  spec: SpecSchema.nullable(),
  hidden: z.strictObject({
    files: z.array(safePath).refine((paths) => new Set(paths).size === paths.length, "duplicate hidden path"),
    command: nonempty,
    timeoutSec: z.number().finite().positive().default(900),
  }),
  source: nonempty,
  tags: z.array(nonempty),
  notes: z.string().optional(),
});
export const ImplementCaseFileSchema = envelope("implement", ImplementCaseSchema);
export type ImplementCase = z.infer<typeof ImplementCaseSchema>;
export function hiddenContents(item: ImplementCase, casePath: string) {
  const root = realpathSync(dirname(casePath));
  return item.hidden.files.map((path) => {
    const source = realpathSync(resolve(root, "hidden", item.id, path));
    const rel = relative(root, source);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel) || !statSync(source).isFile())
      throw new Error(`invalid hidden file: ${path}`);
    return { path, content: readFileSync(source), mode: statSync(source).mode & 0o777 };
  });
}
export const ReviewCaseFileSchema = envelope("review", ReviewCaseSchema);
export const VerifyCaseFileSchema = envelope("verify", VerifyCaseSchema);
export type ReviewCase = z.infer<typeof ReviewCaseSchema>;
export type VerifyCase = z.infer<typeof VerifyCaseSchema>;
export type AnyCaseFile =
  | CaseFile
  | z.infer<typeof ReviewCaseFileSchema>
  | z.infer<typeof VerifyCaseFileSchema>
  | z.infer<typeof ImplementCaseFileSchema>;
export type EvalCase = TriageCase | ReviewCase | VerifyCase | ImplementCase;
export function defaultCasePath(role: "triage" | "review" | "verify" | "implement"): string {
  return fileURLToPath(new URL(`../../evals/${role}/cases.json`, import.meta.url));
}
export function loadRoleCases(
  role: "triage" | "review" | "verify" | "implement",
  path = defaultCasePath(role),
): AnyCaseFile {
  try {
    const schema =
      role === "triage"
        ? CaseFileSchema
        : role === "review"
          ? ReviewCaseFileSchema
          : role === "implement"
            ? ImplementCaseFileSchema
            : VerifyCaseFileSchema;
    const file = schema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (file.role === "implement") for (const item of file.cases) hiddenContents(item, path);
    return file;
  } catch (error) {
    throw new Error(
      `Invalid ${role} eval cases ${path}: ${(error as Error).message}${role === "verify" ? "; curate evals/verify/cases.json before running verify evals" : ""}`,
    );
  }
}
const unique = z
  .array(nonempty)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, "duplicate IDs");
export const EvalRequestSchema = z
  .strictObject({
    role: z.enum(["triage", "review", "verify", "implement"]),
    models: z.array(z.string().min(1)).min(1).optional(),
    systems: EvalReviewSystemsSchema.optional(),
    k: z.number().int().positive().default(1),
    maxUsd: z.number().finite().nonnegative().default(1),
    caseIds: unique.optional(),
    cache: z.boolean().default(true),
    concurrency: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(DEFAULT_EVAL_CONCURRENCY),
    rounds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    strategy: z.enum(["retry", "effort", "switch"]).optional(),
  })
  .refine(
    (r) => r.role === "implement" || (r.rounds === undefined && r.strategy === undefined),
    "rounds and strategy are implement-only options",
  )
  .refine(
    (r) => (r.models === undefined) !== (r.systems === undefined),
    "give exactly one of models or systems",
  )
  .refine((r) => r.systems === undefined || r.role === "review", "systems are a review-only option")
  .transform((r) =>
    r.role === "implement" ? { ...r, rounds: r.rounds ?? 1, strategy: r.strategy ?? "retry" } : r,
  );
export type EvalRequest = z.infer<typeof EvalRequestSchema>;
/** `rosters`: the daemon's configured rosters, which roster references in `systems` expand to. */
export function validateRequest(
  input: unknown,
  file: AnyCaseFile,
  router: Pick<Router, "resolveFor" | "toTarget">,
  rosters: Record<ResolvedProfile, ReviewFinder[]> = DEFAULT_ROSTERS,
) {
  const request = EvalRequestSchema.parse(input);
  const requested = request.systems?.map((system) => expandRoster(system, rosters));
  if (request.role !== file.role) throw new Error("dataset role does not match request");
  // Report every bad reference at once so the operator fixes the whole list in one round trip.
  const problems: string[] = [];
  const resolved: string[] = [];
  const billing = new Map<string, string>();
  const resolve = (id: string): string => {
    try {
      let target = router.resolveFor(request.role, id);
      if (request.strategy === "effort") {
        const levels = EFFORT_LEVELS.filter((level) => target.model.supportedEfforts.includes(level));
        const effort = target.effort ?? levels[0];
        if (!effort || levels.indexOf(effort) === levels.length - 1)
          throw new Error("effort strategy requires a higher supported effort than the starting effort");
        target = router.resolveFor(request.role, { modelId: target.model.id, effort });
      }
      resolved.push(target.targetId);
      billing.set(target.targetId, router.toTarget(target.model).billing);
      return target.targetId;
    } catch (error) {
      problems.push(`${JSON.stringify(id)}: ${(error as Error).message}`);
      return id;
    }
  };
  // Every finder and verifier target is resolved; a system's first finder names its candidate model.
  const resolvedSystems = requested?.map((system) => ({
    ...system,
    finders: system.finders.map((finder) => {
      const target = resolve(finder.target ?? "");
      // As in production, a local finder runs only on a free model.
      if (finder.local && billing.has(target) && billing.get(target) !== "free")
        problems.push(
          `review system ${JSON.stringify(system.name)}: local finder ${target} is not a free model`,
        );
      return { ...finder, target };
    }),
    ...(system.verifier
      ? { verifier: { ...system.verifier, target: resolve(system.verifier.target ?? "") } }
      : {}),
  }));
  for (const id of request.systems ? [] : (request.models ?? [])) resolve(id);
  // As in production, a verifier never reuses a finder's model; a shared vendor is recorded, not refused.
  for (const system of resolvedSystems ?? []) {
    const verifier = system.verifier?.target;
    if (system.finders.some((finder) => finder.target === verifier))
      problems.push(
        `review system ${JSON.stringify(system.name)}: verifier ${verifier} is also one of its finders`,
      );
  }
  const seen = new Set<string>();
  // Systems may share a target (e.g. include vs omit the implementer report); their names differ.
  for (const target of request.systems ? [] : resolved) {
    if (seen.has(target)) problems.push(`duplicate resolved model target ${target}`);
    seen.add(target);
  }
  if (problems.length > 0) throw new Error(`Invalid eval models: ${problems.join("; ")}`);
  // Review candidates are always systems; `--models` means one include-report system per target.
  const systems: ReviewSystem[] | undefined =
    request.role !== "review"
      ? undefined
      : (resolvedSystems ??
        resolved.map((target) => ({
          name: target,
          mode: "single",
          finders: [{ target, prompt: "standard" }],
          implementerReport: "include",
        })));
  // Two names for one configuration would only measure the cache, so reject them after resolution.
  const configs = new Map<string, string>();
  for (const system of request.systems ? (systems ?? []) : []) {
    const hash = reviewSystemHash(system);
    const first = configs.get(hash);
    if (first !== undefined)
      throw new Error(
        `Invalid review systems: ${JSON.stringify(system.name)} has the same configuration as ${JSON.stringify(first)} (names aside)`,
      );
    configs.set(hash, system.name);
  }
  for (const id of request.caseIds ?? [])
    if (!file.cases.some((c) => c.id === id)) throw new Error(`Unknown case ID: ${id}`);
  const cases = file.cases.filter((c) => !request.caseIds || request.caseIds.includes(c.id));
  const models = resolvedSystems?.map((system) => system.finders[0]?.target ?? "") ?? resolved;
  return { request: { ...request, models: [...new Set(models)], systems }, cases };
}
