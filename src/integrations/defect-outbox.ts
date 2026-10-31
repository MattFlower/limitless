import type { Store } from "../db/store.ts";
import {
  type DefectEvidence,
  type DefectPreparationDeps,
  guardDefectPublication,
  prepareDefectPublication,
} from "./defect-publication.ts";

export type DefectOutboxRow = {
  source_ref: string;
  source_key: string;
  destination: string | null;
  signature: string | null;
  occurrence: string | null;
  title: string | null;
  body: string | null;
  comment_body: string | null;
  app_login: string | null;
  operation: "issue" | "comment" | null;
  target_issue: number | null;
  object_id: number | null;
  state: "prepared" | "sending" | "delivered" | "uncertain" | "held" | "blocked" | "suppressed" | "no-report";
  diagnostic: string | null;
  reservation_day: string | null;
  scan_page: number;
  scan_matches: string;
  scan_blocked: number;
};
type Deps = DefectPreparationDeps & {
  coordinator: () => { enabled: boolean } | undefined;
};

/**
 * Inactive submission storage; delivery reconciliation is a separate delivery.
 * Enable defects on exactly one coordinator: separate databases permit duplicate
 * issues and independent caps. Preserve this database and the pinned destination
 * through rollback; transferring ownership needs the coordination work in #902.
 */
export function createDefectOutbox(store: Store, deps: Deps) {
  const enabled = () => deps.coordinator()?.enabled === true;
  const read = (source: string, key: string) =>
    store.db
      .query<DefectOutboxRow, [string, string]>(
        "SELECT * FROM defect_outbox WHERE source_ref=? AND source_key=?",
      )
      .get(source, key);

  /** Await preparation first, then call the returned synchronous submission in the checkpoint transaction. */
  async function prepareSubmission(key: string, input: DefectEvidence) {
    if (!enabled()) return () => undefined;
    const source = input.sourceId;
    const previous = read(source, key);
    let discreet = false;
    let appLogin: string | null = null;
    const publication = previous
      ? undefined
      : await prepareDefectPublication(input, {
          ...deps,
          policy: async (repo) => {
            if (!enabled()) return undefined;
            const policy = await deps.policy(repo);
            discreet ||= policy?.discreet === true;
            return policy;
          },
          identity: async (repo) => {
            if (!enabled()) return undefined;
            const app = await deps.identity(repo);
            if (app?.kind === "app") appLogin = app.botLogin;
            return app;
          },
        });
    return (consume: () => void = () => {}) =>
      store.db
        .transaction(() => {
          if (!enabled()) return undefined;
          let row = read(source, key);
          if (!row) {
            const approved =
              publication?.status === "prepared" &&
              guardDefectPublication(publication, deps).status === "safe"
                ? publication
                : undefined;
            const state = approved
              ? "prepared"
              : discreet
                ? "suppressed"
                : publication?.status === "no-report"
                  ? "no-report"
                  : "blocked";
            store.db
              .query(`INSERT INTO defect_outbox
              (source_ref,source_key,destination,signature,occurrence,title,body,app_login,state,diagnostic)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
              .run(
                source,
                key,
                approved?.destination ?? null,
                approved?.signature ?? null,
                approved?.occurrence ?? null,
                approved?.title ?? null,
                approved?.body ?? null,
                approved ? appLogin : null,
                state,
                state === "blocked" ? "Defect publication blocked" : null,
              );
            if (approved)
              store.db
                .query(`INSERT INTO defect_signatures (destination,signature) VALUES (?,?)
                ON CONFLICT (destination,signature) DO NOTHING`)
                .run(approved.destination, approved.signature);
            row = read(source, key);
          }
          consume();
          return row;
        })
        .immediate();
  }
  return { prepareSubmission, read };
}
