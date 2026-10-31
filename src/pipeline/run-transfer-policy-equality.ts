import { RunTransferError } from "./run-transfer-errors.ts";
import { parseTransferJson } from "./run-transfer-json.ts";
import {
  parseTransferPolicyHistory,
  policyCanonical,
  transferPreparedPolicySchema,
} from "./run-transfer-policy-schema.ts";
import * as r from "./run-transfer-rows.ts";

// Both boundaries take portable data: no defaults, field stripping or coercion.
export const parseTransferPolicy = r.boundary((history: unknown, identity: unknown, state: unknown) => {
  if (history === undefined || history === null) throw new RunTransferError("missing");
  const records = parseTransferPolicyHistory(history);
  const pin = records.at(-1);
  if (!pin) throw new RunTransferError("missing");
  if (policyCanonical(identity) !== policyCanonical({ policyId: pin.policyId, repository: pin.repository }))
    throw new RunTransferError("conflict");
  parseTransferJson(state);
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new RunTransferError("invalid");
  const expected = pin.kind === "provisional" ? {} : pin.fields;
  for (const key of [...Object.keys(transferPreparedPolicySchema.shape), "reviewMode"]) {
    const owner = key === "reviewMode" ? pin : expected;
    const member = key === "reviewMode" ? "effectiveReviewMode" : key;
    const present = Object.hasOwn(owner, member);
    if (
      present !== Object.hasOwn(state, key) ||
      (present && policyCanonical(Reflect.get(owner, member)) !== policyCanonical(Reflect.get(state, key)))
    )
      throw new RunTransferError("conflict");
  }
  return pin;
});
export const encodeTransferPolicy = parseTransferPolicy;
export const executableFieldsFromPolicy = r.boundary(
  (history: unknown, identity: unknown, state: unknown) => {
    const pin = parseTransferPolicy(history, identity, state);
    if (pin.kind === "provisional") throw new RunTransferError("incomplete");
    return {
      ...pin.fields,
      ...("effectiveReviewMode" in pin && pin.effectiveReviewMode !== undefined
        ? { reviewMode: pin.effectiveReviewMode }
        : {}),
    };
  },
);
