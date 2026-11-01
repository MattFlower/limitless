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
const work = () => ({ registrations: 0, inputs: 0, memoAdmissions: 0, memoPeakEntries: 0, memoPeakUnits: 0 });

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
  // A short credential's base64 run inside other text stays encoded for private entries.
  const mixed = preparePrivacyPolicy(snapshot([`${b64("abcd")} tail`], ["abcd"]));
  for (const text of [`${b64("abcd")}\n tail`, `${b64("abcd")} t%2561il`])
    expect(checkPrepared(mixed, text)).toEqual(match());
  expect(checkPrepared(mixed, b64("abcd"))).toEqual(match(true, []));
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

test("credential base64 readings preserve private decoding and its original thresholds", () => {
  const spelling = b64("eight888");
  const entries = policy([`${spelling} tail`]);
  const text = `${spelling} t%2561il`;
  expect(privateMatches(text, entries).map(({ entry }) => entry)).toEqual([1]);
  expect(checkPrepared(preparePrivacyPolicy(snapshot([`${spelling} tail`], ["eight888"])), text)).toEqual(
    match(true),
  );
  // A credential must not lower the original private threshold after NFKC shrinks an entry.
  const wide = "Ａ".repeat(4);
  expect(privateMatches(b64("AAAA"), policy([wide]))).toEqual([]);
  expect(checkPrepared(preparePrivacyPolicy(snapshot([wide], ["x"])), b64("AAAA"))).toEqual({ clean: true });
  // Extra forms observed for credentials must not become additional private readings.
  const values = [word, b64(word).slice(0, 7)];
  const encoded = html(b64(word));
  expect(privateMatches(encoded, policy(values)).map(({ entry }) => entry)).toEqual([1]);
  expect(checkPrepared(preparePrivacyPolicy(snapshot(values)), encoded)).toEqual(match());
});

test("normalization work observes registrations once and inputs for each base64 alignment", () => {
  for (const count of [1, 2]) {
    const counters = work();
    const prepared = preparePrivacyPolicy(snapshot([word, `${word}-other`].slice(0, count)), { counters });
    expect(counters.registrations).toBe(count);
    expect(counters.inputs).toBe(0);
    for (const candidates of [1, 30]) {
      const text = Array.from({ length: candidates }, (_, n) => b64(`ordinary clean field ${n}`)).join(":");
      const previous = counters.inputs;
      for (let i = 0; i < 3; i++) expect(checkPrepared(prepared, text)).toEqual({ clean: true });
      // Four alignments per candidate, plus one unique retained input form per check.
      expect(counters.inputs - previous).toBe(3 * (4 * candidates + 1));
      expect(counters.registrations).toBe(count);
    }
  }
});

test("decoded forms and matching passes are optional counters", () => {
  const counters = { ...work(), forms: 0, scans: 0 };
  const prepared = preparePrivacyPolicy(snapshot(["synthetic-private"]), { counters });
  expect(counters).toMatchObject({ forms: 0, scans: 0 });
  expect(checkPrepared(prepared, "%252E")).toEqual({ clean: true });
  // Raw, then six decoder readings per round: %252E -> %2E -> . -> . (converged).
  // Each reading gets a credential scan; three distinct normalized forms get a private pass.
  expect(counters).toMatchObject({ forms: 19, scans: 22 });
});

test("preparation is reused and generations remain bound to captured snapshots", () => {
  let version = "v1";
  const registry = createPrivacyRegistry(createCredentialRegistry(), () => version);
  registry.replacePolicy(policy([word]));
  const old = capturePrivacySnapshot(registry);
  const prepared = preparePrivacyPolicy(old);
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
  const v1 = capturePrivacySnapshot(registry);
  version = "v2";
  expect(isCurrentPrivacyGeneration(latest, registry)).toBe(false);
  const v2 = capturePrivacySnapshot(registry);
  version = "v1";
  for (const obsolete of [v1, v2]) {
    expect(isCurrentPrivacyGeneration(preparePrivacyPolicy(obsolete), registry)).toBe(false);
    expect(currentPrivacyGeneration(registry).checker).toBeGreaterThan(obsolete.generation.checker);
  }
  expect(isCurrentPrivacyGeneration(latest, registry)).toBe(false);
  expect(isCurrentPrivacyGeneration(preparePrivacyPolicy(capturePrivacySnapshot(registry)), registry)).toBe(
    true,
  );
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
    ["formsTotal", 24, "forms-total"],
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

test("normalized expansions charge per-form and aggregate storage before approval", () => {
  // Seven one-unit decoder forms, plus the unique four-unit NFKC/lowercase form.
  for (const limits of [{ formLength: 4 }, { formsTotal: 11 }])
    expect(checkPrepared(preparePrivacyPolicy(snapshot(), { limits }), "㍿")).toEqual({ clean: true });
  for (const [limits, refused] of [
    [{ formLength: 1 }, "form-length"],
    [{ formLength: 3 }, "form-length"],
    [{ formsTotal: 7 }, "forms-total"],
    [{ formsTotal: 10 }, "forms-total"],
  ] as const)
    expect(checkPrepared(preparePrivacyPolicy(snapshot(), { limits }), "㍿")).toEqual({ refused });
  expect(
    checkPrepared(preparePrivacyPolicy(snapshot(["株式会社"]), { limits: { formsTotal: 10 } }), "㍿"),
  ).toEqual({ refused: "forms-total" });
});

test.each(["memoEntries", "memoUnits"] as const)("%s admissions observe equality and exhaustion", (bound) => {
  const runs = Array.from({ length: 6 }, (_, n) => b64(`ordinary field number ${n}`));
  const units = 2 * (runs[0]?.length ?? 0); // Clean candidates cache their unchanged key and result.
  for (const cap of [0, 1, 2]) {
    const limits = { [bound]: cap * (bound === "memoUnits" ? units : 1) };
    const counters = work();
    const prepared = preparePrivacyPolicy(snapshot([word]), { limits, counters });
    for (const [text, expected] of [
      [runs.join(":"), { clean: true }],
      [[...runs, b64(word)].join(":"), match()],
    ] as const) {
      counters.memoAdmissions = 0;
      expect(checkPrepared(prepared, text)).toEqual(expected);
      expect(counters.memoAdmissions).toBe(cap);
      expect(counters.memoPeakEntries).toBe(cap);
      expect(counters.memoPeakUnits).toBe(cap * units);
    }
    expect(
      checkPrepared(preparePrivacyPolicy(snapshot([], [word]), { limits }), [...runs, b64(word)].join(":")),
    ).toEqual(match(true, []));
  }
  const counters = work();
  const prepared = preparePrivacyPolicy(snapshot([word]), { limits: { memoUnits: units - 1 }, counters });
  expect(checkPrepared(prepared, runs.join(":"))).toEqual({ clean: true });
  expect(counters.memoAdmissions).toBe(0);
  expect(counters.memoPeakUnits).toBe(0);
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
