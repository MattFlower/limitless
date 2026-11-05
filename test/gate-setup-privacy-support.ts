import { expect } from "bun:test";
import type { GateResult, GateRun } from "../src/gates/run.ts";
import { withheldText } from "../src/gates/text-privacy.ts";
import { provenResult } from "./privacy-support.ts";

const setupHost = ["private-setup", "example"].join(".");
const diagnostics = {
  command: `install ${setupHost}`,
  output: `diagnostic ${setupHost}`,
  failures: "failure excerpt must not escape",
  provenanceError: "provenance must not escape",
};
export const setupKinds = ["legacy", "forged", "proven", "missing"] as const;
export async function setupFailure(kind: (typeof setupKinds)[number]): Promise<GateRun> {
  const raw: GateResult = {
    name: "setup",
    command: diagnostics.command,
    output: diagnostics.output,
    failures: diagnostics.failures,
    executionProvenance: {
      sha: "a".repeat(40),
      trackedClean: true,
      provenanceError: diagnostics.provenanceError,
    },
    ok: false,
    exitCode: 1,
    durationMs: 0,
  };
  const result = kind === "legacy" || kind === "missing" ? raw : await provenResult(raw);
  if (kind === "forged" && result.textPrivacy) {
    result.textPrivacy.output.mac = "0".repeat(64);
    if (result.textPrivacy.identities) result.textPrivacy.identities.mac = "0".repeat(64);
  }
  return { setupOk: false, setup: kind === "missing" ? [] : [result], checks: [] };
}

export function assertSetupDiagnostics(text: string, kind: string) {
  expect(text).not.toContain(diagnostics.failures);
  expect(text).not.toContain(diagnostics.provenanceError);
  for (const permitted of [diagnostics.command, diagnostics.output]) {
    if (kind === "proven") expect(text).toContain(permitted);
    else expect(text).not.toContain(permitted);
  }
}

export function assertSetupError(
  message: string | null | undefined,
  kind: string,
  prefix: string,
  missing: string,
) {
  assertSetupDiagnostics(message ?? "", kind);
  expect(message).toBe(
    prefix +
      (kind === "missing"
        ? missing
        : kind === "proven"
          ? `install ${setupHost}\ndiagnostic ${setupHost}`
          : `${withheldText("unproven")}\n${withheldText("unproven")}`),
  );
}

export async function thrownMessage(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("Expected setup to fail");
}
