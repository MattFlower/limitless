import { ISSUE_CLAIM_STATUSES, type Store } from "../db/store.ts";
import { type ClockSource, LEASE, windowOpen } from "../util/claim-clock.ts";
import type { Anchor, ClaimClient, ClaimRecord, ClaimTip } from "./claim-ref.ts";
import type { GhRunner } from "./github.ts";
import {
  canSend,
  expiredForTakeover,
  type GithubTimeSample,
  githubNow,
  sampleUsable,
} from "./github-time.ts";
import { canonicalRepo, type LeaseRow, reconcileLeaseIntent, recoverLeases } from "./lease-store.ts";

export type LeaseHandle = Readonly<
  Pick<ClaimRecord, "run" | "generation"> & { repo: string; ref: string; member: string }
>;
export type LeaseWant = Pick<ClaimRecord, "kind" | "number" | "run" | "status" | "checkpoint">;
export type AcquireResult =
  | { kind: "held"; handle: LeaseHandle; tip: ClaimTip }
  | { kind: "refused"; reason: "live" | "malformed"; tip?: ClaimTip }
  | { kind: "superseded"; tip: ClaimTip }
  | { kind: "wait"; reason: string };
type Patch = Partial<Pick<ClaimRecord, "status" | "checkpoint">>;
type Hooks = { active(h: LeaseHandle): boolean; onLost(h: LeaseHandle, tip: ClaimTip | null): void };
export interface LeaseManager {
  acquire(
    repo: string,
    ref: string,
    want: LeaseWant,
    opts: { takeover: boolean },
    signal?: AbortSignal,
  ): Promise<AcquireResult>;
  update(h: LeaseHandle, patch: Patch): Promise<"applied" | "wait" | "lost" | "obsolete">;
  release(h: LeaseHandle, patch?: Patch): Promise<"released" | "wait" | "lost" | "obsolete">;
  windowOpen(h: LeaseHandle): boolean;
  start(hooks: Hooks): () => void;
}
export async function createLeaseManager(deps: {
  client: ClaimClient;
  store: Store;
  clock: ClockSource;
  gh: GhRunner;
  member: string;
  timer?: { set: typeof setInterval; clear: typeof clearInterval };
}): Promise<LeaseManager> {
  const { client, store, clock, member, timer = { set: setInterval, clear: clearInterval } } = deps;
  const mutexes = new Map<string, Promise<unknown>>();
  const anchors = new Map<string, { tip: string; anchor: Anchor | null }>();
  const handles = new Map<string, LeaseHandle>();
  const losses = new Map<string, { handle: LeaseHandle; tip: ClaimTip | null; delivered: boolean }>();
  let hooks: Hooks | undefined;
  const key = (repo: string, ref: string) => `${canonicalRepo(repo)}:${ref}`;
  const handle = ({ repo, ref, runId: run, confirmed }: LeaseRow): LeaseHandle =>
    Object.freeze({ repo, ref, run, member, generation: confirmed?.generation ?? 0 });
  function lose(row: LeaseRow | null, tip: ClaimTip | null) {
    if (!row?.confirmed) return;
    const h = handle(row);
    const id = JSON.stringify(h);
    if (losses.has(id)) return;
    store.markLeaseLost(row.repo, row.ref);
    losses.set(id, { handle: h, tip, delivered: !!hooks });
    hooks?.onLost(h, tip);
  }
  const recovering = store.leaseRowsWithIntent();
  const recovery = await recoverLeases({ client, store });
  for (const row of recovering) {
    const after = store.leaseRow(row.repo, row.ref);
    if (recovery.superseded.includes(row.ref) && after?.confirmed?.state === "lost" && !after.intent)
      lose(row, null);
  }
  async function locked<T>(repo: string, ref: string, fn: () => Promise<T>): Promise<T> {
    const k = key(repo, ref);
    const work = (mutexes.get(k) ?? Promise.resolve()).catch(() => {}).then(fn);
    mutexes.set(k, work);
    return work;
  }
  function current(h: LeaseHandle) {
    const row = store.leaseRow(h.repo, h.ref);
    if (row?.confirmed?.state !== "held" || row.runId !== h.run) return false;
    return member === h.member && row.confirmed.generation === h.generation;
  }
  function open(h: LeaseHandle) {
    const a = anchors.get(key(h.repo, h.ref));
    if (!current(h) || a?.tip !== store.leaseRow(h.repo, h.ref)?.confirmed?.tip) return false;
    return windowOpen(a?.anchor ?? null, clock.sample());
  }
  async function reconcile(repo: string, ref: string, signal?: AbortSignal) {
    const row = store.leaseRow(repo, ref);
    const result = await reconcileLeaseIntent({ client, store, signal }, repo, ref);
    if (result === "superseded") lose(row, null);
    if (result === "dropped" && !store.leaseRow(repo, ref)?.confirmed) store.forgetLease(repo, ref);
    return result;
  }
  const wait = { kind: "wait", reason: "Lease not confirmed or time unavailable" } as const;
  const refused = { kind: "refused", reason: "live" } as const;
  async function operate(
    repo: string,
    ref: string,
    want: LeaseWant,
    takeover: boolean,
    options: { h?: LeaseHandle; patch?: Patch; release?: boolean; signal?: AbortSignal } = {},
  ): Promise<AcquireResult | "obsolete" | "lost"> {
    const { h, patch = {}, release = false, signal } = options;
    return locked(repo, ref, async () => {
      if (h && !current(h)) return "obsolete";
      let row = store.leaseRow(repo, ref);
      if (row && row.runId !== want.run && (row.intent || row.confirmed?.state === "held")) return refused;
      const settled = await reconcile(repo, ref, signal);
      if (settled === "pending") return wait;
      if (h && !current(h)) return settled === "superseded" ? "lost" : "obsolete";
      let moved = 0;
      let mine: number | undefined; // our generation a same-holder `moved` tip already carries
      for (let attempt = 0; attempt < 4; attempt++) {
        row = store.leaseRow(repo, ref);
        const read = await client.read(repo, ref, signal);
        if (read.kind === "unconfirmed") return wait;
        const tip = read.kind === "tip" ? read.tip : null;
        if (tip?.record === "malformed") return { kind: "refused", reason: "malformed", tip };
        const r = tip?.record;
        let confirmed = row?.runId === want.run ? row.confirmed : null;
        if (mine) confirmed = { generation: mine, tip: "", state: "held" };
        const owns = (v: ClaimRecord) => v.holder === member && v.run === want.run;
        const own = r && owns(r) && r.generation === confirmed?.generation;
        const supersedes =
          r &&
          confirmed &&
          (r.generation > confirmed.generation || (r.generation === confirmed.generation && !own));
        if (h && !tip) return wait;
        if (supersedes || (h && (!r || !own || r.state !== "held"))) {
          if (confirmed?.generation === row?.confirmed?.generation) lose(row, tip);
          return tip ? { kind: "superseded", tip } : wait;
        }
        if (r && r.run !== want.run && (r.state === "held" || ISSUE_CLAIM_STATUSES.includes(r.status)))
          return { ...refused, tip: tip ?? undefined };
        let same = !!own && r?.state === "held" && confirmed?.state === "held";
        const anchor = anchors.get(key(repo, ref));
        const a = anchor?.tip === tip?.sha ? (anchor?.anchor ?? null) : null;
        let sample: GithubTimeSample | null = null;
        const allowed = (kind: "same-generation" | "takeover", now = clock.sample()) =>
          !tip ||
          r?.state !== "held" ||
          canSend(kind, { anchor: a, sample, committedAt: tip.committedAt }, now);
        if (tip && r?.state === "held") {
          if (own && confirmed?.state === "lost" && !takeover) return { kind: "superseded", tip };
          if (r.run !== want.run || (!same && !takeover)) return { ...refused, tip: tip ?? undefined };
          if (!same || !windowOpen(a, clock.sample())) {
            sample = await githubNow(deps.gh, repo, clock, signal);
            const now = clock.sample();
            if (!sample || !sampleUsable(sample, now)) return wait;
            if (same && !allowed("same-generation", now)) {
              if (confirmed?.generation === row?.confirmed?.generation) lose(row, tip);
              if (!takeover) return { kind: "superseded", tip };
              same = false;
            }
            if (!same && !expiredForTakeover(sample, now, tip.committedAt))
              return own ? wait : { ...refused, tip: tip ?? undefined };
          }
        }
        if (row && row.runId !== want.run) store.forgetLease(repo, ref);
        const record: ClaimRecord =
          same && r
            ? { ...r, ...patch }
            : {
                ...want,
                checkpoint: r?.run === want.run ? r.checkpoint : tip ? undefined : want.checkpoint,
                holder: member,
                generation: (r?.generation ?? 0) + 1,
                state: "held",
              };
        if (release) record.state = "released";
        store.beginLeaseIntent(repo, ref, want.run, {
          op: h ? (release ? "release" : "update") : same ? "renew" : "acquire",
          before: tip?.sha ?? "0".repeat(40),
          record,
          commit: null,
        });
        let aborted = false;
        const result = await client.write(repo, ref, tip, record, {
          signal,
          onCommit: (sha) => store.setLeaseIntentCommit(repo, ref, sha),
          beforeSend: () => {
            aborted = !allowed(same ? "same-generation" : "takeover");
            return !aborted;
          },
        });
        if (result.kind === "unconfirmed") return wait;
        if (result.kind === "applied") {
          const { generation, state } = record;
          store.confirmLease(repo, ref, { generation, tip: result.tip.sha, state });
          anchors.set(key(repo, ref), { tip: result.tip.sha, anchor: result.anchor });
          const held: LeaseHandle = Object.freeze({ repo, ref, run: record.run, member, generation });
          handles.set(key(repo, ref), held);
          return { kind: "held", handle: held, tip: result.tip };
        }
        store.dropLeaseIntent(repo, ref);
        if (!store.leaseRow(repo, ref)?.confirmed) store.forgetLease(repo, ref);
        if (result.kind === "unchanged") {
          if (aborted) continue;
          return wait;
        }
        const next = result.tip.record;
        const ours = next !== "malformed" && owns(next) && next.state === "held";
        mine = ours && next.generation === record.generation ? record.generation : undefined;
        if (mine) continue;
        if (++moved < 2) continue;
        if (row?.confirmed && row.runId === want.run) {
          lose(row, result.tip);
          return { kind: "superseded", tip: result.tip };
        }
        return { ...refused, tip: result.tip };
      }
      return wait;
    });
  }
  async function mutate(h: LeaseHandle, patch: Patch, release = false) {
    const want: LeaseWant = { kind: "run", run: h.run, status: "running" };
    const result = await operate(canonicalRepo(h.repo), h.ref, want, false, { h, patch, release });
    if (typeof result === "string") return result;
    if (result.kind === "superseded") return "lost";
    return result.kind === "held" ? "applied" : "wait";
  }
  const manager: LeaseManager = {
    async acquire(repo, ref, want, opts, signal) {
      const result = await operate(canonicalRepo(repo), ref, want, opts.takeover, { signal });
      return typeof result === "string" ? refused : result;
    },
    update: (h, patch) => mutate(h, patch),
    async release(h, patch = {}) {
      const result = await mutate(h, patch, true);
      return result === "applied" ? "released" : result;
    },
    windowOpen: open,
    start(next) {
      hooks = next;
      for (const loss of losses.values()) {
        if (!loss.delivered) next.onLost(loss.handle, loss.tip);
        loss.delivered = true;
      }
      const id = timer.set(async () => {
        for (const row of store.leaseRowsWithIntent())
          await locked(row.repo, row.ref, () => reconcile(row.repo, row.ref));
        for (const h of handles.values()) if (current(h) && next.active(h)) await manager.update(h, {});
      }, LEASE.renewMs);
      return () => timer.clear(id);
    },
  };
  return manager;
}
