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
  let label = checker();
  let semantics = 0;
  const identity = Symbol();
  const copy = () => entries.map((entry) => ({ ...entry }));
  const generation = () => {
    const next = checker();
    if (next !== label) semantics++;
    label = next;
    return Object.freeze({ identity, policy, credentials: secrets.generation, checker: semantics });
  };
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
export function preparePrivacyPolicy(
  snapshot: ReturnType<typeof capturePrivacySnapshot>,
  options: {
    limits?: Partial<typeof privacyLimits>;
    counters?: Record<
      "registrations" | "inputs" | "memoAdmissions" | "memoPeakEntries" | "memoPeakUnits",
      number
    >;
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
  const { counters } = options;
  const normalize = (text: string, registration = false) => {
    if (counters) counters[registration ? "registrations" : "inputs"]++;
    return text.normalize("NFKC").toLowerCase();
  };
  const entries = snapshot.entries.map(({ value, entry }) => ({ value: normalize(value, true), entry }));
  const variants = new Map<string, boolean>();
  for (const secret of snapshot.credentials)
    for (const variant of credentialVariants(secret))
      variants.set(variant, variants.get(variant) || secret.length >= 8);
  const units = [...entries.map(({ value }) => value), ...variants.keys()];
  if (sum(units) > limits.variantsTotal) return refuse("variants-total");
  const search = (values: string[]) => {
    const minimum = Math.ceil((Math.min(...values.map((value) => Buffer.byteLength(value))) * 4) / 3);
    return {
      minimum,
      candidates: values.length
        ? new RegExp(`(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{${Math.max(1, minimum)},}=*`, "g")
        : undefined,
    };
  };
  return Object.freeze({
    generation: Object.freeze({ ...snapshot.generation }),
    entries,
    privateSearch: search(snapshot.entries.map(({ value }) => value)),
    credentialSearch: search([...variants.keys()]),
    normalize,
    counters,
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
  const { entries, matcher, limits, normalize, counters } = prepared;
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
  const decode = (layer: string, secrets = false) => {
    const { candidates, minimum } = secrets ? prepared.credentialSearch : prepared.privateSearch;
    return candidates
      ? layer.replace(candidates, (run) => {
          const cached = secrets ? undefined : cache.get(run);
          if (cached !== undefined) return cached;
          const secret = run.length === layer.length ? credential : substring;
          let decoded = run;
          if (run.replace(/=+$/, "").length >= minimum)
            for (let offset = 0; offset < 4; offset++) {
              const plain = Buffer.from(run.slice(offset), "base64").toString();
              const found = secrets ? "" : normalize(plain);
              if (secrets ? secret(plain) : entries.some(({ value }) => found.includes(value))) {
                decoded = plain;
                break;
              }
            }
          const units = run.length + decoded.length;
          if (!secrets && cache.size < limits.memoEntries && memoUnits + units <= limits.memoUnits) {
            cache.set(run, decoded);
            memoUnits += units;
            if (counters) {
              counters.memoAdmissions++;
              counters.memoPeakEntries = Math.max(counters.memoPeakEntries, cache.size);
              counters.memoPeakUnits = Math.max(counters.memoPeakUnits, memoUnits);
            }
          }
          return decoded;
        })
      : layer;
  };
  try {
    let hit = false;
    // Credential readings never steer the private decoder's replacements or convergence.
    const inspect = (form: string) => {
      retain(form);
      hit ||= credential(form) || decode(form, true) !== form;
    };
    const forms = decodedLayers(text, (layer) => decode(layer), inspect);
    if (!forms) return { refused: "nonconvergent" };
    const normalized = [...new Set(forms)].map((form) => normalize(form));
    for (const form of normalized) retain(form);
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
    return hits.length || hit ? { match: { entries: hits, credential: hit } } : { clean: true };
  } catch (code) {
    return { refused: privacyRefusals.find((fixed) => fixed === code) ?? "nonconvergent" };
  }
}
