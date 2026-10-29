import {
  type ClockSample,
  type ClockSource,
  LEASE,
  suspendedBetween,
  windowOpen,
} from "../util/claim-clock.ts";
import type { GhRunner } from "./github.ts";

export type GithubTimeSample = { githubMs: number; request: ClockSample; response: ClockSample };

export async function githubNow(
  gh: GhRunner,
  repo: string,
  clock: ClockSource,
  signal?: AbortSignal,
): Promise<GithubTimeSample | null> {
  const request = clock.sample();
  let output = "";
  try {
    output = (await gh(["api", "--include", "rate_limit"], signal, undefined, repo)) ?? "";
  } catch {
    return null;
  }
  const response = clock.sample();
  const headers = output.split(/\r?\n\r?\n/, 1)[0];
  if (!headers || !/^HTTP\/\d+(?:\.\d+)?[ \t]+2\d\d(?:[ \t]|\r?$)/m.test(headers.split(/\r?\n/, 1)[0] ?? ""))
    return null;
  const date = /^date:[ \t]*(.+?)\s*$/im.exec(headers)?.[1];
  const githubMs = date ? Date.parse(date) : Number.NaN;
  const sample = { githubMs, request, response };
  return Number.isFinite(githubMs) && sampleUsable(sample, response) ? sample : null;
}

export function sampleUsable(s: GithubTimeSample, now: ClockSample): boolean {
  return (
    suspendedBetween(s.request, now) <= LEASE.suspendToleranceMs &&
    s.response.inclusive - s.request.inclusive <= LEASE.sampleRoundTripMs &&
    now.inclusive - s.request.inclusive <= LEASE.sampleMaxAgeMs
  );
}

export function githubLowerBound(s: GithubTimeSample, now: ClockSample): number {
  return s.githubMs + now.inclusive - s.response.inclusive;
}

export function githubUpperBound(s: GithubTimeSample, now: ClockSample): number {
  return s.githubMs + 1_000 + now.inclusive - s.request.inclusive;
}

export function expiredForTakeover(s: GithubTimeSample, now: ClockSample, committedAt: string): boolean {
  return githubLowerBound(s, now) - Date.parse(committedAt) >= LEASE.expireMs;
}

export function renewable(s: GithubTimeSample, now: ClockSample, committedAt: string): boolean {
  return githubUpperBound(s, now) - Date.parse(committedAt) < LEASE.expireMs;
}

/** Call with fresh clocks immediately before sending: a prior decision or usable sample is insufficient. */
export function canSend(
  kind: "same-generation" | "takeover",
  a: { anchor: ClockSample | null; sample: GithubTimeSample | null; committedAt: string },
  now: ClockSample,
): boolean {
  if (kind === "same-generation" && windowOpen(a.anchor, now)) return true;
  return (
    a.sample !== null &&
    sampleUsable(a.sample, now) &&
    (kind === "takeover"
      ? expiredForTakeover(a.sample, now, a.committedAt)
      : renewable(a.sample, now, a.committedAt))
  );
}
