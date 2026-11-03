import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { privateStringsDigest } from "../gates/private.ts";
import type { privacyRegistry } from "./privacy-boundary.ts";
import type { createPrivacyChecker } from "./privacy-checker.ts";
import { consumeBoundaryChunk } from "./privacy-chunks.ts";
import { redactCredentials, registerCredential } from "./proc.ts";

export { PRIVACY_CHECKER_SEMANTICS } from "./privacy-boundary.ts";

const proofSchema = z.object({
  kind: z.enum(["complete", "attested:lan", "attested:github-actions", "rendering"]),
  mac: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/),
  withheld: z.literal(false).optional(),
});
export type PrivacyProof = Pick<z.infer<typeof proofSchema>, "kind" | "mac">;
type Checker = ReturnType<typeof createPrivacyChecker>;
type KeyState = { loaded?: boolean; key?: Buffer };
const defaults = {
  state: {} as KeyState,
  lstat: lstatSync,
  readFile: (path: string) => readFileSync(path),
  link: linkSync,
  log: console.error,
};
const provider = () => defaults.state.key;
/** Main-thread only. A failed first load also remains failed until restart. */
export function provisionProofKey(configDir: string, deps: Partial<typeof defaults> = {}) {
  const { lstat: inspect, readFile, link, log } = { ...defaults, ...deps };
  const holder = deps.state ?? defaults.state;
  if (holder.loaded) return;
  holder.loaded = true;
  const path = join(configDir, "privacy-proof.key"),
    temp = `${path}.${randomUUID()}`;
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    if (!inspect(path, { throwIfNoEntry: false })) {
      try {
        writeFileSync(temp, randomBytes(32), { flag: "wx", mode: 0o600 });
        try {
          link(temp, path);
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
    const key = readFile(path);
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Invalid key");
    holder.key = key;
    registerCredential("PRIVACY_PROOF_KEY", key.toString("hex"), true);
  } catch {
    holder.key = undefined;
    (log ?? console.error)(redactCredentials("Privacy proof key unavailable; gate proofs will not verify."));
  }
}
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const mac = (key: Buffer, binding: string[], bytes: string | Uint8Array) =>
  createHmac("sha256", key)
    .update(JSON.stringify(["limitless-gate-proof/1", ...binding, hash(bytes)]))
    .digest();
export async function checkAndSign(
  input: Omit<Parameters<Checker["protectText"]>[0], "provenance" | "terminal"> &
    Parameters<Checker["protectText"]>[1] & {
      checker: Pick<Checker, "protectText" | "registry">;
      signer?: typeof provider;
      kind: PrivacyProof["kind"];
      field: string;
    },
): Promise<PrivacyProof | undefined> {
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
    const part = consumeBoundaryChunk(receipt, index, registry, cut?.limit === 0 ? text : undefined);
    if (part.withheld || !part.checkedComplete) return;
    if (part.done) break;
    parts.push(part.bytes);
  }
  const bytes = Buffer.concat(parts),
    binding = [kind, registry.semantics, privateStringsDigest(registry.entries), field];
  return { kind, mac: mac(key, binding, !bytes.length && cut?.limit === 0 ? text : bytes).toString("hex") };
}
export function verifier(registry: typeof privacyRegistry, signer = provider) {
  let policy: [string, string] | undefined;
  try {
    registry.refreshPolicy();
    if (registry.ready) policy = [registry.semantics, privateStringsDigest(registry.entries)];
  } catch {
    /* An unreadable policy cannot verify. */
  }
  const key = signer();
  return {
    verify(value: unknown, field: string, bytes: string | Uint8Array): boolean {
      const proof = proofSchema.safeParse(value);
      if (!key || !policy || !proof.success) return false;
      const expected = mac(key, [proof.data.kind, ...policy, field], bytes),
        actual = Buffer.from(proof.data.mac, "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}
