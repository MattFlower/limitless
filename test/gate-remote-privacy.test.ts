import { afterEach, expect, spyOn, test } from "bun:test";
import { formatGateOutput, RENDER_LIMITS, renderGateOutput } from "../src/gates/failures.ts";
import { protectGateOutput } from "../src/gates/output-privacy.ts";
import { recheckRemote } from "../src/gates/remote-privacy.ts";
import { gateIdentities, IDENTITY_CAP, remoteGateData } from "../src/gates/text-privacy.ts";
import { verifier } from "../src/util/privacy-proof.ts";
import { registerCredential } from "../src/util/proc.ts";
import { remoteFixture } from "./gate-remote-support.ts";

const fixtures: ReturnType<typeof remoteFixture>[] = [];
const fixture = (...args: Parameters<typeof remoteFixture>) => {
  const f = remoteFixture(...args);
  fixtures.push(f);
  return f;
};
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.checker.dispose();
});
const control = () => ({
  deadline: Date.now() + 120_000,
  signal: new AbortController().signal,
  memo: new Map(),
  parity: () => true,
});

test("LAN rendering proofs bind transport, field and credential-redacted bytes", async () => {
  const credential = "remote-test-credential",
    f = fixture([], credential);
  const r = await f.scoped(() =>
    recheckRemote(
      f.result({ output: `before ${credential} after`, failures: "discard" }),
      "attested:lan",
      control(),
    ),
  );
  expect(r.output).toBe("before [redacted] after");
  expect(r.failures).toBeUndefined();
  const v = verifier(f.registry, f.signer);
  expect(v.verify(r.textPrivacy?.output, "output", r.output)).toBe(true);
  expect(v.verify(r.textPrivacy?.identities, "identities", gateIdentities(r))).toBe(true);
  for (const kind of ["complete", "attested:github-actions"])
    expect(v.verify({ ...r.textPrivacy?.output, kind }, "output", r.output)).toBe(false);
  expect(v.verify(r.textPrivacy?.output, "identities", r.output)).toBe(false);
});

test.each(["withheld", "incomplete", "missing", "mismatch", "parity", "private"])(
  "LAN precondition: %s",
  async (condition) => {
    const f = fixture(["private-value"]),
      r = f.result({ output: condition === "private" ? "private-value" : "clean" });
    if (!r.remoteAttestation) throw Error("Missing claims");
    const claim = r.remoteAttestation.output;
    if (condition === "withheld") claim.withheld = true;
    if (condition === "incomplete") delete claim.checkedComplete;
    if (condition === "missing") delete claim.entriesDigest;
    if (condition === "mismatch") claim.entriesDigest = "0".repeat(64);
    const checked = await f.scoped(() =>
      recheckRemote(r, "attested:lan", { ...control(), parity: () => condition !== "parity" }),
    );
    expect(checked.textPrivacy?.output.mac).toBeUndefined();
    expect(checked.textPrivacy?.output.reason).toBe(
      condition === "withheld" ? "remote" : condition === "private" ? "private-match" : "unproven",
    );
    if (condition !== "parity") expect(checked.textPrivacy?.identities?.kind).toBe("attested:lan");
  },
);

test("memo revalidates signed renderings under fresh policy and fresh claims", async () => {
  const f = fixture(),
    c = control(),
    calls = spyOn(f.checker, "protectText"),
    r = f.result();
  const check = (value = r) => f.scoped(() => recheckRemote(value, "attested:lan", c));
  const first = await check();
  await check();
  expect(calls).toHaveBeenCalledTimes(2);
  f.policy(["elsewhere"]);
  const stale = await check();
  expect(stale.textPrivacy?.output.mac).toBeUndefined();
  expect(calls).toHaveBeenCalledTimes(2);
  const updated = await check(f.result());
  expect(updated.textPrivacy?.output.kind).toBe("attested:lan");
  expect(calls).toHaveBeenCalledTimes(4);
  expect(verifier(f.registry, f.signer).verify(first.textPrivacy?.output, "output", first.output)).toBe(
    false,
  );
  expect([...c.memo.keys()].every((key) => /^[a-f0-9]{64}$/.test(key))).toBe(true);
});

