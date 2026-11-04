import { afterEach, expect, spyOn, test } from "bun:test";
import { protectGateOutput } from "../src/gates/output-privacy.ts";
import { recheckRemote } from "../src/gates/remote-privacy.ts";
import { gateIdentities, IDENTITY_CAP, remoteGateData } from "../src/gates/text-privacy.ts";
import { verifier } from "../src/util/privacy-proof.ts";
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
