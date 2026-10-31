import { z } from "zod";
import type { Repo, Run } from "../core/types.ts";
import { RunTransferError } from "./run-transfer-errors.ts";
import * as r from "./run-transfer-rows.ts";

const followUpSchema = z.strictObject({
  ...r.fields("runId ownerId repoSlug prUrl", r.identity),
  kind: r.oneOf("review conflict ci"),
  round: r.ordinal,
  reviewedSha: r.oid,
  deliveredSha: r.oid.nullable(),
  createdAt: r.counter,
  findings: z.array(
    z.strictObject({
      severity: r.oneOf("blocker major minor nit"),
      ...r.fields("title detail", z.string()),
      file: z.string().optional(),
      line: r.ordinal.optional(),
    }),
  ),
  owner: z.unknown(),
});
export type TransferFollowUp = Omit<z.infer<typeof followUpSchema>, "owner"> & {
  readonly owner: r.PortableRun;
};
export interface FollowUpInput {
  owner: Run | null;
  round: (Omit<TransferFollowUp, "owner" | "createdAt"> & { createdAt?: number }) | null;
}
function decodeFollowUp(value: unknown, run: r.PortableRun, repo: Repo): TransferFollowUp | undefined {
  if (value === undefined && run.sourceRef?.kind !== "review-round") return undefined;
  if (!value || typeof value !== "object") throw new RunTransferError("incomplete");
  if (!("owner" in value) || value.owner == null || !("createdAt" in value))
    throw new RunTransferError("incomplete");
  if ("kind" in value && typeof value.kind === "string" && !["review", "conflict", "ci"].includes(value.kind))
    throw new RunTransferError("unsupported");
  const owner = r.decodeTransferRun(value.owner, repo, "incomplete");
  const f = r.parseRecord(followUpSchema, value),
    ref = run.sourceRef;
  if (
    f.runId !== run.id ||
    f.ownerId !== owner.id ||
    owner.id === run.id ||
    f.repoSlug !== repo.slug ||
    f.prUrl !== owner.prUrl ||
    f.prUrl !== run.prUrl ||
    !owner.branch ||
    owner.deliveryBranch !== null ||
    run.baseBranch !== owner.branch ||
    run.deliveryBranch !== owner.branch ||
    f.prUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/[1-9][0-9]*$/)?.[1]?.toLowerCase() !==
      repo.slug.toLowerCase() ||
    ref?.kind !== "review-round" ||
    ref.runId !== owner.id ||
    ref.round !== f.round ||
    ref.prUrl !== f.prUrl ||
    ref.reviewedSha !== f.reviewedSha
  )
    throw new RunTransferError("incomplete");
  return { ...f, owner };
}
const envelopeSchema = z.strictObject({
  ...r.fields("run stages invocations questions", z.unknown()),
  followUp: z.unknown().optional(),
});
export const decodeRunTransfer = r.boundary((value: unknown, repo: Repo) => {
  r.preflight(value);
  const { followUp, ...data } = r.parseRecord(envelopeSchema, value);
  const rows = r.decodeRunTransferRows(data, repo);
  const dependency = decodeFollowUp(followUp, rows.run, repo);
  return dependency === undefined ? rows : { ...rows, followUp: dependency };
});
export const encodeRunTransfer = r.boundary(
  (input: r.TransferRowInput, repo: Repo, dependency?: FollowUpInput) => {
    r.preflight(input, dependency?.owner);
    const rows = r.encodeRunTransferRows(input, repo);
    if (!dependency) return decodeRunTransfer(rows, repo);
    if (!dependency.owner || !dependency.round) throw new RunTransferError("incomplete");
    const owner = r.encodeTransferRun(dependency.owner, repo, "incomplete");
    return decodeRunTransfer({ ...rows, followUp: { ...dependency.round, owner } }, repo);
  },
);