test.each([false, true])("private and over-cap identities stay internally usable: cap=%s", async (cap) => {
  const f = fixture(["private-file"]),
    r = f.result({
      command: cap ? "x".repeat(IDENTITY_CAP + 1) : "private-file",
      executedCommand: "actual",
      failedFiles: ["private-file"],
      failedFileTimes: { "private-file": 3 },
      testCoverage: { passedFiles: ["a"], skippedFiles: ["b"], skippedTests: [{ file: "c", name: "case" }] },
      coveringTest: { file: "test.ts", name: "case" },
    });
  const out = await f.scoped(() => recheckRemote(r, "attested:lan", control()));
  expect(out.command).toBe(r.command);
  expect(out.executedCommand).toBe("actual");
  expect(out.failedFiles).toEqual(r.failedFiles);
  expect(out.failedFileTimes).toEqual(r.failedFileTimes);
  expect(out.testCoverage).toEqual(r.testCoverage);
  expect(out.coveringTest).toEqual(r.coveringTest);
  expect(out.textPrivacy?.identities).toEqual({
    withheld: true,
    reason: cap ? "identity-cap" : "private-match",
  });
});

test("producer digest survives strict ingress without a worker MAC", async () => {
  const f = fixture();
  const protectedOutput = await f.scoped(() =>
    protectGateOutput(
      {
        stdout: "clean",
        stderr: "",
        exitCode: 0,
        signal: null,
        cancelled: false,
        timedOut: false,
        idleTimedOut: false,
        truncated: false,
        durationMs: 1,
        capture: { provenance: { kind: "complete" }, stdout: "clean", stderr: "" },
      },
      "[]",
      control(),
    ),
  );
  const remote = remoteGateData({ ...f.result(), ...protectedOutput });
  expect(remote.remoteAttestation?.output.entriesDigest).toBe(
    f.result().remoteAttestation?.output.entriesDigest,
  );
  expect(remote.remoteAttestation?.output.mac).toBeUndefined();
  expect(remote.remoteAttestation?.identities?.entriesDigest).toBe(
    remote.remoteAttestation?.output.entriesDigest,
  );
});

test("one absolute deadline covers memo reuse, successive fields and cancellation", async () => {
  const f = fixture(),
    c = control(),
    deadlines: (number | undefined)[] = [];
  let now = Date.now();
  const original = f.checker.protectText;
  const spy = spyOn(f.checker, "protectText").mockImplementation(async (input, options) => {
    deadlines.push(options?.deadline);
    return original(input, options);
  });
  await f.scoped(() => recheckRemote(f.result(), "attested:lan", { ...c, now: () => now }));
  expect(deadlines).toEqual([c.deadline, c.deadline]);
  now = c.deadline;
  const expired = await f.scoped(() => recheckRemote(f.result(), "attested:lan", { ...c, now: () => now }));
  expect(expired.textPrivacy?.output.mac).toBeUndefined();
  expect(spy).toHaveBeenCalledTimes(2);
  const controller = new AbortController();
  spy.mockImplementation(async (input, options) => {
    controller.abort();
    return original(input, options);
  });
  const cancelled = await f.scoped(() =>
    recheckRemote(f.result({ output: "new" }), "attested:lan", { ...c, signal: controller.signal }),
  );
  expect(cancelled.textPrivacy?.output.mac).toBeUndefined();
  expect(cancelled.textPrivacy?.identities?.mac).toBeUndefined();
});

test.each(["policy", "signer", "stale-receipt"])(
  "unavailable %s cannot issue coordinator proofs",
  async (failure) => {
    const f = fixture(),
      r = f.result();
    if (failure === "policy") f.registry.failPolicy();
    if (failure === "signer") f.scope.signer = () => undefined;
    if (failure === "stale-receipt") {
      const original = f.checker.protectText;
      spyOn(f.checker, "protectText").mockImplementation(async (...args) => {
        const receipt = await original(...args);
        f.policy(["later-policy"]);
        return receipt;
      });
    }
    const out = await f.scoped(() => recheckRemote(r, "attested:lan", control()));
    expect(out.textPrivacy?.output.mac).toBeUndefined();
    expect(out.textPrivacy?.identities?.mac).toBeUndefined();
  },
);

test("expiry between field requests cannot renew the job budget", async () => {
  const f = fixture(),
    c = control(),
    now = Date.now,
    start = now();
  let time = start;
  const original = f.checker.protectText,
    submitted: (number | undefined)[] = [];
  spyOn(f.checker, "protectText").mockImplementation(async (input, options) => {
    submitted.push(options?.deadline);
    const receipt = await original(input, options);
    time = c.deadline;
    return receipt;
  });
  const out = await f.scoped(() => recheckRemote(f.result(), "attested:lan", { ...c, now: () => time }));
  expect(submitted).toEqual([c.deadline]);
  expect(out.textPrivacy?.output.mac).toBeUndefined();
  expect(out.textPrivacy?.identities?.mac).toBeUndefined();
});

