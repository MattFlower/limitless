import { expect, mock, test } from "bun:test";
import type { GhRunner } from "../src/integrations/github.ts";
import {
  canSend,
  expiredForTakeover,
  type GithubTimeSample,
  githubLowerBound,
  githubNow,
  githubUpperBound,
  renewable,
  sampleUsable,
} from "../src/integrations/github-time.ts";
import type { ClockSample, ClockSource } from "../src/util/claim-clock.ts";

const DATE = "Wed, 28 Oct 2026 12:00:00 GMT";
const T = Date.parse(DATE);
const at = (inclusive: number, exclusive = inclusive): ClockSample => ({ inclusive, exclusive });
const sample = (request = at(0), response = at(2_000)): GithubTimeSample => ({
  githubMs: T,
  request,
  response,
});
const committedAt = (age: number): string => new Date(T - age).toISOString();
const ok = `HTTP/2.0 200 OK\r\nDate: ${DATE}\r\n\r\n{}`;
function sequence(...samples: ClockSample[]): ClockSource {
  return {
    sample() {
      const next = samples.shift();
      if (!next) throw new Error("Unexpected clock read");
      return next;
    },
  };
}

test("samples immediately around each exact GitHub request, before parsing", async () => {
  const order: string[] = [];
  const signal = new AbortController().signal;
  const gh = mock<GhRunner>(async (...args) => {
    order.push("request");
    expect(args).toEqual([["api", "--include", "rate_limit"], signal, undefined, "owner/repo"]);
    return ok;
  });
  let tick = 0;
  const clock = {
    sample() {
      order.push("clock");
      return at(tick++ * 1_000);
    },
  };
  expect(await githubNow(gh, "owner/repo", clock, signal)).toEqual({
    githubMs: T,
    request: at(0),
    response: at(1_000),
  });
  expect(await githubNow(gh, "owner/repo", clock, signal)).toEqual({
    githubMs: T,
    request: at(2_000),
    response: at(3_000),
  });
  expect(order).toEqual(["clock", "request", "clock", "clock", "request", "clock"]);
  expect(gh).toHaveBeenCalledTimes(2);
});

test.each([
  ["CRLF", ok],
  ["LF and mixed case", `HTTP/1.1 201 Created\ndAtE:\t${DATE}\n\nbody`],
  ["status without reason", `HTTP/2 204\nDate: ${DATE}\n\n`],
])("accepts successful header sample: %s", async (_name, output) => {
  expect(await githubNow(async () => output, "owner/repo", sequence(at(0), at(1_000)))).toEqual(
    sample(at(0), at(1_000)),
  );
});

test.each([
  ["5xx", `HTTP/2 503 Unavailable\nDate: ${DATE}\n\n`],
  ["redirect", `HTTP/2 302 Found\nDate: ${DATE}\n\n`],
  ["missing status", `Date: ${DATE}\n\n`],
  ["status outside first line", `X-Header: value\nHTTP/2 200 OK\nDate: ${DATE}\n\n`],
  ["missing date", "HTTP/2 200 OK\nContent-Type: application/json\n\n{}"],
  ["invalid date", "HTTP/2 200 OK\nDate: invalid\n\n"],
  ["date in body only", `HTTP/2 200 OK\n\nDate: ${DATE}`],
  ["success in body only", `HTTP/2 503 Unavailable\n\nHTTP/2 200 OK\nDate: ${DATE}`],
  ["empty output", ""],
  ["absent output", undefined],
])("rejects invalid sample: %s", async (_name, output) => {
  const gh: GhRunner = output === undefined ? async () => {} : async () => output;
  expect(await githubNow(gh, "owner/repo", sequence(at(0), at(1_000)))).toBeNull();
});

test("runner errors return null, while native clock errors propagate", async () => {
  expect(
    await githubNow(
      async () => {
        throw new Error("failed");
      },
      "owner/repo",
      sequence(at(0)),
    ),
  ).toBeNull();
  await expect(githubNow(async () => ok, "owner/repo", sequence())).rejects.toThrow("Unexpected clock read");
  await expect(githubNow(async () => "invalid headers", "owner/repo", sequence(at(0)))).rejects.toThrow(
    "Unexpected clock read",
  );
});

test.each([
  ["request suspend", at(6_000, 1_000)],
  ["slow request", at(31_000)],
])("rejects samples unusable on receipt: %s", async (_name, response) => {
  expect(await githubNow(async () => ok, "owner/repo", sequence(at(0), response))).toBeNull();
});

test.each([
  ["suspend before use", at(2_000), at(7_000, 2_000), false],
  ["round trip over limit", at(31_000), at(31_000), false],
  ["age over limit", at(2_000), at(61_000), false],
  ["within both limits", at(29_000), at(59_000), true],
  ["exact round trip and age limits", at(30_000), at(60_000), true],
  ["exact suspend limit", at(2_000), at(5_000, 4_000), true],
])("sample freshness: %s", (_name, response, now, usable) => {
  expect(sampleUsable(sample(at(0), response), now)).toBe(usable);
});

