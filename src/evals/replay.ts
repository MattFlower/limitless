import type { ReviewSystem } from "../core/types.ts";
import type { Store } from "../db/store.ts";
import { emptyUsage } from "../harness/types.ts";
import { mergeReports } from "../pipeline/panel-merge.ts";
import { FinderSkipped } from "../pipeline/review.ts";
import { ReviewSchema, StoredReviewSchema } from "../pipeline/schemas.ts";

export function validateReplay(
  store: Store,
  id: string,
  systems: ReviewSystem[],
  vendor: (target: string) => string | undefined,
): void {
  const source = store.getEvalRun(id);
  if (source?.role !== "review") throw new Error(`replay source ${id} is not a review eval`);
  const targetKey = (target: string) => (target.includes("@") ? target : `${target}@default`);
  for (const system of systems) {
    const prior = source.systems?.find((s) => s.name === system.replayFrom);
    if (system.mode !== "panel" || prior?.mode !== "panel")
      throw new Error(`replay source system ${system.replayFrom} must exist and both systems must be panels`);
    if (system.finders.length !== prior.finders.length)
      throw new Error(`replay finder count mismatch for ${system.name}`);
    for (const [i, finder] of system.finders.entries()) {
      const original = prior.finders[i];
      if (
        finder.prompt !== original?.prompt ||
        JSON.stringify(finder.lens) !== JSON.stringify(original?.lens)
      )
        throw new Error(`replay finder ${i} prompt mismatch for ${system.name}`);
      if (original?.target && targetKey(finder.target ?? "") !== targetKey(original.target))
        throw new Error(`replay finder ${i} target mismatch for ${system.name}`);
      for (const trial of store.listEvalTrials(id).filter((t) => t.details.system === prior.name)) {
        const parsed = StoredReviewSchema.safeParse(trial.output);
        const roster = parsed.success ? parsed.data.panel?.finders : undefined;
        const recorded = roster?.[i];
        if (
          roster &&
          (roster.length !== system.finders.length ||
            recorded?.prompt !== finder.prompt ||
            recorded.lens !== finder.lens?.name ||
            (recorded.vendor !== null && recorded.vendor !== vendor(finder.target ?? "")))
        )
          throw new Error(`replay finder ${i} recorded roster/vendor mismatch for ${system.name}`);
      }
    }
  }
}

export function replayFinders(store: Store, id: string, system: ReviewSystem, caseId: string, trial: number) {
  const source = store
    .listEvalTrials(id)
    .find((t) => t.details.system === system.replayFrom && t.caseId === caseId && t.trial === trial);
  if (source?.status !== "ok")
    throw new Error(
      `replay source trial ${caseId} #${trial} ${source ? `is ${source.status}: ${source.details.reason ?? "no reason"}` : "is missing"}`,
    );
  const parsed = StoredReviewSchema.safeParse(source.output);
  const panel = parsed.success ? parsed.data.panel : undefined;
  if (!panel?.finders || panel.finders.length !== system.finders.length)
    throw new Error("replay source trial has missing or invalid panel output/roster");
  // Refutation splits differing duplicates into extra candidates, which are not finder reports.
  for (const c of panel.candidates)
    if (panel.refuted.includes(c.id) && c.duplicates?.some((d) => d.line !== c.line || d.title !== c.title))
      throw new Error("replay source trial contains verifier-split candidates");
  // Parsing the live schema strips panel metadata; duplicates inherit the shared claim fields.
  const outputs = system.finders.map((_, finder) =>
    ReviewSchema.parse({
      verdict: "approve",
      summary: "Finder findings reconstructed from the stored source panel trial.",
      findings: panel.candidates.flatMap((c) => [
        ...(c.finder === finder ? [c] : []),
        ...(c.duplicates ?? []).filter((d) => d.finder === finder).map((d) => ({ ...c, ...d })),
      ]),
    }),
  );
  const rebuilt = mergeReports(
    outputs.flatMap((r, finder) => r.findings.map((f) => ({ ...f, finder }))),
    () => undefined,
  ).map((c, i) => ({ ...c, id: `C${i + 1}` }));
  type Identity = Pick<(typeof panel.candidates)[number], "id" | "file" | "line" | "title" | "raisedBy">;
  const identity = (c: Identity) => [c.id, c.file, c.line, c.title, c.raisedBy];
  if (JSON.stringify(rebuilt.map(identity)) !== JSON.stringify(panel.candidates.map(identity)))
    throw new Error("replay source candidate mismatch on id, file, line, title or raisedBy");
  const digest = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([panel.finders, outputs]))
    .digest("hex");
  return {
    identity: { sourceEval: id, digest },
    invoke(finder: number) {
      const member = panel.finders?.[finder];
      if (member?.skipped) throw new FinderSkipped(member.skipped);
      return {
        vendor: member?.vendor,
        result: {
          status: "ok" as const,
          finalText: "",
          structured: outputs[finder],
          sessionId: null,
          usage: emptyUsage(),
          numTurns: 0,
          costUsd: 0,
          costEquivUsd: 0,
          error: null,
          quota: null,
        },
      };
    },
  };
}
