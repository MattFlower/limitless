import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { ProjectionIds } from "../db/portable-projection.ts";
import { sanitizeArtifact } from "../gates/output.ts";
import type { PortableManifest } from "./portable.ts";
import { RunTransferError } from "./run-transfer-errors.ts";
import { encodeTransferJson } from "./run-transfer-json.ts";
import type { RunPayloadV1 } from "./run-transfer-schema.ts";

const n = "(?:0|[1-9][0-9]*)";
const grammar: Record<string, RegExp> = Object.fromEntries(
  Object.entries({
    triage: "triage\\.json",
    spec: "spec\\.md",
    gates: `(?:baseline-gates|gates-${n}|gates-timeout-${n}|gates-rebase-timeout-${n}|gates-rebase-${n})\\.json`,
    report: `(?:implement-${n}\\.md|report-sources\\.json|report\\.md)`,
    diff: "diff\\.patch",
    review: `(?:review-${n}|review-resolution)\\.json`,
    "review-sample": `review-${n}\\.sample-${n}\\.json`,
    "review-shadow": `review-${n}\\.shadow\\.json`,
    verify: `verify-${n}(?:-retry)?\\.json`,
    holdout: "holdout-scenarios\\.json",
    acceptance: "acceptance\\.json",
  }).map(([kind, pattern]) => [kind, new RegExp(`^(?:${pattern})$`)]),
);
const rowSchema = z.strictObject({
  name: z.string(),
  kind: z.string(),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  content: z.string(),
});
export type TransferArtifactRow = z.infer<typeof rowSchema>;
const envelope = rowSchema.extend({
  format: z.literal("limitless-run-artifact"),
  version: z.literal(1),
  runId: z.string(),
});
function role(row: TransferArtifactRow, code: "invalid" | "unsupported") {
  if (!Object.hasOwn(grammar, row.kind) || grammar[row.kind]?.exec(row.name)?.[0] !== row.name)
    throw new RunTransferError(code);
  return row.kind === "holdout" ||
    row.kind === "verify" ||
    row.name === "report.md" ||
    row.name === "report-sources.json"
    ? ("holdout" as const)
    : ("artifact" as const);
}
const jsonText = (value: unknown, original: string) =>
  JSON.stringify(value, null, original.includes("\n") ? 2 : undefined);
function mapSample(row: TransferArtifactRow, ids: ReadonlyMap<number, number>): TransferArtifactRow {
  if (row.kind !== "review-sample") return row;
  const original: unknown = JSON.parse(row.content);
  const sample = z
    .looseObject({ invocationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
    .parse(original);
  const invocationId = ids.get(sample.invocationId);
  if (invocationId === undefined) throw new RunTransferError("invalid");
  return { ...row, content: jsonText({ ...(original as object), invocationId }, row.content) };
}
export function readTransferArtifacts(db: Database, runId: string): TransferArtifactRow[] {
  return db
    .query<TransferArtifactRow, [string]>(
      "SELECT name, kind, created_at AS createdAt, content FROM artifacts WHERE run_id = ? ORDER BY name",
    )
    .all(runId);
}
export function encodeRunArtifacts(
  rows: TransferArtifactRow[],
  runId: string,
  invocations: ReadonlyMap<number, number>,
) {
  return rows.flatMap((row) => {
    if (row.kind === "screenshot") return [];
    const tag = role(row, "unsupported");
    if (row.name === "baseline-gates.json") return [];
    const safe = mapSample(
      { ...rowSchema.parse(row), content: sanitizeArtifact(row.name, row.content) },
      invocations,
    );
    return [
      {
        role: tag,
        bytes: encodeTransferJson({ ...safe, format: "limitless-run-artifact", version: 1, runId }),
      },
    ];
  });
}
export function decodeRunArtifacts(
  m: PortableManifest,
  blobs: ReadonlyMap<string, Uint8Array>,
  p: RunPayloadV1,
): TransferArtifactRow[] {
  if (m.schema !== 3) return [];
  const names = new Set<string>(),
    ids = new Map(p.invocations.map((v) => [v.ordinal, v.ordinal]));
  return m.blobs.artifacts.map((ref) => {
    const bytes = blobs.get(ref.key);
    if (!bytes) throw new RunTransferError("invalid");
    const value = envelope.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const { format: _format, version: _version, runId, ...row } = value;
    if (
      !Buffer.from(bytes).equals(encodeTransferJson(value)) ||
      runId !== m.runId ||
      names.has(row.name) ||
      row.name === "baseline-gates.json" ||
      role(row, "invalid") !== ref.role ||
      sanitizeArtifact(row.name, row.content) !== row.content
    )
      throw new RunTransferError("invalid");
    names.add(row.name);
    mapSample(row, ids);
    return row;
  });
}
export function projectRunArtifacts(
  db: Database,
  runId: string,
  rows: TransferArtifactRow[],
  ids: ProjectionIds,
  verify = false,
): void {
  const expected = rows
    .map((row) => mapSample(row, ids.invocations))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (verify) {
    if (
      !Buffer.from(encodeTransferJson(expected)).equals(encodeTransferJson(readTransferArtifacts(db, runId)))
    )
      throw new RunTransferError("conflict");
    return;
  }
  for (const row of expected)
    db.query("INSERT INTO artifacts (run_id, name, kind, content, created_at) VALUES (?, ?, ?, ?, ?)").run(
      runId,
      row.name,
      row.kind,
      row.content,
      row.createdAt,
    );
}
