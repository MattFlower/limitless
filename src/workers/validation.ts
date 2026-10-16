import type { GateRequest } from "../gates/executor.ts";
import { redactGateOutput } from "../gates/output.ts";
import type { GateResult, GateRun } from "../gates/run.ts";
import { confinementFailed } from "../gates/run.ts";

export function requestedChecks(req: GateRequest) {
  return req.gates.checks.filter((c) => !req.checks || req.checks.includes(c.name));
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
    run.checks.every((r) => validCheck(req, r, "check")) &&
    run.setup.length === req.gates.setup.length &&
    run.setup.every((r) => r.ok)
  );
}
