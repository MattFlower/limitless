import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateMatches } from "../src/gates/private.ts";
import {
  type BoundaryText,
  type Cut,
  createPrivacyBoundary,
  cutBoundaryText,
  preparePrivacyPolicy,
  protectData,
  protectJsonText,
  protectText,
  WITHHELD,
} from "../src/util/privacy-boundary.ts";
import { agentEnv, runProcess } from "../src/util/proc.ts";

const entries = [{ value: "host.example", entry: 1 }];
const policy = await preparePrivacyPolicy({ entries, credentials: [] });
const provenance = { kind: "complete" } as const;
const protect = (text: string, cut?: Cut) => protectText({ text, cut, policy, provenance });

for (const unit of ["U", "B", "CP"] as const) {
  for (const from of ["start", "end"] as const) {
    test(`combining-mark ${unit} ${from} cuts revalidate exact rendering`, async () => {
      // Removing the base of an NFKC combining sequence can expose a private tail too.
      const raw = from === "start" ? "host.example\u0301" : "e\u0301host.example";
      const tailEntries = from === "start" ? entries : [{ value: "\u0301host.example", entry: 1 }];
      expect(privateMatches(raw, tailEntries)).toEqual([]);
      const limit = from === "start" ? 12 : unit === "B" ? 14 : 13;
      const cut = { unit, from, limit };
      const p = await preparePrivacyPolicy({ entries: tailEntries, credentials: [] });
      const uncut = await protectText({ text: raw, provenance, policy: p });
      expect(uncut).toMatchObject({ text: raw, withheld: false, truncated: false, checkedComplete: true });
      if (from === "start") expect(privateMatches(raw.slice(0, 12), entries)).toHaveLength(1);
      for (const result of [
        await protectText({ text: raw, provenance, policy: p, cut }),
        await cutBoundaryText(uncut, cut),
      ]) {
        expect(result).toMatchObject({
          text: WITHHELD,
          withheld: true,
          truncated: true,
          reason: "private-match",
          checkedComplete: true,
        });
        expect(result.text).not.toContain("host.example");
      }
    });
  }
}

test("complete decoded checks precede overlapping credential replacement and terminal stripping", async () => {
  const p = await preparePrivacyPolicy({ entries, credentials: ["host.exam"] });
  for (const text of ["host.example", "host.exam%70le", "ｈｏｓｔ．ｅｘａｍｐｌｅ", "host.\x1b[31mexample"]) {
    const result = await protectText({ text, policy: p, provenance, terminal: true });
    expect(result).toMatchObject({
      text: WITHHELD,
      withheld: true,
      reason: "private-match",
      truncated: false,
    });
    for (const fragment of ["host.exam", "ple", "p"])
      expect(result.text.replace(WITHHELD, "")).not.toContain(fragment);
  }
  expect(
    await protectText({ text: "\x1b[31mclean\x1b[0m", policy: p, provenance, terminal: true }),
  ).toMatchObject({ text: "clean", withheld: false, truncated: false, checkedComplete: true });
  // Refused terminal text measures clipping on the visible rendering the cut would see.
  for (const [limit, truncated] of [
    [12, false],
    [11, true],
  ] as const) {
    for (const text of ["host.example", "\x1b[31mhost.example\x1b[0m"]) {
      const cut = { unit: "U", from: "start", limit } as const;
      expect(await protectText({ text, policy, provenance, terminal: true, cut })).toMatchObject({
        text: WITHHELD,
        reason: "private-match",
        truncated,
      });
    }
  }
});

