import { expect, test } from "bun:test";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Store } from "../src/db/store.ts";
import { Passkeys } from "../src/server/passkeys.ts";
import { fakeAuthenticator } from "./webauthn-fake.ts";

const origin = "https://limitless.example.test";
const FAILED = "passkey registration failed";
const tokenOf = (link: string) => new URL(link).hash.slice(1);

function setup() {
  const clock = { now: 1_700_000_000_000 };
  const store = new Store(":memory:");
  const logs: string[] = [];
  const passkeys = new Passkeys(
    store,
    { publicOrigins: [origin] },
    () => clock.now,
    (reason) => logs.push(reason),
  );
  /** Registers `key` through a fresh enrollment link. */
  const enroll = async (key = fakeAuthenticator(origin)) => {
    const token = tokenOf(passkeys.enrollLink());
    await passkeys.register(token, key.create(await passkeys.registrationOptions(token)), "Phone/1");
    return key;
  };
  /** Asserts a refused sign-in and the logged reason for it. */
  const refused = async (response: AuthenticationResponseJSON, reason: string) => {
    expect(await passkeys.authenticate(response)).toBe(false);
    expect(logs.at(-1)).toContain(reason);
  };
  return { clock, store, logs, passkeys, enroll, refused };
}

test("an enrollment link registers a passkey for the public origin once, within ten minutes", async () => {
  const { clock, store, logs, passkeys } = setup();
  const link = passkeys.enrollLink();
  expect(link).toStartWith(`${origin}/enroll#`);
  const token = tokenOf(link);
  await expect(passkeys.registrationOptions("forged")).rejects.toThrow("enrollment link invalid or expired");
  const options = await passkeys.registrationOptions(token);
  expect(options.rp.id).toBe("limitless.example.test");
  const elsewhere = fakeAuthenticator("https://evil.example");
  await expect(passkeys.register(token, elsewhere.create(options), "Phone/1")).rejects.toThrow(FAILED);
  expect(logs.at(-1)).toContain("origin");
  const key = fakeAuthenticator(origin);
  await passkeys.register(token, key.create(await passkeys.registrationOptions(token)), "Phone/1");
  expect(store.listPasskeys()).toEqual([
    { id: key.id, device: "Phone/1", createdAt: clock.now, lastUsedAt: null },
  ]);
  await expect(passkeys.registrationOptions(token)).rejects.toThrow("enrollment link invalid or expired");
  const late = tokenOf(passkeys.enrollLink());
  clock.now += 10 * 60_000;
  await expect(passkeys.registrationOptions(late)).rejects.toThrow("enrollment link invalid or expired");
  expect(() => new Passkeys(store, { publicOrigins: [] }).enrollLink()).toThrow(
    "passkeys need server.public_origins",
  );
});

test("registration needs user verification and a discoverable credential; only a saved passkey spends the link", async () => {
  const { store, logs, passkeys } = setup();
  const token = tokenOf(passkeys.enrollLink());
  const key = fakeAuthenticator(origin);
  const options = () => passkeys.registrationOptions(token);
  await expect(passkeys.register(token, key.create(await options(), 0x01), "Phone/1")).rejects.toThrow(
    FAILED,
  );
  expect(logs.at(-1)).toContain("verified");
  const nonResident = {
    ...key.create(await options()),
    clientExtensionResults: { credProps: { rk: false } },
  };
  await expect(passkeys.register(token, nonResident, "Phone/1")).rejects.toThrow(FAILED);
  expect(logs.at(-1)).toContain("not discoverable");
  await passkeys.register(token, key.create(await options()), "Phone/1");

  const again = tokenOf(passkeys.enrollLink());
  const retry = () => passkeys.registrationOptions(again);
  await expect(passkeys.register(again, key.create(await retry()), "Phone/1")).rejects.toThrow(FAILED);
  expect(logs.at(-1)).toContain("UNIQUE");
  const other = fakeAuthenticator(origin);
  await passkeys.register(again, other.create(await retry()), "Laptop/1");
  expect(store.listPasskeys().map((p) => p.id)).toEqual([key.id, other.id]);
  const hostile = fakeAuthenticator(origin).create({ challenge: 'x"\u2028\nsecret' });
  await expect(passkeys.register(tokenOf(passkeys.enrollLink()), hostile, "Phone/1")).rejects.toThrow(FAILED);
  // Library messages quote client-chosen values, so only fixed reasons are logged.
  for (const line of logs) expect(line).toMatch(/^registration failed: [\w ()]+$/);
});

