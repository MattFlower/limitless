import type { SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import type { Store } from "../db/store.ts";
import * as d from "./defect-publication.ts";
import type { GitHubIdentity } from "./github-identity.ts";

type Kind = "issue" | "comment";
type Page = { state: "all"; page: number; perPage: 100 };
type Post = { title?: string; body: string; labels?: ["defect"] };
/** App-token client. Without `issue`, `list` returns issues in ascending creation order; comment `number` is its ID. */
export type DefectGitHub = {
  list(repo: string, issue: number | null, page: Page, token: string): Promise<unknown>;
  label(repo: string, name: "defect", token: string): Promise<boolean>;
  post(repo: string, issue: number | null, input: Post, token: string): Promise<unknown>;
};
type Context = { coordinator: () => { enabled: boolean } | undefined; now: () => number; dailyCap?: number };
export type DefectReporterDeps = d.DefectPreparationDeps & Context & { github: DefectGitHub };
type App = Extract<GitHubIdentity, { kind: "app" }>;
type Bindings = SQLQueryBindings[];
type Text = "source_ref" | "source_key" | "destination" | "signature" | "occurrence" | "title" | "body";
type Pending = Record<Text | "app_login" | "state" | "scan", string> &
  Record<"comment_body" | "diagnostic" | "reservation_day", string | null> &
  Record<"target_issue" | "object_id", number | null> & { operation: Kind | null };
export type DefectOutboxRow = { [K in keyof Pending]: Pending[K] | null };
type Binding = { barrier_occurrence: string | null; issue_number: number | null } | null;
const [text, created] = [z.string(), z.iso.datetime({ offset: true })];
const labels = z.array(z.object({ name: text })).optional();
const item = z.looseObject({ number: z.number().int().positive(), createdAt: created, body: text, labels });
const items = z.array(item).max(100);
type Item = z.infer<typeof item>;
type Scan = { matches: [number, string][]; edited: boolean; own?: Item; exact?: boolean; sig?: Binding };
class Deferred extends Error {}
const exhausted = Symbol("defect call budget exhausted");
const swallow = (error: unknown) => {
  if (error !== exhausted) throw error;
};
const FRESH = JSON.stringify({ page: 1, matches: [], edited: false });
const cleared = { title: null, body: null, comment_body: null, diagnostic: null };
const used = "SELECT count(*) AS n FROM defect_outbox WHERE reservation_day=?";
const pending = "SELECT * FROM defect_outbox WHERE body IS NOT NULL AND state IN";
const insert = `INSERT INTO defect_outbox (source_ref,source_key,state,diagnostic,destination,signature,occurrence,
  title,body,app_login) VALUES (?,?,?,?,?,?,?,?,?,?)`;

/**
 * Single-reporter delivery, inactive until D1a.3 supplies the enabled coordinator context. Enable
 * defects on exactly one coordinator: another enabled database can create duplicate issues and
 * spends its own cap; later occurrences converge on the oldest issue. Shared ownership is #902.
 */
export function createDefectReporter(store: Store, deps: DefectReporterDeps) {
  const cap = deps.dailyCap ?? 10;
  if (!Number.isInteger(cap) || cap < 1) throw new Error("Defect daily cap must be a positive integer");
  const { db } = store;
  const gh = deps.github;
  const enabled = () => deps.coordinator()?.enabled === true;
  const run = (sql: string, ...values: Bindings) => db.query(sql).run(...values);
  const get = <T>(sql: string, ...values: Bindings) => db.query<T, Bindings>(sql).get(...values);
  const tx = <T>(task: () => T) => db.transaction(task).immediate();
  const read = (source: string, key: string) =>
    get<DefectOutboxRow>("SELECT * FROM defect_outbox WHERE source_ref=? AND source_key=?", source, key);
  const rows = (states: string) => db.query<Pending, []>(`${pending} (${states}) ORDER BY rowid`).all();
  const where = "WHERE destination=? AND signature=?";
  const binding = (row: Pending) =>
    get<Binding>(`SELECT * FROM defect_signatures ${where}`, row.destination, row.signature);
  const bind = (row: Pending, column: "barrier_occurrence" | "issue_number", value: string | number) =>
    run(`UPDATE defect_signatures SET ${column}=? ${where}`, value, row.destination, row.signature);
  const update = (row: Pending, set: Partial<DefectOutboxRow>) => {
    Object.assign(row, set);
    const keys = Object.keys(set) as (keyof Pending)[];
    const sql = `UPDATE defect_outbox SET ${keys.map((k) => `${k}=?`)} WHERE source_ref=? AND source_key=?`;
    run(sql, ...keys.map((k) => row[k]), row.source_ref, row.source_key);
  };
  /** Await preparation, then call the returned function inside the detector's checkpoint transaction. */
  async function prepareSubmission(key: string, input: d.DefectEvidence) {
    if (!enabled()) return () => undefined;
    const source = input.sourceId;
    let login: string | null = null;
    const identity = async (repo: string) => {
      const app = await deps.identity(repo);
      if (app?.kind === "app") login = app.botLogin;
      return app;
    };
    const result = read(source, key)
      ? undefined
      : await d.prepareDefectPublication(input, { ...deps, identity });
    const p = result?.status === "prepared" ? result : undefined;
    return (consume: () => void = () => {}) =>
      tx(() => {
        if (!enabled()) return undefined;
        if (!read(source, key)) {
          const safe = p && d.guardDefectPublication(p, deps).status === "safe";
          const state = safe ? "prepared" : result?.status === "no-report" ? "no-report" : "blocked";
          const payload = safe ? [p.destination, p.signature, p.occurrence, p.title, p.body, login] : [];
          const diagnostic = state === "blocked" ? "Defect publication blocked" : null;
          const values = Array.from({ length: 6 }, (_, i) => payload[i] ?? null);
          run(insert, source, key, state, diagnostic, ...values);
          if (safe)
            run(
              "INSERT OR IGNORE INTO defect_signatures (destination,signature) VALUES (?,?)",
              ...payload.slice(0, 2),
            );
        }
        consume();
        return read(source, key);
      });
  }
  let left = 0;
  const call = <T>(request: () => Promise<T>, reserve = 0) => {
    if (!enabled() || left <= reserve) throw exhausted;
    left--;
    return request();
  };
  const app = async (row: Pending) => {
    const id = await deps.identity(row.destination).catch(() => undefined);
    if (id?.kind === "app" && id.botLogin === row.app_login) return id;
    throw new Deferred("Defect App identity unavailable");
  };
  const guarded = (row: Pending, task: () => Promise<unknown>) =>
    task().catch((error) => {
      if (error === exhausted || !enabled()) throw exhausted;
      update(row, { diagnostic: error instanceof Deferred ? error.message : "Defect delivery check failed" });
    });
  /** Authenticates one object against the saved author, envelope, provenance and approved bytes. */
  const inspect = (row: Pending, raw: Item, kind: Kind, id: App) => {
    const status = d.defectRecordStatus(raw, id, row.signature, kind);
    const own = status !== "ignored" && d.parseDefectEnvelope(raw.body, kind)?.occurrence === row.occurrence;
    const approved = kind === "issue" ? row.body : row.comment_body;
    return { status, own, exact: own && status === "match" && raw.body === approved };
  };
  const accept = (row: Pending, raw: Item, kind: Kind) => {
    const labelled = kind === "comment" || !!raw.labels?.some((label) => label.name === "defect");
    const diagnostic = labelled ? null : "Defect issue lacks label";
    update(row, { object_id: raw.number, state: labelled ? "delivered" : "held", diagnostic });
    if (kind === "issue") bind(row, "issue_number", raw.number);
  };
  /** Complete, resumable enumeration; progress is saved only after full pages, so the last page is re-read. */
  async function scan(row: Pending, kind: Kind, id: App, reserve = 0): Promise<Scan> {
    let { page, matches, edited }: Scan & { page: number } = JSON.parse(row.scan);
    for (; ; page++) {
      const options = { state: "all", page, perPage: 100 } as const;
      const issue = kind === "issue" ? null : row.target_issue;
      const list = () => gh.list(row.destination, issue, options, id.token);
      const values = items.parse(await call(list, reserve));
      for (const raw of values) {
        const found = inspect(row, raw, kind, id);
        if (found.status === "ignored" || "pull_request" in raw) continue;
        if (found.own) return { matches, edited, own: raw, exact: found.exact };
        if (found.status === "blocked") edited = true;
        else matches.push([raw.number, raw.createdAt]);
      }
      if (values.length < 100) return { matches, edited, sig: binding(row) };
      update(row, { scan: JSON.stringify({ page: page + 1, matches, edited }) });
    }
  }
  /** Never reposts: binds the exact object, holds a conflicting one, or leaves the send uncertain. */
  async function recover(row: Pending) {
    const kind = row.operation ?? "issue";
    const found = await scan(row, kind, await app(row));
    update(row, { scan: FRESH });
    if (found.own && found.exact) accept(row, found.own, kind);
    else if (found.own) update(row, { state: "held", diagnostic: "Defect object conflicts with outbox" });
    else update(row, { state: "uncertain", diagnostic: "Defect delivery outcome unknown" });
  }
  async function deliver(row: Pending, found: Scan) {
    const target = found.matches.sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]) || a[0] - b[0])[0]?.[0];
    const bound = found.sig?.issue_number;
    const lost = bound && !found.matches.some(([n]) => n === bound);
    if (found.edited || found.own || lost || (!target && found.sig?.barrier_occurrence))
      return update(row, { state: "held", diagnostic: "Defect issue provenance unavailable" });
    const kind: Kind = target ? "comment" : "issue";
    const { token } = await app(row);
    if (!target && !(await call(() => gh.label(row.destination, "defect", token), 1).catch(() => false)))
      throw new Deferred("Defect label missing");
    const src = deps.repos.find((repo) => repo.id === row.source_ref) ?? row.source_ref;
    const [id, ...pols] = await Promise.all([app(row), deps.policy(src), deps.policy(row.destination)]);
    // Final synchronous checks: nothing below awaits before the request is dispatched.
    if (pols.some((p) => p?.discreet === true)) return update(row, { state: "suppressed", ...cleared });
    if (pols.some((p) => p?.discreet !== false)) throw new Deferred("Defect policy unavailable");
    const body = target ? row.body.replace(":v1:issue:", ":v1:comment:") : row.body;
    if (d.guardDefectPublication({ title: row.title, body }, deps).status !== "safe")
      return update(row, { state: "blocked", diagnostic: "Defect publication blocked" });
    const day = new Date(deps.now()).toISOString().slice(0, 10);
    const ready = tx(() => {
      // An earlier lookup never overrides a creation barrier or binding established since it completed.
      const stale = JSON.stringify(binding(row)) !== JSON.stringify(found.sig);
      if (stale || read(row.source_ref, row.source_key)?.state !== row.state) return false;
      if (!enabled() || left < 1) throw exhausted;
      const full = (get<{ n: number }>(used, day)?.n ?? cap) >= cap;
      if (!target && full) throw new Deferred("Defect daily cap reached");
      bind(row, target ? "issue_number" : "barrier_occurrence", target ?? row.occurrence);
      update(row, { operation: kind, target_issue: target ?? null, comment_body: target ? body : null });
      const reservation_day = target ? null : day;
      update(row, { state: "sending", diagnostic: null, reservation_day, scan: FRESH });
      return true;
    });
    if (!ready) return;
    left--;
    const input: Post = target ? { body } : { title: row.title, body, labels: ["defect"] };
    try {
      const parsed = item.safeParse(await gh.post(row.destination, target ?? null, input, id.token));
      if (parsed.success && inspect(row, parsed.data, kind, id).exact) accept(row, parsed.data, kind);
    } catch {
      // Outcome unknown: the row stays `sending`, so recovery decides before any further POST.
    }
  }
  const settle = async () => {
    for (const row of rows("'sending','uncertain'")) await guarded(row, () => recover(row));
    return rows("'sending','uncertain'").length === 0;
  };
  async function pass() {
    left = 32;
    if (!enabled() || !(await settle())) return;
    const scans = new Map<Pending, Scan>();
    const scanAll = async () => {
      for (const row of rows("'prepared','blocked'"))
        await guarded(row, async () => scans.set(row, await scan(row, "issue", await app(row), 2)));
    };
    await scanAll().catch(swallow);
    for (const [row, found] of scans) {
      await guarded(row, () => deliver(row, found));
      if (!(await settle())) return;
    }
  }
  let flight: Promise<void> | undefined;
  const reconcile = () =>
    (flight ??= pass()
      .catch(swallow)
      .finally(() => (flight = undefined)));
  return { prepareSubmission, reconcile, read };
}
