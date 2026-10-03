import { expect, test } from "bun:test";
import { Store } from "../src/db/store.ts";
import { Passkeys } from "../src/server/passkeys.ts";
import { fakeAuthenticator } from "./webauthn-fake.ts";

const origin = "https://limitless.example.test";
const tokenOf = (link: string) => new URL(link).hash.slice(1);

function setup() {
  const clock = { now: 1_700_000_000_000 };
  const store = new Store(":memory:");
  return { clock, store, passkeys: new Passkeys(store, { publicOrigins: [origin] }, () => clock.now) };
}

test("an enrollment link registers a passkey for the public origin once, within ten minutes", async () => {
  const { clock, store, passkeys } = setup();
  const link = passkeys.enrollLink();
  expect(link).toStartWith(`${origin}/enroll#`);
  const token = tokenOf(link);
  await expect(passkeys.registrationOptions("forged")).rejects.toThrow("enrollment link invalid or expired");
  const options = await passkeys.registrationOptions(token);
  expect(options.rp.id).toBe("limitless.example.test");
  const elsewhere = fakeAuthenticator("https://evil.example");
  await expect(passkeys.register(token, elsewhere.create(options), "Phone/1")).rejects.toThrow("origin");
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

test("a registered passkey signs in once per fresh challenge, with user verification", async () => {
  const { clock, store, passkeys } = setup();
  const token = tokenOf(passkeys.enrollLink());
  const key = fakeAuthenticator(origin);
  await passkeys.register(token, key.create(await passkeys.registrationOptions(token)), "Phone/1");
  const assertion = key.get(await passkeys.authenticationOptions());
  clock.now += 1000;
  expect(await passkeys.authenticate(assertion)).toBe(true);
  expect(store.listPasskeys()[0]?.lastUsedAt).toBe(clock.now);
  await expect(passkeys.authenticate(assertion)).rejects.toThrow("challenge");
  await expect(passkeys.authenticate(key.get({ challenge: "bm90LWlzc3VlZA" }))).rejects.toThrow("challenge");
  const stale = await passkeys.authenticationOptions();
  clock.now += 5 * 60_000;
  await expect(passkeys.authenticate(key.get(stale))).rejects.toThrow("challenge");
  await expect(passkeys.authenticate(key.get(await passkeys.authenticationOptions(), 0x01))).rejects.toThrow(
    "verified",
  );
  const stranger = fakeAuthenticator(origin, 100);
  expect(await passkeys.authenticate(stranger.get(await passkeys.authenticationOptions()))).toBe(false);
  const forged = { ...stranger.get(await passkeys.authenticationOptions()), id: key.id, rawId: key.id };
  expect(await passkeys.authenticate(forged)).toBe(false);
  store.removePasskey(key.id);
  expect(await passkeys.authenticate(key.get(await passkeys.authenticationOptions()))).toBe(false);
});