test.each(["attested:lan", "attested:github-actions"] as const)(
  "%s output proofs preserve cut provenance through memo and final verification",
  async (kind) => {
    const f = fixture(),
      c = control();
    const r = f.result({ output: "x".repeat(kind === "attested:lan" ? 6000 : 6100) });
    if (kind === "attested:lan" && r.remoteAttestation) r.remoteAttestation.output.truncated = true;
    const out = await f.scoped(() => recheckRemote(r, kind, c));
    expect(out.output).toBe("x".repeat(6000));
    expect(out.textPrivacy?.output.truncated).toBe(true);
    const verify = verifier(f.registry, f.signer).verify;
    expect(verify(out.textPrivacy?.output, "output", out.output, true)).toBe(true);
    expect(verify(out.textPrivacy?.output, "output", out.output, false)).toBe(false);
    expect(verify(out.textPrivacy?.identities, "identities", gateIdentities(out), false)).toBe(true);
    expect(verify(out.textPrivacy?.identities, "identities", gateIdentities(out), true)).toBe(false);
    const calls = spyOn(f.checker, "protectText");
    const cached = await f.scoped(() => recheckRemote(r, kind, c));
    expect(cached.output).toBe(out.output);
    expect(calls).not.toHaveBeenCalled();
    if (kind === "attested:lan" && r.remoteAttestation) {
      delete r.remoteAttestation.output.truncated;
      const complete = await f.scoped(() => recheckRemote(r, kind, c));
      expect(complete.textPrivacy?.output.truncated).toBeUndefined();
      expect(verify(complete.textPrivacy?.output, "output", complete.output, false)).toBe(true);
    }
  },
);

test("LAN excerpts and both renderings bind exact bytes, transport and cut semantics", async () => {
  const f = fixture(),
    c = control(),
    source = f.result({
      ok: false,
      exitCode: 1,
      output: "x".repeat(6000),
      failures: "assertion detail\n(fail) example",
    });
  const result = await f.scoped(() => recheckRemote(source, "attested:lan", c));
  expect(result.failures).toBe(source.failures);
  const verify = verifier(f.registry, f.signer).verify;
  for (const [name, bytes, proof] of [
    ["failures", source.failures ?? "", result.textPrivacy?.failures],
    ...RENDER_LIMITS.map(
      (limit) =>
        [
          `rendering:${limit}`,
          renderGateOutput(result, limit),
          result.textPrivacy?.renderings?.[limit],
        ] as const,
    ),
  ] as const) {
    expect(proof).toMatchObject({ kind: "attested:lan", truncated: true });
    expect(verify(proof, name, bytes, true)).toBe(true);
    expect(verify({ ...proof, kind: "complete" }, name, bytes, true)).toBe(false);
    expect(verify(proof, name, bytes, false)).toBe(false);
    expect(verify(proof, name, `${bytes}!`, true)).toBe(false);
  }
  const cuts = spyOn(f.checker, "protectProducerCut");
  await f.scoped(() => recheckRemote(source, "attested:lan", c));
  expect(cuts).not.toHaveBeenCalled();
  const changed = await f.scoped(() =>
    recheckRemote({ ...source, failures: "different detail" }, "attested:lan", c),
  );
  expect(changed.failures).toBe("different detail");
  expect(cuts).toHaveBeenCalledTimes(3);
  for (const limit of RENDER_LIMITS)
    expect(f.scoped(() => formatGateOutput(changed, limit))).toBe(`different detail\n\n${"x".repeat(1000)}`);
});

test.each([
  "withheld",
  "incomplete",
  "missing",
  "digest",
  "parity",
  "passing",
  "private",
  "prefix",
  "credential",
])("untrusted LAN excerpts fail closed: %s", async (condition) => {
  const f = fixture(["private-example"], "excerpt-credential"),
    source = f.result({
      ok: condition === "passing",
      exitCode: condition === "passing" ? 0 : 1,
      failures:
        condition === "private"
          ? "private-example"
          : condition === "prefix"
            ? "detail p"
            : condition === "credential"
              ? "excerpt-credential"
              : "detail",
    });
  const claim = source.remoteAttestation?.output;
  if (!claim) throw Error("Missing claim");
  if (condition === "withheld") claim.withheld = true;
  if (condition === "incomplete") claim.checkedComplete = false;
  if (condition === "missing") delete source.remoteAttestation;
  if (condition === "digest") claim.entriesDigest = "0".repeat(64);
  const cuts = spyOn(f.checker, "protectProducerCut");
  const checked = await f.scoped(() =>
    recheckRemote(source, "attested:lan", { ...control(), parity: () => condition !== "parity" }),
  );
  expect(checked.failures).toBeUndefined();
  expect(checked.textPrivacy?.failures?.mac).toBeUndefined();
  if (condition !== "passing") expect(checked.textPrivacy?.failures?.withheld).toBe(true);
  if (!["private", "prefix", "credential"].includes(condition)) expect(cuts).not.toHaveBeenCalled();
  else expect(checked.textPrivacy?.failures?.reason).toBe("private-match");
});