test("actual clipping, provenance, immutable issuance and digest checks", async () => {
  const cut = { unit: "U", from: "start", limit: 4000 } as const;
  expect(await protect(`${"x".repeat(3995)}host.`, cut)).toMatchObject({
    withheld: false,
    truncated: false,
    checkedComplete: true,
  });
  expect(await protect(`${"x".repeat(3995)}host.x`, cut)).toMatchObject({
    text: WITHHELD,
    withheld: true,
    truncated: true,
  });
  for (const [source, truncated] of [
    [{ kind: "cut", truncated: true }, true],
    [{ kind: "legacy-unknown" }, undefined],
  ] as const) {
    expect(await protectText({ text: "clean", policy, provenance: source })).toMatchObject({
      text: WITHHELD,
      truncated,
      withheld: true,
      checkedComplete: false,
    });
  }
  const equivalent = await preparePrivacyPolicy({ entries, credentials: [] });
  expect(equivalent.policyDigest).toBe(policy.policyDigest);
  const original = await protect("clean");
  expect(Object.isFrozen(original)).toBe(true);
  expect(await cutBoundaryText(original, cut, equivalent)).toMatchObject({ text: "clean", withheld: false });
  const different = await preparePrivacyPolicy({ entries: [], credentials: ["synthetic-other"] });
  for (const source of [
    { ...original } as BoundaryText,
    await protectText({ text: "clean", policy: different, provenance }),
  ]) {
    expect(await cutBoundaryText(source, cut, policy)).toMatchObject({
      text: WITHHELD,
      withheld: true,
      reason: "unverified-provenance",
    });
  }
  const clipped = await protect("ordinary text", { unit: "U", from: "start", limit: 4 });
  expect(clipped.truncated).toBe(true);
  expect(await cutBoundaryText(clipped, cut)).toMatchObject({
    text: "ordi",
    truncated: true,
    withheld: false,
  });
  expect(
    await protectText({
      text: "ordi",
      provenance: { kind: "cut", truncated: true, source: original },
      policy,
    }),
  ).toMatchObject({ text: "ordi", truncated: true, checkedComplete: true });
});

test("UTF-16, code point and byte cuts preserve encoding at both boundaries", async () => {
  for (const from of ["start", "end"] as const) {
    for (const unit of ["U", "B", "CP"] as const) {
      expect(await protect("clean", { unit, from, limit: 0 })).toMatchObject({
        text: "",
        truncated: true,
        withheld: false,
      });
    }
    const text = from === "start" ? "a😀b" : "b😀a";
    for (const [unit, limit, expected] of [
      ["U", 2, "a"],
      ["CP", 2, from === "start" ? "a😀" : "😀a"],
      ["B", 4, "a"],
    ] as const) {
      expect(await protect(text, { unit, limit, from })).toMatchObject({
        text: expected,
        truncated: true,
        withheld: false,
      });
    }
  }
});

test("fixed refusals for policy, encoding, convergence, input, pending and decoder-form caps", async () => {
  let nested = "%61";
  for (let i = 0; i < 7; i++) nested = nested.replaceAll("%", "%25");
  const empty = await preparePrivacyPolicy({ entries: [], credentials: [] });
  const wide = await preparePrivacyPolicy({ entries: [{ value: "\ufdfa", entry: 1 }], credentials: [] });
  const cases = [
    [
      protectText({ text: "synthetic-secret", policy: null, provenance }),
      "policy-unreadable",
      "synthetic-secret",
    ],
    [protectText({ text: nested, policy: empty, provenance }), "nonconvergence", nested],
    [protect("synthetic-\ud800"), "invalid-input-encoding", "synthetic-\ud800"],
    [
      createPrivacyBoundary({ caps: { input: 3 } }).protectText({ text: "cap-overflow", policy, provenance }),
      "resource-refusal",
      "cap-overflow",
    ],
    [
      createPrivacyBoundary({ caps: { pending: 3 } }).protectText({
        text: "pending-overflow",
        policy,
        provenance,
      }),
      "resource-refusal",
      "pending-overflow",
    ],
    [
      createPrivacyBoundary({ caps: { form: 3 } }).protectText({
        text: "form-overflow",
        policy: wide,
        provenance,
      }),
      "resource-refusal",
      "form-overflow",
    ],
  ] as const;
  for (const [promise, reason, synthetic] of cases) {
    const result = await promise;
    expect(result).toMatchObject({ text: WITHHELD, withheld: true, reason });
    expect(JSON.stringify(result)).not.toContain(synthetic);
  }
  const bounded = createPrivacyBoundary({ caps: { pending: 350 } });
  const [accepted, overflow] = await Promise.all([
    bounded.protectText({ text: "x".repeat(80), provenance, policy }),
    bounded.protectText({ text: "y".repeat(80), provenance, policy }),
  ]);
  expect(accepted).toMatchObject({ withheld: false, truncated: false });
  expect(overflow).toMatchObject({ text: WITHHELD, reason: "resource-refusal" });
  const limited = createPrivacyBoundary({ caps: { form: 3 } });
  for (let repeat = 0; repeat < 2; repeat++) {
    expect(await limited.protectText({ text: "ok", provenance, policy: wide })).toMatchObject({
      reason: "resource-refusal",
      text: WITHHELD,
    });
  }
  expect(await protectJsonText(JSON.stringify({ value: "\ud800" }), provenance, policy)).toEqual({
    value: WITHHELD,
  });
  for (const size of [32, 64, 128]) {
    const run = "\\".repeat(size * 1024);
    expect(await protect(`${run}\\u00`)).toMatchObject({ withheld: false, truncated: false });
    expect(await protect(`${run} host.example`)).toMatchObject({ text: WITHHELD, reason: "private-match" });
  }
});

