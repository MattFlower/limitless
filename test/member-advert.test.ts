import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { bindClaim, claimScope } from "../src/integrations/claim-guard.ts";
import { decodeControlManifest, encodeControlManifest } from "../src/integrations/control-record.ts";
import {
  ADVERT_EXPIRE_MS,
  ADVERT_REFRESH_MS,
  createMemberAdvertiser,
} from "../src/integrations/member-advert.ts";
import type { Capabilities, CapabilityMonitor, Observed } from "../src/integrations/member-capabilities.ts";
import { checkParity } from "../src/integrations/member-policy.ts";
import type { ClockSample } from "../src/util/claim-clock.ts";
import { decrypt, fixture, refName } from "./member-support.ts";
import { deferred, graphqlUrl, isCas, isRead, json, writes } from "./shared-store-fake.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  mock.restore();
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const member = `m-${"a".repeat(16)}`;
function advertFixture() {
  const f = fixture();
  let now: ClockSample = { inclusive: 1_000, exclusive: 1_000 };
  const clock = { sample: () => ({ ...now }) };
  const data: Capabilities = {
    protocol: 1,
    release: null,
    checkpoints: [1, 2],
    os: "linux",
    arch: "x64",
    confinement: {
      backend: "bwrap-landlock",
      verified: true,
      codex: { edit: true, read: true, confinedRead: true },
    },
    agents: { claude: { version: "1.0.0", loggedIn: true }, codex: { version: "1.0.0", loggedIn: true } },
    privateStrings: { parity: "match", policy: null },
    freeSlots: 1,
    power: "ac",
    draining: false,
  };
  const snapshot = (): Observed<Capabilities> => ({ at: clock.sample(), value: data });
  const monitor: CapabilityMonitor = {
    current: () => snapshot(),
    refresh: async () => snapshot(),
    access: async () => ({ at: clock.sample(), value: true }),
    start: () => () => {},
  };
  let fire = () => {};
  const timer = {
    set: mock((callback: () => void, _ms: number) => {
      fire = callback;
      return 1;
    }),
    clear: mock((_id: unknown) => {}),
  };
  const advertiser = createMemberAdvertiser({
    ...f,
    member,
    monitor,
    clock,
    timer: { set: timer.set as unknown as typeof setInterval, clear: timer.clear },
  });
  const key = f.namer.derive("member", [member]);
  const current = () => decodeControlManifest(f.namer, key, decrypt(f.remote, key));
  const plant = async (version: number, mutations: unknown[] = []) => {
    const bytes = encodeControlManifest(f.namer, {
      schema: 1,
      key,
      version,
      mutations,
      value: { kind: "member", member, data },
    });
    const result = await f.refs.write(key, f.remote.refs.get(refName(key)) ?? null, bytes);
    if (result.kind !== "applied") throw new Error("Plant failed");
    return result.tip;
  };
  return {
    ...f,
    advertiser,
    timer,
    monitor,
    clock,
    data,
    advertKey: key,
    current,
    plant,
    time: (inclusive: number, exclusive = inclusive) => {
      now = { inclusive, exclusive };
    },
    start: () => {
      const stop = advertiser.start();
      stops.push(stop);
      return stop;
    },
    tick: async () => {
      fire();
      await flush();
    },
  };
}

test("advert drops a full ledger and writes strict, complete observations every 60 seconds", async () => {
  const f = advertFixture();
  const mutations = Array.from({ length: 1024 }, (_, i) => ({
    id: i.toString(16).padStart(32, "0"),
    actor: { kind: "member", id: member },
    commandDigest: "e".repeat(64),
  }));
  await f.plant(1024, mutations);
  f.start();
  await flush();
  expect(f.timer.set.mock.calls[0]?.[1]).toBe(60_000);
  expect(ADVERT_REFRESH_MS).toBe(60_000);
  expect(ADVERT_EXPIRE_MS).toBe(180_000);
  for (let i = 0; i < 4; i++) {
    if (i > 0) {
      f.time(1_000 + i * 60_000);
      f.data.freeSlots++;
      await f.tick();
    }
    expect(f.current()).toMatchObject({ version: 1025 + i, mutations: [] });
    expect(f.current().value).toEqual({ kind: "member", member, data: f.data });
  }
});

test("an extra capability key fails before any companion call", async () => {
  const f = advertFixture();
  const error = spyOn(console, "error").mockImplementation(() => {});
  Object.assign(f.data, { extra: true });
  f.start();
  await flush();
  expect(f.remote.calls).toHaveLength(0);
  expect(error).toHaveBeenCalledWith("Member advert refresh failed");
});

test("moved adopts the exact observed tip and version without refreshing the anchor", async () => {
  const f = advertFixture();
  f.start();
  await flush();
  const moved = await f.plant(40);
  f.time(101_000);
  f.remote.calls = [];
  await f.tick();
  expect(f.remote.calls.filter(isCas)).toHaveLength(0);
  expect(f.advertiser.fresh({ inclusive: 181_000, exclusive: 181_000 })).toBe(false);
  await f.tick();
  expect(f.remote.calls.filter(isCas)[0]?.body.variables?.u?.[0]?.beforeOid).toBe(moved.sha);
  expect(f.current().version).toBe(41);
});

