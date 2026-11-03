import { type ClockSample, type ClockSource, windowOpen } from "../util/claim-clock.ts";
import { claimScope } from "./claim-guard.ts";
import type { ControlNamer } from "./control-identity.ts";
import { decodeControlManifest, encodeControlManifest } from "./control-record.ts";
import type { ControlRefClient, ControlRefTip } from "./control-ref.ts";
import { CAPABILITY_FRESH_MS, type CapabilityMonitor, capabilitiesSchema } from "./member-capabilities.ts";

export const ADVERT_REFRESH_MS = 60_000;
export const ADVERT_EXPIRE_MS = 180_000;
export interface MemberAdvertiser {
  start(): () => void;
  fresh(now: ClockSample): boolean;
}
export function createMemberAdvertiser(deps: {
  refs: ControlRefClient;
  namer: ControlNamer;
  member: string;
  monitor: CapabilityMonitor;
  clock: ClockSource;
  timer?: { set: typeof setInterval; clear: typeof clearInterval };
}): MemberAdvertiser {
  const { refs, namer, member, monitor, clock } = deps;
  const key = namer.derive("member", [member]);
  const own = new AbortController();
  const timer = deps.timer ?? { set: setInterval, clear: clearInterval };
  let lastTip: ControlRefTip | undefined;
  let anchor: ClockSample | null = null;
  let running = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  async function tick() {
    const snapshot = monitor.current(clock.sample()) ?? (await monitor.refresh(own.signal));
    own.signal.throwIfAborted();
    const data = capabilitiesSchema.parse(snapshot.value);
    if (!lastTip) {
      const result = await refs.read(key, own.signal);
      own.signal.throwIfAborted();
      if (result.kind === "unconfirmed") return;
      lastTip = result.kind === "tip" ? result.tip : undefined;
    }
    let previous = 0;
    try {
      if (lastTip) previous = decodeControlManifest(namer, key, lastTip.bytes).version;
    } catch {
      console.error("Cannot decode own member advert");
      return;
    }
    const bytes = encodeControlManifest(namer, {
      schema: 1,
      key,
      version: previous + 1,
      value: { kind: "member", member, data },
      mutations: [],
    });
    own.signal.throwIfAborted();
    const at = clock.sample();
    if (!windowOpen(snapshot.at, at, CAPABILITY_FRESH_MS)) return;
    const result = await refs.write(key, lastTip?.sha ?? null, bytes, own.signal, lastTip);
    if (own.signal.aborted) return;
    if (result.kind === "applied") anchor = at;
    lastTip = result.kind === "unconfirmed" ? undefined : (result.tip ?? undefined);
  }
  const run = () => {
    if (running || own.signal.aborted) return;
    running = true;
    void claimScope
      .exit(tick)
      .catch(() => {
        if (!own.signal.aborted) console.error("Member advert refresh failed");
      })
      .finally(() => {
        running = false;
      });
  };
  return {
    fresh: (now) => windowOpen(anchor, now, ADVERT_EXPIRE_MS),
    start() {
      if (interval === undefined && !own.signal.aborted) {
        run();
        interval = timer.set(run, ADVERT_REFRESH_MS);
      }
      return () => {
        own.abort();
        if (interval !== undefined) timer.clear(interval);
      };
    },
  };
}