test("the link is checked again after verification: racing registrations save one, an expired link none", async () => {
  const { clock, store, passkeys } = setup();
  const token = tokenOf(passkeys.enrollLink());
  const [a, b] = [fakeAuthenticator(origin), fakeAuthenticator(origin)];
  const [first, second] = [
    a.create(await passkeys.registrationOptions(token)),
    b.create(await passkeys.registrationOptions(token)),
  ];
  const settled = await Promise.allSettled([
    passkeys.register(token, first, "A"),
    passkeys.register(token, second, "B"),
  ]);
  expect(settled.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(store.listPasskeys()).toHaveLength(1);

  const late = tokenOf(passkeys.enrollLink());
  clock.now += 10 * 60_000 - 1000;
  const response = fakeAuthenticator(origin).create(await passkeys.registrationOptions(late));
  const pending = passkeys.register(late, response, "C");
  clock.now += 2000;
  await expect(pending).rejects.toThrow(FAILED);
  expect(store.listPasskeys()).toHaveLength(1);
});

test("a registered passkey signs in once per fresh challenge, with user verification", async () => {
  const { clock, store, logs, passkeys, enroll, refused } = setup();
  const key = await enroll();
  const options = await passkeys.authenticationOptions();
  const assertion = key.get(options);
  clock.now += 1000;
  expect(await passkeys.authenticate(assertion)).toBe(true);
  expect(store.listPasskeys()[0]?.lastUsedAt).toBe(clock.now);
  await refused(assertion, "challenge");
  expect(logs.join("\n")).not.toContain(options.challenge);
  await refused(key.get({ challenge: "bm90LWlzc3VlZA" }), "challenge");
  await refused(key.get({ challenge: 'x"\u2028\npasskey: forged' }), "challenge");
  const stale = await passkeys.authenticationOptions();
  clock.now += 5 * 60_000;
  await refused(key.get(stale), "challenge");
  await refused(key.get(await passkeys.authenticationOptions(), 0x01), "verified");
  const stranger = fakeAuthenticator(origin, 100);
  await refused(stranger.get(await passkeys.authenticationOptions()), "unknown credential");
  const forged = { ...stranger.get(await passkeys.authenticationOptions()), id: key.id, rawId: key.id };
  await refused(forged, "not verified");
  store.removePasskey(key.id);
  await refused(key.get(await passkeys.authenticationOptions()), "unknown credential");
  // Library messages quote client-chosen values, so only fixed reasons are logged.
  for (const line of logs.filter((l) => l.startsWith("sign-in")))
    expect(line).toMatch(/^sign-in failed: [\w ()]+$/);
});

test("a sign-in fails if its passkey is removed or overtaken while it verifies; zero counters keep working", async () => {
  const { store, passkeys, enroll } = setup();
  const removed = await enroll();
  const whileRemoved = passkeys.authenticate(removed.get(await passkeys.authenticationOptions()));
  store.removePasskey(removed.id);
  expect(await whileRemoved).toBe(false);

  const key = await enroll();
  const behind = passkeys.authenticate(key.get(await passkeys.authenticationOptions()));
  expect(store.usePasskey(key.id, 3, 0)).toBe(true);
  expect(await behind).toBe(false);
  expect(store.passkey(key.id)?.counter).toBe(3);

  const synced = await enroll(fakeAuthenticator(origin, null));
  for (let i = 0; i < 2; i++)
    expect(await passkeys.authenticate(synced.get(await passkeys.authenticationOptions()))).toBe(true);
});
