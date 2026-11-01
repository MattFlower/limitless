/** CLI: <main> <c2.1a> <c2.1b> [workloads]. Baselines lack receipts/provenance; heap/RSS deltas observe GC */
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { arch, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privacyLimits as L } from "../src/util/privacy-boundary.ts";
import { agentEnv, runProcess } from "../src/util/proc.ts";

type Projection = Partial<ReturnType<typeof import("../src/util/privacy-boundary.ts").consumeBoundaryText>>;
const fill = (n: number, c = ".", k = c.length) => c.repeat(Math.floor(n / k)) + ".".repeat(n % k);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const keys = ["text", "truncated", "checkedComplete", "withheld", "reason"] as const;
type API = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;
export const sizes = (s: string) => {
  let codePoints = 0;
  for (const _ of s) codePoints++;
  return { units: s.length, codePoints, bytes: Buffer.byteLength(s) };
};
export function structure(v: unknown, depth = 0): { depth: number; nodes: number } {
  const children = Array.isArray(v) ? v : v && typeof v === "object" ? Object.entries(v).flat() : [];
  const ps = children.map((c) => structure(c, depth + 1));
  return { depth: Math.max(depth, ...ps.map((p) => p.depth)), nodes: ps.reduce((n, p) => n + p.nodes, 1) };
}
export const admissionMatrix = [
  { caller: "contract text/data", sourceUnits: L.inputUnits, outputCap: L.outputUnits, status: "admitted" },
  { caller: "planned c2.2 capture", sourceUnits: 5242880, outputCap: L.outputUnits, status: "admitted" },
  { caller: "sh", sourceUnits: 50_000_000, outputCap: 50_000_000, status: "refused" },
  { caller: "codex display", sourceUnits: null, outputCap: 20000, status: "not-covered" },
];
const operations =
  "createCredentialRegistry createPrivacyRegistry capturePrivacySnapshot preparePrivacyPolicy checkPrepared protectText protectData concat cutPrefix cutTail trim consumeBoundaryText redactCredentials privateMatches";
const catalog =
  "ascii-5Mi ascii-max bmp-max astral-max recursive-max depth nodes combined preparation reuse plain sparse:private-match sgr osc escapes base64 streams combining repeated distinct diagnostics input+1:input-length output+1:output-length entries+1 credentials+1 original+1 aggregate+1 variants+1 depth+1:json-depth nodes+1:json-nodes form+1:form-length forms+1:forms-total malformed:ill-formed unknown:unchecked-provenance nonconvergent:nonconvergent invalidation:stale-generation assembly+1:assembly-count sh:input-length capture consumers";
