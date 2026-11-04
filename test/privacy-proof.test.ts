import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPublicationText } from "../src/gates/publication.ts";
import { createCredentialRegistry, credentialRegistry } from "../src/util/credential-matcher.ts";
import { createPrivacyRegistry, privacyRegistry } from "../src/util/privacy-boundary.ts";
import { createPrivacyChecker, privacyWorkerEntry, startPrivacyWorker } from "../src/util/privacy-checker.ts";
import { consumeBoundaryChunk } from "../src/util/privacy-chunks.ts";
import { provisionPrivacyPolicy } from "../src/util/privacy-policy.ts";
import * as p from "../src/util/privacy-proof.ts";
import { agentEnv, redactCredentials, registeredCredentials, sh } from "../src/util/proc.ts";

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
function fixture(secrets = createCredentialRegistry()) {
  const dir = directory(),
    state: { loaded?: boolean; key?: Buffer } = {};
  p.provisionProofKey(dir, { state });
  const registry = createPrivacyRegistry(secrets);
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
test("no key, forged receipt, stale receipt and withheld text cannot sign", async () => {
  const f = fixture();
  expect(await f.sign("safe", { signer: () => undefined })).toBeUndefined();
  expect(await f.sign("safe", { signer: undefined })).toBeUndefined();
  const receipt = await f.checker.protectText({ text: "safe", provenance: { kind: "complete" } });
  f.registry.addCredential("new-credential");
  const checker = { registry: f.registry, protectText: async () => receipt };
  expect(await f.sign("safe", { checker })).toBeUndefined();
  checker.protectText = async () => ({}) as typeof receipt;
  expect(await f.sign("safe", { checker })).toBeUndefined();
  expect(await f.sign("private-value", { cut: { limit: 0, unit: "U", marker: "" } })).toBeDefined();
  writeFileSync(join(f.dir, "private-strings.txt"), "private-value\n");
  expect(await f.sign("private-value")).toBeUndefined();
  expect(await f.sign("private-value", { cut: { limit: 0, unit: "U", marker: "" } })).toBeUndefined();
  expect(Object.keys(p).sort()).toEqual(
    ["PRIVACY_CHECKER_SEMANTICS", "checkAndSign", "provisionProofKey", "verifier"].sort(),
  );
});
test("verdict-only proofs and claims refuse originals that credential redaction would change", async () => {
  const secrets = createCredentialRegistry();
  secrets.add("cred-value-1234");
  const f = fixture(secrets),
    cut = { limit: 0, unit: "U" as const, marker: "" },
    refusals: string[] = [];
  const onRefusal = (reason: string) => refusals.push(reason);
  expect(await f.sign(" cred-value-1234 ", { cut, onRefusal })).toBeUndefined();
  expect(await f.sign(" cred-value-1234 ", { cut, onRefusal, signer: () => undefined })).toBeUndefined();
  expect(refusals).toEqual(["private-match", "private-match"]);
  const rendered = await f.sign(" cred-value-1234 ", { onRefusal });
  expect(p.verifier(f.registry, f.signer).verify(rendered, "output", " [redacted] ")).toBe(true);
  expect(await f.sign("clean identity", { cut, onRefusal })).toBeDefined();
  expect(refusals).toHaveLength(2);
});
test("receipts cannot be replayed against other input or another registry", async () => {
  const f = fixture(),
    cut = { limit: 0, unit: "U" as const, marker: "" },
    strict = createPrivacyRegistry();
  f.registry.refreshPolicy = () => {};
  f.registry.replacePolicy([{ value: "forbidden-value", entry: 0 }]);
  strict.replacePolicy([{ value: "forbidden-value", entry: 0 }]);
  const safe = await f.checker.protectText({
    text: "safe",
    cut,
    terminal: true,
    provenance: { kind: "complete" },
  });
  const replay = { registry: f.registry, protectText: async () => safe };
  expect(await f.sign("forbidden-value", { checker: replay, cut })).toBeUndefined();
  expect(await f.sign("safe", { checker: replay, cut: { ...cut, limit: 0 } })).toBeDefined();
  // A non-verdict receipt cannot be presented as a verdict-only one for other text.
  const full = await f.checker.protectText({ text: "", terminal: true, provenance: { kind: "complete" } });
  expect(
    await f.sign("forbidden-value", {
      checker: { registry: f.registry, protectText: async () => full },
      cut,
    }),
  ).toBeUndefined();
  // Bytes checked under a permissive registry never sign under a stricter one.
  const permissive = createPrivacyChecker({ registry: createPrivacyRegistry() });
  checkers.push(permissive);
  for (const options of [{}, { cut }]) {
    const receipt = await permissive.protectText({
      text: "forbidden-value",
      terminal: true,
      provenance: { kind: "complete" },
      ...options,
    });
    const checker = { registry: strict, protectText: async () => receipt };
    const proof = await f.sign("forbidden-value", { checker, ...options });
    expect(proof).toBeUndefined();
    expect(p.verifier(strict, f.signer).verify(proof, "output", "forbidden-value")).toBe(false);
  }
});
test("cut proofs cover rendering bytes, with verdict-only empty cuts covering input", async () => {
  const f = fixture();
  for (const deadline of [undefined, Date.now() + 30_000]) {
    const proof = await f.sign("safe text", { cut: { limit: 4, unit: "U", marker: "" }, deadline });
    expect(p.verifier(f.registry, f.signer).verify(proof, "output", "safe")).toBe(true);
    const verdict = await f.sign("safe text", { cut: { limit: 0, unit: "U", marker: "" }, deadline });
    expect(p.verifier(f.registry, f.signer).verify(verdict, "output", "safe text")).toBe(true);
  }
  const controlOnly = `${String.fromCharCode(27)}[31m`;
  const emptyRendering = await f.sign(controlOnly);
  expect(p.verifier(f.registry, f.signer).verify(emptyRendering, "output", "")).toBe(true);
  expect(p.verifier(f.registry, f.signer).verify(emptyRendering, "output", controlOnly)).toBe(false);
});
const keyForms = (key: Buffer) => [
  key.toString("hex"),
  key.toString("base64"),
  key.toString("base64").replace(/=+$/, ""),
  key.toString("base64url"),
];
test.each(["hex", "base64", "unpadded", "base64url"])(
  "provisioned %s key representation stays on the main thread and cannot sign",
  async (kind) => {
    const f = fixture(credentialRegistry);
    if (!f.state.key) throw new Error("Missing key");
    const value = keyForms(f.state.key)[["hex", "base64", "unpadded", "base64url"].indexOf(kind)];
    if (!value) throw new Error("Missing representation");
    expect(registeredCredentials()).toContain(value);
    expect(privacyRegistry.mainThreadCredentials()).toContain(value);
    expect(privacyRegistry.snapshot(true).credentials).not.toContain(value);
    expect(redactCredentials(value)).toBe("[redacted]");
    for (const deadline of [undefined, Date.now() + 30_000]) {
      expect(await f.sign(value, { deadline })).toBeUndefined();
    }
  },
);
test.each(
  ["prefix-marker", "ansi", "plain", "encoded", "verdict"].flatMap((kind) =>
    ["immediate", "deadline"].map((admission) => [kind, admission] as const),
  ),
)(
  "exact signing bytes containing the key refuse after a valid receipt: %s (%s admission)",
  async (kind, admission) => {
    // Deliberately omit main-thread credentials so early checks cannot mask the final guard.
    const f = fixture();
    if (!f.state.key) throw new Error("Missing key");
    for (const representation of keyForms(f.state.key)) {
      const encodings =
        kind === "encoded"
          ? [
              Buffer.from(representation).toString("base64"),
              [...representation].map((c) => `%${c.charCodeAt(0).toString(16)}`).join(""),
              [...representation].map((c) => `&#${c.charCodeAt(0)};`).join(""),
              [...representation].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
            ]
          : [representation];
      for (const bytes of encodings) {
        const half = Math.floor(bytes.length / 2),
          text =
            kind === "prefix-marker"
              ? `${bytes.slice(0, half)} omitted`
              : kind === "ansi"
                ? `${bytes.slice(0, half)}${String.fromCharCode(27)}[31m${bytes.slice(half)}`
                : bytes,
          cut =
            kind === "prefix-marker"
              ? { limit: half, unit: "U" as const, marker: bytes.slice(half) }
              : kind === "verdict"
                ? { limit: 0, unit: "U" as const, marker: "" }
                : undefined;
        const deadline = admission === "deadline" ? Date.now() + 30_000 : undefined;
        let valid = false;
        const checker = {
          registry: f.registry,
          protectText: async (...args: Parameters<typeof f.checker.protectText>) => {
            const receipt = await f.checker.protectText(...args),
              parts: Uint8Array[] = [];
            for (let index = 0; ; index++) {
              const part = consumeBoundaryChunk(receipt, index);
              expect(part.withheld).toBe(false);
              expect(part.checkedComplete).toBe(true);
              if (part.done) break;
              parts.push(part.bytes);
            }
            expect(Buffer.concat(parts).toString()).toBe(kind === "verdict" ? "" : bytes);
            valid = true;
            return receipt;
          },
        };
        expect(await f.sign(text, { checker, cut, deadline })).toBeUndefined();
        expect(valid).toBe(true);
      }
    }
  },
);
test("a final key matcher refusal cannot produce a proof from a valid receipt", async () => {
  const f = fixture(),
    receipt = await f.checker.protectText({
      text: "safe",
      terminal: true,
      provenance: { kind: "complete" },
    });
  expect(consumeBoundaryChunk(receipt, 0).checkedComplete).toBe(true);
  const match = spyOn(await import("../src/util/privacy-boundary.ts"), "checkPrepared");
  try {
    match.mockReturnValue({ refused: "forms-total" });
    expect(
      await f.sign("safe", { checker: { registry: f.registry, protectText: async () => receipt } }),
    ).toBeUndefined();
    expect(match).toHaveBeenCalledTimes(1);
  } finally {
    match.mockRestore();
  }
});
test.each(["symlink", "owner", "mode", "type", "short", "long", "read-length", "read-error", "stat-error"])(
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
      log = mock(),
      open = mock((path: string, flags: number) => openSync(path, flags)),
      close = mock(closeSync),
      read = mock((fd: number, key: Buffer) => {
        if (kind === "read-error") throw new Error("Cannot read key");
        return readSync(fd, key, 0, kind === "read-length" ? 31 : 32, 0);
      });
    const deps = {
      state,
      log,
      open,
      close,
      read,
      fstat: (fd: number) => {
        if (kind === "stat-error") throw new Error("Cannot inspect key");
        const stat = fstatSync(fd);
        if (kind === "owner") stat.uid = -1;
        if (kind === "type") stat.isFile = () => false;
        return stat;
      },
    };
    p.provisionProofKey(dir, deps);
    p.provisionProofKey(dir, deps);
    expect(state.key).toBeUndefined();
    expect(open).toHaveBeenCalledWith(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(close).toHaveBeenCalledTimes(kind === "symlink" ? 0 : 1);
    if (kind !== "symlink") {
      const fd = open.mock.results[0]?.value;
      if (typeof fd !== "number") throw new Error("Key was not opened");
      expect(close).toHaveBeenCalledWith(fd);
      expect(() => fstatSync(fd)).toThrow();
    }
    expect(read).toHaveBeenCalledTimes(["read-length", "read-error"].includes(kind) ? 1 : 0);
    expect(log.mock.calls).toEqual([["Privacy proof key unavailable; gate proofs will not verify."]]);
    expect(
      p
        .verifier(createPrivacyRegistry(), () => state.key)
        .verify({ kind: "complete", mac: "0".repeat(64) }, "output", "safe"),
    ).toBe(false);
  },
);
test("a real FIFO key refuses without waiting for a writer and logs once", async () => {
  const dir = directory();
  await sh(["mkfifo", "-m", "600", join(dir, "privacy-proof.key")], {
    cwd: dir,
    timeoutMs: 10_000,
  });
  const result = await sh(
    [
      process.execPath,
      "-e",
      `import { provisionProofKey } from ${JSON.stringify(join(import.meta.dir, "../src/util/privacy-proof.ts"))};
      const state = {};
      provisionProofKey(process.argv[1], { state });
      provisionProofKey(process.argv[1], { state });
      console.log(state.loaded === true && state.key === undefined ? "refused" : "unexpected key state");`,
      dir,
    ],
    { cwd: dir, env: agentEnv(), timeoutMs: 10_000, allowFail: true },
  );
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("refused\n");
  expect(result.stderr).toBe("Privacy proof key unavailable; gate proofs will not verify.\n");
}, 30_000);
test.each(["creation", "inspection"])("key path swapped after %s refuses a symlink", (step) => {
  const dir = directory(),
    path = join(dir, "privacy-proof.key"),
    target = join(dir, "target"),
    state: { key?: Buffer } = {},
    log = mock();
  writeFileSync(target, Buffer.alloc(32, 1), { mode: 0o644 });
  const swap = () => {
    unlinkSync(path);
    symlinkSync(target, path);
  };
  let inspections = 0;
  if (step === "inspection") writeFileSync(path, Buffer.alloc(32, 2), { mode: 0o600 });
  p.provisionProofKey(dir, {
    state,
    log,
    open: (file, flags) => {
      swap();
      return openSync(file, flags);
    },
    lstat: ((file: string) => {
      const stat = lstatSync(file, { throwIfNoEntry: false });
      // The previous path-based loader's final inspection returns the original file's stat.
      if (++inspections === 2) swap();
      return stat;
    }) as typeof lstatSync,
  });
  expect(state.key).toBeUndefined();
  expect(log.mock.calls).toEqual([["Privacy proof key unavailable; gate proofs will not verify."]]);
  expect(readdirSync(dir).sort()).toEqual(["privacy-proof.key", "target"]);
});
test("valid key reads exactly 32 bytes from its validated descriptor and closes it", () => {
  const dir = directory(),
    key = Buffer.alloc(32, 3),
    state: { key?: Buffer } = {},
    opened = mock((path: string, flags: number) => openSync(path, flags)),
    inspected = mock((fd: number) => fstatSync(fd)),
    read = mock((fd: number, buffer: Buffer) => readSync(fd, buffer, 0, 32, 0)),
    close = mock(closeSync);
  writeFileSync(join(dir, "privacy-proof.key"), key, { mode: 0o600 });
  p.provisionProofKey(dir, { state, open: opened, fstat: inspected, read, close });
  expect(state.key).toEqual(key);
  const fd = opened.mock.results[0]?.value;
  if (typeof fd !== "number") throw new Error("Key was not opened");
  expect(inspected).toHaveBeenCalledWith(fd);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[0]).toBe(fd);
  expect(close).toHaveBeenCalledWith(fd);
  expect(close).toHaveBeenCalledTimes(1);
  expect(() => fstatSync(fd)).toThrow();
});
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

