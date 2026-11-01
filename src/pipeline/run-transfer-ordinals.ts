import { RunTransferError } from "./run-transfer-errors.ts";
import { ordinal, parseRecord, type TransferRowInput } from "./run-transfer-rows.ts";

export function sourceOrdinals(input: TransferRowInput) {
  const map = (rows: readonly { id: number }[]) => {
    const ids = rows.map((row) => parseRecord(ordinal, row.id)).sort((a, b) => a - b);
    if (new Set(ids).size !== ids.length) throw new RunTransferError("invalid");
    return new Map(ids.map((id, i) => [id, i + 1]));
  };
  return {
    stages: map(input.stages),
    invocations: map(input.invocations),
    questions: map(input.questions),
  };
}
