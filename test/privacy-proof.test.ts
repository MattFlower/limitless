import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPublicationText } from "../src/gates/publication.ts";
import { credentialRegistry } from "../src/util/credential-matcher.ts";
import { createPrivacyRegistry, privacyRegistry } from "../src/util/privacy-boundary.ts";
import { createPrivacyChecker, privacyWorkerEntry, startPrivacyWorker } from "../src/util/privacy-checker.ts";
import { consumeBoundaryChunk } from "../src/util/privacy-chunks.ts";
import { provisionPrivacyPolicy } from "../src/util/privacy-policy.ts";
import * as p from "../src/util/privacy-proof.ts";
import { agentEnv, redactCredentials, registeredCredentials } from "../src/util/proc.ts";

const dirs: string[] = [];
const checkers: ReturnType<typeof createPrivacyChecker>[] = [];
afterEach(async () => {
  for (const checker of checkers.splice(0)) await checker.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "proof-"));
  dirs.push(dir);
  return dir;
};
function fixture() {
  const dir = directory(),
    state: { loaded?: boolean; key?: Buffer } = {};
  p.provisionProofKey(dir, { state });
  const registry = createPrivacyRegistry();
  provisionPrivacyPolicy(dir, [], { registry });
  const checker = createPrivacyChecker({ registry });
  checkers.push(checker);
  const signer = () => state.key;
  const sign = (text = "safe text", extra: Partial<Parameters<typeof p.checkAndSign>[0]> = {}) =>
    p.checkAndSign({ checker, signer, kind: "complete", field: "output", text, ...extra });
  return { dir, state, registry, checker, signer, sign };
}
test("receipt proofs bind key, kind, field, bytes, entries and semantics", async () => {
  const f = fixture(),
    proof = await f.sign();
  expect(proof).toBeDefined();
  const verify = p.verifier(f.registry, f.signer).verify;
  expect(verify(proof, "output", "safe text")).toBe(true);
  expect(verify(proof, "identities", "safe text")).toBe(false);
  expect(verify(proof, "output", "different bytes")).toBe(false);
  expect(verify({ ...proof, kind: "rendering" }, "output", "safe text")).toBe(false);
  expect(p.verifier(f.registry, () => Buffer.alloc(32)).verify(proof, "output", "safe text")).toBe(false);
  expect(verify({ output: "safe text", textPrivacy: { output: proof } }, "output", "safe text")).toBe(false);
  expect(verify({ ...proof, mac: `${proof?.mac}\n` }, "output", "safe text")).toBe(false);
  expect(verify({ ...proof, kind: {} }, "output", "safe text")).toBe(false);
  expect(verify({ ...proof, mac: "00" }, "output", "safe text")).toBe(false);
  let label = "privacy/1";
  const other = createPrivacyRegistry(undefined, () => label);
  expect(p.verifier(other, f.signer).verify(proof, "output", "safe text")).toBe(true);
  label = "privacy/2";
  expect(p.verifier(other, f.signer).verify(proof, "output", "safe text")).toBe(false);
  label = "privacy/1";
  other.replacePolicy([{ value: "other", entry: 0 }]);
  expect(p.verifier(other, f.signer).verify(proof, "output", "safe text")).toBe(false);
  const hex = f.state.key?.toString("hex") ?? "missing";
  expect(redactCredentials(hex)).toBe("[redacted]");
  expect(registeredCredentials()).toContain(hex);
  expect(privacyRegistry.snapshot().credentials).toContain(hex);
  expect(privacyRegistry.snapshot(true).credentials).not.toContain(hex);
  expect(() =>
    checkPublicationText(
      Buffer.from(hex).toString("base64"),
      "test",
      registeredCredentials().map((value) => ({ value, entry: 0 })),
    ),
  ).toThrow();
  process.env.PROOF_ENV_TEST = hex;
  try {
    expect(agentEnv().PROOF_ENV_TEST).toBeUndefined();
  } finally {
    delete process.env.PROOF_ENV_TEST;
  }
});
test("one fresh snapshot serves all fields until the next verifier", async () => {
  const f = fixture(),
    proof = await f.sign();
  const refresh = spyOn(f.registry, "refreshPolicy");
  try {
    const projection = p.verifier(f.registry, f.signer);
    expect(projection.verify(proof, "output", "safe text")).toBe(true);
    writeFileSync(join(f.dir, "private-strings.txt"), "safe text\n");
    expect(projection.verify(proof, "output", "safe text")).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(p.verifier(f.registry, f.signer).verify(proof, "output", "safe text")).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(await f.sign()).toBeUndefined();
  } finally {
    refresh.mockRestore();
  }
});
test("no key, forged receipt, stale receipt and wrong registry cannot sign", async () => {
  const f = fixture();
  expect(await f.sign("safe", { signer: () => undefined })).toBeUndefined();
  expect(await f.sign("safe", { signer: undefined })).toBeUndefined();
  const receipt = await f.checker.protectText({ text: "safe", provenance: { kind: "complete" } });
  f.registry.addCredential("new-credential");
  const checker = { registry: f.registry, protectText: async () => receipt };
  expect(await f.sign("safe", { checker })).toBeUndefined();
  checker.protectText = async () => ({}) as typeof receipt;
  expect(await f.sign("safe", { checker })).toBeUndefined();
  const valid = await f.checker.protectText({ text: "safe", provenance: { kind: "complete" } });
  expect(
    await f.sign("safe", { checker: { registry: createPrivacyRegistry(), protectText: async () => valid } }),
  ).toBeUndefined();
  expect(Object.keys(p).sort()).toEqual(
    ["PRIVACY_CHECKER_SEMANTICS", "checkAndSign", "provisionProofKey", "verifier"].sort(),
  );
});
test("cut proofs cover rendering bytes, with verdict-only empty cuts covering input", async () => {
  const f = fixture();
  const proof = await f.sign("safe text", { cut: { limit: 4, unit: "U", marker: "" } });
  expect(p.verifier(f.registry, f.signer).verify(proof, "output", "safe")).toBe(true);
  const verdict = await f.sign("safe text", { cut: { limit: 0, unit: "U", marker: "" } });
  expect(p.verifier(f.registry, f.signer).verify(verdict, "output", "safe text")).toBe(true);
  const controlOnly = `${String.fromCharCode(27)}[31m`;
  const emptyRendering = await f.sign(controlOnly);
  expect(p.verifier(f.registry, f.signer).verify(emptyRendering, "output", "")).toBe(true);
  expect(p.verifier(f.registry, f.signer).verify(emptyRendering, "output", controlOnly)).toBe(false);
});
test.each(["symlink", "owner", "mode", "short", "long", "read-length"])(
  "invalid key refuses once: %s",
  (kind) => {
    const dir = directory(),
      path = join(dir, "privacy-proof.key");
    writeFileSync(path, Buffer.alloc(kind === "short" ? 31 : kind === "long" ? 33 : 32), { mode: 0o600 });
    if (kind === "mode") chmodSync(path, 0o644);
    if (kind === "symlink") {
      const target = join(dir, "target");
      linkSync(path, target);
      unlinkSync(path);
      symlinkSync(target, path);
    }
    const state: { loaded?: boolean; key?: Buffer } = {},
      log = mock();
    const deps = {
      state,
      log,
      ...(kind === "owner"
        ? { lstat: ((path: string) => Object.assign(lstatSync(path), { uid: -1 })) as typeof lstatSync }
        : {}),
      ...(kind === "read-length" ? { readFile: () => Buffer.alloc(31) } : {}),
    };
    p.provisionProofKey(dir, deps);
    p.provisionProofKey(dir, deps);
    expect(state.key).toBeUndefined();
    expect(log.mock.calls).toEqual([["Privacy proof key unavailable; gate proofs will not verify."]]);
    expect(
      p
        .verifier(createPrivacyRegistry(), () => state.key)
        .verify({ kind: "complete", mac: "0".repeat(64) }, "output", "safe"),
    ).toBe(false);
  },
);
test("link race converges without replacement and cleans temporary files", () => {
  const dir = directory(),
    winner: { key?: Buffer } = {},
    loser: { key?: Buffer } = {};
  let inode: number | undefined;
  p.provisionProofKey(dir, {
    state: loser,
    link: (temp, final) => {
      p.provisionProofKey(dir, { state: winner });
      inode = lstatSync(final).ino;
      linkSync(temp, final); // Real EEXIST from the winning key.
    },
  });
  expect(loser.key).toEqual(winner.key);
  expect(loser.key?.length).toBe(32);
  if (inode === undefined) throw new Error("No winning inode");
  expect(lstatSync(join(dir, "privacy-proof.key")).ino).toBe(inode);
  expect(readdirSync(dir)).toEqual(["privacy-proof.key"]);
});
test("loaded keys survive deletion; restart creates a new binding", async () => {
  const f = fixture(),
    proof = await f.sign();
  unlinkSync(join(f.dir, "privacy-proof.key"));
  p.provisionProofKey(f.dir, { state: f.state });
  expect(await f.sign()).toEqual(proof);
  const restarted: { key?: Buffer } = {};
  p.provisionProofKey(f.dir, { state: restarted });
  expect(restarted.key).not.toEqual(f.state.key);
  expect(p.verifier(f.registry, () => restarted.key).verify(proof, "output", "safe text")).toBe(false);
});

