import { expect, test } from "bun:test";
import {
  type BoundaryCut,
  type BoundaryText,
  capturePrivacySnapshot,
  checkPrepared,
  concat,
  consumeBoundaryText as consume,
  createPrivacyRegistry,
  cutPrefix,
  cutTail,
  preparePrivacyPolicy,
  protectText,
  trim,
} from "../src/util/privacy-boundary.ts";

const host = ["host", "example"].join(".");
const marker = "[withheld: private text]";
function fixture(entries: string[] = [], credentials: string[] = [], limits = {}) {
  let label = "v1";
  const authority = createPrivacyRegistry(undefined, () => label);
  let generationReads = 0;
  const registry = {
    ...authority,
    get generation() {
      generationReads++;
      return authority.generation;
    },
  };
  registry.replacePolicy(entries.map((value, entry) => ({ value, entry })));
  for (const credential of credentials) registry.addCredential(credential);
  const policy = preparePrivacyPolicy(capturePrivacySnapshot(registry));
  const options = { registry, limits };
  const protect = (
    text: string,
    extra: Partial<Parameters<typeof protectText>[0]> = {},
    beforeIssue?: () => void,
  ) => protectText({ text, policy, provenance: { kind: "complete" }, ...extra }, { ...options, beforeIssue });
  return {
    registry,
    generationReads: () => generationReads,
    policy,
    protect,
    changeLabel: () => {
      label = "v2";
    },
  };
}
function refused(value: unknown, reason?: ReturnType<typeof consume>["reason"]) {
  const result = consume(value);
  expect(result.text).toBe(marker);
  expect(result.withheld).toBe(true);
  if (reason) expect(result.reason).toBe(reason);
  return result;
}

