import { expect, test } from "bun:test";
import { CredentialMatcher, credentialMatcher, type MatchingWork } from "../src/util/credential-matcher.ts";
import {
  agentEnv,
  credentialRedactionPadding,
  redactCredentialData,
  redactCredentials,
  registerCredential,
  registeredCredentials,
} from "../src/util/proc.ts";

function variants(values: string[]) {
  const result = new Map<string, boolean>();
  for (const value of values.filter(Boolean))
    for (const text of [value, JSON.stringify(value).slice(1, -1)])
      result.set(text, result.get(text) || value.length >= 8);
  return result;
}
// Independent copy of the previous implementation, restricted to marker-free dictionaries.
function legacy(text: string, values: string[]) {
  for (const [secret, substring] of [...variants(values)].sort(([a], [b]) => b.length - a.length))
    if (substring || text === secret) text = text.split(secret).join("[redacted]");
  return text;
}

test("fixed and seeded randomized redaction agrees with legacy on original-text matches", () => {
  const values = [
    "seven77",
    "eight888",
    '"'.repeat(7),
    '"'.repeat(8),
    "abcdefgh",
    "cdefghij",
    "abcdefghijk",
    "line\nkey\\tail",
    "🔑🔑🔑🔑",
  ];
  let seed = 706;
  const random = (n: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let round = 0; round < 80; round++) {
    const registrations = [...values];
    for (let i = 0; i < 20; i++) {
      let value = "";
      for (let j = 0, length = 1 + random(16); j < length; j++) value += 'abcde"\\\n'.charAt(random(8));
      registrations.push(value);
    }
    const matcher = new CredentialMatcher(variants(registrations));
    for (const value of registrations) {
      for (const input of [
        value,
        JSON.stringify(value).slice(1, -1),
        `x${value}y`,
        `${value}|${value}`,
        "",
      ]) {
        expect(matcher.redact(input)).toBe(legacy(input, registrations));
      }
    }
    let input = "";
    for (let i = 0; i < 100; i++) input += registrations[random(registrations.length)] ?? "";
    expect(matcher.redact(input)).toBe(legacy(input, registrations));
  }
});

test("original spans use descending length, registration order, then occurrence order", () => {
  const redact = (values: string[], text: string) => new CredentialMatcher(variants(values)).redact(text);
  expect(redact(["abcdefgh", "cdefghij"], "abcdefghij")).toBe("[redacted]ij");
  expect(redact(["cdefghij", "abcdefgh"], "abcdefghij")).toBe("ab[redacted]");
  // A longest output is blocked; its shorter suffix still fits after the winning span.
  expect(redact(["abcdefghij", "ijklmnop", "klmnopqr"], "abcdefghijklmnopqr")).toBe("[redacted][redacted]");
  expect(redact(["aaaaaaaa"], "aaaaaaaaa")).toBe("[redacted]a");
  expect(redact(["redacted", "synthetic-redacted-value"], "synthetic-redacted-value redacted")).toBe(
    "[redacted] [redacted]",
  );
  expect(redact(["redacted", "[redacted]"], "[redacted]")).toBe("[redacted]");
  expect(redact(['"'.repeat(7)], `x${'\\"'.repeat(7)}y`)).toBe(`x${'\\"'.repeat(7)}y`);
});

test("publication windows retain whole markers from original overlapping spans", () => {
  const long = "synthetic-redacted-value";
  const overlap = "abcdefghijk";
  const matcher = new CredentialMatcher(variants(["redacted", long, "abcdefgh", overlap]));
  const input = `x ${long} y ${overlap} z redacted!`;
  const second = input.indexOf(overlap);
  for (const [window, expected] of [
    [{ start: 0, end: 4 }, "x [redacted]"],
    [{ start: 4, end: second + 2 }, "[redacted] y [redacted]"],
    [{ start: 2 + long.length, end: input.length }, " y [redacted] z [redacted]!"],
    [{ start: 2, end: 2 + long.length }, "[redacted]"],
    [{ start: 4, end: 4 }, "[redacted]"],
    [{ start: 0, end: 2 }, "x "],
    [{ start: 0, end: 0 }, ""],
  ] as const) {
    expect(matcher.redact(input, undefined, window)).toBe(expected);
  }
  const short = new CredentialMatcher(variants(["seven77"]));
  const window = { start: 1, end: 4 };
  expect(short.redact("seven77", undefined, window)).toBe("[redacted]");
  expect(short.redact("xseven77", undefined, window)).toBe("sev");
  expect(new CredentialMatcher(new Map()).redact("plain", undefined, window)).toBe("lai");
  expect(window).toEqual({ start: 1, end: 4 });
});

test("CRLF registrations share normalized and escaped variants with publication and streaming", () => {
  // Eligibility is based on the original eight characters, even after normalization shortens it.
  const secret = "ab\r\ncdef";
  registerCredential("MATCHER_CRLF", secret);
  const matcher = credentialMatcher();
  for (const value of [secret, secret.replace(/\r\n/g, "\n")]) {
    for (const variant of [value, JSON.stringify(value).slice(1, -1)]) {
      const input = `x${variant}y`;
      expect(redactCredentials(input)).toBe("x[redacted]y");
      expect(redactCredentials(input, { start: 2, end: input.length - 2 })).toBe("[redacted]");
      expect(credentialRedactionPadding()).toBeGreaterThanOrEqual(variant.length - 1);
      const stream = matcher.stream();
      expect(stream.push(input.slice(0, 3)) + stream.push(input.slice(3), true)).toBe("x[redacted]y");
    }
  }
});

