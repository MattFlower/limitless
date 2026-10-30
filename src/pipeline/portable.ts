import { createHash } from "node:crypto";
import { z } from "zod";
import { isBranchName } from "../core/delivery.ts";
import type { Run } from "../core/types.ts";
import { linkedIssues, type Store } from "../db/store.ts";
import { githubUrlRepo } from "../integrations/github-identity.ts";
import { lifecycleMarker } from "../integrations/issue-lifecycle.ts";
import { deliveryMarker } from "./markers.ts";
import { RunTransferError, rethrowRunTransfer } from "./run-transfer-errors.ts";

const runId = z.string().regex(/^[0-9a-z]{6,40}$/);
const repo = z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const number = counter.positive();
const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i);
const digest = z.string().regex(/^[0-9a-f]{64}$/i);
const branch = z.string().refine(isBranchName);
const claimSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("issue"), repo, number }),
  z.strictObject({ kind: z.literal("pr"), repo, number }),
  z.strictObject({ kind: z.literal("run"), repo, runId }),
]);
export type ClaimKey = z.infer<typeof claimSchema>;

export function claimKey(
  run: Pick<Run, "id" | "repoSlug" | "sourceRef" | "source" | "prompt">,
  store: Store,
): ClaimKey | { none: "several-issues" | "not-github" } {
  const slug = run.repoSlug.toLowerCase();
  const stored =
    store.getRepoBySlug(run.repoSlug) ?? store.listRepos().find((r) => r.slug.toLowerCase() === slug);
  if (stored?.kind !== "github" || !repo.safeParse(slug).success) return { none: "not-github" };
  const round = store.reviewRound(run.id);
  const ref = run.sourceRef;
  if (round || ref?.kind === "review-round" || ref?.kind === "pull_request") {
    const url = round
      ? round.prUrl
      : ref?.kind === "review-round"
        ? ref.prUrl
        : repo.safeParse(ref?.repo).success && number.safeParse(ref?.number).success
          ? `https://github.com/${ref?.repo}/pull/${ref?.number}`
          : null;
    const match =
      typeof url === "string" &&
      /^https:\/\/github\.com\/[^/?#]+\/[^/?#]+\/pull\/([1-9][0-9]*)\/?$/i.exec(url);
    const n = match ? Number(match[1]) : 0;
    return typeof url === "string" &&
      githubUrlRepo(url)?.toLowerCase() === slug &&
      number.safeParse(n).success
      ? { kind: "pr", repo: slug, number: n }
      : { none: "not-github" };
  }
  const issues = linkedIssues(run, store);
  const issue = issues[0];
  return issues.length > 1
    ? { none: "several-issues" }
    : issue
      ? claimSchema.parse({ kind: "issue", repo: issue.repo.toLowerCase(), number: issue.number })
      : claimSchema.parse({ kind: "run", repo: slug, runId: run.id });
}
export function claimRef(key: ClaimKey): string {
  const k = claimSchema.parse(key);
  return `refs/limitless/claims/${k.kind === "run" ? `run-${k.runId}` : k.kind === "pr" ? `pr-${k.number}` : k.number}`;
}
const events = z.enum(["started", "pr", "needs_human", "failed", "cancelled"]);
const families = z.enum(["lifecycle", "review-round", "conflict-round", "ci-round", "verification"]);
export type CommentFamily = z.infer<typeof families>;
const commentSchema = z
  .strictObject({
    kind: z.literal("comment"),
    target: z.enum(["issue", "pr"]),
    number,
    family: families,
    event: events.optional(),
  })
  .refine((i) => (i.family === "lifecycle" ? i.event !== undefined : i.event === undefined));
const intentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("push"), branch, to: sha }),
  z.strictObject({ kind: z.literal("pr-create"), branch, base: branch }),
  z.strictObject({ kind: z.literal("pr-edit"), pr: number, bodyDigest: digest }),
  commentSchema,
  z.strictObject({ kind: z.literal("label"), issue: number, label: z.string(), add: z.boolean() }),
  z.strictObject({ kind: z.literal("merge"), pr: number, sha }),
]);
export type EffectIntent = z.infer<typeof intentSchema>;
const effectSchema = z.strictObject({
  id: z.string().regex(/^fx1-[0-9a-f]{32}$/),
  intent: intentSchema,
  state: z.enum(["pending", "uncertain", "completed"]),
});
export type EffectRecord = z.infer<typeof effectSchema>;
type CommentIntent = EffectIntent & { kind: "comment" };
const deliveryKinds = {
  "review-round": "review",
  "conflict-round": "conflict",
  "ci-round": "ci",
  verification: "verification",
};
export function commentMarkers(id: string, intent: CommentIntent): string[] {
  const i = commentSchema.parse(intent);
  runId.parse(id);
  const family = i.family;
  return family === "lifecycle"
    ? [lifecycleMarker(id, events.parse(i.event))]
    : [false, true].map((discreet) => deliveryMarker(deliveryKinds[family], id, discreet).marker);
}
export function commentMatches(id: string, intent: CommentIntent, body: string): boolean {
  const i = commentSchema.parse(intent);
  runId.parse(id);
  return i.family === "lifecycle"
    ? body.includes(lifecycleMarker(id, events.parse(i.event)))
    : deliveryMarker(deliveryKinds[i.family], id).includes(body);
}
const blobSchema = z.strictObject({ key: z.string().regex(/^[0-9a-f]{32}$/i), digest, size: counter });
export type BlobRef = z.infer<typeof blobSchema>;
const manifestSchema = z.strictObject({
  schema: z.literal(1),
  runId,
  key: claimSchema,
  generation: counter,
  sequence: counter,
  previous: digest.nullable(),
  baseSha: sha.nullable(),
  headSha: sha.nullable(),
  phase: z.enum(["prepare", "triage", "clarify", "spec", "loop", "deliver", "done"]),
  round: counter,
  createdBy: z.string(),
  blobs: z.strictObject({ state: blobSchema, artifacts: z.array(blobSchema), objects: z.array(blobSchema) }),
  effects: z.array(effectSchema),
});
export type ManifestV1 = z.infer<typeof manifestSchema>;
const manifestV2Schema = manifestSchema.extend({
  schema: z.literal(2),
  phase: z.enum(["prepare", "triage", "clarify", "spec", "loop", "deliver", "accept", "done"]),
});
export type ManifestV2 = z.infer<typeof manifestV2Schema>;
export type PortableManifest = ManifestV1 | ManifestV2;
const portableManifestSchema = z.discriminatedUnion("schema", [manifestSchema, manifestV2Schema]);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export function effectId(id: string, intent: EffectIntent): string {
  return `fx1-${hash(canonical({ runId: runId.parse(id), intent: intentSchema.parse(intent) })).slice(0, 32)}`;
}
export function formatManifest(m: PortableManifest): string {
  if (typeof m.schema === "number" && m.schema !== 1 && m.schema !== 2)
    throw new RunTransferError("unsupported");
  if (m.schema === 1) return canonical(manifestSchema.parse(m));
  try {
    return canonical(manifestV2Schema.parse(m));
  } catch (error) {
    rethrowRunTransfer(error, "invalid");
  }
}
export function manifestDigest(m: PortableManifest): string {
  return hash(formatManifest(m));
}
export function parseManifest(text: string): PortableManifest | "malformed" | { unsupported: number } {
  try {
    const value: unknown = JSON.parse(text);
    if (
      value !== null &&
      typeof value === "object" &&
      "schema" in value &&
      typeof value.schema === "number" &&
      value.schema !== 1 &&
      value.schema !== 2
    )
      return { unsupported: value.schema };
    const parsed = portableManifestSchema.safeParse(value);
    if (!parsed.success) return "malformed";
    if (parsed.data.schema === 2 && canonical(parsed.data) !== text) return "malformed";
    return parsed.data;
  } catch {
    return "malformed";
  }
}
