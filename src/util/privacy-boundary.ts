import { decodedLayers, type PrivateStrings, stripPartialEscapes } from "../gates/private.ts";
import {
  CredentialMatcher,
  createCredentialRegistry,
  credentialRegistry,
  credentialVariants,
} from "./credential-matcher.ts";
import { terminalRedactor } from "./terminal-redaction.ts";
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
  inputUnits: 8388608,
  inputBytes: 33554432,
  outputUnits: 8388608,
  outputBytes: 33554432,
  assembly: 64,
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

declare const boundaryBrand: unique symbol;
export type BoundaryText = { readonly [boundaryBrand]: true };
export type Provenance = { kind: "complete" } | { kind: "cut"; truncated: true } | { kind: "legacy-unknown" };
export type BoundaryCut = {
  limit: number;
  unit: "U" | "B" | "CP";
  side?: "prefix" | "tail";
  marker?: string;
};
type Reason =
  | Refusal["refused"]
  | "private-match"
  | "unchecked-provenance"
  | "stale-generation"
  | "input-length"
  | "output-length"
  | "assembly-count"
  | "forged"
  | "unreadable-policy"
  | "invalid-cut";
type Projection = {
  text: string;
  truncated: boolean | undefined;
  checkedComplete: boolean;
  withheld: boolean;
  policyDigest: string;
  reason?: Reason;
};
type Options = {
  registry?: typeof privacyRegistry;
  beforeIssue?: () => void;
  limits?: Partial<typeof privacyLimits>;
};
type Evidence = Projection & {
  policy: Prepared;
  registry: typeof privacyRegistry;
  generation: ReturnType<typeof currentPrivacyGeneration> | undefined;
  limits: typeof privacyLimits;
  beforeIssue?: () => void;
};
const receipts = new WeakMap<BoundaryText, Evidence>();
const withheld = (state: Evidence, reason: Reason): Evidence => ({
  ...state,
  text: "[withheld: private text]",
  withheld: true,
  reason,
});
function context(policy: Prepared, options: Options): Evidence {
  const registry = options.registry ?? privacyRegistry;
  let generation: Evidence["generation"];
  try {
    generation = "refused" in policy ? currentPrivacyGeneration(registry) : policy.generation;
  } catch {
    // A refusal remains possible without generation authority.
  }
  const limits = { ...privacyLimits, ...("refused" in policy ? {} : policy.limits), ...options.limits };
  return {
    text: "",
    truncated: false,
    checkedComplete: false,
    withheld: false,
    policyDigest: generation
      ? `privacy/${generation.policy}/${generation.credentials}/${generation.checker}`
      : "privacy/unavailable",
    policy: "refused" in policy ? policy : { ...policy, limits },
    registry,
    generation,
    beforeIssue: options.beforeIssue,
    limits,
  };
}
function current(state: Evidence): boolean {
  if (!state.generation) return false;
  try {
    const generation = currentPrivacyGeneration(state.registry);
    return (Object.keys(generation) as (keyof typeof generation)[]).every(
      (key) => state.generation?.[key] === generation[key],
    );
  } catch {
    return false;
  }
}
function issue(state: Evidence): BoundaryText {
  try {
    state.beforeIssue?.();
  } catch {
    state = withheld(state, "nonconvergent");
  }
  if (!current(state)) state = withheld(state, "stale-generation");
  const value = Object.freeze({}) as BoundaryText;
  receipts.set(value, state);
  return value;
}
function read(value: unknown): Evidence {
  const state = typeof value === "object" && value !== null ? receipts.get(value as BoundaryText) : undefined;
  if (!state) return withheld(context({ refused: "nonconvergent" }, {}), "forged");
  return current(state) ? state : withheld(state, "stale-generation");
}
export function consumeBoundaryText(value: unknown): Projection {
  const { text, truncated, checkedComplete, withheld, policyDigest, reason } = read(value);
  return { text, truncated, checkedComplete, withheld, policyDigest, ...(reason ? { reason } : {}) };
}
function admit(state: Evidence, text: string, output = false): Reason | undefined {
  if (!text.isWellFormed()) return "ill-formed";
  const { limits } = state;
  if (
    text.length > (output ? limits.outputUnits : limits.inputUnits) ||
    Buffer.byteLength(text) > (output ? limits.outputBytes : limits.inputBytes)
  )
    return output ? "output-length" : "input-length";
}
function inspect(state: Evidence, text: string, visible = false): Evidence {
  const result = checkPrepared(state.policy, text, { truncated: state.truncated === true });
  if ("refused" in result) return withheld(state, result.refused);
  // Visible credential-only hits proceed through the real redactor; private hits never do.
  if ("match" in result && (!visible || result.match.entries.length)) return withheld(state, "private-match");
  return { ...state, text };
}
function select(state: Evidence, cut?: BoundaryCut): Evidence {
  if (state.withheld) return state;
  if (cut) {
    if (!Number.isSafeInteger(cut.limit) || cut.limit < 0 || !["U", "B", "CP"].includes(cut.unit))
      return withheld(state, "invalid-cut");
    let units = 0;
    const measure = (char: string) =>
      cut.unit === "B" ? Buffer.byteLength(char) : cut.unit === "U" ? char.length : 1;
    for (const char of state.text) units += measure(char);
    const clipped = units > cut.limit;
    let start = cut.side === "tail" ? state.text.length : 0;
    let used = 0;
    while (cut.side === "tail" ? start > 0 : start < state.text.length) {
      let next = cut.side === "tail" ? start - 1 : start + 1;
      const code = state.text.charCodeAt(cut.side === "tail" ? next : start);
      if (cut.side === "tail" ? code >= 0xdc00 && code <= 0xdfff : code >= 0xd800 && code <= 0xdbff)
        next += cut.side === "tail" ? -1 : 1;
      const char = state.text.slice(Math.min(start, next), Math.max(start, next));
      if (used + measure(char) > cut.limit) break;
      used += measure(char);
      start = next;
    }
    const fragment = cut.side === "tail" ? state.text.slice(start) : state.text.slice(0, start);
    const marker = clipped ? (cut.marker ?? "") : "";
    state = {
      ...state,
      truncated: clipped ? true : state.truncated,
      text: cut.side === "tail" ? marker + fragment : fragment + marker,
    };
  }
  const reason = admit(state, state.text, true);
  return reason ? withheld(state, reason) : inspect(state, state.text);
}
type TextInput = {
  text: string;
  provenance: Provenance;
  policy: Prepared;
  cut?: BoundaryCut;
  terminal?: boolean;
};
export function protectText(
  { text, provenance, policy, cut, terminal }: TextInput,
  options: Options = {},
): BoundaryText {
  let state = context(policy, options);
  state.truncated = provenance.kind === "cut" ? true : provenance.kind === "complete" ? false : undefined;
  try {
    if (provenance.kind !== "complete") return issue(withheld(state, "unchecked-provenance"));
    if ("refused" in policy) return issue(withheld(state, "unreadable-policy"));
    const reason = admit(state, text);
    if (reason) return issue(withheld(state, reason));
    state = inspect(state, text);
    if (state.withheld) return issue(state);
    state.checkedComplete = true;
    if (terminal) {
      const visible = terminalRedactor(() => new CredentialMatcher(new Map())).push(text, true);
      if (visible !== text) state = inspect(state, visible, true);
    }
    if (state.withheld) return issue(state);
    const rendered = terminal
      ? terminalRedactor(() => policy.matcher).push(text, true)
      : policy.matcher.redact(text);
    if (rendered !== text) state = inspect(state, rendered);
    return issue(select(state, cut));
  } catch {
    return issue(withheld(state, "nonconvergent"));
  }
}
function derive(value: unknown, operation: (state: Evidence) => Evidence): BoundaryText {
  let state = read(value);
  try {
    if (!state.withheld) state = operation({ ...state });
  } catch {
    state = withheld(state, "nonconvergent");
  }
  return issue(state);
}
export const cutPrefix = (value: BoundaryText, limit: number, unit: BoundaryCut["unit"] = "U") =>
  derive(value, (state) => select(state, { limit, unit }));