test("prepared worker matches decoded matcher corpus including credential entries", async () => {
  const credentials = ["credential-synthetic", "host/path.example"];
  const corpusEntries = [
    ...entries,
    { value: "private phrase", entry: 2 },
    { value: String.raw`host\/path.example`, entry: 3 },
  ];
  const all = [...corpusEntries, ...credentials.map((value) => ({ value, entry: -1 }))];
  const p = await preparePrivacyPolicy({ entries: corpusEntries, credentials });
  const host = entries[0]?.value ?? "";
  const percent = (text: string) => Array.from(Buffer.from(text), (byte) => `%${byte.toString(16)}`).join("");
  const corpus = [
    host,
    percent(host),
    percent(percent(host)),
    String.raw`host.exam\u0070le`,
    "host.exam&#112;le",
    "ｈｏｓｔ．ｅｘａｍｐｌｅ",
    String.raw`host\/path.example`,
    "ordinary text",
    "private\n\tphrase",
    percent(String.raw`host\/path.example`),
    "host.%2",
    "credential-synthetic",
  ];
  let nested = "%61";
  for (let i = 0; i < 7; i++) nested = nested.replaceAll("%", "%25");
  corpus.push(nested);
  for (let offset = 0; offset < 4; offset++) {
    for (const value of [host, "private phrase"]) {
      const base64 = Buffer.from(value).toString("base64");
      corpus.push("A".repeat(offset) + base64, "A".repeat(offset) + base64.replace(/=+$/, ""));
    }
  }
  for (const text of corpus) {
    const result = await protectText({ text, policy: p, provenance });
    expect(result.withheld).toBe(privateMatches(text, all).length > 0);
    const clipped = await protectText({
      text: `${text}z`,
      policy: p,
      provenance,
      cut: { limit: text.length, unit: "U", from: "start" },
    });
    expect(clipped.withheld).toBe(
      privateMatches(`${text}z`, all).length > 0 || privateMatches(text, all, true).length > 0,
    );
  }
});