test("raw and visible checks independently prevent concealment", () => {
  refused(fixture([host]).protect(`\x1b]0;${host}\x07safe`, { terminal: true }), "private-match");
  refused(
    fixture([host], [host.slice(0, 9)]).protect("host.\x1b[31mexample", { terminal: true }),
    "private-match",
  );
});
test("terminal credentials use the actual matcher and controls are stripped", () => {
  const f = fixture([], ["synthetic-token"]);
  const result = consume(f.protect("synthetic-\x1b[31mtoken", { terminal: true }));
  expect(result.withheld).toBe(false);
  expect(result.text).toContain("[redacted]");
  expect(result.text).not.toContain("synthetic-token");
  expect(consume(f.protect("clean\x1b[0m text", { terminal: true })).text).toBe("clean text");
  refused(
    fixture(["[redacted]"], ["synthetic-token"]).protect("synthetic-\x1b[31mtoken", {
      terminal: true,
      cut: { limit: 0, unit: "U" },
    }),
    "private-match",
  );
});
test("unchecked provenance and copied identities have no authority", () => {
  const f = fixture();
  const value = f.protect("clean");
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.keys(value)).toEqual([]);
  for (const forged of [
    { ...value },
    structuredClone(value),
    JSON.parse(JSON.stringify(value)),
    { text: "unrelated", checkedComplete: true, receipt: value },
    null,
    "clean",
  ])
    refused(forged, "forged");
  for (const provenance of [{ kind: "cut", truncated: true }, { kind: "legacy-unknown" }] as const) {
    const result = refused(f.protect("clean", { provenance }), "unchecked-provenance");
    expect(result.checkedComplete).toBe(false);
    expect(result.truncated).toBe(provenance.kind === "cut" ? true : undefined);
    expect(consume(cutPrefix(f.protect("clean", { provenance }), 0)).truncated).toBe(result.truncated);
  }
  refused(cutPrefix({ ...value } as BoundaryText, 1), "forged");
});
const units: BoundaryCut["unit"][] = ["U", "B", "CP"];
test.each(units)("clipping reflects actual omission and preserves Unicode in %s", (unit) => {
  const f = fixture([host]);
  const exact = f.protect("host.", { cut: { limit: 5, unit } });
  expect(consume(exact)).toMatchObject({ text: "host.", truncated: false, withheld: false });
  const clipped = f.protect("host.x", { cut: { limit: 5, unit } });
  expect(refused(clipped).truncated).toBe(true);
  expect(consume(cutPrefix(clipped, 0)).truncated).toBe(true);
  expect(consume(f.protect(host)).truncated).toBe(false);
  const clean = fixture();
  const value = clean.protect("😀éZ");
  const limit = unit === "U" ? 2 : unit === "B" ? 4 : 1;
  expect(consume(cutPrefix(value, limit, unit)).text).toBe("😀");
  expect(consume(cutTail(value, unit === "B" ? 3 : 2, unit)).text).toBe("éZ");
  for (const cut of [cutPrefix, cutTail]) {
    const result = consume(cut(value, 1, unit));
    expect(result.text.isWellFormed()).toBe(true);
    expect(result.truncated).toBe(true);
    expect(consume(cut(cut(value, 0, unit), 0, unit)).truncated).toBe(true);
    expect(consume(cut(clean.protect(""), 0, unit)).truncated).toBe(false);
  }
});
test.each(units)("every direct and second cut checks its exact rendering in %s", (unit) => {
  const f = fixture([host]);
  const original = f.protect(`${host}\u0301`);
  expect(consume(original).withheld).toBe(false);
  expect(checkPrepared(f.policy, `${host}\u0301`)).toEqual({ clean: true });
  for (const value of [original, cutPrefix(original, 99, unit)]) {
    expect(refused(cutPrefix(value, host.length, unit)).checkedComplete).toBe(true);
    expect(refused(f.protect(`${host}\u0301`, { cut: { limit: host.length, unit } })).truncated).toBe(true);
  }
  // Short credentials only match the entire value: a tail exposes one.
  const secret = fixture([], ["short"]);
  const credential = secret.protect("xshort");
  expect(consume(credential).withheld).toBe(false);
  refused(cutTail(credential, 5, unit), "private-match");
  refused(cutPrefix(secret.protect("shortx"), 5, unit), "private-match");
  const tailPrivate = fixture(["\u0301x"]);
  const before = tailPrivate.protect("a\u0301x");
  expect(consume(before).withheld).toBe(false);
  refused(cutTail(before, unit === "B" ? 3 : 2, unit), "private-match");
});
test("complete assembly and exact rewritten outputs are checked separately", () => {
  expect(refused(concat([]), "unchecked-provenance").checkedComplete).toBe(false);
  const f = fixture([host]);
  const pieces = [f.protect("host."), f.protect("example")];
  refused(concat(pieces, { cut: { limit: 1, unit: "U", side: "tail" } }), "private-match");
  refused(cutTail(cutPrefix(concat(pieces), 1), 1), "private-match");
  refused(concat([f.protect("host"), f.protect("example")], { separator: "." }), "private-match");
  const credential = fixture([], ["short"]);
  refused(trim(credential.protect(" short ")), "private-match");
  refused(f.protect("host.x", { cut: { limit: 5, unit: "U", marker: "example" } }), "private-match");
  const clean = fixture([], [], { assembly: 2 });
  const joined = concat([clean.protect("alpha"), clean.protect("beta")], {
    separator: " ",
    cut: { limit: 2, unit: "CP" },
  });
  expect(consume(joined)).toMatchObject({ text: "al", truncated: true, withheld: false });
  const clipped = cutPrefix(clean.protect("ab"), 1);
  expect(refused(concat([clean.protect("a"), clipped, clean.protect("c")]), "assembly-count").truncated).toBe(
    true,
  );
});
test("policy, credential and checker generations guard issuance and every reuse", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.registry.replacePolicy([]),
    (f: ReturnType<typeof fixture>) => f.registry.addCredential("new-secret"),
    (f: ReturnType<typeof fixture>) => f.changeLabel(),
  ]) {
    const first = fixture();
    let before = 0;
    const issued = first.protect("clean", {}, () => {
      change(first);
      before = first.generationReads();
    });
    expect(first.generationReads()).toBeGreaterThan(before);
    refused(issued, "stale-generation");
    const later = fixture();
    const value = later.protect("clean");
    change(later);
    refused(value, "stale-generation");
    refused(cutPrefix(value, 2), "stale-generation");
    refused(cutTail(value, 2), "stale-generation");
    refused(trim(value), "stale-generation");
    refused(concat([value]), "stale-generation");
  }
  const f = fixture();
  const value = f.protect("clean");
  expect(consume(cutPrefix(cutPrefix(value, 5), 5))).toMatchObject({ text: "clean", truncated: false });
  expect(consume(value).withheld).toBe(false);
  const repeated = f.protect("clean");
  expect(consume(value).policyDigest).toBe(consume(repeated).policyDigest);
});
test.each([
  [{ kind: "complete" }, false],
  [{ kind: "cut", truncated: true }, true],
  [{ kind: "legacy-unknown" }, undefined],
] as const)("refused policies contain generation lookup failures for %j", (provenance, truncated) => {
  const source = "synthetic-sensitive-source";
  const exception = "synthetic-sensitive-policy-error";
  let failing = false;
  const registry = createPrivacyRegistry(undefined, () => {
    if (failing) throw new Error(exception);
    return "v1";
  });
  registry.replacePolicy([{ value: "synthetic-policy-entry", entry: 0 }]);
  const policy = preparePrivacyPolicy(capturePrivacySnapshot(registry), { limits: { entries: 0 } });
  expect(policy).toEqual({ refused: "entries-count" });
  failing = true;
  const value = protectText({ text: source, provenance, policy }, { registry });
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.keys(value)).toEqual([]);
  const result = consume(value);
  expect(result).toEqual({
    text: marker,
    truncated,
    checkedComplete: false,
    withheld: true,
    policyDigest: "privacy/unavailable",
    reason: "stale-generation",
  });
  for (const sentinel of [source, exception, "synthetic-policy-entry"])
    expect(JSON.stringify([value, result])).not.toContain(sentinel);
  expect(consume(cutPrefix(value, 0))).toEqual(result);
  failing = false;
  expect(consume(value)).toEqual(result);
});
test("limits refuse wholly with fixed reasons at equality and cap plus one", () => {
  for (const [key, text, cap, code] of [
    ["inputUnits", "é😀", 3, "input-length"],
    ["inputBytes", "é😀", 6, "input-length"],
    ["outputUnits", "é😀", 3, "output-length"],
    ["outputBytes", "é😀", 6, "output-length"],
    ["formLength", "abcd", 4, "form-length"],
    ["formsTotal", "abcd", 32, "forms-total"],
  ] as const) {
    expect(consume(fixture([], [], { [key]: cap }).protect(text)).withheld).toBe(false);
    refused(fixture([], [], { [key]: cap - 1 }).protect(text), code);
  }
  const f = fixture();
  refused(f.protect(String.fromCharCode(0xd800)), "ill-formed");
  refused(f.protect("clean", { policy: { refused: "entries-count" } }), "unreadable-policy");
  refused(
    f.protect("clean", {}, () => {
      throw new Error("synthetic exception text");
    }),
    "nonconvergent",
  );
  for (const limit of [-1, NaN, Infinity]) refused(cutPrefix(f.protect("clean"), limit), "invalid-cut");
  const small = fixture([], [], { outputUnits: 1 });
  const result = refused(small.protect("abcd", { cut: { limit: 2, unit: "U" } }), "output-length");
  expect(result.truncated).toBe(true);
  const assembly = fixture([], [], { inputUnits: 2 });
  const a = assembly.protect("ab");
  refused(concat([a, a], { cut: { limit: 1, unit: "U" } }), "input-length");
  const bytes = fixture([], [], { inputBytes: 2 });
  refused(concat([bytes.protect("é"), bytes.protect("é")]), "input-length");
  refused(concat([f.protect("a"), f.protect("b")], { separator: String.fromCharCode(0xd800) }), "ill-formed");
  const cut: BoundaryCut = { limit: 0, unit: "U", marker: String.fromCharCode(0xd800) };
  expect(refused(f.protect("clean", { cut }), "ill-formed").truncated).toBe(true);
});
test("injected decoder and cache limits persist through trusted operations", () => {
  for (const [limits, reason] of [
    [{ formLength: 3 }, "form-length"],
    [{ formsTotal: 24 }, "forms-total"],
  ] as const) {
    const f = fixture([], [], limits);
    refused(concat([f.protect("ab"), f.protect("cd")]), reason);
    const result = refused(f.protect("ab", { cut: { limit: 1, unit: "U", marker: "bcd" } }), reason);
    expect(result.truncated).toBe(true);
  }
  const registry = createPrivacyRegistry();
  registry.replacePolicy([{ value: host, entry: 1 }]);
  for (const key of ["memoEntries", "memoUnits"] as const) {
    const counters = { registrations: 0, inputs: 0, memoAdmissions: 0, memoPeakEntries: 0, memoPeakUnits: 0 };
    const policy = preparePrivacyPolicy(capturePrivacySnapshot(registry), { counters });
    const text = Buffer.from("ordinary clean field").toString("base64");
    const value = protectText(
      { text, policy, provenance: { kind: "complete" } },
      { registry, limits: { [key]: 0 } },
    );
    expect(consume(concat([cutPrefix(value, text.length), cutTail(value, text.length)]))).toMatchObject({
      withheld: false,
    });
    expect(counters.memoAdmissions).toBe(0);
  }
});
