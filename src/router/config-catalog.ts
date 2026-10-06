import { z } from "zod";
import { MODELS, type ModelDef, PROVIDERS, type ProviderDef } from "./catalog.ts";
import { EFFORT_LEVELS } from "./targets.ts";

const id = z.string().regex(/^[^\s/@|]+$/);
const text = z.string().min(1);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const url = z.string().refine((s) => {
  const u = URL.parse(s);
  return /^https?:\/\/\S+$/i.test(s) && u !== null && !u.username && !u.password;
});
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const quota = z.enum(["windows", "unlimited"]);
const price = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(),
});
const countryCodes =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW unknown";
const origin = z.enum(countryCodes.split(" "));
const modelSchema = z.strictObject({
  id,
  model: text,
  vendor: z.enum([
    "anthropic",
    "openai",
    "qwen",
    "deepseek",
    "moonshot",
    "zhipu",
    "minimax",
    "google",
    "meta",
    "ibm",
    "nvidia",
    "mistral",
    "typesafe",
    "other",
  ]),
  origin,
  base_origin: origin,
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  price,
  efforts: z.array(z.enum(EFFORT_LEVELS)),
  effort: z.enum(EFFORT_LEVELS).optional(),
  checkpoint: text.optional(),
  notes: z.string().optional(),
});
const ssh = z.strictObject({
  host: z.string().regex(/^(?!-)[A-Za-z0-9_.:@[\]-]+$/),
  local_port: positive.max(65535),
  remote_port: positive.max(65535),
});
const providerSchema = z.strictObject({
  id,
  kind: z.enum(["claude-cli", "codex-cli", "openai-compatible", "anthropic-compatible", "decisions"]),
  label: text,
  billing: z.enum(["free", "metered", "subscription"]),
  quota: quota.default("windows"),
  max_concurrent: positive,
  base_url: url.optional(),
  openai_base_url: url.optional(),
  decisions_base_url: url.optional(),
  health_url: url.optional(),
  api_key_env: envName.optional(),
  ssh_forward: ssh.optional(),
});
const definition = providerSchema.partial().extend({
  preset: z.enum(["claude", "codex", "openrouter", "typesafe"]).optional(),
  ssh_forward: ssh.partial().optional(),
  models: z
    .array(modelSchema.partial().extend({ id, price: price.partial().optional() }))
    .min(1)
    .optional(),
});
function checked<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Error(
      result.error.issues
        .map(
          (i) =>
            `${path}${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.code === "unrecognized_keys" ? `unknown fields ${i.keys.join(", ")}` : "invalid or missing field"}`,
        )
        .join("; "),
    );
  return result.data;
}
function validateQuota(value: unknown, path: string): void {
  if (!value || typeof value !== "object" || !("quota" in value)) return;
  if (!quota.safeParse(value.quota).success)
    throw new Error(`${path}.quota: expected windows or unlimited, received ${JSON.stringify(value.quota)}`);
}
export function providerKind(p: ProviderDef) {
  if (p.kind) return p.kind;
  if (p.harness === "claude")
    return p.baseUrl ? "anthropic-compatible" : p.openaiBaseUrl ? "openai-compatible" : "claude-cli";
  return p.harness === "codex" ? "codex-cli" : p.harness;
}
function mapFields(value: object, config: boolean): Record<string, unknown> {
  const special: Record<string, string> = config
    ? { apiKeySecret: "api_key_env", supportedEfforts: "efforts" }
    : { api_key_env: "apiKeySecret", efforts: "supportedEfforts" };
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [
        special[k] ??
          (config
            ? k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
            : k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())),
        v && typeof v === "object" && !Array.isArray(v) ? mapFields(v, config) : v,
      ]),
  );
}
function providerFields(p: ProviderDef) {
  const { harness: _h, apiKey: _key, kind: _kind, ...fields } = p;
  return checked(providerSchema, { ...mapFields(fields, true), kind: providerKind(p) }, "providers");
}
function modelFields(m: ModelDef) {
  const { provider, id, source: _source, ...fields } = m;
  return checked(modelSchema, { ...mapFields(fields, true), id: id.slice(provider.length + 1) }, "models");
}
export function resolveCatalog(raw: unknown = undefined) {
  const providers: ProviderDef[] = structuredClone(PROVIDERS).map((p) => ({
      ...p,
      quota: p.quota ?? "windows",
    })),
    models = structuredClone(MODELS);
  const explicit = new Set<string>();
  const providerMaxConcurrent: Record<string, number> = Object.create(null);
  if (raw !== undefined && !Array.isArray(raw)) {
    if (raw === null || typeof raw !== "object") throw new Error("providers must be a table or array");
    for (const [name, value] of Object.entries(raw)) {
      const p = providers.find((p) => p.id === name);
      if (!p) throw new Error(`providers.${name}: unknown provider`);
      const limit = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      validateQuota(value, `providers.${name}`);
      if (limit.max_concurrent !== undefined && !positive.safeParse(limit.max_concurrent).success)
        throw new Error(`providers.${name}.max_concurrent must be a positive safe integer`);
      const legacy = checked(
        z.strictObject({ max_concurrent: positive.optional(), quota: quota.optional() }),
        value,
        `providers.${name}`,
      );
      if (legacy.max_concurrent !== undefined)
        providerMaxConcurrent[name] = p.maxConcurrent = legacy.max_concurrent;
      p.quota = legacy.quota ?? "windows";
    }
  }
  for (const [index, value] of (Array.isArray(raw) ? raw : []).entries()) {
    const path = `providers[${index}]`;
    const identity = value && typeof value === "object" ? (value.id ?? value.preset) : undefined;
    validateQuota(value, `${path}${identity ? `.${identity}` : ""}`);
    const c = checked(definition, value, path);
    const name = checked(id, c.id ?? c.preset, `${path}.id`);
    if (explicit.has(name)) throw new Error(`${path}.id: duplicate provider`);
    explicit.add(name);
    const old = providers.find((p) => p.id === name);
    const base = c.preset ? PROVIDERS.find((p) => p.id === c.preset) : old;
    const { preset: _preset, models: changes, ...fields } = c;
    const inherited: Partial<ReturnType<typeof providerFields>> = base ? providerFields(base) : {};
    const p = checked(
      providerSchema,
      {
        ...inherited,
        ...fields,
        id: name,
        label: c.label ?? base?.label ?? name,
        ssh_forward: c.ssh_forward ? { ...inherited.ssh_forward, ...c.ssh_forward } : inherited.ssh_forward,
      },
      path,
    );
    if (old && providerKind(old) !== p.kind)
      throw new Error(`${path}.${name}: expected kind ${providerKind(old)}, received ${p.kind}`);
    if (p.kind === "openai-compatible" && c.base_url && !c.openai_base_url) p.openai_base_url = c.base_url;
    if (p.kind === "decisions" && c.base_url && !c.decisions_base_url) p.decisions_base_url = c.base_url;
    const endpoint =
      p.kind === "openai-compatible"
        ? (p.openai_base_url ?? p.base_url)
        : p.kind === "decisions"
          ? (p.decisions_base_url ?? p.base_url)
          : p.base_url;
    if (["openai-compatible", "anthropic-compatible", "decisions"].includes(p.kind) && !endpoint)
      throw new Error(`${path}.base_url: endpoint required for ${p.kind}`);
    const def = mapFields(p, false) as unknown as ProviderDef;
    def.harness = p.kind === "codex-cli" ? "codex" : p.kind === "decisions" ? "decisions" : "claude";
    if (p.kind === "openai-compatible") {
      def.openaiBaseUrl = endpoint;
      delete def.baseUrl;
    }
    if (p.kind === "decisions") {
      def.decisionsBaseUrl = endpoint;
      delete def.baseUrl;
    }
    if (!p.api_key_env && old?.apiKey) def.apiKey = old.apiKey;
    // Keep built-in definitions structurally stable when their inferred kind is sufficient.
    if (providerKind({ ...def, kind: undefined }) === def.kind) delete def.kind;
    const position = providers.findIndex((p) => p.id === name);
    if (position < 0) providers.push(def);
    else providers[position] = def;
    const effective = new Map(
      models.filter((m) => m.provider === name).map((m) => [modelFields(m).id, modelFields(m)]),
    );
    if (c.preset)
      for (const m of MODELS.filter((m) => m.provider === c.preset))
        effective.set(modelFields(m).id, modelFields(m));
    const seen = new Set<string>();
    for (const change of changes ?? []) {
      if (seen.has(change.id)) throw new Error(`${path}.models.id: duplicate model`);
      seen.add(change.id);
      const previous = effective.get(change.id);
      effective.set(
        change.id,
        checked(
          modelSchema,
          {
            ...previous,
            ...change,
            price: change.price ? { ...previous?.price, ...change.price } : previous?.price,
          },
          `${path}.models.${change.id}`,
        ),
      );
    }
    if (!effective.size) throw new Error(`${path}.models: at least one model required`);
    for (const value of effective.values()) {
      const m = checked(modelSchema, value, `${path}.models.${value.id}`);
      if (m.effort !== undefined && !m.efforts.includes(m.effort))
        throw new Error(`${path}.models.${m.id}.effort: absent from efforts`);
      const model = { ...mapFields(m, false), id: `${name}/${m.id}`, provider: name } as unknown as ModelDef;
      if (seen.has(m.id) || (c.preset && name !== c.preset)) model.source = "config";
      const at = models.findIndex((m) => m.id === model.id);
      if (at < 0) models.push(model);
      else models[at] = model;
    }
  }
  const notes = ["omlx", "mtplx", "twilight"]
    .filter((id) => !explicit.has(id))
    .map((id) => `${id}: deprecated implicit provider; migrate with limitless providers export --write`);
  return { providers, models, providerMaxConcurrent, notes };
}
export type EffectiveCatalog = ReturnType<typeof resolveCatalog>;
/** Runtime entries require the same complete metadata as config-defined models. */
export function runtimeModel(value: unknown, providers: ProviderDef[]): ModelDef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected model object");
  const { provider, ...fields } = value as Record<string, unknown>;
  if (typeof provider !== "string" || !providers.some((p) => p.id === provider))
    throw new Error(`unknown provider ${String(provider)}`);
  const m = checked(modelSchema, mapFields(fields, true), "model");
  if (m.effort !== undefined && !m.efforts.includes(m.effort))
    throw new Error("model.effort: absent from efforts");
  return {
    ...mapFields(m, false),
    id: `${provider}/${m.id}`,
    provider,
    source: "runtime",
  } as unknown as ModelDef;
}
/** TOML inline values also preserve unrelated nested settings during migration. */
export function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object")
    return `{ ${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)} = ${tomlValue(v)}`)
      .join(", ")} }`;
  if (typeof value === "number" && !Number.isFinite(value))
    return Number.isNaN(value) ? "nan" : value < 0 ? "-inf" : "inf";
  return JSON.stringify(value);
}
function assignments(value: object): string {
  return Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} = ${tomlValue(v)}\n`)
    .join("");
}
export function exportProviders(catalog: Pick<EffectiveCatalog, "providers" | "models">): string {
  // Existing model positions survive overlays; emit providers with additions in their original order.
  const addition = (p: ProviderDef) =>
    catalog.models.findIndex((m) => m.provider === p.id && !MODELS.some((base) => base.id === m.id));
  return [...catalog.providers]
    .sort((a, b) => addition(a) - addition(b))
    .map(
      (p) =>
        `[[providers]]\n${assignments(providerFields(p))}${catalog.models
          .filter((m) => m.provider === p.id)
          .map((m) => `\n[[providers.models]]\n${assignments(modelFields(m))}`)
          .join("")}\n`,
    )
    .join("");
}