test("batched recursive and JSON adapters protect keys, values, numbers and sibling objects", async () => {
  const p = await preparePrivacyPolicy({ entries, credentials: ["123456789"] });
  expect(
    await protectData(
      {
        ok: { a: "clean" },
        bad: { note: "x host.example" },
        keyed: { "host.example": 1, other: 2 },
        n: 123456789,
      },
      provenance,
      p,
    ),
  ).toEqual({ ok: { a: "clean" }, bad: { note: WITHHELD }, keyed: WITHHELD, n: WITHHELD });
  expect(await protectData({ nested: { "host.example": 1, "x host.example": 2 } }, provenance, p)).toEqual({
    nested: WITHHELD,
  });
  expect(
    await protectJsonText('{"a":"host.example","b":"host.example","host.example":"c"}', provenance, p),
  ).toBe(WITHHELD);
  expect(await protectJsonText('{"a":"host.example","b":"host.example"}', provenance, p)).toEqual({
    a: WITHHELD,
    b: WITHHELD,
  });
  expect(await protectJsonText('{"a":"host.example"', provenance, p)).toBe(WITHHELD);
  for (const prov of [{ kind: "legacy-unknown" }, { kind: "cut", truncated: true }] as const) {
    expect(await protectData({ a: "clean" }, prov, p)).toBe(WITHHELD);
    expect(await protectJsonText('{"a":"clean"}', prov, p)).toBe(WITHHELD);
  }
  expect(await protectData({ a: "clean" }, provenance, null)).toBe(WITHHELD);
  expect(await protectJsonText('"clean"', provenance, null)).toBe(WITHHELD);
  expect(await protectData(JSON.parse('{"__proto__":{"a":"clean"}}'), provenance, p)).toEqual(
    JSON.parse('{"__proto__":{"a":"clean"}}'),
  );
  // Inherited graphs are refused before enumeration rather than walked and discarded.
  expect(await protectData({ ok: Object.create({ inherited: "host.example" }) }, provenance, p)).toBe(
    WITHHELD,
  );
  expect(await protectData(Object.assign(Object.create(null), { a: "clean" }), provenance, p)).toEqual({
    a: "clean",
  });
});

test("adapter field refusals and transformed-key collisions stay local", async () => {
  let nested = "%61";
  for (let i = 0; i < 7; i++) nested = nested.replaceAll("%", "%25");
  const empty = await preparePrivacyPolicy({ entries: [], credentials: [] });
  const value = { ok: "clean", refusal: nested };
  expect(await protectData(value, provenance, empty)).toEqual({ ok: "clean", refusal: WITHHELD });
  expect(await protectJsonText(JSON.stringify(value), provenance, empty)).toEqual({
    ok: "clean",
    refusal: WITHHELD,
  });
  const p = await preparePrivacyPolicy({ entries: [], credentials: ["a\r\nb"] });
  expect(await protectData({ nested: { "a\nb": 1, "[redacted]": 2 }, ok: "clean" }, provenance, p)).toEqual({
    nested: WITHHELD,
    ok: "clean",
  });
});

test("checker exit and error settle pending work and allow recovery", async () => {
  for (const throws of [false, true]) {
    process.env.PRIVACY_FIXTURE_THROW = throws ? "1" : "0";
    const pool = createPrivacyBoundary({
      workerPath: new URL("./fixtures/privacy-checker-failure.ts", import.meta.url),
    });
    const results = await Promise.all(
      Array.from({ length: 3 }, () => pool.protectText({ text: "unverified-synthetic", policy, provenance })),
    );
    for (const result of results)
      expect(result).toMatchObject({ text: WITHHELD, reason: "checker-unavailable", withheld: true });
    pool.setWorkerPath(new URL("../src/util/privacy-boundary-worker.ts", import.meta.url));
    expect(await pool.protectText({ text: "clean", policy, provenance })).toMatchObject({
      text: "clean",
      withheld: false,
    });
  }
  delete process.env.PRIVACY_FIXTURE_THROW;
});

test("an idle checker never holds a subprocess open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "privacy-exit-"));
  try {
    const module = new URL("../src/util/privacy-boundary.ts", import.meta.url).href;
    const script = `import {protectText,preparePrivacyPolicy} from ${JSON.stringify(module)}; const policy=await preparePrivacyPolicy({entries:[],credentials:[]}); const result=await protectText({text:"clean",policy,provenance:{kind:"complete"}}); if(result.text!=="clean") process.exit(2);`;
    const result = await runProcess({
      cmd: [process.execPath, "-e", script],
      cwd: dir,
      env: agentEnv(),
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