test("unconfirmed keeps the anchor, reads in full next tick, and sends a new observation", async () => {
  const f = advertFixture();
  f.start();
  await flush();
  f.time(61_000);
  let dropped = false;
  f.remote.hook = async (call, next) => {
    if (isCas(call)) {
      await next();
      dropped = true;
      return json({}, 503);
    }
    if (dropped) return json({}, 503);
    return next();
  };
  await f.tick();
  expect(f.advertiser.fresh({ inclusive: 181_000, exclusive: 181_000 })).toBe(false);
  const uncertain = f.current();
  f.remote.hook = undefined;
  f.remote.calls = [];
  f.data.freeSlots = 0;
  await f.tick();
  for (const path of ["commits", "trees", "blobs"])
    expect(f.remote.calls.filter(isRead(`git/${path}/`))).toHaveLength(1);
  expect(f.remote.calls.filter(isCas)).toHaveLength(1);
  expect(f.current().version).toBe(uncertain.version + 1);
  expect(f.current().value).toEqual({ kind: "member", member, data: f.data });
});

test("undecodable member tips go stale with a fixed diagnostic and no repair", async () => {
  const f = advertFixture();
  const error = spyOn(console, "error").mockImplementation(() => {});
  f.start();
  await flush();
  await f.refs.write(f.advertKey, f.remote.refs.get(refName(f.advertKey)) ?? null, Buffer.from("{"));
  await f.tick(); // adopts the moved tip
  f.remote.calls = [];
  f.time(181_000);
  await f.tick();
  await f.tick();
  expect(writes(f.remote.calls)).toHaveLength(0);
  expect(f.advertiser.fresh(f.clock.sample())).toBe(false);
  expect(error).toHaveBeenCalledWith("Cannot decode own member advert");
});

test("freshness uses the pre-write anchor, strict 180 s boundary, and suspend-inclusive clock", async () => {
  const f = advertFixture();
  expect(f.advertiser.fresh(f.clock.sample())).toBe(false);
  f.remote.hook = async (call, next) => {
    if (isCas(call)) f.time(21_000);
    return next();
  };
  f.start();
  await flush();
  expect(f.advertiser.fresh({ inclusive: 180_999, exclusive: 180_999 })).toBe(true);
  expect(f.advertiser.fresh({ inclusive: 181_000, exclusive: 181_000 })).toBe(false);
  expect(f.advertiser.fresh({ inclusive: 23_000, exclusive: 21_000 })).toBe(false);
});

test("loop skips overlapping refreshes, aborts on stop, and cannot write afterwards", async () => {
  const f = advertFixture();
  const pending = deferred<Observed<Capabilities>>();
  let signal: AbortSignal | undefined;
  f.monitor.current = () => null;
  f.monitor.refresh = mock(async (input) => {
    signal = input;
    return pending.promise;
  });
  const stop = f.start();
  await f.tick();
  await f.tick();
  expect(f.monitor.refresh).toHaveBeenCalledTimes(1);
  stop();
  expect(signal?.aborted).toBe(true);
  expect(f.timer.clear).toHaveBeenCalledTimes(1);
  pending.resolve({ at: f.clock.sample(), value: f.data });
  await flush();
  await f.tick();
  expect(writes(f.remote.calls)).toHaveLength(0);
});

test("stop aborts an in-flight upload before CAS", async () => {
  const f = advertFixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  f.remote.hook = async (call, next) => {
    if (call.url.endsWith("git/blobs") && call.method === "POST") {
      entered.resolve();
      await release.promise;
    }
    return next();
  };
  const stop = f.start();
  await entered.promise;
  stop();
  release.resolve();
  await flush();
  await f.tick();
  expect(f.remote.calls.filter(isCas)).toHaveLength(0);
  expect(f.advertiser.fresh(f.clock.sample())).toBe(false);
});

test("ticks leave a lost claim scope", async () => {
  const f = advertFixture();
  const handle = {
    repo: "example/repo",
    ref: "refs/claims/test",
    run: "a".repeat(32),
    member,
    generation: 1,
  };
  const lost = bindClaim({ windowOpen: () => false }, handle, () => false);
  lost.onLost(handle, null);
  claimScope.run([lost], () => f.start());
  await flush();
  expect(f.advertiser.fresh(f.clock.sample())).toBe(true);
  expect(f.current().version).toBe(1);
});

test("a stale awaited monitor observation is not advertised", async () => {
  const f = advertFixture();
  f.monitor.current = () => null;
  f.monitor.refresh = async () => ({ at: { inclusive: 1_000, exclusive: 1_000 }, value: f.data });
  f.time(61_000);
  f.start();
  await flush();
  expect(writes(f.remote.calls)).toHaveLength(0);
});

test("measured member-hour uses fewer than 600 REST calls with real parity and advertiser", async () => {
  const f = advertFixture();
  f.list("apple\npear");
  await f.publish();
  let refreshes = 0;
  f.monitor.refresh = async () => {
    refreshes++;
    f.data.privateStrings.parity = await checkParity(f);
    expect(f.data.privateStrings.parity).toBe("match");
    return { at: f.clock.sample(), value: f.data };
  };
  f.monitor.current = () => null;
  f.remote.calls = [];
  f.start();
  await flush();
  for (let n = 1; n < 120; n++) {
    f.time(1_000 + n * 30_000);
    if (n % 2 === 0) await f.tick();
    else await f.monitor.refresh();
  }
  expect(refreshes).toBe(120);
  expect(f.remote.calls.filter(isCas)).toHaveLength(60);
  const rest = f.remote.calls.filter((call) => call.url !== graphqlUrl).length;
  const graphql = f.remote.calls.length - rest;
  console.log(`Member-hour: REST=${rest}, GraphQL=${graphql}`);
  expect(rest).toBeLessThan(600);
});
