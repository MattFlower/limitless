import { rethrowClaimControl } from "../integrations/claim-errors.ts";

const diagnostics = {
  missing: "Run transfer data is missing",
  invalid: "Run transfer data is invalid",
  unsupported: "Run transfer format is unsupported",
  incomplete: "Run transfer data is incomplete",
  corrupt: "Run transfer data is corrupt",
  conflict: "Run transfer conflict",
  unavailable: "Run transfer is unavailable",
  aborted: "Run transfer was aborted",
} as const;
export type RunTransferErrorCode = keyof typeof diagnostics;

export class RunTransferError extends Error {
  constructor(readonly code: RunTransferErrorCode) {
    super(diagnostics[code]);
    this.name = "RunTransferError";
  }
}

export function rethrowRunTransfer(error: unknown, code: RunTransferErrorCode): never {
  rethrowClaimControl(error);
  throw new RunTransferError(code);
}
