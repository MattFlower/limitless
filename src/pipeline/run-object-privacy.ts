import { registeredCredentials } from "../util/proc.ts";
import type { PrivateObjectReader, RunObjectIO } from "./run-object-contract.ts";
import { createRunObjectValidator, type RunObjectQuarantineDependencies } from "./run-object-quarantine.ts";
import { RunTransferError, rethrowRunTransfer } from "./run-transfer-errors.ts";

export interface RunObjectPrivacyDependencies extends RunObjectQuarantineDependencies {
  credentials?: () => readonly string[];
  validate?: RunObjectIO["validate"];
}

/** Only literal credential bytes are policy here; Git content must never be rewritten. */
export async function inspectRunObjectCredentials(
  reader: PrivateObjectReader,
  credentials: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  try {
    signal.throwIfAborted();
    const needles = credentials.filter((value) => value.length > 0).map((value) => Buffer.from(value));
    for await (const { oid } of reader.objects()) {
      signal.throwIfAborted();
      const bytes = await reader.read(oid);
      signal.throwIfAborted();
      if (!(bytes instanceof Uint8Array)) throw new RunTransferError("incomplete");
      const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (needles.some((needle) => raw.includes(needle))) throw new RunTransferError("invalid");
    }
    signal.throwIfAborted();
  } catch (error) {
    rethrowRunTransfer(error, signal.aborted ? "aborted" : "invalid");
  }
}

/** Import uses its own registry, even when the exporter already inspected these exact bytes. */
export function createRunObjectPrivacyValidator(deps: RunObjectPrivacyDependencies): RunObjectIO["validate"] {
  const validate = deps.validate ?? createRunObjectValidator(deps);
  return async (input, inspect, signal) => {
    let inspected = false;
    try {
      await validate(
        input,
        async (reader) => {
          await inspectRunObjectCredentials(reader, (deps.credentials ?? registeredCredentials)(), signal);
          await inspect(reader);
          inspected = true;
        },
        signal,
      );
      signal.throwIfAborted();
      if (!inspected) throw new RunTransferError("incomplete");
    } catch (error) {
      rethrowRunTransfer(
        error,
        signal.aborted ? "aborted" : error instanceof RunTransferError ? error.code : "invalid",
      );
    }
  };
}
