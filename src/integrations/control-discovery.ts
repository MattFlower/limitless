import { z } from "zod";
import { rethrowClaimControl } from "./claim-errors.ts";
import { CONTROL_REF_RESPONSE_LIMIT, type ControlKey } from "./control-ref.ts";
import { createCompanionIO, type SharedStoreDeps, SharedStoreError } from "./shared-store.ts";

export type ReceiptCandidatePage = { keys: ControlKey[]; next: string | null };
/**
 * Cursors are directory traversal positions, never input acknowledgements. Listings are
 * not transactional snapshots: callers deduplicate keys and periodically restart without
 * a cursor to discover insertions behind a traversal. Freshly read and authenticate every
 * selected manifest; a candidate grants no execution permission or completed consumption.
 */
export interface ControlDirectory {
  listReceiptCandidates(after?: string, signal?: AbortSignal): Promise<ReceiptCandidatePage>;
}

const prefix = "refs/control/receipt/";
const cursor = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !/[\s\p{Cc}]/u.test(value));
const pageSchema = z.object({
  data: z.object({
    repository: z.object({
      id: z.string().min(1),
      refs: z.object({
        nodes: z
          .array(
            z.object({
              prefix: z.literal(prefix),
              name: z
                .string()
                .length(64)
                .regex(/^[0-9a-f]{64}$/),
            }),
          )
          .max(100),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: cursor.nullable() }),
      }),
    }),
  }),
});
const query = `query($r:ID!,$after:String){
  repository:node(id:$r){... on Repository{id
    refs(refPrefix:"refs/control/receipt/",first:100,after:$after){
      nodes{prefix name} pageInfo{hasNextPage endCursor}
    }
  }}
}`;

export function createControlDirectory(deps: SharedStoreDeps): ControlDirectory {
  const io = createCompanionIO(deps, CONTROL_REF_RESPONSE_LIMIT);
  return {
    async listReceiptCandidates(after, signal) {
      try {
        if (signal?.aborted) throw new SharedStoreError("aborted");
        if (after !== undefined && !cursor.safeParse(after).success) throw new SharedStoreError("invalid");
        const id = await io.repository(signal);
        const raw = await io.call(null, { query, variables: { r: id, after: after ?? null } }, signal);
        if (signal?.aborted) throw new SharedStoreError("aborted");
        const parsed = pageSchema.safeParse(raw);
        if (!parsed.success || parsed.data.data.repository.id !== id)
          throw new SharedStoreError("unavailable");
        const { nodes, pageInfo } = parsed.data.data.repository.refs;
        const { hasNextPage, endCursor } = pageInfo;
        if (hasNextPage && (!nodes.length || !endCursor || endCursor === after))
          throw new SharedStoreError("unavailable");
        return {
          keys: nodes.map(({ name }) => ({ kind: "receipt" as const, id: name })),
          next: hasNextPage ? endCursor : null,
        };
      } catch (error) {
        rethrowClaimControl(error);
        if (signal?.aborted) throw new SharedStoreError("aborted");
        throw error instanceof SharedStoreError ? error : new SharedStoreError("unavailable");
      }
    },
  };
}