test("shared compilation survives duplicates and reloads and invalidates on variant eligibility promotion", () => {
  const short = '"'.repeat(7);
  const escaped = JSON.stringify(short).slice(1, -1);
  const before = credentialMatcher();
  registerCredential("MATCHER_EMPTY", "");
  expect(credentialMatcher()).toBe(before);
  registerCredential("MATCHER_SHORT", short);
  const first = credentialMatcher();
  expect(first).not.toBe(before);
  expect(redactCredentials(`x${escaped}y`)).toBe(`x${escaped}y`);
  expect(redactCredentials(escaped)).toBe("[redacted]");
  redactCredentialData({ field: short });
  registerCredential("MATCHER_DUPLICATE", short);
  expect(credentialMatcher()).toBe(first);
  registerCredential("MATCHER_PROMOTION", escaped);
  expect(credentialMatcher()).not.toBe(first);
  expect(redactCredentials(`x${escaped}y`)).toBe("x[redacted]y");
  expect(redactCredentials(short)).toBe("[redacted]");
  const stable = credentialMatcher();
  registerCredential("MATCHER_PROMOTION", escaped);
  expect(credentialMatcher()).toBe(stable);

  process.env.MATCHER_ENV = "synthetic-environment-value";
  process.env.MATCHER_NAME_ONLY = "public";
  try {
    registerCredential("MATCHER_ENV", "synthetic-explicit-value");
    registerCredential("MATCHER_NAME_ONLY", "");
    expect(registeredCredentials()).toContain("synthetic-environment-value");
    expect(registeredCredentials()).toContain("synthetic-explicit-value");
    expect(registeredCredentials().filter((s) => s === short)).toHaveLength(1);
    expect(agentEnv().MATCHER_ENV).toBeUndefined();
    expect(agentEnv().MATCHER_NAME_ONLY).toBeUndefined();
    registerCredential("MATCHER_ENV", "synthetic-reloaded-value");
    expect(redactCredentials("synthetic-environment-value synthetic-explicit-value")).toBe(
      "[redacted] [redacted]",
    );
  } finally {
    delete process.env.MATCHER_ENV;
    delete process.env.MATCHER_NAME_ONLY;
  }
});

test("structured values and keys retain JSON serialization behavior and share the matcher", () => {
  const secret = "synthetic-structured-value";
  registerCredential("MATCHER_STRUCTURED", secret);
  const compiled = credentialMatcher();
  const redacted: unknown = redactCredentialData({
    [secret]: [secret, { [secret]: `x${secret}y` }],
    omitted: undefined,
    date: new Date(0),
  });
  expect(redacted).toEqual({
    "[redacted]": ["[redacted]", { "[redacted]": "x[redacted]y" }],
    date: new Date(0).toJSON(),
  });
  expect(credentialMatcher()).toBe(compiled);
  expect(() => redactCredentialData(1n)).toThrow();
});

const work = (): MatchingWork => ({ transitions: 0, outputs: 0, boundaries: 0 });
function measure(patterns: string[], input: string) {
  const matcher = new CredentialMatcher(variants(patterns));
  const whole = work();
  const chunks = work();
  const output = matcher.redact(input, whole);
  const stream = matcher.stream(chunks);
  let streamed = "";
  for (let i = 0; i < input.length; i += 13) streamed += stream.push(input.slice(i, i + 13));
  streamed += stream.push("", true);
  expect(streamed).toBe(output);
  return { whole, chunks };
}

test("actual transition, output-resolution and boundary work is unchanged at 10 and 1,000 patterns", () => {
  const patterns = Array.from({ length: 1000 }, (_, i) => `z${String(i).padStart(7, "0")}`);
  patterns[0] = "abcdefgh";
  const input = "prefix abcdefgh suffix abcdefgh!".repeat(80);
  const small = measure(patterns.slice(0, 10), input);
  const large = measure(patterns, input);
  expect(large).toEqual(small);
  expect(small.whole.transitions).toBeGreaterThan(input.length);
  expect(small.whole.outputs).toBeGreaterThan(0);
  expect(small.chunks.boundaries).toBeGreaterThan(0);
});

test("shared suffix outputs and overlapping boundaries are resolved without dictionary enumeration", () => {
  const input = "a".repeat(4096);
  const counts = measure(
    Array.from({ length: 1017 }, (_, i) => "a".repeat(i + 8)),
    input,
  );
  for (const count of [counts.whole, counts.chunks]) {
    expect(count.transitions).toBeLessThanOrEqual(2 * input.length);
    expect(count.outputs).toBeLessThan(100 * input.length);
    expect(count.boundaries).toBeLessThan(5 * input.length);
  }
});
