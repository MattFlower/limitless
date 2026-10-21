import { stripVTControlCharacters } from "node:util";
import type { GateRequest } from "../gates/executor.ts";
import { redactGateOutput } from "../gates/output.ts";
import type { GateResult, GateRun } from "../gates/run.ts";
import { confinementFailed } from "../gates/run.ts";
import { redactCredentials, registeredCredentials } from "../util/proc.ts";

export function requestedChecks(req: GateRequest) {
  return req.gates.checks.filter((c) => !req.checks || req.checks.includes(c.name));
}
/** Commands must stay executable: refuse remote dispatch rather than redact their inputs. */
export function credentialBearing(req: GateRequest) {
  return [
    ...req.gates.setup,
    ...req.gates.checks.flatMap((c) => [c.name, c.run]),
    ...(req.checks ?? []),
    req.gates.retryFiles ?? "",
  ].some(credentialInText);
}
export function credentialInText(input: string) {
  const normalized = stripVTControlCharacters(input);
  return (
    registeredCredentials().some((secret) => normalized.includes(secret)) ||
    redactCredentials(normalized) !== normalized
  );
}

/** Setup/check timeouts plus five minutes for transfer and one minute for posting/slot waits. */
export function attemptBudget(req: GateRequest) {
  return Math.min(
    2_147_483_647,
    360_000 +
      req.gates.setup.length * 900_000 +
      requestedChecks(req).reduce((ms, check) => ms + (check.timeoutSec ?? 900) * 1000, 0),
  );
}

export function validCheck(req: GateRequest, r: GateResult, phase: "setup" | "check") {
  const commands =
    phase === "check"
      ? requestedChecks(req).map((c) => ({ name: c.name, command: c.run }))
      : req.gates.setup.map((command, i) => ({
          name: `setup${req.gates.setup.length > 1 ? `-${i + 1}` : ""}`,
          command,
        }));
  return (
    commands.some(
      (c) =>
        redactGateOutput(c.name) === redactGateOutput(r.name) &&
        redactGateOutput(c.command) === redactGateOutput(r.command),
    ) && !confinementFailed(r)
  );
}
export function validRun(req: GateRequest, run: GateRun) {
  const checks = requestedChecks(req);
  if (
    run.setup.length > req.gates.setup.length ||
    !run.setup.every(
      (r, i) =>
        validCheck(req, r, "setup") &&
        r.name === `setup${req.gates.setup.length > 1 ? `-${i + 1}` : ""}` &&
        redactGateOutput(r.command) === redactGateOutput(req.gates.setup[i] ?? ""),
    )
  )
    return false;
  if (!run.setupOk)
    return (
      run.checks.length === 0 &&
      run.setup.length > 0 &&
      run.setup.every((r, i) => (i === run.setup.length - 1 ? !r.ok : r.ok))
    );
  return (
    run.checks.length === checks.length &&
    new Set(run.checks.map((r) => redactGateOutput(r.name))).size === checks.length &&
    run.checks.every(
      (r, i) =>
        validCheck(req, r, "check") &&
        redactGateOutput(r.name) === redactGateOutput(checks[i]?.name ?? "") &&
        redactGateOutput(r.command) === redactGateOutput(checks[i]?.run ?? ""),
    ) &&
    run.setup.length === req.gates.setup.length &&
    run.setup.every((r) => r.ok)
  );
}