export const cutTail = (value: BoundaryText, limit: number, unit: BoundaryCut["unit"] = "U") =>
  derive(value, (state) => select(state, { limit, unit, side: "tail" }));
export const trim = (value: BoundaryText) =>
  derive(value, (state) => select({ ...state, text: state.text.trim() }));
export function concat(
  values: readonly BoundaryText[],
  options: { separator?: string; cut?: BoundaryCut } = {},
): BoundaryText {
  let state = values.length
    ? read(values[0])
    : withheld(context({ refused: "nonconvergent" }, {}), "unchecked-provenance");
  if (!values.length) return issue(state);
  try {
    const components = values.map(read);
    const failed = components.find((item) => item.withheld);
    const truncated = components.some((item) => item.truncated === true)
      ? true
      : components.some((item) => item.truncated === undefined)
        ? undefined
        : false;
    state = { ...state, truncated, checkedComplete: components.every((item) => item.checkedComplete) };
    if (values.length > state.limits.assembly) return issue(withheld(state, "assembly-count"));
    if (failed) return issue(withheld(state, failed.reason ?? "forged"));
    if (
      components.some(
        (item) =>
          item.generation?.identity !== state.generation?.identity ||
          item.generation?.policy !== state.generation?.policy ||
          item.generation?.credentials !== state.generation?.credentials ||
          item.generation?.checker !== state.generation?.checker,
      )
    )
      return issue(withheld(state, "stale-generation"));
    const separator = options.separator ?? "";
    if (!separator.isWellFormed()) return issue(withheld(state, "ill-formed"));
    // Bound the complete assembly before allocating it, even when selection would be tiny.
    const units = components.reduce(
      (n, item) => n + item.text.length,
      separator.length * Math.max(0, values.length - 1),
    );
    const bytes = components.reduce(
      (n, item) => n + Buffer.byteLength(item.text),
      Buffer.byteLength(separator) * Math.max(0, values.length - 1),
    );
    if (units > state.limits.inputUnits || bytes > state.limits.inputBytes)
      return issue(withheld(state, "input-length"));
    state = inspect(state, components.map((item) => item.text).join(separator));
    return issue(select(state, options.cut));
  } catch {
    return issue(withheld(state, "nonconvergent"));
  }
}