test("main-thread credentials never enter worker snapshots on either admission path", async () => {
  const f = fixture(),
    hex = f.state.key?.toString("hex");
  if (!hex) throw new Error("Missing key");
  if (!f.state.key) throw new Error("Missing key");
  const values = keyForms(f.state.key),
    registry = createPrivacyRegistry(credentialRegistry);
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
          leaked ||= values.some((key) => Buffer.from(value.payload).includes(Buffer.from(key)));
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
    expect(consumeBoundaryChunk(receipt, 0).withheld).toBe(false);
  }
  expect(chunks).toBeGreaterThanOrEqual(2);
  expect(leaked).toBe(false);
  // Key-bearing input is withheld on the main thread and never dispatched or signed.
  const sent = chunks,
    encoded = Buffer.from(hex).toString("base64");
  for (const deadline of [undefined, Date.now() + 30_000]) {
    for (const text of [...values, `log ${hex} tail`, encoded]) {
      const receipt = await checker.protectText({ text, provenance: { kind: "complete" } }, { deadline });
      expect(consumeBoundaryChunk(receipt, 0)).toMatchObject({ withheld: true, reason: "private-match" });
      const proof = await p.checkAndSign({
        checker,
        signer: f.signer,
        kind: "complete",
        field: "output",
        text,
        deadline,
      });
      expect(proof).toBeUndefined();
    }
    const marked = await checker.protectText(
      { text: "safe text", cut: { limit: 1, unit: "U", marker: hex }, provenance: { kind: "complete" } },
      { deadline },
    );
    expect(consumeBoundaryChunk(marked, 0).withheld).toBe(true);
    const data = await checker.protectData(
      { json: JSON.stringify({ hex }), provenance: { kind: "complete" } },
      { deadline },
    );
    expect(consumeBoundaryChunk(data, 0).withheld).toBe(true);
  }
  expect(chunks).toBe(sent);
  expect(leaked).toBe(false);
});
