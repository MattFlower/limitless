import { readFileSync, unlinkSync } from "node:fs";
import { createInterface } from "node:readline";
import { redactCredentials, registerCredential } from "../util/proc.ts";

const path = process.argv[2];
if (!path) throw new Error("Missing deploy redaction credentials");
const credentials: unknown = JSON.parse(readFileSync(path, "utf8"));
if (!Array.isArray(credentials) || !credentials.every((value) => typeof value === "string"))
  throw new Error("Invalid deploy redaction credentials");
for (const credential of credentials) registerCredential("DEPLOY_OUTPUT", credential);
unlinkSync(path);
const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
for await (const line of lines) process.stdout.write(`${redactCredentials(line)}\n`);
