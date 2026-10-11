import { randomBytes, timingSafeEqual } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { protectPrivateFile } from "../util/private-reads.ts";
import { registerCredential } from "../util/proc.ts";

/** Protect before launching work; publish only after all listeners bind successfully. */
export function createApiToken(home: string) {
  const token = randomBytes(32).toString("hex");
  registerCredential("LIMITLESS_API_TOKEN", token);
  const path = join(home, "api-token");
  return {
    token,
    release: protectPrivateFile(path),
    publish() {
      const temp = `${path}.${crypto.randomUUID()}`;
      try {
        writeFileSync(temp, token, { flag: "wx", mode: 0o600 });
        renameSync(temp, path);
      } finally {
        rmSync(temp, { force: true });
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