test("exact round trip and suspend limits can be sampled", async () => {
  expect(await githubNow(async () => ok, "owner/repo", sequence(at(0), at(30_000, 29_000)))).toEqual(
    sample(at(0), at(30_000, 29_000)),
  );
});

test("bounds advance from separate monotonic anchors", () => {
  expect(githubLowerBound(sample(), at(5_000))).toBe(T + 3_000);
  expect(githubUpperBound(sample(), at(5_000))).toBe(T + 6_000);
});

test("takeover uses the lower bound and renewal the upper bound at expiry", () => {
  const s = sample();
  const now = at(5_000);
  expect(expiredForTakeover(s, now, committedAt(596_999))).toBe(false);
  expect(expiredForTakeover(s, now, committedAt(597_000))).toBe(true);
  expect(renewable(s, now, committedAt(593_999))).toBe(true);
  expect(renewable(s, now, committedAt(594_000))).toBe(false);
  expect(expiredForTakeover(s, now, "invalid")).toBe(false);
  expect(renewable(s, now, "invalid")).toBe(false);
});

test.each([-3_600_000, 3_600_000])("wall skew of %i ms cannot affect bounds or decisions", (wallOffset) => {
  const wall = mock((): number => {
    throw new Error("Wall clock must not be read");
  });
  const caller = {
    wall,
    wallOffset,
    decide() {
      const s = sample();
      const now = at(5_000);
      return [
        githubLowerBound(s, now),
        githubUpperBound(s, now),
        expiredForTakeover(s, now, committedAt(597_000)),
        renewable(s, now, committedAt(594_000)),
      ];
    },
  };
  expect(caller.decide()).toEqual([T + 3_000, T + 6_000, true, false]);
  expect(wall).not.toHaveBeenCalled();
});

test("send rechecks expiry crossed without any suspend even while the sample remains usable", () => {
  const s = sample(at(0), at(0));
  const state = { anchor: null, sample: s, committedAt: committedAt(598_000) };
  expect(canSend("same-generation", state, at(0))).toBe(true); // upper-bound age 9:59
  expect(sampleUsable(s, at(2_000))).toBe(true);
  expect(canSend("same-generation", state, at(2_000))).toBe(false);
});

test("send rechecks a window crossing seven minutes, allowing an independent renewable sample", () => {
  const state = { anchor: at(0), sample: null, committedAt: committedAt(590_000) };
  expect(canSend("same-generation", state, at(419_000))).toBe(true);
  expect(canSend("same-generation", state, at(421_000))).toBe(false);
  expect(
    canSend("same-generation", { ...state, sample: sample(at(420_000), at(421_000)) }, at(421_000)),
  ).toBe(true);
});

test("takeover always needs a usable expired sample, regardless of the local window", () => {
  const state = { anchor: at(0), sample: null, committedAt: committedAt(600_000) };
  expect(canSend("same-generation", state, at(0))).toBe(true);
  expect(canSend("takeover", state, at(0))).toBe(false);
  expect(canSend("takeover", { ...state, sample: sample(at(0), at(0)) }, at(0))).toBe(true);
  expect(
    canSend("takeover", { ...state, sample: sample(at(0), at(0)), committedAt: committedAt(599_999) }, at(0)),
  ).toBe(false);
  for (const kind of ["same-generation", "takeover"] as const) {
    expect(canSend(kind, { ...state, anchor: null }, at(0))).toBe(false);
    expect(canSend(kind, { ...state, anchor: null, sample: sample() }, at(61_000))).toBe(false);
  }
});

test("a caller re-samples after suspension before authorizing mutation", async () => {
  const gh = mock<GhRunner>(async () => ok);
  const clock = sequence(
    at(0),
    at(1_000),
    at(6_000, 1_000),
    at(6_000, 1_000),
    at(7_000, 2_000),
    at(7_000, 2_000),
  );
  let s = await githubNow(gh, "owner/repo", clock);
  const now = clock.sample();
  expect(s).not.toBeNull();
  if (!s) throw new Error("Expected initial sample");
  expect(sampleUsable(s, now)).toBe(false);
  expect(canSend("takeover", { anchor: null, sample: s, committedAt: committedAt(600_000) }, now)).toBe(
    false,
  );
  if (!sampleUsable(s, now)) s = await githubNow(gh, "owner/repo", clock);
  expect(
    canSend("takeover", { anchor: null, sample: s, committedAt: committedAt(600_000) }, clock.sample()),
  ).toBe(true);
  expect(gh).toHaveBeenCalledTimes(2);
});
