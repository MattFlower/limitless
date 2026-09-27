import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HoldoutSchema, SpecSchema, TriageSchema } from "../pipeline/schemas.ts";
import type { Router } from "../router/router.ts";

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
const repositoryCase = { id: nonempty, repo: repoId, base: pin, head: pin };
export const ReviewCaseSchema = z.strictObject({
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
        !isAbsolute(path) && !path.includes("\\") && !path.split("/").includes("..") && !path.includes("\0"),
      "seed path must stay inside dataset directory",
    )
    .optional(),
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
export const EvalRequestSchema = z.strictObject({
  role: z.enum(["triage", "review", "verify", "implement"]),
  models: z.array(z.string().min(1)).min(1),
  k: z.number().int().positive().default(1),
  maxUsd: z.number().finite().nonnegative().default(1),
  caseIds: unique.optional(),
  cache: z.boolean().default(true),
});
export type EvalRequest = z.infer<typeof EvalRequestSchema>;
export function validateRequest(input: unknown, file: AnyCaseFile, router: Pick<Router, "resolveFor">) {
  const request = EvalRequestSchema.parse(input);
  if (request.role !== file.role) throw new Error("dataset role does not match request");
  // Report every bad reference at once so the operator fixes the whole list in one round trip.
  const problems: string[] = [];
  const resolved: string[] = [];
  for (const id of request.models) {
    try {
      resolved.push(router.resolveFor(request.role, id).targetId);
    } catch (error) {
      problems.push(`${JSON.stringify(id)}: ${(error as Error).message}`);
    }
  }
  const seen = new Set<string>();
  for (const target of resolved) {
    if (seen.has(target)) problems.push(`duplicate resolved model target ${target}`);
    seen.add(target);
  }
  if (problems.length > 0) throw new Error(`Invalid eval models: ${problems.join("; ")}`);
  request.models = resolved;
  for (const id of request.caseIds ?? [])
    if (!file.cases.some((c) => c.id === id)) throw new Error(`Unknown case ID: ${id}`);
  const cases = file.cases.filter((c) => !request.caseIds || request.caseIds.includes(c.id));
  return { request, cases };
}
