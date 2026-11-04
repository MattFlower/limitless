import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { privateStringsDigest } from "../gates/private.ts";
import { checkPrepared, preparePrivacyPolicy, type privacyRegistry } from "./privacy-boundary.ts";
import type { createPrivacyChecker } from "./privacy-checker.ts";
import { consumeBoundaryChunk } from "./privacy-chunks.ts";
import { redactCredentials, registerCredential } from "./proc.ts";

export { PRIVACY_CHECKER_SEMANTICS } from "./privacy-boundary.ts";

const kinds = z.enum(["complete", "attested:lan", "attested:github-actions", "rendering"]);
const proofSchema = z.object({ kind: kinds, mac: z.string().regex(/^[a-f0-9]{64}(?![\s\S])/) });
export type PrivacyProof = z.infer<typeof proofSchema>;
type Checker = ReturnType<typeof createPrivacyChecker>;
type KeyState = { loaded?: boolean; key?: Buffer };
const defaults = {
  state: {} as KeyState,
  lstat: fs.lstatSync,
  open: (path: string, flags: number) => fs.openSync(path, flags),
  fstat: (fd: number) => fs.fstatSync(fd),
  read: (fd: number, key: Buffer) => fs.readSync(fd, key, 0, 32, 0),
  close: fs.closeSync,
  link: fs.linkSync,
  log: console.error,
};
const provider = () => defaults.state.key;
const representations = (key: Buffer) => [
  key.toString("hex"),
  key.toString("base64"),
  key.toString("base64").replace(/=+$/, ""),
  key.toString("base64url"),
];
/** Main-thread only. A failed first load also remains failed until restart. */
export function provisionProofKey(configDir: string, deps: Partial<typeof defaults> = {}) {
  const { lstat: inspect, open, fstat, read, close, link, log } = { ...defaults, ...deps };
  const holder = deps.state ?? defaults.state;
  if (holder.loaded) return;
  holder.loaded = true;
  const path = join(configDir, "privacy-proof.key"),
    temp = `${path}.${randomUUID()}`;
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    // Create without replacement: a racing loser links nothing and validates the winner's key.
    if (!inspect(path, { throwIfNoEntry: false }))
      try {
        fs.writeFileSync(temp, randomBytes(32), { flag: "wx", mode: 0o600 });
        link(temp, path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      } finally {
        fs.unlinkSync(temp);
      }
    // Let descriptor validation reject FIFOs without waiting for a writer.
    const fd = open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fstat(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size !== 32)
        throw new Error("Invalid key");
      const key = Buffer.alloc(32);
      if (read(fd, key) !== 32) throw new Error("Invalid key");
      for (const value of representations(key)) registerCredential("PRIVACY_PROOF_KEY", value, true);
      holder.key = key;
    } finally {
      close(fd);
    }
  } catch {
    holder.key = undefined;
    log(redactCredentials("Privacy proof key unavailable; gate proofs will not verify."));
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
      onRefusal?: (reason: string) => void;
      kind: PrivacyProof["kind"];
      field: string;
    },
): Promise<PrivacyProof | undefined> {
  const { checker, kind, field, text, cut, signal, deadline, signer = provider } = input;
  const receipt = await checker.protectText(
    { text, cut, terminal: true, provenance: { kind: "complete" } },
    { signal, deadline },
  );
  const { registry } = checker,
    key = signer(),
    bound = { registry, input: cut?.limit === 0 ? hash(text) : undefined };
  const parts: Uint8Array[] = [];
  for (let index = 0; ; index++) {
    const part = consumeBoundaryChunk(receipt, index, bound);
    if (part.withheld || !part.checkedComplete) {
      input.onRefusal?.(part.reason ?? "checker-failed");
      return;
    }
    if (part.done) break;
    parts.push(part.bytes);
  }
  const rendering = Buffer.concat(parts);
  // The checker marks a verdict-only receipt whose original credential redaction would change.
  if (cut?.limit === 0 && rendering.length) {
    input.onRefusal?.("private-match");
    return;
  }
  if (!key) return;
  const bytes = cut?.limit === 0 ? text : rendering,
    binding = [kind, registry.semantics, privateStringsDigest(registry.entries), field];
  const policy = preparePrivacyPolicy({
    ready: true,
    entries: [],
    credentials: representations(key),
    generation: registry.generation,
  });
  if (!("clean" in checkPrepared(policy, bytes.toString()))) {
    input.onRefusal?.("checker-failed");
    return;
  }
  return { kind, mac: mac(key, binding, bytes).toString("hex") };
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
