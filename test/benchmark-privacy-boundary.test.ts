import { expect, test } from "bun:test";
import {
  admissionMatrix,
  decideC21c,
  instrument,
  measureRevision,
  runRevisions,
  sizes,
  structure,
  summarizeTrials,
  validateChunkings,
  validateCoverage,
  wholeSlices,
  workload,
} from "../scripts/benchmark-privacy-boundary.ts";
import { createCredentialRegistry, credentialVariants } from "../src/util/credential-matcher.ts";
import * as boundary from "../src/util/privacy-boundary.ts";
import {
  capturePrivacySnapshot,
  consumeBoundaryText,
  createPrivacyRegistry,
  preparePrivacyPolicy,
  privacyLimits,
  protectData,
  protectText,
} from "../src/util/privacy-boundary.ts";

const tiny = {
  ...privacyLimits,
  inputUnits: 256,
  outputUnits: 256,
  entries: 2,
  credentials: 4,
  originalLength: 128,
  originalsTotal: 512,
  variantsTotal: 3200,
  formLength: 1024,
  formsTotal: 2048,
  depth: 3,
  nodes: 8,
};
const sample = (slice: number, warmup = false, admitted = true, owned = true) => ({
  slice,
  warmup,
  admitted,
  owned,
  heartbeat: 75,
});

