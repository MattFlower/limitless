import { expect, test } from "bun:test";
import { privateMatches } from "../src/gates/private.ts";
import { createCredentialRegistry } from "../src/util/credential-matcher.ts";
import {
  capturePrivacySnapshot,
  checkPrepared,
  createPrivacyRegistry,
  currentPrivacyGeneration,
  isCurrentPrivacyGeneration,
  preparePrivacyPolicy,
  privacyLimits,
  privacyRegistry,
} from "../src/util/privacy-boundary.ts";
import { redactCredentials, registerCredential, registeredCredentials } from "../src/util/proc.ts";

const word = ["synthetic", "token"].join("-");
const policy = (values: string[]) => values.map((value, i) => ({ value, entry: i + 1 }));
function snapshot(values: string[] = [], credentials: string[] = []) {
  const registry = createPrivacyRegistry();
  registry.replacePolicy(policy(values));
  for (const value of credentials) registry.addCredential(value);
  return capturePrivacySnapshot(registry);
}
const b64 = (s: string) => Buffer.from(s).toString("base64");
const percent = (s: string) => [...Buffer.from(s)].map((n) => `%${n.toString(16).padStart(2, "0")}`).join("");
const unicode = (s: string) =>
  [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const html = (s: string) => [...s].map((c) => `&#${c.charCodeAt(0)};`).join("");
const match = (credential = false, entries = [1]) => ({ match: { entries, credential } });

test("prepared readings retain intermediates, alignments, normalization and slash alternatives", () => {
  for (const text of [
    word,
    percent(word),
    unicode(word),
    html(word),
    percent(unicode(word)),
    unicode(percent(word)),
    word.toUpperCase(),
    [...word].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join(""),
    ...[0, 1, 2, 3].map((n) => `${"A".repeat(n)}${b64(word).replace(/=+$/, "")}`),
  ])
    expect(checkPrepared(preparePrivacyPolicy(snapshot([word])), text)).toEqual(match());
  for (const [value, text] of [
    ["alpha%41beta", "alpha%41beta"],
    ["alpha beta", "alpha\n   beta"],
    ["alpha\\/beta", "alpha%5c/beta"],
    ["alpha\\/beta", "alpha%5c/b%2565ta"],
    ["alpha/beta", "alpha\\/beta"],
    ["alpha&#98;eta", percent("alpha&#98;eta")],
    ["alpha&#98;eta", unicode("alpha&#98;eta")],
    ["alpha\\u0062eta", percent("alpha\\u0062eta")],
  ])
    expect(checkPrepared(preparePrivacyPolicy(snapshot([value ?? ""])), text ?? "")).toEqual(match());
  const prepared = preparePrivacyPolicy(snapshot([word]));
  expect(checkPrepared(prepared, "ordinary clean field")).toEqual({ clean: true });
  expect(checkPrepared(preparePrivacyPolicy(snapshot([word], [b64(word)])), html(b64(word)))).toEqual(
    match(true),
  );
  expect(checkPrepared(prepared, `prefix ${word.slice(0, 6)}%a`, { truncated: true })).toEqual(match());
  expect(checkPrepared(prepared, `prefix ${word.slice(0, 6)}%a`)).toEqual({ clean: true });
  const wide = "Ａ".repeat(4);
  expect(checkPrepared(preparePrivacyPolicy(snapshot([wide])), b64("A".repeat(4)))).toEqual({ clean: true });
});

test("decoded credentials work without a private policy and keep original-length eligibility", () => {
  for (const secret of [word, "s/ort77"])
    for (const encode of [percent, unicode, html, b64]) {
      const prepared = preparePrivacyPolicy(snapshot([], [secret]));
      expect(checkPrepared(prepared, encode(secret))).toEqual(match(true, []));
      expect(checkPrepared(prepared, encode("ordinary clean field"))).toEqual({ clean: true });
    }
  for (const secret of ["s/ort77", 'q"ort77', "eight888", "long\r\ncredential/tail", "ab\r\ncd\r\nef"]) {
    const prepared = preparePrivacyPolicy(snapshot([], [secret]));
    const lf = secret.replace(/\r\n/g, "\n");
    for (const value of [
      secret,
      lf,
      JSON.stringify(secret).slice(1, -1),
      JSON.stringify(lf).slice(1, -1),
      JSON.stringify(lf).slice(1, -1).replaceAll("/", "\\/"),
    ]) {
      expect(checkPrepared(prepared, value)).toEqual(match(true, []));
      expect(checkPrepared(prepared, b64(value))).toEqual(match(true, []));
      expect(checkPrepared(prepared, `unrelated:${value}:tail`)).toEqual(
        secret.length >= 8 ? match(true, []) : { clean: true },
      );
    }
  }
  expect(checkPrepared(preparePrivacyPolicy(snapshot([], [word])), word.toUpperCase())).toEqual({
    clean: true,
  });
});

test("preparation is reused and generations remain bound to captured snapshots", () => {
  let version = "v1";
  const registry = createPrivacyRegistry(createCredentialRegistry(), () => version);
  registry.replacePolicy(policy([word]));
  const counters = { preparations: 0, normalizations: 0 };
  const old = capturePrivacySnapshot(registry);
  const prepared = preparePrivacyPolicy(old, { counters });
  for (let i = 0; i < 10; i++)
    checkPrepared(prepared, Array.from({ length: 30 }, (_, n) => b64(`ordinary clean field ${n}`)).join(":"));
  expect(counters).toEqual({ preparations: 1, normalizations: 1 });
  expect(isCurrentPrivacyGeneration(prepared, registry)).toBe(true);
  registry.addCredential(word);
  expect(currentPrivacyGeneration(registry)).toEqual({ ...old.generation, credentials: 1 });
  expect(isCurrentPrivacyGeneration(prepared, registry)).toBe(false);
  expect(isCurrentPrivacyGeneration(preparePrivacyPolicy(old), registry)).toBe(false);
  const added = capturePrivacySnapshot(registry);
  registry.addCredential(word);
  expect(currentPrivacyGeneration(registry)).toEqual(added.generation);
  const next = preparePrivacyPolicy(added);
  expect(isCurrentPrivacyGeneration(next, registry)).toBe(true);
  registry.replacePolicy([]);
  expect(currentPrivacyGeneration(registry)).toEqual({
    ...added.generation,
    policy: added.generation.policy + 1,
  });
  expect(isCurrentPrivacyGeneration(next, registry)).toBe(false);
  expect(isCurrentPrivacyGeneration(preparePrivacyPolicy(added), registry)).toBe(false);
  expect(capturePrivacySnapshot(registry).credentials).toEqual([word]);
  const replaced = currentPrivacyGeneration(registry);
  registry.replacePolicy([]);
  expect(currentPrivacyGeneration(registry)).toEqual({ ...replaced, policy: replaced.policy + 1 });
  const latest = preparePrivacyPolicy(capturePrivacySnapshot(registry));
  version = "v2";
  expect(isCurrentPrivacyGeneration(latest, registry)).toBe(false);
  expect(isCurrentPrivacyGeneration(preparePrivacyPolicy(old), createPrivacyRegistry())).toBe(false);
});

test.each([
  ["entries", "entries-count", ["aa", "bb"], [], 2],
  ["credentials", "credentials-count", [], ["aa", "bb"], 2],
  ["originalLength", "original-length", ["abc"], ["def"], 3],
  ["originalsTotal", "originals-total", ["abc"], ["def"], 6],
  ["variantsTotal", "variants-total", ["abc"], ['d"e'], 10],
] as const)(
  "snapshot admission %s accepts equality and refuses wholly",
  (key, code, entries, credentials, cap) => {
    const data = snapshot([...entries], [...credentials]);
    expect(preparePrivacyPolicy(data, { limits: { [key]: cap } })).not.toHaveProperty("refused");
    const refused = preparePrivacyPolicy(data, { limits: { [key]: cap - 1 } });
    expect(JSON.stringify(refused)).toBe(JSON.stringify({ refused: code }));
    expect(checkPrepared(refused, word)).toEqual({ refused: code });
  },
);

test("forms refuse at cap plus one, reject ill-formed inputs and never return partial matches", () => {
  for (const [key, cap, code] of [
    ["formLength", 3, "form-length"],
    ["formsTotal", 18, "forms-total"],
  ] as const) {
    expect(checkPrepared(preparePrivacyPolicy(snapshot(["abc"]), { limits: { [key]: cap } }), "abc")).toEqual(
      match(),
    );
    expect(
      JSON.stringify(
        checkPrepared(preparePrivacyPolicy(snapshot(["abc"]), { limits: { [key]: cap - 1 } }), "abc"),
      ),
    ).toBe(JSON.stringify({ refused: code }));
  }
  const bad = String.fromCharCode(0xd800);
  for (const data of [snapshot([bad]), snapshot([], [bad])])
    expect(preparePrivacyPolicy(data)).toEqual({ refused: "ill-formed" });
  expect(checkPrepared(preparePrivacyPolicy(snapshot()), bad)).toEqual({ refused: "ill-formed" });
  let nested = percent(word);
  for (let i = 0; i < 6; i++) nested = nested.replaceAll("%", "%25");
  for (const entries of [[], [word]])
    expect(checkPrepared(preparePrivacyPolicy(snapshot(entries)), nested)).toEqual({
      refused: "nonconvergent",
    });
});

test.each([{ memoEntries: 1 }, { memoUnits: 1 }])("memo exhaustion never skips checking: %j", (limits) => {
  const prepared = preparePrivacyPolicy(snapshot([word]), { limits });
  const runs = Array.from({ length: 6 }, (_, n) => b64(`ordinary field number ${n}`));
  expect(checkPrepared(prepared, runs.join(":"))).toEqual({ clean: true });
  expect(checkPrepared(prepared, [...runs, b64(word)].join(":"))).toEqual(match());
  expect(
    checkPrepared(preparePrivacyPolicy(snapshot([], [word]), { limits }), [...runs, b64(word)].join(":")),
  ).toEqual(match(true, []));
});

test("legacy registrations exceed prepared caps and default generation observes proc registrations", () => {
  const old = preparePrivacyPolicy(capturePrivacySnapshot());
  const values = Array.from({ length: privacyLimits.credentials + 1 }, (_, n) => `${word}-legacy-${n}`);
  for (const value of values) registerCredential("SYNTHETIC_PRIVACY_TEST", value);
  expect(isCurrentPrivacyGeneration(old)).toBe(false);
  const direct = `${word}-direct`;
  privacyRegistry.addCredential(direct);
  registerCredential("SYNTHETIC_PRIVACY_TEST", direct);
  expect(redactCredentials(direct)).toBe("[redacted]");
  expect(registeredCredentials()).toContain(values[1024] ?? "");
  expect(redactCredentials(values[1024] ?? "")).toBe("[redacted]");
  const entries = policy(Array.from({ length: privacyLimits.entries + 1 }, (_, n) => `${word}-policy-${n}`));
  expect(privateMatches(entries[64]?.value ?? "", entries)).toContainEqual(
    entries[64] ?? { value: "", entry: 0 },
  );
});
