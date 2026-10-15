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
    commands.some((c) => redactGateOutput(c.name) === r.name && redactGateOutput(c.command) === r.command) &&
    !confinementFailed(r)
  );
}
export function validRun(req: GateRequest, run: GateRun) {
  const checks = requestedChecks(req);
  return (
    run.checks.length === checks.length &&
    new Set(run.checks.map((r) => r.name)).size === checks.length &&
    run.checks.every((r) => validCheck(req, r, "check")) &&
    run.setup.length === req.gates.setup.length &&
    run.setup.every(
      (r, i) => validCheck(req, r, "setup") && r.command === redactGateOutput(req.gates.setup[i] ?? ""),
    ) &&
    run.setupOk === run.setup.every((r) => r.ok)
  );
}
