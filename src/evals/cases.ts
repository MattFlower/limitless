import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { TriageSchema } from "../pipeline/schemas.ts";
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
const unique = z
  .array(nonempty)
  .min(1)
  .refine((ids) => new Set(ids).size === ids.length, "duplicate IDs");
export const EvalRequestSchema = z.strictObject({
  role: z.literal("triage"),
  models: unique,
  k: z.number().int().positive().default(1),
  maxUsd: z.number().finite().nonnegative().default(1),
  caseIds: unique.optional(),
  cache: z.boolean().default(true),
});
export type EvalRequest = z.infer<typeof EvalRequestSchema>;
export function validateRequest(input: unknown, file: CaseFile, router: Pick<Router, "model">) {
  const request = EvalRequestSchema.parse(input);
  for (const id of request.models) if (!router.model(id)) throw new Error(`Unknown model ID: ${id}`);
  for (const id of request.caseIds ?? [])
    if (!file.cases.some((c) => c.id === id)) throw new Error(`Unknown case ID: ${id}`);
  const cases = file.cases.filter((c) => !request.caseIds || request.caseIds.includes(c.id));
  return { request, cases };
}
