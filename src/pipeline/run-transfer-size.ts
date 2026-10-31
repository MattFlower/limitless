import { z } from "zod";
import * as r from "./run-transfer-rows.ts";

const object = z.strictObject,
  text = z.string();
const range = { base: r.oid, head: r.oid, mode: r.oneOf("two-dot merge-base") };
const count = object({ added: r.counter, removed: r.counter });
const stated = z.union([
  object({ kind: z.literal("figure"), lines: r.counter, text }),
  object({ kind: r.oneOf("zero ambiguous"), text }),
  z.null(),
]);
export const transferSizeSchema = object({
  sizeReport: z
    .union([
      object({ unavailable: text }),
      object({ ...range, error: text }),
      object({
        ...range,
        ...r.fields("source tests docs", count),
        binary: r.counter,
        renamesAcross: z.array(object({ from: text, to: text })),
        stated,
      }),
    ])
    .optional(),
});
export type TransferSize = z.infer<typeof transferSizeSchema>;
export const parseTransferSize = r.boundary(
  (value: unknown): TransferSize => r.parseRecord(transferSizeSchema, value),
);
export const sizeCommitMembers = ["sizeReport.base", "sizeReport.head"] as const;
export const sizeCommitDependencies = r.boundary((value: TransferSize): string[] =>
  value.sizeReport && "base" in value.sizeReport ? [value.sizeReport.base, value.sizeReport.head] : [],
);