test.each(["attested:lan", "attested:github-actions"] as const)(
  "%s timeout bypasses a successful memo",
  async (kind) => {
    const f = fixture(),
      c = control(),
      source = f.result({ ok: false, exitCode: 1, output: "x".repeat(6000), failures: "detail" });
    await f.scoped(() => recheckRemote(source, kind, c));
    const cuts = spyOn(f.checker, "protectProducerCut");
    const timed = await f.scoped(() => recheckRemote({ ...source, timedOut: true }, kind, c));
    expect(timed.output).toBe("[withheld: timeout; timed out]");
    expect(timed.textPrivacy?.output).toEqual({ withheld: true, reason: "timeout" });
    expect(timed.textPrivacy?.identities?.kind).toBe(kind);
    expect(timed.failures).toBeUndefined();
    expect(timed.textPrivacy?.failures).toBeUndefined();
    expect(timed.textPrivacy?.renderings).toBeUndefined();
    expect(cuts).not.toHaveBeenCalled();
  },
);

test.each([1, 2, 3])(
  "diagnostic check %s revalidates policy, parity, cancellation, expiry and claims",
  async (pending) => {
    for (const change of ["policy", "parity", "cancel", "deadline", "claim", "credentials"]) {
      const f = fixture(),
        c = control(),
        controller = new AbortController();
      let parity = true,
        now = Date.now(),
        calls = 0;
      const source = f.result({
        ok: false,
        exitCode: 1,
        output: "x".repeat(6000),
        failures: `diagnostic-for-${pending}`,
      });
      const ready = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>(),
        original = f.checker.protectProducerCut;
      const spy = spyOn(f.checker, "protectProducerCut").mockImplementation(async (input, options) => {
        expect(options?.deadline).toBe(c.deadline);
        const receipt = await original(input, options);
        if (++calls === pending) {
          ready.resolve();
          await finish.promise;
        }
        return receipt;
      });
      const checked = f.scoped(() =>
        recheckRemote(source, "attested:lan", {
          ...c,
          signal: controller.signal,
          now: () => now,
          parity: () => parity,
        }),
      );
      await ready.promise;
      if (change === "policy") f.policy(["other-entry"]);
      if (change === "parity") parity = false;
      if (change === "cancel") controller.abort();
      if (change === "deadline") now = c.deadline;
      if (change === "claim" && source.remoteAttestation)
        source.remoteAttestation.output.checkedComplete = false;
      if (change === "credentials")
        registerCredential("REMOTE_EXCERPT_TEST", `diagnostic-for-${pending}`, true);
      finish.resolve();
      const result = await checked;
      expect(result.failures).toBeUndefined();
      expect(result.textPrivacy?.failures?.mac).toBeUndefined();
      for (const [limit, record] of Object.entries(result.textPrivacy?.renderings ?? {})) {
        if (change === "credentials" && pending === 1) {
          expect(f.scoped(() => formatGateOutput(result, Number(limit) as 3000 | 9000))).toBe(
            "x".repeat(Number(limit) === 3000 ? 3000 : 6000),
          );
        } else expect(record.mac).toBeUndefined();
      }
      spy.mockRestore();
    }
  },
);

test("memoized remote cuts cannot be re-signed after a credential suffix becomes known", async () => {
  const f = fixture(),
    c = control(),
    source = f.result({ ok: false, exitCode: 1, failures: "memoized-fragment" });
  const first = await f.scoped(() => recheckRemote(source, "attested:lan", c));
  expect(first.failures).toBe("memoized-fragment");
  registerCredential("REMOTE_MEMO_CUT", "memoized-fragment-with-newly-known-suffix", true);
  const cuts = spyOn(f.checker, "protectProducerCut");
  const result = await f.scoped(() => recheckRemote(source, "attested:lan", c));
  expect(result.failures).toBeUndefined();
  expect(result.textPrivacy?.failures).toEqual({ withheld: true, reason: "credential-changed" });
  expect(result.textPrivacy?.renderings).toBeUndefined();
  expect(cuts).not.toHaveBeenCalled();
});
