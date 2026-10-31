import { expect, test } from "bun:test";
import { ClaimControlError, ClaimLostError, ClaimWaitError } from "../src/integrations/claim-errors.ts";
import {
  RunTransferError,
  type RunTransferErrorCode,
  rethrowRunTransfer,
} from "../src/pipeline/run-transfer-errors.ts";
import { decodeRunTransfer, encodeRunTransfer } from "../src/pipeline/run-transfer-followups.ts";
import { encodeTransferJson, parseTransferJson } from "../src/pipeline/run-transfer-json.ts";
import {
  decodeRunTransferRows,
  decodeTransferRun,
  encodeRunTransferRows,
  encodeTransferRun,
} from "../src/pipeline/run-transfer-rows.ts";
import { fixture, rejects, repo } from "./run-transfer-support.ts";

const messages = {
  missing: "Run transfer data is missing",
  invalid: "Run transfer data is invalid",
  unsupported: "Run transfer format is unsupported",
  incomplete: "Run transfer data is incomplete",
  corrupt: "Run transfer data is corrupt",
  conflict: "Run transfer conflict",
  unavailable: "Run transfer is unavailable",
  aborted: "Run transfer was aborted",
} satisfies Record<RunTransferErrorCode, string>;

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected an error");
}

class CustomControl extends ClaimControlError {
  constructor() {
    super("sentinel custom control");
  }
}

test("transfer errors expose exactly the fixed code diagnostics without causes", () => {
  for (const code of Object.keys(messages) as RunTransferErrorCode[]) {
    const error = new RunTransferError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("RunTransferError");
    expect(error.code).toBe(code);
    expect(error.message).toBe(messages[code]);
    expect("cause" in error).toBe(false);
    const normalized = caught(() => rethrowRunTransfer(new Error("sentinel cause"), code));
    expect(normalized).toBeInstanceOf(RunTransferError);
    expect(normalized).toMatchObject({ code, message: messages[code] });
    expect(normalized).not.toHaveProperty("cause");
  }
});

test("transfer boundaries preserve claim-control instances including subclasses", () => {
  for (const error of [new ClaimLostError(), new ClaimWaitError("lease"), new CustomControl()]) {
    expect(caught(() => rethrowRunTransfer(error, "invalid"))).toBe(error);
    const value = new Proxy(
      {},
      {
        ownKeys: () => {
          throw error;
        },
      },
    );
    expect(caught(() => encodeTransferJson(value))).toBe(error);
    expect(caught(() => parseTransferJson(value))).toBe(error);
  }
});

test("transfer boundaries replace ordinary failures and control-name lookalikes", () => {
  for (const error of [
    new Error("sentinel input", { cause: "sentinel cause" }),
    Object.assign(new Error("Claim lost"), { name: "ClaimLostError" }),
    { name: "ClaimWaitError", message: "sentinel cause" },
    "sentinel rejected value",
  ]) {
    const value = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw error;
        },
      },
    );
    const normalized = caught(() => encodeTransferJson(value));
    expect(normalized).toBeInstanceOf(RunTransferError);
    expect(normalized).not.toBeInstanceOf(ClaimControlError);
    expect(normalized).toMatchObject({ code: "invalid", message: "Run transfer data is invalid" });
    expect(normalized).not.toHaveProperty("cause");
    expect(String(normalized)).not.toContain("sentinel");
  }
});

test("transfer boundaries contain exceptions while inspecting caught values", () => {
  const sentinel = ["private", "inspection", "sentinel"].join("-");
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error(sentinel);
      },
    },
  );
  const value = new Proxy(
    {},
    {
      ownKeys: () => {
        throw hostile;
      },
    },
  );
  for (const action of [
    () => rethrowRunTransfer(hostile, "unavailable"),
    () => encodeTransferJson(value),
    () => parseTransferJson(value),
  ]) {
    const normalized = caught(action);
    expect(normalized).toBeInstanceOf(RunTransferError);
    expect(normalized).toMatchObject({ code: "invalid", message: "Run transfer data is invalid" });
    expect(normalized).not.toHaveProperty("cause");
    expect(String(normalized)).not.toContain(sentinel);
  }
});

test("all row and follow-up public boundaries contain injected exceptions", () => {
  const input = fixture();
  const wire = encodeRunTransfer(input, repo);
  const actions = [
    (value: typeof input.run) => encodeTransferRun(value, repo),
    (value: typeof input.run) => decodeTransferRun(value, repo),
    (value: typeof input.run) => encodeRunTransferRows({ ...input, run: value }, repo),
    (value: typeof input.run) => decodeRunTransferRows({ ...wire, run: value }, repo),
    (value: typeof input.run) => encodeRunTransfer({ ...input, run: value }, repo),
    (value: typeof input.run) => decodeRunTransfer({ ...wire, run: value }, repo),
  ];
  for (const error of [
    new ClaimLostError(),
    new ClaimWaitError("lease"),
    new CustomControl(),
    new Error("private input"),
    { name: "ClaimLostError" },
    "private input",
  ]) {
    const hostile = new Proxy(input.run, {
      get: () => {
        throw error;
      },
    });
    for (const action of actions) {
      if (error instanceof ClaimControlError) expect(caught(() => action(hostile))).toBe(error);
      else {
        rejects(() => action(hostile));
        expect(caught(() => action(hostile))).toMatchObject({ message: "Run transfer data is invalid" });
      }
    }
  }
  for (const code of Object.keys(messages) as RunTransferErrorCode[]) {
    const error = new RunTransferError(code);
    const hostile = new Proxy(input.run, {
      get: () => {
        throw error;
      },
    });
    for (const action of actions) expect(caught(() => action(hostile))).toBe(error);
  }
  const inspectionFailure = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error("private input");
      },
    },
  );
  const hostile = new Proxy(input.run, {
    get: () => {
      throw inspectionFailure;
    },
  });
  for (const action of actions) rejects(() => action(hostile));
});