test("unavailable and failed snapshots refuse and do not reuse partial readiness", async () => {
  const f = fixture(),
    proof = await f.sign();
  f.registry.failPolicy();
  f.registry.refreshPolicy = () => {};
  expect(p.verifier(f.registry, f.signer).verify(proof, "output", "safe text")).toBe(false);
  f.registry.refreshPolicy = () => {
    throw new Error("policy unavailable");
  };
  expect(p.verifier(f.registry, f.signer).verify(proof, "output", "safe text")).toBe(false);
});

test("first startup provisions a missing config directory", () => {
  const dir = join(directory(), "config"),
    state: { key?: Buffer } = {};
  p.provisionProofKey(dir, { state });
  expect(state.key?.length).toBe(32);
  const stat = lstatSync(join(dir, "privacy-proof.key"));
  expect(stat.isFile()).toBe(true);
  expect(stat.mode & 0o077).toBe(0);
});

test("verdict-only receipts cannot be replayed to sign unchecked input", async () => {
  const f = fixture();
  f.registry.refreshPolicy = () => {};
  f.registry.replacePolicy([{ value: "forbidden-value", entry: 0 }]);
  const cut = { limit: 0, unit: "U" as const, marker: "" };
  const receipt = await f.checker.protectText({
    text: "safe",
    cut,
    terminal: true,
    provenance: { kind: "complete" },
  });
  const checker = { registry: f.registry, protectText: async () => receipt };
  expect(await f.sign("forbidden-value", { checker, cut })).toBeUndefined();
  const proof = await f.sign("safe", { checker, cut });
  expect(p.verifier(f.registry, f.signer).verify(proof, "output", "safe")).toBe(true);
});

test("main-thread credentials never enter worker snapshots on either admission path", async () => {
  const f = fixture(),
    hex = f.state.key?.toString("hex");
  if (!hex) throw new Error("Missing key");
  const registry = createPrivacyRegistry(credentialRegistry);
  let chunks = 0,
    leaked = false;
  const checker = createPrivacyChecker({
    registry,
    workerFactory: () => {
      const port = startPrivacyWorker(privacyWorkerEntry()),
        post = port.postMessage;
      port.postMessage = (value, transfer) => {
        if (
          value &&
          typeof value === "object" &&
          "payload" in value &&
          value.payload instanceof ArrayBuffer
        ) {
          chunks++;
          leaked ||= Buffer.from(value.payload).includes(Buffer.from(hex));
        }
        post(value, transfer);
      };
      return port;
    },
  });
  checkers.push(checker);
  for (const deadline of [undefined, Date.now() + 30_000]) {
    const receipt = await checker.protectText(
      { text: "safe", provenance: { kind: "complete" } },
      { deadline },
    );
    expect(consumeBoundaryChunk(receipt, 0, registry).withheld).toBe(false);
  }
  expect(chunks).toBeGreaterThanOrEqual(2);
  expect(leaked).toBe(false);
});
