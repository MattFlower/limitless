import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { protectPrivateFile } from "../util/private-reads.ts";
import { registerCredential } from "../util/proc.ts";

/** Protect before launching work; publish only after all listeners bind successfully. */
export function createApiToken(home: string) {
  const token = randomBytes(32).toString("hex");
  registerCredential("LIMITLESS_API_TOKEN", token);
  const path = join(home, "api-token");
  const originPath = `${path}.origin`;
  const releases = [protectPrivateFile(path), protectPrivateFile(originPath)];
  return {
    token,
    release: () => {
      for (const release of releases) release();
    },
    publish(url: URL) {
      const temp = `${path}.${crypto.randomUUID()}`;
      const originTemp = `${originPath}.${crypto.randomUUID()}`;
      try {
        writeFileSync(temp, token, { flag: "wx", mode: 0o600 });
        const pair = { origin: url.origin, tokenHash: createHash("sha256").update(token).digest("hex") };
        writeFileSync(originTemp, JSON.stringify(pair), { flag: "wx", mode: 0o600 });
        // Publish the binding first: readers during rotation fail closed on a hash mismatch.
        renameSync(originTemp, originPath);
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
        rmSync(originTemp, { force: true });
      }
    },
  };
}

export function matchesApiToken(header: string | null, token?: string): boolean {
  const supplied = /^Bearer ([A-Za-z0-9]+)$/i.exec(header ?? "")?.[1];
  if (!supplied || !token) return false;
  const actual = Buffer.from(supplied),
    expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
