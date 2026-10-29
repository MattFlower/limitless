import { expect, test } from "bun:test";
import {
  CredentialMatcher,
  credentialMatcher,
  credentialVariants,
  type MatchingWork,
} from "../src/util/credential-matcher.ts";
import {
  agentEnv,
  credentialRedactionPadding,
  redactCredentialData,
  redactCredentials,
  registerCredential,
  registeredCredentials,
} from "../src/util/proc.ts";
import { TERMINAL_HOLD, terminalRedactor } from "../src/util/terminal-redaction.ts";

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

test("JSON slash spellings cover raw and CRLF-normalized credentials and retain short-secret rules", () => {
  for (const secret of ["abc/def-ghijkl-credential", 'synthetic/quoted"/key\r\nend', "a/\r\ncdef"]) {
    registerCredential("MATCHER_JSON_SLASH", secret);
    for (const value of [secret, secret.replaceAll("\r\n", "\n")]) {
      const escaped = JSON.stringify(value).slice(1, -1).replaceAll("/", "\\/");
      expect(redactCredentials(`{"token":"${escaped}","ok":true}`)).toBe('{"token":"[redacted]","ok":true}');
    }
  }
  registerCredential("MATCHER_SHORT_SLASH", "ab/cd");
  expect(redactCredentials("ab\\/cd")).toBe("[redacted]");
  expect(redactCredentials('"ab\\/cd"')).toBe('"ab\\/cd"');
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

test("structured numeric credentials redact whole values and containing numbers, leaving fragments unchanged", () => {
  registerCredential("MATCHER_NUMERIC", "987654321012345");
  const redacted: unknown = redactCredentialData({
    input: { token: 987654321012345 },
    values: [987654321012345, 1987654321012345, 98765432, 42, -42, 0.25, 0, 1, 9, 9876543],
  });
  expect(redacted).toEqual({
    input: { token: "[redacted]" },
    values: ["[redacted]", "[redacted]", 98765432, 42, -42, 0.25, 0, 1, 9, 9876543],
  });
});

test("short numeric credentials redact whole values without matching substrings", () => {
  registerCredential("MATCHER_SHORT_NUMERIC", "6352");
  const redacted: unknown = redactCredentialData([6352, 16352, 635]);
  expect(redacted).toEqual(["[redacted]", 16352, 635]);
});

test("digit credentials beyond exact JSON number precision still redact as strings", () => {
  const secret = "987654321012345678901234567890";
  registerCredential("MATCHER_LARGE_NUMERIC", secret);
  expect(redactCredentialData({ token: secret })).toEqual({ token: "[redacted]" });
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

const ESC = "\u001b";
const SECRET = "synthetic-terminal-key";
const [HEAD, TAIL] = [SECRET.slice(0, 5), SECRET.slice(5)];
// Digits are CSI parameters, so a stray introducer before this credential reads them as a sequence.
const DIGITS = "12345678abcdefgh";
// Exhaust short inputs; sample long inputs densely at boundaries. Carry stays bounded at every split.
function expectTerminal(input: string, expected: string, values = [SECRET, DIGITS], boundaries = [0]) {
  const matcher = new CredentialMatcher(variants(values));
  // A held credential prefix delays forced release past the sequence's hold boundary.
  const release = (boundaries[0] ?? 0) + matcher.maxLength + TERMINAL_HOLD;
  for (let offset = 0; offset <= input.length; offset++) {
    if (
      input.length > TERMINAL_HOLD &&
      offset % 97 !== 0 &&
      Math.abs(offset - release) > 3 &&
      !boundaries.some((boundary) => Math.abs(offset - boundary) <= 3)
    )
      continue;
    const redactor = terminalRedactor(() => matcher);
    let output = redactor.push(input.slice(0, offset));
    const { text, maps, output: held } = redactor.retained;
    expect(Math.max(text, maps)).toBeLessThanOrEqual(matcher.maxLength + TERMINAL_HOLD + 1);
    expect(held).toBeLessThanOrEqual(matcher.maxLength);
    output += redactor.push(input.slice(offset), true);
    expect(output).toBe(expected);
    expect(redactor.retained).toEqual({ text: 0, maps: 0, spans: 0, output: 0 });
  }
}

test.each([
  ["stray CSI introducer", `x ${ESC}[${SECRET} y`, "x [redacted] y"],
  ["stray CSI introducer and an SGR inside", `x ${ESC}[${HEAD}${ESC}[31m${TAIL} y`, "x [redacted] y"],
  ["stray ESC and an SGR inside", `x ${ESC}${HEAD}${ESC}[1m${TAIL} y`, "x [redacted] y"],
  ["stray C1 CSI", `x \u009b${SECRET} y`, "x [redacted] y"],
  ["stray C1 CSI and an SGR inside", `x \u009b${HEAD}${ESC}[31m${TAIL} y`, "x [redacted] y"],
  [
    "stray CSI before digits, ended by an SGR inside",
    `x ${ESC}[1234${ESC}[31m5678abcdefgh y`,
    "x [redacted] y",
  ],
  ["stray CSI before digits, ended by a letter", `x ${ESC}[12345678ab${ESC}[31mcdefgh y`, "x [redacted] y"],
  ["stray C1 CSI before digits", `x \u009b1234${ESC}[31m5678ab${ESC}[0mcdefgh y`, "x [redacted] y"],
  [
    "stray CSI before digits, two SGRs inside",
    `x ${ESC}[123${ESC}[1m45678${ESC}[0mabcdefgh y`,
    "x [redacted] y",
  ],
  ["stray ESC intermediate", `x ${ESC} ${HEAD}${ESC}[1m${TAIL} y`, "x [redacted] y"],
  ["stray OSC introducer at EOF", `x ${ESC}]${SECRET} y`, "x ][redacted] y"],
  ["stray OSC introducer and an SGR inside", `x ${ESC}]${HEAD}${ESC}[31m${TAIL} y`, "x ][redacted] y"],
  ["SGR reset inside", `x ${HEAD}${ESC}[m${TAIL} y`, "x [redacted] y"],
  ["DCS inside", `x ${HEAD}${ESC}Pq#0;2;0${ESC}\\${TAIL} y`, "x [redacted] y"],
  ["C1 DCS and ST inside", `x ${HEAD}\u0090q#0\u009c${TAIL} y`, "x [redacted] y"],
  ["C1 OSC with BEL inside", `x ${HEAD}\u009d0;title\u0007${TAIL} y`, "x [redacted] y"],
  [
    "SOS, PM and APC inside",
    `x ${HEAD}${ESC}Xa${ESC}\\${TAIL.slice(0, 4)}${ESC}^b${ESC}\\${TAIL.slice(4, 9)}${ESC}_c${ESC}\\${TAIL.slice(9)} y`,
    "x [redacted] y",
  ],
  ["credential inside a terminated OSC title", `x ${ESC}]0;${SECRET}\u0007 y`, "x [redacted] y"],
  [
    "stray OSC before a line break, then an SGR inside",
    `x ${ESC}]\n${HEAD}${ESC}[31m${TAIL} y`,
    "x ]\n[redacted] y",
  ],
  [
    "two multiline strings interrupting one credential",
    `x ${HEAD}${ESC}]0;a\nb\u0007${TAIL.slice(0, 6)}${ESC}Pc\nd${ESC}\\${TAIL.slice(6)} y`,
    "x [redacted] y",
  ],
  [
    "OSC longer than the hold inside",
    `x ${HEAD}${ESC}]0;${"t".repeat(5_000)}\u0007${TAIL} y`,
    `x [redacted]]0;${"t".repeat(5_000)}[redacted] y`,
  ],
  ["ordinary formatting and no credential", `${ESC}[1;31mred${ESC}[0m ${ESC}(Bplain${ESC}[K`, "red plain"],
])("terminal readings cannot expose a credential: %s", (_name, input, expected) => {
  const start = input.indexOf(ESC);
  const end = input.indexOf("\u0007") + 1;
  const boundaries = [2, start, start + 2 + TERMINAL_HOLD, end, input.length - 2];
  expectTerminal(input, expected, undefined, boundaries);
});

// An unrelated registration gives the other stray reading a deeper partial match at the same introducer.
test.each([
  [
    "earlier stray reading against a deeper decoy",
    ["1abcdefghijk", "31mab-decoy-credential"],
    `x ${ESC}[1${ESC}[31mab${ESC}[0mcdefghijk y`,
    "x [redacted] y",
  ],
  [
    "latest stray reading against a deeper decoy",
    ["31mabcdefghij", "zz x 1ab-decoy"],
    `zz x ${ESC}[1${ESC}[31mab${ESC}[0mcdefghij y`,
    "zz x [redacted] y",
  ],
  [
    "latest stray reading without a decoy",
    ["31mabcdefghij"],
    `zz x ${ESC}[1${ESC}[31mab${ESC}[0mcdefghij y`,
    "zz x [redacted] y",
  ],
  [
    "a discarded prefix that never completes",
    ["1abcdefghijk", "31mab-decoy-credential"],
    `x ${ESC}[1${ESC}[31mab${ESC}[0mcd${"y".repeat(10)} z`,
    "x [redacted]yyy z",
  ],
])("competing stray readings cannot expose a credential: %s", (_name, values, input, expected) =>
  expectTerminal(input, expected, values),
);

test("periodic credentials through a large interrupted stream keep bounded carry and one span", () => {
  const matcher = new CredentialMatcher(variants(["abcabcab"]));
  const redactor = terminalRedactor(() => matcher);
  let output = redactor.push("x");
  for (let i = 0; i < 2_000; i++) {
    output += redactor.push(`${"abc".repeat(50)}${ESC}[1m${"abc".repeat(50)}`);
    const { text, maps, spans } = redactor.retained;
    expect(Math.max(text, maps)).toBeLessThanOrEqual(matcher.maxLength + 8);
    expect(spans).toBeLessThanOrEqual(1);
  }
  output += redactor.push("aby", true);
  expect(output).toBe("x[redacted]y");
  expect(redactor.retained).toEqual({ text: 0, maps: 0, spans: 0, output: 0 });
});

test("a large push leaves only the carry in backing storage", () => {
  const matcher = new CredentialMatcher(variants([SECRET]));
  const redactor = terminalRedactor(() => matcher);
  const output = redactor.push(`${ESC}[1m${"y".repeat(3_000_000)}${ESC}[0m${HEAD}`);
  // The carry is the last maxLength - 1 raw characters: some y, the SGR reset and HEAD.
  const held = matcher.maxLength - 1 - `${ESC}[0m${HEAD}`.length;
  expect(output).toBe("y".repeat(3_000_000 - held));
  expect(redactor.retained).toEqual({
    text: matcher.maxLength - 1,
    maps: matcher.maxLength - 1,
    spans: 0,
    output: 0,
  });
  expect(redactor.push(TAIL, true)).toBe(`${"y".repeat(held)}[redacted]`);
});

test("a stream whose whole output is a short credential is redacted at every split", () => {
  const matcher = new CredentialMatcher(variants(["seven77", SECRET]));
  for (const [input, expected] of [
    ["seven77", "[redacted]"],
    [`${ESC}[1mseven77${ESC}[0m`, "[redacted]"],
    ["seven77\n", "seven77\n"],
    [`x seven77 ${"y".repeat(40)}`, `x seven77 ${"y".repeat(40)}`],
  ] as const)
    for (let offset = 0; offset <= input.length; offset++) {
      const redactor = terminalRedactor(() => matcher);
      expect(redactor.push(input.slice(0, offset)) + redactor.push(input.slice(offset), true)).toBe(expected);
    }
});

test("a registration while a stray introducer is held rematches it", () => {
  const input = `x ${ESC}[1234${ESC}[31m5678${ESC}[0mabcdefgh y`;
  const before = new CredentialMatcher(variants([SECRET]));
  const after = new CredentialMatcher(variants([SECRET, DIGITS]));
  // Registered before the credential-bearing input, with the introducer already held.
  for (let offset = 0; offset <= input.indexOf("1234"); offset++) {
    let matcher = before;
    const redactor = terminalRedactor(() => matcher);
    let output = redactor.push(input.slice(0, offset));
    matcher = after;
    output += redactor.push(input.slice(offset), true);
    expect(output).toBe("x [redacted] y");
  }
});

test("an unterminated strict string bounds carry and releases visible text while open", () => {
  const matcher = new CredentialMatcher(variants([SECRET]));
  const redactor = terminalRedactor(() => matcher);
  // The strict reading never sees a terminator, so its pending prefix is hidden at the bound.
  let output = redactor.push(`x ${HEAD}${ESC}]0;`);
  for (let i = 0; i < 50; i++) {
    output += redactor.push(`${"line ".repeat(39)}\n`);
    expect(redactor.retained.text).toBeLessThanOrEqual(matcher.maxLength + TERMINAL_HOLD + 1);
  }
  expect(output.length).toBeGreaterThan(5_000);
  output += redactor.push(`${SECRET} end`, true);
  expect(output).toBe(`x [redacted]]0;${`${"line ".repeat(39)}\n`.repeat(50)}[redacted] end`);
});

test("explicit credential preparation shares variants without relying on global registrations", () => {
  const secret = 'synthetic/quoted"/key\r\nend';
  const matcher = new CredentialMatcher(credentialVariants([secret, "ab\r\ncdef", "ab/cd"]));
  for (const value of [secret, secret.replaceAll("\r\n", "\n"), "ab\r\ncdef", "ab\ncdef"])
    for (const variant of [
      value,
      JSON.stringify(value).slice(1, -1),
      JSON.stringify(value).slice(1, -1).replaceAll("/", "\\/"),
    ]) {
      expect(matcher.redact(`x${variant}y`)).toBe("x[redacted]y");
      const terminal = terminalRedactor(() => matcher);
      expect(terminal.push(`x${variant}`, false) + terminal.push("y", true)).toBe("x[redacted]y");
    }
  expect(matcher.redact("ab\\/cd")).toBe("[redacted]");
  expect(matcher.redact("xab\\/cdy")).toBe("xab\\/cdy");
  const short = '"'.repeat(7);
  const escaped = JSON.stringify(short).slice(1, -1);
  for (const values of [
    [short, escaped, short],
    [escaped, short],
  ])
    expect(new CredentialMatcher(credentialVariants(values)).redact(`x${escaped}y`)).toBe("x[redacted]y");
  expect([...credentialVariants(["", "ab/cd", "ab/cd"])].length).toBe(2);
});
