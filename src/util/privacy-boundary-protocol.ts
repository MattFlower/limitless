import type { PrivateStrings } from "../gates/private.ts";

export const WITHHELD = "[withheld: private text]";
export type Refusal =
  | "private-match"
  | "policy-unreadable"
  | "invalid-input-encoding"
  | "nonconvergence"
  | "resource-refusal"
  | "unverified-provenance"
  | "checker-unavailable";
export type Cut = { limit: number; unit: "U" | "B" | "CP"; from: "start" | "end" };
export type Caps = { input: number; form: number; pending: number };
export type PolicyData = { entries: PrivateStrings; credentials: string[] };
export type Metadata = {
  truncated: boolean | undefined;
  checkedComplete: boolean;
  withheld: boolean;
  reason?: Refusal;
};
export type Request = {
  mode: "text" | "data" | "json" | "cut";
  digest: string;
  caps: Caps;
  terminal?: boolean;
  cut?: Cut;
  truncated: boolean | undefined;
  checkedComplete: boolean;
};
export type ToChecker =
  | { kind: "chunk"; buffer: ArrayBuffer; policy: boolean }
  | { kind: "run"; request: Request };
// Each scalar is streamed separately; neither data direction clones a large object graph.
export type Token =
  | { kind: "object" | "array" | "end" }
  | { kind: "scalar" | "key"; buffer: ArrayBuffer; last: boolean }
  | { kind: "value"; value: number | boolean | null };
export type FromChecker =
  | Token
  | { kind: "batch"; tokens: Token[] }
  | { kind: "done"; metadata: Metadata; scans: number; compilationMs: number; prepared: boolean };