test("independent units, recursive keys/containers and successful maxima", () => {
  expect(["a", "界", "😀"].map(sizes)).toEqual([
    { units: 1, codePoints: 1, bytes: 1 },
    { units: 1, codePoints: 1, bytes: 3 },
    { units: 2, codePoints: 1, bytes: 4 },
  ]);
  expect(structure({ k: [1, { x: null }] })).toEqual({ depth: 3, nodes: 7 });
  for (const name of [
    "ascii-max",
    "bmp-max",
    "astral-max",
    "recursive-max",
    "depth",
    "nodes",
    "combined",
    "preparation",
  ]) {
    const w = workload(name, tiny),
      registry = createPrivacyRegistry(createCredentialRegistry());
    registry.replacePolicy(w.entries);
    w.credentials.forEach(registry.addCredential);
    const policy = preparePrivacyPolicy(capturePrivacySnapshot(registry), { limits: tiny });
    const input = { provenance: { kind: "complete" as const }, policy };
    const receipt = w.data
      ? protectData({ ...input, json: w.text }, { registry })
      : protectText({ ...input, text: w.text }, { registry });
    expect(() => validateCoverage(w, consumeBoundaryText(receipt))).not.toThrow();
    expect(() => validateCoverage(w, { text: "", checkedComplete: false, withheld: true })).toThrow();
    if (name.endsWith("-max")) expect(w.sizes.units).toBe(256);
    if (name === "astral-max") expect(w.sizes).toEqual({ units: 256, codePoints: 128, bytes: 512 });
    if (name === "combined") expect(w.shape).toEqual({ depth: 3, nodes: 8 });
    if (name === "preparation") {
      expect(w.entries.length).toBe(2);
      expect(w.credentials.length).toBe(4);
      expect([...w.entries.map((e) => e.value), ...w.credentials].reduce((n, s) => n + s.length, 0)).toBe(
        512,
      );
      expect(
        [
          ...new Set(w.credentials.flatMap(credentialVariants)),
          ...w.entries.map((e) => e.value.normalize("NFKC")),
        ].join("").length,
      ).toBeLessThanOrEqual(3200);
    }
  }
});
test("warmups affect worst slice, five timed trials determine median and raw evidence remains", () => {
  const raw = [sample(90, true), sample(80, true), ...[10, 11, 12, 13, 14].map((n) => sample(n))];
  expect(summarizeTrials(raw)).toEqual({ raw, median: 12, worstSlice: 90 });
});
test("whole slices merge no-yield calls and nested phases, split at yields, apart from heartbeat", async () => {
  let clock = 100;
  const { call, phases, yields, yieldNow } = instrument(
    () => clock,
    async () => {
      clock += 500;
    },
  );
  const work = (ms: number) => () =>
    call("phase", () => {
      clock += ms;
    });
  for (let i = 0; i < 3; i++) call("entry", work(20));
  await yieldNow();
  call("entry", work(30));
  expect(yields).toEqual([660]);
  expect(wholeSlices(phases, yields)).toEqual([60, 30]);
  expect(summarizeTrials([sample(Math.max(...wholeSlices(phases, yields)))])).toMatchObject({
    worstSlice: 60,
    raw: [{ heartbeat: 75 }],
  });
});
test("strict threshold covers admitted refusals and warmups but excludes outside observations", () => {
  expect(decideC21c([sample(50)]).trigger).toBe(false);
  const refusal = { ...sample(50.001), outcome: "refusal" };
  expect(decideC21c([refusal]).trigger).toBe(true);
  expect(decideC21c([sample(51, true)]).trigger).toBe(true);
  const excluded = [sample(500, false, false), sample(500, false, true, false)];
  expect(decideC21c(excluded)).toMatchObject({ trigger: false, excluded });
});
function fakeRevision(kind = "b") {
  let clock = 0,
    preparations = 0,
    pending = 0,
    overlap = 0;
  const policies: unknown[] = [];
  const tick = <T>(n: number, value: T) => {
    clock += n;
    return value;
  };
  const api: Record<string, unknown> = {
    createCredentialRegistry: () => tick(1, {}),
    createPrivacyRegistry: () => tick(1, { replacePolicy: () => {}, addCredential: () => {} }),
    capturePrivacySnapshot: () => tick(2, {}),
    preparePrivacyPolicy: (_s: unknown, o: { counters: { registrations: number } }) => {
      o.counters.registrations++;
      return tick(3, ++preparations);
    },
    checkPrepared: () => tick(2, {}),
    protectText: ({ text, policy }: { text: string; policy: unknown }) => {
      policies.push(policy);
      return tick(4, { text, checkedComplete: true, withheld: false, truncated: false });
    },
    consumeBoundaryText: (receipt: unknown) => tick(5, receipt),
    registerCredential: () => {},
    redactCredentials: () => tick(6, "."),
    privateMatches: () => tick(7, []),
  };
  if (kind === "b") api.protectData = api.protectText;
  if (kind === "main") delete api.preparePrivacyPolicy;
  const runtime = {
    platform: ["fake-bun", "fake-os", "fake-release", "fake-arch"],
    now: () => clock,
    memory: () => ({ heap: 17, peakRSS: 33 }),
    gc: () => {},
    pause: () =>
      new Promise<void>((done) => {
        overlap = Math.max(overlap, ++pending);
        queueMicrotask(() => {
          clock += 100;
          pending--;
          done();
        });
      }),
  };
  const fixture = (name: string) => {
    clock += 1000;
    return workload(name, tiny);
  };
  return { api, runtime, fixture, policies, overlap: () => overlap, preparations: () => preparations };
}
test.each(["cutPrefix", "cutTail", "trim"] as const)(
  "rejects forged or incorrect %s renderings",
  async (operation) => {
    const { runtime } = fakeRevision();
    const fixture = () => ({
      ...workload("distinct", tiny),
      text: " \te\u0301😀x ",
      expected: " \te\u0301😀x ",
      entries: [],
      credentials: [],
    });
    const api = { ...boundary, createCredentialRegistry };
    await expect(measureRevision(api, fixture, runtime)).resolves.toMatchObject({ coverage: "successful" });
    const incorrect = operation === "cutPrefix" ? () => ({}) : (receipt: unknown) => receipt;
    await expect(measureRevision({ ...api, [operation]: incorrect }, fixture, runtime)).rejects.toThrow(
      `Invalid rendering: distinct/${operation}`,
    );
    const refusal = () => ({
      ...fixture(),
      name: "sparse",
      entries: [{ entry: 0, value: "x" }],
      reason: "private-match",
    });
    await expect(measureRevision(api, refusal, runtime)).resolves.toMatchObject({ coverage: "refusal" });
    await expect(measureRevision({ ...api, [operation]: () => ({}) }, refusal, runtime)).rejects.toThrow(
      `Invalid rendering: sparse/${operation}`,
    );
  },
);
test("an admitted refusal workload over 50 ms triggers the decision; exactly 50 ms does not", async () => {
  for (const [step, trigger] of [
    [51, true],
    [50, false],
  ] as const) {
    let clock = 0;
    const runtime = { platform: [], now: () => clock, memory: () => ({ heap: 0, peakRSS: 0 }), gc: () => {} };
    const slow = (...args: Parameters<typeof protectText>) => {
      clock += step;
      return protectText(...args);
    };
    const api = { ...boundary, createCredentialRegistry, protectText: slow };
    const fixture = () => ({
      ...workload("sparse", tiny),
      text: "x",
      entries: [{ entry: 0, value: "x" }],
      credentials: [],
      reason: "private-match",
    });
    const report = await measureRevision(api, fixture, { ...runtime, pause: async () => {} });
    expect(report).toMatchObject({ coverage: "refusal", decision: { trigger } });
  }
});
test("evidence reports decoded forms and matching scans per preparation", async () => {
  const { runtime } = fakeRevision();
  const report = await measureRevision(
    { ...boundary, createCredentialRegistry },
    () => ({
      ...workload("plain", tiny),
      text: "%252E",
      expected: "%252E",
      entries: [{ entry: 0, value: "synthetic-private" }],
      credentials: [],
    }),
    runtime,
  );
  const raw = report.groups.checker?.summary.raw;
  expect(raw).toHaveLength(7);
  // Each check visits raw + six forms in each of three rounds (%252E -> %2E -> . -> .).
  // Nineteen credential passes plus three distinct normalized private forms = 22 scans.
  // Three full checks; prefix/tail/trim check %252, which settles in two rounds (13 forms, 15 scans).
  for (const trial of raw ?? [])
    expect(trial).toMatchObject({ counters: { forms: 3 * 19 + 3 * 13, scans: 3 * 22 + 3 * 15 } });
});
test("real worker orchestration excludes fixtures, probes baseline gaps and cleans owned revisions", async () => {
  let pid = 0;
  const cleaned: number[] = [];
  const results = await runRevisions(["main", "a", "b"], ["depth"], async ({ ref, name }) => {
    const f = fakeRevision(ref),
      id = ++pid;
    return {
      result: measureRevision(f.api, () => f.fixture(name), f.runtime).then((report) => ({
        pid: id,
        ...report,
      })),
      cleanup: async () => {
        cleaned.push(id);
      },
    };
  });
  expect(results.map((r) => r.pid)).toEqual([1, 2, 3]);
  expect(cleaned).toEqual([1, 2, 3]);
  for (const result of results) {
    expect(result.platform).toEqual(["fake-bun", "fake-os", "fake-release", "fake-arch"]);
    expect(result.groups["baseline:redactCredentials"]?.summary).toMatchObject({ median: 6, worstSlice: 6 });
    expect(result.groups["baseline:privateMatches"]?.summary).toMatchObject({ median: 7, worstSlice: 7 });
  }
  expect(results[0]?.groups["cold preparation"]).toMatchObject({
    status: "unavailable",
    summary: { raw: [], median: null },
  });
  for (const result of results.slice(0, 2)) {
    expect(result.coverage).toBe("unavailable");
    expect(result.availability.protectData).toBe("unavailable");
    expect(result.groups.checker).toMatchObject({
      status: "unavailable",
      summary: { raw: [], worstSlice: null },
    });
  }
  expect(results[2]?.groups["cold preparation"]?.summary).toMatchObject({ median: 7, worstSlice: 7 });
  const raw = results[2]?.groups.checker?.summary.raw;
  expect(raw).toHaveLength(7);
  expect(raw?.[0]).toMatchObject({
    slice: 23,
    heapDelta: 0,
    retainedHeap: 17,
    peakRSS: 33,
    counters: { registrations: 1 },
  });
  await expect(
    runRevisions(["bad"], ["plain"], async () => ({
      result: Promise.reject(Error("bad")),
      cleanup: async () => {
        cleaned.push(4);
      },
    })),
  ).rejects.toThrow("bad");
  expect(cleaned).toEqual([1, 2, 3, 4]);
  const partial = await runRevisions(["b"], ["streams", "plain"], async ({ ref, name }) => {
    const f = fakeRevision(ref);
    return { result: measureRevision(f.api, () => f.fixture(name), f.runtime), cleanup: async () => {} };
  });
  expect(partial.map((r) => [r.availability.concat, r.coverage])).toEqual([
    ["unavailable", "unavailable"],
    ["unavailable", "successful"],
  ]);
  expect(partial[0]?.groups.checker).toMatchObject({ status: "unavailable", summary: { raw: [] } });
  const invalid = fakeRevision();
  invalid.api.protectData = () => ({ text: "[withheld: private text]", withheld: true });
  await expect(measureRevision(invalid.api, () => invalid.fixture("depth"), invalid.runtime)).rejects.toThrow(
    "Invalid coverage",
  );
});
test("maximum policy is prepared before steady reuse; scheduled consumers and capture have separate records", async () => {
  const f = fakeRevision(),
    w = f.fixture("reuse");
  expect(w.entries).toHaveLength(tiny.entries);
  expect(w.credentials).toHaveLength(tiny.credentials);
  expect([...w.entries.map((e) => e.value), ...w.credentials].join("").length).toBe(tiny.originalsTotal);
  const reuse = await measureRevision(f.api, () => w, f.runtime);
  expect(f.preparations()).toBe(7);
  expect(f.policies).toEqual(Array(7).fill(7));
  expect(reuse.groups["steady reuse"]?.summary).toMatchObject({ median: 16, worstSlice: 16 });
  const g = fakeRevision(),
    consumers = await measureRevision(g.api, () => g.fixture("consumers"), g.runtime);
  expect(g.overlap()).toBeGreaterThanOrEqual(4);
  expect(g.overlap()).toBeLessThanOrEqual(8);
  const summary = consumers.groups["simulation:consumers"]?.summary;
  expect(summary?.raw).toHaveLength(7);
  expect(summary).toMatchObject({ median: 20, worstSlice: 20 });
  expect(summary?.raw.every((s) => "receiptReuse" in s && s.receiptReuse === 4)).toBe(true);
  const capture = await measureRevision(g.api, () => g.fixture("capture"), g.runtime);
  expect(capture.groups["simulation:capture"]?.summary).toMatchObject({ median: 36, worstSlice: 36 });
  expect(capture.groups.checker?.summary).toMatchObject({ median: 23 });
});
test("chunking validates assembled bytes and each provenance field against independent expectations", () => {
  const text = "😀 \\u002E",
    bytes = Buffer.from(text),
    expected = { text, truncated: false, checkedComplete: true, withheld: false };
  const parts = [1, 6].map((i) => [bytes.subarray(0, i), bytes.subarray(i)]);
  expect(() => validateChunkings(parts, expected, (text) => ({ ...expected, text }))).not.toThrow();
  for (const change of [
    { text: "😀 \\u002F" },
    { truncated: true },
    { checkedComplete: false },
    { withheld: true },
    { reason: "private-match" as const },
  ]) {
    expect(() => validateChunkings(parts, expected, (text) => ({ ...expected, text, ...change }))).toThrow();
  }
  expect(() => validateChunkings(parts, { ...expected, text: "😀 \\u002F" }, () => expected)).toThrow();
});
test("caller admission distinguishes source caps, display cuts and real policy metadata", () => {
  expect(admissionMatrix.find((r) => r.caller === "sh")).toMatchObject({
    sourceUnits: 50_000_000,
    status: "refused",
  });
  expect(admissionMatrix.find((r) => r.caller === "codex display")).toMatchObject({
    sourceUnits: null,
    outputCap: 20_000,
    status: "not-covered",
  });
  const w = workload("ascii-5Mi");
  expect(w.sizes).toEqual({ units: 5242880, codePoints: 5242880, bytes: 5242880 });
  expect(w.admitted).toBe(true);
  expect(w.entries.length).toBe(8);
  expect(w.credentials.length).toBe(600);
  expect(w.limits).toEqual(privacyLimits);
  const maximumPolicy = workload("reuse");
  expect(maximumPolicy.entries).toHaveLength(64);
  expect(maximumPolicy.credentials).toHaveLength(1024);
});

