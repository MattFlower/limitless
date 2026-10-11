import { z } from "zod";

export const commitSha = z.string().regex(/^[a-fA-F0-9]{40}$/);
export const recordedHeadSchema = z
  .object({ sha: z.unknown(), version: z.number().int(), pushing: z.boolean() })
  .nullable()
  .optional();

/** A poll snapshot is reviewable only when the push/observation epoch agrees with it. */
export function reviewableHead(observed: unknown, recorded: z.output<typeof recordedHeadSchema>) {
  const snapshot = commitSha.safeParse(observed);
  const head = commitSha.safeParse(recorded?.sha);
  if (recorded?.pushing || (snapshot.success && head.success && snapshot.data !== head.data))
    return { headSha: null, problem: "superseded" } as const;
  if (!snapshot.success || !head.success) return { headSha: null, problem: "unavailable" } as const;
  return { headSha: head.data, problem: null } as const;
}
