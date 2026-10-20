import { readFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { redactCredentials, registerCredential } from "../util/proc.ts";

let available = false;
try {
  const path = process.argv[2];
  if (!path) throw new Error();
  const credentials: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(credentials) || !credentials.every((value) => typeof value === "string"))
    throw new Error();
  for (const credential of credentials) registerCredential("DEPLOY_OUTPUT", credential);
  unlinkSync(path);
  available = true;
} catch {
  // Keep the producer's pipe open through EOF so a logging failure cannot interrupt rollback.
  process.stdout.write("[deploy output withheld: redaction unavailable]\n");
  process.exitCode = 1;
}
if (available) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) process.stdout.write(`${redactCredentials(line)}\n`);
} else {
  for await (const _chunk of process.stdin) {
    // Discard bytes without buffering lines or exposing setup diagnostics.
  }
}