test("cap refusal fixtures reach the intended guard without reducing admission limits", () => {
  for (const [name, reason] of Object.entries({
    "entries+1": "entries-count",
    "credentials+1": "credentials-count",
    "original+1": "original-length",
    "aggregate+1": "originals-total",
    "variants+1": "variants-total",
  })) {
    const w = workload(name, tiny),
      registry = createPrivacyRegistry(createCredentialRegistry());
    registry.replacePolicy(w.entries);
    w.credentials.forEach(registry.addCredential);
    expect(preparePrivacyPolicy(capturePrivacySnapshot(registry), { limits: tiny })).toMatchObject({
      refused: reason,
    });
  }
  for (const [name, reason] of Object.entries({
    "input+1": "input-length",
    "form+1": "form-length",
    "forms+1": "forms-total",
    "depth+1": "json-depth",
    "nodes+1": "json-nodes",
    nonconvergent: "nonconvergent",
    malformed: "ill-formed",
    "output+1": "output-length",
  })) {
    const w = workload(name, tiny),
      registry = createPrivacyRegistry(createCredentialRegistry());
    const policy = preparePrivacyPolicy(capturePrivacySnapshot(registry), { limits: tiny });
    const input = {
      provenance: { kind: "complete" as const },
      policy,
      cut: w.cut && { ...w.cut, unit: "U" as const },
    };
    const receipt = w.data
      ? protectData({ ...input, json: w.text }, { registry })
      : protectText({ ...input, text: w.text }, { registry });
    expect(consumeBoundaryText(receipt)).toMatchObject({ withheld: true, reason });
  }
});

test("terminal workloads exercise replacement with independently known safe bytes", () => {
  for (const name of ["sgr", "osc"]) {
    const w = workload(name, tiny),
      registry = createPrivacyRegistry(createCredentialRegistry());
    registry.replacePolicy(w.entries);
    w.credentials.forEach(registry.addCredential);
    const policy = preparePrivacyPolicy(capturePrivacySnapshot(registry), { limits: tiny });
    const result = consumeBoundaryText(
      protectText({ text: w.text, policy, terminal: true, provenance: { kind: "complete" } }, { registry }),
    );
    expect(result).toMatchObject({
      text: "[redacted]",
      checkedComplete: true,
      withheld: false,
      truncated: false,
    });
    expect(() => validateCoverage(w, result)).not.toThrow();
  }
});

test("refusal coverage requires safe marker bytes and never supplies successful maximum coverage", () => {
  const w = workload("sparse", tiny),
    refused = { text: "[withheld: private text]", withheld: true, reason: "private-match" as const };
  expect(() => validateCoverage(w, refused)).not.toThrow();
  expect(() => validateCoverage(w, { ...refused, text: w.text })).toThrow();
  expect(() => validateCoverage({ ...w, maximum: true }, refused)).toThrow();
});