const expectations = Object.fromEntries(catalog.split(" ").map((s) => s.split(":")));
export function workload(name: string, limits = L) {
  const is = (...names: string[]) => names.includes(name),
    plus = Number(name.endsWith("+1"));
  const maximumPolicy = is("preparation", "reuse", "aggregate+1", "variants+1");
  const count = (key: "entries" | "credentials", n: number) =>
    maximumPolicy || is(`${key}+1`) ? limits[key] + Number(is(`${key}+1`)) : Math.min(n, limits[key]);
  const entries = range(count("entries", 8)).map((entry) => ({ entry, value: `p${entry}.` }));
  const total = count("credentials", 600);
  const spare = limits.originalsTotal + plus - entries.map((e) => e.value).join("").length;
  const full = is("preparation", "reuse", "aggregate+1");
  const width = (i: number) => Math.min(full ? Math.floor((spare + i) / total) : 64, limits.originalLength);
  const seed = (i: number) => createHash("sha256").update(`seed/${i}`).digest("hex").padEnd(width(i), "x");
  const credentials = range(total).map((i) => seed(i).slice(0, width(i)));
  const char = is("bmp-max") ? "界" : is("astral-max") ? "😀" : ".";
  let text = fill(name.endsWith("-max") ? limits.inputUnits : 1, char);
  const data = is("recursive-max", "depth", "nodes", "combined", "depth+1", "nodes+1", "diagnostics");
  const variant = fill(Math.ceil((limits.variantsTotal + 1) / limits.entries), "\uFDFA", 18);
  if (is("variants+1")) for (const e of entries) e.value = `${e.entry}${variant}`;
  if (is("ascii-5Mi", "sh", "input+1"))
    text = ".".repeat(is("sh") ? 50_000_000 : is("ascii-5Mi") ? 5242880 : limits.inputUnits + 1);
  if (data) {
    const d = is("depth", "depth+1", "combined") ? limits.depth + plus : 1;
    const n = is("nodes", "nodes+1", "combined", "diagnostics") ? limits.nodes + plus : d + 1;
    const v = JSON.stringify(is("recursive-max") ? ".".repeat(limits.outputUnits - 4) : ".");
    text = `[${"[".repeat(d - 1)}${v}${"]".repeat(d - 1)}${",0".repeat(Math.max(0, n - d - 1))}]`;
  }
  if (is("sparse")) text = `${".".repeat(Math.min(65536, limits.inputUnits / 2))}${entries[0]?.value}`;
  if (is("repeated", "distinct")) text = ".".repeat(Math.min(128, limits.inputUnits));
  if (is("sgr", "osc"))
    text = `${(credentials[0] ?? ".")[0]}${is("sgr") ? "\x1b[31m" : "\x1b]0;title\x07"}${credentials[0]?.slice(1) ?? ""}`;
  if (is("escapes")) text = String.raw`%2E \u002E &period; \/`;
  if (is("base64")) text = "QUJD".repeat(Math.floor(limits.inputUnits / 4));
  if (is("combining", "capture")) text = "e\u0301😀 %2E \\u002E.";
  if (is("capture")) text = text.repeat(Math.floor(Math.min(65536, limits.inputUnits / 4) / text.length));
  if (is("original+1")) credentials[0] = "x".repeat(limits.originalLength + 1);
  if (is("form+1")) text = fill(limits.formLength + 1, "\uFDFA", 18);
  if (is("forms+1")) text = `ﷺ${".".repeat(Math.ceil((limits.formsTotal - 24) / 8))}`;
  if (is("malformed")) text = String.fromCharCode(0xd800);
  if (is("nonconvergent")) text = `%${"25".repeat(7)}2E`;
  const reason = expectations[name] ?? (name.endsWith("+1") ? "unreadable-policy" : "");
  let expected = is("combining") ? "e" : is("sgr", "osc") ? "[redacted]" : text;
  if (is("streams")) expected = text.repeat(2);
  const cut = is("output+1") ? { limit: 0, marker: ".".repeat(limits.outputUnits + 1) } : undefined;
  const metadata = { sizes: sizes(text), shape: data ? structure(JSON.parse(text)) : null, limits, cut };
  const admitted = metadata.sizes.units <= limits.inputUnits && metadata.sizes.bytes <= limits.inputBytes;
  const maximum = name.endsWith("-max") || is("depth", "nodes", "combined", "preparation");
  return { name, text, expected, reason, data, admitted, maximum, entries, credentials, ...metadata };
}
export function validateCoverage(w: ReturnType<typeof workload>, p: Projection) {
  const refused = p.withheld && p.reason === w.reason && p.text === "[withheld: private text]";
  const success = p.withheld === false && p.checkedComplete === true && p.text === w.expected;
  if (w.reason ? !refused || w.maximum : !success) throw Error(`Invalid coverage: ${w.name}`);
}
// These workload fragments contain no protected values. Cuts keep whole code points,
// but combining marks are independent code points and are not kept with their base.
function rendering(want: Projection, operation: string, limit: number): Projection {
  if (want.withheld) return want;
  const text = want.text ?? "";
  if (operation === "trim") return { ...want, text: text.trim() };
  const tail = operation === "cutTail";
  let fragment = tail ? text.slice(text.length - Math.min(limit, text.length)) : text.slice(0, limit);
  if (!fragment.isWellFormed()) fragment = tail ? fragment.slice(1) : fragment.slice(0, -1);
  return { ...want, text: fragment, truncated: text.length > limit || want.truncated };
}
export function validateChunkings(parts: Uint8Array[][], want: Projection, run: (s: string) => Projection) {
  for (const p of parts.map((chunks) => run(Buffer.concat(chunks).toString())))
    if (keys.some((k) => p[k] !== want[k])) throw Error("Chunking/provenance mismatch");
}
/** Calls with no yield between them form one slice, first entry to last return; a yield starts the next */
export function wholeSlices(calls: { start: number; end: number }[], yields: number[] = []) {
  const slices: typeof calls = [];
  for (const { start, end } of calls) {
    const k = yields.filter((y) => y <= start).length;
    const s = slices[k] ?? { start, end };
    slices[k] = { start: Math.min(start, s.start), end: Math.max(end, s.end) };
  }
  return Object.values(slices).map((s) => s.end - s.start);
}
export function instrument(now = () => performance.now(), pause = () => runtime.pause()) {
  const [phases, yields]: [{ operation: string; start: number; end: number }[], number[]] = [[], []];
  const call = <T>(operation: string, fn: () => T) => {
    const [start, value] = [now(), fn()] as const;
    phases.push({ operation, start, end: now() });
    return value;
  };
  return { phases, yields, call, yieldNow: () => pause().then(() => void yields.push(now())) };
}
export type Trial = { slice: number; heartbeat: number } & Record<"warmup" | "admitted" | "owned", boolean>;
export function summarizeTrials<T extends Trial>(raw: T[]) {
  const timed = raw.filter((r) => !r.warmup).map((r) => r.slice);
  const median = timed.sort((a, b) => a - b)[Math.floor(timed.length / 2)] ?? null;
  return { raw, median, worstSlice: raw.length ? Math.max(...raw.map((r) => r.slice)) : null };
}
export const decideC21c = (records: Trial[]) => ({
  trigger: records.some((r) => r.owned && r.admitted && r.slice > 50),
  excluded: records.filter((r) => !r.admitted || !r.owned),
  caveat: "Finite samples establish a measured envelope, not a wall-clock guarantee.",
});
type Job = { ref: string; name: string };
type Handle<T> = { result: Promise<T>; cleanup: () => Promise<void> };
export async function runRevisions<T>(refs: string[], names: string[], run: (j: Job) => Promise<Handle<T>>) {
  const settled: PromiseSettledResult<T>[] = [];
  for (const job of refs.flatMap((ref) => names.map((name) => ({ ref, name }))))
    settled.push(...(await Promise.allSettled([run(job).then((h) => h.result.finally(h.cleanup))])));
  const failed = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failed) throw failed.reason;
  return settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
}
const runtime = {
  now: () => performance.now(),
  pause: () => new Promise<void>((done) => setImmediate(done)),
  memory: () => ({ heap: process.memoryUsage().heapUsed, peakRSS: process.resourceUsage().maxRSS }),
  gc: () => Bun.gc(true),
  platform: [Bun.version, process.platform, release(), arch()],
};
export async function measureRevision(a: API, fixture: () => ReturnType<typeof workload>, r = runtime) {
  const w = fixture(),
    buf = Buffer.from(w.text);
  const chunks = range(Math.ceil(buf.length / 32768)).map((i) => buf.subarray(i * 32768, (i + 1) * 32768));
  const parts = [chunks, ...[2, 4, 13].map((n) => [buf.subarray(0, n), buf.subarray(n)])];
  const available = (k: string) => typeof a[k] === "function";
  const status = (k: string) => [k, available(k) ? "available" : "unavailable"];
  const availability = Object.fromEntries(operations.split(" ").map(status));
  const groups: Record<string, { status: string; summary: ReturnType<typeof summarizeTrials> }> = {};
  let meter = instrument(r.now, r.pause);
  let counters = {
    registrations: 0,
    inputs: 0,
    forms: 0,
    scans: 0,
    memoAdmissions: 0,
    memoPeakEntries: 0,
    memoPeakUnits: 0,
  };
  const op = (k: string, ...args: unknown[]) => meter.call(k, () => (a[k] as Fn)(...args));
  const series = async (label: string, enabled: boolean, fn: () => unknown, owned = true) => {
    const raw = [];
    const scope = { admitted: w.admitted, owned };
    for (let trial = 0; enabled && trial < 7; trial++) {
      await r.pause();
      meter = instrument(r.now, r.pause);
      const [before, scheduled] = [r.memory().heap, r.now()];
      const beat = r.pause().then(() => r.now() - scheduled);
      await meter.call("entry", fn);
      const [{ heap, peakRSS }, { phases, yields }] = [r.memory(), meter];
      const receiptReuse = phases.filter((p) => p.operation === "consumeBoundaryText").length;
      const evidence = { phases, counters: { ...counters }, receiptReuse, heapDelta: heap - before, peakRSS };
      const [slice, heartbeat] = [Math.max(...wholeSlices(phases, yields)), await beat, r.gc()];
      const timing = { slice, heartbeat, otherDelay: Math.max(0, heartbeat - slice) };
      raw.push({ warmup: trial < 2, ...scope, ...timing, ...evidence, retainedHeap: r.memory().heap });
    }
    groups[label] = { status: enabled ? "available" : "unavailable", summary: summarizeTrials(raw) };
  };
  let registry: Record<"replacePolicy" | "addCredential", Fn>, policy: unknown, receipt: unknown;
  const prepare = () => {
    counters = {
      registrations: 0,
      inputs: 0,
      forms: 0,
      scans: 0,
      memoAdmissions: 0,
      memoPeakEntries: 0,
      memoPeakUnits: 0,
    };
    registry = op("createPrivacyRegistry", op("createCredentialRegistry")) as typeof registry;
    registry.replacePolicy(w.entries);
    w.credentials.forEach(registry.addCredential);
    const options = { counters, limits: w.limits };
    policy = op("preparePrivacyPolicy", op("capturePrivacySnapshot", registry), options);
  };
  const cold = operations.split(" ").slice(0, 4).every(available);
  await series("cold preparation", cold, prepare);
  const operation = w.data ? "protectData" : "protectText";
  const count = w.name === "streams" ? 2 : w.name === "assembly+1" ? w.limits.assembly + 1 : 0;
  const ready = cold && [operation, "consumeBoundaryText", "concat"].slice(0, count ? 3 : 2).every(available);
  const kind = w.name === "unknown" ? "legacy-unknown" : "complete";
  const cut = w.name === "combining" ? { limit: 1, unit: "U" } : w.cut && { ...w.cut, unit: "U" };
  const input = { provenance: { kind }, terminal: w.name === "sgr" || w.name === "osc", cut };
  const protect = (text: string) => op(operation, { ...input, text, json: text, policy }, { registry });
  const read = (receipt: unknown) => op("consumeBoundaryText", receipt) as Projection;
  await series(w.name === "reuse" || w.name === "preparation" ? "steady reuse" : "checker", ready, () => {
    if (w.name !== "reuse" && w.name !== "preparation") meter.call("cold preparation", prepare);
    if (available("checkPrepared")) op("checkPrepared", policy, w.text);
    receipt = protect(w.text);
    if (count) receipt = op("concat", Array(count).fill(receipt));
    if (w.name === "invalidation") registry.addCredential("synthetic-generation-change");
    const original = read(receipt);
    validateCoverage(w, original);
    for (let i = 0; i < (w.name === "repeated" || w.name === "distinct" ? 64 : 1); i++) {
      read(receipt);
      if (["trim", "cutTail", "cutPrefix"].every(available)) {
        let derived = receipt;
        let want: Projection = w.reason
          ? original
          : { text: w.expected, truncated: w.name === "combining", checkedComplete: true, withheld: false };
        for (const [operation, limit] of [
          ["cutPrefix", w.name === "distinct" ? i : 4],
          ["cutTail", 4],
          ["trim", 0],
        ] as const) {
          derived = operation === "trim" ? op(operation, derived) : op(operation, derived, limit);
          want = rendering(want, operation, limit);
          const got = read(derived);
          if (keys.some((key) => got[key] !== want[key]))
            throw Error(`Invalid rendering: ${w.name}/${operation}`);
        }
      }
    }
  });
  if (!ready)
    await series("prepared check", available("checkPrepared"), () => op("checkPrepared", policy, w.text));
  const want = { text: w.expected, checkedComplete: true, withheld: false, truncated: false };
  if (w.name === "capture")
    await series("simulation:capture", ready, () => validateChunkings(parts, want, (s) => read(protect(s))));
  const consumer = () => meter.yieldNow().then(() => validateCoverage(w, read(receipt)));
  if (w.name === "consumers")
    await series("simulation:consumers", ready, () => Promise.all(range(4).map(consumer)));
  w.credentials.forEach((s, i) => void (a.registerCredential as Fn | undefined)?.(`SYNTHETIC_${i}`, s));
  for (const [k, ...rest] of [["redactCredentials"], ["privateMatches", w.entries]] as const)
    await series(`baseline:${k}`, available(k), () => op(k, w.text, ...rest), false);
  const raw = Object.values(groups).flatMap((g) => g.summary.raw);
  const { text: _text, expected: _expected, entries, credentials, cut: _cut, ...metadata } = w;
  const coverage = ready ? (w.reason ? "refusal" : "successful") : "unavailable";
  const counts = { platform: r.platform, coverage, entries: entries.length, credentials: credentials.length };
  return { ...metadata, ...counts, availability, groups, decision: decideC21c(raw) };
}
async function worker([root = "", name = "", ref = ""]: string[]) {
  const paths = ["proc", "credential-matcher", "privacy-boundary"].map((p) => join(root, `src/util/${p}.ts`));
  const found = [...paths, join(root, "src/gates/private.ts")].filter((p) => existsSync(p));
  const api = Object.assign({}, ...(await Promise.all(found.map((p) => import(p)))));
  return { ref, pid: process.pid, ...(await measureRevision(api, () => workload(name))) };
}
async function command(cmd: string[], cwd = process.cwd()) {
  const env = agentEnv({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const r = await runProcess({ cmd, cwd, env, tailLimit: 1_000_000 });
  if (r.exitCode !== 0 || r.truncated) throw Error(r.stderr || "Incomplete report");
  return r.stdout.trim();
}
async function launch({ ref, name }: Job) {
  const root = await fs.mkdtemp(join(tmpdir(), "privacy-boundary-"));
  const result = (async () => {
    const sha = await command(["git", "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
    await command(["git", "archive", `--output=${root}/snapshot.tar`, sha, "src"]);
    await command(["tar", "-xf", `${root}/snapshot.tar`, "-C", root]);
    await fs.symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    const raw = await command([process.execPath, import.meta.path, "--worker", root, name, sha], root);
    return { ref, name, report: JSON.parse(raw) as unknown };
  })();
  return { result, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
const args = process.argv.slice(2);
const names = args.length > 3 ? args.slice(3) : Object.keys(expectations);
if (import.meta.main && args[0] === "--worker") console.log(JSON.stringify(await worker(args.slice(1))));
else if (import.meta.main) {
  if (args.length < 3 || names.some((n) => !(n in expectations))) throw Error("Need 3 refs, known workloads");
  const results = await runRevisions(args.slice(0, 3), names, launch);
  console.log(JSON.stringify({ admissionMatrix, notes: "baseline: no receipts/provenance parity", results }));
}
