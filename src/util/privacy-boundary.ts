import { decodedLayers, type PrivateStrings, stripPartialEscapes } from "../gates/private.ts";
import {
  CredentialMatcher,
  createCredentialRegistry,
  credentialRegistry,
  credentialVariants,
} from "./credential-matcher.ts";
export const privacyRefusals = [
  "entries-count",
  "credentials-count",
  "original-length",
  "originals-total",
  "variants-total",
  "form-length",
  "forms-total",
  "ill-formed",
  "nonconvergent",
] as const;
type Refusal = { refused: (typeof privacyRefusals)[number] };
export const privacyLimits = {
  entries: 64,
  credentials: 1024,
  originalLength: 16384,
  originalsTotal: 1048576,
  variantsTotal: 8388608,
  formLength: 33554432,
  formsTotal: 67108864,
  memoEntries: 64,
  memoUnits: 1048576,
};
export function createPrivacyRegistry(secrets = createCredentialRegistry(), checker = () => "privacy/1") {
  let entries: PrivateStrings = [];
  let policy = 0;
  const identity = Symbol();
  const copy = () => entries.map((entry) => ({ ...entry }));
  const generation = () =>
    Object.freeze({ identity, policy, credentials: secrets.generation, checker: checker() });
  return {
    get entries() {
      return copy();
    },
    replacePolicy(value: PrivateStrings) {
      entries = value.map((entry) => ({ ...entry }));
      policy++;
    },
    addCredential: secrets.add,
    get generation() {
      return generation();
    },
    snapshot: () => ({ entries: copy(), credentials: secrets.values(), generation: generation() }),
  };
}
export const privacyRegistry = createPrivacyRegistry(credentialRegistry);
export const capturePrivacySnapshot = (registry = privacyRegistry) => registry.snapshot();
export const currentPrivacyGeneration = (registry = privacyRegistry) => registry.generation;
export function isCurrentPrivacyGeneration(prepared: Prepared, registry = privacyRegistry): boolean {
  const current = currentPrivacyGeneration(registry);
  if ("refused" in prepared) return false;
  return (Object.keys(current) as (keyof typeof current)[]).every(
    (key) => prepared.generation[key] === current[key],
  );
}
const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
export function preparePrivacyPolicy(
  snapshot: ReturnType<typeof capturePrivacySnapshot>,
  options: {
    limits?: Partial<typeof privacyLimits>;
    counters?: { preparations: number; normalizations: number };
  } = {},
) {
  const limits = { ...privacyLimits, ...options.limits };
  const refuse = (refused: Refusal["refused"]): Refusal => ({ refused });
  if (snapshot.entries.length > limits.entries) return refuse("entries-count");
  if (snapshot.credentials.length > limits.credentials) return refuse("credentials-count");
  const originals = [...snapshot.entries.map(({ value }) => value), ...snapshot.credentials];
  if (originals.some((value) => !value.isWellFormed())) return refuse("ill-formed");
  if (originals.some((value) => value.length > limits.originalLength)) return refuse("original-length");
  const sum = (values: string[]) => values.reduce((total, value) => total + value.length, 0);
  if (sum(originals) > limits.originalsTotal) return refuse("originals-total");
  if (options.counters) options.counters.preparations++;
  const entries = snapshot.entries.map(({ value, entry }) => {
    if (options.counters) options.counters.normalizations++;
    return { value: normalize(value), entry };
  });
  const variants = new Map<string, boolean>();
  for (const secret of snapshot.credentials)
    for (const variant of credentialVariants(secret))
      variants.set(variant, variants.get(variant) || secret.length >= 8);
  const units = [...entries.map(({ value }) => value), ...variants.keys()];
  if (sum(units) > limits.variantsTotal) return refuse("variants-total");
  const bytes = [...originals, ...variants.keys()].map((value) => Buffer.byteLength(value));
  const minimum = Math.ceil((Math.min(...bytes) * 4) / 3);
  const candidates = originals.length
    ? new RegExp(`(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{${Math.max(1, minimum)},}=*`, "g")
    : undefined;
  return Object.freeze({
    generation: Object.freeze({ ...snapshot.generation }),
    entries,
    minimum,
    candidates,
    matcher: new CredentialMatcher(variants),
    limits,
  });
}
type Prepared = ReturnType<typeof preparePrivacyPolicy>;
/** Internal foundation only. Limits admit strings; they do not bound RSS or synchronous duration. */
export function checkPrepared(
  prepared: Prepared,
  text: string,
  { truncated = false } = {},
): Refusal | { clean: true } | { match: { entries: number[]; credential: boolean } } {
  if ("refused" in prepared) return prepared;
  const { entries, matcher, limits, candidates, minimum } = prepared;
  let total = 0;
  const retain = (form: string) => {
    if (!form.isWellFormed()) throw "ill-formed";
    if (form.length > limits.formLength) throw "form-length";
    total += form.length;
    if (total > limits.formsTotal) throw "forms-total";
  };
  const substring = (form: string) => matcher.scan(form).hits.some(({ node }) => node.output);
  const credential = (form: string) => matcher.has(form) || substring(form);
  const cache = new Map<string, string>();
  let memoUnits = 0;
  const decode = (layer: string) =>
    candidates
      ? layer.replace(candidates, (run) => {
          // A short credential matches only a whole form; decoding a run inside other text would hide entries.
          const whole = run.length === layer.length;
          const cached = whole ? undefined : cache.get(run);
          if (cached !== undefined) return cached;
          const secret = whole ? credential : substring;
          let decoded = run;
          if (run.replace(/=+$/, "").length >= minimum)
            for (let offset = 0; offset < 4; offset++) {
              const plain = Buffer.from(run.slice(offset), "base64").toString();
              const found = normalize(plain);
              if (entries.some(({ value }) => found.includes(value)) || secret(plain)) {
                decoded = plain;
                break;
              }
            }
          const units = run.length + decoded.length;
          if (!whole && cache.size < limits.memoEntries && memoUnits + units <= limits.memoUnits) {
            cache.set(run, decoded);
            memoUnits += units;
          }
          return decoded;
        })
      : layer;
  try {
    const forms = decodedLayers(text, decode, retain);
    if (!forms) return { refused: "nonconvergent" };
    const normalized = [...new Set(forms)].map(normalize);
    const hits = entries
      .filter(({ value }) =>
        normalized.some((layer) => {
          if (layer.includes(value)) return true;
          if (truncated)
            for (const tail of [layer, stripPartialEscapes(layer)])
              for (let n = 1; n < value.length && n <= tail.length; n++)
                if (tail.endsWith(value.slice(0, n))) return true;
          return false;
        }),
      )
      .map(({ entry }) => entry);
    const hit = forms.some(credential);
    return hits.length || hit ? { match: { entries: hits, credential: hit } } : { clean: true };
  } catch (code) {
    return { refused: privacyRefusals.find((fixed) => fixed === code) ?? "nonconvergent" };
  }
}
