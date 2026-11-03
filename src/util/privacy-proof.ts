import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { privateStringsDigest } from "../gates/private.ts";
import type { privacyRegistry } from "./privacy-boundary.ts";
import type { createPrivacyChecker } from "./privacy-checker.ts";
import { consumeBoundaryChunk } from "./privacy-chunks.ts";
import { redactCredentials, registerCredential } from "./proc.ts";

export { PRIVACY_CHECKER_SEMANTICS } from "./privacy-semantics.ts";
export type PrivacyProof = {
  kind: "complete" | "attested:lan" | "attested:github-actions" | "rendering";
  mac: string;
};
type KeyState = { loaded?: boolean; key?: Buffer };
const state: KeyState = {};
const provider = () => state.key;
/** Main-thread only. A failed first load also remains failed until restart. */
export function provisionProofKey(
  configDir: string,
  deps: Partial<{
    state: KeyState;
    lstat: typeof lstatSync;
    readFile: (path: string) => Buffer;
    link: typeof linkSync;
    log: (line: string) => void;
  }> = {},
) {
  const holder = deps.state ?? state;
  if (holder.loaded) return;
  holder.loaded = true;
  const path = join(configDir, "privacy-proof.key"),
    temp = `${path}.${randomUUID()}`;
  const inspect = deps.lstat ?? lstatSync;
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    if (!inspect(path, { throwIfNoEntry: false })) {
      try {
        writeFileSync(temp, randomBytes(32), { flag: "wx", mode: 0o600 });
        try {
          (deps.link ?? linkSync)(temp, path);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
      } finally {
        unlinkSync(temp);
      }
    }
    const stat = inspect(path);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size !== 32)
      throw new Error("Invalid key");
    const key = (deps.readFile ?? readFileSync)(path);
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Invalid key");
    holder.key = key;
    registerCredential("PRIVACY_PROOF_KEY", key.toString("hex"), true);
  } catch {
    holder.key = undefined;
    (deps.log ?? console.error)(
      redactCredentials("Privacy proof key unavailable; gate proofs will not verify."),
    );
  }
}
const mac = (key: Buffer, binding: string[], bytes: string | Uint8Array) => {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return createHmac("sha256", key)
    .update(JSON.stringify(["limitless-gate-proof/1", ...binding, hash]))
    .digest();
};
export async function checkAndSign(input: {
  checker: Pick<ReturnType<typeof createPrivacyChecker>, "protectText" | "registry">;
  signer?: typeof provider;
  kind: PrivacyProof["kind"];
  field: string;
  text: string;
  cut?: Parameters<ReturnType<typeof createPrivacyChecker>["protectText"]>[0]["cut"];
  signal?: AbortSignal;
  deadline?: number;
}): Promise<PrivacyProof | undefined> {
  const { checker, kind, field, text, cut, signal, deadline, signer = provider } = input;
  const receipt = await checker.protectText(
    { text, cut, terminal: true, provenance: { kind: "complete" } },
    { signal, deadline },
  );
  const registry = checker.registry;
  const key = signer();
  if (!key) return;
  const parts: Uint8Array[] = [];
  for (let index = 0; ; index++) {
    const part = consumeBoundaryChunk(receipt, index, registry);
    if (part.withheld || !part.checkedComplete) return;
    if (part.done) break;
    parts.push(part.bytes);
  }
  const bytes = Buffer.concat(parts);
  return {
    kind,
    mac: mac(
      key,
      [kind, registry.semantics, privateStringsDigest(registry.entries), field],
      !bytes.length && cut?.limit === 0 ? text : bytes,
    ).toString("hex"),
  };
}
export function verifier(registry: typeof privacyRegistry, signer = provider) {
  let ready = false,
    digest = "",
    semantics = "";
  try {
    registry.refreshPolicy();
    ready = registry.ready;
    digest = privateStringsDigest(registry.entries);
    semantics = registry.semantics;
  } catch {
    ready = false;
  }
  const key = signer();
  return {
    verify(proof: unknown, field: string, bytes: string | Uint8Array): boolean {
      if (
        !key ||
        !ready ||
        !proof ||
        typeof proof !== "object" ||
        !("kind" in proof) ||
        !("mac" in proof) ||
        typeof proof.kind !== "string" ||
        !["complete", "attested:lan", "attested:github-actions", "rendering"].includes(proof.kind) ||
        typeof proof.mac !== "string" ||
        proof.mac.length !== 64 ||
        !/^[a-f0-9]{64}$/.test(proof.mac) ||
        ("withheld" in proof && proof.withheld !== false)
      )
        return false;
      const expected = mac(key, [proof.kind, semantics, digest, field], bytes),
        actual = Buffer.from(proof.mac, "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}
