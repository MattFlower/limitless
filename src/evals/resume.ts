import { z } from "zod";
import type { EvalRun } from "../core/types.ts";
import { type AnyCaseFile, type EvalCase, hiddenContents, parseRoleCases } from "./cases.ts";
import { seedContent } from "./prepare.ts";

type HiddenFiles = ReturnType<typeof hiddenContents>;

/** Everything a run reads from its dataset, fixed at submission so a resumed run grades the same version. */
export interface EvalDataset {
  /** The case file's text; also a label content that pinned histories must not contain. */
  raw: string;
  file: AnyCaseFile;
  /** Selected cases, in submission order. */
  cases: EvalCase[];
  /** Review seed patches by case ID. */
  seeds: Map<string, string>;
  /** Implement hidden test files by case ID. */
  hidden: Map<string, HiddenFiles>;
}

export function readDataset(
  raw: string,
  file: AnyCaseFile,
  cases: EvalCase[],
  casePath: string,
): EvalDataset {
  const seeds = new Map<string, string>();
  const hidden = new Map<string, HiddenFiles>();
  for (const item of file.cases) {
    if ("defects" in item) {
      const seed = seedContent(item, casePath);
      if (seed !== undefined) seeds.set(item.id, seed);
    }
    if ("hidden" in item) hidden.set(item.id, hiddenContents(item, casePath));
  }
  return { raw, file, cases, seeds, hidden };
}

const SnapshotSchema = z.strictObject({
  version: z.literal(1),
  raw: z.string(),
  caseIds: z.array(z.string()).min(1),
  seeds: z.record(z.string(), z.string()),
  hidden: z.record(
    z.string(),
    z.array(z.strictObject({ path: z.string(), mode: z.number().int(), content: z.string() })),
  ),
});

export function snapshotDataset(dataset: EvalDataset): z.infer<typeof SnapshotSchema> {
  return {
    version: 1,
    raw: dataset.raw,
    caseIds: dataset.cases.map((item) => item.id),
    seeds: Object.fromEntries(dataset.seeds),
    hidden: Object.fromEntries(
      [...dataset.hidden].map(([id, files]) => [
        id,
        files.map((f) => ({ path: f.path, mode: f.mode, content: f.content.toString("base64") })),
      ]),
    ),
  };
}

/** Rebuilds a submitted run's dataset; throws when the saved copy can't reproduce it. */
export function restoreDataset(role: EvalRun["role"], saved: unknown): EvalDataset {
  const snapshot = SnapshotSchema.parse(saved);
  const file = parseRoleCases(role, snapshot.raw);
  const byId = new Map<string, EvalCase>(file.cases.map((item) => [item.id, item]));
  const cases = snapshot.caseIds.map((id) => {
    const item = byId.get(id);
    if (!item) throw new Error(`saved dataset has no case ${id}`);
    return item;
  });
  return {
    raw: snapshot.raw,
    file,
    cases,
    seeds: new Map(Object.entries(snapshot.seeds)),
    hidden: new Map(
      Object.entries(snapshot.hidden).map(([id, files]) => [
        id,
        files.map((f) => ({ path: f.path, mode: f.mode, content: Buffer.from(f.content, "base64") })),
      ]),
    ),
  };
}
